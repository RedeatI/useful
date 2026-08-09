//! 插件命令：本地安装 .useful、列出、卸载、权限查询、导入 launcher、宿主桥调用。

use super::{CmdError, CmdResult};
use crate::state::{AppState, HOST_VERSION};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
#[cfg(feature = "native-test")]
use tauri::Emitter;
use tauri::{AppHandle, State};
use useful_core::registry::{ToolCategory, ToolDefinition, ToolKind};
use useful_plugin::install::{
    install_useful, sanitize_component, uninstall_version, InstallOptions, InstallOutcome,
};
use useful_plugin::manifest::{EntryType, PluginManifest};

#[derive(Default)]
pub struct PluginBridgeState {
    readable: Mutex<HashMap<String, HashSet<PathBuf>>>,
    writable: Mutex<HashMap<String, HashSet<PathBuf>>>,
}

pub(crate) fn tool_mutation_lock(tool_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    let locks = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut locks = locks
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    locks
        .entry(tool_id.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

/// 为沙箱 iframe 提供已安装插件静态资源。资源必须位于当前版本安装目录内。
pub(crate) fn plugin_protocol_response(
    context: tauri::UriSchemeContext<'_, tauri::Wry>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    use tauri::Manager;

    #[cfg(feature = "native-test")]
    tracing::info!(target: "plugin_protocol", "插件协议请求: {}", request.uri());

    if request.method() != tauri::http::Method::GET && request.method() != tauri::http::Method::HEAD
    {
        return protocol_error(
            tauri::http::StatusCode::METHOD_NOT_ALLOWED,
            "method not allowed",
        );
    }
    let segments: Vec<&str> = request
        .uri()
        .path()
        .trim_start_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    let Some(plugin_id) = segments.first().copied() else {
        return protocol_error(tauri::http::StatusCode::BAD_REQUEST, "plugin id is missing");
    };
    if !useful_plugin::manifest::is_valid_plugin_id(plugin_id) {
        return protocol_error(tauri::http::StatusCode::BAD_REQUEST, "invalid plugin id");
    }

    let state = context.app_handle().state::<AppState>();
    let installed: Option<(String, String)> = state.db.lock().ok().and_then(|db| {
        db.conn
            .query_row(
                "SELECT tv.install_dir, tv.manifest_json
                     FROM tools t
                     JOIN tool_versions tv ON tv.tool_id=t.id AND tv.version=t.current_version
                     WHERE t.id=?1 AND t.enabled=1",
                [plugin_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok()
    });
    let Some((install_dir, manifest_json)) = installed else {
        return protocol_error(tauri::http::StatusCode::NOT_FOUND, "plugin not installed");
    };
    let Ok(manifest) = serde_json::from_str::<PluginManifest>(&manifest_json) else {
        return protocol_error(
            tauri::http::StatusCode::INTERNAL_SERVER_ERROR,
            "plugin manifest is invalid",
        );
    };
    if manifest.entry.entry_type != EntryType::Web {
        return protocol_error(
            tauri::http::StatusCode::BAD_REQUEST,
            "plugin is not a web plugin",
        );
    }

    let requested = segments[1..].join("/");
    let relative = if requested.is_empty() || requested == "index.html" {
        manifest.entry.path.as_str()
    } else {
        requested.as_str()
    };
    if useful_plugin::zip_safety::ensure_safe_relative(relative).is_err() {
        return protocol_error(tauri::http::StatusCode::BAD_REQUEST, "unsafe plugin path");
    }
    let root = match std::fs::canonicalize(&install_dir) {
        Ok(path) => path,
        Err(_) => {
            return protocol_error(tauri::http::StatusCode::NOT_FOUND, "plugin files missing")
        }
    };
    let target = match std::fs::canonicalize(root.join(relative)) {
        Ok(path) if path.starts_with(&root) && path.is_file() => path,
        _ => return protocol_error(tauri::http::StatusCode::NOT_FOUND, "plugin asset not found"),
    };
    let body = if request.method() == tauri::http::Method::HEAD {
        Vec::new()
    } else {
        match std::fs::read(&target) {
            Ok(bytes) => bytes,
            Err(_) => {
                return protocol_error(
                    tauri::http::StatusCode::INTERNAL_SERVER_ERROR,
                    "plugin asset read failed",
                )
            }
        }
    };
    let plugin_csp = plugin_content_security_policy(plugin_id);
    tauri::http::Response::builder()
        .status(tauri::http::StatusCode::OK)
        .header(
            tauri::http::header::CONTENT_TYPE,
            plugin_content_type(&target),
        )
        .header("Content-Security-Policy", plugin_csp)
        .header(tauri::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header("Cross-Origin-Resource-Policy", "cross-origin")
        .header("X-Content-Type-Options", "nosniff")
        .header(tauri::http::header::CACHE_CONTROL, "no-store")
        .body(body)
        .expect("固定插件协议响应头必须有效")
}

fn plugin_content_security_policy(plugin_id: &str) -> String {
    // manifest id 只允许安全 ASCII 段。CSP 精确绑定当前插件路径，不能泛开整个共享 scheme。
    let custom = format!("usefulplugin://localhost/{plugin_id}/");
    let http = format!("http://usefulplugin.localhost/{plugin_id}/");
    format!(
        "default-src 'none'; img-src {custom} {http} data:; style-src 'unsafe-inline' {custom} {http}; script-src 'unsafe-inline' {custom} {http}; font-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'"
    )
}

fn protocol_error(
    status: tauri::http::StatusCode,
    message: &str,
) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header(
            tauri::http::header::CONTENT_TYPE,
            "text/plain; charset=utf-8",
        )
        .header("Content-Security-Policy", "default-src 'none'")
        .header("X-Content-Type-Options", "nosniff")
        .body(message.as_bytes().to_vec())
        .expect("固定插件协议错误响应头必须有效")
}

fn plugin_content_type(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

/// 把 manifest 转成 ToolDefinition 注册到注册表。
fn manifest_to_tool(m: &PluginManifest, install_dir: &str) -> ToolDefinition {
    let kind = match m.entry.entry_type {
        EntryType::Web => ToolKind::Web,
        EntryType::Launcher => ToolKind::Launcher,
        EntryType::Worker => ToolKind::Worker,
    };
    let order = m
        .contributes
        .sidebar
        .first()
        .map(|s| s.order)
        .unwrap_or(100);
    ToolDefinition {
        id: m.id.clone(),
        name: m.name.clone(),
        description: m.description.clone(),
        icon: m
            .icon
            .clone()
            .map(|i| format!("{install_dir}/{i}"))
            .unwrap_or_else(|| "plugin".into()),
        route: format!("/plugin/{}", m.id),
        category: ToolCategory::Installed,
        kind,
        order,
        supports_shortcut: true,
        required_capabilities: m.permissions.clone(),
        version: Some(m.version.clone()),
    }
}

/// 把安装结果写入数据库并注册到注册表（本地安装与源安装共用）。
pub(crate) struct TrpInstallCommit {
    pub source_id: String,
    pub discovery_url: String,
    pub root_fingerprint: String,
    pub publisher_key_id: String,
    pub installed_version: String,
    pub artifact_sha256: String,
    pub channel: String,
    pub manifest_digest: String,
    pub tuf_state: useful_core::db::TrpTufState,
}

pub(crate) fn persist_installed(
    state: &AppState,
    outcome: InstallOutcome,
    trp: Option<&TrpInstallCommit>,
) -> Result<ToolDefinition, CmdError> {
    let tool_id = outcome.manifest.id.clone();
    match persist_installed_inner(state, &outcome, trp) {
        Ok(tool) => {
            outcome.commit();
            Ok(tool)
        }
        Err(original) => match outcome.rollback() {
            Ok(()) if !original.message.contains("INSTALL_RECOVERY_REQUIRED") => Err(original),
            Ok(()) => Err(isolate_recovery_tool(state, &tool_id, original, None)),
            Err(rollback_error) => Err(isolate_recovery_tool(
                state,
                &tool_id,
                original,
                Some(rollback_error.to_string()),
            )),
        },
    }
}

fn isolate_recovery_tool(
    state: &AppState,
    tool_id: &str,
    original: CmdError,
    rollback_error: Option<String>,
) -> CmdError {
    // Any uncertain rollback is fail-closed: remove the in-process
    // registration and durably disable the row that could resolve to an
    // orphaned same-version directory.
    let mut isolation_failures = Vec::new();
    match state.registry.lock() {
        Ok(mut registry) => {
            registry.unregister(tool_id);
        }
        Err(_) => isolation_failures.push("锁定注册表隔离 orphan 失败".to_string()),
    }
    match state.db.lock() {
        Ok(db) => {
            // A prior SQLite rollback may have failed. Retry it before opening
            // the small recovery transaction; "no transaction" is harmless.
            let _ = db.conn.execute_batch("ROLLBACK;");
            let disable = (|| -> Result<(), rusqlite::Error> {
                db.conn.execute_batch("BEGIN IMMEDIATE;")?;
                db.conn
                    .execute("UPDATE tools SET enabled=0 WHERE id=?1", [tool_id])?;
                db.conn.execute_batch("COMMIT;")?;
                Ok(())
            })();
            if let Err(error) = disable {
                let _ = db.conn.execute_batch("ROLLBACK;");
                isolation_failures.push(format!("禁用 orphan 工具失败: {error}"));
            }
        }
        Err(_) => isolation_failures.push("锁定数据库禁用 orphan 失败".to_string()),
    }
    let rollback = rollback_error
        .map(|error| format!("; {error}"))
        .unwrap_or_default();
    let isolation = if isolation_failures.is_empty() {
        String::new()
    } else {
        format!("; {}", isolation_failures.join("; "))
    };
    CmdError::from(format!(
        "{}; INSTALL_RECOVERY_REQUIRED{rollback}{isolation}",
        original.message
    ))
}

fn rollback_database(conn: &rusqlite::Connection, original: CmdError) -> CmdError {
    match conn.execute_batch("ROLLBACK;") {
        Ok(()) => original,
        Err(error) => CmdError::from(format!(
            "{}; INSTALL_RECOVERY_REQUIRED: SQLite rollback 失败: {error}",
            original.message
        )),
    }
}

fn persist_installed_inner(
    state: &AppState,
    outcome: &InstallOutcome,
    trp: Option<&TrpInstallCommit>,
) -> Result<ToolDefinition, CmdError> {
    let install_dir = outcome.install_dir.to_string_lossy().to_string();
    let manifest_json =
        serde_json::to_string(&outcome.manifest).map_err(|e| CmdError::from(e.to_string()))?;
    let db = state
        .db
        .lock()
        .map_err(|_| CmdError::from("锁定数据库失败"))?;
    db.conn.execute_batch("BEGIN IMMEDIATE;")?;
    let apply = (|| -> Result<(), CmdError> {
        let m = &outcome.manifest;
        db.conn.execute(
            "INSERT INTO tools (id, kind, name, description, icon_path, enabled, current_version)
             VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)
             ON CONFLICT(id) DO UPDATE SET name=?3, description=?4, icon_path=?5, current_version=?6, enabled=1",
            rusqlite::params![
                m.id,
                format!("{:?}", m.entry.entry_type).to_lowercase(),
                m.name,
                m.description,
                m.icon,
                m.version
            ],
        )?;
        db.conn.execute(
            "INSERT INTO tool_versions (tool_id, version, install_dir, manifest_json, sha256)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(tool_id, version) DO UPDATE SET install_dir=?3, manifest_json=?4, sha256=?5",
            rusqlite::params![m.id, m.version, install_dir, manifest_json, outcome.sha256],
        )?;
        // 版本切换后权限必须精确收敛到当前 manifest，不能保留旧版本已移除的授权。
        db.conn.execute(
            "DELETE FROM granted_permissions WHERE tool_id = ?1",
            [&m.id],
        )?;
        for perm in &m.permissions {
            db.conn.execute(
                "INSERT OR IGNORE INTO granted_permissions (tool_id, permission) VALUES (?1, ?2)",
                rusqlite::params![m.id, perm],
            )?;
        }
        if let Some(trp) = trp {
            db.accept_trp_tuf_state_in_transaction(
                &trp.source_id,
                &trp.discovery_url,
                &trp.root_fingerprint,
                &trp.tuf_state,
            )?;
            db.conn.execute(
                "INSERT INTO installed_origins
                 (tool_id, source_id, publisher_key_id, installed_version, artifact_sha256,
                  channel, manifest_digest, installed_at, last_checked_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, unixepoch(), unixepoch())
                 ON CONFLICT(tool_id) DO UPDATE SET
                   source_id=?2, publisher_key_id=?3, installed_version=?4, artifact_sha256=?5,
                   channel=?6, manifest_digest=?7, last_checked_at=unixepoch()",
                rusqlite::params![
                    m.id,
                    trp.source_id,
                    trp.publisher_key_id,
                    trp.installed_version,
                    trp.artifact_sha256,
                    trp.channel,
                    trp.manifest_digest,
                ],
            )?;
        } else {
            let pinned: bool = db.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM installed_origins WHERE tool_id=?1)",
                [&m.id],
                |row| row.get(0),
            )?;
            if pinned {
                return Err(CmdError::from(
                    "SOURCE_PINNED_LOCAL_INSTALL_REJECTED: 已安装工具绑定到 TRP 来源，不能通过本地包覆盖",
                ));
            }
        }
        Ok(())
    })();
    if let Err(error) = apply {
        return Err(rollback_database(&db.conn, error));
    }

    let tool = manifest_to_tool(&outcome.manifest, &install_dir);
    let mut reg = match state.registry.lock() {
        Ok(registry) => registry,
        Err(_) => {
            return Err(rollback_database(
                &db.conn,
                CmdError::from("锁定注册表失败"),
            ));
        }
    };
    let previous = reg.unregister(&tool.id);
    if let Err(error) = reg.register(tool.clone()) {
        let mut original = CmdError::from(error);
        if let Some(previous) = previous {
            if let Err(restore_error) = reg.register(previous) {
                original = CmdError::from(format!(
                    "{}; INSTALL_RECOVERY_REQUIRED: 恢复注册表失败: {restore_error}",
                    original.message
                ));
            }
        }
        return Err(rollback_database(&db.conn, original));
    }
    if let Err(error) = db.conn.execute_batch("COMMIT;") {
        reg.unregister(&tool.id);
        let mut original = CmdError::from(error);
        if let Some(previous) = previous {
            if let Err(restore_error) = reg.register(previous) {
                original = CmdError::from(format!(
                    "{}; INSTALL_RECOVERY_REQUIRED: 恢复注册表失败: {restore_error}",
                    original.message
                ));
            }
        }
        return Err(rollback_database(&db.conn, original));
    }
    drop(reg);
    drop(db);
    Ok(tool)
}

struct OwnedInstallArchive {
    path: PathBuf,
}

impl OwnedInstallArchive {
    fn copy_from(source: &Path, staging_root: &Path) -> Result<Self, CmdError> {
        std::fs::create_dir_all(staging_root)
            .map_err(|error| CmdError::from(format!("创建安装暂存目录失败: {error}")))?;
        let owned = Self {
            path: staging_root.join(format!("local-import-{}.useful", uuid::Uuid::new_v4())),
        };
        let copied = (|| -> Result<(), CmdError> {
            let mut input = std::fs::File::open(source)
                .map_err(|error| CmdError::from(format!("打开本地插件包失败: {error}")))?;
            let mut output = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&owned.path)
                .map_err(|error| CmdError::from(format!("创建受控安装副本失败: {error}")))?;
            std::io::copy(&mut input, &mut output)
                .map_err(|error| CmdError::from(format!("复制本地插件包失败: {error}")))?;
            output
                .sync_all()
                .map_err(|error| CmdError::from(format!("持久化受控安装副本失败: {error}")))?;
            let mut permissions = output
                .metadata()
                .map_err(|error| CmdError::from(format!("读取受控安装副本权限失败: {error}")))?
                .permissions();
            permissions.set_readonly(true);
            std::fs::set_permissions(&owned.path, permissions)
                .map_err(|error| CmdError::from(format!("锁定受控安装副本为只读失败: {error}")))?;
            Ok(())
        })();
        match copied {
            Ok(()) => Ok(owned),
            Err(error) => {
                drop(owned);
                Err(error)
            }
        }
    }
}

impl Drop for OwnedInstallArchive {
    fn drop(&mut self) {
        if let Ok(metadata) = std::fs::metadata(&self.path) {
            let mut permissions = metadata.permissions();
            if permissions.readonly() {
                #[cfg(windows)]
                {
                    // Windows requires clearing FILE_ATTRIBUTE_READONLY before deletion; the
                    // Unix world-writable risk behind this lint does not apply on this branch.
                    #[allow(clippy::permissions_set_readonly_false)]
                    permissions.set_readonly(false);
                }

                // `set_readonly(false)` maps to world-writable permissions on Unix. This is
                // an application-owned private staging file, so restore only owner read/write
                // access long enough for cleanup.
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;

                    permissions.set_mode(0o600);
                }

                let _ = std::fs::set_permissions(&self.path, permissions);
            }
        }
        let _ = std::fs::remove_file(&self.path);
    }
}

/// 安装本地 .useful 插件包。
#[tauri::command]
pub async fn install_local_plugin(
    state: State<'_, AppState>,
    archive_path: String,
) -> CmdResult<ToolDefinition> {
    let selected_archive = std::path::PathBuf::from(&archive_path);
    if !selected_archive.is_file() {
        return Err(CmdError::from("插件包不存在"));
    }
    // 用户选择的路径在校验期间仍可能被其他进程替换。先复制到应用私有、
    // 唯一且只读的暂存文件；manifest 预检、hash 和最终安装全部读取同一副本。
    let archive = OwnedInstallArchive::copy_from(&selected_archive, &state.paths.staging_dir)?;

    // 查询是否已安装（用于降级检测）
    let manifest_bytes = useful_plugin::zip_safety::read_manifest_bytes(&archive.path)
        .map_err(|e| CmdError::from(e.to_string()))?;
    let candidate = PluginManifest::parse_and_validate(&manifest_bytes)
        .map_err(|e| CmdError::from(e.to_string()))?;
    let _tool_guard = tool_mutation_lock(&candidate.id).lock_owned().await;
    let installed_version: Option<String> = {
        let db = state
            .db
            .lock()
            .map_err(|_| CmdError::from("锁定数据库失败"))?;
        db.conn
            .query_row(
                "SELECT current_version FROM tools WHERE id = ?1",
                [&candidate.id],
                |r| r.get::<_, Option<String>>(0),
            )
            .ok()
            .flatten()
    };

    let opts = InstallOptions {
        host_version: HOST_VERSION.into(),
        installed_version,
        allow_downgrade: false,
        ..Default::default()
    };

    let outcome = install_useful(
        &archive.path,
        &state.paths.staging_dir,
        &state.paths.plugins_dir,
        &opts,
    )
    .map_err(|e| CmdError::from(e.to_string()))?;

    persist_installed(&state, outcome, None)
}

/// 列出已安装插件（从注册表读取，注册表在启动时由缓存 manifest 载入）。
#[tauri::command]
pub fn list_plugins(state: State<AppState>) -> CmdResult<Vec<ToolDefinition>> {
    let reg = state
        .registry
        .lock()
        .map_err(|_| CmdError::from("锁定注册表失败"))?;
    Ok(reg
        .list()
        .into_iter()
        .filter(|t| t.category == ToolCategory::Installed)
        .cloned()
        .collect())
}

#[tauri::command]
pub async fn uninstall_plugin(state: State<'_, AppState>, plugin_id: String) -> CmdResult<()> {
    let _tool_guard = tool_mutation_lock(&plugin_id).lock_owned().await;
    let plugin_dir = state.paths.plugins_dir.join(sanitize_component(&plugin_id));
    let removed_dir = if plugin_dir.exists() {
        let backup = plugin_dir.with_extension(format!("uninstall-{}", uuid::Uuid::new_v4()));
        std::fs::rename(&plugin_dir, &backup)
            .map_err(|error| CmdError::from(format!("暂存待卸载插件失败: {error}")))?;
        Some(backup)
    } else {
        None
    };
    let shortcut_paths = {
        let restore_files = || {
            if let Some(backup) = &removed_dir {
                if plugin_dir.exists() {
                    std::fs::remove_dir_all(&plugin_dir).map_err(|error| {
                        CmdError::from(format!("清理卸载回滚期间出现的目标目录失败: {error}"))
                    })?;
                }
                std::fs::rename(backup, &plugin_dir)
                    .map_err(|error| CmdError::from(format!("恢复卸载文件失败: {error}")))?;
            }
            Ok::<(), CmdError>(())
        };

        let db = match state.db.lock() {
            Ok(database) => database,
            Err(_) => {
                restore_files()?;
                return Err(CmdError::from("锁定数据库失败"));
            }
        };
        if let Err(error) = db.conn.execute_batch("BEGIN IMMEDIATE;") {
            restore_files()?;
            return Err(CmdError::from(error));
        }
        let apply = (|| -> Result<Vec<String>, CmdError> {
            let shortcut_paths = {
                let mut statement = db
                    .conn
                    .prepare("SELECT lnk_path FROM shortcuts WHERE tool_id = ?1")?;
                let rows = statement.query_map([&plugin_id], |row| row.get::<_, String>(0))?;
                rows.collect::<Result<Vec<_>, _>>()?
            };
            db.conn
                .execute("DELETE FROM shortcuts WHERE tool_id = ?1", [&plugin_id])?;
            db.conn.execute(
                "DELETE FROM installed_origins WHERE tool_id = ?1",
                [&plugin_id],
            )?;
            db.conn.execute(
                "DELETE FROM granted_permissions WHERE tool_id = ?1",
                [&plugin_id],
            )?;
            db.conn
                .execute("DELETE FROM tool_versions WHERE tool_id = ?1", [&plugin_id])?;
            // 收藏与最近使用保留稳定 ID。
            db.conn
                .execute("DELETE FROM tools WHERE id = ?1", [&plugin_id])?;
            Ok(shortcut_paths)
        })();
        let shortcut_paths = match apply {
            Ok(paths) => paths,
            Err(error) => {
                let _ = db.conn.execute_batch("ROLLBACK;");
                restore_files()?;
                return Err(error);
            }
        };
        let mut reg = match state.registry.lock() {
            Ok(registry) => registry,
            Err(_) => {
                let _ = db.conn.execute_batch("ROLLBACK;");
                restore_files()?;
                return Err(CmdError::from("锁定注册表失败"));
            }
        };
        let previous = reg.unregister(&plugin_id);
        if let Err(error) = db.conn.execute_batch("COMMIT;") {
            if let Some(previous) = previous {
                let _ = reg.register(previous);
            }
            let _ = db.conn.execute_batch("ROLLBACK;");
            restore_files()?;
            return Err(CmdError::from(error));
        }
        drop(reg);
        drop(db);
        shortcut_paths
    };
    if let Some(backup) = removed_dir {
        let _ = std::fs::remove_dir_all(backup);
    }
    for path in shortcut_paths {
        if let Err(error) = useful_shortcuts::delete_shortcut(Path::new(&path)) {
            tracing::warn!("删除已卸载插件快捷方式失败: {error}");
        }
    }
    state
        .plugin_bridge
        .readable
        .lock()
        .map_err(|_| CmdError::from("锁定插件文件授权失败"))?
        .remove(&plugin_id);
    state
        .plugin_bridge
        .writable
        .lock()
        .map_err(|_| CmdError::from("锁定插件文件授权失败"))?
        .remove(&plugin_id);
    Ok(())
}

#[tauri::command]
pub fn get_plugin_permissions(state: State<AppState>, plugin_id: String) -> CmdResult<Vec<String>> {
    let db = state
        .db
        .lock()
        .map_err(|_| CmdError::from("锁定数据库失败"))?;
    let mut stmt = db.conn.prepare(
        "SELECT permission FROM granted_permissions WHERE tool_id = ?1 ORDER BY permission",
    )?;
    let rows = stmt.query_map([&plugin_id], |r| r.get::<_, String>(0))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// 导入本地 EXE 或网址为 launcher 工具。
#[tauri::command]
pub async fn import_launcher(
    state: State<'_, AppState>,
    name: String,
    target: String,
    args: Vec<String>,
) -> CmdResult<ToolDefinition> {
    if name.trim().is_empty() || target.trim().is_empty() {
        return Err(CmdError::from("名称与目标不能为空"));
    }
    // 生成一个本地 launcher 插件 id
    let id = format!("local.launcher.{}", sanitize_id(&name));
    let _tool_guard = tool_mutation_lock(&id).lock_owned().await;
    let manifest = PluginManifest {
        schema_version: 1,
        id: id.clone(),
        name: name.clone(),
        version: "1.0.0".into(),
        description: format!("本地启动器：{target}"),
        icon: None,
        entry: useful_plugin::manifest::Entry {
            entry_type: EntryType::Launcher,
            path: target.clone(),
            args: args.clone(),
        },
        contributes: Default::default(),
        permissions: vec!["process.launch.declared".into()],
        platforms: vec!["windows-x64".into()],
        min_host_version: "0.1.0".into(),
    };
    let manifest_json =
        serde_json::to_string(&manifest).map_err(|e| CmdError::from(e.to_string()))?;
    let tool = manifest_to_tool(&manifest, "");
    let db = state
        .db
        .lock()
        .map_err(|_| CmdError::from("锁定数据库失败"))?;
    db.conn.execute_batch("BEGIN IMMEDIATE;")?;
    let apply = (|| -> Result<(), CmdError> {
        let source_pinned: bool = db.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM installed_origins WHERE tool_id=?1)",
            [&id],
            |row| row.get(0),
        )?;
        if source_pinned {
            return Err(CmdError::from(
                "SOURCE_PINNED_LAUNCHER_IMPORT_REJECTED: 已安装工具绑定到 TRP 来源，不能通过 launcher 覆盖",
            ));
        }
        db.conn.execute(
            "INSERT INTO tools (id, kind, name, description, icon_path, enabled, current_version)
             VALUES (?1, 'launcher', ?2, ?3, NULL, 1, '1.0.0')
             ON CONFLICT(id) DO UPDATE SET kind='launcher', name=?2, description=?3,
               icon_path=NULL, enabled=1, current_version='1.0.0'",
            rusqlite::params![id, name, manifest.description],
        )?;
        db.conn.execute(
            "INSERT INTO tool_versions (tool_id, version, install_dir, manifest_json, sha256)
             VALUES (?1, '1.0.0', NULL, ?2, NULL)
             ON CONFLICT(tool_id, version) DO UPDATE SET install_dir=NULL,
               manifest_json=?2, sha256=NULL",
            rusqlite::params![id, manifest_json],
        )?;
        db.conn
            .execute("DELETE FROM granted_permissions WHERE tool_id=?1", [&id])?;
        db.conn.execute(
            "INSERT INTO granted_permissions (tool_id, permission) VALUES (?1, ?2)",
            rusqlite::params![id, "process.launch.declared"],
        )?;
        Ok(())
    })();
    if let Err(error) = apply {
        return Err(rollback_database(&db.conn, error));
    }

    let mut reg = match state.registry.lock() {
        Ok(registry) => registry,
        Err(_) => {
            return Err(rollback_database(
                &db.conn,
                CmdError::from("锁定注册表失败"),
            ));
        }
    };
    let previous = reg.unregister(&tool.id);
    if let Err(error) = reg.register(tool.clone()) {
        let mut original = CmdError::from(error);
        if let Some(previous) = previous {
            if let Err(restore_error) = reg.register(previous) {
                original = CmdError::from(format!(
                    "{}; INSTALL_RECOVERY_REQUIRED: 恢复 launcher 注册表失败: {restore_error}",
                    original.message
                ));
            }
        }
        return Err(rollback_database(&db.conn, original));
    }
    if let Err(error) = db.conn.execute_batch("COMMIT;") {
        reg.unregister(&tool.id);
        let mut original = CmdError::from(error);
        if let Some(previous) = previous {
            if let Err(restore_error) = reg.register(previous) {
                original = CmdError::from(format!(
                    "{}; INSTALL_RECOVERY_REQUIRED: 恢复 launcher 注册表失败: {restore_error}",
                    original.message
                ));
            }
        }
        return Err(rollback_database(&db.conn, original));
    }
    Ok(tool)
}

/// 宿主桥首发仅暴露不会启动不可取消 native 工作的只读/遥测方法。
#[tauri::command]
pub async fn plugin_bridge_call(
    app: AppHandle,
    state: State<'_, AppState>,
    plugin_id: String,
    method: String,
    params: Option<serde_json::Value>,
) -> CmdResult<serde_json::Value> {
    #[cfg(not(feature = "native-test"))]
    let _ = (&app, &params);
    // 校验插件存在
    {
        let reg = state
            .registry
            .lock()
            .map_err(|_| CmdError::from("锁定注册表失败"))?;
        if reg.get(&plugin_id).is_none() {
            return Err(CmdError::from("插件未注册"));
        }
    }
    match method.as_str() {
        "getTheme" => Ok(serde_json::json!("system")),
        "getLanguage" => Ok(serde_json::json!("zh-CN")),
        "plugin.ready" => {
            #[cfg(feature = "native-test")]
            let _ = app.emit(
                "plugin-ready-observed",
                serde_json::json!({ "pluginId": plugin_id, "details": params }),
            );
            Ok(serde_json::Value::Null)
        }
        "reportProgress" => Ok(serde_json::Value::Null),
        other => Err(CmdError::from(format!("方法暂未实现或被拒绝: {other}"))),
    }
}

#[derive(Serialize)]
pub struct PluginSummary {
    pub id: String,
    pub name: String,
    pub version: String,
}

/// 工具的历史版本记录。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolVersionInfo {
    pub version: String,
    pub installed_at: i64,
    pub current: bool,
}

/// 固定/取消固定版本（固定后不提示更新）。
#[tauri::command]
pub fn tool_set_pinned(state: State<AppState>, tool_id: String, pinned: bool) -> CmdResult<()> {
    let db = state
        .db
        .lock()
        .map_err(|_| CmdError::from("锁定数据库失败"))?;
    let n = db.conn.execute(
        "UPDATE tools SET pinned = ?2 WHERE id = ?1",
        rusqlite::params![tool_id, pinned as i64],
    )?;
    if n == 0 {
        return Err(CmdError::from("工具不存在"));
    }
    Ok(())
}

/// 列出工具的已安装历史版本（新→旧）。
#[tauri::command]
pub fn tool_versions(state: State<AppState>, tool_id: String) -> CmdResult<Vec<ToolVersionInfo>> {
    let db = state
        .db
        .lock()
        .map_err(|_| CmdError::from("锁定数据库失败"))?;
    let current: Option<String> = db
        .conn
        .query_row(
            "SELECT current_version FROM tools WHERE id = ?1",
            [&tool_id],
            |r| r.get(0),
        )
        .ok()
        .flatten();
    let mut stmt = db.conn.prepare(
        "SELECT version, installed_at FROM tool_versions WHERE tool_id = ?1 ORDER BY installed_at DESC",
    )?;
    let rows = stmt.query_map([&tool_id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
    })?;
    Ok(rows
        .filter_map(|r| r.ok())
        .map(|(version, installed_at)| ToolVersionInfo {
            current: Some(&version) == current.as_ref(),
            version,
            installed_at,
        })
        .collect())
}

/// 回滚到上一个已安装版本：删除当前版本目录与记录，恢复上一版本。
#[tauri::command]
pub async fn tool_rollback(
    state: State<'_, AppState>,
    tool_id: String,
) -> CmdResult<ToolDefinition> {
    let _tool_guard = tool_mutation_lock(&tool_id).lock_owned().await;
    // 1) 找到当前版本与上一个版本
    let (current, prev_version, prev_manifest_json, prev_install_dir) = {
        let db = state
            .db
            .lock()
            .map_err(|_| CmdError::from("锁定数据库失败"))?;
        let source_pinned: bool = db.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM installed_origins WHERE tool_id=?1)",
            [&tool_id],
            |row| row.get(0),
        )?;
        if source_pinned {
            return Err(CmdError::from(
                "SOURCE_PINNED_ROLLBACK_REJECTED: TRP 工具必须使用受验证的来源回滚",
            ));
        }
        let current: String = db
            .conn
            .query_row(
                "SELECT current_version FROM tools WHERE id = ?1",
                [&tool_id],
                |r| r.get::<_, Option<String>>(0),
            )
            .ok()
            .flatten()
            .ok_or_else(|| CmdError::from("工具未安装"))?;
        let prev = db
            .conn
            .query_row(
                "SELECT version, manifest_json, install_dir FROM tool_versions
                 WHERE tool_id = ?1 AND version != ?2 ORDER BY installed_at DESC LIMIT 1",
                rusqlite::params![tool_id, current],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .map_err(|_| CmdError::from("没有可回滚的上一个版本"))?;
        (current, prev.0, prev.1, prev.2)
    };

    // 2) 上一版本文件必须仍存在（worker/launcher 无 install_dir 的本地导入工具除外）
    if let Some(dir) = &prev_install_dir {
        if !dir.is_empty() && !std::path::Path::new(dir).exists() {
            return Err(CmdError::from("上一版本文件已不存在，无法回滚"));
        }
    }
    let manifest: PluginManifest = serde_json::from_str(&prev_manifest_json)
        .map_err(|e| CmdError::from(format!("上一版本 manifest 损坏: {e}")))?;

    // 3) 切换数据库记录，删除当前版本
    {
        let db = state
            .db
            .lock()
            .map_err(|_| CmdError::from("锁定数据库失败"))?;
        db.conn.execute(
            "UPDATE tools SET current_version = ?2, name = ?3, description = ?4 WHERE id = ?1",
            rusqlite::params![tool_id, prev_version, manifest.name, manifest.description],
        )?;
        db.conn.execute(
            "DELETE FROM tool_versions WHERE tool_id = ?1 AND version = ?2",
            rusqlite::params![tool_id, current],
        )?;
    }
    uninstall_version(&state.paths.plugins_dir, &tool_id, &current)
        .map_err(|e| CmdError::from(e.to_string()))?;

    // 4) 重新注册
    let tool = manifest_to_tool(&manifest, prev_install_dir.as_deref().unwrap_or(""));
    {
        let mut reg = state
            .registry
            .lock()
            .map_err(|_| CmdError::from("锁定注册表失败"))?;
        reg.unregister(&tool.id);
        reg.register(tool.clone()).map_err(CmdError::from)?;
    }
    Ok(tool)
}

fn sanitize_id(name: &str) -> String {
    let s: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_lowercase();
    if s.is_empty() {
        // 全非 ASCII 名称（如纯中文）时用长度+时间戳兜底，保证 id 段非空且合法
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        format!("tool{}", ts)
    } else {
        s
    }
}

#[cfg(test)]
mod bridge_policy_tests {
    #[test]
    fn csp_allows_only_the_current_plugin_asset_prefix() {
        let csp = super::plugin_content_security_policy("com.example.alpha");
        let current_custom = "usefulplugin://localhost/com.example.alpha/";
        let current_http = "http://usefulplugin.localhost/com.example.alpha/";
        let directives = csp
            .split(';')
            .map(|directive| directive.split_whitespace().collect::<Vec<_>>())
            .collect::<Vec<_>>();

        for directive in &directives {
            for source in directive.iter().skip(1) {
                assert_ne!(*source, "usefulplugin:");
                assert_ne!(*source, "http://usefulplugin.localhost");
                assert!(!source.starts_with("https://usefulplugin.localhost"));
                assert!(!source.contains("com.example.beta"));

                if source.starts_with("usefulplugin:") {
                    assert_eq!(*source, current_custom);
                }
                if source.starts_with("http://usefulplugin.localhost") {
                    assert_eq!(*source, current_http);
                }
            }
        }

        for directive_name in ["img-src", "style-src", "script-src"] {
            let directive = directives
                .iter()
                .find(|directive| directive.first() == Some(&directive_name))
                .expect("plugin CSP must contain the resource directive");
            let current_plugin_sources = directive
                .iter()
                .skip(1)
                .copied()
                .filter(|source| *source == current_custom || *source == current_http)
                .collect::<Vec<_>>();
            assert_eq!(current_plugin_sources, vec![current_custom, current_http]);
        }
    }
}
