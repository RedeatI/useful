//! AI-5 Agent profile 与导航 pin：固定路径、拒绝未知字段、只保存安全的声明式数据。
//!
//! 这里是 Tauri IPC 的第二道边界；Action descriptor/preset 的最终权威校验仍在
//! `@useful/agent-profile` + `ActionExecutor`，且必须发生在签名插件 registry 构造完成之后。

use super::{CmdError, CmdResult};
use crate::state::AppState;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::path::Path;
use tauri::State;
use useful_core::atomic_io::atomic_write;

const PROFILE_SCHEMA: &str = "useful.agent-profile.v1";
const PROFILE_MAX_BYTES: usize = 256 * 1024;
const DEFAULTS_MAX_BYTES: usize = 32 * 1024;
const MAX_DEPTH: usize = 16;
const MAX_NODES: usize = 4096;
const MAX_ACTIONS: usize = 128;
const MAX_ALIASES_TOTAL: usize = 256;
const MAX_PRESETS_TOTAL: usize = 256;

const DANGEROUS_KEYS: &[&str] = &["__proto__", "prototype", "constructor"];
const FORBIDDEN_DEFAULT_KEYS: &[&str] = &[
    "command",
    "rawcommand",
    "flags",
    "argv",
    "env",
    "path",
    "pathtemplate",
    "cwd",
    "workingdirectory",
    "entry",
    "args",
    "target",
    "text",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentProfile {
    schema_version: String,
    profile_id: String,
    name: String,
    actions: Vec<ProfileAction>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProfileAction {
    action_id: String,
    expected_contract_version: String,
    expected_action_version: String,
    expected_source_kind: String,
    expected_publisher_id: String,
    enabled: SurfaceEnabled,
    aliases: Vec<String>,
    presets: Vec<ProfilePreset>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SurfaceEnabled {
    cli: bool,
    mcp: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProfilePreset {
    preset_id: String,
    name: String,
    defaults: Map<String, Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfileView {
    profile_id: String,
    name: String,
    schema_version: String,
    profile_json: String,
    export_path: String,
}

fn profile_error(path: &str, code: &str) -> CmdError {
    CmdError::from(format!("AGENT_PROFILE_INVALID:{path}:{code}"))
}

fn contains_expression(value: &str) -> bool {
    ["${", "{{", "}}", "$(", "<%", "%>"]
        .iter()
        .any(|marker| value.contains(marker))
}

fn inspect_value(value: &Value, path: &str, depth: usize, nodes: &mut usize) -> CmdResult<()> {
    *nodes += 1;
    if depth > MAX_DEPTH {
        return Err(profile_error(path, "DEPTH_LIMIT"));
    }
    if *nodes > MAX_NODES {
        return Err(profile_error(path, "NODE_LIMIT"));
    }
    match value {
        Value::String(text) if contains_expression(text) => {
            Err(profile_error(path, "EXPRESSION_FORBIDDEN"))
        }
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                inspect_value(item, &format!("{path}/{index}"), depth + 1, nodes)?;
            }
            Ok(())
        }
        Value::Object(object) => {
            for (key, child) in object {
                if DANGEROUS_KEYS.contains(&key.as_str()) {
                    return Err(profile_error(&format!("{path}/{key}"), "DANGEROUS_KEY"));
                }
                inspect_value(child, &format!("{path}/{key}"), depth + 1, nodes)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn is_stable_id(value: &str, max: usize) -> bool {
    if value.is_empty() || value.len() > max || !value.is_ascii() {
        return false;
    }
    let bytes = value.as_bytes();
    if !bytes[0].is_ascii_lowercase() {
        return false;
    }
    let mut separator = false;
    for byte in bytes.iter().copied() {
        if byte.is_ascii_lowercase() || byte.is_ascii_digit() {
            separator = false;
        } else if matches!(byte, b'.' | b'_' | b'-') && !separator {
            separator = true;
        } else {
            return false;
        }
    }
    !separator
}

fn is_action_id(value: &str) -> bool {
    if value.len() < 3 || value.len() > 200 || !value.is_ascii() {
        return false;
    }
    let segments: Vec<_> = value.split('.').collect();
    segments.len() >= 2
        && segments.iter().enumerate().all(|(index, segment)| {
            !segment.is_empty()
                && segment.as_bytes()[0].is_ascii_alphanumeric()
                && (index > 0 || segment.as_bytes()[0].is_ascii_lowercase())
                && segment.bytes().all(|byte| {
                    byte.is_ascii_lowercase()
                        || byte.is_ascii_digit()
                        || matches!(byte, b'_' | b'-')
                })
        })
}

fn is_alias(value: &str) -> bool {
    value.len() >= 2 && is_stable_id(value, 64) && !value.contains('.') && !value.contains('_')
}

fn is_semver(value: &str) -> bool {
    if value.len() > 80 || value.contains('+') {
        return false;
    }
    let (core, prerelease) = match value.split_once('-') {
        Some((core, prerelease)) => (core, Some(prerelease)),
        None => (value, None),
    };
    let parts: Vec<_> = core.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.chars().all(|ch| ch.is_ascii_digit()))
        && prerelease.is_none_or(|part| {
            !part.is_empty()
                && part
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-'))
        })
}

fn canonicalize_value(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonicalize_value).collect()),
        Value::Object(object) => {
            let mut keys: Vec<_> = object.keys().collect();
            keys.sort_unstable();
            let mut sorted = Map::new();
            for key in keys {
                sorted.insert(key.clone(), canonicalize_value(&object[key]));
            }
            Value::Object(sorted)
        }
        _ => value.clone(),
    }
}

fn validate_known_builtin_defaults(
    action_id: &str,
    defaults: &Map<String, Value>,
) -> CmdResult<()> {
    let allowed: Option<&[&str]> = match action_id {
        "builtin.utilities.json" => Some(&["operation", "indent"]),
        "builtin.utilities.base64" => Some(&["operation"]),
        "builtin.utilities.hash" => Some(&["algorithm"]),
        _ => None,
    };
    if let Some(allowed) = allowed {
        for key in defaults.keys() {
            if !allowed.contains(&key.as_str()) {
                return Err(profile_error(
                    "/actions/presets/defaults",
                    "DEFAULT_UNKNOWN_OR_SENSITIVE",
                ));
            }
        }
    }
    let invalid = || profile_error("/actions/presets/defaults", "DEFAULT_VALUE_INVALID");
    match action_id {
        "builtin.utilities.json" => {
            if let Some(value) = defaults.get("operation") {
                if !matches!(value.as_str(), Some("format" | "minify")) {
                    return Err(invalid());
                }
            }
            if let Some(value) = defaults.get("indent") {
                if !matches!(value.as_i64(), Some(0..=8)) {
                    return Err(invalid());
                }
            }
        }
        "builtin.utilities.base64" => {
            if let Some(value) = defaults.get("operation") {
                if !matches!(value.as_str(), Some("encode" | "decode")) {
                    return Err(invalid());
                }
            }
        }
        "builtin.utilities.hash" => {
            if let Some(value) = defaults.get("algorithm") {
                if !matches!(
                    value.as_str(),
                    Some("SHA-1" | "SHA-256" | "SHA-384" | "SHA-512")
                ) {
                    return Err(invalid());
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn parse_and_validate_profile(profile_json: &str) -> CmdResult<(AgentProfile, String)> {
    if profile_json.len() > PROFILE_MAX_BYTES {
        return Err(profile_error("", "BYTE_LIMIT"));
    }
    let value: Value =
        serde_json::from_str(profile_json).map_err(|_| profile_error("", "JSON_INVALID"))?;
    let mut nodes = 0;
    inspect_value(&value, "", 0, &mut nodes)?;
    let profile: AgentProfile =
        serde_json::from_value(value.clone()).map_err(|_| profile_error("", "SHAPE_INVALID"))?;

    if profile.schema_version != PROFILE_SCHEMA
        || !is_stable_id(&profile.profile_id, 64)
        || profile.name.is_empty()
        || profile.name.chars().count() > 120
        || contains_expression(&profile.name)
        || profile.actions.len() > MAX_ACTIONS
    {
        return Err(profile_error("", "METADATA_INVALID"));
    }

    let mut action_ids = HashSet::new();
    let mut aliases = HashSet::new();
    let mut alias_total = 0usize;
    let mut preset_total = 0usize;
    for action in &profile.actions {
        if !is_action_id(&action.action_id) || !action_ids.insert(action.action_id.as_str()) {
            return Err(profile_error(
                "/actions/actionId",
                "ACTION_ID_INVALID_OR_DUPLICATE",
            ));
        }
        if action.expected_contract_version != "1.0"
            || !is_semver(&action.expected_action_version)
            || !matches!(
                action.expected_source_kind.as_str(),
                "builtin" | "plugin" | "local"
            )
            || action.expected_publisher_id.is_empty()
            || action.expected_publisher_id.len() > 256
            || contains_expression(&action.expected_publisher_id)
            || action.aliases.len() > 16
            || action.presets.len() > 32
        {
            return Err(profile_error("/actions", "ACTION_METADATA_INVALID"));
        }
        alias_total += action.aliases.len();
        preset_total += action.presets.len();
        for alias in &action.aliases {
            if !is_alias(alias) || !aliases.insert(alias.as_str()) {
                return Err(profile_error(
                    "/actions/aliases",
                    "ALIAS_INVALID_OR_DUPLICATE",
                ));
            }
        }
        let mut preset_ids = HashSet::new();
        for preset in &action.presets {
            if !is_stable_id(&preset.preset_id, 64)
                || !preset_ids.insert(preset.preset_id.as_str())
                || preset.name.is_empty()
                || preset.name.chars().count() > 120
                || contains_expression(&preset.name)
            {
                return Err(profile_error("/actions/presets", "PRESET_METADATA_INVALID"));
            }
            let bytes = serde_json::to_vec(&preset.defaults)
                .map_err(|_| profile_error("/actions/presets/defaults", "NOT_JSON"))?;
            if preset.defaults.len() > 64 {
                return Err(profile_error(
                    "/actions/presets/defaults",
                    "DEFAULTS_PROPERTY_LIMIT",
                ));
            }
            if bytes.len() > DEFAULTS_MAX_BYTES {
                return Err(profile_error(
                    "/actions/presets/defaults",
                    "DEFAULTS_BYTE_LIMIT",
                ));
            }
            for key in preset.defaults.keys() {
                let normalized = key.to_ascii_lowercase().replace(['_', '-', '.'], "");
                if DANGEROUS_KEYS.contains(&key.as_str())
                    || FORBIDDEN_DEFAULT_KEYS.contains(&normalized.as_str())
                {
                    return Err(profile_error(
                        "/actions/presets/defaults",
                        "DEFAULT_KEY_FORBIDDEN",
                    ));
                }
            }
            validate_known_builtin_defaults(&action.action_id, &preset.defaults)?;
        }
    }
    if alias_total > MAX_ALIASES_TOTAL || preset_total > MAX_PRESETS_TOTAL {
        return Err(profile_error("/actions", "TOTAL_LIMIT"));
    }
    if aliases.iter().any(|alias| action_ids.contains(alias)) {
        return Err(profile_error("/actions/aliases", "ALIAS_ACTION_COLLISION"));
    }

    let mut canonical = serde_json::to_string_pretty(&canonicalize_value(&value))
        .map_err(|_| profile_error("", "CANONICALIZE_FAILED"))?;
    canonical.push('\n');
    Ok((profile, canonical))
}

fn profile_view(profile: &AgentProfile, canonical: String, export_path: &Path) -> AgentProfileView {
    AgentProfileView {
        profile_id: profile.profile_id.clone(),
        name: profile.name.clone(),
        schema_version: profile.schema_version.clone(),
        profile_json: canonical,
        export_path: export_path.to_string_lossy().to_string(),
    }
}

fn active_profile_json(conn: &rusqlite::Connection) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT p.profile_json FROM agent_profile_state s
         JOIN agent_profiles p ON p.profile_id = s.active_profile_id
         WHERE s.singleton = 1",
        [],
        |row| row.get(0),
    )
    .optional()
}

#[tauri::command]
pub fn agent_profile_get(state: State<AppState>) -> CmdResult<Option<AgentProfileView>> {
    let db = state
        .db
        .lock()
        .map_err(|_| CmdError::from("AGENT_PROFILE_DB_LOCK"))?;
    let stored = active_profile_json(&db.conn)?;
    let Some(stored) = stored else {
        return Ok(None);
    };
    let (profile, canonical) = parse_and_validate_profile(&stored)?;
    Ok(Some(profile_view(
        &profile,
        canonical,
        &state.paths.agent_profile_path,
    )))
}

#[tauri::command]
pub fn agent_profile_save(
    state: State<AppState>,
    profile_json: String,
) -> CmdResult<AgentProfileView> {
    let (profile, canonical) = parse_and_validate_profile(&profile_json)?;
    let db = state
        .db
        .lock()
        .map_err(|_| CmdError::from("AGENT_PROFILE_DB_LOCK"))?;
    let transaction = db.conn.unchecked_transaction()?;
    transaction.execute(
        "INSERT INTO agent_profiles (profile_id, name, schema_version, profile_json, updated_at)
         VALUES (?1, ?2, ?3, ?4, unixepoch())
         ON CONFLICT(profile_id) DO UPDATE SET
           name=excluded.name, schema_version=excluded.schema_version,
           profile_json=excluded.profile_json, updated_at=unixepoch()",
        rusqlite::params![
            profile.profile_id,
            profile.name,
            profile.schema_version,
            canonical
        ],
    )?;
    transaction.execute(
        "UPDATE agent_profile_state SET active_profile_id = ?1 WHERE singleton = 1",
        [&profile.profile_id],
    )?;
    transaction.commit()?;
    Ok(profile_view(
        &profile,
        canonical,
        &state.paths.agent_profile_path,
    ))
}

#[tauri::command]
pub fn agent_profile_export(state: State<AppState>) -> CmdResult<String> {
    let view = agent_profile_get(state.clone())?
        .ok_or_else(|| CmdError::from("AGENT_PROFILE_NOT_CONFIGURED"))?;
    atomic_write(
        &state.paths.agent_profile_path,
        view.profile_json.as_bytes(),
    )
    .map_err(|_| CmdError::from("AGENT_PROFILE_EXPORT_FAILED"))?;
    Ok(state.paths.agent_profile_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn agent_profile_open_directory(
    app: tauri::AppHandle,
    state: State<AppState>,
) -> CmdResult<()> {
    use tauri_plugin_opener::OpenerExt;
    std::fs::create_dir_all(&state.paths.agent_dir)
        .map_err(|_| CmdError::from("AGENT_PROFILE_DIRECTORY_FAILED"))?;
    app.opener()
        .open_path(
            state.paths.agent_dir.to_string_lossy().to_string(),
            None::<String>,
        )
        .map_err(|_| CmdError::from("AGENT_PROFILE_DIRECTORY_FAILED"))?;
    Ok(())
}

#[tauri::command]
pub fn navigation_pins_get(state: State<AppState>) -> CmdResult<Vec<String>> {
    let db = state
        .db
        .lock()
        .map_err(|_| CmdError::from("NAVIGATION_PIN_DB_LOCK"))?;
    let mut statement = db
        .conn
        .prepare("SELECT item_id FROM navigation_pins ORDER BY sort_order, pinned_at, item_id")?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

#[tauri::command]
pub fn navigation_pin_set(state: State<AppState>, item_id: String, pinned: bool) -> CmdResult<()> {
    if !is_action_id(&item_id) {
        return Err(CmdError::from("NAVIGATION_PIN_ID_INVALID"));
    }
    let db = state
        .db
        .lock()
        .map_err(|_| CmdError::from("NAVIGATION_PIN_DB_LOCK"))?;
    if pinned {
        db.conn.execute(
            "INSERT OR IGNORE INTO navigation_pins (item_id, sort_order)
             VALUES (?1, COALESCE((SELECT MAX(sort_order) + 1 FROM navigation_pins), 0))",
            [&item_id],
        )?;
    } else {
        db.conn
            .execute("DELETE FROM navigation_pins WHERE item_id = ?1", [&item_id])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_profile() -> String {
        serde_json::json!({
            "schemaVersion": PROFILE_SCHEMA,
            "profileId": "default",
            "name": "默认 Agent 配置",
            "actions": [{
                "actionId": "builtin.utilities.base64",
                "expectedContractVersion": "1.0",
                "expectedActionVersion": "1.0.0",
                "expectedSourceKind": "builtin",
                "expectedPublisherId": "useful.project",
                "enabled": { "cli": true, "mcp": true },
                "aliases": ["b64-encode"],
                "presets": [{ "presetId": "encode", "name": "编码", "defaults": { "operation": "encode" } }]
            }]
        })
        .to_string()
    }

    #[test]
    fn ipc_boundary_accepts_safe_profile_and_is_deterministic() {
        let (profile, first) = parse_and_validate_profile(&valid_profile()).unwrap();
        let (_, second) = parse_and_validate_profile(&first).unwrap();
        assert_eq!(profile.profile_id, "default");
        assert_eq!(first, second);
        assert!(first.ends_with('\n'));
    }

    #[test]
    fn canonical_bytes_are_identical_for_different_object_key_order() {
        let first = valid_profile();
        let second = r#"{
          "name":"默认 Agent 配置",
          "profileId":"default",
          "actions":[{
            "presets":[{"defaults":{"operation":"encode"},"name":"编码","presetId":"encode"}],
            "aliases":["b64-encode"],
            "enabled":{"mcp":true,"cli":true},
            "expectedPublisherId":"useful.project",
            "expectedSourceKind":"builtin",
            "expectedActionVersion":"1.0.0",
            "expectedContractVersion":"1.0",
            "actionId":"builtin.utilities.base64"
          }],
          "schemaVersion":"useful.agent-profile.v1"
        }"#;
        let (_, first_bytes) = parse_and_validate_profile(&first).unwrap();
        let (_, second_bytes) = parse_and_validate_profile(second).unwrap();
        assert_eq!(first_bytes.as_bytes(), second_bytes.as_bytes());
    }

    #[test]
    fn semver_matches_profile_schema_pattern() {
        for valid in ["0.0.0", "1.2.3", "1.2.3-rc.1", "1.2.3--"] {
            assert!(is_semver(valid), "{valid}");
        }
        for invalid in [
            "1.2",
            "v1.2.3",
            "1.2.3+build",
            "1.2.3-",
            "1.2.x",
            "1.2.3-rc_1",
        ] {
            assert!(!is_semver(invalid), "{invalid}");
        }
    }

    #[test]
    fn action_id_matches_profile_schema_shape() {
        for valid in ["a.b", "builtin.utilities.foo--bar", "a.b__c", "a.0"] {
            assert!(is_action_id(valid), "{valid}");
        }
        for invalid in ["a", "A.b", "a..b", "a.-b", "a.b+c", "a.B"] {
            assert!(!is_action_id(invalid), "{invalid}");
        }
    }

    #[test]
    fn missing_active_row_is_none_but_database_errors_propagate() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE agent_profiles (profile_id TEXT PRIMARY KEY, profile_json TEXT NOT NULL);
                 CREATE TABLE agent_profile_state (singleton INTEGER PRIMARY KEY, active_profile_id TEXT);
                 INSERT INTO agent_profile_state VALUES (1, NULL);",
            )
            .unwrap();
        assert_eq!(active_profile_json(&connection).unwrap(), None);
        connection.execute("DROP TABLE agent_profiles", []).unwrap();
        assert!(active_profile_json(&connection).is_err());
    }

    #[test]
    fn ipc_boundary_rejects_unknown_dangerous_oversized_and_sensitive_defaults() {
        let mut value: Value = serde_json::from_str(&valid_profile()).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .insert("command".into(), Value::String("calc".into()));
        assert!(parse_and_validate_profile(&value.to_string()).is_err());

        let mut dangerous: Value = serde_json::from_str(&valid_profile()).unwrap();
        dangerous["actions"][0]["presets"][0]["defaults"]
            .as_object_mut()
            .unwrap()
            .insert("__proto__".into(), Value::Object(Map::new()));
        assert!(parse_and_validate_profile(&dangerous.to_string()).is_err());

        let mut sensitive: Value = serde_json::from_str(&valid_profile()).unwrap();
        sensitive["actions"][0]["presets"][0]["defaults"]
            .as_object_mut()
            .unwrap()
            .insert("text".into(), Value::String("TOP_SECRET".into()));
        let error = parse_and_validate_profile(&sensitive.to_string()).unwrap_err();
        assert!(!error.message.contains("TOP_SECRET"));

        for (path, value) in [
            ("/name", "${PROFILE}"),
            ("/actions/0/expectedPublisherId", "{{publisher}}"),
        ] {
            let mut expression: Value = serde_json::from_str(&valid_profile()).unwrap();
            if path == "/name" {
                expression["name"] = Value::String(value.into());
            } else {
                expression["actions"][0]["expectedPublisherId"] = Value::String(value.into());
            }
            assert!(
                parse_and_validate_profile(&expression.to_string()).is_err(),
                "{path}"
            );
        }

        let oversized = format!("{{\"x\":\"{}\"}}", "x".repeat(PROFILE_MAX_BYTES));
        assert!(parse_and_validate_profile(&oversized).is_err());
    }

    #[test]
    fn ipc_boundary_matches_alias_defaults_and_builtin_property_schema() {
        let mut one_alias: Value = serde_json::from_str(&valid_profile()).unwrap();
        one_alias["actions"][0]["aliases"] = serde_json::json!(["a"]);
        assert!(parse_and_validate_profile(&one_alias.to_string()).is_err());

        let builtin_vectors = [
            (
                "builtin.utilities.json",
                serde_json::json!({"operation":"format","indent":0}),
            ),
            (
                "builtin.utilities.json",
                serde_json::json!({"operation":"minify","indent":8}),
            ),
            (
                "builtin.utilities.base64",
                serde_json::json!({"operation":"decode"}),
            ),
            (
                "builtin.utilities.hash",
                serde_json::json!({"algorithm":"SHA-1"}),
            ),
            (
                "builtin.utilities.hash",
                serde_json::json!({"algorithm":"SHA-256"}),
            ),
            (
                "builtin.utilities.hash",
                serde_json::json!({"algorithm":"SHA-384"}),
            ),
            (
                "builtin.utilities.hash",
                serde_json::json!({"algorithm":"SHA-512"}),
            ),
        ];
        for (action_id, defaults) in builtin_vectors {
            let object = defaults.as_object().unwrap();
            assert!(
                validate_known_builtin_defaults(action_id, object).is_ok(),
                "{action_id}"
            );
        }

        let invalid_vectors = [
            (
                "builtin.utilities.json",
                serde_json::json!({"operation":"merge"}),
            ),
            ("builtin.utilities.json", serde_json::json!({"indent":9})),
            ("builtin.utilities.json", serde_json::json!({"indent":2.5})),
            (
                "builtin.utilities.base64",
                serde_json::json!({"operation":"shell"}),
            ),
            (
                "builtin.utilities.hash",
                serde_json::json!({"algorithm":"MD5"}),
            ),
        ];
        for (action_id, defaults) in invalid_vectors {
            let secret_value = defaults.to_string();
            let error = validate_known_builtin_defaults(action_id, defaults.as_object().unwrap())
                .unwrap_err();
            assert!(error.message.contains("DEFAULT_VALUE_INVALID"));
            assert!(!error.message.contains(&secret_value));
        }

        let mut too_many: Value = serde_json::from_str(&valid_profile()).unwrap();
        too_many["actions"][0]["actionId"] = Value::String("com.example.plugin.action".into());
        too_many["actions"][0]["expectedSourceKind"] = Value::String("plugin".into());
        let defaults = too_many["actions"][0]["presets"][0]["defaults"]
            .as_object_mut()
            .unwrap();
        defaults.clear();
        for index in 0..65 {
            defaults.insert(format!("field{index}"), Value::Bool(true));
        }
        let error = parse_and_validate_profile(&too_many.to_string()).unwrap_err();
        assert!(error.message.contains("DEFAULTS_PROPERTY_LIMIT"));
        assert!(!error.message.contains("field64"));
    }
}
