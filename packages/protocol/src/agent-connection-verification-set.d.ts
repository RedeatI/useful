import type { AgentConnectionVerification } from "@useful/protocol/agent-connection-verification";

export type AgentConnectionVerificationSetTarget = "codex" | "claude-code" | "claude-desktop" | "mcp-servers-json";

/** A structurally empty string-keyed environment; any named key has type never. */
export type AgentConnectionVerificationSetEmptyEnvironment = Readonly<Record<string, never>>;

export type AgentConnectionVerificationSetSlot<Target extends AgentConnectionVerificationSetTarget> =
  Omit<AgentConnectionVerification, "connection"> & {
    readonly connection: Omit<AgentConnectionVerification["connection"], "plan"> & {
      readonly plan: Omit<AgentConnectionVerification["connection"]["plan"], "target" | "scope" | "projectDirectory" | "server"> & {
        readonly target: Target;
        readonly scope: "user";
        readonly projectDirectory?: never;
        readonly server: Omit<AgentConnectionVerification["connection"]["plan"]["server"], "env"> & {
          readonly env: AgentConnectionVerificationSetEmptyEnvironment;
        };
      };
    };
  };

export type AgentConnectionVerificationSetTuple = readonly [
  AgentConnectionVerificationSetSlot<"codex">,
  AgentConnectionVerificationSetSlot<"claude-code">,
  AgentConnectionVerificationSetSlot<"claude-desktop">,
  AgentConnectionVerificationSetSlot<"mcp-servers-json">,
];

export interface AgentConnectionVerificationSetClaims {
  readonly documentAuthenticated: false;
  readonly setGeneratedInCurrentProcess: true;
  readonly singleProbeUsedForAllCandidatesInCurrentProcess: true;
  readonly fixedUsefulLauncherMatchedInCurrentProcess: true;
  readonly hostCommandExecutedByVerifier: false;
  readonly hostConfigReadByVerifier: false;
  readonly hostConfigWrittenByVerifier: false;
  readonly externalAgentInstalledAttested: false;
  readonly externalAgentConfiguredAttested: false;
  readonly externalAgentConnectedAttested: false;
}

export interface AgentConnectionVerificationSet {
  readonly schemaVersion: "useful.agent-connection-verification-set.v1";
  readonly kind: "mcp-stdio-connection-verification-set";
  readonly status: "candidate-ready";
  /** Self-reported by this portable document; it is not authenticated proof. */
  readonly claimScope: "useful-mcp-local-stdio-connection-candidates-self-reported";
  readonly claims: AgentConnectionVerificationSetClaims;
  readonly verifications: AgentConnectionVerificationSetTuple;
}

export interface CreateAgentConnectionVerificationSetInput {
  readonly verifications: AgentConnectionVerificationSetTuple;
}

export class AgentConnectionVerificationSetError extends Error {
  code: string;
  details: Readonly<Record<string, unknown>>;
}

export const AGENT_CONNECTION_VERIFICATION_SET_SCHEMA_VERSION: "useful.agent-connection-verification-set.v1";
export const AGENT_CONNECTION_VERIFICATION_SET_SCHEMA_FILE: "agent-connection-verification-set.schema.json";
export const AGENT_CONNECTION_VERIFICATION_SET_SCHEMA_ID: "https://schemas.useful.example/agent/useful.agent-connection-verification-set.v1.schema.json";
export const AGENT_CONNECTION_VERIFICATION_SET_KIND: "mcp-stdio-connection-verification-set";
export const AGENT_CONNECTION_VERIFICATION_SET_STATUS: "candidate-ready";
export const AGENT_CONNECTION_VERIFICATION_SET_CLAIM_SCOPE: "useful-mcp-local-stdio-connection-candidates-self-reported";
export const AGENT_CONNECTION_VERIFICATION_SET_TARGETS: readonly ["codex", "claude-code", "claude-desktop", "mcp-servers-json"];
export const AGENT_CONNECTION_VERIFICATION_SET_CLAIMS: Readonly<AgentConnectionVerificationSetClaims>;

export function createAgentConnectionVerificationSet(input: CreateAgentConnectionVerificationSetInput): Readonly<AgentConnectionVerificationSet>;
export function parseAgentConnectionVerificationSet(document: unknown): Readonly<AgentConnectionVerificationSet>;
export function validateAgentConnectionVerificationSet(document: unknown): Readonly<AgentConnectionVerificationSet>;
