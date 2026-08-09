//! Property 测试：官方信任根匹配（trust）与来源/发布者固定（pinning）。
//!
//! 这两者是软件源接管的核心防线（ADR-007/008）。核心不变量：
//! - **官方徽章只由指纹精确匹配决定**：`is_official_root_with` 为 true 当且仅当
//!   指纹（不区分大小写）精确出现在预置列表中——绝不模糊匹配；
//! - **占位检测正确**：全零占位（或空列表）→ placeholder；含任一真实指纹 → 非占位；
//! - **反接管**：候选与已装来源在 sourceId/publisherKeyId/toolId 任一不同 → 必拒绝；
//! - **Allow 蕴含安全前提**：任何 Allow 决策都蕴含同源、同发布者、同工具、同频道、
//!   且候选版本严格高于已装版本。

use proptest::prelude::*;
use useful_repository_client::pinning::{
    evaluate_update, InstalledOrigin, UpdateCandidate, UpdateDecision,
};
use useful_repository_client::trust::{
    is_official_root_with, official_root_is_placeholder_with, PLACEHOLDER_ROOT_FINGERPRINT,
};

fn hex64() -> impl Strategy<Value = String> {
    prop::collection::vec(0u8..16, 64).prop_map(|v| {
        v.into_iter()
            .map(|n| char::from_digit(n as u32, 16).unwrap())
            .collect()
    })
}

// ---------- trust：官方徽章只由指纹精确匹配 ----------

proptest! {
    /// is_official_root_with 与"精确（不区分大小写）成员"oracle 完全一致。
    #[test]
    fn official_iff_exact_member(
        embedded in prop::collection::vec(hex64(), 0..6),
        probe in hex64(),
    ) {
        let refs: Vec<&str> = embedded.iter().map(|s| s.as_str()).collect();
        let oracle = embedded.iter().any(|f| f.eq_ignore_ascii_case(&probe));
        prop_assert_eq!(is_official_root_with(&refs, &probe), oracle);
    }

    /// 列表成员（任意大小写变体）必然被认作官方；改动任一字符后除非仍是别的成员否则不被认作官方。
    #[test]
    fn member_matches_case_insensitive(
        embedded in prop::collection::vec(hex64(), 1..6),
        idx in 0usize..6,
    ) {
        let refs: Vec<&str> = embedded.iter().map(|s| s.as_str()).collect();
        let pick = &embedded[idx % embedded.len()];
        prop_assert!(is_official_root_with(&refs, &pick.to_uppercase()));
        prop_assert!(is_official_root_with(&refs, &pick.to_lowercase()));
    }

    /// 非成员指纹绝不被认作官方（不模糊匹配）。
    #[test]
    fn non_member_never_official(
        embedded in prop::collection::vec(hex64(), 0..6),
        probe in hex64(),
    ) {
        prop_assume!(!embedded.iter().any(|f| f.eq_ignore_ascii_case(&probe)));
        let refs: Vec<&str> = embedded.iter().map(|s| s.as_str()).collect();
        prop_assert!(!is_official_root_with(&refs, &probe));
    }

    /// 占位检测：空列表或全部为全零占位 → placeholder；含任一真实指纹 → 非占位。
    #[test]
    fn placeholder_detection(reals in prop::collection::vec(hex64(), 0..4)) {
        // 只保留真正非占位的项（随机 hex 极小概率等于全零，过滤掉以稳定断言）
        let reals: Vec<String> = reals
            .into_iter()
            .filter(|s| !s.eq_ignore_ascii_case(PLACEHOLDER_ROOT_FINGERPRINT))
            .collect();

        // 纯占位列表 → true
        let only_ph = vec![PLACEHOLDER_ROOT_FINGERPRINT];
        prop_assert!(official_root_is_placeholder_with(&only_ph));
        // 空列表 → true（无官方根 = fail closed）
        prop_assert!(official_root_is_placeholder_with(&[]));

        // 含任一真实指纹 → false
        if !reals.is_empty() {
            let mut mixed: Vec<&str> = vec![PLACEHOLDER_ROOT_FINGERPRINT];
            mixed.extend(reals.iter().map(|s| s.as_str()));
            prop_assert!(!official_root_is_placeholder_with(&mixed));
        }
    }
}

// ---------- pinning：反接管不变量 ----------

fn origin() -> InstalledOrigin {
    InstalledOrigin {
        source_id: "com.example.a".into(),
        publisher_key_id: "ed25519:pubkeyA".into(),
        tool_id: "com.example.tool".into(),
        installed_version: "1.2.0".into(),
        artifact_sha256: "aa".repeat(32),
        channel: "stable".into(),
        manifest_digest: "bb".repeat(32),
    }
}

/// 候选生成器：以合法基线为主，各字段可独立取"相同/不同"，覆盖跨源/换钥/换工具/换频道等。
fn candidate_strategy() -> impl Strategy<Value = UpdateCandidate> {
    (
        prop_oneof![Just("com.example.a".to_string()), "[a-z.]{3,12}"],
        prop_oneof![Just("ed25519:pubkeyA".to_string()), "ed25519:[a-z]{4,10}"],
        prop_oneof![Just("com.example.tool".to_string()), "[a-z.]{3,12}"],
        prop_oneof![
            Just("1.3.0".to_string()),
            Just("1.1.0".to_string()),
            Just("1.2.0".to_string()),
            Just("2.0.0".to_string()),
            "[0-9]{1,2}\\.[0-9]{1,2}\\.[0-9]{1,2}",
            "not-semver",
        ],
        prop_oneof![Just("stable".to_string()), Just("beta".to_string())],
        prop::collection::vec(
            prop_oneof![
                Just("dialog.open".to_string()),
                Just("fs.write".to_string())
            ],
            0..3,
        ),
    )
        .prop_map(
            |(source_id, publisher_key_id, tool_id, version, channel, permissions)| {
                UpdateCandidate {
                    source_id,
                    publisher_key_id,
                    tool_id,
                    version,
                    artifact_sha256: "cc".repeat(32),
                    channel,
                    permissions,
                }
            },
        )
}

proptest! {
    /// 反接管：sourceId/publisherKeyId/toolId 任一与已装来源不同 → 必然 Reject（绝不 Allow）。
    #[test]
    fn cross_identity_never_allowed(cand in candidate_strategy()) {
        let o = origin();
        let differs = cand.source_id != o.source_id
            || cand.publisher_key_id != o.publisher_key_id
            || cand.tool_id != o.tool_id;
        let decision = evaluate_update(&o, &cand, &[]);
        if differs {
            prop_assert!(
                matches!(decision, UpdateDecision::Reject { .. }),
                "跨源/换钥/换工具候选竟被允许：{cand:?}"
            );
        }
    }

    /// Allow 蕴含全部安全前提：同源、同发布者、同工具、同频道、候选版本严格更高。
    #[test]
    fn allow_implies_all_safety_preconditions(cand in candidate_strategy()) {
        let o = origin();
        if let UpdateDecision::Allow { .. } = evaluate_update(&o, &cand, &[]) {
            prop_assert_eq!(&cand.source_id, &o.source_id);
            prop_assert_eq!(&cand.publisher_key_id, &o.publisher_key_id);
            prop_assert_eq!(&cand.tool_id, &o.tool_id);
            prop_assert_eq!(&cand.channel, &o.channel);
            let cur = semver::Version::parse(&o.installed_version).unwrap();
            let cand_v = semver::Version::parse(&cand.version)
                .map_err(|_| TestCaseError::fail("Allow 却版本非法"))?;
            prop_assert!(cand_v > cur, "Allow 却非严格升级");
        }
    }

    /// evaluate_update 对任意候选绝不 panic。
    #[test]
    fn evaluate_never_panics(cand in candidate_strategy()) {
        let _ = evaluate_update(&origin(), &cand, &[]);
    }
}
