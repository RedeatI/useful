//! 异步子进程编排：ffprobe 元数据、ffmpeg 导出（进度+取消）、缩略图、编码器检测。
//!
//! 所有子进程均以参数数组启动（`Command::args`），绝不拼接 shell；支持中文/空格/超长路径。

use crate::encoders::{build_list_encoders_args, EncoderSupport};
use crate::ffargs::{build_ffmpeg_args, build_ffprobe_args, ExportSpec};
use crate::ffprobe::MediaInfo;
use crate::limits::{acquire_sidecar_slot, CHILD_REAP_DEADLINE, PROCESS_POLL_INTERVAL};
pub use crate::limits::{
    ENCODER_DETECT_DEADLINE, EXPORT_DEADLINE, MAX_CAPTURE_BYTES, MAX_EXPORT_BYTES,
    MAX_PROGRESS_LINE_BYTES, MAX_THUMBNAIL_BYTES, PROBE_DEADLINE, THUMBNAIL_DEADLINE,
};
use crate::progress::{ProgressParser, ProgressUpdate};
use std::fs::OpenOptions;
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use thiserror::Error;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::OwnedSemaphorePermit;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn sidecar_command(program: &Path) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    #[cfg(unix)]
    command.process_group(0);
    command
}

#[derive(Debug, Error)]
pub enum MediaError {
    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),
    #[error("sidecar 不可用: {0}")]
    SidecarMissing(String),
    #[error("子进程失败: {0}")]
    ProcessFailed(String),
    #[error("解析失败: {0}")]
    Parse(String),
    #[error("已取消")]
    Cancelled,
    #[error("子进程超过硬截止时间: {0}")]
    Timeout(&'static str),
    #[error("子进程输出超过上限: {0}")]
    OutputTooLarge(&'static str),
    #[error("媒体资源不可用: {0}")]
    ResourceLimit(&'static str),
    #[error("安全提交导出文件失败: {0}")]
    Commit(String),
}

async fn read_bounded<R: AsyncRead + Unpin>(mut reader: R) -> Result<Vec<u8>, MediaError> {
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let read = reader.read(&mut chunk).await?;
        if read == 0 {
            return Ok(bytes);
        }
        if bytes.len().saturating_add(read) > MAX_CAPTURE_BYTES {
            return Err(MediaError::OutputTooLarge("stdout/stderr"));
        }
        bytes.extend_from_slice(&chunk[..read]);
    }
}

struct BoundedProgressReader<R> {
    reader: R,
    pending: Vec<u8>,
}

impl<R: AsyncBufRead + Unpin> BoundedProgressReader<R> {
    fn new(reader: R) -> Self {
        Self {
            reader,
            pending: Vec::new(),
        }
    }

    /// 取下一行。`pending` 是持久状态，因此周期性 `select!` 取消 future
    /// 不会丢掉已从管道消费的字节，也不会重置行长边界。
    async fn next_line(&mut self) -> Result<Option<String>, MediaError> {
        loop {
            let available = self.reader.fill_buf().await?;
            if available.is_empty() {
                return if self.pending.is_empty() {
                    Ok(None)
                } else {
                    Ok(Some(
                        String::from_utf8_lossy(std::mem::take(&mut self.pending).as_slice())
                            .into_owned(),
                    ))
                };
            }
            let take = available
                .iter()
                .position(|byte| *byte == b'\n')
                .map_or(available.len(), |position| position + 1);
            if self.pending.len().saturating_add(take) > MAX_PROGRESS_LINE_BYTES {
                return Err(MediaError::OutputTooLarge("ffmpeg progress line"));
            }
            let complete = available[take - 1] == b'\n';
            self.pending.extend_from_slice(&available[..take]);
            self.reader.consume(take);
            if complete {
                while matches!(self.pending.last(), Some(b'\n' | b'\r')) {
                    self.pending.pop();
                }
                return Ok(Some(
                    String::from_utf8_lossy(std::mem::take(&mut self.pending).as_slice())
                        .into_owned(),
                ));
            }
        }
    }
}

#[cfg(windows)]
struct ChildTreeGuard(windows::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl ChildTreeGuard {
    fn attach(child: &Child) -> Result<Self, MediaError> {
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        let raw = child
            .raw_handle()
            .ok_or_else(|| MediaError::ProcessFailed("无法获取 sidecar 进程句柄".into()))?;
        unsafe {
            let job = CreateJobObjectW(None, None).map_err(|error| {
                MediaError::ProcessFailed(format!("无法创建 sidecar Job Object: {error}"))
            })?;
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if let Err(error) = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .and_then(|_| AssignProcessToJobObject(job, HANDLE(raw)))
            {
                let _ = windows::Win32::Foundation::CloseHandle(job);
                return Err(MediaError::ProcessFailed(format!(
                    "无法把 sidecar 放入受控进程树: {error}"
                )));
            }
            Ok(Self(job))
        }
    }

    fn terminate(&self) {
        unsafe {
            let _ = windows::Win32::System::JobObjects::TerminateJobObject(self.0, 1);
        }
    }

    fn disarm(&mut self) {}
}

// Job handles are kernel objects and may be closed/terminated from the dedicated reaper thread.
#[cfg(windows)]
unsafe impl Send for ChildTreeGuard {}

#[cfg(windows)]
impl Drop for ChildTreeGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(not(windows))]
struct ChildTreeGuard(Option<u32>);

#[cfg(not(windows))]
impl ChildTreeGuard {
    fn attach(child: &Child) -> Result<Self, MediaError> {
        Ok(Self(child.id()))
    }
    fn terminate(&self) {
        #[cfg(unix)]
        if let Some(pid) = self.0 {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
    }

    fn disarm(&mut self) {
        self.0 = None;
    }
}

#[cfg(not(windows))]
impl Drop for ChildTreeGuard {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.0.take() {
            handoff_process_group(pid);
        }
    }
}

enum ReaperJob {
    Child {
        child: Child,
        tree: Option<ChildTreeGuard>,
        _permit: OwnedSemaphorePermit,
    },
    #[cfg(unix)]
    ProcessGroup(u32),
}

fn poll_reaper_job(job: &mut ReaperJob) -> bool {
    match job {
        ReaperJob::Child { child, tree, .. } => {
            if let Some(tree) = tree.as_ref() {
                tree.terminate();
            }
            let _ = child.start_kill();
            match child.try_wait() {
                Ok(Some(_)) => {
                    if let Some(tree) = tree.as_mut() {
                        tree.disarm();
                    }
                    true
                }
                // 未确认退出时继续持有 child、tree 与 semaphore permit，严格限流。
                Ok(None) | Err(_) => false,
            }
        }
        #[cfg(unix)]
        ReaperJob::ProcessGroup(pid) => unsafe {
            if libc::kill(-(*pid as i32), libc::SIGKILL) == 0 {
                false
            } else {
                std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
            }
        },
    }
}

fn run_reaper(receiver: std::sync::mpsc::Receiver<ReaperJob>) {
    let mut jobs = Vec::new();
    let mut disconnected = false;
    loop {
        match receiver.recv_timeout(PROCESS_POLL_INTERVAL) {
            Ok(job) => jobs.push(job),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => disconnected = true,
        }
        while let Ok(job) = receiver.try_recv() {
            jobs.push(job);
        }
        let mut index = 0;
        while index < jobs.len() {
            if poll_reaper_job(&mut jobs[index]) {
                jobs.swap_remove(index);
            } else {
                index += 1;
            }
        }
        if disconnected && jobs.is_empty() {
            break;
        }
    }
}

fn reaper_sender() -> Option<&'static std::sync::mpsc::Sender<ReaperJob>> {
    static REAPER: std::sync::OnceLock<Option<std::sync::mpsc::Sender<ReaperJob>>> =
        std::sync::OnceLock::new();
    REAPER
        .get_or_init(|| {
            let (sender, receiver) = std::sync::mpsc::channel();
            std::thread::Builder::new()
                .name("useful-media-reaper".into())
                .spawn(move || run_reaper(receiver))
                .ok()
                .map(|_| sender)
        })
        .as_ref()
}

fn reap_synchronously(mut job: ReaperJob) {
    while !poll_reaper_job(&mut job) {
        std::thread::sleep(PROCESS_POLL_INTERVAL);
    }
}

fn handoff_reaper(job: ReaperJob) {
    if let Some(sender) = reaper_sender() {
        match sender.send(job) {
            Ok(()) => return,
            Err(error) => {
                reap_synchronously(error.0);
                return;
            }
        }
    }
    reap_synchronously(job);
}

#[cfg(unix)]
fn handoff_process_group(pid: u32) {
    handoff_reaper(ReaperJob::ProcessGroup(pid));
}

async fn stop_child(mut child: Child, mut tree: ChildTreeGuard, permit: OwnedSemaphorePermit) {
    tree.terminate();
    let _ = child.start_kill();
    match tokio::time::timeout(CHILD_REAP_DEADLINE, child.wait()).await {
        Ok(Ok(_)) => tree.disarm(),
        Ok(Err(_)) | Err(_) => {
            handoff_reaper(ReaperJob::Child {
                child,
                tree: Some(tree),
                _permit: permit,
            });
        }
    }
}

async fn stop_unattached_child(mut child: Child, permit: OwnedSemaphorePermit) {
    let _ = child.start_kill();
    if !matches!(
        tokio::time::timeout(CHILD_REAP_DEADLINE, child.wait()).await,
        Ok(Ok(_))
    ) {
        handoff_reaper(ReaperJob::Child {
            child,
            tree: None,
            _permit: permit,
        });
    }
}

async fn captured_output(
    program: &Path,
    args: &[String],
    deadline: std::time::Duration,
    label: &'static str,
) -> Result<(std::process::ExitStatus, Vec<u8>, Vec<u8>), MediaError> {
    let sidecar_slot = acquire_sidecar_slot()
        .await
        .map_err(MediaError::ResourceLimit)?;
    let mut child = sidecar_command(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let mut tree = match ChildTreeGuard::attach(&child) {
        Ok(tree) => tree,
        Err(error) => {
            stop_unattached_child(child, sidecar_slot).await;
            return Err(error);
        }
    };
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| MediaError::ProcessFailed("无法获取 stdout".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| MediaError::ProcessFailed("无法获取 stderr".into()))?;
    let work = async {
        let wait = async { child.wait().await.map_err(MediaError::Io) };
        let (status, stdout, stderr) =
            tokio::try_join!(wait, read_bounded(stdout), read_bounded(stderr))?;
        Ok::<_, MediaError>((status, stdout, stderr))
    };
    match tokio::time::timeout(deadline, work).await {
        Ok(Ok(output)) => {
            tree.disarm();
            Ok(output)
        }
        Ok(Err(error)) => {
            stop_child(child, tree, sidecar_slot).await;
            Err(error)
        }
        Err(_) => {
            stop_child(child, tree, sidecar_slot).await;
            Err(MediaError::Timeout(label))
        }
    }
}

/// 导出结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExportOutcome {
    Completed,
    Cancelled,
}

/// ffmpeg 只能写入的、由宿主在应用私有缓存中 `create_new` 创建的随机临时文件。
///
/// 未成功提交时（包括 task abort/panic）`Drop` 只清理这个临时路径，
/// 永远不删除最终用户路径。
#[derive(Debug)]
pub struct ExportTemp {
    path: PathBuf,
    file: Option<std::fs::File>,
}

impl ExportTemp {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn commit(mut self, destination: &Path) -> Result<(), MediaError> {
        let destination_parent = destination
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let canonical_destination_parent = std::fs::canonicalize(destination_parent)?;
        if !std::fs::metadata(&canonical_destination_parent)?.is_dir() {
            return Err(MediaError::Commit("导出目标父路径不是目录".into()));
        }
        let metadata = std::fs::symlink_metadata(&self.path)?;
        if !metadata.file_type().is_file() {
            return Err(MediaError::Commit(
                "导出临时路径已不是宿主创建的普通文件".into(),
            ));
        }
        let source = self
            .file
            .as_mut()
            .ok_or_else(|| MediaError::Commit("导出临时文件句柄已关闭".into()))?;
        source.sync_all()?;
        let source_metadata = source.metadata()?;
        if !source_metadata.is_file() {
            return Err(MediaError::Commit("导出临时文件句柄不是普通文件".into()));
        }
        if source_metadata.len() > MAX_EXPORT_BYTES {
            return Err(MediaError::OutputTooLarge("export file"));
        }
        source.seek(SeekFrom::Start(0))?;

        // 最终用户路径只通过这个独占 create_new 句柄写入。任何竞态中已出现的
        // 文件、symlink 或 reparse point 都会令 open 失败，绝不覆盖。
        let mut target = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)
            .map_err(|error| MediaError::Commit(format!("目标已存在或无法独占创建: {error}")))?;
        let copied = match std::io::copy(source, &mut target) {
            Ok(copied) => copied,
            Err(error) => {
                // 目标路径可能已被并发改名/替换；失败时保留已创建句柄对应的文件，
                // 不按可变的 destination 路径执行删除。
                return Err(MediaError::Commit(format!(
                    "写入最终文件失败，未自动删除可能的部分文件: {error}"
                )));
            }
        };
        if copied != source_metadata.len() {
            return Err(MediaError::Commit(
                "写入最终文件不完整，未自动删除可能的部分文件".into(),
            ));
        }
        target.flush()?;
        target.sync_all()?;
        Ok(())
    }
}

impl Drop for ExportTemp {
    fn drop(&mut self) {
        drop(self.file.take());
        let _ = std::fs::remove_file(&self.path);
    }
}

pub fn create_export_temp(
    private_temp_dir: &Path,
    destination: &Path,
    task_id: &str,
) -> Result<ExportTemp, MediaError> {
    if task_id.is_empty()
        || !task_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(MediaError::Commit("导出任务 id 不安全".into()));
    }
    std::fs::create_dir_all(private_temp_dir)?;
    let canonical_private_dir = std::fs::canonicalize(private_temp_dir)?;
    if !std::fs::metadata(&canonical_private_dir)?.is_dir() {
        return Err(MediaError::Commit("导出私有临时路径不是目录".into()));
    }

    for _ in 0..4 {
        let extension = destination
            .extension()
            .map(|value| format!(".{}", value.to_string_lossy()))
            .unwrap_or_default();
        let name = format!(
            ".useful-export-{task_id}-{}{extension}",
            uuid::Uuid::new_v4()
        );
        let path = canonical_private_dir.join(name);
        match OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => {
                return Ok(ExportTemp {
                    path,
                    file: Some(file),
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(MediaError::Io(error)),
        }
    }
    Err(MediaError::Commit("无法分配随机导出临时文件".into()))
}

/// 首发只支持无覆盖导出；已存在时自动追加序号。
pub fn resolve_output(desired: &Path) -> Result<PathBuf, MediaError> {
    if !desired.exists() {
        return Ok(desired.to_path_buf());
    }
    let stem = desired
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = desired.extension().map(|e| e.to_string_lossy().to_string());
    let parent = desired
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_default();
    for i in 1..10000 {
        let name = match &ext {
            Some(e) => format!("{stem} ({i}).{e}"),
            None => format!("{stem} ({i})"),
        };
        let candidate = parent.join(name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(MediaError::Commit("无法分配无覆盖导出文件名".into()))
}

/// 异步读取媒体元数据。
pub async fn probe(ffprobe: &Path, input: &Path) -> Result<MediaInfo, MediaError> {
    let args = build_ffprobe_args(input);
    let (status, stdout, stderr) =
        captured_output(ffprobe, &args, PROBE_DEADLINE, "ffprobe").await?;
    if !status.success() {
        return Err(MediaError::ProcessFailed(
            String::from_utf8_lossy(&stderr).to_string(),
        ));
    }
    MediaInfo::from_ffprobe_json(&stdout).map_err(|e| MediaError::Parse(e.to_string()))
}

/// 检测硬件编码器支持。
pub async fn detect_encoders(ffmpeg: &Path) -> Result<EncoderSupport, MediaError> {
    let args = build_list_encoders_args();
    let (status, stdout, stderr) = captured_output(
        ffmpeg,
        &args,
        ENCODER_DETECT_DEADLINE,
        "ffmpeg encoder detection",
    )
    .await?;
    if !status.success() {
        return Err(MediaError::ProcessFailed(
            String::from_utf8_lossy(&stderr).to_string(),
        ));
    }
    Ok(EncoderSupport::parse(&String::from_utf8_lossy(&stdout)))
}

/// 生成单帧缩略图 PNG。
pub async fn generate_thumbnail(
    ffmpeg: &Path,
    args: &[String],
    output: &Path,
) -> Result<(), MediaError> {
    let sidecar_slot = acquire_sidecar_slot()
        .await
        .map_err(MediaError::ResourceLimit)?;
    let mut child = sidecar_command(ffmpeg)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let mut tree = match ChildTreeGuard::attach(&child) {
        Ok(tree) => tree,
        Err(error) => {
            stop_unattached_child(child, sidecar_slot).await;
            return Err(error);
        }
    };
    let deadline = tokio::time::Instant::now() + THUMBNAIL_DEADLINE;
    let status = loop {
        if std::fs::metadata(output).is_ok_and(|metadata| metadata.len() > MAX_THUMBNAIL_BYTES) {
            stop_child(child, tree, sidecar_slot).await;
            let _ = std::fs::remove_file(output);
            return Err(MediaError::OutputTooLarge("thumbnail file"));
        }
        tokio::select! {
            biased;
            status = child.wait() => match status {
                Ok(status) => break status,
                Err(error) => {
                    stop_child(child, tree, sidecar_slot).await;
                    let _ = std::fs::remove_file(output);
                    return Err(MediaError::Io(error));
                }
            },
            _ = tokio::time::sleep_until(deadline) => {
                stop_child(child, tree, sidecar_slot).await;
                let _ = std::fs::remove_file(output);
                return Err(MediaError::Timeout("ffmpeg thumbnail"));
            },
            _ = tokio::time::sleep(PROCESS_POLL_INTERVAL) => {}
        }
    };
    tree.disarm();
    if status.success() {
        let size = std::fs::metadata(output)?.len();
        if size <= MAX_THUMBNAIL_BYTES {
            Ok(())
        } else {
            let _ = std::fs::remove_file(output);
            Err(MediaError::OutputTooLarge("thumbnail file"))
        }
    } else {
        let _ = std::fs::remove_file(output);
        Err(MediaError::ProcessFailed("缩略图生成失败".into()))
    }
}

/// 运行导出，逐条进度回调，支持取消。
///
/// `on_progress` 收到每次进度更新；`cancel` 置位后会终止 ffmpeg 子进程。
pub async fn run_export<F>(
    ffmpeg: &Path,
    input: &Path,
    output: &Path,
    spec: &ExportSpec,
    cancel: Arc<AtomicBool>,
    mut on_progress: F,
) -> Result<ExportOutcome, MediaError>
where
    F: FnMut(ProgressUpdate),
{
    let sidecar_slot = acquire_sidecar_slot()
        .await
        .map_err(MediaError::ResourceLimit)?;
    if cancel.load(Ordering::SeqCst) {
        let _ = std::fs::remove_file(output);
        return Ok(ExportOutcome::Cancelled);
    }
    let args = build_ffmpeg_args(input, output, spec);
    let mut child = sidecar_command(ffmpeg)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let mut tree = match ChildTreeGuard::attach(&child) {
        Ok(tree) => tree,
        Err(error) => {
            stop_unattached_child(child, sidecar_slot).await;
            return Err(error);
        }
    };

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| MediaError::ProcessFailed("无法获取 ffmpeg stdout".into()))?;
    let mut reader = BoundedProgressReader::new(BufReader::new(stdout));
    let mut parser = ProgressParser::new();
    let deadline = tokio::time::Instant::now() + EXPORT_DEADLINE;

    loop {
        // 取消检查
        if cancel.load(Ordering::SeqCst) {
            stop_child(child, tree, sidecar_slot).await;
            let _ = std::fs::remove_file(output);
            return Ok(ExportOutcome::Cancelled);
        }

        if std::fs::metadata(output).is_ok_and(|metadata| metadata.len() > MAX_EXPORT_BYTES) {
            stop_child(child, tree, sidecar_slot).await;
            let _ = std::fs::remove_file(output);
            return Err(MediaError::OutputTooLarge("export file"));
        }

        // 带超时读取一行，以便定期检查取消标志
        let line = tokio::select! {
            biased;
            _ = tokio::time::sleep_until(deadline) => {
                stop_child(child, tree, sidecar_slot).await;
                let _ = std::fs::remove_file(output);
                return Err(MediaError::Timeout("ffmpeg export"));
            }
            l = reader.next_line() => match l {
                Ok(line) => line,
                Err(error) => {
                    stop_child(child, tree, sidecar_slot).await;
                    let _ = std::fs::remove_file(output);
                    return Err(error);
                }
            },
            _ = tokio::time::sleep(PROCESS_POLL_INTERVAL) => {
                continue;
            }
        };
        match line {
            Some(text) => {
                if let Some(update) = parser.push_line(&text) {
                    on_progress(update);
                }
            }
            None => break, // stdout 结束
        }
    }

    let status = loop {
        if cancel.load(Ordering::SeqCst) {
            stop_child(child, tree, sidecar_slot).await;
            let _ = std::fs::remove_file(output);
            return Ok(ExportOutcome::Cancelled);
        }
        if std::fs::metadata(output).is_ok_and(|metadata| metadata.len() > MAX_EXPORT_BYTES) {
            stop_child(child, tree, sidecar_slot).await;
            let _ = std::fs::remove_file(output);
            return Err(MediaError::OutputTooLarge("export file"));
        }
        tokio::select! {
            biased;
            status = child.wait() => match status {
                Ok(status) => break status,
                Err(error) => {
                    stop_child(child, tree, sidecar_slot).await;
                    let _ = std::fs::remove_file(output);
                    return Err(MediaError::Io(error));
                }
            },
            _ = tokio::time::sleep_until(deadline) => {
                stop_child(child, tree, sidecar_slot).await;
                let _ = std::fs::remove_file(output);
                return Err(MediaError::Timeout("ffmpeg export"));
            },
            _ = tokio::time::sleep(PROCESS_POLL_INTERVAL) => {}
        }
    };
    tree.disarm();
    if cancel.load(Ordering::SeqCst) {
        let _ = std::fs::remove_file(output);
        return Ok(ExportOutcome::Cancelled);
    }
    if status.success() {
        match std::fs::metadata(output) {
            Ok(metadata) if metadata.len() <= MAX_EXPORT_BYTES => Ok(ExportOutcome::Completed),
            Ok(_) => {
                let _ = std::fs::remove_file(output);
                Err(MediaError::OutputTooLarge("export file"))
            }
            Err(error) => {
                let _ = std::fs::remove_file(output);
                Err(MediaError::Io(error))
            }
        }
    } else {
        let _ = std::fs::remove_file(output);
        Err(MediaError::ProcessFailed(format!(
            "ffmpeg 退出码 {:?}",
            status.code()
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_rename_avoids_conflict() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("out.mp4");
        std::fs::write(&f, b"x").unwrap();
        let resolved = resolve_output(&f).unwrap();
        assert_ne!(resolved, f);
        assert!(resolved.to_string_lossy().contains("out (1).mp4"));
    }

    #[test]
    fn resolve_nonexistent_returns_same() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("new.mp4");
        assert_eq!(resolve_output(&f).unwrap(), f);
    }

    #[test]
    fn media_resource_limits_are_finite_and_keep_long_exports_reasonable() {
        assert!(PROBE_DEADLINE < THUMBNAIL_DEADLINE);
        assert!(EXPORT_DEADLINE >= std::time::Duration::from_secs(12 * 60 * 60));
        assert_eq!(MAX_CAPTURE_BYTES, 2 * 1024 * 1024);
        assert_eq!(MAX_PROGRESS_LINE_BYTES, 64 * 1024);
        assert_eq!(MAX_THUMBNAIL_BYTES, 32 * 1024 * 1024);
    }

    #[tokio::test]
    async fn captured_stream_rejects_more_than_the_bounded_limit() {
        let bytes = vec![0u8; MAX_CAPTURE_BYTES + 1];
        assert!(matches!(
            read_bounded(bytes.as_slice()).await,
            Err(MediaError::OutputTooLarge("stdout/stderr"))
        ));
    }

    #[tokio::test]
    async fn progress_reader_rejects_an_unbounded_line() {
        let bytes = vec![b'x'; MAX_PROGRESS_LINE_BYTES + 1];
        let mut reader = BoundedProgressReader::new(BufReader::new(bytes.as_slice()));
        assert!(matches!(
            reader.next_line().await,
            Err(MediaError::OutputTooLarge("ffmpeg progress line"))
        ));
    }

    #[tokio::test]
    async fn progress_reader_preserves_partial_bytes_across_reads() {
        let mut reader = BoundedProgressReader::new(BufReader::with_capacity(
            3,
            b"out_time_ms=123\nprogress=continue\n".as_slice(),
        ));
        assert_eq!(
            reader.next_line().await.unwrap(),
            Some("out_time_ms=123".into())
        );
        assert_eq!(
            reader.next_line().await.unwrap(),
            Some("progress=continue".into())
        );
    }

    #[test]
    fn commit_is_no_clobber() {
        let directory = tempfile::tempdir().unwrap();
        let private = tempfile::tempdir().unwrap();
        let destination = directory.path().join("out.mp4");
        std::fs::write(&destination, b"existing").unwrap();
        let temp = create_export_temp(private.path(), &destination, "task-1").unwrap();
        std::fs::write(temp.path(), b"new").unwrap();
        assert!(matches!(
            temp.commit(&destination),
            Err(MediaError::Commit(_))
        ));
        assert_eq!(std::fs::read(&destination).unwrap(), b"existing");
    }

    #[test]
    fn commit_streams_from_private_temp_into_exclusive_target() {
        let directory = tempfile::tempdir().unwrap();
        let private = tempfile::tempdir().unwrap();
        let destination = directory.path().join("out.mp4");
        let temp = create_export_temp(private.path(), &destination, "task-2").unwrap();
        let temp_path = temp.path().to_path_buf();
        let canonical_private = std::fs::canonicalize(private.path()).unwrap();
        assert!(temp_path.starts_with(&canonical_private));
        std::fs::write(&temp_path, b"new").unwrap();
        temp.commit(&destination).unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), b"new");
        assert!(!temp_path.exists());
    }

    #[tokio::test]
    async fn probe_missing_sidecar_errors() {
        // 不存在的 ffprobe 路径应返回 IO 错误而非 panic
        let r = probe(Path::new("useful-no-ffprobe-xyz"), Path::new("x.mp4")).await;
        assert!(r.is_err());
    }
}
