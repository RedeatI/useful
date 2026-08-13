// 源中心（Phase 6B）的纯逻辑：官方徽章判定、指纹格式化、同步状态文案、源分组。便于单元测试。
import type { SourceAccountInfo, TrpCatalogItem, TrpMergedItem, TrpSourceInfo, TrpSyncStatus } from "./types";

/**
 * 官方徽章是否可见：只看 isOfficial（由 Rust 侧预置根指纹匹配产生）。
 * 绝不根据 displayName / id / discoveryUrl 判定——伪官方源不显示官方徽章。
 */
export function officialBadgeVisible(source: Pick<TrpSourceInfo, "isOfficial">): boolean {
  return source.isOfficial === true;
}

/** 指纹分组显示（每 8 位一组，便于人工比对）。 */
export function formatFingerprint(fp: string): string {
  const clean = fp.trim().toLowerCase();
  const groups: string[] = [];
  for (let i = 0; i < clean.length; i += 8) {
    groups.push(clean.slice(i, i + 8));
  }
  return groups.join(" ");
}

/** 发布者 key 缩写显示：算法前缀 + 前 8 位 + … + 后 4 位。 */
export function shortPublisherKey(publisherKeyId: string): string {
  const idx = publisherKeyId.indexOf(":");
  if (idx < 0) return publisherKeyId;
  const algo = publisherKeyId.slice(0, idx);
  const key = publisherKeyId.slice(idx + 1);
  if (key.length <= 14) return publisherKeyId;
  return `${algo}:${key.slice(0, 8)}…${key.slice(-4)}`;
}

/** 同步状态对应的 i18n key。 */
export function syncStatusKey(status: TrpSyncStatus): string {
  switch (status) {
    case "never":
      return "sourceCenter.syncNever";
    case "ok":
      return "sourceCenter.syncOk";
    case "failed":
      return "sourceCenter.syncFailed";
  }
}

/** accessMode 对应的 i18n key。 */
export function accessModeKey(mode: string): string {
  switch (mode) {
    case "free":
      return "sourceCenter.accessFree";
    case "entitlement":
      return "sourceCenter.accessEntitlement";
    case "external-purchase":
      return "sourceCenter.accessExternal";
    case "private":
      return "sourceCenter.accessPrivate";
    default:
      return "sourceCenter.accessUnavailable";
  }
}

/** 客户端实际观察到的源交付形态；不把云厂商实现当作信任信号。 */
export function deliveryTypeKey(type: TrpSourceInfo["deliveryType"]): string {
  switch (type) {
    case "static-https":
      return "sourceCenter.deliveryStaticHttps";
    case "dynamic":
      return "sourceCenter.deliveryDynamic";
    default:
      return "sourceCenter.deliveryUnknown";
  }
}

/** Catalog 可用性状态对应的 i18n key；未知值按 unknown 展示。 */
export function availabilityStatusKey(status: string): string {
  switch (status) {
    case "healthy":
      return "sourceCenter.sourceReportedHealthy";
    case "degraded":
      return "sourceCenter.sourceReportedDegraded";
    case "unavailable":
      return "sourceCenter.sourceReportedUnavailable";
    default:
      return "sourceCenter.sourceReportedUnknown";
  }
}

/** 保留源报告的检查时间与检查器来源；两者都不提升为客户端验证事实。 */
export function availabilityDetail(
  availability: Pick<NonNullable<TrpCatalogItem["availability"]>, "checkedAt" | "source">,
): string | undefined {
  const parts = [availability.checkedAt, availability.source].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return parts.length ? parts.join(" · ") : undefined;
}

/** 按启用状态分组（组内保持后端返回的优先级顺序）。 */
export function splitSources(sources: TrpSourceInfo[]): {
  enabled: TrpSourceInfo[];
  disabled: TrpSourceInfo[];
} {
  return {
    enabled: sources.filter((s) => s.enabled),
    disabled: sources.filter((s) => !s.enabled),
  };
}

/** 启用的源中已声明的能力标签（用于能力 chips）。 */
export function capabilityLabels(source: TrpSourceInfo): string[] {
  const caps = source.capabilities ?? {};
  const labels: string[] = [];
  if (caps.catalog) labels.push("sourceCenter.capCatalog");
  if (caps.remoteSearch) labels.push("sourceCenter.capRemoteSearch");
  if (caps.authentication) labels.push("sourceCenter.capAuth");
  if (caps.entitlements) labels.push("sourceCenter.capEntitlements");
  if (caps.paidDownloads) labels.push("sourceCenter.capPaid");
  if (caps.staticMirror) labels.push("sourceCenter.capMirror");
  if (caps.nativeWorkers) labels.push("sourceCenter.capNativeWorkers");
  return labels;
}

/** 搜索结果中的同名冲突组数（用于摘要提示）。 */
export function conflictCount(items: TrpMergedItem[]): number {
  const conflictTools = new Set<string>();
  for (const m of items) {
    if (m.nameConflict) conflictTools.add(m.item.toolId);
  }
  return conflictTools.size;
}

/** 源是否声明需要登录（authentication 能力）。 */
export function requiresAuth(source: Pick<TrpSourceInfo, "capabilities">): boolean {
  return source.capabilities?.authentication === true;
}

/** 登录状态文案 key。account 为 null=未登录；overdue 为令牌过期。 */
export function loginStatusKey(account: SourceAccountInfo | null): string {
  if (!account) return "sourceCenter.notLoggedIn";
  if (account.expired) return "sourceCenter.tokenExpired";
  return "sourceCenter.loggedInAs";
}

/** 单个独立审核/签名状态徽章（Phase 9 / RC）。 */
export interface ReviewBadge {
  /** i18n key */
  key: string;
  /** 状态是否通过（未通过时 UI 用中性/警告样式，不隐藏） */
  ok: boolean;
  /** 可选补充文案（如 Sigstore 身份、可用性检查时间），原样展示 */
  detail?: string;
}

/**
 * 搜索结果的各独立状态徽章：源签名/发布者签名（Ed25519 或 Sigstore）/
 * 官方审核/安全扫描/复现构建/来源可用性。
 * 绝不合并成单一 safe 布尔；未通过的状态也如实展示，四类信号分别呈现。
 */
export function reviewBadges(
  item: Pick<
    TrpCatalogItem,
    | "repositorySignatureVerified"
    | "publisherSignatureVerified"
    | "officialReviewPassed"
    | "securityScanPassed"
    | "signatureMethod"
    | "signatureIdentity"
    | "reproducibleBuild"
    | "availability"
  >,
): ReviewBadge[] {
  // 发布者签名：Ed25519 与 Sigstore 身份分别展示，绝不合并
  const pubSigKey =
    item.signatureMethod === "sigstore"
      ? "sourceCenter.sigstoreVerified"
      : "sourceCenter.pubSigVerified";
  const badges: ReviewBadge[] = [
    { key: "sourceCenter.repoSigVerified", ok: item.repositorySignatureVerified === true },
    {
      key: pubSigKey,
      ok: item.publisherSignatureVerified === true,
      detail: item.signatureMethod === "sigstore" ? item.signatureIdentity : undefined,
    },
    { key: "sourceCenter.officialReviewPassed", ok: item.officialReviewPassed === true },
    { key: "sourceCenter.scanPassed", ok: item.securityScanPassed === true },
  ];
  // 复现构建：只有官方验证 verified 才算通过；作者声明单独展示
  if (item.reproducibleBuild) {
    badges.push({
      key: "sourceCenter.reproducibleVerified",
      ok: item.reproducibleBuild.status === "verified",
      detail: item.reproducibleBuild.strategy,
    });
  }
  // 来源可用性只作为自报状态展示；带检查时间与报告来源。
  if (item.availability) {
    badges.push({
      key: availabilityStatusKey(item.availability.status),
      // Catalog sync is intentionally not TUF-verified. Availability remains
      // a source assertion until the install path independently verifies the
      // TUF target, digest and publisher binding.
      ok: false,
      detail: availabilityDetail(item.availability),
    });
  }
  return badges;
}

/** 公告横幅是否可见（存在至少一条安全公告）。 */
export function advisoryBannerVisible(
  item: Pick<TrpCatalogItem, "advisoryCount">,
): boolean {
  return (item.advisoryCount ?? 0) > 0;
}

/** 公告严重级别对应的 i18n key（未知级别按 low 处理，不隐藏）。 */
export function advisorySeverityKey(severity: string | null): string {
  switch (severity) {
    case "critical":
      return "sourceCenter.advSeverityCritical";
    case "high":
      return "sourceCenter.advSeverityHigh";
    case "medium":
      return "sourceCenter.advSeverityMedium";
    default:
      return "sourceCenter.advSeverityLow";
  }
}
