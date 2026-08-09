import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildMediaPackCatalog,
  runCli,
  serializeMediaPackCatalog,
  verifyMediaPackCatalog,
} from "./media-pack-catalog.mjs";
import {
  buildMediaPackSigningStatement,
  serializeMediaPackSigningStatement,
} from "./media-pack-signing.mjs";

const VERIFY_UNIX = 1_900_000_000;
const FUTURE_UNIX = VERIFY_UNIX + 2_000_000;

function publicRawHex(publicKey) {
  const spki = publicKey.export({ format: "der", type: "spki" });
  return spki.subarray(spki.length - 32).toString("hex");
}

function manifest(packId, lock, runtimeLockSha256) {
  const pack = lock.packs.find(({ id }) => id === packId);
  const components = new Map();
  for (const archive of lock.archives) {
    for (const extract of archive.extracts) {
      components.set(extract.component, {
        name: extract.component,
        version: archive.version,
        sourceUrl: archive.sourceUrl,
        archiveSha256: archive.archiveSha256,
        extractedFile: extract.targetName,
        extractedSha256: extract.extractedSha256,
        sizeBytes: extract.sizeBytes,
        license: archive.license,
      });
    }
  }
  return {
    schemaVersion: "useful.media-pack.v1",
    distributionStatus: "unsigned-candidate",
    signatureDomain: "useful-media-pack-v1",
    packId,
    platform: "windows",
    arch: "x64",
    runtimeLockSha256,
    minimumUsefulVersion: pack.minimumUsefulVersion,
    correspondingSourceRequired: true,
    components: pack.components.map((name) => components.get(name)),
  };
}

async function createPackFixture(root, packId, privateKey, lock, runtimeLockSha256) {
  const directory = path.join(root, packId);
  await mkdir(directory);
  const archiveName = `Useful-Media-Pack-${packId}-windows-x64.zip`;
  const manifestName = `MEDIA-PACK-${packId}.json`;
  const statementName = `MEDIA-PACK-SIGNING-${packId}.json`;
  const sourceName = `Useful-Media-Sources-${packId}.zip`;
  const archivePath = path.join(directory, archiveName);
  const manifestPath = path.join(directory, manifestName);
  const statementPath = path.join(directory, statementName);
  const sourcePath = path.join(directory, sourceName);
  await writeFile(archivePath, `archive:${packId}\n`);
  await writeFile(manifestPath, `${JSON.stringify(manifest(packId, lock, runtimeLockSha256), null, 2)}\n`);
  await writeFile(sourcePath, `corresponding-source:${packId}\n`);
  const statement = await buildMediaPackSigningStatement(manifestPath, archivePath, sourcePath);
  const statementBytes = serializeMediaPackSigningStatement(statement);
  await writeFile(statementPath, statementBytes);
  return {
    id: packId,
    archive: { localPath: `${packId}/${archiveName}`, url: `https://media.example.test/${archiveName}` },
    manifest: { localPath: `${packId}/${manifestName}`, url: `https://media.example.test/${manifestName}` },
    statement: { localPath: `${packId}/${statementName}`, url: `https://media.example.test/${statementName}` },
    statementSignatureHex: sign(null, statementBytes, privateKey).toString("hex"),
    correspondingSource: { localPath: `${packId}/${sourceName}`, url: `https://source.example.test/${sourceName}` },
  };
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "useful-media-pack-catalog-"));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const lockBytes = await readFile(new URL("./media-runtimes.v2.candidate.lock.json", import.meta.url));
  const lock = JSON.parse(lockBytes.toString("utf8"));
  const runtimeLockSha256 = createHash("sha256").update(lockBytes).digest("hex");
  await writeFile(path.join(root, "media-runtimes.v2.lock.json"), lockBytes);
  const packs = [
    await createPackFixture(root, "transcode", privateKey, lock, runtimeLockSha256),
    await createPackFixture(root, "preview", privateKey, lock, runtimeLockSha256),
  ];
  const planPath = path.join(root, "catalog.plan.json");
  await writeFile(planPath, `${JSON.stringify({
    schemaVersion: "useful.media-pack-catalog-plan.v1",
    expiresAtUnix: FUTURE_UNIX,
    lockPath: "media-runtimes.v2.lock.json",
    packs,
  }, null, 2)}\n`);
  return { root, planPath, publicKey, privateKey };
}

test("catalog builder closes local assets, verifies statements, and emits deterministic pack order", async () => {
  const fixture = await createFixture();
  try {
    const publicKeyHex = publicRawHex(fixture.publicKey);
    const first = await buildMediaPackCatalog(fixture.planPath, publicKeyHex, VERIFY_UNIX);
    const second = await buildMediaPackCatalog(fixture.planPath, publicKeyHex, VERIFY_UNIX);
    assert.deepEqual(first, second);
    assert.deepEqual(first.packs.map(({ id }) => id), ["preview", "transcode"]);
    assert.equal(first.schemaVersion, "useful.media-pack-catalog.v1");
    for (const pack of first.packs) {
      assert.match(pack.archive.sha256, /^[0-9a-f]{64}$/);
      assert.ok(pack.archive.sizeBytes > 0);
      assert.match(pack.statementSignatureHex, /^[0-9a-f]{128}$/);
    }

    const catalogPath = path.join(fixture.root, "MEDIA-PACK-CATALOG.json");
    const bytes = serializeMediaPackCatalog(first, VERIFY_UNIX);
    await writeFile(catalogPath, bytes);
    const signatureHex = sign(null, bytes, fixture.privateKey).toString("hex");
    assert.deepEqual(
      await verifyMediaPackCatalog(catalogPath, signatureHex, publicKeyHex, VERIFY_UNIX),
      first,
    );

    const cliPlan = JSON.parse(await readFile(fixture.planPath, "utf8"));
    cliPlan.expiresAtUnix = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
    await writeFile(fixture.planPath, `${JSON.stringify(cliPlan, null, 2)}\n`);
    const cliPath = path.join(fixture.root, "MEDIA-PACK-CATALOG-CLI.json");
    await runCli(["--plan", fixture.planPath, "--public-key-hex", publicKeyHex, "--output", cliPath]);
    const cliBytes = await readFile(cliPath);
    const cliSignatureHex = sign(null, cliBytes, fixture.privateKey).toString("hex");
    await runCli([
      "--catalog", cliPath,
      "--signature-hex", cliSignatureHex,
      "--public-key-hex", publicKeyHex,
    ]);
    await assert.rejects(
      () => runCli(["--plan", fixture.planPath, "--public-key-hex", publicKeyHex, "--output", cliPath]),
      /覆盖/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("catalog verification rejects tampering, expiry, wrong keys, and non-canonical bytes", async () => {
  const fixture = await createFixture();
  try {
    const publicKeyHex = publicRawHex(fixture.publicKey);
    const catalog = await buildMediaPackCatalog(fixture.planPath, publicKeyHex, VERIFY_UNIX);
    const bytes = serializeMediaPackCatalog(catalog, VERIFY_UNIX);
    const signatureHex = sign(null, bytes, fixture.privateKey).toString("hex");
    const catalogPath = path.join(fixture.root, "catalog.json");
    await writeFile(catalogPath, bytes);

    await assert.rejects(
      () => verifyMediaPackCatalog(catalogPath, signatureHex, publicKeyHex, FUTURE_UNIX + 1),
      /过期/,
    );
    await assert.rejects(
      () => verifyMediaPackCatalog(catalogPath, signatureHex, publicKeyHex, VERIFY_UNIX - 1_000_000),
      /31 天/,
    );
    const wrongKey = generateKeyPairSync("ed25519").publicKey;
    await assert.rejects(
      () => verifyMediaPackCatalog(catalogPath, signatureHex, publicRawHex(wrongKey), VERIFY_UNIX),
      /签名验证失败/,
    );
    await writeFile(catalogPath, Buffer.concat([bytes, Buffer.from(" ")]));
    await assert.rejects(
      () => verifyMediaPackCatalog(catalogPath, signatureHex, publicKeyHex, VERIFY_UNIX),
      /规范 JSON 字节/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("catalog plans reject unsafe paths, insecure URLs, statement drift, and linked assets", async () => {
  const fixture = await createFixture();
  try {
    const publicKeyHex = publicRawHex(fixture.publicKey);
    const original = JSON.parse(await readFile(fixture.planPath, "utf8"));

    const insecure = structuredClone(original);
    insecure.packs[0].archive.url = insecure.packs[0].archive.url.replace("https:", "http:");
    await writeFile(fixture.planPath, `${JSON.stringify(insecure, null, 2)}\n`);
    await assert.rejects(() => buildMediaPackCatalog(fixture.planPath, publicKeyHex, VERIFY_UNIX), /HTTPS URL/);

    const escaped = structuredClone(original);
    escaped.packs[0].archive.localPath = `../${path.basename(escaped.packs[0].archive.localPath)}`;
    await writeFile(fixture.planPath, `${JSON.stringify(escaped, null, 2)}\n`);
    await assert.rejects(() => buildMediaPackCatalog(fixture.planPath, publicKeyHex, VERIFY_UNIX), /localPath/);

    const ambiguous = structuredClone(original);
    ambiguous.packs[0].archive.localPath = `preview:ads/${path.basename(ambiguous.packs[0].archive.localPath)}`;
    await writeFile(fixture.planPath, `${JSON.stringify(ambiguous, null, 2)}\n`);
    await assert.rejects(() => buildMediaPackCatalog(fixture.planPath, publicKeyHex, VERIFY_UNIX), /portable/);

    await writeFile(fixture.planPath, `${JSON.stringify(original, null, 2)}\n`);
    const preview = original.packs.find(({ id }) => id === "preview");
    const manifestPath = path.join(fixture.root, preview.manifest.localPath);
    const originalManifest = await readFile(manifestPath, "utf8");
    const driftedManifest = JSON.parse(originalManifest);
    driftedManifest.minimumUsefulVersion = "9.9.9";
    await writeFile(manifestPath, `${JSON.stringify(driftedManifest, null, 2)}\n`);
    await assert.rejects(
      () => buildMediaPackCatalog(fixture.planPath, publicKeyHex, VERIFY_UNIX),
      /v2 lock/,
    );
    await writeFile(manifestPath, originalManifest);

    await writeFile(path.join(fixture.root, preview.archive.localPath), "tampered archive\n");
    await assert.rejects(
      () => buildMediaPackCatalog(fixture.planPath, publicKeyHex, VERIFY_UNIX),
      /签名声明与 catalog 本地资产不一致/,
    );

    const linked = path.join(fixture.root, "linked-preview");
    await symlink(path.dirname(path.join(fixture.root, preview.archive.localPath)), linked, "junction");
    const linkedPlan = structuredClone(original);
    linkedPlan.packs.find(({ id }) => id === "preview").archive = {
      localPath: `linked-preview/${path.basename(preview.archive.localPath)}`,
      url: preview.archive.url,
    };
    await writeFile(fixture.planPath, `${JSON.stringify(linkedPlan, null, 2)}\n`);
    await assert.rejects(() => buildMediaPackCatalog(fixture.planPath, publicKeyHex, VERIFY_UNIX), /symlink|junction/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("catalog production tool has no private-key or signing entry point", async () => {
  const source = await readFile(new URL("./media-pack-catalog.mjs", import.meta.url), "utf8");
  assert.match(source, /verifySignature/);
  assert.doesNotMatch(source, /--private-key|privateKey|createPrivateKey|generateKeyPair|["']--sign["']/);
});
