import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { doctorAgentIntegration } from "@useful/agent-integrations";
import { createAgentProbe } from "@useful/protocol/agent-probe";
import {
  AGENT_CONNECTION_VERIFY_ALL_TARGETS,
  agentConnectionVerificationSetTesting,
} from "./agent-connection-verify-all.mjs";
import { AgentConnectionVerifyError } from "./agent-connection-verify.mjs";
import { resolveAgentProbeInstallation } from "./agent-probe.mjs";
import { agentContractData } from "./agent-contract-data.mjs";

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

async function expectVerifyAllError(operation, code) {
  try {
    await operation;
    throw new Error("expected verify-all failure");
  } catch (error) {
    expect(error).toBeInstanceOf(AgentConnectionVerifyError);
    expect(error.code).toBe(code);
  }
}

describe("useful agent verify-all", () => {
  it("registers the exact machine contract command", () => {
    const contract = agentContractData([]);
    expect(contract.commands.agentVerifyAll).toBe(
      "useful agent verify-all --launcher <current-installation-fixed-useful-mcp-entry> --json",
    );
    expect(contract.commandSequence).toContain(
      "useful agent verify-all --launcher \"<ABS_FIXED_USEFUL_MCP_LAUNCHER>\" --json",
    );
  });

  it("uses one bounded probe and returns the four fixed user-scope candidates in order", async () => {
    let probeCalls = 0;
    const doctorTargets = [];
    const result = await agentConnectionVerificationSetTesting.execute(
      { launcher },
      {
        doctor: (input) => {
          doctorTargets.push(input.target);
          return doctorAgentIntegration(input);
        },
        probe: async () => {
          probeCalls += 1;
          return fakeProbe();
        },
      },
    );

    expect(probeCalls).toBe(1);
    expect(doctorTargets).toEqual(AGENT_CONNECTION_VERIFY_ALL_TARGETS);
    expect(result).toMatchObject({
      schemaVersion: "useful.agent-connection-verification-set.v1",
      kind: "mcp-stdio-connection-verification-set",
      status: "candidate-ready",
      claimScope: "useful-mcp-local-stdio-connection-candidates-self-reported",
      claims: {
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
      },
    });
    expect(result.verifications.map((item) => item.connection.plan.target)).toEqual(AGENT_CONNECTION_VERIFY_ALL_TARGETS);
    expect(result.verifications.map((item) => item.connection.plan.scope)).toEqual(["user", "user", "user", "user"]);
    for (const verification of result.verifications) {
      expect(verification.connection.plan.server.env).toStrictEqual({});
    }
    expect(result.verifications.map((item) => item.endpoint.launcherPath)).toEqual([launcher, launcher, launcher, launcher]);
    expect(result.verifications.slice(1).every((item) => (
      JSON.stringify(item.probe) === JSON.stringify(result.verifications[0].probe)
    ))).toBe(true);
  });

  it("is all-or-nothing for an injected failure at every target and writes no candidate", async () => {
    for (const failedTarget of AGENT_CONNECTION_VERIFY_ALL_TARGETS) {
      let probeCalls = 0;
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        await expectVerifyAllError(
          agentConnectionVerificationSetTesting.execute(
            { launcher },
            {
              doctor: (input) => {
                if (input.target === failedTarget) {
                  return { ok: false, checks: [{ id: `failed.${failedTarget}`, status: "fail" }] };
                }
                return doctorAgentIntegration(input);
              },
              probe: async () => {
                probeCalls += 1;
                return fakeProbe();
              },
            },
          ),
          "AGENT_INTEGRATION_DOCTOR_FAILED",
        );
        expect(probeCalls).toBe(0);
        expect(stdout).not.toHaveBeenCalled();
      } finally {
        stdout.mockRestore();
      }
    }
  });

  it("rejects installation identity drift after the one shared probe", async () => {
    let resolutions = 0;
    let probeCalls = 0;
    const drifted = {
      ...sourceInstallation,
      installation: { ...sourceInstallation.installation, sourceRevision: "ab".repeat(20) },
    };
    await expectVerifyAllError(
      agentConnectionVerificationSetTesting.execute(
        { launcher },
        {
          resolveInstallation: () => {
            resolutions += 1;
            return resolutions === 1 ? sourceInstallation : drifted;
          },
          probe: async () => {
            probeCalls += 1;
            return fakeProbe();
          },
        },
      ),
      "AGENT_VERIFY_INSTALLATION_DRIFT",
    );
    expect(resolutions).toBe(2);
    expect(probeCalls).toBe(1);
  });

  it("rejects a mismatched or linked launcher before probing", async (context) => {
    const root = fs.mkdtempSync(path.join(canonicalTempRoot, "useful-agent-verify-all-launcher-"));
    let probeCalls = 0;
    try {
      const wrong = path.join(root, "wrong.mjs");
      fs.writeFileSync(wrong, "// wrong launcher\n", "utf8");
      await expectVerifyAllError(
        agentConnectionVerificationSetTesting.execute(
          { launcher: wrong },
          { probe: async () => {
            probeCalls += 1;
            return fakeProbe();
          } },
        ),
        "AGENT_VERIFY_LAUNCHER_MISMATCH",
      );
      expect(probeCalls).toBe(0);

      const linked = path.join(root, "linked.mjs");
      try {
        fs.symlinkSync(launcher, linked, "file");
      } catch (error) {
        if (error?.code === "EPERM" || error?.code === "EACCES") {
          context.skip();
          return;
        }
        throw error;
      }
      await expectVerifyAllError(
        agentConnectionVerificationSetTesting.execute(
          { launcher: linked },
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

  it("runs the real source CLI without executing host commands or changing host config", () => {
    const root = fs.mkdtempSync(path.join(canonicalTempRoot, "useful-agent-verify-all-real-"));
    try {
      const bin = path.join(root, "bin");
      const config = path.join(root, "config");
      fs.mkdirSync(bin);
      fs.mkdirSync(path.join(config, "codex"), { recursive: true });
      fs.mkdirSync(path.join(config, "claude"), { recursive: true });
      fs.writeFileSync(path.join(config, "codex", "config.toml"), "secret-token=unchanged\n", "utf8");
      fs.writeFileSync(path.join(config, "claude", "config.json"), "{\"unchanged\":true}\n", "utf8");
      const sentinels = ["codex", "claude", "browser", "input"].map((name) => {
        const sentinel = path.join(root, `${name}-executed.txt`);
        writeSentinelCommand(bin, name, sentinel);
        return sentinel;
      });
      const before = snapshotTree(config);
      const result = runCli([
        "agent", "verify-all", "--launcher", launcher, "--json",
      ], {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        CODEX_HOME: path.join(config, "codex"),
        CLAUDE_CONFIG_DIR: path.join(config, "claude"),
        APPDATA: config,
        HOME: config,
        USERPROFILE: config,
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.endsWith("\n")).toBe(true);
      expect(result.stdout.slice(0, -1)).not.toContain("\n");
      expect(result.stdout).not.toContain("secret-token");
      const document = JSON.parse(result.stdout);
      expect(document).toMatchObject({
        ok: true,
        command: "agent verify-all",
        data: { status: "candidate-ready" },
      });
      expect(document.data.verifications.map((item) => item.connection.plan.target)).toEqual(AGENT_CONNECTION_VERIFY_ALL_TARGETS);
      expect(document.data.verifications.map((item) => item.connection.plan.scope)).toEqual(["user", "user", "user", "user"]);
      for (const verification of document.data.verifications) {
        expect(verification.connection.plan.server.env).toStrictEqual({});
      }
      expect(sentinels.every((sentinel) => !fs.existsSync(sentinel))).toBe(true);
      expect(snapshotTree(config)).toEqual(before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, CLI_TEST_TIMEOUT_MS);

  it("requires launcher/json and rejects every other or repeated flag without leaking values", () => {
    const withoutJson = runCli(["agent", "verify-all", "--launcher", launcher]);
    expect(withoutJson.status).toBe(2);
    expect(withoutJson.stdout).toBe("");
    expect(withoutJson.stderr).toContain("JSON_REQUIRED");

    const withoutLauncher = runCli(["agent", "verify-all", "--json"]);
    expect(withoutLauncher.status).toBe(2);
    expect(JSON.parse(withoutLauncher.stdout)).toMatchObject({
      command: "agent verify-all",
      error: { code: "MISSING_REQUIRED_OPTION" },
    });

    for (const option of [
      "profile", "USEFUL_PROFILE", "env", "project", "project-dir", "scope", "target",
      "apply", "install", "config", "output", "node", "argv", "cwd", "unknown",
    ]) {
      const secret = `do-not-leak-${option}`;
      const result = runCli([
        "agent", "verify-all", "--launcher", launcher, `--${option}`, secret, "--json",
      ]);
      expect(result.status).toBe(2);
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toContain(secret);
      expect(JSON.parse(result.stdout)).toMatchObject({
        command: "agent verify-all",
        error: { code: "UNKNOWN_FLAG", details: { option } },
      });
    }

    for (const repeated of [
      ["--launcher", launcher, "--launcher", launcher, "--json"],
      ["--launcher", launcher, "--json", "--json"],
    ]) {
      const result = runCli(["agent", "verify-all", ...repeated]);
      expect(result.status).toBe(2);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({ error: { code: "DUPLICATE_FLAG" } });
    }
  }, CLI_TEST_TIMEOUT_MS);
});
