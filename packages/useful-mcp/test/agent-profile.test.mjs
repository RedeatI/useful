import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { DISCOVERY_TOOL_NAMES } from "../src/server.mjs";

const entry = fileURLToPath(new URL("../bin/useful-mcp.mjs", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));

function environment() {
  return Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined));
}

function profile(publisher = "useful.project", actionVersion = "1.0.0") {
  return {
    schemaVersion: "useful.agent-profile.v1",
    profileId: "mcp-only",
    name: "MCP canonical profile",
    actions: [{
      actionId: "builtin.utilities.base64",
      expectedContractVersion: "1.0",
      expectedActionVersion: actionVersion,
      expectedSourceKind: "builtin",
      expectedPublisherId: publisher,
      enabled: { cli: false, mcp: true },
      aliases: ["b64-encode"],
      presets: [{ presetId: "encode", name: "encode", defaults: { operation: "encode" } }],
    }],
  };
}

async function connect(profilePath, versionNegotiation) {
  const client = new Client(
    { name: "agent-profile-mcp-test", version: "1.0.0" },
    versionNegotiation ? { versionNegotiation } : undefined,
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, "--agent-profile", profilePath],
    cwd: workspaceRoot,
    env: environment(),
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  await client.connect(transport);
  return { client, transport, stderr: () => stderr };
}

test("both official MCP eras expose canonical enabled identities only; aliases and presets do not become tools", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "Useful MCP 中文 空格 "));
  try {
    const profilePath = path.join(root, "Agent profile.json");
    await writeFile(profilePath, `${JSON.stringify(profile(), null, 2)}\n`);
    for (const negotiation of [undefined, { mode: { pin: "2026-07-28" } }]) {
      const connection = await connect(profilePath, negotiation);
      try {
        assert.equal(connection.client.getProtocolEra(), negotiation ? "modern" : "legacy");
        const listed = await connection.client.listTools();
        assert.deepEqual(listed.tools.map((tool) => tool.name), [
          "builtin.utilities.base64",
          ...Object.values(DISCOVERY_TOOL_NAMES),
        ]);
        assert.ok(!listed.tools.some((tool) => tool.name === "b64-encode" || tool.name.includes("encode")));
        const called = await connection.client.callTool({
          name: "builtin.utilities.base64",
          arguments: { operation: "encode", text: "Useful 工具" },
        });
        assert.deepEqual(called.structuredContent, { text: "VXNlZnVsIOW3peWFtw==" });
        const searched = await connection.client.callTool({
          name: DISCOVERY_TOOL_NAMES.SEARCH,
          arguments: { query: "base64" },
        });
        assert.deepEqual(searched.structuredContent.actions.map((action) => action.actionId), ["builtin.utilities.base64"]);
        const hiddenSearch = await connection.client.callTool({
          name: DISCOVERY_TOOL_NAMES.SEARCH,
          arguments: { query: "hash" },
        });
        assert.deepEqual(hiddenSearch.structuredContent.actions, []);
        const hiddenSuggestion = await connection.client.callTool({
          name: DISCOVERY_TOOL_NAMES.SUGGEST,
          arguments: { text: '{"a":1}' },
        });
        assert.deepEqual(hiddenSuggestion.structuredContent.suggestions, []);
        const hiddenRecipe = await connection.client.callTool({
          name: DISCOVERY_TOOL_NAMES.RECIPE,
          arguments: {
            operation: "validate",
            recipe: {
              schemaVersion: "useful.action-recipe.v1",
              steps: [{ id: "hash", actionId: "builtin.utilities.hash", input: { algorithm: "SHA-256", text: "x" } }],
              output: { $ref: "/steps/hash/output" },
            },
          },
        });
        assert.equal(hiddenRecipe.isError, true);
        assert.equal(JSON.parse(hiddenRecipe.content[0].text).error.code, "ACTION_RECIPE_UNKNOWN_ACTION");
        await assert.rejects(
          connection.client.callTool({ name: "b64-encode", arguments: { text: "TOP_SECRET_ALIAS" } }),
          (error) => error.code === -32602 && !error.message.includes("TOP_SECRET_ALIAS"),
        );
        await assert.rejects(
          connection.client.callTool({ name: "builtin.utilities.hash", arguments: { text: "TOP_SECRET_DISABLED" } }),
          (error) => error.code === -32602 && !error.message.includes("TOP_SECRET_DISABLED"),
        );
        assert.equal(connection.stderr(), "");
      } finally {
        await connection.client.close();
        assert.equal(connection.transport.pid, null);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("profile action order is preserved by MCP tool registration", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "Useful MCP profile order "));
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
    const connection = await connect(profilePath);
    try {
      const listed = await connection.client.listTools();
      assert.deepEqual(
        listed.tools.slice(0, 2).map((tool) => tool.name),
        ["builtin.utilities.hash", "builtin.utilities.base64"],
      );
    } finally {
      await connection.client.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid/stale MCP profile exits before server registration with empty stdout and fixed stderr code", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "Useful MCP invalid "));
  try {
    const stalePath = path.join(root, "stale.json");
    await writeFile(stalePath, JSON.stringify(profile("wrong.publisher")));
    const stale = spawnSync(process.execPath, [entry, "--agent-profile", stalePath], {
      cwd: workspaceRoot, encoding: "utf8", windowsHide: true,
    });
    assert.equal(stale.status, 4);
    assert.equal(stale.stdout, "");
    assert.deepEqual(JSON.parse(stale.stderr), { ok: false, error: { code: "AGENT_PROFILE_PIN_MISMATCH" } });
    assert.ok(!stale.stderr.includes("wrong.publisher"));

    const staleVersionPath = path.join(root, "stale-version.json");
    await writeFile(staleVersionPath, JSON.stringify(profile("useful.project", "9.0.0")));
    const staleVersion = spawnSync(process.execPath, [entry, "--agent-profile", staleVersionPath], {
      cwd: workspaceRoot, encoding: "utf8", windowsHide: true,
    });
    assert.equal(staleVersion.status, 4);
    assert.equal(staleVersion.stdout, "");
    assert.deepEqual(JSON.parse(staleVersion.stderr), { ok: false, error: { code: "AGENT_PROFILE_PIN_MISMATCH" } });

    const duplicate = spawnSync(process.execPath, [entry, "--agent-profile", stalePath, "--agent-profile", stalePath], {
      cwd: workspaceRoot, encoding: "utf8", windowsHide: true,
    });
    assert.equal(duplicate.status, 4);
    assert.equal(duplicate.stdout, "");
    assert.deepEqual(JSON.parse(duplicate.stderr), { ok: false, error: { code: "MCP_ARGUMENTS_INVALID" } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
