#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeBrandText,
  formerBrandMatches,
  shouldScanFormerAbbreviation,
} from "./former-brand-policy.mjs";

export const BRAND_CHECK_SCHEMA = "useful.brand-check.v1";

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function invalidArguments(message = "expected [--repo-root <path>] [--json]") {
  const error = new Error(message);
  error.code = "INVALID_ARGUMENTS";
  error.exitCode = 2;
  return error;
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

function runGit(repoRoot, args) {
  const child = spawnSync("git", ["-c", `safe.directory=${repoRoot}`, ...args], {
    cwd: repoRoot,
    encoding: null,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (child.error || child.status !== 0) {
    const error = new Error(child.stderr?.toString("utf8").trim() || `git ${args[0]} failed`);
    error.code = child.error?.code ?? "GIT_FAILED";
    error.exitCode = 4;
    throw error;
  }
  return child.stdout;
}

function lineNumberAt(text, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function addViolationOnce(violations, violation) {
  if (!violations.some((item) => (
    item.path === violation.path
    && item.code === violation.code
    && item.details?.kind === violation.details?.kind
  ))) {
    violations.push(violation);
  }
}

function scanText(relative, text, violations) {
  for (const match of formerBrandMatches(text, {
    includeAbbreviation: shouldScanFormerAbbreviation(relative),
  })) {
    addViolationOnce(violations, {
      path: relative,
      code: "legacy-brand-content",
      details: { kind: match.kind, line: lineNumberAt(text, match.offset) },
    });
  }
}

function scanBinary(relative, bytes, violations) {
  for (const match of formerBrandMatches(bytes.toString("latin1"), { includeAbbreviation: false })) {
    addViolationOnce(violations, {
      path: relative,
      code: "legacy-brand-content",
      details: { kind: match.kind, line: null },
    });
  }
}

export async function inspectBrand({ repoRoot }) {
  const resolvedRoot = path.resolve(repoRoot);
  const tracked = runGit(resolvedRoot, ["ls-files", "-z"])
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
  const violations = [];

  for (const relative of tracked) {
    for (const match of formerBrandMatches(relative, {
      includeAbbreviation: shouldScanFormerAbbreviation(relative),
    })) {
      addViolationOnce(violations, {
        path: relative,
        code: "legacy-brand-path",
        details: { kind: match.kind },
      });
    }

    const absolute = path.join(resolvedRoot, ...relative.split("/"));
    let info;
    let bytes;
    try {
      info = await lstat(absolute);
      if (!info.isFile()) continue;
      bytes = await readFile(absolute);
    } catch {
      violations.push({ path: relative, code: "tracked-file-unreadable" });
      continue;
    }

    try {
      const text = decodeBrandText(bytes);
      if (text === null) scanBinary(relative, bytes, violations);
      else scanText(relative, text, violations);
    } catch {
      scanBinary(relative, bytes, violations);
    }
  }

  violations.sort((left, right) => (
    left.path.localeCompare(right.path)
    || left.code.localeCompare(right.code)
    || String(left.details?.kind ?? "").localeCompare(String(right.details?.kind ?? ""))
  ));
  return {
    schemaVersion: BRAND_CHECK_SCHEMA,
    ok: violations.length === 0,
    repoRoot: resolvedRoot,
    trackedFileCount: tracked.length,
    violationCount: violations.length,
    violations,
  };
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = await inspectBrand(options);
    if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else process.stdout.write(`Useful brand check: ${result.ok ? "PASS" : "BLOCKED"}; violations=${result.violationCount}\n`);
    process.exitCode = result.ok ? 0 : 3;
  } catch (error) {
    const payload = {
      schemaVersion: BRAND_CHECK_SCHEMA,
      ok: false,
      error: { code: error.code ?? "INTERNAL_ERROR", message: error.message },
    };
    if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(payload)}\n`);
    else process.stderr.write(`brand check failed: ${error.message}\n`);
    process.exitCode = error.exitCode ?? 5;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
