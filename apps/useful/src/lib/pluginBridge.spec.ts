import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  createBridgeCapability,
  createPluginBridge,
  MAX_GLOBAL_IN_FLIGHT,
  MAX_INTERACTIVE_IN_FLIGHT,
  MAX_PLUGIN_IN_FLIGHT,
} from "./pluginBridge";

class FakePort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  peer: FakePort | null = null;
  closed = false;
  posted: unknown[] = [];
  received: unknown[] = [];
  start(): void {}
  close(): void { this.closed = true; }
  postMessage(data: unknown): void {
    this.posted.push(data);
    this.peer?.received.push(data);
    // 真实 MessagePort 事件的 target 是接收端 port。jsdom 不会为手动构造的
    // MessageEvent 设置它，因此在 fake 中补齐这个浏览器语义。
    const event = new MessageEvent("message", { data });
    Object.defineProperty(event, "target", { value: this.peer });
    this.peer?.onmessage?.(event);
  }
}

class FakeChannel {
  port1 = new FakePort();
  port2 = new FakePort();
  constructor() {
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
  }
}

function fixture() {
  const iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
  const capability = "c".repeat(64);
  const bridge = createPluginBridge({ pluginId: "plugin.test", iframe, capability });
  const load = () => {
    // 宿主只在 iframe 的明确 load 回调后绑定该 document；不能用初始化时的
    // about:blank WindowProxy 来交换能力。
    iframe.dispatchEvent(new Event("load"));
    expect(bridge.armForLoadedDocument()).toBe(true);
  };
  const bootstrap = (secret = capability) => {
    const channel = new FakeChannel();
    window.dispatchEvent(new MessageEvent("message", {
      source: iframe.contentWindow,
      data: { __usefulBootstrap: true, capability: secret },
      ports: [channel.port2 as unknown as MessagePort],
    }));
    return channel.port1;
  };
  return { iframe, capability, bridge, bootstrap, load };
}

describe("pluginBridge MessageChannel boundary", () => {
  beforeEach(() => {
    invoke.mockReset();
    document.body.innerHTML = "";
    vi.stubGlobal("MessageChannel", FakeChannel);
  });

  it("uses the required 16/2/1 limits and a random 256-bit bootstrap secret", () => {
    expect(MAX_GLOBAL_IN_FLIGHT).toBe(16);
    expect(MAX_PLUGIN_IN_FLIGHT).toBe(2);
    expect(MAX_INTERACTIVE_IN_FLIGHT).toBe(1);
    expect(createBridgeCapability()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("exchanges the secret once and sends RPC only through the transferred port", async () => {
    invoke.mockResolvedValue("dark");
    const { bridge, bootstrap, load } = fixture();
    const beforeLoad = bootstrap();
    expect(beforeLoad.peer?.closed).toBe(true);
    expect(bridge.stats().bootstrapped).toBe(false);
    load();
    const wrong = bootstrap("d".repeat(64));
    expect(wrong.peer?.closed).toBe(true);
    const pluginPort = bootstrap();
    expect(pluginPort.received).toContainEqual(
      expect.objectContaining({ __usefulBootstrap: true, ok: true }),
    );
    const later = bootstrap();
    expect(later.peer?.closed).toBe(true);
    pluginPort.postMessage({ __usefulRpc: true, id: "one", method: "getTheme" });
    await vi.waitFor(() => expect(pluginPort.received).toContainEqual(
      expect.objectContaining({ __usefulRpc: true, id: "one", ok: true, result: "dark" }),
    ));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(bridge.stats()).toMatchObject({ bootstrapped: true, rejected: 1 });
    bridge.dispose();
    expect(pluginPort.peer?.closed).toBe(true);
  });

  it("keeps the two real plugin slots occupied after response timeout", async () => {
    vi.useFakeTimers();
    const settle: Array<(value: unknown) => void> = [];
    invoke.mockImplementation(() => new Promise((resolve) => { settle.push(resolve); }));
    const { bridge, bootstrap, load } = fixture();
    load();
    const pluginPort = bootstrap();
    pluginPort.postMessage({ __usefulRpc: true, id: "one", method: "getTheme" });
    pluginPort.postMessage({ __usefulRpc: true, id: "two", method: "getLanguage" });
    await vi.advanceTimersByTimeAsync(15_000);
    pluginPort.postMessage({ __usefulRpc: true, id: "overflow", method: "getTheme" });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(bridge.stats().pending).toBe(2);
    settle.forEach((resolve) => resolve(null));
    await Promise.resolve();
    bridge.dispose();
    vi.useRealTimers();
  });

  it("enforces the real global limit across different plugins", async () => {
    const settle: Array<(value: unknown) => void> = [];
    invoke.mockImplementation(() => new Promise((resolve) => { settle.push(resolve); }));
    const bridges: Array<Pick<ReturnType<typeof fixture>, "bridge">> = [];
    for (let index = 0; index < 9; index++) {
      const iframe = document.createElement("iframe");
      document.body.appendChild(iframe);
      const capability = index.toString(16).padStart(64, "0");
      const bridge = createPluginBridge({ pluginId: `plugin.${index}`, iframe, capability });
      iframe.dispatchEvent(new Event("load"));
      expect(bridge.armForLoadedDocument()).toBe(true);
      const channel = new FakeChannel();
      window.dispatchEvent(new MessageEvent("message", {
        source: iframe.contentWindow,
        data: { __usefulBootstrap: true, capability },
        ports: [channel.port2 as unknown as MessagePort],
      }));
      channel.port1.postMessage({ __usefulRpc: true, id: `${index}-a`, method: "getTheme" });
      channel.port1.postMessage({ __usefulRpc: true, id: `${index}-b`, method: "getLanguage" });
      bridges.push({ bridge });
    }
    expect(invoke).toHaveBeenCalledTimes(MAX_GLOBAL_IN_FLIGHT);
    settle.forEach((resolve) => resolve(null));
    await Promise.resolve();
    bridges.forEach(({ bridge }) => bridge.dispose());
  });
});
