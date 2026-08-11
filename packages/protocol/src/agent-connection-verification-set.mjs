import {
  AgentConnectionVerificationError,
  parseAgentConnectionVerification,
} from "./agent-connection-verification.mjs";
import {
  AgentProbeProtocolError,
  snapshotAgentProbeData,
} from "./agent-probe.mjs";

export const AGENT_CONNECTION_VERIFICATION_SET_SCHEMA_VERSION = "useful.agent-connection-verification-set.v1";
export const AGENT_CONNECTION_VERIFICATION_SET_SCHEMA_FILE = "agent-connection-verification-set.schema.json";
export const AGENT_CONNECTION_VERIFICATION_SET_SCHEMA_ID = "https://schemas.useful.example/agent/useful.agent-connection-verification-set.v1.schema.json";
export const AGENT_CONNECTION_VERIFICATION_SET_KIND = "mcp-stdio-connection-verification-set";
export const AGENT_CONNECTION_VERIFICATION_SET_STATUS = "candidate-ready";
export const AGENT_CONNECTION_VERIFICATION_SET_CLAIM_SCOPE = "useful-mcp-local-stdio-connection-candidates-self-reported";
export const AGENT_CONNECTION_VERIFICATION_SET_TARGETS = Object.freeze([
  "codex",
  "claude-code",
  "claude-desktop",
  "mcp-servers-json",
]);
export const AGENT_CONNECTION_VERIFICATION_SET_CLAIMS = Object.freeze({
  documentAuthenticated: false,
  setGeneratedInCurrentProcess: true,
  singleProbeUsedForAllCandidatesInCurrentProcess: true,
  fixedUsefulLauncherMatchedInCurrentProcess: true,
  hostCommandExecutedByVerifier: false,
  hostConfigReadByVerifier: false,
  hostConfigWrittenByVerifier: false,
  externalAgentInstalledAttested: false,
  externalAgentConfiguredAttested: false,
  externalAgentConnectedAttested: false,
});

export class AgentConnectionVerificationSetError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "AgentConnectionVerificationSetError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details = {}) {
  throw new AgentConnectionVerificationSetError(code, message, details);
}

function asSetError(error) {
  if (error instanceof AgentConnectionVerificationSetError) return error;
  if (error instanceof AgentConnectionVerificationError || error instanceof AgentProbeProtocolError) {
    return new AgentConnectionVerificationSetError(error.code, error.message, error.details);
  }
  return error;
}

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactRecord(value, expected, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_RECORD", `${field} 必须是普通对象`, { field });
  }
  const actual = Object.keys(value).sort(compareCodePoints);
  const wanted = [...expected].sort(compareCodePoints);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("UNKNOWN_FIELD", `${field} 字段集合无效`, { field, keys: actual });
  }
}

function exactLiteral(value, expected, field) {
  if (value !== expected) fail("INVALID_VALUE", `${field} 无效`, { field });
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort(compareCodePoints).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

function parseClaims(value) {
  exactRecord(value, Object.keys(AGENT_CONNECTION_VERIFICATION_SET_CLAIMS), "claims");
  for (const [field, expected] of Object.entries(AGENT_CONNECTION_VERIFICATION_SET_CLAIMS)) {
    if (value[field] !== expected) fail("INVALID_CLAIM", `claims.${field} 无效`, { field: `claims.${field}` });
  }
  return { ...AGENT_CONNECTION_VERIFICATION_SET_CLAIMS };
}

function parseVerifications(value) {
  if (!Array.isArray(value)) fail("INVALID_VERIFICATIONS", "verifications 必须是数组", { field: "verifications" });
  if (value.length !== AGENT_CONNECTION_VERIFICATION_SET_TARGETS.length) {
    fail("VERIFICATION_COUNT_MISMATCH", "verifications 必须恰好包含四个目标", { count: value.length });
  }
  const verifications = value.map((verification, index) => parseAgentConnectionVerification(verification));
  for (let index = 0; index < AGENT_CONNECTION_VERIFICATION_SET_TARGETS.length; index += 1) {
    const expected = AGENT_CONNECTION_VERIFICATION_SET_TARGETS[index];
    const plan = verifications[index].connection.plan;
    const actual = plan.target;
    if (actual !== expected) {
      fail("VERIFICATION_TARGET_ORDER_MISMATCH", `verifications[${index}] 必须是 ${expected}`, {
        index,
        expected,
        actual,
      });
    }
    if (plan.scope !== "user") {
      fail("VERIFICATION_SCOPE_MISMATCH", `verifications[${index}].connection.plan.scope 必须是 user`, {
        index,
        actual: plan.scope,
      });
    }
    if (Object.keys(plan.server.env).length !== 0) {
      fail("VERIFICATION_ENVIRONMENT_NOT_EMPTY", `verifications[${index}].connection.plan.server.env 必须为空`, {
        index,
        keys: Object.keys(plan.server.env).sort(compareCodePoints),
      });
    }
  }

  const [reference, ...remaining] = verifications;
  const referenceEndpoint = canonicalJson(reference.endpoint);
  const referenceProbe = canonicalJson(reference.probe);
  for (let index = 0; index < remaining.length; index += 1) {
    const verification = remaining[index];
    const verificationIndex = index + 1;
    if (canonicalJson(verification.endpoint) !== referenceEndpoint) {
      fail("VERIFICATION_ENDPOINT_MISMATCH", "所有 verification.endpoint 必须完全一致", { index: verificationIndex });
    }
    if (canonicalJson(verification.probe) !== referenceProbe) {
      fail("VERIFICATION_PROBE_MISMATCH", "所有 verification.probe 必须完全一致", { index: verificationIndex });
    }
  }
  return verifications;
}

function parseInternal(document) {
  const captured = snapshotAgentProbeData(document, "verificationSet");
  exactRecord(captured, ["schemaVersion", "kind", "status", "claimScope", "claims", "verifications"], "verificationSet");
  exactLiteral(captured.schemaVersion, AGENT_CONNECTION_VERIFICATION_SET_SCHEMA_VERSION, "verificationSet.schemaVersion");
  exactLiteral(captured.kind, AGENT_CONNECTION_VERIFICATION_SET_KIND, "verificationSet.kind");
  exactLiteral(captured.status, AGENT_CONNECTION_VERIFICATION_SET_STATUS, "verificationSet.status");
  exactLiteral(captured.claimScope, AGENT_CONNECTION_VERIFICATION_SET_CLAIM_SCOPE, "verificationSet.claimScope");
  const claims = parseClaims(captured.claims);
  const verifications = parseVerifications(captured.verifications);
  return deepFreeze({
    schemaVersion: AGENT_CONNECTION_VERIFICATION_SET_SCHEMA_VERSION,
    kind: AGENT_CONNECTION_VERIFICATION_SET_KIND,
    status: AGENT_CONNECTION_VERIFICATION_SET_STATUS,
    claimScope: AGENT_CONNECTION_VERIFICATION_SET_CLAIM_SCOPE,
    claims,
    verifications,
  });
}

export function parseAgentConnectionVerificationSet(document) {
  try {
    return parseInternal(document);
  } catch (error) {
    throw asSetError(error);
  }
}

export function validateAgentConnectionVerificationSet(document) {
  return parseAgentConnectionVerificationSet(document);
}

/**
 * Constructs a self-reported set of four connection candidates bound to one
 * canonical local probe. It neither runs host commands nor authenticates any
 * external Agent state, and callers cannot override its claims.
 */
export function createAgentConnectionVerificationSet(input = {}) {
  try {
    const captured = snapshotAgentProbeData(input, "createAgentConnectionVerificationSet.input");
    exactRecord(captured, ["verifications"], "createAgentConnectionVerificationSet.input");
    return parseInternal({
      schemaVersion: AGENT_CONNECTION_VERIFICATION_SET_SCHEMA_VERSION,
      kind: AGENT_CONNECTION_VERIFICATION_SET_KIND,
      status: AGENT_CONNECTION_VERIFICATION_SET_STATUS,
      claimScope: AGENT_CONNECTION_VERIFICATION_SET_CLAIM_SCOPE,
      claims: AGENT_CONNECTION_VERIFICATION_SET_CLAIMS,
      verifications: captured.verifications,
    });
  } catch (error) {
    throw asSetError(error);
  }
}
