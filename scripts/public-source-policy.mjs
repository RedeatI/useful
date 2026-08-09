import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath as realpathCallback } from "node:fs";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import AdmZip from "adm-zip";
import {
  decodeBrandText,
  formerBrandMatches,
  shouldScanFormerAbbreviation,
} from "./former-brand-policy.mjs";

export const PUBLIC_SOURCE_POLICY_SCHEMA = "useful.public-source-policy.v2";
export const MAX_PUBLIC_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_PUBLIC_FILES = 20_000;
export const MAX_PUBLIC_TOTAL_BYTES = 512 * 1024 * 1024;
export const MAX_PUBLIC_PATH_BYTES = 1024;
export const MAX_PUBLIC_PATH_SEGMENT_BYTES = 255;
export const MAX_PUBLIC_RECEIPT_BYTES = 16 * 1024 * 1024;
export const MAX_LOCAL_PATH_CHARS = process.platform === "win32" ? 240 : 4096;
const MAX_USEFUL_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_USEFUL_EXPANDED_BYTES = 64 * 1024 * 1024;
const MAX_USEFUL_ENTRIES = 4096;
const realpathNative = promisify(realpathCallback.native);

const PUBLIC_ROOT_FILES = new Set([
  ".editorconfig",
  ".env.example",
  ".gitattributes",
  ".gitignore",
  "AGENTS.md",
  "Cargo.lock",
  "Cargo.toml",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "GOVERNANCE.md",
  "LICENSE",
  "LICENSES.md",
  "NOTICE",
  "README.md",
  "README.zh-CN.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  "TRADEMARKS.md",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "rust-toolchain.toml",
]);

export const REQUIRED_PUBLIC_FILES = Object.freeze([
  "LICENSE",
  "LICENSES.md",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
  "TRADEMARKS.md",
  "README.md",
  "README.zh-CN.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "GOVERNANCE.md",
  ".github/CODEOWNERS",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/pull_request_template.md",
  "docs/KNOWN-LIMITATIONS.md",
  "docs/OPEN-SOURCE-RELEASE.md",
]);

const PUBLIC_ROOTS = [
  ".github/",
  "apps/",
  "licenses/",
  "assets/",
  "binaries/",
  "config/",
  "crates/",
  "deploy/",
  "docs/",
  "examples/",
  "fixtures/",
  "packages/",
  "repositories/",
  "scripts/",
  "services/",
  "templates/",
];

const EXCLUDED_PUBLIC_PATTERNS = [
  /(^|\/)handoffs?(\/|$)/i,
  /^docs\/(?:PHASE\d[^/]*|ROUND\d[^/]*)/i,
  /(^|\/)(?:RELEASE-EVIDENCE|PROJECT-STATE)(?:\.|\/|$)/i,
  /(^|\/)[^/]*REPORT[^/]*\.(?:json|md|txt)$/i,
  /(^|\/)(?:draft|[^/]+-draft)\.(?:json|md|txt)$/i,
  /^docs\/(?:BENCHMARK|PRIVACY-POLICY-draft|TERMS-OF-SERVICE-placeholder)\.md$/,
  /^scripts\/phase13/i,
  /^scripts\/prepare-beta-test-source\.mjs$/,
];

const PROHIBITED_PATH_PATTERNS = [
  /(^|\/)\.env(?!\.example$)/i,
  /\.private\.pem$/i,
  /\.(?:p12|pfx|key)$/i,
  /(^|\/)(?:node_modules|target|artifacts|dist|dist-release|dist-sbom|\.vite|coverage|bench-results|outputs|data)(\/|$)/i,
  /^apps\/useful\/src-tauri\/gen(?:\/|$)/i,
  /\.log$/i,
  /\.(?:7z|apk|appimage|ar|bz2|cab|cpio|deb|dll|dmg|dylib|ear|exe|gz|iso|jar|lha|lz|lz4|lzh|msi|rar|rpm|so|tar|tbz|tbz2|tgz|txz|war|whl|xz|zip|zst)$/i,
];

const SECRET_PATTERNS = [
  { id: "pem-private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { id: "github-token", pattern: /(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { id: "aws-access-key", pattern: /AKIA[0-9A-Z]{16}/ },
  { id: "slack-token", pattern: /xox[baprs]-[A-Za-z0-9-]{20,}/ },
];

const PUBLIC_USEFUL_FIXTURES = new Map([
  ["fixtures/normal.useful", { allowInvalid: false }],
  ["fixtures/malicious-path.useful", { allowInvalid: false }],
  ["fixtures/corrupt.useful", { allowInvalid: true }],
]);

const STATIC_EXAMPLE_PREFIX = "repositories/static-example/";

function parsePolicyJson(files, relative) {
  const bytes = files.get(relative);
  if (!bytes) throw new Error(`缺少 ${relative}`);
  return JSON.parse(bytes.toString("utf8"));
}

function checkedMetadataReference(files, relative, entry) {
  if (!entry || !Number.isSafeInteger(entry.version) || entry.version < 1) {
    throw new Error(`${relative} metadata version 非法`);
  }
  const bytes = files.get(relative);
  if (!bytes) throw new Error(`缺少 ${relative}`);
  if (entry.length !== bytes.length || entry.hashes?.sha256 !== sha256(bytes)) {
    throw new Error(`${relative} 未被上级 metadata 精确 hash/length 绑定`);
  }
  return bytes;
}

function staticTargetIdentity(custom) {
  return [
    custom?.publisherKeyId,
    custom?.toolId,
    custom?.version,
    custom?.channel,
    custom?.platform,
    custom?.arch,
    custom?.artifactSha256,
    custom?.publisherSignatureMethod,
    custom?.signatureIdentity,
  ];
}

function catalogArtifactIdentity(entry, artifact) {
  return [
    entry?.identity?.publisherKeyId,
    entry?.identity?.toolId,
    artifact?.version,
    artifact?.channel,
    artifact?.platform,
    artifact?.arch,
    artifact?.artifactSha256,
    artifact?.signatureMethod,
    artifact?.signatureIdentity,
  ];
}

function sameArtifactIdentity(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Derive the exact generated .useful allowlist from the current static example
 * timestamp -> snapshot -> targets graph and its catalog bindings. Merely
 * placing a digest-named archive under targets/ never grants an exception.
 */
export function deriveStaticExampleFixturePolicy(files) {
  const fixtures = new Map();
  const violations = [];
  if (![...files.keys()].some((relative) => relative.startsWith(STATIC_EXAMPLE_PREFIX))) {
    return { fixtures, violations };
  }
  try {
    const metadataPrefix = `${STATIC_EXAMPLE_PREFIX}metadata/`;
    const timestamp = parsePolicyJson(files, `${metadataPrefix}timestamp.json`);
    if (timestamp?.signed?._type !== "timestamp") throw new Error("timestamp metadata 类型非法");
    const snapshotEntry = timestamp?.signed?.meta?.["snapshot.json"];
    const snapshotPath = `${metadataPrefix}${snapshotEntry?.version}.snapshot.json`;
    checkedMetadataReference(files, snapshotPath, snapshotEntry);
    const snapshot = parsePolicyJson(files, snapshotPath);
    if (snapshot?.signed?._type !== "snapshot" || snapshot.signed.version !== snapshotEntry.version) {
      throw new Error("snapshot metadata 类型或版本不匹配");
    }
    const targetsEntry = snapshot?.signed?.meta?.["targets.json"];
    const targetsPath = `${metadataPrefix}${targetsEntry?.version}.targets.json`;
    checkedMetadataReference(files, targetsPath, targetsEntry);
    const targetsDoc = parsePolicyJson(files, targetsPath);
    if (targetsDoc?.signed?._type !== "targets" || targetsDoc.signed.version !== targetsEntry.version) {
      throw new Error("targets metadata 类型或版本不匹配");
    }
    const targets = targetsDoc.signed.targets;
    const catalog = parsePolicyJson(files, `${STATIC_EXAMPLE_PREFIX}catalog/snapshot.json`);
    if (!targets || typeof targets !== "object" || Array.isArray(targets)) {
      throw new Error("targets metadata 缺少 targets 表");
    }
    if (!Array.isArray(catalog?.entries)) throw new Error("catalog entries 非法");
    const catalogRows = catalog.entries.flatMap((entry) =>
      Array.isArray(entry?.artifacts)
        ? entry.artifacts.map((artifact) => ({ entry, artifact }))
        : [],
    );
    const targetRows = Object.entries(targets);
    if (catalogRows.length !== targetRows.length) {
      throw new Error("catalog artifact 数量与 TUF target 数量不一致");
    }
    for (const [name, info] of targetRows) {
      if (!/^[A-Za-z0-9._-]+\.useful$/.test(name)) throw new Error(`target 名称非法: ${name}`);
      const digest = info?.hashes?.sha256;
      if (!/^[a-f0-9]{64}$/.test(digest ?? "") || info?.custom?.artifactSha256 !== digest) {
        throw new Error(`target digest/custom 绑定非法: ${name}`);
      }
      const custom = info.custom;
      if (
        custom.publisherSignatureVerified !== true
        || custom.publisherSignatureMethod !== "ed25519"
        || custom.publisherSignaturePayloadVersion !== "useful-artifact-v1"
        || custom.signatureIdentity !== custom.publisherKeyId
        || !/^ed25519:[a-f0-9]{64}$/.test(custom.publisherKeyId ?? "")
        || !/^[a-f0-9]{128}$/.test(custom.publisherSignature ?? "")
      ) {
        throw new Error(`target publisher proof 字段非法: ${name}`);
      }
      const relative = `${STATIC_EXAMPLE_PREFIX}targets/${digest}.${name}`;
      const bytes = files.get(relative);
      if (!bytes || bytes.length !== info.length || sha256(bytes) !== digest) {
        throw new Error(`target 文件未被 metadata 精确绑定: ${name}`);
      }
      const identity = staticTargetIdentity(info.custom);
      const matches = catalogRows.filter(({ entry, artifact }) =>
        sameArtifactIdentity(identity, catalogArtifactIdentity(entry, artifact)),
      );
      if (matches.length !== 1) throw new Error(`target/catalog identity 非唯一: ${name}`);
      fixtures.set(relative, { allowInvalid: false });
    }
    for (const { entry, artifact } of catalogRows) {
      const identity = catalogArtifactIdentity(entry, artifact);
      const matches = targetRows.filter(([, info]) =>
        sameArtifactIdentity(identity, staticTargetIdentity(info?.custom)),
      );
      if (matches.length !== 1) throw new Error("catalog artifact 未被唯一 TUF target 绑定");
    }
    const actualTargets = [...files.keys()].filter(
      (relative) => relative.startsWith(`${STATIC_EXAMPLE_PREFIX}targets/`) && relative.endsWith(".useful"),
    );
    for (const relative of actualTargets) {
      if (!fixtures.has(relative)) {
        violations.push({ path: relative, code: "generated-archive-not-allowlisted" });
      }
    }
  } catch (error) {
    violations.push({
      path: STATIC_EXAMPLE_PREFIX.slice(0, -1),
      code: "static-example-trust-graph-invalid",
      details: error instanceof Error ? error.message : String(error),
    });
    fixtures.clear();
  }
  return { fixtures, violations };
}

const SAFE_BINARY_FORMATS = new Map([
  [".gif", (bytes) => bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a"],
  [".ico", (bytes) => bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0],
  [".jpg", (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff],
  [".jpeg", (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff],
  [".png", (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  [".webp", (bytes) => bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP"],
  [".icns", (bytes) => bytes.length >= 4 && bytes.subarray(0, 4).toString("ascii") === "icns"],
  [".woff", (bytes) => bytes.subarray(0, 4).toString("ascii") === "wOFF"],
  [".woff2", (bytes) => bytes.subarray(0, 4).toString("ascii") === "wOF2"],
]);

export function comparePublicPaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function runGit(repoRoot, args, { bytes = false, maxBuffer = 64 * 1024 * 1024 } = {}) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: bytes ? null : "utf8",
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
    maxBuffer,
    windowsHide: true,
  });
  if (result.error) {
    const error = new Error(`git ${args[0]} could not start`);
    error.code = result.error.code ?? "GIT_IO_FAILED";
    throw error;
  }
  if (result.status !== 0) {
    const error = new Error(`git ${args[0]} failed`);
    error.code = "GIT_FAILED";
    error.gitExitCode = result.status;
    throw error;
  }
  return result.stdout;
}

export function readGitBlob(repoRoot, object) {
  return runGit(repoRoot, ["cat-file", "blob", object], { bytes: true });
}

export function readGitCommitParents(repoRoot, commit) {
  if (!/^[0-9a-f]{40,64}$/.test(commit)) {
    const error = new Error("invalid fixed Git commit object id");
    error.code = "GIT_FAILED";
    throw error;
  }
  const raw = runGit(repoRoot, ["--no-replace-objects", "cat-file", "commit", commit]);
  const header = raw.split(/\r?\n\r?\n/, 1)[0];
  return header
    .split(/\r?\n/)
    .filter((line) => line.startsWith("parent "))
    .map((line) => line.slice("parent ".length));
}

export function readGitMetadata(repoRoot) {
  const topLevel = path.resolve(runGit(repoRoot, ["rev-parse", "--show-toplevel"]).trim());
  const commit = runGit(repoRoot, ["rev-parse", "HEAD"]).trim();
  const tree = runGit(repoRoot, ["rev-parse", `${commit}^{tree}`]).trim();
  const status = runGit(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  return { topLevel, commit, tree, dirty: status.length > 0 };
}

function parseTreeEntries(repoRoot, tree) {
  if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new Error("invalid fixed Git tree object id");
  return runGit(repoRoot, ["ls-tree", "-r", "-z", "--full-tree", tree])
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+) (\S+) ([0-9a-f]+)\t([\s\S]+)$/.exec(line);
      if (!match) throw new Error("unable to parse Git tree entry");
      return {
        tracked: true,
        mode: match[1],
        type: match[2],
        object: match[3],
        path: match[4].replaceAll("\\", "/"),
      };
    });
}

function parseUntrackedEntries(repoRoot) {
  return runGit(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean)
    .map((relative) => ({
      tracked: false,
      mode: null,
      object: null,
      path: relative.replaceAll("\\", "/"),
    }));
}

export function isPublicPath(relative) {
  return (
    (PUBLIC_ROOT_FILES.has(relative) || PUBLIC_ROOTS.some((root) => relative.startsWith(root))) &&
    !EXCLUDED_PUBLIC_PATTERNS.some((pattern) => pattern.test(relative))
  );
}

export function isExplicitlyExcluded(relative) {
  return EXCLUDED_PUBLIC_PATTERNS.some((pattern) => pattern.test(relative));
}

export function isProhibitedPath(relative) {
  return PROHIBITED_PATH_PATTERNS.some((pattern) => pattern.test(relative));
}

function isSafeRelativePath(relative) {
  if (!relative || path.posix.isAbsolute(relative) || relative.includes("\0") || relative.includes("\\")) return false;
  return relative.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const WINDOWS_INVALID_CHARS = /[<>:"|?*\u0000-\u001f]/;
const WINDOWS_SHORT_NAME_ALIAS = /^[^ .]{1,6}~[0-9]+(?:\..*)?$/i;

export function getPortablePathViolation(relative) {
  if (!isSafeRelativePath(relative)) return "unsafe-relative-path";
  if (Buffer.byteLength(relative, "utf8") > MAX_PUBLIC_PATH_BYTES) return "path-length-limit";
  for (const segment of relative.split("/")) {
    if (Buffer.byteLength(segment, "utf8") > MAX_PUBLIC_PATH_SEGMENT_BYTES) return "path-segment-length-limit";
    if (segment !== segment.normalize("NFC")) return "non-normalized-path";
    if (
      /[ .]$/.test(segment) ||
      WINDOWS_INVALID_CHARS.test(segment) ||
      WINDOWS_RESERVED_BASENAME.test(segment) ||
      WINDOWS_SHORT_NAME_ALIAS.test(segment)
    ) {
      return "unsupported-windows-path";
    }
  }
  return null;
}

export function portableWindowsPathKey(relative) {
  return relative
    .split("/")
    .map((segment) => segment.normalize("NFC").replace(/[ .]+$/g, "").toLowerCase())
    .join("/");
}

function addViolationOnce(violations, violation) {
  if (
    !violations.some(
      (candidate) =>
        candidate.path === violation.path &&
        candidate.code === violation.code &&
        candidate.details === violation.details,
    )
  ) {
    violations.push(violation);
  }
}

function scanTextForSecrets(relative, text, violations) {
  for (const secret of SECRET_PATTERNS) {
    if (secret.pattern.test(text)) {
      addViolationOnce(violations, { path: relative, code: "secret-pattern", details: secret.id });
    }
  }
}

function scanTextForFormerBrand(relative, text, violations, { includeAbbreviation = true, code = "legacy-brand-content" } = {}) {
  for (const match of formerBrandMatches(text, {
    includeAbbreviation: includeAbbreviation && shouldScanFormerAbbreviation(relative),
  })) {
    addViolationOnce(violations, { path: relative, code, details: match.kind });
  }
}

function isArchiveContainerPath(relative) {
  return /\.(?:7z|apk|appimage|ar|bz2|cab|cpio|deb|dll|dmg|dylib|ear|exe|gz|iso|jar|lha|lz|lz4|lzh|msi|rar|rpm|so|tar|tbz|tbz2|tgz|txz|war|whl|xz|zip|zst)$/i.test(
    relative,
  );
}

function scanNonContainerBytes(relative, bytes, violations) {
  const byteText = bytes.toString("latin1");
  scanTextForSecrets(relative, byteText, violations);
  scanTextForFormerBrand(relative, byteText, violations, { includeAbbreviation: false });
  let brandText = null;
  try {
    brandText = decodeBrandText(bytes);
  } catch {
    brandText = null;
  }
  if (brandText !== null) scanTextForFormerBrand(relative, brandText, violations);
  let utf8;
  try {
    utf8 = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    const extension = path.posix.extname(relative).toLowerCase();
    const recognizer = SAFE_BINARY_FORMATS.get(extension);
    if (!recognizer || !recognizer(bytes)) {
      violations.push({ path: relative, code: "unsupported-binary-content" });
    }
    return;
  }
  scanTextForSecrets(relative, utf8, violations);
}

function scanUsefulFixture(relative, bytes, violations, usefulFixtures) {
  const fixture = usefulFixtures.get(relative);
  if (!fixture) {
    violations.push({ path: relative, code: "generated-archive-not-allowlisted" });
    return;
  }
  let entries;
  try {
    entries = new AdmZip(bytes).getEntries();
  } catch {
    if (!fixture.allowInvalid) violations.push({ path: relative, code: "fixture-archive-invalid" });
    return;
  }
  if (entries.length > MAX_USEFUL_ENTRIES) {
    violations.push({ path: relative, code: "fixture-entry-limit", details: entries.length });
    return;
  }
  let declaredExpandedBytes = 0;
  let actualExpandedBytes = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    scanTextForSecrets(`${relative}!/${entry.entryName}`, entry.entryName, violations);
    scanTextForFormerBrand(`${relative}!/${entry.entryName}`, entry.entryName, violations);
    const unixMode = (Number(entry.attr) >>> 16) & 0xf000;
    if (unixMode === 0xa000) {
      violations.push({ path: `${relative}!/${entry.entryName}`, code: "fixture-link-entry" });
      continue;
    }
    const size = Number(entry.header?.size ?? 0);
    declaredExpandedBytes += size;
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_USEFUL_ENTRY_BYTES || declaredExpandedBytes > MAX_USEFUL_EXPANDED_BYTES) {
      violations.push({
        path: `${relative}!/${entry.entryName}`,
        code: "fixture-expanded-size-limit",
        details: { entryBytes: size, expandedBytes: declaredExpandedBytes },
      });
      return;
    }
    let data;
    try {
      data = entry.getData();
    } catch {
      violations.push({ path: `${relative}!/${entry.entryName}`, code: "fixture-entry-read-failed" });
      continue;
    }
    actualExpandedBytes += data.length;
    if (data.length > MAX_USEFUL_ENTRY_BYTES || actualExpandedBytes > MAX_USEFUL_EXPANDED_BYTES) {
      violations.push({
        path: `${relative}!/${entry.entryName}`,
        code: "fixture-expanded-size-limit",
        details: { entryBytes: data.length, expandedBytes: actualExpandedBytes },
      });
      return;
    }
    if (data.length !== size) {
      violations.push({
        path: `${relative}!/${entry.entryName}`,
        code: "fixture-size-mismatch",
        details: { declaredBytes: size, actualBytes: data.length },
      });
      continue;
    }
    const nested = `${relative}!/${entry.entryName}`;
    if (isArchiveContainerPath(entry.entryName) || path.posix.extname(entry.entryName).toLowerCase() === ".useful") {
      violations.push({ path: nested, code: "fixture-nested-container" });
      continue;
    }
    scanNonContainerBytes(nested, data, violations);
  }
}

function scanBytes(relative, bytes, violations, usefulFixtures = PUBLIC_USEFUL_FIXTURES) {
  const extension = path.posix.extname(relative).toLowerCase();
  if (extension === ".useful") {
    const byteText = bytes.toString("latin1");
    scanTextForSecrets(relative, byteText, violations);
    scanTextForFormerBrand(relative, byteText, violations, { includeAbbreviation: false });
    scanUsefulFixture(relative, bytes, violations, usefulFixtures);
  } else scanNonContainerBytes(relative, bytes, violations);
}

export function getLocalAbsolutePathViolation(value, { platform = process.platform } = {}) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || !path.isAbsolute(value)) {
    return "local-absolute-path-required";
  }
  if (value.length > (platform === "win32" ? 240 : 4096)) return "local-path-length-limit";
  if (value !== value.normalize("NFC")) return "non-normalized-local-path";
  if (platform !== "win32") return null;
  const slashNormalized = value.replaceAll("/", "\\");
  if (
    slashNormalized.startsWith("\\\\") ||
    slashNormalized.startsWith("\\?\\") ||
    slashNormalized.startsWith("\\.\\") ||
    slashNormalized.startsWith("\\??\\")
  ) {
    return "unsupported-windows-namespace";
  }
  if (!/^[A-Za-z]:\\/.test(slashNormalized)) return "local-drive-path-required";
  const tail = slashNormalized.slice(3);
  for (const segment of tail.split("\\").filter(Boolean)) {
    if (
      /[ .]$/.test(segment) ||
      WINDOWS_INVALID_CHARS.test(segment) ||
      WINDOWS_RESERVED_BASENAME.test(segment) ||
      WINDOWS_SHORT_NAME_ALIAS.test(segment)
    ) {
      return "unsupported-windows-path";
    }
  }
  return null;
}

function identityFromInfo(info) {
  return {
    dev: info.dev.toString(),
    ino: info.ino.toString(),
    nlink: info.nlink.toString(),
    kind: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
  };
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.kind === right.kind;
}

export async function capturePathIdentityPins(absolutePath) {
  const syntaxViolation = getLocalAbsolutePathViolation(absolutePath);
  if (syntaxViolation) {
    const error = new Error("unsupported local path");
    error.code = "UNSUPPORTED_LOCAL_PATH";
    error.reason = syntaxViolation;
    throw error;
  }
  const resolved = path.resolve(absolutePath);
  let anchor = resolved;
  while (true) {
    try {
      await lstat(anchor, { bigint: true });
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(anchor);
      if (parent === anchor) throw error;
      anchor = parent;
    }
  }
  const linkInfo = await lstat(anchor, { bigint: true });
  if (linkInfo.isSymbolicLink()) {
    const error = new Error("path contains a symbolic link or junction");
    error.code = "PATH_ALIAS_UNSUPPORTED";
    error.boundary = anchor;
    throw error;
  }
  const canonical = await realpathNative(anchor);
  if (path.normalize(canonical) !== path.normalize(anchor)) {
    const error = new Error("path contains a canonical or reparse alias");
    error.code = "PATH_ALIAS_UNSUPPORTED";
    error.boundary = anchor;
    throw error;
  }
  const targetInfo = await stat(anchor, { bigint: true });
  const linkIdentity = identityFromInfo(linkInfo);
  const targetIdentity = identityFromInfo(targetInfo);
  if (!sameIdentity(linkIdentity, targetIdentity)) {
    const error = new Error("path contains an observable reparse alias");
    error.code = "PATH_ALIAS_UNSUPPORTED";
    error.boundary = anchor;
    throw error;
  }
  if (linkIdentity.kind === "file" && linkInfo.nlink > 1n) {
    const error = new Error("hard-linked files are unsupported");
    error.code = "HARDLINK_UNSUPPORTED";
    error.boundary = anchor;
    throw error;
  }
  if (anchor !== resolved && linkIdentity.kind !== "directory") {
    const error = new Error("path ancestor is not a directory");
    error.code = "PATH_ANCESTOR_NOT_DIRECTORY";
    error.boundary = anchor;
    throw error;
  }
  return { resolved, pins: [{ absolute: anchor, canonical, ...linkIdentity }] };
}

export async function verifyPathIdentityPins(pins) {
  for (const pin of pins) {
    const linkInfo = await lstat(pin.absolute, { bigint: true });
    if (linkInfo.isSymbolicLink()) return false;
    const canonical = await realpathNative(pin.absolute);
    if (canonical !== pin.canonical) return false;
    const targetInfo = await stat(pin.absolute, { bigint: true });
    const linkIdentity = identityFromInfo(linkInfo);
    const targetIdentity = identityFromInfo(targetInfo);
    if (!sameIdentity(linkIdentity, targetIdentity) || !sameIdentity(linkIdentity, pin)) return false;
    if (linkIdentity.kind === "file" && linkInfo.nlink > 1n) return false;
  }
  return true;
}

export async function findPathLinkBoundary(absolutePath) {
  try {
    await capturePathIdentityPins(absolutePath);
    return null;
  } catch (error) {
    if (["PATH_ALIAS_UNSUPPORTED", "HARDLINK_UNSUPPORTED"].includes(error?.code)) return error.boundary ?? absolutePath;
    throw error;
  }
}

async function findRepositoryEntryLinkBoundary(repoRoot, relative) {
  const parts = relative.split("/");
  let current = repoRoot;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") return { boundary: null, missing: true };
      throw error;
    }
    const boundary = parts.slice(0, index + 1).join("/");
    if (info.isSymbolicLink()) return { boundary, missing: false };
    const canonical = await realpathNative(current);
    if (path.normalize(canonical) !== path.normalize(current)) return { boundary, missing: false };
    const targetInfo = await stat(current, { bigint: true });
    const linkIdentity = identityFromInfo(await lstat(current, { bigint: true }));
    const targetIdentity = identityFromInfo(targetInfo);
    if (!sameIdentity(linkIdentity, targetIdentity)) return { boundary, missing: false };
    if (info.isFile() && info.nlink > 1) return { boundary, missing: false };
    if (index < parts.length - 1 && !info.isDirectory()) {
      return { boundary, missing: false };
    }
  }
  return { boundary: null, missing: false };
}

export function findPortableCollisions(entries, violations = []) {
  const seen = new Map();
  for (const entry of entries) {
    const key = portableWindowsPathKey(entry.path);
    const previous = seen.get(key);
    if (previous && previous !== entry.path) {
      violations.push({ path: entry.path, code: "non-portable-path-collision", details: previous });
    } else {
      seen.set(key, entry.path);
    }
  }
  return violations;
}

export function evaluatePublicBudgets(entries) {
  const violations = [];
  if (entries.length > MAX_PUBLIC_FILES) {
    violations.push({ code: "public-file-count-limit", details: { actual: entries.length, maximum: MAX_PUBLIC_FILES } });
  }
  let totalBytes = 0;
  for (const entry of entries) totalBytes += entry.bytes;
  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_PUBLIC_TOTAL_BYTES) {
    violations.push({ code: "public-total-bytes-limit", details: { actual: totalBytes, maximum: MAX_PUBLIC_TOTAL_BYTES } });
  }
  return { totalBytes, violations };
}

export function computeManifestSha256(entries) {
  return sha256(entries.map((entry) => `${entry.sha256}  ${entry.path}\n`).join(""));
}

export function computeReceiptManifestSha256(entries) {
  return sha256(entries.map((entry) => `${entry.mode} ${entry.sha256} ${entry.bytes} ${entry.path}\n`).join(""));
}

async function collectStaticExamplePolicyFiles(repoRoot, entries, purpose) {
  const files = new Map();
  for (const entry of entries) {
    if (!entry.path.startsWith(STATIC_EXAMPLE_PREFIX)) continue;
    if (getPortablePathViolation(entry.path) || !isPublicPath(entry.path) || isProhibitedPath(entry.path)) continue;
    if (purpose === "build") {
      if (entry.tracked && new Set(["100644", "100755"]).has(entry.mode)) {
        files.set(entry.path, readGitBlob(repoRoot, entry.object));
      }
      continue;
    }
    const link = await findRepositoryEntryLinkBoundary(repoRoot, entry.path);
    if (link.boundary || link.missing) continue;
    const absolute = path.join(repoRoot, ...entry.path.split("/"));
    const info = await lstat(absolute);
    if (info.isFile() && info.nlink === 1) files.set(entry.path, await readFile(absolute));
  }
  return files;
}

export async function inspectGitRepository({
  repoRoot,
  allowDirty = false,
  purpose = "check",
  expectedCommit = undefined,
  expectedTree = undefined,
  testHooks = undefined,
}) {
  const metadata = readGitMetadata(repoRoot);
  if (
    (expectedCommit !== undefined && metadata.commit !== expectedCommit) ||
    (expectedTree !== undefined && metadata.tree !== expectedTree)
  ) {
    const error = new Error("Git source does not match the fixed expected object");
    error.code = "SOURCE_CHANGED";
    throw error;
  }
  if (purpose === "build" && (!expectedCommit || !expectedTree)) {
    const error = new Error("build inspection requires fixed commit and tree object ids");
    error.code = "FIXED_GIT_OBJECT_REQUIRED";
    throw error;
  }
  const fixedCommit = expectedCommit ?? metadata.commit;
  const fixedTree = expectedTree ?? metadata.tree;
  if (testHooks?.afterMetadata) await testHooks.afterMetadata({ ...metadata, fixedCommit, fixedTree });
  // The committed tree is the only authoritative source for public paths, modes, and blob bytes.
  // The index and checkout are mutable validation surfaces and are checked separately via dirty
  // state, untracked enumeration, link boundaries, and checkout-byte scanning.
  const trackedEntries = parseTreeEntries(repoRoot, fixedTree);
  if (testHooks?.afterTreeEnumeration) await testHooks.afterTreeEnumeration({ fixedCommit, fixedTree, trackedEntries });
  const entries = purpose === "build" ? trackedEntries : [...trackedEntries, ...parseUntrackedEntries(repoRoot)];
  const included = [];
  const excluded = [];
  const violations = [];
  const staticExample = deriveStaticExampleFixturePolicy(
    await collectStaticExamplePolicyFiles(repoRoot, entries, purpose),
  );
  violations.push(...staticExample.violations);
  const usefulFixtures = new Map([...PUBLIC_USEFUL_FIXTURES, ...staticExample.fixtures]);

  for (const entry of entries) {
    const portablePathViolation = getPortablePathViolation(entry.path);
    if (portablePathViolation) {
      violations.push({ path: entry.path, code: portablePathViolation });
      continue;
    }
    const formerBrandViolationCount = violations.length;
    scanTextForFormerBrand(entry.path, entry.path, violations, { code: "legacy-brand-path" });
    if (purpose === "build" && violations.length > formerBrandViolationCount) continue;
    if (!isPublicPath(entry.path)) {
      excluded.push(entry.path);
      if (purpose === "check") {
        violations.push({
          path: entry.path,
          code: isExplicitlyExcluded(entry.path) ? "non-public-path-present" : "path-not-public-allowlisted",
        });
      }
      continue;
    }
    if (entry.tracked && !new Set(["100644", "100755"]).has(entry.mode)) {
      violations.push({ path: entry.path, code: "non-regular-file", details: entry.mode });
      continue;
    }
    if (isProhibitedPath(entry.path)) {
      if (purpose === "build") excluded.push(entry.path);
      else violations.push({ path: entry.path, code: "prohibited-path" });
      continue;
    }
    const link = await findRepositoryEntryLinkBoundary(repoRoot, entry.path);
    if (link.boundary) {
      violations.push({ path: entry.path, code: "non-regular-file", details: `link boundary: ${link.boundary}` });
      continue;
    }
    if (link.missing) {
      if (purpose === "build") violations.push({ path: entry.path, code: "tracked-path-missing" });
      else if (entry.tracked) excluded.push(entry.path);
      continue;
    }
    const absolute = path.join(repoRoot, ...entry.path.split("/"));
    const info = await lstat(absolute);
    if (!info.isFile() || info.nlink > 1) {
      violations.push({ path: entry.path, code: "non-regular-file", details: entry.tracked ? entry.mode : "untracked" });
      continue;
    }
    // Git objects define the publishable bytes across platforms. The checkout is
    // still scanned separately so a clean/smudge filter cannot hide local content.
    const checkoutBytes = purpose === "check" ? await readFile(absolute) : undefined;
    const bytes = entry.tracked ? readGitBlob(repoRoot, entry.object) : checkoutBytes;
    const observedBytes = Math.max(bytes.length, checkoutBytes?.length ?? 0);
    if (observedBytes > MAX_PUBLIC_FILE_BYTES) {
      violations.push({
        path: entry.path,
        code: "file-too-large",
        details: observedBytes,
      });
      continue;
    }
    const before = violations.length;
    scanBytes(entry.path, bytes, violations, usefulFixtures);
    if (checkoutBytes && !checkoutBytes.equals(bytes)) {
      scanBytes(entry.path, checkoutBytes, violations, usefulFixtures);
    }
    if (purpose === "build" && violations.length > before) continue;
    included.push({
      path: entry.path,
      bytes: bytes.length,
      sha256: sha256(bytes),
      mode: entry.mode ?? "100644",
      object: entry.object,
    });
  }

  included.sort((left, right) => comparePublicPaths(left.path, right.path));
  excluded.sort(comparePublicPaths);
  findPortableCollisions(included, violations);
  const budget = evaluatePublicBudgets(included);
  violations.push(...budget.violations);
  const candidatePaths = new Set(included.map((entry) => entry.path));
  for (const required of REQUIRED_PUBLIC_FILES) {
    if (!candidatePaths.has(required)) violations.push({ path: required, code: "required-public-file-missing" });
  }
  const finalMetadata = readGitMetadata(repoRoot);
  if (
    finalMetadata.topLevel !== metadata.topLevel
    || finalMetadata.commit !== metadata.commit
    || finalMetadata.tree !== metadata.tree
    || finalMetadata.dirty !== metadata.dirty
  ) {
    const error = new Error("Git source changed while public-source policy was inspecting it");
    error.code = "SOURCE_CHANGED";
    throw error;
  }
  if (metadata.dirty && !allowDirty) violations.unshift({ code: "dirty-worktree" });
  const ok = violations.length === 0;
  return {
    policySchemaVersion: PUBLIC_SOURCE_POLICY_SCHEMA,
    ok,
    authoritative: ok && !metadata.dirty && !allowDirty,
    ...metadata,
    commit: fixedCommit,
    tree: fixedTree,
    included,
    excluded,
    violations,
    manifestSha256: computeManifestSha256(included),
    summary: { fileCount: included.length, totalBytes: budget.totalBytes },
  };
}

async function walkDirectory(root, relative = "", entries = [], violations = []) {
  const absolute = relative ? path.join(root, ...relative.split("/")) : root;
  const names = await readdir(absolute);
  names.sort(comparePublicPaths);
  for (const name of names) {
    const childRelative = relative ? `${relative}/${name}` : name;
    const childAbsolute = path.join(absolute, name);
    const info = await lstat(childAbsolute);
    if (info.isSymbolicLink()) {
      violations.push({ path: childRelative, code: "non-regular-file", details: "link boundary" });
      continue;
    }
    const canonical = await realpathNative(childAbsolute);
    const linkIdentity = identityFromInfo(await lstat(childAbsolute, { bigint: true }));
    const targetIdentity = identityFromInfo(await stat(childAbsolute, { bigint: true }));
    if (path.normalize(canonical) !== path.normalize(childAbsolute) || !sameIdentity(linkIdentity, targetIdentity)) {
      violations.push({ path: childRelative, code: "non-regular-file", details: "observable path alias" });
    } else if (info.isDirectory()) {
      await walkDirectory(root, childRelative, entries, violations);
    } else if (info.isFile() && info.nlink === 1) {
      entries.push({ path: childRelative, info });
    } else {
      violations.push({ path: childRelative, code: "non-regular-file" });
    }
  }
  return { entries, violations };
}

export async function validatePublicSnapshotDirectory({ root, expectedEntries }) {
  const walked = await walkDirectory(root);
  const expected = new Map(expectedEntries.map((entry) => [entry.path, entry]));
  const included = [];
  const violations = [...walked.violations];
  const staticFiles = new Map();
  for (const entry of walked.entries) {
    if (entry.path.startsWith(STATIC_EXAMPLE_PREFIX)) {
      staticFiles.set(entry.path, await readFile(path.join(root, ...entry.path.split("/"))));
    }
  }
  const staticExample = deriveStaticExampleFixturePolicy(staticFiles);
  violations.push(...staticExample.violations);
  const usefulFixtures = new Map([...PUBLIC_USEFUL_FIXTURES, ...staticExample.fixtures]);
  for (const entry of walked.entries) {
    scanTextForFormerBrand(entry.path, entry.path, violations, { code: "legacy-brand-path" });
    if (getPortablePathViolation(entry.path) || !isPublicPath(entry.path) || isProhibitedPath(entry.path)) {
      violations.push({ path: entry.path, code: "snapshot-path-not-public" });
      continue;
    }
    const expectedEntry = expected.get(entry.path);
    if (!expectedEntry) {
      violations.push({ path: entry.path, code: "snapshot-file-unexpected" });
      continue;
    }
    const bytes = await readFile(path.join(root, ...entry.path.split("/")));
    const digest = sha256(bytes);
    scanBytes(entry.path, bytes, violations, usefulFixtures);
    if (bytes.length !== expectedEntry.bytes || digest !== expectedEntry.sha256) {
      violations.push({ path: entry.path, code: "snapshot-file-mismatch" });
      continue;
    }
    included.push({ path: entry.path, bytes: bytes.length, sha256: digest, mode: expectedEntry.mode });
    expected.delete(entry.path);
  }
  for (const missing of expected.keys()) violations.push({ path: missing, code: "snapshot-file-missing" });
  included.sort((left, right) => comparePublicPaths(left.path, right.path));
  findPortableCollisions(included, violations);
  const budget = evaluatePublicBudgets(included);
  violations.push(...budget.violations);
  return { ok: violations.length === 0, included, violations, summary: { fileCount: included.length, totalBytes: budget.totalBytes } };
}
