import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  aggregateSigningStatus,
  expectedReleaseAssets,
  runCli,
  validateSigningStatusFile,
} from "./release-signing-status.mjs";

const VERSION = "0.1.0-beta.1";

test("Windows release manifest distinguishes Setup Lite and both portable editions", () => {
  assert.deepEqual(expectedReleaseAssets(VERSION).get("windows/x64"), [
    `Useful-${VERSION}-windows-x64-setup-lite.exe`,
    `Useful-${VERSION}-windows-x64-portable-lite.zip`,
    `Useful-${VERSION}-windows-x64-portable-full.zip`,
    "MEDIA-RUNTIMES.json",
  ]);
});

async function fixture(overrides = {}, scope = "desktop-full") {
  const root = await mkdtemp(path.join(os.tmpdir(), "useful-signing-status-"));
  const entries = {
    "windows-x64": { platform: "windows", arch: "x64", version: VERSION, signingStatus: "verified", verification: "Get-AuthenticodeSignature=Valid" },
    "macos-x64": { platform: "macos", arch: "x64", version: VERSION, signingStatus: "verified", verification: "codesign=valid;notarization-ticket=valid" },
    "macos-arm64": { platform: "macos", arch: "arm64", version: VERSION, signingStatus: "verified", verification: "codesign=valid;notarization-ticket=valid" },
    "linux-x64": { platform: "linux", arch: "x64", version: VERSION, signingStatus: "not-applicable", verification: "not-applicable" },
    ...overrides,
  };
  await mkdir(path.join(root, "nested"));
  await mkdir(path.join(root, "nested", "release-assets"));
  const allowedReceipts = scope === "desktop-lite" ? new Set(["windows-x64"]) : new Set(Object.keys(entries));
  for (const [name, entry] of Object.entries(entries)) {
    if (!allowedReceipts.has(name)) continue;
    if (entry === null) continue;
    await writeFile(path.join(root, "nested", `signing-${name}.json`), JSON.stringify(entry), "utf8");
  }
  const agentZip = `Useful-${VERSION}-agent-kit.zip`;
  const agentReceipt = `${agentZip}.sha256`;
  for (const name of [...expectedReleaseAssets(VERSION, scope).values()].flat().filter((name) => name !== agentReceipt)) {
    await writeFile(path.join(root, "nested", "release-assets", name), `${name}\n`, "utf8");
  }
  const agentZipBytes = await readFile(path.join(root, "nested", "release-assets", agentZip));
  await writeFile(
    path.join(root, "nested", "release-assets", agentReceipt),
    `${createHash("sha256").update(agentZipBytes).digest("hex")}  ${agentZip}\n`,
    "utf8",
  );
  return root;
}

async function withFixture(overrides, callback, scope = "desktop-full") {
  const root = await fixture(overrides, scope);
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("exact cross-platform signing receipts aggregate deterministically", async () => {
  await withFixture({}, async (root) => {
    const result = await aggregateSigningStatus(root, VERSION);
    assert.equal(result.signed, true);
    assert.deepEqual(result.platforms.map(({ platform, arch }) => `${platform}/${arch}`), [
      "windows/x64", "macos/x64", "macos/arm64", "linux/x64",
    ]);
    assert.deepEqual(result.artifacts.map(({ name }) => name), [...expectedReleaseAssets(VERSION).values()].flat());
    assert.ok(result.artifacts.every(({ sha256, sizeBytes }) => /^[0-9a-f]{64}$/.test(sha256) && sizeBytes > 0));
    assert.deepEqual(result.nonCodeSignedArtifacts, [{
      kind: "agent-kit",
      codeSigning: "not-applicable",
      integrity: "sha256+closed-manifest+build-provenance",
      artifacts: expectedReleaseAssets(VERSION).get("agent-kit/n-a").map((name) => result.artifacts.find((artifact) => artifact.name === name)),
    }]);
  });
});

test("signing CLI rejects unknown or duplicate options and never overwrites output", async () => {
  await assert.rejects(() => runCli(["--unknown", "value"], {}), /未知参数/);
  await assert.rejects(() => runCli(["--version", VERSION, "--version", VERSION], {}), /重复参数/);
  await withFixture({}, async (root) => {
    const output = path.join(root, "SIGNING-STATUS.json");
    const args = ["--root", root, "--version", VERSION, "--scope", "desktop-full", "--output", output];
    await runCli(args, {});
    const first = await readFile(output, "utf8");
    await assert.rejects(() => runCli(args, {}), /EEXIST|exist|拒绝覆盖/i);
    assert.equal(await readFile(output, "utf8"), first);
  });
});
test("unsigned beta receipts remain explicit and cannot become signed", async () => {
  await withFixture({
    "windows-x64": { platform: "windows", arch: "x64", version: VERSION, signingStatus: "unsigned", verification: "not-performed" },
  }, async (root) => {
    assert.equal((await aggregateSigningStatus(root, VERSION)).signed, false);
  });
});

test("missing, duplicate, and unknown platform receipts fail closed", async () => {
  await withFixture({ "linux-x64": null }, async (root) => {
    await assert.rejects(() => aggregateSigningStatus(root, VERSION), /数量不符/);
  });
  await withFixture({
    "extra-x64": { platform: "windows", arch: "x64", version: VERSION, signingStatus: "verified", verification: "Get-AuthenticodeSignature=Valid" },
  }, async (root) => {
    await assert.rejects(() => aggregateSigningStatus(root, VERSION), /数量不符|重复/);
  });
});

test("version, schema, and verification drift fail closed", async () => {
  await withFixture({
    "macos-arm64": { platform: "macos", arch: "arm64", version: "9.9.9", signingStatus: "verified", verification: "codesign=valid;notarization-ticket=valid" },
  }, async (root) => {
    await assert.rejects(() => aggregateSigningStatus(root, VERSION), /version/);
  });
  await withFixture({
    "windows-x64": { platform: "windows", arch: "x64", version: VERSION, signingStatus: "verified", verification: "not-performed" },
  }, async (root) => {
    await assert.rejects(() => aggregateSigningStatus(root, VERSION), /验证收据/);
  });
  await withFixture({
    "linux-x64": { platform: "linux", arch: "x64", version: VERSION, signingStatus: "not-applicable", verification: "not-applicable", extra: true },
  }, async (root) => {
    await assert.rejects(() => aggregateSigningStatus(root, VERSION), /闭合 schema/);
  });
});

test("published signing summary is closed and bound to exact candidate asset bytes", async () => {
  await withFixture({}, async (root) => {
    const statusPath = path.join(root, "SIGNING-STATUS.json");
    const summary = await aggregateSigningStatus(root, VERSION);
    await writeFile(statusPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    assert.deepEqual(await validateSigningStatusFile(statusPath, path.join(root, "nested", "release-assets"), VERSION), summary);
    assert.deepEqual(await runCli([
      "--status", statusPath,
      "--asset-root", path.join(root, "nested", "release-assets"),
      "--version", VERSION,
      "--scope", "desktop-full",
    ], {}), summary);

    const firstAsset = summary.artifacts[0].name;
    await writeFile(path.join(root, "nested", "release-assets", firstAsset), "tampered\n", "utf8");
    await assert.rejects(
      () => validateSigningStatusFile(statusPath, path.join(root, "nested", "release-assets"), VERSION),
      /artifact digest 不匹配|artifact manifest 不匹配/,
    );
  });
});

test("desktop-lite signing evidence closes over Windows Lite and Agent Kit assets only", async () => {
  await withFixture({}, async (root) => {
    const result = await aggregateSigningStatus(root, VERSION, "desktop-lite");
    assert.equal(result.scope, "desktop-lite");
    assert.deepEqual(result.platforms.map(({ platform, arch }) => `${platform}/${arch}`), ["windows/x64"]);
    assert.deepEqual(
      result.artifacts.map(({ name }) => name),
      [...expectedReleaseAssets(VERSION, "desktop-lite").values()].flat(),
    );
    assert.ok(result.artifacts.every(({ name }) => !name.includes("portable-full") && !name.includes("macos") && !name.includes("linux")));
  }, "desktop-lite");
});

test("published signing summary rejects version, cardinality, and status drift", async () => {
  await withFixture({}, async (root) => {
    const statusPath = path.join(root, "SIGNING-STATUS.json");
    const summary = await aggregateSigningStatus(root, VERSION);
    for (const mutate of [
      (value) => { value.version = "9.9.9"; },
      (value) => { value.platforms.pop(); },
      (value) => { value.signed = false; },
      (value) => { value.nonCodeSignedArtifacts[0].codeSigning = "verified"; },
      (value) => { value.extra = true; },
    ]) {
      const candidate = structuredClone(summary);
      mutate(candidate);
      await writeFile(statusPath, `${JSON.stringify(candidate)}\n`, "utf8");
      await assert.rejects(
        () => validateSigningStatusFile(statusPath, path.join(root, "nested", "release-assets"), VERSION),
        /version|数量|signed|闭合 schema|Agent Kit/,
      );
    }
  });
});
