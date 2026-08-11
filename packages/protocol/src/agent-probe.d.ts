export type AgentProbeInstallationMode = "source" | "agent-kit";

export interface AgentProbeInstallation {
  readonly mode: AgentProbeInstallationMode;
  /**
   * True only for an Agent Kit MANIFEST closed-set hash/size integrity
   * self-check. It does not attest signature, origin, sidecar, or publishing
   * authorization.
   */
  readonly artifactVerified: boolean;
  readonly sourceRevision: string;
  readonly version: string;
}

export interface AgentProbeServer {
  readonly name: "useful-actions";
  /** Actual MCP component version; it is independent of installation.version. */
  readonly version: string;
  readonly protocolVersion: "2026-07-28";
}

export interface AgentProbeTools {
  readonly count: number;
  readonly namesSha256: string;
  readonly actionCount: number;
  readonly helperCount: number;
}

export interface AgentProbeProof {
  readonly handshake: true;
  readonly list: true;
  readonly search: true;
  readonly describe: true;
  readonly safeCall: true;
  readonly transportClosed: true;
  readonly externalAgentInstalled: false;
  readonly codexConfigured: false;
  readonly claudeConfigured: false;
  readonly hostConfigWrittenByProbe: false;
  readonly launcherNetworkAttested: false;
}

export interface AgentProbeProcess {
  readonly stderrBytes: number;
  readonly stderrSha256: string;
  readonly transportClosed: true;
}

export interface AgentProbe {
  readonly schemaVersion: "useful.agent-probe.v1";
  readonly status: "success";
  readonly proofScope: "useful-mcp-local-stdio";
  readonly installation: AgentProbeInstallation;
  readonly server: AgentProbeServer;
  readonly tools: AgentProbeTools;
  readonly proof: AgentProbeProof;
  readonly process: AgentProbeProcess;
}

export interface CreateAgentProbeInput {
  installation: AgentProbeInstallation;
  server: AgentProbeServer;
  tools: AgentProbeTools;
  proof: AgentProbeProof;
  process: AgentProbeProcess;
}

export class AgentProbeProtocolError extends Error {
  code: string;
  details: Readonly<Record<string, unknown>>;
}

export const AGENT_PROBE_SCHEMA_VERSION: "useful.agent-probe.v1";
export const AGENT_PROBE_SCHEMA_FILE: "agent-probe.schema.json";
export const AGENT_PROBE_SCHEMA_ID: "https://schemas.useful.example/agent/useful.agent-probe.v1.schema.json";
export const AGENT_PROBE_SCOPE: "useful-mcp-local-stdio";
export const AGENT_PROBE_INSTALLATION_MODES: readonly AgentProbeInstallationMode[];

export function snapshotAgentProbeData<T>(value: T, field?: string): T;
export function deepFreezeAgentProbeData<T>(value: T): Readonly<T>;
export function parseAgentProbe(document: unknown): Readonly<AgentProbe>;
export function validateAgentProbe(document: unknown): Readonly<AgentProbe>;
export function createAgentProbe(input: CreateAgentProbeInput): Readonly<AgentProbe>;
