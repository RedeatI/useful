import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildMediaRuntimeManifest,
  readMediaRuntimeLock,
  runCli,
  validateMediaRuntimeLock,
  validateMediaRuntimeManifest,
} from "./release-metadata-media.mjs";

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const lockPath = path.join(scriptRoot, "media-runtimes.lock.json");
const v2CandidateLockPath = path.join(scriptRoot, "media-runtimes.v2.candidate.lock.json");

test("machine-readable lock preserves every legacy media pin and extraction mapping", async () => {
  const lock = await readMediaRuntimeLock(lockPath);
  assert.deepEqual(lock.archives, [
    {
      id: "ffmpeg-full-build",
      name: "ffmpeg 8.1.2 full_build (GPLv3)",
      version: "8.1.2",
      license: "GPLv3",
      sourceUrl: "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-full_build.7z",
      archiveSha256: "0fff188997a499b5382e0f66e845d4556c48c54f0113ebed4853d556dbdd7059",
      extracts: [
        { component: "ffmpeg", sourcePath: "ffmpeg-8.1.2-full_build/bin/ffmpeg.exe", targetName: "ffmpeg.exe" },
        { component: "ffprobe", sourcePath: "ffmpeg-8.1.2-full_build/bin/ffprobe.exe", targetName: "ffprobe.exe" },
      ],
    },
    {
      id: "mpv",
      name: "mpv 20260610-git-304426c (GPLv2+)",
      version: "20260610-git-304426c",
      license: "GPLv2+",
      sourceUrl: "https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/20260610/mpv-x86_64-20260610-git-304426c.7z",
      archiveSha256: "facac536baa73c7b925771af5e39a3c9cb16b8d75b59a6e9800de89799dffca7",
      extracts: [{ component: "mpv", sourcePath: "mpv.exe", targetName: "mpv.exe" }],
    },
  ]);
});

test("media source paths reject cross-platform absolute and ambiguous segments", async () => {
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  const unsafe = [
    "C:\\runtime\\ffmpeg.exe",
    "C:runtime\\ffmpeg.exe",
    "\\\\server\\share\\ffmpeg.exe",
    "/runtime/ffmpeg.exe",
    "runtime/./ffmpeg.exe",
    "runtime/../ffmpeg.exe",
    "runtime//ffmpeg.exe",
  ];
  for (const sourcePath of unsafe) {
    const candidate = structuredClone(lock);
    candidate.archives[0].extracts[0].sourcePath = sourcePath;
    assert.throws(() => validateMediaRuntimeLock(candidate), /sourcePath/);
  }
});

test("v2 candidate lock splits preview and transcode without changing archive pins", async () => {
  const [production, candidate] = await Promise.all([
    readMediaRuntimeLock(lockPath),
    readMediaRuntimeLock(v2CandidateLockPath),
  ]);
  assert.equal(production.schemaVersion, "useful.media-runtimes-lock.v1");
  assert.equal(candidate.schemaVersion, "useful.media-runtimes-lock.v2");
  const candidateArchivePins = candidate.archives.map((archive) => ({
    ...archive,
    extracts: archive.extracts.map(({ extractedSha256: _sha, sizeBytes: _size, ...extract }) => extract),
  }));
  assert.deepEqual(candidateArchivePins, production.archives);
  assert.ok(candidate.components.every(({ extractedSha256, sizeBytes }) => (
    /^[0-9a-f]{64}$/.test(extractedSha256) && Number.isSafeInteger(sizeBytes) && sizeBytes > 0
  )));
  assert.deepEqual(candidate.packs, [
    { id: "preview", minimumUsefulVersion: "0.1.0-beta.1", components: ["mpv"] },
    { id: "transcode", minimumUsefulVersion: "0.1.0-beta.1", components: ["ffmpeg", "ffprobe"] },
  ]);

  const duplicate = JSON.parse(await readFile(v2CandidateLockPath, "utf8"));
  duplicate.packs[1].components.push("mpv");
  assert.throws(() => validateMediaRuntimeLock(duplicate), /重复声明/);
  const missing = JSON.parse(await readFile(v2CandidateLockPath, "utf8"));
  missing.packs[0].components = [];
  assert.throws(() => validateMediaRuntimeLock(missing), /不能为空/);
});

test("public media manifest is deterministic and bound to exact extracted bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "useful-media-runtimes-"));
  try {
    const binaries = path.join(root, "binaries");
    await mkdir(binaries);
    const checksumLines = [];
    for (const name of ["ffmpeg.exe", "ffprobe.exe", "mpv.exe"]) {
      const bytes = Buffer.from(`fixture:${name}\n`);
      await writeFile(path.join(binaries, name), bytes);
      checksumLines.push(`${createHash("sha256").update(bytes).digest("hex")}  ${name}`);
    }
    await writeFile(path.join(binaries, "CHECKSUMS.txt"), `${checksumLines.join("\n")}\n`, "ascii");
    const first = await buildMediaRuntimeManifest(lockPath, binaries);
    const output = path.join(root, "MEDIA-RUNTIMES.json");
    const second = await runCli(["--lock", lockPath, "--binaries", binaries, "--output", output]);
    assert.deepEqual(second, first);
    assert.equal(await readFile(output, "utf8"), `${JSON.stringify(first, null, 2)}\n`);
    assert.deepEqual(first.components.map(({ name }) => name), ["ffmpeg", "ffprobe", "mpv"]);
    assert.ok(first.components.every(({ extractedSha256, sizeBytes }) => /^[0-9a-f]{64}$/.test(extractedSha256) && sizeBytes > 0));
    assert.deepEqual(await validateMediaRuntimeManifest(output, lockPath), first);
    await assert.rejects(
      () => runCli(["--lock", lockPath, "--binaries", binaries, "--output", output]),
      /覆盖|exist/i,
    );
    await assert.rejects(() => runCli(["--unknown", "value"]), /未知参数/);
    await assert.rejects(() => runCli(["--lock", lockPath, "--lock", lockPath, "--manifest", output]), /重复参数/);
    await writeFile(path.join(binaries, "unexpected.dll"), "unexpected\n");
    await assert.rejects(() => buildMediaRuntimeManifest(lockPath, binaries), /条目集合不闭合/);
    await rm(path.join(binaries, "unexpected.dll"));
    const linkedBinaries = path.join(root, "linked-binaries");
    await symlink(binaries, linkedBinaries, "junction");
    await assert.rejects(() => buildMediaRuntimeManifest(lockPath, linkedBinaries), /symlink|junction/);
    const realOutputDirectory = path.join(root, "real-output");
    const linkedOutputDirectory = path.join(root, "linked-output");
    await mkdir(realOutputDirectory);
    await symlink(realOutputDirectory, linkedOutputDirectory, "junction");
    await assert.rejects(() => runCli([
      "--lock", lockPath,
      "--binaries", binaries,
      "--output", path.join(linkedOutputDirectory, "MEDIA-RUNTIMES.json"),
    ]), /symlink|junction/);
    const drifted = structuredClone(first);
    drifted.components[0].version = "9.9.9";
    await writeFile(output, `${JSON.stringify(drifted)}\n`);
    await assert.rejects(() => validateMediaRuntimeManifest(output, lockPath), /锁定清单/);
    await writeFile(path.join(binaries, "mpv.exe"), "tampered\n");
    await assert.rejects(() => buildMediaRuntimeManifest(lockPath, binaries), /CHECKSUMS/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
