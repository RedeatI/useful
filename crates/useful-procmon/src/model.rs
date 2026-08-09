//! 进程监视器数据模型：静态信息、动态指标、快照、差量。

use crate::identity::ProcessIdentity;
use serde::{Deserialize, Serialize};

/// 可选指标：区分“真实为 0”与“不可用”。
/// 不可用时前端显示“不可用”而非伪造的 0。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "state", content = "value")]
pub enum Metric<T> {
    Available(T),
    Unavailable,
}

/// 一项可选能力的状态。失败原因是稳定机器码，remediation 是可直接展示的修复提示。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub available: bool,
    pub reason_code: Option<String>,
    pub remediation: Option<String>,
}

impl Capability {
    pub fn available() -> Self {
        Self {
            available: true,
            reason_code: None,
            remediation: None,
        }
    }

    pub fn unavailable(code: impl Into<String>, remediation: impl Into<String>) -> Self {
        Self {
            available: false,
            reason_code: Some(code.into()),
            remediation: Some(remediation.into()),
        }
    }
}

/// 单个 Windows 网络接口的瞬时吞吐。loopback 不计入全局合计；虚拟接口保留并明确标注。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InterfaceThroughput {
    pub key: String,
    pub name: String,
    pub description: String,
    pub up_bytes_per_sec: u64,
    pub down_bytes_per_sec: u64,
    pub is_loopback: bool,
    pub is_virtual: bool,
}

/// 进程监视器的网络能力和全局接口口径。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkSnapshot {
    pub interface_capability: Capability,
    pub connection_capability: Capability,
    pub etw_capability: Capability,
    pub interfaces: Vec<InterfaceThroughput>,
    pub total_up_bytes_per_sec: u64,
    pub total_down_bytes_per_sec: u64,
    pub aggregate_scope: String,
}

impl Default for NetworkSnapshot {
    fn default() -> Self {
        Self {
            interface_capability: Capability::unavailable(
                "platform_unsupported",
                "当前平台不提供 Windows IP Helper 网络接口吞吐；基本进程监控仍可使用。",
            ),
            connection_capability: Capability::unavailable(
                "platform_unsupported",
                "当前平台不提供 Windows owner-PID 连接表；基本进程监控仍可使用。",
            ),
            etw_capability: Capability::unavailable(
                "platform_unsupported",
                "当前平台不提供 Windows ETW 每进程网络字节；基本进程监控仍可使用。",
            ),
            interfaces: Vec::new(),
            total_up_bytes_per_sec: 0,
            total_down_bytes_per_sec: 0,
            aggregate_scope: "不适用（仅 Windows；基本进程监控可用）".into(),
        }
    }
}

impl<T> Metric<T> {
    pub fn from_option(v: Option<T>) -> Self {
        match v {
            Some(x) => Metric::Available(x),
            None => Metric::Unavailable,
        }
    }
    pub fn is_available(&self) -> bool {
        matches!(self, Metric::Available(_))
    }
}

/// 静态信息：进程生命周期内基本不变，只在首次出现时发送。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaticInfo {
    pub name: String,
    pub exe_path: Option<String>,
    pub cmd_line: Option<String>,
    pub publisher: Option<String>,
    /// 图标缓存键（前端按需拉取，不随每秒差量传输图标数据）
    pub icon_key: Option<String>,
    pub parent: Option<ProcessIdentity>,
}

/// 动态指标：每秒变化，走差量通道。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamicMetrics {
    /// CPU 使用率百分比（0-100 * 核心数归一到 0-100）
    pub cpu: f32,
    /// 工作集内存（字节）
    pub working_set: u64,
    /// 私有内存（字节）
    pub private_bytes: u64,
    /// 磁盘读速率（字节/秒）
    pub disk_read: u64,
    pub disk_write: u64,
    /// 网络（字节/秒），来自 ETW，不可用则 Unavailable
    pub net_up: Metric<u64>,
    pub net_down: Metric<u64>,
    /// owner-PID 表中的当前 TCP 行数与 UDP 本地端点数；它们不是字节量。
    pub tcp_connections: Metric<u32>,
    pub udp_endpoints: Metric<u32>,
    /// GPU 利用率百分比，来自 PDH
    pub gpu: Metric<f32>,
    /// 独立显存（字节），来自 PDH
    pub gpu_memory: Metric<u64>,
    pub threads: u32,
    pub handles: Metric<u32>,
}

impl DynamicMetrics {
    /// 判断两次动态指标是否有“显著”变化（避免无意义差量）。
    pub fn differs(&self, other: &DynamicMetrics) -> bool {
        self != other
    }
}

/// 单个进程完整快照。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSnapshot {
    pub identity: ProcessIdentity,
    pub r#static: StaticInfo,
    pub dynamic: DynamicMetrics,
}

/// 差量更新的“更新”项：只包含变化的动态字段 + 身份键。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatedProcess {
    pub key: String,
    pub dynamic: DynamicMetrics,
}

/// 每秒差量：新增/更新/移除。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessDelta {
    /// 新增进程（含完整静态信息）
    pub added: Vec<ProcessSnapshot>,
    /// 更新进程（仅动态字段）
    pub updated: Vec<UpdatedProcess>,
    /// 移除进程（身份键）
    pub removed: Vec<String>,
}

impl ProcessDelta {
    pub fn is_empty(&self) -> bool {
        self.added.is_empty() && self.updated.is_empty() && self.removed.is_empty()
    }
}
