import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_INHERITED_ENV_VARS } from "@modelcontextprotocol/client/stdio";
import {
  AgentSelfProbeError,
  agentProbeTesting,
  resolveAgentProbeInstallation,
} from "./agent-probe.mjs";
import { ACTION_IDS, OFFICE_ACTION_IDS } from "../../action-runtime/src/browser.mjs";

const realCli = path.join(path.dirname(fileURLToPath(import.meta.url)), "useful.mjs");
const sourceModule = pathToFileURL(path.join(path.dirname(realCli), "agent-probe.mjs")).href;
const CLI_TEST_TIMEOUT_MS = 40_000;
const CANONICAL_TEMP_ROOT = fs.realpathSync.native(os.tmpdir());
const COMPUTER_USE_AGENT_KIT_REQUIRED_FILES = Object.freeze([
  "schemas/computer-use-probe.schema.json",
  "lib/provenance/protocol/computer-use-probe.mjs",
  "lib/provenance/protocol/computer-use-probe.d.ts",
  "lib/provenance/computer-use-contract/index.mjs",
  "lib/provenance/computer-use-contract/index.d.ts",
  "lib/provenance/computer-use-browser-adapter/index.mjs",
  "lib/provenance/computer-use-browser-adapter/index.d.ts",
]);

function actionNames() {
  return [...Object.values(ACTION_IDS), ...Object.values(OFFICE_ACTION_IDS)].sort();
}

function allNames() {
  return [
    ...actionNames(),
    "useful.actions.search",
    "useful.actions.describe",
    "useful.actions.suggest",
    "useful.actions.recipe",
  ];
}

class FakeTransport {
  static latest;

  constructor(parameters) {
    this.parameters = parameters;
    this.stderr = new PassThrough();
    this.pid = null;
    this.closed = false;
    FakeTransport.latest = this;
  }

  async close() {
    this.closed = true;
    this.pid = null;
  }
}

class FakeClient {
  static latestOptions;

  constructor(_clientInfo, options) {
    this.transport = null;
    FakeClient.latestOptions = options;
  }

  async connect(transport) {
    this.transport = transport;
    transport.pid = 1234;
  }

  getServerVersion() {
    return { name: "useful-actions", version: "0.1.0" };
  }

  getNegotiatedProtocolVersion() {
    return "2026-07-28";
  }

  async listTools() {
    return { tools: allNames().map((name) => ({ name })) };
  }

  async callTool({ name }) {
    if (name === "useful.actions.search") return { structuredContent: { actions: actionNames().map((actionId) => ({ actionId })) } };
    if (name === "useful.actions.describe") {
      return {
        structuredContent: {
          action: {
            actionId: "builtin.utilities.base64",
            behavior: { readOnly: true, destructive: false, idempotent: true, openWorld: false, requiresConfirmation: false, sideEffects: [] },
            execution: { mode: "pure" },
            permissions: { required: [], capabilities: [] },
          },
        },
      };
    }
    return { structuredContent: { text: "VXNlZnVsIHNlbGYgcHJvYmU=" } };
  }

  async close() {
    await this.transport?.close();
  }
}

function fakeResolved() {
  return {
    installation: {
      mode: "source",
      artifactVerified: false,
      sourceRevision: "ab".repeat(20),
      version: "0.1.0-beta.3",
    },
    mcpEntry: path.join(path.parse(realCli).root, "fixed", "useful-mcp.mjs"),
    root: path.join(path.parse(realCli).root, "fixed"),
  };
}

function writeAgentKitTraversalFixture(root) {
  const libraryRoot = path.join(root, "lib");
  const moduleFile = path.join(libraryRoot, "useful.mjs");
  fs.mkdirSync(libraryRoot);
  fs.writeFileSync(moduleFile, "// cli\n");
  fs.writeFileSync(path.join(libraryRoot, "useful-mcp.mjs"), "// mcp\n");
  fs.writeFileSync(path.join(root, "MANIFEST.json"), `${JSON.stringify({
    schemaVersion: "useful.agent-kit.manifest.v1",
    product: { name: "Useful", version: "0.1.0-beta.3" },
    source: { revision: "ab".repeat(20) },
    node: { requirement: ">=20" },
    commands: {
      useful: { entry: "lib/useful.mjs", posix: "bin/useful", windows: "bin/useful.cmd" },
      "useful-runtime": { entry: "lib/useful-runtime.mjs", posix: "bin/useful-runtime", windows: "bin/useful-runtime.cmd" },
      "useful-mcp": { entry: "lib/useful-mcp.mjs", posix: "bin/useful-mcp", windows: "bin/useful-mcp.cmd" },
    },
    closure: { manifestPath: "MANIFEST.json", manifestSelfExcluded: true },
    files: [{ path: "lib/useful.mjs", sha256: "0".repeat(64), size: 7 }],
  })}\n`);
  return moduleFile;
}

function writeClosedAgentKitManifest(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name !== "MANIFEST.json") {
        const bytes = fs.readFileSync(absolute);
        files.push({
          path: path.relative(root, absolute).split(path.sep).join("/"),
          sha256: createHash("sha256").update(bytes).digest("hex"),
          size: bytes.length,
        });
      }
    }
  };
  visit(root);
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  fs.writeFileSync(path.join(root, "MANIFEST.json"), `${JSON.stringify({
    schemaVersion: "useful.agent-kit.manifest.v1",
    product: { name: "Useful", version: "0.1.0-beta.3" },
    source: { revision: "ab".repeat(20) },
    node: { requirement: ">=20" },
    commands: {
      useful: { entry: "lib/useful.mjs", posix: "bin/useful", windows: "bin/useful.cmd" },
      "useful-runtime": { entry: "lib/useful-runtime.mjs", posix: "bin/useful-runtime", windows: "bin/useful-runtime.cmd" },
      "useful-mcp": { entry: "lib/useful-mcp.mjs", posix: "bin/useful-mcp", windows: "bin/useful-mcp.cmd" },
    },
    closure: { manifestPath: "MANIFEST.json", manifestSelfExcluded: true },
    files,
  })}\n`);
}

function writeValidAgentKitFixture(root) {
  const required = new Set([
    ...agentProbeTesting.requiredAgentKitFiles,
    ...COMPUTER_USE_AGENT_KIT_REQUIRED_FILES,
  ]);
  for (const relative of required) {
    const file = path.join(root, ...relative.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${relative}\n`);
  }
  fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify({
    name: "useful-agent-kit",
    version: "0.1.0-beta.3",
    description: "Valid Agent Kit probe fixture",
    private: true,
    license: "SEE LICENSE IN LICENSE",
    type: "module",
    engines: { node: ">=20" },
  })}\n`);
  const moduleFile = path.join(root, "lib", "useful.mjs");
  fs.writeFileSync(moduleFile, [
    `import { resolveAgentProbeInstallation } from ${JSON.stringify(sourceModule)};`,
    "try {",
    "  const result = resolveAgentProbeInstallation(import.meta.url, true);",
    "  process.stdout.write(JSON.stringify({ ok: true, installation: result.installation }) + '\\n');",
    "} catch (error) {",
    "  process.stdout.write(JSON.stringify({ name: error?.name ?? null, code: error?.code ?? null, details: error?.details ?? null }) + '\\n');",
    "  process.exitCode = 4;",
    "}",
    "",
  ].join("\n"));
  writeClosedAgentKitManifest(root);
  return moduleFile;
}

async function expectProbeError(promise, code) {
  try {
    await promise;
    throw new Error("expected probe failure");
  } catch (error) {
    expect(error).toBeInstanceOf(AgentSelfProbeError);
    expect(error.code).toBe(code);
  }
}

describe("useful agent self-probe production", () => {
  it("pins the production action closure to the canonical built-in IDs", () => {
    expect(agentProbeTesting.expectedActionNames).toEqual(actionNames());
    expect(agentProbeTesting.expectedActionNames).toHaveLength(36);
    expect(agentProbeTesting.expectedHelperOrder).toEqual([
      "useful.actions.search",
      "useful.actions.describe",
      "useful.actions.suggest",
      "useful.actions.recipe",
    ]);
  });

  it("uses only the fixed executable, argv, cwd and scrubbed minimal environment", async () => {
    const secret = "DO_NOT_INHERIT_SELF_PROBE_SECRET";
    const previousSecret = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = secret;
    try {
      const result = await agentProbeTesting.executeProbe(fakeResolved(), { ClientClass: FakeClient, TransportClass: FakeTransport });
      expect(result).toMatchObject({
        schemaVersion: "useful.agent-probe.v1",
        status: "success",
        proofScope: "useful-mcp-local-stdio",
        tools: { count: 40, actionCount: 36, helperCount: 4 },
        proof: {
          transportClosed: true,
          externalAgentInstalled: false,
          codexConfigured: false,
          claudeConfigured: false,
          hostConfigWrittenByProbe: false,
          launcherNetworkAttested: false,
        },
      });
      const parameters = FakeTransport.latest.parameters;
      expect(parameters.command).toBe(process.execPath);
      expect(parameters.args).toEqual([fakeResolved().mcpEntry]);
      expect(parameters.cwd).toBe(fakeResolved().root);
      expect(parameters.stderr).toBe("pipe");
      expect(parameters.env.PATH).toBe("");
      for (const name of DEFAULT_INHERITED_ENV_VARS) {
        const isControlledWindowsValue = process.platform === "win32" && (name === "SYSTEMROOT" || name === "TEMP");
        if (isControlledWindowsValue) expect(parameters.env[name]).not.toBe("");
        else expect(parameters.env[name]).toBe("");
      }
      expect(parameters.env.OPENAI_API_KEY).toBeUndefined();
      expect(FakeClient.latestOptions).toEqual({ versionNegotiation: { mode: { pin: "2026-07-28" } } });
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(result.server).toEqual({ name: "useful-actions", version: "0.1.0", protocolVersion: "2026-07-28" });
      expect(FakeTransport.latest.closed).toBe(true);
    } finally {
      if (previousSecret === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousSecret;
    }
  });

  it("runs the fixed real source MCP end to end", () => {
    const result = spawnSync(process.execPath, [realCli, "agent", "probe", "--json"], {
      cwd: os.tmpdir(),
      encoding: "utf8",
      timeout: CLI_TEST_TIMEOUT_MS,
      windowsHide: true,
      env: { ...process.env, OPENAI_API_KEY: "DO_NOT_INHERIT_REAL_PROBE_SECRET" },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("DO_NOT_INHERIT_REAL_PROBE_SECRET");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      command: "agent probe",
      data: {
        status: "success",
        installation: { mode: "source", artifactVerified: false },
        tools: { count: 40, actionCount: 36, helperCount: 4 },
        process: { transportClosed: true },
      },
    });
  }, CLI_TEST_TIMEOUT_MS);

  it("rejects every launcher, path, profile, environment and call override", () => {
    for (const argument of ["--launcher", "--node", "--cwd", "--env", "--profile", "--input", "--call", "--out", "--config-path", "--apply"]) {
      const result = spawnSync(process.execPath, [realCli, "agent", "probe", argument, "ignored", "--json"], { encoding: "utf8", windowsHide: true });
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({ command: "agent probe", error: { code: "UNKNOWN_FLAG" } });
    }
    const positional = spawnSync(process.execPath, [realCli, "agent", "probe", "ignored", "--json"], { encoding: "utf8", windowsHide: true });
    expect(positional.status).toBe(2);
    expect(JSON.parse(positional.stdout).error.code).toBe("INVALID_ARGUMENTS");
    const duplicate = spawnSync(process.execPath, [realCli, "agent", "probe", "--json", "--json"], { encoding: "utf8", windowsHide: true });
    expect(duplicate.status).toBe(2);
    expect(JSON.parse(duplicate.stdout).error.code).toBe("DUPLICATE_FLAG");
  }, CLI_TEST_TIMEOUT_MS);

  it("rejects invalid source and Agent Kit paths before launching", () => {
    expect(() => resolveAgentProbeInstallation(pathToFileURL(path.join(os.tmpdir(), "other.mjs")).href, false))
      .toThrowError(expect.objectContaining({ code: "SOURCE_LAYOUT_INVALID" }));
    expect(() => resolveAgentProbeInstallation(pathToFileURL(path.join(os.tmpdir(), "other.mjs")).href, true))
      .toThrowError(expect.objectContaining({ code: "AGENT_KIT_LAYOUT_INVALID" }));
  });

  it("rejects a malformed Agent Kit manifest in the fixed layout", () => {
    const root = fs.mkdtempSync(path.join(CANONICAL_TEMP_ROOT, "useful-probe-kit-"));
    try {
      fs.mkdirSync(path.join(root, "lib"));
      fs.writeFileSync(path.join(root, "lib", "useful.mjs"), "// cli\n");
      fs.writeFileSync(path.join(root, "lib", "useful-mcp.mjs"), "// mcp\n");
      fs.writeFileSync(path.join(root, "MANIFEST.json"), "{}\n");
      expect(() => resolveAgentProbeInstallation(pathToFileURL(path.join(root, "lib", "useful.mjs")).href, true))
        .toThrowError(expect.objectContaining({ code: "AGENT_KIT_MANIFEST_INVALID" }));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(COMPUTER_USE_AGENT_KIT_REQUIRED_FILES)(
    "rejects a closed Agent Kit missing required Computer Use file %s",
    (requiredPath) => {
      const root = fs.mkdtempSync(path.join(CANONICAL_TEMP_ROOT, "useful-probe-computer-use-required-"));
      try {
        const moduleFile = writeValidAgentKitFixture(root);
        expect(agentProbeTesting.verifyAgentKit(moduleFile)).toMatchObject({
          installation: { mode: "agent-kit", artifactVerified: true },
        });

        fs.rmSync(path.join(root, ...requiredPath.split("/")));
        writeClosedAgentKitManifest(root);

        expect(() => agentProbeTesting.verifyAgentKit(moduleFile)).toThrowError(expect.objectContaining({
          code: "AGENT_KIT_MANIFEST_INVALID",
          details: { path: requiredPath },
        }));
        const child = spawnSync(process.execPath, [moduleFile], {
          cwd: root,
          encoding: "utf8",
          timeout: CLI_TEST_TIMEOUT_MS,
          windowsHide: true,
        });
        expect(child.status).toBe(4);
        expect(child.stderr).toBe("");
        expect(child.stdout.trim().split(/\r?\n/u)).toHaveLength(1);
        expect(JSON.parse(child.stdout)).toEqual({
          name: "AgentSelfProbeError",
          code: "AGENT_KIT_MANIFEST_INVALID",
          details: { path: requiredPath },
        });
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it("rejects an Agent Kit with more than 4096 directories", () => {
    const root = fs.mkdtempSync(path.join(CANONICAL_TEMP_ROOT, "useful-probe-dir-limit-"));
    try {
      const moduleFile = writeAgentKitTraversalFixture(root);
      for (let index = 0; index < 4096; index += 1) {
        fs.mkdirSync(path.join(root, `d-${index.toString().padStart(4, "0")}`));
      }
      expect(() => resolveAgentProbeInstallation(pathToFileURL(moduleFile).href, true))
        .toThrowError(expect.objectContaining({ code: "AGENT_KIT_DIRECTORY_LIMIT_EXCEEDED" }));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, CLI_TEST_TIMEOUT_MS);

  it("rejects an Agent Kit directory deeper than 64 levels", () => {
    const root = fs.mkdtempSync(path.join(CANONICAL_TEMP_ROOT, "useful-probe-depth-limit-"));
    try {
      const moduleFile = writeAgentKitTraversalFixture(root);
      let directory = root;
      for (let depth = 0; depth < 65; depth += 1) {
        directory = path.join(directory, "d");
        fs.mkdirSync(directory);
      }
      expect(() => resolveAgentProbeInstallation(pathToFileURL(moduleFile).href, true))
        .toThrowError(expect.objectContaining({ code: "AGENT_KIT_DEPTH_LIMIT_EXCEEDED" }));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("enforces the MCP execution-and-close deadline and still closes the transport", async () => {
    class HangingClient extends FakeClient {
      async connect(transport, options) {
        this.transport = transport;
        transport.pid = 1234;
        await new Promise((resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        });
      }
    }
    await expectProbeError(
      agentProbeTesting.executeProbe(fakeResolved(), { ClientClass: HangingClient, TransportClass: FakeTransport, deadlineMs: 5 }),
      "AGENT_PROBE_TIMEOUT",
    );
    expect(FakeTransport.latest.closed).toBe(true);
  });

  it("rejects a counted but noncanonical action set", async () => {
    class NoncanonicalClient extends FakeClient {
      async listTools() {
        const names = allNames();
        names[0] = "builtin.office.lookalike";
        return { tools: names.map((name) => ({ name })) };
      }
    }
    await expectProbeError(
      agentProbeTesting.executeProbe(fakeResolved(), { ClientClass: NoncanonicalClient, TransportClass: FakeTransport }),
      "MCP_TOOL_SET_MISMATCH",
    );
  });

  it("rejects the right helpers in the wrong registration order", async () => {
    class ReorderedHelperClient extends FakeClient {
      async listTools() {
        const names = [...actionNames(), ...agentProbeTesting.expectedHelperOrder].sort();
        return { tools: names.map((name) => ({ name })) };
      }
    }
    await expectProbeError(
      agentProbeTesting.executeProbe(fakeResolved(), { ClientClass: ReorderedHelperClient, TransportClass: FakeTransport }),
      "MCP_TOOL_SET_MISMATCH",
    );
  });

  it("rejects a protocol version other than the pinned 2026-07-28 revision", async () => {
    class DriftedProtocolClient extends FakeClient {
      getNegotiatedProtocolVersion() {
        return "2025-11-25";
      }
    }
    await expectProbeError(
      agentProbeTesting.executeProbe(fakeResolved(), { ClientClass: DriftedProtocolClient, TransportClass: FakeTransport }),
      "MCP_HANDSHAKE_IDENTITY_MISMATCH",
    );
  });

  it("requires explicit empty side-effect and permission arrays before the safe call", async () => {
    class UnsafeDescriptorClient extends FakeClient {
      async callTool({ name }) {
        const result = await super.callTool({ name });
        if (name === "useful.actions.describe") delete result.structuredContent.action.behavior.sideEffects;
        return result;
      }
    }
    await expectProbeError(
      agentProbeTesting.executeProbe(fakeResolved(), { ClientClass: UnsafeDescriptorClient, TransportClass: FakeTransport }),
      "MCP_DESCRIBE_PROOF_FAILED",
    );
  });

  it("caps stderr without echoing child text", async () => {
    const secret = "CHILD_STDERR_MUST_NOT_BE_ECHOED";
    class NoisyClient extends FakeClient {
      async connect(transport) {
        await super.connect(transport);
        transport.stderr.write(Buffer.alloc(64 * 1024 + 1, secret));
      }
    }
    try {
      await agentProbeTesting.executeProbe(fakeResolved(), { ClientClass: NoisyClient, TransportClass: FakeTransport });
      throw new Error("expected probe failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentSelfProbeError);
      expect(error.code).toBe("AGENT_PROBE_STDERR_LIMIT_EXCEEDED");
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });

  it("uses stable safe failures for server errors", async () => {
    class ErrorClient extends FakeClient {
      async callTool() {
        throw new Error("SERVER_CONTROLLED_SECRET");
      }
    }
    try {
      await agentProbeTesting.executeProbe(fakeResolved(), { ClientClass: ErrorClient, TransportClass: FakeTransport });
      throw new Error("expected probe failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentSelfProbeError);
      expect(error.code).toBe("MCP_PROBE_FAILED");
      expect(JSON.stringify(error)).not.toContain("SERVER_CONTROLLED_SECRET");
    }
  });

  it("does not claim transport closure when close fails", async () => {
    class UncloseableTransport extends FakeTransport {
      async close() {
        throw new Error("close failed");
      }
    }
    await expectProbeError(
      agentProbeTesting.executeProbe(fakeResolved(), { ClientClass: FakeClient, TransportClass: UncloseableTransport }),
      "MCP_TRANSPORT_CLOSE_FAILED",
    );
  });

  it("reports close failure ahead of a prior server error without echoing its message", async () => {
    class ErrorClient extends FakeClient {
      async callTool() {
        throw new Error("SERVER_SECRET_BEFORE_CLOSE");
      }
    }
    class UncloseableTransport extends FakeTransport {
      async close() {
        throw new Error("CLOSE_SECRET");
      }
    }
    try {
      await agentProbeTesting.executeProbe(fakeResolved(), { ClientClass: ErrorClient, TransportClass: UncloseableTransport });
      throw new Error("expected probe failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentSelfProbeError);
      expect(error).toMatchObject({ code: "MCP_TRANSPORT_CLOSE_FAILED", details: { priorCode: "MCP_PROBE_FAILED" } });
      expect(JSON.stringify(error)).not.toMatch(/SERVER_SECRET_BEFORE_CLOSE|CLOSE_SECRET/u);
    }
  });

  it("source resolver is independent of cwd", () => {
    const before = process.cwd();
    process.chdir(os.tmpdir());
    try {
      const resolved = resolveAgentProbeInstallation(sourceModule, false);
      expect(resolved.mcpEntry).toBe(path.resolve(path.dirname(realCli), "../../useful-mcp/bin/useful-mcp.mjs"));
      expect(resolved.root).not.toBe(process.cwd());
      expect(resolved.installation.sourceRevision).toMatch(/^[a-f0-9]{40,64}$/u);
    } finally {
      process.chdir(before);
    }
  });

  it("accepts only a reciprocally bound Git linked-worktree metadata layout", () => {
    const outer = fs.mkdtempSync(path.join(CANONICAL_TEMP_ROOT, "useful-probe-worktree-"));
    const root = path.join(outer, "checkout");
    const common = path.join(outer, "main", ".git");
    const gitDirectory = path.join(common, "worktrees", "checkout");
    const revision = "cd".repeat(20);
    try {
      fs.mkdirSync(path.join(root), { recursive: true });
      fs.mkdirSync(path.join(gitDirectory), { recursive: true });
      fs.mkdirSync(path.join(common, "refs", "heads"), { recursive: true });
      fs.writeFileSync(path.join(root, ".git"), `gitdir: ${gitDirectory}\n`);
      fs.writeFileSync(path.join(gitDirectory, "gitdir"), `${path.join(root, ".git")}\n`);
      fs.writeFileSync(path.join(gitDirectory, "commondir"), "../..\n");
      fs.writeFileSync(path.join(gitDirectory, "HEAD"), "ref: refs/heads/main\n");
      fs.writeFileSync(path.join(common, "refs", "heads", "main"), `${revision}\n`);

      expect(agentProbeTesting.readSourceRevision(root)).toBe(revision);
      fs.writeFileSync(path.join(gitDirectory, "gitdir"), `${path.join(outer, "other", ".git")}\n`);
      expect(() => agentProbeTesting.readSourceRevision(root))
        .toThrowError(expect.objectContaining({ code: "SOURCE_REVISION_UNAVAILABLE" }));
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  });
});
