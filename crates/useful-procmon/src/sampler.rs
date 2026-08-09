//! 基础进程采样器：保持长期 `System` 实例，只刷新必要字段，
//! 并合并 Windows 专有的 ETW 网络与 PDH GPU 数据。
//!
//! 缺失的 Windows 专有数据以 `Metric::Unavailable` 表示，绝不伪造 0，也不阻塞基础采样。

use crate::etw::NetCollector;
use crate::gpu::GpuCollector;
use crate::identity::ProcessIdentity;
use crate::model::NetworkSnapshot;
use crate::model::{DynamicMetrics, Metric, ProcessSnapshot, StaticInfo};
use crate::network::{associate_endpoint_counts, NetworkCollector};
use std::collections::HashMap;
use std::time::Instant;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

/// 采样器：封装长期 System 实例与专有采集器。
pub struct Sampler {
    system: System,
    net: NetCollector,
    network: NetworkCollector,
    gpu: GpuCollector,
    /// 上一采样点的 PID -> start_time。新出现或发生 PID 重用的进程先等待一个完整区间，
    /// 避免把区间内旧进程的 ETW 字节/owner-PID 行归给新进程。
    previous_identities: HashMap<u32, u64>,
    /// 上次采样耗时（毫秒），供开发者性能面板显示
    pub last_sample_ms: f64,
}

impl Default for Sampler {
    fn default() -> Self {
        Self::new()
    }
}

impl Sampler {
    pub fn new() -> Self {
        Self {
            system: System::new(),
            net: NetCollector::new(),
            network: NetworkCollector::new(),
            gpu: GpuCollector::new(),
            previous_identities: HashMap::new(),
            last_sample_ms: 0.0,
        }
    }

    /// 仅基础采样（不含专有采集器），用于测试与无 Windows 环境。
    pub fn new_basic() -> Self {
        Self {
            system: System::new(),
            net: NetCollector::disabled(),
            network: NetworkCollector::new(),
            gpu: GpuCollector::disabled(),
            previous_identities: HashMap::new(),
            last_sample_ms: 0.0,
        }
    }

    pub fn net_available(&self) -> bool {
        self.net.is_available()
    }
    pub fn gpu_available(&self) -> bool {
        self.gpu.is_available()
    }

    pub fn network_snapshot(&self) -> &NetworkSnapshot {
        self.network.snapshot()
    }

    /// Drain ETW and reset interface baselines. Call while paused and once on resume.
    pub fn reset_network(&mut self) -> NetworkSnapshot {
        self.net.reset();
        self.network.reset(self.net.capability())
    }

    /// 采样一次，返回全部进程快照。只刷新 CPU/内存/磁盘等必要字段。
    pub fn sample(&mut self) -> Vec<ProcessSnapshot> {
        let start = Instant::now();
        let refresh = ProcessRefreshKind::nothing()
            .with_cpu()
            .with_memory()
            .with_disk_usage()
            .with_cmd(UpdateKind::OnlyIfNotSet)
            .with_exe(UpdateKind::OnlyIfNotSet);
        self.system
            .refresh_processes_specifics(ProcessesToUpdate::All, true, refresh);

        let current_identities: HashMap<u32, u64> = self
            .system
            .processes()
            .values()
            .map(|process| (process.pid().as_u32(), process.start_time()))
            .collect();

        // 专有数据（一次性获取，按 PID 索引）
        let net_map = self.net.sample();
        let (network_snapshot, endpoint_map) = self.network.sample(self.net.capability());
        let connections_available = network_snapshot.connection_capability.available;
        let endpoints_by_identity = associate_endpoint_counts(
            self.system
                .processes()
                .values()
                .map(|process| ProcessIdentity::new(process.pid().as_u32(), process.start_time())),
            &endpoint_map,
        );
        let gpu_map = self.gpu.sample();
        let thread_map = thread_counts();

        let snapshots: Vec<ProcessSnapshot> = self
            .system
            .processes()
            .values()
            .map(|p| {
                let pid = p.pid().as_u32();
                let start_time = p.start_time();
                let identity = ProcessIdentity::new(pid, start_time);
                let identity_stable = self.previous_identities.get(&pid) == Some(&start_time);
                let disk = p.disk_usage();

                let static_info = StaticInfo {
                    name: p.name().to_string_lossy().to_string(),
                    exe_path: p.exe().map(|e| e.to_string_lossy().to_string()),
                    cmd_line: {
                        let cmd: Vec<String> = p
                            .cmd()
                            .iter()
                            .map(|s| s.to_string_lossy().to_string())
                            .collect();
                        if cmd.is_empty() {
                            None
                        } else {
                            Some(cmd.join(" "))
                        }
                    },
                    publisher: None, // 由 windows-rs 侧按需补充
                    icon_key: p.exe().map(|e| e.to_string_lossy().to_string()),
                    parent: p.parent().and_then(|pp| {
                        self.system.process(pp).map(|parent_proc| {
                            ProcessIdentity::new(pp.as_u32(), parent_proc.start_time())
                        })
                    }),
                };

                let net = net_map.get(&pid);
                let gpu = gpu_map.get(&pid);
                let endpoints = endpoints_by_identity
                    .get(&identity.key())
                    .copied()
                    .unwrap_or_default();

                let dynamic = DynamicMetrics {
                    cpu: p.cpu_usage(),
                    working_set: p.memory(),
                    private_bytes: p.virtual_memory(),
                    disk_read: disk.read_bytes,
                    disk_write: disk.written_bytes,
                    net_up: match (identity_stable, net) {
                        (false, _) => Metric::Unavailable,
                        (true, Some(n)) => Metric::Available(n.up),
                        (true, None) if self.net.is_available() => Metric::Available(0),
                        (true, None) => Metric::Unavailable,
                    },
                    net_down: match (identity_stable, net) {
                        (false, _) => Metric::Unavailable,
                        (true, Some(n)) => Metric::Available(n.down),
                        (true, None) if self.net.is_available() => Metric::Available(0),
                        (true, None) => Metric::Unavailable,
                    },
                    tcp_connections: if connections_available && identity_stable {
                        Metric::Available(endpoints.tcp_connections)
                    } else {
                        Metric::Unavailable
                    },
                    udp_endpoints: if connections_available && identity_stable {
                        Metric::Available(endpoints.udp_endpoints)
                    } else {
                        Metric::Unavailable
                    },
                    gpu: match gpu {
                        Some(g) => Metric::Available(g.utilization.min(100.0)),
                        None if self.gpu.is_available() => Metric::Available(0.0),
                        None => Metric::Unavailable,
                    },
                    gpu_memory: match gpu {
                        Some(g) => Metric::Available(g.dedicated_bytes),
                        None if self.gpu.is_available() => Metric::Available(0),
                        None => Metric::Unavailable,
                    },
                    threads: thread_map.get(&pid).copied().unwrap_or(0),
                    handles: Metric::from_option(handle_count(pid)),
                };

                ProcessSnapshot {
                    identity,
                    r#static: static_info,
                    dynamic,
                }
            })
            .collect();

        self.previous_identities = current_identities;

        self.last_sample_ms = start.elapsed().as_secs_f64() * 1000.0;
        snapshots
    }

    pub fn process_count(&self) -> usize {
        self.system.processes().len()
    }
}

/// 通过 Toolhelp 线程快照统计每 PID 线程数（一次快照覆盖全部进程）。
#[cfg(windows)]
fn thread_counts() -> HashMap<u32, u32> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    let mut map = HashMap::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) else {
            return map;
        };
        let mut entry = THREADENTRY32 {
            dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        if Thread32First(snap, &mut entry).is_ok() {
            loop {
                *map.entry(entry.th32OwnerProcessID).or_insert(0) += 1;
                if Thread32Next(snap, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }
    map
}

#[cfg(not(windows))]
fn thread_counts() -> HashMap<u32, u32> {
    HashMap::new()
}

/// 读取进程句柄数（Windows）。失败返回 None -> 显示「不可用」。
#[cfg(windows)]
fn handle_count(pid: u32) -> Option<u32> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        GetProcessHandleCount, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut count = 0u32;
        let ok = GetProcessHandleCount(handle, &mut count).is_ok();
        let _ = CloseHandle(handle);
        if ok {
            Some(count)
        } else {
            None
        }
    }
}

#[cfg(not(windows))]
fn handle_count(_pid: u32) -> Option<u32> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sampler_returns_processes() {
        let mut sampler = Sampler::new_basic();
        // 首次采样建立基线
        let _ = sampler.sample();
        std::thread::sleep(std::time::Duration::from_millis(50));
        let snaps = sampler.sample();
        // 当前测试进程自身一定存在
        assert!(!snaps.is_empty(), "至少应采到当前进程");
        // 每个进程都有合法身份键
        for s in &snaps {
            assert!(!s.identity.key().is_empty());
        }
    }

    #[test]
    fn first_sample_keeps_pid_only_network_metrics_unavailable() {
        let mut sampler = Sampler::new_basic();
        let first = sampler.sample();
        assert!(first.iter().all(|snapshot| {
            matches!(snapshot.dynamic.net_up, Metric::Unavailable)
                && matches!(snapshot.dynamic.net_down, Metric::Unavailable)
                && matches!(snapshot.dynamic.tcp_connections, Metric::Unavailable)
                && matches!(snapshot.dynamic.udp_endpoints, Metric::Unavailable)
        }));
    }
}
