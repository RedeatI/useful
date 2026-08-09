import { describe, it, expect } from "vitest";
import {
  UTIL_TOOLS,
  UTIL_CATEGORIES,
  findTool,
  searchTools,
  UTIL_ACTIONS,
} from "@/lib/tools/registry";
import { BUILTIN_ACTION_DESCRIPTORS } from "@useful/action-runtime/browser";

describe("实用工具注册表", () => {
  it("每个工具字段完整且 id 唯一", () => {
    const ids = new Set<string>();
    for (const tt of UTIL_TOOLS) {
      expect(tt.id).toBeTruthy();
      expect(tt.nameKey).toMatch(/^util\./);
      expect(tt.descKey).toMatch(/^util\./);
      expect(tt.icon).toBeTruthy();
      expect(tt.component).toBeTruthy();
      expect(tt.keywords.length).toBeGreaterThan(0);
      expect(ids.has(tt.id)).toBe(false);
      ids.add(tt.id);
    }
  });

  it("每个工具的分类都在已声明分类中", () => {
    const cats = new Set(UTIL_CATEGORIES.map((c) => c.key));
    for (const tt of UTIL_TOOLS) expect(cats.has(tt.category)).toBe(true);
  });

  it("findTool 命中与未命中", () => {
    expect(findTool("json")?.id).toBe("json");
    expect(findTool("does-not-exist")).toBeUndefined();
  });

  it("searchTools 按 id/关键词过滤，空查询返回全部", () => {
    expect(searchTools("")).toHaveLength(UTIL_TOOLS.length);
    expect(searchTools("base64").some((t) => t.id === "base64")).toBe(true);
    expect(searchTools("哈希").some((t) => t.id === "hash")).toBe(true);
    expect(searchTools("正则").some((t) => t.id === "regex")).toBe(true);
    expect(searchTools("zzzznomatch")).toHaveLength(0);
  });

  it("31 个 utility 工具完整注册", () => {
    expect(UTIL_TOOLS).toHaveLength(31);
  });

  it("全部 31 个 utility action 共享 GUI/CLI/MCP 自动化元数据且顺序闭合", () => {
    const automated = UTIL_ACTIONS.filter((action) => action.automation);
    const descriptors = BUILTIN_ACTION_DESCRIPTORS.filter(
      (descriptor) =>
        "toolId" in descriptor.source && descriptor.source.toolId === "builtin.utilities",
    );
    expect(automated.map((action) => action.id)).toEqual(descriptors.map((descriptor) => descriptor.actionId));
    expect(automated).toHaveLength(31);
    for (const action of automated) {
      const descriptor = descriptors.find((candidate) => candidate.actionId === action.id)!;
      expect(action.automation).toMatchObject({
        actionId: action.id,
        contractVersion: "1.0",
        executionMode: descriptor.execution.mode === "worker" ? "worker" : "pure",
        surfaces: ["gui", "runtime-cli", "mcp"],
      });
    }
  });
});
