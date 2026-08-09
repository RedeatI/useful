#!/usr/bin/env node

import { readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_PUBLIC_FILE_BYTES,
  MAX_PUBLIC_FILES,
  MAX_PUBLIC_RECEIPT_BYTES,
  MAX_PUBLIC_TOTAL_BYTES,
  PUBLIC_SOURCE_POLICY_SCHEMA,
  capturePathIdentityPins,
  comparePublicPaths,
  computeReceiptManifestSha256,
  getPortablePathViolation,
  inspectGitRepository,
  readGitCommitParents,
  readGitMetadata,
  sha256,
  verifyPathIdentityPins,
} from "./public-source-policy.mjs";

const RESULT_SCHEMA = "useful.verify-public-commit.result.v1";
const RECEIPT_SCHEMA = "useful.public-source-receipt.v2";
const TRANSACTION_SCHEMA = "useful.public-source-transaction.v1";
const MAX_TRANSACTION_MARKER_BYTES = 1024 * 1024;
const RECEIPT_AUTHORITY_CONDITION =
  "the transaction marker named by the successful CLI result is valid, has phase=complete, binds this receipt SHA-256, and its recorded file identities still match";
const GIT_INDEX_MODE = Object.freeze({
  filesystemModeAuthoritative: false,
  applyFrom: "files[].mode",
  application: "after git add, apply --chmod=+x for 100755 and --chmod=-x for 100644 to each exact path",
  verification: "compare every committed Git tree path, mode, blob byte length, and SHA-256 with files[]",
});
const IO_OR_SECURITY_CODES = new Set([
  "EACCES",
  "EBUSY",
  "EIO",
  "ELOOP",
  "EMFILE",
  "ENFILE",
  "ENOENT",
  "ENOSPC",
  "ENOTDIR",
  "EPERM",
  "EROFS",
  "GIT_IO_FAILED",
  "HARDLINK_UNSUPPORTED",
  "PATH_ALIAS_UNSUPPORTED",
  "UNSUPPORTED_LOCAL_PATH",
]);

export class VerificationError extends Error {
  constructor(code, message, exitCode = 3) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

function invalidArguments() {
  return new VerificationError(
    "INVALID_ARGUMENTS",
    "expected exactly --repo-root <path> --receipt <json> --transaction-marker <json> --json",
    2,
  );
}

export function parseArguments(argv) {
  const values = new Map();
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      if (json) throw invalidArguments();
      json = true;
      continue;
    }
    if (!["--repo-root", "--receipt", "--transaction-marker"].includes(argument)) throw invalidArguments();
    if (values.has(argument) || !argv[index + 1] || argv[index + 1].startsWith("--")) throw invalidArguments();
    values.set(argument, path.resolve(argv[index + 1]));
    index += 1;
  }
  if (
    !json
    || !values.has("--repo-root")
    || !values.has("--receipt")
    || !values.has("--transaction-marker")
    || values.size !== 3
  ) {
    throw invalidArguments();
  }
  return {
    repoRoot: values.get("--repo-root"),
    receipt: values.get("--receipt"),
    transactionMarker: values.get("--transaction-marker"),
  };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  return isObject(value) &&
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function comparablePath(value) {
  const normalized = path.resolve(value).normalize("NFC");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sameLocalPath(left, right) {
  return typeof left === "string" && path.isAbsolute(left) && comparablePath(left) === comparablePath(right);
}

function validObjectId(value) {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

async function readPinnedJson(absolute, maximumBytes, invalidCode) {
  const capture = await capturePathIdentityPins(absolute);
  const pin = capture.pins.at(-1);
  if (!pin || pin.absolute !== capture.resolved || pin.kind !== "file") {
    throw new VerificationError(invalidCode, "input must be a unique regular file");
  }
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maximumBytes) {
    throw new VerificationError(invalidCode, "input must be a bounded unique regular file");
  }
  const bytes = await readFile(absolute);
  if (bytes.length > maximumBytes) {
    throw new VerificationError(invalidCode, "input exceeds its byte limit");
  }
  if (!(await verifyPathIdentityPins(capture.pins))) {
    throw new VerificationError(invalidCode, "input identity changed while it was read");
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new VerificationError(invalidCode, "input is not valid JSON");
  }
  return { value, bytes, capture };
}

function assertReceipt(receipt) {
  const invalid = () => new VerificationError("RECEIPT_INVALID", "receipt does not match the strict v2 schema");
  if (
    !hasExactKeys(receipt, [
      "schemaVersion",
      "policySchemaVersion",
      "authoritative",
      "authority",
      "source",
      "summary",
      "gitIndexMode",
      "files",
    ]) ||
    receipt.schemaVersion !== RECEIPT_SCHEMA ||
    receipt.policySchemaVersion !== PUBLIC_SOURCE_POLICY_SCHEMA ||
    receipt.authoritative !== true ||
    !hasExactKeys(receipt.authority, ["protocol", "condition"]) ||
    receipt.authority.protocol !== TRANSACTION_SCHEMA ||
    receipt.authority.condition !== RECEIPT_AUTHORITY_CONDITION ||
    !hasExactKeys(receipt.source, ["commit", "tree"]) ||
    !validObjectId(receipt.source.commit) ||
    !validObjectId(receipt.source.tree) ||
    receipt.source.commit.length !== receipt.source.tree.length ||
    !hasExactKeys(receipt.summary, ["fileCount", "totalBytes", "manifestSha256", "snapshotSha256"]) ||
    !hasExactKeys(receipt.gitIndexMode, Object.keys(GIT_INDEX_MODE)) ||
    !sameJson(receipt.gitIndexMode, GIT_INDEX_MODE) ||
    !Array.isArray(receipt.files) ||
    receipt.files.length > MAX_PUBLIC_FILES
  ) {
    throw invalid();
  }

  let totalBytes = 0;
  let previousPath = null;
  for (const entry of receipt.files) {
    if (
      !hasExactKeys(entry, ["path", "bytes", "mode", "sha256"]) ||
      typeof entry.path !== "string" ||
      getPortablePathViolation(entry.path) !== null ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      entry.bytes > MAX_PUBLIC_FILE_BYTES ||
      !["100644", "100755"].includes(entry.mode) ||
      typeof entry.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(entry.sha256) ||
      (previousPath !== null && comparePublicPaths(previousPath, entry.path) >= 0)
    ) {
      throw invalid();
    }
    totalBytes += entry.bytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_PUBLIC_TOTAL_BYTES) throw invalid();
    previousPath = entry.path;
  }

  const manifestSha256 = computeReceiptManifestSha256(receipt.files);
  const snapshotSha256 = sha256(
    `commit ${receipt.source.commit}\ntree ${receipt.source.tree}\npolicy ${PUBLIC_SOURCE_POLICY_SCHEMA}\nmanifest ${manifestSha256}\nfiles ${receipt.files.length}\nbytes ${totalBytes}\n`,
  );
  if (
    receipt.summary.fileCount !== receipt.files.length ||
    receipt.summary.totalBytes !== totalBytes ||
    receipt.summary.manifestSha256 !== manifestSha256 ||
    receipt.summary.snapshotSha256 !== snapshotSha256
  ) {
    throw new VerificationError("RECEIPT_SUMMARY_MISMATCH", "receipt summary cannot be reproduced from its contents");
  }
}

function assertIdentityShape(identity, expectedKind) {
  return (
    hasExactKeys(identity, ["absolute", "canonical", "dev", "ino", "nlink", "kind"]) &&
    typeof identity.absolute === "string" &&
    typeof identity.canonical === "string" &&
    /^\d+$/.test(identity.dev) &&
    /^\d+$/.test(identity.ino) &&
    /^\d+$/.test(identity.nlink) &&
    identity.kind === expectedKind
  );
}

function sameRecordedIdentity(recorded, actual, compareLinkCount = false) {
  return (
    recorded.dev === actual.dev &&
    recorded.ino === actual.ino &&
    recorded.kind === actual.kind &&
    (!compareLinkCount || recorded.nlink === actual.nlink) &&
    sameLocalPath(recorded.absolute, actual.absolute) &&
    sameLocalPath(recorded.canonical, actual.canonical)
  );
}

async function assertMarker({ marker, markerBytes, markerCapture, repoRoot, receiptPath, receiptBytes, receiptCapture, receipt }) {
  const invalid = () =>
    new VerificationError("TRANSACTION_MARKER_INVALID", "transaction marker does not match the strict complete schema");
  if (
    !hasExactKeys(marker, [
      "schemaVersion",
      "authoritative",
      "phase",
      "nonce",
      "output",
      "receipt",
      "source",
      "receiptSha256",
      "errorCode",
      "identities",
    ]) ||
    marker.schemaVersion !== TRANSACTION_SCHEMA ||
    typeof marker.nonce !== "string" ||
    marker.nonce.length === 0 ||
    !sameLocalPath(marker.output, repoRoot) ||
    !sameLocalPath(marker.receipt, receiptPath) ||
    !hasExactKeys(marker.source, ["commit", "tree"]) ||
    !sameJson(marker.source, receipt.source) ||
    typeof marker.receiptSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(marker.receiptSha256)
  ) {
    throw invalid();
  }
  if (marker.authoritative !== true || marker.phase !== "complete") {
    throw new VerificationError(
      "TRANSACTION_MARKER_NOT_COMPLETE",
      "transaction marker must be complete and authoritative",
    );
  }
  if (
    marker.errorCode !== null ||
    !hasExactKeys(marker.identities, ["output", "receipt", "transactionMarker"]) ||
    !assertIdentityShape(marker.identities.output, "directory") ||
    !assertIdentityShape(marker.identities.receipt, "file") ||
    !assertIdentityShape(marker.identities.transactionMarker, "file")
  ) {
    throw invalid();
  }
  if (marker.receiptSha256 !== sha256(receiptBytes)) {
    throw new VerificationError("TRANSACTION_RECEIPT_MISMATCH", "transaction marker does not bind the exact receipt bytes");
  }

  const repoCapture = await capturePathIdentityPins(repoRoot);
  const actualOutput = repoCapture.pins.at(-1);
  const actualReceipt = receiptCapture.pins.at(-1);
  const actualMarker = markerCapture.pins.at(-1);
  if (
    !actualOutput ||
    actualOutput.absolute !== repoCapture.resolved ||
    actualOutput.kind !== "directory" ||
    !sameRecordedIdentity(marker.identities.output, actualOutput) ||
    !sameRecordedIdentity(marker.identities.receipt, actualReceipt, true) ||
    !sameRecordedIdentity(marker.identities.transactionMarker, actualMarker, true) ||
    !(await verifyPathIdentityPins(repoCapture.pins)) ||
    !(await verifyPathIdentityPins(receiptCapture.pins)) ||
    !(await verifyPathIdentityPins(markerCapture.pins))
  ) {
    throw new VerificationError("TRANSACTION_IDENTITY_MISMATCH", "transaction marker identities no longer match");
  }
  if (!markerBytes.equals(await readFile(markerCapture.resolved))) {
    throw new VerificationError("VERIFICATION_INPUT_CHANGED", "transaction marker changed while it was checked");
  }
}

function exactFilesMatch(actual, expected) {
  if (actual.length !== expected.length) return false;
  return actual.every(
    (entry, index) =>
      entry.path === expected[index].path &&
      entry.mode === expected[index].mode &&
      entry.bytes === expected[index].bytes &&
      entry.sha256 === expected[index].sha256,
  );
}

export async function verifyPublicCommit(options) {
  const receiptRead = await readPinnedJson(options.receipt, MAX_PUBLIC_RECEIPT_BYTES, "RECEIPT_INVALID");
  assertReceipt(receiptRead.value);

  const markerRead = await readPinnedJson(
    options.transactionMarker,
    MAX_TRANSACTION_MARKER_BYTES,
    "TRANSACTION_MARKER_INVALID",
  );
  await assertMarker({
    marker: markerRead.value,
    markerBytes: markerRead.bytes,
    markerCapture: markerRead.capture,
    repoRoot: options.repoRoot,
    receiptPath: options.receipt,
    receiptBytes: receiptRead.bytes,
    receiptCapture: receiptRead.capture,
    receipt: receiptRead.value,
  });

  const rootCapture = await capturePathIdentityPins(options.repoRoot);
  const rootPin = rootCapture.pins.at(-1);
  if (!rootPin || rootPin.absolute !== rootCapture.resolved || rootPin.kind !== "directory") {
    throw new VerificationError("PUBLIC_REPO_INVALID", "public repository root must be a regular directory");
  }
  const before = readGitMetadata(options.repoRoot);
  if (!sameLocalPath(before.topLevel, options.repoRoot)) {
    throw new VerificationError("PUBLIC_REPO_NOT_TOPLEVEL", "public repository root must be the exact Git top level");
  }
  if (before.dirty) {
    throw new VerificationError("PUBLIC_REPO_DIRTY", "public repository must have a clean HEAD");
  }
  const parents = readGitCommitParents(options.repoRoot, before.commit);
  if (parents.length !== 0) {
    throw new VerificationError(
      "PUBLIC_COMMIT_HAS_PARENTS",
      "the first public commit must be a root commit with no parent history",
    );
  }

  const inspection = await inspectGitRepository({
    repoRoot: options.repoRoot,
    purpose: "check",
    expectedCommit: before.commit,
    expectedTree: before.tree,
  });
  if (!inspection.ok || !inspection.authoritative || inspection.dirty || inspection.violations.length > 0) {
    throw new VerificationError("PUBLIC_POLICY_FAILED", "public HEAD does not satisfy the strict public policy");
  }
  const actualFiles = inspection.included.map(({ path: relative, mode, bytes, sha256: digest }) => ({
    path: relative,
    bytes,
    mode,
    sha256: digest,
  }));
  if (!exactFilesMatch(actualFiles, receiptRead.value.files)) {
    throw new VerificationError(
      "PUBLIC_COMMIT_RECEIPT_MISMATCH",
      "public HEAD paths, modes, blob bytes, or SHA-256 values do not exactly match the receipt",
    );
  }

  const after = readGitMetadata(options.repoRoot);
  if (
    after.dirty ||
    after.commit !== before.commit ||
    after.tree !== before.tree ||
    !(await verifyPathIdentityPins(rootCapture.pins)) ||
    !(await verifyPathIdentityPins(receiptRead.capture.pins)) ||
    !receiptRead.bytes.equals(await readFile(receiptRead.capture.resolved)) ||
    !(await verifyPathIdentityPins(markerRead.capture.pins)) ||
    !markerRead.bytes.equals(await readFile(markerRead.capture.resolved))
  ) {
    throw new VerificationError("VERIFICATION_INPUT_CHANGED", "verification inputs changed while they were checked");
  }

  return {
    schemaVersion: RESULT_SCHEMA,
    ok: true,
    authoritative: true,
    publicCommit: before.commit,
    publicTree: before.tree,
    policySchemaVersion: PUBLIC_SOURCE_POLICY_SCHEMA,
    receiptSha256: sha256(receiptRead.bytes),
    transactionMarkerSha256: sha256(markerRead.bytes),
    transactionMarkerVerified: true,
    initialCommitVerified: true,
    summary: { ...receiptRead.value.summary },
  };
}

function classifyError(error) {
  if (error instanceof VerificationError) return error;
  if (IO_OR_SECURITY_CODES.has(error?.code)) {
    return new VerificationError("VERIFY_IO_OR_SECURITY", "verification encountered a safe I/O refusal", 4);
  }
  if (["GIT_FAILED", "SOURCE_CHANGED", "FIXED_GIT_OBJECT_REQUIRED"].includes(error?.code)) {
    return new VerificationError("PUBLIC_REPO_INVALID", "public repository is not a stable readable Git worktree", 3);
  }
  return new VerificationError("INTERNAL_ERROR", "public commit verification failed", 5);
}

function failureResult(error) {
  return {
    schemaVersion: RESULT_SCHEMA,
    ok: false,
    authoritative: false,
    error: { code: error.code, message: error.message },
  };
}

async function main() {
  let json = process.argv.includes("--json");
  try {
    const options = parseArguments(process.argv.slice(2));
    json = true;
    const result = await verifyPublicCommit(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (caught) {
    const error = classifyError(caught);
    if (json) process.stdout.write(`${JSON.stringify(failureResult(error))}\n`);
    else process.stderr.write(`verify-public-commit failed: ${error.message}\n`);
    process.exitCode = error.exitCode;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
