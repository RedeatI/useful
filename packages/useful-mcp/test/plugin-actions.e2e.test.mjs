import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { DISCOVERY_TOOL_NAMES } from "../src/server.mjs";

const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
const usefulCli = fileURLToPath(new URL("../../useful-cli/bin/useful.mjs", import.meta.url));
const runtimeCli = fileURLToPath(new URL("../../useful-runtime/bin/useful-runtime.mjs", import.meta.url));
const mcpCli = fileURLToPath(new URL("../bin/useful-mcp.mjs", import.meta.url));
const actionId = "com.example.signed-pipeline.base64-sha256";
const expectedDigest = "35d95694d3f160215db293c7899daa5907837838fb4b8119ed713e32446c1266";

function runJson(entry, args, input) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: workspaceRoot,
    input,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.ok(result.stdout.trim(), `expected JSON stdout; status=${result.status}; stderr=${result.stderr}`);
  return { ...result, json: JSON.parse(result.stdout) };
}

function successful(entry, args, input) {
  const result = runJson(entry, args, input);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stderr, "");
  return result.json;
}

function inheritedEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined));
}

async function connect(configPath, versionNegotiation, profilePath) {
  const client = new Client(
    { name: "plugin-action-e2e", version: "1.0.0" },
    versionNegotiation ? { versionNegotiation } : undefined,
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpCli, "--plugin-config", configPath, ...(profilePath ? ["--agent-profile", profilePath] : [])],
    cwd: workspaceRoot,
    env: inheritedEnvironment(),
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  await client.connect(transport);
  return { client, transport, stderr: () => stderr };
}

test("real CLI creates/signs a declarative action consumed by runtime and both MCP eras", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "Useful AI-4 中文 空格 "));
  try {
    const tool = path.join(root, "动作 插件");
    const out = path.join(root, "签名 产物");
    const publisher = path.join(root, "发布者 私钥");
    fs.mkdirSync(out);

    const created = successful(usefulCli, ["create", tool, "--id", "com.example.signed-pipeline", "--name", "Signed Pipeline", "--template", "minimal-action", "--json"]);
    assert.equal(created.data.actionId, actionId);
    const doctor = successful(usefulCli, ["doctor", tool, "--json"]);
    assert.equal(doctor.data.checks.find((check) => check.id === "plugin-actions")?.status, "pass");
    assert.equal(successful(usefulCli, ["validate", tool, "--json"]).data.valid, true);
    const packed = successful(usefulCli, ["pack", tool, out, "--json"]).data;
    const initialized = successful(usefulCli, ["publisher", "init", publisher, "--id", "com.example.publisher", "--name", "Example Publisher", "--json"]).data;
    const signed = successful(usefulCli, ["publisher", "sign", packed.artifactPath, "--key", initialized.privatePath, "--json"]).data;
    const verified = successful(usefulCli, ["publisher", "verify", packed.artifactPath, signed.path, "--json"]).data;
    assert.equal(verified.valid, true);
    assert.equal(verified.artifactSha256, packed.sha256);

    const configPath = path.join(root, "显式 plugin config.json");
    fs.writeFileSync(configPath, `${JSON.stringify({
      schemaVersion: "useful.plugin-set.v1",
      plugins: [{
        artifactPath: path.relative(root, packed.artifactPath),
        signaturePath: path.relative(root, signed.path),
        expectedPublisherKeyId: verified.publisherKeyId,
        expectedArtifactSha256: packed.sha256,
      }],
    }, null, 2)}\n`);

    const listed = successful(runtimeCli, ["--plugin-config", configPath, "actions", "list", "--json"]);
    assert.ok(listed.actions.some((action) => action.actionId === actionId));
    const described = successful(runtimeCli, ["--plugin-config", configPath, "actions", "describe", actionId, "--json"]);
    assert.equal(described.action.source.kind, "plugin");
    assert.equal(described.action.source.publisher.id, verified.publisherKeyId);
    assert.match(described.action.source.digest, /^[a-f0-9]{64}$/);
    const run = successful(runtimeCli, ["--plugin-config", configPath, "actions", "run", actionId, "--output", "json"], JSON.stringify({ text: "abc" }));
    assert.equal(run.output.digest, expectedDigest);
    assert.deepEqual(run.receipt.source, described.action.source);

    const profilePath = path.join(root, "显式 Agent profile.json");
    fs.writeFileSync(profilePath, `${JSON.stringify({
      schemaVersion: "useful.agent-profile.v1",
      profileId: "signed-plugin",
      name: "已签名插件最小暴露",
      actions: [{
        actionId,
        expectedContractVersion: described.action.contractVersion,
        expectedActionVersion: described.action.version,
        expectedSourceKind: "plugin",
        expectedPublisherId: verified.publisherKeyId,
        enabled: { cli: true, mcp: true },
        aliases: ["signed-pipeline"],
        presets: [],
      }],
    }, null, 2)}\n`);
    const filtered = successful(runtimeCli, ["--agent-profile", profilePath, "--plugin-config", configPath, "actions", "list", "--json"]);
    assert.deepEqual(filtered.actions.map((action) => action.actionId), [actionId]);
    assert.deepEqual(filtered.actions[0].aliases, ["signed-pipeline"]);
    const aliasRun = successful(runtimeCli, ["--plugin-config", configPath, "--agent-profile", profilePath, "actions", "run", "signed-pipeline", "--output", "json"], JSON.stringify({ text: "abc" }));
    assert.equal(aliasRun.actionId, actionId);
    assert.equal(aliasRun.output.digest, expectedDigest);

    for (const negotiation of [undefined, { mode: { pin: "2026-07-28" } }]) {
      const connection = await connect(configPath, negotiation, profilePath);
      try {
        assert.equal(connection.client.getProtocolEra(), negotiation ? "modern" : "legacy");
        const tools = await connection.client.listTools();
        assert.deepEqual(tools.tools.map((tool) => tool.name), [
          actionId,
          ...Object.values(DISCOVERY_TOOL_NAMES),
        ]);
        assert.ok(!tools.tools.some((tool) => tool.name === "signed-pipeline"));
        const result = await connection.client.callTool({ name: actionId, arguments: { text: "abc" } });
        assert.equal(result.structuredContent.digest, expectedDigest);
        assert.equal(result.isError, undefined);
        assert.equal(connection.stderr(), "");
      } finally {
        await connection.client.close();
        assert.equal(connection.transport.pid, null);
      }
    }

    const invalidConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    invalidConfig.plugins[0].expectedArtifactSha256 = "0".repeat(64);
    fs.writeFileSync(configPath, JSON.stringify(invalidConfig));
    const runtimeRejected = runJson(runtimeCli, ["--plugin-config", configPath, "actions", "list", "--json"]);
    assert.equal(runtimeRejected.status, 4);
    assert.equal(runtimeRejected.json.error.code, "ARTIFACT_PIN_MISMATCH");
    assert.equal(runtimeRejected.stderr, "");
    const mcpRejected = spawnSync(process.execPath, [mcpCli, "--plugin-config", configPath], { cwd: workspaceRoot, encoding: "utf8", windowsHide: true });
    assert.equal(mcpRejected.status, 4);
    assert.equal(mcpRejected.stdout, "");
    assert.equal(JSON.parse(mcpRejected.stderr).error.code, "ARTIFACT_PIN_MISMATCH");

    const runtimeFlag = runJson(runtimeCli, ["--unknown-config", configPath, "actions", "list", "--json"]);
    assert.equal(runtimeFlag.status, 2);
    assert.equal(runtimeFlag.json.error.code, "USAGE");
    const mcpFlag = spawnSync(process.execPath, [mcpCli, "--unknown-config", configPath], { cwd: workspaceRoot, encoding: "utf8", windowsHide: true });
    assert.equal(mcpFlag.status, 4);
    assert.equal(mcpFlag.stdout, "");
    assert.equal(JSON.parse(mcpFlag.stderr).error.code, "MCP_ARGUMENTS_INVALID");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
