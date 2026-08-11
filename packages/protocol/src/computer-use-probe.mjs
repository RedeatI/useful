import {
  AGENT_PROBE_MAX_DEPTH,
  AGENT_PROBE_MAX_NODES,
  AgentProbeProtocolError,
  snapshotAgentProbeData,
} from "./agent-probe.mjs";

export const COMPUTER_USE_PROBE_SCHEMA_VERSION = "useful.computer-use-probe.v1";
export const COMPUTER_USE_PROBE_SCHEMA_FILE = "computer-use-probe.schema.json";
export const COMPUTER_USE_PROBE_SCHEMA_ID = "https://schemas.useful.example/agent/useful.computer-use-probe.v1.schema.json";
export const COMPUTER_USE_PROBE_CLAIM_SCOPE = "useful-computer-use-capability-local-self-reported";
export const COMPUTER_USE_PROBE_INSTALLATION_MODES = Object.freeze(["source", "agent-kit"]);
export const COMPUTER_USE_PROBE_MAX_DEPTH = AGENT_PROBE_MAX_DEPTH;
export const COMPUTER_USE_PROBE_MAX_NODES = AGENT_PROBE_MAX_NODES;

export const COMPUTER_USE_PROBE_ENVIRONMENTS = Object.freeze([
  "isolated-browser",
  "isolated-vm",
]);

export const COMPUTER_USE_PROBE_ACTION_TYPES = Object.freeze([
  "screenshot",
  "click",
  "double-click",
  "drag",
  "move",
  "scroll",
  "type",
  "key",
  "wait",
]);

export const COMPUTER_USE_PROBE_ACTION_TYPES_SHA256 = "a9bce07e51d533f830833d94ddc5fd53ae7f0b837da31edc8b68f64394a10cf7";

const COMPUTER_USE_SCHEMA = "useful.computer-use.v1";
const SOURCE_REVISION = /^[a-f0-9]{40,64}$/u;
const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

const FIXED_DEFAULT_POLICY = Object.freeze({
  environment: "isolated-browser",
  allowDomainsCount: 0,
  maxRedirects: 0,
  developmentMode: false,
  allowPrivateDomains: false,
});

const FIXED_CAPABILITIES = Object.freeze({
  cliProbeAvailable: true,
  cliExecutionAvailable: false,
  defaultProviderEnabled: false,
  executableBrowserProviderPresent: false,
  isolatedVmAdapterPresent: false,
  modelAdapterPresent: false,
  actionRegistered: false,
  mcpRegistered: false,
  guiRegistered: false,
  browserAdapterInterfacePresent: true,
});

const FIXED_CLAIMS = Object.freeze({
  documentAuthenticated: false,
  defaultControllerDisabledObserved: true,
  hostDesktopRejectedObserved: true,
  networkUsedByProbe: false,
  userInputPerformed: false,
  hostDesktopTouched: false,
  realBrowserAttested: false,
  networkEnforcementAttested: false,
});

export class ComputerUseProbeProtocolError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ComputerUseProbeProtocolError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details = {}) {
  throw new ComputerUseProbeProtocolError(code, message, details);
}

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function snapshot(value, field) {
  try {
    return snapshotAgentProbeData(value, field);
  } catch (error) {
    if (error instanceof AgentProbeProtocolError) {
      throw new ComputerUseProbeProtocolError(error.code, error.message, error.details);
    }
    throw error;
  }
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
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

function exactSequence(value, expected, field) {
  if (!Array.isArray(value)
    || value.length !== expected.length
    || value.some((item, index) => item !== expected[index])) {
    fail("INVALID_SEQUENCE", `${field} 必须匹配固定顺序`, { field });
  }
  return [...expected];
}

function parseInstallation(value) {
  exactRecord(value, ["mode", "artifactVerified", "sourceRevision", "version"], "installation");
  if (!COMPUTER_USE_PROBE_INSTALLATION_MODES.includes(value.mode)) {
    fail("INVALID_INSTALLATION_MODE", "installation.mode 无效", { mode: value.mode });
  }
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
    mode: value.mode,
    artifactVerified: value.artifactVerified,
    sourceRevision: value.sourceRevision,
    version: value.version,
  };
}

function parseDefaultPolicy(value) {
  exactRecord(value, Object.keys(FIXED_DEFAULT_POLICY), "contract.defaultPolicy");
  for (const [key, expected] of Object.entries(FIXED_DEFAULT_POLICY)) {
    exactLiteral(value[key], expected, `contract.defaultPolicy.${key}`);
  }
  return { ...FIXED_DEFAULT_POLICY };
}

function parseContract(value) {
  exactRecord(value, ["schemaVersion", "environments", "actionTypes", "actionTypesSha256", "defaultPolicy"], "contract");
  exactLiteral(value.schemaVersion, COMPUTER_USE_SCHEMA, "contract.schemaVersion");
  exactLiteral(value.actionTypesSha256, COMPUTER_USE_PROBE_ACTION_TYPES_SHA256, "contract.actionTypesSha256");
  return {
    schemaVersion: COMPUTER_USE_SCHEMA,
    environments: exactSequence(value.environments, COMPUTER_USE_PROBE_ENVIRONMENTS, "contract.environments"),
    actionTypes: exactSequence(value.actionTypes, COMPUTER_USE_PROBE_ACTION_TYPES, "contract.actionTypes"),
    actionTypesSha256: COMPUTER_USE_PROBE_ACTION_TYPES_SHA256,
    defaultPolicy: parseDefaultPolicy(value.defaultPolicy),
  };
}

function parseFixedRecord(value, expected, field) {
  exactRecord(value, Object.keys(expected), field);
  for (const [key, expectedValue] of Object.entries(expected)) {
    exactLiteral(value[key], expectedValue, `${field}.${key}`);
  }
  return { ...expected };
}

function parseInternal(document) {
  const probe = snapshot(document, "computerUseProbe");
  exactRecord(
    probe,
    ["schemaVersion", "status", "claimScope", "installation", "contract", "capabilities", "claims"],
    "computerUseProbe",
  );
  exactLiteral(probe.schemaVersion, COMPUTER_USE_PROBE_SCHEMA_VERSION, "computerUseProbe.schemaVersion");
  exactLiteral(probe.status, "success", "computerUseProbe.status");
  exactLiteral(probe.claimScope, COMPUTER_USE_PROBE_CLAIM_SCOPE, "computerUseProbe.claimScope");
  return deepFreeze({
    schemaVersion: COMPUTER_USE_PROBE_SCHEMA_VERSION,
    status: "success",
    claimScope: COMPUTER_USE_PROBE_CLAIM_SCOPE,
    installation: parseInstallation(probe.installation),
    contract: parseContract(probe.contract),
    capabilities: parseFixedRecord(probe.capabilities, FIXED_CAPABILITIES, "capabilities"),
    claims: parseFixedRecord(probe.claims, FIXED_CLAIMS, "claims"),
  });
}

export function parseComputerUseProbe(document) {
  return parseInternal(document);
}

export function validateComputerUseProbe(document) {
  return parseComputerUseProbe(document);
}

/** Builds the fixed local, self-reported capability record for an installation. */
export function createComputerUseProbe(input) {
  const captured = snapshot(input, "createComputerUseProbe.input");
  exactRecord(captured, ["installation"], "createComputerUseProbe.input");
  return parseInternal({
    schemaVersion: COMPUTER_USE_PROBE_SCHEMA_VERSION,
    status: "success",
    claimScope: COMPUTER_USE_PROBE_CLAIM_SCOPE,
    installation: captured.installation,
    contract: {
      schemaVersion: COMPUTER_USE_SCHEMA,
      environments: [...COMPUTER_USE_PROBE_ENVIRONMENTS],
      actionTypes: [...COMPUTER_USE_PROBE_ACTION_TYPES],
      actionTypesSha256: COMPUTER_USE_PROBE_ACTION_TYPES_SHA256,
      defaultPolicy: { ...FIXED_DEFAULT_POLICY },
    },
    capabilities: { ...FIXED_CAPABILITIES },
    claims: { ...FIXED_CLAIMS },
  });
}
