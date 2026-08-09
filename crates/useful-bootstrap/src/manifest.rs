//! 更新清单验证：签名/摘要/长度/版本，全部 fail closed。
//!
//! 签名载荷 = "useful-app-update-v1\n<version>\n<sha256>"，域前缀与工具制品
//! 签名（useful-artifact-v1）不同：即使密钥被混用，签名也无法跨域重放。

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// 更新包大小上限（512 MB）。
pub const MAX_UPDATE_SIZE: u64 = 512 << 20;

#[derive(Debug, thiserror::Error)]
pub enum VerifyError {
    #[error("清单解析失败: {0}")]
    Parse(String),
    #[error("清单字段非法: {0}")]
    Invalid(String),
    #[error("更新包大小与清单不符（清单 {expected}，实际 {actual}）")]
    SizeMismatch { expected: u64, actual: u64 },
    #[error("更新包 SHA-256 与清单不符")]
    DigestMismatch,
    #[error("更新签名验证失败：拒绝应用（签名密钥不是客户端更新根）")]
    BadSignature,
    #[error("版本不是升级（当前 {current}，清单 {offered}）")]
    NotAnUpgrade { current: String, offered: String },
}

/// 客户端更新清单（update/pending/update-manifest.json）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateManifest {
    pub schema_version: u32,
    /// 新版本（SemVer）。
    pub version: String,
    /// payload.zip 的 SHA-256（hex）。
    pub sha256: String,
    /// payload.zip 字节数。
    pub size: u64,
    /// 客户端更新根私钥对签名载荷的 Ed25519 签名（hex）。
    pub signature: String,
}

/// 构造签名载荷（域前缀防跨域重放）。
pub fn signing_payload(version: &str, sha256: &str) -> Vec<u8> {
    format!("useful-app-update-v1\n{version}\n{}", sha256.to_lowercase()).into_bytes()
}

pub fn parse_manifest(raw: &[u8]) -> Result<UpdateManifest, VerifyError> {
    if raw.len() > 64 * 1024 {
        return Err(VerifyError::Invalid("清单文件过大".into()));
    }
    let m: UpdateManifest =
        serde_json::from_slice(raw).map_err(|e| VerifyError::Parse(e.to_string()))?;
    if m.schema_version != 1 {
        return Err(VerifyError::Invalid("不支持的 schemaVersion".into()));
    }
    semver::Version::parse(&m.version)
        .map_err(|_| VerifyError::Invalid("version 不是合法 SemVer".into()))?;
    if m.sha256.len() != 64 || hex::decode(&m.sha256).is_err() {
        return Err(VerifyError::Invalid("sha256 非法".into()));
    }
    if m.size == 0 || m.size > MAX_UPDATE_SIZE {
        return Err(VerifyError::Invalid("size 非法或超限".into()));
    }
    Ok(m)
}

/// 验证更新：版本必须严格升级；payload 长度/摘要与清单一致；
/// 签名必须由客户端更新根公钥验证通过（工具源密钥必然失败）。
pub fn verify_update(
    manifest: &UpdateManifest,
    payload: &[u8],
    update_root_pubkey_hex: &str,
    current_version: &str,
) -> Result<(), VerifyError> {
    let offered = semver::Version::parse(&manifest.version)
        .map_err(|_| VerifyError::Invalid("version 非法".into()))?;
    let current = semver::Version::parse(current_version)
        .map_err(|_| VerifyError::Invalid("当前版本号非法".into()))?;
    if offered <= current {
        return Err(VerifyError::NotAnUpgrade {
            current: current.to_string(),
            offered: offered.to_string(),
        });
    }
    if payload.len() as u64 != manifest.size {
        return Err(VerifyError::SizeMismatch {
            expected: manifest.size,
            actual: payload.len() as u64,
        });
    }
    let digest = hex::encode(Sha256::digest(payload));
    if !digest.eq_ignore_ascii_case(&manifest.sha256) {
        return Err(VerifyError::DigestMismatch);
    }
    let pub_raw: [u8; 32] = hex::decode(update_root_pubkey_hex)
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or_else(|| VerifyError::Invalid("更新根公钥非法".into()))?;
    let vk = VerifyingKey::from_bytes(&pub_raw).map_err(|_| VerifyError::BadSignature)?;
    let sig_raw: [u8; 64] = hex::decode(&manifest.signature)
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or(VerifyError::BadSignature)?;
    let sig = Signature::from_bytes(&sig_raw);
    vk.verify(&signing_payload(&manifest.version, &manifest.sha256), &sig)
        .map_err(|_| VerifyError::BadSignature)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use rand::rngs::OsRng;

    fn signed_manifest(payload: &[u8], version: &str, key: &SigningKey) -> UpdateManifest {
        let sha = hex::encode(Sha256::digest(payload));
        let sig = key.sign(&signing_payload(version, &sha));
        UpdateManifest {
            schema_version: 1,
            version: version.into(),
            sha256: sha,
            size: payload.len() as u64,
            signature: hex::encode(sig.to_bytes()),
        }
    }

    #[test]
    fn valid_update_verifies() {
        let key = SigningKey::generate(&mut OsRng);
        let payload = b"new useful build";
        let m = signed_manifest(payload, "0.2.0", &key);
        let pub_hex = hex::encode(key.verifying_key().to_bytes());
        verify_update(&m, payload, &pub_hex, "0.1.0").unwrap();
    }

    #[test]
    fn bad_signature_rejected() {
        // 验收：客户端更新包签名错误时拒绝
        let key = SigningKey::generate(&mut OsRng);
        let payload = b"new useful build";
        let mut m = signed_manifest(payload, "0.2.0", &key);
        m.signature = "ab".repeat(64);
        let pub_hex = hex::encode(key.verifying_key().to_bytes());
        assert!(matches!(
            verify_update(&m, payload, &pub_hex, "0.1.0"),
            Err(VerifyError::BadSignature)
        ));
    }

    #[test]
    fn tool_source_key_cannot_update_client() {
        // 验收：工具源无法更新 Useful.exe——工具源的发布者密钥
        // 签出的"更新"在客户端更新信任域必然验签失败。
        let update_root = SigningKey::generate(&mut OsRng);
        let tool_source_key = SigningKey::generate(&mut OsRng); // 工具源密钥
        let payload = b"malicious useful from tool source";
        let m = signed_manifest(payload, "99.0.0", &tool_source_key);
        let update_root_hex = hex::encode(update_root.verifying_key().to_bytes());
        assert!(matches!(
            verify_update(&m, payload, &update_root_hex, "0.1.0"),
            Err(VerifyError::BadSignature)
        ));
    }

    #[test]
    fn cross_domain_signature_rejected() {
        // 同一把密钥给工具制品域（useful-artifact-v1）签的名不能在更新域重放
        let key = SigningKey::generate(&mut OsRng);
        let payload = b"payload";
        let sha = hex::encode(Sha256::digest(payload));
        let artifact_sig = key.sign(format!("useful-artifact-v1\ntool\n0.2.0\n{sha}").as_bytes());
        let m = UpdateManifest {
            schema_version: 1,
            version: "0.2.0".into(),
            sha256: sha,
            size: payload.len() as u64,
            signature: hex::encode(artifact_sig.to_bytes()),
        };
        let pub_hex = hex::encode(key.verifying_key().to_bytes());
        assert!(matches!(
            verify_update(&m, payload, &pub_hex, "0.1.0"),
            Err(VerifyError::BadSignature)
        ));
    }

    #[test]
    fn digest_and_size_mismatch_rejected() {
        let key = SigningKey::generate(&mut OsRng);
        let payload = b"new useful build";
        let m = signed_manifest(payload, "0.2.0", &key);
        let pub_hex = hex::encode(key.verifying_key().to_bytes());
        assert!(matches!(
            verify_update(&m, b"tampered!", &pub_hex, "0.1.0"),
            Err(VerifyError::SizeMismatch { .. })
        ));
        let mut same_len = payload.to_vec();
        same_len[0] ^= 0xff;
        assert!(matches!(
            verify_update(&m, &same_len, &pub_hex, "0.1.0"),
            Err(VerifyError::DigestMismatch)
        ));
    }

    #[test]
    fn downgrade_rejected() {
        // 回滚攻击防护：更新版本必须严格高于当前版本
        let key = SigningKey::generate(&mut OsRng);
        let payload = b"old build";
        let m = signed_manifest(payload, "0.1.0", &key);
        let pub_hex = hex::encode(key.verifying_key().to_bytes());
        assert!(matches!(
            verify_update(&m, payload, &pub_hex, "0.1.0"),
            Err(VerifyError::NotAnUpgrade { .. })
        ));
    }

    #[test]
    fn manifest_limits_enforced() {
        assert!(parse_manifest(&vec![b' '; 128 * 1024]).is_err());
        assert!(parse_manifest(br#"{"schemaVersion":2}"#).is_err());
    }
}
