import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import {
  AGENT_CONNECTION_SCHEMA_VERSION,
  AgentConnectionError,
  createAgentConnection,
  parseAgentConnection,
} from "../src/agent-connection.mjs";
import { renderAgentIntegrationOutput } from "../src/agent-integration.mjs";
import { buildAjv, getValidator } from "../src/schemas.mjs";

const hostPlatform = process.platform;
const windows = hostPlatform === "win32";
const nodePath = windows ? "C:\\Program Files\\nodejs\\node.exe" : "/usr/local/bin/node";
const launcherPath = windows ? "C:\\Useful\\secretary-tokenizer.mjs" : "/opt/useful/secretary-tokenizer.mjs";
const projectDirectory = windows ? "C:\\Useful\\secret-project" : "/opt/useful/secret-project";

function makePlan(target = "mcp-servers-json", scope = "user") {
  return {
    schemaVersion: "useful.agent-integration.v1",
    target,
    transport: "stdio",
    scope,
    ...(scope === "project" ? { projectDirectory } : {}),
    server: {
      name: "useful",
      nodePath,
      launcherPath,
      args: [],
      env: { NO_COLOR: "1", USEFUL_PROFILE: "secretary-tokenizer" },
    },
  };
}

test("connection derives and deeply freezes canonical output from plan only", () => {
  const connection = createAgentConnection({ plan: makePlan() });
  assert.equal(connection.schemaVersion, AGENT_CONNECTION_SCHEMA_VERSION);
  assert.equal(connection.hostPlatform, hostPlatform);
  assert.equal(connection.output.mergeFragment.mcpServers.useful.args[0], launcherPath);
  assert.equal(Object.isFrozen(connection), true);
  assert.equal(Object.isFrozen(connection.plan.server.env), true);
  assert.equal(Object.isFrozen(connection.output.mergeFragment.mcpServers.useful.args), true);
  assert.throws(
    () => createAgentConnection({ plan: makePlan(), output: connection.output }),
    (error) => error instanceof AgentConnectionError && error.code === "UNKNOWN_FIELD",
  );
});

test("all target/scope variants share the protocol renderer without drift", () => {
  const cases = [
    ["codex", "user"],
    ["codex", "project"],
    ["claude-code", "user"],
    ["claude-code", "project"],
    ["claude-desktop", "user"],
    ["mcp-servers-json", "user"],
  ];
  for (const [target, scope] of cases) {
    const connection = createAgentConnection({ plan: makePlan(target, scope) });
    assert.deepEqual(connection.output, renderAgentIntegrationOutput(connection.plan, { hostPlatform }));
    assert.equal(connection.plan.target, target);
    assert.equal(connection.plan.scope, scope);
  }
});

test("parser recomputes output and rejects extensions, pollution and platform drift", () => {
  const valid = createAgentConnection({ plan: makePlan() });
  const cases = [
    { ...valid, unknown: true },
    { ...valid, output: { ...valid.output, writesHostConfigWhenExecuted: true } },
    { ...valid, hostPlatform: hostPlatform === "win32" ? "linux" : "win32" },
    { ...valid, plan: { ...valid.plan, server: { ...valid.plan.server, env: { OPENAI_API_KEY: "redacted" } } } },
  ];
  for (const document of cases) assert.throws(() => parseAgentConnection(document), AgentConnectionError);
  const polluted = JSON.parse(JSON.stringify(valid));
  Object.defineProperty(polluted.plan, "__proto__", { value: {}, enumerable: true });
  assert.throws(() => parseAgentConnection(polluted), (error) => error.code === "PROTOTYPE_POLLUTION_FORBIDDEN");
});

test("plain-data snapshot rejects Proxy, accessors, hidden fields, symbols and cycles", () => {
  const valid = createAgentConnection({ plan: makePlan() });
  const proxy = new Proxy(JSON.parse(JSON.stringify(valid)), {});
  assert.throws(() => parseAgentConnection(proxy), (error) => error.code === "PROXY_FORBIDDEN");
  for (const descriptor of [
    { get() { throw new Error("must not run"); }, enumerable: true },
    { value: true, enumerable: false },
  ]) {
    const hostile = JSON.parse(JSON.stringify(valid));
    Object.defineProperty(hostile, "hostile", descriptor);
    assert.throws(() => parseAgentConnection(hostile), (error) => error.code === "ACCESSOR_PROPERTY_FORBIDDEN");
  }
  const symbol = JSON.parse(JSON.stringify(valid));
  symbol[Symbol("hidden")] = true;
  assert.throws(() => parseAgentConnection(symbol), (error) => error.code === "SYMBOL_PROPERTY_FORBIDDEN");
  const cyclic = JSON.parse(JSON.stringify(valid));
  cyclic.plan.loop = cyclic;
  assert.throws(() => parseAgentConnection(cyclic), (error) => error.code === "CYCLIC_INPUT_FORBIDDEN");
});

test("secret-like ordinary text is allowed while unknown and secret environment fields fail closed", () => {
  const valid = createAgentConnection({ plan: makePlan() });
  assert.equal(parseAgentConnection(valid).plan.server.launcherPath, launcherPath);
  for (const env of [{ secretary: "available" }, { OPENAI_API_KEY: "redacted" }]) {
    const forged = { ...valid, plan: { ...valid.plan, server: { ...valid.plan.server, env } } };
    assert.throws(() => parseAgentConnection(forged), AgentConnectionError);
  }
});

test("Schema enforces target shapes and parser establishes the derived binding", () => {
  const validate = getValidator(buildAjv(), "agent-connection.schema.json");
  for (const [target, scope] of [["codex", "user"], ["codex", "project"], ["claude-code", "user"], ["claude-code", "project"], ["claude-desktop", "user"], ["mcp-servers-json", "user"]]) {
    const connection = createAgentConnection({ plan: makePlan(target, scope) });
    assert.equal(validate(connection), true, JSON.stringify(validate.errors));
    assert.deepEqual(parseAgentConnection(connection), connection);
  }
  const valid = createAgentConnection({ plan: makePlan("mcp-servers-json") });
  const structurallyValidButForged = JSON.parse(JSON.stringify(valid));
  structurallyValidButForged.output.mergeFragment.mcpServers.useful.args[0] = windows ? "C:\\Other\\launcher.mjs" : "/other/launcher.mjs";
  assert.equal(validate(structurallyValidButForged), true, JSON.stringify(validate.errors));
  assert.throws(() => parseAgentConnection(structurallyValidButForged), (error) => error.code === "OUTPUT_PLAN_MISMATCH");
  const wrongShape = { ...valid, plan: makePlan("codex", "user") };
  assert.equal(validate(wrongShape), false);
});
