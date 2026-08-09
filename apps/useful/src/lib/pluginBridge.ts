// 插件宿主桥：window.postMessage 仅用于一次性 MessageChannel bootstrap；RPC 只走私有 port。
// sandbox 未启用 allow-same-origin，event.origin 是 opaque，不能作为身份边界。
import { invoke } from "@tauri-apps/api/core";

interface BridgeOptions {
  pluginId: string;
  iframe: HTMLIFrameElement;
  capability: string;
  onError?: (msg: string) => void;
}

interface BootstrapRequest {
  __usefulBootstrap: true;
  capability: string;
}

interface PluginRequest {
  __usefulRpc: true;
  id: string;
  method: string;
  params?: unknown;
}

interface MethodPolicy {
  interactive: boolean;
}

const METHODS = new Map<string, MethodPolicy>([
  ["getTheme", { interactive: false }],
  ["getLanguage", { interactive: false }],
  ["plugin.ready", { interactive: false }],
  ["reportProgress", { interactive: false }],
]);

const MAX_MESSAGE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
export const MAX_GLOBAL_IN_FLIGHT = 16;
export const MAX_PLUGIN_IN_FLIGHT = 2;
export const MAX_INTERACTIVE_IN_FLIGHT = 1;

let globalInFlight = 0;
let interactiveInFlight = 0;
const pluginInFlight = new Map<string, number>();

export function createBridgeCapability(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function reserve(pluginId: string, interactive: boolean): boolean {
  const perPlugin = pluginInFlight.get(pluginId) ?? 0;
  if (globalInFlight >= MAX_GLOBAL_IN_FLIGHT || perPlugin >= MAX_PLUGIN_IN_FLIGHT) return false;
  if (interactive && interactiveInFlight >= MAX_INTERACTIVE_IN_FLIGHT) return false;
  globalInFlight++;
  if (interactive) interactiveInFlight++;
  pluginInFlight.set(pluginId, perPlugin + 1);
  return true;
}

function release(pluginId: string, interactive: boolean): void {
  globalInFlight = Math.max(0, globalInFlight - 1);
  if (interactive) interactiveInFlight = Math.max(0, interactiveInFlight - 1);
  const next = Math.max(0, (pluginInFlight.get(pluginId) ?? 1) - 1);
  if (next === 0) pluginInFlight.delete(pluginId);
  else pluginInFlight.set(pluginId, next);
}

function messageSize(value: unknown): number | null {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return null;
  }
}

export function createPluginBridge(opts: BridgeOptions) {
  let pendingCount = 0;
  let rejectionCount = 0;
  let active = true;
  let bootstrapped = false;
  let bootstrapArmed = false;
  let loadedDocumentWindow: Window | null = null;
  let port: MessagePort | null = null;
  const responseTimers = new Set<ReturnType<typeof setTimeout>>();
  const requestIds = new Set<string>();

  function reply(id: string, response: Record<string, unknown>): void {
    if (!active || !port) return;
    port.postMessage({ __usefulRpc: true, id, ...response });
  }

  async function onPortMessage(event: MessageEvent): Promise<void> {
    if (!active || event.target !== port) return;
    const raw = event.data;
    const size = messageSize(raw);
    if (size === null || size > MAX_MESSAGE_BYTES) {
      rejectionCount++;
      opts.onError?.("插件 RPC 消息超过大小限制或无法序列化");
      return;
    }
    if (!raw || typeof raw !== "object" || (raw as PluginRequest).__usefulRpc !== true) return;
    const req = raw as PluginRequest;
    if (typeof req.id !== "string" || typeof req.method !== "string") return;
    const policy = METHODS.get(req.method);
    if (!policy) {
      rejectionCount++;
      reply(req.id, { ok: false, error: `方法未被允许: ${req.method}` });
      return;
    }
    if (requestIds.has(req.id)) {
      rejectionCount++;
      reply(req.id, { ok: false, error: "请求 id 重复" });
      return;
    }
    if (!reserve(opts.pluginId, policy.interactive)) {
      rejectionCount++;
      reply(req.id, { ok: false, error: "插件桥并发请求过多" });
      return;
    }

    requestIds.add(req.id);
    pendingCount++;
    let responded = false;
    const timer = setTimeout(() => {
      responseTimers.delete(timer);
      responded = true;
      reply(req.id, { ok: false, error: "请求超时" });
    }, REQUEST_TIMEOUT_MS);
    responseTimers.add(timer);

    try {
      const result = await invoke("plugin_bridge_call", {
        pluginId: opts.pluginId,
        method: req.method,
        params: req.params ?? null,
      });
      if (!responded) reply(req.id, { ok: true, result });
    } catch (error) {
      if (!responded) reply(req.id, { ok: false, error: String(error) });
    } finally {
      clearTimeout(timer);
      responseTimers.delete(timer);
      requestIds.delete(req.id);
      pendingCount--;
      release(opts.pluginId, policy.interactive);
    }
  }

  function onBootstrap(event: MessageEvent): void {
    const offeredPort = event.ports[0];
    if (
      !active ||
      !bootstrapArmed ||
      bootstrapped ||
      !loadedDocumentWindow ||
      opts.iframe.contentWindow !== loadedDocumentWindow ||
      event.source !== loadedDocumentWindow
    ) {
      for (const candidate of event.ports) candidate.close();
      return;
    }
    const raw = event.data as BootstrapRequest | undefined;
    if (
      !raw ||
      raw.__usefulBootstrap !== true ||
      raw.capability !== opts.capability ||
      event.ports.length !== 1
    ) {
      rejectionCount++;
      for (const candidate of event.ports) candidate.close();
      return;
    }
    bootstrapArmed = false;
    bootstrapped = true;
    port = offeredPort;
    port.onmessage = (message): void => { void onPortMessage(message); };
    port.start();
    // 通过已交换的 port 确认；不对可能已导航的 WindowProxy 回送能力。
    port.postMessage({ __usefulBootstrap: true, capability: opts.capability, ok: true });
  }

  window.addEventListener("message", onBootstrap);

  return {
    armForLoadedDocument(): boolean {
      if (!active || bootstrapArmed || bootstrapped) return false;
      loadedDocumentWindow = opts.iframe.contentWindow;
      if (!loadedDocumentWindow) return false;
      bootstrapArmed = true;
      return true;
    },
    dispose(): void {
      active = false;
      bootstrapArmed = false;
      loadedDocumentWindow = null;
      window.removeEventListener("message", onBootstrap);
      for (const timer of responseTimers) clearTimeout(timer);
      responseTimers.clear();
      if (port) {
        port.onmessage = null;
        port.close();
        port = null;
      }
      // Tauri invoke 无可靠取消 API；其 settle 前真实槽位仍由 finally 占用。
    },
    stats(): { pending: number; rejected: number; bootstrapped: boolean } {
      return { pending: pendingCount, rejected: rejectionCount, bootstrapped };
    },
  };
}
