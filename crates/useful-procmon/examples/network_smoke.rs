//! Privacy-safe, aggregate-only network sampler smoke test.
//!
//! Run explicitly with:
//! `cargo run --locked --release -p useful-procmon --example network_smoke -- --json`

use serde::Serialize;
use std::ffi::OsStr;
use std::io::{self, Write};
use std::process::ExitCode;
use std::time::{Duration, Instant};
use useful_procmon::model::{Metric, NetworkSnapshot, ProcessSnapshot};
use useful_procmon::sampler::Sampler;

const SCHEMA_VERSION: &str = "useful.procmon.network-smoke.v1";
const SAMPLE_COUNT: u32 = 3;
const SAMPLE_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum Platform {
    Windows,
    Macos,
    Linux,
    Other,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum PrivilegeRequest {
    None,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SmokeProjection {
    schema_version: &'static str,
    sample_count: u32,
    duration_ms: u64,
    nonzero_system_rx_observed: bool,
    nonzero_system_tx_observed: bool,
    max_interface_count: usize,
    max_pids_with_tcp_connections: usize,
    max_pids_with_udp_connections: usize,
    etw_available: bool,
    etw_reason_code_present: bool,
    etw_remediation_present: bool,
    aggregate_network_available: bool,
    aggregate_network_reason: Option<String>,
    aggregate_network_remediation: Option<String>,
    platform: Platform,
    privilege_request: PrivilegeRequest,
}

impl SmokeProjection {
    fn new() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            sample_count: SAMPLE_COUNT,
            duration_ms: 0,
            nonzero_system_rx_observed: false,
            nonzero_system_tx_observed: false,
            max_interface_count: 0,
            max_pids_with_tcp_connections: 0,
            max_pids_with_udp_connections: 0,
            etw_available: false,
            etw_reason_code_present: false,
            etw_remediation_present: false,
            aggregate_network_available: false,
            aggregate_network_reason: None,
            aggregate_network_remediation: None,
            platform: current_platform(),
            privilege_request: PrivilegeRequest::None,
        }
    }

    fn observe(&mut self, processes: &[ProcessSnapshot], network: &NetworkSnapshot) {
        self.nonzero_system_rx_observed |= network.total_down_bytes_per_sec > 0;
        self.nonzero_system_tx_observed |= network.total_up_bytes_per_sec > 0;
        self.max_interface_count = self.max_interface_count.max(network.interfaces.len());
        self.max_pids_with_tcp_connections = self
            .max_pids_with_tcp_connections
            .max(count_nonzero(processes, |process| {
                process.dynamic.tcp_connections
            }));
        self.max_pids_with_udp_connections = self
            .max_pids_with_udp_connections
            .max(count_nonzero(processes, |process| {
                process.dynamic.udp_endpoints
            }));

        self.etw_available = network.etw_capability.available;
        self.etw_reason_code_present = network.etw_capability.reason_code.is_some();
        self.etw_remediation_present = network.etw_capability.remediation.is_some();
        self.aggregate_network_available = network.interface_capability.available;
        self.aggregate_network_reason = network.interface_capability.reason_code.clone();
        self.aggregate_network_remediation = network.interface_capability.remediation.clone();
    }
}

fn count_nonzero(
    processes: &[ProcessSnapshot],
    metric: impl Fn(&ProcessSnapshot) -> Metric<u32>,
) -> usize {
    processes
        .iter()
        .filter(|process| matches!(metric(process), Metric::Available(value) if value > 0))
        .count()
}

fn current_platform() -> Platform {
    if cfg!(windows) {
        Platform::Windows
    } else if cfg!(target_os = "macos") {
        Platform::Macos
    } else if cfg!(target_os = "linux") {
        Platform::Linux
    } else {
        Platform::Other
    }
}

fn sample_network() -> SmokeProjection {
    let started = Instant::now();
    let mut sampler = Sampler::new();
    let mut projection = SmokeProjection::new();

    for index in 0..SAMPLE_COUNT {
        let processes = sampler.sample();
        projection.observe(&processes, sampler.network_snapshot());
        if index + 1 < SAMPLE_COUNT {
            std::thread::sleep(SAMPLE_INTERVAL);
        }
    }

    projection.duration_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    projection
}

fn write_json<T: Serialize>(value: &T) -> io::Result<()> {
    let line = serde_json::to_string(value).map_err(io::Error::other)?;
    let mut stdout = io::stdout().lock();
    stdout.write_all(line.as_bytes())?;
    stdout.write_all(b"\n")
}

fn main() -> ExitCode {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 1 || args[0] != OsStr::new("--json") {
        eprintln!("Usage: network_smoke --json");
        return ExitCode::from(2);
    }

    let projection = sample_network();
    match write_json(&projection) {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => {
            eprintln!("network_smoke: failed to write JSON output");
            ExitCode::from(1)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn json_projection_contains_only_approved_aggregate_keys() {
        let value = serde_json::to_value(SmokeProjection::new()).unwrap();
        let actual: BTreeSet<_> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        let approved = BTreeSet::from([
            "aggregateNetworkAvailable",
            "aggregateNetworkReason",
            "aggregateNetworkRemediation",
            "durationMs",
            "etwAvailable",
            "etwReasonCodePresent",
            "etwRemediationPresent",
            "maxInterfaceCount",
            "maxPidsWithTcpConnections",
            "maxPidsWithUdpConnections",
            "nonzeroSystemRxObserved",
            "nonzeroSystemTxObserved",
            "platform",
            "privilegeRequest",
            "sampleCount",
            "schemaVersion",
        ]);

        assert_eq!(actual, approved);
    }
}
