import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OFFICE_ACTIONS } from "./officeRegistry";
import {
  NATIVE_SMOKE_ROUTE_ACTIONS,
  NATIVE_SMOKE_STANDALONE_TOOL_COUNT,
  NATIVE_SMOKE_TOTAL,
  REQUIRED_NATIVE_TOOL_IDS,
  REQUIRED_OFFICE_SMOKE_ROUTES,
} from "./nativeSmoke";
import { UTIL_ACTIONS } from "./tools/registry";

describe("native smoke route contract", () => {
  it("requires every Office action and its canonical route", () => {
    expect(REQUIRED_OFFICE_SMOKE_ROUTES).toEqual(
      OFFICE_ACTIONS.map(({ id, route }) => ({ id, route })),
    );
    expect(NATIVE_SMOKE_ROUTE_ACTIONS.map(({ id }) => id)).toEqual([
      ...UTIL_ACTIONS.map(({ id }) => id),
      ...OFFICE_ACTIONS.map(({ id }) => id),
    ]);
    expect(REQUIRED_NATIVE_TOOL_IDS).toContain("builtin.office");
  });

  it("keeps the release-stage count aligned with the executable smoke set", async () => {
    expect(NATIVE_SMOKE_TOTAL).toBe(
      UTIL_ACTIONS.length + OFFICE_ACTIONS.length + NATIVE_SMOKE_STANDALONE_TOOL_COUNT,
    );
    const verification = await readFile(
      path.resolve(process.cwd(), "../../scripts/verify-release.mjs"),
      "utf8",
    );
    expect(verification).toContain(
      `真实 Tauri ${NATIVE_SMOKE_TOTAL}/${NATIVE_SMOKE_TOTAL} 全工具路由、SQLite、剪贴板、媒体 deep-link 与导出`,
    );
    expect(verification).toContain(
      `${NATIVE_SMOKE_ROUTE_ACTIONS.length}/${NATIVE_SMOKE_ROUTE_ACTIONS.length} action 冷启动与单实例直达`,
    );
    const deeplinkSmoke = await readFile(
      path.resolve(process.cwd(), "../../scripts/action-deeplink-smoke.ps1"),
      "utf8",
    );
    expect(deeplinkSmoke).toContain('$_.id -like "builtin.office.*"');
    expect(deeplinkSmoke).toContain(`Action baseline is below ${NATIVE_SMOKE_ROUTE_ACTIONS.length}`);
  });
});
