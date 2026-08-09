import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildMediaPackSigningStatement,
  runCli,
  serializeMediaPackSigningStatement,
  verifyMediaPackSigningStatement,
} from "./media-pack-signing.mjs";

function fixtureManifest() {
  return {
    schemaVersion: "useful.media-pack.v1",
    distributionStatus: "unsigned-candidate",
    signatureDomain: "useful-media-pack-v1",
    packId: "preview",
    platform: "windows",
    arch: "x64",
    runtimeLockSha256: "a".repeat(64),
    minimumUsefulVersion: "0.1.0-beta.1",
    correspondingSourceRequired: true,
    components: [{ name: "mpv" }],
  };
}

test("detached MediaPack statement binds archive, manifest, source asset, and independent Ed25519 key", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "useful-media-pack-signing-"));
  try {
    const manifestPath = path.join(root, "MEDIA-PACK.json");
    const archivePath = path.join(root, "Useful-Media-Pack-preview.zip");
    const statementPath = path.join(root, "MEDIA-PACK-SIGNING.json");
    const sourceAssetPath = path.join(root, "Useful-Media-Sources-preview.zip");
    await writeFile(manifestPath, `${JSON.stringify(fixtureManifest(), null, 2)}\n`);
    await writeFile(archivePath, "fixture archive bytes\n");
    await writeFile(sourceAssetPath, "corresponding source fixture\n");
    const statement = await buildMediaPackSigningStatement(
      manifestPath,
      archivePath,
      sourceAssetPath,
    );
    assert.equal(statement.packId, "preview");
    assert.equal(statement.correspondingSourceAssetId, "Useful-Media-Sources-preview.zip");
    assert.match(statement.correspondingSourceAssetSha256, /^[0-9a-f]{64}$/);
    assert.ok(statement.correspondingSourceAssetSizeBytes > 0);
    assert.match(statement.archiveSha256, /^[0-9a-f]{64}$/);
    assert.match(statement.manifestSha256, /^[0-9a-f]{64}$/);
    await writeFile(statementPath, serializeMediaPackSigningStatement(statement));

    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicSpki = publicKey.export({ format: "der", type: "spki" });
    const publicRawHex = publicSpki.subarray(publicSpki.length - 32).toString("hex");
    const signatureHex = sign(null, await readFile(statementPath), privateKey).toString("hex");
    assert.deepEqual(
      await verifyMediaPackSigningStatement(statementPath, signatureHex, publicRawHex),
      statement,
    );

    const wrongKey = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" });
    await assert.rejects(
      () => verifyMediaPackSigningStatement(
        statementPath,
        signatureHex,
        wrongKey.subarray(wrongKey.length - 32).toString("hex"),
      ),
      /签名验证失败/,
    );
    await assert.rejects(
      () => buildMediaPackSigningStatement(manifestPath, archivePath, path.join(root, "missing-source.zip")),
      /不存在/,
    );

    const cliOutput = path.join(root, "CLI-SIGNING.json");
    await runCli([
      "--manifest", manifestPath,
      "--archive", archivePath,
      "--source-asset", sourceAssetPath,
      "--output", cliOutput,
    ]);
    await assert.rejects(() => runCli([
      "--manifest", manifestPath,
      "--archive", archivePath,
      "--source-asset", sourceAssetPath,
      "--output", cliOutput,
    ]), /覆盖/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MediaPack signing tool contains verification only and no private-key ingestion", async () => {
  const source = await readFile(new URL("./media-pack-signing.mjs", import.meta.url), "utf8");
  assert.match(source, /verifySignature/);
  assert.match(source, /ED25519_SPKI_PREFIX/);
  assert.doesNotMatch(source, /--private-key|privateKey|createPrivateKey|["']--sign["']/);
});
