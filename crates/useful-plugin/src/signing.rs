//! Ed25519 源索引签名验证。
//!
//! 工具源索引（source index JSON）由源维护者用 Ed25519 私钥签名，
//! 宿主用源记录中登记的公钥验证 `signature` 覆盖的规范化 payload。

use crate::error::PluginError;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};

/// 从 hex 字符串解析 Ed25519 公钥（32 字节）。
pub fn parse_public_key(hex_key: &str) -> Result<VerifyingKey, PluginError> {
    let bytes = hex::decode(hex_key.trim())
        .map_err(|e| PluginError::SignatureInvalid(format!("公钥不是合法 hex: {e}")))?;
    let arr: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| PluginError::SignatureInvalid("公钥长度必须为 32 字节".into()))?;
    VerifyingKey::from_bytes(&arr)
        .map_err(|e| PluginError::SignatureInvalid(format!("公钥非法: {e}")))
}

/// 公钥指纹：SHA-256(pubkey) 前 8 字节的 hex，分组显示便于人工核对。
pub fn public_key_fingerprint(hex_key: &str) -> Result<String, PluginError> {
    let key = parse_public_key(hex_key)?;
    let digest = crate::zip_safety::sha256_bytes(key.as_bytes());
    let short = &digest[..16];
    let grouped: Vec<String> = short
        .as_bytes()
        .chunks(4)
        .map(|c| String::from_utf8_lossy(c).to_string())
        .collect();
    Ok(grouped.join("-"))
}

/// 验证签名：`payload` 是被签名的字节，`signature_hex` 是 64 字节签名的 hex。
pub fn verify_signature(
    hex_key: &str,
    payload: &[u8],
    signature_hex: &str,
) -> Result<(), PluginError> {
    let key = parse_public_key(hex_key)?;
    let sig_bytes = hex::decode(signature_hex.trim())
        .map_err(|e| PluginError::SignatureInvalid(format!("签名不是合法 hex: {e}")))?;
    let sig_arr: [u8; 64] = sig_bytes
        .as_slice()
        .try_into()
        .map_err(|_| PluginError::SignatureInvalid("签名长度必须为 64 字节".into()))?;
    let signature = Signature::from_bytes(&sig_arr);
    key.verify(payload, &signature)
        .map_err(|_| PluginError::SignatureInvalid("签名与公钥/内容不匹配".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use rand::rngs::OsRng;

    #[test]
    fn verifies_valid_signature_and_rejects_tampered() {
        let mut csprng = OsRng;
        let signing = SigningKey::generate(&mut csprng);
        let verifying = signing.verifying_key();
        let pub_hex = hex::encode(verifying.as_bytes());

        let payload = br#"{"sourceId":"demo","packages":[]}"#;
        let sig = signing.sign(payload);
        let sig_hex = hex::encode(sig.to_bytes());

        // 合法
        assert!(verify_signature(&pub_hex, payload, &sig_hex).is_ok());

        // 篡改内容 -> 失败
        let tampered = br#"{"sourceId":"demo","packages":[1]}"#;
        assert!(verify_signature(&pub_hex, tampered, &sig_hex).is_err());

        // 篡改签名 -> 失败
        let mut bad = sig.to_bytes();
        bad[0] ^= 0xff;
        assert!(verify_signature(&pub_hex, payload, &hex::encode(bad)).is_err());
    }

    #[test]
    fn fingerprint_is_stable() {
        let mut csprng = OsRng;
        let signing = SigningKey::generate(&mut csprng);
        let pub_hex = hex::encode(signing.verifying_key().as_bytes());
        let fp1 = public_key_fingerprint(&pub_hex).unwrap();
        let fp2 = public_key_fingerprint(&pub_hex).unwrap();
        assert_eq!(fp1, fp2);
        assert!(fp1.contains('-'));
    }
}
