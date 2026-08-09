import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildMediaRuntimeManifest } from "./release-metadata-media.mjs";
import {
  buildMediaPackManifest,
  runCli,
  validateLockedMediaPackManifest,
  validateMediaPackManifest,
} from "./media-pack-v2.mjs";

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const candidateLockPath = path.join(scriptRoot, "media-runtimes.v2.candidate.lock.json");
const execFileAsync = promisify(execFile);

async function createFixture(root) {
  const binaries = path.join(root, "binaries");
  await mkdir(binaries);
  const checksumLines = [];
  const fileFacts = new Map();
  for (const name of ["ffmpeg.exe", "ffprobe.exe", "mpv.exe"]) {
    const bytes = Buffer.from(`media-pack-fixture:${name}\n`);
    await writeFile(path.join(binaries, name), bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    checksumLines.push(`${sha256}  ${name}`);
    fileFacts.set(name, { sha256, sizeBytes: bytes.length });
  }
  await writeFile(path.join(binaries, "CHECKSUMS.txt"), `${checksumLines.join("\n")}\n`, "ascii");
  const fixtureLock = JSON.parse(await readFile(candidateLockPath, "utf8"));
  for (const archive of fixtureLock.archives) {
    for (const extract of archive.extracts) {
      const facts = fileFacts.get(extract.targetName);
      extract.extractedSha256 = facts.sha256;
      extract.sizeBytes = facts.sizeBytes;
    }
  }
  const fixtureLockPath = path.join(root, "media-runtimes.v2.fixture.lock.json");
  await writeFile(fixtureLockPath, `${JSON.stringify(fixtureLock, null, 2)}\n`);
  const runtimeManifest = path.join(root, "MEDIA-RUNTIMES.json");
  const runtime = await buildMediaRuntimeManifest(fixtureLockPath, binaries);
  await writeFile(runtimeManifest, `${JSON.stringify(runtime, null, 2)}\n`);
  return { binaries, fixtureLockPath, runtimeManifest };
}

test("pack manifests are deterministic subsets bound to the v2 lock and runtime bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "useful-media-pack-v2-"));
  try {
    const { fixtureLockPath, runtimeManifest } = await createFixture(root);
    const preview = await buildMediaPackManifest(fixtureLockPath, runtimeManifest, "preview");
    const transcode = await buildMediaPackManifest(fixtureLockPath, runtimeManifest, "transcode");
    assert.equal(preview.distributionStatus, "unsigned-candidate");
    assert.equal(preview.signatureDomain, "useful-media-pack-v1");
    assert.equal(preview.correspondingSourceRequired, true);
    assert.deepEqual(preview.components.map(({ name }) => name), ["mpv"]);
    assert.deepEqual(transcode.components.map(({ name }) => name), ["ffmpeg", "ffprobe"]);
    assert.match(preview.runtimeLockSha256, /^[0-9a-f]{64}$/);
    assert.equal(preview.runtimeLockSha256, transcode.runtimeLockSha256);

    const output = path.join(root, "MEDIA-PACK.json");
    await runCli([
      "--lock", fixtureLockPath,
      "--runtime-manifest", runtimeManifest,
      "--pack", "preview",
      "--output", output,
    ]);
    assert.deepEqual(await validateMediaPackManifest(output, fixtureLockPath, runtimeManifest, "preview"), preview);
    assert.deepEqual(await validateLockedMediaPackManifest(output, fixtureLockPath, "preview"), preview);
    assert.deepEqual(await runCli([
      "--lock", fixtureLockPath,
      "--pack", "preview",
      "--locked-manifest", output,
    ]), preview);
    await assert.rejects(() => runCli([
      "--lock", fixtureLockPath,
      "--runtime-manifest", runtimeManifest,
      "--pack", "preview",
      "--output", output,
    ]), /覆盖/);

    const tampered = structuredClone(preview);
    tampered.minimumUsefulVersion = "9.9.9";
    await writeFile(output, `${JSON.stringify(tampered)}\n`);
    await assert.rejects(
      () => validateMediaPackManifest(output, fixtureLockPath, runtimeManifest, "preview"),
      /不一致/,
    );
    await assert.rejects(
      () => buildMediaPackManifest(fixtureLockPath, runtimeManifest, "unknown"),
      /未知 media pack/,
    );

    const realDirectory = path.join(root, "real-pack-directory");
    const linkedDirectory = path.join(root, "linked-pack-directory");
    await mkdir(realDirectory);
    await writeFile(path.join(realDirectory, "MEDIA-PACK.json"), `${JSON.stringify(preview, null, 2)}\n`);
    await symlink(realDirectory, linkedDirectory, "junction");
    await assert.rejects(
      () => validateMediaPackManifest(path.join(linkedDirectory, "MEDIA-PACK.json"), fixtureLockPath, runtimeManifest, "preview"),
      /symlink|junction/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PowerShell packager is candidate-only, deterministic, and fail-closed", async () => {
  const [source, evaluation] = await Promise.all([
    readFile(path.join(scriptRoot, "package-media-packs.ps1"), "utf8"),
    readFile(path.join(scriptRoot, "evaluate-media-packs.ps1"), "utf8"),
  ]);
  assert.match(source, /media-runtimes\.v2\.candidate\.lock\.json/);
  assert.match(source, /unsigned-candidate\.zip/);
  assert.match(source, /CompressionLevel\]::Optimal/);
  assert.match(source, /UNSIGNED-CANDIDATE\.txt/);
  assert.match(source, /publicRelease = \$false/);
  assert.match(source, /\.useful-media-pack-candidate\.incomplete\.json/);
  assert.match(source, /Refusing to overwrite existing media-pack output/);
  assert.doesNotMatch(source, /(?:New-Item|Move-Item)[^\r\n]*-Force|Remove-Item/);
  assert.match(evaluation, /productionLockUnchanged = \$true/);
  assert.match(evaluation, /CANDIDATE_SPLIT_ONLY_TOTAL_TARGET_NOT_MET/);
  assert.match(evaluation, /100MB/);
  assert.match(evaluation, /HardLink/);
  assert.doesNotMatch(evaluation, /media-runtimes\.lock\.json[^\r\n]*(?:Set-Content|WriteAllText)/);
});

test("PowerShell packager emits the closed candidate asset set and refuses overwrite", async () => {
  if (process.platform !== "win32") return;
  const root = await mkdtemp(path.join(os.tmpdir(), "useful-media-packaging-v2-"));
  try {
    const { binaries, fixtureLockPath } = await createFixture(root);
    const output = path.join(root, "output");
    await mkdir(output);
    const args = [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", path.join(scriptRoot, "package-media-packs.ps1"),
      "-LockPath", fixtureLockPath,
      "-BinariesDir", binaries,
      "-OutDir", output,
    ];
    await execFileAsync("powershell", args, { windowsHide: true });
    assert.deepEqual((await readdir(output)).sort(), [
      "MEDIA-PACKS-CANDIDATE-SHA256SUMS.txt",
      "MEDIA-PACK-preview.unsigned-candidate.json",
      "MEDIA-PACK-transcode.unsigned-candidate.json",
      "Useful-Media-Pack-preview-windows-x64-unsigned-candidate.zip",
      "Useful-Media-Pack-transcode-windows-x64-unsigned-candidate.zip",
    ].sort());
    await assert.rejects(
      () => execFileAsync("powershell", args, { windowsHide: true }),
      /overwrite|existing media-pack output/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("in-app MediaPack trust, proxy, and resume boundaries are build-pinned", async () => {
  const [native, sidecar, paths, appNative, ipc, view] = await Promise.all([
    readFile(path.join(scriptRoot, "../apps/useful/src-tauri/src/commands/media_pack.rs"), "utf8"),
    readFile(path.join(scriptRoot, "../crates/useful-media/src/sidecar.rs"), "utf8"),
    readFile(path.join(scriptRoot, "../crates/useful-core/src/paths.rs"), "utf8"),
    readFile(path.join(scriptRoot, "../apps/useful/src-tauri/src/lib.rs"), "utf8"),
    readFile(path.join(scriptRoot, "../apps/useful/src/lib/ipc.ts"), "utf8"),
    readFile(path.join(scriptRoot, "../apps/useful/src/views/MediaRuntimeView.vue"), "utf8"),
  ]);
  assert.match(native, /option_env!\("USEFUL_MEDIA_PACK_CATALOG_URL"\)/);
  assert.match(native, /option_env!\("USEFUL_MEDIA_PACK_CATALOG_SIGNATURE_URL"\)/);
  assert.match(native, /option_env!\("USEFUL_MEDIA_PACK_PUBLIC_KEY_HEX"\)/);
  assert.doesNotMatch(native, /std::env::var(?:_os)?\([^\r\n]*USEFUL_MEDIA_PACK/);
  assert.match(native, /redirect\(reqwest::redirect::Policy::none\(\)\)/);
  assert.match(native, /\.no_gzip\(\)/);
  assert.match(native, /\.read_timeout\(Duration::from_secs\(30\)\)/);
  assert.match(native, /MAX_DOWNLOAD_ATTEMPTS:\s*u8\s*=\s*3/);
  assert.match(native, /\.header\(RANGE,/);
  assert.match(native, /\.header\(IF_RANGE,/);
  assert.match(native, /StatusCode::PARTIAL_CONTENT/);
  assert.match(native, /CONTENT_RANGE/);
  assert.doesNotMatch(native, /\.no_proxy\(\)|Proxy::|\.proxy\(/);
  assert.match(native, /\.part/);
  assert.match(native, /pack::install_verified_pack/);
  assert.doesNotMatch(native, /remove_dir_all/);
  assert.match(native, /damaged:\s*installed\.damaged/);
  assert.match(sidecar, /media-pack-damaged/);
  assert.doesNotMatch(sidecar, /var_os\("PATH"\)|split_paths/);
  assert.match(paths, /\.useful-write-probe-/);
  assert.match(appNative, /Useful 不会改用 AppData/);
  assert.match(ipc, /mediaPackInstall:\s*\(packId:\s*"preview"\s*\|\s*"transcode"\)/);
  assert.doesNotMatch(ipc, /mediaPackInstall:[^\r\n]*(?:url|publicKey|signature)/i);
  assert.match(view, /window\.confirm/);
  assert.match(view, /media-pack-progress/);
  assert.match(view, /media-pack-done/);
});
