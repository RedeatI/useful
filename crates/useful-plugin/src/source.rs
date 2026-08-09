//! 工具源索引数据结构与解析（静态托管，Ed25519 签名）。

use crate::error::PluginError;
use serde::{Deserialize, Serialize};

/// 源索引：静态 JSON，`signature` 覆盖去掉 signature 字段后的规范化 payload。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceIndex {
    pub source_id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub generated_at: String,
    /// Ed25519 公钥（hex）
    pub public_key: String,
    /// Ed25519 签名（hex），覆盖 canonical_payload()
    pub signature: String,
    pub packages: Vec<SourcePackage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourcePackage {
    pub id: String,
    pub version: String,
    pub package_url: String,
    pub sha256: String,
    pub size: u64,
    #[serde(default)]
    pub changelog: String,
    /// 分类（可选）。为空时不参与规范化签名 payload，保持旧索引签名兼容。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub category: String,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default = "default_min_host")]
    pub min_host_version: String,
    #[serde(default = "default_platforms")]
    pub platforms: Vec<String>,
}

fn default_min_host() -> String {
    "0.1.0".into()
}
fn default_platforms() -> Vec<String> {
    vec!["windows-x64".into()]
}

impl SourceIndex {
    /// 解析并验证签名。签名覆盖“去掉 signature 字段”的规范化 JSON。
    pub fn parse_and_verify(bytes: &[u8]) -> Result<SourceIndex, PluginError> {
        let index: SourceIndex = serde_json::from_slice(bytes)?;
        let payload = index.canonical_payload()?;
        crate::signing::verify_signature(&index.public_key, &payload, &index.signature)?;
        Ok(index)
    }

    /// 不验证签名地解析（仅用于开发者模式或本地导入的显式确认路径）。
    pub fn parse_unverified(bytes: &[u8]) -> Result<SourceIndex, PluginError> {
        Ok(serde_json::from_slice(bytes)?)
    }

    /// 规范化被签名 payload：把 signature 置空后按有序键序列化。
    pub fn canonical_payload(&self) -> Result<Vec<u8>, PluginError> {
        let mut clone = self.clone();
        clone.signature = String::new();
        // serde_json 对 struct 按字段声明顺序输出，稳定可复现
        Ok(serde_json::to_vec(&clone)?)
    }

    /// URL 协议策略校验。默认只允许 HTTPS；开发者模式额外允许 localhost/file/http。
    pub fn is_url_allowed(url: &str, developer_mode: bool) -> bool {
        if url.starts_with("https://") {
            return true;
        }
        if developer_mode {
            return url.starts_with("http://localhost")
                || url.starts_with("http://127.0.0.1")
                || url.starts_with("file://")
                || url.starts_with("http://");
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use rand::rngs::OsRng;

    fn make_signed_index() -> (String, Vec<u8>) {
        let signing = SigningKey::generate(&mut OsRng);
        let pub_hex = hex::encode(signing.verifying_key().as_bytes());
        let mut index = SourceIndex {
            source_id: "demo".into(),
            name: "示例源".into(),
            description: "测试".into(),
            generated_at: "2026-01-01T00:00:00Z".into(),
            public_key: pub_hex.clone(),
            signature: String::new(),
            packages: vec![SourcePackage {
                id: "com.example.tool".into(),
                version: "1.0.0".into(),
                package_url: "https://example.com/tool-1.0.0.useful".into(),
                sha256: "abc".into(),
                size: 100,
                changelog: "首发".into(),
                category: String::new(),
                permissions: vec![],
                min_host_version: "0.1.0".into(),
                platforms: vec!["windows-x64".into()],
            }],
        };
        let payload = index.canonical_payload().unwrap();
        let sig = signing.sign(&payload);
        index.signature = hex::encode(sig.to_bytes());
        (pub_hex, serde_json::to_vec(&index).unwrap())
    }

    #[test]
    fn verifies_signed_index() {
        let (_pub, bytes) = make_signed_index();
        let index = SourceIndex::parse_and_verify(&bytes).unwrap();
        assert_eq!(index.source_id, "demo");
        assert_eq!(index.packages.len(), 1);
    }

    #[test]
    fn rejects_tampered_index() {
        let (_pub, bytes) = make_signed_index();
        let mut index: SourceIndex = serde_json::from_slice(&bytes).unwrap();
        index.packages[0].sha256 = "tampered".into();
        let tampered = serde_json::to_vec(&index).unwrap();
        assert!(SourceIndex::parse_and_verify(&tampered).is_err());
    }

    #[test]
    fn empty_category_keeps_signature_compatible() {
        // 旧索引（无 category 字段）在新版本解析后重算 payload 必须一致
        let (_pub, bytes) = make_signed_index();
        let index = SourceIndex::parse_and_verify(&bytes).unwrap();
        assert!(index.packages[0].category.is_empty());
    }

    #[test]
    fn url_policy() {
        assert!(SourceIndex::is_url_allowed("https://a.com/x.useful", false));
        assert!(!SourceIndex::is_url_allowed("http://a.com/x.useful", false));
        assert!(SourceIndex::is_url_allowed("http://localhost:8080/x", true));
        assert!(!SourceIndex::is_url_allowed(
            "http://localhost:8080/x",
            false
        ));
    }
}
