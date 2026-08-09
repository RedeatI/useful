// Useful web 插件 SDK。一次性 fragment secret 只用于换取 MessageChannel；RPC 不走 window 消息。
export type Theme = "light" | "dark" | "system";
export type Language = "zh-CN";

interface PendingResolver {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface HostResponse {
  __usefulRpc: true;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const BOOTSTRAP_TIMEOUT_MS = 5_000;

async function afterCurrentDocumentLoad(): Promise<void> {
  if (document.readyState !== "complete") {
    await new Promise<void>((resolve) => {
      window.addEventListener("load", () => resolve(), { once: true });
    });
  }
  // 宿主 iframe load 监听器先绑定当前文档；不让 about:blank/预加载脚本抢先握手。
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function capabilityFromFragment(): string | null {
  const capability = new URLSearchParams(window.location.hash.slice(1)).get("usefulCapability");
  return capability && /^[0-9a-f]{64}$/.test(capability) ? capability : null;
}

function clearCapabilityFragment(): void {
  try {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  } catch {
    // opaque-origin 沙箱可能拒绝 History API。此时 secret 已被宿主一次性消费；
    // 不用 location.hash 降级，因为哈希导航可以触发 iframe load 并使宿主关闭 port。
  }
}

export class UsefulClient {
  private pending = new Map<string, PendingResolver>();
  private seq = 0;
  private capability: string | null = null;
  private portPromise: Promise<MessagePort> | null = null;

  private connect(): Promise<MessagePort> {
    this.capability ??= capabilityFromFragment();
    this.portPromise ??= this.bootstrap();
    return this.portPromise;
  }

  private async bootstrap(): Promise<MessagePort> {
    if (!this.capability) return Promise.reject(new Error("缺少 Useful 宿主 bootstrap secret"));
    await afterCurrentDocumentLoad();
    return await new Promise<MessagePort>((resolve, reject) => {
      const channel = new MessageChannel();
      const pluginPort = channel.port1;
      pluginPort.onmessage = (event: MessageEvent): void => {
        const data = event.data as { __usefulBootstrap?: boolean; capability?: string; ok?: boolean };
        if (
          !data ||
          data.__usefulBootstrap !== true ||
          data.ok !== true ||
          data.capability !== this.capability
        ) return;
        cleanup();
        pluginPort.onmessage = (message): void => this.onPortMessage(message);
        clearCapabilityFragment();
        resolve(pluginPort);
      };
      const timer = setTimeout(() => {
        cleanup();
        pluginPort.close();
        reject(new Error("Useful 宿主 bootstrap 超时"));
      }, BOOTSTRAP_TIMEOUT_MS);
      const cleanup = (): void => {
        clearTimeout(timer);
      };
      pluginPort.start();
      window.parent.postMessage(
        { __usefulBootstrap: true, capability: this.capability },
        "*",
        [channel.port2],
      );
    });
  }

  private onPortMessage(event: MessageEvent): void {
    const data = event.data as HostResponse | undefined;
    if (!data || typeof data !== "object" || data.__usefulRpc !== true || !("ok" in data)) return;
    const resolver = this.pending.get(data.id);
    if (!resolver) return;
    this.pending.delete(data.id);
    clearTimeout(resolver.timer);
    if (data.ok) resolver.resolve(data.result);
    else resolver.reject(new Error(data.error ?? "宿主返回错误"));
  }

  private async call<T>(method: string, params?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    const port = await this.connect();
    const id = `${Date.now()}-${this.seq++}`;
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`调用 ${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      port.postMessage({ __usefulRpc: true, id, method, params });
    });
  }

  getTheme(): Promise<Theme> { return this.call<Theme>("getTheme"); }
  getLanguage(): Promise<Language> { return this.call<Language>("getLanguage"); }
  ready(details?: Record<string, unknown>): Promise<void> { return this.call<void>("plugin.ready", details ?? {}); }
  reportProgress(percent: number, label?: string): Promise<void> { return this.call<void>("reportProgress", { percent, label }); }
}

export const useful = new UsefulClient();
export default useful;
