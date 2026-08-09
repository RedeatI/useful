import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildReleaseMetadata,
  expectedTag,
  runCli,
  validateReleaseIdentity,
} from "./release-metadata.mjs";

test("stable requires the exact tag, readiness gate, and verified signing", () => {
  assert.equal(expectedTag("1.2.3"), "v1.2.3");
  assert.throws(
    () => validateReleaseIdentity({
      version: "1.2.3",
      tag: "v1.2.4",
      channel: "stable",
      signingReady: true,
    }),
    /tag.*严格一致/,
  );
  assert.throws(
    () => validateReleaseIdentity({
      version: "1.2.3",
      tag: "v1.2.3",
      channel: "stable",
      signingReady: false,
    }),
    /USEFUL_SIGNING_READY=true/,
  );
  assert.throws(
    () => buildReleaseMetadata({
      version: "1.2.3",
      tag: "v1.2.3",
      channel: "stable",
      signingReady: true,
      signingStatus: "unsigned",
    }),
    /签名.*公证.*验证/,
  );
});
test("version prerelease and requested channel cannot drift", () => {
  assert.throws(
    () => validateReleaseIdentity({
      version: "1.2.3-beta.4",
      tag: "v1.2.3-beta.4",
      channel: "nightly",
      signingReady: false,
    }),
    /nightly 版本必须/,
  );
  assert.throws(
    () => validateReleaseIdentity({
      version: "1.2.3-rc.1",
      tag: "v1.2.3-rc.1",
      channel: "beta",
      signingReady: false,
    }),
    /beta 版本必须/,
  );
});

test("unsigned beta and nightly are explicitly marked preview", () => {
  for (const [version, channel] of [
    ["1.2.3-beta.4", "beta"],
    ["1.2.3-nightly.20260803.1", "nightly"],
  ]) {
    const metadata = buildReleaseMetadata({
      version,
      tag: `v${version}`,
      channel,
      signingReady: false,
      signingStatus: "unsigned",
    });
    assert.equal(metadata.prerelease, true);
    assert.equal(metadata.unsignedPreview, true);
    assert.match(metadata.releaseName, /UNSIGNED PREVIEW/);
    assert.match(metadata.warning, /^UNSIGNED PREVIEW:/);
  }
});

test("signed stable metadata is a latest non-prerelease", () => {
  const metadata = buildReleaseMetadata({
    version: "2.0.0",
    tag: "v2.0.0",
    channel: "stable",
    signingReady: true,
    signingStatus: "signed",
  });
  assert.equal(metadata.releaseName, "Useful v2.0.0");
  assert.equal(metadata.prerelease, false);
  assert.equal(metadata.makeLatest, true);
  assert.equal(metadata.warning, null);
});

test("stable, beta, and nightly metadata is deterministic for an exact identity", () => {
  for (const [version, channel, signingReady, signingStatus] of [
    ["2.1.0", "stable", true, "signed"],
    ["2.1.0-beta.7", "beta", false, "unsigned"],
    ["2.1.0-nightly.20260803.4", "nightly", false, "unsigned"],
  ]) {
    const input = { version, tag: `v${version}`, channel, signingReady, signingStatus };
    const first = buildReleaseMetadata(input);
    const second = buildReleaseMetadata(structuredClone(input));
    assert.deepEqual(second, first);
    assert.equal(Object.prototype.hasOwnProperty.call(first, "generatedAt"), false);
    assert.equal(first.makeLatest, channel === "stable");
    assert.equal(first.prerelease, channel !== "stable");
  }
});

test("CLI reads the package version and writes GitHub outputs", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "useful-release-metadata-"));
  const packagePath = path.join(directory, "package.json");
  const outputPath = path.join(directory, "github-output.txt");
  await writeFile(packagePath, '{"version":"3.0.0-beta.2"}\n');

  const metadata = await runCli([
    "--package", packagePath,
    "--tag", "v3.0.0-beta.2",
    "--channel", "beta",
    "--signing-ready", "false",
    "--signing-status", "unsigned",
    "--github-output", outputPath,
  ]);
  const output = await readFile(outputPath, "utf8");
  assert.equal(metadata.version, "3.0.0-beta.2");
  assert.match(output, /^release_name=Useful v3\.0\.0-beta\.2 Beta — UNSIGNED PREVIEW$/m);
  assert.match(output, /^metadata_json=\{"schemaVersion":"useful\.release-metadata\.v1"/m);
});

test("identity-only CLI output does not invent signing metadata", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "useful-release-identity-"));
  const packagePath = path.join(directory, "package.json");
  const outputPath = path.join(directory, "github-output.txt");
  await writeFile(packagePath, '{"version":"4.0.0-nightly.20260803.2"}\n');

  await runCli([
    "--package", packagePath,
    "--tag", "v4.0.0-nightly.20260803.2",
    "--channel", "nightly",
    "--signing-ready", "false",
    "--identity-only",
    "--github-output", outputPath,
  ]);
  const output = await readFile(outputPath, "utf8");
  assert.doesNotMatch(output, /undefined/);
  assert.doesNotMatch(output, /^signed=/m);
});

test("metadata CLI rejects unknown, duplicate, and mode-incompatible options", async () => {
  await assert.rejects(() => runCli(["--unknown", "value"], {}), /未知参数/);
  await assert.rejects(() => runCli(["--package", "one", "--package", "two"], {}), /重复参数/);
  await assert.rejects(() => runCli([
    "--package", "package.json",
    "--tag", "v0.1.0-beta.1",
    "--channel", "beta",
    "--signing-ready", "false",
    "--identity-only",
    "--signing-status", "unsigned",
  ], {}), /不能与 --signing-status/);
});
