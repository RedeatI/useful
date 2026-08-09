import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { HOST_ACTION_IDS } from "@useful/host-actions";

const cli = fileURLToPath(new URL("../bin/useful-runtime.mjs", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "Useful runtime host "));
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
  return { root, readRoot, writeRoot, config, configPath };
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

function hostProfile() {
  return {
    schemaVersion: "useful.agent-profile.v1",
    profileId: "host-cli",
    name: "Host CLI profile",
    actions: [{
      actionId: HOST_ACTION_IDS.VIDEO_EXPORT,
      expectedContractVersion: "1.0",
      expectedActionVersion: "1.0.0",
      expectedSourceKind: "builtin",
      expectedPublisherId: "useful.project",
      enabled: { cli: true, mcp: false },
      aliases: [],
      presets: [],
    }],
  };
}

test("--host-config registers only configured entries and derives their trusted grants", async () => {
  const fx = await fixture();
  try {
    const listed = run(["--host-config", fx.configPath, "actions", "list", "--json"]);
    assert.equal(listed.status, 0, listed.stdout);
    assert.ok(listed.json.actions.some((entry) => entry.actionId === HOST_ACTION_IDS.VIDEO_PROBE));
    assert.ok(listed.json.actions.some((entry) => entry.actionId === HOST_ACTION_IDS.VIDEO_EXPORT));

    const probe = run(
      ["--host-config", fx.configPath, "actions", "run", HOST_ACTION_IDS.VIDEO_PROBE, "--output", "json"],
      JSON.stringify({ path: "" }),
    );
    assert.equal(probe.status, 2, probe.stdout);
    assert.equal(probe.json.error.code, "INPUT_INVALID");
    assert.notEqual(probe.json.error.code, "PERMISSION_DENIED");
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("actions run requires a per-invocation --confirm for destructive host actions", async () => {
  const fx = await fixture();
  try {
    const input = JSON.stringify(exportInput(fx));
    const denied = run(
      ["--host-config", fx.configPath, "actions", "run", HOST_ACTION_IDS.VIDEO_EXPORT, "--output", "json"],
      input,
    );
    assert.equal(denied.status, 4, denied.stdout);
    assert.equal(denied.json.error.code, "CONFIRMATION_REQUIRED");

    const confirmed = run(
      ["--host-config", fx.configPath, "actions", "run", HOST_ACTION_IDS.VIDEO_EXPORT, "--confirm", "--output", "json"],
      input,
    );
    assert.equal(confirmed.status, 2, confirmed.stdout);
    assert.equal(confirmed.json.error.code, "INPUT_INVALID");
    assert.notEqual(confirmed.json.error.code, "CONFIRMATION_REQUIRED");
    assert.notEqual(confirmed.json.error.code, "PERMISSION_DENIED");
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("profile exposure neither registers host actions nor supplies confirmation", async () => {
  const fx = await fixture();
  try {
    const profilePath = path.join(fx.root, "profile.json");
    await writeFile(profilePath, JSON.stringify(hostProfile()), "utf8");

    const absent = run(["--agent-profile", profilePath, "actions", "list", "--json"]);
    assert.equal(absent.status, 4, absent.stdout);
    assert.equal(absent.json.error.code, "AGENT_PROFILE_UNKNOWN_ACTION");

    const visibleButUnconfirmed = run(
      ["--host-config", fx.configPath, "--agent-profile", profilePath, "actions", "run", HOST_ACTION_IDS.VIDEO_EXPORT, "--output", "json"],
      JSON.stringify(exportInput(fx)),
    );
    assert.equal(visibleButUnconfirmed.status, 4, visibleButUnconfirmed.stdout);
    assert.equal(visibleButUnconfirmed.json.error.code, "CONFIRMATION_REQUIRED");
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("host config arguments and unsupported overwrite fail closed", async () => {
  const fx = await fixture();
  try {
    const duplicate = run(["--host-config", fx.configPath, "--host-config", fx.configPath, "actions", "list", "--json"]);
    assert.equal(duplicate.status, 2, duplicate.stdout);
    assert.equal(duplicate.json.error.code, "USAGE");

    const misplaced = run(["actions", "list", "--host-config", fx.configPath, "--json"]);
    assert.equal(misplaced.status, 2, misplaced.stdout);
    assert.equal(misplaced.json.error.code, "USAGE");

    const overwritePath = path.join(fx.root, "overwrite.json");
    const overwrite = structuredClone(fx.config);
    overwrite.video.allowOverwrite = true;
    await writeFile(overwritePath, JSON.stringify(overwrite), "utf8");
    const rejected = run(["--host-config", overwritePath, "actions", "list", "--json"]);
    assert.equal(rejected.status, 4, rejected.stdout);
    assert.equal(rejected.json.error.code, "HOST_CONFIG_OVERWRITE_UNSUPPORTED");
    assert.ok(!rejected.stdout.includes(fx.root));
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});
