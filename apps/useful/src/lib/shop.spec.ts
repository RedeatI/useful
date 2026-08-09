// 工具铺/下载纯逻辑测试：下载状态、进度、事件合并、目录过滤。
import { describe, it, expect } from "vitest";
import {
  applyDownloadDone,
  applyDownloadProgress,
  catalogCategories,
  downloadPercent,
  downloadStatusKey,
  filterCatalog,
  isActiveDownload,
  latestPerPackage,
  packageAction,
} from "@/lib/shop";
import type { DownloadRecord, ShopPackage } from "@/lib/types";

function mkDownload(over: Partial<DownloadRecord> = {}): DownloadRecord {
  return {
    id: "d1",
    url: "https://example.com/a.useful",
    packageId: "com.example.a",
    version: "1.0.0",
    totalBytes: 1000,
    receivedBytes: 0,
    status: "pending",
    error: null,
    createdAt: 1,
    ...over,
  };
}

function mkPackage(over: Partial<ShopPackage> = {}): ShopPackage {
  return {
    sourceId: "src",
    id: "com.example.a",
    version: "1.2.0",
    size: 1024,
    changelog: "修复若干问题",
    category: "图片",
    permissions: ["dialog.open"],
    minHostVersion: "0.1.0",
    installedVersion: null,
    updateAvailable: false,
    downgrade: false,
    pinned: false,
    ...over,
  };
}

describe("下载状态", () => {
  it("每种状态映射唯一 i18n key", () => {
    expect(downloadStatusKey("pending")).toBe("downloads.statusPending");
    expect(downloadStatusKey("downloading")).toBe("downloads.statusDownloading");
    expect(downloadStatusKey("verifying")).toBe("downloads.statusVerifying");
    expect(downloadStatusKey("done")).toBe("downloads.statusDone");
    expect(downloadStatusKey("failed")).toBe("downloads.statusFailed");
    expect(downloadStatusKey("cancelled")).toBe("downloads.statusCancelled");
  });

  it("进行中的状态可取消", () => {
    expect(isActiveDownload("pending")).toBe(true);
    expect(isActiveDownload("downloading")).toBe(true);
    expect(isActiveDownload("verifying")).toBe(true);
    expect(isActiveDownload("done")).toBe(false);
    expect(isActiveDownload("failed")).toBe(false);
    expect(isActiveDownload("cancelled")).toBe(false);
  });

  it("进度百分比钳制在 0-100，总大小未知返回 null", () => {
    expect(downloadPercent(500, 1000)).toBe(50);
    expect(downloadPercent(2000, 1000)).toBe(100);
    expect(downloadPercent(0, 1000)).toBe(0);
    expect(downloadPercent(100, null)).toBeNull();
    expect(downloadPercent(100, 0)).toBeNull();
  });
});

describe("下载事件合并", () => {
  it("进度事件更新已有记录且不修改原数组", () => {
    const list = [mkDownload()];
    const next = applyDownloadProgress(list, {
      id: "d1",
      packageId: "com.example.a",
      version: "1.0.0",
      receivedBytes: 300,
      totalBytes: 1000,
      status: "downloading",
    });
    expect(next[0].receivedBytes).toBe(300);
    expect(next[0].status).toBe("downloading");
    expect(list[0].receivedBytes).toBe(0);
  });

  it("未知 ID 的进度事件在列表头部新建记录", () => {
    const next = applyDownloadProgress([], {
      id: "d2",
      packageId: "com.example.b",
      version: "2.0.0",
      receivedBytes: 10,
      totalBytes: 100,
      status: "downloading",
    });
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe("d2");
    expect(next[0].packageId).toBe("com.example.b");
  });

  it("完成事件写入终态与错误；done 时进度补满", () => {
    const list = [mkDownload({ status: "downloading", receivedBytes: 700 })];
    const done = applyDownloadDone(list, {
      id: "d1",
      packageId: "com.example.a",
      version: "1.0.0",
      status: "done",
      error: null,
    });
    expect(done[0].status).toBe("done");
    expect(done[0].receivedBytes).toBe(1000);

    const failed = applyDownloadDone(list, {
      id: "d1",
      packageId: "com.example.a",
      version: "1.0.0",
      status: "failed",
      error: "SHA-256 不匹配",
    });
    expect(failed[0].status).toBe("failed");
    expect(failed[0].error).toBe("SHA-256 不匹配");
    expect(failed[0].receivedBytes).toBe(700);
  });
});

describe("商店目录", () => {
  it("packageAction 区分安装/更新/降级/已安装", () => {
    expect(packageAction(mkPackage())).toBe("install");
    expect(
      packageAction(mkPackage({ installedVersion: "1.0.0", updateAvailable: true })),
    ).toBe("update");
    expect(
      packageAction(mkPackage({ installedVersion: "2.0.0", downgrade: true })),
    ).toBe("downgrade");
    expect(packageAction(mkPackage({ installedVersion: "1.2.0" }))).toBe("installed");
  });

  it("分类去重排序，空分类不计入", () => {
    const pkgs = [
      mkPackage({ category: "视频" }),
      mkPackage({ id: "b.b", category: "图片" }),
      mkPackage({ id: "c.c", category: "" }),
      mkPackage({ id: "d.d", category: "图片" }),
    ];
    expect(catalogCategories(pkgs)).toEqual(["图片", "视频"]);
  });

  it("按关键字与分类过滤", () => {
    const pkgs = [
      mkPackage({ id: "com.example.image", category: "图片" }),
      mkPackage({ id: "com.example.video", category: "视频", changelog: "支持 AV1" }),
    ];
    expect(filterCatalog(pkgs, "image", "")).toHaveLength(1);
    expect(filterCatalog(pkgs, "", "视频")).toHaveLength(1);
    expect(filterCatalog(pkgs, "av1", "")).toHaveLength(1);
    expect(filterCatalog(pkgs, "不存在", "")).toHaveLength(0);
  });

  it("latestPerPackage 每个包只保留第一行（按版本降序的最新版）", () => {
    const pkgs = [
      mkPackage({ version: "2.0.0" }),
      mkPackage({ version: "1.0.0" }),
      mkPackage({ id: "b.b", version: "1.0.0" }),
    ];
    const latest = latestPerPackage(pkgs);
    expect(latest).toHaveLength(2);
    expect(latest[0].version).toBe("2.0.0");
  });
});
