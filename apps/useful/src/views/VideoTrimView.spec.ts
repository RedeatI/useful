import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { setLocale } from "@/i18n";

const listeners = new Map<string, (event: { payload: unknown }) => void>();
const routerMock = vi.hoisted(() => ({ push: vi.fn().mockResolvedValue(undefined) }));
const dialogMock = vi.hoisted(() => ({
  confirm: vi.fn().mockResolvedValue(true),
  open: vi.fn().mockResolvedValue(null),
  save: vi.fn().mockResolvedValue(null),
}));
const ipcMock = vi.hoisted(() => ({
  mediaSidecars: vi.fn(),
  mediaDetectEncoders: vi.fn().mockResolvedValue({ nvenc: false, qsv: false, amf: false }),
  mediaProbe: vi.fn().mockResolvedValue({
    durationSec: 60,
    width: 1_920,
    height: 1_080,
    fps: 30,
    videoCodec: "h264",
    audioCodec: "aac",
    audioTracks: 1,
    formatName: "mov,mp4",
  }),
  mediaThumbnail: vi.fn().mockResolvedValue("thumb.jpg"),
  mediaExport: vi.fn(),
  mediaCancelExport: vi.fn().mockResolvedValue(undefined),
  mpvStart: vi.fn().mockResolvedValue(undefined),
  mpvSetRect: vi.fn().mockResolvedValue(undefined),
  mpvLoad: vi.fn(),
  mpvSetPaused: vi.fn().mockResolvedValue(undefined),
  mpvSeek: vi.fn().mockResolvedValue(undefined),
  mpvStop: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/ipc", () => ({ default: ipcMock }));
vi.mock("vue-router", () => ({ useRouter: () => routerMock }));
vi.mock("@tauri-apps/plugin-dialog", () => dialogMock);
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, callback: (event: { payload: unknown }) => void) => {
    listeners.set(name, callback);
    return Promise.resolve(vi.fn());
  }),
}));

import VideoTrimView from "@/views/VideoTrimView.vue";

const availableSidecars = {
  ffmpeg: { name: "ffmpeg", available: true, path: "ffmpeg.exe" },
  ffprobe: { name: "ffprobe", available: true, path: "ffprobe.exe" },
  mpv: { name: "mpv", available: true, path: "mpv.exe" },
};

function mountView() {
  return mount(VideoTrimView, {
    global: { stubs: { VideoTimeline: true } },
  });
}

async function openVideo(): Promise<void> {
  window.dispatchEvent(new CustomEvent("useful-open-file", {
    detail: { toolId: "builtin.video-trim", file: "C:\\media\\sample.mp4" },
  }));
  await flushPromises();
  await nextTick();
  await flushPromises();
}

describe("VideoTrimView preview capability", () => {
  let rectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    listeners.clear();
    routerMock.push.mockClear();
    await setLocale("zh-CN");
    ipcMock.mediaSidecars.mockReset().mockResolvedValue(availableSidecars);
    ipcMock.mediaProbe.mockReset().mockResolvedValue({
      durationSec: 60,
      width: 1_920,
      height: 1_080,
      fps: 30,
      videoCodec: "h264",
      audioCodec: "aac",
      audioTracks: 1,
      formatName: "mov,mp4",
    });
    ipcMock.mpvLoad.mockReset().mockResolvedValue({ status: "loaded", backend: "mpv-windows" });
    rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 10, y: 20, left: 10, top: 20, right: 650, bottom: 380, width: 640, height: 360,
      toJSON: () => ({}),
    } as DOMRect);
    vi.stubGlobal("ResizeObserver", class {
      observe = vi.fn();
      disconnect = vi.fn();
    });
  });

  afterEach(() => {
    rectSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("keeps confirmed direct preview operable after a dropped-frame warning", async () => {
    const wrapper = mountView();
    await flushPromises();
    await openVideo();

    expect(ipcMock.mpvStart).toHaveBeenCalledWith(10, 20, 640, 360, false);
    expect(ipcMock.mpvLoad).toHaveBeenCalledWith("C:\\media\\sample.mp4");
    expect(wrapper.get('button[title="播放"]').attributes("disabled")).toBeUndefined();

    listeners.get("mpv-frame-drops")?.({ payload: null });
    await nextTick();
    expect(wrapper.text()).toContain("当前版本尚未提供安全、可取消的代理生成");
    expect(wrapper.get('button[title="播放"]').attributes("disabled")).toBeUndefined();

    wrapper.unmount();
    await flushPromises();
  });

  it("offers only fail-closed no-overwrite export behavior", async () => {
    const wrapper = mountView();
    await flushPromises();
    expect(wrapper.text()).not.toContain("覆盖");
    expect(wrapper.find('option[value="overwrite"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("states when no preview host exists while keeping media metadata visible", async () => {
    ipcMock.mediaSidecars.mockResolvedValue({
      ...availableSidecars,
      mpv: { name: "mpv", available: false },
    });
    const wrapper = mountView();
    await flushPromises();
    await openVideo();

    expect(ipcMock.mpvStart).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("当前平台或安装没有预览宿主");
    expect(wrapper.text()).toContain("1920×1080");
    expect(wrapper.get('button[title="播放"]').attributes()).toHaveProperty("disabled");

    wrapper.unmount();
    await flushPromises();
  });

  it("reports an unconfirmed direct load as failure and stops the backend", async () => {
    ipcMock.mpvLoad.mockRejectedValueOnce(new Error("unsupported codec"));
    const wrapper = mountView();
    await flushPromises();
    await openVideo();

    expect(wrapper.text()).toContain("直接预览失败");
    expect(wrapper.text()).toContain("当前版本不生成代理");
    expect(ipcMock.mpvStop).toHaveBeenCalled();
    expect(wrapper.get('button[title="播放"]').attributes()).toHaveProperty("disabled");

    wrapper.unmount();
    await flushPromises();
  });

  it("asks before import and opens the decoder manager when transcode components are missing", async () => {
    ipcMock.mediaSidecars.mockResolvedValue({
      ffmpeg: { name: "ffmpeg", available: false },
      ffprobe: { name: "ffprobe", available: false },
      mpv: { name: "mpv", available: false },
    });
    dialogMock.confirm.mockResolvedValueOnce(true);
    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.text()).toContain("Lite 版会在需要时引导安装");
    await wrapper.get('[data-testid="choose-video"]').trigger("click");
    await flushPromises();

    expect(dialogMock.confirm).toHaveBeenCalledWith(expect.stringContaining("导入视频需要转码组件"));
    expect(routerMock.push).toHaveBeenCalledWith({
      name: "media-runtime",
      query: { required: "transcode", returnTo: "/tools/video-trim" },
    });
    expect(ipcMock.mediaProbe).not.toHaveBeenCalled();

    wrapper.unmount();
  });

  it("fails closed and still offers the decoder manager when runtime detection fails", async () => {
    ipcMock.mediaSidecars.mockRejectedValueOnce(new Error("Tauri IPC unavailable"));
    dialogMock.confirm.mockResolvedValueOnce(true);
    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.text()).toContain("暂时无法读取本机媒体组件状态");
    expect(wrapper.text()).toContain("Lite 版会在需要时引导安装");
    expect(wrapper.text()).not.toContain("Tauri IPC unavailable");
    await wrapper.get('[data-testid="choose-video"]').trigger("click");
    await flushPromises();

    expect(dialogMock.confirm).toHaveBeenCalled();
    expect(routerMock.push).toHaveBeenCalledWith({
      name: "media-runtime",
      query: { required: "transcode", returnTo: "/tools/video-trim" },
    });

    wrapper.unmount();
  });
});
