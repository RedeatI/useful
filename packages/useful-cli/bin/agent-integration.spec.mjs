import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "useful.mjs");
const launcher = path.join(path.dirname(process.execPath), "useful mcp launcher.mjs");
const CLI_TEST_TIMEOUT_MS = 30_000;

function run(...args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}

describe("useful agent integration CLI", () => {
  it("writes one clean JSON document for a plan", () => {
    const result = run("agent", "plan", "--target", "claude-desktop", "--launcher", launcher, "--scope", "user", "--env", "NO_COLOR=1", "--json");
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const document = JSON.parse(result.stdout);
    expect(document.ok).toBe(true);
    expect(document.command).toBe("agent plan");
    expect(document.data.plan.transport).toBe("stdio");
    expect(document.data.output.mergeFragment.mcpServers.useful.args).toEqual([launcher]);
    expect(document.data.output.writesHostConfigWhenExecuted).toBe(false);
  });

  it("exports one deterministic connection document without host-side effects", () => {
    const args = ["agent", "export", "--target", "claude-desktop", "--launcher", launcher, "--scope", "user", "--env", "NO_COLOR=1", "--json"];
    const first = run(...args);
    const second = run(...args);
    expect(first.status).toBe(0);
    expect(first.stderr).toBe("");
    expect(first.stdout).toBe(second.stdout);
    expect(first.stdout.endsWith("\n")).toBe(true);
    expect(first.stdout.slice(0, -1)).not.toContain("\n");
    const document = JSON.parse(first.stdout);
    expect(document).toMatchObject({
      ok: true,
      command: "agent export",
      data: {
        schemaVersion: "useful.agent-connection.v1",
        kind: "mcp-stdio-connection",
        writePolicy: "manual-review-only",
        secretPolicy: "no-secrets",
        hostPlatform: process.platform,
        plan: { target: "claude-desktop" },
      },
    });
    expect(JSON.stringify(document.data)).not.toMatch(/createdAt|generatedAt|hostname|release|nodeVersion|cwd/i);
  }, CLI_TEST_TIMEOUT_MS);

  it("exports all four target shapes with a canonical host platform binding", () => {
    for (const target of ["codex", "claude-code", "claude-desktop", "mcp-servers-json"]) {
      const result = run("agent", "export", "--target", target, "--launcher", launcher, "--json");
      expect(result.status).toBe(0);
      const connection = JSON.parse(result.stdout).data;
      expect(connection.hostPlatform).toBe(process.platform);
      expect(connection.plan.target).toBe(target);
      if (target === "codex" || target === "claude-code") {
        expect(connection.output.kind).toBe("host-command");
      } else {
        expect(connection.output).toMatchObject({ kind: "merge-fragment", format: "json" });
      }
    }
  }, CLI_TEST_TIMEOUT_MS);

  it("rejects unknown targets and writing options with JSON-only failures", () => {
    const unknown = run("agent", "plan", "--target", "other", "--launcher", launcher, "--json");
    expect(unknown.status).toBe(3);
    expect(JSON.parse(unknown.stdout)).toMatchObject({ command: "agent plan", error: { code: "UNKNOWN_TARGET" } });
    const apply = run("agent", "plan", "--target", "codex", "--launcher", launcher, "--apply", "--json");
    expect(apply.status).toBe(2);
    expect(JSON.parse(apply.stdout).error.code).toBe("APPLY_NOT_SUPPORTED");
    const duplicate = run("agent", "plan", "--target", "codex", "--target", "claude-code", "--launcher", launcher, "--json");
    expect(duplicate.status).toBe(2);
    expect(JSON.parse(duplicate.stdout).error.code).toBe("DUPLICATE_FLAG");
    for (const option of ["--output", "--out", "--output-path", "--config-path"]) {
      const outputPath = run("agent", "export", "--target", "codex", "--launcher", launcher, option, "ignored.json", "--json");
      expect(outputPath.status).toBe(2);
      expect(JSON.parse(outputPath.stdout).error.code).toBe("OUTPUT_PATH_NOT_SUPPORTED");
    }
  }, CLI_TEST_TIMEOUT_MS);

  it("does not echo rejected environment values", () => {
    const secret = "DO_NOT_ECHO_AGENT_SECRET";
    const result = run("agent", "plan", "--target", "codex", "--launcher", launcher, "--env", `OPENAI_API_KEY=${secret}`, "--json");
    expect(result.status).toBe(3);
    expect(result.stdout).not.toContain(secret);
    expect(JSON.parse(result.stdout)).toMatchObject({ command: "agent plan", error: { code: "SECRET_ENVIRONMENT_FORBIDDEN" } });
  });

  it("export rejects secret environment values without echoing them", () => {
    const secret = "DO_NOT_ECHO_EXPORTED_AGENT_SECRET";
    const result = run("agent", "export", "--target", "mcp-servers-json", "--launcher", launcher, "--env", `ACCESS_TOKEN=${secret}`, "--json");
    expect(result.status).toBe(3);
    expect(result.stdout).not.toContain(secret);
    expect(JSON.parse(result.stdout)).toMatchObject({ command: "agent export", error: { code: "SECRET_ENVIRONMENT_FORBIDDEN" } });
  }, CLI_TEST_TIMEOUT_MS);

  it("requires an explicit project directory for project scope", () => {
    const result = run("agent", "plan", "--target", "claude-code", "--launcher", launcher, "--scope", "project", "--json");
    expect(result.status).toBe(3);
    expect(JSON.parse(result.stdout).error.code).toBe("MISSING_REQUIRED_VALUE");
  });

  it("doctor returns a nonzero JSON failure for a missing launcher", () => {
    const missing = path.join(path.dirname(process.execPath), "does-not-exist-useful-mcp.mjs");
    const result = run("agent", "doctor", "--target", "mcp-servers-json", "--launcher", missing, "--json");
    expect(result.status).toBe(3);
    const document = JSON.parse(result.stdout);
    expect(document.error.code).toBe("AGENT_INTEGRATION_DOCTOR_FAILED");
    expect(document.data.ok).toBe(false);
    expect(document.data.plan).toBeUndefined();
  });
});
