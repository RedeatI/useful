#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PINNED_LICENSE_FILE_SHA256,
  digestLegalTextBytes,
} from "../packages/useful-cli/bin/license-policy.mjs";
import { inspectGitRepository, REQUIRED_PUBLIC_FILES } from "./public-source-policy.mjs";

export const RELEASE_READINESS_SCHEMA = "useful.release-readiness.v1";
export { PINNED_LICENSE_FILE_SHA256 };

// The Owner approved the complete path-to-SPDX classification on 2026-08-09. Keep this exported
// closed set so a future unmapped root can re-open the gate without weakening package validation.
export const PENDING_OWNER_LICENSE_MAPPINGS = Object.freeze([]);

export const APPROVED_EXACT_PATH_LICENSES = Object.freeze({
  ".gitattributes": "Apache-2.0",
  ".gitignore": "Apache-2.0",
  "AGENTS.md": "CC-BY-4.0",
  "Cargo.lock": "Apache-2.0",
  "Cargo.toml": "Apache-2.0",
  "CODE_OF_CONDUCT.md": "CC-BY-4.0",
  "CONTRIBUTING.md": "CC-BY-4.0",
  "GOVERNANCE.md": "CC-BY-4.0",
  "LICENSE": null,
  "LICENSES.md": null,
  "NOTICE": null,
  "README.md": "CC-BY-4.0",
  "README.zh-CN.md": "CC-BY-4.0",
  "SECURITY.md": "CC-BY-4.0",
  "THIRD_PARTY_NOTICES.md": null,
  "TRADEMARKS.md": null,
  "package.json": "Apache-2.0",
  "pnpm-lock.yaml": "Apache-2.0",
  "pnpm-workspace.yaml": "Apache-2.0",
  "rust-toolchain.toml": "Apache-2.0",
  "services/Dockerfile": "AGPL-3.0-or-later",
  "services/OPERATIONS.md": "AGPL-3.0-or-later",
  "services/go.mod": "AGPL-3.0-or-later",
  "services/go.sum": "AGPL-3.0-or-later",
});

export const APPROVED_LICENSE_PATH_PREFIXES = Object.freeze([
  [".github/", "Apache-2.0"],
  ["apps/source-admin/", "AGPL-3.0-or-later"],
  ["apps/useful/", "MPL-2.0"],
  ["binaries/", "Apache-2.0"],
  ["config/", "Apache-2.0"],
  ["crates/useful-", "MPL-2.0"],
  ["deploy/", "AGPL-3.0-or-later"],
  ["docs/", "CC-BY-4.0"],
  ["examples/", "Apache-2.0"],
  ["fixtures/", "Apache-2.0"],
  ["licenses/", null],
  ["packages/action-contract/", "Apache-2.0"],
  ["packages/action-runtime/", "MPL-2.0"],
  ["packages/agent-profile/", "Apache-2.0"],
  ["packages/agent-integrations/", "Apache-2.0"],
  ["packages/computer-use-contract/", "Apache-2.0"],
  ["packages/host-actions/", "MPL-2.0"],
  ["packages/office-core/", "MPL-2.0"],
  ["packages/plugin-actions/", "Apache-2.0"],
  ["packages/protocol/", "Apache-2.0"],
  ["packages/useful-cli/", "Apache-2.0"],
  ["packages/useful-mcp/", "Apache-2.0"],
  ["packages/useful-runtime/", "Apache-2.0"],
  ["packages/useful-sdk/", "Apache-2.0"],
  ["repositories/", "Apache-2.0"],
  ["scripts/", "Apache-2.0"],
  ["services/internal/", "AGPL-3.0-or-later"],
  ["services/migrations/", "AGPL-3.0-or-later"],
  ["services/source-server/", "AGPL-3.0-or-later"],
  ["services/source-worker/", "AGPL-3.0-or-later"],
  ["templates/", "Apache-2.0"],
].map((entry) => Object.freeze(entry)));

const EXPECTED_NPM_LICENSES = new Map([
  ["package.json", "SEE LICENSE IN LICENSES.md"],
  ["apps/useful/package.json", "MPL-2.0"],
  ["examples/base64-tool/package.json", "Apache-2.0"],
  ["examples/file-hash-tool/package.json", "Apache-2.0"],
  ["examples/json-diff-pro-tool/package.json", "Apache-2.0"],
  ["examples/qr-code-tool/package.json", "Apache-2.0"],
  ["packages/action-contract/package.json", "Apache-2.0"],
  ["packages/action-runtime/package.json", "MPL-2.0"],
  ["packages/agent-profile/package.json", "Apache-2.0"],
  ["packages/agent-integrations/package.json", "Apache-2.0"],
  ["packages/computer-use-contract/package.json", "Apache-2.0"],
  ["packages/host-actions/package.json", "MPL-2.0"],
  ["packages/office-core/package.json", "MPL-2.0"],
  ["packages/plugin-actions/package.json", "Apache-2.0"],
  ["packages/protocol/package.json", "Apache-2.0"],
  ["packages/useful-cli/package.json", "Apache-2.0"],
  ["packages/useful-mcp/package.json", "Apache-2.0"],
  ["packages/useful-runtime/package.json", "Apache-2.0"],
  ["packages/useful-sdk/package.json", "Apache-2.0"],
]);

const EXPECTED_CARGO_LICENSES = new Map([
  ["Cargo.toml", { license: "MPL-2.0", workspace: false }],
  ["apps/useful/src-tauri/Cargo.toml", { license: null, workspace: true }],
  ["crates/useful-bootstrap/Cargo.toml", { license: "MPL-2.0", workspace: false }],
  ["crates/useful-core/Cargo.toml", { license: null, workspace: true }],
  ["crates/useful-media/Cargo.toml", { license: null, workspace: true }],
  ["crates/useful-plugin/Cargo.toml", { license: null, workspace: true }],
  ["crates/useful-procmon/Cargo.toml", { license: null, workspace: true }],
  ["crates/useful-repository-client/Cargo.toml", { license: null, workspace: true }],
  ["crates/useful-shortcuts/Cargo.toml", { license: null, workspace: true }],
  ["crates/useful-source-accounts/Cargo.toml", { license: null, workspace: true }],
]);

const REQUIRED_LICENSE_MAP_SNIPPETS = Object.freeze([
  "`apps/useful`",
  "`crates/useful-*`",
  "`services/source-server`",
  "`services/source-worker`",
  "`services/internal`",
  "`services/migrations`",
  "`services/Dockerfile`",
  "`services/OPERATIONS.md`",
  "`services/go.mod`",
  "`services/go.sum`",
  "`apps/source-admin`",
  "`deploy/*`",
  "`packages/action-contract`",
  "`packages/action-runtime`",
  "`packages/agent-profile`",
  "`packages/agent-integrations`",
  "`packages/computer-use-contract`",
  "`packages/host-actions`",
  "`packages/office-core`",
  "`packages/plugin-actions`",
  "`packages/protocol`",
  "`packages/useful-sdk`",
  "`packages/useful-cli`",
  "`packages/useful-mcp`",
  "`packages/useful-runtime`",
  "`repositories/*`",
  "`examples/*`",
  "`docs/*`",
  "`.github/*`",
  "`scripts/*`",
]);

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

async function exists(absolute) {
  try {
    await access(absolute);
    return true;
  } catch {
    return false;
  }
}

function runGit(repoRoot, args) {
  const result = spawnSync("git", ["-c", `safe.directory=${repoRoot}`, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const error = new Error(result.stderr?.trim() || `git ${args.join(" ")} failed`);
    error.code = "GIT_FAILED";
    error.exitCode = 4;
    throw error;
  }
  return result.stdout;
}

function runNode(repoRoot, scriptRelative, extraArgs = []) {
  const script = path.join(repoRoot, scriptRelative);
  const result = spawnSync(process.execPath, [script, ...extraArgs], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function parseCargoLicenseMetadata(raw, { workspaceManifest = false } = {}) {
  const targetSection = workspaceManifest ? "workspace.package" : "package";
  let section = "";
  let license = null;
  let workspace = false;
  let sawLicense = false;
  let sawWorkspace = false;

  for (const sourceLine of String(raw).split(/\r?\n/)) {
    const header = /^\s*\[\s*([^\]]+?)\s*\]\s*(?:#.*)?$/.exec(sourceLine);
    if (header) {
      section = header[1].replace(/\s+/g, "");
      continue;
    }
    if (section !== targetSection) continue;

    const explicit = /^\s*license\s*=\s*"([^"\\]*)"\s*(?:#.*)?$/.exec(sourceLine);
    if (explicit) {
      if (sawLicense) throw new Error(`duplicate license key in [${targetSection}]`);
      sawLicense = true;
      license = explicit[1];
      continue;
    }
    const inherited = /^\s*license\s*\.\s*workspace\s*=\s*(true|false)\s*(?:#.*)?$/.exec(sourceLine);
    if (inherited) {
      if (sawWorkspace) throw new Error(`duplicate license.workspace key in [${targetSection}]`);
      sawWorkspace = true;
      workspace = inherited[1] === "true";
    }
  }

  return { license, workspace };
}

export function isCanonicalGitOrigin(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (/^git@github\.com:RedeatI\/useful(?:\.git)?\/?$/.test(value)) return true;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  const https = parsed.protocol === "https:" && parsed.username === "";
  const ssh = parsed.protocol === "ssh:" && parsed.username === "git";
  if (
    (!https && !ssh)
    || parsed.password !== ""
    || parsed.hostname.toLowerCase() !== "github.com"
    || parsed.port !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
  ) {
    return false;
  }
  const pathname = parsed.pathname.replace(/\/$/, "").replace(/\.git$/, "");
  return pathname === "/RedeatI/useful";
}

function gate(id, ok, severity, summary, details = undefined) {
  return {
    id,
    ok,
    severity,
    summary,
    ...(details === undefined ? {} : { details }),
  };
}

export function resolveApprovedLicenseForPath(relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0 || relativePath.includes("\0")) {
    return undefined;
  }
  const normalized = relativePath.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    return undefined;
  }
  if (Object.hasOwn(APPROVED_EXACT_PATH_LICENSES, normalized)) {
    return APPROVED_EXACT_PATH_LICENSES[normalized];
  }
  for (const [prefix, spdx] of APPROVED_LICENSE_PATH_PREFIXES) {
    if (normalized.startsWith(prefix)) return spdx;
  }
  return undefined;
}

export function evaluateLicensePathCoverage(paths) {
  const unmappedTrackedPaths = [...new Set(paths)]
    .filter((relative) => resolveApprovedLicenseForPath(relative) === undefined)
    .sort((left, right) => {
      if (left === right) return 0;
      return left < right ? -1 : 1;
    });
  return { ok: unmappedTrackedPaths.length === 0, unmappedTrackedPaths };
}

async function collectPackageLicenseMetadata(repoRoot) {
  const npm = [];
  const cargo = [];
  const tracked = runGit(repoRoot, ["ls-files", "-z"])
    .split("\0")
    .filter(Boolean);
  const candidates = new Set(tracked);
  for (const relative of [...EXPECTED_NPM_LICENSES.keys(), ...EXPECTED_CARGO_LICENSES.keys()]) {
    if (await exists(path.join(repoRoot, ...relative.split("/")))) candidates.add(relative);
  }
  for (const relative of candidates) {
    const filename = path.posix.basename(relative);
    if (filename === "package.json") {
      const raw = JSON.parse(await readFile(path.join(repoRoot, ...relative.split("/")), "utf8"));
      npm.push({ path: relative, license: raw.license ?? null });
    }
    if (filename === "Cargo.toml") {
      const raw = await readFile(path.join(repoRoot, ...relative.split("/")), "utf8");
      const parsed = parseCargoLicenseMetadata(raw, { workspaceManifest: relative === "Cargo.toml" });
      cargo.push({ path: relative, ...parsed });
    }
  }
  return { npm, cargo };
}

export function evaluatePackageLicenseMetadata(metadata) {
  const npmUnexpected = metadata.npm
    .map((item) => ({ ...item, expected: EXPECTED_NPM_LICENSES.get(item.path) ?? null }))
    .filter((item) => item.expected === null || item.license !== item.expected);
  for (const [relative, expected] of EXPECTED_NPM_LICENSES) {
    if (!metadata.npm.some((item) => item.path === relative)) {
      npmUnexpected.push({ path: relative, license: null, expected, missing: true });
    }
  }

  const cargoUnexpected = metadata.cargo
    .map((item) => ({ ...item, expected: EXPECTED_CARGO_LICENSES.get(item.path) ?? null }))
    .filter((item) => (
      item.expected === null
      || item.license !== item.expected.license
      || item.workspace !== item.expected.workspace
    ));
  for (const [relative, expected] of EXPECTED_CARGO_LICENSES) {
    if (!metadata.cargo.some((item) => item.path === relative)) {
      cargoUnexpected.push({ path: relative, license: null, workspace: false, expected, missing: true });
    }
  }

  return { npmUnexpected, cargoUnexpected };
}

export async function inspectPinnedLicenseFiles(repoRoot) {
  const files = [];
  for (const [relative, expectedSha256] of Object.entries(PINNED_LICENSE_FILE_SHA256)) {
    let actualSha256 = null;
    try {
      const bytes = await readFile(path.join(repoRoot, ...relative.split("/")));
      actualSha256 = digestLegalTextBytes(bytes);
    } catch {
      actualSha256 = null;
    }
    files.push({ path: relative, expectedSha256, actualSha256, ok: actualSha256 === expectedSha256 });
  }
  return { ok: files.every((item) => item.ok), files };
}

export async function evaluateReleaseReadiness(options) {
  const repoRoot = path.resolve(options.repoRoot);
  const gates = [];

  const licensePath = path.join(repoRoot, "LICENSE");
  const licensePresent = await exists(licensePath);
  const pinnedLicenses = await inspectPinnedLicenseFiles(repoRoot);
  const rootLicenseEvidence = pinnedLicenses.files.find((item) => item.path === "LICENSE");
  const rootLicensePinnedOk = licensePresent && rootLicenseEvidence?.ok === true;
  gates.push(
    gate(
      "root-license",
      rootLicensePinnedOk,
      "hard",
      rootLicensePinnedOk
        ? "Root LICENSE matches the repository-pinned digest"
        : "Root LICENSE is missing or differs from the repository-pinned digest",
      { expectedSha256: rootLicenseEvidence?.expectedSha256 ?? null, actualSha256: rootLicenseEvidence?.actualSha256 ?? null },
    ),
  );

  const requiredPresence = [];
  for (const relative of REQUIRED_PUBLIC_FILES) {
    const present = await exists(path.join(repoRoot, relative));
    requiredPresence.push({ path: relative, present });
  }
  const missingRequired = requiredPresence.filter((item) => !item.present).map((item) => item.path);
  gates.push(
    gate(
      "required-public-files-worktree",
      missingRequired.length === 0,
      "hard",
      missingRequired.length === 0
        ? "All required public files exist in the worktree"
        : "Required public files are missing from the worktree",
      { missing: missingRequired, checked: requiredPresence },
    ),
  );

  let head = null;
  let headTree = null;
  let branch = null;
  let remotes = [];
  let canonicalRemote = null;
  let canonicalRemoteOk = false;
  let trackedRequired = [];
  let dirty = null;
  try {
    head = runGit(repoRoot, ["rev-parse", "HEAD"]).trim();
    headTree = runGit(repoRoot, ["rev-parse", `${head}^{tree}`]).trim();
    branch = runGit(repoRoot, ["branch", "--show-current"]).trim() || null;
    remotes = runGit(repoRoot, ["remote"])
      .split(/\r?\n/)
      .filter(Boolean);
    try {
      canonicalRemote = runGit(repoRoot, ["config", "--get", "remote.origin.url"]).trim();
    } catch {
      canonicalRemote = null;
    }
    canonicalRemoteOk = isCanonicalGitOrigin(canonicalRemote);
    dirty = runGit(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]).trim().length > 0;
    const lsTree = runGit(repoRoot, ["ls-tree", "-r", "--name-only", "HEAD"]);
    const tracked = new Set(lsTree.split(/\r?\n/).filter(Boolean));
    trackedRequired = REQUIRED_PUBLIC_FILES.map((relative) => ({
      path: relative,
      tracked: tracked.has(relative),
    }));
    const untrackedRequired = trackedRequired.filter((item) => !item.tracked).map((item) => item.path);
    gates.push(
      gate(
        "required-public-files-head",
        untrackedRequired.length === 0,
        "hard",
        untrackedRequired.length === 0
          ? "All required public files are tracked at HEAD"
          : "Required public files are not all tracked at HEAD",
        { missingFromHead: untrackedRequired, checked: trackedRequired },
      ),
    );
    gates.push(
      gate(
        "worktree-clean-for-public-prepare",
        dirty === false,
        "hard",
        dirty ? "Worktree is dirty; prepare-public-source requires a clean HEAD" : "Worktree is clean",
      ),
    );
    gates.push(
      gate(
        "canonical-git-remote",
        canonicalRemoteOk,
        "hard",
        canonicalRemoteOk
          ? "Canonical GitHub origin is configured"
          : "Canonical GitHub origin is missing or does not match the approved repository",
        { originMatchesCanonical: canonicalRemoteOk, remoteNames: remotes },
      ),
    );
  } catch (error) {
    gates.push(
      gate("git-inspection", false, "hard", "Git inspection failed", {
        code: error.code ?? "GIT_FAILED",
        message: error.message,
      }),
    );
  }

  if (head && headTree) {
    try {
      const projection = await inspectGitRepository({
        repoRoot,
        purpose: "build",
        expectedCommit: head,
        expectedTree: headTree,
      });
      gates.push(
        gate(
          "public-source-preparation-policy",
          projection.ok,
          "hard",
          projection.ok
            ? "Fixed Git objects and current worktree boundaries satisfy public-source preparation policy"
            : "Fixed Git objects or current worktree boundaries fail public-source preparation policy",
          {
            objectContentPinned: true,
            worktreeBoundaryChecked: true,
            sourceCommit: projection.commit,
            sourceTree: projection.tree,
            includedCount: projection.included.length,
            excludedCount: projection.excluded.length,
            violationCount: projection.violations.length,
            manifestSha256: projection.manifestSha256,
          },
        ),
      );
    } catch (error) {
      gates.push(
        gate("public-source-preparation-policy", false, "hard", "Public-source preparation policy inspection failed", {
          code: error.code ?? "SOURCE_POLICY_FAILED",
        }),
      );
    }
  }

  const activeDependabot = await exists(path.join(repoRoot, ".github", "dependabot.yml"));
  const exampleDependabot = await exists(path.join(repoRoot, ".github", "dependabot.yml.example"));
  gates.push(
    gate(
      "dependabot-inactive",
      !activeDependabot && exampleDependabot,
      "hard",
      !activeDependabot && exampleDependabot
        ? "Active Dependabot is absent and example template is present"
        : "Dependabot activation boundary is not fail-closed",
      { activePresent: activeDependabot, examplePresent: exampleDependabot },
    ),
  );

  const workflow = runNode(repoRoot, "scripts/check-workflows.mjs", ["--json"]);
  let workflowJson = null;
  try {
    workflowJson = JSON.parse(workflow.stdout);
  } catch {
    workflowJson = null;
  }
  gates.push(
    gate(
      "workflows-manual-only",
      workflow.status === 0 && workflowJson?.ok === true,
      "hard",
      workflow.status === 0 && workflowJson?.ok === true
        ? "Workflow static check passed with first-public manual-only policy"
        : "Workflow static check failed",
      {
        status: workflow.status,
        result: workflowJson,
        stderrBytes: Buffer.byteLength(workflow.stderr),
      },
    ),
  );

  const brand = runNode(repoRoot, "scripts/check-brand.mjs", ["--json"]);
  let brandJson = null;
  try {
    brandJson = JSON.parse(brand.stdout);
  } catch {
    brandJson = null;
  }
  gates.push(
    gate(
      "legacy-brand-zero",
      brand.status === 0 && brandJson?.ok === true,
      "hard",
      brand.status === 0 && brandJson?.ok === true
        ? "Tracked paths and files use only the Useful identity"
        : "Legacy product identity remains in tracked paths or files",
      {
        status: brand.status,
        result: brandJson,
        stderrBytes: Buffer.byteLength(brand.stderr),
      },
    ),
  );

  const version = runNode(repoRoot, "scripts/check-version-drift.mjs", ["--json"]);
  let versionJson = null;
  try {
    versionJson = JSON.parse(version.stdout);
  } catch {
    versionJson = null;
  }
  gates.push(
    gate(
      "version-drift",
      version.status === 0 && versionJson?.ok === true,
      "hard",
      version.status === 0 && versionJson?.ok === true
        ? `Version drift check passed for ${versionJson.version}`
        : "Version drift check failed",
      { status: version.status, result: versionJson },
    ),
  );

  const metadata = await collectPackageLicenseMetadata(repoRoot);
  const { npmUnexpected, cargoUnexpected } = evaluatePackageLicenseMetadata(metadata);
  const rootPackage = metadata.npm.find((item) => item.path === "package.json");
  const rootLicenseOk = rootPackage?.license === "SEE LICENSE IN LICENSES.md";
  const cargoWorkspace = metadata.cargo.find((item) => item.path === "Cargo.toml");
  const cargoWorkspaceOk = cargoWorkspace?.license === "MPL-2.0";
  let licenseMapText = "";
  try {
    licenseMapText = await readFile(path.join(repoRoot, "LICENSES.md"), "utf8");
  } catch {
    licenseMapText = "";
  }
  const missingMapSnippets = REQUIRED_LICENSE_MAP_SNIPPETS.filter((snippet) => !licenseMapText.includes(snippet));
  const mismatchedLicenseFiles = pinnedLicenses.files.filter((item) => item.path !== "LICENSE" && !item.ok);
  const trackedPaths = runGit(repoRoot, ["ls-files", "-z"]).split("\0").filter(Boolean);
  const pathCoverage = evaluateLicensePathCoverage(trackedPaths);
  const licenseMappingComplete = PENDING_OWNER_LICENSE_MAPPINGS.length === 0 && pathCoverage.ok;
  gates.push(
    gate(
      "component-license-map-owner-approval",
      licenseMappingComplete,
      "hard",
      licenseMappingComplete
        ? "Owner-approved path-to-SPDX mapping is complete"
        : "Owner/legal review is still required for paths outside the authoritative component map",
      {
        pending: [...PENDING_OWNER_LICENSE_MAPPINGS],
        unmappedTrackedPaths: pathCoverage.unmappedTrackedPaths,
      },
    ),
  );
  const metadataOk =
    npmUnexpected.length === 0
    && rootLicenseOk
    && cargoWorkspaceOk
    && cargoUnexpected.length === 0
    && missingMapSnippets.length === 0
    && mismatchedLicenseFiles.length === 0;
  gates.push(
    gate(
      "package-license-metadata",
      metadataOk,
      "hard",
      metadataOk
        ? "Package/crate license metadata and license body files match the documented multi-license map"
        : "Package/crate license metadata or license body files still conflict with the documented multi-license map",
      {
        npmUnexpectedCount: npmUnexpected.length,
        npmUnexpected,
        rootPackageLicense: rootPackage?.license ?? null,
        cargoWorkspaceLicense: cargoWorkspace?.license ?? null,
        cargoUnexpected,
        missingMapSnippets,
        mismatchedLicenseFiles,
      },
    ),
  );

  const gh = spawnSync("gh", ["--version"], { encoding: "utf8", windowsHide: true });
  gates.push(
    gate(
      "gh-cli",
      gh.status === 0,
      "soft",
      gh.status === 0 ? "GitHub CLI is available" : "GitHub CLI is not available",
      { status: gh.status },
    ),
  );

  const hardFailed = gates.filter((item) => item.severity === "hard" && !item.ok);
  const softFailed = gates.filter((item) => item.severity === "soft" && !item.ok);
  const localPreflightPassed = hardFailed.length === 0 && softFailed.length === 0;
  return {
    schemaVersion: RELEASE_READINESS_SCHEMA,
    ok: hardFailed.length === 0,
    // This command deliberately does not inspect GitHub visibility, refs, rulesets, checks,
    // or the final sanitized root commit. It can prove only a local preflight.
    authoritative: false,
    localPreflightPassed,
    evidenceKind: "local-source-preflight",
    publicationAuthorized: false,
    remoteStateChecked: false,
    strictPublicCommitChecked: false,
    repoRoot,
    head,
    branch,
    hardFailedCount: hardFailed.length,
    softFailedCount: softFailed.length,
    gates,
    nextOwnerActions: [
      ...(rootLicensePinnedOk
        ? []
        : ["Restore or separately approve the exact root LICENSE before publication"]),
      ...(licenseMappingComplete && metadataOk
        ? []
        : ["Approve the complete path-to-SPDX map and synchronize LICENSE, LICENSES.md, NOTICE, and package metadata"]),
      ...(canonicalRemoteOk ? [] : ["Configure the canonical GitHub owner/repository origin"]),
      ...(missingRequired.length === 0 ? [] : [`Add missing worktree files: ${missingRequired.join(", ")}`]),
      "Enable and test Private Vulnerability Reporting after the public repository exists",
      "Name and test the private Code of Conduct reporting channel",
      "Authorize the sanitized public snapshot, formal checks, and only then push",
    ],
  };
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = await evaluateReleaseReadiness(options);
    if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else {
      process.stdout.write(
        `Useful release readiness: ${result.ok ? "PASS" : "BLOCKED"}; hardFailed=${result.hardFailedCount}; softFailed=${result.softFailedCount}\n`,
      );
      for (const item of result.gates) {
        process.stdout.write(`- [${item.ok ? "ok" : "FAIL"}/${item.severity}] ${item.id}: ${item.summary}\n`);
      }
    }
    process.exitCode = result.ok ? 0 : 3;
  } catch (error) {
    const code = error.code ?? "INTERNAL_ERROR";
    const exitCode = error.exitCode ?? 5;
    const payload = {
      schemaVersion: RELEASE_READINESS_SCHEMA,
      ok: false,
      authoritative: false,
      error: { code, message: error.message },
    };
    if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(payload)}\n`);
    else process.stderr.write(`release-readiness failed: ${error.message}\n`);
    process.exitCode = exitCode;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
