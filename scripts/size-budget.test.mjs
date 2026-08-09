import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFile(path.join(root, relative), "utf8");
const exists = async (relative) => {
  try {
    await access(path.join(root, relative));
    return true;
  } catch {
    return false;
  }
};

const HARD_LIMIT_KEYS = [
  "usefulExeBytes",
  "bootstrapExeBytes",
  "frontendDistBytes",
  "entryJsBytes",
  "agentChunkBytes",
  "portableLiteZipBytes",
  "setupLiteBytes",
  "portableFullZipBytes",
];

test("size budget config exists and declares hard limits", async () => {
  const raw = await read("config/size-budgets.json");
  const budgets = JSON.parse(raw);
  assert.equal(budgets.schemaVersion, "useful.size-budgets.v1");
  assert.equal(typeof budgets.growthWarnPercent, "number");
  assert.ok(budgets.growthWarnPercent > 0 && budgets.growthWarnPercent <= 50);
  for (const key of HARD_LIMIT_KEYS) {
    assert.equal(typeof budgets.hardLimits[key], "number", `hardLimits.${key}`);
    assert.ok(budgets.hardLimits[key] > 0, `hardLimits.${key} must be positive`);
  }
  assert.ok(budgets.hardLimits.usefulExeBytes <= 20 * 1024 * 1024);
  assert.ok(budgets.hardLimits.portableLiteZipBytes <= 40 * 1024 * 1024);
  assert.ok(budgets.hardLimits.portableFullZipBytes <= 200 * 1024 * 1024);
});

test("measure-size.ps1 writes reports under artifacts/size not dist-release", async () => {
  const measure = await read("scripts/measure-size.ps1");
  assert.match(measure, /artifacts\\size|artifacts\/size/);
  assert.match(measure, /size-report\.json/);
  assert.match(measure, /Resolve-UsefulReleaseBinaries/);
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

test("when a size report exists, measured values stay under hard limits", async () => {
  if (!(await exists("artifacts/size/size-report.json"))) {
    // Baseline not measured yet — contract still passes; measure-size.ps1 produces it.
    return;
  }
  const [budgetRaw, reportRaw] = await Promise.all([
    read("config/size-budgets.json"),
    read("artifacts/size/size-report.json"),
  ]);
  const budgets = JSON.parse(budgetRaw);
  const report = JSON.parse(reportRaw);
  const checked = [];
  for (const key of HARD_LIMIT_KEYS) {
    const value = report[key];
    if (value === null || value === undefined) continue;
    assert.equal(typeof value, "number", `report.${key}`);
    assert.ok(
      value <= budgets.hardLimits[key],
      `${key}=${value} exceeds hard limit ${budgets.hardLimits[key]}`,
    );
    checked.push(key);
  }
  // Prefer checking at least the always-present binary fields when a report is present.
  if (report.usefulExeBytes != null) {
    assert.ok(checked.includes("usefulExeBytes"));
  }
});
