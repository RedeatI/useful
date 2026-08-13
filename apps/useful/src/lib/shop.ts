// 工具铺/下载的纯逻辑：状态文案键、进度计算、事件合并。便于单元测试。
import type {
  DownloadDoneEvent,
  DownloadProgressEvent,
  DownloadRecord,
  DownloadStatus,
  ShopPackage,
} from "./types";

/** 下载状态对应的 i18n key。 */
export function downloadStatusKey(status: DownloadStatus): string {
  switch (status) {
    case "pending":
      return "downloads.statusPending";
    case "downloading":
      return "downloads.statusDownloading";
    case "verifying":
      return "downloads.statusVerifying";
    case "installing":
      return "downloads.statusInstalling";
    case "done":
      return "downloads.statusDone";
    case "failed":
      return "downloads.statusFailed";
    case "cancelled":
      return "downloads.statusCancelled";
  }
}

/** 下载进度百分比（0-100 整数）；总大小未知时返回 null。 */
export function downloadPercent(received: number, total: number | null): number | null {
  if (!total || total <= 0) return null;
  const pct = Math.floor((received / total) * 100);
  return Math.min(100, Math.max(0, pct));
}

/** 是否为进行中的下载（可取消）。 */
export function isActiveDownload(status: DownloadStatus): boolean {
  return (
    status === "pending" ||
    status === "downloading" ||
    status === "verifying"
  );
}

/** 稳定下载错误码对应的 i18n key；未知码仍保留原始错误详情。 */
export function downloadErrorKey(code: string | null): string | null {
  switch (code) {
    case "object_missing":
      return "downloads.errorObjectMissing";
    case "size_mismatch":
      return "downloads.errorSizeMismatch";
    case "signature_invalid":
      return "downloads.errorSignatureInvalid";
    case "network":
      return "downloads.errorNetwork";
    case "install_failed":
      return "downloads.errorInstallFailed";
    default:
      return null;
  }
}

/** 把进度事件合并进下载记录列表（不存在时新建占位记录）。返回新数组。 */
export function applyDownloadProgress(
  list: DownloadRecord[],
  ev: DownloadProgressEvent,
): DownloadRecord[] {
  const idx = list.findIndex((d) => d.id === ev.id);
  if (idx < 0) {
    const rec: DownloadRecord = {
      id: ev.id,
      url: "",
      packageId: ev.packageId,
      version: ev.version,
      totalBytes: ev.totalBytes,
      receivedBytes: ev.receivedBytes,
      status: ev.status,
      digest: ev.digest,
      error: null,
      errorCode: null,
      createdAt: Math.floor(Date.now() / 1000),
    };
    return [rec, ...list];
  }
  const next = list.slice();
  next[idx] = {
    ...next[idx],
    receivedBytes: ev.receivedBytes,
    totalBytes: ev.totalBytes,
    status: ev.status,
    digest: ev.digest,
  };
  return next;
}

/** 把完成事件合并进下载记录列表。返回新数组。 */
export function applyDownloadDone(
  list: DownloadRecord[],
  ev: DownloadDoneEvent,
): DownloadRecord[] {
  const idx = list.findIndex((d) => d.id === ev.id);
  if (idx < 0) return list;
  const next = list.slice();
  next[idx] = {
    ...next[idx],
    status: ev.status,
    error: ev.error,
    errorCode: ev.errorCode,
    receivedBytes:
      ev.status === "done" && next[idx].totalBytes
        ? (next[idx].totalBytes as number)
        : next[idx].receivedBytes,
  };
  return next;
}

/** 包在商店中的动作类型。 */
export type ShopAction = "install" | "update" | "downgrade" | "installed";

export function packageAction(pkg: ShopPackage): ShopAction {
  if (!pkg.installedVersion) return "install";
  if (pkg.installedVersion === pkg.version) return "installed";
  if (pkg.updateAvailable) return "update";
  if (pkg.downgrade) return "downgrade";
  return "installed";
}

/** 提取目录中的全部分类（去重、按码点排序保证跨环境确定性，空分类不计入）。 */
export function catalogCategories(packages: ShopPackage[]): string[] {
  const set = new Set<string>();
  for (const p of packages) {
    if (p.category) set.add(p.category);
  }
  return Array.from(set).sort();
}

/** 按关键字与分类过滤目录。 */
export function filterCatalog(
  packages: ShopPackage[],
  keyword: string,
  category: string,
): ShopPackage[] {
  const kw = keyword.trim().toLowerCase();
  return packages.filter((p) => {
    if (category && p.category !== category) return false;
    if (!kw) return true;
    return (
      p.id.toLowerCase().includes(kw) ||
      p.changelog.toLowerCase().includes(kw) ||
      p.version.includes(kw)
    );
  });
}

/** 同一包只保留每个 id 的最新版本行（目录按 version DESC 排序返回）。 */
export function latestPerPackage(packages: ShopPackage[]): ShopPackage[] {
  const seen = new Set<string>();
  const out: ShopPackage[] = [];
  for (const p of packages) {
    const key = `${p.sourceId}/${p.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}
