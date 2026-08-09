//! 官方信任根匹配。
//!
//! OfficialSource = root key fingerprint matches embedded official root trust。
//! 官方徽章绝不来自 source name / source id / URL / TLS 证书名称 / favicon / operator 文本。
//! 客户端代码不得通过硬编码域名判断官方源。

/// 全零占位指纹（Phase 6B）。真实 SHA-256 不可能为全零（抗预像），
/// 故占位期任何源都不会被识别为官方——安全 fail closed。
pub const PLACEHOLDER_ROOT_FINGERPRINT: &str =
    "0000000000000000000000000000000000000000000000000000000000000000";

/// 预置官方根指纹（编译进客户端只读资源）。
///
/// Phase 6B 占位：真实官方 TUF root 在 Owner Gate OG-1 生成后替换此列表。
/// 占位值不对应任何已发布 root，因此当前不会有任何源被识别为官方——
/// 这比"临时放宽"安全（fail closed）。
pub const OFFICIAL_ROOT_FINGERPRINTS: &[&str] = &[PLACEHOLDER_ROOT_FINGERPRINT];

/// 官方判定：仅当根指纹与预置列表精确匹配。
pub fn is_official_root(root_fingerprint: &str) -> bool {
    OFFICIAL_ROOT_FINGERPRINTS
        .iter()
        .any(|f| f.eq_ignore_ascii_case(root_fingerprint))
}

/// 供测试注入的判定函数：与 `is_official_root` 相同逻辑，但允许自定义预置列表。
pub fn is_official_root_with(embedded: &[&str], root_fingerprint: &str) -> bool {
    embedded
        .iter()
        .any(|f| f.eq_ignore_ascii_case(root_fingerprint))
}

/// 是否仍在使用占位官方根（尚未配置真实官方 TUF root）。
///
/// 为 true 时官方徽章能力实际被禁用（任何源都不会被识别为官方）。
/// 对应 Owner Gate OG-1：生产/发布前必须替换为真实根指纹。诊断/启动应
/// **显著**呈现此状态（§十三：production 发现占位值必须 fail closed 或显著拒绝）。
pub fn official_root_is_placeholder() -> bool {
    official_root_is_placeholder_with(OFFICIAL_ROOT_FINGERPRINTS)
}

/// 供测试注入：判断给定预置列表是否仍为占位（空列表或全部为全零占位）。
pub fn official_root_is_placeholder_with(embedded: &[&str]) -> bool {
    embedded.is_empty()
        || embedded
            .iter()
            .all(|f| f.eq_ignore_ascii_case(PLACEHOLDER_ROOT_FINGERPRINT))
}

#[cfg(test)]
mod tests {
    use super::*;

    const OFFICIAL: &str = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    const OTHER: &str = "c0535e4be2b79ffd93291305436bf889314e4a3faec05ecffcbb7df31ad9e51a";

    #[test]
    fn official_only_by_fingerprint_match() {
        assert!(is_official_root_with(&[OFFICIAL], OFFICIAL));
        assert!(!is_official_root_with(&[OFFICIAL], OTHER));
    }

    #[test]
    fn fake_official_source_gets_no_badge() {
        // 伪官方源：自报 id/name/operator 全是"官方"，但指纹不匹配 → 不是官方。
        // 判定函数签名根本不接受 name/id/url——结构上无法用它们冒充。
        let claimed_id = "org.useful.official";
        let claimed_name = "Useful Official Source";
        let _ = (claimed_id, claimed_name); // 这些字段与官方判定无关
        assert!(!is_official_root_with(&[OFFICIAL], OTHER));
    }

    #[test]
    fn placeholder_fingerprint_matches_nothing_real() {
        // 6B 占位指纹不会匹配任何真实 root 摘要（fail closed）
        assert!(!is_official_root(OFFICIAL));
        assert!(!is_official_root(OTHER));
    }

    #[test]
    fn fingerprint_match_case_insensitive() {
        assert!(is_official_root_with(&[OFFICIAL], &OFFICIAL.to_uppercase()));
    }
}
