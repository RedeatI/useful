#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  lstat,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const AdmZip = require("adm-zip");
const directInvocation = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const EXPECTED_DIGEST = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const POSIX_LAUNCHERS = new Set(["bin/useful", "bin/useful-runtime", "bin/useful-mcp"]);

function fail(message) {
  throw new Error(message);
}

export function parseArguments(argv) {
  const valueFlags = new Set([
    "--archive",
    "--extract-root",
    "--expected-sha256",
    "--expected-source-revision",
    "--expected-version",
    "--required-node-major",
  ]);
  const values = new Map();
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--json") {
      if (json) fail("duplicate --json");
      json = true;
      continue;
    }
    if (!valueFlags.has(flag)) fail(`unknown argument: ${flag}`);
    if (values.has(flag)) fail(`duplicate argument: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`missing value: ${flag}`);
    values.set(flag, value);
    index += 1;
  }
  if (!json) fail("--json is required");
  for (const flag of valueFlags) {
    if (!values.has(flag)) fail(`missing required argument: ${flag}`);
  }
  const requiredNodeMajor = Number(values.get("--required-node-major"));
  if (!Number.isSafeInteger(requiredNodeMajor) || requiredNodeMajor < 20) {
    fail("--required-node-major must be an integer >= 20");
  }
  const expectedSha256 = values.get("--expected-sha256").toLowerCase();
  const expectedSourceRevision = values.get("--expected-source-revision").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) fail("--expected-sha256 must be 64 lowercase hex characters");
  if (!/^[a-f0-9]{40}$/.test(expectedSourceRevision)) fail("--expected-source-revision must be 40 lowercase hex characters");
  return {
    archive: path.resolve(values.get("--archive")),
    extractRoot: path.resolve(values.get("--extract-root")),
    expectedSha256,
    expectedSourceRevision,
    expectedVersion: values.get("--expected-version"),
    requiredNodeMajor,
  };
}

export function normalizeArchivePath(rawName) {
  if (typeof rawName !== "string" || rawName.length === 0 || rawName.includes("\0")) {
    fail("archive entry path is empty or contains NUL");
  }
  if (rawName.includes("\\") || rawName.includes(":")) fail(`unsafe archive entry path: ${rawName}`);
  const directory = rawName.endsWith("/");
  const withoutTrailingSlash = directory ? rawName.slice(0, -1) : rawName;
  if (!withoutTrailingSlash || withoutTrailingSlash.startsWith("/")) fail(`unsafe archive entry path: ${rawName}`);
  const segments = withoutTrailingSlash.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    fail(`unsafe archive entry path: ${rawName}`);
  }
  return { path: segments.join("/"), directory };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function unixMode(entry) {
  return (Number(entry.header.attr) >>> 16) & 0xffff;
}

export async function extractArchive(archivePath, extractRoot) {
  if (await pathExists(extractRoot)) fail("extract root already exists");
  const zip = new AdmZip(archivePath);
  const entries = zip.getEntries();
  const seen = new Set();
  const normalized = entries.map((entry) => {
    const descriptor = normalizeArchivePath(entry.entryName);
    const folded = descriptor.path.toLocaleLowerCase("en-US");
    if (seen.has(folded)) fail(`case-insensitive duplicate archive path: ${descriptor.path}`);
    seen.add(folded);
    const mode = unixMode(entry);
    const fileType = mode & 0o170000;
    if (fileType !== 0 && fileType !== 0o040000 && fileType !== 0o100000) {
      fail(`non-regular archive entry is forbidden: ${descriptor.path}`);
    }
    if (descriptor.directory !== entry.isDirectory) fail(`archive directory metadata mismatch: ${descriptor.path}`);
    if (POSIX_LAUNCHERS.has(descriptor.path) && (mode & 0o111) === 0) {
      fail(`POSIX launcher is not executable in the archive: ${descriptor.path}`);
    }
    return { entry, ...descriptor, mode };
  });

  await mkdir(extractRoot, { recursive: false });
  for (const item of normalized) {
    const target = path.join(extractRoot, ...item.path.split("/"));
    const relative = path.relative(extractRoot, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) fail(`archive entry escaped extraction root: ${item.path}`);
    if (item.directory) {
      await mkdir(target, { recursive: true });
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    const mode = item.mode & 0o777;
    await writeFile(target, item.entry.getData(), { flag: "wx", mode: mode || 0o644 });
  }
  return normalized.filter((entry) => !entry.directory).map((entry) => entry.path);
}

async function verifyManifest(extractRoot, actualPaths, options) {
  const manifestPath = path.join(extractRoot, "MANIFEST.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.schemaVersion, "useful.agent-kit.manifest.v1");
  assert.equal(manifest.product?.name, "Useful");
  assert.equal(manifest.product?.version, options.expectedVersion);
  assert.equal(manifest.source?.revision, options.expectedSourceRevision);
  assert.equal(manifest.node?.requirement, ">=20");
  assert.deepEqual(manifest.closure, { manifestPath: "MANIFEST.json", manifestSelfExcluded: true });
  assert.ok(Array.isArray(manifest.files));

  const declared = new Map();
  for (const file of manifest.files) {
    const normalized = normalizeArchivePath(file?.path);
    if (normalized.directory || declared.has(normalized.path)) fail(`invalid or duplicate manifest path: ${file?.path}`);
    if (!Number.isSafeInteger(file?.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file?.sha256 ?? "")) {
      fail(`invalid manifest file record: ${file?.path}`);
    }
    declared.set(normalized.path, file);
  }

  const actual = actualPaths.filter((entry) => entry !== "MANIFEST.json").sort();
  assert.deepEqual(actual, [...declared.keys()].sort(), "manifest file set must exactly match archive files");
  assert.equal(actualPaths.filter((entry) => entry === "MANIFEST.json").length, 1);
  for (const relative of actual) {
    const bytes = await readFile(path.join(extractRoot, ...relative.split("/")));
    const expected = declared.get(relative);
    assert.equal(bytes.length, expected.size, `manifest size mismatch: ${relative}`);
    assert.equal(sha256(bytes), expected.sha256, `manifest SHA-256 mismatch: ${relative}`);
  }
  return { manifest, closureEntries: actual.length, archiveFiles: actualPaths.length };
}

function inheritedEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined));
}

export function launcherInvocation(launcher, args, platform = process.platform) {
  if (platform !== "win32") return { command: launcher, args };
  const launcherName = path.win32.basename(launcher);
  if (!["useful.cmd", "useful-runtime.cmd", "useful-mcp.cmd"].includes(launcherName)) {
    fail(`unexpected Windows launcher name: ${launcherName}`);
  }
  return {
    command: "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/s", "/c", "call", `.\\${launcherName}`, ...args],
    cwd: path.win32.dirname(launcher),
  };
}

function runJsonLauncher(launcher, args, { cwd, input } = {}) {
  const invocation = launcherInvocation(launcher, args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: invocation.cwd ?? cwd,
    input,
    encoding: "utf8",
    env: inheritedEnvironment(),
    maxBuffer: 32 * 1024 * 1024,
    timeout: 60_000,
    windowsHide: true,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, `${path.basename(launcher)} was terminated by ${result.signal}`);
  assert.equal(result.status, 0, `${path.basename(launcher)} exited ${result.status}: ${result.stdout}`);
  assert.equal(result.stderr, "", `${path.basename(launcher)} wrote to stderr`);
  const stdout = result.stdout.trim();
  assert.ok(stdout, `${path.basename(launcher)} returned empty stdout`);
  return { value: JSON.parse(stdout), stdout };
}

async function loadMcpClient() {
  const packageRequire = createRequire(new URL("../packages/useful-mcp/package.json", import.meta.url));
  const client = await import(pathToFileURL(packageRequire.resolve("@modelcontextprotocol/client")));
  const stdio = await import(pathToFileURL(packageRequire.resolve("@modelcontextprotocol/client/stdio")));
  return { Client: client.Client, StdioClientTransport: stdio.StdioClientTransport };
}

async function exerciseMcp({ command, args, cwd, label, versionNegotiation }) {
  const { Client, StdioClientTransport } = await loadMcpClient();
  const client = new Client(
    { name: "published-agent-kit-cross-platform-acceptance", version: "1.0.0" },
    versionNegotiation ? { versionNegotiation } : undefined,
  );
  const transport = new StdioClientTransport({
    command,
    args,
    cwd,
    env: inheritedEnvironment(),
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 40);
    assert.equal(new Set(listed.tools.map((tool) => tool.name)).size, 40);
    const result = await client.callTool({
      name: "builtin.utilities.hash",
      arguments: { algorithm: "SHA-256", text: "abc" },
    });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent?.digest, EXPECTED_DIGEST);
    return {
      label,
      protocolEra: client.getProtocolEra(),
      negotiatedProtocolVersion: client.getNegotiatedProtocolVersion(),
      toolCount: listed.tools.length,
      digest: result.structuredContent.digest,
    };
  } finally {
    await client.close();
    assert.equal(transport.pid, null);
    assert.equal(stderr, "");
  }
}

async function accept(options) {
  const actualNodeMajor = Number(process.versions.node.split(".")[0]);
  assert.equal(actualNodeMajor, options.requiredNodeMajor, "Node.js major version does not match the required acceptance runtime");
  const archiveBytes = await readFile(options.archive);
  const archiveSha256 = sha256(archiveBytes);
  assert.equal(archiveSha256, options.expectedSha256, "published Agent Kit SHA-256 mismatch");
  const actualPaths = await extractArchive(options.archive, options.extractRoot);
  const manifestResult = await verifyManifest(options.extractRoot, actualPaths, options);

  const commandKey = process.platform === "win32" ? "windows" : "posix";
  const commands = manifestResult.manifest.commands;
  for (const name of ["useful", "useful-runtime", "useful-mcp"]) {
    assert.equal(typeof commands?.[name]?.[commandKey], "string", `missing ${commandKey} launcher for ${name}`);
  }
  const useful = path.join(options.extractRoot, ...commands.useful[commandKey].split("/"));
  const runtime = path.join(options.extractRoot, ...commands["useful-runtime"][commandKey].split("/"));
  const mcpLauncher = path.join(options.extractRoot, ...commands["useful-mcp"][commandKey].split("/"));
  const mcpEntry = path.join(options.extractRoot, ...commands["useful-mcp"].entry.split("/"));

  const contract = runJsonLauncher(useful, ["agent-contract", "--json"], { cwd: options.extractRoot }).value;
  assert.equal(contract.schemaVersion, "useful.cli.result.v1");
  assert.equal(contract.ok, true);

  const listed = runJsonLauncher(runtime, ["actions", "list", "--json"], { cwd: options.extractRoot }).value;
  assert.equal(listed.operation, "actions.list");
  assert.equal(listed.actions?.length, 36);

  const secret = '{"secret":"AGENT_KIT_ACCEPTANCE_DO_NOT_ECHO"}';
  const suggested = runJsonLauncher(runtime, ["actions", "suggest", "--limit", "3", "--json"], {
    cwd: options.extractRoot,
    input: secret,
  });
  assert.equal(suggested.value.operation, "actions.suggest");
  assert.equal(suggested.stdout.includes("AGENT_KIT_ACCEPTANCE_DO_NOT_ECHO"), false);

  const recipe = {
    schemaVersion: "useful.action-recipe.v1",
    input: { source: '{ "a": 1 }' },
    steps: [
      { id: "minify", actionId: "builtin.utilities.json", input: { operation: "minify", text: { $ref: "/input/source" } } },
      { id: "encode", actionId: "builtin.utilities.base64", input: { operation: "encode", text: { $ref: "/steps/minify/output/text" } } },
    ],
    output: { encoded: { $ref: "/steps/encode/output/text" } },
  };
  const validatedRecipe = runJsonLauncher(runtime, ["actions", "recipe", "--validate-only", "--output", "json"], {
    cwd: options.extractRoot,
    input: JSON.stringify(recipe),
  }).value;
  assert.equal(validatedRecipe.operation, "actions.recipe.validate");
  const executedRecipe = runJsonLauncher(runtime, ["actions", "recipe", "--output", "json"], {
    cwd: options.extractRoot,
    input: JSON.stringify(recipe),
  }).value;
  assert.deepEqual(executedRecipe.output, { encoded: "eyJhIjoxfQ==" });
  assert.ok(executedRecipe.steps.every((step) => step.receipt?.status === "success"));

  const regex = runJsonLauncher(runtime, ["actions", "run", "builtin.utilities.regex", "--output", "json"], {
    cwd: options.extractRoot,
    input: JSON.stringify({ operation: "test", pattern: "a+", flags: "", text: "caaab" }),
  }).value;
  assert.equal(regex.output?.matches?.length, 1);
  assert.equal(regex.output.matches[0]?.match, "aaa");
  const office = runJsonLauncher(runtime, ["actions", "run", "builtin.office.spreadsheet", "--output", "json"], {
    cwd: options.extractRoot,
    input: JSON.stringify({ operation: "inspect-csv", text: "a,b\n1,2" }),
  }).value;
  assert.equal(office.output?.summary?.format, "csv");

  const launcherMcp = launcherInvocation(mcpLauncher, []);
  const mcp = [];
  mcp.push(await exerciseMcp({
    ...launcherMcp,
    cwd: launcherMcp.cwd ?? options.extractRoot,
    label: `${commandKey}-launcher-legacy`,
  }));
  mcp.push(await exerciseMcp({
    command: process.execPath,
    args: [mcpEntry],
    cwd: options.extractRoot,
    label: "direct-entry-modern",
    versionNegotiation: { mode: { pin: "2026-07-28" } },
  }));

  return {
    schemaVersion: "useful.agent-kit.acceptance.v1",
    ok: true,
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.version,
    requiredNodeMajor: options.requiredNodeMajor,
    archive: {
      sha256: archiveSha256,
      sizeBytes: archiveBytes.length,
      fileEntries: manifestResult.archiveFiles,
      closureEntries: manifestResult.closureEntries,
    },
    product: manifestResult.manifest.product,
    sourceRevision: manifestResult.manifest.source.revision,
    commands: {
      launcherKind: commandKey,
      actionCount: listed.actions.length,
      suggestSecretEchoed: false,
      recipeSteps: executedRecipe.steps.length,
      regexWorker: true,
      officeWorker: true,
    },
    mcp,
    boundaries: {
      downloadedPublishedAsset: true,
      monorepoUsedAsTestDriverOnly: true,
      globalInstallUsed: false,
      guiUsed: false,
      artifactPublished: false,
    },
  };
}

if (directInvocation) {
  try {
    const options = parseArguments(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(await accept(options))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: "useful.agent-kit.acceptance.v1",
      ok: false,
      error: { message: error instanceof Error ? error.message : String(error) },
    })}\n`);
    process.exitCode = 1;
  }
}
