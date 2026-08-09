// ToolShopView 渲染冒烟测试：验证重写后的工具铺视图能挂载并渲染结构
// （源管理表单/分区标题/空状态），IPC 以 mock 提供（等价于浏览器中无 Tauri 后端时的渲染）。
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createRouter, createWebHistory } from "vue-router";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/ipc", () => ({
  default: {
    getSettings: vi.fn().mockResolvedValue({
      theme: "light",
      language: "zh-CN",
      developerMode: true,
      sidebarCollapsed: false,
    }),
    updateSetting: vi.fn().mockResolvedValue(undefined),
    sourceList: vi.fn().mockResolvedValue([]),
    shopCatalog: vi.fn().mockResolvedValue([{
      sourceId: "legacy.source",
      id: "com.test.legacy",
      version: "1.0.0",
      size: 1,
      changelog: "legacy",
      category: "test",
      permissions: [],
      minHostVersion: "0.1.0",
      installedVersion: null,
      updateAvailable: false,
      downgrade: false,
      pinned: false,
    }]),
    downloadAndInstall: vi.fn(),
    listShortcuts: vi.fn().mockResolvedValue([]),
  },
}));

import ToolShopView from "@/views/ToolShopView.vue";
import { useUiStore } from "@/stores/ui";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: { template: "<div/>" } },
    { path: "/sources", component: { template: "<div/>" } },
  ],
});

describe("ToolShopView 渲染", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("挂载后只提供源中心入口，并保留可安装/已安装分区", async () => {
    const ui = useUiStore();
    ui.developerMode = true; // 触发开发者模式非 HTTPS 源警告
    const wrapper = mount(ToolShopView, { global: { plugins: [router] } });
    await router.isReady();
    await Promise.resolve();
    await Promise.resolve();

    const text = wrapper.text();
    // 分区标题
    expect(text).toContain("发现与安装");
    expect(text).toContain("可安装工具");
    expect(text).toContain("已安装的工具");
    // 旧 source-add UI 已移除，兼容索引源与 TRP 源都从 Source Center 分区管理
    expect(wrapper.find("input.source-add__url").exists()).toBe(false);
    expect(wrapper.find('[data-testid="source-management-link"]').text()).toContain("管理软件源");
    // 开发者模式显著警告
    expect(text).toContain("开发者模式已允许非 HTTPS 源");
    // 权限对话框默认不显示
    expect(wrapper.find('[data-testid="perm-dialog"]').exists()).toBe(false);
    expect(wrapper.find(".pkg-item__actions .useful-btn--primary").exists()).toBe(false);
  });
});
