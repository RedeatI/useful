import { types as utilTypes } from "node:util";

export const AGENT_PROBE_SCHEMA_VERSION = "useful.agent-probe.v1";
export const AGENT_PROBE_SCHEMA_FILE = "agent-probe.schema.json";
export const AGENT_PROBE_SCHEMA_ID = "https://schemas.useful.example/agent/useful.agent-probe.v1.schema.json";
export const AGENT_PROBE_SCOPE = "useful-mcp-local-stdio";
export const AGENT_PROBE_INSTALLATION_MODES = Object.freeze(["source", "agent-kit"]);
/** The snapshot root has depth 1; every property value or array item adds 1. */
export const AGENT_PROBE_MAX_DEPTH = 64;
/** The snapshot root counts as 1 node, as does every visited JSON value. */
export const AGENT_PROBE_MAX_NODES = 4096;

const UNSAFE_KEY = new Set(["__proto__", "prototype", "constructor"]);
const SHA256 = /^[a-f0-9]{64}$/u;
const SOURCE_REVISION = /^[a-f0-9]{40,64}$/u;
const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const SERVER_NAME = "useful-actions";
const PROTOCOL_VERSION = "2026-07-28";
const SUCCESS_PROOF = Object.freeze({
  handshake: true,
  list: true,
  search: true,
  describe: true,
  safeCall: true,
  transportClosed: true,
  externalAgentInstalled: false,
  codexConfigured: false,
  claudeConfigured: false,
  hostConfigWrittenByProbe: false,
  launcherNetworkAttested: false,
});

export class AgentProbeProtocolError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "AgentProbeProtocolError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details = {}) {
  throw new AgentProbeProtocolError(code, message, details);
}

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Captures ordinary JSON data without evaluating user-defined accessors. */
export function snapshotAgentProbeData(value, field = "input") {
  const ancestors = new Set();
  let nodeCount = 0;

  function assertChildCapacity(childCount, currentField) {
    const minimumNodeCount = nodeCount + childCount;
    if (minimumNodeCount > AGENT_PROBE_MAX_NODES) {
      fail("MAX_NODES_EXCEEDED", `${currentField} 超过最大节点数`, {
        field: currentField,
        maximumNodes: AGENT_PROBE_MAX_NODES,
        observedNodes: minimumNodeCount,
      });
    }
  }

  function visit(current, currentField, depth) {
    if (depth > AGENT_PROBE_MAX_DEPTH) {
      fail("MAX_DEPTH_EXCEEDED", `${currentField} 超过最大深度`, {
        field: currentField,
        maximumDepth: AGENT_PROBE_MAX_DEPTH,
        observedDepth: depth,
      });
    }
    nodeCount += 1;
    if (nodeCount > AGENT_PROBE_MAX_NODES) {
      fail("MAX_NODES_EXCEEDED", `${currentField} 超过最大节点数`, {
        field: currentField,
        maximumNodes: AGENT_PROBE_MAX_NODES,
        observedNodes: nodeCount,
      });
    }
    if (current === null || typeof current === "string" || typeof current === "boolean") return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) fail("UNSUPPORTED_VALUE", `${currentField} 只接受有限数字`, { field: currentField });
      return current;
    }
    if (typeof current !== "object") fail("UNSUPPORTED_VALUE", `${currentField} 只接受普通 JSON 数据`, { field: currentField });
    if (utilTypes.isProxy(current)) fail("PROXY_FORBIDDEN", `${currentField} 不接受 Proxy`, { field: currentField });
    if (ancestors.has(current)) fail("CYCLIC_INPUT_FORBIDDEN", `${currentField} 不接受循环引用`, { field: currentField });
    ancestors.add(current);
    try {
      const isArray = Array.isArray(current);
      const prototype = Object.getPrototypeOf(current);
      if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
        fail("NON_PLAIN_DATA_FORBIDDEN", `${currentField} 必须是普通对象或数组`, { field: currentField });
      }
      if (Object.getOwnPropertySymbols(current).length > 0) fail("SYMBOL_PROPERTY_FORBIDDEN", `${currentField} 不允许 symbol 字段`, { field: currentField });
      const descriptors = Object.getOwnPropertyDescriptors(current);
      if (isArray) {
        const keys = Object.keys(descriptors).filter((key) => key !== "length");
        if (keys.length !== current.length || keys.some((key, index) => key !== String(index))) {
          fail("INVALID_ARRAY", `${currentField} 必须是无额外字段的稠密数组`, { field: currentField });
        }
        assertChildCapacity(keys.length, currentField);
        return keys.map((key, index) => {
          const descriptor = descriptors[key];
          if (!descriptor.enumerable || !("value" in descriptor)) {
            fail("ACCESSOR_PROPERTY_FORBIDDEN", `${currentField} 只允许可枚举数据项`, { field: currentField, key });
          }
          return visit(descriptor.value, `${currentField}[${index}]`, depth + 1);
        });
      }
      const output = {};
      const keys = Object.keys(descriptors);
      assertChildCapacity(keys.length, currentField);
      for (const key of keys.sort(compareCodePoints)) {
        if (UNSAFE_KEY.has(key)) fail("PROTOTYPE_POLLUTION_FORBIDDEN", `${currentField} 包含不安全字段`, { field: currentField, key });
        const descriptor = descriptors[key];
        if (!descriptor.enumerable || !("value" in descriptor)) {
          fail("ACCESSOR_PROPERTY_FORBIDDEN", `${currentField} 只允许可枚举数据字段`, { field: currentField, key });
        }
        output[key] = visit(descriptor.value, `${currentField}.${key}`, depth + 1);
      }
      return output;
    } finally {
      ancestors.delete(current);
    }
  }

  return visit(value, field, 1);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

export function deepFreezeAgentProbeData(value) {
  return deepFreeze(snapshotAgentProbeData(value, "freeze.input"));
}

function exactRecord(value, expected, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_RECORD", `${field} 必须是普通对象`, { field });
  const actual = Object.keys(value).sort(compareCodePoints);
  const wanted = [...expected].sort(compareCodePoints);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("UNKNOWN_FIELD", `${field} 字段集合无效`, { field, keys: actual });
  }
}

function boundedInteger(value, field, maximum) {
  if (!Number.isInteger(value) || value < 0 || value > maximum) fail("INVALID_INTEGER", `${field} 必须是范围内的整数`, { field });
  return value;
}

function exactLiteral(value, expected, field) {
  if (value !== expected) fail("INVALID_VALUE", `${field} 无效`, { field });
  return expected;
}

function parseInstallation(value) {
  exactRecord(value, ["mode", "artifactVerified", "sourceRevision", "version"], "installation");
  if (!AGENT_PROBE_INSTALLATION_MODES.includes(value.mode)) fail("INVALID_INSTALLATION_MODE", "installation.mode 无效", { mode: value.mode });
  if (value.artifactVerified !== (value.mode === "agent-kit")) {
    fail("INSTALLATION_PROOF_MISMATCH", "artifactVerified 必须匹配 installation.mode", { mode: value.mode });
  }
  if (typeof value.sourceRevision !== "string" || !SOURCE_REVISION.test(value.sourceRevision)) {
    fail("INVALID_SOURCE_REVISION", "installation.sourceRevision 必须是小写 Git revision", { field: "installation.sourceRevision" });
  }
  if (typeof value.version !== "string" || value.version.length > 128 || !SEMVER.test(value.version)) {
    fail("INVALID_VERSION", "installation.version 必须是 SemVer", { field: "installation.version" });
  }
  return {
    artifactVerified: value.artifactVerified,
    mode: value.mode,
    sourceRevision: value.sourceRevision,
    version: value.version,
  };
}

function parseServer(value) {
  exactRecord(value, ["name", "version", "protocolVersion"], "server");
  if (value.name !== SERVER_NAME) fail("INVALID_SERVER_NAME", "server.name 必须是 useful-actions", { field: "server.name" });
  if (typeof value.version !== "string" || value.version.length > 128 || !SEMVER.test(value.version)) fail("INVALID_VERSION", "server.version 必须是 SemVer", { field: "server.version" });
  exactLiteral(value.protocolVersion, PROTOCOL_VERSION, "server.protocolVersion");
  return { name: value.name, protocolVersion: value.protocolVersion, version: value.version };
}

function parseTools(value) {
  exactRecord(value, ["count", "namesSha256", "actionCount", "helperCount"], "tools");
  const count = boundedInteger(value.count, "tools.count", 1000);
  const actionCount = boundedInteger(value.actionCount, "tools.actionCount", 1000);
  const helperCount = boundedInteger(value.helperCount, "tools.helperCount", 1000);
  if (count !== actionCount + helperCount) fail("TOOL_COUNT_MISMATCH", "tools.count 必须等于 actionCount + helperCount");
  if (typeof value.namesSha256 !== "string" || !SHA256.test(value.namesSha256)) {
    fail("INVALID_TOOL_NAMES_HASH", "tools.namesSha256 必须是小写 SHA-256", { field: "tools.namesSha256" });
  }
  return { actionCount, count, helperCount, namesSha256: value.namesSha256 };
}

function parseProof(value) {
  exactRecord(value, Object.keys(SUCCESS_PROOF), "proof");
  for (const [key, expected] of Object.entries(SUCCESS_PROOF)) exactLiteral(value[key], expected, `proof.${key}`);
  return { ...SUCCESS_PROOF };
}

function parseProcess(value) {
  exactRecord(value, ["stderrBytes", "stderrSha256", "transportClosed"], "process");
  const stderrBytes = boundedInteger(value.stderrBytes, "process.stderrBytes", 65536);
  if (typeof value.stderrSha256 !== "string" || !SHA256.test(value.stderrSha256)) {
    fail("INVALID_STDERR_HASH", "process.stderrSha256 必须是小写 SHA-256", { field: "process.stderrSha256" });
  }
  exactLiteral(value.transportClosed, true, "process.transportClosed");
  return { stderrBytes, stderrSha256: value.stderrSha256, transportClosed: true };
}

function parseInternal(document) {
  const probe = snapshotAgentProbeData(document, "probe");
  exactRecord(probe, ["schemaVersion", "status", "proofScope", "installation", "server", "tools", "proof", "process"], "probe");
  exactLiteral(probe.schemaVersion, AGENT_PROBE_SCHEMA_VERSION, "probe.schemaVersion");
  exactLiteral(probe.status, "success", "probe.status");
  exactLiteral(probe.proofScope, AGENT_PROBE_SCOPE, "probe.proofScope");
  const installation = parseInstallation(probe.installation);
  const proof = parseProof(probe.proof);
  const process = parseProcess(probe.process);
  if (proof.transportClosed !== process.transportClosed) fail("TRANSPORT_CLOSE_MISMATCH", "proof 与 process 的 transportClosed 必须一致");
  return deepFreeze({
    installation,
    process,
    proof,
    proofScope: AGENT_PROBE_SCOPE,
    schemaVersion: AGENT_PROBE_SCHEMA_VERSION,
    server: parseServer(probe.server),
    status: "success",
    tools: parseTools(probe.tools),
  });
}

export function parseAgentProbe(document) {
  return parseInternal(document);
}

export function validateAgentProbe(document) {
  return parseAgentProbe(document);
}

/** Builds a canonical success record; the caller must supply actual local observations. */
export function createAgentProbe(input) {
  const captured = snapshotAgentProbeData(input, "createAgentProbe.input");
  exactRecord(captured, ["installation", "server", "tools", "proof", "process"], "createAgentProbe.input");
  return parseInternal({
    installation: captured.installation,
    process: captured.process,
    proof: captured.proof,
    proofScope: AGENT_PROBE_SCOPE,
    schemaVersion: AGENT_PROBE_SCHEMA_VERSION,
    server: captured.server,
    status: "success",
    tools: captured.tools,
  });
}
