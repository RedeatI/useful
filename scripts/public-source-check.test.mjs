import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import {
  MAX_PUBLIC_FILES,
  MAX_PUBLIC_TOTAL_BYTES,
  REQUIRED_PUBLIC_FILES,
  deriveStaticExampleFixturePolicy,
  evaluatePublicBudgets,
  findPortableCollisions,
  getPortablePathViolation,
  inspectGitRepository,
  sha256,
} from "./public-source-policy.mjs";

const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "public-source-check.mjs");
const requiredFiles = [...REQUIRED_PUBLIC_FILES];

function staticExamplePolicyFiles() {
  const prefix = "repositories/static-example/";
  const artifact = Buffer.from("controlled useful fixture");
  const digest = sha256(artifact);
  const name = "com.test.tool-1.0.0-stable-windows-x86_64.useful";
  const custom = {
    publisherKeyId: `ed25519:${"11".repeat(32)}`,
    toolId: "com.test.tool",
    version: "1.0.0",
    channel: "stable",
    platform: "windows",
    arch: "x86_64",
    artifactSha256: digest,
    publisherSignatureVerified: true,
    publisherSignatureMethod: "ed25519",
    publisherSignaturePayloadVersion: "useful-artifact-v1",
    publisherSignature: "22".repeat(64),
    signatureIdentity: `ed25519:${"11".repeat(32)}`,
  };
  const targets = Buffer.from(JSON.stringify({
    signed: { _type: "targets", version: 7, targets: { [name]: { length: artifact.length, hashes: { sha256: digest }, custom } } },
  }));
  const snapshot = Buffer.from(JSON.stringify({
    signed: { _type: "snapshot", version: 8, meta: { "targets.json": { version: 7, length: targets.length, hashes: { sha256: sha256(targets) } } } },
  }));
  const timestamp = Buffer.from(JSON.stringify({
    signed: { _type: "timestamp", meta: { "snapshot.json": { version: 8, length: snapshot.length, hashes: { sha256: sha256(snapshot) } } } },
  }));
  const catalog = Buffer.from(JSON.stringify({
    entries: [{
      identity: { publisherKeyId: custom.publisherKeyId, toolId: custom.toolId },
      artifacts: [{
        version: custom.version,
        channel: custom.channel,
        platform: custom.platform,
        arch: custom.arch,
        artifactSha256: digest,
        signatureMethod: custom.publisherSignatureMethod,
        signatureIdentity: custom.signatureIdentity,
      }],
    }],
  }));
  return new Map([
    [`${prefix}metadata/timestamp.json`, timestamp],
    [`${prefix}metadata/8.snapshot.json`, snapshot],
    [`${prefix}metadata/7.targets.json`, targets],
    [`${prefix}catalog/snapshot.json`, catalog],
    [`${prefix}targets/${digest}.${name}`, artifact],
  ]);
}

test("static example archive policy is derived from one exact metadata/catalog binding", () => {
  const files = staticExamplePolicyFiles();
  const accepted = deriveStaticExampleFixturePolicy(files);
  assert.equal(accepted.violations.length, 0);
  assert.deepEqual([...accepted.fixtures.keys()], [
    [...files.keys()].find((relative) => relative.includes("/targets/")),
  ]);

  const extra = Buffer.from("extra archive");
  files.set(
    `repositories/static-example/targets/${sha256(extra)}.extra.useful`,
    extra,
  );
  const rejected = deriveStaticExampleFixturePolicy(files);
  assert.ok(rejected.violations.some((violation) =>
    violation.code === "generated-archive-not-allowlisted"));
});

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function gitOutput(root, args) {
  return git(root, args).trim();
}

async function writeZip(file, entries) {
  const archive = new AdmZip();
  for (const entry of entries) {
    archive.addFile(entry.name, Buffer.from(entry.content));
    if (entry.attr !== undefined) archive.getEntry(entry.name).attr = entry.attr;
  }
  await writeFile(file, archive.toBuffer());
}

async function makeRepository({ unsafe = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "useful-public-source-"));
  await mkdir(path.join(root, "docs"), { recursive: true });
  await mkdir(path.join(root, "fixtures"), { recursive: true });
  for (const relative of requiredFiles) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, `${relative}\n`);
  }
  await writeFile(path.join(root, ".gitignore"), "node_modules/\n");
  await writeFile(path.join(root, "NOTICE"), "fixture notice\n");
  await writeFile(path.join(root, "fixtures", "corrupt.useful"), Buffer.from("not a zip"));
  await writeZip(path.join(root, "fixtures", "malicious-path.useful"), [
    { name: "../escape.txt", content: "intentional traversal fixture" },
  ]);
  await writeZip(path.join(root, "fixtures", "normal.useful"), [
    unsafe
      ? { name: "link", content: "../outside", attr: (0xa1ff << 16) >>> 0 }
      : { name: "manifest.json", content: '{"id":"fixture"}\n' },
  ]);
  if (unsafe) {
    await writeZip(path.join(root, "fixtures", "unexpected.useful"), [
      { name: "manifest.json", content: '{"id":"unexpected"}\n' },
    ]);
    await writeFile(path.join(root, "docs", "PHASE99-FINAL-REPORT.md"), "private handoff\n");
  }
  git(root, ["init", "--quiet"]);
  git(root, ["add", "."]);
  git(root, [
    "-c",
    "user.name=Useful Test",
    "-c",
    "user.email=useful-test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  return root;
}

async function addTrackedFiles(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
  }
  git(root, ["add", "."]);
  git(root, [
    "-c",
    "user.name=Useful Test",
    "-c",
    "user.email=useful-test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture paths",
  ]);
}

function runRaw(root, extraArgs = []) {
  const args = [scriptPath, "--repo-root", root, "--json"];
  args.push(...extraArgs);
  const result = spawnSync(process.execPath, args, {
    encoding: "utf8",
  });
  assert.equal(result.stderr, "");
  const parsed = JSON.parse(result.stdout);
  return { ...result, parsed };
}

function runCheck(root) {
  const result = runRaw(root);
  assert.equal(result.status, result.parsed.ok && result.parsed.authoritative ? 0 : 3);
  return result.parsed;
}

test("accepts only the bounded allowlisted fixtures without extracting them", async (t) => {
  const root = await makeRepository();
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = runCheck(root);

  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
  await assert.rejects(readFile(path.join(root, "escape.txt")), { code: "ENOENT" });
});

test("fails closed on non-public paths, unallowlisted archives, and archive links", async (t) => {
  const root = await makeRepository({ unsafe: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = runCheck(root);
  const codes = new Set(result.violations.map((violation) => violation.code));

  assert.equal(result.ok, false);
  assert.equal(codes.has("non-public-path-present"), true);
  assert.equal(codes.has("generated-archive-not-allowlisted"), true);
  assert.equal(codes.has("fixture-link-entry"), true);
});

test("rejects former product identity in a public path or text file", async (t) => {
  const root = await makeRepository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const formerName = ["tool", "box"].join("");
  const formerAbbreviation = ["t", "b", "x"].join("");
  await addTrackedFiles(root, {
    [`docs/${formerName}-notes.md`]: "historical product path\n",
    "docs/identity-notes.md": `historical prefix ${formerAbbreviation}\n`,
  });

  const result = runCheck(root);

  assert.equal(result.ok, false);
  assert.equal(result.violations.some((entry) => entry.code === "legacy-brand-path"), true);
  assert.equal(result.violations.some((entry) => entry.code === "legacy-brand-content"), true);
});

test("allows abbreviation-shaped lock integrity while rejecting UTF-16 former identity", async (t) => {
  const root = await makeRepository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const formerName = ["tool", "box"].join("");
  const formerAbbreviation = ["t", "b", "x"].join("");
  const hashLikeAbbreviation = `${formerAbbreviation.slice(0, 2).toUpperCase()}${formerAbbreviation.slice(2)}`;
  await addTrackedFiles(root, {
    "pnpm-lock.yaml": `integrity: sha512-a${hashLikeAbbreviation}M7randomdigest\n`,
    "docs/utf16.txt": Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(`${formerName}\n`, "utf16le"),
    ]),
  });

  const result = runCheck(root);

  assert.equal(result.ok, false);
  assert.equal(result.violations.some((entry) => entry.path === "pnpm-lock.yaml" && entry.code === "legacy-brand-content"), false);
  assert.equal(result.violations.some((entry) => entry.path === "docs/utf16.txt" && entry.code === "legacy-brand-content"), true);
});

test("rejects generated path names at their exact boundaries without rejecting similar source names", async (t) => {
  const cases = [
    { rejected: "docs/build/dist/index.js", allowed: "docs/build/dist-notes/index.js" },
    { rejected: "apps/useful/.vite/manifest.json", allowed: "apps/useful/.vite-notes/manifest.json" },
    { rejected: "packages/core/coverage/index.html", allowed: "packages/core/coverage-guide/index.html" },
    { rejected: "docs/perf/bench-results/result.json", allowed: "docs/perf/bench-results-guide/result.json" },
    {
      rejected: "apps/useful/src-tauri/gen/schemas/app.json",
      allowed: "apps/useful/src-tauri/generated/schemas/app.json",
    },
    { rejected: "docs/build.log", allowed: "docs/build.log.md" },
  ];

  for (const fixture of cases) {
    await t.test(fixture.rejected, async (t) => {
      const root = await makeRepository();
      t.after(() => rm(root, { recursive: true, force: true }));
      await addTrackedFiles(root, {
        [fixture.rejected]: "generated fixture\n",
        [fixture.allowed]: "public source fixture\n",
      });

      const result = runCheck(root);
      const violation = result.violations.find(
        (entry) => entry.path === fixture.rejected && entry.code === "prohibited-path",
      );

      assert.equal(result.ok, false);
      assert.equal(Boolean(violation), true);
      assert.equal(result.included.some((entry) => entry.path === fixture.rejected), false);
      assert.equal(result.included.some((entry) => entry.path === fixture.allowed), true);
    });
  }
});

test("excludes only the named non-public source files without rejecting similar public names", async (t) => {
  const cases = [
    { excluded: "docs/BENCHMARK.md", allowed: "docs/BENCHMARK-guide.md" },
    { excluded: "docs/PRIVACY-POLICY-draft.md", allowed: "docs/PRIVACY-POLICY-draft-notes.md" },
    {
      excluded: "docs/TERMS-OF-SERVICE-placeholder.md",
      allowed: "docs/TERMS-OF-SERVICE-placeholder-notes.md",
    },
    {
      excluded: "scripts/prepare-beta-test-source.mjs",
      allowed: "scripts/prepare-beta-test-source-helper.mjs",
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.excluded, async (t) => {
      const root = await makeRepository();
      t.after(() => rm(root, { recursive: true, force: true }));
      await addTrackedFiles(root, {
        [fixture.excluded]: "internal source fixture\n",
        [fixture.allowed]: "public source fixture\n",
      });

      const result = runCheck(root);
      const violation = result.violations.find(
        (entry) => entry.path === fixture.excluded && entry.code === "non-public-path-present",
      );

      assert.equal(result.ok, false);
      assert.equal(Boolean(violation), true);
      assert.equal(result.excluded.includes(fixture.excluded), true);
      assert.equal(result.included.some((entry) => entry.path === fixture.excluded), false);
      assert.equal(result.included.some((entry) => entry.path === fixture.allowed), true);
    });
  }
});

test("keeps product-review documents, release notes, and json-diff-pro-tool source eligible", async (t) => {
  const root = await makeRepository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const retainedPaths = [
    "docs/BETA-UPGRADE-ROLLBACK.md",
    "docs/DEVELOPER-PREVIEW.md",
    "docs/KNOWN-LIMITATIONS.md",
    "docs/TEST-MATRIX.md",
    "docs/releases/0.1.0-beta.1.md",
    "examples/json-diff-pro-tool/README.md",
    "services/internal/app/phase9_test.go",
  ];
  await addTrackedFiles(
    root,
    Object.fromEntries(retainedPaths.map((relative) => [relative, "product review fixture\n"])),
  );

  const result = runCheck(root);

  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
  for (const relative of retainedPaths) {
    assert.equal(result.included.some((entry) => entry.path === relative), true);
  }
});

test("does not read through a filesystem symlink or junction", async (t) => {
  const root = await makeRepository();
  const outside = await mkdtemp(path.join(tmpdir(), "useful-public-source-outside-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, "outside.txt"), "must not be scanned\n");
  await symlink(outside, path.join(root, "docs", "linked"), process.platform === "win32" ? "junction" : "dir");

  const result = await inspectGitRepository({ repoRoot: root, allowDirty: true, purpose: "check" });
  const linkViolation = result.violations.find(
    (violation) => violation.code === "non-regular-file" && String(violation.details).includes("link boundary"),
  );

  assert.equal(result.ok, false);
  assert.equal(result.authoritative, false);
  assert.equal(Boolean(linkViolation), true);
  assert.equal(result.included.some((entry) => entry.path.includes("docs/linked/")), false);
});

test("strict CLI rejects dirty input and rejects --allow-dirty as a stable usage error", async (t) => {
  const root = await makeRepository();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "docs", "untracked.md"), "dirty\n");

  const dirty = runRaw(root);
  assert.equal(dirty.status, 3);
  assert.equal(dirty.parsed.ok, false);
  assert.equal(dirty.parsed.authoritative, false);
  assert.equal(dirty.parsed.error.code, "SOURCE_POLICY_FAILED");
  assert.equal(dirty.parsed.violations[0].code, "dirty-worktree");

  const diagnostic = await inspectGitRepository({ repoRoot: root, allowDirty: true, purpose: "check" });
  assert.equal(diagnostic.ok, true);
  assert.equal(diagnostic.dirty, true);
  assert.equal(diagnostic.authoritative, false);

  const relaxed = runRaw(root, ["--allow-dirty"]);
  assert.equal(relaxed.status, 2);
  assert.equal(relaxed.parsed.ok, false);
  assert.equal(relaxed.parsed.authoritative, false);
  assert.equal(relaxed.parsed.error.code, "INVALID_ARGUMENTS");
});

test("classifies native missing-directory I/O as exit 4 instead of INTERNAL_ERROR", async (t) => {
  const container = await mkdtemp(path.join(tmpdir(), "useful-public-source-missing-"));
  t.after(() => rm(container, { recursive: true, force: true }));
  const result = runRaw(path.join(container, "missing"));
  assert.equal(result.status, 4);
  assert.equal(result.parsed.ok, false);
  assert.equal(result.parsed.authoritative, false);
  assert.equal(result.parsed.error.code, "PUBLIC_SOURCE_IO_OR_SECURITY");
  assert.equal(result.parsed.error.details.nativeCode, "ENOENT");
});

test("scans secrets in every UTF-8 source/config extension and ordinary PEM names", async (t) => {
  const root = await makeRepository();
  t.after(() => rm(root, { recursive: true, force: true }));
  await addTrackedFiles(root, {
    "docs/server.pem": ["-----BEGIN", " PRIVATE KEY-----"].join("") + "\nfixture\n",
    ".env.example": "GITHUB_TOKEN=" + "ghp_" + "123456789012345678901234567890" + "\n",
    "scripts/task.py": "token = '" + "xoxb-" + "123456789012345678901234" + "'\n",
    "config/service.properties": "aws=" + "AKIA" + "1234567890123456" + "\n",
    "docs/example.xml": "<token>" + "github_pat_" + "1234567890123456789012345" + "</token>\n",
    "apps/useful/Example.java": "String token = \"" + "gho_" + "1234567890123456789012345" + "\";\n",
  });

  const result = runCheck(root);
  const secretPaths = new Set(result.violations.filter((entry) => entry.code === "secret-pattern").map((entry) => entry.path));
  for (const relative of [
    "docs/server.pem",
    ".env.example",
    "scripts/task.py",
    "config/service.properties",
    "docs/example.xml",
    "apps/useful/Example.java",
  ]) {
    assert.equal(secretPaths.has(relative), true, relative);
  }
});

test("rejects archive/container extensions as a closed set and rejects unrecognized binary bytes", async (t) => {
  const root = await makeRepository();
  t.after(() => rm(root, { recursive: true, force: true }));
  await addTrackedFiles(root, {
    "assets/payload.jar": Buffer.from("jar"),
    "assets/payload.rar": Buffer.from("rar"),
    "assets/payload.xz": Buffer.from("xz"),
    "assets/payload.whl": Buffer.from("whl"),
    "assets/opaque.bin": Buffer.from([0xff, 0xfe, 0xfd, 0x00]),
    "assets/leaky.png": Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff]),
      Buffer.from("ghp_" + "123456789012345678901234567890", "ascii"),
    ]),
  });

  const result = runCheck(root);
  for (const relative of ["assets/payload.jar", "assets/payload.rar", "assets/payload.xz", "assets/payload.whl"]) {
    assert.equal(result.violations.some((entry) => entry.path === relative && entry.code === "prohibited-path"), true);
  }
  assert.equal(
    result.violations.some((entry) => entry.path === "assets/opaque.bin" && entry.code === "unsupported-binary-content"),
    true,
  );
  assert.equal(
    result.violations.some((entry) => entry.path === "assets/leaky.png" && entry.code === "secret-pattern"),
    true,
  );
});

test("portable collision and aggregate budgets are deterministic pure policy checks", () => {
  const collisions = findPortableCollisions([{ path: "docs/Café.txt" }, { path: "docs/CAFÉ.TXT" }]);
  assert.equal(collisions.some((entry) => entry.code === "non-portable-path-collision"), true);

  const entries = Array.from({ length: MAX_PUBLIC_FILES + 1 }, (_, index) => ({ path: `docs/${index}.txt`, bytes: 0 }));
  const budget = evaluatePublicBudgets(entries);
  assert.equal(budget.violations.some((entry) => entry.code === "public-file-count-limit"), true);
  const bytesBudget = evaluatePublicBudgets([{ path: "docs/large.txt", bytes: MAX_PUBLIC_TOTAL_BYTES + 1 }]);
  assert.equal(bytesBudget.violations.some((entry) => entry.code === "public-total-bytes-limit"), true);
  assert.equal(getPortablePathViolation(`docs/${"a".repeat(256)}`), "path-segment-length-limit");
});

test("fixed build inspection remains bound to tree A across an A-to-B-to-A ref race", async (t) => {
  const root = await makeRepository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const commitA = gitOutput(root, ["rev-parse", "HEAD"]);
  const treeA = gitOutput(root, ["rev-parse", `${commitA}^{tree}`]);
  const bytesA = await readFile(path.join(root, "README.md"));
  await writeFile(path.join(root, "README.md"), "tree B\n");
  git(root, ["add", "README.md"]);
  git(root, ["-c", "user.name=Useful Test", "-c", "user.email=useful-test@example.invalid", "commit", "--quiet", "-m", "tree B"]);
  const commitB = gitOutput(root, ["rev-parse", "HEAD"]);
  git(root, ["checkout", "--quiet", "-b", "snapshot-a", commitA]);

  const inspection = await inspectGitRepository({
    repoRoot: root,
    purpose: "build",
    expectedCommit: commitA,
    expectedTree: treeA,
    testHooks: {
      afterMetadata() {
        git(root, ["update-ref", "HEAD", commitB]);
      },
      afterTreeEnumeration() {
        git(root, ["update-ref", "HEAD", commitA]);
      },
    },
  });

  assert.equal(inspection.commit, commitA);
  assert.equal(inspection.tree, treeA);
  assert.equal(inspection.included.find((entry) => entry.path === "README.md")?.sha256, sha256(bytesA));
});

test("strict inspection reads the fixed HEAD tree rather than a raced Git index", async (t) => {
  const root = await makeRepository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const commitA = gitOutput(root, ["rev-parse", "HEAD"]);
  const treeA = gitOutput(root, ["rev-parse", `${commitA}^{tree}`]);
  const bytesA = await readFile(path.join(root, "README.md"));
  await writeFile(path.join(root, "README.md"), "tree B\n");
  git(root, ["add", "README.md"]);
  git(root, ["-c", "user.name=Useful Test", "-c", "user.email=useful-test@example.invalid", "commit", "--quiet", "-m", "tree B"]);
  const commitB = gitOutput(root, ["rev-parse", "HEAD"]);
  git(root, ["checkout", "--quiet", "-b", "strict-a", commitA]);

  const inspection = await inspectGitRepository({
    repoRoot: root,
    purpose: "check",
    expectedCommit: commitA,
    expectedTree: treeA,
    testHooks: {
      afterMetadata() {
        git(root, ["read-tree", commitB]);
      },
      afterTreeEnumeration() {
        git(root, ["read-tree", commitA]);
      },
    },
  });

  assert.equal(inspection.authoritative, true);
  assert.equal(inspection.included.find((entry) => entry.path === "README.md")?.sha256, sha256(bytesA));
});

test("inspection refuses a checkout that changes after enumeration", async (t) => {
  const root = await makeRepository();
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    () => inspectGitRepository({
      repoRoot: root,
      purpose: "check",
      testHooks: {
        afterTreeEnumeration() {
          return writeFile(path.join(root, "README.md"), "changed during inspection\n");
        },
      },
    }),
    (error) => error?.code === "SOURCE_CHANGED",
  );
});

test("Git replacement refs cannot substitute the committed public tree", async (t) => {
  const root = await makeRepository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const commitA = gitOutput(root, ["rev-parse", "HEAD"]);
  const treeA = gitOutput(root, ["rev-parse", `${commitA}^{tree}`]);
  const bytesA = await readFile(path.join(root, "README.md"));
  await writeFile(path.join(root, "README.md"), "replacement tree\n");
  git(root, ["add", "README.md"]);
  git(root, ["-c", "user.name=Useful Test", "-c", "user.email=useful-test@example.invalid", "commit", "--quiet", "-m", "replacement tree"]);
  const replacement = gitOutput(root, ["rev-parse", "HEAD"]);
  git(root, ["checkout", "--quiet", "-b", "no-replace-a", commitA]);
  git(root, ["replace", commitA, replacement]);

  const inspection = await inspectGitRepository({ repoRoot: root, purpose: "check" });

  assert.equal(inspection.commit, commitA);
  assert.equal(inspection.tree, treeA);
  assert.equal(inspection.included.find((entry) => entry.path === "README.md")?.sha256, sha256(bytesA));
});
