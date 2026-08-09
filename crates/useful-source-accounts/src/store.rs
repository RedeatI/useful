//! 令牌安全存储抽象与 SourceAccount 模型。
//!
//! Access/Refresh Token 绝不明文入 SQLite。SQLite 只存 SourceAccount 元信息
//! （含 credential_reference 指针），令牌本体由 `TokenStore` 保管：
//!
//! - Windows：DPAPI / Credential Manager（见客户端 `dpapi_store`）。
//! - 测试：内存实现。
//!
//! 跨源隔离：`TokenStore` 的键含 source_id，一个源无法读另一个源的凭据。

use crate::AccountError;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

/// 客户端数据库中保存的每源账户元信息（不含令牌本体）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceAccount {
    pub source_id: String,
    pub account_id: String,
    pub display_name: String,
    /// 指向 TokenStore 中凭据的引用（不是令牌本身）。
    pub credential_reference: String,
    pub scopes: Vec<String>,
    /// access token 过期的 unix 秒（用于 UI 与刷新判断）。
    pub expires_at: i64,
    pub last_authenticated_at: i64,
}

/// 令牌本体（只在内存/安全存储中流转，绝不写入 SQLite）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TokenBundle {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: i64,
}

/// 令牌安全存储抽象。实现须保证：
/// - 令牌加密/受操作系统保护，不落明文；
/// - 键隔离：`source_id` + `reference` 唯一定位，跨源不可越权读取；
/// - 不在日志/崩溃报告/导出配置中泄露。
pub trait TokenStore {
    /// 保存令牌，返回 credential_reference（供 SourceAccount 记录）。
    fn save(
        &self,
        source_id: &str,
        reference: &str,
        tokens: &TokenBundle,
    ) -> Result<(), AccountError>;
    /// 按 source_id + reference 读取（越源读取应失败或返回 None）。
    fn load(&self, source_id: &str, reference: &str) -> Result<Option<TokenBundle>, AccountError>;
    /// 删除（登出/删除源时调用）。
    fn delete(&self, source_id: &str, reference: &str) -> Result<(), AccountError>;
}

/// 内存 TokenStore（测试用）。键 = source_id + "\0" + reference，保证跨源隔离。
#[derive(Default)]
pub struct MemoryTokenStore {
    inner: Mutex<HashMap<String, TokenBundle>>,
}

impl MemoryTokenStore {
    pub fn new() -> Self {
        Self::default()
    }
    fn key(source_id: &str, reference: &str) -> String {
        format!("{source_id}\0{reference}")
    }
}

impl TokenStore for MemoryTokenStore {
    fn save(
        &self,
        source_id: &str,
        reference: &str,
        tokens: &TokenBundle,
    ) -> Result<(), AccountError> {
        let mut m = self
            .inner
            .lock()
            .map_err(|_| AccountError::Store("锁定失败".into()))?;
        m.insert(Self::key(source_id, reference), tokens.clone());
        Ok(())
    }
    fn load(&self, source_id: &str, reference: &str) -> Result<Option<TokenBundle>, AccountError> {
        let m = self
            .inner
            .lock()
            .map_err(|_| AccountError::Store("锁定失败".into()))?;
        Ok(m.get(&Self::key(source_id, reference)).cloned())
    }
    fn delete(&self, source_id: &str, reference: &str) -> Result<(), AccountError> {
        let mut m = self
            .inner
            .lock()
            .map_err(|_| AccountError::Store("锁定失败".into()))?;
        m.remove(&Self::key(source_id, reference));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bundle() -> TokenBundle {
        TokenBundle {
            access_token: "at".into(),
            refresh_token: "rt".into(),
            expires_at: 1_800_000_000,
        }
    }

    #[test]
    fn save_load_roundtrip() {
        let store = MemoryTokenStore::new();
        store.save("src.a", "ref1", &bundle()).unwrap();
        assert_eq!(store.load("src.a", "ref1").unwrap(), Some(bundle()));
    }

    #[test]
    fn cross_source_isolation() {
        // 一个源无法用自己的 source_id 读到另一个源保存的凭据
        let store = MemoryTokenStore::new();
        store.save("src.a", "ref1", &bundle()).unwrap();
        assert_eq!(store.load("src.b", "ref1").unwrap(), None);
    }

    #[test]
    fn delete_removes() {
        let store = MemoryTokenStore::new();
        store.save("src.a", "ref1", &bundle()).unwrap();
        store.delete("src.a", "ref1").unwrap();
        assert_eq!(store.load("src.a", "ref1").unwrap(), None);
    }

    #[test]
    fn source_account_has_no_token_fields() {
        // 结构性保证：SourceAccount 只存引用，不含 access/refresh token
        let acct = SourceAccount {
            source_id: "src.a".into(),
            account_id: "user-1".into(),
            display_name: "User".into(),
            credential_reference: "ref1".into(),
            scopes: vec!["downloads".into()],
            expires_at: 0,
            last_authenticated_at: 0,
        };
        let json = serde_json::to_string(&acct).unwrap();
        assert!(!json.contains("accessToken") && !json.contains("access_token"));
        assert!(!json.contains("refreshToken") && !json.contains("refresh_token"));
        assert!(json.contains("credentialReference"));
    }
}
