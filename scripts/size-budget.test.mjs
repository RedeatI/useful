import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  AGENT_PROFILE_SOURCE,
  createFrontendSizeReport,
  MAX_SIZE_BYTES,
} from "./frontend-size-report.mjs";
import { checkSizeBudget } from "./size-budget.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFile(path.join(root, relative), "utf8");
const TEST_COMMIT = "a".repeat(40);
const NODE_MODULE_MANIFEST_KEY = "../../node_modules/.pnpm/@tauri-apps+plugin-dialog@2.2.0/node_modules/@tauri-apps/plugin-dialog/dist-js/index.js";
const PACKAGE_VERSION = JSON.parse(await read("package.json")).version;

const HARD_LIMIT_KEYS = [
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

async function createFrontendFixture(t, {
  fileHashWorkerCount = 1,
  regexWorkerCount = 1,
  officeWorkerCount = 1,
  extraFiles = [],
} = {}) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "useful-size-fixture-"));
  t.after(async () => rm(repoRoot, { force: true, recursive: true }));
  const dist = path.join(repoRoot, "apps", "useful", "dist");
  const assets = path.join(dist, "assets");
  const vite = path.join(dist, ".vite");
  await mkdir(assets, { recursive: true });
  await mkdir(vite);
  await mkdir(path.join(repoRoot, "config"), { recursive: true });
  await copyFile(path.join(root, "config", "size-budgets.json"), path.join(repoRoot, "config", "size-budgets.json"));
  await copyFile(path.join(root, "package.json"), path.join(repoRoot, "package.json"));

  const files = new Map([
    ["index.html", "<script type=module src=/assets/main-12345678.js></script>\n"],
    ["assets/main-12345678.js", "import './shared-12345678.js';\n"],
    ["assets/shared-12345678.js", "export const shared = true;\n"],
    ["assets/dialog-12345678.js", "export const open = true;\n"],
    ["assets/AgentProfilePanel-12345678.js", "export const agent = true;\n"],
  ]);
  for (const [workerName, count] of [
    ["fileHashWorker", fileHashWorkerCount],
    ["regexWorker", regexWorkerCount],
    ["officeWorker", officeWorkerCount],
  ]) {
    for (let index = 0; index < count; index += 1) {
      const suffix = index === 0 ? "12345678" : "87654321";
      files.set(`assets/${workerName}-${suffix}.js`, `self.onmessage = () => '${workerName}-${index}';\n`);
    }
  }
  for (const [relative, contents] of extraFiles) files.set(relative, contents);
  for (const [relative, contents] of files) {
    await writeFile(path.join(dist, ...relative.split("/")), contents, "utf8");
  }

  const manifest = {
    "_shared-12345678.js": {
      file: "assets/shared-12345678.js",
      name: "shared",
    },
    [NODE_MODULE_MANIFEST_KEY]: {
      file: "assets/dialog-12345678.js",
      name: "index",
      src: NODE_MODULE_MANIFEST_KEY,
    },
    "index.html": {
      file: "assets/main-12345678.js",
      name: "index",
      src: "index.html",
      isEntry: true,
      imports: ["_shared-12345678.js", NODE_MODULE_MANIFEST_KEY],
      dynamicImports: [AGENT_PROFILE_SOURCE],
    },
    [AGENT_PROFILE_SOURCE]: {
      file: "assets/AgentProfilePanel-12345678.js",
      name: "AgentProfilePanel",
      src: AGENT_PROFILE_SOURCE,
      isDynamicEntry: true,
      imports: ["_shared-12345678.js"],
    },
  };
  const manifestPath = path.join(vite, "manifest.json");
  const reportPath = path.join(repoRoot, "artifacts", "size", "size-report.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
  return { repoRoot, dist, manifestPath, reportPath };
}

async function captureFixture(fixture) {
  return createFrontendSizeReport({
    repoRoot: fixture.repoRoot,
    distDirectory: fixture.dist,
    manifestPath: fixture.manifestPath,
    reportPath: fixture.reportPath,
    commit: TEST_COMMIT,
  });
}

function profileArtifactPaths(profile) {
  if (profile === "ci") {
    return {
      usefulExe: "target/release/Useful.exe",
      bootstrapExe: "target/release/useful-bootstrap.exe",
      portableLiteZip: "dist-release/Useful-Portable-Lite-x64.zip",
    };
  }
  const desktop = {
    usefulExe: "target/x86_64-pc-windows-msvc/release/Useful.exe",
    bootstrapExe: "target/x86_64-pc-windows-msvc/release/useful-bootstrap.exe",
    portableLiteZip: `release-assets/Useful-${PACKAGE_VERSION}-windows-x64-portable-lite.zip`,
    setupLite: `release-assets/Useful-${PACKAGE_VERSION}-windows-x64-setup-lite.exe`,
    portableFullZip: `release-assets/Useful-${PACKAGE_VERSION}-windows-x64-portable-full.zip`,
  };
  if (profile === "release-lite") delete desktop.portableFullZip;
  return desktop;
}

async function writeArtifactEvidence(repoRoot, relative, contents) {
  const bytes = Buffer.from(contents);
  const fullPath = path.join(repoRoot, ...relative.split("/"));
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, bytes);
  return {
    path: relative,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function populateProfileArtifacts(fixture, report, profile) {
  const paths = profileArtifactPaths(profile);
  const contents = {};
  for (const [artifact, relative] of Object.entries(paths)) {
    const content = Buffer.from(`controlled-${profile}-${artifact}\n`);
    contents[artifact] = content;
    const evidence = await writeArtifactEvidence(fixture.repoRoot, relative, content);
    report.releaseArtifacts[artifact] = evidence;
    const metric = {
      usefulExe: "usefulExeBytes",
      bootstrapExe: "bootstrapExeBytes",
      portableLiteZip: "portableLiteZipBytes",
      setupLite: "setupLiteBytes",
      portableFullZip: "portableFullZipBytes",
    }[artifact];
    report[metric] = evidence.bytes;
  }
  return { paths, contents };
}

test("size budget config exists and declares hard limits", async () => {
  const raw = await read("config/size-budgets.json");
  const budgets = JSON.parse(raw);
  assert.equal(budgets.schemaVersion, "useful.size-budgets.v2");
  assert.equal(budgets.maximumMetricBytes, 1_000_000_000);
  assert.deepEqual(Object.keys(budgets), [
    "schemaVersion",
    "notes",
    "maximumMetricBytes",
    "hardLimits",
    "targets",
    "requiredProfiles",
  ]);
  assert.equal(Object.hasOwn(budgets, "growthWarnPercent"), false);
  for (const key of HARD_LIMIT_KEYS) {
    assert.equal(typeof budgets.hardLimits[key], "number", `hardLimits.${key}`);
    assert.ok(budgets.hardLimits[key] > 0, `hardLimits.${key} must be positive`);
  }
  assert.ok(budgets.hardLimits.usefulExeBytes <= 20 * 1024 * 1024);
  assert.ok(budgets.hardLimits.portableLiteZipBytes <= 40 * 1024 * 1024);
  assert.ok(budgets.hardLimits.portableFullZipBytes <= 200 * 1024 * 1024);
  assert.equal(budgets.hardLimits.frontendAppBytes, 819_200);
  assert.equal(budgets.hardLimits.officeWorkerBytes, 524_288);
  assert.equal(budgets.hardLimits.frontendDistBytes, 1_343_488);
  assert.equal(
    budgets.hardLimits.frontendDistBytes,
    budgets.hardLimits.frontendAppBytes + budgets.hardLimits.officeWorkerBytes,
  );
  assert.equal(budgets.hardLimits.initialJsBytes, 256_000);
  assert.equal(budgets.hardLimits.agentProfileChunkBytes, 40_960);
  assert.deepEqual(Object.keys(budgets.requiredProfiles), ["frontend", "ci", "release-lite", "release"]);
  assert.ok(budgets.requiredProfiles.frontend.every((key) => key.includes("frontend") || key.includes("Worker") || key.includes("initial") || key.includes("agentProfile")));
  assert.ok(budgets.requiredProfiles.ci.includes("portableLiteZipBytes"));
  assert.ok(budgets.requiredProfiles.release.includes("setupLiteBytes"));
  assert.ok(budgets.requiredProfiles.release.includes("portableFullZipBytes"));
  assert.ok(budgets.requiredProfiles["release-lite"].includes("setupLiteBytes"));
  assert.ok(!budgets.requiredProfiles["release-lite"].includes("portableFullZipBytes"));
  assert.equal(budgets.hardLimits.entryJsBytes, undefined);
  assert.equal(budgets.hardLimits.agentChunkBytes, undefined);
});

test("frontend build captures a Vite manifest, deletes it, and runs the frontend production gate", async () => {
  const [appRaw, packageRaw, capture, checker] = await Promise.all([
    read("apps/useful/package.json"),
    read("package.json"),
    read("scripts/frontend-size-report.mjs"),
    read("scripts/size-budget.mjs"),
  ]);
  const app = JSON.parse(appRaw);
  const pkg = JSON.parse(packageRaw);
  assert.match(app.scripts.build, /vite build --manifest/);
  assert.match(app.scripts.build, /frontend-size-report\.mjs/);
  assert.match(app.scripts.build, /size-budget\.mjs --profile frontend --json/);
  assert.equal(pkg.scripts["size:check"], "node scripts/size-budget.mjs");
  assert.doesNotMatch(pkg.scripts["release:checks"], /size:check|artifacts[\\/]size|size-report\.json/);
  assert.match(capture, /\.vite\/manifest\.json/);
  assert.match(capture, /isSymbolicLink\(\)/);
  assert.match(capture, /AGENT_PROFILE_SOURCE/);
  assert.match(capture, /OFFICE_WORKER_ASSET_PATTERN/);
  assert.match(checker, /REPORT_COMMIT_MISMATCH/);
  assert.match(checker, /SCHEMA_FIELDS_INVALID/);
  assert.match(checker, /REQUIRED_METRIC_MISSING/);
});

test("measure-size merges native/archive fields under artifacts/size only", async () => {
  const measure = await read("scripts/measure-size.ps1");
  assert.match(measure, /artifacts\\size|artifacts\/size/);
  assert.match(measure, /size-report\.json/);
  assert.match(measure, /useful\.size-report\.v2/);
  assert.match(measure, /ExpectedCommit/);
  assert.match(measure, /Resolve-MeasurementBinaries/);
  assert.match(measure, /portable-lite\.zip/);
  assert.match(measure, /portable-full\.zip/);
  assert.match(measure, /releaseArtifacts/);
  assert.match(measure, /sha256/);
  assert.doesNotMatch(measure, /\[string\]\$ReportDir/);
  assert.match(measure, /Join-Path \$profileDirectory "Useful\.exe"/);
  assert.doesNotMatch(measure, /useful-app\.exe|LastWriteTimeUtc|\$bestTime/);
  assert.doesNotMatch(measure, /Join-Path \$root "dist-release".*size-report/);
});

test("package-release uses Optimal compression and cargo metadata target resolution", async () => {
  const packaging = await read("scripts/package-release.ps1");
  assert.match(packaging, /resolve-cargo-target\.ps1/);
  assert.match(packaging, /Resolve-UsefulReleaseBinaries/);
  assert.match(packaging, /CompressionLevel\]::Optimal/);
  assert.doesNotMatch(packaging, /CompressionLevel\]::NoCompression/);
  assert.match(packaging, /\$KeepExpanded/);
  assert.match(packaging, /\[string\]\$OutDir/);
  // Expanded portable trees are optional deliverables.
  assert.match(packaging, /if \(\$KeepExpanded\) \{ \$plannedNames \+= "Useful-Portable-Lite-x64" \}/);
  assert.match(packaging, /if \(\$KeepExpanded\) \{ \$plannedNames \+= "Useful-Portable-Full-x64" \}/);
});

test("resolve-cargo-target helper uses cargo metadata not hardcoded target\\release", async () => {
  const helper = await read("scripts/resolve-cargo-target.ps1");
  assert.match(helper, /"metadata"/);
  assert.match(helper, /"--format-version", "1"/);
  assert.match(helper, /"--no-deps"/);
  assert.match(helper, /target_directory/);
  assert.match(helper, /function Resolve-UsefulReleaseBinaries/);
  assert.doesNotMatch(helper, /Join-Path \$RepoRoot "target\\release/);
});

test("windows features are split per crate; workspace does not kitchen-sink Win32 APIs", async () => {
  const rootCargo = await read("Cargo.toml");
  const procmon = await read("crates/useful-procmon/Cargo.toml");
  const shortcuts = await read("crates/useful-shortcuts/Cargo.toml");
  const app = await read("apps/useful/src-tauri/Cargo.toml");
  // Workspace pin only enables std; Win32 surfaces are declared per crate.
  assert.match(rootCargo, /\[workspace\.dependencies\.windows\]/);
  assert.match(rootCargo, /features = \["std"\]/);
  assert.doesNotMatch(rootCargo, /Win32_System_JobObjects|Win32_System_ProcessStatus|Win32_UI_Shell_PropertiesSystem/);
  assert.match(procmon, /Win32_System_Diagnostics_Etw/);
  assert.match(procmon, /Win32_System_Performance/);
  assert.doesNotMatch(procmon, /Win32_UI_Shell/);
  assert.match(shortcuts, /Win32_UI_Shell/);
  assert.match(shortcuts, /Win32_Storage_FileSystem/);
  assert.doesNotMatch(shortcuts, /Win32_System_Diagnostics_Etw/);
  assert.match(app, /Win32_Security_Cryptography/);
  assert.match(app, /Win32_Graphics_Dwm/);
  assert.doesNotMatch(app, /Win32_System_Diagnostics_Etw/);
});

test("agent-profile browser path does not import Ajv", async () => {
  const browser = await read("packages/agent-profile/src/browser.mjs");
  const schema = await read("packages/agent-profile/src/schema-validate.mjs");
  const pkg = JSON.parse(await read("packages/agent-profile/package.json"));
  assert.doesNotMatch(browser, /from ["']ajv|import Ajv/);
  assert.match(browser, /schema-validate\.mjs/);
  assert.match(schema, /validateProfileSchema/);
  assert.equal(pkg.dependencies?.ajv, undefined);
  assert.ok(pkg.devDependencies?.ajv, "Ajv remains a devDependency for parity tests");
});

test("media essentials evaluation script pins same version and never mutates production lock path in-script", async () => {
  const evalScript = await read("scripts/evaluate-media-essentials.ps1");
  const lock = await read("scripts/media-runtimes.lock.json");
  assert.match(evalScript, /ffmpeg-8\.1\.2-essentials_build\.7z/);
  assert.match(evalScript, /ffmpeg-8\.1\.2-full_build\.7z/);
  assert.match(evalScript, /libaom-av1/);
  assert.doesNotMatch(evalScript, /libsvtav1/);
  assert.match(evalScript, /e25b682664025d49034c981afb4bae36238a40f29a3cc1c713ad9a8b5b3528f6/);
  assert.match(evalScript, /productionLockUnchanged = \$true/);
  assert.match(evalScript, /media-essentials-eval\.json/);
  assert.match(evalScript, /Capability evidence check id must be non-empty/);
  assert.match(evalScript, /Capability evidence check id is duplicated/);
  assert.match(evalScript, /runtime:lossless-copy-trim:command/);
  assert.match(evalScript, /hard product matrix: \{0\}; soft codec matrix: \{1\}/);
  assert.doesNotMatch(evalScript, /[^\x00-\x7F]/);
  assert.match(lock, /ffmpeg-full-build/);
  assert.match(lock, /full_build/);
  // Production lock must remain full_build until Owner gate + product decision.
  assert.doesNotMatch(lock, /essentials_build/);
});

test("useful-app exposes standard/core feature gates for procmon and media", async () => {
  const cargo = await read("apps/useful/src-tauri/Cargo.toml");
  const mod = await read("apps/useful/src-tauri/src/commands/mod.rs");
  const app = await read("apps/useful/src-tauri/src/commands/app.rs");
  assert.match(cargo, /default = \["custom-protocol", "standard"\]/);
  assert.match(cargo, /standard = \["procmon", "media"\]/);
  assert.match(cargo, /procmon = \["dep:useful-procmon"\]/);
  assert.match(cargo, /media = \["dep:useful-media"\]/);
  assert.match(cargo, /useful-procmon = \{ path = .*optional = true/);
  assert.match(cargo, /useful-media = \{ path = .*optional = true/);
  assert.match(mod, /#\[cfg\(feature = "procmon"\)\]/);
  assert.match(mod, /#\[cfg\(feature = "media"\)\]/);
  assert.match(mod, /procmon_stub\.rs/);
  assert.match(mod, /media_stub\.rs/);
  assert.match(app, /HostCapabilities/);
  assert.match(app, /cfg!\(feature = "procmon"\)/);
  assert.match(app, /cfg!\(feature = "media"\)/);
});

test("manifest capture binds the exact frontend closure and removes Vite metadata", async (t) => {
  const fixture = await createFrontendFixture(t);
  const { report } = await captureFixture(fixture);
  assert.equal(report.schemaVersion, "useful.size-report.v2");
  assert.equal(report.commit, TEST_COMMIT);
  assert.equal(report.frontendDistBytes, report.frontendAppBytes + report.officeWorkerBytes);
  assert.deepEqual(report.frontendInitialJsFiles, [
    "assets/dialog-12345678.js",
    "assets/main-12345678.js",
    "assets/shared-12345678.js",
  ]);
  assert.equal(report.agentProfileSource, AGENT_PROFILE_SOURCE);
  assert.equal(report.agentProfileChunkFile, "assets/AgentProfilePanel-12345678.js");
  assert.equal(report.officeWorkerAsset, "assets/officeWorker-12345678.js");
  assert.equal(report.frontendFiles.filter((file) => file.path.includes("fileHashWorker-")).length, 1);
  assert.equal(report.frontendFiles.filter((file) => file.path.includes("regexWorker-")).length, 1);
  assert.equal(report.frontendFiles.filter((file) => file.path.includes("officeWorker-")).length, 1);
  await assert.rejects(readFile(fixture.manifestPath), { code: "ENOENT" });
  const result = await checkSizeBudget({
    repoRoot: fixture.repoRoot,
    reportPath: fixture.reportPath,
    budgetPath: path.join(fixture.repoRoot, "config", "size-budgets.json"),
    profile: "frontend",
    expectedCommit: TEST_COMMIT,
    actualCommit: TEST_COMMIT,
  });
  assert.equal(result.ok, true);
  assert.equal(result.profile, "frontend");
});

test("manifest capture rejects more than one controlled officeWorker asset", async (t) => {
  const fixture = await createFrontendFixture(t, { officeWorkerCount: 2 });
  await assert.rejects(
    captureFixture(fixture),
    (error) => error?.code === "CONTROLLED_WORKER_ASSET_INVALID" && error.message.includes("officeWorker"),
  );
  await assert.rejects(readFile(fixture.manifestPath), { code: "ENOENT" });
});

test("manifest capture rejects missing, duplicate, and imprecise helper worker outputs", async (t) => {
  const missingFixture = await createFrontendFixture(t, { fileHashWorkerCount: 0 });
  await assert.rejects(
    captureFixture(missingFixture),
    (error) => error?.code === "CONTROLLED_WORKER_ASSET_INVALID" && error.message.includes("fileHashWorker"),
  );

  const duplicateFixture = await createFrontendFixture(t, { regexWorkerCount: 2 });
  await assert.rejects(
    captureFixture(duplicateFixture),
    (error) => error?.code === "CONTROLLED_WORKER_ASSET_INVALID" && error.message.includes("regexWorker"),
  );

  const emptyFixture = await createFrontendFixture(t, {
    extraFiles: [["assets/fileHashWorker-12345678.js", ""]],
  });
  await assert.rejects(
    captureFixture(emptyFixture),
    (error) => error?.code === "CONTROLLED_WORKER_ASSET_EMPTY" && error.message.includes("fileHashWorker"),
  );

  for (const [name, relative] of [
    ["arbitrary extra", "assets/unreviewed-12345678.js"],
    ["wrong extension", "assets/fileHashWorker-abcdef12.wasm"],
    ["wrong directory", "regexWorker-abcdef12.js"],
  ]) {
    const fixture = await createFrontendFixture(t, { extraFiles: [[relative, `// ${name}\n`]] });
    await assert.rejects(
      captureFixture(fixture),
      (error) => error?.code === "DIST_FILE_SET_NOT_CLOSED" && error.message.includes(relative),
    );
  }
});

test("manifest capture rejects a linked controlled helper worker", async (t) => {
  const fixture = await createFrontendFixture(t);
  const worker = path.join(fixture.dist, "assets", "fileHashWorker-12345678.js");
  await rm(worker);
  try {
    await symlink(path.join(fixture.dist, "assets", "shared-12345678.js"), worker, "file");
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("file symlinks are unavailable in this Windows environment");
      return;
    }
    throw error;
  }
  await assert.rejects(captureFixture(fixture), (error) => error?.code === "DIST_LINK_FORBIDDEN");
});

test("manifest identifiers may traverse to node_modules while output files may not traverse dist", async (t) => {
  const validFixture = await createFrontendFixture(t);
  const valid = await captureFixture(validFixture);
  assert.ok(valid.report.frontendInitialJsFiles.includes("assets/dialog-12345678.js"));

  const fileTraversalFixture = await createFrontendFixture(t);
  const fileTraversalManifest = JSON.parse(await readFile(fileTraversalFixture.manifestPath, "utf8"));
  fileTraversalManifest[NODE_MODULE_MANIFEST_KEY].file = "../../outside.js";
  await writeFile(fileTraversalFixture.manifestPath, `${JSON.stringify(fileTraversalManifest)}\n`, "utf8");
  await assert.rejects(
    captureFixture(fileTraversalFixture),
    (error) => error?.code === "RELATIVE_PATH_INVALID",
  );

  const importTraversalFixture = await createFrontendFixture(t);
  const importTraversalManifest = JSON.parse(await readFile(importTraversalFixture.manifestPath, "utf8"));
  importTraversalManifest["index.html"].imports.push("../../../undeclared/outside.js");
  await writeFile(importTraversalFixture.manifestPath, `${JSON.stringify(importTraversalManifest)}\n`, "utf8");
  await assert.rejects(
    captureFixture(importTraversalFixture),
    (error) => error?.code === "MANIFEST_IMPORT_MISSING",
  );
});

test("manifest chunks reject unknown fields and wrong field types", async (t) => {
  const unknownFixture = await createFrontendFixture(t);
  const unknownManifest = JSON.parse(await readFile(unknownFixture.manifestPath, "utf8"));
  unknownManifest["index.html"].unreviewed = true;
  await writeFile(unknownFixture.manifestPath, `${JSON.stringify(unknownManifest)}\n`, "utf8");
  await assert.rejects(
    captureFixture(unknownFixture),
    (error) => error?.code === "MANIFEST_CHUNK_FIELDS_INVALID",
  );

  const wrongTypeFixture = await createFrontendFixture(t);
  const wrongTypeManifest = JSON.parse(await readFile(wrongTypeFixture.manifestPath, "utf8"));
  wrongTypeManifest["index.html"].imports = "_shared-12345678.js";
  await writeFile(wrongTypeFixture.manifestPath, `${JSON.stringify(wrongTypeManifest)}\n`, "utf8");
  await assert.rejects(
    captureFixture(wrongTypeFixture),
    (error) => error?.code === "MANIFEST_FIELD_INVALID",
  );
});

test("dist child junction is rejected before descendant reads or report creation", async (t) => {
  const fixture = await createFrontendFixture(t);
  const target = path.join(fixture.repoRoot, "junction-target");
  const linked = path.join(fixture.dist, "assets", "linked-directory");
  await mkdir(target);
  const sentinel = path.join(target, "must-not-be-traversed.txt");
  await writeFile(sentinel, "junction descendant remains controlled\n", "utf8");
  try {
    await symlink(target, linked, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "ENOSYS") {
      t.skip("directory reparse points are unavailable in this environment");
      return;
    }
    throw error;
  }
  await assert.rejects(
    captureFixture(fixture),
    (error) => ["DIST_LINK_FORBIDDEN", "WINDOWS_REPARSE_POINT_FORBIDDEN"].includes(error?.code),
  );
  assert.equal(await readFile(sentinel, "utf8"), "junction descendant remains controlled\n");
  assert.ok(await lstat(linked), "junction must remain after preflight rejection");
  await assert.rejects(lstat(fixture.reportPath), { code: "ENOENT" });
});

test("manifest junction is rejected before manifest read or Vite metadata deletion", async (t) => {
  const fixture = await createFrontendFixture(t);
  const originalManifest = await readFile(fixture.manifestPath, "utf8");
  const viteDirectory = path.dirname(fixture.manifestPath);
  const junctionTarget = path.join(fixture.repoRoot, "vite-junction-target");
  await mkdir(junctionTarget);
  await writeFile(path.join(junctionTarget, "manifest.json"), originalManifest, "utf8");
  await rm(viteDirectory, { recursive: true });
  try {
    await symlink(
      junctionTarget,
      viteDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "ENOSYS") {
      t.skip("directory reparse points are unavailable in this environment");
      return;
    }
    throw error;
  }
  await assert.rejects(
    captureFixture(fixture),
    (error) => ["WINDOWS_REPARSE_POINT_FORBIDDEN", "DIRECTORY_NOT_ORDINARY"].includes(error?.code),
  );
  assert.equal(await readFile(path.join(junctionTarget, "manifest.json"), "utf8"), originalManifest);
});

test("report junction is rejected before creating or overwriting report output", async (t) => {
  const fixture = await createFrontendFixture(t);
  const junctionTarget = path.join(fixture.repoRoot, "report-junction-target");
  const artifactsDirectory = path.join(fixture.repoRoot, "artifacts");
  await mkdir(junctionTarget);
  try {
    await symlink(
      junctionTarget,
      artifactsDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "ENOSYS") {
      t.skip("directory reparse points are unavailable in this environment");
      return;
    }
    throw error;
  }
  await assert.rejects(
    captureFixture(fixture),
    (error) => ["WINDOWS_REPARSE_POINT_FORBIDDEN", "OUTPUT_DIRECTORY_NOT_ORDINARY"].includes(error?.code),
  );
  await assert.rejects(lstat(path.join(junctionTarget, "size")), { code: "ENOENT" });
});

test("production profiles require their artifacts and release accepts a complete fixture", async (t) => {
  const fixture = await createFrontendFixture(t);
  const { report } = await captureFixture(fixture);
  const options = {
    repoRoot: fixture.repoRoot,
    reportPath: fixture.reportPath,
    budgetPath: path.join(fixture.repoRoot, "config", "size-budgets.json"),
    expectedCommit: TEST_COMMIT,
    actualCommit: TEST_COMMIT,
  };
  await assert.rejects(
    checkSizeBudget({ ...options, profile: "ci" }),
    (error) => error?.code === "REQUIRED_ARTIFACT_MISSING" && error.message.includes("usefulExe"),
  );
  await populateProfileArtifacts(fixture, report, "release");
  await writeFile(fixture.reportPath, `${JSON.stringify(report)}\n`, "utf8");
  const result = await checkSizeBudget({ ...options, profile: "release" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.required.slice(-3), ["portableLiteZipBytes", "setupLiteBytes", "portableFullZipBytes"]);
});

test("release-lite requires Setup Lite and rejects any Portable Full evidence", async (t) => {
  const fixture = await createFrontendFixture(t);
  const { report } = await captureFixture(fixture);
  await populateProfileArtifacts(fixture, report, "release-lite");
  const options = {
    repoRoot: fixture.repoRoot,
    reportPath: fixture.reportPath,
    budgetPath: path.join(fixture.repoRoot, "config", "size-budgets.json"),
    profile: "release-lite",
    expectedCommit: TEST_COMMIT,
    actualCommit: TEST_COMMIT,
  };
  await writeFile(fixture.reportPath, `${JSON.stringify(report)}\n`, "utf8");
  const result = await checkSizeBudget(options);
  assert.equal(result.ok, true);
  assert.equal(report.releaseArtifacts.portableFullZip, null);

  report.releaseArtifacts.portableFullZip = await writeArtifactEvidence(
    fixture.repoRoot,
    `release-assets/Useful-${PACKAGE_VERSION}-windows-x64-portable-full.zip`,
    "forbidden-full\n",
  );
  report.portableFullZipBytes = report.releaseArtifacts.portableFullZip.bytes;
  await writeFile(fixture.reportPath, `${JSON.stringify(report)}\n`, "utf8");
  await assert.rejects(
    checkSizeBudget(options),
    (error) => error?.code === "ARTIFACT_PROFILE_BINDING_INVALID" && error.message.includes("portableFullZip"),
  );
});

test("CI artifact evidence is bound to the exact CI binary and Portable Lite names", async (t) => {
  const fixture = await createFrontendFixture(t);
  const { report } = await captureFixture(fixture);
  await populateProfileArtifacts(fixture, report, "ci");
  const options = {
    repoRoot: fixture.repoRoot,
    reportPath: fixture.reportPath,
    budgetPath: path.join(fixture.repoRoot, "config", "size-budgets.json"),
    profile: "ci",
    expectedCommit: TEST_COMMIT,
    actualCommit: TEST_COMMIT,
  };
  await writeFile(fixture.reportPath, `${JSON.stringify(report)}\n`, "utf8");
  assert.equal((await checkSizeBudget(options)).ok, true);

  report.releaseArtifacts.portableLiteZip.path = "dist-release/Useful-Lite.zip";
  await writeFile(fixture.reportPath, `${JSON.stringify(report)}\n`, "utf8");
  await assert.rejects(
    checkSizeBudget(options),
    (error) => error?.code === "ARTIFACT_PROFILE_BINDING_INVALID" && error.message.includes("portableLiteZip"),
  );
});

test("production artifact evidence rejects missing, substituted, same-size changed, and forged-hash files", async (t) => {
  const fixture = await createFrontendFixture(t);
  const { report } = await captureFixture(fixture);
  const { paths, contents } = await populateProfileArtifacts(fixture, report, "release");
  const options = {
    repoRoot: fixture.repoRoot,
    reportPath: fixture.reportPath,
    budgetPath: path.join(fixture.repoRoot, "config", "size-budgets.json"),
    profile: "release",
    expectedCommit: TEST_COMMIT,
    actualCommit: TEST_COMMIT,
  };
  const writeReport = async (value = report) => writeFile(fixture.reportPath, `${JSON.stringify(value)}\n`, "utf8");
  await writeReport();

  await rm(path.join(fixture.repoRoot, ...paths.usefulExe.split("/")));
  await assert.rejects(
    checkSizeBudget(options),
    (error) => error?.code === "ARTIFACT_MISSING_OR_INVALID" && error.message.includes("usefulExe"),
  );
  await writeArtifactEvidence(fixture.repoRoot, paths.usefulExe, contents.usefulExe);

  const substituted = structuredClone(report);
  substituted.releaseArtifacts.usefulExe.path = paths.bootstrapExe;
  await writeReport(substituted);
  await assert.rejects(
    checkSizeBudget(options),
    (error) => error?.code === "ARTIFACT_PROFILE_BINDING_INVALID" && error.message.includes("usefulExe"),
  );

  await writeReport();
  const changed = Buffer.alloc(report.releaseArtifacts.usefulExe.bytes, 0x78);
  await writeFile(path.join(fixture.repoRoot, ...paths.usefulExe.split("/")), changed);
  await assert.rejects(
    checkSizeBudget(options),
    (error) => error?.code === "ARTIFACT_HASH_DRIFT" && error.message.includes("usefulExe"),
  );
  await writeArtifactEvidence(fixture.repoRoot, paths.usefulExe, contents.usefulExe);

  const forgedHash = structuredClone(report);
  forgedHash.releaseArtifacts.usefulExe.sha256 = "0".repeat(64);
  await writeReport(forgedHash);
  await assert.rejects(
    checkSizeBudget(options),
    (error) => error?.code === "ARTIFACT_HASH_DRIFT" && error.message.includes("usefulExe"),
  );
});

test("production checker rejects an artifact path crossing a directory junction", async (t) => {
  const fixture = await createFrontendFixture(t);
  const { report } = await captureFixture(fixture);
  const releaseParent = path.join(fixture.repoRoot, "target", "x86_64-pc-windows-msvc");
  const junctionTarget = path.join(fixture.repoRoot, "controlled-junction-target");
  await mkdir(releaseParent, { recursive: true });
  await mkdir(junctionTarget);
  try {
    await symlink(
      junctionTarget,
      path.join(releaseParent, "release"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "ENOSYS") {
      t.skip("directory reparse points are unavailable in this environment");
      return;
    }
    throw error;
  }
  await populateProfileArtifacts(fixture, report, "release");
  await writeFile(fixture.reportPath, `${JSON.stringify(report)}\n`, "utf8");
  await assert.rejects(
    checkSizeBudget({
      repoRoot: fixture.repoRoot,
      reportPath: fixture.reportPath,
      budgetPath: path.join(fixture.repoRoot, "config", "size-budgets.json"),
      profile: "release",
      expectedCommit: TEST_COMMIT,
      actualCommit: TEST_COMMIT,
    }),
    (error) => error?.code === "ARTIFACT_MISSING_OR_INVALID",
  );
});

test("production checker rejects missing, stale, unknown, over-1B, and over-budget reports", async (t) => {
  const fixture = await createFrontendFixture(t);
  const { report } = await captureFixture(fixture);
  const budgetPath = path.join(fixture.repoRoot, "config", "size-budgets.json");
  const options = {
    repoRoot: fixture.repoRoot,
    reportPath: fixture.reportPath,
    budgetPath,
    profile: "frontend",
    expectedCommit: TEST_COMMIT,
    actualCommit: TEST_COMMIT,
  };
  const baseline = structuredClone(report);
  const writeReport = async (value) => writeFile(fixture.reportPath, `${JSON.stringify(value)}\n`, "utf8");

  await assert.rejects(
    checkSizeBudget({ ...options, reportPath: path.join(fixture.repoRoot, "missing.json") }),
    (error) => error?.code === "REPORT_MISSING_OR_INVALID",
  );

  const stale = structuredClone(baseline);
  stale.commit = "b".repeat(40);
  await writeReport(stale);
  await assert.rejects(checkSizeBudget(options), (error) => error?.code === "REPORT_COMMIT_MISMATCH");

  const unknown = structuredClone(baseline);
  unknown.unreviewedBytes = 1;
  await writeReport(unknown);
  await assert.rejects(checkSizeBudget(options), (error) => error?.code === "SCHEMA_FIELDS_INVALID");

  await writeReport(baseline);
  const budgetsBaseline = JSON.parse(await readFile(budgetPath, "utf8"));
  const configWithUnknown = structuredClone(budgetsBaseline);
  configWithUnknown.growthWarnPercent = 5;
  await writeFile(budgetPath, `${JSON.stringify(configWithUnknown)}\n`, "utf8");
  await assert.rejects(checkSizeBudget(options), (error) => error?.code === "SCHEMA_FIELDS_INVALID");
  await writeFile(budgetPath, `${JSON.stringify(budgetsBaseline)}\n`, "utf8");

  const tooLarge = structuredClone(baseline);
  tooLarge.frontendDistBytes = MAX_SIZE_BYTES + 1;
  await writeReport(tooLarge);
  await assert.rejects(checkSizeBudget(options), (error) => error?.code === "METRIC_VALUE_INVALID");

  await writeReport(baseline);
  const budgets = JSON.parse(await readFile(budgetPath, "utf8"));
  budgets.hardLimits.initialJsBytes = 1;
  await writeFile(budgetPath, `${JSON.stringify(budgets)}\n`, "utf8");
  await assert.rejects(checkSizeBudget(options), (error) => error?.code === "HARD_LIMIT_EXCEEDED");
});
