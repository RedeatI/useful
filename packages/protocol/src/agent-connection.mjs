import process from "node:process";
import {
  AGENT_INTEGRATION_HOST_PLATFORMS,
  AGENT_INTEGRATION_TARGETS,
  AgentIntegrationProtocolError,
  deepFreezeAgentIntegrationData,
  parseAgentIntegrationPlan,
  renderAgentIntegrationOutput,
  snapshotAgentIntegrationData,
} from "./agent-integration.mjs";

export const AGENT_CONNECTION_SCHEMA_VERSION = "useful.agent-connection.v1";
export const AGENT_CONNECTION_SCHEMA_FILE = "agent-connection.schema.json";
export const AGENT_CONNECTION_KIND = "mcp-stdio-connection";
export const AGENT_CONNECTION_WRITE_POLICY = "manual-review-only";
export const AGENT_CONNECTION_SECRET_POLICY = "no-secrets";
export const AGENT_CONNECTION_TARGETS = AGENT_INTEGRATION_TARGETS;
export const AGENT_CONNECTION_HOST_PLATFORMS = AGENT_INTEGRATION_HOST_PLATFORMS;

export class AgentConnectionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "AgentConnectionError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details = {}) {
  throw new AgentConnectionError(code, message, details);
}

function asConnectionError(error) {
  if (error instanceof AgentConnectionError) return error;
  if (error instanceof AgentIntegrationProtocolError) {
    return new AgentConnectionError(error.code, error.message, error.details);
  }
  return error;
}

function exactKeys(value, expected, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_RECORD", `${field} 必须是普通对象`, { field });
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("UNKNOWN_FIELD", `${field} 字段集合无效`, { field, keys: actual });
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseInternal(input) {
  const document = snapshotAgentIntegrationData(input, "connection");
  exactKeys(document, ["schemaVersion", "kind", "writePolicy", "secretPolicy", "hostPlatform", "plan", "output"], "connection");
  if (document.schemaVersion !== AGENT_CONNECTION_SCHEMA_VERSION) fail("INVALID_SCHEMA_VERSION", "schemaVersion 无效");
  if (document.kind !== AGENT_CONNECTION_KIND) fail("INVALID_CONNECTION_KIND", "kind 无效");
  if (document.writePolicy !== AGENT_CONNECTION_WRITE_POLICY) fail("INVALID_WRITE_POLICY", "writePolicy 无效");
  if (document.secretPolicy !== AGENT_CONNECTION_SECRET_POLICY) fail("INVALID_SECRET_POLICY", "secretPolicy 无效");
  if (!AGENT_CONNECTION_HOST_PLATFORMS.includes(document.hostPlatform)) {
    fail("INVALID_HOST_PLATFORM", "hostPlatform 必须是 win32、linux 或 darwin", { hostPlatform: document.hostPlatform });
  }
  const plan = parseAgentIntegrationPlan(document.plan, { hostPlatform: document.hostPlatform });
  const output = renderAgentIntegrationOutput(plan, { hostPlatform: document.hostPlatform });
  if (canonicalJson(document.output) !== canonicalJson(output)) {
    fail("OUTPUT_PLAN_MISMATCH", "output 必须逐字匹配 plan 与 hostPlatform 的唯一规范渲染结果");
  }
  return deepFreezeAgentIntegrationData({
    schemaVersion: AGENT_CONNECTION_SCHEMA_VERSION,
    kind: AGENT_CONNECTION_KIND,
    writePolicy: AGENT_CONNECTION_WRITE_POLICY,
    secretPolicy: AGENT_CONNECTION_SECRET_POLICY,
    hostPlatform: document.hostPlatform,
    plan,
    output,
  });
}

export function parseAgentConnection(document) {
  try {
    return parseInternal(document);
  } catch (error) {
    throw asConnectionError(error);
  }
}

export function validateAgentConnection(document) {
  return parseAgentConnection(document);
}

/**
 * Creates a host-native, nonportable review document from a plan only. Output
 * is always rendered internally and cannot be supplied by the caller.
 */
export function createAgentConnection(input = {}) {
  try {
    const captured = snapshotAgentIntegrationData(input, "createAgentConnection.input");
    exactKeys(captured, ["plan"], "createAgentConnection.input");
    const hostPlatform = process.platform;
    if (!AGENT_CONNECTION_HOST_PLATFORMS.includes(hostPlatform)) {
      fail("HOST_PLATFORM_NOT_SUPPORTED", "当前主机平台不支持 Agent 连接导出", { hostPlatform });
    }
    const plan = parseAgentIntegrationPlan(captured.plan, { hostPlatform });
    const output = renderAgentIntegrationOutput(plan, { hostPlatform });
    return parseInternal({
      schemaVersion: AGENT_CONNECTION_SCHEMA_VERSION,
      kind: AGENT_CONNECTION_KIND,
      writePolicy: AGENT_CONNECTION_WRITE_POLICY,
      secretPolicy: AGENT_CONNECTION_SECRET_POLICY,
      hostPlatform,
      plan,
      output,
    });
  } catch (error) {
    throw asConnectionError(error);
  }
}
