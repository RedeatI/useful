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
      trustState: "ready",
      reason: null,
      sourceLockSha256: "aa".repeat(32),
      packs: [
        {
          id: "preview", downloadBytes: 77_205_127, archiveBytes: 77_205_127,
          sourceName: "mpv project", sourcePageUrl: "https://mpv.io/installation/",
          sourceCodeUrl: "https://github.com/mpv-player/mpv/tree/v0.41.0",
          archiveSha256: "11".repeat(32), installed: true, previousAvailable: false, damaged: false,
        },
        {
          id: "transcode", downloadBytes: 109_728_040, archiveBytes: 109_728_040,
          sourceName: "gyan.dev", sourcePageUrl: "https://ffmpeg.org/download.html",
          sourceCodeUrl: "https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz",
          archiveSha256: "22".repeat(32), installed: false, previousAvailable: false, damaged: false,
        },
      ],
    });
    ipcMock.mediaPackInstall.mockResolvedValue("media-task-1");
    ipcMock.mediaPackCancel.mockResolvedValue(undefined);
    ipcMock.mediaPackRollback.mockResolvedValue(undefined);
  });

  it("shows pinned upstream sources, measured size, detection state, and an enabled install action", async () => {
    const wrapper = mount(MediaRuntimeView);
    await flushPromises();

    expect(wrapper.text()).toContain("媒体解码器");
    expect(wrapper.text()).toContain("已启用构建时固定的上游源");
    expect(wrapper.get('[data-testid="media-pack-preview"]').text()).toContain("已检测");
    expect(wrapper.get('[data-testid="media-pack-preview"]').text()).toContain("73.6 MB");
    expect(wrapper.get('[data-testid="media-pack-preview"]').text()).toContain("mpv project");
    expect(wrapper.get('[data-testid="media-pack-transcode"]').text()).toContain("未安装");
    expect(wrapper.get('[data-testid="media-pack-transcode"]').text()).toContain("105 MB");
    expect(wrapper.get('[data-testid="media-pack-transcode"]').text()).toContain("gyan.dev");
    expect(wrapper.get('[data-testid="install-transcode"]').attributes("disabled")).toBeUndefined();
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
      sourceLockSha256: "aa".repeat(32),
      packs: [{
        id: "preview", downloadBytes: 77_205_127, archiveBytes: 77_205_127,
        sourceName: "mpv project", sourcePageUrl: "https://mpv.io/installation/",
        sourceCodeUrl: "https://github.com/mpv-player/mpv/tree/v0.41.0",
        archiveSha256: "11".repeat(32), installed: false,
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
      sourceLockSha256: "aa".repeat(32),
      packs: [
        {
          id: "preview", downloadBytes: 77_205_127, archiveBytes: 77_205_127,
          sourceName: "mpv project", sourcePageUrl: "https://mpv.io/installation/",
          sourceCodeUrl: "https://github.com/mpv-player/mpv/tree/v0.41.0",
          archiveSha256: "11".repeat(32), installed: true, previousAvailable: false, damaged: false,
        },
        {
          id: "transcode", downloadBytes: 109_728_040, archiveBytes: 109_728_040,
          sourceName: "gyan.dev", sourcePageUrl: "https://ffmpeg.org/download.html",
          sourceCodeUrl: "https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz",
          archiveSha256: "22".repeat(32), installed: false, previousAvailable: false, damaged: false,
        },
      ],
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const wrapper = mount(MediaRuntimeView);
    await flushPromises();

    expect(wrapper.text()).toContain("已启用构建时固定的上游源");
    expect(wrapper.get('[data-testid="install-transcode"]').attributes("disabled")).toBeUndefined();
    await wrapper.get('[data-testid="install-transcode"]').trigger("click");
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("105 MB"));
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("gyan.dev"));
    expect(ipcMock.mediaPackInstall).toHaveBeenCalledWith("transcode");

    // Native work may emit before Tauri resolves the command response with the task id.
    listeners.get("media-pack-progress")?.({ payload: {
      taskId: "media-task-1", packId: "transcode", phase: "downloading",
      receivedBytes: 54_864_020, totalBytes: 109_728_040,
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
      sourceLockSha256: "aa".repeat(32),
      packs: [{
        id: "preview", downloadBytes: 77_205_127, archiveBytes: 77_205_127,
        sourceName: "mpv project", sourcePageUrl: "https://mpv.io/installation/",
        sourceCodeUrl: "https://github.com/mpv-player/mpv/tree/v0.41.0",
        archiveSha256: "11".repeat(32), installed: true, previousAvailable: true, damaged: false,
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
