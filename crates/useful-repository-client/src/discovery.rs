//! TRP v1 discovery（/.well-known/useful-repository.json）解析与校验。
//!
//! 安全模型：
//! - discovery 文件不构成信任根；`source.id` 不构成官方身份。
//! - `Capabilities` 使用 `deny_unknown_fields`：结构上不存在 appUpdate/clientUpdate
//!   等任何客户端更新能力键，普通工具源在类型层面就无法声明更新客户端。
//! - 所有 URL 默认必须 HTTPS；仅显式标记为本地/开发源时允许 127.0.0.1 / file://。
//! - 大小与字段长度设限，解析失败一律 fail closed。

use crate::RepoError;
use serde::{Deserialize, Serialize};

/// discovery 文件大小上限（防炸弹）。
pub const MAX_DISCOVERY_SIZE: usize = 256 * 1024;
/// 重定向次数上限（由网络层执行，此处导出常量以便统一）。
pub const MAX_REDIRECTS: usize = 3;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryDiscovery {
    pub schema_version: String,
    pub source: SourceMeta,
    pub repository: RepositoryMeta,
    #[serde(default)]
    pub api: Option<ApiMeta>,
    pub capabilities: Capabilities,
    #[serde(default)]
    pub auth: Option<AuthMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceMeta {
    /// 源自报 ID：仅用于展示与本地键，绝不用于确认官方身份。
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub operator: String,
    #[serde(default)]
    pub homepage: Option<String>,
    #[serde(default)]
    pub support_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryMeta {
    /// 首版仅支持 tuf-v1。
    pub profile: String,
    pub metadata_base_url: String,
    pub targets_base_url: String,
    /// 只能用于获取候选 root metadata，不构成信任。
    pub root_url: String,
    pub root_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApiMeta {
    pub base_url: String,
}

/// 源能力协商。`deny_unknown_fields` 是关键安全属性：
/// 伪造的 `appUpdate: true` 等未知键会直接导致整个 discovery 解析失败。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capabilities {
    #[serde(default)]
    pub catalog: bool,
    #[serde(default)]
    pub remote_search: bool,
    #[serde(default)]
    pub authentication: bool,
    #[serde(default)]
    pub entitlements: bool,
    #[serde(default)]
    pub paid_downloads: bool,
    #[serde(default)]
    pub publisher_portal: bool,
    #[serde(default)]
    pub private_tools: bool,
    #[serde(default)]
    pub static_mirror: bool,
    #[serde(default)]
    pub native_workers: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthMeta {
    /// 仅 oauth2-pkce。
    #[serde(rename = "type")]
    pub auth_type: String,
    pub issuer: String,
    pub client_id: String,
    pub scopes: Vec<String>,
}

/// URL 是否属于本地/开发源（127.0.0.1 loopback 或 file://）。
pub fn is_local_url(url: &str) -> bool {
    crate::network::validate_url(url, true).is_ok()
        && crate::network::validate_url(url, false).is_err()
}

fn check_url(field: &str, url: &str, allow_local: bool) -> Result<(), RepoError> {
    crate::network::validate_url(url, allow_local)
        .map(|_| ())
        .map_err(|error| RepoError::InvalidDiscovery(format!("{field}: {error}")))
}

fn is_lowercase_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 200
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '-' | '_'))
        && s.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && s.ends_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
}

pub fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64
        && s.chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

/// 解析并校验 discovery 字节。`allow_local` 仅在用户显式添加本地/开发源时为 true。
pub fn parse_discovery(bytes: &[u8], allow_local: bool) -> Result<RepositoryDiscovery, RepoError> {
    if bytes.len() > MAX_DISCOVERY_SIZE {
        return Err(RepoError::LimitExceeded(
            "discovery 文件超过大小上限".into(),
        ));
    }
    let d: RepositoryDiscovery = serde_json::from_slice(bytes)
        .map_err(|e| RepoError::InvalidDiscovery(format!("JSON 解析失败: {e}")))?;

    if d.schema_version != "1.0" {
        return Err(RepoError::InvalidDiscovery(format!(
            "不支持的 schemaVersion: {}",
            d.schema_version
        )));
    }
    if !is_lowercase_id(&d.source.id) {
        return Err(RepoError::InvalidDiscovery(
            "source.id 不是小写规范 ID".into(),
        ));
    }
    if d.source.name.is_empty() || d.source.name.len() > 200 {
        return Err(RepoError::InvalidDiscovery("source.name 长度非法".into()));
    }
    if d.source.operator.is_empty() || d.source.operator.len() > 200 {
        return Err(RepoError::InvalidDiscovery(
            "source.operator 长度非法".into(),
        ));
    }
    if d.source.description.len() > 2000 {
        return Err(RepoError::LimitExceeded("source.description 过长".into()));
    }
    if d.repository.profile != "tuf-v1" {
        return Err(RepoError::InvalidDiscovery(format!(
            "不支持的 repository.profile: {}",
            d.repository.profile
        )));
    }
    if !is_sha256_hex(&d.repository.root_sha256) {
        return Err(RepoError::InvalidDiscovery(
            "rootSha256 不是合法 SHA-256".into(),
        ));
    }
    check_url(
        "metadataBaseUrl",
        &d.repository.metadata_base_url,
        allow_local,
    )?;
    check_url(
        "targetsBaseUrl",
        &d.repository.targets_base_url,
        allow_local,
    )?;
    check_url("rootUrl", &d.repository.root_url, allow_local)?;
    if let Some(api) = &d.api {
        check_url("api.baseUrl", &api.base_url, allow_local)?;
    }
    if let Some(auth) = &d.auth {
        if auth.auth_type != "oauth2-pkce" {
            return Err(RepoError::InvalidDiscovery(
                "仅支持 oauth2-pkce 认证类型（禁止 implicit/password flow）".into(),
            ));
        }
        check_url("auth.issuer", &auth.issuer, allow_local)?;
        if auth.scopes.len() > 32 {
            return Err(RepoError::LimitExceeded("auth.scopes 数量超限".into()));
        }
    }
    Ok(d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_discovery_json() -> serde_json::Value {
        serde_json::json!({
            "schemaVersion": "1.0",
            "source": {
                "id": "com.example.static",
                "name": "示例源",
                "operator": "Example Community"
            },
            "repository": {
                "profile": "tuf-v1",
                "metadataBaseUrl": "https://static.example.com/metadata/",
                "targetsBaseUrl": "https://static.example.com/targets/",
                "rootUrl": "https://static.example.com/metadata/1.root.json",
                "rootSha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
            },
            "capabilities": { "catalog": true }
        })
    }

    #[test]
    fn valid_discovery_parses() {
        let bytes = serde_json::to_vec(&valid_discovery_json()).unwrap();
        let d = parse_discovery(&bytes, false).unwrap();
        assert_eq!(d.source.id, "com.example.static");
        assert!(d.capabilities.catalog);
        assert!(!d.capabilities.native_workers);
    }

    #[test]
    fn app_update_capability_key_is_structurally_rejected() {
        // 普通工具源尝试声明客户端更新能力 → 未知键导致整个 discovery 解析失败
        let mut v = valid_discovery_json();
        v["capabilities"]["appUpdate"] = serde_json::json!(true);
        let bytes = serde_json::to_vec(&v).unwrap();
        assert!(parse_discovery(&bytes, false).is_err());

        let mut v2 = valid_discovery_json();
        v2["capabilities"]["clientUpdate"] = serde_json::json!(true);
        assert!(parse_discovery(&serde_json::to_vec(&v2).unwrap(), false).is_err());
    }

    #[test]
    fn https_downgrade_rejected_for_non_local() {
        let mut v = valid_discovery_json();
        v["repository"]["metadataBaseUrl"] =
            serde_json::json!("http://static.example.com/metadata/");
        let bytes = serde_json::to_vec(&v).unwrap();
        assert!(parse_discovery(&bytes, false).is_err());
    }

    #[test]
    fn local_urls_allowed_only_when_flagged_local() {
        let mut v = valid_discovery_json();
        v["repository"]["metadataBaseUrl"] = serde_json::json!("http://127.0.0.1:8080/metadata/");
        v["repository"]["targetsBaseUrl"] = serde_json::json!("http://127.0.0.1:8080/targets/");
        v["repository"]["rootUrl"] =
            serde_json::json!("http://127.0.0.1:8080/metadata/1.root.json");
        let bytes = serde_json::to_vec(&v).unwrap();
        assert!(parse_discovery(&bytes, false).is_err());
        assert!(parse_discovery(&bytes, true).is_ok());
    }

    #[test]
    fn oversized_discovery_rejected() {
        let mut v = valid_discovery_json();
        v["source"]["description"] = serde_json::json!("x".repeat(MAX_DISCOVERY_SIZE));
        let bytes = serde_json::to_vec(&v).unwrap();
        assert!(matches!(
            parse_discovery(&bytes, false),
            Err(RepoError::LimitExceeded(_))
        ));
    }

    #[test]
    fn wrong_schema_version_rejected() {
        let mut v = valid_discovery_json();
        v["schemaVersion"] = serde_json::json!("2.0");
        assert!(parse_discovery(&serde_json::to_vec(&v).unwrap(), false).is_err());
    }

    #[test]
    fn invalid_root_sha256_rejected() {
        let mut v = valid_discovery_json();
        v["repository"]["rootSha256"] = serde_json::json!("ZZ86d081");
        assert!(parse_discovery(&serde_json::to_vec(&v).unwrap(), false).is_err());
    }

    #[test]
    fn implicit_flow_rejected() {
        let mut v = valid_discovery_json();
        v["auth"] = serde_json::json!({
            "type": "implicit",
            "issuer": "https://auth.example.com",
            "clientId": "useful-desktop",
            "scopes": []
        });
        assert!(parse_discovery(&serde_json::to_vec(&v).unwrap(), false).is_err());
    }

    #[test]
    fn uppercase_source_id_rejected() {
        let mut v = valid_discovery_json();
        v["source"]["id"] = serde_json::json!("Com.Example.Static");
        assert!(parse_discovery(&serde_json::to_vec(&v).unwrap(), false).is_err());
    }
}
