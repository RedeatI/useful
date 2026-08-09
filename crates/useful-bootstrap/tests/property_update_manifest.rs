//! Property 测试：客户端更新清单解析与验证（Section 八 fuzz 目标 "app update manifest"）。
//!
//! 这是最高后果的解析器——绕过即等于客户端自更新 RCE。覆盖不变量：
//! - `parse_manifest` / `verify_update` 对任意输入绝不 panic（fail closed）；
//! - **不可伪造**：对一份合法签名清单施加任意单点篡改（版本/摘要/负载/大小/
//!   签名/错误根公钥/非升级）后，验证绝不返回 Ok；
//! - 合法路径（正确签名 + 匹配负载 + 正确根公钥 + 严格升级）必然验证通过。

use ed25519_dalek::{Signer, SigningKey};
use proptest::prelude::*;
use sha2::{Digest, Sha256};
use useful_bootstrap::manifest::{parse_manifest, signing_payload, UpdateManifest};
use useful_bootstrap::verify_update;

fn key_from_seed(seed: [u8; 32]) -> SigningKey {
    SigningKey::from_bytes(&seed)
}

fn sign_manifest(payload: &[u8], version: &str, key: &SigningKey) -> UpdateManifest {
    let sha = hex::encode(Sha256::digest(payload));
    let sig = key.sign(&signing_payload(version, &sha));
    UpdateManifest {
        schema_version: 1,
        version: version.to_string(),
        sha256: sha,
        size: payload.len() as u64,
        signature: hex::encode(sig.to_bytes()),
    }
}

fn seed() -> impl Strategy<Value = [u8; 32]> {
    prop::array::uniform32(any::<u8>())
}

proptest! {
    /// 任意字节当作更新清单解析：绝不 panic，只允许 Err 或合法清单。
    #[test]
    fn parse_never_panics(bytes in prop::collection::vec(any::<u8>(), 0..8192)) {
        let _ = parse_manifest(&bytes);
    }

    /// 任意字段的清单 + 任意负载/公钥/版本：验证绝不 panic。
    #[test]
    fn verify_never_panics(
        version in ".{0,40}",
        sha256 in ".{0,80}",
        signature in ".{0,160}",
        pubkey_hex in ".{0,80}",
        size in any::<u64>(),
        payload in prop::collection::vec(any::<u8>(), 0..512),
        current in ".{0,40}",
    ) {
        let m = UpdateManifest { schema_version: 1, version, sha256, size, signature };
        let _ = verify_update(&m, &payload, &pubkey_hex, &current);
    }

    /// 合法路径必然验证通过（正确签名 + 匹配负载 + 正确根 + 严格升级）。
    #[test]
    fn valid_update_always_verifies(
        s in seed(),
        payload in prop::collection::vec(any::<u8>(), 1..4096),
        base in (0u32..50, 0u32..50, 0u32..50),
        bump in 1u32..50,
    ) {
        let key = key_from_seed(s);
        let current = format!("{}.{}.{}", base.0, base.1, base.2);
        let offered = format!("{}.{}.{}", base.0, base.1, base.2 + bump);
        let m = sign_manifest(&payload, &offered, &key);
        let pub_hex = hex::encode(key.verifying_key().to_bytes());
        prop_assert!(
            verify_update(&m, &payload, &pub_hex, &current).is_ok(),
            "合法更新未通过验证"
        );
    }

    /// 合法签名清单经序列化后可被 parse_manifest 接受。
    #[test]
    fn valid_manifest_parses(
        s in seed(),
        payload in prop::collection::vec(any::<u8>(), 1..4096),
        bump in 1u32..200,
    ) {
        let key = key_from_seed(s);
        let m = sign_manifest(&payload, &format!("0.0.{bump}"), &key);
        let json = serde_json::to_vec(&m).expect("序列化");
        let parsed = parse_manifest(&json)
            .map_err(|e| TestCaseError::fail(format!("合法清单被拒: {e}")))?;
        prop_assert_eq!(parsed.sha256, m.sha256);
        prop_assert_eq!(parsed.size, m.size);
    }

    /// 不可伪造：对合法清单施加任意单点篡改后，验证绝不返回 Ok。
    #[test]
    fn no_tampering_ever_verifies(
        s in seed(),
        wrong in seed(),
        payload in prop::collection::vec(any::<u8>(), 1..2048),
        bump in 1u32..50,
        tamper in 0u8..7,
    ) {
        let key = key_from_seed(s);
        let offered = format!("0.0.{bump}");
        let m = sign_manifest(&payload, &offered, &key);
        let pub_hex = hex::encode(key.verifying_key().to_bytes());

        // 前置健全性：未篡改必然通过
        prop_assert!(verify_update(&m, &payload, &pub_hex, "0.0.0").is_ok());

        let mut m2 = m.clone();
        let mut payload2 = payload.clone();
        let mut pub2 = pub_hex.clone();
        let mut current = "0.0.0".to_string();

        let flip_hex_first = |s: &str| -> String {
            let mut b = s.as_bytes().to_vec();
            if let Some(c) = b.first_mut() {
                *c = if *c == b'0' { b'1' } else { b'0' };
            }
            String::from_utf8(b).unwrap()
        };

        match tamper {
            0 => m2.version = format!("0.0.{}", bump + 1), // 版本改动，签名覆盖旧版本
            1 => m2.sha256 = flip_hex_first(&m2.sha256),   // 摘要改动
            2 => payload2[0] ^= 0xff,                       // 负载篡改（等长→摘要不符）
            3 => payload2.push(0),                          // 负载加长（大小不符）
            4 => m2.signature = flip_hex_first(&m2.signature), // 签名改动
            5 => {                                          // 错误的更新根公钥
                pub2 = hex::encode(key_from_seed(wrong).verifying_key().to_bytes());
                prop_assume!(pub2 != pub_hex);
            }
            _ => current = format!("0.0.{bump}"),           // current==offered → 非升级
        }

        prop_assert!(
            verify_update(&m2, &payload2, &pub2, &current).is_err(),
            "篡改类型 {tamper} 竟通过了验证（可伪造！）"
        );
    }

    /// 任意非更新根密钥（含工具源密钥）签名的清单必然验证失败（无密钥混淆）。
    #[test]
    fn only_the_update_root_key_can_verify(
        root in seed(),
        other in seed(),
        payload in prop::collection::vec(any::<u8>(), 1..1024),
        bump in 1u32..50,
    ) {
        let root_key = key_from_seed(root);
        let other_key = key_from_seed(other);
        let root_hex = hex::encode(root_key.verifying_key().to_bytes());
        prop_assume!(hex::encode(other_key.verifying_key().to_bytes()) != root_hex);

        // 用 other_key 签名，却声称由更新根 root 验证 → 必然失败
        let m = sign_manifest(&payload, &format!("0.0.{bump}"), &other_key);
        prop_assert!(verify_update(&m, &payload, &root_hex, "0.0.0").is_err());
    }
}
