export const HOST_ACTION_IDS: Readonly<{
  VIDEO_PROBE: "builtin.video-trim.probe";
  VIDEO_EXPORT: "builtin.video-trim.export";
  PROCESS_SNAPSHOT: "builtin.process-monitor.snapshot";
  PROCESS_TERMINATE: "builtin.process-monitor.terminate";
}>;

export class HostActionError extends Error {
  constructor(code: string, actionCode?: string);
  code: string;
  actionCode?: string;
}

export type HostActionId = (typeof HOST_ACTION_IDS)[keyof typeof HOST_ACTION_IDS];

export interface HostActionDescriptor extends Record<string, unknown> {
  readonly contractVersion: "1.0";
  readonly actionId: HostActionId;
  readonly version: "1.0.0";
  readonly execution: Readonly<{
    mode: "host";
    handler: HostActionId;
    timeoutMs: number;
    maxInputBytes: number;
    maxOutputBytes: number;
    supportsCancellation: true;
  }>;
  readonly behavior: Readonly<{
    readOnly: boolean;
    destructive: boolean;
    idempotent: boolean;
    openWorld: false;
    sideEffects: readonly string[];
    requiresConfirmation: boolean;
  }>;
  readonly permissions: Readonly<{
    required: readonly string[];
    capabilities: readonly string[];
  }>;
  readonly sensitive: Readonly<{
    input: readonly string[];
    output: readonly string[];
    redactLogs: true;
  }>;
}

export interface LoadedHostActionConfig {
  readonly schemaVersion: "useful.host-actions.v1";
  readonly enabled: Readonly<{
    videoProbe: boolean;
    videoExport: boolean;
    processSnapshot: boolean;
    processTerminate: boolean;
  }>;
  readonly readRoots: readonly string[];
  readonly writeRoots: readonly string[];
  readonly process: Readonly<{
    fields: readonly ("pid" | "startTime" | "name")[];
    maxProcesses: number;
    maxOutputBytes: number;
  }>;
  readonly video?: Readonly<{
    allowOverwrite: false;
    maxDurationSec: number;
    maxProbeOutputBytes: number;
    videoCodecs: readonly ("copy" | "libx264" | "libx265" | "libvpx-vp9")[];
    audioCodecs: readonly ("copy" | "aac" | "libopus")[];
  }>;
}

export interface HostActionEntry {
  readonly descriptor: Readonly<HostActionDescriptor>;
  readonly handler: (input: Record<string, unknown>, context?: { signal?: AbortSignal }) => Promise<Record<string, unknown>>;
}

export function loadHostActionConfig(configPath: string): Promise<LoadedHostActionConfig>;
export function createHostActionEntries(config: LoadedHostActionConfig): readonly HostActionEntry[];
