import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { ActionRegistry } from "@useful/action-runtime";
import {
  HOST_ACTION_IDS,
  HostActionError,
  createHostActionEntries,
  loadHostActionConfig,
} from "../src/index.mjs";

const temporaryRoots = [];

after(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(overrides = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "useful host actions ")));
  temporaryRoots.push(root);
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
      maxDurationSec: 3600,
      maxProbeOutputBytes: 1024 * 1024,
      videoCodecs: ["copy", "libx264"],
      audioCodecs: ["copy", "aac"],
    },
    process: { fields: ["pid", "startTime", "name"], maxProcesses: 128, maxOutputBytes: 1024 * 1024 },
    ...overrides,
  };
  const configPath = path.join(root, "host-actions.json");
  await writeFile(configPath, `${JSON.stringify(config)}\n`, "utf8");
  return { root, readRoot, writeRoot, config, configPath };
}

async function writeConfig(configPath, config) {
  await writeFile(configPath, `${JSON.stringify(config)}\n`, "utf8");
}

test("JSON Schema and hand validator agree on explicit host policy vectors", async () => {
  const Ajv2020 = (await import("ajv/dist/2020.js")).default;
  const schema = JSON.parse(await readFile(new URL("../src/useful.host-actions.v1.schema.json", import.meta.url), "utf8"));
  const validateSchema = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.$id, "https://schemas.useful.local/host/useful.host-actions.v1.schema.json");

  const vectors = [
    {
      name: "both video actions enabled",
      schemaValid: true,
      handValid: true,
      mutate() {},
    },
    {
      name: "all actions disabled without video policy or roots",
      schemaValid: true,
      handValid: true,
      mutate(candidate) {
        candidate.enabled = { videoProbe: false, videoExport: false, processSnapshot: false, processTerminate: false };
        candidate.readRoots = [];
        candidate.writeRoots = [];
        delete candidate.ffmpegPath;
        delete candidate.ffprobePath;
        delete candidate.video;
      },
    },
    {
      name: "probe-only requires no ffmpeg or write root",
      schemaValid: true,
      handValid: true,
      mutate(candidate) {
        candidate.enabled.videoExport = false;
        candidate.writeRoots = [];
        delete candidate.ffmpegPath;
      },
    },
    {
      name: "export-only requires no ffprobe",
      schemaValid: true,
      handValid: true,
      mutate(candidate) {
        candidate.enabled.videoProbe = false;
        delete candidate.ffprobePath;
      },
    },
    {
      name: "closed process policy accepts exact lower limits",
      schemaValid: true,
      handValid: true,
      mutate(candidate) {
        candidate.process = { fields: ["pid", "startTime"], maxProcesses: 1, maxOutputBytes: 4096 };
      },
    },
    {
      name: "closed process policy accepts exact upper limits",
      schemaValid: true,
      handValid: true,
      mutate(candidate) {
        candidate.process = { fields: ["pid", "startTime", "name"], maxProcesses: 10000, maxOutputBytes: 16777216 };
      },
    },
    {
      name: "probe rejects missing video policy",
      schemaValid: false,
      handCode: "HOST_CONFIG_INVALID",
      mutate(candidate) { delete candidate.video; },
    },
    {
      name: "probe rejects missing ffprobe path",
      schemaValid: false,
      handCode: "HOST_CONFIG_INVALID",
      mutate(candidate) { delete candidate.ffprobePath; },
    },
    {
      name: "probe rejects empty read roots",
      schemaValid: false,
      handCode: "HOST_CONFIG_INVALID",
      mutate(candidate) { candidate.readRoots = []; },
    },
    {
      name: "export rejects missing video policy",
      schemaValid: false,
      handCode: "HOST_CONFIG_INVALID",
      mutate(candidate) {
        candidate.enabled.videoProbe = false;
        delete candidate.video;
      },
    },
    {
      name: "export rejects missing ffmpeg path",
      schemaValid: false,
      handCode: "HOST_CONFIG_INVALID",
      mutate(candidate) { delete candidate.ffmpegPath; },
    },
    {
      name: "export rejects empty read roots",
      schemaValid: false,
      handCode: "HOST_CONFIG_INVALID",
      mutate(candidate) { candidate.readRoots = []; },
    },
    {
      name: "export rejects empty write roots",
      schemaValid: false,
      handCode: "HOST_CONFIG_INVALID",
      mutate(candidate) { candidate.writeRoots = []; },
    },
    {
      name: "overwrite opt-in has a dedicated hand-validator error",
      schemaValid: false,
      handCode: "HOST_CONFIG_OVERWRITE_UNSUPPORTED",
      mutate(candidate) { candidate.video.allowOverwrite = true; },
    },
    {
      name: "process policy rejects unknown fields",
      schemaValid: false,
      handCode: "HOST_CONFIG_INVALID",
      mutate(candidate) { candidate.process.command = "tasklist"; },
    },
    {
      name: "process fields require pid",
      schemaValid: false,
      handCode: "HOST_CONFIG_INVALID",
      mutate(candidate) { candidate.process.fields = ["startTime", "name"]; },
    },
    {
      name: "process fields require startTime",
      schemaValid: false,
      handCode: "HOST_CONFIG_INVALID",
      mutate(candidate) { candidate.process.fields = ["pid", "name"]; },
    },
    {
      name: "process fields reject duplicates",
      schemaValid: false,
      handCode: "HOST_CONFIG_INVALID",
      mutate(candidate) { candidate.process.fields = ["pid", "startTime", "pid"]; },
    },
    {
      name: "process count rejects below lower limit",
      schemaValid: false,
      handCode: "HOST_CONFIG_INVALID",
      mutate(candidate) { candidate.process.maxProcesses = 0; },
    },
    {
      name: "process count rejects above upper limit",
      schemaValid: false,
      handCode: "HOST_CONFIG_INVALID",
      mutate(candidate) { candidate.process.maxProcesses = 10001; },
    },
    {
      name: "process output rejects below lower limit",
      schemaValid: false,
      handCode: "HOST_CONFIG_INVALID",
      mutate(candidate) { candidate.process.maxOutputBytes = 4095; },
    },
    {
      name: "process output rejects above upper limit",
      schemaValid: false,
      handCode: "HOST_CONFIG_INVALID",
      mutate(candidate) { candidate.process.maxOutputBytes = 16777217; },
    },
  ];

  for (const vector of vectors) {
    const fx = await fixture();
    const candidate = structuredClone(fx.config);
    vector.mutate(candidate, fx);
    const schemaValid = validateSchema(candidate);
    assert.equal(schemaValid, vector.schemaValid, `${vector.name}: ${JSON.stringify(validateSchema.errors)}`);
    await writeConfig(fx.configPath, candidate);
    if (vector.handValid) {
      await assert.doesNotReject(loadHostActionConfig(fx.configPath), vector.name);
    } else {
      await assert.rejects(
        loadHostActionConfig(fx.configPath),
        (error) => error instanceof HostActionError && error.code === vector.handCode,
        vector.name,
      );
    }
  }
});

test("schema leaves absolute paths and filesystem executability to the runtime boundary", async () => {
  const Ajv2020 = (await import("ajv/dist/2020.js")).default;
  const schema = JSON.parse(await readFile(new URL("../src/useful.host-actions.v1.schema.json", import.meta.url), "utf8"));
  const validateSchema = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  const vectors = [
    {
      name: "relative root is a runtime document error",
      handCode: "HOST_CONFIG_INVALID",
      mutate(candidate) { candidate.readRoots = ["relative"]; },
    },
    {
      name: "missing read root is a runtime filesystem error",
      handCode: "HOST_CONFIG_READ_ROOT_INVALID",
      mutate(candidate, fx) { candidate.readRoots = [path.join(fx.root, "missing-read-root")]; },
    },
    {
      name: "directory cannot stand in for executable file",
      handCode: "HOST_CONFIG_FFPROBE_INVALID",
      mutate(candidate, fx) { candidate.ffprobePath = fx.root; },
    },
  ];

  for (const vector of vectors) {
    const fx = await fixture();
    const candidate = structuredClone(fx.config);
    vector.mutate(candidate, fx);
    assert.equal(validateSchema(candidate), true, `${vector.name}: ${JSON.stringify(validateSchema.errors)}`);
    await writeConfig(fx.configPath, candidate);
    await assert.rejects(
      loadHostActionConfig(fx.configPath),
      (error) => error instanceof HostActionError && error.code === vector.handCode,
      vector.name,
    );
  }
});

test("strict config loads canonical policy and produces registerable enabled entries", async () => {
  const fx = await fixture();
  const config = await loadHostActionConfig(fx.configPath);
  assert.ok(Object.isFrozen(config));
  assert.deepEqual(config.readRoots, [fx.readRoot]);
  const entries = createHostActionEntries(config);
  const registry = new ActionRegistry(entries);
  assert.deepEqual(entries.map((entry) => entry.descriptor.actionId), [HOST_ACTION_IDS.VIDEO_PROBE, HOST_ACTION_IDS.VIDEO_EXPORT]);
  assert.deepEqual(registry.list().map((entry) => entry.actionId), [HOST_ACTION_IDS.VIDEO_EXPORT, HOST_ACTION_IDS.VIDEO_PROBE]);
  assert.equal(entries[0].descriptor.execution.mode, "host");
  assert.equal(entries[1].descriptor.behavior.destructive, true);
  assert.equal(entries[1].descriptor.behavior.requiresConfirmation, true);
});

test("probe-only config requires ffprobe but does not require ffmpeg", async () => {
  const fx = await fixture({
    ffmpegPath: undefined,
    writeRoots: [],
    enabled: { videoProbe: true, videoExport: false, processSnapshot: false, processTerminate: false },
  });
  const config = await loadHostActionConfig(fx.configPath);
  const entries = createHostActionEntries(config);
  assert.deepEqual(entries.map((entry) => entry.descriptor.actionId), [HOST_ACTION_IDS.VIDEO_PROBE]);
});

test("overwrite opt-in fails closed on every platform", async () => {
  const fx = await fixture({
    video: {
      allowOverwrite: true,
      maxDurationSec: 3600,
      maxProbeOutputBytes: 1024 * 1024,
      videoCodecs: ["copy", "libx264"],
      audioCodecs: ["copy", "aac"],
    },
  });
  await assert.rejects(
    loadHostActionConfig(fx.configPath),
    (error) => error instanceof HostActionError && error.code === "HOST_CONFIG_OVERWRITE_UNSUPPORTED",
  );
});

test("config rejects unknown fields, relative roots, duplicates, and unloaded objects", async () => {
  const unknown = await fixture({ command: "ffmpeg -version" });
  await assert.rejects(loadHostActionConfig(unknown.configPath), (error) => error.code === "HOST_CONFIG_INVALID");

  const relative = await fixture({ readRoots: ["relative"] });
  await assert.rejects(loadHostActionConfig(relative.configPath), (error) => error.code === "HOST_CONFIG_INVALID");

  const duplicateBase = await fixture();
  duplicateBase.config.readRoots = [duplicateBase.readRoot, duplicateBase.readRoot];
  await writeFile(duplicateBase.configPath, JSON.stringify(duplicateBase.config), "utf8");
  await assert.rejects(loadHostActionConfig(duplicateBase.configPath), (error) => ["HOST_CONFIG_INVALID", "HOST_CONFIG_DUPLICATE_ROOT"].includes(error.code));

  assert.throws(() => createHostActionEntries({ schemaVersion: "useful.host-actions.v1" }), (error) => error.code === "HOST_CONFIG_NOT_LOADED");
});

test("symlink config and executable paths are rejected", async (t) => {
  const fx = await fixture();
  const configLink = path.join(fx.root, "config-link.json");
  try { await symlink(fx.configPath, configLink, "file"); } catch { t.skip("symlink creation unavailable"); return; }
  await assert.rejects(loadHostActionConfig(configLink), (error) => error.code === "HOST_CONFIG_NOT_REGULAR_FILE");

  const executableLink = path.join(fx.root, process.platform === "win32" ? "ffprobe-link.exe" : "ffprobe-link");
  await symlink(process.execPath, executableLink, "file");
  fx.config.ffprobePath = executableLink;
  await writeFile(fx.configPath, JSON.stringify(fx.config), "utf8");
  await assert.rejects(loadHostActionConfig(fx.configPath), (error) => error.code === "HOST_CONFIG_FFPROBE_INVALID");
});

test("read and write paths cannot escape configured roots and overwrite defaults closed", async () => {
  const fx = await fixture();
  const outside = path.join(fx.root, "outside.mp4");
  const inside = path.join(fx.readRoot, "inside.mp4");
  const existing = path.join(fx.writeRoot, "existing.mp4");
  await writeFile(outside, "outside", "utf8");
  await writeFile(inside, "inside", "utf8");
  await writeFile(existing, "existing", "utf8");
  const entries = createHostActionEntries(await loadHostActionConfig(fx.configPath));
  const probe = entries.find((entry) => entry.descriptor.actionId === HOST_ACTION_IDS.VIDEO_PROBE);
  const exportAction = entries.find((entry) => entry.descriptor.actionId === HOST_ACTION_IDS.VIDEO_EXPORT);
  await assert.rejects(probe.handler({ path: outside }), (error) => error.code === "READ_PATH_OUTSIDE_ALLOWED_ROOT" && !error.message.includes(outside));
  await assert.rejects(exportAction.handler({ inputPath: inside, outputPath: existing, startSec: 0, endSec: 1, videoCodec: "copy", audioCodec: "copy" }), (error) => error.code === "OUTPUT_EXISTS");
});

test("process snapshot uses only configured minimal fields and limit", async (t) => {
  if (!["win32", "linux", "darwin"].includes(process.platform)) { t.skip("unsupported platform"); return; }
  const fx = await fixture({
    ffmpegPath: undefined,
    ffprobePath: undefined,
    readRoots: [],
    writeRoots: [],
    enabled: { videoProbe: false, videoExport: false, processSnapshot: true, processTerminate: false },
    video: undefined,
    process: { fields: ["pid", "startTime"], maxProcesses: 5, maxOutputBytes: 1024 * 1024 },
  });
  const raw = JSON.parse(await readFile(fx.configPath, "utf8"));
  delete raw.ffmpegPath;
  delete raw.ffprobePath;
  delete raw.video;
  await writeFile(fx.configPath, JSON.stringify(raw), "utf8");
  const entry = createHostActionEntries(await loadHostActionConfig(fx.configPath))[0];
  const output = await entry.handler({});
  assert.ok(output.processes.length <= 5);
  assert.ok(output.processes.every((item) => Object.keys(item).join(",") === "pid,startTime"));
  assert.deepEqual(entry.descriptor.sensitive.output, [""]);
});

test("POSIX terminate enablement fails closed instead of using a PID-only fallback", async (t) => {
  if (process.platform === "win32") { t.skip("Windows has the start-time checked implementation"); return; }
  const fx = await fixture({
    ffmpegPath: undefined,
    ffprobePath: undefined,
    readRoots: [],
    writeRoots: [],
    enabled: { videoProbe: false, videoExport: false, processSnapshot: false, processTerminate: true },
    video: undefined,
  });
  const raw = JSON.parse(await readFile(fx.configPath, "utf8"));
  delete raw.ffmpegPath;
  delete raw.ffprobePath;
  delete raw.video;
  await writeFile(fx.configPath, JSON.stringify(raw), "utf8");
  await assert.rejects(loadHostActionConfig(fx.configPath), (error) => error.code === "PROCESS_TERMINATE_UNSUPPORTED");
});

test("export propagates AbortSignal to a directly spawned executable", async (t) => {
  if (process.platform === "win32") { t.skip("portable fixture executable is POSIX-only"); return; }
  const fx = await fixture();
  const slow = path.join(fx.root, "slow-ffmpeg");
  await writeFile(slow, "#!/bin/sh\n/bin/sleep 10\n", "utf8");
  await chmod(slow, 0o700);
  fx.config.ffmpegPath = slow;
  await writeFile(fx.configPath, JSON.stringify(fx.config), "utf8");
  const source = path.join(fx.readRoot, "input.mp4");
  await writeFile(source, "input", "utf8");
  const entry = createHostActionEntries(await loadHostActionConfig(fx.configPath)).find((item) => item.descriptor.actionId === HOST_ACTION_IDS.VIDEO_EXPORT);
  const controller = new AbortController();
  const promise = entry.handler({ inputPath: source, outputPath: path.join(fx.writeRoot, "output.mp4"), startSec: 0, endSec: 1, videoCodec: "copy", audioCodec: "copy" }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(promise, (error) => error instanceof HostActionError && error.actionCode === "CANCELLED");
});
