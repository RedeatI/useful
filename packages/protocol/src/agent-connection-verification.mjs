import {
  AgentConnectionError,
  parseAgentConnection,
} from "./agent-connection.mjs";
import {
  AgentProbeProtocolError,
  parseAgentProbe,
  snapshotAgentProbeData,
} from "./agent-probe.mjs";

export const AGENT_CONNECTION_VERIFICATION_SCHEMA_VERSION = "useful.agent-connection-verification.v1";
export const AGENT_CONNECTION_VERIFICATION_SCHEMA_FILE = "agent-connection-verification.schema.json";
export const AGENT_CONNECTION_VERIFICATION_SCHEMA_ID = "https://schemas.useful.example/agent/useful.agent-connection-verification.v1.schema.json";
export const AGENT_CONNECTION_VERIFICATION_KIND = "mcp-stdio-connection-verification";
export const AGENT_CONNECTION_VERIFICATION_STATUS = "success";
export const AGENT_CONNECTION_VERIFICATION_CLAIM_SCOPE = "useful-mcp-local-stdio-connection-candidate-self-reported";
export const AGENT_CONNECTION_VERIFICATION_CLAIMS = Object.freeze({
  documentAuthenticated: false,
  connectionGeneratedInCurrentProcess: true,
  fixedUsefulLauncherMatchedInCurrentProcess: true,
  hostCommandExecutedByVerifier: false,
  hostConfigReadByVerifier: false,
  hostConfigWrittenByVerifier: false,
  externalAgentInstalledAttested: false,
  externalAgentConfiguredAttested: false,
});

const EXPECTED_PROBE_TOOL_CLOSURE = Object.freeze({
  count: 40,
  actionCount: 36,
  helperCount: 4,
  namesSha256: "2740f646530580de5ad2079f3290c01517e8b37f58c6d624293ae74e665c6f17",
});

export class AgentConnectionVerificationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "AgentConnectionVerificationError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details = {}) {
  throw new AgentConnectionVerificationError(code, message, details);
}

function asVerificationError(error) {
  if (error instanceof AgentConnectionVerificationError) return error;
  if (error instanceof AgentConnectionError || error instanceof AgentProbeProtocolError) {
    return new AgentConnectionVerificationError(error.code, error.message, error.details);
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
  return expected;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

function deriveEndpoint(connection, probe) {
  return {
    nodePath: connection.plan.server.nodePath,
    launcherPath: connection.plan.server.launcherPath,
    installationMode: probe.installation.mode,
    sourceRevision: probe.installation.sourceRevision,
    productVersion: probe.installation.version,
  };
}

function firstProbeToolClosureMismatch(probe) {
  const tools = probe && typeof probe === "object" && !Array.isArray(probe)
    ? probe.tools
    : undefined;
  if (!tools || typeof tools !== "object" || Array.isArray(tools)) return undefined;
  return Object.entries(EXPECTED_PROBE_TOOL_CLOSURE)
    .find(([field, expected]) => tools[field] !== expected);
}

function assertProbeToolClosure(probe) {
  const mismatch = firstProbeToolClosureMismatch(probe);
  if (!mismatch) return probe;
  const [field, expected] = mismatch;
  fail("PROBE_TOOL_CLOSURE_MISMATCH", `probe.tools.${field} 不匹配 Useful 默认工具闭集`, {
    field: `probe.tools.${field}`,
    expected,
    actual: probe.tools[field],
  });
}

function parseBoundProbe(value) {
  let probe;
  try {
    probe = parseAgentProbe(value);
  } catch (error) {
    const mismatch = firstProbeToolClosureMismatch(value);
    if (mismatch) assertProbeToolClosure(value);
    throw error;
  }
  return assertProbeToolClosure(probe);
}

function parseEndpoint(value, expected) {
  exactRecord(value, ["nodePath", "launcherPath", "installationMode", "sourceRevision", "productVersion"], "endpoint");
  for (const field of ["nodePath", "launcherPath"]) {
    if (value[field] !== expected[field]) {
      fail("ENDPOINT_CONNECTION_MISMATCH", `endpoint.${field} 必须逐字匹配 connection.plan.server.${field}`, { field: `endpoint.${field}` });
    }
  }
  for (const field of ["installationMode", "sourceRevision", "productVersion"]) {
    if (value[field] !== expected[field]) {
      fail("ENDPOINT_PROBE_MISMATCH", `endpoint.${field} 必须逐字匹配 probe.installation`, { field: `endpoint.${field}` });
    }
  }
  return { ...expected };
}

function parseClaims(value) {
  exactRecord(value, Object.keys(AGENT_CONNECTION_VERIFICATION_CLAIMS), "claims");
  for (const [field, expected] of Object.entries(AGENT_CONNECTION_VERIFICATION_CLAIMS)) {
    if (value[field] !== expected) fail("INVALID_CLAIM", `claims.${field} 无效`, { field: `claims.${field}` });
  }
  return { ...AGENT_CONNECTION_VERIFICATION_CLAIMS };
}

function parseInternal(document) {
  const captured = snapshotAgentProbeData(document, "verification");
  exactRecord(
    captured,
    ["schemaVersion", "kind", "status", "claimScope", "connection", "probe", "endpoint", "claims"],
    "verification",
  );
  exactLiteral(captured.schemaVersion, AGENT_CONNECTION_VERIFICATION_SCHEMA_VERSION, "verification.schemaVersion");
  exactLiteral(captured.kind, AGENT_CONNECTION_VERIFICATION_KIND, "verification.kind");
  exactLiteral(captured.status, AGENT_CONNECTION_VERIFICATION_STATUS, "verification.status");
  exactLiteral(captured.claimScope, AGENT_CONNECTION_VERIFICATION_CLAIM_SCOPE, "verification.claimScope");

  const connection = parseAgentConnection(captured.connection);
  const probe = parseBoundProbe(captured.probe);
  const endpoint = parseEndpoint(captured.endpoint, deriveEndpoint(connection, probe));
  const claims = parseClaims(captured.claims);

  return deepFreeze({
    schemaVersion: AGENT_CONNECTION_VERIFICATION_SCHEMA_VERSION,
    kind: AGENT_CONNECTION_VERIFICATION_KIND,
    status: AGENT_CONNECTION_VERIFICATION_STATUS,
    claimScope: AGENT_CONNECTION_VERIFICATION_CLAIM_SCOPE,
    connection,
    probe,
    endpoint,
    claims,
  });
}

export function parseAgentConnectionVerification(document) {
  try {
    return parseInternal(document);
  } catch (error) {
    throw asVerificationError(error);
  }
}

export function validateAgentConnectionVerification(document) {
  return parseAgentConnectionVerification(document);
}

/**
 * Constructs a self-reported binding between a connection candidate and a
 * local stdio probe result. It does not authenticate execution, and the caller
 * cannot supply endpoint or claim overrides.
 */
export function createAgentConnectionVerification(input = {}) {
  try {
    const captured = snapshotAgentProbeData(input, "createAgentConnectionVerification.input");
    exactRecord(captured, ["connection", "probe"], "createAgentConnectionVerification.input");
    const connection = parseAgentConnection(captured.connection);
    const probe = parseBoundProbe(captured.probe);
    return parseInternal({
      schemaVersion: AGENT_CONNECTION_VERIFICATION_SCHEMA_VERSION,
      kind: AGENT_CONNECTION_VERIFICATION_KIND,
      status: AGENT_CONNECTION_VERIFICATION_STATUS,
      claimScope: AGENT_CONNECTION_VERIFICATION_CLAIM_SCOPE,
      connection,
      probe,
      endpoint: deriveEndpoint(connection, probe),
      claims: AGENT_CONNECTION_VERIFICATION_CLAIMS,
    });
  } catch (error) {
    throw asVerificationError(error);
  }
}
