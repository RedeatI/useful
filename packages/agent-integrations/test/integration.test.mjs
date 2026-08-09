import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import {
  AGENT_INTEGRATION_SCHEMA_VERSION,
  AgentIntegrationError,
  buildAgentIntegrationPlan,
  doctorAgentIntegration,
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

test("renderer fully revalidates and rejects forged plans", () => {
  const fixture = makeFixture();
  const plan = buildAgentIntegrationPlan({ target: "mcp-servers-json", launcher: fixture.launcher });
  const forged = {
    ...plan,
    server: { ...plan.server, args: ["--unsafe"], injected: true },
  };
  assert.throws(() => renderAgentIntegration(forged), (error) => error instanceof AgentIntegrationError && error.code === "INVALID_PLAN");
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
