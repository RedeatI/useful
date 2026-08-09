export type AgentIntegrationTarget = "codex" | "claude-code" | "claude-desktop" | "mcp-servers-json";
export type AgentIntegrationScope = "user" | "project";

export interface AgentIntegrationServer {
  name: "useful";
  nodePath: string;
  launcherPath: string;
  args: [];
  env: Partial<{
    NO_COLOR: "1";
    USEFUL_LOG_LEVEL: "error" | "warn" | "info";
    USEFUL_PROFILE: string;
  }>;
}

export interface AgentIntegrationPlan {
  schemaVersion: "useful.agent-integration.v1";
  target: AgentIntegrationTarget;
  transport: "stdio";
  scope: AgentIntegrationScope;
  projectDirectory?: string;
  server: AgentIntegrationServer;
}

export const AGENT_INTEGRATION_SCHEMA_VERSION: "useful.agent-integration.v1";
export const AGENT_INTEGRATION_SCHEMA_FILE: "agent-integration.schema.json";
export const AGENT_INTEGRATION_TARGETS: readonly AgentIntegrationTarget[];
export const AGENT_INTEGRATION_SCOPES: readonly AgentIntegrationScope[];
