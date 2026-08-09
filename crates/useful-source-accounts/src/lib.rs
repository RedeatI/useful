//! 每源独立的 OAuth2 Authorization Code + PKCE 登录逻辑（纯逻辑，无网络/IO）。
//!
//! 安全模型（对应规范 §12）：
//! - PKCE S256、随机 state、随机 nonce、精确 redirect URI 校验、issuer 校验。
//! - loopback IP literal 回调（127.0.0.1），端口仅在授权期间开启，完成/超时即关闭。
//! - 禁止 implicit/password flow、内嵌 client secret、WebView 登录、token 入查询参数、
//!   用 localhost 主机名代替 loopback IP literal、接受 state/issuer 不匹配。
//! - 令牌绝不明文入 SQLite：由 `TokenStore` 抽象（Windows DPAPI/Credential Manager 实现）。
//! - 跨源隔离：每源独立 SourceAccount 与凭据引用，一个源不能读另一个源的凭据。

pub mod pkce;
pub mod session;
pub mod store;

pub use pkce::PkcePair;
pub use session::{AuthSession, CallbackParams, TokenResponse};
pub use store::{SourceAccount, TokenBundle, TokenStore};

#[derive(Debug, thiserror::Error)]
pub enum AccountError {
    #[error("state 不匹配（可能的 CSRF），已拒绝")]
    StateMismatch,
    #[error("issuer 不匹配，已拒绝")]
    IssuerMismatch,
    #[error("回调返回错误: {0}")]
    CallbackError(String),
    #[error("回调缺少授权码")]
    MissingCode,
    #[error("redirect_uri 必须是 loopback IP literal（http://127.0.0.1:PORT）")]
    NonLoopbackRedirect,
    #[error("令牌响应非法: {0}")]
    InvalidTokenResponse(String),
    #[error("凭据存储错误: {0}")]
    Store(String),
}
