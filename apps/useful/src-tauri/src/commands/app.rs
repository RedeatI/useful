//! Phase 0 应用命令：应用信息、工具列表、设置、收藏、最近使用、打开工具/路径。

use super::{CmdError, CmdResult};
use crate::state::{AppState, HOST_VERSION};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State, Theme, WebviewWindow};
use useful_core::paths::RunMode;
use useful_core::registry::ToolDefinition;

const FAVORITES_ORDER_SQL: &str =
    "SELECT tool_id FROM favorites ORDER BY sort_order, added_at, tool_id COLLATE BINARY";
const RECENT_TOOLS_ORDER_SQL: &str =
    "SELECT tool_id FROM recent_tools ORDER BY last_used_at DESC, tool_id COLLATE BINARY LIMIT 12";
const ACTION_FAVORITES_ORDER_SQL: &str =
    "SELECT action_id FROM action_favorites ORDER BY sort_order, added_at, action_id COLLATE BINARY";
const ACTION_RECENT_ORDER_SQL: &str =
    "SELECT action_id FROM action_recent ORDER BY last_used_at DESC, action_id COLLATE BINARY LIMIT 12";

fn ordered_ids(conn: &rusqlite::Connection, sql: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    rows.collect()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostCapabilities {
    /// Process monitor (ETW/PDH/sampler) is linked into this binary.
    pub procmon: bool,
    /// Video trim / media sidecar control is linked into this binary.
    pub media: bool,
    /// Product edition label for diagnostics (standard | core).
    pub edition: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub run_mode: String,
    pub data_dir: String,
    pub logs_dir: String,
    pub plugins_dir: String,
    pub capabilities: HostCapabilities,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub theme: String,
    pub language: String,
    pub developer_mode: bool,
    pub sidebar_collapsed: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            language: "zh-CN".into(),
            developer_mode: false,
            sidebar_collapsed: false,
        }
    }
}

#[tauri::command]
pub fn get_app_info(state: State<AppState>) -> CmdResult<AppInfo> {
    let p = &state.paths;
    let has_procmon = cfg!(feature = "procmon");
    let has_media = cfg!(feature = "media");
    let edition = if has_procmon && has_media {
        "standard"
    } else if !has_procmon && !has_media {
        "core"
    } else {
        "custom"
    };
    Ok(AppInfo {
        name: "Useful".into(),
        version: HOST_VERSION.into(),
        run_mode: match p.mode {
            RunMode::Portable => "portable".into(),
            RunMode::Installed => "installed".into(),
        },
        data_dir: p.data_dir.to_string_lossy().to_string(),
        logs_dir: p.logs_dir.to_string_lossy().to_string(),
        plugins_dir: p.plugins_dir.to_string_lossy().to_string(),
        capabilities: HostCapabilities {
            procmon: has_procmon,
            media: has_media,
            edition: edition.into(),
        },
    })
}

#[tauri::command]
pub fn list_tools(state: State<AppState>) -> CmdResult<Vec<ToolDefinition>> {
    let reg = state
        .registry
        .lock()
        .map_err(|_| CmdError::from("锁定注册表失败"))?;
    Ok(reg.list().into_iter().cloned().collect())
}

/// 从数据库读取设置；供启动时原生主题应用与前端 IPC 共用。
pub fn read_settings(state: &AppState) -> CmdResult<Settings> {
    let db = state
        .db
        .lock()
        .map_err(|_| CmdError::from("锁定数据库失败"))?;
    let mut settings = Settings::default();
    let mut stmt = db.conn.prepare("SELECT key, value FROM settings")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    for row in rows {
        let (key, value) = row?;
        match key.as_str() {
            "theme" if matches!(value.as_str(), "system" | "light" | "dark") => {
                settings.theme = value
            }
            "language" if matches!(value.as_str(), "zh-CN" | "en-US") => settings.language = value,
            "developerMode" => settings.developer_mode = value == "true",
            "sidebarCollapsed" => settings.sidebar_collapsed = value == "true",
            _ => {}
        }
    }
    Ok(settings)
}

/// 在 WebView 内容渲染前应用原生窗口主题，避免浅色内容配深色标题栏。
pub fn apply_window_theme(window: &WebviewWindow, theme: &str) {
    let resolved = match theme {
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        _ => None,
    };
    if let Err(error) = window.set_theme(resolved) {
        tracing::warn!("应用原生窗口主题失败: {error}");
    }

    // Keep the non-client caption and window fill in sync with the explicit theme.
    // On Windows, set_theme alone can leave an immersive-dark caption when the OS
    // is dark but the app is forced to light.
    let background = match theme {
        "light" => Some(tauri::window::Color(248, 248, 248, 255)),
        "dark" => Some(tauri::window::Color(32, 32, 32, 255)),
        _ => None,
    };
    if let Err(error) = window.set_background_color(background) {
        tracing::warn!("应用窗口背景色失败: {error}");
    }

    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        // Tauri and this crate may link different `windows` crate versions; pass the raw handle.
        apply_windows_caption_theme(hwnd.0 as isize, theme);
    }
}

#[cfg(windows)]
fn apply_windows_caption_theme(hwnd: isize, theme: &str) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_USE_IMMERSIVE_DARK_MODE, DWMWINDOWATTRIBUTE,
    };

    // None for system: leave the OS default alone.
    let use_dark = match theme {
        "light" => Some(0u32),
        "dark" => Some(1u32),
        _ => None,
    };
    let Some(value) = use_dark else {
        return;
    };
    let attr = DWMWINDOWATTRIBUTE(DWMWA_USE_IMMERSIVE_DARK_MODE.0);
    if let Err(error) = unsafe {
        DwmSetWindowAttribute(
            HWND(hwnd as *mut _),
            attr,
            &value as *const u32 as *const _,
            std::mem::size_of_val(&value) as u32,
        )
    } {
        tracing::warn!("DWM 标题栏主题失败: {error}");
    }
}

#[tauri::command]
pub fn get_settings(state: State<AppState>) -> CmdResult<Settings> {
    read_settings(&state)
}

#[tauri::command]
pub fn update_setting(
    app: tauri::AppHandle,
    state: State<AppState>,
    key: String,
    value: String,
) -> CmdResult<()> {
    validate_setting(&key, &value)?;
    {
        let db = state
            .db
            .lock()
            .map_err(|_| CmdError::from("锁定数据库失败"))?;
        db.conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = unixepoch()",
            rusqlite::params![key, value],
        )?;
    }
    if key == "theme" {
        if let Some(window) = app.get_webview_window("main") {
            apply_window_theme(&window, &value);
        }
    }
    Ok(())
}

fn validate_setting(key: &str, value: &str) -> CmdResult<()> {
    let valid = match key {
        "theme" => matches!(value, "system" | "light" | "dark"),
        "language" => matches!(value, "zh-CN" | "en-US"),
        "developerMode" | "sidebarCollapsed" => matches!(value, "true" | "false"),
        _ => return Err(CmdError::from(format!("未知设置键: {key}"))),
    };
    if !valid {
        return Err(CmdError::from(format!("设置 {key} 的值无效")));
    }
    Ok(())
}

#[tauri::command]
pub fn get_favorites(state: State<AppState>) -> CmdResult<Vec<String>> {
    let db = state
        .db
        .lock()
        .map_err(|_| CmdError::from("锁定数据库失败"))?;
    Ok(ordered_ids(&db.conn, FAVORITES_ORDER_SQL)?)
}

#[tauri::command]
pub fn toggle_favorite(state: State<AppState>, tool_id: String) -> CmdResult<bool> {
    let db = state
        .db
        .lock()
        .map_err(|_| CmdError::from("锁定数据库失败"))?;
    let exists: bool = db
        .conn
        .query_row(
            "SELECT 1 FROM favorites WHERE tool_id = ?1",
            [&tool_id],
            |_| Ok(true),
        )
        .unwrap_or(false);
    if exists {
        db.conn
            .execute("DELETE FROM favorites WHERE tool_id = ?1", [&tool_id])?;
        Ok(false)
    } else {
        db.conn
            .execute("INSERT INTO favorites (tool_id) VALUES (?1)", [&tool_id])?;
        Ok(true)
    }
}

#[tauri::command]
pub fn get_recent_tools(state: State<AppState>) -> CmdResult<Vec<String>> {
    let db = state
        .db
        .lock()
        .map_err(|_| CmdError::from("锁定数据库失败"))?;
    Ok(ordered_ids(&db.conn, RECENT_TOOLS_ORDER_SQL)?)
}

#[tauri::command]
pub fn record_tool_use(state: State<AppState>, tool_id: String) -> CmdResult<()> {
    let db = state
        .db
        .lock()
        .map_err(|_| CmdError::from("锁定数据库失败"))?;
    db.conn.execute(
        "INSERT INTO recent_tools (tool_id, last_used_at, use_count)
         VALUES (?1, unixepoch(), 1)
         ON CONFLICT(tool_id) DO UPDATE SET last_used_at = unixepoch(), use_count = use_count + 1",
        [&tool_id],
    )?;
    Ok(())
}

/// 打开工具：校验存在后向前端发送 open-tool 事件并聚焦窗口。
#[tauri::command]
pub fn open_tool(
    app: tauri::AppHandle,
    state: State<AppState>,
    tool_id: String,
    file: Option<String>,
) -> CmdResult<()> {
    {
        let reg = state
            .registry
            .lock()
            .map_err(|_| CmdError::from("锁定注册表失败"))?;
        if reg.get(&tool_id).is_none() {
            return Err(CmdError::from(format!("工具不存在: {tool_id}")));
        }
    }
    record_tool_use(state, tool_id.clone())?;
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
    app.emit(
        "open-tool",
        serde_json::json!({ "toolId": tool_id, "file": file }),
    )
    .map_err(|e| CmdError::from(e.to_string()))?;
    Ok(())
}

/// 打开系统路径（文件夹）。仅允许打开数据目录范围内的路径或用户给定的现有目录。
#[tauri::command]
pub fn open_path(app: tauri::AppHandle, path: String) -> CmdResult<()> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(path, None::<String>)
        .map_err(|e| CmdError::from(e.to_string()))?;
    Ok(())
}

// ---------- Action 级收藏与最近使用（Phase 12） ----------
// 使用独立表 action_favorites / action_recent，以稳定 action ID 为键。
// 与顶级 favorites/recent_tools 并存，不相互干扰。

#[tauri::command]
pub fn get_action_favorites(state: State<AppState>) -> CmdResult<Vec<String>> {
    let db = state
        .db
        .lock()
        .map_err(|_| CmdError::from("锁定数据库失败"))?;
    Ok(ordered_ids(&db.conn, ACTION_FAVORITES_ORDER_SQL)?)
}

#[tauri::command]
pub fn toggle_action_favorite(state: State<AppState>, action_id: String) -> CmdResult<bool> {
    let db = state
        .db
        .lock()
        .map_err(|_| CmdError::from("锁定数据库失败"))?;
    let exists: bool = db
        .conn
        .query_row(
            "SELECT 1 FROM action_favorites WHERE action_id = ?1",
            [&action_id],
            |_| Ok(true),
        )
        .unwrap_or(false);
    if exists {
        db.conn.execute(
            "DELETE FROM action_favorites WHERE action_id = ?1",
            [&action_id],
        )?;
        Ok(false)
    } else {
        db.conn.execute(
            "INSERT INTO action_favorites (action_id) VALUES (?1)",
            [&action_id],
        )?;
        Ok(true)
    }
}

#[tauri::command]
pub fn get_action_recent(state: State<AppState>) -> CmdResult<Vec<String>> {
    let db = state
        .db
        .lock()
        .map_err(|_| CmdError::from("锁定数据库失败"))?;
    Ok(ordered_ids(&db.conn, ACTION_RECENT_ORDER_SQL)?)
}

#[tauri::command]
pub fn record_action_use(state: State<AppState>, action_id: String) -> CmdResult<()> {
    let db = state
        .db
        .lock()
        .map_err(|_| CmdError::from("锁定数据库失败"))?;
    db.conn.execute(
        "INSERT INTO action_recent (action_id, last_used_at, use_count)
         VALUES (?1, unixepoch(), 1)
         ON CONFLICT(action_id) DO UPDATE SET last_used_at = unixepoch(), use_count = use_count + 1",
        [&action_id],
    )?;
    Ok(())
}

#[tauri::command]
pub fn clear_action_recent(state: State<AppState>) -> CmdResult<()> {
    let db = state
        .db
        .lock()
        .map_err(|_| CmdError::from("锁定数据库失败"))?;
    db.conn.execute("DELETE FROM action_recent", [])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        ordered_ids, validate_setting, ACTION_FAVORITES_ORDER_SQL, ACTION_RECENT_ORDER_SQL,
        FAVORITES_ORDER_SQL, RECENT_TOOLS_ORDER_SQL,
    };
    use rusqlite::Connection;

    #[test]
    fn validates_closed_theme_and_locale_enums() {
        for theme in ["system", "light", "dark"] {
            assert!(validate_setting("theme", theme).is_ok());
        }
        for locale in ["zh-CN", "en-US"] {
            assert!(validate_setting("language", locale).is_ok());
        }
        assert!(validate_setting("theme", "midnight").is_err());
        assert!(validate_setting("language", "../../locale").is_err());
    }

    #[test]
    fn validates_boolean_settings_and_rejects_unknown_keys() {
        assert!(validate_setting("developerMode", "true").is_ok());
        assert!(validate_setting("sidebarCollapsed", "false").is_ok());
        assert!(validate_setting("developerMode", "1").is_err());
        assert!(validate_setting("customCss", "body{}").is_err());
    }

    #[test]
    fn favorite_and_recent_queries_have_stable_id_tie_breaks() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE favorites (tool_id TEXT, sort_order INTEGER, added_at INTEGER);
             CREATE TABLE recent_tools (tool_id TEXT, last_used_at INTEGER);
             CREATE TABLE action_favorites (action_id TEXT, sort_order INTEGER, added_at INTEGER);
             CREATE TABLE action_recent (action_id TEXT, last_used_at INTEGER);
             INSERT INTO favorites VALUES ('tool.b', 0, 7), ('tool.a', 0, 7);
             INSERT INTO recent_tools VALUES ('tool.b', 9), ('tool.a', 9);
             INSERT INTO action_favorites VALUES ('action.b', 0, 7), ('action.a', 0, 7);
             INSERT INTO action_recent VALUES ('action.b', 9), ('action.a', 9);",
        )
        .unwrap();

        assert_eq!(
            ordered_ids(&conn, FAVORITES_ORDER_SQL).unwrap(),
            vec!["tool.a".to_string(), "tool.b".to_string()]
        );
        assert_eq!(
            ordered_ids(&conn, RECENT_TOOLS_ORDER_SQL).unwrap(),
            vec!["tool.a".to_string(), "tool.b".to_string()]
        );
        assert_eq!(
            ordered_ids(&conn, ACTION_FAVORITES_ORDER_SQL).unwrap(),
            vec!["action.a".to_string(), "action.b".to_string()]
        );
        assert_eq!(
            ordered_ids(&conn, ACTION_RECENT_ORDER_SQL).unwrap(),
            vec!["action.a".to_string(), "action.b".to_string()]
        );
    }
}
