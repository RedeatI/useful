import type {
  AgentIntegrationPlan,
  AgentIntegrationScope,
  AgentIntegrationTarget,
} from "@useful/protocol/agent-integration";

export type { AgentIntegrationPlan, AgentIntegrationScope, AgentIntegrationTarget };

export interface AgentIntegrationInput {
  target: AgentIntegrationTarget;
  launcher: string;
  scope?: AgentIntegrationScope;
  environment?: Record<string, string>;
  nodePath?: string;
  projectDirectory?: string;
}

export interface HostCommandOutput {
  kind: "host-command";
  commandArgv: string[];
  powershellCommand: string;
  requiredWorkingDirectory?: string;
  writesHostConfigWhenExecuted: true;
}

export interface MergeFragmentOutput {
  kind: "merge-fragment";
  format: "json" | "toml";
  configPath?: string;
  mergeFragment: string | { mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> };
  writesHostConfigWhenExecuted: false;
}

export type AgentIntegrationOutput = HostCommandOutput | MergeFragmentOutput;

export interface AgentIntegrationPlanResult {
  schemaVersion: "useful.agent-integration.v1";
  plan: AgentIntegrationPlan;
  output: AgentIntegrationOutput;
}

export interface AgentIntegrationDoctorResult extends AgentIntegrationPlanResult {
  ok: boolean;
  checks: Array<{ id: string; status: "pass" | "fail"; message: string; details?: unknown }>;
}

export const AGENT_INTEGRATION_SCHEMA_VERSION: "useful.agent-integration.v1";
export const AGENT_INTEGRATION_TARGETS: readonly AgentIntegrationTarget[];
export const AGENT_INTEGRATION_SCOPES: readonly AgentIntegrationScope[];

export class AgentIntegrationError extends Error {
  code: string;
  details: Record<string, unknown>;
}

export function validateEnvironment(environment?: Record<string, string>): Record<string, string>;
export function parseEnvironmentAssignments(assignments?: string[]): Record<string, string>;
export function quotePowerShellLiteral(value: unknown): string;
export function toPowerShellInvocation(commandArgv: string[]): string;
export function buildAgentIntegrationPlan(input: AgentIntegrationInput): AgentIntegrationPlan;
export function renderAgentIntegration(plan: AgentIntegrationPlan): AgentIntegrationOutput;
export function doctorAgentIntegration(input: AgentIntegrationInput): AgentIntegrationDoctorResult;
export function planAgentIntegration(input: AgentIntegrationInput): AgentIntegrationPlanResult;
