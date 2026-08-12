import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { setLocale } from "@/i18n";

const routeMock = vi.hoisted(() => ({
  query: { required: "transcode", returnTo: "/tools/video-trim" } as Record<string, string>,
}));
const routerMock = vi.hoisted(() => ({ push: vi.fn().mockResolvedValue(undefined) }));
const listeners = new Map<string, (event: { payload: unknown }) => void>();
const ipcMock = vi.hoisted(() => ({
  mediaSidecars: vi.fn(),
  mediaPackCatalog: vi.fn(),
  mediaPackInstall: vi.fn(),
  mediaPackCancel: vi.fn(),
  mediaPackRollback: vi.fn(),
}));

vi.mock("vue-router", () => ({
  useRoute: () => routeMock,
  useRouter: () => routerMock,
}));
vi.mock("@/lib/ipc", () => ({ default: ipcMock }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, callback: (event: { payload: unknown }) => void) => {
    listeners.set(name, callback);
    return Promise.resolve(vi.fn());
  }),
}));

import MediaRuntimeView from "@/views/MediaRuntimeView.vue";

describe("MediaRuntimeView", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    listeners.clear();
    await setLocale("zh-CN");
    routeMock.query = { required: "transcode", returnTo: "/tools/video-trim" };
    ipcMock.mediaSidecars.mockResolvedValue({
      ffmpeg: { name: "ffmpeg", available: false },
      ffprobe: { name: "ffprobe", available: false },
      mpv: { name: "mpv", available: true, path: "mpv.exe" },
    });
    ipcMock.mediaPackCatalog.mockResolvedValue({
      trustState: "blocked",
      reason: "production-trust-not-configured",
      publicKeyFingerprint: null,
      packs: [],
    });
    ipcMock.mediaPackInstall.mockResolvedValue("media-task-1");
    ipcMock.mediaPackCancel.mockResolvedValue(undefined);
    ipcMock.mediaPackRollback.mockResolvedValue(undefined);
  });

  it("shows per-pack purpose, measured size, detection state, and a fail-closed install action", async () => {
    const wrapper = mount(MediaRuntimeView);
    await flushPromises();

    expect(wrapper.text()).toContain("媒体解码器");
    expect(wrapper.text()).toContain("正式签名源尚未启用");
    expect(wrapper.get('[data-testid="media-pack-preview"]').text()).toContain("已检测");
    expect(wrapper.get('[data-testid="media-pack-preview"]').text()).toContain("43.3 MB");
    expect(wrapper.get('[data-testid="media-pack-transcode"]').text()).toContain("未安装");
    expect(wrapper.get('[data-testid="media-pack-transcode"]').text()).toContain("175 MB");
    expect(wrapper.get('[data-testid="install-transcode"]').attributes()).toHaveProperty("disabled");
    expect(wrapper.get('[data-testid="media-pack-transcode"]').classes()).toContain("runtime-card--required");
  });

  it("returns only to the fixed video-trim route", async () => {
    routeMock.query = { required: "preview", returnTo: "https://evil.example" };
    const wrapper = mount(MediaRuntimeView);
    await flushPromises();
    await wrapper.get('[data-testid="return-video-trim"]').trigger("click");
    expect(routerMock.push).toHaveBeenCalledWith("/tools/video-trim");
  });

  it("keeps the pack choices visible and fail-closed when detection fails", async () => {
    ipcMock.mediaSidecars.mockRejectedValueOnce(new Error("Tauri IPC unavailable"));
    const wrapper = mount(MediaRuntimeView);
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toContain("暂时无法读取本机媒体组件状态");
    expect(wrapper.get('[data-testid="media-pack-preview"]').text()).toContain("未安装");
    expect(wrapper.get('[data-testid="media-pack-transcode"]').text()).toContain("未安装");
    expect(wrapper.get('[data-testid="install-preview"]').attributes()).toHaveProperty("disabled");
    expect(wrapper.get('[data-testid="install-transcode"]').attributes()).toHaveProperty("disabled");
  });

  it("marks quarantined components as damaged and offers only verified repair", async () => {
    ipcMock.mediaSidecars.mockResolvedValueOnce({
      ffmpeg: { name: "ffmpeg", available: true, path: "bundled/ffmpeg.exe" },
      ffprobe: { name: "ffprobe", available: true, path: "bundled/ffprobe.exe" },
      mpv: { name: "mpv", available: false, reason: "media-pack-damaged" },
    });
    ipcMock.mediaPackCatalog.mockResolvedValueOnce({
      trustState: "ready",
      reason: null,
      publicKeyFingerprint: "aa".repeat(32),
      packs: [{
        id: "preview", downloadBytes: 45_356_407, archiveBytes: 45_356_000,
        correspondingSourceUrl: "https://example.test/preview-source.zip",
        correspondingSourceSha256: "11".repeat(32), installed: false,
        previousAvailable: false, damaged: true,
      }],
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const wrapper = mount(MediaRuntimeView);
    await flushPromises();

    const preview = wrapper.get('[data-testid="media-pack-preview"]');
    expect(preview.text()).toContain("需要修复");
    expect(preview.text()).toContain("不会改用系统 PATH");
    expect(wrapper.get('[data-testid="install-preview"]').text()).toContain("重新验证并修复");
    await wrapper.get('[data-testid="install-preview"]').trigger("click");
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("重新下载并修复"));
    expect(ipcMock.mediaPackInstall).toHaveBeenCalledWith("preview");
    confirmSpy.mockRestore();
  });

  it("requires confirmation, reports cancellable progress, and re-detects after verified install", async () => {
    let resolveInstall!: (taskId: string) => void;
    ipcMock.mediaPackInstall.mockReturnValueOnce(new Promise<string>((resolve) => {
      resolveInstall = resolve;
    }));
    ipcMock.mediaSidecars
      .mockResolvedValueOnce({
        ffmpeg: { name: "ffmpeg", available: false },
        ffprobe: { name: "ffprobe", available: false },
        mpv: { name: "mpv", available: true, path: "mpv.exe" },
      })
      .mockResolvedValue({
        ffmpeg: { name: "ffmpeg", available: true, path: "installed/ffmpeg.exe" },
        ffprobe: { name: "ffprobe", available: true, path: "installed/ffprobe.exe" },
        mpv: { name: "mpv", available: true, path: "mpv.exe" },
      });
    ipcMock.mediaPackCatalog.mockResolvedValue({
      trustState: "ready",
      reason: null,
      publicKeyFingerprint: "aa".repeat(32),
      packs: [
        {
          id: "preview", downloadBytes: 45_356_407, archiveBytes: 45_356_000,
          correspondingSourceUrl: "https://example.test/preview-source.zip",
          correspondingSourceSha256: "11".repeat(32), installed: true, previousAvailable: false,
        },
        {
          id: "transcode", downloadBytes: 183_797_099, archiveBytes: 183_796_000,
          correspondingSourceUrl: "https://example.test/transcode-source.zip",
          correspondingSourceSha256: "22".repeat(32), installed: false, previousAvailable: false,
        },
      ],
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const wrapper = mount(MediaRuntimeView);
    await flushPromises();

    expect(wrapper.text()).toContain("可信 MediaPack 源已可用");
    expect(wrapper.get('[data-testid="install-transcode"]').attributes("disabled")).toBeUndefined();
    await wrapper.get('[data-testid="install-transcode"]').trigger("click");
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("175 MB"));
    expect(ipcMock.mediaPackInstall).toHaveBeenCalledWith("transcode");

    // Native work may emit before Tauri resolves the command response with the task id.
    listeners.get("media-pack-progress")?.({ payload: {
      taskId: "media-task-1", packId: "transcode", phase: "downloading",
      receivedBytes: 91_898_550, totalBytes: 183_797_099,
    } });
    await flushPromises();
    expect(wrapper.get('[data-testid="media-pack-transcode"]').text()).toContain("50%");
    await wrapper.get('[data-testid="cancel-transcode"]').trigger("click");
    expect(ipcMock.mediaPackCancel).toHaveBeenCalledWith("media-task-1");

    listeners.get("media-pack-done")?.({ payload: {
      taskId: "media-task-1", packId: "transcode", status: "done", errorCode: null,
    } });
    resolveInstall("media-task-1");
    await flushPromises();
    expect(ipcMock.mediaSidecars).toHaveBeenCalledTimes(2);
    expect(wrapper.get('[data-testid="media-pack-transcode"]').text()).toContain("已检测");
    confirmSpy.mockRestore();
  });

  it("exposes rollback only for a verified previous pointer", async () => {
    ipcMock.mediaPackCatalog.mockResolvedValue({
      trustState: "ready",
      reason: null,
      publicKeyFingerprint: "aa".repeat(32),
      packs: [{
        id: "preview", downloadBytes: 45_356_407, archiveBytes: 45_356_000,
        correspondingSourceUrl: "https://example.test/preview-source.zip",
        correspondingSourceSha256: "11".repeat(32), installed: true, previousAvailable: true,
      }],
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const wrapper = mount(MediaRuntimeView);
    await flushPromises();
    await wrapper.get('[data-testid="rollback-preview"]').trigger("click");
    await flushPromises();
    expect(ipcMock.mediaPackRollback).toHaveBeenCalledWith("preview");
    expect(ipcMock.mediaSidecars).toHaveBeenCalledTimes(2);
    confirmSpy.mockRestore();
  });
});
