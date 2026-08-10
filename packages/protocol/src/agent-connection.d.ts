import type {
  AgentIntegrationHostPlatform,
  AgentIntegrationOutput,
  AgentIntegrationPlan,
  AgentIntegrationTarget,
} from "@useful/protocol/agent-integration";

export type AgentConnectionTarget = AgentIntegrationTarget;
export type AgentConnectionHostPlatform = AgentIntegrationHostPlatform;
export type AgentConnectionOutput = AgentIntegrationOutput;

export interface AgentConnection {
  readonly schemaVersion: "useful.agent-connection.v1";
  readonly kind: "mcp-stdio-connection";
  readonly writePolicy: "manual-review-only";
  readonly secretPolicy: "no-secrets";
  readonly hostPlatform: AgentConnectionHostPlatform;
  readonly plan: AgentIntegrationPlan;
  readonly output: AgentConnectionOutput;
}

export class AgentConnectionError extends Error {
  code: string;
  details: Readonly<Record<string, unknown>>;
}

export const AGENT_CONNECTION_SCHEMA_VERSION: "useful.agent-connection.v1";
export const AGENT_CONNECTION_SCHEMA_FILE: "agent-connection.schema.json";
export const AGENT_CONNECTION_KIND: "mcp-stdio-connection";
export const AGENT_CONNECTION_WRITE_POLICY: "manual-review-only";
export const AGENT_CONNECTION_SECRET_POLICY: "no-secrets";
export const AGENT_CONNECTION_TARGETS: readonly AgentConnectionTarget[];
export const AGENT_CONNECTION_HOST_PLATFORMS: readonly AgentConnectionHostPlatform[];

export function parseAgentConnection(document: unknown): Readonly<AgentConnection>;
export function validateAgentConnection(document: unknown): Readonly<AgentConnection>;
export function createAgentConnection(input: { plan: AgentIntegrationPlan }): Readonly<AgentConnection>;
