import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";

const dialogMock = vi.hoisted(() => ({ confirm: vi.fn().mockResolvedValue(true) }));
vi.mock("@tauri-apps/plugin-dialog", () => dialogMock);

const ipcMock = vi.hoisted(() => ({
  trpSourceList: vi.fn().mockResolvedValue([]),
  sourceList: vi.fn().mockResolvedValue([{ id: "legacy", name: "Legacy", url: "https://legacy/index.json", publicKey: "aa", fingerprint: "aa", enabled: true, lastRefreshedAt: null, packageCount: 1 }]),
  sourceAdd: vi.fn().mockResolvedValue({}),
  sourceRefresh: vi.fn().mockResolvedValue({}),
  sourceSetEnabled: vi.fn().mockResolvedValue(undefined),
  sourceRemove: vi.fn().mockResolvedValue(undefined),
  trpCatalogSearch: vi.fn(),
  trpInstall: vi.fn(),
  trpInstalledOrigin: vi.fn(),
}));
vi.mock("@/lib/ipc", () => ({ default: ipcMock }));

import SourceCenterView from "./SourceCenterView.vue";

const publisherKeyId = `ed25519:${"a".repeat(64)}`;
const artifactSha256 = "b".repeat(64);
const manifestDigest = "c".repeat(64);

function source() {
  return {
    id: "com.example.source",
    kind: "tool" as const,
    discoveryUrl: "https://source.example/.well-known/useful-repository.json",
    displayName: "Example source",
    operator: "Example",
    local: false,
    enabled: true,
    priority: 100,
    rootKeyFingerprint: "aa".repeat(32),
    trustConfirmedAt: 1,
    capabilities: { catalog: true, authentication: true },
    deliveryType: "dynamic" as const,
    lastSyncAt: 1,
    lastSyncStatus: "ok" as const,
    lastSyncError: null,
    lastSyncDurationMs: 10,
    entryCount: 1,
    isOfficial: false,
  };
}

function result(publisher = publisherKeyId, nameConflict = false) {
  return {
    item: {
      sourceId: "com.example.source",
      sourcePriority: 100,
      publisherKeyId: publisher,
      toolId: "com.example.tool",
      name: "Example tool",
      summary: "Example summary",
      license: "Apache-2.0",
      latestStable: "1.2.3",
      latestStableDigest: artifactSha256,
      accessMode: "free",
      isNativeWorker: false,
      repositorySignatureVerified: false,
      publisherSignatureVerified: false,
      officialReviewPassed: false,
      securityScanPassed: false,
      availability: { status: "healthy" as const },
      advisoryCount: 0,
      maxAdvisorySeverity: null,
      permissions: ["filesystem.read"],
      candidateVersion: "1.2.3",
      candidateArtifactSha256: artifactSha256,
      candidateManifestDigest: manifestDigest,
      candidateChannel: "stable",
    },
    mirrorSourceIds: [],
    nameConflict,
  };
}

describe("Source Center compatibility source management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dialogMock.confirm.mockResolvedValue(true);
  });

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

  it("shows directory permissions before installation, retains same tool IDs from different publishers, and only displays verified facts after matching origin readback", async () => {
    ipcMock.trpSourceList.mockResolvedValueOnce([source()]);
    ipcMock.trpCatalogSearch.mockResolvedValueOnce([
      result(),
      result(`ed25519:${"d".repeat(64)}`, true),
    ]);
    ipcMock.trpInstall.mockResolvedValueOnce({ name: "Example tool" });
    ipcMock.trpInstalledOrigin.mockResolvedValueOnce({
      sourceId: "com.example.source",
      publisherKeyId,
      toolId: "com.example.tool",
      installedVersion: "1.2.3",
      artifactSha256,
      channel: "stable",
      manifestDigest,
    });
    const wrapper = mount(SourceCenterView);
    await flushPromises();
    await wrapper.get('[data-testid="search-input"]').setValue("example");
    await wrapper.get('[data-testid="search-btn"]').trigger("click");
    await flushPromises();

    const cards = wrapper.findAll('[data-testid="search-result"]');
    expect(cards).toHaveLength(2);
    const first = cards[0];
    const second = cards[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) return;
    expect(first.text()).toContain("软件包权限");
    expect(first.text()).toContain("filesystem.read");
    expect(wrapper.find('[data-testid="client-verified-facts"]').exists()).toBe(false);
    expect(first.text()).toContain(publisherKeyId.slice(-4));
    expect(second.text()).toContain("dddd");

    await first.get('[data-testid="install-btn"]').trigger("click");
    await flushPromises();
    expect(ipcMock.trpInstall).toHaveBeenCalledWith(
      "com.example.source", publisherKeyId, "com.example.tool", false,
    );
    expect(ipcMock.trpInstalledOrigin).toHaveBeenCalledWith("com.example.tool");
    expect(wrapper.get('[data-testid="client-verified-facts"]').text()).toContain("客户端已验证的安装事实");
  });

  it("does not display client-verified facts when the post-install origin differs", async () => {
    ipcMock.trpSourceList.mockResolvedValueOnce([source()]);
    ipcMock.trpCatalogSearch.mockResolvedValueOnce([result()]);
    ipcMock.trpInstall.mockResolvedValueOnce({ name: "Example tool" });
    ipcMock.trpInstalledOrigin.mockResolvedValueOnce({
      sourceId: "com.example.source",
      publisherKeyId: `ed25519:${"e".repeat(64)}`,
      toolId: "com.example.tool",
      installedVersion: "1.2.3",
      artifactSha256,
      channel: "stable",
      manifestDigest,
    });
    const wrapper = mount(SourceCenterView);
    await flushPromises();
    await wrapper.get('[data-testid="search-input"]').setValue("example");
    await wrapper.get('[data-testid="search-btn"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-testid="install-btn"]').trigger("click");
    await flushPromises();
    expect(ipcMock.trpInstalledOrigin).toHaveBeenCalledWith("com.example.tool");
    expect(wrapper.find('[data-testid="client-verified-facts"]').exists()).toBe(false);
  });
});
