//! mpv 预览宿主（Windows）：创建原生子窗口，启动 mpv sidecar 并通过 `--wid` 嵌入，
//! 经 JSON IPC 命名管道控制。找不到 mpv 或创建失败时安全降级（不崩溃）。

use std::ffi::c_void;
use std::io::Write;
use std::path::Path;
use std::process::Child;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use useful_media::limits::{
    try_acquire_sidecar_slot, WindowsSidecarJob, CHILD_REAP_DEADLINE, PROCESS_POLL_INTERVAL,
};
use useful_media::mpv::{build_mpv_args, DecodeMode, IpcCommand, LoadMonitor};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, MoveWindow, RegisterClassW, ShowWindow,
    CW_USEDEFAULT, HMENU, SW_SHOW, WINDOW_EX_STYLE, WNDCLASSW, WS_CHILD, WS_CLIPCHILDREN,
    WS_VISIBLE,
};

const CLASS_NAME: &[u16] = &[
    b'T' as u16,
    b'b' as u16,
    b'x' as u16,
    b'M' as u16,
    b'p' as u16,
    b'v' as u16,
    0,
];

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    unsafe { DefWindowProcW(hwnd, msg, wp, lp) }
}

/// 注册窗口类（只注册一次）。
fn ensure_class() -> Result<(), String> {
    static REGISTERED: OnceLock<bool> = OnceLock::new();
    let mut err: Option<String> = None;
    let registered = *REGISTERED.get_or_init(|| unsafe {
        let hinst = match GetModuleHandleW(PCWSTR::null()) {
            Ok(h) => h,
            Err(e) => {
                err = Some(format!("GetModuleHandleW: {e}"));
                return false;
            }
        };
        let wc = WNDCLASSW {
            lpfnWndProc: Some(wndproc),
            hInstance: hinst.into(),
            lpszClassName: PCWSTR(CLASS_NAME.as_ptr()),
            ..Default::default()
        };
        let atom = RegisterClassW(&wc);
        if atom == 0 {
            err = Some("RegisterClassW 失败".into());
            return false;
        }
        true
    });
    match err {
        Some(e) => Err(e),
        None if registered => Ok(()),
        None => Err("mpv 预览窗口类此前注册失败；请重启 Useful 后重试".into()),
    }
}

/// mpv 预览宿主。
pub struct MpvHost {
    child_hwnd: HWND,
    process: Option<Child>,
    process_tree: Option<WindowsSidecarJob>,
    sidecar_slot: Option<tokio::sync::OwnedSemaphorePermit>,
    pipe_name: String,
    load_monitor: Arc<LoadMonitor>,
}

// HWND 为原生句柄，仅在主线程/命令内使用；用 Mutex 保护于 State 中。
unsafe impl Send for MpvHost {}

impl MpvHost {
    /// 在父窗口内创建子窗口并启动 mpv 嵌入。
    pub fn start(
        parent_hwnd: isize,
        mpv_path: &Path,
        rect: (i32, i32, i32, i32),
        software: bool,
    ) -> Result<MpvHost, String> {
        let sidecar_slot = try_acquire_sidecar_slot().map_err(|error| error.to_string())?;
        ensure_class()?;
        let (x, y, w, h) = rect;
        let child = unsafe {
            let hinst =
                GetModuleHandleW(PCWSTR::null()).map_err(|e| format!("GetModuleHandleW: {e}"))?;
            let parent = HWND(parent_hwnd as *mut c_void);
            let title = wide("mpv-preview");
            let hwnd = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                PCWSTR(CLASS_NAME.as_ptr()),
                PCWSTR(title.as_ptr()),
                WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN,
                if x == 0 { CW_USEDEFAULT } else { x },
                y,
                w.max(1),
                h.max(1),
                Some(parent),
                None::<HMENU>,
                Some(hinst.into()),
                None,
            )
            .map_err(|e| format!("CreateWindowExW: {e}"))?;
            let _ = ShowWindow(hwnd, SW_SHOW);
            hwnd
        };

        // 唯一 IPC 管道名
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let pipe_name = format!(r"\\.\pipe\useful-mpv-{ts}");

        let wid = format!("{}", child_hwnd_as_usize(child));
        let decode = if software {
            DecodeMode::Software
        } else {
            DecodeMode::HardwareAutoSafe
        };
        let args = build_mpv_args(&wid, &pipe_name, None, decode);

        let mut process = std::process::Command::new(mpv_path)
            .args(&args)
            .spawn()
            .map_err(|e| {
                // 启动失败：销毁子窗口
                unsafe {
                    let _ = DestroyWindow(child);
                }
                format!("启动 mpv 失败: {e}")
            })?;
        let process_tree = match WindowsSidecarJob::attach_std(&process) {
            Ok(process_tree) => process_tree,
            Err(error) => {
                kill_and_reap(process, None, sidecar_slot);
                unsafe {
                    let _ = DestroyWindow(child);
                }
                return Err(error);
            }
        };

        // 启动成功不等于后端健康：等待 IPC 管道出现，同时监控进程是否提前退出。
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match process.try_wait() {
                Ok(Some(status)) => {
                    unsafe {
                        let _ = DestroyWindow(child);
                    }
                    return Err(format!("mpv 在 IPC 就绪前退出: {status}"));
                }
                Ok(None) => {}
                Err(error) => {
                    kill_and_reap(process, Some(process_tree), sidecar_slot);
                    unsafe {
                        let _ = DestroyWindow(child);
                    }
                    return Err(format!("检查 mpv 进程失败: {error}"));
                }
            }
            match std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&pipe_name)
            {
                Ok(_) => break,
                Err(_) if Instant::now() < deadline => {
                    std::thread::sleep(PROCESS_POLL_INTERVAL);
                }
                Err(e) => {
                    kill_and_reap(process, Some(process_tree), sidecar_slot);
                    unsafe {
                        let _ = DestroyWindow(child);
                    }
                    return Err(format!("mpv IPC 管道未在 5 秒内就绪: {e}"));
                }
            }
        }

        Ok(MpvHost {
            child_hwnd: child,
            process: Some(process),
            process_tree: Some(process_tree),
            sidecar_slot: Some(sidecar_slot),
            pipe_name,
            load_monitor: Arc::new(LoadMonitor::default()),
        })
    }

    /// 更新子窗口位置与大小（跟随前端预览区域）。
    pub fn set_rect(&self, x: i32, y: i32, w: i32, h: i32) {
        unsafe {
            let _ = MoveWindow(self.child_hwnd, x, y, w.max(1), h.max(1), true);
        }
    }

    /// IPC 管道名（供事件读取线程连接）。
    pub fn pipe_name(&self) -> &str {
        &self.pipe_name
    }

    pub fn load_monitor(&self) -> Arc<LoadMonitor> {
        self.load_monitor.clone()
    }

    pub fn begin_load(&self) {
        self.load_monitor.begin();
    }

    pub fn wait_for_load(&self, timeout: Duration) -> Result<(), String> {
        self.load_monitor.wait(timeout)
    }

    /// 通过 IPC 发送一条命令（打开命名管道写入一行 JSON）。
    pub fn send(&self, cmd: &IpcCommand) -> Result<(), String> {
        // mpv 命名管道可作为文件打开写入
        let mut line = cmd.to_line();
        line.push('\n');
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .open(&self.pipe_name)
            .map_err(|e| format!("打开 mpv IPC 管道失败: {e}"))?;
        file.write_all(line.as_bytes())
            .map_err(|e| format!("写入 mpv IPC 失败: {e}"))?;
        Ok(())
    }

    /// 停止 mpv 并销毁子窗口。
    pub fn stop(&mut self) {
        if let Some(process) = self.process.take() {
            if let Some(permit) = self.sidecar_slot.take() {
                kill_and_reap(process, self.process_tree.take(), permit);
            }
        }
        unsafe {
            let _ = DestroyWindow(self.child_hwnd);
        }
    }
}

struct MpvReapJob {
    process: Child,
    process_tree: Option<WindowsSidecarJob>,
    _permit: tokio::sync::OwnedSemaphorePermit,
}

fn poll_mpv_reap(job: &mut MpvReapJob) -> bool {
    if let Some(process_tree) = job.process_tree.as_ref() {
        process_tree.terminate();
    }
    let _ = job.process.kill();
    matches!(job.process.try_wait(), Ok(Some(_)))
}

fn run_mpv_reaper(receiver: std::sync::mpsc::Receiver<MpvReapJob>) {
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
            if poll_mpv_reap(&mut jobs[index]) {
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

fn mpv_reaper_sender() -> Option<&'static std::sync::mpsc::Sender<MpvReapJob>> {
    static REAPER: OnceLock<Option<std::sync::mpsc::Sender<MpvReapJob>>> = OnceLock::new();
    REAPER
        .get_or_init(|| {
            let (sender, receiver) = std::sync::mpsc::channel();
            std::thread::Builder::new()
                .name("useful-mpv-reaper".into())
                .spawn(move || run_mpv_reaper(receiver))
                .ok()
                .map(|_| sender)
        })
        .as_ref()
}

fn handoff_mpv_reaper(job: MpvReapJob) {
    if let Some(sender) = mpv_reaper_sender() {
        match sender.send(job) {
            Ok(()) => return,
            Err(error) => {
                let mut job = error.0;
                while !poll_mpv_reap(&mut job) {
                    std::thread::sleep(PROCESS_POLL_INTERVAL);
                }
                return;
            }
        }
    }
    let mut job = job;
    while !poll_mpv_reap(&mut job) {
        std::thread::sleep(PROCESS_POLL_INTERVAL);
    }
}

fn kill_and_reap(
    mut process: Child,
    process_tree: Option<WindowsSidecarJob>,
    permit: tokio::sync::OwnedSemaphorePermit,
) {
    if let Some(process_tree) = process_tree.as_ref() {
        process_tree.terminate();
    }
    let _ = process.kill();
    let deadline = Instant::now() + CHILD_REAP_DEADLINE;
    loop {
        match process.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(PROCESS_POLL_INTERVAL);
            }
            Ok(None) | Err(_) => {
                handoff_mpv_reaper(MpvReapJob {
                    process,
                    process_tree,
                    _permit: permit,
                });
                return;
            }
        }
    }
}

impl Drop for MpvHost {
    fn drop(&mut self) {
        self.stop();
    }
}

fn child_hwnd_as_usize(hwnd: HWND) -> usize {
    hwnd.0 as usize
}
