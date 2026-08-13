//! 多源目录合并与本地搜索。
//!
//! 规则：
//! - 合并键 = (publisherKeyId, toolId)。同 toolId 不同发布者绝不合并，并标记同名冲突。
//! - 同发布者、同 stable 摘要、不同源 → 折叠为镜像（保留优先级最高的源为主条目）。
//! - 同发布者、同 toolId、摘要不同 → 不折叠，各自保留（可疑差异必须可见）。
//! - 合并后保留来源信息；单个源的数据缺失/失败不影响其他源（调用方按源隔离）。

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

use crate::catalog::AvailabilityView;

/// 从某个源缓存读出的一条目录条目（拍平后用于搜索/展示）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogItem {
    pub source_id: String,
    /// 数值越小优先级越高。
    pub source_priority: i64,
    pub publisher_key_id: String,
    pub tool_id: String,
    pub name: String,
    pub summary: String,
    pub license: String,
    pub latest_stable: Option<String>,
    /// stable 频道最新制品摘要（镜像折叠比较键）。
    pub latest_stable_digest: Option<String>,
    pub access_mode: String,
    pub is_native_worker: bool,
    /// 以下为各独立审核/签名状态（Phase 9）：绝不合并成单一 safe 布尔。
    #[serde(default)]
    pub repository_signature_verified: bool,
    #[serde(default)]
    pub publisher_signature_verified: bool,
    #[serde(default)]
    pub official_review_passed: bool,
    #[serde(default)]
    pub security_scan_passed: bool,
    /// Catalog-provided availability is a display assertion only. It never
    /// elevates client verification booleans.
    #[serde(default)]
    pub availability: Option<AvailabilityView>,
    /// 安全公告数（>0 时 UI 展示公告横幅）。
    #[serde(default)]
    pub advisory_count: u32,
    /// 公告最高严重级别（low|medium|high|critical）。
    #[serde(default)]
    pub max_advisory_severity: Option<String>,
}

/// 合并结果条目。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergedItem {
    pub item: CatalogItem,
    /// 同发布者同摘要的其他镜像源 ID（按优先级排序）。
    pub mirror_source_ids: Vec<String>,
    /// 同 toolId 存在不同发布者（同名冲突，UI 必须并列展示发布者指纹）。
    pub name_conflict: bool,
}

/// 合并多源条目。输入可为任意源的并集；输出稳定排序（toolId, publisherKeyId, sourceId）。
pub fn merge_catalog(items: Vec<CatalogItem>) -> Vec<MergedItem> {
    // 1) 统计每个 toolId 的发布者集合（同名冲突检测）
    let mut publishers_by_tool: HashMap<&str, Vec<&str>> = HashMap::new();
    for it in &items {
        let v = publishers_by_tool.entry(it.tool_id.as_str()).or_default();
        if !v.contains(&it.publisher_key_id.as_str()) {
            v.push(it.publisher_key_id.as_str());
        }
    }
    let conflict_tools: Vec<String> = publishers_by_tool
        .iter()
        .filter(|(_, pubs)| pubs.len() > 1)
        .map(|(tool, _)| tool.to_string())
        .collect();

    // 2) 按 (publisherKeyId, toolId, digest) 折叠镜像；摘要不同则不折叠
    let mut groups: BTreeMap<(String, String, String), Vec<CatalogItem>> = BTreeMap::new();
    for it in items {
        let digest_key = it
            .latest_stable_digest
            .clone()
            .unwrap_or_else(|| format!("nodigest:{}", it.source_id));
        groups
            .entry((it.tool_id.clone(), it.publisher_key_id.clone(), digest_key))
            .or_default()
            .push(it);
    }

    let mut out: Vec<MergedItem> = Vec::with_capacity(groups.len());
    for ((tool_id, _pub, _digest), mut members) in groups {
        // 优先级最高（数值最小）的源为主条目；并列时按 sourceId 保证确定性
        members.sort_by(|a, b| {
            (a.source_priority, a.source_id.as_str())
                .cmp(&(b.source_priority, b.source_id.as_str()))
        });
        let primary = members.remove(0);
        let mirrors = members.into_iter().map(|m| m.source_id).collect();
        out.push(MergedItem {
            name_conflict: conflict_tools.contains(&tool_id),
            item: primary,
            mirror_source_ids: mirrors,
        });
    }
    out
}

/// 关键字过滤（本地搜索；大小写不敏感，匹配名称/toolId/摘要/发布者）。
pub fn filter_items(items: &[MergedItem], keyword: &str) -> Vec<MergedItem> {
    let kw = keyword.trim().to_lowercase();
    if kw.is_empty() {
        return items.to_vec();
    }
    items
        .iter()
        .filter(|m| {
            m.item.name.to_lowercase().contains(&kw)
                || m.item.tool_id.to_lowercase().contains(&kw)
                || m.item.summary.to_lowercase().contains(&kw)
                || m.item.publisher_key_id.to_lowercase().contains(&kw)
        })
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(source: &str, prio: i64, publisher: &str, tool: &str, digest: &str) -> CatalogItem {
        CatalogItem {
            source_id: source.into(),
            source_priority: prio,
            publisher_key_id: publisher.into(),
            tool_id: tool.into(),
            name: format!("Tool {tool}"),
            summary: String::new(),
            license: "Apache-2.0".into(),
            latest_stable: Some("1.0.0".into()),
            latest_stable_digest: Some(digest.into()),
            access_mode: "free".into(),
            is_native_worker: false,
            repository_signature_verified: true,
            publisher_signature_verified: false,
            official_review_passed: false,
            security_scan_passed: true,
            availability: None,
            advisory_count: 0,
            max_advisory_severity: None,
        }
    }

    #[test]
    fn same_tool_id_different_publisher_not_merged_and_flagged() {
        // 同名不同发布者不得合并
        let merged = merge_catalog(vec![
            item("src.a", 10, "ed25519:pubA", "com.x.tool", &"aa".repeat(32)),
            item("src.b", 20, "ed25519:pubB", "com.x.tool", &"bb".repeat(32)),
        ]);
        assert_eq!(merged.len(), 2);
        assert!(merged.iter().all(|m| m.name_conflict));
        assert!(merged.iter().all(|m| m.mirror_source_ids.is_empty()));
    }

    #[test]
    fn same_publisher_same_digest_folded_as_mirror() {
        // 同发布者同摘要不同镜像源可以折叠；主条目取优先级最高的源
        let merged = merge_catalog(vec![
            item(
                "src.mirror",
                50,
                "ed25519:pubA",
                "com.x.tool",
                &"aa".repeat(32),
            ),
            item(
                "src.primary",
                10,
                "ed25519:pubA",
                "com.x.tool",
                &"aa".repeat(32),
            ),
        ]);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].item.source_id, "src.primary");
        assert_eq!(merged[0].mirror_source_ids, vec!["src.mirror".to_string()]);
        assert!(!merged[0].name_conflict);
    }

    #[test]
    fn same_publisher_different_digest_not_folded() {
        // 同发布者但摘要不同 → 可疑差异必须可见，不折叠
        let merged = merge_catalog(vec![
            item("src.a", 10, "ed25519:pubA", "com.x.tool", &"aa".repeat(32)),
            item("src.b", 20, "ed25519:pubA", "com.x.tool", &"bb".repeat(32)),
        ]);
        assert_eq!(merged.len(), 2);
    }

    #[test]
    fn merge_keeps_source_info_across_three_sources() {
        // 验收：三个不同源并存，合并保留来源信息
        let merged = merge_catalog(vec![
            item("src.a", 10, "ed25519:pubA", "com.x.alpha", &"aa".repeat(32)),
            item("src.b", 20, "ed25519:pubB", "com.x.beta", &"bb".repeat(32)),
            item("src.c", 30, "ed25519:pubC", "com.x.gamma", &"cc".repeat(32)),
        ]);
        assert_eq!(merged.len(), 3);
        let sources: Vec<_> = merged.iter().map(|m| m.item.source_id.as_str()).collect();
        assert!(sources.contains(&"src.a"));
        assert!(sources.contains(&"src.b"));
        assert!(sources.contains(&"src.c"));
    }

    #[test]
    fn merge_preserves_primary_source_availability() {
        let mut primary = item(
            "src.primary",
            10,
            "ed25519:pubA",
            "com.x.tool",
            &"aa".repeat(32),
        );
        primary.availability = Some(AvailabilityView {
            status: "healthy".into(),
            checked_at: Some("2026-08-13T10:00:00Z".into()),
            source: "background-check".into(),
        });
        let merged = merge_catalog(vec![
            primary,
            item(
                "src.mirror",
                20,
                "ed25519:pubA",
                "com.x.tool",
                &"aa".repeat(32),
            ),
        ]);
        let availability = merged[0].item.availability.as_ref().unwrap();
        assert_eq!(availability.status, "healthy");
        assert_eq!(
            availability.checked_at.as_deref(),
            Some("2026-08-13T10:00:00Z")
        );
    }

    #[test]
    fn keyword_filter_matches_name_and_publisher() {
        let merged = merge_catalog(vec![
            item("src.a", 10, "ed25519:pubA", "com.x.alpha", &"aa".repeat(32)),
            item("src.b", 20, "ed25519:pubB", "com.x.beta", &"bb".repeat(32)),
        ]);
        assert_eq!(filter_items(&merged, "alpha").len(), 1);
        assert_eq!(filter_items(&merged, "pubb").len(), 1);
        assert_eq!(filter_items(&merged, "").len(), 2);
        assert_eq!(filter_items(&merged, "不存在").len(), 0);
    }
}
