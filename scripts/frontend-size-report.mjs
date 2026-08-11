#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SIZE_REPORT_SCHEMA = "useful.size-report.v2";
export const MAX_SIZE_BYTES = 1_000_000_000;
export const FRONTEND_DIST_RELATIVE = "apps/useful/dist";
export const FRONTEND_ENTRY_SOURCE = "index.html";
export const AGENT_PROFILE_SOURCE = "src/components/AgentProfilePanel.vue";
export const FILE_HASH_WORKER_ASSET_PATTERN = /^assets\/fileHashWorker-[A-Za-z0-9_-]{8,}\.js$/;
export const REGEX_WORKER_ASSET_PATTERN = /^assets\/regexWorker-[A-Za-z0-9_-]{8,}\.js$/;
export const OFFICE_WORKER_ASSET_PATTERN = /^assets\/officeWorker-[A-Za-z0-9_-]{8,}\.js$/;

const CONTROLLED_HELPER_WORKERS = [
  ["fileHashWorker", FILE_HASH_WORKER_ASSET_PATTERN],
  ["regexWorker", REGEX_WORKER_ASSET_PATTERN],
  ["officeWorker", OFFICE_WORKER_ASSET_PATTERN],
];

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VITE_MANIFEST_RELATIVE = ".vite/manifest.json";
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const MANIFEST_CHUNK_FIELDS = new Set([
  "file",
  "name",
  "names",
  "src",
  "isEntry",
  "isDynamicEntry",
  "imports",
  "dynamicImports",
  "css",
  "assets",
]);

function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export class SizeReportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SizeReportError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new SizeReportError(code, message);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resolveInside(root, candidate, label) {
  const rootPath = path.resolve(root);
  const fullPath = path.resolve(candidate);
  const relative = path.relative(rootPath, fullPath);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    return fullPath;
  }
  fail("PATH_OUTSIDE_ROOT", `${label} must stay inside ${rootPath}: ${fullPath}`);
}

function normalizeRelativePath(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.includes("\0")) {
    fail("RELATIVE_PATH_INVALID", `${label} must be a non-empty POSIX relative path`);
  }
  if (value.startsWith("/") || value.endsWith("/") || value.includes("//")) {
    fail("RELATIVE_PATH_INVALID", `${label} is not normalized: ${value}`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    fail("RELATIVE_PATH_INVALID", `${label} is not normalized: ${value}`);
  }
  return value;
}

function normalizeManifestIdentifier(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail("MANIFEST_IDENTIFIER_INVALID", `${label} must be a non-empty identifier without NUL bytes`);
  }
  return value;
}

async function requireDirectory(directory, label) {
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    fail(error?.code === "ENOENT" ? "DIRECTORY_MISSING" : "DIRECTORY_UNREADABLE", `${label}: ${directory}`);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    fail("DIRECTORY_NOT_ORDINARY", `${label} must be an ordinary directory: ${directory}`);
  }
  return info;
}

async function requireOrdinaryFile(file, label, maximumBytes = MAX_SIZE_BYTES) {
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    fail(error?.code === "ENOENT" ? "FILE_MISSING" : "FILE_UNREADABLE", `${label}: ${file}`);
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    fail("FILE_NOT_ORDINARY", `${label} must be an ordinary file: ${file}`);
  }
  if (!Number.isSafeInteger(info.size) || info.size < 0 || info.size > maximumBytes) {
    fail("FILE_SIZE_INVALID", `${label} size is outside 0..${maximumBytes}: ${file}`);
  }
  return info;
}

async function assertNoWindowsReparsePoints(paths, label) {
  if (process.platform !== "win32") return;
  const uniquePaths = [];
  const seen = new Set();
  for (const candidate of paths) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    uniquePaths.push(resolved);
  }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$items = [Console]::In.ReadToEnd() | ConvertFrom-Json",
    "foreach ($itemPath in $items) {",
    "  $item = Get-Item -LiteralPath ([string]$itemPath) -Force -ErrorAction Stop",
    "  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {",
    "    [Console]::Error.WriteLine(('REPARSE_POINT:' + [string]$itemPath))",
    "    exit 42",
    "  }",
    "}",
  ].join("\n");
  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { input: JSON.stringify(uniquePaths), encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) {
    fail(
      result.status === 42 ? "WINDOWS_REPARSE_POINT_FORBIDDEN" : "WINDOWS_REPARSE_CHECK_FAILED",
      `${label} failed Windows reparse-point validation: ${String(result.stderr ?? "").trim()}`,
    );
  }
}

export async function requireOrdinaryPathChain(root, target, leafKind) {
  const rootPath = resolveInside(root, root, "repository root");
  const filesystemRoot = path.parse(rootPath).root;
  const inspectedPaths = [filesystemRoot];
  let cursor = filesystemRoot;
  const rootRelative = path.relative(filesystemRoot, rootPath);
  for (const segment of rootRelative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    inspectedPaths.push(cursor);
  }
  const targetPath = resolveInside(rootPath, target, "path");
  const relative = path.relative(rootPath, targetPath);
  if (relative === "") {
    if (leafKind !== "directory") fail("PATH_KIND_INVALID", "repository root is not a file");
    await assertNoWindowsReparsePoints(inspectedPaths, "path chain");
    for (const directory of inspectedPaths) await requireDirectory(directory, "repository path component");
    return;
  }
  const segments = relative.split(path.sep);
  cursor = rootPath;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    inspectedPaths.push(cursor);
  }
  // On Windows the ordered helper checks each ancestor before touching its child,
  // so a generic reparse directory cannot be followed while validating the chain.
  await assertNoWindowsReparsePoints(inspectedPaths, "path chain");
  for (let index = 0; index < inspectedPaths.length; index += 1) {
    cursor = inspectedPaths[index];
    const isTarget = index === inspectedPaths.length - 1;
    if (isTarget && leafKind === "file") await requireOrdinaryFile(cursor, "path component");
    else await requireDirectory(cursor, "path component");
  }
}

async function ensureOrdinaryDirectory(root, directory) {
  const rootPath = resolveInside(root, root, "repository root");
  await requireOrdinaryPathChain(rootPath, rootPath, "directory");
  const targetPath = resolveInside(rootPath, directory, "output directory");
  const relative = path.relative(rootPath, targetPath);
  if (relative === "") return;
  let cursor = rootPath;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    try {
      const info = await lstat(cursor);
      await assertNoWindowsReparsePoints([cursor], "output path component");
      if (info.isSymbolicLink() || !info.isDirectory()) {
        fail("OUTPUT_DIRECTORY_NOT_ORDINARY", `Output path component is not an ordinary directory: ${cursor}`);
      }
    } catch (error) {
      if (error instanceof SizeReportError) throw error;
      if (error?.code !== "ENOENT") fail("OUTPUT_DIRECTORY_UNREADABLE", `Cannot inspect output directory: ${cursor}`);
      await mkdir(cursor);
      await assertNoWindowsReparsePoints([cursor], "new output path component");
    }
  }
}

function gitHead(repoRoot) {
  const result = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    fail("GIT_HEAD_UNAVAILABLE", `git rev-parse HEAD failed: ${String(result.stderr ?? "").trim()}`);
  }
  const commit = String(result.stdout ?? "").trim();
  if (!COMMIT_PATTERN.test(commit)) fail("GIT_HEAD_INVALID", `Git HEAD is not a lowercase 40-hex commit: ${commit}`);
  return commit;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function expectedDirectories(filePaths) {
  const directories = new Set();
  for (const file of filePaths) {
    let directory = path.posix.dirname(file);
    while (directory !== ".") {
      directories.add(directory);
      directory = path.posix.dirname(directory);
    }
  }
  return [...directories].sort(compareOrdinal);
}

export async function collectDistInventory(distDirectory) {
  // Both production callers validate the dist root chain before entering here.
  await requireDirectory(distDirectory, "frontend dist");
  const files = [];
  const directories = [];
  let totalBytes = 0;

  async function visit(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareOrdinal(left.name, right.name));
    const childPaths = entries.map((entry) => path.join(directory, entry.name));
    if (childPaths.length > 0) {
      // One ordered batch per verified directory, before any child lstat,
      // read, or recursion. A reparse child therefore cannot be followed.
      await assertNoWindowsReparsePoints(childPaths, "frontend dist children");
    }
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      normalizeRelativePath(relative, "dist entry");
      const fullPath = childPaths[index];
      const info = await lstat(fullPath);
      if (info.isSymbolicLink()) fail("DIST_LINK_FORBIDDEN", `dist contains a symlink/junction: ${relative}`);
      if (info.isDirectory()) {
        directories.push(relative);
        await visit(fullPath, relative);
        continue;
      }
      if (!info.isFile()) fail("DIST_ENTRY_NOT_REGULAR", `dist entry is not a regular file: ${relative}`);
      if (!Number.isSafeInteger(info.size) || info.size < 0 || info.size > MAX_SIZE_BYTES) {
        fail("DIST_FILE_SIZE_INVALID", `dist file size is outside 0..${MAX_SIZE_BYTES}: ${relative}`);
      }
      totalBytes += info.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_SIZE_BYTES) {
        fail("DIST_TOTAL_TOO_LARGE", `frontend dist exceeds ${MAX_SIZE_BYTES} bytes`);
      }
      const bytes = await readFile(fullPath);
      if (bytes.length !== info.size) fail("DIST_FILE_DRIFT", `dist file changed while measuring: ${relative}`);
      files.push({ path: relative, bytes: info.size, sha256: sha256(bytes) });
    }
  }

  await visit(distDirectory, "");
  files.sort((left, right) => compareOrdinal(left.path, right.path));
  directories.sort(compareOrdinal);
  return { files, directories, totalBytes };
}

async function consumeViteManifest(repoRoot, distDirectory, manifestPath) {
  const expectedManifest = path.join(distDirectory, ...VITE_MANIFEST_RELATIVE.split("/"));
  if (path.resolve(manifestPath) !== path.resolve(expectedManifest)) {
    fail("MANIFEST_PATH_INVALID", `Vite manifest must be ${expectedManifest}`);
  }
  const viteDirectory = path.dirname(expectedManifest);
  // Validate the complete existing chain before any manifest directory read,
  // manifest read, unlink, or metadata-directory removal.
  await requireOrdinaryPathChain(repoRoot, expectedManifest, "file");
  await requireDirectory(viteDirectory, "Vite manifest directory");
  const manifestInfo = await requireOrdinaryFile(expectedManifest, "Vite manifest", 16 * 1024 * 1024);
  try {
    const names = (await readdir(viteDirectory)).sort(compareOrdinal);
    if (names.length !== 1 || names[0] !== "manifest.json") {
      fail("VITE_METADATA_NOT_CLOSED", `.vite must contain only manifest.json; found: ${names.join(",")}`);
    }
    if (manifestInfo.size === 0) fail("MANIFEST_EMPTY", "Vite manifest must not be empty");
    const raw = await readFile(expectedManifest, "utf8");
    try {
      return JSON.parse(raw);
    } catch (error) {
      fail("MANIFEST_JSON_INVALID", `Vite manifest is invalid JSON: ${error.message}`);
    }
  } finally {
    await unlink(expectedManifest);
    try {
      await rmdir(viteDirectory);
    } catch (error) {
      fail("VITE_METADATA_REMAINS", `.vite metadata directory was not empty after manifest capture: ${error.message}`);
    }
  }
}

function stringArray(value, label, { paths = false, identifiers = false } = {}) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail("MANIFEST_FIELD_INVALID", `${label} must be an array of strings`);
  }
  const seen = new Set();
  for (const item of value) {
    if (paths) normalizeRelativePath(item, label);
    if (identifiers) normalizeManifestIdentifier(item, label);
    if (seen.has(item)) fail("MANIFEST_FIELD_DUPLICATE", `${label} contains a duplicate: ${item}`);
    seen.add(item);
  }
  return value;
}

function analyzeManifest(manifest, inventory) {
  if (!isPlainObject(manifest) || Object.keys(manifest).length === 0) {
    fail("MANIFEST_ROOT_INVALID", "Vite manifest must be a non-empty object");
  }
  const chunks = new Map();
  const outputOwners = new Map();
  const referencedOutputs = new Set();

  for (const [rawKey, value] of Object.entries(manifest)) {
    const key = normalizeManifestIdentifier(rawKey, "manifest key");
    if (!isPlainObject(value)) fail("MANIFEST_CHUNK_INVALID", `Manifest chunk must be an object: ${key}`);
    const unknownFields = Object.keys(value).filter((field) => !MANIFEST_CHUNK_FIELDS.has(field));
    if (unknownFields.length > 0) {
      fail("MANIFEST_CHUNK_FIELDS_INVALID", `Manifest chunk ${key} has unknown fields: ${unknownFields.sort(compareOrdinal).join(",")}`);
    }
    const file = normalizeRelativePath(value.file, `manifest[${key}].file`);
    if (outputOwners.has(file)) {
      fail("MANIFEST_OUTPUT_DUPLICATE", `Manifest chunks share output ${file}: ${outputOwners.get(file)},${key}`);
    }
    outputOwners.set(file, key);
    if (value.name !== undefined && (typeof value.name !== "string" || value.name.length === 0 || value.name.includes("\0"))) {
      fail("MANIFEST_FIELD_INVALID", `manifest[${key}].name must be a non-empty string without NUL bytes`);
    }
    stringArray(value.names, `manifest[${key}].names`, { identifiers: true });
    if (value.src !== undefined) normalizeManifestIdentifier(value.src, `manifest[${key}].src`);
    for (const field of ["isEntry", "isDynamicEntry"]) {
      if (value[field] !== undefined && typeof value[field] !== "boolean") {
        fail("MANIFEST_FIELD_INVALID", `manifest[${key}].${field} must be boolean`);
      }
    }
    const imports = stringArray(value.imports, `manifest[${key}].imports`, { identifiers: true });
    const dynamicImports = stringArray(value.dynamicImports, `manifest[${key}].dynamicImports`, { identifiers: true });
    const css = stringArray(value.css, `manifest[${key}].css`, { paths: true });
    const assets = stringArray(value.assets, `manifest[${key}].assets`, { paths: true });
    referencedOutputs.add(file);
    for (const output of [...css, ...assets]) referencedOutputs.add(output);
    chunks.set(key, { key, file, src: value.src, isEntry: value.isEntry, isDynamicEntry: value.isDynamicEntry, imports, dynamicImports });
  }

  for (const chunk of chunks.values()) {
    for (const reference of [...chunk.imports, ...chunk.dynamicImports]) {
      if (!chunks.has(reference)) fail("MANIFEST_IMPORT_MISSING", `${chunk.key} references missing manifest chunk ${reference}`);
    }
  }

  const inventoryPaths = inventory.files.map((file) => file.path);
  const inventoryByPath = new Map(inventory.files.map((file) => [file.path, file]));
  const controlledWorkerAssets = new Map();
  for (const [workerName, pattern] of CONTROLLED_HELPER_WORKERS) {
    const matches = inventoryPaths.filter((file) => pattern.test(file));
    if (matches.length !== 1) {
      fail("CONTROLLED_WORKER_ASSET_INVALID", `Expected exactly one ${workerName} asset; found ${matches.length}`);
    }
    const workerAsset = matches[0];
    if (inventoryByPath.get(workerAsset).bytes <= 0) {
      fail("CONTROLLED_WORKER_ASSET_EMPTY", `${workerName} asset must be non-empty: ${workerAsset}`);
    }
    controlledWorkerAssets.set(workerName, workerAsset);
  }
  const allowedFiles = new Set([
    FRONTEND_ENTRY_SOURCE,
    ...referencedOutputs,
    ...controlledWorkerAssets.values(),
  ]);
  const missing = [...allowedFiles].filter((file) => !inventoryPaths.includes(file)).sort();
  const extra = inventoryPaths.filter((file) => !allowedFiles.has(file)).sort();
  if (missing.length > 0 || extra.length > 0) {
    fail("DIST_FILE_SET_NOT_CLOSED", `dist/manifest file closure mismatch; missing=[${missing.join(",")}] extra=[${extra.join(",")}]`);
  }
  const expectedDirectorySet = expectedDirectories(inventoryPaths);
  if (JSON.stringify(inventory.directories) !== JSON.stringify(expectedDirectorySet)) {
    fail("DIST_DIRECTORY_SET_NOT_CLOSED", `dist contains unexpected empty directories: ${inventory.directories.join(",")}`);
  }

  const entryChunks = [...chunks.values()].filter((chunk) => chunk.isEntry === true);
  if (
    entryChunks.length !== 1
    || entryChunks[0].key !== FRONTEND_ENTRY_SOURCE
    || entryChunks[0].src !== FRONTEND_ENTRY_SOURCE
    || !entryChunks[0].file.endsWith(".js")
  ) {
    fail("FRONTEND_ENTRY_INVALID", `Expected one ${FRONTEND_ENTRY_SOURCE} JavaScript entry chunk`);
  }
  const entry = entryChunks[0];
  const visited = new Set();
  function visitStatic(key) {
    if (visited.has(key)) return;
    visited.add(key);
    const chunk = chunks.get(key);
    if (!chunk.file.endsWith(".js")) fail("INITIAL_CHUNK_NOT_JS", `Initial static chunk is not JavaScript: ${chunk.file}`);
    for (const importedKey of chunk.imports) visitStatic(importedKey);
  }
  visitStatic(entry.key);
  const initialJsFiles = [...new Set([...visited].map((key) => chunks.get(key).file))]
    .sort(compareOrdinal);

  const agentChunks = [...chunks.values()].filter((chunk) => chunk.src === AGENT_PROFILE_SOURCE);
  if (
    agentChunks.length !== 1
    || agentChunks[0].key !== AGENT_PROFILE_SOURCE
    || agentChunks[0].isDynamicEntry !== true
    || !agentChunks[0].file.endsWith(".js")
  ) {
    fail("AGENT_PROFILE_SOURCE_INVALID", `Expected one dynamic chunk with exact source ${AGENT_PROFILE_SOURCE}`);
  }
  const agentChunk = agentChunks[0];
  if (initialJsFiles.includes(agentChunk.file)) {
    fail("AGENT_PROFILE_NOT_LAZY", `Agent profile chunk entered the initial static closure: ${agentChunk.file}`);
  }

  const byPath = new Map(inventory.files.map((file) => [file.path, file]));
  const sum = (paths) => paths.reduce((total, file) => total + byPath.get(file).bytes, 0);
  const officeWorkerAsset = controlledWorkerAssets.get("officeWorker");
  const officeWorkerBytes = byPath.get(officeWorkerAsset).bytes;
  return {
    frontendEntryFile: entry.file,
    frontendInitialJsFiles: initialJsFiles,
    agentProfileChunkFile: agentChunk.file,
    officeWorkerAsset,
    frontendDistBytes: inventory.totalBytes,
    frontendAppBytes: inventory.totalBytes - officeWorkerBytes,
    officeWorkerBytes,
    initialJsBytes: sum(initialJsFiles),
    agentProfileChunkBytes: byPath.get(agentChunk.file).bytes,
  };
}

async function writeReport(repoRoot, reportPath, report) {
  const fullPath = resolveInside(repoRoot, reportPath, "size report");
  await ensureOrdinaryDirectory(repoRoot, path.dirname(fullPath));
  let existed = false;
  try {
    const existing = await lstat(fullPath);
    existed = true;
    await assertNoWindowsReparsePoints([fullPath], "size report output");
    if (existing.isSymbolicLink() || !existing.isFile()) {
      fail("REPORT_OUTPUT_NOT_ORDINARY", `Refusing to replace non-ordinary report output: ${fullPath}`);
    }
  } catch (error) {
    if (error instanceof SizeReportError) throw error;
    if (error?.code !== "ENOENT") fail("REPORT_OUTPUT_UNREADABLE", `Cannot inspect report output: ${fullPath}`);
  }
  await writeFile(
    fullPath,
    `${JSON.stringify(report, null, 2)}\n`,
    { encoding: "utf8", flag: existed ? "w" : "wx" },
  );
  return fullPath;
}

export async function createFrontendSizeReport(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? defaultRepoRoot);
  const distDirectory = resolveInside(
    repoRoot,
    options.distDirectory ?? path.join(repoRoot, ...FRONTEND_DIST_RELATIVE.split("/")),
    "frontend dist",
  );
  const manifestPath = resolveInside(
    distDirectory,
    options.manifestPath ?? path.join(distDirectory, ...VITE_MANIFEST_RELATIVE.split("/")),
    "Vite manifest",
  );
  const reportPath = resolveInside(
    repoRoot,
    options.reportPath ?? path.join(repoRoot, "artifacts", "size", "size-report.json"),
    "size report",
  );
  await requireOrdinaryPathChain(repoRoot, distDirectory, "directory");
  const commit = options.commit ?? gitHead(repoRoot);
  if (!COMMIT_PATTERN.test(commit)) fail("COMMIT_INVALID", `Report commit must be lowercase 40-hex: ${commit}`);

  const manifest = await consumeViteManifest(repoRoot, distDirectory, manifestPath);
  const inventory = await collectDistInventory(distDirectory);
  const metrics = analyzeManifest(manifest, inventory);
  const report = {
    schemaVersion: SIZE_REPORT_SCHEMA,
    commit,
    frontendDistPath: FRONTEND_DIST_RELATIVE,
    frontendEntrySource: FRONTEND_ENTRY_SOURCE,
    frontendEntryFile: metrics.frontendEntryFile,
    frontendInitialJsFiles: metrics.frontendInitialJsFiles,
    agentProfileSource: AGENT_PROFILE_SOURCE,
    agentProfileChunkFile: metrics.agentProfileChunkFile,
    officeWorkerAsset: metrics.officeWorkerAsset,
    frontendFiles: inventory.files,
    releaseArtifacts: {
      usefulExe: null,
      bootstrapExe: null,
      portableLiteZip: null,
      setupLite: null,
      portableFullZip: null,
    },
    usefulExeBytes: null,
    bootstrapExeBytes: null,
    frontendAppBytes: metrics.frontendAppBytes,
    officeWorkerBytes: metrics.officeWorkerBytes,
    frontendDistBytes: metrics.frontendDistBytes,
    initialJsBytes: metrics.initialJsBytes,
    agentProfileChunkBytes: metrics.agentProfileChunkBytes,
    portableLiteZipBytes: null,
    setupLiteBytes: null,
    portableFullZipBytes: null,
  };
  const output = await writeReport(repoRoot, reportPath, report);
  return { report, reportPath: output };
}

async function main() {
  const result = await createFrontendSizeReport();
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "useful.frontend-size-capture.v1",
    ok: true,
    commit: result.report.commit,
    report: path.relative(defaultRepoRoot, result.reportPath).replaceAll(path.sep, "/"),
    frontendDistBytes: result.report.frontendDistBytes,
    frontendAppBytes: result.report.frontendAppBytes,
    officeWorkerBytes: result.report.officeWorkerBytes,
    initialJsBytes: result.report.initialJsBytes,
    agentProfileChunkBytes: result.report.agentProfileChunkBytes,
  })}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    const code = error instanceof SizeReportError ? error.code : "FRONTEND_SIZE_CAPTURE_FAILED";
    process.stderr.write(`${code}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
