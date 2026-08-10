import type {
  AgentIntegrationEnvironment,
  AgentIntegrationOutput,
  AgentIntegrationPlan,
  AgentIntegrationScope,
  AgentIntegrationTarget,
} from "@useful/protocol/agent-integration";
import type { AgentConnection } from "@useful/protocol/agent-connection";

export type { AgentIntegrationPlan, AgentIntegrationScope, AgentIntegrationTarget };

export interface AgentIntegrationInput {
  target: AgentIntegrationTarget;
  launcher: string;
  scope?: AgentIntegrationScope;
  environment?: Record<string, string>;
  nodePath?: string;
  projectDirectory?: string;
}

export type { AgentIntegrationEnvironment, AgentIntegrationOutput };

/** @deprecated Prefer AgentIntegrationOutput narrowed by kind. */
export type HostCommandOutput = Extract<AgentIntegrationOutput, { kind: "host-command" }>;

/** @deprecated Prefer AgentIntegrationOutput narrowed by kind. */
export type MergeFragmentOutput = Extract<AgentIntegrationOutput, { kind: "merge-fragment" }>;

export interface AgentIntegrationPlanResult {
  schemaVersion: "useful.agent-integration.v1";
  readonly plan: AgentIntegrationPlan;
  readonly output: AgentIntegrationOutput;
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
  details: Readonly<Record<string, unknown>>;
}

export function validateEnvironment(environment?: Record<string, string>): AgentIntegrationEnvironment;
export function parseEnvironmentAssignments(assignments?: string[]): AgentIntegrationEnvironment;
export function quotePowerShellLiteral(value: string): string;
export function toPowerShellInvocation(commandArgv: string[]): string;
export function buildAgentIntegrationPlan(input: AgentIntegrationInput): AgentIntegrationPlan;
export function renderAgentIntegration(plan: AgentIntegrationPlan): AgentIntegrationOutput;
export function doctorAgentIntegration(input: AgentIntegrationInput): AgentIntegrationDoctorResult;
export function planAgentIntegration(input: AgentIntegrationInput): AgentIntegrationPlanResult;
export function exportAgentIntegration(input: AgentIntegrationInput): AgentConnection;
