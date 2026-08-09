//! 视频裁剪媒体命令：sidecar 探测、ffprobe 元数据、编码器检测、缩略图（LRU+磁盘）、
//! ffmpeg 导出（进度事件 + 取消）。所有子进程使用参数数组，绝不拼接 shell。

use super::{CmdError, CmdResult};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
#[cfg(windows)]
use tauri::Manager;
use tauri::{Emitter, State};
use useful_media::compat::{validate_audio_copy_output, validate_lossless_output};
use useful_media::encoders::EncoderSupport;
use useful_media::export::{self, ExportOutcome};
use useful_media::ffargs::{AudioFormat, ExportSpec, HwEncoder, VideoCodec};
use useful_media::ffprobe::MediaInfo;
use useful_media::sidecar::Sidecars;
use useful_media::thumbnail::{self, LruCache};

const MAX_CONCURRENT_EXPORTS: usize = 2;

/// 媒体全局状态。
pub struct MediaState {
    sidecars: Mutex<Sidecars>,
    exe_dir: PathBuf,
    pub media_root: PathBuf,
    cache_dir: PathBuf,
    export_temp_dir: PathBuf,
    /// 缩略图 LRU：cache_key -> 磁盘 png 路径
    thumb_cache: Mutex<LruCache<PathBuf>>,
    /// 同一缓存键只允许一个 ffmpeg 任务；等待者复用其结果。
    thumb_flights: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    /// 运行中的导出任务：taskId -> 取消标志
    exports: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    /// 运行中的 MediaPack 安装任务：taskId -> 取消标志
    pub pack_installs: Mutex<HashMap<String, MediaPackInstallTask>>,
    /// mpv 预览宿主（Windows）
    #[cfg(windows)]
    mpv: Mutex<Option<crate::platform::mpv::MpvHost>>,
}

impl MediaState {
    pub fn new(exe_dir: &Path, cache_dir: &Path, media_root: &Path) -> Self {
        Self {
            sidecars: Mutex::new(Sidecars::resolve_with_media_root(exe_dir, media_root)),
            exe_dir: exe_dir.to_path_buf(),
            media_root: media_root.to_path_buf(),
            cache_dir: cache_dir.join("thumbnails"),
            export_temp_dir: cache_dir.join("export-temp"),
            thumb_cache: Mutex::new(LruCache::new(512)),
            thumb_flights: Arc::new(Mutex::new(HashMap::new())),
            exports: Arc::new(Mutex::new(HashMap::new())),
            pack_installs: Mutex::new(HashMap::new()),
            #[cfg(windows)]
            mpv: Mutex::new(None),
        }
    }

    pub fn sidecars(&self) -> CmdResult<Sidecars> {
        self.sidecars
            .lock()
            .map(|sidecars| sidecars.clone())
            .map_err(|_| CmdError::from("锁定媒体组件状态失败"))
    }

    pub fn refresh_sidecars(&self) -> CmdResult<Sidecars> {
        let resolved = Sidecars::resolve_with_media_root(&self.exe_dir, &self.media_root);
        let mut sidecars = self
            .sidecars
            .lock()
            .map_err(|_| CmdError::from("锁定媒体组件状态失败"))?;
        *sidecars = resolved.clone();
        Ok(resolved)
    }
}

pub struct MediaPackInstallTask {
    pub pack_id: String,
    pub cancel: Arc<AtomicBool>,
}

struct ThumbnailFlightGuard {
    registry: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    key: String,
    lock: Arc<tokio::sync::Mutex<()>>,
    _guard: tokio::sync::OwnedMutexGuard<()>,
}

impl Drop for ThumbnailFlightGuard {
    fn drop(&mut self) {
        let mut registry = self
            .registry
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // 持有 registry 锁后，无新等待者能在计数与删除之间取得旧锁。
        // 无等待者时计数恰为 registry + self.lock + OwnedMutexGuard。
        if Arc::strong_count(&self.lock) == 3
            && registry
                .get(&self.key)
                .is_some_and(|current| Arc::ptr_eq(current, &self.lock))
        {
            registry.remove(&self.key);
        }
    }
}

async fn acquire_thumbnail_flight(
    registry: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    key: String,
) -> ThumbnailFlightGuard {
    let lock = {
        let mut registry = registry
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        registry
            .entry(key.clone())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    };
    let guard = lock.clone().lock_owned().await;
    ThumbnailFlightGuard {
        registry,
        key,
        lock,
        _guard: guard,
    }
}

/// 无论导出 future 正常返回、失败、panic 还是被 abort，都从任务表移除记录。
struct ExportTaskGuard {
    exports: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    task_id: String,
}

impl Drop for ExportTaskGuard {
    fn drop(&mut self) {
        let mut exports = self
            .exports
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        exports.remove(&self.task_id);
    }
}

#[tauri::command]
pub fn media_sidecars(state: State<AppState>) -> CmdResult<Sidecars> {
    #[cfg(windows)]
    let sidecars = state.media.refresh_sidecars()?;
    #[cfg(not(windows))]
    let mut sidecars = state.media.refresh_sidecars()?;
    // 当前预览宿主依赖 Windows HWND。PATH 中出现 mpv 不代表其他平台已实现预览后端。
    #[cfg(not(windows))]
    {
        sidecars.mpv.available = false;
        sidecars.mpv.path = None;
        sidecars.mpv.reason = Some("platform-unsupported".into());
    }
    Ok(sidecars)
}

#[tauri::command]
pub async fn media_probe(state: State<'_, AppState>, path: String) -> CmdResult<MediaInfo> {
    let ffprobe = state.media.sidecars()?.ffprobe_path().ok_or_else(|| {
        CmdError::from("ffprobe 不可用（Lite 版无媒体运行时，请安装 Full 版或提供 ffprobe）")
    })?;
    let info = export::probe(&ffprobe, Path::new(&path))
        .await
        .map_err(|e| CmdError::from(e.to_string()))?;
    info.validate_for_trim()
        .map_err(|e| CmdError::from(format!("ffprobe 已读取文件，但媒体不可用于视频裁剪: {e}")))?;
    Ok(info)
}

#[tauri::command]
pub async fn media_detect_encoders(state: State<'_, AppState>) -> CmdResult<EncoderSupport> {
    let ffmpeg = state
        .media
        .sidecars()?
        .ffmpeg_path()
        .ok_or_else(|| CmdError::from("ffmpeg 不可用"))?;
    let enc = export::detect_encoders(&ffmpeg)
        .await
        .map_err(|e| CmdError::from(e.to_string()))?;
    Ok(enc)
}

/// 生成/读取缩略图，返回 data URL（base64 PNG），便于沙箱前端直接显示。
#[tauri::command]
pub async fn media_thumbnail(
    state: State<'_, AppState>,
    path: String,
    time_sec: f64,
    width: u32,
) -> CmdResult<String> {
    let input = PathBuf::from(&path);
    let meta = std::fs::metadata(&input).map_err(|e| CmdError::from(e.to_string()))?;
    let size = meta.len();
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let normalized = useful_core::paths::normalize_for_key(&input);
    let digest = thumbnail::quick_digest(&input).map_err(|e| CmdError::from(e.to_string()))?;
    // 缓存键还包含时间点与宽度
    let base = thumbnail::cache_key(&normalized, size, mtime, &digest);
    let key = format!("{base}-{}-{width}", (time_sec * 1000.0) as i64);
    let _flight = acquire_thumbnail_flight(state.media.thumb_flights.clone(), key.clone()).await;

    // 命中缓存
    let cached: Option<PathBuf> = {
        let mut cache = state
            .media
            .thumb_cache
            .lock()
            .map_err(|_| CmdError::from("锁定缓存失败"))?;
        cache.get(&key).filter(|p| p.exists())
    };
    let png_path = match cached {
        Some(p) => p,
        None => {
            let ffmpeg = state
                .media
                .sidecars()?
                .ffmpeg_path()
                .ok_or_else(|| CmdError::from("ffmpeg 不可用"))?;
            std::fs::create_dir_all(&state.media.cache_dir)
                .map_err(|e| CmdError::from(e.to_string()))?;
            let out = state
                .media
                .cache_dir
                .join(format!(".useful-thumb-{}.png", uuid::Uuid::new_v4()));
            let args = thumbnail::build_thumbnail_args(&input, time_sec, &out, width);
            export::generate_thumbnail(&ffmpeg, &args, &out)
                .await
                .map_err(|e| CmdError::from(e.to_string()))?;
            // 记录缓存，淘汰旧文件
            let evicted = {
                let mut cache = state
                    .media
                    .thumb_cache
                    .lock()
                    .map_err(|_| CmdError::from("锁定缓存失败"))?;
                cache.put(key.clone(), out.clone())
            };
            if let Some((_old_key, old_path)) = evicted {
                let _ = std::fs::remove_file(old_path);
            }
            out
        }
    };

    let bytes = std::fs::read(&png_path).map_err(|e| CmdError::from(e.to_string()))?;
    Ok(format!("data:image/png;base64,{}", base64_encode(&bytes)))
}

/// 导出请求（来自前端）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportRequest {
    pub input: String,
    pub output: String,
    pub mode: String, // lossless | precise | audio
    pub start_sec: f64,
    pub end_sec: f64,
    /// precise: h264|h265|av1
    #[serde(default)]
    pub codec: Option<String>,
    /// precise: 质量（CRF/CQ）
    #[serde(default)]
    pub quality: Option<u8>,
    /// audio: copy|mp3|aac|flac|wav
    #[serde(default)]
    pub audio_format: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportStarted {
    pub task_id: String,
    pub output: String,
}

/// 启动导出任务；进度通过 `media-progress` 事件推送。
#[tauri::command]
pub async fn media_export(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    req: ExportRequest,
) -> CmdResult<ExportStarted> {
    let sidecars = state.media.sidecars()?;
    let ffmpeg = sidecars
        .ffmpeg_path()
        .ok_or_else(|| CmdError::from("ffmpeg 不可用"))?;

    let output = export::resolve_output(Path::new(&req.output))
        .map_err(|error| CmdError::from(error.to_string()))?;
    let spec = build_spec(&req)?;
    let ffprobe = sidecars
        .ffprobe_path()
        .ok_or_else(|| CmdError::from("ffprobe 不可用，无法验证源流与输出容器兼容性"))?;
    let source_info = export::probe(&ffprobe, Path::new(&req.input))
        .await
        .map_err(|e| CmdError::from(format!("导出前探测失败: {e}")))?;
    source_info
        .validate_for_trim()
        .map_err(|e| CmdError::from(format!("导出前媒体验证失败: {e}")))?;
    match &spec {
        ExportSpec::LosslessCut { .. } => validate_lossless_output(&source_info, &output),
        ExportSpec::AudioExtract {
            format: AudioFormat::Copy,
            ..
        } => validate_audio_copy_output(&source_info, &output),
        _ => Ok(()),
    }
    .map_err(CmdError::from)?;
    let total_dur = (req.end_sec - req.start_sec).max(0.001);

    let task_id = uuid::Uuid::new_v4().to_string();
    let cancel = Arc::new(AtomicBool::new(false));
    let export_temp = export::create_export_temp(&state.media.export_temp_dir, &output, &task_id)
        .map_err(|error| CmdError::from(error.to_string()))?;
    {
        let mut exports = state
            .media
            .exports
            .lock()
            .map_err(|_| CmdError::from("锁定导出表失败"))?;
        register_export(&mut exports, task_id.clone(), cancel.clone())?;
    }

    let input = PathBuf::from(&req.input);
    let out_clone = output.clone();
    let temp_path = export_temp.path().to_path_buf();
    let task_id_thread = task_id.clone();
    let app_handle = app.clone();
    let registration = ExportTaskGuard {
        exports: state.media.exports.clone(),
        task_id: task_id.clone(),
    };

    // 在后台异步任务中运行导出
    tauri::async_runtime::spawn(async move {
        let registration = registration;
        let tid = task_id_thread.clone();
        let emit_app = app_handle.clone();
        let result = export::run_export(
            &ffmpeg,
            &input,
            &temp_path,
            &spec,
            cancel.clone(),
            move |update| {
                let (percent, eta) = update.percent_and_eta(total_dur);
                let _ = emit_app.emit(
                    "media-progress",
                    serde_json::json!({
                        "taskId": tid,
                        "percent": percent,
                        "etaSec": eta,
                        "frame": update.frame,
                        "speed": update.speed,
                        "done": update.done,
                    }),
                );
            },
        )
        .await;

        let result = match result {
            Ok(ExportOutcome::Completed) => export_temp
                .commit(&out_clone)
                .map(|_| ExportOutcome::Completed),
            other => other,
        };
        // 完成事件发送前先移除记录；panic/abort 也会由 Drop 清理。
        drop(registration);

        let payload = match result {
            Ok(ExportOutcome::Completed) => serde_json::json!({
                "taskId": task_id_thread, "status": "completed",
                "output": out_clone.to_string_lossy().to_string()
            }),
            Ok(ExportOutcome::Cancelled) => serde_json::json!({
                "taskId": task_id_thread, "status": "cancelled"
            }),
            Err(e) => serde_json::json!({
                "taskId": task_id_thread, "status": "failed", "error": e.to_string()
            }),
        };
        let _ = app_handle.emit("media-export-done", payload);
    });

    Ok(ExportStarted {
        task_id,
        output: output.to_string_lossy().to_string(),
    })
}

fn register_export(
    exports: &mut HashMap<String, Arc<AtomicBool>>,
    task_id: String,
    cancel: Arc<AtomicBool>,
) -> CmdResult<()> {
    if exports.len() >= MAX_CONCURRENT_EXPORTS {
        return Err(CmdError::from(format!(
            "同时最多运行 {MAX_CONCURRENT_EXPORTS} 个媒体导出任务"
        )));
    }
    if exports.contains_key(&task_id) {
        return Err(CmdError::from("导出任务 id 冲突，已拒绝启动"));
    }
    exports.insert(task_id, cancel);
    Ok(())
}

/// 取消导出任务。
#[tauri::command]
pub fn media_cancel_export(state: State<AppState>, task_id: String) -> CmdResult<()> {
    let exports = state
        .media
        .exports
        .lock()
        .map_err(|_| CmdError::from("锁定导出表失败"))?;
    request_export_cancel(&exports, &task_id)
}

fn request_export_cancel(
    exports: &HashMap<String, Arc<AtomicBool>>,
    task_id: &str,
) -> CmdResult<()> {
    let cancel = exports
        .get(task_id)
        .ok_or_else(|| CmdError::from("导出任务不存在或已结束"))?;
    cancel.store(true, Ordering::SeqCst);
    Ok(())
}

fn build_spec(req: &ExportRequest) -> Result<ExportSpec, CmdError> {
    match req.mode.as_str() {
        "lossless" => Ok(ExportSpec::LosslessCut {
            start_sec: req.start_sec,
            end_sec: req.end_sec,
        }),
        "precise" => {
            let codec = match req.codec.as_deref() {
                Some("h265") => VideoCodec::H265,
                Some("av1") => VideoCodec::Av1,
                _ => VideoCodec::H264,
            };
            Ok(ExportSpec::PreciseCut {
                start_sec: req.start_sec,
                end_sec: req.end_sec,
                codec,
                // 编码器由前端根据检测结果指定；这里默认软件，前端可传 quality
                encoder: HwEncoder::Software,
                quality: req.quality.unwrap_or(20),
            })
        }
        "audio" => {
            let format = match req.audio_format.as_deref() {
                Some("mp3") => AudioFormat::Mp3,
                Some("aac") => AudioFormat::Aac,
                Some("flac") => AudioFormat::Flac,
                Some("wav") => AudioFormat::Wav,
                _ => AudioFormat::Copy,
            };
            Ok(ExportSpec::AudioExtract {
                start_sec: req.start_sec,
                end_sec: req.end_sec,
                format,
            })
        }
        other => Err(CmdError::from(format!("未知导出模式: {other}"))),
    }
}

// ---- mpv 预览（Windows：--wid 子窗口嵌入 + JSON IPC） ----

#[cfg(windows)]
#[tauri::command]
pub fn mpv_start(
    app: tauri::AppHandle,
    state: State<AppState>,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    software: bool,
) -> CmdResult<()> {
    let mpv_path = state
        .media
        .sidecars()?
        .mpv_path()
        .ok_or_else(|| CmdError::from("mpv 不可用"))?;
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| CmdError::from("找不到主窗口"))?;
    let hwnd = window.hwnd().map_err(|e| CmdError::from(e.to_string()))?;
    let parent = hwnd.0 as isize;
    let mut host =
        crate::platform::mpv::MpvHost::start(parent, &mpv_path, (x, y, width, height), software)
            .map_err(CmdError::from)?;
    // mpv 属性回读：time-pos 事件流 + 持续丢帧检测（触发时提示生成代理预览）
    let ready = spawn_mpv_event_reader(
        app.clone(),
        host.pipe_name().to_string(),
        host.load_monitor(),
    );
    match ready.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            host.stop();
            return Err(CmdError::from(e));
        }
        Err(_) => {
            host.stop();
            return Err(CmdError::from("mpv IPC 事件通道未在 5 秒内就绪"));
        }
    }
    let mut guard = state
        .media
        .mpv
        .lock()
        .map_err(|_| CmdError::from("锁定 mpv 失败"))?;
    if let Some(mut old) = guard.take() {
        old.stop();
    }
    *guard = Some(host);
    Ok(())
}

/// 后台线程：连接 mpv IPC 管道，订阅 time-pos / frame-drop-count 属性变化，
/// 转发为前端事件；检测到持续丢帧时发一次 `mpv-frame-drops` 提示。
#[cfg(windows)]
fn spawn_mpv_event_reader(
    app: tauri::AppHandle,
    pipe: String,
    load_monitor: Arc<useful_media::mpv::LoadMonitor>,
) -> std::sync::mpsc::Receiver<Result<(), String>> {
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        use std::io::{BufRead, BufReader, Write};
        use useful_media::mpv::{
            parse_load_event, parse_property_change, FrameDropDetector, IpcCommand,
        };

        // 等待 mpv 创建管道（最多 5 秒）
        let mut file = None;
        for _ in 0..20 {
            match std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&pipe)
            {
                Ok(f) => {
                    file = Some(f);
                    break;
                }
                Err(_) => std::thread::sleep(std::time::Duration::from_millis(250)),
            }
        }
        let Some(f) = file else {
            tracing::warn!("mpv 事件流：IPC 管道不可用，属性回读已禁用");
            let _ = ready_tx.send(Err("mpv IPC 管道不可用".into()));
            return;
        };
        let Ok(mut writer) = f.try_clone() else {
            let _ = ready_tx.send(Err("无法复制 mpv IPC 管道句柄".into()));
            return;
        };
        for (id, prop) in [(1u64, "time-pos"), (2u64, "frame-drop-count")] {
            let mut line = IpcCommand::observe_property(id, prop).to_line();
            line.push('\n');
            if writer.write_all(line.as_bytes()).is_err() {
                let _ = ready_tx.send(Err("无法订阅 mpv 属性事件".into()));
                return;
            }
        }
        let _ = ready_tx.send(Ok(()));
        let mut detector = FrameDropDetector::default_policy();
        for line in BufReader::new(f).lines() {
            let Ok(line) = line else { break };
            if let Some(event) = parse_load_event(&line) {
                load_monitor.update(event);
                continue;
            }
            let Some(ev) = parse_property_change(&line) else {
                continue;
            };
            match ev.name.as_str() {
                "time-pos" => {
                    let _ = app.emit("mpv-time-pos", ev.value);
                }
                "frame-drop-count" => {
                    if let Some(v) = ev.value {
                        if detector.push(v) {
                            tracing::warn!("检测到持续丢帧，建议生成代理预览");
                            let _ = app
                                .emit("mpv-frame-drops", serde_json::json!({"suggestProxy": true}));
                        }
                    }
                }
                _ => {}
            }
        }
        tracing::info!("mpv 事件流结束");
    });
    ready_rx
}

#[cfg(windows)]
#[tauri::command]
pub fn mpv_set_rect(
    state: State<AppState>,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> CmdResult<()> {
    let guard = state
        .media
        .mpv
        .lock()
        .map_err(|_| CmdError::from("锁定 mpv 失败"))?;
    if let Some(host) = guard.as_ref() {
        host.set_rect(x, y, width, height);
    }
    Ok(())
}

#[cfg(windows)]
#[tauri::command]
pub fn mpv_load(state: State<AppState>, path: String) -> CmdResult<MpvLoadResult> {
    use useful_media::mpv::IpcCommand;
    let guard = state
        .media
        .mpv
        .lock()
        .map_err(|_| CmdError::from("锁定 mpv 失败"))?;
    let host = guard
        .as_ref()
        .ok_or_else(|| CmdError::from("mpv 预览后端尚未启动"))?;
    host.begin_load();
    host.send(&IpcCommand::load_file(&path))
        .map_err(CmdError::from)?;
    host.wait_for_load(std::time::Duration::from_secs(10))
        .map_err(CmdError::from)?;
    Ok(MpvLoadResult {
        status: "loaded",
        backend: "mpv-windows",
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvLoadResult {
    status: &'static str,
    backend: &'static str,
}

#[cfg(windows)]
#[tauri::command]
pub fn mpv_set_paused(state: State<AppState>, paused: bool) -> CmdResult<()> {
    use useful_media::mpv::IpcCommand;
    let guard = state
        .media
        .mpv
        .lock()
        .map_err(|_| CmdError::from("锁定 mpv 失败"))?;
    if let Some(host) = guard.as_ref() {
        host.send(&IpcCommand::set_pause(paused))
            .map_err(CmdError::from)?;
    }
    Ok(())
}

#[cfg(windows)]
#[tauri::command]
pub fn mpv_seek(state: State<AppState>, sec: f64) -> CmdResult<()> {
    use useful_media::mpv::IpcCommand;
    let guard = state
        .media
        .mpv
        .lock()
        .map_err(|_| CmdError::from("锁定 mpv 失败"))?;
    if let Some(host) = guard.as_ref() {
        host.send(&IpcCommand::seek_absolute(sec))
            .map_err(CmdError::from)?;
    }
    Ok(())
}

#[cfg(windows)]
#[tauri::command]
pub fn mpv_stop(state: State<AppState>) -> CmdResult<()> {
    let mut guard = state
        .media
        .mpv
        .lock()
        .map_err(|_| CmdError::from("锁定 mpv 失败"))?;
    if let Some(mut host) = guard.take() {
        host.stop();
    }
    Ok(())
}

// 非 Windows 平台的 mpv 命令占位（保证命令注册一致）
#[cfg(not(windows))]
fn unsupported_preview<T>() -> CmdResult<T> {
    Err(CmdError::from(
        "当前平台没有可用的 native mpv 预览宿主；可继续使用探测、缩略图与导出功能",
    ))
}

#[cfg(not(windows))]
#[tauri::command]
pub fn mpv_start(
    _app: tauri::AppHandle,
    _state: State<AppState>,
    _x: i32,
    _y: i32,
    _width: i32,
    _height: i32,
    _software: bool,
) -> CmdResult<()> {
    unsupported_preview()
}
#[cfg(not(windows))]
#[tauri::command]
pub fn mpv_set_rect(
    _state: State<AppState>,
    _x: i32,
    _y: i32,
    _width: i32,
    _height: i32,
) -> CmdResult<()> {
    unsupported_preview()
}
#[cfg(not(windows))]
#[tauri::command]
pub fn mpv_load(_state: State<AppState>, _path: String) -> CmdResult<MpvLoadResult> {
    unsupported_preview()
}
#[cfg(not(windows))]
#[tauri::command]
pub fn mpv_set_paused(_state: State<AppState>, _paused: bool) -> CmdResult<()> {
    unsupported_preview()
}
#[cfg(not(windows))]
#[tauri::command]
pub fn mpv_seek(_state: State<AppState>, _sec: f64) -> CmdResult<()> {
    unsupported_preview()
}
#[cfg(not(windows))]
#[tauri::command]
pub fn mpv_stop(_state: State<AppState>) -> CmdResult<()> {
    unsupported_preview()
}

/// 极简 base64 编码（标准字母表，无换行）。
fn base64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[(n >> 18 & 63) as usize] as char);
        out.push(T[(n >> 12 & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            T[(n >> 6 & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn build_spec_modes() {
        let base = ExportRequest {
            input: "i".into(),
            output: "o".into(),
            mode: "lossless".into(),
            start_sec: 1.0,
            end_sec: 5.0,
            codec: None,
            quality: None,
            audio_format: None,
        };
        assert!(matches!(
            build_spec(&base).unwrap(),
            ExportSpec::LosslessCut { .. }
        ));

        let precise = ExportRequest {
            mode: "precise".into(),
            codec: Some("h265".into()),
            ..clone_req(&base)
        };
        assert!(matches!(
            build_spec(&precise).unwrap(),
            ExportSpec::PreciseCut {
                codec: VideoCodec::H265,
                ..
            }
        ));

        let audio = ExportRequest {
            mode: "audio".into(),
            audio_format: Some("mp3".into()),
            ..clone_req(&base)
        };
        assert!(matches!(
            build_spec(&audio).unwrap(),
            ExportSpec::AudioExtract {
                format: AudioFormat::Mp3,
                ..
            }
        ));

        let bad = ExportRequest {
            mode: "nope".into(),
            ..clone_req(&base)
        };
        assert!(build_spec(&bad).is_err());
    }

    #[test]
    fn export_request_rejects_removed_overwrite_field() {
        let value = serde_json::json!({
            "input": "i",
            "output": "o",
            "mode": "lossless",
            "startSec": 0.0,
            "endSec": 1.0,
            "conflict": "overwrite"
        });
        assert!(serde_json::from_value::<ExportRequest>(value).is_err());
    }

    #[test]
    fn export_registry_rejects_collision_and_capacity() {
        let mut exports = HashMap::new();
        let cancel = || Arc::new(AtomicBool::new(false));
        register_export(&mut exports, "one".into(), cancel()).unwrap();
        assert!(register_export(&mut exports, "one".into(), cancel()).is_err());
        register_export(&mut exports, "two".into(), cancel()).unwrap();
        assert!(register_export(&mut exports, "three".into(), cancel()).is_err());
        assert_eq!(exports.len(), MAX_CONCURRENT_EXPORTS);
    }

    #[test]
    fn export_guard_removes_registration_on_every_drop_path() {
        let exports = Arc::new(Mutex::new(HashMap::new()));
        let cancel = Arc::new(AtomicBool::new(false));
        register_export(&mut exports.lock().unwrap(), "guarded".into(), cancel).unwrap();
        let guard = ExportTaskGuard {
            exports: exports.clone(),
            task_id: "guarded".into(),
        };
        assert!(exports.lock().unwrap().contains_key("guarded"));
        drop(guard);
        assert!(!exports.lock().unwrap().contains_key("guarded"));
    }

    #[test]
    fn export_cancel_rejects_unknown_task_and_sets_known_flag() {
        let cancel = Arc::new(AtomicBool::new(false));
        let exports = HashMap::from([("known".to_string(), cancel.clone())]);
        assert!(request_export_cancel(&exports, "missing").is_err());
        request_export_cancel(&exports, "known").unwrap();
        assert!(cancel.load(Ordering::SeqCst));
    }

    fn clone_req(r: &ExportRequest) -> ExportRequest {
        ExportRequest {
            input: r.input.clone(),
            output: r.output.clone(),
            mode: r.mode.clone(),
            start_sec: r.start_sec,
            end_sec: r.end_sec,
            codec: r.codec.clone(),
            quality: r.quality,
            audio_format: r.audio_format.clone(),
        }
    }
}
