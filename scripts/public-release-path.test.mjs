import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { generateRootLicense } from "./generate-root-license.mjs";
import { generate } from "./prepare-public-source.mjs";
import { REQUIRED_PUBLIC_FILES, sha256 } from "./public-source-policy.mjs";

const canonicalTempRoot = realpathSync.native(tmpdir());
const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDirectory, "..");
const verifierPath = path.join(scriptsDirectory, "verify-public-commit.mjs");
const checkerPath = path.join(scriptsDirectory, "public-source-check.mjs");

function git(root, args) {
  const result = spawnSync("git", ["-c", `safe.directory=${root}`, ...args], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

async function write(root, relative, contents) {
  const absolute = path.join(root, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
}

test("owner-approved LICENSE unlocks prepare + strict check on a clean synthetic tree", async () => {
  const container = await mkdtemp(path.join(canonicalTempRoot, "useful-owner-path-"));
  const source = path.join(container, "source");
  const output = path.join(container, "public-out");
  const receipt = path.join(container, "public-out.receipt.json");
  try {
    await mkdir(source);
    const approvalPath = path.join(container, "approval.json");
    await writeFile(
      approvalPath,
      JSON.stringify(
        {
          schemaVersion: "useful.license-mapping-approval.v1",
          approved: true,
          legalReviewer: "Synthetic Counsel",
          reviewedOn: "2026-08-06",
          mapping: {
            desktopRust: "MPL-2.0",
            backend: "AGPL-3.0-or-later",
            protocolSdkCliExamples: "Apache-2.0",
            docs: "CC-BY-4.0",
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    for (const relative of REQUIRED_PUBLIC_FILES.filter((candidate) => candidate !== "LICENSE")) {
      await write(source, relative, relative + "\n");
    }
    await write(
      source,
      "apps/useful/package.json",
      JSON.stringify({ name: "@useful/app", license: "MPL-2.0" }, null, 2) + "\n",
    );
    await cp(path.join(repoRoot, "licenses"), path.join(source, "licenses"), { recursive: true });

    const licenseResult = await generateRootLicense({
      repoRoot: source,
      holder: "Synthetic Legal Entity Ltd.",
      year: "2026",
      mappingApprovalPath: approvalPath,
      outputRelative: "LICENSE",
    });
    assert.equal(licenseResult.ok, true);
    assert.match(await readFile(path.join(source, "LICENSE"), "utf8"), /Synthetic Legal Entity Ltd\./);

    git(source, ["init", "--quiet"]);
    git(source, ["add", "."]);
    git(source, [
      "-c",
      "user.name=Useful Path Test",
      "-c",
      "user.email=useful-path@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "public candidate",
    ]);

    const prepared = await generate({
      repoRoot: source,
      output,
      receipt,
    });
    assert.equal(prepared.ok, true);
    assert.equal(prepared.authoritative, true);

    const receiptJson = JSON.parse(await readFile(receipt, "utf8"));
    assert.equal(receiptJson.authoritative, true);
    assert.ok(receiptJson.files.some((entry) => entry.path === "LICENSE"));
    assert.ok(receiptJson.files.some((entry) => entry.path.startsWith("licenses/")));

    const marker = JSON.parse(
      await readFile(`${output}.useful-public-source.transaction.json`, "utf8"),
    );
    assert.equal(marker.phase, "complete");
    // The verifier targets a reviewed public Git worktree, not the bare prepared directory.
    git(output, ["init", "--quiet"]);
    git(output, ["add", "."]);
    for (const entry of receiptJson.files) {
      git(output, ["update-index", entry.mode === "100755" ? "--chmod=+x" : "--chmod=-x", "--", entry.path]);
    }
    git(output, [
      "-c",
      "user.name=Useful Path Test",
      "-c",
      "user.email=useful-path@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "import public snapshot",
    ]);


    const strictCheck = spawnSync(
      process.execPath,
      [checkerPath, "--repo-root", output, "--json"],
      {
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    assert.equal(strictCheck.status, 0, strictCheck.stderr || strictCheck.stdout);
    const strictJson = JSON.parse(strictCheck.stdout);
    assert.equal(strictJson.ok, true);
    assert.equal(strictJson.authoritative, true);

    const check = spawnSync(
      process.execPath,
      [
        verifierPath,
        "--repo-root",
        output,
        "--receipt",
        receipt,
        "--transaction-marker",
        `${output}.useful-public-source.transaction.json`,
        "--json",
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    if (check.status !== 0) {
      console.error(check.stdout);
      console.error(check.stderr);
    }
    assert.equal(check.status, 0, check.stderr);
    const checkJson = JSON.parse(check.stdout);
    assert.equal(checkJson.ok, true);
    assert.equal(checkJson.authoritative, true);
    assert.equal(checkJson.transactionMarkerVerified, true);
    assert.equal(checkJson.receiptSha256, marker.receiptSha256);
    assert.equal(checkJson.transactionMarkerSha256, sha256(await readFile(`${output}.useful-public-source.transaction.json`)));
  } finally {
    await rm(container, { recursive: true, force: true });
  }
});
