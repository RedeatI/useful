#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_PUBLIC_RECEIPT_BYTES,
  PUBLIC_SOURCE_POLICY_SCHEMA,
  capturePathIdentityPins,
  comparePublicPaths,
  computeReceiptManifestSha256,
  getLocalAbsolutePathViolation,
  inspectGitRepository,
  readGitBlob,
  readGitMetadata,
  sha256,
  validatePublicSnapshotDirectory,
  verifyPathIdentityPins,
} from "./public-source-policy.mjs";

const RESULT_SCHEMA = "useful.prepare-public-source.result.v2";
const RECEIPT_SCHEMA = "useful.public-source-receipt.v2";
const TRANSACTION_SCHEMA = "useful.public-source-transaction.v1";
const IO_OR_SECURITY_CODES = new Set([
  "EACCES",
  "EBUSY",
  "EEXIST",
  "EIO",
  "ELOOP",
  "EMFILE",
  "ENFILE",
  "ENOENT",
  "ENOSPC",
  "ENOTDIR",
  "EPERM",
  "EROFS",
  "EXDEV",
  "GIT_IO_FAILED",
]);

export class BuilderError extends Error {
  constructor(code, message, exitCode, details = undefined) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

function invalidArguments() {
  return new BuilderError(
    "INVALID_ARGUMENTS",
    "expected exactly --repo-root <path> --output <new-local-absolute-directory> --receipt <new-local-absolute-json> --json",
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
    if (!["--repo-root", "--output", "--receipt"].includes(argument)) throw invalidArguments();
    if (values.has(argument) || !argv[index + 1] || argv[index + 1].startsWith("--")) throw invalidArguments();
    const value = argv[index + 1];
    if (argument !== "--repo-root") {
      const reason = getLocalAbsolutePathViolation(value);
      if (reason) throw new BuilderError("UNSUPPORTED_DESTINATION_PATH", "destination must be a supported local absolute path", 4, { reason });
    }
    values.set(argument, argument === "--repo-root" ? path.resolve(value) : path.normalize(value));
    index += 1;
  }
  if (!json || values.size !== 3) throw invalidArguments();
  return {
    repoRoot: values.get("--repo-root"),
    output: values.get("--output"),
    receipt: values.get("--receipt"),
  };
}

function comparablePath(absolute) {
  const normalized = path.resolve(absolute).normalize("NFC");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(left, right) {
  return comparablePath(left) === comparablePath(right);
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function pathExists(absolute) {
  try {
    await lstat(absolute);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function transactionMarkerPath(output) {
  return `${output}.useful-public-source.transaction.json`;
}

function identityFromInfo(info) {
  return {
    dev: info.dev.toString(),
    ino: info.ino.toString(),
    nlink: info.nlink.toString(),
    kind: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
  };
}

function sameObjectIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.kind === right.kind;
}

function sameIdentity(left, right) {
  return (
    sameObjectIdentity(left, right) &&
    left.absolute === right.absolute &&
    left.canonical === right.canonical
  );
}

async function readOwnedIdentity(absolute, expectedKind) {
  const capture = await capturePathIdentityPins(absolute);
  const identity = capture.pins.at(-1);
  if (
    !identity ||
    identity.absolute !== capture.resolved ||
    identity.kind !== expectedKind ||
    BigInt(identity.nlink) < 1n ||
    (expectedKind === "file" && identity.nlink !== "1")
  ) {
    throw new BuilderError("DESTINATION_IDENTITY_CHANGED", "a generated path no longer has its owned identity", 4);
  }
  return identity;
}

async function assertOwnedIdentity(absolute, expected) {
  const actual = await readOwnedIdentity(absolute, expected.kind);
  if (!sameIdentity(actual, expected)) {
    throw new BuilderError("DESTINATION_IDENTITY_CHANGED", "a generated path identity changed", 4);
  }
}

async function assertTransactionMarkerIdentity(absolute, expected) {
  const actual = await readOwnedIdentity(absolute, "file");
  if (!sameIdentity(actual, expected)) {
    throw new BuilderError("TRANSACTION_IDENTITY_CHANGED", "transaction marker identity changed", 4);
  }
}

function canonicalProspectivePath(capture) {
  const anchor = capture.pins.at(-1);
  if (!anchor) throw new BuilderError("PATH_IDENTITY_UNAVAILABLE", "path identity could not be established", 4);
  const suffix = path.relative(anchor.absolute, capture.resolved);
  return suffix ? path.join(anchor.canonical, suffix) : anchor.canonical;
}

async function assertPins(...captures) {
  for (const capture of captures) {
    if (!(await verifyPathIdentityPins(capture.pins))) {
      throw new BuilderError("PATH_IDENTITY_CHANGED", "an existing path ancestor changed during generation", 4);
    }
  }
}

async function assertExistingDirectory(absolute, label) {
  let info;
  try {
    info = await lstat(absolute, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") throw new BuilderError("PARENT_DIRECTORY_MISSING", `${label} parent must exist`, 4);
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new BuilderError("PATH_NOT_DIRECTORY", `${label} parent must be a regular directory`, 4);
  }
}

function buildReceipt(inspection) {
  const files = inspection.included
    .map(({ path: relative, bytes, sha256: digest, mode }) => ({ path: relative, bytes, mode, sha256: digest }))
    .sort((left, right) => comparePublicPaths(left.path, right.path));
  const manifestSha256 = computeReceiptManifestSha256(files);
  const totalBytes = files.reduce((total, entry) => total + entry.bytes, 0);
  const snapshotSha256 = sha256(
    `commit ${inspection.commit}\ntree ${inspection.tree}\npolicy ${PUBLIC_SOURCE_POLICY_SCHEMA}\nmanifest ${manifestSha256}\nfiles ${files.length}\nbytes ${totalBytes}\n`,
  );
  return {
    schemaVersion: RECEIPT_SCHEMA,
    policySchemaVersion: PUBLIC_SOURCE_POLICY_SCHEMA,
    authoritative: true,
    authority: {
      protocol: TRANSACTION_SCHEMA,
      condition: "the transaction marker named by the successful CLI result is valid, has phase=complete, binds this receipt SHA-256, and its recorded file identities still match",
    },
    source: { commit: inspection.commit, tree: inspection.tree },
    summary: { fileCount: files.length, totalBytes, manifestSha256, snapshotSha256 },
    gitIndexMode: {
      filesystemModeAuthoritative: false,
      applyFrom: "files[].mode",
      application: "after git add, apply --chmod=+x for 100755 and --chmod=-x for 100644 to each exact path",
      verification: "compare every committed Git tree path, mode, blob byte length, and SHA-256 with files[]",
    },
    files,
  };
}

async function writeHandleBytes(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
    if (bytesWritten <= 0) throw new Error("short write");
    offset += bytesWritten;
  }
  await handle.truncate(bytes.length);
  await handle.sync();
}

async function writeExclusiveOwned(absolute, bytes, mode = 0o600) {
  const handle = await open(absolute, "wx", mode);
  let identity;
  let originalError;
  try {
    identity = identityFromInfo(await handle.stat({ bigint: true }));
    if (identity.kind !== "file" || identity.nlink !== "1") {
      throw new BuilderError("DESTINATION_IDENTITY_CHANGED", "new file is not a unique regular file", 4);
    }
    await writeHandleBytes(handle, bytes);
  } catch (error) {
    originalError = error;
  }
  try {
    await handle.close();
  } catch (error) {
    if (!originalError) originalError = error;
  }
  if (originalError) throw originalError;
  const pathIdentity = await readOwnedIdentity(absolute, "file");
  if (!sameObjectIdentity(pathIdentity, identity)) {
    throw new BuilderError("DESTINATION_IDENTITY_CHANGED", "new file path identity changed after close", 4);
  }
  return pathIdentity;
}

function transactionState({
  nonce,
  phase,
  output,
  receipt,
  source,
  receiptSha256 = null,
  errorCode = null,
  identities = null,
}) {
  return {
    schemaVersion: TRANSACTION_SCHEMA,
    authoritative: phase === "complete",
    phase,
    nonce,
    output,
    receipt,
    source,
    receiptSha256,
    errorCode,
    identities,
  };
}

async function updateOwnedTransactionMarker(absolute, expectedIdentity, nonce, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  const handle = await open(absolute, "r+");
  let originalError;
  try {
    const handleIdentity = identityFromInfo(await handle.stat({ bigint: true }));
    if (!sameObjectIdentity(handleIdentity, expectedIdentity) || handleIdentity.nlink !== "1") {
      throw new BuilderError("TRANSACTION_IDENTITY_CHANGED", "transaction marker identity changed", 4);
    }
    const existingBytes = await handle.readFile();
    let existing;
    try {
      existing = JSON.parse(existingBytes.toString("utf8"));
    } catch {
      throw new BuilderError("TRANSACTION_IDENTITY_CHANGED", "transaction marker is not readable JSON", 4);
    }
    if (existing.nonce !== nonce) {
      throw new BuilderError("TRANSACTION_IDENTITY_CHANGED", "transaction marker nonce changed", 4);
    }
    await writeHandleBytes(handle, bytes);
  } catch (error) {
    originalError = error;
  }
  try {
    await handle.close();
  } catch (error) {
    if (!originalError) originalError = error;
  }
  if (originalError) throw originalError;
  await assertTransactionMarkerIdentity(absolute, expectedIdentity);
  if (!Buffer.from(await readFile(absolute)).equals(bytes)) {
    throw new BuilderError("TRANSACTION_IDENTITY_CHANGED", "transaction marker readback changed", 4);
  }
}

async function ensureOwnedDirectory(output, relativeDirectory, identities) {
  let current = output;
  if (!relativeDirectory || relativeDirectory === ".") return;
  for (const segment of relativeDirectory.split(path.sep)) {
    current = path.join(current, segment);
    const known = identities.get(current);
    if (known) {
      await assertOwnedIdentity(current, known);
      continue;
    }
    try {
      await mkdir(current, { recursive: false });
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new BuilderError("DESTINATION_RACE", "an unexpected directory appeared inside the reserved output", 4);
      }
      throw error;
    }
    identities.set(current, await readOwnedIdentity(current, "directory"));
  }
}

async function copyGitEntries(repoRoot, output, outputIdentity, entries, pathCaptures, marker, markerIdentity) {
  const directoryIdentities = new Map([[output, outputIdentity]]);
  for (const entry of entries) {
    await assertPins(...pathCaptures);
    await assertOwnedIdentity(output, outputIdentity);
    await assertTransactionMarkerIdentity(marker, markerIdentity);
    const target = path.join(output, ...entry.path.split("/"));
    await ensureOwnedDirectory(output, path.dirname(path.relative(output, target)), directoryIdentities);
    const bytes = readGitBlob(repoRoot, entry.object);
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
      throw new BuilderError("SOURCE_CHANGED", "source Git object changed during generation", 3);
    }
    const identity = await writeExclusiveOwned(target, bytes, 0o600);
    await chmod(target, entry.mode === "100755" ? 0o755 : 0o644);
    await assertOwnedIdentity(target, identity);
  }
}

function classifyBuilderError(error) {
  if (error instanceof BuilderError) return error;
  if (IO_OR_SECURITY_CODES.has(error?.code)) {
    return new BuilderError("PUBLIC_SOURCE_IO_OR_SECURITY", "public source generation encountered a safe I/O refusal", 4, {
      nativeCode: error.code,
    });
  }
  if (["GIT_FAILED", "SOURCE_CHANGED", "FIXED_GIT_OBJECT_REQUIRED"].includes(error?.code)) {
    return new BuilderError("SOURCE_VALIDATION_FAILED", "source is not a readable, stable Git worktree", 3, {
      reason: error.code,
    });
  }
  if (["UNSUPPORTED_LOCAL_PATH", "PATH_ALIAS_UNSUPPORTED", "HARDLINK_UNSUPPORTED", "PATH_ANCESTOR_NOT_DIRECTORY"].includes(error?.code)) {
    return new BuilderError("UNSUPPORTED_DESTINATION_PATH", "path identity cannot be proven safe", 4, {
      reason: error.code,
    });
  }
  return new BuilderError("INTERNAL_ERROR", "public source generation failed", 5);
}

function appendErrorDetails(error, extra) {
  error.details = { ...(error.details && typeof error.details === "object" ? error.details : {}), ...extra };
  return error;
}

async function bestEffortMarkIncomplete(context, originalError) {
  const cleanupErrors = [];
  if (context.markerIdentity) {
    try {
      await updateOwnedTransactionMarker(
        context.marker,
        context.markerIdentity,
        context.nonce,
        transactionState({
          nonce: context.nonce,
          phase: "incomplete",
          output: context.output,
          receipt: context.receipt,
          source: context.source,
          receiptSha256: context.receiptSha256,
          errorCode: originalError.code,
        }),
      );
    } catch (error) {
      cleanupErrors.push(classifyBuilderError(error).code);
    }
  }
  appendErrorDetails(originalError, {
    authoritative: false,
    transactionMarker: context.marker,
    cleanupErrors,
    cleanupPolicy: "owned artifacts are retained; no path-based recursive deletion is attempted",
  });
  return originalError;
}

export async function generate(options, { testHooks = undefined } = {}) {
  const marker = transactionMarkerPath(options.output);
  const markerReason = getLocalAbsolutePathViolation(marker);
  if (markerReason) {
    throw new BuilderError("UNSUPPORTED_DESTINATION_PATH", "transaction marker path is unsupported", 4, { reason: markerReason });
  }

  const [sourceCapture, outputCapture, receiptCapture, markerCapture] = await Promise.all([
    capturePathIdentityPins(options.repoRoot),
    capturePathIdentityPins(options.output),
    capturePathIdentityPins(options.receipt),
    capturePathIdentityPins(marker),
  ]);
  await assertExistingDirectory(path.dirname(options.output), "output");
  await assertExistingDirectory(path.dirname(options.receipt), "receipt");
  const sourceCanonical = canonicalProspectivePath(sourceCapture);
  const outputCanonical = canonicalProspectivePath(outputCapture);
  const receiptCanonical = canonicalProspectivePath(receiptCapture);
  const markerCanonical = canonicalProspectivePath(markerCapture);
  if (samePath(outputCanonical, receiptCanonical) || isInside(outputCanonical, receiptCanonical)) {
    throw new BuilderError("INVALID_DESTINATION_LAYOUT", "receipt must be outside the output directory", 4);
  }
  if (
    samePath(sourceCanonical, outputCanonical) ||
    samePath(sourceCanonical, receiptCanonical) ||
    samePath(sourceCanonical, markerCanonical) ||
    isInside(sourceCanonical, outputCanonical) ||
    isInside(outputCanonical, sourceCanonical) ||
    isInside(sourceCanonical, receiptCanonical) ||
    isInside(sourceCanonical, markerCanonical)
  ) {
    throw new BuilderError("INVALID_DESTINATION_LAYOUT", "destinations must be outside the source repository", 4);
  }
  if (samePath(markerCanonical, receiptCanonical) || isInside(outputCanonical, markerCanonical)) {
    throw new BuilderError("INVALID_DESTINATION_LAYOUT", "transaction marker must be a distinct sibling path", 4);
  }
  if (await pathExists(options.output)) throw new BuilderError("OUTPUT_EXISTS", "output directory already exists", 4);
  if (await pathExists(options.receipt)) throw new BuilderError("RECEIPT_EXISTS", "receipt file already exists", 4);
  if (await pathExists(marker)) throw new BuilderError("TRANSACTION_EXISTS", "transaction marker already exists", 4);

  let metadata;
  try {
    metadata = readGitMetadata(options.repoRoot);
  } catch (error) {
    if (IO_OR_SECURITY_CODES.has(error?.code)) throw error;
    throw new BuilderError("SOURCE_NOT_GIT", "source must be a readable Git repository", 3);
  }
  if (!samePath(metadata.topLevel, sourceCanonical)) {
    throw new BuilderError("SOURCE_ROOT_NOT_TOPLEVEL", "source must be the exact Git worktree root", 3);
  }
  if (metadata.dirty) throw new BuilderError("SOURCE_DIRTY", "source Git worktree must be clean", 3);

  const inspection = await inspectGitRepository({
    repoRoot: options.repoRoot,
    purpose: "build",
    expectedCommit: metadata.commit,
    expectedTree: metadata.tree,
  });
  if (!inspection.authoritative || inspection.violations.length > 0) {
    throw new BuilderError("SOURCE_POLICY_FAILED", "source does not satisfy public snapshot policy", 3, {
      violations: inspection.violations,
    });
  }
  const receipt = buildReceipt(inspection);
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  if (receiptBytes.length > MAX_PUBLIC_RECEIPT_BYTES) {
    throw new BuilderError("RECEIPT_BYTES_LIMIT", "receipt exceeds the deterministic byte budget", 3, {
      actual: receiptBytes.length,
      maximum: MAX_PUBLIC_RECEIPT_BYTES,
    });
  }

  const nonce = `${process.pid}-${randomUUID()}`;
  const context = {
    nonce,
    marker,
    markerIdentity: null,
    output: options.output,
    receipt: options.receipt,
    source: receipt.source,
    receiptSha256: sha256(receiptBytes),
  };
  const pathCaptures = [sourceCapture, outputCapture, receiptCapture, markerCapture];
  let outputIdentity;
  let receiptIdentity;
  let finalMarkerBytes;
  try {
    await assertPins(...pathCaptures);
    const initialMarker = transactionState({
      nonce,
      phase: "incomplete",
      output: options.output,
      receipt: options.receipt,
      source: receipt.source,
      receiptSha256: context.receiptSha256,
    });
    context.markerIdentity = await writeExclusiveOwned(
      marker,
      Buffer.from(`${JSON.stringify(initialMarker, null, 2)}\n`, "utf8"),
    );
    if (testHooks?.afterTransactionStarted) await testHooks.afterTransactionStarted({ ...context });
    await assertPins(...pathCaptures);
    await assertTransactionMarkerIdentity(marker, context.markerIdentity);
    try {
      await mkdir(options.output, { recursive: false });
    } catch (error) {
      if (error?.code === "EEXIST") throw new BuilderError("DESTINATION_RACE", "output appeared after preflight", 4);
      throw error;
    }
    outputIdentity = await readOwnedIdentity(options.output, "directory");
    if (testHooks?.afterOutputCreated) await testHooks.afterOutputCreated({ ...context, outputIdentity });
    await copyGitEntries(
      options.repoRoot,
      options.output,
      outputIdentity,
      inspection.included,
      pathCaptures,
      marker,
      context.markerIdentity,
    );
    const independent = await validatePublicSnapshotDirectory({ root: options.output, expectedEntries: receipt.files });
    if (!independent.ok || independent.included.length !== receipt.files.length) {
      throw new BuilderError("OUTPUT_VALIDATION_FAILED", "generated snapshot failed independent policy validation", 3, {
        violations: independent.violations,
      });
    }
    await assertPins(...pathCaptures);
    await assertOwnedIdentity(options.output, outputIdentity);
    await assertTransactionMarkerIdentity(marker, context.markerIdentity);
    const afterCopy = readGitMetadata(options.repoRoot);
    if (afterCopy.dirty || afterCopy.commit !== metadata.commit || afterCopy.tree !== metadata.tree) {
      throw new BuilderError("SOURCE_CHANGED", "source changed during generation", 3);
    }
    if (testHooks?.beforeReceiptCreate) await testHooks.beforeReceiptCreate({ ...context, outputIdentity });
    try {
      receiptIdentity = await writeExclusiveOwned(options.receipt, receiptBytes);
    } catch (error) {
      if (error?.code === "EEXIST") throw new BuilderError("DESTINATION_RACE", "receipt appeared after preflight", 4);
      throw error;
    }
    if (!Buffer.from(await readFile(options.receipt)).equals(receiptBytes)) {
      throw new BuilderError("RECEIPT_VALIDATION_FAILED", "generated receipt failed readback", 3);
    }
    if (testHooks?.beforeTransactionComplete) await testHooks.beforeTransactionComplete({ ...context, outputIdentity, receiptIdentity });
    await assertPins(...pathCaptures);
    await assertOwnedIdentity(options.output, outputIdentity);
    await assertOwnedIdentity(options.receipt, receiptIdentity);
    await assertTransactionMarkerIdentity(marker, context.markerIdentity);
    const beforeCommit = readGitMetadata(options.repoRoot);
    if (beforeCommit.dirty || beforeCommit.commit !== metadata.commit || beforeCommit.tree !== metadata.tree) {
      throw new BuilderError("SOURCE_CHANGED", "source changed during generation", 3);
    }
    await updateOwnedTransactionMarker(
      marker,
      context.markerIdentity,
      nonce,
      transactionState({
        nonce,
        phase: "complete",
        output: options.output,
        receipt: options.receipt,
        source: receipt.source,
        receiptSha256: context.receiptSha256,
        identities: {
          output: outputIdentity,
          receipt: receiptIdentity,
          transactionMarker: context.markerIdentity,
        },
      }),
    );
    finalMarkerBytes = await readFile(marker);
    await assertPins(...pathCaptures);
    await assertOwnedIdentity(options.output, outputIdentity);
    await assertOwnedIdentity(options.receipt, receiptIdentity);
    await assertTransactionMarkerIdentity(marker, context.markerIdentity);
    const finalMetadata = readGitMetadata(options.repoRoot);
    if (finalMetadata.dirty || finalMetadata.commit !== metadata.commit || finalMetadata.tree !== metadata.tree) {
      throw new BuilderError("SOURCE_CHANGED", "source changed during final verification", 3);
    }
    if (!finalMarkerBytes.equals(await readFile(marker))) {
      throw new BuilderError("TRANSACTION_CHANGED", "transaction marker changed during final verification", 4);
    }
  } catch (caught) {
    const original = classifyBuilderError(caught);
    throw await bestEffortMarkIncomplete(context, original);
  }
  return {
    schemaVersion: RESULT_SCHEMA,
    ok: true,
    authoritative: true,
    output: options.output,
    receipt: options.receipt,
    transactionMarker: marker,
    transactionIdentity: context.markerIdentity,
    receiptSha256: context.receiptSha256,
    transactionMarkerSha256: sha256(finalMarkerBytes),
    source: receipt.source,
    summary: receipt.summary,
  };
}

function failureResult(error) {
  return {
    schemaVersion: RESULT_SCHEMA,
    ok: false,
    authoritative: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = await generate(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (caught) {
    const error = classifyBuilderError(caught);
    process.stdout.write(`${JSON.stringify(failureResult(error))}\n`);
    process.exitCode = error.exitCode;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
