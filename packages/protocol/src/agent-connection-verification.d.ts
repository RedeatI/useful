import type { AgentConnection } from "@useful/protocol/agent-connection";
import type { AgentProbe, AgentProbeInstallationMode } from "@useful/protocol/agent-probe";

export interface AgentConnectionVerificationEndpoint {
  readonly nodePath: string;
  readonly launcherPath: string;
  readonly installationMode: AgentProbeInstallationMode;
  readonly sourceRevision: string;
  readonly productVersion: string;
}

export interface AgentConnectionVerificationClaims {
  readonly documentAuthenticated: false;
  readonly connectionGeneratedInCurrentProcess: true;
  readonly fixedUsefulLauncherMatchedInCurrentProcess: true;
  readonly hostCommandExecutedByVerifier: false;
  readonly hostConfigReadByVerifier: false;
  readonly hostConfigWrittenByVerifier: false;
  readonly externalAgentInstalledAttested: false;
  readonly externalAgentConfiguredAttested: false;
}

export interface AgentConnectionVerification {
  readonly schemaVersion: "useful.agent-connection-verification.v1";
  readonly kind: "mcp-stdio-connection-verification";
  readonly status: "success";
  /** Self-reported by this portable document; it is not authenticated proof. */
  readonly claimScope: "useful-mcp-local-stdio-connection-candidate-self-reported";
  readonly connection: AgentConnection;
  readonly probe: AgentProbe;
  readonly endpoint: AgentConnectionVerificationEndpoint;
  readonly claims: AgentConnectionVerificationClaims;
}

export interface CreateAgentConnectionVerificationInput {
  readonly connection: AgentConnection;
  readonly probe: AgentProbe;
}

export class AgentConnectionVerificationError extends Error {
  code: string;
  details: Readonly<Record<string, unknown>>;
}

export const AGENT_CONNECTION_VERIFICATION_SCHEMA_VERSION: "useful.agent-connection-verification.v1";
export const AGENT_CONNECTION_VERIFICATION_SCHEMA_FILE: "agent-connection-verification.schema.json";
export const AGENT_CONNECTION_VERIFICATION_SCHEMA_ID: "https://schemas.useful.example/agent/useful.agent-connection-verification.v1.schema.json";
export const AGENT_CONNECTION_VERIFICATION_KIND: "mcp-stdio-connection-verification";
export const AGENT_CONNECTION_VERIFICATION_STATUS: "success";
export const AGENT_CONNECTION_VERIFICATION_CLAIM_SCOPE: "useful-mcp-local-stdio-connection-candidate-self-reported";
export const AGENT_CONNECTION_VERIFICATION_CLAIMS: Readonly<AgentConnectionVerificationClaims>;

export function createAgentConnectionVerification(input: CreateAgentConnectionVerificationInput): Readonly<AgentConnectionVerification>;
export function parseAgentConnectionVerification(document: unknown): Readonly<AgentConnectionVerification>;
export function validateAgentConnectionVerification(document: unknown): Readonly<AgentConnectionVerification>;
