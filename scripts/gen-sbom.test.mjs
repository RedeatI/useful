import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { generateSbom, runCli } from "./gen-sbom.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = path.join(repoRoot, "scripts", "media-runtimes.lock.json");
const revision = "12".repeat(20);

function successfulExec(command, args) {
  if (command === "cargo") return JSON.stringify({
    workspace_members: ["useful-app 1.2.3"],
    packages: [
      { id: "dep-b 2.0.0", name: "dep-b", version: "2.0.0", license: "Apache-2.0", repository: "https://example.test/dep-b" },
      { id: "useful-app 1.2.3", name: "useful-app", version: "1.2.3" },
      { id: "dep-a 1.0.0", name: "dep-a", version: "1.0.0", license: "MIT" },
    ],
  });
  if (command === "pnpm") return JSON.stringify({
    MIT: [{ name: "npm-a", versions: ["2.0.0", "1.0.0"], homepage: "https://example.test/npm-a" }],
    ISC: [{ name: "npm-b", version: "3.0.0" }],
  });
  if (command === "git" && args[0] === "rev-parse") return revision;
  if (command === "git" && args[0] === "show") return "1700000000";
  throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
}

test("same exact source and dependencies produce byte-identical SBOMs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "useful-sbom-"));
  try {
    const firstPath = path.join(root, "first.json");
    const secondPath = path.join(root, "second.json");
    const first = await generateSbom({ rootPath: root, outputPath: firstPath, lockPath, execFile: successfulExec, env: {} });
    const second = await generateSbom({ rootPath: root, outputPath: secondPath, lockPath, execFile: successfulExec, env: {} });
    assert.deepEqual(second.bom, first.bom);
    assert.deepEqual(await readFile(secondPath), await readFile(firstPath));
    assert.equal(first.bom.metadata.timestamp, "2023-11-14T22:13:20.000Z");
    assert.match(first.bom.serialNumber, /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.deepEqual(
      first.bom.components.filter(({ name }) => ["ffmpeg", "ffprobe", "mpv"].includes(name)).map(({ name, version }) => [name, version]),
      [["ffmpeg", "8.1.2"], ["ffprobe", "8.1.2"], ["mpv", "20260610-git-304426c"]],
    );
    assert.ok(first.bom.components.filter(({ name }) => ["ffmpeg", "ffprobe", "mpv"].includes(name)).every(({ properties }) => (
      properties.some(({ name, value }) => name === "useful:media:releaseEdition" && value === "windows-x64-portable-full")
    )));
    assert.equal(first.bom.metadata.tools[0].vendor, "Useful");
    assert.equal(first.bom.metadata.component.name, "Useful");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cargo or pnpm dependency collection failure is nonzero and writes no SBOM", async () => {
  for (const failedCommand of ["cargo", "pnpm"]) {
    const root = await mkdtemp(path.join(os.tmpdir(), `useful-sbom-${failedCommand}-`));
    try {
      const outputPath = path.join(root, "sbom.cdx.json");
      const stderr = { value: "", write(value) { this.value += value; } };
      const exitCode = await runCli({
        rootPath: root,
        outputPath,
        lockPath,
        env: { SOURCE_DATE_EPOCH: "1700000000" },
        execFile(command, args) {
          if (command === failedCommand) throw new Error(`${command} collection failed`);
          return successfulExec(command, args);
        },
        stdout: { write() {} },
        stderr,
      });
      assert.equal(exitCode, 1);
      assert.match(stderr.value, new RegExp(`${failedCommand} collection failed`));
      await assert.rejects(() => readFile(outputPath), /ENOENT/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
