// 进程表格逻辑（与视图解耦，便于测试）：应用差量、树构建、排序、搜索、展开折叠。
import type { DynamicMetrics, ProcessDelta, ProcessSnapshot } from "./types";

export type SortColumn =
  | "name"
  | "pid"
  | "cpu"
  | "memory"
  | "disk"
  | "net"
  | "gpu"
  | "gpuMemory";
export type SortDir = "asc" | "desc";

export interface ProcRow {
  key: string;
  pid: number;
  startTime: number;
  name: string;
  parentKey: string | null;
  dynamic: DynamicMetrics;
  depth: number;
}

/** 进程表：维护 key -> snapshot，并支持差量更新。 */
export class ProcTable {
  private map = new Map<string, ProcessSnapshot>();

  get size(): number {
    return this.map.size;
  }

  /** 应用一次差量（added/updated/removed）。 */
  applyDelta(delta: ProcessDelta): void {
    for (const snap of delta.added) {
      this.map.set(snap.identity.pid + ":" + snap.identity.startTime, snap);
    }
    for (const upd of delta.updated) {
      const existing = this.map.get(upd.key);
      if (existing) existing.dynamic = upd.dynamic;
    }
    for (const key of delta.removed) {
      this.map.delete(key);
    }
  }

  private keyOf(s: ProcessSnapshot): string {
    return s.identity.pid + ":" + s.identity.startTime;
  }

  private parentKeyOf(s: ProcessSnapshot): string | null {
    return s.static.parent
      ? s.static.parent.pid + ":" + s.static.parent.startTime
      : null;
  }

  /** 列表模式：全局按列排序。 */
  listMode(sort: SortColumn, dir: SortDir, search: string): ProcRow[] {
    const rows = this.allRows();
    const filtered = filterRows(rows, search);
    sortRows(filtered, sort, dir);
    return filtered;
  }

  /** 树模式：保留父子关系，仅同级排序；返回按 DFS 展开、带 depth 的行。 */
  treeMode(
    sort: SortColumn,
    dir: SortDir,
    search: string,
    expanded: Set<string>,
  ): ProcRow[] {
    const rows = this.allRows();
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const children = new Map<string | null, ProcRow[]>();
    for (const r of rows) {
      // 父不存在时视为根
      const pk = r.parentKey && byKey.has(r.parentKey) ? r.parentKey : null;
      r.parentKey = pk;
      const arr = children.get(pk) ?? [];
      arr.push(r);
      children.set(pk, arr);
    }
    for (const arr of children.values()) sortRows(arr, sort, dir);

    const matched = search ? new Set(filterRows(rows, search).map((r) => r.key)) : null;

    const out: ProcRow[] = [];
    const visit = (key: string | null, depth: number): void => {
      const kids = children.get(key) ?? [];
      for (const row of kids) {
        row.depth = depth;
        // 搜索时只显示命中或含命中后代的节点
        if (!matched || subtreeMatches(row.key, children, matched)) {
          out.push(row);
          if (expanded.has(row.key)) visit(row.key, depth + 1);
        }
      }
    };
    visit(null, 0);
    return out;
  }

  allRows(): ProcRow[] {
    const out: ProcRow[] = [];
    for (const s of this.map.values()) {
      out.push({
        key: this.keyOf(s),
        pid: s.identity.pid,
        startTime: s.identity.startTime,
        name: s.static.name,
        parentKey: this.parentKeyOf(s),
        dynamic: s.dynamic,
        depth: 0,
      });
    }
    return out;
  }

  /** 按 key 读取可执行文件完整路径（静态信息）。 */
  exePathOf(key: string): string | undefined {
    return this.map.get(key)?.static.exePath;
  }

  /** 按 key 读取命令行（静态信息）。 */
  cmdLineOf(key: string): string | undefined {
    return this.map.get(key)?.static.cmdLine;
  }
}

function metricValue(m: { state: string; value?: number } | undefined): number {
  return m && m.state === "available" ? (m.value ?? 0) : -1;
}

/** Prefer real ETW byte rates; if unavailable, sort by explicitly-labelled endpoint counts. */
export function networkSortValue(row: ProcRow): number {
  const up = metricValue(row.dynamic.netUp);
  const down = metricValue(row.dynamic.netDown);
  if (up >= 0 || down >= 0) return Math.max(0, up) + Math.max(0, down);
  const tcp = metricValue(row.dynamic.tcpConnections);
  const udp = metricValue(row.dynamic.udpEndpoints);
  return Math.max(0, tcp) + Math.max(0, udp);
}

function sortKey(row: ProcRow, col: SortColumn): number | string {
  switch (col) {
    case "name":
      return row.name.toLowerCase();
    case "pid":
      return row.pid;
    case "cpu":
      return row.dynamic.cpu;
    case "memory":
      return row.dynamic.workingSet;
    case "disk":
      return row.dynamic.diskRead + row.dynamic.diskWrite;
    case "net":
      return networkSortValue(row);
    case "gpu":
      return metricValue(row.dynamic.gpu);
    case "gpuMemory":
      return metricValue(row.dynamic.gpuMemory);
  }
}

export function sortRows(rows: ProcRow[], col: SortColumn, dir: SortDir): void {
  rows.sort((a, b) => {
    const ka = sortKey(a, col);
    const kb = sortKey(b, col);
    let cmp: number;
    if (typeof ka === "string" && typeof kb === "string") {
      cmp = ka.localeCompare(kb);
    } else {
      cmp = (ka as number) - (kb as number);
    }
    // 稳定次级排序：pid
    if (cmp === 0) cmp = a.pid - b.pid;
    return dir === "asc" ? cmp : -cmp;
  });
}

export function filterRows(rows: ProcRow[], search: string): ProcRow[] {
  const q = search.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(
    (r) => r.name.toLowerCase().includes(q) || String(r.pid).includes(q),
  );
}

function subtreeMatches(
  key: string,
  children: Map<string | null, ProcRow[]>,
  matched: Set<string>,
): boolean {
  if (matched.has(key)) return true;
  const kids = children.get(key) ?? [];
  return kids.some((k) => subtreeMatches(k.key, children, matched));
}
