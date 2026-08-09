import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createRouter, createWebHistory } from "vue-router";

const ipcMock = vi.hoisted(() => ({
  recordToolUse: vi.fn().mockResolvedValue(undefined),
  recordActionUse: vi.fn().mockResolvedValue(undefined),
  updateSetting: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/ipc", () => ({ default: ipcMock }));

import AppSidebar from "@/components/AppSidebar.vue";
import { useAppStore } from "@/stores/app";
import { useUiStore } from "@/stores/ui";

function createTestRouter() {
  return createRouter({
    history: createWebHistory(),
    routes: [
      { path: "/", component: { template: "<div/>" } },
      { path: "/library", component: { template: "<div/>" } },
      { path: "/tools/utilities/:id?", component: { template: "<div/>" } },
      { path: "/plugin/:id", component: { template: "<div/>" } },
      { path: "/shop", component: { template: "<div/>" } },
      { path: "/downloads", component: { template: "<div/>" } },
      { path: "/settings", component: { template: "<div/>" } },
    ],
  });
}

describe("AppSidebar customizable navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setActivePinia(createPinia());
  });

  it("shows only pinned quick access items and keeps source management out of the top level", async () => {
    const store = useAppStore();
    store.tools = [{
      id: "com.example.zzz", name: "我的插件工具", description: "", icon: "", route: "/plugin/com.example.zzz",
      category: "installed", kind: "web", order: 100, supportsShortcut: true, requiredCapabilities: [], version: "1.0.0",
    }];
    store.navigationPins = ["com.example.zzz", "builtin.utilities.base64"];
    const router = createTestRouter();
    await router.push("/library");
    await router.isReady();
    const wrapper = mount(AppSidebar, { global: { plugins: [router] } });

    expect(wrapper.text()).toContain("我的插件工具");
    expect(wrapper.text()).toContain("Base64 编解码");
    expect(wrapper.text()).not.toContain("源中心");
    expect(wrapper.get('button[title="工具库"]').attributes("aria-current")).toBe("page");
  });

  it("records the correct recent-use kind before navigating a pinned item", async () => {
    const store = useAppStore();
    store.tools = [{
      id: "com.example.zzz", name: "我的插件工具", description: "", icon: "", route: "/plugin/com.example.zzz",
      category: "installed", kind: "web", order: 100, supportsShortcut: true, requiredCapabilities: [], version: "1.0.0",
    }];
    store.navigationPins = ["com.example.zzz", "builtin.utilities.base64"];
    const router = createTestRouter();
    await router.push("/");
    await router.isReady();
    const wrapper = mount(AppSidebar, { global: { plugins: [router] } });

    await wrapper.get('button[title="Base64 编解码"]').trigger("click");
    expect(ipcMock.recordActionUse).not.toHaveBeenCalled();
    await wrapper.get('button[title="我的插件工具"]').trigger("click");
    expect(ipcMock.recordToolUse).toHaveBeenCalledWith("com.example.zzz");
  });

  it("explains empty quick access without losing the stable library entry", async () => {
    const router = createTestRouter();
    await router.push("/");
    await router.isReady();
    const wrapper = mount(AppSidebar, { global: { plugins: [router] } });
    expect(wrapper.text()).toContain("在工具库中固定常用工具或 Action");
    expect(wrapper.get('button[title="工具库"]')).toBeTruthy();
  });

  it("applies only the closed navigation layout and never hides settings", async () => {
    const ui = useUiStore();
    ui.setLayoutItemVisible("nav", "shop", false);
    ui.setLayoutItemVisible("nav", "settings", false);
    ui.moveLayoutItem("nav", "settings", -1);
    const router = createTestRouter();
    await router.push("/");
    await router.isReady();
    const wrapper = mount(AppSidebar, { global: { plugins: [router] } });

    expect(wrapper.find('button[title="发现与安装"]').exists()).toBe(false);
    expect(wrapper.get('button[title="设置"]').element.tagName).toBe("BUTTON");
  });

  it("exposes a stable entry to customize navigation layout", async () => {
    const router = createTestRouter();
    await router.push("/");
    await router.isReady();
    const push = vi.spyOn(router, "push");
    const wrapper = mount(AppSidebar, { global: { plugins: [router] } });
    const button = wrapper.get('button[title="自定义导航"]');
    expect(button.text()).toContain("自定义导航");
    await button.trigger("click");
    expect(push).toHaveBeenCalledWith({ path: "/settings", hash: "#navigation-layout" });
  });

});
