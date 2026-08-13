//! Standard-user network telemetry backed by Windows IP Helper.
//!
//! `GetIfTable2` supplies machine/interface byte counters. Owner-PID TCP/UDP tables
//! supply only live row/endpoint counts; they must never be presented as bytes.

use crate::identity::ProcessIdentity;
use crate::model::{Capability, InterfaceThroughput, NetworkSnapshot};
use std::collections::HashMap;
#[cfg(any(windows, test))]
use std::time::Duration;
use std::time::Instant;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EndpointCounts {
    pub tcp_connections: u32,
    pub udp_endpoints: u32,
}

/// Bind the ephemeral owner-PID table to a process snapshot generation. Callers must
/// additionally require that the PID + start_time survived a complete sampling interval;
/// owner-PID tables themselves do not expose process start time.
pub fn associate_endpoint_counts(
    identities: impl IntoIterator<Item = ProcessIdentity>,
    counts: &HashMap<u32, EndpointCounts>,
) -> HashMap<String, EndpointCounts> {
    identities
        .into_iter()
        .map(|identity| {
            let value = counts.get(&identity.pid).copied().unwrap_or_default();
            (identity.key(), value)
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg(any(windows, test))]
struct RawInterface {
    key: String,
    name: String,
    description: String,
    in_octets: u64,
    out_octets: u64,
    is_loopback: bool,
    is_virtual: bool,
}

#[derive(Default)]
struct InterfaceRateTracker {
    previous: HashMap<String, (u64, u64)>,
    sampled_at: Option<Instant>,
}

impl InterfaceRateTracker {
    fn reset(&mut self) {
        self.previous.clear();
        self.sampled_at = None;
    }

    #[cfg(any(windows, test))]
    fn update(
        &mut self,
        now: Instant,
        result: Result<Vec<RawInterface>, u32>,
    ) -> (Capability, Vec<InterfaceThroughput>, u64, u64) {
        let rows = match result {
            Ok(rows) => rows,
            Err(code) => {
                self.reset();
                return (
                    Capability::unavailable(
                        format!("get_if_table2_{code}"),
                        "读取 Windows 网络接口计数失败；请检查系统网络服务后重试。",
                    ),
                    Vec::new(),
                    0,
                    0,
                );
            }
        };
        let elapsed = self
            .sampled_at
            .map(|then| now.saturating_duration_since(then));
        let mut next = HashMap::with_capacity(rows.len());
        let mut interfaces = Vec::with_capacity(rows.len());
        let mut total_up = 0u64;
        let mut total_down = 0u64;

        for row in rows {
            let (up, down) = match (elapsed, self.previous.get(&row.key)) {
                (Some(elapsed), Some((old_in, old_out))) if !elapsed.is_zero() => (
                    rate(counter_delta(*old_out, row.out_octets), elapsed),
                    rate(counter_delta(*old_in, row.in_octets), elapsed),
                ),
                _ => (0, 0),
            };
            next.insert(row.key.clone(), (row.in_octets, row.out_octets));
            if !row.is_loopback {
                total_up = total_up.saturating_add(up);
                total_down = total_down.saturating_add(down);
            }
            interfaces.push(InterfaceThroughput {
                key: row.key,
                name: row.name,
                description: row.description,
                up_bytes_per_sec: up,
                down_bytes_per_sec: down,
                is_loopback: row.is_loopback,
                is_virtual: row.is_virtual,
            });
        }
        interfaces.sort_by(|a, b| a.name.cmp(&b.name).then(a.key.cmp(&b.key)));
        self.previous = next;
        self.sampled_at = Some(now);
        (Capability::available(), interfaces, total_up, total_down)
    }
}

/// A reset is much more common than a real u64 wrap. Only treat values close to the
/// numeric ends as wraparound; otherwise establish a fresh baseline and report zero.
#[cfg(any(windows, test))]
fn counter_delta(previous: u64, current: u64) -> u64 {
    if current >= previous {
        current - previous
    } else if previous > u64::MAX - (1u64 << 32) && current < (1u64 << 32) {
        (u64::MAX - previous)
            .saturating_add(1)
            .saturating_add(current)
    } else {
        0
    }
}

#[cfg(any(windows, test))]
fn rate(bytes: u64, elapsed: Duration) -> u64 {
    let seconds = elapsed.as_secs_f64();
    if seconds <= 0.0 {
        return 0;
    }
    ((bytes as f64 / seconds).round().clamp(0.0, u64::MAX as f64)) as u64
}

pub struct NetworkCollector {
    interfaces: InterfaceRateTracker,
    #[cfg(windows)]
    connection_capability: Capability,
    last: NetworkSnapshot,
}

impl Default for NetworkCollector {
    fn default() -> Self {
        Self::new()
    }
}

impl NetworkCollector {
    pub fn new() -> Self {
        Self {
            interfaces: InterfaceRateTracker::default(),
            #[cfg(windows)]
            connection_capability: Capability::available(),
            last: NetworkSnapshot::default(),
        }
    }

    pub fn sample(
        &mut self,
        etw_capability: Capability,
    ) -> (NetworkSnapshot, HashMap<u32, EndpointCounts>) {
        #[cfg(not(windows))]
        {
            let snapshot = NetworkSnapshot {
                etw_capability,
                ..NetworkSnapshot::default()
            };
            self.last = snapshot.clone();
            (snapshot, HashMap::new())
        }

        #[cfg(windows)]
        {
            let (interface_capability, interfaces, total_up, total_down) = self
                .interfaces
                .update(Instant::now(), win::interface_rows());
            let endpoints = match win::endpoint_counts() {
                Ok(counts) => {
                    self.connection_capability = Capability::available();
                    counts
                }
                Err(code) => {
                    self.connection_capability = Capability::unavailable(
                        format!("owner_pid_table_{code}"),
                        "读取 Windows TCP/UDP owner-PID 表失败；基本进程监控仍可使用。",
                    );
                    HashMap::new()
                }
            };

            self.last = NetworkSnapshot {
                interface_capability,
                connection_capability: self.connection_capability.clone(),
                etw_capability,
                interfaces,
                total_up_bytes_per_sec: total_up,
                total_down_bytes_per_sec: total_down,
                aggregate_scope: "合计排除 loopback，包含并标注虚拟/隧道接口；新增、删除或计数器重置的接口先建立零速率基线。".into(),
            };
            (self.last.clone(), endpoints)
        }
    }

    /// Pause/resume boundaries discard counters so paused bytes cannot leak into a rate.
    pub fn reset(&mut self, etw_capability: Capability) -> NetworkSnapshot {
        self.interfaces.reset();
        for interface in &mut self.last.interfaces {
            interface.up_bytes_per_sec = 0;
            interface.down_bytes_per_sec = 0;
        }
        self.last.total_up_bytes_per_sec = 0;
        self.last.total_down_bytes_per_sec = 0;
        self.last.etw_capability = etw_capability;
        self.last.clone()
    }

    pub fn snapshot(&self) -> &NetworkSnapshot {
        &self.last
    }
}

#[cfg(windows)]
mod win {
    use super::{EndpointCounts, RawInterface};
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::mem::{size_of, size_of_val};
    use std::ptr;
    use windows::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, NO_ERROR};
    use windows::Win32::NetworkManagement::IpHelper::{
        FreeMibTable, GetExtendedTcpTable, GetExtendedUdpTable, GetIfTable2, MIB_IF_TABLE2,
        MIB_TCP6ROW_OWNER_PID, MIB_TCPROW_OWNER_PID, MIB_UDP6ROW_OWNER_PID, MIB_UDPROW_OWNER_PID,
        TCP_TABLE_OWNER_PID_ALL, UDP_TABLE_OWNER_PID,
    };
    use windows::Win32::Networking::WinSock::{AF_INET, AF_INET6};

    const IF_TYPE_SOFTWARE_LOOPBACK: u32 = 24;
    const IF_TYPE_PROP_VIRTUAL: u32 = 53;
    const IF_TYPE_TUNNEL: u32 = 131;

    struct MibTable(*mut MIB_IF_TABLE2);
    impl Drop for MibTable {
        fn drop(&mut self) {
            unsafe { FreeMibTable(self.0.cast()) }
        }
    }

    pub(super) fn interface_rows() -> Result<Vec<RawInterface>, u32> {
        let mut ptr: *mut MIB_IF_TABLE2 = ptr::null_mut();
        let status = unsafe { GetIfTable2(&mut ptr) };
        if status != NO_ERROR || ptr.is_null() {
            return Err(status.0);
        }
        let table = MibTable(ptr);
        let table_ref = unsafe { &*table.0 };
        let count = table_ref.NumEntries as usize;
        let first = table_ref.Table.as_ptr();
        let rows = unsafe { std::slice::from_raw_parts(first, count) };
        Ok(rows
            .iter()
            .map(|row| {
                let name = wide(&row.Alias);
                let description = wide(&row.Description);
                let text = format!("{} {}", name, description).to_ascii_lowercase();
                let is_loopback = row.Type == IF_TYPE_SOFTWARE_LOOPBACK;
                let is_virtual = row.Type == IF_TYPE_PROP_VIRTUAL
                    || row.Type == IF_TYPE_TUNNEL
                    || [
                        "virtual", "hyper-v", "vpn", "tunnel", "wintun", "tap", "loopback",
                    ]
                    .iter()
                    .any(|needle| text.contains(needle));
                RawInterface {
                    key: format!(
                        "{}:{}",
                        unsafe { row.InterfaceLuid.Value },
                        row.InterfaceIndex
                    ),
                    name,
                    description,
                    in_octets: row.InOctets,
                    out_octets: row.OutOctets,
                    is_loopback,
                    is_virtual,
                }
            })
            .collect())
    }

    fn wide(value: &[u16]) -> String {
        let end = value.iter().position(|ch| *ch == 0).unwrap_or(value.len());
        String::from_utf16_lossy(&value[..end])
    }

    pub(super) fn endpoint_counts() -> Result<HashMap<u32, EndpointCounts>, u32> {
        let mut counts = HashMap::<u32, EndpointCounts>::new();
        for row in table_rows::<MIB_TCPROW_OWNER_PID>(|buf, size| unsafe {
            GetExtendedTcpTable(
                buf,
                size,
                false,
                AF_INET.0 as u32,
                TCP_TABLE_OWNER_PID_ALL,
                0,
            )
        })? {
            counts.entry(row.dwOwningPid).or_default().tcp_connections += 1;
        }
        for row in table_rows::<MIB_TCP6ROW_OWNER_PID>(|buf, size| unsafe {
            GetExtendedTcpTable(
                buf,
                size,
                false,
                AF_INET6.0 as u32,
                TCP_TABLE_OWNER_PID_ALL,
                0,
            )
        })? {
            counts.entry(row.dwOwningPid).or_default().tcp_connections += 1;
        }
        for row in table_rows::<MIB_UDPROW_OWNER_PID>(|buf, size| unsafe {
            GetExtendedUdpTable(buf, size, false, AF_INET.0 as u32, UDP_TABLE_OWNER_PID, 0)
        })? {
            counts.entry(row.dwOwningPid).or_default().udp_endpoints += 1;
        }
        for row in table_rows::<MIB_UDP6ROW_OWNER_PID>(|buf, size| unsafe {
            GetExtendedUdpTable(buf, size, false, AF_INET6.0 as u32, UDP_TABLE_OWNER_PID, 0)
        })? {
            counts.entry(row.dwOwningPid).or_default().udp_endpoints += 1;
        }
        counts.remove(&0);
        Ok(counts)
    }

    fn table_rows<T: Copy>(
        mut call: impl FnMut(Option<*mut c_void>, *mut u32) -> u32,
    ) -> Result<Vec<T>, u32> {
        let mut bytes = 0u32;
        let initial = call(None, &mut bytes);
        if initial != ERROR_INSUFFICIENT_BUFFER.0 && initial != NO_ERROR.0 {
            return Err(initial);
        }
        // u64 storage guarantees alignment for every IP Helper owner-PID row.
        let mut storage = vec![0u64; (bytes as usize).div_ceil(size_of::<u64>())];
        for _ in 0..3 {
            let status = call(Some(storage.as_mut_ptr().cast()), &mut bytes);
            if status == ERROR_INSUFFICIENT_BUFFER.0 {
                storage.resize((bytes as usize).div_ceil(size_of::<u64>()), 0);
                continue;
            }
            if status != NO_ERROR.0 {
                return Err(status);
            }
            let used = bytes as usize;
            if used < size_of::<u32>() {
                return Err(13); // ERROR_INVALID_DATA
            }
            let base = storage.as_ptr().cast::<u8>();
            let count = unsafe { ptr::read_unaligned(base.cast::<u32>()) } as usize;
            let required = size_of::<u32>().saturating_add(count.saturating_mul(size_of::<T>()));
            if required > used || required > size_of_val(storage.as_slice()) {
                return Err(13);
            }
            let rows = (0..count)
                .map(|index| unsafe {
                    ptr::read_unaligned(
                        base.add(size_of::<u32>() + index * size_of::<T>())
                            .cast::<T>(),
                    )
                })
                .collect();
            return Ok(rows);
        }
        Err(ERROR_INSUFFICIENT_BUFFER.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(key: &str, incoming: u64, outgoing: u64) -> RawInterface {
        RawInterface {
            key: key.into(),
            name: key.into(),
            description: String::new(),
            in_octets: incoming,
            out_octets: outgoing,
            is_loopback: false,
            is_virtual: false,
        }
    }

    #[test]
    fn interface_add_remove_reset_and_elapsed_rates() {
        let start = Instant::now();
        let mut tracker = InterfaceRateTracker::default();
        let (_, first, up, down) = tracker.update(start, Ok(vec![row("a", 100, 200)]));
        assert_eq!((first[0].up_bytes_per_sec, up, down), (0, 0, 0));

        let (_, second, up, down) = tracker.update(
            start + Duration::from_millis(500),
            Ok(vec![row("a", 250, 300), row("b", 9, 8)]),
        );
        assert_eq!(
            (second[0].up_bytes_per_sec, second[0].down_bytes_per_sec),
            (200, 300)
        );
        assert_eq!((up, down), (200, 300)); // new interface b is a zero-rate baseline

        let (_, third, up, down) =
            tracker.update(start + Duration::from_secs(1), Ok(vec![row("a", 10, 12)]));
        assert_eq!((third[0].up_bytes_per_sec, up, down), (0, 0, 0)); // reset, b removed
    }

    #[test]
    fn counter_wrap_is_bounded_and_winapi_error_resets_baseline() {
        assert_eq!(counter_delta(u64::MAX - 3, 5), 9);
        assert_eq!(counter_delta(5_000, 4), 0);
        let start = Instant::now();
        let mut tracker = InterfaceRateTracker::default();
        tracker.update(start, Ok(vec![row("a", 1, 1)]));
        let (cap, rows, up, down) = tracker.update(start + Duration::from_secs(1), Err(5));
        assert!(!cap.available);
        assert_eq!(cap.reason_code.as_deref(), Some("get_if_table2_5"));
        assert!(rows.is_empty());
        assert_eq!((up, down), (0, 0));
        let (_, rows, _, _) =
            tracker.update(start + Duration::from_secs(2), Ok(vec![row("a", 50, 50)]));
        assert_eq!(rows[0].up_bytes_per_sec, 0);
    }

    #[test]
    fn loopback_is_excluded_virtual_is_marked_and_included() {
        let start = Instant::now();
        let mut tracker = InterfaceRateTracker::default();
        let mut loopback = row("loop", 0, 0);
        loopback.is_loopback = true;
        let mut virtual_row = row("vpn", 0, 0);
        virtual_row.is_virtual = true;
        tracker.update(start, Ok(vec![loopback.clone(), virtual_row.clone()]));
        loopback.in_octets = 100;
        loopback.out_octets = 100;
        virtual_row.in_octets = 20;
        virtual_row.out_octets = 30;
        let (_, rows, up, down) = tracker.update(
            start + Duration::from_secs(1),
            Ok(vec![loopback, virtual_row]),
        );
        assert!(rows.iter().any(|r| r.is_loopback));
        assert!(rows.iter().any(|r| r.is_virtual));
        assert_eq!((up, down), (30, 20));
    }

    #[test]
    fn endpoint_aggregation_keeps_tcp_and_udp_distinct() {
        let rows = [(7, true), (7, true), (7, false), (8, false)];
        let mut counts = HashMap::<u32, EndpointCounts>::new();
        for (pid, tcp) in rows {
            let entry = counts.entry(pid).or_default();
            if tcp {
                entry.tcp_connections += 1;
            } else {
                entry.udp_endpoints += 1;
            }
        }
        assert_eq!(
            counts[&7],
            EndpointCounts {
                tcp_connections: 2,
                udp_endpoints: 1
            }
        );
        assert_eq!(counts[&8].udp_endpoints, 1);
    }

    #[test]
    fn endpoint_counts_are_keyed_by_pid_and_start_time() {
        let counts = HashMap::from([(
            42,
            EndpointCounts {
                tcp_connections: 3,
                udp_endpoints: 1,
            },
        )]);
        let first = associate_endpoint_counts([ProcessIdentity::new(42, 100)], &counts);
        let reused = associate_endpoint_counts([ProcessIdentity::new(42, 200)], &counts);
        assert_eq!(first.get("42:100").unwrap().tcp_connections, 3);
        assert!(!first.contains_key("42:200"));
        assert_eq!(reused.get("42:200").unwrap().tcp_connections, 3);
        assert!(!reused.contains_key("42:100"));
    }
}
