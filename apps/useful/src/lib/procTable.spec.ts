import { describe, it, expect } from "vitest";
import { ProcTable, sortRows, filterRows, networkSortValue, type ProcRow } from "@/lib/procTable";
import type { DynamicMetrics, ProcessSnapshot } from "@/lib/types";

function metrics(cpu: number, mem: number): DynamicMetrics {
  return {
    cpu,
    workingSet: mem,
    privateBytes: mem,
    diskRead: 0,
    diskWrite: 0,
    netUp: { state: "unavailable" },
    netDown: { state: "unavailable" },
    tcpConnections: { state: "available", value: 0 },
    udpEndpoints: { state: "available", value: 0 },
    gpu: { state: "unavailable" },
    gpuMemory: { state: "unavailable" },
    threads: 1,
    handles: { state: "available", value: 10 },
  };
}

function snap(
  pid: number,
  name: string,
  cpu: number,
  mem: number,
  parent?: number,
): ProcessSnapshot {
  return {
    identity: { pid, startTime: 1000 },
    static: {
      name,
      parent: parent ? { pid: parent, startTime: 1000 } : undefined,
    },
    dynamic: metrics(cpu, mem),
  };
}

describe("ProcTable 差量更新", () => {
  it("added/updated/removed 正确应用", () => {
    const table = new ProcTable();
    table.applyDelta({
      added: [snap(1, "a", 5, 100), snap(2, "b", 10, 200)],
      updated: [],
      removed: [],
    });
    expect(table.size).toBe(2);

    // 更新 cpu
    table.applyDelta({
      added: [],
      updated: [{ key: "1:1000", dynamic: metrics(50, 100) }],
      removed: [],
    });
    const rowA = table.allRows().find((r) => r.pid === 1)!;
    expect(rowA.dynamic.cpu).toBe(50);

    // 移除
    table.applyDelta({ added: [], updated: [], removed: ["2:1000"] });
    expect(table.size).toBe(1);
  });

  it("未知 key 的 updated 被忽略——故启动必须先下发全量 added 基线", () => {
    // 回归：进程监视器曾只显示极少进程。空表若只收到 updated（后端未下发基线），
    // 这些 updated 命中不到任何行而被丢弃，表保持空。修复后后端启动即以
    // added 下发全量基线，这里模拟该基线让全部进程立即出现。
    const table = new ProcTable();
    table.applyDelta({
      added: [],
      updated: [{ key: "1:1000", dynamic: metrics(50, 100) }],
      removed: [],
    });
    expect(table.size).toBe(0);

    // 模拟后端启动时的全量基线（442 进程量级的批量 added）
    const baseline = Array.from({ length: 300 }, (_, i) => snap(i + 1, `p${i}`, 0, 100));
    table.applyDelta({ added: baseline, updated: [], removed: [] });
    expect(table.size).toBe(300);
    // 后续 updated 现在能命中并刷新真实占用
    table.applyDelta({
      added: [],
      updated: [{ key: "1:1000", dynamic: metrics(77, 100) }],
      removed: [],
    });
    expect(table.allRows().find((r) => r.pid === 1)!.dynamic.cpu).toBe(77);
  });
});

describe("排序", () => {
  const rows = (): ProcRow[] => [
    { key: "1:1", pid: 1, startTime: 1, name: "Zeta", parentKey: null, dynamic: metrics(5, 300), depth: 0 },
    { key: "2:1", pid: 2, startTime: 1, name: "alpha", parentKey: null, dynamic: metrics(80, 100), depth: 0 },
    { key: "3:1", pid: 3, startTime: 1, name: "mid", parentKey: null, dynamic: metrics(20, 200), depth: 0 },
  ];

  it("按 CPU 降序", () => {
    const r = rows();
    sortRows(r, "cpu", "desc");
    expect(r.map((x) => x.pid)).toEqual([2, 3, 1]);
  });

  it("按名称升序（大小写不敏感）", () => {
    const r = rows();
    sortRows(r, "name", "asc");
    expect(r.map((x) => x.name)).toEqual(["alpha", "mid", "Zeta"]);
  });

  it("按内存升序", () => {
    const r = rows();
    sortRows(r, "memory", "asc");
    expect(r.map((x) => x.pid)).toEqual([2, 3, 1]);
  });
});

describe("网络显示口径", () => {
  it("ETW 字节可用时按上下行之和排序", () => {
    const row = { key: "1:1", pid: 1, startTime: 1, name: "a", parentKey: null, dynamic: metrics(0, 0), depth: 0 };
    row.dynamic.netUp = { state: "available", value: 120 };
    row.dynamic.netDown = { state: "available", value: 80 };
    row.dynamic.tcpConnections = { state: "available", value: 999 };
    expect(networkSortValue(row)).toBe(200);
  });

  it("ETW 不可用时连接数保持独立计数，绝不冒充字节", () => {
    const row = { key: "1:1", pid: 1, startTime: 1, name: "a", parentKey: null, dynamic: metrics(0, 0), depth: 0 };
    row.dynamic.tcpConnections = { state: "available", value: 3 };
    row.dynamic.udpEndpoints = { state: "available", value: 2 };
    expect(networkSortValue(row)).toBe(5);
    expect(row.dynamic.netUp.state).toBe("unavailable");
  });
});

describe("搜索", () => {
  it("按名称与 PID 过滤", () => {
    const table = new ProcTable();
    table.applyDelta({
      added: [snap(1, "chrome", 5, 100), snap(222, "node", 10, 200)],
      updated: [],
      removed: [],
    });
    expect(filterRows(table.allRows(), "chr").length).toBe(1);
    expect(filterRows(table.allRows(), "222").length).toBe(1);
    expect(filterRows(table.allRows(), "zzz").length).toBe(0);
  });
});

describe("树模式 展开/折叠", () => {
  it("折叠时不显示子节点，展开时显示", () => {
    const table = new ProcTable();
    table.applyDelta({
      added: [
        snap(1, "root", 5, 100),
        snap(2, "child", 10, 200, 1),
        snap(3, "grandchild", 1, 50, 2),
      ],
      updated: [],
      removed: [],
    });

    // 全部折叠：只有根
    let view = table.treeMode("name", "asc", "", new Set());
    expect(view.map((r) => r.pid)).toEqual([1]);
    expect(view[0].depth).toBe(0);

    // 展开根：显示 child
    view = table.treeMode("name", "asc", "", new Set(["1:1000"]));
    expect(view.map((r) => r.pid)).toEqual([1, 2]);
    expect(view[1].depth).toBe(1);

    // 展开根与 child：显示全部
    view = table.treeMode("name", "asc", "", new Set(["1:1000", "2:1000"]));
    expect(view.map((r) => r.pid)).toEqual([1, 2, 3]);
    expect(view[2].depth).toBe(2);
  });

  it("孤儿进程（父不存在）视为根", () => {
    const table = new ProcTable();
    table.applyDelta({
      added: [snap(5, "orphan", 5, 100, 999)],
      updated: [],
      removed: [],
    });
    const view = table.treeMode("name", "asc", "", new Set());
    expect(view.map((r) => r.pid)).toEqual([5]);
  });

  it("搜索时显示命中节点及其祖先链", () => {
    const table = new ProcTable();
    table.applyDelta({
      added: [
        snap(1, "root", 5, 100),
        snap(2, "target", 10, 200, 1),
        snap(3, "other", 1, 50),
      ],
      updated: [],
      removed: [],
    });
    const view = table.treeMode("name", "asc", "target", new Set(["1:1000"]));
    const pids = view.map((r) => r.pid);
    expect(pids).toContain(1);
    expect(pids).toContain(2);
    expect(pids).not.toContain(3);
  });
});
