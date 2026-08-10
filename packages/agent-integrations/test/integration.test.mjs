import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { renderAgentIntegrationOutput } from "@useful/protocol/agent-integration";
import { parseAgentConnection } from "@useful/protocol/agent-connection";
import {
  AGENT_INTEGRATION_SCHEMA_VERSION,
  AgentIntegrationError,
  buildAgentIntegrationPlan,
  doctorAgentIntegration,
  exportAgentIntegration,
  parseEnvironmentAssignments,
  planAgentIntegration,
  quotePowerShellLiteral,
  renderAgentIntegration,
  validateEnvironment,
} from "../src/integration.mjs";

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "useful-agent-integration-"));
  const launcher = path.join(root, "Useful MCP launcher.mjs");
  fs.writeFileSync(launcher, "// fixture\n", "utf8");
  return { root, launcher };
}

test("four targets render canonical argv or merge fragments", () => {
  const fixture = makeFixture();
  const environment = { USEFUL_LOG_LEVEL: "info", NO_COLOR: "1" };
  const codexUser = planAgentIntegration({ target: "codex", launcher: fixture.launcher, environment });
  assert.deepEqual(codexUser.output.commandArgv, [
    "codex", "mcp", "add", "useful",
    "--env", "NO_COLOR=1", "--env", "USEFUL_LOG_LEVEL=info",
    "--", process.execPath, fixture.launcher,
  ]);
  assert.equal(codexUser.output.powershellCommand.startsWith("& 'codex' "), true);
  assert.equal(codexUser.output.writesHostConfigWhenExecuted, true);

  const codexProject = planAgentIntegration({
    target: "codex",
    launcher: fixture.launcher,
    scope: "project",
    projectDirectory: fixture.root,
    environment,
  });
  assert.equal(codexProject.output.kind, "merge-fragment");
  assert.equal(codexProject.output.configPath, path.join(fixture.root, ".codex", "config.toml"));
  assert.equal(Object.hasOwn(codexProject.output, "commandArgv"), false);
  assert.match(codexProject.output.mergeFragment, /^\[mcp_servers\.useful\]\ncommand = /);
  assert.equal(codexProject.output.writesHostConfigWhenExecuted, false);

  const claudeUser = planAgentIntegration({ target: "claude-code", launcher: fixture.launcher, environment });
  assert.deepEqual(claudeUser.output.commandArgv, [
    "claude", "mcp", "add",
    "--env", "NO_COLOR=1", "--env", "USEFUL_LOG_LEVEL=info",
    "--transport", "stdio", "--scope", "user",
    "useful", "--", process.execPath, fixture.launcher,
  ]);
  const claudeProject = planAgentIntegration({
    target: "claude-code",
    launcher: fixture.launcher,
    scope: "project",
    projectDirectory: fixture.root,
  });
  assert.equal(claudeProject.output.requiredWorkingDirectory, fixture.root);
  assert.deepEqual(claudeProject.output.commandArgv.slice(3, 9), ["--transport", "stdio", "--scope", "project", "useful", "--"]);

  for (const target of ["claude-desktop", "mcp-servers-json"]) {
    const result = planAgentIntegration({ target, launcher: fixture.launcher, environment });
    assert.equal(result.schemaVersion, AGENT_INTEGRATION_SCHEMA_VERSION);
    assert.equal(result.output.kind, "merge-fragment");
    assert.equal(result.output.format, "json");
    assert.equal(result.output.mergeFragment.mcpServers.useful.command, process.execPath);
    assert.deepEqual(result.output.mergeFragment.mcpServers.useful.args, [fixture.launcher]);
    assert.deepEqual(Object.keys(result.output.mergeFragment.mcpServers.useful.env), ["NO_COLOR", "USEFUL_LOG_LEVEL"]);
    assert.equal(result.output.writesHostConfigWhenExecuted, false);
  }
});

test("four targets export canonical deterministic secret-free connection documents", () => {
  const fixture = makeFixture();
  for (const target of ["codex", "claude-code", "claude-desktop", "mcp-servers-json"]) {
    const input = { target, launcher: fixture.launcher, environment: { USEFUL_PROFILE: "office-safe", NO_COLOR: "1" } };
    const first = exportAgentIntegration(input);
    const second = exportAgentIntegration(input);
    assert.deepEqual(first, second);
    assert.deepEqual(Object.keys(first), ["hostPlatform", "kind", "output", "plan", "schemaVersion", "secretPolicy", "writePolicy"]);
    assert.equal(first.schemaVersion, "useful.agent-connection.v1");
    assert.equal(first.kind, "mcp-stdio-connection");
    assert.equal(first.writePolicy, "manual-review-only");
    assert.equal(first.secretPolicy, "no-secrets");
    assert.equal(first.hostPlatform, process.platform);
    assert.equal(first.plan.target, target);
    assert.equal(first.plan.server.launcherPath, fixture.launcher);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.plan), true);
    assert.equal(Object.isFrozen(first.output), true);
    assert.doesNotMatch(JSON.stringify(first), /createdAt|generatedAt|hostname|nodeVersion|cwd/i);
  }
});

test("PowerShell display quotes every argument and doubles apostrophes", () => {
  assert.equal(quotePowerShellLiteral("C:\\Agent's Tools\\launcher.mjs"), "'C:\\Agent''s Tools\\launcher.mjs'");
});

test("secret and unknown environment inputs fail closed without echoing values", () => {
  for (const invoke of [
    () => validateEnvironment({ OPENAI_API_KEY: "SUPER_SECRET_VALUE" }),
    () => parseEnvironmentAssignments(["PATH=C:\\unsafe-secret-value"]),
  ]) {
    assert.throws(invoke, (error) => {
      assert.equal(error instanceof AgentIntegrationError, true);
      assert.doesNotMatch(JSON.stringify(error), /SUPER_SECRET_VALUE|unsafe-secret-value/);
      return true;
    });
  }
});

test("relative UNC incomplete roots invalid characters and unsupported scopes are rejected", () => {
  const fixture = makeFixture();
  assert.throws(() => planAgentIntegration({ target: "codex", launcher: "relative.mjs" }), (error) => error instanceof AgentIntegrationError && error.code === "RELATIVE_PATH_FORBIDDEN");
  assert.throws(() => planAgentIntegration({ target: "codex", launcher: "\\\\server\\share\\launcher.mjs" }), (error) => error instanceof AgentIntegrationError && error.code === "UNC_PATH_FORBIDDEN");
  assert.throws(() => planAgentIntegration({ target: "unknown", launcher: fixture.launcher }), (error) => error instanceof AgentIntegrationError && error.code === "UNKNOWN_TARGET");
  assert.throws(() => planAgentIntegration({ target: "codex", launcher: fixture.launcher, nodePath: fixture.launcher }), (error) => error instanceof AgentIntegrationError && error.code === "NODE_PATH_MISMATCH");
  assert.throws(() => planAgentIntegration({ target: "codex", launcher: fixture.launcher, scope: "project" }), (error) => error instanceof AgentIntegrationError && error.code === "MISSING_REQUIRED_VALUE");
  assert.throws(() => planAgentIntegration({ target: "claude-desktop", launcher: fixture.launcher, scope: "project", projectDirectory: fixture.root }), (error) => error instanceof AgentIntegrationError && error.code === "SCOPE_NOT_SUPPORTED");
  assert.throws(() => planAgentIntegration({ target: "mcp-servers-json", launcher: fixture.launcher, scope: "project", projectDirectory: fixture.root }), (error) => error instanceof AgentIntegrationError && error.code === "SCOPE_NOT_SUPPORTED");
  const tooLong = `${path.parse(fixture.launcher).root}${"a".repeat(4097)}`;
  assert.throws(() => planAgentIntegration({ target: "codex", launcher: tooLong }), (error) => error instanceof AgentIntegrationError && error.code === "MISSING_REQUIRED_VALUE");
  assert.throws(() => planAgentIntegration({ target: "codex", launcher: `${fixture.launcher}\u007f` }), (error) => error instanceof AgentIntegrationError && error.code === "INVALID_PATH");
  if (process.platform === "win32") {
    assert.throws(() => planAgentIntegration({ target: "codex", launcher: "\\rooted-without-drive.mjs" }), (error) => error instanceof AgentIntegrationError && error.code === "RELATIVE_PATH_FORBIDDEN");
    assert.throws(() => planAgentIntegration({ target: "codex", launcher: "/rooted-without-drive.mjs" }), (error) => error instanceof AgentIntegrationError && error.code === "RELATIVE_PATH_FORBIDDEN");
  }
});

test("connection parser rejects derived output and host platform tampering after a valid export", () => {
  const fixture = makeFixture();
  const valid = exportAgentIntegration({ target: "mcp-servers-json", launcher: fixture.launcher });
  const forgedOutput = JSON.parse(JSON.stringify(valid));
  forgedOutput.output.mergeFragment.mcpServers.useful.args[0] = path.join(fixture.root, "other-launcher.mjs");
  assert.throws(
    () => parseAgentConnection(forgedOutput),
    (error) => error.code === "OUTPUT_PLAN_MISMATCH",
  );
  const forgedPlatform = {
    ...valid,
    hostPlatform: process.platform === "win32" ? "linux" : "win32",
  };
  assert.throws(
    () => parseAgentConnection(forgedPlatform),
    (error) => error.code === "HOST_PATH_MISMATCH",
  );
});

test("integration renderer delegates to the protocol single source for every target", () => {
  const fixture = makeFixture();
  for (const target of ["codex", "claude-code", "claude-desktop", "mcp-servers-json"]) {
    const plan = buildAgentIntegrationPlan({ target, launcher: fixture.launcher, environment: { USEFUL_PROFILE: "secretary-tokenizer" } });
    assert.deepEqual(renderAgentIntegration(plan), renderAgentIntegrationOutput(plan, { hostPlatform: process.platform }));
  }
});

test("object APIs reject Proxy accessors hidden fields symbols and cycles before validation", () => {
  const fixture = makeFixture();
  assert.throws(
    () => buildAgentIntegrationPlan(new Proxy({ target: "codex", launcher: fixture.launcher }, {})),
    (error) => error instanceof AgentIntegrationError && error.code === "PROXY_FORBIDDEN",
  );
  for (const descriptor of [
    { get() { throw new Error("must not run"); }, enumerable: true },
    { value: "codex", enumerable: false },
  ]) {
    const input = { launcher: fixture.launcher };
    Object.defineProperty(input, "target", descriptor);
    assert.throws(() => buildAgentIntegrationPlan(input), (error) => error instanceof AgentIntegrationError && error.code === "ACCESSOR_PROPERTY_FORBIDDEN");
  }
  const symbol = { target: "codex", launcher: fixture.launcher, [Symbol("hidden")]: true };
  assert.throws(() => buildAgentIntegrationPlan(symbol), (error) => error.code === "SYMBOL_PROPERTY_FORBIDDEN");
  const cyclic = { target: "codex", launcher: fixture.launcher };
  cyclic.self = cyclic;
  assert.throws(() => buildAgentIntegrationPlan(cyclic), (error) => error.code === "CYCLIC_INPUT_FORBIDDEN");
});

test("secret-like ordinary profile and path text does not trigger substring rejection", () => {
  const fixture = makeFixture();
  const secretPath = path.join(fixture.root, "secretary-tokenizer.mjs");
  fs.writeFileSync(secretPath, "// fixture\n", "utf8");
  const result = planAgentIntegration({
    target: "mcp-servers-json",
    launcher: secretPath,
    environment: { USEFUL_PROFILE: "secretary-tokenizer" },
  });
  assert.equal(result.plan.server.launcherPath, secretPath);
  assert.equal(result.plan.server.env.USEFUL_PROFILE, "secretary-tokenizer");
});

test("doctor rejects missing and linked launcher paths without executing them", (context) => {
  const fixture = makeFixture();
  const missing = path.join(fixture.root, "missing.mjs");
  const missingResult = doctorAgentIntegration({ target: "mcp-servers-json", launcher: missing });
  assert.equal(missingResult.ok, false);
  assert.equal(missingResult.checks.some((check) => check.id === "launcher.exists" && check.status === "fail"), true);

  const linked = path.join(fixture.root, "linked-launcher.mjs");
  try {
    fs.symlinkSync(fixture.launcher, linked, "file");
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      context.skip("当前 Windows 权限不允许创建测试 symlink");
      return;
    }
    throw error;
  }
  const linkedResult = doctorAgentIntegration({ target: "mcp-servers-json", launcher: linked });
  assert.equal(linkedResult.ok, false);
  assert.equal(linkedResult.checks.some((check) => check.id === "launcher.linked-path" && check.status === "fail"), true);
});
