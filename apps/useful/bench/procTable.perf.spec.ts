// 进程监视器前端差量处理 benchmark：500 进程，100 轮差量 + 树/列表重建。
// 目标（需求十三）：一次差量渲染（数据层处理）P95 < 50ms。
// 结果写入 bench-results/proctable.json，由 scripts/run-benchmarks.mjs 汇总。
import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { ProcTable } from "@/lib/procTable";
import type { DynamicMetrics, ProcessDelta, ProcessSnapshot } from "@/lib/types";

const PROCESSES = 500;
const ROUNDS = 100;

function dyn(seed: number): DynamicMetrics {
  return {
    cpu: (seed % 100) / 2,
    workingSet: 100_000_000 + seed * 4096,
    privateBytes: 80_000_000 + seed * 2048,
    diskRead: seed * 100,
    diskWrite: seed * 60,
    netUp: { state: "available", value: seed * 10 },
    netDown: { state: "available", value: seed * 20 },
    gpu: { state: "unavailable" },
    gpuMemory: { state: "unavailable" },
    threads: 10 + (seed % 40),
    handles: { state: "available", value: 200 + (seed % 500) },
  };
}

function snapshot(pid: number, seed: number): ProcessSnapshot {
  return {
    identity: { pid, startTime: 1_700_000_000 },
    static: {
      name: `进程-${pid}.exe`,
      exePath: `C:\\Program Files\\示例 应用\\proc-${pid}.exe`,
      parent: pid > 4 ? { pid: Math.floor(pid / 2), startTime: 1_700_000_000 } : undefined,
    },
    dynamic: dyn(seed),
  };
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.round((sorted.length - 1) * p));
  return sorted[idx];
}

describe("进程表差量处理性能（500 进程）", () => {
  it("100 轮差量 + 树模式重建 P95 < 50ms", () => {
    const table = new ProcTable();
    // 初始 500 进程
    const initial: ProcessDelta = {
      added: Array.from({ length: PROCESSES }, (_, i) => snapshot(i + 4, i)),
      updated: [],
      removed: [],
    };
    table.applyDelta(initial);
    expect(table.size).toBe(PROCESSES);

    const expanded = new Set<string>(
      Array.from({ length: PROCESSES }, (_, i) => `${i + 4}:1700000000`),
    );
    const times: number[] = [];
    for (let round = 0; round < ROUNDS; round++) {
      // 每轮：全部进程动态字段更新 + 少量增删（模拟真实差量）
      const delta: ProcessDelta = {
        added: [snapshot(10_000 + round, round)],
        updated: Array.from({ length: PROCESSES }, (_, i) => ({
          key: `${i + 4}:1700000000`,
          dynamic: dyn(i + round),
        })),
        removed: round > 0 ? [`${10_000 + round - 1}:1700000000`] : [],
      };
      const start = performance.now();
      table.applyDelta(delta);
      // 数据层"渲染"：树模式重建（视图为虚拟化列表，仅消费该数组）
      const rows = table.treeMode("cpu", "desc", "", expanded);
      const listRows = table.listMode("memory", "desc", "");
      times.push(performance.now() - start);
      expect(rows.length).toBeGreaterThan(0);
      expect(listRows.length).toBeGreaterThan(0);
    }

    const sorted = [...times].sort((a, b) => a - b);
    const result = {
      processes: PROCESSES,
      rounds: ROUNDS,
      avgMs: times.reduce((a, b) => a + b, 0) / times.length,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      maxMs: sorted[sorted.length - 1],
      generatedAt: new Date().toISOString(),
    };

    const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../..", "bench-results");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, "proctable.json"), JSON.stringify(result, null, 2));
    // eslint-disable-next-line no-console
    console.log("proctable benchmark:", JSON.stringify(result));

    // 需求十三：一次差量渲染 P95 < 50ms
    expect(result.p95Ms).toBeLessThan(50);
  });
});
