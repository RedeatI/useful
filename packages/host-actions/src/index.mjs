import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, readFileSync } from "node:fs";
import { access, lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG_VERSION = "useful.host-actions.v1";
const CONFIG_MAX_BYTES = 256 * 1024;
const MAX_PATH_LENGTH = 32768;
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const CONFIG_BRAND = Symbol("useful.host-actions.loaded");
const agentKitProvenance = typeof __USEFUL_AGENT_KIT__ !== "undefined" && __USEFUL_AGENT_KIT__ === true;
const provenanceSourceUrl = agentKitProvenance
  ? new URL("./provenance/host-actions/index.mjs", import.meta.url)
  : import.meta.url;
const provenanceSchemaUrl = agentKitProvenance
  ? new URL("./provenance/host-actions/useful.host-actions.v1.schema.json", import.meta.url)
  : new URL("./useful.host-actions.v1.schema.json", import.meta.url);
const canonicalSourceBytes = (url) => Buffer.from(
  readFileSync(fileURLToPath(url), "utf8").replace(/\r\n?/g, "\n"),
  "utf8",
);
const SOURCE_DIGEST = createHash("sha256")
  .update("index.mjs\0")
  .update(canonicalSourceBytes(provenanceSourceUrl))
  .update("\0useful.host-actions.v1.schema.json\0")
  .update(canonicalSourceBytes(provenanceSchemaUrl))
  .digest("hex");
const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const VIDEO_CODECS = new Set(["copy", "libx264", "libx265", "libvpx-vp9"]);
const AUDIO_CODECS = new Set(["copy", "aac", "libopus"]);
const PROCESS_FIELDS = new Set(["pid", "startTime", "name"]);
const OUTPUT_EXTENSIONS = new Set([".mp4", ".mkv", ".mov", ".webm", ".m4a"]);

export const HOST_ACTION_IDS = Object.freeze({
  VIDEO_PROBE: "builtin.video-trim.probe",
  VIDEO_EXPORT: "builtin.video-trim.export",
  PROCESS_SNAPSHOT: "builtin.process-monitor.snapshot",
  PROCESS_TERMINATE: "builtin.process-monitor.terminate",
});

export class HostActionError extends Error {
  constructor(code, actionCode) {
    super(code);
    this.name = "HostActionError";
    this.code = code;
    if (actionCode) this.actionCode = actionCode;
  }
}

function fail(code, actionCode) {
  throw new HostActionError(code, actionCode);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactObject(value, required, allowed, code = "HOST_CONFIG_INVALID") {
  if (!isObject(value)) fail(code);
  if (required.some((key) => !Object.hasOwn(value, key))) fail(code);
  if (Object.keys(value).some((key) => !allowed.includes(key) || ["__proto__", "prototype", "constructor"].includes(key))) fail(code);
}

function exactInput(value, required, optional = []) {
  if (!isObject(value)
    || required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => ![...required, ...optional].includes(key) || ["__proto__", "prototype", "constructor"].includes(key))) {
    throw actionError("INPUT_INVALID");
  }
}

function safeInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function stringArray(value, allowed, minimum, maximum) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum || new Set(value).size !== value.length) fail("HOST_CONFIG_INVALID");
  if (value.some((entry) => typeof entry !== "string" || !allowed.has(entry))) fail("HOST_CONFIG_INVALID");
  return [...value];
}

function pathArray(value) {
  if (!Array.isArray(value) || value.length > 32 || new Set(value).size !== value.length) fail("HOST_CONFIG_INVALID");
  if (value.some((entry) => typeof entry !== "string" || !entry.length || entry.length > MAX_PATH_LENGTH || entry.includes("\0") || !path.isAbsolute(entry))) fail("HOST_CONFIG_INVALID");
  return [...value];
}

function validateConfigDocument(value) {
  exactObject(
    value,
    ["schemaVersion", "enabled", "readRoots", "writeRoots", "process"],
    ["schemaVersion", "ffmpegPath", "ffprobePath", "readRoots", "writeRoots", "enabled", "video", "process"],
  );
  if (value.schemaVersion !== CONFIG_VERSION) fail("HOST_CONFIG_INVALID");

  exactObject(value.enabled, ["videoProbe", "videoExport", "processSnapshot", "processTerminate"], ["videoProbe", "videoExport", "processSnapshot", "processTerminate"]);
  if (Object.values(value.enabled).some((entry) => typeof entry !== "boolean")) fail("HOST_CONFIG_INVALID");
  const readRoots = pathArray(value.readRoots);
  const writeRoots = pathArray(value.writeRoots);
  for (const executableField of ["ffmpegPath", "ffprobePath"]) {
    if (value[executableField] !== undefined
      && (typeof value[executableField] !== "string" || !value[executableField].length || value[executableField].length > MAX_PATH_LENGTH || value[executableField].includes("\0") || !path.isAbsolute(value[executableField]))) {
      fail("HOST_CONFIG_INVALID");
    }
  }

  exactObject(value.process, ["fields", "maxProcesses", "maxOutputBytes"], ["fields", "maxProcesses", "maxOutputBytes"]);
  const fields = stringArray(value.process.fields, PROCESS_FIELDS, 2, 3);
  if (!fields.includes("pid") || !fields.includes("startTime") || !safeInteger(value.process.maxProcesses, 1, 10000) || !safeInteger(value.process.maxOutputBytes, 4096, MAX_CAPTURE_BYTES)) fail("HOST_CONFIG_INVALID");

  const videoEnabled = value.enabled.videoProbe || value.enabled.videoExport;
  if (videoEnabled) {
    if (!isObject(value.video)
      || (value.enabled.videoProbe && typeof value.ffprobePath !== "string")
      || (value.enabled.videoExport && typeof value.ffmpegPath !== "string")) fail("HOST_CONFIG_INVALID");
    if (!readRoots.length || (value.enabled.videoExport && !writeRoots.length)) fail("HOST_CONFIG_INVALID");
  }
  let video;
  if (value.video !== undefined) {
    exactObject(value.video, ["allowOverwrite", "maxDurationSec", "maxProbeOutputBytes", "videoCodecs", "audioCodecs"], ["allowOverwrite", "maxDurationSec", "maxProbeOutputBytes", "videoCodecs", "audioCodecs"]);
    if (typeof value.video.allowOverwrite !== "boolean" || !safeInteger(value.video.maxDurationSec, 1, 86400) || !safeInteger(value.video.maxProbeOutputBytes, 4096, MAX_CAPTURE_BYTES)) fail("HOST_CONFIG_INVALID");
    if (value.video.allowOverwrite) fail("HOST_CONFIG_OVERWRITE_UNSUPPORTED");
    video = {
      allowOverwrite: value.video.allowOverwrite,
      maxDurationSec: value.video.maxDurationSec,
      maxProbeOutputBytes: value.video.maxProbeOutputBytes,
      videoCodecs: stringArray(value.video.videoCodecs, VIDEO_CODECS, 1, 4),
      audioCodecs: stringArray(value.video.audioCodecs, AUDIO_CODECS, 1, 3),
    };
  }
  return {
    schemaVersion: CONFIG_VERSION,
    enabled: { ...value.enabled },
    readRoots,
    writeRoots,
    process: { fields, maxProcesses: value.process.maxProcesses, maxOutputBytes: value.process.maxOutputBytes },
    video,
    ffmpegPath: value.ffmpegPath,
    ffprobePath: value.ffprobePath,
  };
}

async function canonicalRegularFile(value, code) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.length > MAX_PATH_LENGTH || value.includes("\0")) fail(code);
  let metadata;
  try { metadata = await lstat(value); } catch { fail(code); }
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail(code);
  let canonical;
  try { canonical = await realpath(value); } catch { fail(code); }
  try { await access(canonical, fsConstants.R_OK | fsConstants.X_OK); } catch { fail(code); }
  return canonical;
}

async function canonicalDirectory(value, code) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.length > MAX_PATH_LENGTH || value.includes("\0")) fail(code);
  let metadata;
  try { metadata = await lstat(value); } catch { fail(code); }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail(code);
  try { return await realpath(value); } catch { fail(code); }
}

function comparisonPath(value) {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function insideRoot(candidate, root) {
  const relative = path.relative(comparisonPath(root), comparisonPath(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function insideAnyRoot(candidate, roots) {
  return roots.some((root) => insideRoot(candidate, root));
}

function uniqueCanonicalPaths(values) {
  const seen = new Set();
  for (const value of values) {
    const key = comparisonPath(value);
    if (seen.has(key)) fail("HOST_CONFIG_DUPLICATE_ROOT");
    seen.add(key);
  }
  return values;
}

async function fixedProcessExecutable() {
  const fixed = process.platform === "win32"
    ? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
    : process.platform === "linux" || process.platform === "darwin"
      ? "/bin/ps"
      : undefined;
  if (!fixed) return undefined;
  try { return await canonicalRegularFile(fixed, "PROCESS_SNAPSHOT_UNAVAILABLE"); } catch { return undefined; }
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export async function loadHostActionConfig(configPath) {
  const resolved = path.resolve(configPath);
  let metadata;
  try { metadata = await lstat(resolved); } catch { fail("HOST_CONFIG_UNREADABLE"); }
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail("HOST_CONFIG_NOT_REGULAR_FILE");
  if (metadata.size > CONFIG_MAX_BYTES) fail("HOST_CONFIG_TOO_LARGE");
  let document;
  try { document = JSON.parse((await readFile(resolved, "utf8")).replace(/^\uFEFF+/, "")); } catch { fail("HOST_CONFIG_JSON_INVALID"); }
  const config = validateConfigDocument(document);

  config.readRoots = uniqueCanonicalPaths(await Promise.all(config.readRoots.map((entry) => canonicalDirectory(entry, "HOST_CONFIG_READ_ROOT_INVALID"))));
  config.writeRoots = uniqueCanonicalPaths(await Promise.all(config.writeRoots.map((entry) => canonicalDirectory(entry, "HOST_CONFIG_WRITE_ROOT_INVALID"))));
  if (config.enabled.videoExport) {
    config.ffmpegPath = await canonicalRegularFile(config.ffmpegPath, "HOST_CONFIG_FFMPEG_INVALID");
  } else {
    delete config.ffmpegPath;
  }
  if (config.enabled.videoProbe) {
    config.ffprobePath = await canonicalRegularFile(config.ffprobePath, "HOST_CONFIG_FFPROBE_INVALID");
  } else {
    delete config.ffprobePath;
  }
  config.processExecutable = (config.enabled.processSnapshot || config.enabled.processTerminate) ? await fixedProcessExecutable() : undefined;
  if (config.enabled.processSnapshot && !config.processExecutable) fail("PROCESS_SNAPSHOT_UNAVAILABLE");
  if (config.enabled.processTerminate && (process.platform !== "win32" || !config.processExecutable)) fail("PROCESS_TERMINATE_UNSUPPORTED");
  Object.defineProperty(config, CONFIG_BRAND, { value: true, enumerable: false });
  return deepFreeze(config);
}

function actionError(code, actionCode = "INPUT_INVALID") {
  return new HostActionError(code, actionCode);
}

async function resolveReadPath(value, roots) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.length > MAX_PATH_LENGTH || value.includes("\0")) throw actionError("READ_PATH_INVALID");
  let canonical;
  try { canonical = await realpath(value); } catch { throw actionError("READ_PATH_UNREADABLE"); }
  let metadata;
  try { metadata = await stat(canonical); } catch { throw actionError("READ_PATH_UNREADABLE"); }
  if (!metadata.isFile() || !insideAnyRoot(canonical, roots)) throw actionError("READ_PATH_OUTSIDE_ALLOWED_ROOT");
  return canonical;
}

async function resolveWritePath(value, config) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.length > MAX_PATH_LENGTH || value.includes("\0") || !OUTPUT_EXTENSIONS.has(path.extname(value).toLowerCase())) throw actionError("WRITE_PATH_INVALID");
  let parent;
  try { parent = await realpath(path.dirname(value)); } catch { throw actionError("WRITE_PARENT_UNREADABLE"); }
  if (!insideAnyRoot(parent, config.writeRoots)) throw actionError("WRITE_PATH_OUTSIDE_ALLOWED_ROOT");
  const target = path.join(parent, path.basename(value));
  let existing;
  try { existing = await lstat(target); } catch (error) { if (error?.code !== "ENOENT") throw actionError("WRITE_PATH_UNREADABLE"); }
  if (existing) throw actionError("OUTPUT_EXISTS");
  return target;
}

function minimalEnvironment(extra = {}) {
  const base = process.platform === "win32"
    ? { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" }
    : { LANG: "C", LC_ALL: "C", TZ: "UTC0" };
  return { ...base, ...extra };
}

function runFixedCommand(executable, args, options = {}) {
  if (typeof executable !== "string" || !path.isAbsolute(executable) || !Array.isArray(args) || args.some((entry) => typeof entry !== "string")) fail("HOST_COMMAND_INVALID");
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  if (!safeInteger(maxBytes, 1, MAX_CAPTURE_BYTES)) fail("HOST_COMMAND_INVALID");
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executable, args, {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: minimalEnvironment(options.env),
      });
    } catch { reject(new HostActionError("HOST_COMMAND_START_FAILED")); return; }
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let settled = false;
    let forcedKill;
    const cleanup = () => {
      options.signal?.removeEventListener("abort", onAbort);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const stop = () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        forcedKill = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 250);
        forcedKill.unref?.();
      }
    };
    const onAbort = () => {
      stop();
      settle(reject, new HostActionError("HOST_ACTION_CANCELLED", "CANCELLED"));
    };
    const capture = (bucket) => (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > maxBytes) {
        stop();
        settle(reject, new HostActionError("HOST_OUTPUT_TOO_LARGE", "OUTPUT_TOO_LARGE"));
      } else bucket.push(buffer);
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.once("error", () => settle(reject, new HostActionError("HOST_COMMAND_START_FAILED")));
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        const mapped = options.exitCodes?.[code];
        settle(reject, new HostActionError(mapped ?? "HOST_COMMAND_FAILED"));
        return;
      }
      settle(resolve, { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function finiteInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function parseProbeOutput(text) {
  let value;
  try { value = JSON.parse(text); } catch { fail("FFPROBE_OUTPUT_INVALID", "OUTPUT_INVALID"); }
  if (!isObject(value) || !isObject(value.format) || !Array.isArray(value.streams)) fail("FFPROBE_OUTPUT_INVALID", "OUTPUT_INVALID");
  const streams = value.streams.slice(0, 128).map((stream) => {
    if (!isObject(stream)) fail("FFPROBE_OUTPUT_INVALID", "OUTPUT_INVALID");
    const result = {
      index: finiteInteger(stream.index),
      type: typeof stream.codec_type === "string" ? stream.codec_type.slice(0, 32) : "unknown",
      codec: typeof stream.codec_name === "string" ? stream.codec_name.slice(0, 64) : "unknown",
    };
    for (const [source, target] of [["width", "width"], ["height", "height"], ["sample_rate", "sampleRate"], ["channels", "channels"]]) {
      const number = finiteInteger(stream[source], -1);
      if (number >= 0) result[target] = number;
    }
    return result;
  });
  return {
    format: {
      durationSec: finiteNumber(value.format.duration),
      sizeBytes: finiteInteger(value.format.size),
    },
    streams,
  };
}

async function videoProbeHandler(config, input, context = {}) {
  exactInput(input, ["path"]);
  const mediaPath = await resolveReadPath(input.path, config.readRoots);
  const { stdout } = await runFixedCommand(config.ffprobePath, [
    "-v", "error",
    "-show_entries", "format=duration,size:stream=index,codec_type,codec_name,width,height,sample_rate,channels",
    "-of", "json",
    mediaPath,
  ], { maxBytes: config.video.maxProbeOutputBytes, signal: context.signal });
  return parseProbeOutput(stdout);
}

async function videoExportHandler(config, input, context = {}) {
  exactInput(input, ["inputPath", "outputPath", "startSec", "endSec", "videoCodec", "audioCodec"]);
  if (typeof input.startSec !== "number" || !Number.isFinite(input.startSec) || input.startSec < 0
    || typeof input.endSec !== "number" || !Number.isFinite(input.endSec) || input.endSec <= input.startSec
    || input.endSec - input.startSec > config.video.maxDurationSec
    || !config.video.videoCodecs.includes(input.videoCodec)
    || !config.video.audioCodecs.includes(input.audioCodec)) throw actionError("VIDEO_EXPORT_INPUT_INVALID");
  const source = await resolveReadPath(input.inputPath, config.readRoots);
  const target = await resolveWritePath(input.outputPath, config);
  const duration = input.endSec - input.startSec;
  await runFixedCommand(config.ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-ss", String(input.startSec), "-i", source, "-t", String(duration),
    "-map", "0:v:0?", "-map", "0:a:0?",
    "-c:v", input.videoCodec, "-c:a", input.audioCodec,
    "-n",
    target,
  ], { maxBytes: 1024 * 1024, signal: context.signal });
  let canonical;
  try { canonical = await realpath(target); } catch { fail("VIDEO_EXPORT_OUTPUT_MISSING", "OUTPUT_INVALID"); }
  if (!insideAnyRoot(canonical, config.writeRoots)) fail("VIDEO_EXPORT_OUTPUT_OUTSIDE_ROOT", "OUTPUT_INVALID");
  const metadata = await stat(canonical).catch(() => undefined);
  if (!metadata?.isFile()) fail("VIDEO_EXPORT_OUTPUT_INVALID", "OUTPUT_INVALID");
  return { outputPath: canonical, bytes: metadata.size };
}

const WINDOWS_SNAPSHOT_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$limit=[int]$env:USEFUL_PROCESS_LIMIT",
  "$items=@(Get-Process | ForEach-Object { try { [pscustomobject]@{pid=[int]$_.Id;startTime=[DateTimeOffset]::new($_.StartTime).ToUnixTimeMilliseconds();name=[string]$_.ProcessName} } catch {} } | Sort-Object pid | Select-Object -First ($limit+1))",
  "ConvertTo-Json -InputObject $items -Compress",
].join(";");

const WINDOWS_TERMINATE_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$targetPid=[int]$env:USEFUL_TARGET_PID",
  "$expectedStart=[long]$env:USEFUL_TARGET_START",
  "$p=Get-Process -Id $targetPid -ErrorAction Stop",
  "$actual=[DateTimeOffset]::new($p.StartTime).ToUnixTimeMilliseconds()",
  "if($actual -ne $expectedStart){exit 42}",
  "Stop-Process -InputObject $p -Force -ErrorAction Stop",
].join(";");

function selectProcessFields(processEntry, fields) {
  const result = {};
  for (const field of fields) result[field] = processEntry[field];
  return result;
}

function parseWindowsProcesses(text) {
  let value;
  try { value = JSON.parse(text || "[]"); } catch { fail("PROCESS_OUTPUT_INVALID", "OUTPUT_INVALID"); }
  const entries = Array.isArray(value) ? value : [value];
  return entries.filter(isObject).map((entry) => ({ pid: Number(entry.pid), startTime: Number(entry.startTime), name: String(entry.name ?? "") }))
    .filter((entry) => safeInteger(entry.pid, 1, 0x7fffffff) && safeInteger(entry.startTime, 1, Number.MAX_SAFE_INTEGER));
}

function parsePosixProcesses(text) {
  const result = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.{24})\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const startTime = Date.parse(`${match[2]} UTC`);
    if (safeInteger(pid, 1, 0x7fffffff) && safeInteger(startTime, 1, Number.MAX_SAFE_INTEGER)) result.push({ pid, startTime, name: match[3].slice(0, 256) });
  }
  return result;
}

async function processSnapshotHandler(config, input, context = {}) {
  exactInput(input, []);
  let entries;
  if (process.platform === "win32") {
    const { stdout } = await runFixedCommand(config.processExecutable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_SNAPSHOT_SCRIPT], {
      maxBytes: config.process.maxOutputBytes,
      signal: context.signal,
      env: { USEFUL_PROCESS_LIMIT: String(config.process.maxProcesses) },
    });
    entries = parseWindowsProcesses(stdout);
  } else if (process.platform === "linux" || process.platform === "darwin") {
    const { stdout } = await runFixedCommand(config.processExecutable, ["-eo", "pid=,lstart=,comm="], { maxBytes: config.process.maxOutputBytes, signal: context.signal });
    entries = parsePosixProcesses(stdout).sort((left, right) => left.pid - right.pid);
  } else fail("PROCESS_SNAPSHOT_UNSUPPORTED");
  const truncated = entries.length > config.process.maxProcesses;
  const processes = entries.slice(0, config.process.maxProcesses).map((entry) => selectProcessFields(entry, config.process.fields));
  if (Buffer.byteLength(JSON.stringify({ processes, truncated }), "utf8") > config.process.maxOutputBytes) fail("PROCESS_OUTPUT_TOO_LARGE", "OUTPUT_TOO_LARGE");
  return { processes, truncated };
}

async function processTerminateHandler(config, input, context = {}) {
  exactInput(input, ["pid", "startTime"]);
  if (!safeInteger(input.pid, 1, 0x7fffffff) || input.pid === process.pid || !safeInteger(input.startTime, 1, Number.MAX_SAFE_INTEGER)) throw actionError("PROCESS_TERMINATE_INPUT_INVALID");
  if (process.platform !== "win32" || !config.processExecutable) fail("PROCESS_TERMINATE_UNSUPPORTED");
  await runFixedCommand(config.processExecutable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_TERMINATE_SCRIPT], {
    maxBytes: 64 * 1024,
    signal: context.signal,
    env: { USEFUL_TARGET_PID: String(input.pid), USEFUL_TARGET_START: String(input.startTime) },
    exitCodes: { 42: "PROCESS_IDENTITY_MISMATCH" },
  });
  return { terminated: true };
}

const string = (maxLength = 32768) => ({ type: "string", maxLength });
const integer = (minimum, maximum) => ({ type: "integer", minimum, maximum });
const number = (minimum, maximum) => ({ type: "number", minimum, maximum });
const boolean = () => ({ type: "boolean" });
const object = (properties, required = Object.keys(properties)) => ({ $schema: DRAFT, type: "object", additionalProperties: false, properties, required });
const nestedObject = (properties, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, properties, required });
const array = (items, maxItems) => ({ type: "array", items, maxItems });

function hostDescriptor(options) {
  return {
    contractVersion: "1.0",
    actionId: options.actionId,
    version: "1.0.0",
    source: { kind: "builtin", toolId: options.toolId, publisher: { id: "useful.project", name: "Useful" }, digest: SOURCE_DIGEST },
    title: options.title,
    description: options.description,
    keywords: options.keywords,
    aliases: [],
    inputSchema: options.inputSchema,
    outputSchema: options.outputSchema,
    examples: [],
    testVectors: options.testVectors,
    execution: { mode: "host", handler: options.actionId, timeoutMs: options.timeoutMs, maxInputBytes: 128 * 1024, maxOutputBytes: options.maxOutputBytes, supportsCancellation: true },
    behavior: { readOnly: options.readOnly, destructive: options.destructive, idempotent: options.idempotent, openWorld: false, sideEffects: options.sideEffects, requiresConfirmation: options.requiresConfirmation },
    permissions: { required: options.permissions, capabilities: options.capabilities },
    sensitive: { input: options.sensitiveInput, output: options.sensitiveOutput, redactLogs: true },
    presentation: { route: options.route, category: options.category },
  };
}

function descriptorSet(config) {
  const probe = hostDescriptor({
    actionId: HOST_ACTION_IDS.VIDEO_PROBE, toolId: "builtin.video-trim", title: "Probe media", description: "Read bounded media metadata with the explicitly configured ffprobe executable.", keywords: ["video", "media", "probe", "metadata"],
    inputSchema: object({ path: string() }), outputSchema: object({ format: nestedObject({ durationSec: number(0, 86400000), sizeBytes: integer(0, Number.MAX_SAFE_INTEGER) }), streams: array(nestedObject({ index: integer(0, 1000000), type: string(32), codec: string(64), width: integer(0, 100000), height: integer(0, 100000), sampleRate: integer(0, 1000000), channels: integer(0, 1024) }, ["index", "type", "codec"]), 128) }),
    testVectors: [{ name: "reject empty path", input: { path: "" }, expectedErrorCode: "INPUT_INVALID" }], timeoutMs: 30000, maxOutputBytes: config.video?.maxProbeOutputBytes ?? 4 * 1024 * 1024,
    readOnly: true, destructive: false, idempotent: true, sideEffects: ["process.spawn"], requiresConfirmation: false,
    permissions: ["fs.read.user-configured", "process.spawn.ffprobe"], capabilities: ["host.video"], sensitiveInput: ["/path"], sensitiveOutput: [""], route: "/tools/video-trim", category: "media",
  });
  const exportAction = hostDescriptor({
    actionId: HOST_ACTION_IDS.VIDEO_EXPORT, toolId: "builtin.video-trim", title: "Export media trim", description: "Export a bounded media segment with closed codec and argument allowlists.", keywords: ["video", "media", "trim", "export"],
    inputSchema: object({ inputPath: string(), outputPath: string(), startSec: number(0, 86400000), endSec: number(0, 86400000), videoCodec: { type: "string", enum: [...VIDEO_CODECS] }, audioCodec: { type: "string", enum: [...AUDIO_CODECS] } }),
    outputSchema: object({ outputPath: string(), bytes: integer(0, Number.MAX_SAFE_INTEGER) }),
    testVectors: [{ name: "reject reversed interval", input: { inputPath: "x", outputPath: "y.mp4", startSec: 2, endSec: 1, videoCodec: "copy", audioCodec: "copy" }, expectedErrorCode: "INPUT_INVALID" }], timeoutMs: Math.min(3600000, Math.max(60000, (config.video?.maxDurationSec ?? 3600) * 2000)), maxOutputBytes: 64 * 1024,
    readOnly: false, destructive: true, idempotent: false, sideEffects: ["filesystem.write", "process.spawn"], requiresConfirmation: true,
    permissions: ["fs.read.user-configured", "fs.write.user-configured", "process.spawn.ffmpeg"], capabilities: ["host.video"], sensitiveInput: ["/inputPath", "/outputPath"], sensitiveOutput: ["/outputPath"], route: "/tools/video-trim", category: "media",
  });
  const processItem = nestedObject({ pid: integer(1, 0x7fffffff), startTime: integer(1, Number.MAX_SAFE_INTEGER), name: string(256) }, ["pid", "startTime"]);
  const snapshot = hostDescriptor({
    actionId: HOST_ACTION_IDS.PROCESS_SNAPSHOT, toolId: "builtin.process-monitor", title: "Process snapshot", description: "Return a bounded, minimal local process snapshot from a fixed operating-system command.", keywords: ["process", "snapshot", "monitor"],
    inputSchema: object({}), outputSchema: object({ processes: array(processItem, config.process.maxProcesses), truncated: boolean() }),
    testVectors: [{ name: "reject unknown input", input: { command: "whoami" }, expectedErrorCode: "INPUT_INVALID" }], timeoutMs: 10000, maxOutputBytes: config.process.maxOutputBytes,
    readOnly: true, destructive: false, idempotent: true, sideEffects: ["process.spawn"], requiresConfirmation: false,
    permissions: ["process.read"], capabilities: ["host.process"], sensitiveInput: [], sensitiveOutput: [""], route: "/tools/process-monitor", category: "system",
  });
  const terminate = hostDescriptor({
    actionId: HOST_ACTION_IDS.PROCESS_TERMINATE, toolId: "builtin.process-monitor", title: "Terminate process", description: "Terminate a Windows process only when PID and observed start time still match.", keywords: ["process", "terminate", "kill"],
    inputSchema: object({ pid: integer(1, 0x7fffffff), startTime: integer(1, Number.MAX_SAFE_INTEGER) }), outputSchema: object({ terminated: boolean() }),
    testVectors: [{ name: "reject pid zero", input: { pid: 0, startTime: 1 }, expectedErrorCode: "INPUT_INVALID" }], timeoutMs: 10000, maxOutputBytes: 1024,
    readOnly: false, destructive: true, idempotent: false, sideEffects: ["process.terminate"], requiresConfirmation: true,
    permissions: ["process.terminate"], capabilities: ["host.process", "platform.windows"], sensitiveInput: ["/pid", "/startTime"], sensitiveOutput: [], route: "/tools/process-monitor", category: "system",
  });
  return { probe, exportAction, snapshot, terminate };
}

export function createHostActionEntries(config) {
  if (!isObject(config) || config[CONFIG_BRAND] !== true) fail("HOST_CONFIG_NOT_LOADED");
  const descriptors = descriptorSet(config);
  const entries = [];
  if (config.enabled.videoProbe) entries.push({ descriptor: descriptors.probe, handler: (input, context) => videoProbeHandler(config, input, context) });
  if (config.enabled.videoExport) entries.push({ descriptor: descriptors.exportAction, handler: (input, context) => videoExportHandler(config, input, context) });
  if (config.enabled.processSnapshot) entries.push({ descriptor: descriptors.snapshot, handler: (input, context) => processSnapshotHandler(config, input, context) });
  if (config.enabled.processTerminate) entries.push({ descriptor: descriptors.terminate, handler: (input, context) => processTerminateHandler(config, input, context) });
  return Object.freeze(entries.map((entry) => Object.freeze({ descriptor: deepFreeze(entry.descriptor), handler: entry.handler })));
}
