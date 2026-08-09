import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildMediaRuntimeManifest } from "./release-metadata-media.mjs";
import { buildMediaPackSigningStatement, serializeMediaPackSigningStatement } from "./media-pack-signing.mjs";

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const candidateLockPath = path.join(scriptRoot, "media-runtimes.v2.candidate.lock.json");

function execFileClosedStdin(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout: 15_000, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin.end();
  });
}

async function createFixture(root) {
  const binaries = path.join(root, "binaries");
  await mkdir(binaries);
  const facts = new Map();
  const checksumLines = [];
  for (const name of ["ffmpeg.exe", "ffprobe.exe", "mpv.exe"]) {
    const bytes = Buffer.from(`install-fixture:${name}\n`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(path.join(binaries, name), bytes);
    facts.set(name, { sha256, sizeBytes: bytes.length });
    checksumLines.push(`${sha256}  ${name}`);
  }
  await writeFile(path.join(binaries, "CHECKSUMS.txt"), `${checksumLines.join("\n")}\n`, "ascii");
  const lock = JSON.parse(await readFile(candidateLockPath, "utf8"));
  for (const archive of lock.archives) {
    for (const extract of archive.extracts) {
      const fact = facts.get(extract.targetName);
      extract.extractedSha256 = fact.sha256;
      extract.sizeBytes = fact.sizeBytes;
    }
  }
  const lockPath = path.join(root, "fixture.lock.json");
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  const runtime = await buildMediaRuntimeManifest(lockPath, binaries);
  assert.equal(runtime.components.length, 3);
  return { binaries, facts, lock, lockPath };
}

async function buildSignedPreview({ root, label, baseLock, binaries, sourceAssetPath, privateKey, minimumUsefulVersion }) {
  const lock = structuredClone(baseLock);
  lock.packs.find((pack) => pack.id === "preview").minimumUsefulVersion = minimumUsefulVersion;
  const lockPath = path.join(root, `fixture-${label}.lock.json`);
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  const packageOutput = path.join(root, `package-output-${label}`);
  await mkdir(packageOutput);
  await execFileClosedStdin("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", path.join(scriptRoot, "package-media-packs.ps1"),
    "-LockPath", lockPath,
    "-BinariesDir", binaries,
    "-OutDir", packageOutput,
  ], { windowsHide: true });
  const manifestPath = path.join(packageOutput, "MEDIA-PACK-preview.unsigned-candidate.json");
  const archivePath = path.join(packageOutput, "Useful-Media-Pack-preview-windows-x64-unsigned-candidate.zip");
  const statementPath = path.join(root, `MEDIA-PACK-SIGNING-${label}.json`);
  const statement = await buildMediaPackSigningStatement(manifestPath, archivePath, sourceAssetPath);
  await writeFile(statementPath, serializeMediaPackSigningStatement(statement));
  const signatureHex = sign(null, await readFile(statementPath), privateKey).toString("hex");
  return { archivePath, lockPath, manifestPath, signatureHex, statementPath };
}

test("offline import verifies signature/source/lock/ZIP and atomically activates one pack", async () => {
  if (process.platform !== "win32") return;
  const root = await mkdtemp(path.join(os.tmpdir(), "useful-media-pack-install-"));
  try {
    const { binaries, facts, lock } = await createFixture(root);
    const installRoot = path.join(root, "installed");
    const sourceAssetPath = path.join(root, "Useful-Media-Sources-preview.zip");
    await writeFile(sourceAssetPath, "GPL corresponding source fixture\n");
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const spki = publicKey.export({ format: "der", type: "spki" });
    const publicKeyHex = spki.subarray(spki.length - 32).toString("hex");

    const buildVersion = (label, minimumUsefulVersion) => buildSignedPreview({
      root, label, baseLock: lock, binaries, sourceAssetPath, privateKey, minimumUsefulVersion,
    });
    const installArgs = (candidate, currentUsefulVersion, destination = installRoot) => [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", path.join(scriptRoot, "install-media-pack.ps1"),
      "-ArchivePath", candidate.archivePath,
      "-ManifestPath", candidate.manifestPath,
      "-StatementPath", candidate.statementPath,
      "-SignatureHex", candidate.signatureHex,
      "-PublicKeyHex", publicKeyHex,
      "-SourceAssetPath", sourceAssetPath,
      "-LockPath", candidate.lockPath,
      "-InstallRoot", destination,
      "-CurrentUsefulVersion", currentUsefulVersion,
    ];

    const first = await buildVersion("v1", "0.1.0-beta.1");
    const firstArgs = installArgs(first, "0.1.0-beta.1");
    await execFileClosedStdin("powershell.exe", firstArgs, { windowsHide: true });
    const firstManifest = JSON.parse(await readFile(first.manifestPath, "utf8"));
    const target = path.join(installRoot, firstManifest.runtimeLockSha256, "preview");
    assert.deepEqual((await readdir(target)).sort(), [
      "INSTALLED.json",
      "MEDIA-PACK-SIGNATURE.hex",
      "MEDIA-PACK-SIGNING.json",
      "MEDIA-PACK.json",
      "UNSIGNED-CANDIDATE.txt",
      "mpv.exe",
    ].sort());
    assert.equal(createHash("sha256").update(await readFile(path.join(target, "mpv.exe"))).digest("hex"), facts.get("mpv.exe").sha256);
    const firstCurrent = JSON.parse(await readFile(path.join(installRoot, "current-preview.json"), "utf8"));
    assert.equal(firstCurrent.relativePath, `${firstManifest.runtimeLockSha256}/preview`);
    assert.ok(!(await readdir(installRoot)).some((name) => name.startsWith(".staging-")));

    const second = await buildVersion("v2", "0.1.0-beta.2");
    await execFileClosedStdin("powershell.exe", installArgs(second, "0.1.0-beta.2"), { windowsHide: true });
    const secondManifest = JSON.parse(await readFile(second.manifestPath, "utf8"));
    const secondCurrent = JSON.parse(await readFile(path.join(installRoot, "current-preview.json"), "utf8"));
    const secondPrevious = JSON.parse(await readFile(path.join(installRoot, "current-preview.previous.json"), "utf8"));
    assert.equal(secondCurrent.relativePath, `${secondManifest.runtimeLockSha256}/preview`);
    assert.equal(secondPrevious.relativePath, `${firstManifest.runtimeLockSha256}/preview`);

    const third = await buildVersion("v3", "0.1.0-beta.3");
    const thirdArgs = installArgs(third, "0.1.0-beta.3");
    await execFileClosedStdin("powershell.exe", thirdArgs, { windowsHide: true });
    const thirdManifest = JSON.parse(await readFile(third.manifestPath, "utf8"));
    const thirdCurrent = JSON.parse(await readFile(path.join(installRoot, "current-preview.json"), "utf8"));
    const thirdPrevious = JSON.parse(await readFile(path.join(installRoot, "current-preview.previous.json"), "utf8"));
    assert.equal(thirdCurrent.relativePath, `${thirdManifest.runtimeLockSha256}/preview`);
    assert.equal(thirdPrevious.relativePath, `${secondManifest.runtimeLockSha256}/preview`);
    for (const manifest of [firstManifest, secondManifest, thirdManifest]) {
      assert.ok((await readdir(path.join(installRoot, manifest.runtimeLockSha256, "preview"))).includes("INSTALLED.json"));
    }

    await assert.rejects(() => execFileClosedStdin("powershell.exe", thirdArgs, { windowsHide: true }), /overwrite existing media runtime path/i);

    const badRoot = path.join(root, "bad-install");
    const badArgs = installArgs(first, "0.1.0-beta.1", badRoot);
    const signatureIndex = badArgs.indexOf("-SignatureHex") + 1;
    badArgs[signatureIndex] = `${first.signatureHex[0] === "0" ? "1" : "0"}${first.signatureHex.slice(1)}`;
    await assert.rejects(() => execFileClosedStdin("powershell.exe", badArgs, { windowsHide: true }), /signature|签名/i);
    await assert.rejects(() => readdir(badRoot), /ENOENT/);

    const olderRoot = path.join(root, "older-install");
    const olderArgs = installArgs(first, "0.1.0-beta.0", olderRoot);
    await assert.rejects(() => execFileClosedStdin("powershell.exe", olderArgs, { windowsHide: true }), /older than media pack minimum/i);
    await assert.rejects(() => readdir(olderRoot), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installer has no embedded key, no PATH fallback, and never removes prior versions", async () => {
  const source = await readFile(path.join(scriptRoot, "install-media-pack.ps1"), "utf8");
  assert.match(source, /Parameter\(Mandatory = \$true\).*\$PublicKeyHex/);
  assert.match(source, /media-pack-signing\.mjs/);
  assert.match(source, /--locked-manifest/);
  assert.match(source, /\[IO\.File\]::Replace/);
  assert.match(source, /current-\$packId\.previous\.json/);
  assert.doesNotMatch(source, /Remove-Item|\$env:PATH|--private-key|\$PrivateKey/i);
});
