import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  extractArchive,
  normalizeArchivePath,
  parseArguments,
} from "./accept-published-agent-kit.mjs";

const require = createRequire(import.meta.url);
const AdmZip = require("adm-zip");
const SHA256 = "a".repeat(64);
const REVISION = "b".repeat(40);

test("argument parser requires immutable identity pins and JSON output", () => {
  const parsed = parseArguments([
    "--archive", "kit.zip",
    "--extract-root", "extracted",
    "--expected-sha256", SHA256,
    "--expected-source-revision", REVISION,
    "--expected-version", "0.1.0-beta.10",
    "--required-node-major", "20",
    "--json",
  ]);
  assert.equal(parsed.expectedSha256, SHA256);
  assert.equal(parsed.expectedSourceRevision, REVISION);
  assert.equal(parsed.expectedVersion, "0.1.0-beta.10");
  assert.equal(parsed.requiredNodeMajor, 20);
  assert.throws(() => parseArguments(["--json"]), /missing required argument/);
  assert.throws(() => parseArguments([
    "--archive", "kit.zip",
    "--archive", "other.zip",
    "--json",
  ]), /duplicate argument/);
});

test("archive path normalization rejects traversal and Windows aliases", () => {
  assert.deepEqual(normalizeArchivePath("bin/useful"), { path: "bin/useful", directory: false });
  assert.deepEqual(normalizeArchivePath("bin/"), { path: "bin", directory: true });
  for (const unsafe of ["../escape", "a/../escape", "/rooted", "C:/drive", "a\\b", "a//b", "./a"]) {
    assert.throws(() => normalizeArchivePath(unsafe), /unsafe archive entry path/);
  }
});

test("archive extraction creates regular files without overwriting a target", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "useful-agent-kit-acceptance-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archive = path.join(root, "fixture.zip");
  const extractRoot = path.join(root, "extracted");
  const zip = new AdmZip();
  zip.addFile("nested/value.txt", Buffer.from("value\n", "utf8"));
  zip.writeZip(archive);
  assert.deepEqual(await extractArchive(archive, extractRoot), ["nested/value.txt"]);
  assert.equal(await readFile(path.join(extractRoot, "nested", "value.txt"), "utf8"), "value\n");
  await assert.rejects(extractArchive(archive, extractRoot), /extract root already exists/);
});

test("archive extraction rejects case-insensitive duplicate paths before writing", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "useful-agent-kit-acceptance-duplicate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archive = path.join(root, "duplicate.zip");
  const extractRoot = path.join(root, "extracted");
  const zip = new AdmZip();
  zip.addFile("A.txt", Buffer.from("a"));
  zip.addFile("a.txt", Buffer.from("b"));
  zip.writeZip(archive);
  await assert.rejects(extractArchive(archive, extractRoot), /case-insensitive duplicate archive path/);
});
