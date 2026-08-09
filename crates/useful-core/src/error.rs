use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),

    #[error("数据库错误: {0}")]
    Db(#[from] rusqlite::Error),

    #[error("JSON 错误: {0}")]
    Json(#[from] serde_json::Error),

    #[error("路径无效: {0}")]
    InvalidPath(String),

    #[error("数据库损坏: {0}")]
    DbCorrupted(String),

    #[error("迁移失败: {0}")]
    Migration(String),

    #[error("仓库信任状态拒绝: {0}")]
    TrustState(String),
}
