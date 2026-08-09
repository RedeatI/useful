import { beforeEach, describe, expect, it, vi } from "vitest";
import { UsefulClient } from "./index";

const capability = "a".repeat(64);

class FakePort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  peer: FakePort | null = null;
  posted: unknown[] = [];
  received: unknown[] = [];
  closed = false;
  start(): void {}
  close(): void { this.closed = true; }
  postMessage(data: unknown): void {
    this.posted.push(data);
    this.peer?.received.push(data);
    this.peer?.onmessage?.(new MessageEvent("message", { data }));
  }
  respond(data: unknown): void { this.onmessage?.(new MessageEvent("message", { data })); }
}

const channels: FakeChannel[] = [];

class FakeChannel {
  port1 = new FakePort();
  port2 = new FakePort();
  constructor() {
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
    channels.push(this);
  }
}

describe("useful SDK MessageChannel bootstrap", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    channels.length = 0;
    vi.stubGlobal("MessageChannel", FakeChannel);
    window.history.replaceState(null, "", `/#usefulCapability=${capability}`);
  });

  it("uses window only once for bootstrap, clears the secret, then sends RPC on the port", async () => {
    const post = vi.spyOn(window.parent, "postMessage").mockImplementation((...args: unknown[]) => {
      const [message, , transfer] = args as [unknown, string, Transferable[] | undefined];
      expect(message).toEqual({ __usefulBootstrap: true, capability });
      const hostPort = transfer?.[0] as unknown as FakePort;
      setTimeout(() => hostPort.postMessage({ __usefulBootstrap: true, capability, ok: true }), 0);
    });
    const request = new UsefulClient().getTheme();
    expect(post).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(channels[0]?.port1.posted).toHaveLength(1));
    const rpc = channels[0].port1.posted[0] as { id: string };
    channels[0].port2.postMessage({ __usefulRpc: true, id: rpc.id, ok: true, result: "dark" });
    await expect(request).resolves.toBe("dark");
    expect(post).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe("");
  });

  it("fails closed without a bootstrap secret", async () => {
    window.history.replaceState(null, "", "/");
    const post = vi.spyOn(window.parent, "postMessage");
    await expect(new UsefulClient().ready()).rejects.toThrow("bootstrap secret");
    expect(post).not.toHaveBeenCalled();
  });
});
