import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  PUBLIC_SOURCE_POLICY_SCHEMA,
  REQUIRED_PUBLIC_FILES,
  capturePathIdentityPins,
  computeReceiptManifestSha256,
  getLocalAbsolutePathViolation,
  inspectGitRepository,
  sha256,
} from "./public-source-policy.mjs";
import { BuilderError, generate } from "./prepare-public-source.mjs";

const canonicalTemporaryDirectory = realpathSync.native(tmpdir());
const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const builderPath = path.join(scriptsDirectory, "prepare-public-source.mjs");
const checkerPath = path.join(scriptsDirectory, "public-source-check.mjs");
const requiredFiles = [...REQUIRED_PUBLIC_FILES];

function git(root, args, { expect = 0 } = {}) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, expect, result.stderr);
  return result.stdout;
}

function gitBytes(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: null });
  assert.equal(result.status, 0, result.stderr?.toString("utf8"));
  return result.stdout;
}

async function write(root, relative, contents = "") {
  const absolute = path.join(root, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
}

async function makeRepository({ internalFiles = false } = {}) {
  const container = await mkdtemp(path.join(canonicalTemporaryDirectory, "useful snapshot fixture "));
  const root = path.join(container, "source repo 空间");
  await mkdir(root);
  for (const relative of requiredFiles) await write(root, relative, `${relative}\n`);
  await write(root, ".gitignore", "node_modules/\ndist/\nartifacts/\n.env*\n");
  await write(root, "docs/Unicode 空间/empty.txt", "");
  await write(root, "scripts/run.sh", "#!/bin/sh\nprintf useful\\n\n");
  await write(root, "assets/pixel.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff]));
  if (internalFiles) {
    const excluded = [
      "docs/PHASE13-plan.md",
      "docs/ROUND2-notes.md",
      "docs/RELEASE-EVIDENCE.md",
      "docs/PROJECT-STATE.md",
      "docs/handoffs/internal.md",
      "docs/FINAL-REPORT.md",
      "docs/internal-draft.md",
      "artifacts/result.json",
      "dist/bundle.js",
      "node_modules/pkg/index.js",
      ".env",
      "binaries/tool.exe",
    ];
    for (const relative of excluded) await write(root, relative, `excluded ${relative}\n`);
  }
  git(root, ["init", "--quiet"]);
  git(root, ["add", "."]);
  if (internalFiles) {
    git(root, [
      "add",
      "--force",
      "artifacts/result.json",
      "dist/bundle.js",
      "node_modules/pkg/index.js",
      ".env",
    ]);
  }
  git(root, ["update-index", "--chmod=+x", "scripts/run.sh"]);
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
  await write(root, "node_modules/ignored.js", "ignored\n");
  return { container, root };
}

function runBuilder(repoRoot, output, receipt, extraArgs = []) {
  const result = spawnSync(
    process.execPath,
    [
      builderPath,
      "--repo-root",
      repoRoot,
      "--output",
      output,
      "--receipt",
      receipt,
      "--json",
      ...extraArgs,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.stderr, "");
  const parsed = JSON.parse(result.stdout);
  const validationErrors = new Set([
    "SOURCE_DIRTY",
    "SOURCE_NOT_GIT",
    "SOURCE_POLICY_FAILED",
    "SOURCE_ROOT_NOT_TOPLEVEL",
    "SOURCE_CHANGED",
    "SOURCE_VALIDATION_FAILED",
    "OUTPUT_VALIDATION_FAILED",
    "RECEIPT_VALIDATION_FAILED",
    "RECEIPT_BYTES_LIMIT",
  ]);
  let expectedExitCode = 4;
  if (parsed.ok) expectedExitCode = 0;
  else if (parsed.error.code === "INVALID_ARGUMENTS") expectedExitCode = 2;
  else if (validationErrors.has(parsed.error.code)) expectedExitCode = 3;
  else if (parsed.error.code === "INTERNAL_ERROR") expectedExitCode = 5;
  assert.equal(result.status, expectedExitCode);
  assert.equal(parsed.authoritative, parsed.ok);
  return { ...result, parsed };
}

async function assertAbsent(absolute) {
  await assert.rejects(readFile(absolute), { code: "ENOENT" });
}

test("builds deterministic receipts from a clean exact Git source", async (t) => {
  const { container, root } = await makeRepository({ internalFiles: true });
  t.after(() => rm(container, { recursive: true, force: true }));
  const outputA = path.join(container, "public output A");
  const outputB = path.join(container, "public output B");
  const receiptA = path.join(container, "receipt A.json");
  const receiptB = path.join(container, "receipt B.json");

  const first = runBuilder(root, outputA, receiptA);
  const second = runBuilder(root, outputB, receiptB);

  assert.equal(first.status, 0);
  assert.equal(second.status, 0);
  assert.equal(first.parsed.schemaVersion, "useful.prepare-public-source.result.v2");
  assert.equal(first.parsed.authoritative, true);
  assert.deepEqual(await readFile(receiptA), await readFile(receiptB));
  const receipt = JSON.parse(await readFile(receiptA, "utf8"));
  assert.equal(receipt.schemaVersion, "useful.public-source-receipt.v2");
  assert.equal(receipt.authoritative, true);
  assert.equal(receipt.gitIndexMode.filesystemModeAuthoritative, false);
  const transactionA = JSON.parse(await readFile(first.parsed.transactionMarker, "utf8"));
  assert.equal(transactionA.phase, "complete");
  assert.equal(transactionA.authoritative, true);
  assert.equal(transactionA.receiptSha256, sha256(await readFile(receiptA)));
  assert.equal(first.parsed.receiptSha256, transactionA.receiptSha256);
  assert.equal(first.parsed.transactionMarkerSha256, sha256(await readFile(first.parsed.transactionMarker)));
  assert.deepEqual(transactionA.identities.transactionMarker, first.parsed.transactionIdentity);
  assert.equal(receipt.source.commit, git(root, ["rev-parse", "HEAD"]).trim());
  assert.equal(receipt.files.some((entry) => entry.path === "docs/Unicode 空间/empty.txt" && entry.bytes === 0), true);
  assert.equal(receipt.files.find((entry) => entry.path === "scripts/run.sh")?.mode, "100755");
  assert.equal(await readFile(path.join(outputA, "docs/Unicode 空间/empty.txt"), "utf8"), "");
  for (const fragment of [
    "PHASE13",
    "ROUND2",
    "RELEASE-EVIDENCE",
    "PROJECT-STATE",
    "handoffs",
    "REPORT",
    "draft",
    "artifacts",
    "dist",
    "node_modules",
    ".env",
    "tool.exe",
  ]) {
    assert.equal(receipt.files.some((entry) => entry.path.includes(fragment)), false, fragment);
  }
});

test("anchors path identity at only the target or nearest existing parent", async (t) => {
  const { container, root } = await makeRepository();
  t.after(() => rm(container, { recursive: true, force: true }));
  const sourceCapture = await capturePathIdentityPins(root);
  assert.equal(sourceCapture.pins.length, 1);
  assert.equal(sourceCapture.pins[0].absolute, root);

  const target = path.join(container, "missing", "public output");
  const targetCapture = await capturePathIdentityPins(target);
  assert.equal(targetCapture.pins.length, 1);
  assert.equal(targetCapture.pins[0].absolute, container);
});

test("copies fixed Git blob bytes instead of CRLF-smudged checkout bytes", async (t) => {
  const { container, root } = await makeRepository();
  t.after(() => rm(container, { recursive: true, force: true }));
  const filterScript = [
    'import { stdin, stdout } from "node:process";',
    "const chunks = [];",
    "for await (const chunk of stdin) chunks.push(chunk);",
    'const input = Buffer.concat(chunks).toString("utf8");',
    'if (process.argv[2] === "clean") {',
    '  stdout.write(input.replaceAll("\\r\\n", "\\n").replaceAll("\\r", "\\n"));',
    '} else if (process.argv[2] === "smudge") {',
    '  stdout.write(input.replaceAll("\\r\\n", "\\n").replaceAll("\\n", "\\r\\n"));',
    "} else {",
    "  process.exitCode = 2;",
    "}",
    "",
  ].join("\n");
  await writeFile(path.join(root, ".git", "useful-crlf-filter.mjs"), filterScript);
  git(root, ["config", "filter.useful-crlf.clean", "node .git/useful-crlf-filter.mjs clean"]);
  git(root, ["config", "filter.useful-crlf.smudge", "node .git/useful-crlf-filter.mjs smudge"]);
  git(root, ["config", "filter.useful-crlf.required", "true"]);
  await write(root, ".gitattributes", "README.md filter=useful-crlf -text\n");
  await write(root, "README.md", "README.md\n");
  git(root, ["add", ".gitattributes", "README.md"]);
  git(root, [
    "-c",
    "user.name=Useful Test",
    "-c",
    "user.email=useful-test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "deterministic CRLF fixture",
  ]);
  await rm(path.join(root, "README.md"));
  git(root, ["checkout", "--", "README.md"]);

  const checkout = await readFile(path.join(root, "README.md"));
  assert.equal(checkout.includes(Buffer.from("\r\n")), true, "fixture failure: checkout is not CRLF");
  const blob = gitBytes(root, ["cat-file", "blob", "HEAD:README.md"]);
  assert.equal(blob.includes(Buffer.from("\r\n")), false, "fixture failure: committed README blob is not LF");
  assert.notDeepEqual(checkout, blob, "fixture failure: checkout bytes must differ from the committed LF blob");
  assert.equal(
    git(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
    "",
    "fixture failure: clean/smudge filter did not keep the CRLF checkout clean",
  );

  const output = path.join(container, "public output");
  const receiptPath = path.join(container, "receipt.json");
  const result = runBuilder(root, output, receiptPath);
  assert.equal(result.status, 0);
  assert.deepEqual(await readFile(path.join(output, "README.md")), blob);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  const readmeTreeLine = git(root, ["ls-tree", "HEAD", "--", "README.md"]).trim();
  const readmeTreeMatch = /^(\d+) blob ([0-9a-f]+)\tREADME\.md$/.exec(readmeTreeLine);
  assert.notEqual(readmeTreeMatch, null, readmeTreeLine);
  const readmeReceipt = receipt.files.find((entry) => entry.path === "README.md");
  assert.deepEqual(readmeReceipt, {
    path: "README.md",
    bytes: blob.length,
    mode: readmeTreeMatch[1],
    sha256: sha256(blob),
  });
  assert.deepEqual(gitBytes(root, ["cat-file", "blob", readmeTreeMatch[2]]), blob);
  assert.equal(receipt.summary.fileCount, receipt.files.length);
  assert.equal(receipt.summary.totalBytes, receipt.files.reduce((total, entry) => total + entry.bytes, 0));
  assert.equal(receipt.summary.manifestSha256, computeReceiptManifestSha256(receipt.files));
  const checked = await inspectGitRepository({ repoRoot: root, purpose: "check" });
  assert.equal(checked.ok, true);
  const checkedReadme = checked.included.find((entry) => entry.path === "README.md");
  assert.equal(checkedReadme.bytes, blob.length);
  assert.equal(checkedReadme.sha256, sha256(blob));
  assert.equal(computeReceiptManifestSha256(checked.included), receipt.summary.manifestSha256);
  assert.equal(
    receipt.summary.snapshotSha256,
    sha256(
      `commit ${receipt.source.commit}\ntree ${receipt.source.tree}\npolicy ${PUBLIC_SOURCE_POLICY_SCHEMA}\nmanifest ${receipt.summary.manifestSha256}\nfiles ${receipt.summary.fileCount}\nbytes ${receipt.summary.totalBytes}\n`,
    ),
  );
});

test("fails closed without leaving partial output", async (t) => {
  const cases = [
    {
      name: "dirty source",
      mutate: (root) => write(root, "docs/untracked.md", "untracked\n"),
      expectedCode: "SOURCE_DIRTY",
    },
    {
      name: "missing LICENSE",
      mutate: (root) => {
        git(root, ["rm", "--quiet", "LICENSE"]);
        git(root, [
          "-c",
          "user.name=Useful Test",
          "-c",
          "user.email=useful-test@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "remove license",
        ]);
      },
      expectedCode: "SOURCE_POLICY_FAILED",
    },
    {
      name: "tracked symlink",
      mutate: async (root) => {
        await write(root, "docs/tracked-link", "README.md");
        const object = git(root, ["hash-object", "-w", "docs/tracked-link"]).trim();
        git(root, ["update-index", "--add", "--cacheinfo", `120000,${object},docs/tracked-link`]);
        git(root, [
          "-c",
          "user.name=Useful Test",
          "-c",
          "user.email=useful-test@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "tracked link",
        ]);
      },
      expectedCode: ["SOURCE_DIRTY", "SOURCE_POLICY_FAILED"],
    },
    {
      name: "tracked directory replaced by a link boundary",
      mutate: async (root) => {
        const movedDocs = path.join(path.dirname(root), "moved tracked docs");
        await rename(path.join(root, "docs"), movedDocs);
        await symlink(movedDocs, path.join(root, "docs"), process.platform === "win32" ? "junction" : "dir");
      },
      expectedCode: ["SOURCE_DIRTY", "SOURCE_POLICY_FAILED"],
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async (t) => {
      const { container, root } = await makeRepository();
      t.after(() => rm(container, { recursive: true, force: true }));
      await fixture.mutate(root);
      const output = path.join(container, "public output");
      const receipt = path.join(container, "receipt.json");

      const result = runBuilder(root, output, receipt);

      assert.notEqual(result.status, 0);
      assert.equal(
        Array.isArray(fixture.expectedCode)
          ? fixture.expectedCode.includes(result.parsed.error.code)
          : result.parsed.error.code === fixture.expectedCode,
        true,
      );
      await assertAbsent(output);
      await assertAbsent(receipt);
    });
  }
});

test("rejects existing destinations and invalid arguments", async (t) => {
  const { container, root } = await makeRepository();
  t.after(() => rm(container, { recursive: true, force: true }));
  const output = path.join(container, "public output");
  const receipt = path.join(container, "receipt.json");
  await mkdir(output);
  await write(output, "marker.txt", "keep\n");

  const existing = runBuilder(root, output, receipt);
  assert.notEqual(existing.status, 0);
  assert.equal(existing.parsed.error.code, "OUTPUT_EXISTS");
  assert.equal(await readFile(path.join(output, "marker.txt"), "utf8"), "keep\n");
  await assertAbsent(receipt);

  const receiptBlockedOutput = path.join(container, "receipt-blocked-output");
  const existingReceipt = path.join(container, "existing-receipt.json");
  await writeFile(existingReceipt, "keep receipt\n");
  const receiptExists = runBuilder(root, receiptBlockedOutput, existingReceipt);
  assert.notEqual(receiptExists.status, 0);
  assert.equal(receiptExists.parsed.error.code, "RECEIPT_EXISTS");
  await assertAbsent(receiptBlockedOutput);
  assert.equal(await readFile(existingReceipt, "utf8"), "keep receipt\n");

  for (const extraArgs of [["--unknown"], ["--output", path.join(container, "other")]]) {
    const freshOutput = path.join(container, `fresh-${extraArgs.length}-${extraArgs.at(-1).length}`);
    const freshReceipt = path.join(container, `fresh-${extraArgs.at(-1).length}.json`);
    const invalid = runBuilder(root, freshOutput, freshReceipt, extraArgs);
    assert.equal(invalid.status, 2);
    assert.equal(invalid.parsed.error.code, "INVALID_ARGUMENTS");
    await assertAbsent(freshOutput);
    await assertAbsent(freshReceipt);
  }

  const relativeDestination = runBuilder(root, "relative-output", path.join(container, "relative-receipt.json"));
  assert.equal(relativeDestination.status, 4);
  assert.equal(relativeDestination.parsed.error.code, "UNSUPPORTED_DESTINATION_PATH");

  const missingParent = runBuilder(
    root,
    path.join(container, "missing-parent", "output"),
    path.join(container, "missing-receipt-parent", "receipt.json"),
  );
  assert.equal(missingParent.status, 4);
  assert.equal(missingParent.parsed.error.code, "PARENT_DIRECTORY_MISSING");
});

test("rejects source and output link boundaries", async (t) => {
  const { container, root } = await makeRepository();
  t.after(() => rm(container, { recursive: true, force: true }));
  const sourceLink = path.join(container, "source-link");
  await symlink(root, sourceLink, process.platform === "win32" ? "junction" : "dir");
  const linkedSourceOutput = path.join(container, "linked-source-output");
  const linkedSourceReceipt = path.join(container, "linked-source-receipt.json");
  const linkedSource = runBuilder(sourceLink, linkedSourceOutput, linkedSourceReceipt);
  assert.notEqual(linkedSource.status, 0);
  assert.equal(linkedSource.parsed.error.code, "UNSUPPORTED_DESTINATION_PATH");
  await assertAbsent(linkedSourceOutput);
  await assertAbsent(linkedSourceReceipt);

  const outside = path.join(container, "outside");
  const outputParent = path.join(container, "output-parent-link");
  await mkdir(outside);
  await symlink(outside, outputParent, process.platform === "win32" ? "junction" : "dir");
  const linkedOutput = path.join(outputParent, "public output");
  const linkedReceipt = path.join(container, "linked-output-receipt.json");
  const outputResult = runBuilder(root, linkedOutput, linkedReceipt);
  assert.notEqual(outputResult.status, 0);
  assert.equal(outputResult.parsed.error.code, "UNSUPPORTED_DESTINATION_PATH");
  await assertAbsent(linkedOutput);
  await assertAbsent(linkedReceipt);
});

test("receipt file set exactly matches the shared-policy checker", async (t) => {
  const { container, root } = await makeRepository({ internalFiles: true });
  t.after(() => rm(container, { recursive: true, force: true }));
  const output = path.join(container, "public output");
  const receiptPath = path.join(container, "receipt.json");
  const built = runBuilder(root, output, receiptPath);
  assert.equal(built.status, 0);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  git(output, ["init", "--quiet"]);
  git(output, ["add", "."]);
  for (const entry of receipt.files) {
    git(output, ["update-index", entry.mode === "100755" ? "--chmod=+x" : "--chmod=-x", "--", entry.path]);
  }
  git(output, [
    "-c",
    "user.name=Useful Test",
    "-c",
    "user.email=useful-test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "public snapshot",
  ]);
  const checked = spawnSync(process.execPath, [checkerPath, "--repo-root", output, "--json"], {
    encoding: "utf8",
  });
  assert.equal(checked.status, 0, checked.stdout);
  assert.equal(checked.stderr, "");
  const check = JSON.parse(checked.stdout);
  assert.equal(check.authoritative, true);
  assert.deepEqual(check.included, receipt.files);
  assert.equal(check.receiptManifestSha256, receipt.summary.manifestSha256);
  const treeLines = git(output, ["ls-tree", "-r", "-z", "--full-tree", "HEAD"])
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+) blob ([0-9a-f]+)\t([\s\S]+)$/.exec(line);
      assert.notEqual(match, null, line);
      return { mode: match[1], object: match[2], path: match[3] };
    });
  assert.equal(treeLines.length, receipt.files.length);
  for (const [index, actual] of treeLines.entries()) {
    const expected = receipt.files[index];
    const bytes = gitBytes(output, ["cat-file", "blob", actual.object]);
    assert.equal(actual.path, expected.path);
    assert.equal(actual.mode, expected.mode);
    assert.equal(bytes.length, expected.bytes);
    assert.equal(sha256(bytes), expected.sha256);
  }
  assert.equal(receipt.summary.fileCount, receipt.files.length);
  assert.equal(receipt.summary.totalBytes, receipt.files.reduce((total, entry) => total + entry.bytes, 0));
  assert.equal(receipt.summary.manifestSha256, computeReceiptManifestSha256(receipt.files));
  assert.equal(
    receipt.summary.snapshotSha256,
    sha256(
      `commit ${receipt.source.commit}\ntree ${receipt.source.tree}\npolicy ${PUBLIC_SOURCE_POLICY_SCHEMA}\nmanifest ${receipt.summary.manifestSha256}\nfiles ${receipt.summary.fileCount}\nbytes ${receipt.summary.totalBytes}\n`,
    ),
  );
  assert.deepEqual((await readdir(output)).includes("receipt.json"), false);
});

test("second-stage receipt race preserves the competitor and leaves an explicit incomplete transaction", async (t) => {
  const { container, root } = await makeRepository();
  t.after(() => rm(container, { recursive: true, force: true }));
  const output = path.join(container, "public output");
  const receipt = path.join(container, "receipt.json");

  await assert.rejects(
    generate(
      { repoRoot: root, output, receipt },
      {
        testHooks: {
          async beforeReceiptCreate() {
            await writeFile(receipt, "competitor receipt\n");
          },
        },
      },
    ),
    (error) => error instanceof BuilderError && error.code === "DESTINATION_RACE" && error.exitCode === 4,
  );

  assert.equal(await readFile(receipt, "utf8"), "competitor receipt\n");
  const markerPath = `${output}.useful-public-source.transaction.json`;
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  assert.equal(marker.phase, "incomplete");
  assert.equal(marker.authoritative, false);
  assert.equal(marker.errorCode, "DESTINATION_RACE");
  assert.equal((await readdir(output)).length > 0, true);
});

test("output reservation race uses mkdir no-replace and never alters the competing directory", async (t) => {
  const { container, root } = await makeRepository();
  t.after(() => rm(container, { recursive: true, force: true }));
  const output = path.join(container, "public output");
  const receipt = path.join(container, "receipt.json");

  await assert.rejects(
    generate(
      { repoRoot: root, output, receipt },
      {
        testHooks: {
          async afterTransactionStarted() {
            await mkdir(output);
            await write(output, "competitor.txt", "keep\n");
          },
        },
      },
    ),
    (error) => error instanceof BuilderError && error.code === "DESTINATION_RACE" && error.exitCode === 4,
  );

  assert.equal(await readFile(path.join(output, "competitor.txt"), "utf8"), "keep\n");
  await assertAbsent(receipt);
  const marker = JSON.parse(await readFile(`${output}.useful-public-source.transaction.json`, "utf8"));
  assert.equal(marker.phase, "incomplete");
});

test("identity-changing a transaction marker never lets cleanup overwrite or delete the replacement", async (t) => {
  const { container, root } = await makeRepository();
  t.after(() => rm(container, { recursive: true, force: true }));
  const output = path.join(container, "public output");
  const receipt = path.join(container, "receipt.json");
  const replacement = '{"phase":"incomplete","nonce":"competitor","authoritative":false}\n';

  await assert.rejects(
    generate(
      { repoRoot: root, output, receipt },
      {
        testHooks: {
          async beforeTransactionComplete({ marker }) {
            await rename(marker, `${marker}.owned-original`);
            await writeFile(marker, replacement);
          },
        },
      },
    ),
    (error) =>
      error instanceof BuilderError &&
      error.code === "TRANSACTION_IDENTITY_CHANGED" &&
      error.details.cleanupErrors.includes("TRANSACTION_IDENTITY_CHANGED"),
  );

  assert.equal(await readFile(`${output}.useful-public-source.transaction.json`, "utf8"), replacement);
});

test("revalidates every existing destination ancestor identity after transaction start", async (t) => {
  const { container, root } = await makeRepository();
  t.after(() => rm(container, { recursive: true, force: true }));
  const destinationParent = path.join(container, "destination-parent");
  const movedParent = path.join(container, "destination-parent-moved");
  await mkdir(destinationParent);
  const output = path.join(destinationParent, "public output");
  const receipt = path.join(destinationParent, "receipt.json");

  await assert.rejects(
    generate(
      { repoRoot: root, output, receipt },
      {
        testHooks: {
          async afterTransactionStarted() {
            await rename(destinationParent, movedParent);
            await mkdir(destinationParent);
          },
        },
      },
    ),
    (error) => error instanceof BuilderError && error.code === "PATH_IDENTITY_CHANGED" && error.exitCode === 4,
  );

  const movedMarker = JSON.parse(
    await readFile(path.join(movedParent, "public output.useful-public-source.transaction.json"), "utf8"),
  );
  assert.equal(movedMarker.phase, "incomplete");
  await assertAbsent(output);
  await assertAbsent(receipt);
});

test("rejects hard-linked source files before creating any destination", async (t) => {
  const { container, root } = await makeRepository();
  t.after(() => rm(container, { recursive: true, force: true }));
  await link(path.join(root, "README.md"), path.join(container, "README-hardlink.md"));
  const output = path.join(container, "public output");
  const receipt = path.join(container, "receipt.json");

  const result = runBuilder(root, output, receipt);
  assert.equal(result.status, 3);
  assert.equal(result.parsed.error.code, "SOURCE_POLICY_FAILED");
  assert.equal(
    result.parsed.error.details.violations.some(
      (entry) => entry.path === "README.md" && entry.code === "non-regular-file",
    ),
    true,
  );
  await assertAbsent(output);
  await assertAbsent(receipt);
});

test("Windows destination syntax rejects namespaces, UNC, ADS, reserved names, and trailing aliases", () => {
  const cases = [
    "\\\\server\\share\\output",
    "\\\\?\\C:\\safe\\output",
    "\\\\.\\C:\\safe\\output",
    "C:\\safe\\name:stream",
    "C:\\safe\\CON\\output",
    "C:\\PROGRA~1\\output",
    "C:\\safe\\output.",
    "C:\\safe\\output ",
    `C:\\safe\\${"a".repeat(240)}`,
  ];
  for (const candidate of cases) {
    assert.notEqual(getLocalAbsolutePathViolation(candidate, { platform: "win32" }), null, candidate);
  }
});
