//! mpv sidecar 控制：启动参数（--wid 嵌入、--hwdec、IPC 命名管道）与 JSON IPC 命令序列化。
//!
//! 实际的命名管道连接在应用层（Windows 专有）实现；本模块保持协议与参数为纯逻辑，便于测试。

use serde::Serialize;
use std::path::Path;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

/// mpv 硬件解码模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecodeMode {
    /// --hwdec=auto-safe
    HardwareAutoSafe,
    /// 降级软件解码 --hwdec=no
    Software,
}

/// 构建 mpv 启动参数。
///
/// - `wid`: 原生子窗口 HWND（作为字符串），mpv 通过 `--wid` 嵌入其中。
/// - `ipc_pipe`: JSON IPC 命名管道名（Windows: `\\.\pipe\xxx`）。
/// - `file`: 初始载入的媒体文件（可为 None，稍后 loadfile）。
pub fn build_mpv_args(
    wid: &str,
    ipc_pipe: &str,
    file: Option<&Path>,
    decode: DecodeMode,
) -> Vec<String> {
    let mut args = vec![
        format!("--wid={wid}"),
        format!("--input-ipc-server={ipc_pipe}"),
        match decode {
            DecodeMode::HardwareAutoSafe => "--hwdec=auto-safe".to_string(),
            DecodeMode::Software => "--hwdec=no".to_string(),
        },
        // 预览用途：不读用户配置、保持暂停在首帧、关闭 OSC 以免干扰
        "--no-config".into(),
        "--no-terminal".into(),
        "--idle=yes".into(),
        "--force-window=yes".into(),
        "--keep-open=yes".into(),
        "--pause".into(),
        "--osc=no".into(),
        "--input-default-bindings=no".into(),
        "--input-vo-keyboard=no".into(),
    ];
    if let Some(f) = file {
        args.push(f.to_string_lossy().to_string());
    }
    args
}

/// mpv JSON IPC 命令。序列化为一行 JSON（末尾需追加换行由发送方处理）。
#[derive(Debug, Clone, Serialize)]
pub struct IpcCommand {
    pub command: Vec<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<u64>,
}

impl IpcCommand {
    fn new(parts: Vec<serde_json::Value>) -> Self {
        Self {
            command: parts,
            request_id: None,
        }
    }

    /// 载入文件。
    pub fn load_file(path: &str) -> Self {
        let mut cmd = Self::new(vec!["loadfile".into(), path.into()]);
        cmd.request_id = Some(10);
        cmd
    }

    /// 播放/暂停。
    pub fn set_pause(paused: bool) -> Self {
        Self::new(vec![
            "set_property".into(),
            "pause".into(),
            serde_json::Value::Bool(paused),
        ])
    }

    /// 绝对定位（秒）。
    pub fn seek_absolute(sec: f64) -> Self {
        Self::new(vec![
            "seek".into(),
            sec.to_string().into(),
            "absolute".into(),
        ])
    }

    /// 设置 A-B 循环区间（预览选中区间）。
    pub fn set_ab_loop(start: f64, end: f64) -> Vec<Self> {
        vec![
            Self::new(vec![
                "set_property".into(),
                "ab-loop-a".into(),
                start.to_string().into(),
            ]),
            Self::new(vec![
                "set_property".into(),
                "ab-loop-b".into(),
                end.to_string().into(),
            ]),
        ]
    }

    /// 查询当前播放位置。
    pub fn get_time_pos() -> Self {
        Self::new(vec!["get_property".into(), "time-pos".into()])
    }

    /// 订阅属性变化（property-change 事件流）。
    pub fn observe_property(observe_id: u64, name: &str) -> Self {
        Self::new(vec![
            "observe_property".into(),
            serde_json::Value::from(observe_id),
            name.into(),
        ])
    }

    /// 序列化为一行 JSON（不含换行）。
    pub fn to_line(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{\"command\":[]}".to_string())
    }
}

/// mpv 文件加载的终态。`end-file` 在加载阶段通常携带明确失败原因。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoadEvent {
    Loaded,
    Failed(String),
}

/// 解析 mpv 的 `file-loaded` / `end-file` 事件。
pub fn parse_load_event(line: &str) -> Option<LoadEvent> {
    let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    match v.get("event")?.as_str()? {
        "file-loaded" => Some(LoadEvent::Loaded),
        "end-file" => {
            let reason = v
                .get("reason")
                .and_then(|x| x.as_str())
                .unwrap_or("unknown");
            let error = v.get("file_error").and_then(|x| x.as_str());
            Some(LoadEvent::Failed(match error {
                Some(error) => format!("mpv 无法加载媒体: {reason} ({error})"),
                None => format!("mpv 未加载媒体: {reason}"),
            }))
        }
        _ => None,
    }
}

#[derive(Debug, Clone, Default)]
enum LoadState {
    #[default]
    Idle,
    Loading,
    Loaded,
    Failed(String),
}

/// 跨线程等待 mpv 的实际加载事件，避免把“命令已写入管道”误报为可预览。
#[derive(Debug, Default)]
pub struct LoadMonitor {
    state: Mutex<LoadState>,
    changed: Condvar,
}

impl LoadMonitor {
    pub fn begin(&self) {
        if let Ok(mut state) = self.state.lock() {
            *state = LoadState::Loading;
        }
    }

    pub fn update(&self, event: LoadEvent) {
        if let Ok(mut state) = self.state.lock() {
            *state = match event {
                LoadEvent::Loaded => LoadState::Loaded,
                LoadEvent::Failed(message) => LoadState::Failed(message),
            };
            self.changed.notify_all();
        }
    }

    pub fn wait(&self, timeout: Duration) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "锁定 mpv 加载状态失败".to_string())?;
        loop {
            match &*state {
                LoadState::Loaded => return Ok(()),
                LoadState::Failed(message) => return Err(message.clone()),
                LoadState::Idle => return Err("mpv 未收到加载请求".into()),
                LoadState::Loading => {}
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("等待 mpv file-loaded 超时；文件可能需要代理预览或已损坏".into());
            }
            let (next, result) = self
                .changed
                .wait_timeout(state, remaining)
                .map_err(|_| "等待 mpv 加载状态失败".to_string())?;
            state = next;
            if result.timed_out() && matches!(*state, LoadState::Loading) {
                return Err("等待 mpv file-loaded 超时；文件可能需要代理预览或已损坏".into());
            }
        }
    }
}

/// mpv IPC 事件中的属性变化。
#[derive(Debug, Clone, PartialEq)]
pub struct PropertyChange {
    pub name: String,
    pub value: Option<f64>,
}

/// 解析 mpv IPC 事件行；只关心 property-change，其余返回 None。
pub fn parse_property_change(line: &str) -> Option<PropertyChange> {
    let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    if v.get("event")?.as_str()? != "property-change" {
        return None;
    }
    let name = v.get("name")?.as_str()?.to_string();
    let value = v.get("data").and_then(|d| d.as_f64());
    Some(PropertyChange { name, value })
}

/// 持续丢帧检测：基于 mpv `frame-drop-count` 累计值。
/// 连续 `threshold_windows` 个采样窗口内每窗口新增丢帧超过 `drops_per_window`
/// 时触发一次“建议生成代理预览”（触发后不重复提示）。
#[derive(Debug)]
pub struct FrameDropDetector {
    last_count: Option<f64>,
    consecutive: u32,
    threshold_windows: u32,
    drops_per_window: f64,
    triggered: bool,
}

impl FrameDropDetector {
    pub fn new(threshold_windows: u32, drops_per_window: f64) -> Self {
        Self {
            last_count: None,
            consecutive: 0,
            threshold_windows,
            drops_per_window,
            triggered: false,
        }
    }

    /// 默认策略：连续 3 个窗口、每窗口丢帧 > 5。
    pub fn default_policy() -> Self {
        Self::new(3, 5.0)
    }

    /// 输入最新的累计丢帧数；返回是否应提示生成代理预览（仅首次触发返回 true）。
    pub fn push(&mut self, cumulative_drops: f64) -> bool {
        let delta = match self.last_count {
            Some(prev) => (cumulative_drops - prev).max(0.0),
            None => 0.0,
        };
        self.last_count = Some(cumulative_drops);
        if delta > self.drops_per_window {
            self.consecutive += 1;
        } else {
            self.consecutive = 0;
        }
        if !self.triggered && self.consecutive >= self.threshold_windows {
            self.triggered = true;
            return true;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mpv_args_embed_and_hwdec() {
        let args = build_mpv_args(
            "12345",
            r"\\.\pipe\useful-mpv",
            Some(Path::new(r"D:\视频 素材\a.mp4")),
            DecodeMode::HardwareAutoSafe,
        );
        assert!(args.contains(&"--wid=12345".to_string()));
        assert!(args.contains(&"--hwdec=auto-safe".to_string()));
        assert!(args.iter().any(|a| a.starts_with("--input-ipc-server=")));
        assert!(args.iter().any(|a| a.contains("视频 素材")));
    }

    #[test]
    fn software_fallback() {
        let args = build_mpv_args("1", "p", None, DecodeMode::Software);
        assert!(args.contains(&"--hwdec=no".to_string()));
        // 无文件时不追加空参数
        assert!(!args.iter().any(|a| a.is_empty()));
    }

    #[test]
    fn ipc_command_serialization() {
        assert_eq!(
            IpcCommand::set_pause(true).to_line(),
            r#"{"command":["set_property","pause",true]}"#
        );
        assert_eq!(
            IpcCommand::load_file("a.mp4").to_line(),
            r#"{"command":["loadfile","a.mp4"],"request_id":10}"#
        );
        let seek = IpcCommand::seek_absolute(12.5).to_line();
        assert!(seek.contains("seek"));
        assert!(seek.contains("absolute"));
        let ab = IpcCommand::set_ab_loop(1.0, 5.0);
        assert_eq!(ab.len(), 2);
        assert!(ab[0].to_line().contains("ab-loop-a"));
        assert!(ab[1].to_line().contains("ab-loop-b"));
        assert_eq!(
            IpcCommand::observe_property(1, "time-pos").to_line(),
            r#"{"command":["observe_property",1,"time-pos"]}"#
        );
    }

    #[test]
    fn parses_load_success_and_failure_events() {
        assert_eq!(
            parse_load_event(r#"{"event":"file-loaded"}"#),
            Some(LoadEvent::Loaded)
        );
        assert_eq!(
            parse_load_event(
                r#"{"event":"end-file","reason":"error","file_error":"unsupported format"}"#
            ),
            Some(LoadEvent::Failed(
                "mpv 无法加载媒体: error (unsupported format)".into()
            ))
        );
        assert!(parse_load_event(r#"{"event":"start-file"}"#).is_none());
    }

    #[test]
    fn load_monitor_reports_backend_outcome() {
        let monitor = LoadMonitor::default();
        monitor.begin();
        monitor.update(LoadEvent::Loaded);
        assert!(monitor.wait(Duration::from_millis(1)).is_ok());

        monitor.begin();
        monitor.update(LoadEvent::Failed("bad media".into()));
        assert_eq!(
            monitor.wait(Duration::from_millis(1)),
            Err("bad media".into())
        );

        monitor.begin();
        assert!(monitor
            .wait(Duration::from_millis(1))
            .unwrap_err()
            .contains("file-loaded 超时"));
    }

    #[test]
    fn parses_property_change_events() {
        let ev = parse_property_change(
            r#"{"event":"property-change","id":1,"name":"time-pos","data":12.34}"#,
        )
        .unwrap();
        assert_eq!(ev.name, "time-pos");
        assert_eq!(ev.value, Some(12.34));
        // data 缺失（如未播放）时 value 为 None
        let ev = parse_property_change(r#"{"event":"property-change","id":1,"name":"time-pos"}"#)
            .unwrap();
        assert_eq!(ev.value, None);
        // 非 property-change 事件返回 None
        assert!(parse_property_change(r#"{"event":"file-loaded"}"#).is_none());
        assert!(parse_property_change("not json").is_none());
    }

    #[test]
    fn frame_drop_detector_triggers_once_on_sustained_drops() {
        let mut d = FrameDropDetector::new(3, 5.0);
        // 稳定播放：不触发
        assert!(!d.push(0.0));
        assert!(!d.push(1.0));
        assert!(!d.push(2.0));
        // 持续丢帧：每窗口 +10
        assert!(!d.push(12.0));
        assert!(!d.push(22.0));
        assert!(d.push(32.0)); // 第三个连续窗口触发
                               // 不重复触发
        assert!(!d.push(42.0));
    }

    #[test]
    fn frame_drop_detector_resets_on_stable_window() {
        let mut d = FrameDropDetector::new(2, 5.0);
        assert!(!d.push(0.0));
        assert!(!d.push(10.0)); // 窗口1超阈
        assert!(!d.push(11.0)); // 稳定，计数归零
        assert!(!d.push(21.0)); // 窗口1超阈
        assert!(d.push(31.0)); // 窗口2超阈 -> 触发
    }
}
