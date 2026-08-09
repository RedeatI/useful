import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createRouter, createWebHistory } from "vue-router";
import { nextTick } from "vue";

const ipcMock = vi.hoisted(() => ({
  navigationPinSet: vi.fn().mockResolvedValue(undefined),
  toggleActionFavorite: vi.fn().mockResolvedValue(true),
  toggleFavorite: vi.fn().mockResolvedValue(true),
  recordActionUse: vi.fn().mockResolvedValue(undefined),
  recordToolUse: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/ipc", () => ({ default: ipcMock }));

import ToolLibraryView from "./ToolLibraryView.vue";
import { useAppStore } from "@/stores/app";
import { BUILTIN_ACTION_DESCRIPTORS } from "@useful/action-runtime/browser";

function routerForTest() {
  return createRouter({
    history: createWebHistory(),
    routes: [
      { path: "/library", component: { template: "<div/>" } },
      { path: "/settings", component: { template: "<div/>" } },
      { path: "/tools/utilities/:id?", component: { template: "<div/>" } },
      { path: "/tools/office/:id?", component: { template: "<div/>" } },
      { path: "/plugin/:id", component: { template: "<div/>" } },
    ],
  });
}

describe("ToolLibraryView", () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks(); });

  it("filters descriptor-backed Agent actions and keeps pin/exposure controls distinct", async () => {
    const router = routerForTest();
    await router.push("/library");
    await router.isReady();
    const wrapper = mount(ToolLibraryView, { global: { plugins: [router] } });
    await wrapper.findAll("button").find((button) => button.text() === "Agent 可用")!.trigger("click");
    expect(wrapper.findAll("article.library-card")).toHaveLength(BUILTIN_ACTION_DESCRIPTORS.length);
    expect(wrapper.text()).toContain("发布者 useful.project");
    expect(wrapper.text()).toContain("CLI");
    expect(wrapper.text()).toContain("MCP");

    const base64 = wrapper.findAll("article.library-card")
      .find((card) => card.text().includes("builtin.utilities.base64"))!;
    await base64.findAll("button").find((button) => button.text() === "固定到快捷访问")!.trigger("click");
    expect(ipcMock.navigationPinSet).toHaveBeenCalledWith("builtin.utilities.base64", true);
    expect(base64.text()).toContain("Agent 配置");
    await base64.findAll("button").find((button) => button.text() === "Agent 配置")!.trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe("/settings?section=agent&action=builtin.utilities.base64");

    await wrapper.get<HTMLSelectElement>('[data-testid="library-category"]').setValue("office");
    await nextTick();
    const office = wrapper.findAll("article.library-card")
      .find((card) => card.text().includes("builtin.office.docx"))!;
    await office.findAll("button").find((button) => button.text() === "打开 GUI")!.trigger("click");
    await flushPromises();
    expect(ipcMock.recordActionUse).not.toHaveBeenCalled();
    expect(router.currentRoute.value.fullPath).toBe("/tools/office/docx");
  });

  it("does not guess plugin CLI/MCP support and searches the unified model", async () => {
    const store = useAppStore();
    store.tools = [{
      id: "com.example.plugin", name: "示例插件", description: "第三方工具", icon: "", route: "/plugin/com.example.plugin",
      category: "installed", kind: "web", order: 100, supportsShortcut: true, requiredCapabilities: ["clipboard.read"], version: "1.0.0",
    }];
    const router = routerForTest();
    await router.push("/library");
    await router.isReady();
    const wrapper = mount(ToolLibraryView, { global: { plugins: [router] } });
    const search = wrapper.get<HTMLInputElement>('input[placeholder="搜索名称、ID 或关键词"]');
    await search.setValue("示例插件");
    await nextTick();
    const plugin = wrapper.get("article.library-card");
    expect(plugin.text()).toContain("GUI");
    expect(plugin.text()).not.toContain("CLI");
    expect(plugin.text()).not.toContain("MCP");
    expect(plugin.text()).toContain("需 runtime 验证");

    await wrapper.get<HTMLSelectElement>('[data-testid="library-category"]').setValue("plugin");
    await search.setValue("");
    await nextTick();
    expect(wrapper.findAll("article.library-card").map((card) => card.text())).toHaveLength(1);
    expect(wrapper.get("article.library-card").text()).toContain("com.example.plugin");
  });

  it("offers recommended/name/category/source sorting with deterministic output", async () => {
    const router = routerForTest();
    await router.push("/library");
    await router.isReady();
    const wrapper = mount(ToolLibraryView, { global: { plugins: [router] } });
    const sort = wrapper.get<HTMLSelectElement>('[data-testid="library-sort"]');
    const ids = () => wrapper.findAll("article.library-card code").map((node) => node.text());

    expect(sort.findAll("option").map((option) => option.attributes("value"))).toEqual([
      "recommended", "name", "category", "source",
    ]);
    await sort.setValue("name");
    await nextTick();
    const first = ids();
    await sort.setValue("recommended");
    await sort.setValue("name");
    await nextTick();
    expect(ids()).toEqual(first);
  });

  it("suggests only local catalog actions from an explicit content sample", async () => {
    const router = routerForTest();
    await router.push("/library");
    await router.isReady();
    const wrapper = mount(ToolLibraryView, { global: { plugins: [router] } });
    const sample = wrapper.get<HTMLTextAreaElement>("#library-smart-sample");
    await sample.setValue('{"secret":"DO_NOT_COPY"}');
    await nextTick();

    const suggestions = wrapper.findAll("button.library__smart-result");
    expect(suggestions.length).toBeGreaterThanOrEqual(2);
    expect(suggestions[0].text()).toContain("JSON");
    expect(suggestions.some((button) => button.text().includes("YAML"))).toBe(true);
    expect(suggestions.every((button) => !button.text().includes("DO_NOT_COPY"))).toBe(true);

    await suggestions[0].trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe("/tools/utilities/json");
  });
});
