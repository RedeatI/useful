export type AgentIntegrationTarget = "codex" | "claude-code" | "claude-desktop" | "mcp-servers-json";
export type AgentIntegrationScope = "user" | "project";
export type AgentIntegrationHostPlatform = "win32" | "linux" | "darwin";
export type AgentIntegrationEnvironment = Readonly<Partial<{
  NO_COLOR: "1";
  USEFUL_LOG_LEVEL: "error" | "warn" | "info";
  USEFUL_PROFILE: string;
}>>;

export interface AgentIntegrationServer {
  readonly name: "useful";
  readonly nodePath: string;
  readonly launcherPath: string;
  readonly args: readonly [];
  readonly env: AgentIntegrationEnvironment;
}

export interface AgentIntegrationPlan {
  readonly schemaVersion: "useful.agent-integration.v1";
  readonly target: AgentIntegrationTarget;
  readonly transport: "stdio";
  readonly scope: AgentIntegrationScope;
  readonly projectDirectory?: string;
  readonly server: AgentIntegrationServer;
}

export interface AgentIntegrationHostCommandOutput {
  readonly kind: "host-command";
  readonly commandArgv: readonly string[];
  readonly powershellCommand: string;
  readonly requiredWorkingDirectory?: string;
  readonly writesHostConfigWhenExecuted: true;
}

export interface AgentIntegrationMcpServer {
  readonly command: string;
  readonly args: readonly [string];
  readonly env?: AgentIntegrationEnvironment;
}

export interface AgentIntegrationJsonMergeOutput {
  readonly kind: "merge-fragment";
  readonly format: "json";
  readonly mergeFragment: Readonly<{ mcpServers: Readonly<{ useful: AgentIntegrationMcpServer }> }>;
  readonly writesHostConfigWhenExecuted: false;
}

export interface AgentIntegrationTomlMergeOutput {
  readonly kind: "merge-fragment";
  readonly format: "toml";
  readonly configPath: string;
  readonly mergeFragment: string;
  readonly writesHostConfigWhenExecuted: false;
}

export type AgentIntegrationOutput = AgentIntegrationHostCommandOutput | AgentIntegrationJsonMergeOutput | AgentIntegrationTomlMergeOutput;

export class AgentIntegrationProtocolError extends Error {
  code: string;
  details: Readonly<Record<string, unknown>>;
}

export const AGENT_INTEGRATION_SCHEMA_VERSION: "useful.agent-integration.v1";
export const AGENT_INTEGRATION_SCHEMA_FILE: "agent-integration.schema.json";
export const AGENT_INTEGRATION_SCHEMA_ID: "https://schemas.useful.example/agent/useful.agent-integration.v1.schema.json";
export const AGENT_INTEGRATION_TARGETS: readonly AgentIntegrationTarget[];
export const AGENT_INTEGRATION_SCOPES: readonly AgentIntegrationScope[];
export const AGENT_INTEGRATION_HOST_PLATFORMS: readonly AgentIntegrationHostPlatform[];

export function snapshotAgentIntegrationData<T>(value: T, field?: string): T;
export function deepFreezeAgentIntegrationData<T>(value: T): Readonly<T>;
export function parseAgentIntegrationPlan(document: unknown, options?: { hostPlatform?: AgentIntegrationHostPlatform }): Readonly<AgentIntegrationPlan>;
export function renderAgentIntegrationOutput(document: unknown, options: { hostPlatform: AgentIntegrationHostPlatform }): Readonly<AgentIntegrationOutput>;
