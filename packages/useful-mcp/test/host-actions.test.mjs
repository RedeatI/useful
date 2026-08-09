import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { ActionExecutor, ActionRegistry } from "@useful/action-runtime";
import { createHostActionEntries, HOST_ACTION_IDS, loadHostActionConfig } from "@useful/host-actions";
import { createActionToolHandler, DISCOVERY_TOOL_NAMES } from "../src/server.mjs";

const entry = fileURLToPath(new URL("../bin/useful-mcp.mjs", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));

function environment() {
  return Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined));
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "Useful MCP host "));
  const readRoot = path.join(root, "read");
  const writeRoot = path.join(root, "write");
  await mkdir(readRoot);
  await mkdir(writeRoot);
  const config = {
    schemaVersion: "useful.host-actions.v1",
    ffmpegPath: process.execPath,
    ffprobePath: process.execPath,
    readRoots: [readRoot],
    writeRoots: [writeRoot],
    enabled: { videoProbe: true, videoExport: true, processSnapshot: false, processTerminate: false },
    video: {
      allowOverwrite: false,
      maxDurationSec: 60,
      maxProbeOutputBytes: 1024 * 1024,
      videoCodecs: ["copy"],
      audioCodecs: ["copy"],
    },
    process: { fields: ["pid", "startTime"], maxProcesses: 16, maxOutputBytes: 1024 * 1024 },
  };
  const configPath = path.join(root, "host-actions.json");
  await writeFile(configPath, `${JSON.stringify(config)}\n`, "utf8");
  return { root, readRoot, writeRoot, configPath };
}

function hostProfile() {
  return {
    schemaVersion: "useful.agent-profile.v1",
    profileId: "host-mcp",
    name: "Host MCP profile",
    actions: [{
      actionId: HOST_ACTION_IDS.VIDEO_EXPORT,
      expectedContractVersion: "1.0",
      expectedActionVersion: "1.0.0",
      expectedSourceKind: "builtin",
      expectedPublisherId: "useful.project",
      enabled: { cli: false, mcp: true },
      aliases: [],
      presets: [],
    }],
  };
}

function exportInput(fx) {
  return {
    inputPath: path.join(fx.readRoot, "input.mp4"),
    outputPath: path.join(fx.writeRoot, "output.mp4"),
    startSec: 2,
    endSec: 1,
    videoCodec: "copy",
    audioCodec: "copy",
  };
}

async function connect(args) {
  const client = new Client({ name: "useful-host-actions-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, ...args],
    cwd: workspaceRoot,
    env: environment(),
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  await client.connect(transport);
  return { client, transport, stderr: () => stderr };
}

function errorCode(result) {
  assert.equal(result.isError, true);
  const block = result.content.find((item) => item.type === "text");
  assert.ok(block);
  return JSON.parse(block.text).error.code;
}

test("MCP --host-config discovers host entries and grants only read-only execution", async () => {
  const fx = await fixture();
  const connection = await connect(["--host-config", fx.configPath]);
  try {
    const listed = await connection.client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    assert.ok(names.includes(HOST_ACTION_IDS.VIDEO_PROBE));
    assert.ok(names.includes(HOST_ACTION_IDS.VIDEO_EXPORT));
    assert.ok(names.includes(DISCOVERY_TOOL_NAMES.SEARCH));

    const searched = await connection.client.callTool({
      name: DISCOVERY_TOOL_NAMES.SEARCH,
      arguments: { query: "video probe" },
    });
    assert.ok(searched.structuredContent.actions.some((action) => action.actionId === HOST_ACTION_IDS.VIDEO_PROBE));

    const probe = await connection.client.callTool({
      name: HOST_ACTION_IDS.VIDEO_PROBE,
      arguments: { path: "" },
    });
    assert.equal(errorCode(probe), "INPUT_INVALID");

    const destructive = await connection.client.callTool({
      name: HOST_ACTION_IDS.VIDEO_EXPORT,
      arguments: exportInput(fx),
    });
    assert.equal(errorCode(destructive), "CONFIRMATION_REQUIRED");
    assert.equal(connection.stderr(), "");
  } finally {
    await connection.client.close();
    assert.equal(connection.transport.pid, null);
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("trusted execution-policy seam is injectable while its default supplies no confirmation", async () => {
  const fx = await fixture();
  try {
    const entries = createHostActionEntries(await loadHostActionConfig(fx.configPath));
    const exportEntry = entries.find((item) => item.descriptor.actionId === HOST_ACTION_IDS.VIDEO_EXPORT);
    const executor = new ActionExecutor(new ActionRegistry(entries));
    const input = exportInput(fx);

    const defaultResult = await createActionToolHandler(HOST_ACTION_IDS.VIDEO_EXPORT, executor)(input, {});
    assert.equal(errorCode(defaultResult), "CONFIRMATION_REQUIRED");

    let request;
    const policyResult = await createActionToolHandler(
      HOST_ACTION_IDS.VIDEO_EXPORT,
      executor,
      (value) => {
        request = value;
        return {
          grantedPermissions: [...exportEntry.descriptor.permissions.required],
          grantedCapabilities: [...exportEntry.descriptor.permissions.capabilities],
          confirmed: true,
        };
      },
      exportEntry.descriptor,
    )(input, {});
    assert.deepEqual(
      { actionId: request.actionId, surface: request.surface, descriptorId: request.descriptor.actionId },
      { actionId: HOST_ACTION_IDS.VIDEO_EXPORT, surface: "mcp", descriptorId: HOST_ACTION_IDS.VIDEO_EXPORT },
    );
    assert.equal(errorCode(policyResult), "INPUT_INVALID");
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("profile exposure cannot register or confirm a destructive host action", async () => {
  const fx = await fixture();
  try {
    const profilePath = path.join(fx.root, "profile.json");
    await writeFile(profilePath, JSON.stringify(hostProfile()), "utf8");

    const absent = spawnSync(process.execPath, [entry, "--agent-profile", profilePath], {
      cwd: workspaceRoot,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(absent.status, 4);
    assert.equal(absent.stdout, "");
    assert.deepEqual(JSON.parse(absent.stderr), { ok: false, error: { code: "AGENT_PROFILE_UNKNOWN_ACTION" } });

    const connection = await connect(["--host-config", fx.configPath, "--agent-profile", profilePath]);
    try {
      const listed = await connection.client.listTools();
      assert.deepEqual(listed.tools.map((tool) => tool.name), [
        HOST_ACTION_IDS.VIDEO_EXPORT,
        ...Object.values(DISCOVERY_TOOL_NAMES),
      ]);
      const result = await connection.client.callTool({
        name: HOST_ACTION_IDS.VIDEO_EXPORT,
        arguments: exportInput(fx),
      });
      assert.equal(errorCode(result), "CONFIRMATION_REQUIRED");
    } finally {
      await connection.client.close();
    }
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("MCP rejects duplicate host config flags before starting stdio", async () => {
  const fx = await fixture();
  try {
    const result = spawnSync(process.execPath, [entry, "--host-config", fx.configPath, "--host-config", fx.configPath], {
      cwd: workspaceRoot,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.status, 4);
    assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr), { ok: false, error: { code: "MCP_ARGUMENTS_INVALID" } });
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});
