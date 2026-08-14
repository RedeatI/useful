//! Build-pinned upstream media runtime catalog, cancellable download, verified install, and rollback.
//!
//! The renderer selects only a pack id. Upstream URLs, archive hashes, selected paths, and
//! extracted-file hashes are compile-time inputs and cannot be supplied by renderer IPC.

use super::{CmdError, CmdResult};
use crate::commands::media::MediaPackInstallTask;
use crate::state::{AppState, HOST_VERSION};
use reqwest::header::{
    HeaderValue, ACCEPT_ENCODING, CONTENT_RANGE, ETAG, IF_RANGE, LAST_MODIFIED, RANGE,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use useful_media::{
    pack,
    upstream::{self, UpstreamAsset, UpstreamInstallInput, UpstreamPack, UpstreamRuntimeLock},
};

const MAX_DOWNLOAD_ATTEMPTS: u8 = 3;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaPackCatalogView {
    pub trust_state: String,
    pub reason: Option<String>,
    pub source_lock_sha256: Option<String>,
    pub packs: Vec<MediaPackView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaPackView {
    pub id: String,
    pub download_bytes: u64,
    pub archive_bytes: u64,
    pub source_name: String,
    pub source_page_url: String,
    pub source_code_url: String,
    pub archive_sha256: String,
    pub installed: bool,
    pub previous_available: bool,
    pub damaged: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaPackProgressEvent {
    task_id: String,
    pack_id: String,
    phase: String,
    received_bytes: u64,
    total_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaPackDoneEvent {
    task_id: String,
    pack_id: String,
    status: String,
    error_code: Option<String>,
}

fn http_client() -> CmdResult<reqwest::Client> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let host = attempt.url().host_str();
            let allowed = attempt.url().scheme() == "https"
                && matches!(
                    host,
                    Some("www.gyan.dev")
                        | Some("github.com")
                        | Some("release-assets.githubusercontent.com")
                        | Some("objects.githubusercontent.com")
                );
            if allowed && attempt.previous().len() < 5 {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(30))
        .no_gzip()
        .build()
        .map_err(|_| CmdError::from("无法初始化 MediaPack HTTPS client"))
}

fn load_catalog() -> CmdResult<UpstreamRuntimeLock> {
    upstream::built_in_lock().map_err(|_| CmdError::from("内置上游媒体运行时锁无效"))
}

fn view_for_pack(state: &AppState, pack: &UpstreamPack) -> MediaPackView {
    let upstream_installed = upstream::installed_status(&state.media.media_root, &pack.id);
    let legacy_installed = pack::installed_status(&state.media.media_root, &pack.id);
    MediaPackView {
        id: pack.id.clone(),
        download_bytes: pack.archive.size_bytes,
        archive_bytes: pack.archive.size_bytes,
        source_name: pack.provider.clone(),
        source_page_url: pack.provider_page_url.clone(),
        source_code_url: pack.source_code_url.clone(),
        archive_sha256: pack.archive.sha256.clone(),
        installed: upstream_installed.current_relative_path.is_some()
            || legacy_installed.current_relative_path.is_some(),
        previous_available: upstream_installed.previous_available
            || legacy_installed.previous_available,
        damaged: upstream_installed.damaged || legacy_installed.damaged,
    }
}

#[tauri::command]
pub async fn media_pack_catalog(state: State<'_, AppState>) -> CmdResult<MediaPackCatalogView> {
    if !cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        return Ok(MediaPackCatalogView {
            trust_state: "unavailable".into(),
            reason: Some("platform-not-supported".into()),
            source_lock_sha256: None,
            packs: Vec::new(),
        });
    }
    let catalog = load_catalog()?;
    Ok(MediaPackCatalogView {
        trust_state: "ready".into(),
        reason: None,
        source_lock_sha256: Some(upstream::built_in_lock_sha256()),
        packs: catalog
            .packs
            .iter()
            .map(|item| view_for_pack(&state, item))
            .collect(),
    })
}

#[tauri::command]
pub async fn media_pack_install(
    app: AppHandle,
    state: State<'_, AppState>,
    pack_id: String,
) -> CmdResult<String> {
    if !matches!(pack_id.as_str(), "preview" | "transcode") {
        return Err(CmdError::from("未知 MediaPack"));
    }
    if !cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        return Err(CmdError::from("当前平台尚不支持内置媒体运行时下载"));
    }
    let catalog = load_catalog()?;
    let pack = catalog
        .packs
        .into_iter()
        .find(|item| item.id == pack_id)
        .ok_or_else(|| CmdError::from("内置上游锁中不存在该媒体组件包"))?;
    if upstream::installed_status(&state.media.media_root, &pack_id)
        .current_relative_path
        .is_some()
    {
        return Err(CmdError::from("该 MediaPack 已安装"));
    }

    let task_id = uuid::Uuid::new_v4().to_string();
    let cancel = Arc::new(AtomicBool::new(false));
    let mut tasks = state
        .media
        .pack_installs
        .lock()
        .map_err(|_| CmdError::from("锁定 MediaPack 安装状态失败"))?;
    if tasks.values().any(|task| task.pack_id == pack_id) {
        return Err(CmdError::from("该 MediaPack 已有安装任务在运行"));
    }
    tasks.insert(
        task_id.clone(),
        MediaPackInstallTask {
            pack_id: pack_id.clone(),
            cancel: cancel.clone(),
        },
    );
    drop(tasks);

    let task_id_for_run = task_id.clone();
    tauri::async_runtime::spawn(async move {
        let result = run_install(&app, &task_id_for_run, &pack, cancel.clone()).await;
        let state = app.state::<AppState>();
        if let Ok(mut tasks) = state.media.pack_installs.lock() {
            tasks.remove(&task_id_for_run);
        }
        match result {
            Ok(()) => emit_done(&app, &task_id_for_run, &pack.id, "done", None),
            Err(error) if cancel.load(Ordering::Relaxed) => {
                tracing::info!("MediaPack install cancelled: {}", pack.id);
                emit_done(
                    &app,
                    &task_id_for_run,
                    &pack.id,
                    "cancelled",
                    Some("cancelled"),
                );
                tracing::debug!("MediaPack cancellation detail: {}", error.message);
            }
            Err(error) => {
                tracing::warn!("MediaPack install failed {}: {}", pack.id, error.message);
                emit_done(
                    &app,
                    &task_id_for_run,
                    &pack.id,
                    "failed",
                    Some("install-failed"),
                );
            }
        }
    });
    Ok(task_id)
}

async fn run_install(
    app: &AppHandle,
    task_id: &str,
    pack: &UpstreamPack,
    cancel: Arc<AtomicBool>,
) -> CmdResult<()> {
    let state = app.state::<AppState>();
    std::fs::create_dir_all(&state.paths.downloads_dir)
        .map_err(|_| CmdError::from("无法创建 MediaPack 下载目录"))?;
    let task_root = state
        .paths
        .downloads_dir
        .join(format!("media-pack-{task_id}"));
    std::fs::create_dir(&task_root).map_err(|_| CmdError::from("无法创建 MediaPack 临时目录"))?;
    let total = pack.archive.size_bytes;
    let result = async {
        let client = http_client()?;
        let archive_path = task_root.join(&pack.archive.file_name);
        let _ = download_asset(
            app,
            task_id,
            &pack.id,
            &client,
            &pack.archive,
            &archive_path,
            0,
            total,
            &cancel,
        )
        .await?;
        if cancel.load(Ordering::Relaxed) {
            return Err(CmdError::from("MediaPack install cancelled"));
        }
        emit_progress(app, task_id, &pack.id, "verifying", total, total);
        let pack_for_install = pack.clone();
        let install_root = state.media.media_root.clone();
        let archive_for_install = archive_path.clone();
        emit_progress(app, task_id, &pack.id, "installing", total, total);
        tauri::async_runtime::spawn_blocking(move || {
            upstream::install_upstream_pack(UpstreamInstallInput {
                pack: &pack_for_install,
                archive_path: &archive_for_install,
                install_root: &install_root,
                current_useful_version: HOST_VERSION,
            })
            .map_err(|_| CmdError::from("上游归档校验或原子安装失败"))
        })
        .await
        .map_err(|_| CmdError::from("MediaPack install worker failed"))??;
        emit_progress(app, task_id, &pack.id, "redetecting", total, total);
        state.media.refresh_sidecars()?;
        Ok(())
    }
    .await;
    if let Err(error) = cleanup_task_root(&task_root, &pack.archive) {
        tracing::warn!(
            "MediaPack temp cleanup failed {}: {}",
            task_root.display(),
            error
        );
    }
    result
}

fn part_path(destination: &Path) -> std::path::PathBuf {
    destination.with_extension(format!(
        "{}.part",
        destination
            .extension()
            .and_then(|item| item.to_str())
            .unwrap_or("asset")
    ))
}

fn cleanup_task_root(task_root: &Path, asset: &UpstreamAsset) -> std::io::Result<()> {
    let destination = task_root.join(&asset.file_name);
    for path in [part_path(&destination), destination] {
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    std::fs::remove_dir(task_root)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DownloadResponseMode {
    Append,
    Restart,
}

fn validate_download_response(
    status: reqwest::StatusCode,
    content_length: Option<u64>,
    content_range: Option<&str>,
    offset: u64,
    total: u64,
) -> CmdResult<DownloadResponseMode> {
    if offset == 0 {
        if status != reqwest::StatusCode::OK || content_length.is_some_and(|length| length != total)
        {
            return Err(CmdError::from(
                "MediaPack asset HTTP facts do not match catalog",
            ));
        }
        return Ok(DownloadResponseMode::Append);
    }
    if status == reqwest::StatusCode::OK {
        if content_length.is_some_and(|length| length != total) {
            return Err(CmdError::from(
                "MediaPack asset HTTP facts do not match catalog",
            ));
        }
        return Ok(DownloadResponseMode::Restart);
    }
    let remaining = total
        .checked_sub(offset)
        .ok_or_else(|| CmdError::from("MediaPack resume offset exceeds catalog size"))?;
    let expected_range = format!("bytes {offset}-{}/{total}", total.saturating_sub(1));
    if status != reqwest::StatusCode::PARTIAL_CONTENT
        || content_length != Some(remaining)
        || content_range != Some(expected_range.as_str())
    {
        return Err(CmdError::from(
            "MediaPack Range response does not match catalog",
        ));
    }
    Ok(DownloadResponseMode::Append)
}

fn response_validator(response: &reqwest::Response) -> Option<HeaderValue> {
    response
        .headers()
        .get(ETAG)
        .filter(|value| !value.as_bytes().starts_with(b"W/"))
        .cloned()
        .or_else(|| response.headers().get(LAST_MODIFIED).cloned())
}

fn retryable_status(status: reqwest::StatusCode) -> bool {
    matches!(
        status,
        reqwest::StatusCode::REQUEST_TIMEOUT
            | reqwest::StatusCode::TOO_MANY_REQUESTS
            | reqwest::StatusCode::INTERNAL_SERVER_ERROR
            | reqwest::StatusCode::BAD_GATEWAY
            | reqwest::StatusCode::SERVICE_UNAVAILABLE
            | reqwest::StatusCode::GATEWAY_TIMEOUT
    )
}

async fn retry_pause(cancel: &AtomicBool, attempt: u8) -> CmdResult<()> {
    if cancel.load(Ordering::Relaxed) {
        return Err(CmdError::from("MediaPack install cancelled"));
    }
    tokio::time::sleep(Duration::from_millis(u64::from(attempt) * 250)).await;
    if cancel.load(Ordering::Relaxed) {
        return Err(CmdError::from("MediaPack install cancelled"));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn download_asset(
    app: &AppHandle,
    task_id: &str,
    pack_id: &str,
    client: &reqwest::Client,
    asset: &UpstreamAsset,
    destination: &Path,
    base_received: u64,
    total: u64,
    cancel: &AtomicBool,
) -> CmdResult<u64> {
    use tokio::io::{AsyncSeekExt, AsyncWriteExt};
    let part_path = part_path(destination);
    let mut output = tokio::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&part_path)
        .await
        .map_err(|_| CmdError::from("无法创建 MediaPack .part 文件"))?;
    let mut asset_received = 0u64;
    let mut digest = Sha256::new();
    let mut last_emit = std::time::Instant::now();
    let mut validator: Option<HeaderValue> = None;
    let mut completed = false;
    for attempt in 1..=MAX_DOWNLOAD_ATTEMPTS {
        if cancel.load(Ordering::Relaxed) {
            return Err(CmdError::from("MediaPack install cancelled"));
        }
        let offset = asset_received;
        let mut request = client.get(&asset.url).header(ACCEPT_ENCODING, "identity");
        if offset > 0 {
            request = request.header(RANGE, format!("bytes={offset}-"));
            if let Some(value) = &validator {
                request = request.header(IF_RANGE, value.clone());
            }
        }
        let mut response = match request.send().await {
            Ok(response) => response,
            Err(_) if attempt < MAX_DOWNLOAD_ATTEMPTS => {
                retry_pause(cancel, attempt).await?;
                continue;
            }
            Err(_) => return Err(CmdError::from("MediaPack asset download failed")),
        };
        if retryable_status(response.status()) && attempt < MAX_DOWNLOAD_ATTEMPTS {
            retry_pause(cancel, attempt).await?;
            continue;
        }
        let content_range = response
            .headers()
            .get(CONTENT_RANGE)
            .and_then(|value| value.to_str().ok());
        let mode = validate_download_response(
            response.status(),
            response.content_length(),
            content_range,
            offset,
            asset.size_bytes,
        )?;
        if mode == DownloadResponseMode::Restart {
            output
                .set_len(0)
                .await
                .map_err(|_| CmdError::from("MediaPack .part reset failed"))?;
            output
                .seek(std::io::SeekFrom::Start(0))
                .await
                .map_err(|_| CmdError::from("MediaPack .part seek failed"))?;
            asset_received = 0;
            digest = Sha256::new();
            emit_progress(app, task_id, pack_id, "downloading", base_received, total);
        }
        if asset_received == 0 {
            validator = response_validator(&response);
        }

        loop {
            let chunk = match response.chunk().await {
                Ok(Some(chunk)) => chunk,
                Ok(None) => break,
                Err(_) => break,
            };
            if cancel.load(Ordering::Relaxed) {
                return Err(CmdError::from("MediaPack install cancelled"));
            }
            asset_received = asset_received.saturating_add(chunk.len() as u64);
            if asset_received > asset.size_bytes {
                return Err(CmdError::from("MediaPack asset exceeds catalog size"));
            }
            output
                .write_all(&chunk)
                .await
                .map_err(|_| CmdError::from("MediaPack .part write failed"))?;
            digest.update(&chunk);
            if last_emit.elapsed() >= Duration::from_millis(250) {
                last_emit = std::time::Instant::now();
                emit_progress(
                    app,
                    task_id,
                    pack_id,
                    "downloading",
                    base_received.saturating_add(asset_received),
                    total,
                );
            }
        }
        if asset_received == asset.size_bytes {
            if hex::encode(digest.clone().finalize()) == asset.sha256 {
                completed = true;
                break;
            }
            if attempt == MAX_DOWNLOAD_ATTEMPTS {
                return Err(CmdError::from("MediaPack asset hash or size mismatch"));
            }
            output
                .set_len(0)
                .await
                .map_err(|_| CmdError::from("MediaPack .part reset failed"))?;
            output
                .seek(std::io::SeekFrom::Start(0))
                .await
                .map_err(|_| CmdError::from("MediaPack .part seek failed"))?;
            asset_received = 0;
            digest = Sha256::new();
            validator = None;
        }
        if attempt < MAX_DOWNLOAD_ATTEMPTS {
            retry_pause(cancel, attempt).await?;
        }
    }
    if !completed {
        return Err(CmdError::from("MediaPack asset stream retry exhausted"));
    }
    output
        .flush()
        .await
        .map_err(|_| CmdError::from("MediaPack .part flush failed"))?;
    drop(output);
    if asset_received != asset.size_bytes || hex::encode(digest.finalize()) != asset.sha256 {
        return Err(CmdError::from("MediaPack asset hash or size mismatch"));
    }
    tokio::fs::rename(&part_path, destination)
        .await
        .map_err(|_| CmdError::from("MediaPack verified download rename failed"))?;
    let next = base_received.saturating_add(asset_received);
    emit_progress(app, task_id, pack_id, "downloading", next, total);
    Ok(next)
}

fn emit_progress(
    app: &AppHandle,
    task_id: &str,
    pack_id: &str,
    phase: &str,
    received_bytes: u64,
    total_bytes: u64,
) {
    let _ = app.emit(
        "media-pack-progress",
        MediaPackProgressEvent {
            task_id: task_id.into(),
            pack_id: pack_id.into(),
            phase: phase.into(),
            received_bytes,
            total_bytes,
        },
    );
}

fn emit_done(
    app: &AppHandle,
    task_id: &str,
    pack_id: &str,
    status: &str,
    error_code: Option<&str>,
) {
    let _ = app.emit(
        "media-pack-done",
        MediaPackDoneEvent {
            task_id: task_id.into(),
            pack_id: pack_id.into(),
            status: status.into(),
            error_code: error_code.map(str::to_string),
        },
    );
}

#[tauri::command]
pub fn media_pack_cancel(state: State<AppState>, task_id: String) -> CmdResult<()> {
    let tasks = state
        .media
        .pack_installs
        .lock()
        .map_err(|_| CmdError::from("锁定 MediaPack 安装状态失败"))?;
    let task = tasks
        .get(&task_id)
        .ok_or_else(|| CmdError::from("MediaPack 安装任务不存在或已结束"))?;
    task.cancel.store(true, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub fn media_pack_rollback(state: State<AppState>, pack_id: String) -> CmdResult<()> {
    if state
        .media
        .pack_installs
        .lock()
        .map_err(|_| CmdError::from("锁定 MediaPack 安装状态失败"))?
        .values()
        .any(|task| task.pack_id == pack_id)
    {
        return Err(CmdError::from("安装进行中无法回滚 MediaPack"));
    }
    if upstream::installed_status(&state.media.media_root, &pack_id).previous_available {
        upstream::rollback(&state.media.media_root, &pack_id)
            .map_err(|_| CmdError::from("没有可用的上一版上游媒体组件"))?;
    } else {
        pack::rollback(&state.media.media_root, &pack_id)
            .map_err(|_| CmdError::from("没有可用的上一版 MediaPack"))?;
    }
    state.media.refresh_sidecars()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_and_exact_partial_responses_are_accepted() {
        assert_eq!(
            validate_download_response(reqwest::StatusCode::OK, Some(100), None, 0, 100).unwrap(),
            DownloadResponseMode::Append
        );
        assert_eq!(
            validate_download_response(
                reqwest::StatusCode::PARTIAL_CONTENT,
                Some(60),
                Some("bytes 40-99/100"),
                40,
                100,
            )
            .unwrap(),
            DownloadResponseMode::Append
        );
    }

    #[test]
    fn full_response_to_range_request_restarts_in_place() {
        assert_eq!(
            validate_download_response(reqwest::StatusCode::OK, Some(100), None, 40, 100).unwrap(),
            DownloadResponseMode::Restart
        );
    }

    #[test]
    fn mismatched_range_facts_fail_closed() {
        assert!(
            validate_download_response(reqwest::StatusCode::OK, Some(99), None, 0, 100,).is_err()
        );
        assert!(validate_download_response(
            reqwest::StatusCode::PARTIAL_CONTENT,
            Some(60),
            Some("bytes 39-98/100"),
            40,
            100,
        )
        .is_err());
        assert!(validate_download_response(
            reqwest::StatusCode::PARTIAL_CONTENT,
            Some(59),
            Some("bytes 40-99/100"),
            40,
            100,
        )
        .is_err());
        assert!(validate_download_response(
            reqwest::StatusCode::RANGE_NOT_SATISFIABLE,
            Some(0),
            Some("bytes */100"),
            40,
            100,
        )
        .is_err());
        assert!(validate_download_response(
            reqwest::StatusCode::PARTIAL_CONTENT,
            Some(0),
            Some("bytes 101-99/100"),
            101,
            100,
        )
        .is_err());
    }

    #[test]
    fn only_transient_http_statuses_are_retryable() {
        assert!(retryable_status(reqwest::StatusCode::REQUEST_TIMEOUT));
        assert!(retryable_status(reqwest::StatusCode::TOO_MANY_REQUESTS));
        assert!(retryable_status(reqwest::StatusCode::SERVICE_UNAVAILABLE));
        assert!(!retryable_status(reqwest::StatusCode::UNAUTHORIZED));
        assert!(!retryable_status(reqwest::StatusCode::NOT_FOUND));
    }
}
