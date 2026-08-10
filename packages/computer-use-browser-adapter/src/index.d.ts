import type {
  ComputerUseAction,
  ComputerUsePolicy,
  ComputerUseProvider,
  NetworkEvidence,
} from "@useful/computer-use-contract";

export interface IsolatedBrowserNetworkEnforcement {
  transport: "host-enforced";
  requests: "every-request";
  dns: "all-addresses";
  redirects: "every-hop";
  ports: "explicit";
}

export interface IsolatedBrowserNetworkGuardSession<Binding = unknown> {
  binding: Binding;
  evidence(context: { signal: AbortSignal }): Promise<NetworkEvidence>;
  close(context: { signal: AbortSignal; reason?: string }): Promise<void>;
}

export interface IsolatedBrowserNetworkGuard<Binding = unknown> {
  enforcement: IsolatedBrowserNetworkEnforcement;
  open(
    request: { startUrl: string; policy: Readonly<ComputerUsePolicy> },
    context: { signal: AbortSignal },
  ): Promise<IsolatedBrowserNetworkGuardSession<Binding>>;
}

export interface IsolatedBrowserObservation {
  screenshot: ArrayBuffer | ArrayBufferView;
  url: string;
  documentToken: string;
}

export interface IsolatedBrowserDriverResult {
  resultCode: string;
}

export interface IsolatedBrowserContext {
  observe(request: { maxScreenshotBytes: number }, context: { signal: AbortSignal }): Promise<IsolatedBrowserObservation>;
  screenshot(request: { documentToken: string }, context: { signal: AbortSignal }): Promise<IsolatedBrowserDriverResult>;
  click(request: { documentToken: string; x: number; y: number; button?: "left" | "middle" | "right" }, context: { signal: AbortSignal }): Promise<IsolatedBrowserDriverResult>;
  doubleClick(request: { documentToken: string; x: number; y: number; button?: "left" | "middle" | "right" }, context: { signal: AbortSignal }): Promise<IsolatedBrowserDriverResult>;
  drag(request: { documentToken: string; startX: number; startY: number; endX: number; endY: number; durationMs?: number }, context: { signal: AbortSignal }): Promise<IsolatedBrowserDriverResult>;
  move(request: { documentToken: string; x: number; y: number }, context: { signal: AbortSignal }): Promise<IsolatedBrowserDriverResult>;
  scroll(request: { documentToken: string; deltaX: number; deltaY: number; x?: number; y?: number }, context: { signal: AbortSignal }): Promise<IsolatedBrowserDriverResult>;
  typeText(request: { documentToken: string; text: string }, context: { signal: AbortSignal }): Promise<IsolatedBrowserDriverResult>;
  pressKeys(request: { documentToken: string; keys: string[] }, context: { signal: AbortSignal }): Promise<IsolatedBrowserDriverResult>;
  wait(request: { documentToken: string; durationMs: number }, context: { signal: AbortSignal }): Promise<IsolatedBrowserDriverResult>;
  close(context: { signal: AbortSignal; reason?: string }): Promise<void>;
}

export interface IsolatedBrowserProviderOptions<Binding = unknown> {
  createContext(
    request: Readonly<{ startUrl: string; networkGuardBinding: Binding }>,
    context: { signal: AbortSignal },
  ): Promise<IsolatedBrowserContext>;
  startUrl: string;
  networkGuard: IsolatedBrowserNetworkGuard<Binding>;
  idFactory?: () => string;
}

export interface IsolatedBrowserProvider extends ComputerUseProvider {
  reapQuarantine(context?: { signal?: AbortSignal }): Promise<Readonly<{ remaining: number; closed: number }>>;
}

export function createIsolatedBrowserProvider<Binding = unknown>(
  options: IsolatedBrowserProviderOptions<Binding>,
): IsolatedBrowserProvider;

export type { ComputerUseAction };
