import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "useful.mjs");
const launcher = path.join(path.dirname(process.execPath), "useful mcp launcher.mjs");

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
  });

  it("does not echo rejected environment values", () => {
    const secret = "DO_NOT_ECHO_AGENT_SECRET";
    const result = run("agent", "plan", "--target", "codex", "--launcher", launcher, "--env", `OPENAI_API_KEY=${secret}`, "--json");
    expect(result.status).toBe(3);
    expect(result.stdout).not.toContain(secret);
    expect(JSON.parse(result.stdout)).toMatchObject({ command: "agent plan", error: { code: "SECRET_ENVIRONMENT_FORBIDDEN" } });
  });

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
