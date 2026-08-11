import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  COMPUTER_USE_PROBE_ACTION_TYPES,
  COMPUTER_USE_PROBE_ACTION_TYPES_SHA256,
  COMPUTER_USE_PROBE_MAX_DEPTH,
  COMPUTER_USE_PROBE_MAX_NODES,
  COMPUTER_USE_PROBE_SCHEMA_VERSION,
  ComputerUseProbeProtocolError,
  createComputerUseProbe,
  parseComputerUseProbe,
  validateComputerUseProbe,
} from "../src/computer-use-probe.mjs";
import { AGENT_PROBE_MAX_DEPTH, AGENT_PROBE_MAX_NODES } from "../src/agent-probe.mjs";
import { buildAjv, getValidator } from "../src/schemas.mjs";

const REVISION = "b".repeat(40);

function installation(mode = "source") {
  return {
    mode,
    artifactVerified: mode === "agent-kit",
    sourceRevision: REVISION,
    version: "0.1.0-beta.3",
  };
}

function makeNestedValue(depth) {
  let value = null;
  for (let level = 1; level < depth; level += 1) value = { next: value };
  return value;
}

test("creates the fixed deep-frozen self-reported capability document", () => {
  const probe = createComputerUseProbe({ installation: installation() });
  assert.equal(probe.schemaVersion, COMPUTER_USE_PROBE_SCHEMA_VERSION);
  assert.equal(probe.status, "success");
  assert.equal(probe.claimScope, "useful-computer-use-capability-local-self-reported");
  assert.deepEqual(probe.contract.environments, ["isolated-browser", "isolated-vm"]);
  assert.deepEqual(probe.contract.actionTypes, ["screenshot", "click", "double-click", "drag", "move", "scroll", "type", "key", "wait"]);
  assert.deepEqual(probe.contract.defaultPolicy, {
    environment: "isolated-browser",
    allowDomainsCount: 0,
    maxRedirects: 0,
    developmentMode: false,
    allowPrivateDomains: false,
  });
  assert.deepEqual(probe.capabilities, {
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
  assert.deepEqual(probe.claims, {
    documentAuthenticated: false,
    defaultControllerDisabledObserved: true,
    hostDesktopRejectedObserved: true,
    networkUsedByProbe: false,
    userInputPerformed: false,
    hostDesktopTouched: false,
    realBrowserAttested: false,
    networkEnforcementAttested: false,
  });
  assert.equal(Object.isFrozen(probe), true);
  assert.equal(Object.isFrozen(probe.installation), true);
  assert.equal(Object.isFrozen(probe.contract), true);
  assert.equal(Object.isFrozen(probe.contract.environments), true);
  assert.equal(Object.isFrozen(probe.contract.actionTypes), true);
  assert.equal(Object.isFrozen(probe.contract.defaultPolicy), true);
  assert.equal(Object.isFrozen(probe.capabilities), true);
  assert.equal(Object.isFrozen(probe.claims), true);
});

test("binds the action order to the UTF-8 JSON SHA-256", () => {
  const digest = createHash("sha256").update(JSON.stringify(COMPUTER_USE_PROBE_ACTION_TYPES), "utf8").digest("hex");
  assert.equal(digest, COMPUTER_USE_PROBE_ACTION_TYPES_SHA256);
  assert.equal(digest, "a9bce07e51d533f830833d94ddc5fd53ae7f0b837da31edc8b68f64394a10cf7");
});

test("keeps JSON Schema and parser aligned on the exact success shape", () => {
  const probe = createComputerUseProbe({ installation: installation() });
  const schemaValidate = getValidator(buildAjv(), "computer-use-probe.schema.json");
  assert.equal(schemaValidate(probe), true, JSON.stringify(schemaValidate.errors));
  assert.deepEqual(parseComputerUseProbe(probe), probe);
  assert.deepEqual(validateComputerUseProbe(probe), probe);

  const mutations = [
    { ...probe, extra: true },
    { ...probe, claimScope: "external-attestation" },
    { ...probe, contract: { ...probe.contract, environments: [...probe.contract.environments].reverse() } },
    { ...probe, contract: { ...probe.contract, actionTypes: [...probe.contract.actionTypes].reverse() } },
    { ...probe, contract: { ...probe.contract, actionTypesSha256: "a".repeat(64) } },
    { ...probe, contract: { ...probe.contract, defaultPolicy: { ...probe.contract.defaultPolicy, maxRedirects: 1 } } },
    { ...probe, capabilities: { ...probe.capabilities, defaultProviderEnabled: true } },
    { ...probe, claims: { ...probe.claims, realBrowserAttested: true } },
  ];
  for (const mutation of mutations) {
    assert.equal(schemaValidate(mutation), false, JSON.stringify(mutation));
    assert.throws(() => parseComputerUseProbe(mutation), ComputerUseProbeProtocolError);
  }
});

test("enforces source and Agent Kit artifact verification semantics", () => {
  const source = createComputerUseProbe({ installation: installation("source") });
  const agentKit = createComputerUseProbe({ installation: installation("agent-kit") });
  assert.equal(source.installation.artifactVerified, false);
  assert.equal(agentKit.installation.artifactVerified, true);
  assert.throws(
    () => createComputerUseProbe({ installation: { ...installation("source"), artifactVerified: true } }),
    (error) => error instanceof ComputerUseProbeProtocolError && error.code === "INSTALLATION_PROOF_MISMATCH",
  );
  assert.throws(
    () => createComputerUseProbe({ installation: { ...installation("agent-kit"), artifactVerified: false } }),
    (error) => error instanceof ComputerUseProbeProtocolError && error.code === "INSTALLATION_PROOF_MISMATCH",
  );
});

test("rejects hostile or non-ordinary input without invoking accessors", () => {
  const valid = createComputerUseProbe({ installation: installation() });
  assert.throws(
    () => parseComputerUseProbe(new Proxy(structuredClone(valid), {})),
    (error) => error instanceof ComputerUseProbeProtocolError && error.code === "PROXY_FORBIDDEN",
  );
  const accessor = structuredClone(valid);
  Object.defineProperty(accessor, "hostile", { enumerable: true, get() { throw new Error("must not run"); } });
  assert.throws(
    () => parseComputerUseProbe(accessor),
    (error) => error instanceof ComputerUseProbeProtocolError && error.code === "ACCESSOR_PROPERTY_FORBIDDEN",
  );
  const hidden = structuredClone(valid);
  Object.defineProperty(hidden, "hostile", { enumerable: false, value: true });
  assert.throws(
    () => parseComputerUseProbe(hidden),
    (error) => error instanceof ComputerUseProbeProtocolError && error.code === "ACCESSOR_PROPERTY_FORBIDDEN",
  );
  const symbol = structuredClone(valid);
  symbol[Symbol("hidden")] = true;
  assert.throws(
    () => parseComputerUseProbe(symbol),
    (error) => error instanceof ComputerUseProbeProtocolError && error.code === "SYMBOL_PROPERTY_FORBIDDEN",
  );
  const cycle = structuredClone(valid);
  cycle.contract.loop = cycle;
  assert.throws(
    () => parseComputerUseProbe(cycle),
    (error) => error instanceof ComputerUseProbeProtocolError && error.code === "CYCLIC_INPUT_FORBIDDEN",
  );
  assert.throws(() => createComputerUseProbe({ installation: installation(), extra: true }), ComputerUseProbeProtocolError);
});

test("reuses the agent-probe ordinary-data depth and node budgets", () => {
  assert.equal(COMPUTER_USE_PROBE_MAX_DEPTH, AGENT_PROBE_MAX_DEPTH);
  assert.equal(COMPUTER_USE_PROBE_MAX_NODES, AGENT_PROBE_MAX_NODES);
  assert.throws(
    () => parseComputerUseProbe(makeNestedValue(COMPUTER_USE_PROBE_MAX_DEPTH + 1)),
    (error) => error instanceof ComputerUseProbeProtocolError
      && error.code === "MAX_DEPTH_EXCEEDED"
      && error.details.maximumDepth === COMPUTER_USE_PROBE_MAX_DEPTH,
  );
  const overLimit = Array.from({ length: COMPUTER_USE_PROBE_MAX_NODES }, () => null);
  assert.throws(
    () => validateComputerUseProbe(overLimit),
    (error) => error instanceof ComputerUseProbeProtocolError
      && error.code === "MAX_NODES_EXCEEDED"
      && error.details.maximumNodes === COMPUTER_USE_PROBE_MAX_NODES,
  );
});
