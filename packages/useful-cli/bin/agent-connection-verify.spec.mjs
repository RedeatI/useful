import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createAgentProbe } from "@useful/protocol/agent-probe";
import {
  AgentConnectionVerifyError,
  agentConnectionVerificationTesting,
} from "./agent-connection-verify.mjs";
import { resolveAgentProbeInstallation } from "./agent-probe.mjs";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "useful.mjs");
const sourceInstallation = resolveAgentProbeInstallation();
const launcher = sourceInstallation.mcpEntry;
const canonicalTempRoot = fs.realpathSync.native(os.tmpdir());
const CLI_TEST_TIMEOUT_MS = 45_000;

function fakeProbe(installation = sourceInstallation.installation) {
  return createAgentProbe({
    installation,
    server: {
      name: "useful-actions",
      version: "0.1.0",
      protocolVersion: "2026-07-28",
    },
    tools: {
      count: 40,
      namesSha256: "2740f646530580de5ad2079f3290c01517e8b37f58c6d624293ae74e665c6f17",
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
      stderrSha256: createHash("sha256").digest("hex"),
      transportClosed: true,
    },
  });
}

function runCli(args, environment = process.env) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: canonicalTempRoot,
    encoding: "utf8",
    env: environment,
    timeout: CLI_TEST_TIMEOUT_MS,
    windowsHide: true,
  });
}

function snapshotTree(root) {
  const rows = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
      if (entry.isDirectory()) {
        rows.push(`d:${relative}`);
        visit(absolute);
      } else {
        rows.push(`f:${relative}:${createHash("sha256").update(fs.readFileSync(absolute)).digest("hex")}`);
      }
    }
  };
  visit(root);
  return rows;
}

function writeSentinelCommand(directory, name, sentinel) {
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(directory, `${name}.cmd`), `@echo executed>"${sentinel}"\r\n`, "utf8");
    return;
  }
  const command = path.join(directory, name);
  fs.writeFileSync(command, `#!/bin/sh\nprintf executed > '${sentinel.replaceAll("'", "'\\''")}'\n`, { mode: 0o755 });
}

async function expectVerifyError(operation, code) {
  try {
    await operation;
    throw new Error("expected verification failure");
  } catch (error) {
    expect(error).toBeInstanceOf(AgentConnectionVerifyError);
    expect(error.code).toBe(code);
  }
}

describe("useful agent connection verification", () => {
  it("runs a real fixed source verification without executing hosts or changing config", () => {
    const root = fs.mkdtempSync(path.join(canonicalTempRoot, "useful-agent-verify-real-"));
    try {
      const bin = path.join(root, "bin");
      const config = path.join(root, "config");
      const codexSentinel = path.join(root, "codex-executed.txt");
      const claudeSentinel = path.join(root, "claude-executed.txt");
      fs.mkdirSync(bin);
      fs.mkdirSync(path.join(config, "codex"), { recursive: true });
      fs.mkdirSync(path.join(config, "claude"), { recursive: true });
      fs.writeFileSync(path.join(config, "codex", "config.toml"), "# unchanged\n", "utf8");
      fs.writeFileSync(path.join(config, "claude", "config.json"), "{\"unchanged\":true}\n", "utf8");
      writeSentinelCommand(bin, "codex", codexSentinel);
      writeSentinelCommand(bin, "claude", claudeSentinel);
      const before = snapshotTree(config);
      const environment = {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        CODEX_HOME: path.join(config, "codex"),
        CLAUDE_CONFIG_DIR: path.join(config, "claude"),
        APPDATA: config,
        HOME: config,
        USERPROFILE: config,
      };
      const result = runCli([
        "agent", "verify",
        "--target", "codex",
        "--launcher", launcher,
        "--env", "NO_COLOR=1",
        "--json",
      ], environment);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.endsWith("\n")).toBe(true);
      expect(result.stdout.slice(0, -1)).not.toContain("\n");
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        command: "agent verify",
        data: {
          schemaVersion: "useful.agent-connection-verification.v1",
          kind: "mcp-stdio-connection-verification",
          status: "success",
          claimScope: "useful-mcp-local-stdio-connection-candidate-self-reported",
          connection: {
            kind: "mcp-stdio-connection",
            plan: { target: "codex", server: { launcherPath: launcher } },
          },
          probe: {
            installation: { mode: "source", artifactVerified: false },
            tools: { count: 40, actionCount: 36, helperCount: 4 },
          },
          endpoint: { launcherPath: launcher, installationMode: "source" },
          claims: {
            documentAuthenticated: false,
            connectionGeneratedInCurrentProcess: true,
            fixedUsefulLauncherMatchedInCurrentProcess: true,
            hostCommandExecutedByVerifier: false,
            hostConfigReadByVerifier: false,
            hostConfigWrittenByVerifier: false,
            externalAgentInstalledAttested: false,
            externalAgentConfiguredAttested: false,
          },
        },
      });
      expect(fs.existsSync(codexSentinel)).toBe(false);
      expect(fs.existsSync(claudeSentinel)).toBe(false);
      expect(snapshotTree(config)).toEqual(before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, CLI_TEST_TIMEOUT_MS);

  it("binds all four export targets to one fixed probe without host execution", async () => {
    let probeCalls = 0;
    for (const target of ["codex", "claude-code", "claude-desktop", "mcp-servers-json"]) {
      const result = await agentConnectionVerificationTesting.execute(
        { target, launcher, scope: "user", environment: { NO_COLOR: "1" } },
        { probe: async () => {
          probeCalls += 1;
          return fakeProbe();
        } },
      );
      expect(result.connection.plan.target).toBe(target);
      expect(result.endpoint.launcherPath).toBe(launcher);
      expect(result.probe.tools).toMatchObject({ count: 40, actionCount: 36, helperCount: 4 });
      expect(result.claims).toMatchObject({
        documentAuthenticated: false,
        hostCommandExecutedByVerifier: false,
        hostConfigReadByVerifier: false,
        hostConfigWrittenByVerifier: false,
        externalAgentInstalledAttested: false,
        externalAgentConfiguredAttested: false,
      });
    }
    expect(probeCalls).toBe(4);
  });

  it("rejects a non-fixed launcher before probing", async () => {
    const root = fs.mkdtempSync(path.join(canonicalTempRoot, "useful-agent-verify-wrong-"));
    let probeCalls = 0;
    try {
      const wrong = path.join(root, "other.mjs");
      fs.writeFileSync(wrong, "// not Useful MCP\n", "utf8");
      await expectVerifyError(
        agentConnectionVerificationTesting.execute(
          { target: "codex", launcher: wrong, scope: "user", environment: {} },
          { probe: async () => {
            probeCalls += 1;
            return fakeProbe();
          } },
        ),
        "AGENT_VERIFY_LAUNCHER_MISMATCH",
      );
      expect(probeCalls).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a control character in the launcher before probing", async () => {
    let probeCalls = 0;
    await expectVerifyError(
      agentConnectionVerificationTesting.execute(
        { target: "codex", launcher: `${launcher}\u007f`, scope: "user", environment: {} },
        { probe: async () => {
          probeCalls += 1;
          return fakeProbe();
        } },
      ),
      "AGENT_VERIFY_LAUNCHER_INVALID",
    );
    expect(probeCalls).toBe(0);
  });

  it("rejects a launcher symlink before probing", async (context) => {
    const root = fs.mkdtempSync(path.join(canonicalTempRoot, "useful-agent-verify-link-"));
    const linked = path.join(root, "linked-useful-mcp.mjs");
    let probeCalls = 0;
    try {
      try {
        fs.symlinkSync(launcher, linked, "file");
      } catch (error) {
        if (error?.code === "EPERM" || error?.code === "EACCES") {
          context.skip();
          return;
        }
        throw error;
      }
      await expectVerifyError(
        agentConnectionVerificationTesting.execute(
          { target: "codex", launcher: linked, scope: "user", environment: {} },
          { probe: async () => {
            probeCalls += 1;
            return fakeProbe();
          } },
        ),
        "AGENT_VERIFY_LINKED_PATH_FORBIDDEN",
      );
      expect(probeCalls).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an unsafe project directory before probing", async () => {
    let probeCalls = 0;
    const missingProject = path.join(canonicalTempRoot, `missing-useful-project-${process.pid}-${Date.now()}`);
    try {
      await agentConnectionVerificationTesting.execute(
        {
          target: "claude-code",
          launcher,
          scope: "project",
          projectDirectory: missingProject,
          environment: {},
        },
        { probe: async () => {
          probeCalls += 1;
          return fakeProbe();
        } },
      );
      throw new Error("expected unsafe project failure");
    } catch (error) {
      expect(error).toMatchObject({ code: "PROJECT_DIRECTORY_UNSAFE" });
    }
    expect(probeCalls).toBe(0);
  });

  it("rejects USEFUL_PROFILE through the seam before probing", async () => {
    let probeCalls = 0;
    await expectVerifyError(
      agentConnectionVerificationTesting.execute(
        {
          target: "mcp-servers-json",
          launcher,
          scope: "user",
          environment: { USEFUL_PROFILE: "office-safe" },
        },
        { probe: async () => {
          probeCalls += 1;
          return fakeProbe();
        } },
      ),
      "AGENT_VERIFY_PROFILE_NOT_SUPPORTED",
    );
    expect(probeCalls).toBe(0);
  });

  it("rejects USEFUL_PROFILE in the real CLI before the fixed probe starts", () => {
    const environment = {
      ...process.env,
      ...(process.platform === "win32" ? { SystemRoot: "not-an-absolute-system-root" } : {}),
    };
    const result = runCli([
      "agent", "verify",
      "--target", "mcp-servers-json",
      "--launcher", launcher,
      "--env", "USEFUL_PROFILE=office-safe",
      "--json",
    ], environment);
    expect(result.status).toBe(3);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("office-safe");
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "agent verify",
      error: { code: "AGENT_VERIFY_PROFILE_NOT_SUPPORTED", details: { name: "USEFUL_PROFILE" } },
    });
  }, CLI_TEST_TIMEOUT_MS);

  it("rejects installation drift after the bounded probe", async () => {
    let resolutions = 0;
    const drifted = {
      ...sourceInstallation,
      installation: {
        ...sourceInstallation.installation,
        sourceRevision: "ab".repeat(20),
      },
    };
    await expectVerifyError(
      agentConnectionVerificationTesting.execute(
        { target: "mcp-servers-json", launcher, scope: "user", environment: {} },
        {
          resolveInstallation: () => {
            resolutions += 1;
            return resolutions === 1 ? sourceInstallation : drifted;
          },
          probe: async () => fakeProbe(),
        },
      ),
      "AGENT_VERIFY_INSTALLATION_DRIFT",
    );
  });

  it("requires JSON and rejects write, install, process, argv and cwd overrides", () => {
    const withoutJson = runCli(["agent", "verify", "--target", "codex", "--launcher", launcher]);
    expect(withoutJson.status).toBe(2);
    expect(withoutJson.stdout).toBe("");
    expect(withoutJson.stderr).toContain("JSON_REQUIRED");

    for (const [option, code] of [
      ["--apply", "APPLY_NOT_SUPPORTED"],
      ["--install", "APPLY_NOT_SUPPORTED"],
      ["--output", "OUTPUT_PATH_NOT_SUPPORTED"],
      ["--config", "OUTPUT_PATH_NOT_SUPPORTED"],
      ["--node", "UNKNOWN_FLAG"],
      ["--argv", "UNKNOWN_FLAG"],
      ["--cwd", "UNKNOWN_FLAG"],
    ]) {
      const result = runCli([
        "agent", "verify", "--target", "codex", "--launcher", launcher,
        option, "ignored", "--json",
      ]);
      expect(result.status).toBe(2);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({ command: "agent verify", error: { code } });
    }
  }, CLI_TEST_TIMEOUT_MS);
});
