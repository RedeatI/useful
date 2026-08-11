import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  PUBLIC_SOURCE_POLICY_SCHEMA,
  REQUIRED_PUBLIC_FILES,
  comparePublicPaths,
  computeReceiptManifestSha256,
  sha256,
} from "./public-source-policy.mjs";

const canonicalTempRoot = realpathSync.native(tmpdir());
const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const verifierPath = path.join(scriptsDirectory, "verify-public-commit.mjs");
const AUTHORITY_CONDITION =
  "the transaction marker named by the successful CLI result is valid, has phase=complete, binds this receipt SHA-256, and its recorded file identities still match";

function git(root, args, { bytes = false } = {}) {
  const result = spawnSync("git", ["-c", `safe.directory=${root}`, ...args], {
    cwd: root,
    encoding: bytes ? null : "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, bytes ? result.stderr?.toString("utf8") : result.stderr);
  return result.stdout;
}

async function write(root, relative, contents) {
  const absolute = path.join(root, ...relative.split("/"));
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
}

function receiptSummary(receipt) {
  const totalBytes = receipt.files.reduce((sum, entry) => sum + entry.bytes, 0);
  const manifestSha256 = computeReceiptManifestSha256(receipt.files);
  return {
    fileCount: receipt.files.length,
    totalBytes,
    manifestSha256,
    snapshotSha256: sha256(
      `commit ${receipt.source.commit}\ntree ${receipt.source.tree}\npolicy ${PUBLIC_SOURCE_POLICY_SCHEMA}\nmanifest ${manifestSha256}\nfiles ${receipt.files.length}\nbytes ${totalBytes}\n`,
    ),
  };
}

async function makeRepository() {
  const container = await mkdtemp(path.join(canonicalTempRoot, "useful-public-commit-"));
  const root = path.join(container, "public");
  const receiptPath = path.join(container, "receipt.json");
  const markerPath = path.join(container, "transaction.json");
  await mkdir(root);
  for (const relative of REQUIRED_PUBLIC_FILES) {
    await write(root, relative, `${relative}\n`);
  }
  git(root, ["init", "--quiet"]);
  git(root, ["add", "."]);
  git(root, [
    "-c",
    "user.name=Useful Verification Test",
    "-c",
    "user.email=verification@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "public snapshot",
  ]);
  const commit = git(root, ["rev-parse", "HEAD"]).trim();
  const tree = git(root, ["rev-parse", "HEAD^{tree}"]).trim();
  const files = git(root, ["ls-tree", "-r", "-z", "--full-tree", "HEAD"])
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+) blob ([0-9a-f]+)\t([\s\S]+)$/.exec(line);
      assert.notEqual(match, null, line);
      const bytes = git(root, ["cat-file", "blob", match[2]], { bytes: true });
      return {
        path: match[3],
        bytes: bytes.length,
        mode: match[1],
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    });
  const receipt = {
    schemaVersion: "useful.public-source-receipt.v2",
    policySchemaVersion: PUBLIC_SOURCE_POLICY_SCHEMA,
    authoritative: true,
    authority: { protocol: "useful.public-source-transaction.v1", condition: AUTHORITY_CONDITION },
    source: { commit, tree },
    summary: null,
    gitIndexMode: {
      filesystemModeAuthoritative: false,
      applyFrom: "files[].mode",
      application: "after git add, apply --chmod=+x for 100755 and --chmod=-x for 100644 to each exact path",
      verification: "compare every committed Git tree path, mode, blob byte length, and SHA-256 with files[]",
    },
    files,
  };
  receipt.summary = receiptSummary(receipt);
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return { container, root, receiptPath, markerPath, receipt };
}

async function identity(absolute) {
  const info = await lstat(absolute, { bigint: true });
  return {
    absolute: path.resolve(absolute),
    canonical: await realpath(absolute),
    dev: info.dev.toString(),
    ino: info.ino.toString(),
    nlink: info.nlink.toString(),
    kind: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
  };
}

async function writeMarker(fixture, overrides = {}) {
  const receiptBytes = await readFile(fixture.receiptPath);
  const marker = {
    schemaVersion: "useful.public-source-transaction.v1",
    authoritative: true,
    phase: "complete",
    nonce: "synthetic-transaction",
    output: fixture.root,
    receipt: fixture.receiptPath,
    source: fixture.receipt.source,
    receiptSha256: sha256(receiptBytes),
    errorCode: null,
    identities: null,
    ...overrides,
  };
  await writeFile(fixture.markerPath, `${JSON.stringify(marker, null, 2)}\n`);
  marker.identities = {
    output: await identity(fixture.root),
    receipt: await identity(fixture.receiptPath),
    transactionMarker: await identity(fixture.markerPath),
  };
  await writeFile(fixture.markerPath, `${JSON.stringify(marker, null, 2)}\n`);
  return marker;
}

function runVerifier(fixture, { marker = true } = {}) {
  const args = [verifierPath, "--repo-root", fixture.root, "--receipt", fixture.receiptPath];
  if (marker) args.push("--transaction-marker", fixture.markerPath);
  args.push("--json");
  const result = spawnSync(process.execPath, args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { ...result, json: JSON.parse(result.stdout) };
}

async function rewriteReceipt(fixture, mutate, { recompute = false } = {}) {
  const receipt = structuredClone(fixture.receipt);
  mutate(receipt);
  receipt.files.sort((left, right) => comparePublicPaths(left.path, right.path));
  if (recompute) receipt.summary = receiptSummary(receipt);
  fixture.receipt = receipt;
  await writeFile(fixture.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
}

test("clean strict public HEAD exactly matching receipt and complete marker passes", async (t) => {
  const fixture = await makeRepository();
  t.after(() => rm(fixture.container, { recursive: true, force: true }));
  await writeMarker(fixture);
  const result = runVerifier(fixture, { marker: true });
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stderr, "");
  assert.equal(result.json.ok, true);
  assert.equal(result.json.authoritative, true);
  assert.equal(result.json.transactionMarkerVerified, true);
  assert.equal(result.json.initialCommitVerified, true);
  assert.equal(result.json.transactionMarkerSha256, sha256(await readFile(fixture.markerPath)));
  assert.equal(result.json.publicCommit, git(fixture.root, ["rev-parse", "HEAD"]).trim());
});

test("a receipt cannot be authoritative without its complete transaction marker", async (t) => {
  const fixture = await makeRepository();
  t.after(() => rm(fixture.container, { recursive: true, force: true }));
  const result = runVerifier(fixture, { marker: false });
  assert.notEqual(result.status, 0);
  assert.equal(result.json.error.code, "INVALID_ARGUMENTS");
});

test("a clean commit made after blob tampering cannot reuse the receipt", async (t) => {
  const fixture = await makeRepository();
  t.after(() => rm(fixture.container, { recursive: true, force: true }));
  await writeMarker(fixture);
  await write(fixture.root, "README.md", "# Useful changed after receipt\n");
  git(fixture.root, ["add", "README.md"]);
  git(fixture.root, [
    "-c",
    "user.name=Useful Verification Test",
    "-c",
    "user.email=verification@example.invalid",
    "commit",
    "--quiet",
    "--amend",
    "--no-edit",
  ]);
  const result = runVerifier(fixture);
  assert.notEqual(result.status, 0);
  assert.equal(result.json.error.code, "PUBLIC_COMMIT_RECEIPT_MISMATCH");
});

test("the public commit cannot retain parent history even when its tree matches the receipt", async (t) => {
  const fixture = await makeRepository();
  t.after(() => rm(fixture.container, { recursive: true, force: true }));
  await writeMarker(fixture);
  git(fixture.root, [
    "-c",
    "user.name=Useful Verification Test",
    "-c",
    "user.email=verification@example.invalid",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "same tree with private parent",
  ]);
  const result = runVerifier(fixture);
  assert.notEqual(result.status, 0);
  assert.equal(result.json.error.code, "PUBLIC_COMMIT_HAS_PARENTS");
});

test("committed mode and receipt path mismatches are rejected", async (t) => {
  await t.test("mode", async () => {
    const fixture = await makeRepository();
    t.after(() => rm(fixture.container, { recursive: true, force: true }));
    await writeMarker(fixture);
    git(fixture.root, ["update-index", "--chmod=+x", "--", "README.md"]);
    git(fixture.root, [
      "-c",
      "user.name=Useful Verification Test",
      "-c",
      "user.email=verification@example.invalid",
      "commit",
      "--quiet",
      "--amend",
      "--no-edit",
    ]);
    const result = runVerifier(fixture);
    assert.notEqual(result.status, 0);
    assert.equal(result.json.error.code, "PUBLIC_COMMIT_RECEIPT_MISMATCH");
  });

  await t.test("path", async () => {
    const fixture = await makeRepository();
    t.after(() => rm(fixture.container, { recursive: true, force: true }));
    await rewriteReceipt(
      fixture,
      (receipt) => {
        receipt.files.find((entry) => entry.path === "SECURITY.md").path = "docs/SECURITY-NOTE.md";
      },
      { recompute: true },
    );
    await writeMarker(fixture);
    const result = runVerifier(fixture);
    assert.notEqual(result.status, 0);
    assert.equal(result.json.error.code, "PUBLIC_COMMIT_RECEIPT_MISMATCH");
  });
});

test("receipt summary mismatch fails before public commit comparison", async (t) => {
  const fixture = await makeRepository();
  t.after(() => rm(fixture.container, { recursive: true, force: true }));
  await rewriteReceipt(fixture, (receipt) => {
    receipt.summary.fileCount += 1;
  });
  await writeMarker(fixture);
  const result = runVerifier(fixture);
  assert.notEqual(result.status, 0);
  assert.equal(result.json.error.code, "RECEIPT_SUMMARY_MISMATCH");
});

test("dirty public worktree and incomplete transaction marker fail closed", async (t) => {
  await t.test("dirty", async () => {
    const fixture = await makeRepository();
    t.after(() => rm(fixture.container, { recursive: true, force: true }));
    await writeMarker(fixture);
    await write(fixture.root, "README.md", "dirty checkout\n");
    const result = runVerifier(fixture);
    assert.notEqual(result.status, 0);
    assert.equal(result.json.error.code, "PUBLIC_REPO_DIRTY");
  });

  await t.test("incomplete marker", async () => {
    const fixture = await makeRepository();
    t.after(() => rm(fixture.container, { recursive: true, force: true }));
    await writeMarker(fixture, { authoritative: false, phase: "incomplete" });
    const result = runVerifier(fixture, { marker: true });
    assert.notEqual(result.status, 0);
    assert.equal(result.json.error.code, "TRANSACTION_MARKER_NOT_COMPLETE");
  });
});
