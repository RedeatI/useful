//! 进程监视器：进程身份、采样、差量生成、进程树构建。
//!
//! 进程身份使用 PID + 启动时间，避免 PID 复用误杀。

pub mod diff;
pub mod etw;
pub mod gpu;
pub mod identity;
pub mod model;
pub mod network;
pub mod sampler;
pub mod tree;

pub use identity::ProcessIdentity;
pub use model::{
    Capability, DynamicMetrics, InterfaceThroughput, NetworkSnapshot, ProcessDelta,
    ProcessSnapshot, StaticInfo,
};
