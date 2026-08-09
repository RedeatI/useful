// 组件测试：命令面板搜索行为。
// 覆盖：空查询显示全部、关键词搜索、别名搜索、无结果提示。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createRouter, createWebHistory } from "vue-router";
import { nextTick } from "vue";

const ipcMock = vi.hoisted(() => ({
  recordToolUse: vi.fn().mockResolvedValue(undefined),
  recordActionUse: vi.fn().mockResolvedValue(undefined),
  updateSetting: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/ipc", () => ({ default: ipcMock }));
import {
  UTIL_ACTIONS,
  searchActions,
  findAction,
  shortIdToAction,
  actionToShortId,
} from "@/lib/tools/registry";
import CommandPalette from "@/components/CommandPalette.vue";
import { useUiStore } from "@/stores/ui";

let mounted: ReturnType<typeof mount> | null = null;

async function openPalette() {
  const router = createRouter({
    history: createWebHistory(),
    routes: [
      { path: "/", component: { template: "<div/>" } },
      { path: "/library", component: { template: "<div/>" } },
      { path: "/tools/utilities/:id?", component: { template: "<div/>" } },
      { path: "/tools/office/:id?", component: { template: "<div/>" } },
      { path: "/shop", component: { template: "<div/>" } },
      { path: "/downloads", component: { template: "<div/>" } },
      { path: "/settings", component: { template: "<div/>" } },
    ],
  });
  await router.push("/");
  await router.isReady();
  mounted = mount(CommandPalette, { global: { plugins: [router] } });
  useUiStore().commandPaletteOpen = true;
  await nextTick();
  await nextTick();
  return { router, input: document.body.querySelector<HTMLInputElement>(".palette__input")! };
}

describe("命令面板搜索测试", () => {
  it("空查询返回全部 31 个 utility actions", () => {
    const results = searchActions("");
    expect(results.length).toBe(31);
  });

  it("搜索 sha 返回哈希工具", () => {
    const results = searchActions("sha");
    expect(results.some((a) => a.id === "builtin.utilities.hash")).toBe(true);
  });

  it("搜索 guid 返回 UUID 工具", () => {
    const results = searchActions("guid");
    expect(results.some((a) => a.id === "builtin.utilities.uuid")).toBe(true);
  });

  it("搜索 编码 返回 Base64 和 URL 工具", () => {
    const results = searchActions("编码");
    const ids = results.map((a) => a.id);
    expect(ids).toContain("builtin.utilities.base64");
    expect(ids).toContain("builtin.utilities.url");
  });

  it("搜索 银行卡 返回 Luhn 工具", () => {
    const results = searchActions("银行卡");
    expect(results.some((a) => a.id === "builtin.utilities.luhn")).toBe(true);
  });

  it("搜索 jwt 返回 JWT 解码器", () => {
    const results = searchActions("jwt");
    expect(results.some((a) => a.id === "builtin.utilities.jwt")).toBe(true);
  });

  it("搜索 regex 返回正则工具", () => {
    const results = searchActions("regex");
    expect(results.some((a) => a.id === "builtin.utilities.regex")).toBe(true);
  });

  it("别名搜索 b64 返回 Base64", () => {
    const results = searchActions("b64");
    expect(results.some((a) => a.id === "builtin.utilities.base64")).toBe(true);
  });

  it("别名搜索 epoch 返回时间戳工具", () => {
    const results = searchActions("epoch");
    expect(results.some((a) => a.id === "builtin.utilities.timestamp")).toBe(true);
  });

  it("findAction 支持完整 ID", () => {
    const action = findAction("builtin.utilities.base64");
    expect(action).toBeDefined();
    expect(action?.route).toBe("/tools/utilities/base64");
  });

  it("findAction 支持短 ID 回退", () => {
    const action = findAction("json");
    expect(action).toBeDefined();
    expect(action?.id).toBe("builtin.utilities.json");
  });

  it("findAction 未知 ID 返回 undefined", () => {
    expect(findAction("nonexistent.tool")).toBeUndefined();
  });

  it("shortIdToAction 正确构造完整 ID", () => {
    expect(shortIdToAction("base64")).toBe("builtin.utilities.base64");
    expect(shortIdToAction("builtin.utilities.json")).toBe("builtin.utilities.json");
  });

  it("actionToShortId 正确提取短 ID", () => {
    expect(actionToShortId("builtin.utilities.hash")).toBe("hash");
    expect(actionToShortId("hash")).toBe("hash");
  });

  it("每个 action 有稳定路由", () => {
    for (const action of UTIL_ACTIONS) {
      expect(action.route).toMatch(/^\/tools\/utilities\//);
      expect(action.id).toMatch(/^builtin\.utilities\./);
    }
  });

  it("每个 action 支持收藏和最近使用", () => {
    for (const action of UTIL_ACTIONS) {
      expect(action.supportsFavorite).toBe(true);
      expect(action.supportsRecent).toBe(true);
    }
  });

  it("敏感工具有 sensitiveInput 标记", () => {
    const password = findAction("builtin.utilities.password");
    const jwt = findAction("builtin.utilities.jwt");
    expect(password?.sensitiveInput).toBe(true);
    expect(jwt?.sensitiveInput).toBe(true);
  });

  it("非敏感工具没有 sensitiveInput 标记", () => {
    const base64 = findAction("builtin.utilities.base64");
    expect(base64?.sensitiveInput).toBe(false);
  });
});

describe("CommandPalette accessibility contract", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });
  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = "";
  });

  it("keeps descriptor metadata identical before and after a query and lists /library", async () => {
    const { input } = await openPalette();
    const findBase64 = () => [...document.body.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.textContent?.includes("Base64 编解码"));
    const before = findBase64()?.querySelector(".palette__sub")?.textContent;
    expect(before).toContain("发布者：useful.project");
    expect(before).toContain("GUI · CLI · MCP");
    expect(document.body.textContent).toContain("工具库");

    input.value = "b64";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    const after = findBase64()?.querySelector(".palette__sub")?.textContent;
    expect(after).toBe(before);
  });

  it("searches translated names/descriptions with shared NFKC multi-token matching", async () => {
    const { input } = await openPalette();
    input.value = "Ｂ６４ UTF-8";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    const options = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain("Base64 编解码");
  });

  it("discovers and opens Office actions through the same catalog", async () => {
    const { input, router } = await openPalette();
    input.value = "word markdown";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    const options = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain("Word / DOCX");
    options[0].click();
    await flushPromises();
    expect(ipcMock.recordActionUse).not.toHaveBeenCalled();
    expect(router.currentRoute.value.fullPath).toBe("/tools/office/docx");
  });

  it("connects combobox/listbox/option state and scrolls the active option into view", async () => {
    const { input } = await openPalette();
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-controls")).toBe("command-palette-listbox");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await nextTick();
    await nextTick();
    expect(input.getAttribute("aria-activedescendant")).toBe("command-palette-option-1");
    expect(document.getElementById("command-palette-option-1")?.getAttribute("aria-selected")).toBe("true");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("restores focus after Escape and overlay dismissal", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    let { input } = await openPalette();
    expect(document.activeElement).toBe(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await nextTick();
    await nextTick();
    expect(document.activeElement).toBe(opener);

    useUiStore().commandPaletteOpen = true;
    await nextTick();
    await nextTick();
    input = document.body.querySelector<HTMLInputElement>(".palette__input")!;
    document.body.querySelector<HTMLElement>(".palette-overlay")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    await nextTick();
    expect(document.activeElement).toBe(opener);
  });
});
