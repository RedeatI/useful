//! 网络采集：Microsoft-Windows-Kernel-Network ETW 实时会话。
//!
//! - ETW 会话只创建一次；后台消费线程解析事件，按 PID 聚合每秒收发字节。
//! - 无权限 / 启动失败时标记「不可用」，绝不阻塞基础采样，也不崩溃。
//! - 应用退出时停止会话并合上消费线程。

use crate::model::Capability;
use std::collections::HashMap;
#[cfg(any(windows, test))]
use std::time::Duration;
use std::time::Instant;

/// 每 PID 网络速率（字节/秒）。
#[derive(Debug, Clone, Copy, Default)]
pub struct NetUsage {
    pub up: u64,
    pub down: u64,
}

/// 网络采集器。内部持有 ETW 会话与共享累计计数。
pub struct NetCollector {
    #[cfg(windows)]
    inner: Option<win::EtwNet>,
    capability: Capability,
    sampled_at: Instant,
}

impl Default for NetCollector {
    fn default() -> Self {
        Self::new()
    }
}

impl NetCollector {
    pub fn new() -> Self {
        #[cfg(windows)]
        {
            match win::EtwNet::start() {
                Ok(inner) => NetCollector {
                    inner: Some(inner),
                    capability: Capability::available(),
                    sampled_at: Instant::now(),
                },
                Err(capability) => {
                    tracing::warn!(reason_code = ?capability.reason_code, "ETW 网络会话启动失败；每进程字节不可用");
                    NetCollector {
                        inner: None,
                        capability,
                        sampled_at: Instant::now(),
                    }
                }
            }
        }
        #[cfg(not(windows))]
        {
            NetCollector {
                capability: Capability::unavailable(
                    "platform_unsupported",
                    "当前平台不提供 Windows ETW 每进程网络字节；基本进程监控仍可使用。",
                ),
                sampled_at: Instant::now(),
            }
        }
    }

    pub fn is_available(&self) -> bool {
        self.capability.available
    }

    pub fn capability(&self) -> Capability {
        self.capability.clone()
    }

    /// 显式禁用（不启动 ETW 会话），用于测试与无 Windows 环境。
    pub fn disabled() -> Self {
        #[cfg(windows)]
        {
            NetCollector {
                inner: None,
                capability: Capability::unavailable(
                    "disabled",
                    "ETW 采集器已禁用；基本进程监控仍可使用。",
                ),
                sampled_at: Instant::now(),
            }
        }
        #[cfg(not(windows))]
        {
            NetCollector {
                capability: Capability::unavailable(
                    "platform_unsupported",
                    "当前平台不提供 Windows ETW 每进程网络字节；基本进程监控仍可使用。",
                ),
                sampled_at: Instant::now(),
            }
        }
    }

    /// 读取并清零累计字节，使用 monotonic elapsed 换算为字节/秒。
    pub fn sample(&mut self) -> HashMap<u32, NetUsage> {
        let now = Instant::now();
        #[cfg(windows)]
        let elapsed = now.saturating_duration_since(self.sampled_at).as_secs_f64();
        self.sampled_at = now;
        #[cfg(windows)]
        {
            if let Some(inner) = self.inner.as_ref() {
                return rates_for_elapsed(inner.take(), Duration::from_secs_f64(elapsed));
            }
        }
        HashMap::new()
    }

    /// Drain accumulated ETW events and restart the elapsed clock at pause/resume boundaries.
    pub fn reset(&mut self) {
        #[cfg(windows)]
        if let Some(inner) = self.inner.as_ref() {
            let _ = inner.take();
        }
        self.sampled_at = Instant::now();
    }
}

#[cfg(any(windows, test))]
fn rates_for_elapsed(
    mut usage: HashMap<u32, NetUsage>,
    elapsed: Duration,
) -> HashMap<u32, NetUsage> {
    let seconds = elapsed.as_secs_f64();
    if seconds <= 0.0 {
        usage.clear();
        return usage;
    }
    for value in usage.values_mut() {
        value.up = ((value.up as f64 / seconds)
            .round()
            .clamp(0.0, u64::MAX as f64)) as u64;
        value.down = ((value.down as f64 / seconds)
            .round()
            .clamp(0.0, u64::MAX as f64)) as u64;
    }
    usage
}

#[cfg(windows)]
mod win {
    use super::NetUsage;
    use crate::model::Capability;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};
    use windows::core::{GUID, PCWSTR};
    use windows::Win32::Foundation::{GetLastError, WIN32_ERROR};
    use windows::Win32::System::Diagnostics::Etw::{
        CloseTrace, ControlTraceW, EnableTraceEx2, OpenTraceW, ProcessTrace, StartTraceW,
        CONTROLTRACE_HANDLE, ENABLE_TRACE_PARAMETERS, EVENT_CONTROL_CODE_ENABLE_PROVIDER,
        EVENT_RECORD, EVENT_TRACE_CONTROL_STOP, EVENT_TRACE_LOGFILEW, EVENT_TRACE_PROPERTIES,
        EVENT_TRACE_REAL_TIME_MODE, PROCESSTRACE_HANDLE, PROCESS_TRACE_MODE_EVENT_RECORD,
        PROCESS_TRACE_MODE_REAL_TIME, TRACE_LEVEL_INFORMATION, WNODE_FLAG_TRACED_GUID,
    };

    // Microsoft-Windows-Kernel-Network: {7DD42A49-5329-4832-8DFD-43D979153A88}
    const KERNEL_NETWORK_GUID: GUID = GUID::from_u128(0x7DD42A49_5329_4832_8DFD_43D979153A88);
    const ERROR_SUCCESS: u32 = 0;

    // 事件 ID：数据发送/接收（IPv4 与 IPv6）
    const EVT_TCP_SEND_V4: u16 = 10;
    const EVT_TCP_RECV_V4: u16 = 11;
    const EVT_TCP_SEND_V6: u16 = 26;
    const EVT_TCP_RECV_V6: u16 = 27;
    const EVT_UDP_SEND_V4: u16 = 42;
    const EVT_UDP_RECV_V4: u16 = 43;
    const EVT_UDP_SEND_V6: u16 = 58;
    const EVT_UDP_RECV_V6: u16 = 59;

    type Counters = Arc<Mutex<HashMap<u32, NetUsage>>>;

    // 全局：供 C 回调访问的累计表（每个会话一个；本应用只建一个会话）。
    static COUNTERS: Mutex<Option<Counters>> = Mutex::new(None);

    fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub struct EtwNet {
        session: CONTROLTRACE_HANDLE,
        session_name: Vec<u16>,
        counters: Counters,
        consumer: Option<std::thread::JoinHandle<()>>,
        trace_handle: Arc<Mutex<Option<u64>>>,
    }

    // EVENT_TRACE_PROPERTIES 需要尾随会话名缓冲区
    #[repr(C)]
    struct TraceProps {
        props: EVENT_TRACE_PROPERTIES,
        name: [u16; 256],
    }

    impl EtwNet {
        pub fn start() -> Result<EtwNet, Capability> {
            let counters: Counters = Arc::new(Mutex::new(HashMap::new()));
            *COUNTERS.lock().unwrap() = Some(counters.clone());

            // 进程级名称避免测试、并行会话或异常恢复误停另一个 Useful 实例的 ETW 会话。
            let session_name = to_wide(&format!("UsefulKernelNet-{}", std::process::id()));
            let mut boxed = Box::new(TraceProps {
                props: EVENT_TRACE_PROPERTIES::default(),
                name: [0u16; 256],
            });
            let total = std::mem::size_of::<TraceProps>() as u32;
            boxed.props.Wnode.BufferSize = total;
            boxed.props.Wnode.Flags = WNODE_FLAG_TRACED_GUID;
            boxed.props.Wnode.ClientContext = 1; // QPC
            boxed.props.LogFileMode = EVENT_TRACE_REAL_TIME_MODE;
            boxed.props.LoggerNameOffset = std::mem::size_of::<EVENT_TRACE_PROPERTIES>() as u32;

            let mut session = CONTROLTRACE_HANDLE::default();
            unsafe {
                // 先尝试停止可能残留的同名会话
                let _ = ControlTraceW(
                    CONTROLTRACE_HANDLE::default(),
                    PCWSTR(session_name.as_ptr()),
                    &mut boxed.props,
                    EVENT_TRACE_CONTROL_STOP,
                );
                // 重新初始化属性（ControlTrace 可能改写）
                boxed.props = EVENT_TRACE_PROPERTIES::default();
                boxed.props.Wnode.BufferSize = total;
                boxed.props.Wnode.Flags = WNODE_FLAG_TRACED_GUID;
                boxed.props.Wnode.ClientContext = 1;
                boxed.props.LogFileMode = EVENT_TRACE_REAL_TIME_MODE;
                boxed.props.LoggerNameOffset = std::mem::size_of::<EVENT_TRACE_PROPERTIES>() as u32;

                let st = StartTraceW(
                    &mut session,
                    PCWSTR(session_name.as_ptr()),
                    &mut boxed.props,
                );
                if st != WIN32_ERROR(ERROR_SUCCESS) {
                    *COUNTERS.lock().unwrap() = None;
                    return Err(failure("start_trace", st.0));
                }

                let params = ENABLE_TRACE_PARAMETERS {
                    Version: 2,
                    ..Default::default()
                };
                let st = EnableTraceEx2(
                    session,
                    &KERNEL_NETWORK_GUID,
                    EVENT_CONTROL_CODE_ENABLE_PROVIDER.0,
                    TRACE_LEVEL_INFORMATION as u8,
                    0,
                    0,
                    0,
                    Some(&params),
                );
                if st != WIN32_ERROR(ERROR_SUCCESS) {
                    let _ = ControlTraceW(
                        session,
                        PCWSTR(session_name.as_ptr()),
                        &mut boxed.props,
                        EVENT_TRACE_CONTROL_STOP,
                    );
                    *COUNTERS.lock().unwrap() = None;
                    return Err(failure("enable_provider", st.0));
                }
            }

            // 启动消费线程：OpenTraceW + ProcessTrace（阻塞直到会话停止）
            let trace_handle = Arc::new(Mutex::new(None::<u64>));
            let th_clone = trace_handle.clone();
            let name_for_thread = session_name.clone();
            let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
            let consumer = std::thread::Builder::new()
                .name("etw-net-consumer".into())
                .spawn(move || unsafe {
                    // EVENT_TRACE_LOGFILEW 含 union 字段，已在 unsafe 块内，直接零初始化后逐字段赋值
                    let mut logfile: EVENT_TRACE_LOGFILEW = std::mem::zeroed();
                    logfile.LoggerName = windows::core::PWSTR(name_for_thread.as_ptr() as *mut _);
                    logfile.Anonymous1.ProcessTraceMode =
                        PROCESS_TRACE_MODE_REAL_TIME | PROCESS_TRACE_MODE_EVENT_RECORD;
                    logfile.Anonymous2.EventRecordCallback = Some(event_record_callback);

                    let handle = OpenTraceW(&mut logfile);
                    // 无效句柄检查
                    if handle.Value == u64::MAX {
                        let _ = ready_tx.send(Err(GetLastError().0));
                        return;
                    }
                    *th_clone.lock().unwrap() = Some(handle.Value);
                    let _ = ready_tx.send(Ok(()));
                    let handles = [handle];
                    // ProcessTrace 阻塞，直到会话被 ControlTrace(STOP) 停止
                    let _ = ProcessTrace(&handles, None, None);
                })
                .map_err(|_| {
                    unsafe {
                        let _ = ControlTraceW(
                            session,
                            PCWSTR(session_name.as_ptr()),
                            &mut boxed.props,
                            EVENT_TRACE_CONTROL_STOP,
                        );
                    }
                    *COUNTERS.lock().unwrap() = None;
                    Capability::unavailable(
                        "etw_consumer_thread_failed",
                        "无法启动 ETW 消费线程；请重启 Useful 后重试。",
                    )
                })?;

            match ready_rx.recv_timeout(std::time::Duration::from_secs(2)) {
                Ok(Ok(())) => {}
                Ok(Err(code)) => {
                    unsafe {
                        let _ = ControlTraceW(
                            session,
                            PCWSTR(session_name.as_ptr()),
                            &mut boxed.props,
                            EVENT_TRACE_CONTROL_STOP,
                        );
                    }
                    let _ = consumer.join();
                    *COUNTERS.lock().unwrap() = None;
                    return Err(failure("open_trace", code));
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    unsafe {
                        let _ = ControlTraceW(
                            session,
                            PCWSTR(session_name.as_ptr()),
                            &mut boxed.props,
                            EVENT_TRACE_CONTROL_STOP,
                        );
                    }
                    let _ = consumer.join();
                    *COUNTERS.lock().unwrap() = None;
                    return Err(Capability::unavailable(
                        "etw_consumer_disconnected",
                        "ETW 消费器启动失败；请重启 Useful 后重试。",
                    ));
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    unsafe {
                        let _ = ControlTraceW(
                            session,
                            PCWSTR(session_name.as_ptr()),
                            &mut boxed.props,
                            EVENT_TRACE_CONTROL_STOP,
                        );
                    }
                    let _ = consumer.join();
                    *COUNTERS.lock().unwrap() = None;
                    return Err(Capability::unavailable(
                        "etw_consumer_handshake_timeout",
                        "ETW 消费器未能及时就绪；请重启 Useful 后重试。",
                    ));
                }
            }

            Ok(EtwNet {
                session,
                session_name,
                counters,
                consumer: Some(consumer),
                trace_handle,
            })
        }

        /// 读取并清零累计计数。
        pub fn take(&self) -> HashMap<u32, NetUsage> {
            let mut guard = self.counters.lock().unwrap();
            std::mem::take(&mut *guard)
        }
    }

    fn failure(stage: &str, code: u32) -> Capability {
        if code == 5 {
            Capability::unavailable(
                "etw_access_denied",
                "每进程字节需要 ETW 权限。可由管理员将当前用户加入“Performance Log Users（性能日志用户）”后重新登录；无需以管理员身份持续运行 Useful。",
            )
        } else {
            Capability::unavailable(
                format!("etw_{stage}_{code}"),
                format!("ETW 每进程字节采集失败（Windows 错误 {code}）；请重启 Useful 后重试。"),
            )
        }
    }

    impl Drop for EtwNet {
        fn drop(&mut self) {
            unsafe {
                // 停止会话，使 ProcessTrace 返回
                let mut boxed = Box::new(TraceProps {
                    props: EVENT_TRACE_PROPERTIES::default(),
                    name: [0u16; 256],
                });
                boxed.props.Wnode.BufferSize = std::mem::size_of::<TraceProps>() as u32;
                boxed.props.LoggerNameOffset = std::mem::size_of::<EVENT_TRACE_PROPERTIES>() as u32;
                let _ = ControlTraceW(
                    self.session,
                    PCWSTR(self.session_name.as_ptr()),
                    &mut boxed.props,
                    EVENT_TRACE_CONTROL_STOP,
                );
                if let Some(h) = *self.trace_handle.lock().unwrap() {
                    let _ = CloseTrace(PROCESSTRACE_HANDLE { Value: h });
                }
            }
            if let Some(c) = self.consumer.take() {
                let _ = c.join();
            }
            *COUNTERS.lock().unwrap() = None;
        }
    }

    /// ETW 事件回调（C ABI）。解析 Kernel-Network 事件的 PID 与字节数。
    unsafe extern "system" fn event_record_callback(record: *mut EVENT_RECORD) {
        if record.is_null() {
            return;
        }
        let record = &*record;
        if record.EventHeader.ProviderId != KERNEL_NETWORK_GUID {
            return;
        }
        let id = record.EventHeader.EventDescriptor.Id;
        let (is_send, is_recv) = match id {
            EVT_TCP_SEND_V4 | EVT_TCP_SEND_V6 | EVT_UDP_SEND_V4 | EVT_UDP_SEND_V6 => (true, false),
            EVT_TCP_RECV_V4 | EVT_TCP_RECV_V6 | EVT_UDP_RECV_V4 | EVT_UDP_RECV_V6 => (false, true),
            _ => return,
        };

        // Kernel-Network 事件用户数据布局：PID(uint32) @0, size(uint32) @4
        let data = record.UserData as *const u8;
        let len = record.UserDataLength as usize;
        if data.is_null() || len < 8 {
            return;
        }
        let pid = u32::from_le_bytes([*data, *data.add(1), *data.add(2), *data.add(3)]);
        let size =
            u32::from_le_bytes([*data.add(4), *data.add(5), *data.add(6), *data.add(7)]) as u64;
        if pid == 0 {
            return;
        }

        if let Some(counters) = COUNTERS.lock().unwrap().as_ref() {
            if let Ok(mut map) = counters.lock() {
                let e = map.entry(pid).or_default();
                if is_send {
                    e.up = e.up.saturating_add(size);
                }
                if is_recv {
                    e.down = e.down.saturating_add(size);
                }
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn etw_errors_have_stable_reason_and_remediation() {
            let denied = failure("start_trace", 5);
            assert_eq!(denied.reason_code.as_deref(), Some("etw_access_denied"));
            assert!(denied
                .remediation
                .unwrap()
                .contains("Performance Log Users"));
            let other = failure("open_trace", 87);
            assert_eq!(other.reason_code.as_deref(), Some("etw_open_trace_87"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collector_never_panics() {
        // 无权限环境下应安全降级为不可用，且不 panic
        let mut c = NetCollector::new();
        let _ = c.is_available();
        let _ = c.sample();
    }

    #[test]
    fn etw_bytes_use_actual_elapsed_time() {
        let raw = HashMap::from([(9, NetUsage { up: 300, down: 120 })]);
        let rates = rates_for_elapsed(raw, Duration::from_millis(1500));
        assert_eq!(rates[&9].up, 200);
        assert_eq!(rates[&9].down, 80);
    }
}
