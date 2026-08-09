//! 进程身份：PID + 启动时间。首发版本仅用于只读快照与差量关联。

use serde::{Deserialize, Serialize};

/// 进程身份 = PID + 启动时间（Unix 秒，受当前跨平台 sysinfo 采样精度限制）。
///
/// 单独 PID 会被操作系统复用；这个复合键用于防止采样差量把新进程误当成旧进程。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessIdentity {
    pub pid: u32,
    pub start_time: u64,
}

impl ProcessIdentity {
    pub fn new(pid: u32, start_time: u64) -> Self {
        Self { pid, start_time }
    }

    /// 稳定字符串键（用于前端 map / diff）。
    pub fn key(&self) -> String {
        format!("{}:{}", self.pid, self.start_time)
    }

    /// 校验两个只读采样身份是否相同。
    pub fn matches(&self, other: &ProcessIdentity) -> bool {
        self.pid == other.pid && self.start_time == other.start_time
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_key_stable() {
        let id = ProcessIdentity::new(1234, 1700000000);
        assert_eq!(id.key(), "1234:1700000000");
    }

    #[test]
    fn pid_reuse_detected() {
        // 相同 PID 但不同启动时间 = 不同进程（PID 已复用）
        let original = ProcessIdentity::new(4000, 1700000000);
        let reused = ProcessIdentity::new(4000, 1700009999);
        assert!(!original.matches(&reused));
        assert_ne!(original, reused);

        // 完全相同 = 同一进程
        let same = ProcessIdentity::new(4000, 1700000000);
        assert!(original.matches(&same));
    }
}
