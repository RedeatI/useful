//! Property 测试：catalog 快照与 discovery 解析器（Section 八 fuzz/property 目标）。
//!
//! 覆盖不变量：
//! - 任意字节输入解析器绝不 panic（fail closed）；
//! - 合法快照解析后条目数量与身份完整保留（同 toolId 不同发布者绝不合并）；
//! - sourceId 不一致必然拒绝（防串源缓存投毒）；
//! - `latest_stable_digest` 绝不返回已撤回制品的摘要；
//! - `is_sha256_hex` 与参考实现语义一致；
//! - `max_advisory_severity` 与公告顺序无关。

use proptest::prelude::*;
use useful_repository_client::catalog::{
    latest_stable_digest, max_advisory_severity, parse_catalog, AdvisoryView,
};
use useful_repository_client::discovery::{is_sha256_hex, parse_discovery};

// ---------- 生成器 ----------

fn hex64() -> impl Strategy<Value = String> {
    prop::collection::vec(0u8..16, 64).prop_map(|v| {
        v.into_iter()
            .map(|n| char::from_digit(n as u32, 16).unwrap())
            .collect()
    })
}

fn source_id_strategy() -> impl Strategy<Value = String> {
    prop::collection::vec("[a-z][a-z0-9]{0,8}", 2..4).prop_map(|segs| segs.join("."))
}

fn access_mode() -> impl Strategy<Value = &'static str> {
    prop_oneof![
        Just("free"),
        Just("entitlement"),
        Just("external-purchase"),
        Just("private"),
        Just("unavailable"),
    ]
}

/// 单个合法条目（可控 withdrawn 状态）。
fn entry_json(
    publisher: &str,
    tool_id: &str,
    digest: &str,
    mode: &str,
    withdrawn: bool,
) -> serde_json::Value {
    serde_json::json!({
        "identity": { "publisherKeyId": publisher, "toolId": tool_id },
        "name": "Tool",
        "channels": ["stable"],
        "latest": { "stable": "1.0.0" },
        "artifacts": [{
            "version": "1.0.0",
            "channel": "stable",
            "platform": "windows",
            "arch": "x86_64",
            "artifactSha256": digest,
            "manifestDigest": digest,
            "size": 1,
            "permissions": [],
            "withdrawn": withdrawn
        }],
        "offer": { "accessMode": mode }
    })
}

fn snapshot_json(source_id: &str, entries: Vec<serde_json::Value>) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "schemaVersion": "1.0",
        "sourceId": source_id,
        "generatedAt": "2026-07-31T00:00:00Z",
        "entries": entries
    }))
    .unwrap()
}

// ---------- 解析器绝不 panic ----------

proptest! {
    #[test]
    fn parse_catalog_never_panics(bytes in prop::collection::vec(any::<u8>(), 0..2048)) {
        let _ = parse_catalog(&bytes, "com.example.static");
    }

    #[test]
    fn parse_discovery_never_panics(bytes in prop::collection::vec(any::<u8>(), 0..2048)) {
        let _ = parse_discovery(&bytes, false);
        let _ = parse_discovery(&bytes, true);
    }
}

// ---------- catalog 语义不变量 ----------

proptest! {
    /// 合法快照必然解析成功；条目数与身份完整保留，同 toolId 不同发布者绝不合并。
    #[test]
    fn valid_snapshot_preserves_identities(
        source_id in source_id_strategy(),
        publishers in prop::collection::hash_set("[a-f0-9]{8}", 1..6),
        tool_id in "[a-z]{3,10}",
        digest in hex64(),
        mode in access_mode(),
    ) {
        // 同一个 toolId，多个不同发布者 → 条目必须逐一保留
        let entries: Vec<_> = publishers
            .iter()
            .map(|p| entry_json(
                &format!("ed25519:{p}"),
                &format!("com.example.{tool_id}"),
                &digest,
                mode,
                false,
            ))
            .collect();
        let bytes = snapshot_json(&source_id, entries);
        let snap = parse_catalog(&bytes, &source_id)
            .map_err(|e| TestCaseError::fail(format!("合法快照被拒绝: {e}")))?;
        prop_assert_eq!(snap.entries.len(), publishers.len());
        let unique: std::collections::HashSet<_> =
            snap.entries.iter().map(|e| e.identity.clone()).collect();
        prop_assert_eq!(unique.len(), publishers.len(), "身份被合并或丢失");
    }

    /// 快照自报 sourceId 与所属源不一致必然被拒绝（防串源缓存投毒）。
    #[test]
    fn source_id_mismatch_always_rejected(
        a in source_id_strategy(),
        b in source_id_strategy(),
        digest in hex64(),
    ) {
        prop_assume!(a != b);
        let bytes = snapshot_json(&a, vec![entry_json("ed25519:aa", "com.x.t", &digest, "free", false)]);
        prop_assert!(parse_catalog(&bytes, &b).is_err());
    }

    /// 非法摘要（长度/字符/大写）必然被拒绝。
    #[test]
    fn invalid_digest_always_rejected(
        source_id in source_id_strategy(),
        bad_digest in prop_oneof![
            "[a-f0-9]{0,63}",              // 过短
            "[a-f0-9]{65,80}",             // 过长
            "[A-F0-9]{64}",                // 大写
            "[g-z]{64}",                   // 非 hex
        ],
    ) {
        prop_assume!(!is_sha256_hex(&bad_digest));
        let bytes = snapshot_json(
            &source_id,
            vec![entry_json("ed25519:aa", "com.x.t", &bad_digest, "free", false)],
        );
        prop_assert!(parse_catalog(&bytes, &source_id).is_err());
    }

    /// latest_stable_digest 绝不返回已撤回制品的摘要。
    #[test]
    fn withdrawn_artifact_never_selected(
        source_id in source_id_strategy(),
        digest in hex64(),
        withdrawn in any::<bool>(),
    ) {
        let bytes = snapshot_json(
            &source_id,
            vec![entry_json("ed25519:aa", "com.x.t", &digest, "free", withdrawn)],
        );
        let snap = parse_catalog(&bytes, &source_id).unwrap();
        let got = latest_stable_digest(&snap.entries[0]);
        if withdrawn {
            prop_assert_eq!(got, None, "撤回制品仍被选中");
        } else {
            prop_assert_eq!(got, Some(digest.as_str()));
        }
    }
}

// ---------- is_sha256_hex 与参考实现一致 ----------

proptest! {
    #[test]
    fn sha256_hex_matches_reference(s in "[a-fA-F0-9]{0,80}") {
        let reference = s.len() == 64
            && s.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'));
        prop_assert_eq!(is_sha256_hex(&s), reference);
    }

    #[test]
    fn sha256_hex_arbitrary_never_panics(s in "\\PC{0,100}") {
        let _ = is_sha256_hex(&s);
    }
}

// ---------- 公告严重级别与顺序无关 ----------

proptest! {
    #[test]
    fn advisory_severity_is_order_invariant(
        severities in prop::collection::vec(
            prop_oneof![
                Just("critical"), Just("high"), Just("medium"), Just("low"), Just("bogus")
            ],
            0..8,
        ),
    ) {
        let make = |list: &[&str]| -> Vec<AdvisoryView> {
            list.iter()
                .map(|s| AdvisoryView {
                    severity: s.to_string(),
                    summary: "x".into(),
                    affected_versions: vec![],
                    created_at: None,
                })
                .collect()
        };
        fn rank(s: Option<&String>) -> u8 {
            match s.map(|s| s.as_str()) {
                Some("critical") => 4,
                Some("high") => 3,
                Some("medium") => 2,
                Some("low") => 1,
                Some(_) => 0,
                None => 0,
            }
        }
        let forward = max_advisory_severity(&make(&severities));
        let mut reversed_input = severities.clone();
        reversed_input.reverse();
        let backward = max_advisory_severity(&make(&reversed_input));
        // 最高级别的等级必须与顺序无关
        prop_assert_eq!(rank(forward.as_ref()), rank(backward.as_ref()));
        // 空输入返回 None，非空必有值
        prop_assert_eq!(forward.is_none(), severities.is_empty());
    }
}
