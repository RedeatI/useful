//! 快捷方式命令：创建、列出、删除、修复（软件移动目录后重指向）。

use super::{CmdError, CmdResult};
use crate::state::AppState;
use serde::Serialize;
use tauri::State;
use useful_shortcuts::{
    create_shortcut as create_lnk, delete_shortcut as delete_lnk, desktop_dir, repair_shortcut,
    sanitize_filename, ShortcutSpec,
};

const BUILTIN_UTILITY_ACTION_IDS: &[&str] = &[
    "builtin.utilities.json",
    "builtin.utilities.base64",
    "builtin.utilities.hash",
    "builtin.utilities.url",
    "builtin.utilities.uuid",
    "builtin.utilities.password",
    "builtin.utilities.timestamp",
    "builtin.utilities.base-convert",
    "builtin.utilities.color",
    "builtin.utilities.case",
    "builtin.utilities.regex",
    "builtin.utilities.jwt",
    "builtin.utilities.html",
    "builtin.utilities.hex-text",
    "builtin.utilities.morse",
    "builtin.utilities.text-stats",
    "builtin.utilities.text-lines",
    "builtin.utilities.slug",
    "builtin.utilities.byte-size",
    "builtin.utilities.lorem",
    "builtin.utilities.duration",
    "builtin.utilities.byte-unit",
    "builtin.utilities.number-format",
    "builtin.utilities.unicode",
    "builtin.utilities.caesar",
    "builtin.utilities.luhn",
    "builtin.utilities.contrast",
    "builtin.utilities.random-number",
    "builtin.utilities.data-format",
    "builtin.utilities.text-diff",
    "builtin.utilities.ipv4",
];

fn validate_action_id(action_id: &str) -> CmdResult<()> {
    if action_id.is_empty() {
        return Err(CmdError::from("action ID 不能为空"));
    }
    if action_id.len() > 128 {
        return Err(CmdError::from("action ID 过长"));
    }
    if !action_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
    {
        return Err(CmdError::from("action ID 含非法字符"));
    }
    if !BUILTIN_UTILITY_ACTION_IDS.contains(&action_id) {
        return Err(CmdError::from(format!("action 不存在: {action_id}")));
    }
    Ok(())
}

fn canonical_shortcut_args(id: &str) -> Vec<String> {
    if id.starts_with("builtin.utilities.") {
        vec!["--open-action".into(), id.into()]
    } else {
        vec!["--open-tool".into(), id.into()]
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutRecord {
    pub id: i64,
    pub tool_id: String,
    pub lnk_path: String,
    pub icon_path: Option<String>,
    pub target_exe: String,
    pub args: String,
}

/// 当前 Useful 可执行文件绝对路径（Windows 主程序为 Useful.exe）。
fn current_exe() -> Result<std::path::PathBuf, CmdError> {
    std::env::current_exe().map_err(|e| CmdError::from(e.to_string()))
}

fn resolved_desktop() -> Result<std::path::PathBuf, CmdError> {
    #[cfg(feature = "native-test")]
    if let Some(path) = std::env::var_os("USEFUL_NATIVE_TEST_DESKTOP") {
        let path = std::path::PathBuf::from(path);
        std::fs::create_dir_all(&path).map_err(|error| CmdError::from(error.to_string()))?;
        return Ok(path);
    }
    desktop_dir().map_err(|error| CmdError::from(error.to_string()))
}

#[tauri::command]
pub fn create_shortcut(state: State<AppState>, tool_id: String) -> CmdResult<ShortcutRecord> {
    // 校验工具存在并取显示名
    let (display_name, icon_path) = {
        let reg = state
            .registry
            .lock()
            .map_err(|_| CmdError::from("锁定注册表失败"))?;
        let tool = reg
            .get(&tool_id)
            .ok_or_else(|| CmdError::from(format!("工具不存在: {tool_id}")))?;
        // 内置工具用其名称 key 的末段作为回退显示名（前端已本地化，这里用 id 简写）
        let name = tool.name.clone();
        (name, None::<std::path::PathBuf>)
    };

    let exe = current_exe()?;
    let desktop = resolved_desktop()?;
    // 显示名：内置工具的 i18n key 不适合做文件名，做一次简单映射
    let file_name = friendly_name(&tool_id, &display_name);

    let spec = ShortcutSpec::for_tool(
        exe.clone(),
        &desktop,
        &tool_id,
        &file_name,
        icon_path.clone(),
    );
    if spec.lnk_path.exists() {
        let db = state
            .db
            .lock()
            .map_err(|_| CmdError::from("锁定数据库失败"))?;
        let existing: Option<String> = db
            .conn
            .query_row(
                "SELECT tool_id FROM shortcuts WHERE lnk_path = ?1",
                [spec.lnk_path.to_string_lossy().as_ref()],
                |row| row.get(0),
            )
            .ok();
        if existing.as_deref() != Some(tool_id.as_str()) {
            return Err(CmdError::from(format!(
                "同名快捷方式已存在: {}",
                spec.lnk_path.display()
            )));
        }
    }
    create_lnk(&spec).map_err(|e| CmdError::from(e.to_string()))?;

    let db = state
        .db
        .lock()
        .map_err(|_| CmdError::from("锁定数据库失败"))?;
    let lnk_path = spec.lnk_path.to_string_lossy().to_string();
    let target = spec.target_exe.to_string_lossy().to_string();
    let args = spec.arguments_string();
    db.conn.execute(
        "INSERT INTO shortcuts (tool_id, lnk_path, icon_path, target_exe, args)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(lnk_path) DO UPDATE SET tool_id=?1, target_exe=?4, args=?5",
        rusqlite::params![
            tool_id,
            lnk_path,
            icon_path.map(|p| p.to_string_lossy().to_string()),
            target,
            args
        ],
    )?;
    let id = db.conn.query_row(
        "SELECT id FROM shortcuts WHERE lnk_path = ?1",
        [&lnk_path],
        |row| row.get(0),
    )?;
    Ok(ShortcutRecord {
        id,
        tool_id,
        lnk_path,
        icon_path: None,
        target_exe: target,
        args,
    })
}

/// Phase 12: 为 action 级创建桌面快捷方式（--open-action <actionId>）。
#[tauri::command]
pub fn create_action_shortcut(
    state: State<AppState>,
    action_id: String,
    display_name: String,
) -> CmdResult<ShortcutRecord> {
    validate_action_id(&action_id)?;

    let exe = current_exe()?;
    let desktop = resolved_desktop()?;
    let file_name = sanitize_filename(&display_name);
    if file_name.is_empty() {
        return Err(CmdError::from("快捷方式名称不能为空"));
    }

    let spec = ShortcutSpec {
        target_exe: exe.clone(),
        args: vec!["--open-action".into(), action_id.clone()],
        working_dir: exe
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| std::path::PathBuf::from(".")),
        lnk_path: desktop.join(format!("{file_name}.lnk")),
        icon_path: None,
        description: format!("Useful - {display_name}"),
    };
    if spec.lnk_path.exists() {
        let db = state
            .db
            .lock()
            .map_err(|_| CmdError::from("锁定数据库失败"))?;
        let existing: Option<String> = db
            .conn
            .query_row(
                "SELECT tool_id FROM shortcuts WHERE lnk_path = ?1",
                [spec.lnk_path.to_string_lossy().as_ref()],
                |row| row.get(0),
            )
            .ok();
        if existing.as_deref() != Some(action_id.as_str()) {
            return Err(CmdError::from(format!(
                "同名快捷方式已存在: {}",
                spec.lnk_path.display()
            )));
        }
    }
    create_lnk(&spec).map_err(|e| CmdError::from(e.to_string()))?;

    let db = state
        .db
        .lock()
        .map_err(|_| CmdError::from("锁定数据库失败"))?;
    let lnk_path = spec.lnk_path.to_string_lossy().to_string();
    let target = spec.target_exe.to_string_lossy().to_string();
    let args = spec.arguments_string();
    db.conn.execute(
        "INSERT INTO shortcuts (tool_id, lnk_path, icon_path, target_exe, args)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(lnk_path) DO UPDATE SET tool_id=?1, target_exe=?4, args=?5",
        rusqlite::params![action_id, lnk_path, None::<String>, target, args],
    )?;
    let id = db.conn.query_row(
        "SELECT id FROM shortcuts WHERE lnk_path = ?1",
        [&lnk_path],
        |row| row.get(0),
    )?;
    Ok(ShortcutRecord {
        id,
        tool_id: action_id,
        lnk_path,
        icon_path: None,
        target_exe: target,
        args,
    })
}

#[tauri::command]
pub fn list_shortcuts(state: State<AppState>) -> CmdResult<Vec<ShortcutRecord>> {
    let db = state
        .db
        .lock()
        .map_err(|_| CmdError::from("锁定数据库失败"))?;
    let mut stmt = db.conn.prepare(
        "SELECT id, tool_id, lnk_path, icon_path, target_exe, args FROM shortcuts ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(ShortcutRecord {
            id: r.get(0)?,
            tool_id: r.get(1)?,
            lnk_path: r.get(2)?,
            icon_path: r.get(3)?,
            target_exe: r.get(4)?,
            args: r.get(5)?,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub fn delete_shortcut(state: State<AppState>, id: i64) -> CmdResult<()> {
    let db = state
        .db
        .lock()
        .map_err(|_| CmdError::from("锁定数据库失败"))?;
    let lnk: Option<String> = db
        .conn
        .query_row("SELECT lnk_path FROM shortcuts WHERE id = ?1", [id], |r| {
            r.get(0)
        })
        .ok();
    if let Some(path) = lnk {
        delete_lnk(std::path::Path::new(&path)).map_err(|e| CmdError::from(e.to_string()))?;
    }
    db.conn
        .execute("DELETE FROM shortcuts WHERE id = ?1", [id])?;
    Ok(())
}

/// 修复全部快捷方式：把 target 重指向当前 exe（用于软件移动目录后）。返回修复数量。
#[tauri::command]
pub fn repair_all_shortcuts(state: State<AppState>) -> CmdResult<u32> {
    let exe = current_exe()?;
    let registered_tools: std::collections::HashSet<String> = state
        .registry
        .lock()
        .map_err(|_| CmdError::from("锁定注册表失败"))?
        .list()
        .into_iter()
        .map(|tool| tool.id.clone())
        .collect();
    let db = state
        .db
        .lock()
        .map_err(|_| CmdError::from("锁定数据库失败"))?;
    // 先收集记录，释放语句借用
    let records: Vec<ShortcutRecord> = {
        let mut stmt = db
            .conn
            .prepare("SELECT id, tool_id, lnk_path, icon_path, target_exe, args FROM shortcuts")?;
        let rows = stmt.query_map([], |r| {
            Ok(ShortcutRecord {
                id: r.get(0)?,
                tool_id: r.get(1)?,
                lnk_path: r.get(2)?,
                icon_path: r.get(3)?,
                target_exe: r.get(4)?,
                args: r.get(5)?,
            })
        })?;
        rows.filter_map(|r| r.ok()).collect()
    };

    let mut repaired = 0u32;
    for rec in records {
        let action_exists = if rec.tool_id.starts_with("builtin.utilities.") {
            validate_action_id(&rec.tool_id).is_ok()
        } else {
            registered_tools.contains(&rec.tool_id)
        };
        if !action_exists {
            delete_lnk(std::path::Path::new(&rec.lnk_path))
                .map_err(|e| CmdError::from(e.to_string()))?;
            db.conn
                .execute("DELETE FROM shortcuts WHERE id = ?1", [rec.id])?;
            continue;
        }
        // 从已验证 identity 重建规范参数，绝不重新解析数据库中的命令行字符串。
        let args = canonical_shortcut_args(&rec.tool_id);
        let spec = ShortcutSpec {
            target_exe: exe.clone(),
            args,
            working_dir: exe.parent().map(|p| p.to_path_buf()).unwrap_or_default(),
            lnk_path: std::path::PathBuf::from(&rec.lnk_path),
            icon_path: rec
                .icon_path
                .clone()
                .map(std::path::PathBuf::from)
                .filter(|path| path.is_file()),
            description: format!("Useful - {}", rec.tool_id),
        };
        if repair_shortcut(&spec).is_ok() {
            let target = exe.to_string_lossy().to_string();
            let _ = db.conn.execute(
                "UPDATE shortcuts SET target_exe = ?1 WHERE id = ?2",
                rusqlite::params![target, rec.id],
            );
            repaired += 1;
        }
    }
    Ok(repaired)
}

/// 为内置工具 id 生成友好的文件名。
fn friendly_name(tool_id: &str, fallback: &str) -> String {
    match tool_id {
        "builtin.video-trim" => "视频裁剪".to_string(),
        "builtin.process-monitor" => "进程监视器".to_string(),
        _ => {
            // 第三方工具直接用显示名
            if fallback.contains('.') {
                tool_id.rsplit('.').next().unwrap_or(tool_id).to_string()
            } else {
                fallback.to_string()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_action_baseline_is_complete() {
        assert_eq!(BUILTIN_UTILITY_ACTION_IDS.len(), 31);
        assert!(validate_action_id("builtin.utilities.base64").is_ok());
        assert!(validate_action_id("builtin.utilities.hash").is_ok());
        assert!(validate_action_id("builtin.utilities.data-format").is_ok());
        assert!(validate_action_id("builtin.utilities.text-diff").is_ok());
        assert!(validate_action_id("builtin.utilities.ipv4").is_ok());
    }

    #[test]
    fn action_validation_rejects_unknown_injection_and_overlong_ids() {
        assert!(validate_action_id("builtin.utilities.missing").is_err());
        assert!(validate_action_id("builtin.utilities.base64 --file pwned").is_err());
        assert!(validate_action_id(&"a".repeat(129)).is_err());
        assert!(validate_action_id("builtin.utilities.base64\" --file x").is_err());
    }

    #[test]
    fn repair_arguments_are_rebuilt_from_identity() {
        assert_eq!(
            canonical_shortcut_args("builtin.utilities.base64"),
            vec!["--open-action", "builtin.utilities.base64"]
        );
        assert_eq!(
            canonical_shortcut_args("com.example.tool"),
            vec!["--open-tool", "com.example.tool"]
        );
    }
}
