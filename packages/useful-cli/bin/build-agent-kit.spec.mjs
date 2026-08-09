import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BUILTIN_ACTIONS } from "../../action-runtime/src/builtins.mjs";
import { ACTION_IDS } from "../../action-runtime/src/semantics.mjs";
import { OFFICE_ACTION_IDS } from "../../action-runtime/src/office-actions.mjs";
import {
  HOST_ACTION_IDS,
  createHostActionEntries,
  loadHostActionConfig,
} from "../../host-actions/src/index.mjs";
import { DISCOVERY_TOOL_NAMES } from "../../useful-mcp/src/server.mjs";
import {
  AGENT_KIT_SCHEMA_VERSION,
  AgentKitError,
  buildAgentKit,
  inspectAgentKitZip,
} from "./build-agent-kit.mjs";

const toolingRoot = fileURLToPath(new URL("../../..", import.meta.url));
const requireFromMcp = createRequire(path.join(toolingRoot, "packages/useful-mcp/package.json"));
const { Client } = await import(pathToFileURL(requireFromMcp.resolve("@modelcontextprotocol/client")).href);
const { StdioClientTransport } = await import(pathToFileURL(requireFromMcp.resolve("@modelcontextprotocol/client/stdio")).href);
const temporaryRoots = [];
const AGENT_KIT_FIXTURE_TIMEOUT_MS = 30_000;
const expectedDefaultActionIds = Object.freeze(
  [...Object.values(ACTION_IDS), ...Object.values(OFFICE_ACTION_IDS)].sort(),
);
const reservedMcpHelperNames = Object.freeze(Object.values(DISCOVERY_TOOL_NAMES));
const fixturePaths = [
  "LICENSE",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "LICENSES.md",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
  "TRADEMARKS.md",
  "licenses",
  "packages/action-contract",
  "packages/action-runtime",
  "packages/agent-integrations",
  "packages/agent-profile",
  "packages/host-actions",
  "packages/office-core",
  "packages/plugin-actions",
  "packages/protocol",
  "packages/useful-cli",
  "packages/useful-mcp",
  "packages/useful-runtime",
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function makeCaseCollisionZip(original) {
  const bytes = Buffer.from(original);
  const endOffset = bytes.length - 22;
  const entryCount = bytes.readUInt16LE(endOffset + 10);
  let cursor = bytes.readUInt32LE(endOffset + 16);
  const records = [];
  for (let index = 0; index < entryCount; index += 1) {
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    records.push({
      name: bytes.subarray(nameStart, nameStart + nameLength).toString("utf8"),
      nameLength,
      nameStart,
      localNameStart: localOffset + 30,
    });
    cursor = nameStart + nameLength + extraLength + commentLength;
  }
  for (const source of records) {
    if (!/^[\x20-\x7e]+$/.test(source.name) || !/[A-Za-z]/.test(source.name)) continue;
    const variant = source.name === source.name.toLowerCase() ? source.name.toUpperCase() : source.name.toLowerCase();
    const replacement = Buffer.from(variant, "utf8");
    const target = records.find((record) => record !== source && record.nameLength === replacement.length);
    if (!target) continue;
    replacement.copy(bytes, target.nameStart);
    replacement.copy(bytes, target.localNameStart);
    return bytes;
  }
  throw new Error("Agent Kit test fixture has no equal-length entry pair for a portable collision");
}

function renameZipEntrySameLength(original, sourceName, replacementName) {
  const bytes = Buffer.from(original);
  const sourceBytes = Buffer.from(sourceName, "utf8");
  const replacementBytes = Buffer.from(replacementName, "utf8");
  if (sourceBytes.length !== replacementBytes.length) throw new Error("ZIP entry replacement must preserve byte length");
  const endOffset = bytes.length - 22;
  const entryCount = bytes.readUInt16LE(endOffset + 10);
  let cursor = bytes.readUInt32LE(endOffset + 16);
  for (let index = 0; index < entryCount; index += 1) {
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    if (nameLength === sourceBytes.length && bytes.subarray(nameStart, nameStart + nameLength).equals(sourceBytes)) {
      replacementBytes.copy(bytes, nameStart);
      replacementBytes.copy(bytes, localOffset + 30);
      return bytes;
    }
    cursor = nameStart + nameLength + extraLength + commentLength;
  }
  throw new Error(`Agent Kit test fixture entry is missing: ${sourceName}`);
}

function copyFixturePath(relative, fixtureRoot) {
  const source = path.join(toolingRoot, ...relative.split("/"));
  const destination = path.join(fixtureRoot, ...relative.split("/"));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, {
    recursive: true,
    filter: (candidate) => !candidate.split(path.sep).includes("node_modules"),
  });
}

function git(fixtureRoot, args, env = {}) {
  return execFileSync("git", args, {
    cwd: fixtureRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, ...env },
  }).trim();
}

function makeCleanFixture({ license = true } = {}) {
  const outer = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "useful-agent-kit-fixture-"));
  temporaryRoots.push(outer);
  const fixtureRoot = path.join(outer, "clean source");
  fs.mkdirSync(fixtureRoot);
  for (const relative of fixturePaths) {
    if (relative === "LICENSE" && !license) continue;
    copyFixturePath(relative, fixtureRoot);
  }
  git(fixtureRoot, ["init", "--quiet"]);
  git(fixtureRoot, ["config", "user.name", "Useful Agent Kit Test"]);
  git(fixtureRoot, ["config", "user.email", "agent-kit-test@example.invalid"]);
  git(fixtureRoot, ["add", "--all"]);
  const commitEnvironment = {
    GIT_AUTHOR_DATE: "2026-02-02T03:04:06Z",
    GIT_COMMITTER_DATE: "2026-02-02T03:04:06Z",
  };
  git(fixtureRoot, ["commit", "--quiet", "-m", "agent kit fixture"], commitEnvironment);
  expect(git(fixtureRoot, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe("");
  return { outer, fixtureRoot };
}

function extract(entries, destination) {
  for (const [name, entry] of entries) {
    const target = path.join(destination, ...name.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.data, { mode: entry.mode & 0o777 });
    if (process.platform !== "win32") fs.chmodSync(target, entry.mode & 0o777);
  }
}

function runLauncher(kitRoot, name, args, options = {}) {
  const launcher = path.join(kitRoot, "bin", process.platform === "win32" ? `${name}.cmd` : name);
  const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : launcher;
  const commandArgs = process.platform === "win32" ? ["/d", "/s", "/c", "call", launcher, ...args] : args;
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? kitRoot,
    encoding: "utf8",
    input: options.input,
    windowsHide: true,
  });
  let json;
  let jsonError;
  if (result.stdout) {
    try { json = JSON.parse(result.stdout); } catch (error) { jsonError = error; }
  }
  return {
    ...result,
    json,
    jsonError,
  };
}

function expectJsonSuccess(result) {
  expect(result.status, JSON.stringify({ stdout: result.stdout, stderr: result.stderr, error: result.error?.message, jsonError: result.jsonError?.message })).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.trim().split(/\r?\n/)).toHaveLength(1);
  expect(result.json).toMatchObject({ ok: true });
  return result.json.data;
}

function expectRuntimeJson(result) {
  expect(result.status, JSON.stringify({ stdout: result.stdout, stderr: result.stderr, error: result.error?.message, jsonError: result.jsonError?.message })).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.trim().split(/\r?\n/)).toHaveLength(1);
  return result.json;
}

function expectRuntimeSuccess(result) {
  const json = expectRuntimeJson(result);
  expect(json).toMatchObject({ ok: true });
  return json;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Useful Agent Kit builder", () => {
  it("fails closed for a clean repository without the required root LICENSE", async () => {
    const fixture = makeCleanFixture({ license: false });
    await expect(buildAgentKit({
      repoRoot: fixture.fixtureRoot,
      dependencyRoot: toolingRoot,
      outDir: path.join(fixture.outer, "out"),
    })).rejects.toMatchObject({
      name: "AgentKitError",
      code: "PATH_MISSING",
      exitCode: 3,
    });
  }, AGENT_KIT_FIXTURE_TIMEOUT_MS);

  it("rejects a clean commit whose legal map differs from the owner-approved digest", async () => {
    const fixture = makeCleanFixture();
    fs.appendFileSync(path.join(fixture.fixtureRoot, "LICENSE"), "tampered\n");
    git(fixture.fixtureRoot, ["add", "LICENSE"]);
    git(fixture.fixtureRoot, ["commit", "--quiet", "-m", "tamper license"]);
    await expect(buildAgentKit({
      repoRoot: fixture.fixtureRoot,
      dependencyRoot: toolingRoot,
      outDir: path.join(fixture.outer, "out"),
    })).rejects.toMatchObject({
      name: "AgentKitError",
      code: "LEGAL_MAPPING_UNAPPROVED",
      exitCode: 5,
    });
  }, AGENT_KIT_FIXTURE_TIMEOUT_MS);

  it("rejects relevant dirty and untracked source instead of attributing it to HEAD", async () => {
    const fixture = makeCleanFixture();
    fs.appendFileSync(path.join(fixture.fixtureRoot, "packages/action-runtime/src/action-suggest.mjs"), "\n");
    fs.appendFileSync(path.join(fixture.fixtureRoot, "packages/action-runtime/src/recipe.mjs"), "\n");
    fs.writeFileSync(path.join(fixture.fixtureRoot, "packages/useful-cli/untracked.txt"), "dirty\n");
    await expect(buildAgentKit({
      repoRoot: fixture.fixtureRoot,
      dependencyRoot: toolingRoot,
      outDir: path.join(fixture.outer, "out"),
    })).rejects.toMatchObject({ code: "SOURCE_DIRTY", exitCode: 3 });
  }, AGENT_KIT_FIXTURE_TIMEOUT_MS);

  it("rejects dirty agent integration source", async () => {
    const fixture = makeCleanFixture();
    fs.appendFileSync(path.join(fixture.fixtureRoot, "packages/agent-integrations/src/integration.mjs"), "\n");
    await expect(buildAgentKit({
      repoRoot: fixture.fixtureRoot,
      dependencyRoot: toolingRoot,
      outDir: path.join(fixture.outer, "out"),
    })).rejects.toMatchObject({ code: "SOURCE_DIRTY", exitCode: 3 });
  }, AGENT_KIT_FIXTURE_TIMEOUT_MS);

  it("rejects linked repository and output path components before reading or creating through them", async () => {
    const fixture = makeCleanFixture();
    const linkedRoot = path.join(fixture.outer, "linked source");
    fs.symlinkSync(fixture.fixtureRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    await expect(buildAgentKit({
      repoRoot: linkedRoot,
      dependencyRoot: toolingRoot,
      outDir: path.join(fixture.outer, "out"),
    })).rejects.toMatchObject({ code: "PATH_LINK_REJECTED", exitCode: 4 });

    const realOutput = path.join(fixture.outer, "real output");
    const linkedOutput = path.join(fixture.outer, "linked output");
    fs.mkdirSync(realOutput);
    fs.symlinkSync(realOutput, linkedOutput, process.platform === "win32" ? "junction" : "dir");
    await expect(buildAgentKit({
      repoRoot: fixture.fixtureRoot,
      dependencyRoot: toolingRoot,
      outDir: path.join(linkedOutput, "nested"),
    })).rejects.toMatchObject({ code: "PATH_LINK_REJECTED", exitCode: 4 });
  }, AGENT_KIT_FIXTURE_TIMEOUT_MS);

  it("is byte-reproducible, closed, non-overwriting, and runnable from a Chinese path with spaces", async () => {
    const fixture = makeCleanFixture();
    const firstOut = path.join(fixture.outer, "产物 一");
    const secondOut = path.join(fixture.outer, "产物 二");
    const buildOptions = {
      repoRoot: fixture.fixtureRoot,
      dependencyRoot: toolingRoot,
    };
    const priorSourceDateEpoch = process.env.SOURCE_DATE_EPOCH;
    delete process.env.SOURCE_DATE_EPOCH;
    let first;
    let second;
    try {
      first = await buildAgentKit({ ...buildOptions, outDir: firstOut });
      second = await buildAgentKit({ ...buildOptions, outDir: secondOut });
    } finally {
      if (priorSourceDateEpoch === undefined) delete process.env.SOURCE_DATE_EPOCH;
      else process.env.SOURCE_DATE_EPOCH = priorSourceDateEpoch;
    }
    const firstBytes = fs.readFileSync(first.asset.path);
    const secondBytes = fs.readFileSync(second.asset.path);
    expect(firstBytes.equals(secondBytes)).toBe(true);
    expect(first.publicationAuthorized).toBe(false);
    expect(first.legalMappingApproved).toBe(true);
    expect(first.asset.sha256).toBe(sha256(firstBytes));
    expect(fs.readFileSync(first.receipt.path, "utf8")).toBe(`${first.asset.sha256}  ${first.asset.name}\n`);

    const inspected = inspectAgentKitZip(firstBytes);
    expect(inspected.manifest.schemaVersion).toBe(AGENT_KIT_SCHEMA_VERSION);
    expect(inspected.manifest.product).toEqual({ name: "Useful", version: "0.1.0-beta.2" });
    expect(inspected.manifest.source.revision).toBe(git(fixture.fixtureRoot, ["rev-parse", "HEAD"]));
    const listed = inspected.manifest.files.map((entry) => entry.path);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...inspected.entries.keys()].filter((name) => name !== "MANIFEST.json").sort()).toEqual([...listed].sort());
    expect(listed).toEqual(expect.arrayContaining([
      "LICENSE",
      "LICENSES.md",
      "NOTICE",
      "THIRD_PARTY-LICENSES.json",
      "THIRD_PARTY_NOTICES.md",
      "TRADEMARKS.md",
      "licenses/README.md",
      "licenses/MPL-2.0.txt",
      "licenses/Apache-2.0.txt",
      "licenses/AGPL-3.0-or-later.txt",
      "licenses/CC-BY-4.0.txt",
      "lib/office-worker-thread.mjs",
      "lib/regex-worker-thread.mjs",
      "lib/provenance/agent-integrations/integration.d.ts",
      "lib/provenance/agent-integrations/integration.mjs",
      "lib/provenance/action-runtime/action-suggest.mjs",
      "lib/provenance/action-runtime/builtins.mjs",
      "lib/provenance/action-runtime/office-worker-thread.mjs",
      "lib/provenance/action-runtime/recipe.mjs",
      "lib/provenance/action-runtime/regex-worker-thread.mjs",
      "lib/provenance/host-actions/index.mjs",
      "lib/provenance/host-actions/useful.host-actions.v1.schema.json",
      "lib/provenance/office-core/index.mjs",
      "lib/provenance/office-core/pdf.mjs",
      "lib/provenance/office-core/table-markdown.mjs",
      "lib/useful.plugin-action.v1.schema.json",
      "schemas/agent-integration.schema.json",
      "schemas/package-manifest.schema.json",
    ]));
    expect(listed.filter((entry) => /^lib\/[^/]+\.mjs$/.test(entry)).sort()).toEqual([
      "lib/office-worker-thread.mjs",
      "lib/regex-worker-thread.mjs",
      "lib/useful-mcp.mjs",
      "lib/useful-runtime.mjs",
      "lib/useful.mjs",
    ]);
    for (const name of listed.filter((entry) => /^lib\/[^/]+\.mjs$/.test(entry))) {
      const bundle = inspected.entries.get(name).data.toString("utf8").toLowerCase();
      expect(bundle).not.toContain(toolingRoot.replaceAll("\\", "/").toLowerCase());
      expect(bundle).not.toContain(toolingRoot.replaceAll("\\", "\\\\").toLowerCase());
    }
    const kitPackage = JSON.parse(inspected.entries.get("package.json").data.toString("utf8"));
    expect(kitPackage).toMatchObject({ private: true, license: "SEE LICENSE IN LICENSE" });
    const thirdPartyLicenses = JSON.parse(inspected.entries.get("THIRD_PARTY-LICENSES.json").data.toString("utf8"));
    expect(thirdPartyLicenses.schemaVersion).toBe("useful.agent-kit.third-party-licenses.v1");
    expect(thirdPartyLicenses.packages.map((dependency) => dependency.name)).toEqual(expect.arrayContaining([
      "@modelcontextprotocol/server",
      "adm-zip",
      "ajv",
      "fflate",
      "pdf-lib",
      "tslib",
      "yaml",
    ]));
    const tslib = thirdPartyLicenses.packages.find((dependency) => dependency.name === "tslib");
    expect(tslib.files.map((file) => path.posix.basename(file.path))).toContain("CopyrightNotice.txt");
    for (const dependency of thirdPartyLicenses.packages) {
      expect(dependency.license).toEqual(expect.any(String));
      expect(dependency.files.length).toBeGreaterThan(0);
      for (const legal of dependency.files) {
        const entry = inspected.entries.get(legal.path);
        expect(entry).toBeDefined();
        expect(legal.size).toBe(entry.data.length);
        expect(legal.sha256).toBe(sha256(entry.data));
      }
    }
    await expect(buildAgentKit({ ...buildOptions, outDir: firstOut })).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });

    const kitRoot = path.join(fixture.outer, "中文 解压 目录");
    fs.mkdirSync(kitRoot);
    extract(inspected.entries, kitRoot);
    const contract = runLauncher(kitRoot, "useful", ["agent-contract", "--json"]);
    const contractData = expectJsonSuccess(contract);
    expect(contractData.product).toBeUndefined();
    expect(contractData.templates.map((template) => template.id)).toEqual(["minimal-web", "minimal-action", "starter-web"]);
    expect(contractData.commandSequence.slice(0, 7).every((command) => command.startsWith("useful "))).toBe(true);
    expect(contractData.commandSequence.join("\n")).not.toMatch(/\b(?:npx|pnpm\s+dlx)\b/);

    const agentMcpLauncher = path.join(kitRoot, "lib", "useful-mcp.mjs");
    const integrationPlan = expectJsonSuccess(runLauncher(kitRoot, "useful", [
      "agent", "plan",
      "--target", "codex",
      "--launcher", agentMcpLauncher,
      "--env", "NO_COLOR=1",
      "--json",
    ]));
    expect(integrationPlan.plan.schemaVersion).toBe("useful.agent-integration.v1");
    expect(integrationPlan.output.commandArgv).toEqual([
      "codex", "mcp", "add", "useful", "--env", "NO_COLOR=1", "--",
      process.execPath, agentMcpLauncher,
    ]);
    expect(integrationPlan.output.writesHostConfigWhenExecuted).toBe(true);
    const integrationDoctor = expectJsonSuccess(runLauncher(kitRoot, "useful", [
      "agent", "doctor",
      "--target", "mcp-servers-json",
      "--launcher", agentMcpLauncher,
      "--json",
    ]));
    expect(integrationDoctor.ok).toBe(true);
    expect(integrationDoctor.checks.map((check) => check.id)).toEqual(expect.arrayContaining([
      "launcher.file",
      "nodePath.file",
      "node.version",
      "generated-output.parse",
    ]));

    const projectDirectory = path.join(fixture.outer, "explicit project");
    fs.mkdirSync(projectDirectory);
    const projectPlan = expectJsonSuccess(runLauncher(kitRoot, "useful", [
      "agent", "plan",
      "--target", "codex",
      "--launcher", agentMcpLauncher,
      "--scope", "project",
      "--project-dir", projectDirectory,
      "--json",
    ]));
    expect(projectPlan.output).toMatchObject({
      kind: "merge-fragment",
      configPath: path.join(projectDirectory, ".codex", "config.toml"),
      writesHostConfigWhenExecuted: false,
    });
    expect(projectPlan.output.commandArgv).toBeUndefined();

    const runtime = runLauncher(kitRoot, "useful-runtime", ["actions", "list", "--json"]);
    expect(runtime.status).toBe(0);
    expect(runtime.stderr).toBe("");
    expect(runtime.json.actions.map((action) => action.actionId)).toEqual(expectedDefaultActionIds);
    expect(expectedDefaultActionIds).toHaveLength(36);
    expect(runtime.json.actions).toHaveLength(36);
    expect(runtime.json.actions.map((action) => action.actionId)).not.toEqual(expect.arrayContaining(Object.values(HOST_ACTION_IDS)));

    const hostConfig = path.join(fixture.outer, "host-actions.json");
    const fakeProbe = path.join(fixture.outer, process.platform === "win32" ? "ffprobe-test.exe" : "ffprobe-test");
    fs.writeFileSync(fakeProbe, "Agent Kit registration test only; never executed.\n", "utf8");
    if (process.platform !== "win32") fs.chmodSync(fakeProbe, 0o755);
    fs.writeFileSync(hostConfig, `${JSON.stringify({
      schemaVersion: "useful.host-actions.v1",
      ffprobePath: fakeProbe,
      enabled: {
        videoProbe: true,
        videoExport: false,
        processSnapshot: false,
        processTerminate: false,
      },
      readRoots: [fixture.outer],
      writeRoots: [],
      video: {
        allowOverwrite: false,
        maxDurationSec: 3600,
        maxProbeOutputBytes: 1048576,
        videoCodecs: ["copy"],
        audioCodecs: ["copy"],
      },
      process: { fields: ["pid", "startTime"], maxProcesses: 10, maxOutputBytes: 65536 },
    }, null, 2)}\n`, "utf8");
    const hostList = runLauncher(kitRoot, "useful-runtime", ["--host-config", hostConfig, "actions", "list", "--json"]);
    expect(hostList.status, JSON.stringify({ stdout: hostList.stdout, stderr: hostList.stderr })).toBe(0);
    expect(hostList.stderr).toBe("");
    expect(hostList.json.actions.map((action) => action.actionId)).toEqual([
      ...expectedDefaultActionIds,
      HOST_ACTION_IDS.VIDEO_PROBE,
    ].sort());

    for (const actionId of [ACTION_IDS.JSON, OFFICE_ACTION_IDS.MARKDOWN]) {
      const sourceDescriptor = BUILTIN_ACTIONS.find((entry) => entry.descriptor.actionId === actionId).descriptor;
      const described = runLauncher(kitRoot, "useful-runtime", ["actions", "describe", actionId, "--json"]);
      expect(described.status, JSON.stringify({ stdout: described.stdout, stderr: described.stderr })).toBe(0);
      expect(described.json.action.source.digest).toBe(sourceDescriptor.source.digest);
    }
    const sourceHostEntry = createHostActionEntries(await loadHostActionConfig(hostConfig))
      .find((entry) => entry.descriptor.actionId === HOST_ACTION_IDS.VIDEO_PROBE);
    const describedHost = runLauncher(kitRoot, "useful-runtime", [
      "--host-config", hostConfig,
      "actions", "describe", HOST_ACTION_IDS.VIDEO_PROBE, "--json",
    ]);
    expect(describedHost.status, JSON.stringify({ stdout: describedHost.stdout, stderr: describedHost.stderr })).toBe(0);
    expect(describedHost.json.action.source.digest).toBe(sourceHostEntry.descriptor.source.digest);

    const regex = expectRuntimeSuccess(runLauncher(
      kitRoot,
      "useful-runtime",
      ["actions", "run", "builtin.utilities.regex", "--input", "-", "--output", "json"],
      { input: JSON.stringify({ operation: "test", text: "a1 b22", pattern: "\\d+", flags: "g" }) },
    ));
    expect(regex.output.matches.map((match) => match.match)).toEqual(["1", "22"]);

    const office = expectRuntimeSuccess(runLauncher(
      kitRoot,
      "useful-runtime",
      ["actions", "run", "builtin.office.markdown", "--input", "-", "--output", "json"],
      { input: JSON.stringify({ operation: "parse", markdown: "# Useful\n\nLocal office tools." }) },
    ));
    expect(office.output.operation).toBe("parse");
    expect(office.output.blocks.length).toBeGreaterThan(0);

    const suggestionSecret = '{"secret":"AGENT_KIT_SECRET"}';
    const suggested = expectRuntimeJson(runLauncher(
      kitRoot,
      "useful-runtime",
      ["actions", "suggest", "--limit", "3", "--json"],
      { input: suggestionSecret },
    ));
    expect(suggested.operation).toBe("actions.suggest");
    expect(suggested.suggestions[0].actionId).toBe(ACTION_IDS.JSON);
    expect(suggested.suggestions.some((entry) => entry.actionId === ACTION_IDS.DATA_FORMAT)).toBe(true);
    expect(JSON.stringify(suggested)).not.toContain("AGENT_KIT_SECRET");

    const actionRecipe = {
      schemaVersion: "useful.action-recipe.v1",
      input: { source: "{ \"a\": 1 }" },
      steps: [
        { id: "minify", actionId: ACTION_IDS.JSON, input: { operation: "minify", text: { $ref: "/input/source" } } },
        { id: "encode", actionId: ACTION_IDS.BASE64, input: { operation: "encode", text: { $ref: "/steps/minify/output/text" } } },
      ],
      output: { encoded: { $ref: "/steps/encode/output/text" } },
    };
    const recipeResult = expectRuntimeSuccess(runLauncher(
      kitRoot,
      "useful-runtime",
      ["actions", "recipe", "--output", "json"],
      { input: JSON.stringify(actionRecipe) },
    ));
    expect(recipeResult.operation).toBe("actions.recipe.run");
    expect(recipeResult.output).toEqual({ encoded: "eyJhIjoxfQ==" });

    const mcpLauncher = path.join(kitRoot, "bin", process.platform === "win32" ? "useful-mcp.cmd" : "useful-mcp");
    const mcpCommand = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : mcpLauncher;
    const mcpArgs = process.platform === "win32" ? ["/d", "/s", "/c", "call", mcpLauncher] : [];
    const client = new Client({ name: "useful-agent-kit-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: mcpCommand,
      args: mcpArgs,
      cwd: kitRoot,
      env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
      stderr: "pipe",
    });
    let mcpStderr = "";
    transport.stderr?.on("data", (chunk) => { mcpStderr += chunk.toString("utf8"); });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(reservedMcpHelperNames).toEqual([
        "useful.actions.search",
        "useful.actions.describe",
        "useful.actions.suggest",
        "useful.actions.recipe",
      ]);
      expect(new Set(reservedMcpHelperNames).size).toBe(4);
      expect(reservedMcpHelperNames.filter((name) => expectedDefaultActionIds.includes(name))).toEqual([]);
      expect(tools.tools).toHaveLength(40);
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        ...expectedDefaultActionIds,
        ...reservedMcpHelperNames,
      ]);
      const called = await client.callTool({
        name: "builtin.utilities.base64",
        arguments: { operation: "encode", text: "Useful 中文" },
      });
      expect(called.isError).toBeUndefined();
      expect(called.structuredContent.text).toBe(Buffer.from("Useful 中文", "utf8").toString("base64"));

      const suggestedByMcp = await client.callTool({
        name: DISCOVERY_TOOL_NAMES.SUGGEST,
        arguments: { text: suggestionSecret, limit: 3 },
      });
      expect(suggestedByMcp.isError).toBeUndefined();
      expect(suggestedByMcp.structuredContent.suggestions[0].actionId).toBe(ACTION_IDS.JSON);
      expect(JSON.stringify(suggestedByMcp.structuredContent)).not.toContain("AGENT_KIT_SECRET");

      const recipeByMcp = await client.callTool({
        name: DISCOVERY_TOOL_NAMES.RECIPE,
        arguments: { operation: "run", recipe: actionRecipe },
      });
      expect(recipeByMcp.isError).toBeUndefined();
      expect(recipeByMcp.structuredContent.output).toEqual({ encoded: "eyJhIjoxfQ==" });
    } finally {
      await client.close().catch(() => {});
    }
    expect(mcpStderr).toBe("");

    const toolDir = path.join(fixture.outer, "中文 工具");
    const created = expectJsonSuccess(runLauncher(kitRoot, "useful", [
      "create", toolDir,
      "--id", "com.example.agent-kit",
      "--name", "Useful Agent Kit Fixture",
      "--template", "minimal-action",
      "--json",
    ]));
    expect(created.template).toBe("minimal-action");
    expect(fs.existsSync(path.join(toolDir, "actions/base64-sha256.json"))).toBe(true);
    expectJsonSuccess(runLauncher(kitRoot, "useful", ["doctor", toolDir, "--json"]));
    expectJsonSuccess(runLauncher(kitRoot, "useful", ["validate", toolDir, "--json"]));

    const artifactDir = path.join(fixture.outer, "artifacts");
    const packed = expectJsonSuccess(runLauncher(kitRoot, "useful", ["pack", toolDir, artifactDir, "--json"]));
    const publisherDir = path.join(fixture.outer, "publisher");
    const publisher = expectJsonSuccess(runLauncher(kitRoot, "useful", [
      "publisher", "init", publisherDir,
      "--id", "com.example.agent-kit-publisher",
      "--name", "Agent Kit Test Publisher",
      "--json",
    ]));
    const signed = expectJsonSuccess(runLauncher(kitRoot, "useful", [
      "publisher", "sign", packed.artifactPath,
      "--key", publisher.privatePath,
      "--json",
    ]));
    const verified = expectJsonSuccess(runLauncher(kitRoot, "useful", [
      "publisher", "verify", packed.artifactPath, signed.path, "--json",
    ]));
    expect(verified.valid).toBe(true);
    const pluginConfig = path.join(fixture.outer, "plugin-set.json");
    fs.writeFileSync(pluginConfig, `${JSON.stringify({
      schemaVersion: "useful.plugin-set.v1",
      plugins: [{
        artifactPath: path.relative(fixture.outer, packed.artifactPath).replaceAll("\\", "/"),
        signaturePath: path.relative(fixture.outer, signed.path).replaceAll("\\", "/"),
        expectedPublisherKeyId: verified.publisherKeyId,
        expectedArtifactSha256: packed.sha256,
      }],
    }, null, 2)}\n`);
    const pluginList = runLauncher(kitRoot, "useful-runtime", ["--plugin-config", pluginConfig, "actions", "list", "--json"]);
    expect(pluginList.status).toBe(0);
    expect(pluginList.stderr).toBe("");
    expect(pluginList.json.actions.map((action) => action.actionId)).toContain("com.example.agent-kit.base64-sha256");
  }, 120000);

  it("rejects hostile local/central ZIP metadata disagreement", async () => {
    const fixture = makeCleanFixture();
    const built = await buildAgentKit({
      repoRoot: fixture.fixtureRoot,
      dependencyRoot: toolingRoot,
      sourceDateEpoch: "1770001446",
      outDir: path.join(fixture.outer, "out"),
    });
    const original = fs.readFileSync(built.asset.path);
    const endOffset = original.length - 22;
    const centralOffset = original.readUInt32LE(endOffset + 16);
    const mutations = [
      (bytes) => bytes.writeUInt16LE(0, 6),
      (bytes) => bytes.writeUInt16LE(0, centralOffset + 8),
      (bytes) => bytes.writeUInt16LE(8, centralOffset + 10),
      (bytes) => bytes.writeUInt32LE((bytes.readUInt32LE(centralOffset + 16) ^ 1) >>> 0, centralOffset + 16),
      (bytes) => bytes.writeUInt32LE(bytes.readUInt32LE(centralOffset + 24) + 1, centralOffset + 24),
      (bytes) => bytes.writeUInt32LE(bytes.readUInt32LE(centralOffset + 42) + 1, centralOffset + 42),
    ];
    for (const mutate of mutations) {
      const hostile = Buffer.from(original);
      mutate(hostile);
      expect(() => inspectAgentKitZip(hostile)).toThrowError(AgentKitError);
    }
    try {
      inspectAgentKitZip(makeCaseCollisionZip(original));
      throw new Error("portable collision was accepted");
    } catch (error) {
      expect(error).toMatchObject({ name: "AgentKitError", code: "PORTABLE_ENTRY_COLLISION" });
    }
    for (const hostile of [
      renameZipEntrySameLength(original, "LICENSE", "CON.txt"),
      renameZipEntrySameLength(original, "NOTICE", "BAD..."),
    ]) {
      try {
        inspectAgentKitZip(hostile);
        throw new Error("non-portable ZIP entry was accepted");
      } catch (error) {
        expect(error).toMatchObject({ name: "AgentKitError", code: "INVALID_ENTRY_NAME" });
      }
    }
  }, 120000);
});
