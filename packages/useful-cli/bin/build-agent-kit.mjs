import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { builtinModules } from "node:module";
import { mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build as esbuild } from "esbuild";
import {
  PINNED_LICENSE_FILE_SHA256,
  digestLegalTextBytes,
} from "./license-policy.mjs";

export const AGENT_KIT_SCHEMA_VERSION = "useful.agent-kit.manifest.v1";
export const AGENT_KIT_RESULT_SCHEMA_VERSION = "useful.agent-kit.build-result.v1";
export const AGENT_KIT_NODE_REQUIREMENT = ">=20";

const MANIFEST_NAME = "MANIFEST.json";
const MAX_ENTRIES = 4096;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const REQUIRED_LEGAL_FILES = Object.freeze(["LICENSE", "LICENSES.md", "NOTICE", "THIRD_PARTY_NOTICES.md", "TRADEMARKS.md"]);
const FIRST_PARTY_LICENSE_FILES = Object.freeze([
  "licenses/README.md",
  "licenses/MPL-2.0.txt",
  "licenses/Apache-2.0.txt",
  "licenses/AGPL-3.0-or-later.txt",
  "licenses/CC-BY-4.0.txt",
]);
const REQUIRED_KIT_LEGAL_FILES = Object.freeze([
  ...REQUIRED_LEGAL_FILES,
  ...FIRST_PARTY_LICENSE_FILES,
  "THIRD_PARTY-LICENSES.json",
]);
const SOURCE_PATHS = Object.freeze([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "LICENSE",
  "LICENSES.md",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
  "TRADEMARKS.md",
  "licenses",
  "packages/action-contract",
  "packages/action-runtime",
  "packages/agent-integrations",
  "packages/agent-profile",
  "packages/host-actions",
  "packages/office-core",
  "packages/plugin-actions",
  "packages/protocol",
  "packages/useful-cli",
  "packages/useful-mcp",
  "packages/useful-runtime",
]);
const COMMANDS = Object.freeze([
  { name: "useful", entry: "lib/useful.mjs", posix: "bin/useful", windows: "bin/useful.cmd" },
  { name: "useful-runtime", entry: "lib/useful-runtime.mjs", posix: "bin/useful-runtime", windows: "bin/useful-runtime.cmd" },
  { name: "useful-mcp", entry: "lib/useful-mcp.mjs", posix: "bin/useful-mcp", windows: "bin/useful-mcp.cmd" },
]);
const AGENT_INTEGRATIONS_PROVENANCE_FILES = Object.freeze([
  "integration.mjs",
  "integration.d.ts",
]);
const PROTOCOL_AGENT_CONNECTION_PROVENANCE_FILES = Object.freeze([
  "agent-connection.mjs",
  "agent-connection.d.ts",
  "agent-integration.mjs",
  "agent-integration.d.ts",
]);
const PROTOCOL_AGENT_PROBE_PROVENANCE_FILES = Object.freeze([
  "agent-probe.mjs",
  "agent-probe.d.ts",
]);
const PROTOCOL_AGENT_CONNECTION_VERIFICATION_PROVENANCE_FILES = Object.freeze([
  "agent-connection-verification.mjs",
  "agent-connection-verification.d.ts",
]);
const ACTION_RUNTIME_PROVENANCE_FILES = Object.freeze([
  "action-suggest.mjs",
  "builtins.mjs",
  "recipe.mjs",
  "semantics.mjs",
  "node-hash.mjs",
  "node-regex.mjs",
  "regex-worker-thread.mjs",
  "utility-actions.mjs",
  "office-actions.mjs",
  "node-office.mjs",
  "office-worker-thread.mjs",
]);
const OFFICE_CORE_PROVENANCE_FILES = Object.freeze([
  "index.mjs",
  "errors.mjs",
  "limits.mjs",
  "xml.mjs",
  "zip.mjs",
  "docx.mjs",
  "pptx.mjs",
  "xlsx.mjs",
  "csv.mjs",
  "table-markdown.mjs",
  "markdown.mjs",
  "pdf.mjs",
]);
const HOST_ACTION_PROVENANCE_FILES = Object.freeze([
  "index.mjs",
  "useful.host-actions.v1.schema.json",
]);
const NODE_BUILTIN_IMPORTS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => name.startsWith("node:") ? name : `node:${name}`),
]);
const THIRD_PARTY_LICENSE_FILE = /^(?:licen[cs]es?|copying)(?:[._-][A-Za-z0-9._-]+)?$/i;
const THIRD_PARTY_NOTICE_FILE = /^(?:notice|copyright(?:notice)?|patents?|authors|third[-_]?party[-_]?notices?)(?:[._-][A-Za-z0-9._-]+)?$/i;
const THIRD_PARTY_LICENSES_SCHEMA = "useful.agent-kit.third-party-licenses.v1";

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
    table[index] = value >>> 0;
  }
  return table;
})();

export class AgentKitError extends Error {
  constructor(code, message, exitCode = 4, details = {}) {
    super(message);
    this.name = "AgentKitError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

function fail(code, message, exitCode = 4, details = {}) {
  throw new AgentKitError(code, message, exitCode, details);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizedText(bytes) {
  return Buffer.from(bytes.toString("utf8").replace(/\r\n?/g, "\n"), "utf8");
}

function assertApprovedLegalMapping(repoRoot) {
  for (const relative of [...REQUIRED_LEGAL_FILES, ...FIRST_PARTY_LICENSE_FILES]) {
    const expectedSha256 = PINNED_LICENSE_FILE_SHA256[relative];
    if (typeof expectedSha256 !== "string") {
      fail("LEGAL_MAPPING_UNPINNED", "Agent Kit legal material is not bound to the approved map", 5, {
        path: relative,
      });
    }
    const file = assertRegularFile(path.join(repoRoot, ...relative.split("/")), repoRoot, `root ${relative}`);
    const actualSha256 = digestLegalTextBytes(fs.readFileSync(file));
    if (actualSha256 !== expectedSha256) {
      fail("LEGAL_MAPPING_UNAPPROVED", "Agent Kit legal material differs from the owner-approved map", 5, {
        path: relative,
        expectedSha256,
        actualSha256,
      });
    }
  }
}

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function containsAbsoluteBuildPath(text, roots) {
  const variants = new Set();
  for (const root of roots) {
    const native = path.resolve(root).replace(/[\\/]+$/, "");
    const forward = native.replaceAll("\\", "/");
    for (const value of [native, forward, pathToFileURL(native).href.replace(/\/$/, "")]) {
      variants.add(value);
      variants.add(JSON.stringify(value).slice(1, -1));
    }
  }
  const searchable = text.toLowerCase();
  return [...variants].some((value) => value.length > 1 && searchable.includes(value.toLowerCase()));
}

function normalizeEntryName(value) {
  if (typeof value !== "string" || value.includes("\0") || value.includes("\\")) {
    fail("INVALID_ENTRY_NAME", "Agent Kit entry name is invalid", 4, { entry: value });
  }
  const segments = value.split("/");
  if (!value || value.startsWith("/") || /^[A-Za-z]:/.test(value) || segments.some((part) => !part || part === "." || part === "..")) {
    fail("INVALID_ENTRY_NAME", "Agent Kit entry name is unsafe", 4, { entry: value });
  }
  const windowsDevice = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i;
  const hasControlCharacter = (part) => [...part].some((character) => character.codePointAt(0) <= 0x1f);
  if (segments.some((part) => /[<>:"|?*]/.test(part) || hasControlCharacter(part) || /[ .]$/.test(part) || windowsDevice.test(part))) {
    fail("INVALID_ENTRY_NAME", "Agent Kit entry name is not portable", 4, { entry: value });
  }
  if (value.normalize("NFC") !== value) fail("INVALID_ENTRY_NAME", "Agent Kit entry name must use NFC", 4, { entry: value });
  return value;
}

function portableEntryKey(value) {
  return value.normalize("NFC").toUpperCase();
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function comparableRealPath(value) {
  const normalized = path.resolve(value).replace(/^\\\\\?\\/, "").replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function assertNoLinkedPathComponents(target, allowMissing = false) {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  const segments = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  let missing = false;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) {
      missing = true;
      continue;
    }
    if (missing) fail("PATH_COMPONENT_INCONSISTENT", "A child exists below a missing path component", 4, { path: current });
    const metadata = fs.lstatSync(current);
    let real;
    try {
      real = fs.realpathSync.native(current);
    } catch {
      fail("PATH_COMPONENT_UNREADABLE", "A path component cannot be resolved safely", 4, { path: current });
    }
    if (metadata.isSymbolicLink() || comparableRealPath(real) !== comparableRealPath(current)) {
      fail("PATH_LINK_REJECTED", "Symlink, junction, or reparse-point path component rejected", 4, { path: current });
    }
  }
  if (!allowMissing && missing) fail("PATH_MISSING", "A required path component is missing", 3, { path: resolved });
}

function assertRegularFile(file, root, label) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(file);
  assertNoLinkedPathComponents(resolvedRoot);
  assertNoLinkedPathComponents(resolved);
  if (!isInside(resolvedRoot, resolved)) fail("SOURCE_OUTSIDE_ROOT", `${label} escapes its root`, 4, { path: resolved });
  let metadata;
  try {
    metadata = fs.lstatSync(resolved);
  } catch {
    fail("REQUIRED_FILE_MISSING", `${label} is required`, 3, { path: resolved });
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    fail("SOURCE_NOT_REGULAR_FILE", `${label} must be a regular file and not a link`, 4, { path: resolved });
  }
  if (metadata.size === 0) fail("SOURCE_FILE_EMPTY", `${label} must not be empty`, 3, { path: resolved });
  if (metadata.size > MAX_FILE_BYTES) fail("SOURCE_FILE_TOO_LARGE", `${label} exceeds the file budget`, 4, { path: resolved, size: metadata.size });
  return resolved;
}

async function readSourceFile(root, relative, label = relative) {
  const file = assertRegularFile(path.join(root, ...relative.split("/")), root, label);
  return readFile(file);
}

function addEntry(entries, name, data, mode = 0o100644) {
  const normalized = normalizeEntryName(name);
  if (entries.has(normalized)) fail("DUPLICATE_ENTRY", "Duplicate Agent Kit entry rejected", 4, { entry: normalized });
  const portableKey = portableEntryKey(normalized);
  if ([...entries.keys()].some((existing) => portableEntryKey(existing) === portableKey)) {
    fail("PORTABLE_ENTRY_COLLISION", "Case-equivalent Agent Kit entry rejected", 4, { entry: normalized });
  }
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (bytes.length > MAX_FILE_BYTES) fail("ENTRY_TOO_LARGE", "Agent Kit entry exceeds the file budget", 4, { entry: normalized, size: bytes.length });
  entries.set(normalized, { data: bytes, mode });
}

function validateBudgets(entries) {
  if (entries.size > MAX_ENTRIES) fail("TOO_MANY_ENTRIES", "Agent Kit entry budget exceeded", 4, { entries: entries.size });
  const total = [...entries.values()].reduce((sum, entry) => sum + entry.data.length, 0);
  if (total > MAX_TOTAL_BYTES) fail("KIT_TOO_LARGE", "Agent Kit expanded-size budget exceeded", 4, { total });
}

function gitValue(repoRoot, args, code) {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }).trim();
  } catch {
    fail(code, "Unable to read required git source metadata", 4);
  }
}

function assertCleanSource(repoRoot) {
  const status = gitValue(
    repoRoot,
    ["status", "--porcelain=v1", "--untracked-files=all", "--", ...SOURCE_PATHS],
    "GIT_STATUS_UNAVAILABLE",
  );
  if (status) {
    fail("SOURCE_DIRTY", "Agent Kit inputs must exactly match the committed source revision", 3, {
      changedEntries: status.split(/\r?\n/).filter(Boolean).length,
    });
  }
}

function resolveEpoch(repoRoot, explicitEpoch) {
  const raw = explicitEpoch ?? process.env.SOURCE_DATE_EPOCH ?? gitValue(repoRoot, ["show", "-s", "--format=%ct", "HEAD"], "GIT_COMMIT_TIME_UNAVAILABLE");
  if (!/^[0-9]+$/.test(String(raw))) fail("INVALID_SOURCE_DATE_EPOCH", "SOURCE_DATE_EPOCH must be an integer number of seconds", 2);
  const epoch = Number(raw);
  const date = new Date(epoch * 1000);
  const year = date.getUTCFullYear();
  if (!Number.isSafeInteger(epoch) || year < 1980 || year > 2107) {
    fail("INVALID_SOURCE_DATE_EPOCH", "SOURCE_DATE_EPOCH is outside the ZIP timestamp range", 2, { epoch });
  }
  return epoch;
}

function dosDateTime(epoch) {
  const date = new Date(epoch * 1000);
  return {
    date: ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
  };
}

function zipBytes(entries, epoch) {
  validateBudgets(entries);
  const timestamp = dosDateTime(epoch);
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const [name, entry] of [...entries.entries()].sort(([left], [right]) => compareCodePoints(left, right))) {
    const nameBytes = Buffer.from(name, "utf8");
    const checksum = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(timestamp.time, 10);
    local.writeUInt16LE(timestamp.date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(timestamp.time, 12);
    central.writeUInt16LE(timestamp.date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((entry.mode & 0xffff) * 0x10000, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + entry.data.length;
  }

  const centralOffset = offset;
  const centralBytes = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.size, 8);
  end.writeUInt16LE(entries.size, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralBytes, end]);
}

function findEndOfCentralDirectory(bytes) {
  const earliest = Math.max(0, bytes.length - 65557);
  for (let offset = bytes.length - 22; offset >= earliest; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  fail("ZIP_INVALID", "ZIP end-of-central-directory record is missing");
}

export function readAgentKitZip(bytes) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  const endOffset = findEndOfCentralDirectory(bytes);
  const disk = bytes.readUInt16LE(endOffset + 4);
  const centralDisk = bytes.readUInt16LE(endOffset + 6);
  const entriesOnDisk = bytes.readUInt16LE(endOffset + 8);
  const entryCount = bytes.readUInt16LE(endOffset + 10);
  const centralSize = bytes.readUInt32LE(endOffset + 12);
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  const commentLength = bytes.readUInt16LE(endOffset + 20);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount || endOffset + 22 + commentLength !== bytes.length || centralOffset + centralSize !== endOffset) {
    fail("ZIP_INVALID", "Multi-disk, trailing-data, or inconsistent ZIP rejected");
  }
  if (entryCount > MAX_ENTRIES) fail("TOO_MANY_ENTRIES", "Agent Kit entry budget exceeded");

  const entries = new Map();
  const portableNames = new Set();
  const localRanges = [];
  let cursor = centralOffset;
  let expanded = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > endOffset || bytes.readUInt32LE(cursor) !== 0x02014b50) fail("ZIP_INVALID", "Invalid ZIP central directory");
    const madeBy = bytes.readUInt16LE(cursor + 4);
    const versionNeeded = bytes.readUInt16LE(cursor + 6);
    const flags = bytes.readUInt16LE(cursor + 8);
    const compression = bytes.readUInt16LE(cursor + 10);
    const modifiedTime = bytes.readUInt16LE(cursor + 12);
    const modifiedDate = bytes.readUInt16LE(cursor + 14);
    const checksum = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const entryCommentLength = bytes.readUInt16LE(cursor + 32);
    const diskStart = bytes.readUInt16LE(cursor + 34);
    const internalAttributes = bytes.readUInt16LE(cursor + 36);
    const externalAttributes = bytes.readUInt32LE(cursor + 38);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd + extraLength + entryCommentLength > endOffset) fail("ZIP_INVALID", "Truncated ZIP central entry");
    const name = normalizeEntryName(bytes.subarray(nameStart, nameEnd).toString("utf8"));
    if (entries.has(name)) fail("DUPLICATE_ENTRY", "Duplicate Agent Kit entry rejected", 4, { entry: name });
    const portableName = portableEntryKey(name);
    if (portableNames.has(portableName)) fail("PORTABLE_ENTRY_COLLISION", "Case-equivalent ZIP entry rejected", 4, { entry: name });
    portableNames.add(portableName);
    if (versionNeeded !== 20 || flags !== 0x0800 || compression !== 0 || compressedSize !== size || extraLength !== 0 || entryCommentLength !== 0 || diskStart !== 0 || internalAttributes !== 0) {
      fail("ZIP_UNSUPPORTED", "Encrypted, descriptor-based, or compressed ZIP entry rejected", 4, { entry: name });
    }
    const unixMode = madeBy >> 8 === 3 ? (externalAttributes >>> 16) & 0xffff : 0;
    if ((unixMode & 0o170000) !== 0o100000 || ![0o100644, 0o100755].includes(unixMode) || name.endsWith("/")) {
      fail("ZIP_LINK_OR_DIRECTORY", "Links, directories, and non-regular modes are rejected", 4, { entry: name });
    }
    if (size > MAX_FILE_BYTES) fail("ENTRY_TOO_LARGE", "Agent Kit entry exceeds the file budget", 4, { entry: name, size });
    expanded += size;
    if (expanded > MAX_TOTAL_BYTES) fail("KIT_TOO_LARGE", "Agent Kit expanded-size budget exceeded");

    if (localOffset + 30 > centralOffset || bytes.readUInt32LE(localOffset) !== 0x04034b50) fail("ZIP_INVALID", "Invalid ZIP local header");
    const localVersionNeeded = bytes.readUInt16LE(localOffset + 4);
    const localFlags = bytes.readUInt16LE(localOffset + 6);
    const localCompression = bytes.readUInt16LE(localOffset + 8);
    const localModifiedTime = bytes.readUInt16LE(localOffset + 10);
    const localModifiedDate = bytes.readUInt16LE(localOffset + 12);
    const localChecksum = bytes.readUInt32LE(localOffset + 14);
    const localCompressedSize = bytes.readUInt32LE(localOffset + 18);
    const localSize = bytes.readUInt32LE(localOffset + 22);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const localNameStart = localOffset + 30;
    const localNameEnd = localNameStart + localNameLength;
    const dataStart = localNameEnd + localExtraLength;
    const dataEnd = dataStart + size;
    if (
      localVersionNeeded !== versionNeeded
      || localFlags !== flags
      || localCompression !== compression
      || localModifiedTime !== modifiedTime
      || localModifiedDate !== modifiedDate
      || localChecksum !== checksum
      || localCompressedSize !== compressedSize
      || localSize !== size
      || localExtraLength !== 0
      || dataEnd > centralOffset
      || bytes.subarray(localNameStart, localNameEnd).toString("utf8") !== name
    ) fail("ZIP_INVALID", "ZIP local and central entry metadata mismatch");
    const data = Buffer.from(bytes.subarray(dataStart, dataEnd));
    if (crc32(data) !== checksum) fail("ZIP_CRC_MISMATCH", "ZIP entry checksum mismatch", 4, { entry: name });
    entries.set(name, { data, mode: unixMode || 0o100644 });
    localRanges.push({ start: localOffset, end: dataEnd });
    cursor = nameEnd + extraLength + entryCommentLength;
  }
  if (cursor !== endOffset) fail("ZIP_INVALID", "Unexpected central-directory bytes rejected");
  localRanges.sort((left, right) => left.start - right.start);
  let expectedOffset = 0;
  for (const range of localRanges) {
    if (range.start !== expectedOffset || range.end <= range.start) fail("ZIP_INVALID", "ZIP local entries overlap or contain unclaimed bytes");
    expectedOffset = range.end;
  }
  if (expectedOffset !== centralOffset) fail("ZIP_INVALID", "ZIP contains unclaimed bytes before its central directory");
  return entries;
}

function exactKeys(value, allowed) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort(compareCodePoints);
  const expected = [...allowed].sort(compareCodePoints);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function assertThirdPartyLicenseManifest(entries) {
  const manifestEntry = entries.get("THIRD_PARTY-LICENSES.json");
  let document;
  try {
    document = JSON.parse(manifestEntry?.data.toString("utf8") ?? "");
  } catch {
    fail("THIRD_PARTY_LICENSES_INVALID", "Third-party license manifest must be valid JSON");
  }
  if (!exactKeys(document, ["schemaVersion", "packages"])
    || document.schemaVersion !== THIRD_PARTY_LICENSES_SCHEMA
    || !Array.isArray(document.packages)
    || document.packages.length === 0
    || document.packages.length > MAX_ENTRIES) {
    fail("THIRD_PARTY_LICENSES_INVALID", "Third-party license manifest shape is invalid");
  }

  const seenPackages = new Set();
  const seenFiles = new Set();
  let priorIdentity = "";
  for (const dependency of document.packages) {
    if (!exactKeys(dependency, ["name", "version", "license", "files"])
      || typeof dependency.name !== "string"
      || dependency.name.length > 214
      || !/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(dependency.name)
      || typeof dependency.version !== "string"
      || dependency.version.length > 128
      || !/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(dependency.version)
      || typeof dependency.license !== "string"
      || dependency.license.length > 256
      || dependency.license.trim() !== dependency.license
      || !dependency.license
      || !Array.isArray(dependency.files)
      || dependency.files.length === 0) {
      fail("THIRD_PARTY_LICENSES_INVALID", "Third-party package legal metadata is invalid");
    }
    const identity = `${dependency.name}@${dependency.version}`;
    if (seenPackages.has(identity) || (priorIdentity && compareCodePoints(priorIdentity, identity) >= 0)) {
      fail("THIRD_PARTY_LICENSES_INVALID", "Third-party package list is not unique and sorted");
    }
    seenPackages.add(identity);
    priorIdentity = identity;
    const archiveRoot = `third-party/${dependency.name}/${dependency.version}`;
    let primaryLicense = false;
    for (const file of dependency.files) {
      if (!exactKeys(file, ["path", "sha256", "size"])
        || typeof file.path !== "string"
        || !file.path.startsWith(`${archiveRoot}/`)
        || file.path.slice(archiveRoot.length + 1).includes("/")
        || !/^[a-f0-9]{64}$/.test(file.sha256 ?? "")
        || !Number.isSafeInteger(file.size)
        || file.size <= 0
        || seenFiles.has(file.path)) {
        fail("THIRD_PARTY_LICENSES_INVALID", "Third-party legal file record is invalid");
      }
      const basename = path.posix.basename(file.path);
      if (!THIRD_PARTY_LICENSE_FILE.test(basename) && !THIRD_PARTY_NOTICE_FILE.test(basename)) {
        fail("THIRD_PARTY_LICENSES_INVALID", "Third-party legal file name is not allowed");
      }
      primaryLicense ||= THIRD_PARTY_LICENSE_FILE.test(basename);
      const entry = entries.get(file.path);
      if (!entry || entry.mode !== 0o100644 || entry.data.length !== file.size || sha256(entry.data) !== file.sha256) {
        fail("THIRD_PARTY_LICENSES_MISMATCH", "Third-party legal file is missing or differs from its index", 4, { entry: file.path });
      }
      seenFiles.add(file.path);
    }
    if (!primaryLicense) fail("THIRD_PARTY_LICENSES_INVALID", "Third-party package lacks a primary license file");
  }
  const archivedLegalFiles = [...entries.keys()].filter((name) => name.startsWith("third-party/"));
  if (archivedLegalFiles.length !== seenFiles.size || archivedLegalFiles.some((name) => !seenFiles.has(name))) {
    fail("THIRD_PARTY_LICENSES_MISMATCH", "Third-party legal directory is not closed by its index");
  }
}

function assertClosedManifest(entries) {
  const manifestEntry = entries.get(MANIFEST_NAME);
  if (!manifestEntry) fail("MANIFEST_MISSING", "MANIFEST.json is required");
  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.data.toString("utf8"));
  } catch {
    fail("MANIFEST_INVALID", "MANIFEST.json must contain valid JSON");
  }
  if (
    !exactKeys(manifest, ["schemaVersion", "product", "source", "node", "commands", "closure", "files"])
    || manifest.schemaVersion !== AGENT_KIT_SCHEMA_VERSION
    || !exactKeys(manifest.product, ["name", "version"])
    || manifest.product.name !== "Useful"
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.product.version ?? "")
    || !exactKeys(manifest.source, ["revision"])
    || !/^[a-f0-9]{40}$/.test(manifest.source.revision ?? "")
    || !exactKeys(manifest.node, ["requirement"])
    || manifest.node.requirement !== AGENT_KIT_NODE_REQUIREMENT
    || !exactKeys(manifest.closure, ["manifestPath", "manifestSelfExcluded"])
    || manifest.closure.manifestPath !== MANIFEST_NAME
    || manifest.closure.manifestSelfExcluded !== true
    || !Array.isArray(manifest.files)
  ) {
    fail("MANIFEST_INVALID", "Agent Kit manifest identity is invalid");
  }
  if (!exactKeys(manifest.commands, COMMANDS.map((command) => command.name))) fail("MANIFEST_INVALID", "Manifest commands must be the fixed compatibility command set");
  for (const expected of COMMANDS) {
    const actual = manifest.commands[expected.name];
    if (
      !exactKeys(actual, ["entry", "posix", "windows"])
      || actual.entry !== expected.entry
      || actual.posix !== expected.posix
      || actual.windows !== expected.windows
    ) fail("MANIFEST_INVALID", "Manifest command entry points are not the fixed compatibility paths", 4, { command: expected.name });
  }
  const listed = new Set();
  let prior = "";
  for (const item of manifest.files) {
    if (!exactKeys(item, ["path", "sha256", "size"]) || !/^[a-f0-9]{64}$/.test(item?.sha256 ?? "") || !Number.isSafeInteger(item?.size) || item.size < 0) {
      fail("MANIFEST_INVALID", "Manifest file record is invalid");
    }
    const name = normalizeEntryName(item?.path);
    if (name === MANIFEST_NAME || listed.has(name) || (prior && compareCodePoints(prior, name) >= 0)) fail("MANIFEST_INVALID", "Manifest file list is not unique and sorted");
    const entry = entries.get(name);
    if (!entry || item.size !== entry.data.length || item.sha256 !== sha256(entry.data)) fail("MANIFEST_MISMATCH", "Manifest hash or size mismatch", 4, { entry: name });
    const expectedMode = COMMANDS.some((command) => command.posix === name) ? 0o100755 : 0o100644;
    if (entry.mode !== expectedMode) fail("MANIFEST_MISMATCH", "Archive file mode is not canonical", 4, { entry: name });
    listed.add(name);
    prior = name;
  }
  const archiveNames = [...entries.keys()].filter((name) => name !== MANIFEST_NAME);
  if (archiveNames.length !== listed.size || archiveNames.some((name) => !listed.has(name))) fail("MANIFEST_NOT_CLOSED", "Archive contains an extra or missing entry");
  if (manifestEntry.mode !== 0o100644) fail("MANIFEST_MISMATCH", "MANIFEST.json mode is not canonical");
  for (const command of COMMANDS) for (const key of ["entry", "posix", "windows"]) if (!listed.has(command[key])) fail("MANIFEST_INVALID", "Manifest command points outside the closed file set");
  for (const legal of REQUIRED_KIT_LEGAL_FILES) if (!listed.has(legal)) fail("MANIFEST_INVALID", "Required legal file is absent", 4, { entry: legal });
  assertThirdPartyLicenseManifest(entries);
  return manifest;
}

export function inspectAgentKitZip(bytes) {
  const entries = readAgentKitZip(bytes);
  const manifest = assertClosedManifest(entries);
  return { entries, manifest };
}

function workspaceResolver(repoRoot) {
  const packageSource = {
    "@useful/action-contract": "packages/action-contract/src/index.mjs",
    "@useful/action-runtime": "packages/action-runtime/src/index.mjs",
    "@useful/action-runtime/browser": "packages/action-runtime/src/browser.mjs",
    "@useful/agent-integrations": "packages/agent-integrations/src/integration.mjs",
    "@useful/agent-profile": "packages/agent-profile/src/index.mjs",
    "@useful/agent-profile/node": "packages/agent-profile/src/node.mjs",
    "@useful/host-actions": "packages/host-actions/src/index.mjs",
    "@useful/office-core": "packages/office-core/src/index.mjs",
    "@useful/plugin-actions": "packages/plugin-actions/src/index.mjs",
    "@useful/protocol/agent-connection": "packages/protocol/src/agent-connection.mjs",
    "@useful/protocol/agent-integration": "packages/protocol/src/agent-integration.mjs",
    "@useful/protocol/agent-probe": "packages/protocol/src/agent-probe.mjs",
    "@useful/protocol/agent-connection-verification": "packages/protocol/src/agent-connection-verification.mjs",
    "@useful/protocol/src/schemas.mjs": "packages/protocol/src/schemas.mjs",
  };
  return {
    name: "useful-agent-kit-workspace-resolution",
    setup(build) {
      build.onResolve({ filter: /^@useful\// }, (args) => {
        const relative = packageSource[args.path];
        if (!relative) return { errors: [{ text: `Unmapped workspace import rejected: ${args.path}` }] };
        return { path: path.join(repoRoot, ...relative.split("/")) };
      });
    },
  };
}

function findNodePackageRoot(input, dependencyRoot) {
  const boundary = path.resolve(dependencyRoot);
  let current = path.dirname(path.resolve(input));
  while (isInside(boundary, current) && current !== boundary) {
    const parent = path.dirname(current);
    const grandparent = path.dirname(parent);
    if (path.basename(parent).toLowerCase() === "node_modules") return current;
    if (path.basename(grandparent).toLowerCase() === "node_modules" && path.basename(parent).startsWith("@")) return current;
    current = parent;
  }
  return undefined;
}

function thirdPartyArchiveRoot(name, version) {
  const packageName = typeof name === "string" && name.length <= 214 && /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(name) ? name : undefined;
  const packageVersion = typeof version === "string" && version.length <= 128 && /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(version) ? version : undefined;
  if (!packageName || !packageVersion) {
    fail("DEPENDENCY_METADATA_INVALID", "Bundled dependency name or version is unsafe", 5);
  }
  return `third-party/${packageName}/${packageVersion}`;
}

async function collectThirdPartyPackages(repoRoot, dependencyRoot, metafile) {
  const activeInputs = new Set();
  for (const metadata of Object.values(metafile.outputs)) {
    for (const [input, contribution] of Object.entries(metadata.inputs ?? {})) {
      if (contribution.bytesInOutput > 0) activeInputs.add(input);
    }
  }

  const packageRoots = new Set();
  for (const input of activeInputs) {
    if (input.startsWith("<")) continue;
    const resolvedInput = path.isAbsolute(input) ? input : path.resolve(repoRoot, input);
    const packageRoot = findNodePackageRoot(resolvedInput, dependencyRoot);
    if (packageRoot) {
      packageRoots.add(packageRoot);
      continue;
    }
    const repoRelative = path.relative(repoRoot, resolvedInput);
    const firstParty = isInside(repoRoot, resolvedInput)
      && !repoRelative.split(path.sep).some((segment) => segment.toLowerCase() === "node_modules");
    if (!firstParty) {
      fail("BUNDLE_INPUT_UNATTRIBUTED", "Bundled input is neither first-party source nor an attributable Node package", 5, { input });
    }
  }

  const packages = new Map();
  for (const packageRoot of packageRoots) {
    assertNoLinkedPathComponents(packageRoot);
    const manifestPath = assertRegularFile(path.join(packageRoot, "package.json"), dependencyRoot, "bundled dependency package.json");
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      fail("DEPENDENCY_METADATA_INVALID", "Bundled dependency package.json is invalid", 5);
    }
    if (typeof manifest?.name !== "string" || typeof manifest?.version !== "string" || typeof manifest?.license !== "string" || !manifest.license.trim() || manifest.license.length > 256) {
      fail("DEPENDENCY_METADATA_INVALID", "Bundled dependency must declare name, version, and license", 5);
    }
    const archiveRoot = thirdPartyArchiveRoot(manifest.name, manifest.version);
    const names = fs.readdirSync(packageRoot).filter((name) => THIRD_PARTY_LICENSE_FILE.test(name) || THIRD_PARTY_NOTICE_FILE.test(name));
    names.sort(compareCodePoints);
    if (!names.some((name) => THIRD_PARTY_LICENSE_FILE.test(name))) {
      fail("DEPENDENCY_LICENSE_MISSING", "Bundled dependency has no distributable license file", 5, {
        package: `${manifest.name}@${manifest.version}`,
      });
    }
    const files = [];
    for (const name of names) {
      const file = assertRegularFile(path.join(packageRoot, name), dependencyRoot, `dependency legal file ${manifest.name}/${name}`);
      const data = normalizedText(await readFile(file));
      if (!data.length) fail("DEPENDENCY_LICENSE_MISSING", "Bundled dependency legal file is empty", 5, { package: manifest.name, file: name });
      files.push({ name, data, sha256: sha256(data) });
    }
    const record = {
      name: manifest.name,
      version: manifest.version,
      license: manifest.license.trim(),
      archiveRoot,
      files,
    };
    const identity = `${record.name}@${record.version}`;
    const prior = packages.get(identity);
    if (prior) {
      const comparable = (value) => JSON.stringify({
        license: value.license,
        files: value.files.map((file) => ({ name: file.name, sha256: file.sha256 })),
      });
      if (comparable(prior) !== comparable(record)) {
        fail("DEPENDENCY_LICENSE_CONFLICT", "Duplicate bundled dependency has inconsistent legal metadata", 5, { package: identity });
      }
    } else {
      packages.set(identity, record);
    }
  }
  if (packages.size === 0) fail("DEPENDENCY_LICENSES_MISSING", "No third-party bundle licenses were collected", 5);
  return [...packages.values()].sort((left, right) => compareCodePoints(`${left.name}@${left.version}`, `${right.name}@${right.version}`));
}

async function buildBundles(repoRoot, dependencyRoot) {
  const entryPoints = {
    useful: path.join(repoRoot, "packages/useful-cli/bin/useful.mjs"),
    "useful-runtime": path.join(repoRoot, "packages/useful-runtime/bin/useful-runtime.mjs"),
    "useful-mcp": path.join(repoRoot, "packages/useful-mcp/bin/useful-mcp.mjs"),
    "regex-worker-thread": path.join(repoRoot, "packages/action-runtime/src/regex-worker-thread.mjs"),
    "office-worker-thread": path.join(repoRoot, "packages/action-runtime/src/office-worker-thread.mjs"),
  };
  for (const [name, file] of Object.entries(entryPoints)) assertRegularFile(file, repoRoot, `${name} entry point`);
  let result;
  try {
    result = await esbuild({
      absWorkingDir: repoRoot,
      banner: { js: "import { createRequire as __usefulCreateRequire } from \"node:module\"; const require = __usefulCreateRequire(import.meta.url);" },
      bundle: true,
      charset: "utf8",
      define: { __USEFUL_AGENT_KIT__: "true" },
      entryNames: "[name]",
      entryPoints,
      format: "esm",
      legalComments: "none",
      logLevel: "silent",
      metafile: true,
      minify: true,
      nodePaths: [
        path.join(dependencyRoot, "node_modules"),
        path.join(dependencyRoot, "packages/action-contract/node_modules"),
        path.join(dependencyRoot, "packages/action-runtime/node_modules"),
        path.join(dependencyRoot, "packages/agent-integrations/node_modules"),
        path.join(dependencyRoot, "packages/agent-profile/node_modules"),
        path.join(dependencyRoot, "packages/host-actions/node_modules"),
        path.join(dependencyRoot, "packages/office-core/node_modules"),
        path.join(dependencyRoot, "packages/plugin-actions/node_modules"),
        path.join(dependencyRoot, "packages/protocol/node_modules"),
        path.join(dependencyRoot, "packages/useful-cli/node_modules"),
        path.join(dependencyRoot, "packages/useful-mcp/node_modules"),
        path.join(dependencyRoot, "packages/useful-runtime/node_modules"),
      ],
      outdir: path.join(repoRoot, ".useful-agent-kit-virtual", "lib"),
      outExtension: { ".js": ".mjs" },
      platform: "node",
      plugins: [workspaceResolver(repoRoot)],
      sourcemap: false,
      splitting: false,
      target: "node20",
      write: false,
    });
  } catch (error) {
    fail("BUNDLE_FAILED", "Agent Kit bundle failed", 5, { message: error instanceof Error ? error.message.split("\n")[0] : "unknown" });
  }
  for (const input of Object.keys(result.metafile.inputs)) {
    if (input.startsWith("<")) continue;
    const resolvedInput = path.isAbsolute(input) ? input : path.resolve(repoRoot, input);
    assertNoLinkedPathComponents(resolvedInput);
    const metadata = fs.lstatSync(resolvedInput);
    if (!metadata.isFile() || metadata.isSymbolicLink()) fail("BUNDLE_INPUT_UNSAFE", "Bundle input must be a regular non-link file", 4, { input });
  }
  for (const [output, metadata] of Object.entries(result.metafile.outputs)) {
    for (const imported of metadata.imports ?? []) {
      if (imported.external && !NODE_BUILTIN_IMPORTS.has(imported.path)) {
        fail("BUNDLE_EXTERNAL_IMPORT", "Agent Kit bundle retained a non-Node external import", 5, {
          output: path.basename(output),
          import: imported.path,
        });
      }
    }
  }
  const bundles = new Map();
  const expectedOutputs = new Set([
    "useful.mjs",
    "useful-runtime.mjs",
    "useful-mcp.mjs",
    "regex-worker-thread.mjs",
    "office-worker-thread.mjs",
  ]);
  for (const output of result.outputFiles) {
    const name = path.basename(output.path);
    if (!expectedOutputs.has(name)) {
      fail("BUNDLE_OUTPUT_UNEXPECTED", "Unexpected bundle output rejected", 5, { output: name });
    }
    const text = output.text;
    if (containsAbsoluteBuildPath(text, [repoRoot, dependencyRoot]) || /(?:from|import\()\s*["'](?:@useful\/|@modelcontextprotocol\/|adm-zip|ajv(?:\/|["'])|yaml["'])/.test(text)) {
      fail("BUNDLE_NOT_SELF_CONTAINED", "Bundle retained an absolute path or package import", 5, { output: name });
    }
    bundles.set(`lib/${name}`, Buffer.from(output.contents));
  }
  if (bundles.size !== expectedOutputs.size || [...expectedOutputs].some((name) => !bundles.has(`lib/${name}`))) {
    fail("BUNDLE_OUTPUT_MISSING", "Expected five Agent Kit bundles", 5, { count: bundles.size });
  }
  return {
    bundles,
    thirdPartyPackages: await collectThirdPartyPackages(repoRoot, dependencyRoot, result.metafile),
  };
}

function launcherBytes(command, windows) {
  if (windows) return Buffer.from(`@ECHO off\r\nnode "%~dp0..\\${command.entry.replaceAll("/", "\\")}" %*\r\n`, "utf8");
  return Buffer.from(`#!/bin/sh\nset -eu\nexec node "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/../${command.entry}" "$@"\n`, "utf8");
}

async function addRuntimeResources(entries, repoRoot) {
  for (const relative of AGENT_INTEGRATIONS_PROVENANCE_FILES) {
    const source = `packages/agent-integrations/src/${relative}`;
    addEntry(entries, `lib/provenance/agent-integrations/${relative}`, normalizedText(await readSourceFile(repoRoot, source)));
  }
  for (const relative of PROTOCOL_AGENT_CONNECTION_PROVENANCE_FILES) {
    const source = `packages/protocol/src/${relative}`;
    addEntry(entries, `lib/provenance/protocol/${relative}`, normalizedText(await readSourceFile(repoRoot, source)));
  }
  for (const relative of PROTOCOL_AGENT_PROBE_PROVENANCE_FILES) {
    const source = `packages/protocol/src/${relative}`;
    addEntry(entries, `lib/provenance/protocol/${relative}`, normalizedText(await readSourceFile(repoRoot, source)));
  }
  for (const relative of PROTOCOL_AGENT_CONNECTION_VERIFICATION_PROVENANCE_FILES) {
    const source = `packages/protocol/src/${relative}`;
    addEntry(entries, `lib/provenance/protocol/${relative}`, normalizedText(await readSourceFile(repoRoot, source)));
  }
  for (const relative of ACTION_RUNTIME_PROVENANCE_FILES) {
    const source = `packages/action-runtime/src/${relative}`;
    addEntry(entries, `lib/provenance/action-runtime/${relative}`, normalizedText(await readSourceFile(repoRoot, source)));
  }
  for (const relative of OFFICE_CORE_PROVENANCE_FILES) {
    const source = `packages/office-core/src/${relative}`;
    addEntry(entries, `lib/provenance/office-core/${relative}`, normalizedText(await readSourceFile(repoRoot, source)));
  }
  for (const relative of HOST_ACTION_PROVENANCE_FILES) {
    const source = `packages/host-actions/src/${relative}`;
    addEntry(entries, `lib/provenance/host-actions/${relative}`, normalizedText(await readSourceFile(repoRoot, source)));
  }
  addEntry(
    entries,
    "lib/useful.plugin-action.v1.schema.json",
    normalizedText(await readSourceFile(repoRoot, "packages/plugin-actions/src/useful.plugin-action.v1.schema.json")),
  );

  const schemaRoot = path.join(repoRoot, "packages/protocol/schemas");
  assertNoLinkedPathComponents(schemaRoot);
  let schemaDirectory;
  try {
    schemaDirectory = fs.lstatSync(schemaRoot);
  } catch {
    fail("SCHEMA_DIRECTORY_MISSING", "Protocol schema directory is required", 3);
  }
  if (schemaDirectory.isSymbolicLink() || !schemaDirectory.isDirectory()) fail("SCHEMA_DIRECTORY_UNSAFE", "Protocol schema directory must not be a link");
  const schemaNames = (await readdir(schemaRoot)).filter((name) => name.endsWith(".schema.json")).sort(compareCodePoints);
  if (schemaNames.length === 0) fail("SCHEMAS_MISSING", "Protocol schemas are required", 3);
  for (const name of schemaNames) addEntry(entries, `schemas/${name}`, normalizedText(await readSourceFile(schemaRoot, name, `protocol schema ${name}`)));
}

function addThirdPartyResources(entries, packages) {
  const summary = [];
  for (const dependency of packages) {
    const legalFiles = [];
    for (const file of dependency.files) {
      const entryPath = `${dependency.archiveRoot}/${file.name}`;
      addEntry(entries, entryPath, file.data);
      legalFiles.push({ path: entryPath, sha256: file.sha256, size: file.data.length });
    }
    summary.push({
      name: dependency.name,
      version: dependency.version,
      license: dependency.license,
      files: legalFiles,
    });
  }
  addEntry(entries, "THIRD_PARTY-LICENSES.json", jsonBytes({
    schemaVersion: THIRD_PARTY_LICENSES_SCHEMA,
    packages: summary,
  }));
}

function readRootPackage(repoRoot) {
  const file = assertRegularFile(path.join(repoRoot, "package.json"), repoRoot, "root package.json");
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    fail("PACKAGE_INVALID", "Root package.json is invalid", 3);
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version ?? "")) fail("VERSION_INVALID", "Root product version is not safe SemVer", 3);
  return pkg;
}

async function createPayload(repoRoot, dependencyRoot, version) {
  const entries = new Map();
  const { bundles, thirdPartyPackages } = await buildBundles(repoRoot, dependencyRoot);
  for (const [name, data] of bundles) addEntry(entries, name, data);
  await addRuntimeResources(entries, repoRoot);
  addThirdPartyResources(entries, thirdPartyPackages);

  for (const legal of REQUIRED_LEGAL_FILES) addEntry(entries, legal, normalizedText(await readSourceFile(repoRoot, legal, `root ${legal}`)));
  for (const legal of FIRST_PARTY_LICENSE_FILES) addEntry(entries, legal, normalizedText(await readSourceFile(repoRoot, legal, legal)));
  addEntry(entries, "README.txt", Buffer.from(
    `Useful Agent Kit ${version}\n\nRequires Node.js 20 or newer.\nCompatible commands: useful, useful-runtime, useful-mcp.\nThe @useful package names and useful/useful schema identities remain compatibility interfaces.\nNo global install or monorepo-relative runtime path is required.\nBundled dependency license texts and notices are indexed by THIRD_PARTY-LICENSES.json.\nRun the local MCP self-probe on POSIX: bin/useful agent probe --json\nRun the local MCP self-probe on Windows: bin\\useful.cmd agent probe --json\nVerify a Codex connection candidate on POSIX: bin/useful agent verify --target codex --launcher <ABS_KIT>/lib/useful-mcp.mjs --json\nVerify a Codex connection candidate on Windows: bin\\useful.cmd agent verify --target codex --launcher <ABS_KIT>\\lib\\useful-mcp.mjs --json\nThe self-probe proves only this extracted directory's local MANIFEST closed set and bundled Useful MCP protocol surface; it does not attest an external Agent, signature, publisher, origin, sidecar, or publication authorization.\nIts 30-second deadline covers MCP execution and transport closure after synchronous MANIFEST preflight; it does not bound that preflight.\nAgent verify requires the current installation's fixed Useful MCP entry and fails closed for another launcher.\nIts claimScope and claims are self-reported, with documentAuthenticated false; parsing validates JSON structure, endpoint binding, and the fixed 40 = 36 + 4 tool-name closure SHA-256 2740f646530580de5ad2079f3290c01517e8b37f58c6d624293ae74e665c6f17, but it does not authenticate execution.\nThe JSON can be copied, but parsing it does not make current-host paths portable; the endpoint binds only node/launcher paths and installation identity, not environment or working directory.\nVerify does not execute output commandArgv or apply merge output, and its claims self-report no host configuration read/write by the verifier.\nV1 rejects USEFUL_PROFILE and makes no Agent Profile binding claim.\nIt does not attest Codex/Claude installation, configuration, or acceptance, a signature, publisher, origin, sidecar, publication authorization, or that the fixed launcher has no network access.\nAgent integration exports are manual-review-only and secret-free: they do not write host configuration, start a launcher, or make network connections.\nThe Claude Desktop JSON fragment is for local mcpServers merging only; remote/managed configuration is not generated.\nComputer Use has no default provider or host registration in this kit.\nThe component map is owner-approved, but this build remains an internal candidate and does not authorize publication of any specific snapshot.\n`,
    "utf8",
  ));
  addEntry(entries, "package.json", jsonBytes({
    name: "useful-agent-kit",
    version,
    description: "Useful self-contained command kit for external AI agents.",
    private: true,
    license: "SEE LICENSE IN LICENSE",
    type: "module",
    engines: { node: AGENT_KIT_NODE_REQUIREMENT },
  }));
  for (const command of COMMANDS) {
    addEntry(entries, command.posix, launcherBytes(command, false), 0o100755);
    addEntry(entries, command.windows, launcherBytes(command, true));
  }
  validateBudgets(entries);
  return entries;
}

async function reserveAndWrite(zipPath, receiptPath, archive, receipt) {
  let zipHandle;
  let receiptHandle;
  let zipCreated = false;
  let receiptCreated = false;
  try {
    zipHandle = await open(zipPath, "wx");
    zipCreated = true;
    receiptHandle = await open(receiptPath, "wx");
    receiptCreated = true;
    await zipHandle.writeFile(archive);
    await receiptHandle.writeFile(receipt);
  } catch (error) {
    await zipHandle?.close().catch(() => {});
    await receiptHandle?.close().catch(() => {});
    if (zipCreated) await rm(zipPath, { force: true }).catch(() => {});
    if (receiptCreated) await rm(receiptPath, { force: true }).catch(() => {});
    if (error?.code === "EEXIST") fail("OUTPUT_EXISTS", "Existing Agent Kit output is never overwritten", 4);
    fail("OUTPUT_WRITE_FAILED", "Unable to write Agent Kit output", 4);
  }
  await zipHandle.close();
  await receiptHandle.close();
}

export async function buildAgentKit(options) {
  if (Number(process.versions.node.split(".")[0]) < 20) fail("NODE_VERSION_UNSUPPORTED", "Node.js 20 or newer is required", 3);
  const repoRoot = path.resolve(options?.repoRoot ?? fileURLToPath(new URL("../../..", import.meta.url)));
  const dependencyRoot = path.resolve(options?.dependencyRoot ?? repoRoot);
  const outDir = path.resolve(options?.outDir ?? "");
  if (!options?.outDir) fail("OUT_DIR_REQUIRED", "--out-dir is required", 2);
  assertNoLinkedPathComponents(repoRoot);
  assertNoLinkedPathComponents(outDir, true);
  assertCleanSource(repoRoot);
  const rootPackage = readRootPackage(repoRoot);
  for (const legal of REQUIRED_LEGAL_FILES) assertRegularFile(path.join(repoRoot, legal), repoRoot, `root ${legal}`);
  assertApprovedLegalMapping(repoRoot);
  const version = rootPackage.version;
  const revision = gitValue(repoRoot, ["rev-parse", "HEAD"], "GIT_REVISION_UNAVAILABLE");
  if (!/^[a-f0-9]{40}$/.test(revision)) fail("GIT_REVISION_INVALID", "Git source revision is invalid", 4);
  const epoch = resolveEpoch(repoRoot, options?.sourceDateEpoch);

  const payload = await createPayload(repoRoot, dependencyRoot, version);
  const files = [...payload.entries()]
    .map(([entryPath, entry]) => ({ path: entryPath, sha256: sha256(entry.data), size: entry.data.length }))
    .sort((left, right) => compareCodePoints(left.path, right.path));
  const commands = Object.fromEntries(COMMANDS.map((command) => [command.name, {
    entry: command.entry,
    posix: command.posix,
    windows: command.windows,
  }]));
  const manifest = {
    schemaVersion: AGENT_KIT_SCHEMA_VERSION,
    product: { name: "Useful", version },
    source: { revision },
    node: { requirement: AGENT_KIT_NODE_REQUIREMENT },
    commands,
    closure: { manifestPath: MANIFEST_NAME, manifestSelfExcluded: true },
    files,
  };
  addEntry(payload, MANIFEST_NAME, jsonBytes(manifest));
  const archive = zipBytes(payload, epoch);
  const inspected = inspectAgentKitZip(archive);
  if (JSON.stringify(inspected.manifest) !== JSON.stringify(manifest)) fail("MANIFEST_ROUNDTRIP_FAILED", "Manifest changed during archive roundtrip", 5);

  assertNoLinkedPathComponents(outDir, true);
  await mkdir(outDir, { recursive: true });
  assertNoLinkedPathComponents(outDir);
  const outMetadata = fs.lstatSync(outDir);
  if (outMetadata.isSymbolicLink() || !outMetadata.isDirectory()) fail("OUTPUT_DIR_UNSAFE", "Output directory must be a real directory and not a link", 4);
  const assetName = `Useful-${version}-agent-kit.zip`;
  const zipPath = path.join(outDir, assetName);
  const receiptPath = `${zipPath}.sha256`;
  if (fs.existsSync(zipPath) || fs.existsSync(receiptPath)) fail("OUTPUT_EXISTS", "Existing Agent Kit output is never overwritten", 4, { zipPath, receiptPath });
  const archiveSha256 = sha256(archive);
  const receipt = Buffer.from(`${archiveSha256}  ${assetName}\n`, "utf8");
  await reserveAndWrite(zipPath, receiptPath, archive, receipt);
  return {
    schemaVersion: AGENT_KIT_RESULT_SCHEMA_VERSION,
    ok: true,
    publicationAuthorized: false,
    legalMappingApproved: true,
    product: manifest.product,
    source: manifest.source,
    node: manifest.node,
    asset: { name: assetName, path: zipPath, sha256: archiveSha256, size: archive.length },
    receipt: { name: `${assetName}.sha256`, path: receiptPath },
    manifest: { path: MANIFEST_NAME, schemaVersion: AGENT_KIT_SCHEMA_VERSION, files: files.length },
  };
}

function parseCli(args) {
  let outDir;
  let json = false;
  let sourceDateEpoch;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      if (json) fail("DUPLICATE_OPTION", "--json may only be used once", 2);
      json = true;
    } else if (arg === "--out-dir" || arg === "--source-date-epoch") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) fail("OPTION_VALUE_REQUIRED", `${arg} requires a value`, 2);
      if (arg === "--out-dir") {
        if (outDir !== undefined) fail("DUPLICATE_OPTION", "--out-dir may only be used once", 2);
        outDir = value;
      } else {
        if (sourceDateEpoch !== undefined) fail("DUPLICATE_OPTION", "--source-date-epoch may only be used once", 2);
        sourceDateEpoch = value;
      }
      index += 1;
    } else {
      fail("UNKNOWN_OPTION", `Unknown option: ${arg}`, 2);
    }
  }
  if (!json) fail("JSON_REQUIRED", "--json is required for the machine-readable Agent Kit builder", 2);
  if (!outDir) fail("OUT_DIR_REQUIRED", "--out-dir is required", 2);
  return { outDir, sourceDateEpoch };
}

async function main() {
  try {
    const options = parseCli(process.argv.slice(2));
    const result = await buildAgentKit(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const failure = error instanceof AgentKitError
      ? error
      : new AgentKitError("INTERNAL_ERROR", "Unexpected Agent Kit builder failure", 5);
    process.stdout.write(`${JSON.stringify({
      schemaVersion: AGENT_KIT_RESULT_SCHEMA_VERSION,
      ok: false,
      error: { code: failure.code, message: failure.message, details: failure.details },
    })}\n`);
    process.exitCode = failure.exitCode;
  }
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntryPoint) await main();
