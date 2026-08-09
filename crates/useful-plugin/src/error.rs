use thiserror::Error;

#[derive(Debug, Error)]
pub enum PluginError {
    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON 错误: {0}")]
    Json(#[from] serde_json::Error),

    #[error("ZIP 错误: {0}")]
    Zip(#[from] zip::result::ZipError),

    #[error("manifest 校验失败: {0}")]
    ManifestInvalid(String),

    #[error("包结构不安全: {0}")]
    UnsafeArchive(String),

    #[error("文件大小超过上限: {actual} > {limit}")]
    SizeExceeded { actual: u64, limit: u64 },

    #[error("SHA-256 不匹配: 期望 {expected}, 实际 {actual}")]
    HashMismatch { expected: String, actual: String },

    #[error("签名验证失败: {0}")]
    SignatureInvalid(String),

    #[error("插件 ID 冲突或不一致: {0}")]
    IdConflict(String),

    #[error("版本不兼容: {0}")]
    VersionIncompatible(String),

    #[error("版本降级被拒绝: 已安装 {installed}, 尝试安装 {candidate}")]
    DowngradeRejected {
        installed: String,
        candidate: String,
    },

    #[error("宿主版本不满足: 需要 >= {required}, 当前 {current}")]
    HostVersionTooLow { required: String, current: String },

    #[error("安装失败并已回滚: {0}")]
    InstallRolledBack(String),

    #[error("权限被拒绝: {0}")]
    PermissionDenied(String),
}
