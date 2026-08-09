//! 进程树构建：从父子身份关系构造树，并支持“结束进程树”的后代收集。

use crate::identity::ProcessIdentity;
use std::collections::{HashMap, HashSet};

/// 树节点：身份 + 子节点身份列表。
#[derive(Debug, Clone, PartialEq)]
pub struct TreeNode {
    pub identity: ProcessIdentity,
    pub children: Vec<ProcessIdentity>,
}

/// 从 (identity, parent) 列表构建父->子邻接表。
pub fn build_children_map(
    entries: &[(ProcessIdentity, Option<ProcessIdentity>)],
) -> HashMap<ProcessIdentity, Vec<ProcessIdentity>> {
    let present: HashSet<ProcessIdentity> = entries.iter().map(|(id, _)| *id).collect();
    let mut map: HashMap<ProcessIdentity, Vec<ProcessIdentity>> = HashMap::new();
    for (id, parent) in entries {
        map.entry(*id).or_default();
        if let Some(p) = parent {
            // 父进程必须仍存在，否则视为根（避免悬挂父指针）
            if present.contains(p) {
                map.entry(*p).or_default().push(*id);
            }
        }
    }
    // 子节点稳定排序
    for children in map.values_mut() {
        children.sort();
    }
    map
}

/// 找出所有根节点（无父或父不存在）。
pub fn roots(entries: &[(ProcessIdentity, Option<ProcessIdentity>)]) -> Vec<ProcessIdentity> {
    let present: HashSet<ProcessIdentity> = entries.iter().map(|(id, _)| *id).collect();
    let mut roots: Vec<ProcessIdentity> = entries
        .iter()
        .filter(|(_, parent)| match parent {
            None => true,
            Some(p) => !present.contains(p),
        })
        .map(|(id, _)| *id)
        .collect();
    roots.sort();
    roots
}

/// 收集某进程的所有后代（含自身），用于“结束进程树”。
/// 使用 BFS，带 visited 防止环导致无限循环。
pub fn collect_descendants(
    children_map: &HashMap<ProcessIdentity, Vec<ProcessIdentity>>,
    root: ProcessIdentity,
) -> Vec<ProcessIdentity> {
    let mut result = Vec::new();
    let mut visited = HashSet::new();
    let mut queue = std::collections::VecDeque::new();
    queue.push_back(root);
    visited.insert(root);

    while let Some(node) = queue.pop_front() {
        result.push(node);
        if let Some(children) = children_map.get(&node) {
            for &child in children {
                if visited.insert(child) {
                    queue.push_back(child);
                }
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(pid: u32) -> ProcessIdentity {
        ProcessIdentity::new(pid, 1000)
    }

    #[test]
    fn builds_tree_and_roots() {
        //  1 -> 2 -> 4
        //    -> 3
        let entries = vec![
            (id(1), None),
            (id(2), Some(id(1))),
            (id(3), Some(id(1))),
            (id(4), Some(id(2))),
        ];
        let map = build_children_map(&entries);
        assert_eq!(map[&id(1)], vec![id(2), id(3)]);
        assert_eq!(map[&id(2)], vec![id(4)]);
        assert_eq!(roots(&entries), vec![id(1)]);
    }

    #[test]
    fn orphan_becomes_root() {
        // 父 99 不存在 -> 2 视为根
        let entries = vec![(id(2), Some(id(99)))];
        assert_eq!(roots(&entries), vec![id(2)]);
    }

    #[test]
    fn collect_descendants_for_kill_tree() {
        let entries = vec![
            (id(1), None),
            (id(2), Some(id(1))),
            (id(3), Some(id(1))),
            (id(4), Some(id(2))),
            (id(5), None),
        ];
        let map = build_children_map(&entries);
        let mut desc = collect_descendants(&map, id(1));
        desc.sort();
        assert_eq!(desc, vec![id(1), id(2), id(3), id(4)]);
        // 不包含无关的 5
        assert!(!desc.contains(&id(5)));
    }

    #[test]
    fn cycle_does_not_hang() {
        // 人为构造环：1->2, 2->1
        let mut map: HashMap<ProcessIdentity, Vec<ProcessIdentity>> = HashMap::new();
        map.insert(id(1), vec![id(2)]);
        map.insert(id(2), vec![id(1)]);
        let desc = collect_descendants(&map, id(1));
        assert_eq!(desc.len(), 2);
    }
}
