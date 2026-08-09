import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";

// 模拟 IPC 层，避免真实 Tauri 依赖（工具数据在工厂内联，因 vi.mock 会被提升到顶部）
vi.mock("@/lib/ipc", () => {
  const mockTools = [
    {
      id: "builtin.video-trim",
      name: "tools.videoTrim.name",
      description: "tools.videoTrim.description",
      icon: "builtin:video-trim",
      route: "/tools/video-trim",
      category: "builtin",
      kind: "builtin",
      order: 10,
      supportsShortcut: true,
      requiredCapabilities: [],
    },
    {
      id: "com.example.tool",
      name: "示例插件",
      description: "第三方",
      icon: "plugin",
      route: "/plugin/com.example.tool",
      category: "installed",
      kind: "web",
      order: 100,
      supportsShortcut: true,
      requiredCapabilities: [],
      version: "1.0.0",
    },
  ];
  return {
    default: {
      getAppInfo: vi.fn().mockResolvedValue({
        name: "Useful",
        version: "0.1.0",
        runMode: "portable",
        dataDir: "C:/data",
        logsDir: "C:/data/logs",
        pluginsDir: "C:/data/plugins",
        capabilities: { procmon: true, media: true, edition: "standard" },
      }),
      listTools: vi.fn().mockResolvedValue(mockTools),
      getFavorites: vi.fn().mockResolvedValue(["com.example.tool"]),
      getRecentTools: vi.fn().mockResolvedValue([]),
      toggleFavorite: vi.fn().mockResolvedValue(false),
      recordToolUse: vi.fn().mockResolvedValue(undefined),
      getActionFavorites: vi.fn().mockResolvedValue([]),
      getActionRecent: vi.fn().mockResolvedValue([]),
      toggleActionFavorite: vi.fn().mockResolvedValue(false),
      recordActionUse: vi.fn().mockResolvedValue(undefined),
      clearActionRecent: vi.fn().mockResolvedValue(undefined),
      navigationPinsGet: vi.fn().mockResolvedValue([]),
      navigationPinSet: vi.fn().mockResolvedValue(undefined),
      agentProfileGet: vi.fn().mockResolvedValue(null),
    },
  };
});

import { useAppStore } from "@/stores/app";

describe("app store 动态侧边栏", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("加载后区分内置与已安装工具", async () => {
    const store = useAppStore();
    await store.loadAll();
    expect(store.builtinTools.length).toBe(1);
    expect(store.installedTools.length).toBe(1);
    expect(store.installedTools[0].id).toBe("com.example.tool");
  });

  it("收藏工具从后端加载", async () => {
    const store = useAppStore();
    await store.loadAll();
    expect(store.isFavorite("com.example.tool")).toBe(true);
    expect(store.favoriteTools.length).toBe(1);
  });

  it("切换收藏更新状态", async () => {
    const store = useAppStore();
    await store.loadAll();
    await store.toggleFavorite("com.example.tool");
    expect(store.isFavorite("com.example.tool")).toBe(false);
  });

  it("resolves Office action favorites and recent entries through the shared catalog", async () => {
    const ipc = (await import("@/lib/ipc")).default;
    (ipc.getActionFavorites as ReturnType<typeof vi.fn>).mockResolvedValueOnce(["builtin.office.docx"]);
    (ipc.getActionRecent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(["builtin.office.pdf"]);
    const store = useAppStore();
    await store.loadAll();
    expect(store.favoriteActions.map((action) => action.id)).toEqual(["builtin.office.docx"]);
    expect(store.recentActions.map((action) => action.id)).toEqual(["builtin.office.pdf"]);
  });

  it("加载失败时记录错误", async () => {
    const ipc = (await import("@/lib/ipc")).default;
    (ipc.listTools as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("后端不可用"),
    );
    const store = useAppStore();
    await store.loadAll();
    expect(store.error).toContain("后端不可用");
  });
});
