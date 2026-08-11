import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";
import {
  AGENT_CONNECTION_VERIFICATION_KIND,
  AGENT_CONNECTION_VERIFICATION_CLAIM_SCOPE,
  AGENT_CONNECTION_VERIFICATION_SCHEMA_VERSION,
  AgentConnectionVerificationError,
  createAgentConnectionVerification,
  parseAgentConnectionVerification,
  validateAgentConnectionVerification,
} from "../src/agent-connection-verification.mjs";
import { createAgentConnection } from "../src/agent-connection.mjs";
import { createAgentProbe } from "../src/agent-probe.mjs";
import { buildAjv, getValidator } from "../src/schemas.mjs";

const WINDOWS = process.platform === "win32";
const NODE_PATH = WINDOWS ? "C:\\Program Files\\nodejs\\node.exe" : "/usr/local/bin/node";
const LAUNCHER_PATH = WINDOWS ? "C:\\Useful\\lib\\useful-mcp.mjs" : "/opt/useful/lib/useful-mcp.mjs";
const OTHER_NODE_PATH = WINDOWS ? "C:\\Other\\node.exe" : "/other/node";
const OTHER_LAUNCHER_PATH = WINDOWS ? "C:\\Other\\useful-mcp.mjs" : "/other/useful-mcp.mjs";
const REVISION = "b".repeat(40);
const SHA256 = "a".repeat(64);
const TOOL_NAMES_SHA256 = "2740f646530580de5ad2079f3290c01517e8b37f58c6d624293ae74e665c6f17";

function makeConnection({ nodePath = NODE_PATH, launcherPath = LAUNCHER_PATH } = {}) {
  return createAgentConnection({
    plan: {
      schemaVersion: "useful.agent-integration.v1",
      target: "mcp-servers-json",
      transport: "stdio",
      scope: "user",
      server: {
        name: "useful",
        nodePath,
        launcherPath,
        args: [],
        env: { NO_COLOR: "1" },
      },
    },
  });
}

function makeProbe({ version = "0.1.0-beta.3", revision = REVISION } = {}) {
  return createAgentProbe({
    installation: {
      mode: "source",
      artifactVerified: false,
      sourceRevision: revision,
      version,
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
      stderrBytes: 0,
      stderrSha256: SHA256,
      transportClosed: true,
    },
  });
}

function makeVerification() {
  return createAgentConnectionVerification({
    connection: makeConnection(),
    probe: makeProbe(),
  });
}

test("creates a deeply frozen closed connection-candidate verification", () => {
  const verification = makeVerification();
  assert.equal(verification.schemaVersion, AGENT_CONNECTION_VERIFICATION_SCHEMA_VERSION);
  assert.equal(verification.kind, AGENT_CONNECTION_VERIFICATION_KIND);
  assert.equal(verification.status, "success");
  assert.equal(verification.claimScope, AGENT_CONNECTION_VERIFICATION_CLAIM_SCOPE);
  assert.deepEqual(verification.endpoint, {
    nodePath: NODE_PATH,
    launcherPath: LAUNCHER_PATH,
    installationMode: "source",
    sourceRevision: REVISION,
    productVersion: "0.1.0-beta.3",
  });
  assert.deepEqual(verification.claims, {
    documentAuthenticated: false,
    connectionGeneratedInCurrentProcess: true,
    fixedUsefulLauncherMatchedInCurrentProcess: true,
    hostCommandExecutedByVerifier: false,
    hostConfigReadByVerifier: false,
    hostConfigWrittenByVerifier: false,
    externalAgentInstalledAttested: false,
    externalAgentConfiguredAttested: false,
  });
  for (const value of [
    verification,
    verification.connection,
    verification.connection.plan.server,
    verification.probe,
    verification.probe.proof,
    verification.endpoint,
    verification.claims,
  ]) assert.equal(Object.isFrozen(value), true);
  assert.throws(
    () => createAgentConnectionVerification({ connection: verification.connection, probe: verification.probe, claims: verification.claims }),
    (error) => error instanceof AgentConnectionVerificationError && error.code === "UNKNOWN_FIELD",
  );
});

test("Schema resolves real cross-file refs while parser enforces endpoint binding", () => {
  const verification = makeVerification();
  const validate = getValidator(buildAjv(), "agent-connection-verification.schema.json");
  assert.equal(validate(verification), true, JSON.stringify(validate.errors));
  assert.deepEqual(parseAgentConnectionVerification(verification), verification);
  assert.deepEqual(validateAgentConnectionVerification(verification), verification);

  const endpointDrift = structuredClone(verification);
  endpointDrift.endpoint.nodePath = OTHER_NODE_PATH;
  assert.equal(validate(endpointDrift), true, JSON.stringify(validate.errors));
  assert.throws(
    () => parseAgentConnectionVerification(endpointDrift),
    (error) => error instanceof AgentConnectionVerificationError && error.code === "ENDPOINT_CONNECTION_MISMATCH",
  );
});

test("parser rejects canonical connection and probe drift against the bound endpoint", () => {
  const verification = makeVerification();
  const connectionDrift = structuredClone(verification);
  connectionDrift.connection = makeConnection({ nodePath: OTHER_NODE_PATH, launcherPath: OTHER_LAUNCHER_PATH });
  assert.throws(
    () => parseAgentConnectionVerification(connectionDrift),
    (error) => error instanceof AgentConnectionVerificationError && error.code === "ENDPOINT_CONNECTION_MISMATCH",
  );

  const probeDrift = structuredClone(verification);
  probeDrift.probe = makeProbe({ version: "0.1.1", revision: "c".repeat(40) });
  assert.throws(
    () => parseAgentConnectionVerification(probeDrift),
    (error) => error instanceof AgentConnectionVerificationError && error.code === "ENDPOINT_PROBE_MISMATCH",
  );
});

test("parser and Schema lock the default probe tool closure", () => {
  const verification = makeVerification();
  const validate = getValidator(buildAjv(), "agent-connection-verification.schema.json");
  for (const [field, value] of [
    ["count", 0],
    ["actionCount", 0],
    ["helperCount", 0],
    ["namesSha256", SHA256],
  ]) {
    const forged = structuredClone(verification);
    forged.probe.tools[field] = value;
    assert.equal(validate(forged), false, `${field} drift must fail Schema validation`);
    assert.throws(
      () => parseAgentConnectionVerification(forged),
      (error) => error instanceof AgentConnectionVerificationError && error.code === "PROBE_TOOL_CLOSURE_MISMATCH",
    );
  }
});

test("claims are self-reported, fixed and cannot overclaim authentication or external state", () => {
  const verification = makeVerification();
  const validate = getValidator(buildAjv(), "agent-connection-verification.schema.json");
  for (const claims of [
    { ...verification.claims, documentAuthenticated: true },
    { ...verification.claims, fixedUsefulLauncherMatchedInCurrentProcess: false },
    { ...verification.claims, hostCommandExecutedByVerifier: true },
    { ...verification.claims, hostConfigReadByVerifier: true },
    { ...verification.claims, hostConfigWrittenByVerifier: true },
    { ...verification.claims, externalAgentInstalledAttested: true },
    { ...verification.claims, externalAgentConfiguredAttested: true },
    { ...verification.claims, signatureVerified: true },
  ]) {
    const forged = { ...verification, claims };
    assert.equal(validate(forged), false);
    assert.throws(() => parseAgentConnectionVerification(forged), AgentConnectionVerificationError);
  }
});

test("plain-data capture rejects unknown fields, Proxy, accessors, hidden fields, symbols and cycles", () => {
  const verification = makeVerification();
  assert.throws(
    () => parseAgentConnectionVerification({ ...verification, unexpected: true }),
    (error) => error instanceof AgentConnectionVerificationError && error.code === "UNKNOWN_FIELD",
  );
  assert.throws(
    () => parseAgentConnectionVerification({ ...verification, endpoint: { ...verification.endpoint, unexpected: true } }),
    (error) => error instanceof AgentConnectionVerificationError && error.code === "UNKNOWN_FIELD",
  );
  assert.throws(
    () => parseAgentConnectionVerification(new Proxy(structuredClone(verification), {})),
    (error) => error instanceof AgentConnectionVerificationError && error.code === "PROXY_FORBIDDEN",
  );
  for (const descriptor of [
    { enumerable: true, get() { throw new Error("must not run"); } },
    { enumerable: false, value: true },
  ]) {
    const hostile = structuredClone(verification);
    Object.defineProperty(hostile, "hostile", descriptor);
    assert.throws(
      () => parseAgentConnectionVerification(hostile),
      (error) => error instanceof AgentConnectionVerificationError && error.code === "ACCESSOR_PROPERTY_FORBIDDEN",
    );
  }
  const symbol = structuredClone(verification);
  symbol[Symbol("hidden")] = true;
  assert.throws(
    () => parseAgentConnectionVerification(symbol),
    (error) => error instanceof AgentConnectionVerificationError && error.code === "SYMBOL_PROPERTY_FORBIDDEN",
  );
  const cyclic = structuredClone(verification);
  cyclic.endpoint.loop = cyclic;
  assert.throws(
    () => parseAgentConnectionVerification(cyclic),
    (error) => error instanceof AgentConnectionVerificationError && error.code === "CYCLIC_INPUT_FORBIDDEN",
  );
});
