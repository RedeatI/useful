#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REQUIRED_PUBLIC_FILES, isExplicitlyExcluded } from "./public-source-policy.mjs";

const RESULT_SCHEMA = "useful.public-commit-candidates.v1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jsonMode = process.argv.includes("--json");

function git(args) {
  const result = spawnSync("git", ["-c", `safe.directory=${repoRoot}`, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

function classify(relative) {
  const r = relative.replaceAll("\\", "/");
  if (!r || r.endsWith("/")) return "skip-dir-marker";
  if (/(^|\/)(?:node_modules|target|artifacts|dist|dist-release|outputs|data|\.git)(\/|$)/i.test(r)) {
    return "excluded-generated";
  }
  if (isExplicitlyExcluded(r)) {
    return "excluded-internal";
  }
  if (/\.(?:exe|dll|pdb|log)$/i.test(r)) return "excluded-binary-or-log";
  if (r === "LICENSE" || REQUIRED_PUBLIC_FILES.includes(r)) return "required-public";
  if (
    r.startsWith("licenses/") ||
    r.startsWith(".github/") ||
    r.startsWith("assets/") ||
    r.startsWith("binaries/") ||
    r.startsWith("config/") ||
    r.startsWith("deploy/") ||
    r.startsWith("docs/") ||
    r.startsWith("fixtures/") ||
    r.startsWith("scripts/") ||
    r.startsWith("templates/")
  ) {
    return "open-source-tooling";
  }
  if (
    r.startsWith("apps/") ||
    r.startsWith("crates/") ||
    r.startsWith("packages/") ||
    r.startsWith("examples/") ||
    r.startsWith("services/") ||
    r.startsWith("repositories/")
  ) {
    return "product-source";
  }
  if (
    [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "Cargo.toml",
      "Cargo.lock",
      "README.md",
      "README.zh-CN.md",
      "AGENTS.md",
      "CONTRIBUTING.md",
      "SECURITY.md",
      "CODE_OF_CONDUCT.md",
      "LICENSES.md",
      "NOTICE",
      "THIRD_PARTY_NOTICES.md",
      "TRADEMARKS.md",
      "GOVERNANCE.md",
      ".gitignore",
      ".gitattributes",
    ].includes(r)
  ) {
    return "repo-root-public";
  }
  return "review";
}

async function main() {
  try {
    const status = git(["status", "--porcelain=v1", "--untracked-files=all"]);
    const entries = [];
    for (const line of status.split(/\r?\n/).filter(Boolean)) {
      const raw = line.slice(3);
      const relative = raw.includes(" -> ") ? raw.split(" -> ").pop() : raw;
      const normalized = relative.replaceAll("\\", "/");
      entries.push({ code: line.slice(0, 2), path: normalized, class: classify(normalized) });
    }

    const groups = {};
    for (const entry of entries) {
      groups[entry.class] ??= [];
      groups[entry.class].push(entry.path);
    }
    for (const key of Object.keys(groups)) {
      groups[key] = [...new Set(groups[key])].sort((a, b) => a.localeCompare(b));
    }

    const missingRequired = [];
    for (const relative of REQUIRED_PUBLIC_FILES) {
      try {
        await access(path.join(repoRoot, relative));
      } catch {
        missingRequired.push(relative);
      }
    }

    const recommendedCommitPaths = [
      ...(groups["open-source-tooling"] ?? []),
      ...(groups["repo-root-public"] ?? []),
      ...(groups["product-source"] ?? []),
      ...(groups["required-public"] ?? []),
    ]
      .filter((value, index, all) => all.indexOf(value) === index)
      .sort((a, b) => a.localeCompare(b));

    const result = {
      schemaVersion: RESULT_SCHEMA,
      ok: missingRequired.length === 0,
      authoritative: false,
      dirtyCount: entries.length,
      missingRequired,
      groups,
      recommendedCommitPaths,
      doNotCommit: [
        ...(groups["excluded-generated"] ?? []),
        ...(groups["excluded-internal"] ?? []),
        ...(groups["excluded-binary-or-log"] ?? []),
      ],
      reviewPaths: groups.review ?? [],
      needsOwnerBeforeCommit: missingRequired.includes("LICENSE")
        ? ["Generate root LICENSE with scripts/generate-root-license.mjs after legal holder approval"]
        : [],
      note: "Classifies the dirty worktree for an authorized future commit. Does not stage, commit, or publish.",
    };

    if (jsonMode) process.stdout.write(`${JSON.stringify(result)}\n`);
    else {
      process.stdout.write(
        `Public commit candidates: dirty=${result.dirtyCount}; recommended=${result.recommendedCommitPaths.length}; missingRequired=${missingRequired.join(",") || "none"}\n`,
      );
      process.stdout.write(`Do-not-commit=${result.doNotCommit.length}; review=${result.reviewPaths.length}\n`);
      process.stdout.write(`Needs owner: ${result.needsOwnerBeforeCommit.join("; ") || "none"}\n`);
    }
    process.exitCode = result.ok ? 0 : 3;
  } catch (error) {
    const payload = {
      schemaVersion: RESULT_SCHEMA,
      ok: false,
      authoritative: false,
      error: { code: error.code ?? "INTERNAL_ERROR", message: error.message },
    };
    if (jsonMode) process.stdout.write(`${JSON.stringify(payload)}\n`);
    else process.stderr.write(`list-public-commit-candidates failed: ${error.message}\n`);
    process.exitCode = 5;
  }
}

await main();
