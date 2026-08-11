import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";
import {
  AGENT_PROBE_MAX_DEPTH,
  AGENT_PROBE_MAX_NODES,
  AGENT_PROBE_SCHEMA_VERSION,
  AgentProbeProtocolError,
  createAgentProbe,
  parseAgentProbe,
  snapshotAgentProbeData,
  validateAgentProbe,
} from "../src/agent-probe.mjs";
import { parseAgentIntegrationPlan } from "../src/agent-integration.mjs";
import { buildAjv, getValidator } from "../src/schemas.mjs";

const SHA256 = "a".repeat(64);
const REVISION = "b".repeat(40);

function makeProbe(overrides = {}) {
  return {
    installation: {
      mode: "source",
      artifactVerified: false,
      sourceRevision: REVISION,
      version: "0.1.0-beta.3",
    },
    server: {
      name: "useful-actions",
      version: "0.1.0",
      protocolVersion: "2026-07-28",
    },
    tools: {
      count: 40,
      namesSha256: SHA256,
      actionCount: 36,
      helperCount: 4,
    },
    proof: {
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
    },
    process: {
      stderrBytes: 19,
      stderrSha256: SHA256,
      transportClosed: true,
    },
    ...overrides,
  };
}

function makeNestedValue(depth) {
  let value = null;
  for (let level = 1; level < depth; level += 1) value = { next: value };
  return value;
}

test("exports fixed snapshot resource budgets", () => {
  assert.equal(AGENT_PROBE_MAX_DEPTH, 64);
  assert.equal(AGENT_PROBE_MAX_NODES, 4096);
});

test("creates a deep-frozen closed local-MCP success proof", () => {
  const probe = createAgentProbe(makeProbe());
  assert.equal(probe.schemaVersion, AGENT_PROBE_SCHEMA_VERSION);
  assert.equal(probe.status, "success");
  assert.equal(probe.proofScope, "useful-mcp-local-stdio");
  assert.equal(probe.proof.externalAgentInstalled, false);
  assert.equal(probe.proof.hostConfigWrittenByProbe, false);
  assert.equal(probe.proof.launcherNetworkAttested, false);
  assert.equal(Object.isFrozen(probe), true);
  assert.equal(Object.isFrozen(probe.proof), true);
  assert.equal(Object.isFrozen(probe.process), true);
  assert.equal("processTreeReaped" in probe.process, false);
});

test("schema validates the success shape while parser binds semantic invariants", () => {
  const probe = createAgentProbe(makeProbe());
  const validate = getValidator(buildAjv(), "agent-probe.schema.json");
  assert.equal(validate(probe), true, JSON.stringify(validate.errors));
  assert.deepEqual(parseAgentProbe(probe), probe);

  const countMismatch = structuredClone(probe);
  countMismatch.tools.count = 39;
  assert.equal(validate(countMismatch), true, JSON.stringify(validate.errors));
  assert.throws(() => parseAgentProbe(countMismatch), (error) => error instanceof AgentProbeProtocolError && error.code === "TOOL_COUNT_MISMATCH");

  const componentVersion = structuredClone(probe);
  componentVersion.server.version = "0.2.0";
  assert.equal(validate(componentVersion), true, JSON.stringify(validate.errors));
  assert.equal(parseAgentProbe(componentVersion).server.version, "0.2.0");

  const protocolMismatch = structuredClone(probe);
  protocolMismatch.server.protocolVersion = "2025-03-26";
  assert.equal(validate(protocolMismatch), false, JSON.stringify(validate.errors));
  assert.throws(() => parseAgentProbe(protocolMismatch), (error) => error instanceof AgentProbeProtocolError && error.code === "INVALID_VALUE");

  const serverNameMismatch = structuredClone(probe);
  serverNameMismatch.server.name = "other-valid-ascii-name";
  assert.equal(validate(serverNameMismatch), false, JSON.stringify(validate.errors));
  assert.throws(() => parseAgentProbe(serverNameMismatch), (error) => error instanceof AgentProbeProtocolError && error.code === "INVALID_SERVER_NAME");
});

test("parser rejects claims outside the local stdio proof boundary", () => {
  const probe = createAgentProbe(makeProbe());
  const cases = [
    { ...probe, unexpected: true },
    { ...probe, proof: { ...probe.proof, codexConfigured: true } },
    { ...probe, proof: { ...probe.proof, launcherNetworkAttested: true } },
    { ...probe, process: { ...probe.process, transportClosed: false } },
    { ...probe, process: { ...probe.process, stderrBytes: 65537 } },
    { ...probe, installation: { ...probe.installation, artifactVerified: true } },
  ];
  for (const forged of cases) assert.throws(() => parseAgentProbe(forged), AgentProbeProtocolError);
});

test("plain-data capture rejects proxy, accessors, hidden fields, symbols and cycles", () => {
  const valid = createAgentProbe(makeProbe());
  assert.throws(() => parseAgentProbe(new Proxy(structuredClone(valid), {})), (error) => error.code === "PROXY_FORBIDDEN");
  const accessor = structuredClone(valid);
  Object.defineProperty(accessor, "hostile", { enumerable: true, get() { throw new Error("must not run"); } });
  assert.throws(() => parseAgentProbe(accessor), (error) => error.code === "ACCESSOR_PROPERTY_FORBIDDEN");
  const hidden = structuredClone(valid);
  Object.defineProperty(hidden, "hostile", { enumerable: false, value: true });
  assert.throws(() => parseAgentProbe(hidden), (error) => error.code === "ACCESSOR_PROPERTY_FORBIDDEN");
  const symbol = structuredClone(valid);
  symbol[Symbol("hidden")] = true;
  assert.throws(() => parseAgentProbe(symbol), (error) => error.code === "SYMBOL_PROPERTY_FORBIDDEN");
  const cyclic = structuredClone(valid);
  cyclic.proof.loop = cyclic;
  assert.throws(() => parseAgentProbe(cyclic), (error) => error.code === "CYCLIC_INPUT_FORBIDDEN");
});

test("snapshot counts the root at depth one and parse rejects excessive depth", () => {
  assert.equal(typeof snapshotAgentProbeData(makeNestedValue(AGENT_PROBE_MAX_DEPTH)), "object");
  assert.throws(
    () => parseAgentProbe(makeNestedValue(AGENT_PROBE_MAX_DEPTH + 1)),
    (error) => error instanceof AgentProbeProtocolError
      && error.code === "MAX_DEPTH_EXCEEDED"
      && error.details.maximumDepth === AGENT_PROBE_MAX_DEPTH
      && error.details.observedDepth === AGENT_PROBE_MAX_DEPTH + 1,
  );
});

test("snapshot counts the root as one node and validate rejects excessive nodes", () => {
  const atLimit = Array.from({ length: AGENT_PROBE_MAX_NODES - 1 }, () => null);
  assert.equal(snapshotAgentProbeData(atLimit).length, AGENT_PROBE_MAX_NODES - 1);
  const overLimit = Array.from({ length: AGENT_PROBE_MAX_NODES }, () => null);
  assert.throws(
    () => validateAgentProbe(overLimit),
    (error) => error instanceof AgentProbeProtocolError
      && error.code === "MAX_NODES_EXCEEDED"
      && error.details.maximumNodes === AGENT_PROBE_MAX_NODES
      && error.details.observedNodes === AGENT_PROBE_MAX_NODES + 1,
  );
});

function platformPath() {
  return process.platform === "win32" ? "C:\\Useful\\useful-mcp.mjs" : "/opt/useful/useful-mcp.mjs";
}

function profilePlan(profile) {
  return {
    schemaVersion: "useful.agent-integration.v1",
    target: "mcp-servers-json",
    transport: "stdio",
    scope: "user",
    server: {
      name: "useful",
      nodePath: platformPath(),
      launcherPath: platformPath(),
      args: [],
      env: { USEFUL_PROFILE: profile },
    },
  };
}

test("USEFUL_PROFILE accepts ASCII case and rejects Unicode lookalikes", () => {
  for (const value of ["Useful", "A_B.C-9", "Z".repeat(64)]) {
    assert.equal(parseAgentIntegrationPlan(profilePlan(value), { hostPlatform: process.platform }).server.env.USEFUL_PROFILE, value);
  }
  for (const value of ["\u212A", "\u017F", "\u4E2D\u6587", "\uFF21profile", "A".repeat(65)]) {
    assert.throws(() => parseAgentIntegrationPlan(profilePlan(value), { hostPlatform: process.platform }), (error) => error.code === "INVALID_ENVIRONMENT");
  }
});
