// DownloadsView 渲染冒烟测试：验证下载与更新视图能挂载并渲染队列/空状态。
// 事件监听以 mock 提供（等价于浏览器中无 Tauri 事件系统时的渲染）。
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

const downloadsList = vi.fn();
vi.mock("@/lib/ipc", () => ({
  default: {
    downloadsList: (...args: unknown[]) => downloadsList(...args),
    downloadCancel: vi.fn().mockResolvedValue(undefined),
    downloadsClearFinished: vi.fn().mockResolvedValue(undefined),
  },
}));

import DownloadsView from "@/views/DownloadsView.vue";

describe("DownloadsView 渲染", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    downloadsList.mockReset();
  });

  it("无任务时显示空状态", async () => {
    downloadsList.mockResolvedValue([]);
    const wrapper = mount(DownloadsView);
    await flushPromises();
    expect(wrapper.text()).toContain("下载与更新");
    expect(wrapper.text()).toContain("没有进行中的下载或更新任务");
    expect(wrapper.findAll('[data-testid="download-item"]')).toHaveLength(0);
  });

  it("有任务时渲染下载项、进度与进行中任务的取消按钮", async () => {
    downloadsList.mockResolvedValue([
      {
        id: "d1",
        url: "https://example.com/a.useful",
        packageId: "com.example.a",
        version: "1.0.0",
        totalBytes: 1000,
        receivedBytes: 500,
        status: "downloading",
        error: null,
        createdAt: 1,
      },
      {
        id: "d2",
        url: "https://example.com/b.useful",
        packageId: "com.example.b",
        version: "2.0.0",
        totalBytes: 2000,
        receivedBytes: 2000,
        status: "done",
        error: null,
        createdAt: 2,
      },
    ]);
    const wrapper = mount(DownloadsView);
    await flushPromises();

    const items = wrapper.findAll('[data-testid="download-item"]');
    expect(items).toHaveLength(2);
    // 进行中任务状态与进度文本
    expect(wrapper.text()).toContain("下载中");
    expect(wrapper.text()).toContain("50%");
    // 已完成任务状态
    expect(wrapper.text()).toContain("已完成");
    // 仅进行中任务显示取消按钮
    expect(wrapper.findAll('[data-testid="download-cancel"]')).toHaveLength(1);
  });
});
