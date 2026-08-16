import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import TrustFactCard from "./TrustFactCard.vue";

const publisherKeyId = `ed25519:${"a".repeat(64)}`;
const artifactSha256 = "b".repeat(64);
const manifestDigest = "c".repeat(64);

function props(withVerified = false) {
  const directory = {
    sourceId: "com.example.source",
    publisherKeyId,
    toolId: "com.example.tool",
    version: "1.2.3",
    artifactSha256,
    channel: "stable" as const,
    manifestDigest,
    permissions: ["filesystem.read", "network.connect"],
  };
  return {
    sourceId: directory.sourceId,
    sourceCapabilities: { catalog: true, authentication: true },
    availability: { status: "healthy" as const, checkedAt: "2026-08-16T00:00:00Z" },
    directory,
    verified: withVerified,
  };
}

describe("TrustFactCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("keeps source-reported, directory-declared, and client-verified layers separate", () => {
    const withoutOrigin = mount(TrustFactCard, { props: props() });
    expect(withoutOrigin.get('[data-testid="source-reported-facts"]').text()).toContain("来源自报事实");
    expect(withoutOrigin.get('[data-testid="directory-declared-facts"]').text()).toContain("软件包权限");
    expect(withoutOrigin.get('[data-testid="package-permissions"]').text()).toContain("filesystem.read");
    expect(withoutOrigin.find('[data-testid="client-verified-facts"]').exists()).toBe(false);

    const withOrigin = mount(TrustFactCard, { props: props(true) });
    expect(withOrigin.get('[data-testid="client-verified-facts"]').text()).toContain("客户端已验证的安装事实");
  });

  it("copies only after an explicit click and exports the full allowlist values without sensitive fields", async () => {
    const writeText = vi.mocked(navigator.clipboard.writeText);
    const wrapper = mount(TrustFactCard, { props: props(true) });
    expect(writeText).not.toHaveBeenCalled();

    await wrapper.get('[data-testid="copy-trust-facts"]').trigger("click");
    expect(writeText).toHaveBeenCalledOnce();
    const copied = writeText.mock.calls[0]?.[0];
    expect(typeof copied).toBe("string");
    const payload = JSON.parse(copied as string) as Record<string, unknown>;
    expect(payload).toMatchObject({
      directoryDeclared: { publisherKeyId, artifactSha256, manifestDigest },
      clientVerifiedInstalled: { publisherKeyId, artifactSha256, manifestDigest },
    });
    expect(copied).not.toContain("discoveryUrl");
    expect(copied).not.toContain("token");
    expect(copied).not.toContain("account");
    expect(wrapper.text()).toContain("事实已复制");
  });

  it("explains clipboard write failure without reading from the clipboard", async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error("CLIPBOARD_DENIED"));
    const wrapper = mount(TrustFactCard, { props: props() });
    await wrapper.get('[data-testid="copy-trust-facts"]').trigger("click");
    expect(wrapper.text()).toContain("复制事实 JSON 失败");
    expect(wrapper.text()).not.toContain("CLIPBOARD_DENIED");
  });
});
