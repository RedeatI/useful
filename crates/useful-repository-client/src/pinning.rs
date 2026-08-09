//! 来源固定（source pinning）与发布者固定（publisher pinning）。
//!
//! 更新默认只接受：相同 source_id、相同 publisher_key_id、相同 tool_id、
//! 合法 SemVer 升级、相同频道；权限新增必须用户确认；同版本不同摘要拒绝。
//! 禁止：跨源自动选最高版本、发布者换钥静默更新、同名工具自动覆盖。
//! 来源迁移必须是显式操作（不在本模块——本模块只做"默认拒绝"）。

use serde::{Deserialize, Serialize};

/// 已安装工具的来源记录（对应 installed_origins 表 / installed-origin schema）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledOrigin {
    pub source_id: String,
    pub publisher_key_id: String,
    pub tool_id: String,
    pub installed_version: String,
    pub artifact_sha256: String,
    pub channel: String,
    pub manifest_digest: String,
}

/// 候选更新（来自某个源的目录条目制品）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCandidate {
    pub source_id: String,
    pub publisher_key_id: String,
    pub tool_id: String,
    pub version: String,
    pub artifact_sha256: String,
    pub channel: String,
    /// 候选版本声明的全部权限（与已授予权限比较得出新增）。
    pub permissions: Vec<String>,
}

/// 更新决策。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "decision")]
pub enum UpdateDecision {
    /// 允许更新；`added_permissions` 非空时 UI 必须先取得用户确认。
    Allow { added_permissions: Vec<String> },
    /// 拒绝更新（默认安全姿态）。
    Reject { reason: RejectReason },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RejectReason {
    /// 候选来自不同源：禁止因第三方源版本更高而切换来源。
    SourceMismatch,
    /// 发布者密钥变化：无法证明连续性时视为新发布者，禁止静默更新。
    PublisherKeyMismatch,
    /// 工具 ID 不同。
    ToolIdMismatch,
    /// 版本号非法。
    InvalidVersion,
    /// 不是 SemVer 升级（相同或更低版本）。
    NotAnUpgrade,
    /// 频道变化必须由用户显式切换。
    ChannelChanged,
    /// 版本号相同但摘要不同的制品禁止静默替换。
    SameVersionDifferentDigest,
}

/// 评估默认更新决策（不含用户显式"迁移来源"操作）。
/// `granted_permissions` 为该工具当前已授予的权限集合。
pub fn evaluate_update(
    origin: &InstalledOrigin,
    candidate: &UpdateCandidate,
    granted_permissions: &[String],
) -> UpdateDecision {
    if candidate.tool_id != origin.tool_id {
        return UpdateDecision::Reject {
            reason: RejectReason::ToolIdMismatch,
        };
    }
    if candidate.source_id != origin.source_id {
        return UpdateDecision::Reject {
            reason: RejectReason::SourceMismatch,
        };
    }
    if candidate.publisher_key_id != origin.publisher_key_id {
        return UpdateDecision::Reject {
            reason: RejectReason::PublisherKeyMismatch,
        };
    }
    if candidate.channel != origin.channel {
        return UpdateDecision::Reject {
            reason: RejectReason::ChannelChanged,
        };
    }
    let (Ok(cur), Ok(cand)) = (
        semver::Version::parse(&origin.installed_version),
        semver::Version::parse(&candidate.version),
    ) else {
        return UpdateDecision::Reject {
            reason: RejectReason::InvalidVersion,
        };
    };
    if cand == cur {
        if !candidate
            .artifact_sha256
            .eq_ignore_ascii_case(&origin.artifact_sha256)
        {
            return UpdateDecision::Reject {
                reason: RejectReason::SameVersionDifferentDigest,
            };
        }
        return UpdateDecision::Reject {
            reason: RejectReason::NotAnUpgrade,
        };
    }
    if cand < cur {
        return UpdateDecision::Reject {
            reason: RejectReason::NotAnUpgrade,
        };
    }
    // 权限新增 → 必须确认
    let added: Vec<String> = candidate
        .permissions
        .iter()
        .filter(|p| !granted_permissions.contains(p))
        .cloned()
        .collect();
    UpdateDecision::Allow {
        added_permissions: added,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn origin() -> InstalledOrigin {
        InstalledOrigin {
            source_id: "com.example.a".into(),
            publisher_key_id: "ed25519:pubkeyA0000000000".into(),
            tool_id: "com.example.tool".into(),
            installed_version: "1.2.0".into(),
            artifact_sha256: "aa".repeat(32),
            channel: "stable".into(),
            manifest_digest: "bb".repeat(32),
        }
    }

    fn candidate() -> UpdateCandidate {
        UpdateCandidate {
            source_id: "com.example.a".into(),
            publisher_key_id: "ed25519:pubkeyA0000000000".into(),
            tool_id: "com.example.tool".into(),
            version: "1.3.0".into(),
            artifact_sha256: "cc".repeat(32),
            channel: "stable".into(),
            permissions: vec!["dialog.open".into()],
        }
    }

    #[test]
    fn legal_semver_upgrade_allowed() {
        let d = evaluate_update(&origin(), &candidate(), &["dialog.open".into()]);
        assert_eq!(
            d,
            UpdateDecision::Allow {
                added_permissions: vec![]
            }
        );
    }

    #[test]
    fn higher_version_from_other_source_rejected() {
        // 禁止因第三方源版本更高而切换来源
        let mut c = candidate();
        c.source_id = "com.thirdparty.b".into();
        c.version = "9.9.9".into();
        let d = evaluate_update(&origin(), &c, &[]);
        assert_eq!(
            d,
            UpdateDecision::Reject {
                reason: RejectReason::SourceMismatch
            }
        );
    }

    #[test]
    fn publisher_key_change_rejected() {
        // 发布者密钥变化后禁止静默更新
        let mut c = candidate();
        c.publisher_key_id = "ed25519:attackerKey000000".into();
        let d = evaluate_update(&origin(), &c, &[]);
        assert_eq!(
            d,
            UpdateDecision::Reject {
                reason: RejectReason::PublisherKeyMismatch
            }
        );
    }

    #[test]
    fn downgrade_and_same_version_rejected() {
        let mut c = candidate();
        c.version = "1.1.0".into();
        assert_eq!(
            evaluate_update(&origin(), &c, &[]),
            UpdateDecision::Reject {
                reason: RejectReason::NotAnUpgrade
            }
        );
        c.version = "1.2.0".into();
        c.artifact_sha256 = origin().artifact_sha256;
        assert_eq!(
            evaluate_update(&origin(), &c, &[]),
            UpdateDecision::Reject {
                reason: RejectReason::NotAnUpgrade
            }
        );
    }

    #[test]
    fn same_version_different_digest_rejected() {
        // 版本号相同但摘要不同的制品禁止静默替换
        let mut c = candidate();
        c.version = "1.2.0".into();
        c.artifact_sha256 = "dd".repeat(32);
        assert_eq!(
            evaluate_update(&origin(), &c, &[]),
            UpdateDecision::Reject {
                reason: RejectReason::SameVersionDifferentDigest
            }
        );
    }

    #[test]
    fn channel_change_rejected() {
        let mut c = candidate();
        c.channel = "beta".into();
        assert_eq!(
            evaluate_update(&origin(), &c, &[]),
            UpdateDecision::Reject {
                reason: RejectReason::ChannelChanged
            }
        );
    }

    #[test]
    fn added_permissions_require_confirmation() {
        let mut c = candidate();
        c.permissions = vec!["dialog.open".into(), "fs.write".into()];
        let d = evaluate_update(&origin(), &c, &["dialog.open".into()]);
        assert_eq!(
            d,
            UpdateDecision::Allow {
                added_permissions: vec!["fs.write".into()]
            }
        );
    }
}
