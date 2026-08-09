// 源中心纯逻辑测试：官方徽章仅凭 isOfficial（伪官方不显示）、指纹格式化、分组与冲突统计。
import { describe, expect, it } from "vitest";
import {
  accessModeKey,
  advisoryBannerVisible,
  advisorySeverityKey,
  capabilityLabels,
  conflictCount,
  formatFingerprint,
  loginStatusKey,
  officialBadgeVisible,
  requiresAuth,
  reviewBadges,
  shortPublisherKey,
  splitSources,
  syncStatusKey,
} from "./sourceCenter";
import type { TrpMergedItem, TrpSourceInfo } from "./types";

function source(partial: Partial<TrpSourceInfo>): TrpSourceInfo {
  return {
    id: "com.example.src",
    kind: "tool",
    discoveryUrl: "https://src.example/.well-known/useful-repository.json",
    displayName: "示例源",
    operator: "Example",
    local: false,
    enabled: true,
    priority: 100,
    rootKeyFingerprint: "aa".repeat(32),
    trustConfirmedAt: 1750000000,
    capabilities: {},
    lastSyncAt: null,
    lastSyncStatus: "never",
    lastSyncError: null,
    lastSyncDurationMs: null,
    entryCount: 0,
    isOfficial: false,
    ...partial,
  };
}

function mergedItem(toolId: string, nameConflict: boolean): TrpMergedItem {
  return {
    item: {
      sourceId: "com.example.src",
      sourcePriority: 100,
      publisherKeyId: "ed25519:abcdef0123456789abcdef",
      toolId,
      name: toolId,
      summary: "",
      license: "Apache-2.0",
      latestStable: "1.0.0",
      latestStableDigest: "aa".repeat(32),
      accessMode: "free",
      isNativeWorker: false,
      repositorySignatureVerified: true,
      publisherSignatureVerified: false,
      officialReviewPassed: false,
      securityScanPassed: true,
      advisoryCount: 0,
      maxAdvisorySeverity: null,
    },
    mirrorSourceIds: [],
    nameConflict,
  };
}

describe("officialBadgeVisible", () => {
  it("仅 isOfficial=true 时显示官方徽章", () => {
    expect(officialBadgeVisible(source({ isOfficial: true }))).toBe(true);
    expect(officialBadgeVisible(source({ isOfficial: false }))).toBe(false);
  });

  it("伪官方源（名称/ID 自称官方）不显示官方徽章", () => {
    const fake = source({
      id: "org.useful.official",
      displayName: "Useful 官方源",
      operator: "Useful Project",
      discoveryUrl: "https://official-looking.example/.well-known/useful-repository.json",
      isOfficial: false, // 根指纹不匹配预置官方根
    });
    expect(officialBadgeVisible(fake)).toBe(false);
  });
});

describe("formatFingerprint", () => {
  it("每 8 位一组、小写化", () => {
    const fp = "9F86D081884C7D659A2FEAA0C55AD015A3BF4F1B2B0B822CD15D6C15B0F00A08";
    expect(formatFingerprint(fp)).toBe(
      "9f86d081 884c7d65 9a2feaa0 c55ad015 a3bf4f1b 2b0b822c d15d6c15 b0f00a08",
    );
  });
});

describe("shortPublisherKey", () => {
  it("缩写长 key，保留算法前缀", () => {
    expect(shortPublisherKey("ed25519:9f8e7d6c5b4a39281706f5e4d3c2b1a0")).toBe(
      "ed25519:9f8e7d6c…b1a0",
    );
  });
  it("短 key 原样返回", () => {
    expect(shortPublisherKey("ed25519:short")).toBe("ed25519:short");
  });
});

describe("syncStatusKey / accessModeKey", () => {
  it("状态映射", () => {
    expect(syncStatusKey("never")).toBe("sourceCenter.syncNever");
    expect(syncStatusKey("ok")).toBe("sourceCenter.syncOk");
    expect(syncStatusKey("failed")).toBe("sourceCenter.syncFailed");
  });
  it("accessMode 映射（未知值归为不可用）", () => {
    expect(accessModeKey("free")).toBe("sourceCenter.accessFree");
    expect(accessModeKey("entitlement")).toBe("sourceCenter.accessEntitlement");
    expect(accessModeKey("weird")).toBe("sourceCenter.accessUnavailable");
  });
});

describe("splitSources", () => {
  it("按启用状态分组且保持顺序", () => {
    const a = source({ id: "a", enabled: true });
    const b = source({ id: "b", enabled: false });
    const c = source({ id: "c", enabled: true });
    const { enabled, disabled } = splitSources([a, b, c]);
    expect(enabled.map((s) => s.id)).toEqual(["a", "c"]);
    expect(disabled.map((s) => s.id)).toEqual(["b"]);
  });
});

describe("capabilityLabels", () => {
  it("只输出已声明为 true 的能力", () => {
    const s = source({
      capabilities: { catalog: true, paidDownloads: true, remoteSearch: false },
    });
    expect(capabilityLabels(s)).toEqual(["sourceCenter.capCatalog", "sourceCenter.capPaid"]);
  });
});

describe("conflictCount", () => {
  it("统计存在同名冲突的 toolId 数（同一 toolId 只计一次）", () => {
    const items = [
      mergedItem("com.x.tool", true),
      mergedItem("com.x.tool", true), // 同 toolId 的另一发布者条目
      mergedItem("com.x.other", false),
    ];
    expect(conflictCount(items)).toBe(1);
  });
});

describe("requiresAuth / loginStatusKey", () => {
  it("requiresAuth 仅看 capabilities.authentication", () => {
    expect(requiresAuth(source({ capabilities: { authentication: true } }))).toBe(true);
    expect(requiresAuth(source({ capabilities: { authentication: false } }))).toBe(false);
    expect(requiresAuth(source({ capabilities: {} }))).toBe(false);
  });
  it("登录状态映射：未登录/已登录/过期", () => {
    expect(loginStatusKey(null)).toBe("sourceCenter.notLoggedIn");
    const acct = {
      sourceId: "s", accountId: "u", displayName: "U", scopes: [],
      expiresAt: 0, lastAuthenticatedAt: 0, expired: false,
    };
    expect(loginStatusKey(acct)).toBe("sourceCenter.loggedInAs");
    expect(loginStatusKey({ ...acct, expired: true })).toBe("sourceCenter.tokenExpired");
  });
});

describe("reviewBadges (Phase 9)", () => {
  it("四个独立状态各自映射，不合并成单一布尔", () => {
    const badges = reviewBadges({
      repositorySignatureVerified: true,
      publisherSignatureVerified: false,
      officialReviewPassed: true,
      securityScanPassed: false,
    });
    expect(badges).toHaveLength(4);
    expect(badges.find((b) => b.key === "sourceCenter.repoSigVerified")?.ok).toBe(true);
    expect(badges.find((b) => b.key === "sourceCenter.pubSigVerified")?.ok).toBe(false);
    expect(badges.find((b) => b.key === "sourceCenter.officialReviewPassed")?.ok).toBe(true);
    expect(badges.find((b) => b.key === "sourceCenter.scanPassed")?.ok).toBe(false);
  });
  it("未通过的状态不隐藏（仍返回条目）", () => {
    const badges = reviewBadges({
      repositorySignatureVerified: false,
      publisherSignatureVerified: false,
      officialReviewPassed: false,
      securityScanPassed: false,
    });
    expect(badges).toHaveLength(4);
    expect(badges.every((b) => b.ok === false)).toBe(true);
  });
});

describe("advisoryBannerVisible / advisorySeverityKey", () => {
  it("有公告才显示横幅", () => {
    expect(advisoryBannerVisible({ advisoryCount: 0 })).toBe(false);
    expect(advisoryBannerVisible({ advisoryCount: 2 })).toBe(true);
  });
  it("严重级别映射（未知按 low，不隐藏）", () => {
    expect(advisorySeverityKey("critical")).toBe("sourceCenter.advSeverityCritical");
    expect(advisorySeverityKey("high")).toBe("sourceCenter.advSeverityHigh");
    expect(advisorySeverityKey("medium")).toBe("sourceCenter.advSeverityMedium");
    expect(advisorySeverityKey("low")).toBe("sourceCenter.advSeverityLow");
    expect(advisorySeverityKey(null)).toBe("sourceCenter.advSeverityLow");
    expect(advisorySeverityKey("weird")).toBe("sourceCenter.advSeverityLow");
  });
});
