//! 差量生成：比较前后两次快照，产出 added/updated/removed。

use crate::model::{ProcessDelta, ProcessSnapshot, UpdatedProcess};
use std::collections::HashMap;

/// 进程表：身份键 -> 快照。
pub type SnapshotMap = HashMap<String, ProcessSnapshot>;

/// 从快照列表构建 map。
pub fn build_map(snapshots: Vec<ProcessSnapshot>) -> SnapshotMap {
    snapshots
        .into_iter()
        .map(|s| (s.identity.key(), s))
        .collect()
}

/// 生成差量：`prev` 为上一次，`next` 为本次。
/// - added: 出现在 next 但不在 prev
/// - updated: 两者都有但动态指标不同（仅传动态字段）
/// - removed: 出现在 prev 但不在 next
pub fn diff(prev: &SnapshotMap, next: &SnapshotMap) -> ProcessDelta {
    let mut delta = ProcessDelta::default();

    for (key, snap) in next {
        match prev.get(key) {
            None => delta.added.push(snap.clone()),
            Some(old) => {
                if old.dynamic.differs(&snap.dynamic) {
                    delta.updated.push(UpdatedProcess {
                        key: key.clone(),
                        dynamic: snap.dynamic.clone(),
                    });
                }
            }
        }
    }

    for key in prev.keys() {
        if !next.contains_key(key) {
            delta.removed.push(key.clone());
        }
    }

    // 稳定顺序，便于测试与前端稳定渲染
    delta.added.sort_by_key(|a| a.identity);
    delta.updated.sort_by(|a, b| a.key.cmp(&b.key));
    delta.removed.sort();
    delta
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::ProcessIdentity;
    use crate::model::{DynamicMetrics, Metric, StaticInfo};

    fn dyn_metrics(cpu: f32, mem: u64) -> DynamicMetrics {
        DynamicMetrics {
            cpu,
            working_set: mem,
            private_bytes: mem,
            disk_read: 0,
            disk_write: 0,
            net_up: Metric::Unavailable,
            net_down: Metric::Unavailable,
            tcp_connections: Metric::Unavailable,
            udp_endpoints: Metric::Unavailable,
            gpu: Metric::Unavailable,
            gpu_memory: Metric::Unavailable,
            threads: 1,
            handles: Metric::Available(10),
        }
    }

    fn snap(pid: u32, start: u64, cpu: f32, mem: u64) -> ProcessSnapshot {
        ProcessSnapshot {
            identity: ProcessIdentity::new(pid, start),
            r#static: StaticInfo {
                name: format!("proc{pid}"),
                exe_path: None,
                cmd_line: None,
                publisher: None,
                icon_key: None,
                parent: None,
            },
            dynamic: dyn_metrics(cpu, mem),
        }
    }

    #[test]
    fn detects_added_updated_removed() {
        let prev = build_map(vec![snap(1, 100, 5.0, 1000), snap(2, 200, 10.0, 2000)]);
        let next = build_map(vec![
            snap(1, 100, 7.0, 1000), // updated (cpu changed)
            snap(3, 300, 1.0, 500),  // added
        ]);
        let delta = diff(&prev, &next);
        assert_eq!(delta.added.len(), 1);
        assert_eq!(delta.added[0].identity.pid, 3);
        assert_eq!(delta.updated.len(), 1);
        assert_eq!(delta.updated[0].key, "1:100");
        assert_eq!(delta.removed, vec!["2:200".to_string()]);
    }

    #[test]
    fn no_delta_when_identical() {
        let prev = build_map(vec![snap(1, 100, 5.0, 1000)]);
        let next = build_map(vec![snap(1, 100, 5.0, 1000)]);
        let delta = diff(&prev, &next);
        assert!(delta.is_empty());
    }

    #[test]
    fn empty_prev_emits_full_snapshot_as_added() {
        // 回归：进程监视器启动时以空基线 diff，必须把全量进程作为 added 下发；
        // 否则前端从空表起步，只会收到不认识的 updated 而“只显示极少进程”。
        let prev = SnapshotMap::new();
        let next = build_map(vec![
            snap(1, 100, 5.0, 1000),
            snap(2, 200, 10.0, 2000),
            snap(3, 300, 1.0, 500),
        ]);
        let delta = diff(&prev, &next);
        assert_eq!(delta.added.len(), 3, "空基线应把全部进程作为 added 下发");
        assert!(delta.updated.is_empty());
        assert!(delta.removed.is_empty());
    }

    #[test]
    fn pid_reuse_shows_as_add_and_remove() {
        // 同 PID 不同启动时间：应视为一个移除 + 一个新增，而非更新
        let prev = build_map(vec![snap(1, 100, 5.0, 1000)]);
        let next = build_map(vec![snap(1, 999, 5.0, 1000)]);
        let delta = diff(&prev, &next);
        assert_eq!(delta.added.len(), 1);
        assert_eq!(delta.removed, vec!["1:100".to_string()]);
        assert!(delta.updated.is_empty());
    }
}
