import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFile(path.join(root, relative), "utf8");

test("ordinary CI publishes only a Useful Portable Lite development-trust unsigned preview", async () => {
  const ci = await read(".github/workflows/ci.yml");
  assert.doesNotMatch(ci, /fetch-binaries\.ps1/);
  assert.doesNotMatch(ci, /Portable-Full|-Edition (?:Full|All)/);
  assert.match(ci, /package-release\.ps1 -Edition Lite/);
  assert.match(ci, /useful-portable-lite-x64-development-trust-unsigned-preview/);
  assert.match(ci, /dist-release\/Useful-Portable-Lite-x64\.zip/);
  assert.match(ci, /USEFUL_SIZE_EXPECTED_COMMIT: \$\{\{ github\.sha \}\}/);
  assert.match(ci, /measure-size\.ps1 -ExpectedCommit \$env:USEFUL_SIZE_EXPECTED_COMMIT/);
  assert.match(ci, /pnpm size:check --profile ci --json/);
  const packageIndex = ci.indexOf("package-release.ps1 -Edition Lite");
  const measureIndex = ci.indexOf("& ./scripts/measure-size.ps1 -ExpectedCommit $env:USEFUL_SIZE_EXPECTED_COMMIT");
  const checkIndex = ci.indexOf("pnpm size:check --profile ci --json");
  const uploadIndex = ci.indexOf("uses: actions/upload-artifact@", checkIndex);
  assert.ok(packageIndex < measureIndex && measureIndex < checkIndex && checkIndex < uploadIndex);
  assert.doesNotMatch(ci, /(?:path:|dist-release\/)[^\n]*(?:artifacts[\\/]size|size-report\.json)/i);
});

test("public local packaging has explicit Lite Full All semantics and Full fails closed", async () => {
  const [packaging, dryRun, verification, resolveTarget, measure] = await Promise.all([
    read("scripts/package-release.ps1"),
    read("scripts/useful.release.ps1"),
    read("scripts/verify-release.mjs"),
    read("scripts/resolve-cargo-target.ps1"),
    read("scripts/measure-size.ps1"),
  ]);
  assert.match(packaging, /ValidateSet\("Lite", "Full", "All"\)/);
  assert.match(packaging, /\[string\]\$OutDir/);
  assert.match(packaging, /\[switch\]\$KeepExpanded/);
  assert.match(packaging, /Assert-MediaRuntimes/);
  assert.match(packaging, /release-metadata-media\.mjs/);
  assert.match(packaging, /Useful-Portable-Lite-x64/);
  assert.match(packaging, /Useful-Portable-Full-x64/);
  assert.match(packaging, /resolve-cargo-target\.ps1/);
  assert.match(packaging, /Resolve-UsefulReleaseBinaries/);
  assert.match(packaging, /CompressionLevel\]::Optimal/);
  assert.doesNotMatch(packaging, /CompressionLevel\]::NoCompression/);
  assert.match(packaging, /if \(\$KeepExpanded\) \{ \$plannedNames \+= "Useful-Portable-Lite-x64" \}/);
  assert.match(packaging, /if \(\$KeepExpanded\) \{ \$plannedNames \+= "Useful-Portable-Full-x64" \}/);
  assert.doesNotMatch(packaging, /Write-Warning|skip Full|跳过 Full/);
  assert.doesNotMatch(packaging, /(?:New-Item|Move-Item)[^\r\n]*-Force|Remove-Item/);
  assert.match(packaging, /\.staging-/);
  assert.match(packaging, /\[IO\.FileMode\]::CreateNew/);
  assert.match(packaging, /\[StringComparer\]::Ordinal/);
  assert.match(packaging, /2107-12-31T23:59:58Z/);
  assert.match(packaging, /\.useful-package-release\.incomplete\.json/);
  assert.match(packaging, /status = "incomplete"/);
  assert.match(packaging, /Incomplete Useful release delivery/);
  assert.ok(packaging.indexOf('[IO.File]::Delete($incompleteMarker)') < packaging.indexOf('Write-Host "Complete: $out"'));
  assert.match(packaging, /Copy-Item -LiteralPath \$mediaManifestPath -Destination \(Join-Path \$directory "MEDIA-RUNTIMES\.json"\)/);
  assert.match(packaging, /Portable Lite must not contain media runtimes or MEDIA-RUNTIMES\.json/);
  assert.match(resolveTarget, /"metadata"/);
  assert.match(resolveTarget, /"--format-version", "1"/);
  assert.match(resolveTarget, /"--no-deps"/);
  assert.match(resolveTarget, /target_directory/);
  assert.match(dryRun, /pnpm --filter @useful\/app tauri build --no-bundle/);
  assert.match(dryRun, /cargo build --release --locked -p useful-bootstrap/);
  assert.match(dryRun, /package-release\.ps1"\) -Edition Lite/);
  assert.match(dryRun, /measure-size\.ps1/);
  assert.match(dryRun, /pnpm size:check --profile ci --expected-commit \$ExpectedCommit --json/);
  assert.ok(dryRun.indexOf('package-release.ps1") -Edition Lite') < dryRun.indexOf("pnpm size:check --profile ci"));
  const measurementResolver = measure.slice(
    measure.indexOf("function Resolve-MeasurementBinaries"),
    measure.indexOf("function Get-ExactReleaseArtifactOrNull"),
  );
  assert.match(measurementResolver, /Join-Path \$profileDirectory "Useful\.exe"/);
  assert.match(measurementResolver, /Join-Path \$profileDirectory "useful-bootstrap\.exe"/);
  assert.doesNotMatch(measurementResolver, /useful-app\.exe|LastWriteTimeUtc|\$bestTime|Get-ChildItem/);
  assert.doesNotMatch(measure, /\[string\]\$ReportDir/);
  assert.match(measure, /releaseArtifacts\.usefulExe/);
  assert.match(measure, /Get-FileHash -LiteralPath .* -Algorithm SHA256/);
  assert.match(verification, /"-Edition", "All"/);
  assert.match(verification, /Useful-Portable-Lite-x64\.zip/);
  assert.match(verification, /Useful-Portable-Full-x64\.zip/);
  assert.match(verification, /"MEDIA-RUNTIMES\.json"/);
});

test("official Windows release uses the shared lock and exact Lite Full asset names", async () => {
  const [release, fetch] = await Promise.all([
    read(".github/workflows/release.yml"),
    read("scripts/fetch-binaries.ps1"),
  ]);
  assert.match(fetch, /media-runtimes\.lock\.json/);
  assert.match(fetch, /\$manifest\s*=\s*@\(\$lock\.archives\)/);
  assert.doesNotMatch(fetch, /Name\s*=\s*"ffmpeg|Url\s*=\s*"https:\/\//);
  assert.doesNotMatch(fetch, /(?:New-Item|Move-Item)[^\r\n]*-Force|Remove-Item\s/);
  assert.match(fetch, /Unsafe media extract sourcePath/);
  assert.match(fetch, /\$expectedPairs = \[ordered\]@\{ ffmpeg = "ffmpeg\.exe"; ffprobe = "ffprobe\.exe"; mpv = "mpv\.exe" \}/);
  assert.match(fetch, /Cached archive hash mismatch; refusing to replace/);
  assert.match(fetch, /\.staging-/);
  assert.match(fetch, /\.useful-fetch-binaries\.incomplete\.json/);
  assert.match(fetch, /Incomplete Useful media runtime delivery/);
  assert.ok(fetch.indexOf('[IO.File]::Delete($incompleteMarker)') < fetch.indexOf('Write-Host "Useful media runtimes verified and installed."'));
  assert.match(release, /Fetch and verify locked media runtimes for Windows Portable Full/);
  assert.match(release, /Useful-\$version-windows-x64-setup-lite\.exe/);
  assert.match(release, /Useful-\$version-windows-x64-portable-lite\.zip/);
  assert.match(release, /Useful-\$version-windows-x64-portable-full\.zip/);
  assert.match(release, /MEDIA-RUNTIMES\.json/);
  assert.match(release, /USEFUL_SIZE_EXPECTED_COMMIT: \$\{\{ github\.sha \}\}/);
  assert.match(release, /& \.\/scripts\/measure-size\.ps1 -OutDir release-assets -Target \$env:TARGET -ExpectedCommit \$env:USEFUL_SIZE_EXPECTED_COMMIT/);
  assert.match(release, /pnpm size:check --profile release --json/);
  const packageIndex = release.indexOf("Package Windows Setup Lite and deterministic Portable Lite/Full assets");
  const measureIndex = release.indexOf("& ./scripts/measure-size.ps1 -OutDir release-assets -Target $env:TARGET -ExpectedCommit $env:USEFUL_SIZE_EXPECTED_COMMIT");
  const checkIndex = release.indexOf("pnpm size:check --profile release --json");
  const uploadIndex = release.indexOf("name: Upload build output for release assembly");
  assert.ok(packageIndex < measureIndex && measureIndex < checkIndex && checkIndex < uploadIndex);
  assert.doesNotMatch(release, /release-assets[^\n]*(?:size-report\.json|artifacts[\\/]size)/i);
  assert.match(release, /\$ErrorActionPreference = 'Stop'/);
  assert.match(release, /\$PSNativeCommandUseErrorActionPreference = \$true/);
  assert.match(release, /\[StringComparer\]::Ordinal/);
  assert.match(release, /2107-12-31T23:59:58Z/);
  assert.doesNotMatch(release, /Sort-Object FullName/);
  assert.match(release, /constants\.COPYFILE_EXCL/);
  assert.match(release, /duplicate release candidate basename/);
  assert.doesNotMatch(release, /find _downloads[^\n]*-exec cp/);
});

test("assemble rejects forged generated basenames before any candidate write and generates exclusively", async () => {
  const release = await read(".github/workflows/release.yml");
  const reserved = release.indexOf("const generatedNames = new Set([");
  const collision = release.indexOf("release candidate input collides with reserved generated name");
  const candidateCreate = release.indexOf("mkdirSync('release-candidate')");
  assert.ok(reserved >= 0 && collision > reserved && candidateCreate > collision);
  for (const name of ["RELEASE-METADATA.json", "RELEASE-ASSETS.txt", "RELEASE-NOTES.md", "BUILD-PROVENANCE.json", "SHA256SUMS.txt"]) {
    assert.ok(release.slice(reserved, collision).includes(`'${name}'`), `${name} must be reserved against artifact input collision`);
  }
  assert.match(release, /copyFileSync\(entry\.source, destination, constants\.COPYFILE_EXCL\)/);
  assert.match(release, /BUILD-PROVENANCE\.json'\), `\$\{JSON\.stringify\(provenance, null, 2\)\}\\n`, \{ flag: 'wx' \}/);
  assert.ok((release.match(/set -o noclobber/g) ?? []).length >= 3);
});
