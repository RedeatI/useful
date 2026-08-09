import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/useful-runtime.mjs", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));

function profile(overrides = {}) {
  const value = {
    schemaVersion: "useful.agent-profile.v1",
    profileId: "default",
    name: "CLI Agent 配置",
    actions: [{
      actionId: "builtin.utilities.base64",
      expectedContractVersion: "1.0",
      expectedActionVersion: "1.0.0",
      expectedSourceKind: "builtin",
      expectedPublisherId: "useful.project",
      enabled: { cli: true, mcp: false },
      aliases: ["b64-encode"],
      presets: [{ presetId: "encode", name: "UTF-8 编码", defaults: { operation: "encode" } }],
    }],
  };
  return Object.assign(value, overrides);
}

function run(args, input) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: workspaceRoot,
    input,
    encoding: "utf8",
    windowsHide: true,
  });
  return { ...result, json: JSON.parse(result.stdout) };
}

test("explicit profile filters list/describe, replaces descriptor aliases and runs controlled alias preset", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "Useful AI-5 中文 空格 "));
  try {
    const profilePath = path.join(root, "Agent 配置 profile.json");
    const requestPath = path.join(root, "请求 request.json");
    await writeFile(profilePath, `${JSON.stringify(profile(), null, 2)}\n`);
    await writeFile(requestPath, JSON.stringify({ text: "Useful 工具" }));

    const listed = run(["--agent-profile", profilePath, "actions", "list", "--json"]);
    assert.equal(listed.status, 0);
    assert.equal(listed.stderr, "");
    assert.deepEqual(listed.json.actions.map((action) => action.actionId), ["builtin.utilities.base64"]);
    assert.deepEqual(listed.json.actions[0].aliases, ["b64-encode"]);
    assert.ok(!listed.json.actions[0].aliases.includes("b64"));

    const searched = run([
      "--agent-profile", profilePath,
      "actions", "search", "--query", "base64", "--json",
    ]);
    assert.equal(searched.status, 0, searched.stdout);
    assert.deepEqual(searched.json.actions.map((action) => action.actionId), ["builtin.utilities.base64"]);
    const hiddenSearch = run([
      "--agent-profile", profilePath,
      "actions", "search", "--query", "hash", "--json",
    ]);
    assert.equal(hiddenSearch.status, 0, hiddenSearch.stdout);
    assert.deepEqual(hiddenSearch.json.actions, []);

    const described = run(["--agent-profile", profilePath, "actions", "describe", "b64-encode", "--json"]);
    assert.equal(described.status, 0);
    assert.equal(described.json.action.actionId, "builtin.utilities.base64");
    assert.deepEqual(described.json.action.aliases, ["b64-encode"]);

    const result = run([
      "--agent-profile", profilePath,
      "actions", "run", "b64-encode",
      "--preset", "encode",
      "--input", `@${requestPath}`,
      "--output", "json",
    ]);
    assert.equal(result.status, 0, result.stdout);
    assert.equal(result.stderr, "");
    assert.equal(result.json.actionId, "builtin.utilities.base64");
    assert.deepEqual(result.json.output, { text: "VXNlZnVsIOW3peWFtw==" });
    assert.equal(result.json.receipt.actionId, "builtin.utilities.base64");

    const hidden = run(["--agent-profile", profilePath, "actions", "describe", "builtin.utilities.hash", "--json"]);
    assert.equal(hidden.status, 4);
    assert.equal(hidden.json.error.code, "AGENT_PROFILE_SURFACE_DISABLED");
    const hiddenRun = run(
      ["--agent-profile", profilePath, "actions", "run", "builtin.utilities.hash", "--output", "json"],
      JSON.stringify({ algorithm: "SHA-256", text: "TOP_SECRET_DISABLED" }),
    );
    assert.equal(hiddenRun.status, 4);
    assert.equal(hiddenRun.json.error.code, "AGENT_PROFILE_SURFACE_DISABLED");
    assert.ok(!hiddenRun.stdout.includes("TOP_SECRET_DISABLED"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stale pins, invalid preset/profile and strict global flag placement fail closed without secret echo", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "Useful AI-5 policy "));
  try {
    const stalePath = path.join(root, "stale.json");
    const stale = profile();
    stale.actions[0].expectedPublisherId = "attacker.publisher";
    await writeFile(stalePath, JSON.stringify(stale));
    const staleResult = run(["--agent-profile", stalePath, "actions", "list", "--json"]);
    assert.equal(staleResult.status, 4);
    assert.equal(staleResult.stderr, "");
    assert.equal(staleResult.json.error.code, "AGENT_PROFILE_PIN_MISMATCH");
    assert.ok(!staleResult.stdout.includes("attacker.publisher"));

    const invalidPath = path.join(root, "invalid.json");
    await writeFile(invalidPath, '{"schemaVersion":"useful.agent-profile.v1","unknown":true}');
    const invalidProfile = run(["--agent-profile", invalidPath, "actions", "list", "--json"]);
    assert.equal(invalidProfile.status, 4);
    assert.equal(invalidProfile.stderr, "");
    assert.equal(invalidProfile.json.error.code, "AGENT_PROFILE_INVALID");

    const validPath = path.join(root, "valid.json");
    await writeFile(validPath, JSON.stringify(profile()));
    const missingPreset = run(
      ["--agent-profile", validPath, "actions", "run", "builtin.utilities.base64", "--preset", "missing"],
      JSON.stringify({ text: "TOP_SECRET_INPUT" }),
    );
    assert.equal(missingPreset.status, 4);
    assert.equal(missingPreset.json.error.code, "AGENT_PROFILE_PRESET_UNKNOWN");
    assert.ok(!missingPreset.stdout.includes("TOP_SECRET_INPUT"));

    for (const args of [
      ["--agent-profile", validPath, "--agent-profile", validPath, "actions", "list", "--json"],
      ["actions", "list", "--agent-profile", validPath, "--json"],
      ["actions", "run", "builtin.utilities.base64", "--preset", "encode"],
    ]) {
      const invalid = run(args, "{}");
      assert.equal(invalid.status, 2);
      assert.equal(invalid.json.error.code, "USAGE");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("profile action order is preserved by CLI list", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "Useful AI profile order "));
  try {
    const ordered = profile();
    const base64 = ordered.actions[0];
    ordered.actions = [{
      ...structuredClone(base64),
      actionId: "builtin.utilities.hash",
      aliases: [],
      presets: [],
    }, base64];
    const profilePath = path.join(root, "ordered.json");
    await writeFile(profilePath, `${JSON.stringify(ordered, null, 2)}\n`);

    const listed = run(["--agent-profile", profilePath, "actions", "list", "--json"]);
    assert.equal(listed.status, 0, listed.stdout);
    assert.deepEqual(
      listed.json.actions.map((action) => action.actionId),
      ["builtin.utilities.hash", "builtin.utilities.base64"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
