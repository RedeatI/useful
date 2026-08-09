//! TRP v1（Useful Repository Protocol）客户端逻辑。
//!
//! 本 crate 只包含纯逻辑，无网络与数据库依赖，供 Tauri 命令层组合调用：
//! - `discovery`：discovery 文件解析与校验（结构上拒绝任何客户端更新能力）
//! - `trust`：官方信任根匹配（官方身份仅由预置根指纹产生，绝不由名称/ID/URL 产生）
//! - `catalog`：目录快照解析与限额校验
//! - `pinning`：来源固定与发布者固定的更新决策
//! - `search`：多源目录合并（同名不同发布者不合并、同发布者同摘要折叠镜像）
//! - `tuf`：TUF 风格 metadata 验证链（TrustBackend trait 隔离实现）

pub mod catalog;
pub mod discovery;
pub mod network;
pub mod pinning;
pub mod publisher;
pub mod search;
pub mod trust;
pub mod tuf;

/// TRP 客户端错误。所有解析失败一律 fail closed。
#[derive(Debug, thiserror::Error)]
pub enum RepoError {
    #[error("discovery 无效: {0}")]
    InvalidDiscovery(String),
    #[error("目录快照无效: {0}")]
    InvalidCatalog(String),
    #[error("超出限制: {0}")]
    LimitExceeded(String),
}
