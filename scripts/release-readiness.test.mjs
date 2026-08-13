import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  parseArguments as parseLicenseArguments,
  validateHolder,
  validateYear,
  renderRootLicense,
  generateRootLicense,
} from "./generate-root-license.mjs";
import {
  PINNED_LICENSE_FILE_SHA256,
  PENDING_OWNER_LICENSE_MAPPINGS,
  evaluateLicensePathCoverage,
  evaluatePackageLicenseMetadata,
  evaluateReleaseReadiness,
  inspectPinnedLicenseFiles,
  isCanonicalGitOrigin,
  parseCargoLicenseMetadata,
  parseArguments as parseReadinessArguments,
  resolveApprovedLicenseForPath,
} from "./release-readiness.mjs";
import {
  EXPECTED_BUNDLE_IDENTIFIER,
  evaluateVersionDrift,
} from "./check-version-drift.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const versionDriftChecker = path.join(repoRoot, "scripts", "check-version-drift.mjs");
const versionDriftFixturePaths = Object.freeze([
  "package.json",
  "apps/useful/package.json",
  "packages/useful-cli/package.json",
  "packages/useful-sdk/package.json",
  "apps/useful/src-tauri/tauri.conf.json",
  "apps/useful/src-tauri/tauri.windows.conf.json",
  "apps/useful/src-tauri/tauri.macos.conf.json",
  "apps/useful/src-tauri/tauri.linux.conf.json",
  "Cargo.toml",
  "Cargo.lock",
  "README.md",
  "README.zh-CN.md",
]);

async function makeVersionDriftFixture() {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "useful-version-drift-"));
  for (const relative of versionDriftFixturePaths) {
    const destination = path.join(fixture, ...relative.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(repoRoot, ...relative.split("/")), destination);
  }
  return fixture;
}

async function updateJson(relative, fixture, update) {
  const target = path.join(fixture, ...relative.split("/"));
  const parsed = JSON.parse(await readFile(target, "utf8"));
  update(parsed);
  await writeFile(target, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

test("license generator rejects generic holders and year typos", () => {
  assert.throws(() => validateHolder("Useful Project and contributors"), /legal subject/);
  assert.throws(() => validateHolder("TODO"), /legal subject/);
  assert.throws(() => validateYear("202"), /YYYY/);
  assert.equal(validateYear("2024-2026"), "2024-2026");
  assert.equal(validateHolder("Example Legal Entity Ltd."), "Example Legal Entity Ltd.");
});

test("license generator requires explicit mapping approval and never overwrites", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "useful-license-"));
  try {
    const approvalPath = path.join(temp, "approval.json");
    await writeFile(
      approvalPath,
      `${JSON.stringify(
        {
          schemaVersion: "useful.license-mapping-approval.v1",
          approved: true,
          legalReviewer: "Counsel Name",
          reviewedOn: "2026-08-06",
          mapping: {
            desktopRust: "MPL-2.0",
            backend: "AGPL-3.0-or-later",
            protocolSdkCliExamples: "Apache-2.0",
            docs: "CC-BY-4.0",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const result = await generateRootLicense({
      repoRoot: temp,
      holder: "Example Legal Entity Ltd.",
      year: "2026",
      mappingApprovalPath: approvalPath,
      outputRelative: "LICENSE",
    });
    assert.equal(result.ok, true);
    const body = await readFile(path.join(temp, "LICENSE"), "utf8");
    assert.match(body, /Example Legal Entity Ltd\./);
    assert.match(body, /MPL-2\.0/);
    await assert.rejects(
      () =>
        generateRootLicense({
          repoRoot: temp,
          holder: "Example Legal Entity Ltd.",
          year: "2026",
          mappingApprovalPath: approvalPath,
          outputRelative: "LICENSE",
        }),
      /already exists/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("license CLI parse requires holder year and mapping approval", () => {
  assert.throws(() => parseLicenseArguments(["--holder", "A"]), /missing --year/);
  const parsed = parseLicenseArguments([
    "--holder",
    "Example Legal Entity Ltd.",
    "--year",
    "2026",
    "--mapping-approval",
    "approval.json",
    "--json",
  ]);
  assert.equal(parsed.json, true);
  assert.equal(parsed.holder, "Example Legal Entity Ltd.");
});

test("release readiness reports stable evidence boundaries without mutating the tree", async () => {
  parseReadinessArguments(["--json"]);
  const before = await readFile(path.join(repoRoot, "LICENSE"), "utf8");
  const result = await evaluateReleaseReadiness({ repoRoot });
  const after = await readFile(path.join(repoRoot, "LICENSE"), "utf8");
  assert.equal(before, after);
  assert.equal(result.schemaVersion, "useful.release-readiness.v1");
  const byId = Object.fromEntries(result.gates.map((gate) => [gate.id, gate]));

  // A fork, dirty contributor worktree, or missing local gh binary may legitimately block a gate.
  // This test checks evidence semantics, not the mutable state of the checkout running the test.
  assert.equal(byId["root-license"].severity, "hard");
  assert.equal(byId["required-public-files-worktree"].severity, "hard");
  assert.equal(byId["required-public-files-head"].severity, "hard");
  assert.equal(byId["canonical-git-remote"].severity, "hard");
  assert.equal(byId["public-source-preparation-policy"].severity, "hard");
  assert.equal(byId["public-source-preparation-policy"].details.objectContentPinned, true);
  assert.equal(byId["public-source-preparation-policy"].details.worktreeBoundaryChecked, true);
  assert.equal(byId["package-license-metadata"].severity, "hard");
  assert.equal(byId["component-license-map-owner-approval"].severity, "hard");
  assert.equal(byId["component-license-map-owner-approval"].ok, true);
  assert.deepEqual(byId["component-license-map-owner-approval"].details.pending, PENDING_OWNER_LICENSE_MAPPINGS);
  assert.deepEqual(byId["component-license-map-owner-approval"].details.unmappedTrackedPaths, []);
  assert.deepEqual(PENDING_OWNER_LICENSE_MAPPINGS, []);
  assert.equal(byId["gh-cli"].severity, "soft");
  const versionResult = byId["version-drift"].details.result;
  assert.equal(versionResult.checked, 15);
  const identifierGate = versionResult.bundleIdentifier;
  assert.equal(identifierGate.expected, "io.github.redeati.useful");
  assert.equal(identifierGate.ok, true);
  assert.deepEqual(identifierGate.base, {
    path: "apps/useful/src-tauri/tauri.conf.json",
    identifier: "io.github.redeati.useful",
    matchesExpected: true,
    endsWithAppSuffix: false,
  });
  assert.deepEqual(
    identifierGate.platformOverrides.map((entry) => entry.path),
    [
      "apps/useful/src-tauri/tauri.windows.conf.json",
      "apps/useful/src-tauri/tauri.macos.conf.json",
      "apps/useful/src-tauri/tauri.linux.conf.json",
    ],
  );
  assert.equal(identifierGate.platformOverrides.every((entry) => entry.declaresIdentifier === false), true);
  assert.deepEqual(identifierGate.failures, []);
  assert.equal(versionResult.readmeRelease.ok, true);
  assert.deepEqual(
    versionResult.readmeRelease.files.map((entry) => entry.path),
    ["README.md", "README.zh-CN.md"],
  );
  assert.equal(result.evidenceKind, "local-source-preflight");
  assert.equal(result.publicationAuthorized, false);
  assert.equal(result.remoteStateChecked, false);
  assert.equal(result.strictPublicCommitChecked, false);
  assert.equal(result.authoritative, false);
  assert.equal(typeof result.localPreflightPassed, "boolean");

  assert.equal(result.ok, result.hardFailedCount === 0);
});

test("bundle identifier policy fails closed for an invalid base or any platform override", async () => {
  const cases = [
    {
      name: "wrong base identifier",
      relative: "apps/useful/src-tauri/tauri.conf.json",
      update: (config) => { config.identifier = "com.example.wrong"; },
      failureCode: "bundle-identifier-mismatch",
    },
    {
      name: "base identifier with app suffix",
      relative: "apps/useful/src-tauri/tauri.conf.json",
      update: (config) => { config.identifier = `${EXPECTED_BUNDLE_IDENTIFIER}.app`; },
      failureCode: "bundle-identifier-app-suffix",
    },
    ...[
      "apps/useful/src-tauri/tauri.windows.conf.json",
      "apps/useful/src-tauri/tauri.macos.conf.json",
      "apps/useful/src-tauri/tauri.linux.conf.json",
    ].map((relative) => ({
      name: `${relative} explicit identifier`,
      relative,
      update: (config) => { config.identifier = EXPECTED_BUNDLE_IDENTIFIER; },
      failureCode: "bundle-identifier-platform-override",
    })),
  ];

  for (const scenario of cases) {
    const fixture = await makeVersionDriftFixture();
    try {
      await updateJson(scenario.relative, fixture, scenario.update);
      const evaluated = await evaluateVersionDrift({ repoRoot: fixture });
      assert.equal(evaluated.ok, false, scenario.name);
      assert.equal(evaluated.checked, 15, scenario.name);
      assert.equal(evaluated.mismatches.length, 0, scenario.name);
      assert.equal(
        evaluated.bundleIdentifier.failures.some((failure) => failure.code === scenario.failureCode),
        true,
        scenario.name,
      );

      const child = spawnSync(
        process.execPath,
        [versionDriftChecker, "--repo-root", fixture, "--json"],
        { cwd: repoRoot, encoding: "utf8", windowsHide: true },
      );
      assert.equal(child.status, 1, `${scenario.name}: ${child.stderr}`);
      assert.equal(child.stderr, "", scenario.name);
      const payload = JSON.parse(child.stdout);
      assert.equal(payload.ok, false, scenario.name);
      assert.equal(payload.checked, 15, scenario.name);
      assert.equal(payload.mismatches.length, 0, scenario.name);
      assert.equal(
        payload.bundleIdentifier.failures.some((failure) => failure.code === scenario.failureCode),
        true,
        scenario.name,
      );
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  }
});

test("bilingual README release tags, portable assets, bundles, and checksums are version-bound", async () => {
  const scenarios = [
    ["README.md", "releases/tag/v0.1.0-beta.7", "releases/tag/v0.1.0-beta.6"],
    ["README.zh-CN.md", "Useful-0.1.0-beta.7-windows-x64-portable-lite.zip", "Useful-0.1.0-beta.6-windows-x64-portable-lite.zip"],
    ["README.md", "Useful-0.1.0-beta.7-windows-x64-setup-lite.exe", "Useful-0.1.0-beta.6-windows-x64-setup-lite.exe"],
  ];
  for (const [relative, from, to] of scenarios) {
    const fixture = await makeVersionDriftFixture();
    try {
      const target = path.join(fixture, ...relative.split("/"));
      const raw = await readFile(target, "utf8");
      assert.match(raw, new RegExp(from.replaceAll(".", "\\.")), `${relative} fixture marker`);
      await writeFile(target, raw.replaceAll(from, to), "utf8");
      const evaluated = await evaluateVersionDrift({ repoRoot: fixture });
      assert.equal(evaluated.ok, false, relative);
      assert.equal(evaluated.mismatches.length, 0, relative);
      assert.equal(
        evaluated.readmeRelease.failures.some((failure) => failure.path === relative),
        true,
        relative,
      );
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  }
});

test("canonical origin matching is exact and fork-safe", () => {
  assert.equal(isCanonicalGitOrigin("https://github.com/RedeatI/useful.git"), true);
  assert.equal(isCanonicalGitOrigin("https://github.com/RedeatI/useful"), true);
  assert.equal(isCanonicalGitOrigin("git@github.com:RedeatI/useful.git"), true);
  assert.equal(isCanonicalGitOrigin("ssh://git@github.com/RedeatI/useful.git"), true);
  assert.equal(isCanonicalGitOrigin("https://github.com/example/useful.git"), false);
  assert.equal(isCanonicalGitOrigin("https://github.com/RedeatI/useful-fork.git"), false);
  assert.equal(isCanonicalGitOrigin("https://user@github.com/RedeatI/useful.git"), false);
  assert.equal(isCanonicalGitOrigin("https://github.com/RedeatI/useful.git?ref=main"), false);
});

test("license metadata rejects unapproved package paths even when they claim an allowed SPDX value", () => {
  const result = evaluatePackageLicenseMetadata({
    npm: [{ path: "packages/unmapped/package.json", license: "Apache-2.0" }],
    cargo: [{ path: "crates/unmapped/Cargo.toml", license: null, workspace: true }],
  });
  assert.equal(result.npmUnexpected.some((item) => item.path === "packages/unmapped/package.json"), true);
  assert.equal(result.cargoUnexpected.some((item) => item.path === "crates/unmapped/Cargo.toml"), true);
});

test("Agent integration contract packages are explicitly Apache-2.0 mapped and metadata-gated", () => {
  assert.equal(resolveApprovedLicenseForPath("packages/agent-integrations/src/integration.mjs"), "Apache-2.0");
  assert.equal(resolveApprovedLicenseForPath("packages/computer-use-contract/src/index.mjs"), "Apache-2.0");
  assert.equal(resolveApprovedLicenseForPath("packages/computer-use-browser-adapter/src/index.mjs"), "Apache-2.0");
  assert.equal(resolveApprovedLicenseForPath("services/OPERATIONS.md"), "AGPL-3.0-or-later");
  const result = evaluatePackageLicenseMetadata({
    npm: [
      { path: "packages/agent-integrations/package.json", license: "Apache-2.0" },
      { path: "packages/computer-use-contract/package.json", license: "Apache-2.0" },
      { path: "packages/computer-use-browser-adapter/package.json", license: "Apache-2.0" },
    ],
    cargo: [],
  });
  assert.equal(result.npmUnexpected.some((item) => item.path === "packages/agent-integrations/package.json"), false);
  assert.equal(result.npmUnexpected.some((item) => item.path === "packages/computer-use-contract/package.json"), false);
  assert.equal(result.npmUnexpected.some((item) => item.path === "packages/computer-use-browser-adapter/package.json"), false);
});

test("Cargo license parsing is section-bound and ignores metadata decoys", () => {
  assert.deepEqual(
    parseCargoLicenseMetadata(`
[package]
name = "example"

[package.metadata.audit]
license = "MPL-2.0"
license.workspace = true
`),
    { license: null, workspace: false },
  );
  assert.deepEqual(
    parseCargoLicenseMetadata(`
[package]
name = "example"
license.workspace = true

[package.metadata.audit]
license = "Apache-2.0"
`),
    { license: null, workspace: true },
  );
  assert.deepEqual(
    parseCargoLicenseMetadata(`
[workspace.package]
license = "MPL-2.0"

[package]
license = "Apache-2.0"
`, { workspaceManifest: true }),
    { license: "MPL-2.0", workspace: false },
  );
});

test("license bodies and component notices are pinned by exact digest", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "useful-license-digests-"));
  try {
    for (const relative of Object.keys(PINNED_LICENSE_FILE_SHA256)) {
      const destination = path.join(temp, ...relative.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(path.join(repoRoot, ...relative.split("/")), destination);
    }
    assert.equal((await inspectPinnedLicenseFiles(temp)).ok, true);
    await writeFile(path.join(temp, "licenses", "Apache-2.0.txt"), "altered\n", "utf8");
    const altered = await inspectPinnedLicenseFiles(temp);
    assert.equal(altered.ok, false);
    assert.equal(altered.files.find((item) => item.path === "licenses/Apache-2.0.txt").ok, false);

    await copyFile(path.join(repoRoot, "licenses", "Apache-2.0.txt"), path.join(temp, "licenses", "Apache-2.0.txt"));
    const licenseMap = path.join(temp, "LICENSES.md");
    const originalMap = await readFile(licenseMap, "utf8");
    await writeFile(licenseMap, originalMap.replace("Apache-2.0", "MPL-2.0"), "utf8");
    const remapped = await inspectPinnedLicenseFiles(temp);
    assert.equal(remapped.ok, false);
    assert.equal(remapped.files.find((item) => item.path === "LICENSES.md").ok, false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("release readiness CLI emits one JSON document and exit code matching hard-gate outcome", () => {
  const child = spawnSync(process.execPath, ["scripts/release-readiness.mjs", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  const payload = JSON.parse(child.stdout);
  assert.equal(payload.schemaVersion, "useful.release-readiness.v1");
  assert.equal(payload.ok, payload.hardFailedCount === 0);
  assert.equal(child.status, payload.ok ? 0 : 3);
});

test("renderRootLicense stays deterministic for the same inputs", () => {
  const left = renderRootLicense({
    holder: "Example Legal Entity Ltd.",
    year: "2026",
    mapping: {
      desktopRust: "MPL-2.0",
      backend: "AGPL-3.0-or-later",
      protocolSdkCliExamples: "Apache-2.0",
      docs: "CC-BY-4.0",
    },
  });
  const right = renderRootLicense({
    holder: "Example Legal Entity Ltd.",
    year: "2026",
    mapping: {
      desktopRust: "MPL-2.0",
      backend: "AGPL-3.0-or-later",
      protocolSdkCliExamples: "Apache-2.0",
      docs: "CC-BY-4.0",
    },
  });
  assert.equal(left, right);
});

test("owner-approved path map is closed and assigns the intended SPDX families", () => {
  assert.equal(resolveApprovedLicenseForPath("packages/action-runtime/src/index.mjs"), "MPL-2.0");
  assert.equal(resolveApprovedLicenseForPath("packages/host-actions/src/index.mjs"), "MPL-2.0");
  assert.equal(resolveApprovedLicenseForPath("packages/office-core/src/index.mjs"), "MPL-2.0");
  assert.equal(resolveApprovedLicenseForPath("packages/action-contract/src/index.mjs"), "Apache-2.0");
  assert.equal(resolveApprovedLicenseForPath("packages/agent-integrations/src/integration.mjs"), "Apache-2.0");
  assert.equal(resolveApprovedLicenseForPath("packages/computer-use-contract/src/index.mjs"), "Apache-2.0");
  assert.equal(resolveApprovedLicenseForPath("packages/computer-use-browser-adapter/src/index.mjs"), "Apache-2.0");
  assert.equal(resolveApprovedLicenseForPath("packages/useful-mcp/src/server.mjs"), "Apache-2.0");
  assert.equal(resolveApprovedLicenseForPath("services/internal/app/app.go"), "AGPL-3.0-or-later");
  assert.equal(resolveApprovedLicenseForPath("apps/source-admin/app.js"), "AGPL-3.0-or-later");
  assert.equal(resolveApprovedLicenseForPath("deploy/docker-compose/docker-compose.yml"), "AGPL-3.0-or-later");
  assert.equal(resolveApprovedLicenseForPath("docs/AI-INTEGRATION.md"), "CC-BY-4.0");
  assert.equal(resolveApprovedLicenseForPath("LICENSE"), null);
  assert.equal(resolveApprovedLicenseForPath("packages/new-package/package.json"), undefined);
  assert.deepEqual(evaluateLicensePathCoverage([
    "README.md",
    "packages/action-runtime/src/index.mjs",
    "packages/new-package/package.json",
  ]), {
    ok: false,
    unmappedTrackedPaths: ["packages/new-package/package.json"],
  });
});

test("tracked root LICENSE matches the approved generator mapping", async () => {
  const rendered = renderRootLicense({
    holder: "RedeatI",
    year: "2026",
    mapping: {
      desktopRust: "MPL-2.0",
      backend: "AGPL-3.0-or-later",
      protocolSdkCliExamples: "Apache-2.0",
      docs: "CC-BY-4.0",
    },
  });
  assert.equal((await readFile(path.join(repoRoot, "LICENSE"), "utf8")).replaceAll("\r\n", "\n"), rendered);
});
