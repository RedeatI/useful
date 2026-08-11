#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_PROFILE_SOURCE,
  collectDistInventory,
  FRONTEND_DIST_RELATIVE,
  FRONTEND_ENTRY_SOURCE,
  MAX_SIZE_BYTES,
  OFFICE_WORKER_ASSET_PATTERN,
  requireOrdinaryPathChain,
  SIZE_REPORT_SCHEMA,
  SizeReportError,
} from "./frontend-size-report.mjs";

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUDGET_SCHEMA = "useful.size-budgets.v2";
const CHECK_SCHEMA = "useful.size-budget-check.v2";
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
const METRIC_FIELDS = [
  "usefulExeBytes",
  "bootstrapExeBytes",
  "frontendAppBytes",
  "officeWorkerBytes",
  "frontendDistBytes",
  "initialJsBytes",
  "agentProfileChunkBytes",
  "portableLiteZipBytes",
  "setupLiteBytes",
  "portableFullZipBytes",
];
const FRONTEND_REQUIRED = [
  "frontendAppBytes",
  "officeWorkerBytes",
  "frontendDistBytes",
  "initialJsBytes",
  "agentProfileChunkBytes",
];
const CI_REQUIRED = [
  "usefulExeBytes",
  "bootstrapExeBytes",
  ...FRONTEND_REQUIRED,
  "portableLiteZipBytes",
];
const RELEASE_REQUIRED = [
  ...CI_REQUIRED,
  "setupLiteBytes",
  "portableFullZipBytes",
];
const PROFILE_REQUIREMENTS = {
  frontend: FRONTEND_REQUIRED,
  ci: CI_REQUIRED,
  release: RELEASE_REQUIRED,
};
const RELEASE_ARTIFACT_FIELDS = [
  "usefulExe",
  "bootstrapExe",
  "portableLiteZip",
  "setupLite",
  "portableFullZip",
];
const RELEASE_ARTIFACT_METRICS = {
  usefulExe: "usefulExeBytes",
  bootstrapExe: "bootstrapExeBytes",
  portableLiteZip: "portableLiteZipBytes",
  setupLite: "setupLiteBytes",
  portableFullZip: "portableFullZipBytes",
};
const REPORT_FIELDS = [
  "schemaVersion",
  "commit",
  "frontendDistPath",
  "frontendEntrySource",
  "frontendEntryFile",
  "frontendInitialJsFiles",
  "agentProfileSource",
  "agentProfileChunkFile",
  "officeWorkerAsset",
  "frontendFiles",
  "releaseArtifacts",
  ...METRIC_FIELDS,
];

export class SizeBudgetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SizeBudgetError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new SizeBudgetError(code, message);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  if (!isPlainObject(value)) fail("SCHEMA_OBJECT_REQUIRED", `${label} must be an object`);
  const actual = Object.keys(value).sort(compareOrdinal);
  const wanted = [...expected].sort(compareOrdinal);
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    const wantedSet = new Set(wanted);
    const actualSet = new Set(actual);
    const unknown = actual.filter((key) => !wantedSet.has(key));
    const missing = wanted.filter((key) => !actualSet.has(key));
    fail("SCHEMA_FIELDS_INVALID", `${label} fields are not closed; unknown=[${unknown.join(",")}] missing=[${missing.join(",")}]`);
  }
}

function normalizeRelativePath(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.includes("\0")) {
    fail("REPORT_PATH_INVALID", `${label} must be a non-empty POSIX relative path`);
  }
  const normalized = path.posix.normalize(value);
  if (
    value.startsWith("/")
    || value.endsWith("/")
    || value.includes("//")
    || normalized !== value
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
  ) {
    fail("REPORT_PATH_INVALID", `${label} is not normalized: ${value}`);
  }
  return value;
}

function resolveInside(root, candidate, label) {
  const rootPath = path.resolve(root);
  const fullPath = path.resolve(candidate);
  const relative = path.relative(rootPath, fullPath);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    return fullPath;
  }
  fail("PATH_OUTSIDE_ROOT", `${label} must stay inside repository root: ${fullPath}`);
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

async function readJsonFile(repoRoot, file, label) {
  const errorPrefix = label === "size report" ? "REPORT" : label === "size budgets" ? "BUDGET" : "PACKAGE";
  const fullPath = resolveInside(repoRoot, file, label);
  try {
    await requireOrdinaryPathChain(repoRoot, fullPath, "file");
  } catch (error) {
    if (error instanceof SizeReportError) {
      fail(`${errorPrefix}_MISSING_OR_INVALID`, error.message);
    }
    throw error;
  }
  const info = await lstat(fullPath);
  if (info.size <= 0 || info.size > MAX_SIZE_BYTES) {
    fail(`${errorPrefix}_FILE_SIZE_INVALID`, `${label} must be 1..${MAX_SIZE_BYTES} bytes`);
  }
  const raw = await readFile(fullPath, "utf8");
  try {
    return { value: JSON.parse(raw), path: fullPath };
  } catch (error) {
    fail(`${errorPrefix}_JSON_INVALID`, `${label} is invalid JSON: ${error.message}`);
  }
}

function validatePositiveMetric(value, label, { nullable = true } = {}) {
  if (value === null && nullable) return;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_SIZE_BYTES) {
    fail("METRIC_VALUE_INVALID", `${label} must be a positive integer no greater than ${MAX_SIZE_BYTES}`);
  }
}

function validateBudgets(budgets) {
  exactKeys(
    budgets,
    ["schemaVersion", "notes", "maximumMetricBytes", "hardLimits", "targets", "requiredProfiles"],
    "size budgets",
  );
  if (budgets.schemaVersion !== BUDGET_SCHEMA) fail("BUDGET_SCHEMA_INVALID", `Expected ${BUDGET_SCHEMA}`);
  if (
    !Array.isArray(budgets.notes)
    || budgets.notes.length === 0
    || budgets.notes.some((note) => typeof note !== "string" || note.trim().length === 0)
  ) {
    fail("BUDGET_NOTES_INVALID", "size budgets notes must be non-empty strings");
  }
  if (budgets.maximumMetricBytes !== MAX_SIZE_BYTES) {
    fail("BUDGET_MAXIMUM_INVALID", `maximumMetricBytes must be ${MAX_SIZE_BYTES}`);
  }
  exactKeys(budgets.hardLimits, METRIC_FIELDS, "hard limits");
  for (const key of METRIC_FIELDS) validatePositiveMetric(budgets.hardLimits[key], `hardLimits.${key}`, { nullable: false });
  if (
    budgets.hardLimits.frontendDistBytes
    !== budgets.hardLimits.frontendAppBytes + budgets.hardLimits.officeWorkerBytes
  ) {
    fail("FRONTEND_LIMIT_COMPOSITION_INVALID", "frontendDistBytes hard limit must equal frontendAppBytes plus officeWorkerBytes");
  }
  if (!isPlainObject(budgets.targets)) fail("BUDGET_TARGETS_INVALID", "targets must be an object");
  for (const [key, value] of Object.entries(budgets.targets)) {
    if (!METRIC_FIELDS.includes(key)) fail("BUDGET_TARGET_UNKNOWN", `Unknown target metric: ${key}`);
    validatePositiveMetric(value, `targets.${key}`, { nullable: false });
  }
  exactKeys(budgets.requiredProfiles, Object.keys(PROFILE_REQUIREMENTS), "required profiles");
  for (const [profile, expected] of Object.entries(PROFILE_REQUIREMENTS)) {
    const actual = budgets.requiredProfiles[profile];
    if (!Array.isArray(actual) || JSON.stringify(actual) !== JSON.stringify(expected)) {
      fail("BUDGET_PROFILE_INVALID", `requiredProfiles.${profile} must be the exact production field list`);
    }
  }
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

function validateSortedUniquePaths(value, label) {
  if (!Array.isArray(value) || value.length === 0) fail("REPORT_ARRAY_INVALID", `${label} must be a non-empty array`);
  const normalized = value.map((item, index) => normalizeRelativePath(item, `${label}[${index}]`));
  const sorted = [...normalized].sort(compareOrdinal);
  if (new Set(normalized).size !== normalized.length || JSON.stringify(normalized) !== JSON.stringify(sorted)) {
    fail("REPORT_ARRAY_NOT_CLOSED", `${label} must be sorted and duplicate-free`);
  }
  return normalized;
}

function validateReportSchema(report) {
  exactKeys(report, REPORT_FIELDS, "size report");
  if (report.schemaVersion !== SIZE_REPORT_SCHEMA) fail("REPORT_SCHEMA_INVALID", `Expected ${SIZE_REPORT_SCHEMA}`);
  if (!COMMIT_PATTERN.test(report.commit)) fail("REPORT_COMMIT_INVALID", "report.commit must be lowercase 40-hex");
  if (report.frontendDistPath !== FRONTEND_DIST_RELATIVE) {
    fail("REPORT_DIST_PATH_INVALID", `frontendDistPath must be ${FRONTEND_DIST_RELATIVE}`);
  }
  if (report.frontendEntrySource !== FRONTEND_ENTRY_SOURCE) {
    fail("REPORT_ENTRY_SOURCE_INVALID", `frontendEntrySource must be ${FRONTEND_ENTRY_SOURCE}`);
  }
  if (report.agentProfileSource !== AGENT_PROFILE_SOURCE) {
    fail("REPORT_AGENT_SOURCE_INVALID", `agentProfileSource must be ${AGENT_PROFILE_SOURCE}`);
  }
  const entryFile = normalizeRelativePath(report.frontendEntryFile, "frontendEntryFile");
  const agentFile = normalizeRelativePath(report.agentProfileChunkFile, "agentProfileChunkFile");
  const officeWorker = normalizeRelativePath(report.officeWorkerAsset, "officeWorkerAsset");
  if (!entryFile.endsWith(".js") || !agentFile.endsWith(".js") || !OFFICE_WORKER_ASSET_PATTERN.test(officeWorker)) {
    fail("REPORT_CONTROLLED_ASSET_INVALID", "entry, AgentProfile, or officeWorker asset binding is invalid");
  }
  const initialJsFiles = validateSortedUniquePaths(report.frontendInitialJsFiles, "frontendInitialJsFiles");
  if (!initialJsFiles.includes(entryFile) || initialJsFiles.includes(agentFile)) {
    fail("REPORT_INITIAL_CLOSURE_INVALID", "initial JS closure must contain the entry and exclude AgentProfile");
  }

  if (!Array.isArray(report.frontendFiles) || report.frontendFiles.length === 0) {
    fail("REPORT_FILE_SET_INVALID", "frontendFiles must be a non-empty closed file list");
  }
  const frontendFiles = report.frontendFiles.map((file, index) => {
    exactKeys(file, ["path", "bytes", "sha256"], `frontendFiles[${index}]`);
    const filePath = normalizeRelativePath(file.path, `frontendFiles[${index}].path`);
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_SIZE_BYTES) {
      fail("REPORT_FILE_SIZE_INVALID", `frontendFiles[${index}].bytes is invalid`);
    }
    if (!SHA256_PATTERN.test(file.sha256)) fail("REPORT_FILE_HASH_INVALID", `frontendFiles[${index}].sha256 is invalid`);
    return { path: filePath, bytes: file.bytes, sha256: file.sha256 };
  });
  const filePaths = frontendFiles.map((file) => file.path);
  const sortedPaths = [...filePaths].sort(compareOrdinal);
  if (new Set(filePaths).size !== filePaths.length || JSON.stringify(filePaths) !== JSON.stringify(sortedPaths)) {
    fail("REPORT_FILE_SET_NOT_CLOSED", "frontendFiles must be path-sorted and duplicate-free");
  }
  for (const required of [FRONTEND_ENTRY_SOURCE, entryFile, agentFile, officeWorker, ...initialJsFiles]) {
    if (!filePaths.includes(required)) fail("REPORT_FILE_BINDING_MISSING", `frontendFiles is missing ${required}`);
  }
  const officeWorkers = filePaths.filter((file) => OFFICE_WORKER_ASSET_PATTERN.test(file));
  if (officeWorkers.length !== 1 || officeWorkers[0] !== officeWorker) {
    fail("REPORT_OFFICE_WORKER_SET_INVALID", "frontendFiles must contain exactly the controlled officeWorker asset");
  }

  exactKeys(report.releaseArtifacts, RELEASE_ARTIFACT_FIELDS, "releaseArtifacts");
  const releaseArtifacts = {};
  for (const artifact of RELEASE_ARTIFACT_FIELDS) {
    const value = report.releaseArtifacts[artifact];
    const metric = RELEASE_ARTIFACT_METRICS[artifact];
    if (value === null) {
      if (report[metric] !== null) {
        fail("REPORT_ARTIFACT_METRIC_BINDING_INVALID", `report.${metric} must be null when releaseArtifacts.${artifact} is null`);
      }
      releaseArtifacts[artifact] = null;
      continue;
    }
    exactKeys(value, ["path", "bytes", "sha256"], `releaseArtifacts.${artifact}`);
    const artifactPath = normalizeRelativePath(value.path, `releaseArtifacts.${artifact}.path`);
    validatePositiveMetric(value.bytes, `releaseArtifacts.${artifact}.bytes`, { nullable: false });
    if (!SHA256_PATTERN.test(value.sha256)) {
      fail("REPORT_ARTIFACT_HASH_INVALID", `releaseArtifacts.${artifact}.sha256 must be lowercase SHA-256`);
    }
    if (report[metric] !== value.bytes) {
      fail("REPORT_ARTIFACT_METRIC_BINDING_INVALID", `report.${metric} must equal releaseArtifacts.${artifact}.bytes`);
    }
    releaseArtifacts[artifact] = { path: artifactPath, bytes: value.bytes, sha256: value.sha256 };
  }

  for (const field of METRIC_FIELDS) validatePositiveMetric(report[field], `report.${field}`);
  const byPath = new Map(frontendFiles.map((file) => [file.path, file]));
  const totalBytes = frontendFiles.reduce((total, file) => total + file.bytes, 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_SIZE_BYTES) {
    fail("REPORT_DIST_TOTAL_INVALID", `frontend file total exceeds ${MAX_SIZE_BYTES}`);
  }
  const officeBytes = byPath.get(officeWorker).bytes;
  const initialBytes = initialJsFiles.reduce((total, file) => total + byPath.get(file).bytes, 0);
  const agentBytes = byPath.get(agentFile).bytes;
  if (
    report.frontendDistBytes !== totalBytes
    || report.officeWorkerBytes !== officeBytes
    || report.frontendAppBytes !== totalBytes - officeBytes
    || report.initialJsBytes !== initialBytes
    || report.agentProfileChunkBytes !== agentBytes
    || report.frontendDistBytes !== report.frontendAppBytes + report.officeWorkerBytes
  ) {
    fail("REPORT_METRIC_BINDING_INVALID", "frontend metrics do not exactly match the closed file evidence");
  }
  return { frontendFiles, initialJsFiles, releaseArtifacts };
}

async function validateCurrentDist(repoRoot, report, evidence) {
  const distDirectory = resolveInside(repoRoot, path.join(repoRoot, ...report.frontendDistPath.split("/")), "frontend dist");
  await requireOrdinaryPathChain(repoRoot, distDirectory, "directory");
  const actual = await collectDistInventory(distDirectory);
  if (JSON.stringify(actual.files) !== JSON.stringify(evidence.frontendFiles)) {
    fail("DIST_EVIDENCE_DRIFT", "Current dist file closure, sizes, or hashes differ from the size report");
  }
  const expectedDirectorySet = expectedDirectories(evidence.frontendFiles.map((file) => file.path));
  if (JSON.stringify(actual.directories) !== JSON.stringify(expectedDirectorySet)) {
    fail("DIST_DIRECTORY_DRIFT", "Current dist contains an unexpected or missing directory");
  }
  if (actual.totalBytes !== report.frontendDistBytes) fail("DIST_TOTAL_DRIFT", "Current dist total differs from the report");
}

function validatePackageVersion(packageMetadata) {
  if (!isPlainObject(packageMetadata) || typeof packageMetadata.version !== "string") {
    fail("PACKAGE_VERSION_INVALID", "package.json must declare a string version");
  }
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(packageMetadata.version)) {
    fail("PACKAGE_VERSION_INVALID", `package.json version is invalid: ${packageMetadata.version}`);
  }
  return packageMetadata.version;
}

function expectedReleaseArtifactPaths(profile, version) {
  const none = Object.fromEntries(RELEASE_ARTIFACT_FIELDS.map((field) => [field, null]));
  if (profile === "frontend") return none;
  if (profile === "ci") {
    return {
      usefulExe: "target/release/Useful.exe",
      bootstrapExe: "target/release/useful-bootstrap.exe",
      portableLiteZip: "dist-release/Useful-Portable-Lite-x64.zip",
      setupLite: null,
      portableFullZip: null,
    };
  }
  return {
    usefulExe: "target/x86_64-pc-windows-msvc/release/Useful.exe",
    bootstrapExe: "target/x86_64-pc-windows-msvc/release/useful-bootstrap.exe",
    portableLiteZip: `release-assets/Useful-${version}-windows-x64-portable-lite.zip`,
    setupLite: `release-assets/Useful-${version}-windows-x64-setup-lite.exe`,
    portableFullZip: `release-assets/Useful-${version}-windows-x64-portable-full.zip`,
  };
}

function validateProfileArtifactBindings(profile, version, artifacts) {
  const expected = expectedReleaseArtifactPaths(profile, version);
  for (const artifact of RELEASE_ARTIFACT_FIELDS) {
    const evidence = artifacts[artifact];
    const expectedPath = expected[artifact];
    if (expectedPath === null) {
      if (evidence !== null) {
        fail("ARTIFACT_PROFILE_BINDING_INVALID", `Profile ${profile} requires releaseArtifacts.${artifact} to be null`);
      }
      continue;
    }
    if (evidence === null) {
      fail("REQUIRED_ARTIFACT_MISSING", `Profile ${profile} requires releaseArtifacts.${artifact}`);
    }
    if (evidence.path !== expectedPath) {
      fail(
        "ARTIFACT_PROFILE_BINDING_INVALID",
        `Profile ${profile} requires releaseArtifacts.${artifact}.path=${expectedPath}; found ${evidence.path}`,
      );
    }
  }
}

async function validateArtifactFiles(repoRoot, artifacts) {
  for (const [artifact, evidence] of Object.entries(artifacts)) {
    if (evidence === null) continue;
    const fullPath = resolveInside(
      repoRoot,
      path.join(repoRoot, ...evidence.path.split("/")),
      `releaseArtifacts.${artifact}`,
    );
    try {
      await requireOrdinaryPathChain(repoRoot, fullPath, "file");
      const before = await lstat(fullPath);
      if (!before.isFile() || before.isSymbolicLink() || before.size <= 0 || before.size > MAX_SIZE_BYTES) {
        fail("ARTIFACT_MISSING_OR_INVALID", `releaseArtifacts.${artifact} is not a controlled non-empty ordinary file`);
      }
      const bytes = await readFile(fullPath);
      const after = await lstat(fullPath);
      await requireOrdinaryPathChain(repoRoot, fullPath, "file");
      if (
        before.size !== after.size
        || before.mtimeMs !== after.mtimeMs
        || (before.ino !== undefined && after.ino !== undefined && before.ino !== after.ino)
        || bytes.length !== after.size
      ) {
        fail("ARTIFACT_FILE_DRIFT", `releaseArtifacts.${artifact} changed while being checked`);
      }
      if (bytes.length !== evidence.bytes) {
        fail("ARTIFACT_SIZE_DRIFT", `releaseArtifacts.${artifact} size differs from the report`);
      }
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== evidence.sha256) {
        fail("ARTIFACT_HASH_DRIFT", `releaseArtifacts.${artifact} SHA-256 differs from the report`);
      }
    } catch (error) {
      if (error instanceof SizeBudgetError) throw error;
      if (error instanceof SizeReportError || error?.code === "ENOENT") {
        fail("ARTIFACT_MISSING_OR_INVALID", `releaseArtifacts.${artifact} is missing or not an ordinary file: ${evidence.path}`);
      }
      throw error;
    }
  }
}

export async function checkSizeBudget(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? defaultRepoRoot);
  const profile = options.profile;
  if (!Object.prototype.hasOwnProperty.call(PROFILE_REQUIREMENTS, profile)) {
    fail("PROFILE_INVALID", `--profile must be one of: ${Object.keys(PROFILE_REQUIREMENTS).join(", ")}`);
  }
  const actualCommit = options.actualCommit ?? gitHead(repoRoot);
  if (!COMMIT_PATTERN.test(actualCommit)) fail("GIT_HEAD_INVALID", `Actual commit must be lowercase 40-hex: ${actualCommit}`);
  const expectedCommit = options.expectedCommit ?? process.env.USEFUL_SIZE_EXPECTED_COMMIT ?? actualCommit;
  if (!COMMIT_PATTERN.test(expectedCommit)) fail("EXPECTED_COMMIT_INVALID", "Expected commit must be lowercase 40-hex");
  if (actualCommit !== expectedCommit) {
    fail("CHECKOUT_COMMIT_MISMATCH", `Checkout HEAD ${actualCommit} does not match expected commit ${expectedCommit}`);
  }

  const reportFile = options.reportPath ?? path.join(repoRoot, "artifacts", "size", "size-report.json");
  const budgetFile = options.budgetPath ?? path.join(repoRoot, "config", "size-budgets.json");
  const [
    { value: report, path: resolvedReport },
    { value: budgets, path: resolvedBudgets },
    { value: packageMetadata },
  ] = await Promise.all([
    readJsonFile(repoRoot, reportFile, "size report"),
    readJsonFile(repoRoot, budgetFile, "size budgets"),
    readJsonFile(repoRoot, path.join(repoRoot, "package.json"), "package metadata"),
  ]);
  validateBudgets(budgets);
  const evidence = validateReportSchema(report);
  const packageVersion = validatePackageVersion(packageMetadata);
  if (report.commit !== expectedCommit) {
    fail("REPORT_COMMIT_MISMATCH", `Report commit ${report.commit} does not match expected commit ${expectedCommit}`);
  }
  await validateCurrentDist(repoRoot, report, evidence);
  validateProfileArtifactBindings(profile, packageVersion, evidence.releaseArtifacts);
  await validateArtifactFiles(repoRoot, evidence.releaseArtifacts);

  const required = budgets.requiredProfiles[profile];
  for (const field of required) {
    if (report[field] === null) fail("REQUIRED_METRIC_MISSING", `Profile ${profile} requires non-null report.${field}`);
  }
  const checked = {};
  for (const field of METRIC_FIELDS) {
    const value = report[field];
    if (value === null) continue;
    const limit = budgets.hardLimits[field];
    if (value > limit) fail("HARD_LIMIT_EXCEEDED", `${field}=${value} exceeds hard limit ${limit}`);
    checked[field] = { bytes: value, hardLimitBytes: limit };
  }
  return {
    schemaVersion: CHECK_SCHEMA,
    ok: true,
    profile,
    commit: expectedCommit,
    reportPath: path.relative(repoRoot, resolvedReport).replaceAll(path.sep, "/"),
    budgetPath: path.relative(repoRoot, resolvedBudgets).replaceAll(path.sep, "/"),
    required,
    checked,
  };
}

function parseArguments(args) {
  const parsed = { json: false };
  const valueOptions = new Map([
    ["--repo-root", "repoRoot"],
    ["--report", "reportPath"],
    ["--budgets", "budgetPath"],
    ["--profile", "profile"],
    ["--expected-commit", "expectedCommit"],
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      if (parsed.json) fail("ARGUMENT_DUPLICATE", "--json was provided more than once");
      parsed.json = true;
      continue;
    }
    const key = valueOptions.get(argument);
    if (!key) fail("ARGUMENT_UNKNOWN", `Unknown argument: ${argument}`);
    if (Object.prototype.hasOwnProperty.call(parsed, key)) fail("ARGUMENT_DUPLICATE", `${argument} was provided more than once`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) fail("ARGUMENT_VALUE_MISSING", `${argument} requires a value`);
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

async function main() {
  const jsonRequested = process.argv.slice(2).includes("--json");
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = await checkSizeBudget(options);
    if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else process.stdout.write(`Useful size budget: PASS; profile=${result.profile}; commit=${result.commit}; metrics=${Object.keys(result.checked).length}\n`);
  } catch (error) {
    const code = error instanceof SizeBudgetError ? error.code : "SIZE_BUDGET_CHECK_FAILED";
    if (jsonRequested) {
      process.stdout.write(`${JSON.stringify({ schemaVersion: CHECK_SCHEMA, ok: false, error: { code, message: error.message } })}\n`);
    } else {
      process.stderr.write(`${code}: ${error.message}\n`);
    }
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
