import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";

const ipcMock = vi.hoisted(() => ({
  trpSourceList: vi.fn().mockResolvedValue([]),
  sourceList: vi.fn().mockResolvedValue([{ id: "legacy", name: "Legacy", url: "https://legacy/index.json", publicKey: "aa", fingerprint: "aa", enabled: true, lastRefreshedAt: null, packageCount: 1 }]),
  sourceAdd: vi.fn().mockResolvedValue({}),
  sourceRefresh: vi.fn().mockResolvedValue({}),
  sourceSetEnabled: vi.fn().mockResolvedValue(undefined),
  sourceRemove: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/ipc", () => ({ default: ipcMock }));

import SourceCenterView from "./SourceCenterView.vue";

describe("Source Center compatibility source management", () => {
  beforeEach(() => { vi.clearAllMocks(); window.confirm = vi.fn(() => true); });

  it("keeps legacy catalog CRUD reachable after Tool Shop source-add removal", async () => {
    const wrapper = mount(SourceCenterView);
    await flushPromises();
    expect(wrapper.find('[data-testid="legacy-source-section"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="legacy-source-card"]').text()).toContain("Legacy");
    await wrapper.find('[data-testid="legacy-refresh"]').trigger("click");
    expect(ipcMock.sourceRefresh).toHaveBeenCalledWith("legacy");
    await wrapper.find('[data-testid="legacy-toggle"]').trigger("click");
    expect(ipcMock.sourceSetEnabled).toHaveBeenCalledWith("legacy", false);
    await wrapper.find('[data-testid="legacy-remove"]').trigger("click");
    expect(ipcMock.sourceRemove).toHaveBeenCalledWith("legacy");
    await wrapper.find('[data-testid="legacy-url"]').setValue("https://new/index.json");
    await wrapper.find('[data-testid="legacy-add"]').trigger("click");
    expect(ipcMock.sourceAdd).toHaveBeenCalledWith("https://new/index.json", undefined);
  });

  it("shows the client-observed delivery type for a static object-store source", async () => {
    ipcMock.trpSourceList.mockResolvedValueOnce([
      {
        id: "com.example.static",
        kind: "tool",
        discoveryUrl: "https://cdn.example/.well-known/useful-repository.json",
        displayName: "Example static source",
        operator: "Example",
        local: false,
        enabled: true,
        priority: 100,
        rootKeyFingerprint: "aa".repeat(32),
        trustConfirmedAt: 1,
        capabilities: { catalog: true, staticMirror: true },
        deliveryType: "static-https",
        lastSyncAt: 1,
        lastSyncStatus: "ok",
        lastSyncError: null,
        lastSyncDurationMs: 10,
        entryCount: 1,
        isOfficial: false,
      },
    ]);
    const wrapper = mount(SourceCenterView);
    await flushPromises();
    expect(wrapper.get('[data-testid="delivery-type-badge"]').text()).toContain(
      "静态 HTTPS / S3 兼容存储",
    );
  });
});
