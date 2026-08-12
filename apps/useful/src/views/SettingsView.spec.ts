import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createRouter, createWebHistory } from "vue-router";
import type { AppUpdateSourceInfo } from "@/lib/types";
import { getLocale, resetLocaleForTests, t } from "@/i18n";
import enUS from "@/i18n/en-US";

const ipcMock = vi.hoisted(() => ({
  getSettings: vi.fn().mockResolvedValue({ theme: "system", language: "zh-CN", developerMode: false, sidebarCollapsed: false }),
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
    resetLocaleForTests(async () => ({ default: enUS }));
    ipcMock.appUpdateSourceGet.mockResolvedValue(updateSource());
    setActivePinia(createPinia());
  });

  function mountView(stubs: Record<string, unknown> = {}) {
    return mount(SettingsView, {
      global: {
        plugins: [router],
        stubs: { AgentProfilePanel: true, AgentConnectionPanel: true, PerfPanel: true, ...stubs },
      },
    });
  }

  it("switches locale immediately and keeps the Settings entry keyboard-operable and non-hideable", async () => {
    const wrapper = mountView();
    const ui = useUiStore();
    const locale = wrapper.get("select.useful-select");
    await locale.setValue("en-US");
    await flushPromises();
    expect(ui.language).toBe("en-US");
    expect(wrapper.get("h1").text()).toBe("Settings");
    expect(document.documentElement.lang).toBe("en-US");
    expect(ipcMock.updateSetting).toHaveBeenCalledWith("language", "en-US");

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

  it("lets a visible pending English hydration be changed back to Chinese", async () => {
    let resolveEnglish!: (module: { default: Record<string, unknown> }) => void;
    resetLocaleForTests(vi.fn(() => new Promise<{ default: Record<string, unknown> }>((resolve) => {
      resolveEnglish = resolve;
    })));
    ipcMock.getSettings.mockResolvedValueOnce({ theme: "system", language: "en-US", developerMode: false, sidebarCollapsed: false });
    const wrapper = mountView();
    const ui = useUiStore();
    const loading = ui.load();

    await flushPromises();
    const locale = wrapper.get("select.useful-select");
    expect((locale.element as HTMLSelectElement).value).toBe("en-US");
    expect(ui.requestedLanguage).toBe("en-US");
    expect(ui.language).toBe("zh-CN");

    await locale.setValue("zh-CN");
    await flushPromises();
    expect(ui.requestedLanguage).toBe("zh-CN");
    expect(ipcMock.updateSetting).toHaveBeenCalledWith("language", "zh-CN");

    resolveEnglish({ default: enUS });
    await loading;
    await flushPromises();

    expect((locale.element as HTMLSelectElement).value).toBe("zh-CN");
    expect(ui.language).toBe("zh-CN");
    expect(ui.requestedLanguage).toBe("zh-CN");
    expect(getLocale()).toBe("zh-CN");
    expect(t("nav.home")).toBe("首页");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(ipcMock.updateSetting.mock.calls.filter(([key]) => key === "language")).toEqual([
      ["language", "zh-CN"],
    ]);
  });

  it("rolls the native select back after persisted English hydration fails", async () => {
    let rejectEnglish!: (reason: Error) => void;
    resetLocaleForTests(vi.fn(() => new Promise<{ default: Record<string, unknown> }>((_resolve, reject) => {
      rejectEnglish = reject;
    })));
    ipcMock.getSettings.mockResolvedValueOnce({ theme: "system", language: "en-US", developerMode: false, sidebarCollapsed: false });
    const wrapper = mountView();
    const ui = useUiStore();
    const loading = ui.load();

    await flushPromises();
    const locale = wrapper.get("select.useful-select");
    expect((locale.element as HTMLSelectElement).value).toBe("en-US");
    expect(ui.requestedLanguage).toBe("en-US");
    expect(ui.language).toBe("zh-CN");

    rejectEnglish(new Error("chunk unavailable"));
    await loading;
    await flushPromises();

    expect((locale.element as HTMLSelectElement).value).toBe("zh-CN");
    expect(ui.language).toBe("zh-CN");
    expect(ui.requestedLanguage).toBe("zh-CN");
    expect(getLocale()).toBe("zh-CN");
    expect(t("nav.home")).toBe("首页");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(ipcMock.updateSetting).not.toHaveBeenCalledWith("language", "en-US");
  });

  it("offers the nightly update channel", async () => {
    const wrapper = mountView();
    await flushPromises();
    const nightly = wrapper.findAll('[data-testid="update-channel"] button').find((button) => button.text() === "Nightly")!;
    await nightly.trigger("click");
    expect(ipcMock.appUpdateChannelSet).toHaveBeenCalledWith("nightly");
  });

  it("keeps the profile and connection inspectors in separate settings sections", () => {
    const wrapper = mountView();
    expect(wrapper.get("#agent-settings").find("agent-profile-panel-stub").exists()).toBe(true);
    expect(wrapper.get("#agent-connections").find("agent-connection-panel-stub").exists()).toBe(true);
  });

  it("isolates errors from each async Agent panel", async () => {
    function ThrowingProfile(): never {
      throw new Error("profile-only");
    }
    let wrapper = mountView({ AgentProfilePanel: ThrowingProfile });
    await flushPromises();
    expect(wrapper.get("#agent-settings").text()).toContain("profile-only");
    expect(wrapper.get("#agent-connections").text()).not.toContain("profile-only");
    wrapper.unmount();

    function ThrowingConnections(): never {
      throw new Error("connections-only");
    }
    wrapper = mountView({ AgentConnectionPanel: ThrowingConnections });
    await flushPromises();
    expect(wrapper.get("#agent-connections").text()).toContain("connections-only");
    expect(wrapper.get("#agent-settings").text()).not.toContain("connections-only");
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
