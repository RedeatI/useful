//! 插件 manifest 结构与双重校验（serde 强类型 + JSON Schema）。

use crate::error::PluginError;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::OnceLock;

/// manifest 内嵌的 JSON Schema（schemaVersion 1）。
pub const MANIFEST_SCHEMA: &str = include_str!("manifest.schema.json");

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    pub entry: Entry,
    #[serde(default)]
    pub contributes: Contributes,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default = "default_platforms")]
    pub platforms: Vec<String>,
    #[serde(default = "default_min_host")]
    pub min_host_version: String,
}

fn default_platforms() -> Vec<String> {
    vec!["windows-x64".into()]
}
fn default_min_host() -> String {
    "0.1.0".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    #[serde(rename = "type")]
    pub entry_type: EntryType,
    /// web: HTML 相对路径；launcher: 声明的程序/脚本/URL；worker: 可执行相对路径
    pub path: String,
    /// launcher/worker 的参数模板
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryType {
    Web,
    Launcher,
    Worker,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Contributes {
    #[serde(default)]
    pub sidebar: Vec<SidebarItem>,
    #[serde(default)]
    pub actions: Vec<ActionContribution>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionContribution {
    pub action_id: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SidebarItem {
    pub id: String,
    pub title: String,
    #[serde(default = "default_group")]
    pub group: String,
    #[serde(default)]
    pub order: i32,
}

fn default_group() -> String {
    "installed".into()
}

fn schema() -> &'static jsonschema::Validator {
    static SCHEMA: OnceLock<jsonschema::Validator> = OnceLock::new();
    SCHEMA.get_or_init(|| {
        let value: serde_json::Value =
            serde_json::from_str(MANIFEST_SCHEMA).expect("内置 schema 必须是合法 JSON");
        jsonschema::validator_for(&value).expect("内置 schema 必须可编译")
    })
}

impl PluginManifest {
    /// 双重校验：先 JSON Schema，再 serde 强类型，再语义校验。
    pub fn parse_and_validate(bytes: &[u8]) -> Result<PluginManifest, PluginError> {
        let value: serde_json::Value = serde_json::from_slice(bytes)
            .map_err(|e| PluginError::ManifestInvalid(format!("非法 JSON: {e}")))?;

        // 1) JSON Schema 校验
        if let Err(err) = schema().validate(&value) {
            return Err(PluginError::ManifestInvalid(format!(
                "schema 校验失败: {err}"
            )));
        }

        // 2) serde 强类型反序列化
        let manifest: PluginManifest = serde_json::from_value(value)
            .map_err(|e| PluginError::ManifestInvalid(format!("类型校验失败: {e}")))?;

        // 3) 语义校验
        manifest.validate_semantics()?;
        Ok(manifest)
    }

    fn validate_semantics(&self) -> Result<(), PluginError> {
        if self.schema_version != 1 {
            return Err(PluginError::ManifestInvalid(format!(
                "不支持的 schemaVersion: {}",
                self.schema_version
            )));
        }
        // 反向域名式 ID：小写字母、数字、点、连字符
        if !is_valid_plugin_id(&self.id) {
            return Err(PluginError::ManifestInvalid(format!(
                "非法插件 ID: {}",
                self.id
            )));
        }
        semver::Version::parse(&self.version)
            .map_err(|e| PluginError::ManifestInvalid(format!("非法版本号: {e}")))?;
        semver::Version::parse(&self.min_host_version)
            .map_err(|e| PluginError::ManifestInvalid(format!("非法 minHostVersion: {e}")))?;

        // entry.path 不得为绝对路径或包含穿越（launcher 的 URL 例外）
        if self.entry.entry_type != EntryType::Launcher {
            crate::zip_safety::ensure_safe_relative(&self.entry.path)
                .map_err(|e| PluginError::ManifestInvalid(format!("entry.path 不安全: {e}")))?;
        }
        if let Some(icon) = &self.icon {
            crate::zip_safety::ensure_safe_relative(icon)
                .map_err(|e| PluginError::ManifestInvalid(format!("icon 路径不安全: {e}")))?;
        }
        let unknown = crate::permissions::unknown_permissions(&self.permissions);
        if !unknown.is_empty() {
            return Err(PluginError::ManifestInvalid(format!(
                "首发版本不支持这些 native 权限: {}",
                unknown.join(", ")
            )));
        }
        let launch_declared = self
            .permissions
            .iter()
            .any(|permission| permission == "process.launch.declared");
        if self.entry.entry_type == EntryType::Launcher && !launch_declared {
            return Err(PluginError::ManifestInvalid(
                "launcher 必须声明 process.launch.declared".into(),
            ));
        }
        if self.entry.entry_type != EntryType::Launcher && !self.permissions.is_empty() {
            return Err(PluginError::ManifestInvalid(
                "web/worker 插件首发版本必须使用 permissions: []".into(),
            ));
        }
        if self.contributes.actions.len() > 32 {
            return Err(PluginError::ManifestInvalid(
                "contributes.actions 最多 32 项".into(),
            ));
        }
        if !self.contributes.actions.is_empty()
            && !is_valid_action_id(&format!("{}.action", self.id))
        {
            return Err(PluginError::ManifestInvalid(
                "含 actions 的插件 ID 必须是可产生合法 actionId 的小写命名空间".into(),
            ));
        }
        let mut action_ids = HashSet::new();
        let mut action_paths = HashSet::new();
        for action in &self.contributes.actions {
            if !is_valid_action_id(&action.action_id)
                || !action.action_id.starts_with(&format!("{}.", self.id))
                || !action_ids.insert(action.action_id.as_str())
            {
                return Err(PluginError::ManifestInvalid(
                    "actionId 必须唯一且位于插件命名空间".into(),
                ));
            }
            crate::zip_safety::ensure_safe_relative(&action.path)
                .map_err(|e| PluginError::ManifestInvalid(format!("action path 不安全: {e}")))?;
            if !action_paths.insert(action.path.as_str()) {
                return Err(PluginError::ManifestInvalid("action path 不得重复".into()));
            }
        }
        Ok(())
    }

    /// 检查宿主版本是否满足 minHostVersion。
    pub fn check_host_version(&self, host_version: &str) -> Result<(), PluginError> {
        let required = semver::Version::parse(&self.min_host_version)
            .map_err(|e| PluginError::VersionIncompatible(e.to_string()))?;
        let current = semver::Version::parse(host_version)
            .map_err(|e| PluginError::VersionIncompatible(e.to_string()))?;
        if current < required {
            return Err(PluginError::HostVersionTooLow {
                required: self.min_host_version.clone(),
                current: host_version.to_string(),
            });
        }
        Ok(())
    }

    pub fn supports_windows_x64(&self) -> bool {
        self.platforms.iter().any(|p| p == "windows-x64")
    }
}

/// 校验插件 ID：反向域名，段之间用点分隔，每段以字母开头。
pub fn is_valid_plugin_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 128 {
        return false;
    }
    let segments: Vec<&str> = id.split('.').collect();
    if segments.len() < 2 {
        return false;
    }
    segments.iter().all(|seg| {
        !seg.is_empty()
            && seg
                .chars()
                .next()
                .map(|c| c.is_ascii_alphabetic())
                .unwrap_or(false)
            && seg
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    })
}

/// ActionDescriptor v1 actionId：全小写；首段以字母开头，后续段可由数字开头。
pub fn is_valid_action_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 200 {
        return false;
    }
    let segments: Vec<&str> = id.split('.').collect();
    if segments.len() < 2 {
        return false;
    }
    segments.iter().enumerate().all(|(index, segment)| {
        let Some(first) = segment.chars().next() else {
            return false;
        };
        let valid_first = if index == 0 {
            first.is_ascii_lowercase()
        } else {
            first.is_ascii_lowercase() || first.is_ascii_digit()
        };
        valid_first
            && segment.chars().all(|character| {
                character.is_ascii_lowercase()
                    || character.is_ascii_digit()
                    || character == '-'
                    || character == '_'
            })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID: &str = r#"{
        "schemaVersion": 1,
        "id": "com.example.image-converter",
        "name": "图片转换",
        "version": "1.0.0",
        "description": "批量转换图片格式",
        "icon": "assets/icon.png",
        "entry": { "type": "web", "path": "dist/index.html" },
        "contributes": { "sidebar": [ { "id": "main", "title": "图片转换", "group": "installed", "order": 100 } ] },
        "permissions": [],
        "platforms": ["windows-x64"],
        "minHostVersion": "0.1.0"
    }"#;

    #[test]
    fn parses_valid_manifest() {
        let m = PluginManifest::parse_and_validate(VALID.as_bytes()).unwrap();
        assert_eq!(m.id, "com.example.image-converter");
        assert_eq!(m.entry.entry_type, EntryType::Web);
        assert_eq!(m.contributes.sidebar.len(), 1);
        assert!(m.supports_windows_x64());
    }

    #[test]
    fn rejects_missing_required_field() {
        let bad = VALID.replace("\"version\": \"1.0.0\",", "");
        assert!(PluginManifest::parse_and_validate(bad.as_bytes()).is_err());
    }

    #[test]
    fn rejects_bad_id() {
        let bad = VALID.replace("com.example.image-converter", "no-dots");
        assert!(PluginManifest::parse_and_validate(bad.as_bytes()).is_err());
        assert!(!is_valid_plugin_id("no-dots"));
        assert!(!is_valid_plugin_id("com..empty"));
        assert!(!is_valid_plugin_id("com.1bad.start"));
        assert!(is_valid_plugin_id("com.example.tool"));
    }

    #[test]
    fn rejects_path_traversal_in_entry() {
        let bad = VALID.replace("dist/index.html", "../../evil.html");
        assert!(PluginManifest::parse_and_validate(bad.as_bytes()).is_err());
    }

    #[test]
    fn first_release_permission_policy_is_entry_type_specific() {
        let web_native = VALID.replace(
            "\"permissions\": []",
            "\"permissions\": [\"process.launch.declared\"]",
        );
        assert!(PluginManifest::parse_and_validate(web_native.as_bytes()).is_err());

        let launcher = VALID.replace(
            "\"entry\": { \"type\": \"web\", \"path\": \"dist/index.html\" }",
            "\"entry\": { \"type\": \"launcher\", \"path\": \"tool.exe\" }",
        );
        assert!(PluginManifest::parse_and_validate(launcher.as_bytes()).is_err());
        let declared = launcher.replace(
            "\"permissions\": []",
            "\"permissions\": [\"process.launch.declared\"]",
        );
        assert!(PluginManifest::parse_and_validate(declared.as_bytes()).is_ok());
    }

    #[test]
    fn rejects_bad_version() {
        let bad = VALID.replace("\"1.0.0\"", "\"not-semver\"");
        assert!(PluginManifest::parse_and_validate(bad.as_bytes()).is_err());
    }

    #[test]
    fn host_version_check() {
        let m = PluginManifest::parse_and_validate(VALID.as_bytes()).unwrap();
        assert!(m.check_host_version("0.1.0").is_ok());
        assert!(m.check_host_version("0.2.0").is_ok());
        assert!(m.check_host_version("0.0.9").is_err());
    }

    #[test]
    fn parses_additive_action_contribution_and_rejects_unsafe_variants() {
        let with_action = VALID.replace(
            "\"sidebar\": [",
            "\"actions\": [{\"actionId\": \"com.example.image-converter.encode\", \"path\": \"actions/encode.json\"}], \"sidebar\": [",
        );
        let manifest = PluginManifest::parse_and_validate(with_action.as_bytes()).unwrap();
        assert_eq!(manifest.contributes.actions.len(), 1);

        let wrong_namespace =
            with_action.replace("com.example.image-converter.encode", "com.attacker.encode");
        assert!(PluginManifest::parse_and_validate(wrong_namespace.as_bytes()).is_err());

        let traversal = with_action.replace("actions/encode.json", "../encode.json");
        assert!(PluginManifest::parse_and_validate(traversal.as_bytes()).is_err());
    }

    #[test]
    fn action_id_validator_matches_shared_vectors() {
        let vectors: serde_json::Value =
            serde_json::from_str(include_str!("../../../fixtures/action-id-vectors.json")).unwrap();
        for value in vectors["valid"].as_array().unwrap() {
            let value = value.as_str().unwrap();
            assert!(is_valid_action_id(value), "expected valid: {value}");
        }
        for value in vectors["invalid"].as_array().unwrap() {
            let value = value.as_str().unwrap();
            assert!(!is_valid_action_id(value), "expected invalid: {value}");
        }
    }

    #[test]
    fn action_namespace_requires_lowercase_plugin_id() {
        let with_action = VALID
            .replace("com.example.image-converter", "Com.example.image-converter")
            .replace(
                "\"sidebar\": [",
                "\"actions\": [{\"actionId\": \"com.example.image-converter.encode\", \"path\": \"actions/encode.json\"}], \"sidebar\": [",
            );
        assert!(PluginManifest::parse_and_validate(with_action.as_bytes()).is_err());
    }
}
