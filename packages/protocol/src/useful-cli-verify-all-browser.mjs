export const USEFUL_CLI_VERIFY_ALL_MAX_CODE_UNITS = 1024 * 1024;
export const USEFUL_CLI_VERIFY_ALL_MAX_UTF8_BYTES = 1024 * 1024;
export const USEFUL_CLI_VERIFY_ALL_MAX_DEPTH = 64;
export const USEFUL_CLI_VERIFY_ALL_MAX_NODES = 4096;

const TARGETS = Object.freeze(["codex", "claude-code", "claude-desktop", "mcp-servers-json"]);
const HOST_PLATFORMS = Object.freeze(["win32", "linux", "darwin"]);
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const SHA256 = /^[a-f0-9]{64}$/u;
const REVISION = /^[a-f0-9]{40,64}$/u;
const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

const SET_CLAIMS = Object.freeze({
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

const VERIFICATION_CLAIMS = Object.freeze({
  documentAuthenticated: false,
  connectionGeneratedInCurrentProcess: true,
  fixedUsefulLauncherMatchedInCurrentProcess: true,
  hostCommandExecutedByVerifier: false,
  hostConfigReadByVerifier: false,
  hostConfigWrittenByVerifier: false,
  externalAgentInstalledAttested: false,
  externalAgentConfiguredAttested: false,
});

const PROOF = Object.freeze({
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

const TOOL_CLOSURE = Object.freeze({
  count: 40,
  namesSha256: "2740f646530580de5ad2079f3290c01517e8b37f58c6d624293ae74e665c6f17",
  actionCount: 36,
  helperCount: 4,
});

export class UsefulCliVerifyAllBrowserError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "UsefulCliVerifyAllBrowserError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details = {}) {
  throw new UsefulCliVerifyAllBrowserError(code, message, details);
}

function utf8ByteLength(text) {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit <= 0x7f) bytes += 1;
    else if (unit <= 0x7ff) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
    if (bytes > USEFUL_CLI_VERIFY_ALL_MAX_UTF8_BYTES) return bytes;
  }
  return bytes;
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactRecord(value, expected, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_RECORD", `${field} must be an object`, { field });
  }
  const actual = Object.keys(value).sort(compare);
  const wanted = [...expected].sort(compare);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("UNKNOWN_FIELD", `${field} has an invalid field set`, { field });
  }
  return value;
}

function exactLiteral(value, expected, field) {
  if (value !== expected) fail("INVALID_VALUE", `${field} has an invalid value`, { field });
  return expected;
}

function assertDataBudget(value) {
  let nodes = 0;
  function visit(current, depth) {
    if (depth > USEFUL_CLI_VERIFY_ALL_MAX_DEPTH) {
      fail("MAX_DEPTH_EXCEEDED", "verify-all data exceeds the depth limit", {
        field: "document",
        maximumDepth: USEFUL_CLI_VERIFY_ALL_MAX_DEPTH,
        observedDepth: depth,
      });
    }
    nodes += 1;
    if (nodes > USEFUL_CLI_VERIFY_ALL_MAX_NODES) {
      fail("MAX_NODES_EXCEEDED", "verify-all data exceeds the node limit", {
        field: "document",
        maximumNodes: USEFUL_CLI_VERIFY_ALL_MAX_NODES,
        observedNodes: nodes,
      });
    }
    if (!current || typeof current !== "object") return;
    if (Array.isArray(current)) {
      for (const child of current) visit(child, depth + 1);
      return;
    }
    for (const key of Object.keys(current)) {
      if (UNSAFE_KEYS.has(key)) {
        fail("PROTOTYPE_POLLUTION_FORBIDDEN", "verify-all data contains a dangerous key", { field: "document" });
      }
      visit(current[key], depth + 1);
    }
  }
  visit(value, 1);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort(compare).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertPath(value, field, hostPlatform) {
  if (typeof value !== "string" || value.length < 2 || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("INVALID_PATH", `${field} must be a bounded absolute local path`, { field });
  }
  if (/^(?:\\\\|\/\/)/u.test(value)) fail("UNC_PATH_FORBIDDEN", `${field} cannot be a UNC path`, { field });
  const windows = /^[A-Za-z]:[\\/](?![\\/])/u.test(value);
  const posix = /^\/(?!\/)/u.test(value);
  if (!windows && !posix) fail("RELATIVE_PATH_FORBIDDEN", `${field} must be absolute`, { field });
  if ((hostPlatform === "win32" && !windows) || (hostPlatform !== "win32" && !posix)) {
    fail("HOST_PATH_MISMATCH", `${field} does not match hostPlatform`, { field });
  }
  return value;
}

function parsePlan(value, hostPlatform, expectedTarget, prefix) {
  exactRecord(value, ["schemaVersion", "target", "transport", "scope", "server"], `${prefix}.plan`);
  exactLiteral(value.schemaVersion, "useful.agent-integration.v1", `${prefix}.plan.schemaVersion`);
  exactLiteral(value.target, expectedTarget, `${prefix}.plan.target`);
  exactLiteral(value.transport, "stdio", `${prefix}.plan.transport`);
  exactLiteral(value.scope, "user", `${prefix}.plan.scope`);
  exactRecord(value.server, ["name", "nodePath", "launcherPath", "args", "env"], `${prefix}.plan.server`);
  exactLiteral(value.server.name, "useful", `${prefix}.plan.server.name`);
  if (!Array.isArray(value.server.args) || value.server.args.length !== 0) {
    fail("INVALID_PLAN", `${prefix}.plan.server.args must be empty`, { field: `${prefix}.plan.server.args` });
  }
  exactRecord(value.server.env, [], `${prefix}.plan.server.env`);
  return {
    schemaVersion: "useful.agent-integration.v1",
    scope: "user",
    server: {
      args: [],
      env: {},
      launcherPath: assertPath(value.server.launcherPath, `${prefix}.plan.server.launcherPath`, hostPlatform),
      name: "useful",
      nodePath: assertPath(value.server.nodePath, `${prefix}.plan.server.nodePath`, hostPlatform),
    },
    target: expectedTarget,
    transport: "stdio",
  };
}

function powerShellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function renderOutput(plan) {
  if (plan.target === "claude-desktop" || plan.target === "mcp-servers-json") {
    return {
      format: "json",
      kind: "merge-fragment",
      mergeFragment: { mcpServers: { useful: { args: [plan.server.launcherPath], command: plan.server.nodePath } } },
      writesHostConfigWhenExecuted: false,
    };
  }
  const argv = plan.target === "codex"
    ? ["codex", "mcp", "add", "useful", "--", plan.server.nodePath, plan.server.launcherPath]
    : ["claude", "mcp", "add", "--transport", "stdio", "--scope", "user", "useful", "--", plan.server.nodePath, plan.server.launcherPath];
  return {
    commandArgv: argv,
    kind: "host-command",
    powershellCommand: `& ${argv.map(powerShellLiteral).join(" ")}`,
    writesHostConfigWhenExecuted: true,
  };
}

function parseConnection(value, expectedTarget, prefix) {
  exactRecord(value, ["schemaVersion", "kind", "writePolicy", "secretPolicy", "hostPlatform", "plan", "output"], `${prefix}.connection`);
  exactLiteral(value.schemaVersion, "useful.agent-connection.v1", `${prefix}.connection.schemaVersion`);
  exactLiteral(value.kind, "mcp-stdio-connection", `${prefix}.connection.kind`);
  exactLiteral(value.writePolicy, "manual-review-only", `${prefix}.connection.writePolicy`);
  exactLiteral(value.secretPolicy, "no-secrets", `${prefix}.connection.secretPolicy`);
  if (!HOST_PLATFORMS.includes(value.hostPlatform)) {
    fail("INVALID_HOST_PLATFORM", `${prefix}.connection.hostPlatform is invalid`, { field: `${prefix}.connection.hostPlatform` });
  }
  const plan = parsePlan(value.plan, value.hostPlatform, expectedTarget, `${prefix}.connection`);
  const output = renderOutput(plan);
  if (canonicalJson(value.output) !== canonicalJson(output)) {
    fail("OUTPUT_PLAN_MISMATCH", `${prefix}.connection.output does not match the canonical rendering`, { field: `${prefix}.connection.output` });
  }
  return {
    schemaVersion: "useful.agent-connection.v1",
    kind: "mcp-stdio-connection",
    writePolicy: "manual-review-only",
    secretPolicy: "no-secrets",
    hostPlatform: value.hostPlatform,
    plan,
    output,
  };
}

function parseProbe(value, prefix) {
  exactRecord(value, ["schemaVersion", "status", "proofScope", "installation", "server", "tools", "proof", "process"], `${prefix}.probe`);
  exactLiteral(value.schemaVersion, "useful.agent-probe.v1", `${prefix}.probe.schemaVersion`);
  exactLiteral(value.status, "success", `${prefix}.probe.status`);
  exactLiteral(value.proofScope, "useful-mcp-local-stdio", `${prefix}.probe.proofScope`);

  exactRecord(value.installation, ["mode", "artifactVerified", "sourceRevision", "version"], `${prefix}.probe.installation`);
  if (value.installation.mode !== "source" && value.installation.mode !== "agent-kit") {
    fail("INVALID_INSTALLATION_MODE", `${prefix}.probe.installation.mode is invalid`, { field: `${prefix}.probe.installation.mode` });
  }
  if (value.installation.artifactVerified !== (value.installation.mode === "agent-kit")) {
    fail("INSTALLATION_PROOF_MISMATCH", `${prefix}.probe.installation proof does not match its mode`, { field: `${prefix}.probe.installation.artifactVerified` });
  }
  if (typeof value.installation.sourceRevision !== "string" || !REVISION.test(value.installation.sourceRevision)) {
    fail("INVALID_SOURCE_REVISION", `${prefix}.probe.installation.sourceRevision is invalid`, { field: `${prefix}.probe.installation.sourceRevision` });
  }
  if (typeof value.installation.version !== "string" || value.installation.version.length > 128 || !SEMVER.test(value.installation.version)) {
    fail("INVALID_VERSION", `${prefix}.probe.installation.version is invalid`, { field: `${prefix}.probe.installation.version` });
  }
  const installation = {
    artifactVerified: value.installation.artifactVerified,
    mode: value.installation.mode,
    sourceRevision: value.installation.sourceRevision,
    version: value.installation.version,
  };

  exactRecord(value.server, ["name", "version", "protocolVersion"], `${prefix}.probe.server`);
  exactLiteral(value.server.name, "useful-actions", `${prefix}.probe.server.name`);
  if (typeof value.server.version !== "string" || value.server.version.length > 128 || !SEMVER.test(value.server.version)) {
    fail("INVALID_VERSION", `${prefix}.probe.server.version is invalid`, { field: `${prefix}.probe.server.version` });
  }
  exactLiteral(value.server.protocolVersion, "2026-07-28", `${prefix}.probe.server.protocolVersion`);
  const server = { name: "useful-actions", protocolVersion: "2026-07-28", version: value.server.version };

  exactRecord(value.tools, Object.keys(TOOL_CLOSURE), `${prefix}.probe.tools`);
  for (const [field, expected] of Object.entries(TOOL_CLOSURE)) {
    if (value.tools[field] !== expected) {
      fail("PROBE_TOOL_CLOSURE_MISMATCH", `${prefix}.probe.tools does not match the fixed closure`, { field: `${prefix}.probe.tools.${field}` });
    }
  }
  const tools = { actionCount: 36, count: 40, helperCount: 4, namesSha256: TOOL_CLOSURE.namesSha256 };

  exactRecord(value.proof, Object.keys(PROOF), `${prefix}.probe.proof`);
  for (const [field, expected] of Object.entries(PROOF)) {
    exactLiteral(value.proof[field], expected, `${prefix}.probe.proof.${field}`);
  }
  const proof = { ...PROOF };

  exactRecord(value.process, ["stderrBytes", "stderrSha256", "transportClosed"], `${prefix}.probe.process`);
  if (!Number.isInteger(value.process.stderrBytes) || value.process.stderrBytes < 0 || value.process.stderrBytes > 65536) {
    fail("INVALID_INTEGER", `${prefix}.probe.process.stderrBytes is invalid`, { field: `${prefix}.probe.process.stderrBytes` });
  }
  if (typeof value.process.stderrSha256 !== "string" || !SHA256.test(value.process.stderrSha256)) {
    fail("INVALID_STDERR_HASH", `${prefix}.probe.process.stderrSha256 is invalid`, { field: `${prefix}.probe.process.stderrSha256` });
  }
  exactLiteral(value.process.transportClosed, true, `${prefix}.probe.process.transportClosed`);
  const processRecord = {
    stderrBytes: value.process.stderrBytes,
    stderrSha256: value.process.stderrSha256,
    transportClosed: true,
  };

  return {
    installation,
    process: processRecord,
    proof,
    proofScope: "useful-mcp-local-stdio",
    schemaVersion: "useful.agent-probe.v1",
    server,
    status: "success",
    tools,
  };
}

function parseClaims(value, expected, field) {
  exactRecord(value, Object.keys(expected), field);
  for (const [name, literal] of Object.entries(expected)) exactLiteral(value[name], literal, `${field}.${name}`);
  return { ...expected };
}

function parseEndpoint(value, connection, probe, prefix) {
  exactRecord(value, ["nodePath", "launcherPath", "installationMode", "sourceRevision", "productVersion"], `${prefix}.endpoint`);
  const expected = {
    nodePath: connection.plan.server.nodePath,
    launcherPath: connection.plan.server.launcherPath,
    installationMode: probe.installation.mode,
    sourceRevision: probe.installation.sourceRevision,
    productVersion: probe.installation.version,
  };
  for (const field of Object.keys(expected)) {
    if (value[field] !== expected[field]) {
      fail(field === "nodePath" || field === "launcherPath" ? "ENDPOINT_CONNECTION_MISMATCH" : "ENDPOINT_PROBE_MISMATCH", `${prefix}.endpoint is not bound to its inputs`, { field: `${prefix}.endpoint.${field}` });
    }
  }
  return expected;
}

function parseVerification(value, expectedTarget, index) {
  const prefix = `data.verifications[${index}]`;
  exactRecord(value, ["schemaVersion", "kind", "status", "claimScope", "connection", "probe", "endpoint", "claims"], prefix);
  exactLiteral(value.schemaVersion, "useful.agent-connection-verification.v1", `${prefix}.schemaVersion`);
  exactLiteral(value.kind, "mcp-stdio-connection-verification", `${prefix}.kind`);
  exactLiteral(value.status, "success", `${prefix}.status`);
  exactLiteral(value.claimScope, "useful-mcp-local-stdio-connection-candidate-self-reported", `${prefix}.claimScope`);
  const connection = parseConnection(value.connection, expectedTarget, prefix);
  const probe = parseProbe(value.probe, prefix);
  const endpoint = parseEndpoint(value.endpoint, connection, probe, prefix);
  const claims = parseClaims(value.claims, VERIFICATION_CLAIMS, `${prefix}.claims`);
  return {
    schemaVersion: "useful.agent-connection-verification.v1",
    kind: "mcp-stdio-connection-verification",
    status: "success",
    claimScope: "useful-mcp-local-stdio-connection-candidate-self-reported",
    connection,
    probe,
    endpoint,
    claims,
  };
}

function parseSet(value) {
  exactRecord(value, ["schemaVersion", "kind", "status", "claimScope", "claims", "verifications"], "data");
  exactLiteral(value.schemaVersion, "useful.agent-connection-verification-set.v1", "data.schemaVersion");
  exactLiteral(value.kind, "mcp-stdio-connection-verification-set", "data.kind");
  exactLiteral(value.status, "candidate-ready", "data.status");
  exactLiteral(value.claimScope, "useful-mcp-local-stdio-connection-candidates-self-reported", "data.claimScope");
  const claims = parseClaims(value.claims, SET_CLAIMS, "data.claims");
  if (!Array.isArray(value.verifications) || value.verifications.length !== TARGETS.length) {
    fail("VERIFICATION_COUNT_MISMATCH", "data.verifications must contain exactly four items", { field: "data.verifications" });
  }
  const verifications = value.verifications.map((item, index) => parseVerification(item, TARGETS[index], index));
  const endpoint = canonicalJson(verifications[0].endpoint);
  const probe = canonicalJson(verifications[0].probe);
  for (let index = 1; index < verifications.length; index += 1) {
    if (canonicalJson(verifications[index].endpoint) !== endpoint) {
      fail("VERIFICATION_ENDPOINT_MISMATCH", "all verification endpoints must be canonical-identical", { index });
    }
    if (canonicalJson(verifications[index].probe) !== probe) {
      fail("VERIFICATION_PROBE_MISMATCH", "all verification probes must be canonical-identical", { index });
    }
  }
  return {
    schemaVersion: "useful.agent-connection-verification-set.v1",
    kind: "mcp-stdio-connection-verification-set",
    status: "candidate-ready",
    claimScope: "useful-mcp-local-stdio-connection-candidates-self-reported",
    claims,
    verifications,
  };
}

/**
 * Parses an untrusted `useful agent verify-all --json` success document.
 * Validation proves only the closed portable document contract; it does not
 * authenticate that the CLI, probe, host command, or external Agent executed.
 */
export function parseUsefulCliVerifyAllJson(text) {
  if (typeof text !== "string") {
    fail("INVALID_INPUT_TYPE", "verify-all JSON input must be a string", { expected: "string" });
  }
  if (text.length > USEFUL_CLI_VERIFY_ALL_MAX_CODE_UNITS) {
    fail("INPUT_TOO_LARGE", "verify-all JSON input exceeds the code-unit limit", {
      limit: "codeUnits",
      maximum: USEFUL_CLI_VERIFY_ALL_MAX_CODE_UNITS,
      observed: text.length,
    });
  }
  const bytes = utf8ByteLength(text);
  if (bytes > USEFUL_CLI_VERIFY_ALL_MAX_UTF8_BYTES) {
    fail("INPUT_TOO_LARGE", "verify-all JSON input exceeds the UTF-8 byte limit", {
      limit: "utf8Bytes",
      maximum: USEFUL_CLI_VERIFY_ALL_MAX_UTF8_BYTES,
      observed: bytes,
    });
  }
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    fail("INVALID_JSON", "verify-all output is not valid JSON");
  }
  exactRecord(envelope, ["schemaVersion", "ok", "command", "data"], "envelope");
  exactLiteral(envelope.schemaVersion, "useful.cli.result.v1", "envelope.schemaVersion");
  exactLiteral(envelope.ok, true, "envelope.ok");
  exactLiteral(envelope.command, "agent verify-all", "envelope.command");
  assertDataBudget(envelope.data);
  return deepFreeze(parseSet(envelope.data));
}
