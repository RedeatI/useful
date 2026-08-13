//! 下载器：从工具源下载 .useful → 临时 `.part` → 校验 SHA-256/大小 → 安装。
//!
//! - 进度写入 `downloads` 表并发 `download-progress` 事件，完成/失败发 `download-done`
//! - 支持取消；未完成/校验失败的文件绝不进入安装管线
//! - 安装阶段不执行任何脚本；公开源禁止 worker 插件

use super::sources::{check_url_policy, developer_mode_enabled, file_url_path};
use super::{CmdError, CmdResult};
use crate::state::{AppState, HOST_VERSION};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use useful_plugin::download::{ensure_source_install_allowed, verify_downloaded_file};
use useful_plugin::install::{install_useful, InstallOptions};
use useful_plugin::manifest::PluginManifest;
use useful_plugin::permissions::added_permissions;

/// 下载任务取消标志表。
#[derive(Default)]
pub struct DownloadsState {
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRecord {
    pub id: String,
    pub url: String,
    pub package_id: Option<String>,
    pub version: Option<String>,
    pub total_bytes: Option<u64>,
    pub received_bytes: u64,
    pub status: String,
    pub digest: Option<String>,
    pub error: Option<String>,
    pub error_code: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgressEvent {
    id: String,
    package_id: String,
    version: String,
    received_bytes: u64,
    total_bytes: u64,
    status: String,
    digest: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadDoneEvent {
    id: String,
    package_id: String,
    version: String,
    status: String, // done | failed | cancelled
    error: Option<String>,
    error_code: Option<String>,
}

/// 下载任务的准备信息（同步阶段产出）。
struct DownloadJob {
    download_id: String,
    package_id: String,
    version: String,
    url: String,
    sha256: String,
    size: u64,
    installed_version: Option<String>,
    granted: Vec<String>,
    allow_downgrade: bool,
    permissions_confirmed: bool,
    allow_local: bool,
    part_path: PathBuf,
    final_path: PathBuf,
    cancel: Arc<AtomicBool>,
}

fn set_download_status(
    app: &AppHandle,
    id: &str,
    status: &str,
    error: Option<&str>,
    error_code: Option<&str>,
    received: Option<u64>,
) {
    let state = app.state::<AppState>();
    let guard = state.db.lock();
    if let Ok(db) = guard {
        let _ = db.conn.execute(
            "UPDATE downloads SET status = ?2, error = ?3, error_code = ?4,
             received_bytes = COALESCE(?5, received_bytes), updated_at = unixepoch()
             WHERE id = ?1",
            rusqlite::params![id, status, error, error_code, received.map(|v| v as i64)],
        );
    }
}

fn emit_progress(app: &AppHandle, job: &DownloadJob, received: u64, status: &str) {
    let _ = app.emit(
        "download-progress",
        DownloadProgressEvent {
            id: job.download_id.clone(),
            package_id: job.package_id.clone(),
            version: job.version.clone(),
            received_bytes: received,
            total_bytes: job.size,
            status: status.into(),
            digest: job.sha256.clone(),
        },
    );
}

fn emit_done(
    app: &AppHandle,
    job: &DownloadJob,
    status: &str,
    error: Option<String>,
    error_code: Option<String>,
) {
    let _ = app.emit(
        "download-done",
        DownloadDoneEvent {
            id: job.download_id.clone(),
            package_id: job.package_id.clone(),
            version: job.version.clone(),
            status: status.into(),
            error,
            error_code,
        },
    );
}

/// Download-queue bridge for the trusted TRP/TUF install path. The artifact
/// still flows through TRP verification; this object only persists and emits
/// observable state and cancellation.
pub(crate) struct TrustedInstallTracker {
    app: AppHandle,
    id: String,
    package_id: String,
    version: String,
    digest: String,
    size: u64,
    cancel: Arc<AtomicBool>,
}

impl TrustedInstallTracker {
    pub(crate) fn begin(
        app: AppHandle,
        package_id: &str,
        version: &str,
        digest: &str,
        size: u64,
    ) -> CmdResult<Self> {
        let id = uuid::Uuid::new_v4().to_string();
        let cancel = Arc::new(AtomicBool::new(false));
        let state = app.state::<AppState>();
        {
            let db = state
                .db
                .lock()
                .map_err(|_| CmdError::from("锁定数据库失败"))?;
            db.conn.execute(
                "INSERT INTO downloads
                 (id, url, dest_path, total_bytes, sha256_expected, status, package_id, version)
                 VALUES (?1, ?2, '', ?3, ?4, 'pending', ?5, ?6)",
                rusqlite::params![
                    id,
                    format!("sha256:{digest}"),
                    size as i64,
                    digest.to_lowercase(),
                    package_id,
                    version
                ],
            )?;
        }
        state
            .downloads
            .cancels
            .lock()
            .map_err(|_| CmdError::from("锁定下载状态失败"))?
            .insert(id.clone(), cancel.clone());
        Ok(Self {
            app,
            id,
            package_id: package_id.into(),
            version: version.into(),
            digest: digest.to_lowercase(),
            size,
            cancel,
        })
    }

    pub(crate) fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    pub(crate) fn progress(&self, status: &str, received: u64) -> CmdResult<()> {
        if self.cancelled() {
            return Err(CmdError::from("已取消"));
        }
        set_download_status(&self.app, &self.id, status, None, None, Some(received));
        let _ = self.app.emit(
            "download-progress",
            DownloadProgressEvent {
                id: self.id.clone(),
                package_id: self.package_id.clone(),
                version: self.version.clone(),
                received_bytes: received,
                total_bytes: self.size,
                status: status.into(),
                digest: self.digest.clone(),
            },
        );
        Ok(())
    }

    pub(crate) fn complete(&self) {
        set_download_status(&self.app, &self.id, "done", None, None, Some(self.size));
        self.emit_terminal("done", None, None);
        self.unregister();
    }

    pub(crate) fn fail(&self, error: &CmdError) {
        let cancelled = self.cancelled();
        let status = if cancelled { "cancelled" } else { "failed" };
        let code = if cancelled {
            None
        } else {
            Some(error.code.as_deref().unwrap_or("install_failed"))
        };
        set_download_status(
            &self.app,
            &self.id,
            status,
            Some(&error.message),
            code,
            None,
        );
        self.emit_terminal(
            status,
            Some(error.message.clone()),
            code.map(str::to_string),
        );
        self.unregister();
    }

    fn emit_terminal(&self, status: &str, error: Option<String>, error_code: Option<String>) {
        let _ = self.app.emit(
            "download-done",
            DownloadDoneEvent {
                id: self.id.clone(),
                package_id: self.package_id.clone(),
                version: self.version.clone(),
                status: status.into(),
                error,
                error_code,
            },
        );
    }

    fn unregister(&self) {
        let state = self.app.state::<AppState>();
        if let Ok(mut cancels) = state.downloads.cancels.lock() {
            cancels.remove(&self.id);
        };
    }
}

/// 从源安装/更新/降级：创建下载任务，返回下载 ID；进度经事件推送。
pub const LEGACY_SOURCE_INSTALL_DISABLED: &str =
    "LEGACY_SOURCE_INSTALL_DISABLED: 首次公开版本仅允许通过 TRP/TUF 源安装";

#[tauri::command]
pub async fn download_and_install(
    _app: AppHandle,
    _state: State<'_, AppState>,
    _source_id: String,
    _package_id: String,
    _version: String,
    _allow_downgrade: bool,
    _permissions_confirmed: bool,
) -> CmdResult<String> {
    Err(CmdError::from(LEGACY_SOURCE_INSTALL_DISABLED))
}

#[allow(dead_code)]
async fn legacy_download_and_install_impl(
    app: AppHandle,
    state: State<'_, AppState>,
    source_id: String,
    package_id: String,
    version: String,
    allow_downgrade: bool,
    permissions_confirmed: bool,
) -> CmdResult<String> {
    // ---- 同步准备阶段（全部锁在此作用域内释放）----
    let job = {
        let dev = developer_mode_enabled(&state);
        let db = state
            .db
            .lock()
            .map_err(|_| CmdError::from("锁定数据库失败"))?;

        // 源必须存在且启用
        let enabled: bool = db
            .conn
            .query_row(
                "SELECT enabled FROM tool_sources WHERE id = ?1",
                [&source_id],
                |r| Ok(r.get::<_, i64>(0)? != 0),
            )
            .map_err(|_| CmdError::from("源不存在"))?;
        if !enabled {
            return Err(CmdError::from("源已被禁用"));
        }

        let (url, sha256, size, permissions_json): (String, String, i64, String) = db
            .conn
            .query_row(
                "SELECT package_url, sha256, size, permissions_json FROM source_packages
                 WHERE source_id = ?1 AND package_id = ?2 AND version = ?3",
                rusqlite::params![source_id, package_id, version],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .map_err(|_| CmdError::from("源中不存在该包/版本"))?;

        check_url_policy(&url, dev)?;

        let installed_version: Option<String> = db
            .conn
            .query_row(
                "SELECT current_version FROM tools WHERE id = ?1",
                [&package_id],
                |r| r.get::<_, Option<String>>(0),
            )
            .ok()
            .flatten();

        let granted: Vec<String> = {
            let mut stmt = db
                .conn
                .prepare("SELECT permission FROM granted_permissions WHERE tool_id = ?1")?;
            let rows = stmt.query_map([&package_id], |r| r.get::<_, String>(0))?;
            rows.filter_map(|r| r.ok()).collect()
        };

        // 更新时新增权限必须先经用户重新确认（防插件更新偷偷加权限）
        if installed_version.is_some() && !permissions_confirmed {
            let requested: Vec<String> =
                serde_json::from_str(&permissions_json).unwrap_or_default();
            let added = added_permissions(&granted, &requested);
            if !added.is_empty() {
                return Err(CmdError::from(format!(
                    "该更新新增权限需要确认: {}",
                    added.join(", ")
                )));
            }
        }

        let download_id = uuid::Uuid::new_v4().to_string();
        let part_path = state
            .paths
            .downloads_dir
            .join(format!("{download_id}.useful.part"));
        let final_path = state
            .paths
            .downloads_dir
            .join(format!("{download_id}.useful"));

        db.conn.execute(
            "INSERT INTO downloads (id, url, dest_path, total_bytes, sha256_expected, status, package_id, version)
             VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7)",
            rusqlite::params![
                download_id,
                url,
                final_path.to_string_lossy(),
                size,
                sha256,
                package_id,
                version
            ],
        )?;

        let cancel = Arc::new(AtomicBool::new(false));
        state
            .downloads
            .cancels
            .lock()
            .map_err(|_| CmdError::from("锁定下载状态失败"))?
            .insert(download_id.clone(), cancel.clone());

        DownloadJob {
            download_id,
            package_id,
            version,
            url,
            sha256,
            size: size as u64,
            installed_version,
            granted,
            allow_downgrade,
            permissions_confirmed,
            allow_local: dev,
            part_path,
            final_path,
            cancel,
        }
    };

    let id = job.download_id.clone();
    tauri::async_runtime::spawn(async move {
        let result = run_download(&app, &job).await;
        // 清理取消标志
        {
            let state = app.state::<AppState>();
            let guard = state.downloads.cancels.lock();
            if let Ok(mut cancels) = guard {
                cancels.remove(&job.download_id);
            }
        }
        // 清理临时文件
        let _ = tokio::fs::remove_file(&job.part_path).await;
        let _ = tokio::fs::remove_file(&job.final_path).await;

        match result {
            Ok(()) => {
                set_download_status(&app, &job.download_id, "done", None, None, Some(job.size));
                emit_done(&app, &job, "done", None, None);
            }
            Err(e) if job.cancel.load(Ordering::Relaxed) => {
                set_download_status(&app, &job.download_id, "cancelled", None, None, None);
                emit_done(&app, &job, "cancelled", Some(e.message), None);
            }
            Err(e) => {
                tracing::warn!("下载安装失败 {}: {}", job.package_id, e.message);
                set_download_status(
                    &app,
                    &job.download_id,
                    "failed",
                    Some(&e.message),
                    e.code.as_deref(),
                    None,
                );
                emit_done(&app, &job, "failed", Some(e.message), e.code);
            }
        }
    });
    Ok(id)
}

/// 下载 + 校验 + 安装的主流程。任一步失败都返回错误，由调用方统一清理。
async fn run_download(app: &AppHandle, job: &DownloadJob) -> Result<(), CmdError> {
    use tokio::io::AsyncWriteExt;

    set_download_status(app, &job.download_id, "downloading", None, None, Some(0));
    emit_progress(app, job, 0, "downloading");

    // ---- 下载到 .part ----
    let mut file = tokio::fs::File::create(&job.part_path)
        .await
        .map_err(|e| CmdError::from(format!("创建临时文件失败: {e}")))?;
    let mut received: u64 = 0;
    let mut last_emit = std::time::Instant::now();

    if let Some(path) = file_url_path(&job.url)? {
        // 开发者模式本地包（策略已在准备阶段校验）
        let bytes = tokio::fs::read(&path)
            .await
            .map_err(|e| CmdError::from(format!("读取本地包失败: {e}")))?;
        if bytes.len() as u64 > job.size {
            return Err(CmdError::from("包体积超过源索引声明大小"));
        }
        file.write_all(&bytes)
            .await
            .map_err(|e| CmdError::from(format!("写入失败: {e}")))?;
        received = bytes.len() as u64;
    } else {
        let mut resp = super::sources::secure_get(&job.url, job.allow_local).await?;
        if !resp.status().is_success() {
            return Err(CmdError::from(format!("HTTP 状态异常: {}", resp.status())));
        }
        loop {
            if job.cancel.load(Ordering::Relaxed) {
                return Err(CmdError::from("已取消"));
            }
            let chunk = resp
                .chunk()
                .await
                .map_err(|e| CmdError::from(format!("下载中断: {e}")))?;
            let Some(chunk) = chunk else { break };
            received += chunk.len() as u64;
            if received > job.size {
                return Err(CmdError::from("包体积超过源索引声明大小"));
            }
            file.write_all(&chunk)
                .await
                .map_err(|e| CmdError::from(format!("写入失败: {e}")))?;
            // 进度节流：至少间隔 300ms
            if last_emit.elapsed().as_millis() >= 300 {
                last_emit = std::time::Instant::now();
                set_download_status(
                    app,
                    &job.download_id,
                    "downloading",
                    None,
                    None,
                    Some(received),
                );
                emit_progress(app, job, received, "downloading");
            }
        }
    }
    file.flush()
        .await
        .map_err(|e| CmdError::from(format!("写入失败: {e}")))?;
    drop(file);

    if job.cancel.load(Ordering::Relaxed) {
        return Err(CmdError::from("已取消"));
    }

    // ---- 完成落盘后改名，未完成文件永远带 .part 后缀 ----
    tokio::fs::rename(&job.part_path, &job.final_path)
        .await
        .map_err(|e| CmdError::from(format!("重命名失败: {e}")))?;

    set_download_status(
        app,
        &job.download_id,
        "verifying",
        None,
        None,
        Some(received),
    );
    emit_progress(app, job, received, "verifying");

    // ---- 校验 + 安装（阻塞管线放 spawn_blocking）----
    let app2 = app.clone();
    let final_path = job.final_path.clone();
    let sha256 = job.sha256.clone();
    let size = job.size;
    let installed_version = job.installed_version.clone();
    let granted = job.granted.clone();
    let allow_downgrade = job.allow_downgrade;
    let permissions_confirmed = job.permissions_confirmed;

    tauri::async_runtime::spawn_blocking(move || -> Result<(), CmdError> {
        // 1) 大小 + SHA-256 校验（校验不过绝不安装）
        verify_downloaded_file(&final_path, &sha256, size)
            .map_err(|e| CmdError::from(e.to_string()))?;

        // 2) 公开源禁止 worker；manifest 权限二次比对
        let manifest_bytes = useful_plugin::zip_safety::read_manifest_bytes(&final_path)
            .map_err(|e| CmdError::from(e.to_string()))?;
        let manifest = PluginManifest::parse_and_validate(&manifest_bytes)
            .map_err(|e| CmdError::from(e.to_string()))?;
        ensure_source_install_allowed(&manifest).map_err(|e| CmdError::from(e.to_string()))?;
        if installed_version.is_some() && !permissions_confirmed {
            let added = added_permissions(&granted, &manifest.permissions);
            if !added.is_empty() {
                return Err(CmdError::from(format!(
                    "包内 manifest 新增权限需要确认: {}",
                    added.join(", ")
                )));
            }
        }

        // 3) 安装管线（含降级检测、原子移动、失败回滚）
        let state = app2.state::<AppState>();
        let opts = InstallOptions {
            host_version: HOST_VERSION.into(),
            expected_sha256: Some(sha256),
            installed_version,
            allow_downgrade,
            ..Default::default()
        };
        let outcome = install_useful(
            &final_path,
            &state.paths.staging_dir,
            &state.paths.plugins_dir,
            &opts,
        )
        .map_err(|e| CmdError::from(e.to_string()))?;

        super::plugins::persist_installed(&state, outcome, None)?;
        Ok(())
    })
    .await
    .map_err(|e| CmdError::from(format!("安装任务异常: {e}")))??;

    Ok(())
}

/// 取消下载。
#[tauri::command]
pub fn download_cancel(state: State<AppState>, download_id: String) -> CmdResult<()> {
    let cancels = state
        .downloads
        .cancels
        .lock()
        .map_err(|_| CmdError::from("锁定下载状态失败"))?;
    match cancels.get(&download_id) {
        Some(flag) => {
            flag.store(true, Ordering::Relaxed);
            Ok(())
        }
        None => Err(CmdError::from("下载任务不存在或已结束")),
    }
}

/// 下载记录列表（新→旧，最多 100 条）。
#[tauri::command]
pub fn downloads_list(state: State<AppState>) -> CmdResult<Vec<DownloadRecord>> {
    let db = state
        .db
        .lock()
        .map_err(|_| CmdError::from("锁定数据库失败"))?;
    let mut stmt = db.conn.prepare(
        "SELECT id, url, package_id, version, total_bytes, received_bytes, status,
                sha256_expected, error, error_code, created_at
         FROM downloads ORDER BY created_at DESC, id DESC LIMIT 100",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(DownloadRecord {
            id: r.get(0)?,
            url: r.get(1)?,
            package_id: r.get(2)?,
            version: r.get(3)?,
            total_bytes: r.get::<_, Option<i64>>(4)?.map(|v| v as u64),
            received_bytes: r.get::<_, i64>(5)? as u64,
            status: r.get(6)?,
            digest: r.get(7)?,
            error: r.get(8)?,
            error_code: r.get(9)?,
            created_at: r.get(10)?,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// 清除已结束（done/failed/cancelled）的下载记录。
#[tauri::command]
pub fn downloads_clear_finished(state: State<AppState>) -> CmdResult<()> {
    let db = state
        .db
        .lock()
        .map_err(|_| CmdError::from("锁定数据库失败"))?;
    db.conn.execute(
        "DELETE FROM downloads WHERE status IN ('done', 'failed', 'cancelled')",
        [],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::LEGACY_SOURCE_INSTALL_DISABLED;

    #[test]
    fn legacy_install_error_code_is_stable() {
        assert_eq!(
            LEGACY_SOURCE_INSTALL_DISABLED,
            "LEGACY_SOURCE_INSTALL_DISABLED: 首次公开版本仅允许通过 TRP/TUF 源安装"
        );
    }
}
