#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeReceiptManifestSha256, inspectGitRepository } from "./public-source-policy.mjs";

const RESULT_SCHEMA = "useful.public-source-check.v2";
const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
]);

class CheckError extends Error {
  constructor(code, message, exitCode, details = undefined) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

function invalidArguments(message = "expected [--repo-root <path>] [--json]") {
  return new CheckError("INVALID_ARGUMENTS", message, 2);
}

export function parseArguments(argv) {
  const parsed = { repoRoot: defaultRepoRoot, json: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      if (seen.has(argument)) throw invalidArguments(`duplicate option: ${argument}`);
      seen.add(argument);
      parsed.json = true;
      continue;
    }
    if (argument === "--repo-root") {
      if (seen.has(argument) || !argv[index + 1] || argv[index + 1].startsWith("--")) {
        throw invalidArguments("--repo-root requires one path");
      }
      seen.add(argument);
      parsed.repoRoot = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    throw invalidArguments(`unknown option: ${argument}`);
  }
  return parsed;
}

function classifyError(error) {
  if (error instanceof CheckError) return error;
  if (IO_OR_SECURITY_CODES.has(error?.code)) {
    return new CheckError("PUBLIC_SOURCE_IO_OR_SECURITY", "public source check encountered a safe I/O refusal", 4, {
      nativeCode: error.code,
    });
  }
  if (["GIT_FAILED", "SOURCE_CHANGED", "FIXED_GIT_OBJECT_REQUIRED"].includes(error?.code)) {
    return new CheckError("SOURCE_VALIDATION_FAILED", "source is not a readable, stable Git worktree", 3, {
      reason: error.code,
    });
  }
  return new CheckError("INTERNAL_ERROR", "public source check failed", 5);
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
    violations: [],
    excluded: [],
    included: [],
  };
}

export async function runCheck(options) {
  const inspection = await inspectGitRepository({ repoRoot: options.repoRoot, purpose: "check" });
  const included = inspection.included.map(({ path: relative, bytes, sha256, mode }) => ({
    path: relative,
    bytes,
    mode,
    sha256,
  }));
  const result = {
    schemaVersion: RESULT_SCHEMA,
    ok: inspection.ok,
    authoritative: inspection.authoritative,
    commit: inspection.commit,
    tree: inspection.tree,
    dirty: inspection.dirty,
    includedCount: included.length,
    excludedCount: inspection.excluded.length,
    totalBytes: inspection.summary.totalBytes,
    manifestSha256: inspection.manifestSha256,
    receiptManifestSha256: computeReceiptManifestSha256(included),
    violations: inspection.violations,
    excluded: inspection.excluded,
    included,
    ...(inspection.ok
      ? {}
      : {
          error: {
            code: "SOURCE_POLICY_FAILED",
            message: "source does not satisfy the strict public snapshot policy",
            details: { violationCount: inspection.violations.length },
          },
        }),
  };
  return { result, exitCode: result.ok && result.authoritative ? 0 : 3 };
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
    const outcome = await runCheck(options);
    if (options.json) process.stdout.write(`${JSON.stringify(outcome.result)}\n`);
    else {
      process.stdout.write(
        `Useful public source: ${outcome.result.ok ? "PASS" : "FAIL"}; included=${outcome.result.includedCount}; excluded=${outcome.result.excludedCount}; violations=${outcome.result.violations.length}\n`,
      );
      for (const violation of outcome.result.violations) {
        process.stderr.write(`- ${violation.code}: ${violation.path ?? "repository"}\n`);
      }
    }
    process.exitCode = outcome.exitCode;
  } catch (caught) {
    const error = classifyError(caught);
    const json = options?.json ?? process.argv.includes("--json");
    if (json) process.stdout.write(`${JSON.stringify(failureResult(error))}\n`);
    else process.stderr.write(`public-source-check failed: ${error.message}\n`);
    process.exitCode = error.exitCode;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
