import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createRouter, createWebHistory } from "vue-router";
import type { AppUpdateSourceInfo } from "@/lib/types";
import { setLocale } from "@/i18n";

const ipcMock = vi.hoisted(() => ({
  updateSetting: vi.fn().mockResolvedValue(undefined),
  openPath: vi.fn().mockResolvedValue(undefined),
  diagnosticsPreview: vi.fn().mockResolvedValue([]),
  diagnosticsExport: vi.fn().mockResolvedValue("feedback.zip"),
  appUpdateSourceGet: vi.fn().mockResolvedValue({
    updateFeedUrl: "https://example.test/stable.json",
    channel: "stable",
    isOfficial: true,
    isDefaultOfficial: true,
    usingDevelopmentUpdateTrust: false,
    rootFingerprint: "AA:BB",
    warningAcknowledgedAt: null,
    currentVersion: "1.0.0",
    pendingUpdate: false,
    bootstrapPresent: true,
  }),
  appUpdateSourceSetCustom: vi.fn(),
  appUpdateSourceResetOfficial: vi.fn(),
  appUpdateChannelSet: vi.fn().mockImplementation(async (channel: string) => ({
    ...(await ipcMock.appUpdateSourceGet()), channel,
  })),
}));
vi.mock("@/lib/ipc", () => ({ default: ipcMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn().mockResolvedValue(null) }));

import SettingsView from "@/views/SettingsView.vue";
import { useUiStore } from "@/stores/ui";

function updateSource(overrides: Partial<AppUpdateSourceInfo> = {}): AppUpdateSourceInfo {
  return {
    updateFeedUrl: "https://example.test/stable.json",
    channel: "stable",
    isOfficial: true,
    isDefaultOfficial: true,
    usingDevelopmentUpdateTrust: false,
    rootFingerprint: "AA:BB",
    warningAcknowledgedAt: null,
    currentVersion: "1.0.0",
    pendingUpdate: false,
    bootstrapPresent: true,
    ...overrides,
  };
}

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: { template: "<div/>" } },
    { path: "/sources", component: { template: "<div/>" } },
  ],
});

describe("SettingsView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    setLocale("zh-CN");
    ipcMock.appUpdateSourceGet.mockResolvedValue(updateSource());
    setActivePinia(createPinia());
  });

  function mountView() {
    return mount(SettingsView, {
      global: {
        plugins: [router],
        stubs: { AgentProfilePanel: true, PerfPanel: true },
      },
    });
  }

  it("switches locale immediately and keeps the Settings entry keyboard-operable and non-hideable", async () => {
    const wrapper = mountView();
    const ui = useUiStore();
    const locale = wrapper.get("select.useful-select");
    await locale.setValue("en-US");
    expect(ui.language).toBe("en-US");
    expect(wrapper.get("h1").text()).toBe("Settings");
    expect(document.documentElement.lang).toBe("en-US");

    const layout = wrapper.get('[data-testid="navigation-layout-settings"]');
    const settingsRow = layout.findAll("li").find((row) => row.text().includes("Settings"))!;
    expect(settingsRow.get('input[type="checkbox"]').attributes()).toHaveProperty("disabled");
    expect(settingsRow.findAll("button")[0].element.tagName).toBe("BUTTON");

    const moveHomeDown = layout.get('button[aria-label="Move Home down"]');
    expect(moveHomeDown.attributes("disabled")).toBeUndefined();
    await moveHomeDown.trigger("click");
    expect(ui.navigationLayout.nav.slice(0, 2).map((item) => item.id)).toEqual(["library", "home"]);
    expect(JSON.parse(localStorage.getItem("useful.navigation-layout.v1")!).nav.slice(0, 2).map((item: { id: string }) => item.id)).toEqual(["library", "home"]);
  });

  it("offers the nightly update channel", async () => {
    const wrapper = mountView();
    await flushPromises();
    const nightly = wrapper.findAll('[data-testid="update-channel"] button').find((button) => button.text() === "Nightly")!;
    await nightly.trigger("click");
    expect(ipcMock.appUpdateChannelSet).toHaveBeenCalledWith("nightly");
  });

  it("labels the production default as official and offers no redundant reset", async () => {
    ipcMock.appUpdateSourceGet.mockResolvedValue(updateSource());
    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.get('[data-testid="update-official-badge"]').text()).toBe("官方预置");
    expect(wrapper.find('[data-testid="update-development-trust-badge"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="update-custom-badge"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="reset-official-update-source"]').exists()).toBe(false);
  });

  it("shows bundled development trust as its own warning state without a reset action", async () => {
    ipcMock.appUpdateSourceGet.mockResolvedValue(updateSource({
      updateFeedUrl: "https://qa-update.example.test/feed.json",
      isOfficial: false,
      isDefaultOfficial: false,
      usingDevelopmentUpdateTrust: true,
    }));
    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.get('[data-testid="update-development-trust-badge"]').text()).toBe("开发更新信任");
    expect(wrapper.get('[data-testid="development-update-trust-warning"]').text()).toContain("既不是官方生产更新源，也不是用户配置的自定义源");
    expect(wrapper.find('[data-testid="update-official-badge"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="update-custom-badge"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="reset-official-update-source"]').exists()).toBe(false);
  });

  it("labels a real custom source and offers restoration to official", async () => {
    ipcMock.appUpdateSourceGet.mockResolvedValue(updateSource({
      updateFeedUrl: "https://updates.example.test/feed.json",
      isOfficial: false,
      isDefaultOfficial: false,
      usingDevelopmentUpdateTrust: false,
    }));
    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.get('[data-testid="update-custom-badge"]').text()).toBe("自定义更新源");
    expect(wrapper.find('[data-testid="update-development-trust-badge"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="reset-official-update-source"]').text()).toBe("恢复官方更新源");
  });
});
