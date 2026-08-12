import type { AgentConnectionVerificationSet } from "@useful/protocol/agent-connection-verification-set";

export const USEFUL_CLI_VERIFY_ALL_MAX_CODE_UNITS: 1048576;
export const USEFUL_CLI_VERIFY_ALL_MAX_UTF8_BYTES: 1048576;
export const USEFUL_CLI_VERIFY_ALL_MAX_DEPTH: 64;
export const USEFUL_CLI_VERIFY_ALL_MAX_NODES: 4096;

export class UsefulCliVerifyAllBrowserError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;
}

/**
 * Parses a bounded, untrusted `useful agent verify-all --json` success result.
 * The returned document is normalized and deeply frozen, but is not
 * authenticated proof that any command or external Agent executed.
 */
export function parseUsefulCliVerifyAllJson(text: string): Readonly<AgentConnectionVerificationSet>;
