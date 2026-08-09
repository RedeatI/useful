//! 目录快照（catalog snapshot）解析与限额校验。
//!
//! 快照供本地缓存与多源本地搜索使用；条目身份为 toolIdentity =
//! publisherKeyId + toolId。同名（toolId 相同）不同发布者的条目绝不合并。

use crate::discovery::is_sha256_hex;
use crate::RepoError;
use serde::{Deserialize, Serialize};

/// 快照文件大小上限（10 万条目录目标下的保守值）。
pub const MAX_CATALOG_SIZE: usize = 64 * 1024 * 1024;
/// 快照条目数上限。
pub const MAX_CATALOG_ENTRIES: usize = 100_000;
/// 单条目制品数上限（与 schema 一致）。
pub const MAX_ARTIFACTS_PER_ENTRY: usize = 4096;

/// 单条目公告数上限（与 schema 一致）。
pub const MAX_ADVISORIES_PER_ENTRY: usize = 128;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogSnapshot {
    pub schema_version: String,
    pub source_id: String,
    pub generated_at: String,
    pub entries: Vec<CatalogEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
// 兼容策略（ADR-012）：catalog 条目是可演进的数据——条目级结构允许未知字段
// （新源可能携带新增可选字段，旧客户端必须能继续解析）；
// 安全相关的锁定结构（identity、artifact 摘要）仍严格拒绝未知字段。
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub identity: ToolIdentity,
    pub name: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub license: String,
    pub channels: Vec<String>,
    /// 各频道最新版本指针。版本全部撤回但有公告的条目可为空。
    #[serde(default)]
    pub latest: LatestVersions,
    #[serde(default)]
    pub artifacts: Vec<ArtifactInfo>,
    pub offer: CatalogOffer,
    #[serde(default)]
    pub review: Option<ReviewStatus>,
    #[serde(default)]
    pub is_native_worker: bool,
    /// 可用性视图：源后台健康检查推导（带时间戳；缺失/过期视为 unknown）。
    #[serde(default)]
    pub availability: Option<AvailabilityView>,
    /// 复现构建视图：作者声明与官方验证严格分离。
    #[serde(default)]
    pub reproducible_build: Option<ReproducibleBuildView>,
    /// 条目级安全公告轻量视图（已安装用户可见）。
    #[serde(default)]
    pub advisories: Vec<AdvisoryView>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

/// ToolIdentity = PublisherKeyId + ToolId。禁止仅用 ToolId 作为全局身份。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolIdentity {
    pub publisher_key_id: String,
    pub tool_id: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LatestVersions {
    #[serde(default)]
    pub stable: Option<String>,
    #[serde(default)]
    pub beta: Option<String>,
    #[serde(default)]
    pub nightly: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactInfo {
    pub version: String,
    pub channel: String,
    pub platform: String,
    pub arch: String,
    pub artifact_sha256: String,
    pub manifest_digest: String,
    pub size: u64,
    pub permissions: Vec<String>,
    #[serde(default)]
    pub published_at: Option<String>,
    #[serde(default)]
    pub withdrawn: bool,
    /// 发布者签名验证状态（与软件源 TUF 验证分离，独立字段）。
    #[serde(default)]
    pub publisher_signature_verified: bool,
    /// Catalog assertion only; installation re-verifies the TUF-bound proof.
    #[serde(default)]
    pub signature_method: Option<String>,
    /// Optional signing identity display value. Never a trust decision alone.
    #[serde(default)]
    pub signature_identity: Option<String>,
}

/// 条目级安全公告视图（完整公告见 security-advisory schema）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdvisoryView {
    pub severity: String,
    pub summary: String,
    #[serde(default)]
    pub affected_versions: Vec<String>,
    #[serde(default)]
    pub created_at: Option<String>,
}

/// CatalogOffer：商业信息载体（可变），绝不进入不可变 package manifest。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogOffer {
    pub access_mode: String,
    #[serde(default)]
    pub product_id: Option<String>,
    #[serde(default)]
    pub plan_ids: Vec<String>,
    #[serde(default)]
    pub purchase_url: Option<String>,
}

/// 各独立审核/签名状态，禁止混成单一 safe 布尔。
// 允许未知字段：review 是可扩展状态集（新增状态不得破坏旧客户端）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewStatus {
    #[serde(default)]
    pub repository_signature_verified: bool,
    #[serde(default)]
    pub publisher_signature_verified: bool,
    #[serde(default)]
    pub official_review_passed: bool,
    #[serde(default)]
    pub security_scan_passed: bool,
    #[serde(default)]
    pub source_available: bool,
    #[serde(default)]
    pub reproducible_build_verified: bool,
}

/// 可用性视图（UI 应展示状态、最后检查时间与状态来源）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailabilityView {
    /// unknown | healthy | degraded | unavailable（未知值按 unknown 处理）
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub checked_at: Option<String>,
    /// 状态来源（如 background-check）
    #[serde(default)]
    pub source: String,
}

/// 复现构建视图（UI 应将作者声明 claimed 与官方 verified 分开展示）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReproducibleBuildView {
    /// unknown | claimed | verification-pending | verified | failed
    #[serde(default)]
    pub status: String,
    /// dual-build | provenance（verified 时存在）
    #[serde(default)]
    pub strategy: String,
}

const ACCESS_MODES: &[&str] = &[
    "free",
    "entitlement",
    "external-purchase",
    "private",
    "unavailable",
];

/// 解析并校验目录快照。`expected_source_id` 必须与快照自报一致（防串源缓存投毒）。
pub fn parse_catalog(bytes: &[u8], expected_source_id: &str) -> Result<CatalogSnapshot, RepoError> {
    if bytes.len() > MAX_CATALOG_SIZE {
        return Err(RepoError::LimitExceeded("目录快照超过大小上限".into()));
    }
    let snap: CatalogSnapshot = serde_json::from_slice(bytes)
        .map_err(|e| RepoError::InvalidCatalog(format!("JSON 解析失败: {e}")))?;
    if snap.schema_version != "1.0" {
        return Err(RepoError::InvalidCatalog(format!(
            "不支持的 schemaVersion: {}",
            snap.schema_version
        )));
    }
    if snap.source_id != expected_source_id {
        return Err(RepoError::InvalidCatalog(format!(
            "快照 sourceId ({}) 与所属源 ({expected_source_id}) 不一致",
            snap.source_id
        )));
    }
    if snap.entries.len() > MAX_CATALOG_ENTRIES {
        return Err(RepoError::LimitExceeded("目录条目数超限".into()));
    }
    for e in &snap.entries {
        if e.name.is_empty() || e.name.len() > 200 {
            return Err(RepoError::InvalidCatalog(format!(
                "条目 {} 名称长度非法",
                e.identity.tool_id
            )));
        }
        if e.artifacts.len() > MAX_ARTIFACTS_PER_ENTRY {
            return Err(RepoError::LimitExceeded(format!(
                "条目 {} 制品数超限",
                e.identity.tool_id
            )));
        }
        if e.advisories.len() > MAX_ADVISORIES_PER_ENTRY {
            return Err(RepoError::LimitExceeded(format!(
                "条目 {} 公告数超限",
                e.identity.tool_id
            )));
        }
        if !ACCESS_MODES.contains(&e.offer.access_mode.as_str()) {
            return Err(RepoError::InvalidCatalog(format!(
                "条目 {} accessMode 非法: {}",
                e.identity.tool_id, e.offer.access_mode
            )));
        }
        for a in &e.artifacts {
            if !is_sha256_hex(&a.artifact_sha256) || !is_sha256_hex(&a.manifest_digest) {
                return Err(RepoError::InvalidCatalog(format!(
                    "条目 {} 摘要格式非法",
                    e.identity.tool_id
                )));
            }
            if semver::Version::parse(&a.version).is_err() {
                return Err(RepoError::InvalidCatalog(format!(
                    "条目 {} 版本非法: {}",
                    e.identity.tool_id, a.version
                )));
            }
        }
    }
    Ok(snap)
}

/// 取条目 stable 频道最新制品摘要（用于镜像折叠比较）。
pub fn latest_stable_digest(entry: &CatalogEntry) -> Option<&str> {
    let stable = entry.latest.stable.as_deref()?;
    entry
        .artifacts
        .iter()
        .find(|a| a.channel == "stable" && a.version == stable && !a.withdrawn)
        .map(|a| a.artifact_sha256.as_str())
}

/// 公告最高严重级别（critical > high > medium > low；未知级别视为最低）。
pub fn max_advisory_severity(advisories: &[AdvisoryView]) -> Option<String> {
    fn rank(s: &str) -> u8 {
        match s {
            "critical" => 4,
            "high" => 3,
            "medium" => 2,
            "low" => 1,
            _ => 0,
        }
    }
    advisories
        .iter()
        .max_by_key(|a| rank(&a.severity))
        .map(|a| a.severity.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot_json(source_id: &str) -> serde_json::Value {
        serde_json::json!({
            "schemaVersion": "1.0",
            "sourceId": source_id,
            "generatedAt": "2026-07-20T08:05:00Z",
            "entries": [{
                "identity": {
                    "publisherKeyId": "ed25519:9f8e7d6c5b4a39281706f5e4d3c2b1a0",
                    "toolId": "com.example.hello-web"
                },
                "name": "Hello Web Tool",
                "channels": ["stable"],
                "latest": { "stable": "1.0.0" },
                "artifacts": [{
                    "version": "1.0.0",
                    "channel": "stable",
                    "platform": "windows",
                    "arch": "x86_64",
                    "artifactSha256": "c0535e4be2b79ffd93291305436bf889314e4a3faec05ecffcbb7df31ad9e51a",
                    "manifestDigest": "3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b",
                    "size": 12288,
                    "permissions": ["dialog.open"]
                }],
                "offer": { "accessMode": "free" }
            }]
        })
    }

    #[test]
    fn valid_snapshot_parses() {
        let mut value = snapshot_json("com.example.static");
        value["entries"][0]["artifacts"][0]["publisherSignatureVerified"] = serde_json::json!(true);
        value["entries"][0]["artifacts"][0]["signatureMethod"] = serde_json::json!("ed25519");
        value["entries"][0]["artifacts"][0]["signatureIdentity"] =
            serde_json::json!("ed25519:publisher");
        let bytes = serde_json::to_vec(&value).unwrap();
        let snap = parse_catalog(&bytes, "com.example.static").unwrap();
        assert_eq!(snap.entries.len(), 1);
        assert_eq!(
            latest_stable_digest(&snap.entries[0]),
            Some("c0535e4be2b79ffd93291305436bf889314e4a3faec05ecffcbb7df31ad9e51a")
        );
        let artifact = &snap.entries[0].artifacts[0];
        assert!(artifact.publisher_signature_verified);
        assert_eq!(artifact.signature_method.as_deref(), Some("ed25519"));
        assert_eq!(
            artifact.signature_identity.as_deref(),
            Some("ed25519:publisher")
        );
    }

    #[test]
    fn mismatched_source_id_rejected() {
        // 防串源缓存投毒：快照自报的 sourceId 与所属源不一致 → 拒绝
        let bytes = serde_json::to_vec(&snapshot_json("com.evil.other")).unwrap();
        assert!(parse_catalog(&bytes, "com.example.static").is_err());
    }

    #[test]
    fn corrupt_json_rejected() {
        assert!(parse_catalog(b"{ not json", "com.example.static").is_err());
    }

    #[test]
    fn invalid_digest_rejected() {
        let mut v = snapshot_json("com.example.static");
        v["entries"][0]["artifacts"][0]["artifactSha256"] = serde_json::json!("short");
        let bytes = serde_json::to_vec(&v).unwrap();
        assert!(parse_catalog(&bytes, "com.example.static").is_err());
    }

    #[test]
    fn invalid_access_mode_rejected() {
        let mut v = snapshot_json("com.example.static");
        v["entries"][0]["offer"]["accessMode"] = serde_json::json!("piracy");
        let bytes = serde_json::to_vec(&v).unwrap();
        assert!(parse_catalog(&bytes, "com.example.static").is_err());
    }

    #[test]
    fn three_sources_one_corrupt_failure_is_isolated() {
        // 验收：可同时加载至少三个不同源；一个源故障不影响其他源。
        let sources = [
            (
                "com.example.a",
                serde_json::to_vec(&snapshot_json("com.example.a")).unwrap(),
            ),
            ("com.example.b", b"corrupted!!!".to_vec()),
            (
                "com.example.c",
                serde_json::to_vec(&snapshot_json("com.example.c")).unwrap(),
            ),
        ];
        let results: Vec<_> = sources
            .iter()
            .map(|(id, bytes)| parse_catalog(bytes, id))
            .collect();
        assert!(results[0].is_ok());
        assert!(results[1].is_err());
        assert!(results[2].is_ok());
    }
}
