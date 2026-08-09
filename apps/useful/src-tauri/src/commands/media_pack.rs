//! Signed MediaPack catalog, cancellable download, verified install, and rollback commands.
//!
//! The renderer selects only a pack id. Catalog URLs and the Ed25519 trust root are compile-time
//! release inputs; absent production inputs keep installation blocked.

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
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use useful_media::pack::{
    self, CatalogAsset, CatalogPack, InstallInput, MediaPackCatalog, MAX_CATALOG_BYTES,
};

const CATALOG_URL: Option<&str> = option_env!("USEFUL_MEDIA_PACK_CATALOG_URL");
const CATALOG_SIGNATURE_URL: Option<&str> = option_env!("USEFUL_MEDIA_PACK_CATALOG_SIGNATURE_URL");
const PUBLIC_KEY_HEX: Option<&str> = option_env!("USEFUL_MEDIA_PACK_PUBLIC_KEY_HEX");
const MAX_DOWNLOAD_ATTEMPTS: u8 = 3;

#[derive(Clone)]
struct TrustConfig {
    catalog_url: String,
    signature_url: String,
    public_key_hex: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaPackCatalogView {
    pub trust_state: String,
    pub reason: Option<String>,
    pub public_key_fingerprint: Option<String>,
    pub packs: Vec<MediaPackView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaPackView {
    pub id: String,
    pub download_bytes: u64,
    pub archive_bytes: u64,
    pub corresponding_source_url: String,
    pub corresponding_source_sha256: String,
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

fn trust_config() -> CmdResult<Option<TrustConfig>> {
    match (CATALOG_URL, CATALOG_SIGNATURE_URL, PUBLIC_KEY_HEX) {
        (None, None, None) => Ok(None),
        (Some(catalog_url), Some(signature_url), Some(public_key_hex)) => {
            for (value, label) in [
                (catalog_url, "MediaPack catalog URL"),
                (signature_url, "MediaPack catalog signature URL"),
            ] {
                let parsed = reqwest::Url::parse(value)
                    .map_err(|_| CmdError::from(format!("{label} 无效")))?;
                if parsed.scheme() != "https"
                    || parsed.host_str().is_none()
                    || !parsed.username().is_empty()
                    || parsed.password().is_some()
                    || parsed.fragment().is_some()
                {
                    return Err(CmdError::from(format!("{label} 必须是无凭据 HTTPS URL")));
                }
            }
            if public_key_hex.len() != 64
                || !public_key_hex
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                || public_key_hex.bytes().all(|byte| byte == b'0')
            {
                return Err(CmdError::from("MediaPack production public key 无效"));
            }
            Ok(Some(TrustConfig {
                catalog_url: catalog_url.into(),
                signature_url: signature_url.into(),
                public_key_hex: public_key_hex.into(),
            }))
        }
        _ => Err(CmdError::from(
            "MediaPack production trust configuration 不完整",
        )),
    }
}

fn http_client() -> CmdResult<reqwest::Client> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(30))
        .no_gzip()
        .build()
        .map_err(|_| CmdError::from("无法初始化 MediaPack HTTPS client"))
}

async fn fetch_small(client: &reqwest::Client, url: &str, maximum: usize) -> CmdResult<Vec<u8>> {
    let mut response = client
        .get(url)
        .header(ACCEPT_ENCODING, "identity")
        .send()
        .await
        .map_err(|_| CmdError::from("无法读取 MediaPack catalog"))?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(CmdError::from("MediaPack catalog HTTP 状态无效"));
    }
    if response
        .content_length()
        .is_some_and(|length| length as usize > maximum)
    {
        return Err(CmdError::from("MediaPack catalog 超过大小限制"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| CmdError::from("无法读取 MediaPack catalog bytes"))?
    {
        if bytes.len().saturating_add(chunk.len()) > maximum {
            return Err(CmdError::from("MediaPack catalog 超过大小限制"));
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.is_empty() {
        return Err(CmdError::from("MediaPack catalog bytes 无效"));
    }
    Ok(bytes)
}

async fn load_catalog(config: &TrustConfig) -> CmdResult<MediaPackCatalog> {
    let client = http_client()?;
    let (catalog_bytes, signature_bytes) = tokio::try_join!(
        fetch_small(&client, &config.catalog_url, MAX_CATALOG_BYTES),
        fetch_small(&client, &config.signature_url, 256),
    )?;
    let signature = std::str::from_utf8(&signature_bytes)
        .map_err(|_| CmdError::from("MediaPack catalog signature 编码无效"))?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| CmdError::from("系统时间无效"))?
        .as_secs() as i64;
    pack::verify_catalog(
        &catalog_bytes,
        signature.trim(),
        &config.public_key_hex,
        now,
    )
    .map_err(|_| CmdError::from("MediaPack catalog 验签或闭合校验失败"))
}

fn view_for_pack(state: &AppState, pack: &CatalogPack) -> MediaPackView {
    let installed = pack::installed_status(&state.media.media_root, &pack.id);
    MediaPackView {
        id: pack.id.clone(),
        download_bytes: pack
            .archive
            .size_bytes
            .saturating_add(pack.manifest.size_bytes)
            .saturating_add(pack.statement.size_bytes),
        archive_bytes: pack.archive.size_bytes,
        corresponding_source_url: pack.corresponding_source.url.clone(),
        corresponding_source_sha256: pack.corresponding_source.sha256.clone(),
        installed: installed.current_relative_path.is_some(),
        previous_available: installed.previous_available,
        damaged: installed.damaged,
    }
}

#[tauri::command]
pub async fn media_pack_catalog(state: State<'_, AppState>) -> CmdResult<MediaPackCatalogView> {
    let Some(config) = trust_config()? else {
        return Ok(MediaPackCatalogView {
            trust_state: "blocked".into(),
            reason: Some("production-trust-not-configured".into()),
            public_key_fingerprint: None,
            packs: Vec::new(),
        });
    };
    match load_catalog(&config).await {
        Ok(catalog) => Ok(MediaPackCatalogView {
            trust_state: "ready".into(),
            reason: None,
            public_key_fingerprint: Some(pack::sha256_hex(
                &hex::decode(&config.public_key_hex)
                    .map_err(|_| CmdError::from("MediaPack production public key 无效"))?,
            )),
            packs: catalog
                .packs
                .iter()
                .map(|item| view_for_pack(&state, item))
                .collect(),
        }),
        Err(error) => {
            tracing::warn!("MediaPack catalog unavailable: {}", error.message);
            Ok(MediaPackCatalogView {
                trust_state: "unavailable".into(),
                reason: Some("catalog-unavailable".into()),
                public_key_fingerprint: None,
                packs: Vec::new(),
            })
        }
    }
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
    let config =
        trust_config()?.ok_or_else(|| CmdError::from("MediaPack production trust 尚未配置"))?;
    let catalog = load_catalog(&config).await?;
    let pack = catalog
        .packs
        .into_iter()
        .find(|item| item.id == pack_id)
        .ok_or_else(|| CmdError::from("可信 catalog 中不存在该 MediaPack"))?;
    if pack::installed_status(&state.media.media_root, &pack_id)
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
        let result = run_install(&app, &task_id_for_run, &pack, &config, cancel.clone()).await;
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
    pack: &CatalogPack,
    config: &TrustConfig,
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
    let total = pack
        .archive
        .size_bytes
        .saturating_add(pack.manifest.size_bytes)
        .saturating_add(pack.statement.size_bytes);
    let result = async {
        let client = http_client()?;
        let mut received = 0u64;
        let archive_path = task_root.join(&pack.archive.file_name);
        received = download_asset(
            app,
            task_id,
            &pack.id,
            &client,
            &pack.archive,
            &archive_path,
            received,
            total,
            &cancel,
        )
        .await?;
        let manifest_path = task_root.join(&pack.manifest.file_name);
        received = download_asset(
            app,
            task_id,
            &pack.id,
            &client,
            &pack.manifest,
            &manifest_path,
            received,
            total,
            &cancel,
        )
        .await?;
        let statement_path = task_root.join(&pack.statement.file_name);
        let _ = download_asset(
            app,
            task_id,
            &pack.id,
            &client,
            &pack.statement,
            &statement_path,
            received,
            total,
            &cancel,
        )
        .await?;
        if cancel.load(Ordering::Relaxed) {
            return Err(CmdError::from("MediaPack install cancelled"));
        }
        emit_progress(app, task_id, &pack.id, "verifying", total, total);
        let manifest_bytes = read_exact_bounded(&manifest_path, pack.manifest.size_bytes).await?;
        let statement_bytes =
            read_exact_bounded(&statement_path, pack.statement.size_bytes).await?;
        let pack_for_install = pack.clone();
        let public_key = config.public_key_hex.clone();
        let install_root = state.media.media_root.clone();
        let archive_for_install = archive_path.clone();
        emit_progress(app, task_id, &pack.id, "installing", total, total);
        tauri::async_runtime::spawn_blocking(move || {
            pack::install_verified_pack(InstallInput {
                pack: &pack_for_install,
                public_key_hex: &public_key,
                archive_path: &archive_for_install,
                manifest_bytes: &manifest_bytes,
                statement_bytes: &statement_bytes,
                install_root: &install_root,
                current_useful_version: HOST_VERSION,
            })
            .map_err(|_| CmdError::from("MediaPack verification or atomic install failed"))
        })
        .await
        .map_err(|_| CmdError::from("MediaPack install worker failed"))??;
        emit_progress(app, task_id, &pack.id, "redetecting", total, total);
        state.media.refresh_sidecars()?;
        Ok(())
    }
    .await;
    if let Err(error) = cleanup_task_root(&task_root, pack) {
        tracing::warn!(
            "MediaPack temp cleanup failed {}: {}",
            task_root.display(),
            error
        );
    }
    result
}

async fn read_exact_bounded(path: &Path, expected_size: u64) -> CmdResult<Vec<u8>> {
    use tokio::io::{AsyncReadExt, BufReader};

    let file = tokio::fs::File::open(path)
        .await
        .map_err(|_| CmdError::from("无法打开已下载 MediaPack metadata"))?;
    let mut reader = BufReader::new(file).take(expected_size.saturating_add(1));
    let mut bytes = Vec::with_capacity(expected_size as usize);
    reader
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| CmdError::from("无法读取已下载 MediaPack metadata"))?;
    if bytes.len() as u64 != expected_size {
        return Err(CmdError::from("MediaPack metadata 大小与 catalog 不一致"));
    }
    Ok(bytes)
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

fn cleanup_task_root(task_root: &Path, pack: &CatalogPack) -> std::io::Result<()> {
    for asset in [&pack.archive, &pack.manifest, &pack.statement] {
        let destination = task_root.join(&asset.file_name);
        for path in [part_path(&destination), destination] {
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
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
    asset: &CatalogAsset,
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
    pack::rollback(&state.media.media_root, &pack_id)
        .map_err(|_| CmdError::from("没有可用的上一版 MediaPack"))?;
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
