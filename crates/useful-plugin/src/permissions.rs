//! 权限模型：已知权限集合、解析、以及“更新时新增权限”检测（防权限提升攻击）。

use std::collections::BTreeSet;

/// 已知权限前缀 / 精确权限。
const KNOWN_EXACT: &[&str] = &["process.launch.declared"];

/// 判断权限字符串是否为已知合法权限。
pub fn is_known_permission(perm: &str) -> bool {
    KNOWN_EXACT.contains(&perm)
}

/// 是否为“危险”权限，安装时需要额外确认。
pub fn is_sensitive_permission(perm: &str) -> bool {
    perm == "process.launch.declared"
}

/// 计算更新时相对已授予权限“新增”的权限集合。
/// 返回的新增权限需要用户重新确认（防插件更新偷偷加权限）。
pub fn added_permissions(granted: &[String], requested: &[String]) -> Vec<String> {
    let granted_set: BTreeSet<&String> = granted.iter().collect();
    requested
        .iter()
        .filter(|p| !granted_set.contains(*p))
        .cloned()
        .collect()
}

/// 校验一组权限是否全部已知；返回未知权限列表。
pub fn unknown_permissions(perms: &[String]) -> Vec<String> {
    perms
        .iter()
        .filter(|p| !is_known_permission(p))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_permissions() {
        assert!(is_known_permission("process.launch.declared"));
        assert!(!is_known_permission("dialog.open"));
        assert!(!is_known_permission("fs.read.user-selected"));
        assert!(!is_known_permission("network.fetch:example.com"));
        assert!(!is_known_permission("fs.read.any"));
        assert!(!is_known_permission("evil.permission"));
    }

    #[test]
    fn detects_added_permissions_on_update() {
        let granted = Vec::new();
        let requested = vec!["process.launch.declared".to_string()];
        let added = added_permissions(&granted, &requested);
        assert_eq!(added, vec!["process.launch.declared".to_string()]);
    }

    #[test]
    fn no_new_permissions_when_subset() {
        let granted = vec!["process.launch.declared".to_string()];
        let requested = Vec::new();
        assert!(added_permissions(&granted, &requested).is_empty());
    }

    #[test]
    fn sensitive_flagged() {
        assert!(is_sensitive_permission("process.launch.declared"));
        assert!(!is_sensitive_permission("dialog.open"));
    }
}
