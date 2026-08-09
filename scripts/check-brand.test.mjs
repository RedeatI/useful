import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inspectBrand } from "./check-brand.mjs";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const checker = path.join(scriptsDirectory, "check-brand.mjs");
const formerName = ["tool", "box"].join("");
const formerAbbreviation = ["t", "b", "x"].join("");
const formerLocalizedName = ["工具", "箱"].join("");

function git(root, args) {
  const child = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
}

async function makeRepository(t, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "useful-brand-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ["init", "--quiet"]);
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
  }
  git(root, ["add", "."]);
  return root;
}

test("accepts a tracked tree that uses only the Useful identity", async (t) => {
  const root = await makeRepository(t, {
    "README.md": "# Useful\n",
    "packages/useful/package.json": '{"name":"@useful/example"}\n',
  });

  const result = await inspectBrand({ repoRoot: root });

  assert.equal(result.ok, true);
  assert.equal(result.trackedFileCount, 2);
  assert.deepEqual(result.violations, []);
});

test("rejects former product tokens in tracked paths and text", async (t) => {
  const root = await makeRepository(t, {
    [`docs/${formerName}-migration.md`]: `old prefix ${formerAbbreviation}\n`,
  });

  const result = await inspectBrand({ repoRoot: root });
  const codes = new Set(result.violations.map((entry) => entry.code));
  const kinds = new Set(result.violations.map((entry) => entry.details?.kind));

  assert.equal(result.ok, false);
  assert.equal(codes.has("legacy-brand-path"), true);
  assert.equal(codes.has("legacy-brand-content"), true);
  assert.equal(kinds.has("former-name"), true);
  assert.equal(kinds.has("former-abbreviation"), true);
});

test("rejects the former localized product name in tracked paths and text", async (t) => {
  const root = await makeRepository(t, {
    [`docs/${formerLocalizedName}.md`]: `${formerLocalizedName}\n`,
  });

  const result = await inspectBrand({ repoRoot: root });

  assert.equal(result.ok, false);
  assert.equal(result.violations.some((entry) => entry.code === "legacy-brand-path"), true);
  assert.equal(result.violations.some((entry) => entry.code === "legacy-brand-content"), true);
  assert.equal(result.violations.some((entry) => entry.details?.kind === "former-localized-name"), true);
});

test("records both path and content evidence for the same former name", async (t) => {
  const root = await makeRepository(t, {
    [`docs/${formerName}.md`]: `${formerName}\n`,
  });

  const result = await inspectBrand({ repoRoot: root });
  const evidence = result.violations.filter((entry) => entry.path === `docs/${formerName}.md`);

  assert.equal(evidence.some((entry) => entry.code === "legacy-brand-path"), true);
  assert.equal(evidence.some((entry) => entry.code === "legacy-brand-content"), true);
});

test("allows an abbreviation-shaped integrity substring but rejects old identifiers", async (t) => {
  const hashLikeAbbreviation = `${formerAbbreviation.slice(0, 2).toUpperCase()}${formerAbbreviation.slice(2)}`;
  const root = await makeRepository(t, {
    "pnpm-lock.yaml": `integrity: sha512-a${hashLikeAbbreviation}M7randomdigest\n`,
    "src/old-api.mjs": `export const read${formerAbbreviation[0].toUpperCase()}${formerAbbreviation.slice(1)}Manifest = true;\n`,
  });

  const result = await inspectBrand({ repoRoot: root });

  assert.equal(result.violations.some((entry) => entry.path === "pnpm-lock.yaml"), false);
  assert.equal(result.violations.some((entry) => entry.path === "src/old-api.mjs"), true);
});

test("rejects abbreviation identifiers at start, PascalCase, and embedded lower camel boundaries", async (t) => {
  const pascal = `${formerAbbreviation[0].toUpperCase()}${formerAbbreviation.slice(1)}`;
  const root = await makeRepository(t, {
    "src/lower-start.mjs": `export const ${formerAbbreviation}Manifest = true;\n`,
    "src/pascal-start.mjs": `export class ${pascal}Manifest {}\n`,
    "src/embedded-lower.mjs": `export const read${formerAbbreviation}Manifest = true;\n`,
  });

  const result = await inspectBrand({ repoRoot: root });

  assert.equal(result.ok, false);
  assert.equal(result.violations.filter((entry) => entry.code === "legacy-brand-content").length, 3);
});

test("scans nonstandard lock files for former identifiers", async (t) => {
  const root = await makeRepository(t, {
    "config/policy.lock": `${formerAbbreviation}-setting=true\n`,
  });

  const result = await inspectBrand({ repoRoot: root });

  assert.equal(result.ok, false);
  assert.equal(result.violations[0].path, "config/policy.lock");
});

test("scans generated lock identities while ignoring only opaque digest tokens", async (t) => {
  const root = await makeRepository(t, {
    "pnpm-lock.yaml": `packages:\n  '@${formerAbbreviation}/example':\n    resolution: {integrity: sha512-a${formerAbbreviation}M7randomdigest==}\n`,
    "Cargo.lock": `[[package]]\nname = "${formerAbbreviation}-core"\nchecksum = "abcdef0123456789"\n`,
    "services/go.sum": `example.com/${formerAbbreviation}/module v1.0.0 h1:a${formerAbbreviation}M7randomdigest=\n`,
  });

  const result = await inspectBrand({ repoRoot: root });
  const paths = new Set(result.violations.map((entry) => entry.path));

  assert.equal(paths.has("pnpm-lock.yaml"), true);
  assert.equal(paths.has("Cargo.lock"), true);
  assert.equal(paths.has("services/go.sum"), true);
});

test("rejects fully lowercase former abbreviations inside identifiers", async (t) => {
  const root = await makeRepository(t, {
    "src/lowercase.mjs": `export const read${formerAbbreviation}manifest = true;\n`,
  });

  const result = await inspectBrand({ repoRoot: root });
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].details.kind, "former-abbreviation");
});

test("rejects a former identity encoded as UTF-16LE text", async (t) => {
  const root = await makeRepository(t, {
    "docs/utf16.txt": Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(`${formerName}\n`, "utf16le"),
    ]),
  });

  const result = await inspectBrand({ repoRoot: root });

  assert.equal(result.ok, false);
  assert.equal(result.violations[0].details.kind, "former-name");
});

test("binary scanning rejects the former full name without treating a short byte sequence as text", async (t) => {
  const root = await makeRepository(t, {
    "assets/long.bin": Buffer.concat([Buffer.from([0, 255]), Buffer.from(formerName)]),
    "assets/short.bin": Buffer.concat([Buffer.from([0, 255]), Buffer.from(formerAbbreviation)]),
  });

  const result = await inspectBrand({ repoRoot: root });

  assert.equal(result.ok, false);
  assert.equal(result.violations.some((entry) => entry.path === "assets/long.bin"), true);
  assert.equal(result.violations.some((entry) => entry.path === "assets/short.bin"), false);
});

test("CLI emits one JSON document and a stable blocked exit code", async (t) => {
  const root = await makeRepository(t, { "README.md": `${formerName}\n` });
  const child = spawnSync(process.execPath, [checker, "--repo-root", root, "--json"], {
    encoding: "utf8",
    windowsHide: true,
  });

  assert.equal(child.status, 3);
  assert.equal(child.stderr, "");
  const result = JSON.parse(child.stdout);
  assert.equal(result.ok, false);
  assert.equal(result.violationCount, 1);
});
