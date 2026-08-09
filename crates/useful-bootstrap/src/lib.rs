//! useful-bootstrap：便携客户端更新引导器（Phase 10）。
//!
//! 信任域隔离原则：
//! - 客户端更新信任根（AppUpdateSource.updateRootPublicKey）与工具源信任根完全分离；
//!   本 crate 不读取 trp_sources、不接受任何工具源的密钥或 capability。
//! - 普通 SourceDefinition（kind=tool|mirror）没有可更新客户端的能力（协议层已约束）；
//!   即使工具源提供"更高版本"的 Useful.exe，其签名也无法通过客户端更新根验证。
//! - 默认 AppUpdateSource 使用官方预置公钥；高级用户更换必须单独确认警告
//!   （warningAcknowledgedAt），且绝不从工具源自动继承。
//!
//! 更新流程：检查 pending → 验证签名/摘要/长度/版本 → 确认 Useful.exe 已退出 →
//! 备份当前版本 → 原子替换 → 启动新版本 → 启动失败回滚 → 清理过期备份。

pub mod apply;
pub mod config;
pub mod manifest;

pub use apply::{apply_update, cleanup_backups, ensure_app_exited, rollback, ApplyError};
pub use config::{
    AppUpdateSource, ConfigError, OFFICIAL_UPDATE_ROOT_PUBKEY_HEX, PRODUCTION_UPDATE_CONFIGURED,
};
pub use manifest::{verify_update, UpdateManifest, VerifyError};
