import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import type { ProcessDelta, ProcmonStats } from "@/lib/types";

let deltaListener: ((event: { payload: ProcessDelta }) => void) | undefined;

const ipcMock = vi.hoisted(() => ({
  procmonStart: vi.fn().mockResolvedValue(undefined),
  procmonStop: vi.fn().mockResolvedValue(undefined),
  procmonSetPaused: vi.fn().mockResolvedValue(undefined),
  procmonOpenFolder: vi.fn().mockResolvedValue(undefined),
  killProcess: vi.fn().mockResolvedValue(undefined),
  killProcessTree: vi.fn().mockResolvedValue(undefined),
  procmonStats: vi.fn(),
  elevationStatus: vi.fn().mockResolvedValue({ elevated: false, platform: "windows", canRequest: false }),
  restartElevated: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/ipc", () => ({ default: ipcMock }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_name: string, callback: (event: { payload: ProcessDelta }) => void) => {
    deltaListener = callback;
    return Promise.resolve(vi.fn());
  }),
}));

import ProcessMonitorView from "@/views/ProcessMonitorView.vue";

const standardUserStats: ProcmonStats = {
  running: true,
  paused: false,
  backendSamplingMs: 5,
  processCount: 1,
  netAvailable: false,
  gpuAvailable: false,
  lastDeltaAdded: 1,
  lastDeltaUpdated: 0,
  lastDeltaRemoved: 0,
  network: {
    interfaceCapability: { available: true },
    connectionCapability: { available: true },
    etwCapability: {
      available: false,
      reasonCode: "etw_access_denied",
      remediation: "加入 Performance Log Users 后重新登录。",
    },
    interfaces: [{
      key: "1:1",
      name: "Ethernet",
      description: "physical",
      upBytesPerSec: 2_048,
      downBytesPerSec: 4_096,
      isLoopback: false,
      isVirtual: false,
    }],
    totalUpBytesPerSec: 2_048,
    totalDownBytesPerSec: 4_096,
    aggregateScope: "排除 loopback",
  },
  processControlAvailable: false,
};

describe("ProcessMonitorView 网络降级显示", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    deltaListener = undefined;
    ipcMock.procmonStats.mockResolvedValue(standardUserStats);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("标准用户看到接口真实吞吐、权限提示和独立连接计数", async () => {
    const wrapper = mount(ProcessMonitorView);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    deltaListener?.({
      payload: {
        added: [{
          identity: { pid: 7, startTime: 100 },
          static: { name: "browser" },
          dynamic: {
            cpu: 1,
            workingSet: 1_024,
            privateBytes: 2_048,
            diskRead: 0,
            diskWrite: 0,
            netUp: { state: "unavailable" },
            netDown: { state: "unavailable" },
            tcpConnections: { state: "available", value: 3 },
            udpEndpoints: { state: "available", value: 1 },
            gpu: { state: "unavailable" },
            gpuMemory: { state: "unavailable" },
            threads: 2,
            handles: { state: "available", value: 4 },
          },
        }],
        updated: [],
        removed: [],
      },
    });
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain("接口总吞吐");
    // 网卡列表默认折叠，避免虚拟接口撑满布局；展开后才显示名称。
    expect(wrapper.find('[data-testid="network-interfaces-list"]').exists()).toBe(false);
    expect(wrapper.text()).toContain("1 个接口");
    await wrapper.get('[data-testid="toggle-network-interfaces"]').trigger("click");
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="network-interfaces-list"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("Ethernet");
    expect(wrapper.text()).toContain("每进程字节不可用");
    expect(wrapper.text()).toContain("etw_access_denied");
    expect(wrapper.get('[data-testid="manual-elevation-guidance"]').text()).toContain("手动");
    expect(wrapper.find('[data-testid="request-etw-elevation"]').exists()).toBe(false);
    expect(wrapper.text()).toContain("连接：TCP 3 · UDP 1");
    expect(wrapper.text()).toContain("只读模式");
    expect(wrapper.text()).not.toContain("结束进程");
    expect(ipcMock.killProcess).not.toHaveBeenCalled();
    expect(ipcMock.killProcessTree).not.toHaveBeenCalled();
    expect(wrapper.text()).not.toContain("↑3 B/s");
    wrapper.unmount();
    await flushPromises();
  });

  it("canRequest=false 时只显示手动管理员启动指引", async () => {
    ipcMock.elevationStatus.mockResolvedValueOnce({ elevated: false, platform: "windows", canRequest: false });
    const wrapper = mount(ProcessMonitorView);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    expect(wrapper.find('[data-testid="request-etw-elevation"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="manual-elevation-guidance"]').text()).toContain("手动");
    expect(ipcMock.restartElevated).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("部分指标不可用时逐项标示，不把缺失值伪装成零", async () => {
    ipcMock.procmonStats.mockResolvedValue({
      ...standardUserStats,
      network: {
        ...standardUserStats.network,
        connectionCapability: {
          available: false,
          reasonCode: "owner_table_denied",
          remediation: "以允许读取 owner table 的账户运行。",
        },
      },
    });
    const wrapper = mount(ProcessMonitorView);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    deltaListener?.({
      payload: {
        added: [{
          identity: { pid: 8, startTime: 101 },
          static: { name: "partial-network" },
          dynamic: {
            cpu: 1,
            workingSet: 1_024,
            privateBytes: 2_048,
            diskRead: 0,
            diskWrite: 0,
            netUp: { state: "available", value: 1_024 },
            netDown: { state: "unavailable" },
            tcpConnections: { state: "unavailable" },
            udpEndpoints: { state: "available", value: 2 },
            gpu: { state: "unavailable" },
            gpuMemory: { state: "unavailable" },
            threads: 2,
            handles: { state: "available", value: 4 },
          },
        }],
        updated: [],
        removed: [],
      },
    });
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain("↑1.0 KB/s");
    expect(wrapper.text()).toContain("↓不可用");
    expect(wrapper.text()).toContain("连接：TCP 不可用 · UDP 2");
    expect(wrapper.text()).toContain("每进程连接/端点计数不可用");
    expect(wrapper.text()).toContain("owner_table_denied");
    wrapper.unmount();
    await flushPromises();
  });
});
