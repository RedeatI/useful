import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEVELOPMENT_UPDATE_ROOT_PUBKEY_HEX,
  runCli,
  validateReleasePublishGate,
} from "./release-publish-gate.mjs";

const productionRoot = "12".repeat(32);
const repositoryLockPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "media-runtimes.lock.json");
const valid = {
  repository: "example/useful",
  expectedRepository: "example/useful",
  visibility: "public",
  actor: "release-owner",
  allowedActors: "other-owner,release-owner",
  publish: false,
  scope: "desktop-full",
  channel: "beta",
  updateRootPublicKey: productionRoot,
  updateFeedUrlTemplate: "https://updates.example.org/useful/{channel}/{platform}-{arch}.json",
  rootCeremonySha256: "34".repeat(32),
};

async function createMediaComplianceFixture(root) {
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await mkdir(path.join(root, "compliance"), { recursive: true });
  const lockBytes = await readFile(repositoryLockPath);
  await writeFile(path.join(root, "scripts", "media-runtimes.lock.json"), lockBytes);
  const lock = JSON.parse(lockBytes.toString("utf8"));
  const components = [];
  for (const archive of lock.archives) {
    for (const extract of archive.extracts) {
      const makeAssets = async (kind) => {
        const relative = `compliance/${extract.component}-${kind}.txt`;
        const bytes = Buffer.from(`test fixture ${extract.component} ${kind}\n`);
        await writeFile(path.join(root, ...relative.split("/")), bytes);
        return [{
          path: relative,
          releaseAssetName: `Useful-media-${extract.component}-${kind}.txt`,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          sizeBytes: bytes.length,
        }];
      };
      components.push({
        name: extract.component,
        version: archive.version,
        binaryArchiveSha256: archive.archiveSha256,
        completeSourceAssets: await makeAssets("complete-source"),
        buildAssets: await makeAssets("build-config"),
        licenseAssets: await makeAssets("license"),
      });
    }
  }
  components.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const evidence = {
    schemaVersion: "useful.media-source-compliance-evidence.v1",
    mediaRuntimeLockSha256: createHash("sha256").update(lockBytes).digest("hex"),
    continuousAccessMethod: "github-release-assets",
    components,
  };
  const evidenceRelative = "compliance/media-source-evidence.json";
  const evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
  await writeFile(path.join(root, ...evidenceRelative.split("/")), evidenceBytes);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: root });
  execFileSync("git", ["add", "scripts/media-runtimes.lock.json", "compliance"], { cwd: root });
  execFileSync("git", ["-c", "user.name=Useful Tests", "-c", "user.email=tests@useful.invalid", "commit", "-qm", "fixture"], { cwd: root });
  return {
    path: evidenceRelative,
    sha256: createHash("sha256").update(evidenceBytes).digest("hex"),
  };
}

function baseCliArgs(root, publish, channel = "beta") {
  return [
    "--repository", "example/useful",
    "--expected-repository", "example/useful",
    "--visibility", "public",
    "--actor", "release-owner",
    "--allowed-actors", "release-owner",
    "--publish", String(publish),
    "--scope", "desktop-full",
    "--channel", channel,
    "--update-root-pubkey", productionRoot,
    "--update-feed-template", "https://updates.example.org/useful/{channel}/{platform}-{arch}.json",
    "--root-ceremony-sha256", "34".repeat(32),
    "--repo-root", root,
    "--stable-evidence-path", "",
    "--stable-evidence-sha256", "",
    "--media-source-evidence-path", "",
    "--media-source-evidence-sha256", "",
    "--tag", channel === "stable" ? "v1.2.3" : "v1.2.3-beta.1",
  ];
}

test("official candidate requires exact public repository, actor, and production update trust", () => {
  const result = validateReleasePublishGate(valid);
  assert.equal(result.ok, true);
  assert.equal(result.publish, false);
  assert.equal(result.updateRootPublicKey, productionRoot);
  assert.throws(() => validateReleasePublishGate({ ...valid, repository: "attacker/useful" }), /身份不匹配/);
  assert.throws(() => validateReleasePublishGate({ ...valid, visibility: "private" }), /public/);
  assert.throws(() => validateReleasePublishGate({ ...valid, actor: "release" }), /未获发布授权/);
});
test("development key and placeholder feed fail closed", () => {
  assert.throws(
    () => validateReleasePublishGate({ ...valid, updateRootPublicKey: DEVELOPMENT_UPDATE_ROOT_PUBKEY_HEX }),
    /开发占位/,
  );
  assert.throws(
    () => validateReleasePublishGate({ ...valid, updateFeedUrlTemplate: "https://update.useful.example/{channel}/{platform}-{arch}.json" }),
    /示例域名/,
  );
  assert.throws(
    () => validateReleasePublishGate({ ...valid, updateFeedUrlTemplate: "https://updates.example.org/{channel}.json" }),
    /platform/,
  );
  assert.throws(
    () => validateReleasePublishGate({ ...valid, updateFeedUrlTemplate: "https://release-user@updates.example.org/{channel}/{platform}-{arch}.json" }),
    /credentials/,
  );
  assert.throws(
    () => validateReleasePublishGate({ ...valid, updateFeedUrlTemplate: "https://:release-password@updates.example.org/{channel}/{platform}-{arch}.json" }),
    /credentials/,
  );
  assert.throws(
    () => validateReleasePublishGate({ ...valid, updateFeedUrlTemplate: "https://updates.example.org/{channel}/{platform}-{arch}.json#release" }),
    /fragment/,
  );
});

test("publish gate CLI rejects unknown and duplicate options before evaluating identity", async () => {
  await assert.rejects(() => runCli(["--unknown", "value"], {}), /未知参数/);
  await assert.rejects(() => runCli(["--repository", "one/repo", "--repository", "two/repo"], {}), /重复参数/);
});

test("Full candidate is explicit compliance-pending, while every public channel requires exact committed media source evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "useful-media-owner-gate-"));
  try {
    const candidate = await runCli(baseCliArgs(root, false), {});
    assert.equal(candidate.mediaSourceCompliance.status, "pending");
    assert.equal(candidate.mediaSourceCompliance.distribution, "NOT-FOR-PUBLIC-DISTRIBUTION");
    assert.match(candidate.mediaSourceCompliance.requiredActions.join("\n"), /RELEASE-ASSETS.*SHA256SUMS.*BUILD-PROVENANCE/);
    for (const channel of ["beta", "nightly"]) {
      await assert.rejects(() => runCli(baseCliArgs(root, true, channel), {}), /MEDIA_SOURCE_EVIDENCE_PATH|NOT-FOR-PUBLIC-DISTRIBUTION/);
    }

    const media = await createMediaComplianceFixture(root);
    const args = baseCliArgs(root, true, "beta").map((value, index, values) => {
      if (values[index - 1] === "--media-source-evidence-path") return media.path;
      if (values[index - 1] === "--media-source-evidence-sha256") return media.sha256;
      return value;
    });
    const publishable = await runCli(args, {});
    assert.equal(publishable.mediaSourceCompliance.status, "verified");
    assert.equal(publishable.mediaSourceCompliance.releaseAssets.length, 9);
    await writeFile(path.join(root, "compliance", "ffmpeg-license.txt"), "drifted\n");
    await assert.rejects(() => runCli(args, {}), /HEAD.*完全一致/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop-lite publish excludes media runtimes without weakening repository or actor gates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "useful-lite-owner-gate-"));
  try {
    const args = baseCliArgs(root, true).map((value, index, values) => (
      values[index - 1] === "--scope" ? "desktop-lite" : value
    ));
    const result = await runCli(args, {});
    assert.equal(result.scope, "desktop-lite");
    assert.deepEqual(result.mediaSourceCompliance, {
      status: "not-applicable",
      distribution: "NOT-INCLUDED",
      reason: "desktop-lite excludes Portable Full and all media runtime assets",
      requiredActions: [],
      evidence: null,
      releaseAssets: [],
    });
    await assert.rejects(
      () => runCli(args.map((value, index, values) => values[index - 1] === "--actor" ? "intruder" : value), {}),
      /未获发布授权/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stable publish requires a repository evidence file with matching digest and closed checks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "useful-stable-evidence-"));
  const media = await createMediaComplianceFixture(root);
  const directory = path.join(root, "docs", "releases");
  await mkdir(directory, { recursive: true });
  const evidencePath = path.join(directory, "v1.2.3-stable-evidence.json");
  const rootFingerprint = createHash("sha256").update(Buffer.from(productionRoot, "hex")).digest("hex");
  const evidence = {
    schemaVersion: "useful.stable-update-evidence.v1",
    tag: "v1.2.3",
    updateRootFingerprint: rootFingerprint,
    updateManifestSha256: "56".repeat(32),
    updateSignatureVerified: true,
    tamperRejected: true,
    upgradeVerified: true,
    rollbackVerified: true,
    approvedBy: "release-owner",
    approvedAt: "2026-08-03T00:00:00Z",
  };
  const bytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
  await writeFile(evidencePath, bytes);
  execFileSync("git", ["add", "docs/releases/v1.2.3-stable-evidence.json"], { cwd: root });
  execFileSync("git", ["-c", "user.name=Useful Tests", "-c", "user.email=tests@useful.invalid", "commit", "-qm", "stable evidence"], { cwd: root });
  const evidenceSha256 = createHash("sha256").update(bytes).digest("hex");
  const args = [
    "--repository", "example/useful",
    "--expected-repository", "example/useful",
    "--visibility", "public",
    "--actor", "release-owner",
    "--allowed-actors", "release-owner",
    "--publish", "true",
    "--scope", "desktop-full",
    "--channel", "stable",
    "--update-root-pubkey", productionRoot,
    "--update-feed-template", "https://updates.example.org/useful/{channel}/{platform}-{arch}.json",
    "--root-ceremony-sha256", "34".repeat(32),
    "--repo-root", root,
    "--stable-evidence-path", "docs/releases/v1.2.3-stable-evidence.json",
    "--stable-evidence-sha256", evidenceSha256,
    "--media-source-evidence-path", media.path,
    "--media-source-evidence-sha256", media.sha256,
    "--tag", "v1.2.3",
  ];
  const result = await runCli(args, {});
  assert.equal(result.stableEvidence.sha256, evidenceSha256);
  await assert.rejects(() => runCli(args.map((item) => item === evidenceSha256 ? "78".repeat(32) : item), {}), /SHA-256 不匹配/);
  const drifted = Buffer.from(`${JSON.stringify({ ...evidence, approvedBy: "different-owner" }, null, 2)}\n`);
  await writeFile(evidencePath, drifted);
  const driftedArgs = args.map((item) => item === evidenceSha256 ? createHash("sha256").update(drifted).digest("hex") : item);
  await assert.rejects(() => runCli(driftedArgs, {}), /HEAD.*完全一致/);
});

test("stable evidence rejects a symlink or junction in any intermediate path before reading", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "useful-stable-link-"));
  const outside = await mkdtemp(path.join(tmpdir(), "useful-stable-outside-"));
  try {
    const media = await createMediaComplianceFixture(root);
    await mkdir(path.join(root, "docs"));
    await mkdir(path.join(outside, "releases"));
    const evidencePath = path.join(outside, "releases", "v1.2.3-stable-evidence.json");
    const evidence = {
      schemaVersion: "useful.stable-update-evidence.v1",
      tag: "v1.2.3",
      updateRootFingerprint: createHash("sha256").update(Buffer.from(productionRoot, "hex")).digest("hex"),
      updateManifestSha256: "56".repeat(32),
      updateSignatureVerified: true,
      tamperRejected: true,
      upgradeVerified: true,
      rollbackVerified: true,
      approvedBy: "release-owner",
      approvedAt: "2026-08-03T00:00:00Z",
    };
    const bytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
    await writeFile(evidencePath, bytes);
    await symlink(path.join(outside, "releases"), path.join(root, "docs", "releases"), "junction");
    await assert.rejects(() => runCli([
      "--repository", "example/useful",
      "--expected-repository", "example/useful",
      "--visibility", "public",
      "--actor", "release-owner",
      "--allowed-actors", "release-owner",
      "--publish", "true",
      "--scope", "desktop-full",
      "--channel", "stable",
      "--update-root-pubkey", productionRoot,
      "--update-feed-template", "https://updates.example.org/useful/{channel}/{platform}-{arch}.json",
      "--root-ceremony-sha256", "34".repeat(32),
      "--repo-root", root,
      "--stable-evidence-path", "docs/releases/v1.2.3-stable-evidence.json",
      "--stable-evidence-sha256", createHash("sha256").update(bytes).digest("hex"),
      "--media-source-evidence-path", media.path,
      "--media-source-evidence-sha256", media.sha256,
      "--tag", "v1.2.3",
    ], {}), /symlink|junction|中间路径/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
