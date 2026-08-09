//! 统一工具定义与注册表。侧边栏与命令面板均由注册表驱动，不硬编码第三方工具。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// 工具类别（决定侧边栏分组）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ToolCategory {
    Builtin,
    Installed,
}

/// 工具入口类型。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ToolKind {
    Builtin,
    Web,
    Launcher,
    Worker,
}

/// 统一工具定义。内置工具在 Rust 侧静态声明，第三方工具由插件 manifest 生成。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDefinition {
    pub id: String,
    /// i18n key（内置工具）或插件提供的显示名
    pub name: String,
    pub description: String,
    /// 相对/内置图标标识
    pub icon: String,
    /// 前端路由，如 /tools/video-trim 或 /plugin/<id>
    pub route: String,
    pub category: ToolCategory,
    pub kind: ToolKind,
    pub order: i32,
    pub supports_shortcut: bool,
    pub required_capabilities: Vec<String>,
    /// 插件版本（内置工具为 None）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// 进程内工具注册表。
#[derive(Default)]
pub struct ToolRegistry {
    tools: BTreeMap<String, ToolDefinition>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// 注册工具；同 ID 重复注册视为冲突并拒绝（防插件 ID 冲突）。
    pub fn register(&mut self, def: ToolDefinition) -> Result<(), String> {
        if self.tools.contains_key(&def.id) {
            return Err(format!("工具 ID 冲突: {}", def.id));
        }
        self.tools.insert(def.id.clone(), def);
        Ok(())
    }

    pub fn unregister(&mut self, id: &str) -> Option<ToolDefinition> {
        self.tools.remove(id)
    }

    pub fn get(&self, id: &str) -> Option<&ToolDefinition> {
        self.tools.get(id)
    }

    /// 按 (category, order, id) 排序返回全部工具。
    pub fn list(&self) -> Vec<&ToolDefinition> {
        let mut v: Vec<_> = self.tools.values().collect();
        v.sort_by(|a, b| {
            (a.category as u8, a.order, &a.id).cmp(&(b.category as u8, b.order, &b.id))
        });
        v
    }
}

/// 内置工具静态声明。
pub fn builtin_tools() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            id: "builtin.utilities".into(),
            name: "tools.utilities.name".into(),
            description: "tools.utilities.description".into(),
            icon: "builtin:utilities".into(),
            route: "/tools/utilities".into(),
            category: ToolCategory::Builtin,
            kind: ToolKind::Builtin,
            order: 5,
            supports_shortcut: true,
            required_capabilities: vec![],
            version: None,
        },
        ToolDefinition {
            id: "builtin.office".into(),
            name: "tools.office.name".into(),
            description: "tools.office.description".into(),
            icon: "builtin:office".into(),
            route: "/tools/office".into(),
            category: ToolCategory::Builtin,
            kind: ToolKind::Builtin,
            order: 7,
            supports_shortcut: true,
            required_capabilities: vec![],
            version: None,
        },
        ToolDefinition {
            id: "builtin.video-trim".into(),
            name: "tools.videoTrim.name".into(),
            description: "tools.videoTrim.description".into(),
            icon: "builtin:video-trim".into(),
            route: "/tools/video-trim".into(),
            category: ToolCategory::Builtin,
            kind: ToolKind::Builtin,
            order: 10,
            supports_shortcut: true,
            required_capabilities: vec!["media.ffmpeg".into(), "media.mpv".into()],
            version: None,
        },
        ToolDefinition {
            id: "builtin.process-monitor".into(),
            name: "tools.processMonitor.name".into(),
            description: "tools.processMonitor.description".into(),
            icon: "builtin:process-monitor".into(),
            route: "/tools/process-monitor".into(),
            category: ToolCategory::Builtin,
            kind: ToolKind::Builtin,
            order: 20,
            supports_shortcut: true,
            required_capabilities: vec!["system.process".into()],
            version: None,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_tools_register_without_conflict() {
        let mut reg = ToolRegistry::new();
        for t in builtin_tools() {
            reg.register(t).unwrap();
        }
        assert_eq!(reg.list().len(), 4);
        assert!(reg.get("builtin.office").is_some());
        assert!(reg.get("builtin.video-trim").is_some());
    }

    #[test]
    fn duplicate_id_rejected() {
        let mut reg = ToolRegistry::new();
        for t in builtin_tools() {
            reg.register(t).unwrap();
        }
        let dup = builtin_tools().remove(0);
        assert!(reg.register(dup).is_err());
    }

    #[test]
    fn list_sorted_by_category_then_order() {
        let mut reg = ToolRegistry::new();
        reg.register(ToolDefinition {
            id: "com.example.z".into(),
            name: "Z".into(),
            description: String::new(),
            icon: String::new(),
            route: "/plugin/com.example.z".into(),
            category: ToolCategory::Installed,
            kind: ToolKind::Web,
            order: 1,
            supports_shortcut: true,
            required_capabilities: vec![],
            version: Some("1.0.0".into()),
        })
        .unwrap();
        for t in builtin_tools() {
            reg.register(t).unwrap();
        }
        let ids: Vec<_> = reg.list().iter().map(|t| t.id.clone()).collect();
        assert_eq!(
            ids,
            vec![
                "builtin.utilities",
                "builtin.office",
                "builtin.video-trim",
                "builtin.process-monitor",
                "com.example.z"
            ]
        );
    }
}
