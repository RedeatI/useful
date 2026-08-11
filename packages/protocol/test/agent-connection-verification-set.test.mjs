import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";
import {
  AGENT_CONNECTION_VERIFICATION_SET_CLAIMS,
  AGENT_CONNECTION_VERIFICATION_SET_CLAIM_SCOPE,
  AGENT_CONNECTION_VERIFICATION_SET_KIND,
  AGENT_CONNECTION_VERIFICATION_SET_SCHEMA_VERSION,
  AGENT_CONNECTION_VERIFICATION_SET_TARGETS,
  AgentConnectionVerificationSetError,
  createAgentConnectionVerificationSet,
  parseAgentConnectionVerificationSet,
  validateAgentConnectionVerificationSet,
} from "../src/agent-connection-verification-set.mjs";
import { createAgentConnectionVerification } from "../src/agent-connection-verification.mjs";
import { createAgentConnection } from "../src/agent-connection.mjs";
import { createAgentProbe } from "../src/agent-probe.mjs";
import { buildAjv, getValidator } from "../src/schemas.mjs";

const WINDOWS = process.platform === "win32";
const NODE_PATH = WINDOWS ? "C:\\Program Files\\nodejs\\node.exe" : "/usr/local/bin/node";
const LAUNCHER_PATH = WINDOWS ? "C:\\Useful\\lib\\useful-mcp.mjs" : "/opt/useful/lib/useful-mcp.mjs";
const OTHER_NODE_PATH = WINDOWS ? "C:\\Other\\node.exe" : "/other/node";
const PROJECT_DIRECTORY = WINDOWS ? "C:\\Useful\\project" : "/opt/useful/project";
const REVISION = "b".repeat(40);
const SHA256 = "a".repeat(64);
const TOOL_NAMES_SHA256 = "2740f646530580de5ad2079f3290c01517e8b37f58c6d624293ae74e665c6f17";

function makeConnection(target, { nodePath = NODE_PATH, scope = "user", env = {} } = {}) {
  return createAgentConnection({
    plan: {
      schemaVersion: "useful.agent-integration.v1",
      target,
      transport: "stdio",
      scope,
      ...(scope === "project" ? { projectDirectory: PROJECT_DIRECTORY } : {}),
      server: {
        name: "useful",
        nodePath,
        launcherPath: LAUNCHER_PATH,
        args: [],
        env,
      },
    },
  });
}

function makeProbe({ stderrBytes = 0 } = {}) {
  return createAgentProbe({
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
      namesSha256: TOOL_NAMES_SHA256,
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
      stderrBytes,
      stderrSha256: SHA256,
      transportClosed: true,
    },
  });
}

function makeVerifications(probe = makeProbe()) {
  return AGENT_CONNECTION_VERIFICATION_SET_TARGETS.map((target) => createAgentConnectionVerification({
    connection: makeConnection(target),
    probe,
  }));
}

function makeSet() {
  return createAgentConnectionVerificationSet({ verifications: makeVerifications() });
}

test("creates the closed, ordered and deeply frozen four-target candidate set", () => {
  const set = makeSet();
  assert.equal(set.schemaVersion, AGENT_CONNECTION_VERIFICATION_SET_SCHEMA_VERSION);
  assert.equal(set.kind, AGENT_CONNECTION_VERIFICATION_SET_KIND);
  assert.equal(set.status, "candidate-ready");
  assert.equal(set.claimScope, AGENT_CONNECTION_VERIFICATION_SET_CLAIM_SCOPE);
  assert.deepEqual(set.claims, AGENT_CONNECTION_VERIFICATION_SET_CLAIMS);
  assert.deepEqual(set.verifications.map((item) => item.connection.plan.target), AGENT_CONNECTION_VERIFICATION_SET_TARGETS);
  assert.deepEqual(set.verifications.map((item) => item.connection.plan.scope), ["user", "user", "user", "user"]);
  assert.deepEqual(set.verifications.map((item) => item.connection.plan.server.env), [{}, {}, {}, {}]);
  assert.equal(new Set(set.verifications.map((item) => JSON.stringify(item.probe))).size, 1);
  for (const value of [set, set.claims, set.verifications, ...set.verifications]) {
    assert.equal(Object.isFrozen(value), true);
  }
  assert.throws(
    () => createAgentConnectionVerificationSet({ verifications: set.verifications, claims: set.claims }),
    (error) => error instanceof AgentConnectionVerificationSetError && error.code === "UNKNOWN_FIELD",
  );
});

test("Schema resolves the real verification $id and parser closes cross-item semantics", () => {
  const set = makeSet();
  const validate = getValidator(buildAjv(), "agent-connection-verification-set.schema.json");
  assert.equal(validate(set), true, JSON.stringify(validate.errors));
  assert.deepEqual(parseAgentConnectionVerificationSet(set), set);
  assert.deepEqual(validateAgentConnectionVerificationSet(set), set);
});

test("Schema and parser reject project scope for Codex and Claude Code slots", () => {
  const set = makeSet();
  const validate = getValidator(buildAjv(), "agent-connection-verification-set.schema.json");
  for (const [index, target] of [[0, "codex"], [1, "claude-code"]]) {
    const forged = structuredClone(set);
    forged.verifications[index] = createAgentConnectionVerification({
      connection: makeConnection(target, { scope: "project" }),
      probe: set.verifications[index].probe,
    });
    assert.equal(validate(forged), false, `${target} project scope must fail Schema validation`);
    assert.throws(
      () => parseAgentConnectionVerificationSet(forged),
      (error) => error instanceof AgentConnectionVerificationSetError && error.code === "VERIFICATION_SCOPE_MISMATCH",
    );
  }
});

test("Schema and parser reject every allowed environment key in all four slots", () => {
  const set = makeSet();
  const validate = getValidator(buildAjv(), "agent-connection-verification-set.schema.json");
  const environmentCases = [
    ["NO_COLOR", "1"],
    ["USEFUL_LOG_LEVEL", "info"],
    ["USEFUL_PROFILE", "profile"],
  ];
  for (let index = 0; index < AGENT_CONNECTION_VERIFICATION_SET_TARGETS.length; index += 1) {
    const target = AGENT_CONNECTION_VERIFICATION_SET_TARGETS[index];
    for (const [key, value] of environmentCases) {
      const forged = structuredClone(set);
      forged.verifications[index] = createAgentConnectionVerification({
        connection: makeConnection(target, { env: { [key]: value } }),
        probe: set.verifications[index].probe,
      });
      assert.equal(validate(forged), false, `${target} ${key} must fail Schema validation`);
      assert.throws(
        () => parseAgentConnectionVerificationSet(forged),
        (error) => error instanceof AgentConnectionVerificationSetError && error.code === "VERIFICATION_ENVIRONMENT_NOT_EMPTY",
      );
    }
  }
});

test("rejects missing, extra, duplicate and out-of-order targets", () => {
  const set = makeSet();
  const cases = [
    set.verifications.slice(0, 3),
    [...set.verifications, set.verifications[3]],
    [set.verifications[0], set.verifications[1], set.verifications[1], set.verifications[3]],
    [set.verifications[1], set.verifications[0], set.verifications[2], set.verifications[3]],
  ];
  for (const verifications of cases) {
    assert.throws(
      () => createAgentConnectionVerificationSet({ verifications }),
      (error) => error instanceof AgentConnectionVerificationSetError
        && ["VERIFICATION_COUNT_MISMATCH", "VERIFICATION_TARGET_ORDER_MISMATCH"].includes(error.code),
    );
  }
});

test("each slot rejects endpoint drift and probe drift across the set", () => {
  for (let index = 0; index < 4; index += 1) {
    const endpointDrift = makeVerifications();
    endpointDrift[index] = createAgentConnectionVerification({
      connection: makeConnection(AGENT_CONNECTION_VERIFICATION_SET_TARGETS[index], { nodePath: OTHER_NODE_PATH }),
      probe: endpointDrift[index].probe,
    });
    assert.throws(
      () => createAgentConnectionVerificationSet({ verifications: endpointDrift }),
      (error) => error instanceof AgentConnectionVerificationSetError && error.code === "VERIFICATION_ENDPOINT_MISMATCH",
    );

    const probeDrift = makeVerifications();
    probeDrift[index] = createAgentConnectionVerification({
      connection: probeDrift[index].connection,
      probe: makeProbe({ stderrBytes: 1 }),
    });
    assert.throws(
      () => createAgentConnectionVerificationSet({ verifications: probeDrift }),
      (error) => error instanceof AgentConnectionVerificationSetError && error.code === "VERIFICATION_PROBE_MISMATCH",
    );
  }
});

test("each nested verification retains exact endpoint, fixed tool closure and limited claims", () => {
  const set = makeSet();
  for (let index = 0; index < 4; index += 1) {
    const endpoint = structuredClone(set);
    endpoint.verifications[index].endpoint.nodePath = OTHER_NODE_PATH;
    assert.throws(() => parseAgentConnectionVerificationSet(endpoint), AgentConnectionVerificationSetError);

    for (const [field, value] of [
      ["count", 0],
      ["actionCount", 0],
      ["helperCount", 0],
      ["namesSha256", SHA256],
    ]) {
      const closure = structuredClone(set);
      closure.verifications[index].probe.tools[field] = value;
      assert.throws(
        () => parseAgentConnectionVerificationSet(closure),
        (error) => error instanceof AgentConnectionVerificationSetError && error.code === "PROBE_TOOL_CLOSURE_MISMATCH",
      );
    }

    const nestedClaim = structuredClone(set);
    nestedClaim.verifications[index].claims.externalAgentConfiguredAttested = true;
    assert.throws(() => parseAgentConnectionVerificationSet(nestedClaim), AgentConnectionVerificationSetError);
  }
});

test("outer claims are exact self-reported semantics and cannot overclaim external state", () => {
  const set = makeSet();
  const validate = getValidator(buildAjv(), "agent-connection-verification-set.schema.json");
  for (const claims of [
    { ...set.claims, documentAuthenticated: true },
    { ...set.claims, setGeneratedInCurrentProcess: false },
    { ...set.claims, hostCommandExecutedByVerifier: true },
    { ...set.claims, hostConfigReadByVerifier: true },
    { ...set.claims, hostConfigWrittenByVerifier: true },
    { ...set.claims, externalAgentInstalledAttested: true },
    { ...set.claims, externalAgentConfiguredAttested: true },
    { ...set.claims, externalAgentConnectedAttested: true },
    { ...set.claims, signatureVerified: true },
  ]) {
    const forged = { ...set, claims };
    assert.equal(validate(forged), false);
    assert.throws(() => parseAgentConnectionVerificationSet(forged), AgentConnectionVerificationSetError);
  }
});

test("plain-data capture rejects unknown fields, Proxy, accessors, hidden fields, symbols and cycles", () => {
  const set = makeSet();
  assert.throws(
    () => parseAgentConnectionVerificationSet({ ...set, unexpected: true }),
    (error) => error instanceof AgentConnectionVerificationSetError && error.code === "UNKNOWN_FIELD",
  );
  assert.throws(
    () => parseAgentConnectionVerificationSet(new Proxy(structuredClone(set), {})),
    (error) => error instanceof AgentConnectionVerificationSetError && error.code === "PROXY_FORBIDDEN",
  );
  for (const descriptor of [
    { enumerable: true, get() { throw new Error("must not run"); } },
    { enumerable: false, value: true },
  ]) {
    const hostile = structuredClone(set);
    Object.defineProperty(hostile, "hostile", descriptor);
    assert.throws(
      () => parseAgentConnectionVerificationSet(hostile),
      (error) => error instanceof AgentConnectionVerificationSetError && error.code === "ACCESSOR_PROPERTY_FORBIDDEN",
    );
  }
  const symbol = structuredClone(set);
  symbol[Symbol("hidden")] = true;
  assert.throws(
    () => parseAgentConnectionVerificationSet(symbol),
    (error) => error instanceof AgentConnectionVerificationSetError && error.code === "SYMBOL_PROPERTY_FORBIDDEN",
  );
  const cyclic = structuredClone(set);
  cyclic.verifications[0].loop = cyclic;
  assert.throws(
    () => parseAgentConnectionVerificationSet(cyclic),
    (error) => error instanceof AgentConnectionVerificationSetError && error.code === "CYCLIC_INPUT_FORBIDDEN",
  );
});

test("plain-data capture preserves the inherited 64-depth and 4096-node limits", () => {
  const tooDeep = {};
  let cursor = tooDeep;
  for (let index = 0; index < 65; index += 1) cursor = cursor.next = {};
  assert.throws(
    () => parseAgentConnectionVerificationSet(tooDeep),
    (error) => error instanceof AgentConnectionVerificationSetError && error.code === "MAX_DEPTH_EXCEEDED",
  );
  assert.throws(
    () => parseAgentConnectionVerificationSet({ values: Array.from({ length: 4096 }, () => null) }),
    (error) => error instanceof AgentConnectionVerificationSetError && error.code === "MAX_NODES_EXCEEDED",
  );
});
