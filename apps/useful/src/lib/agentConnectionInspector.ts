import {
  USEFUL_CLI_VERIFY_ALL_MAX_UTF8_BYTES,
  parseUsefulCliVerifyAllJson,
} from "@useful/protocol/useful-cli-verify-all-browser";

export const AGENT_CONNECTION_JSON_BUDGET = USEFUL_CLI_VERIFY_ALL_MAX_UTF8_BYTES;

export const AGENT_CONNECTION_TARGETS = [
  "codex",
  "claude-code",
  "claude-desktop",
  "mcp-servers-json",
] as const;

export type AgentConnectionTarget = typeof AGENT_CONNECTION_TARGETS[number];

interface ConnectionOutput {
  readonly kind: "host-command" | "merge-fragment";
  readonly format?: "json" | "toml";
  readonly powershellCommand?: string;
  readonly mergeFragment?: unknown;
}

interface VerificationView {
  readonly connection: {
    readonly plan: {
      readonly target: AgentConnectionTarget;
      readonly scope: "user";
      readonly server: {
        readonly nodePath: string;
        readonly launcherPath: string;
        readonly env: Readonly<Record<string, never>>;
      };
    };
    readonly output: ConnectionOutput;
  };
}

export interface VerificationSetView {
  readonly status: "candidate-ready";
  readonly claimScope: string;
  readonly claims: {
    readonly documentAuthenticated: false;
    readonly externalAgentInstalledAttested: false;
    readonly externalAgentConfiguredAttested: false;
    readonly externalAgentConnectedAttested: false;
  };
  readonly verifications: readonly VerificationView[];
}

export function inspectAgentConnectionJson(text: string): VerificationSetView {
  return parseUsefulCliVerifyAllJson(text);
}

export function normalizedVerificationSetJson(value: VerificationSetView): string {
  return JSON.stringify(value, null, 2);
}

export function connectionOutputText(output: ConnectionOutput): string {
  if (output.kind === "host-command") return output.powershellCommand ?? JSON.stringify(output, null, 2);
  if (output.format === "toml" && typeof output.mergeFragment === "string") return output.mergeFragment;
  return JSON.stringify(output.mergeFragment, null, 2) ?? "";
}
