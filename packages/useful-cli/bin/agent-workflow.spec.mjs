import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import { AGENT_DOC_COMMANDS } from "./agent-contract-data.mjs";
import { EXIT_CODES, RESULT_SCHEMA_VERSION } from "./cli-contract.mjs";

const cli = fileURLToPath(new URL("./useful.mjs", import.meta.url));
const legacyCreator = fileURLToPath(new URL("./create-useful-tool.mjs", import.meta.url));
const temporaryRoots = [];
const CLI_WORKFLOW_TIMEOUT_MS = 30_000;

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "Useful Agent 空格中文-"));
  temporaryRoots.push(root);
  return root;
}

function runEntryJson(entry, args, expectedStatus = EXIT_CODES.SUCCESS) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  expect(result.status, `${args.join(" ")}\n${result.stderr}\n${result.stdout}`).toBe(expectedStatus);
  expect(result.stderr).toBe("");
  const lines = result.stdout.trim().split(/\r?\n/);
  expect(lines).toHaveLength(1);
  const document = JSON.parse(lines[0]);
  expect(document.schemaVersion).toBe(RESULT_SCHEMA_VERSION);
  expect(document.ok).toBe(expectedStatus === EXIT_CODES.SUCCESS);
  return document;
}

function runJson(args, expectedStatus = EXIT_CODES.SUCCESS) {
  return runEntryJson(cli, args, expectedStatus);
}

function createMinimal(root, name = "工具 甲") {
  const tool = path.join(root, "工具 目录");
  const document = runJson(["create", tool, "--id", "com.example.agent-tool", "--name", name, "--template", "minimal-web", "--json"]);
  expect(document.data.permissions).toEqual([]);
  return tool;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Agent-first CLI workflow", () => {
  it("keeps create-useful-tool defaults compatible while sharing the hardened scaffold", () => {
    const root = makeRoot();
    const tool = path.join(root, "legacy-tool");
    const created = runEntryJson(legacyCreator, [tool, "--json"]).data;
    expect(created).toEqual(expect.objectContaining({
      toolId: "com.example.legacytool",
      template: "starter-web",
      permissions: [],
    }));
    const manifest = JSON.parse(fs.readFileSync(path.join(tool, "manifest.json"), "utf8"));
    expect(manifest.description).toBe("legacy-tool - 由 Useful CLI 生成");
    const bridge = fs.readFileSync(path.join(tool, "index.html"), "utf8");
    expect(bridge).toContain("Useful web 工具示例");
    // starter-web 是纯 Web 单文件脚手架；不再生成已移除的 native main.js 入口。
    expect(fs.existsSync(path.join(tool, "main.js"))).toBe(false);
    expect(bridge).toContain("usefulCapability");
    expect(bridge).toContain("new MessageChannel()");
    expect(bridge).toContain("__usefulBootstrap");
    expect(bridge).toContain("__usefulRpc");
    expect(bridge).not.toContain('call("dialog.open"');
    expect(runJson(["validate", tool, "--json"]).data.valid).toBe(true);
  }, CLI_WORKFLOW_TIMEOUT_MS);

  it("runs create -> doctor -> validate -> pack -> publisher init/sign/verify through the real CLI", () => {
    const root = makeRoot();
    const tool = createMinimal(root, "<工具 & 安全>");
    expect(fs.readFileSync(path.join(tool, "index.html"), "utf8")).toContain("&lt;工具 &amp; 安全&gt;");

    const doctor = runJson(["doctor", tool, "--json"]);
    expect(doctor.data.summary).toEqual(expect.objectContaining({ failed: 0, hardFailure: false }));
    expect(doctor.data.checks.find((check) => check.id === "cli-version").message).toBe("Useful CLI 0.1.0-beta.3");
    expect(runJson(["validate", tool, "--json"]).data.valid).toBe(true);

    const out = path.join(root, "输出 目录");
    const packed = runJson(["pack", tool, out, "--json"]).data;
    const artifactBytes = fs.readFileSync(packed.artifactPath);
    expect(createHash("sha256").update(artifactBytes).digest("hex")).toBe(packed.sha256);
    expect(artifactBytes.length).toBe(packed.sizeBytes);
    const zip = new AdmZip(artifactBytes);
    const entries = zip.getEntries().filter((entry) => !entry.isDirectory).map((entry) => entry.entryName).sort();
    expect(entries).toEqual(["assets/icon.png", "index.html", "manifest.json"]);
    expect(entries.some((entry) => /(?:^|\/)(?:node_modules|\.git|\.env)(?:\/|$)/i.test(entry))).toBe(false);
    expect(JSON.parse(zip.readAsText("manifest.json"))).toEqual(expect.objectContaining({
      id: "com.example.agent-tool",
      permissions: [],
    }));

    const publisherDir = path.join(root, "发布者 目录");
    const initialized = runJson(["publisher", "init", publisherDir, "--id", "com.example.agent-publisher", "--name", "Agent Publisher", "--json"]).data;
    expect(initialized.privatePath).toBe(path.join(publisherDir, "publisher.private.pem"));
    expect(JSON.stringify(initialized)).not.toContain("BEGIN PRIVATE KEY");
    const signed = runJson(["publisher", "sign", packed.artifactPath, "--key", initialized.privatePath, "--json"]).data;
    expect(signed.signature).toBe("[REDACTED]");
    const receipt = JSON.parse(fs.readFileSync(signed.path, "utf8"));
    expect(receipt.artifactSha256).toBe(packed.sha256);
    expect(receipt.artifactBytes).toBe(packed.sizeBytes);
    const verified = runJson(["publisher", "verify", packed.artifactPath, signed.path, "--json"]).data;
    expect(verified).toEqual(expect.objectContaining({ valid: true, artifactSha256: packed.sha256 }));
  }, CLI_WORKFLOW_TIMEOUT_MS);

  it("fails closed for existing targets, malicious input, and unknown flags", () => {
    const root = makeRoot();
    runJson(["create", root, "--json"], EXIT_CODES.SECURITY_OR_IO);
    runJson(["create", path.join(root, "bad-id"), "--id", "bad;id", "--json"], EXIT_CODES.USAGE);
    runJson(["create", path.join(root, "bad-name"), "--name", "bad\nname", "--json"], EXIT_CODES.USAGE);
    runJson(["doctor", root, "--mystery", "value", "--json"], EXIT_CODES.USAGE);
    const tokenFailure = runJson(["publisher", "register", path.join(root, "publisher.json"), "--token", "super-secret-token", "--json"], EXIT_CODES.USAGE);
    expect(JSON.stringify(tokenFailure)).not.toContain("super-secret-token");
  }, CLI_WORKFLOW_TIMEOUT_MS);

  it("keeps legacy manifests valid when optional/default fields are absent", () => {
    const root = makeRoot();
    const tool = createMinimal(root);
    const manifestPath = path.join(tool, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    delete manifest.icon;
    delete manifest.permissions;
    delete manifest.platforms;
    delete manifest.minHostVersion;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    expect(runJson(["validate", tool, "--json"]).data.valid).toBe(true);
    const doctor = runJson(["doctor", tool, "--json"]).data;
    expect(doctor.summary.failed).toBe(0);
    expect(doctor.summary.warnings).toBe(4);
    expect(doctor.checks.filter((check) => check.status === "warning").map((check) => check.id)).toEqual([
      "permissions",
      "platforms",
      "min-host-version",
      "icon-path",
    ]);
    expect(runJson(["pack", tool, path.join(root, "legacy-out"), "--json"]).data.entryCount).toBe(3);
  }, CLI_WORKFLOW_TIMEOUT_MS);

  it("accepts the canonical external launcher without reading its host-resolved target", () => {
    const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const launcher = path.join(repositoryRoot, "examples", "external-launcher-tool");
    const doctor = runJson(["doctor", launcher, "--json"]).data;
    expect(doctor.summary.failed).toBe(0);
    expect(doctor.checks.find((check) => check.id === "entry-path")).toEqual(expect.objectContaining({
      status: "pass",
      details: { resolution: "host", targetKind: "program-or-script" },
    }));
    expect(doctor.checks.find((check) => check.id === "launcher-permission").status).toBe("pass");
    const root = makeRoot();
    const packed = runJson(["pack", launcher, path.join(root, "launcher-out"), "--json"]).data;
    expect(new AdmZip(packed.artifactPath).getEntries().some((entry) => entry.entryName === "notepad.exe")).toBe(false);
  }, CLI_WORKFLOW_TIMEOUT_MS);

  it("rejects secrets, forbidden directories, escaping paths, links, and oversized entries", () => {
    const root = makeRoot();
    const cases = [];

    const envTool = createMinimal(path.join(root, "env-case"));
    fs.writeFileSync(path.join(envTool, ".env"), "TOKEN=never-print-this\n");
    cases.push(envTool);

    const keyTool = createMinimal(path.join(root, "key-case"));
    const privateKeyHeader = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
    const privateKeyFooter = ["-----END", "PRIVATE KEY-----"].join(" ");
    fs.writeFileSync(
      path.join(keyTool, "innocent.txt"),
      `${privateKeyHeader}\nsecret\n${privateKeyFooter}\n`,
    );
    cases.push(keyTool);

    const largeKeyTool = createMinimal(path.join(root, "large-key-case"));
    const disguisedLargeKey = path.join(largeKeyTool, "large-source.dat");
    fs.writeFileSync(disguisedLargeKey, `${privateKeyHeader}\nsecret\n`);
    fs.truncateSync(disguisedLargeKey, 2 * 1024 * 1024);
    cases.push(largeKeyTool);

    const gitTool = createMinimal(path.join(root, "git-case"));
    fs.mkdirSync(path.join(gitTool, ".git"));
    fs.mkdirSync(path.join(gitTool, "node_modules"));
    fs.writeFileSync(path.join(gitTool, "previous.useful"), "nested artifact");
    cases.push(gitTool);

    for (const tool of cases) {
      const failure = runJson(["doctor", tool, "--json"], EXIT_CODES.VALIDATION);
      expect(failure.error.code).toBe("DOCTOR_FAILED");
      expect(JSON.stringify(failure)).not.toContain("never-print-this");
    }

    const escapeRoot = path.join(root, "escape-case");
    const escapeTool = createMinimal(escapeRoot);
    const manifestPath = path.join(escapeTool, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.entry.path = "../outside.html";
    manifest.icon = "C:\\outside.png";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(runJson(["validate", escapeTool, "--json"], EXIT_CODES.VALIDATION).data.valid).toBe(false);

    const largeRoot = path.join(root, "large-case");
    const largeTool = createMinimal(largeRoot);
    fs.writeFileSync(path.join(largeTool, "too-large.bin"), Buffer.alloc(1));
    fs.truncateSync(path.join(largeTool, "too-large.bin"), 64 * 1024 * 1024 + 1);
    expect(runJson(["pack", largeTool, path.join(root, "large-out"), "--json"], EXIT_CODES.VALIDATION).error.code).toBe("PACK_PREFLIGHT_FAILED");

    const linkRoot = path.join(root, "link-case");
    const linkTool = createMinimal(linkRoot);
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "outside.txt"), "outside");
    try {
      fs.symlinkSync(outside, path.join(linkTool, "linked"), process.platform === "win32" ? "junction" : "dir");
      expect(runJson(["doctor", linkTool, "--json"], EXIT_CODES.VALIDATION).error.code).toBe("DOCTOR_FAILED");
    } catch (error) {
      if (!["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) throw error;
    }
  }, CLI_WORKFLOW_TIMEOUT_MS);

  it("allows ordinary source, license, env example, and public certificate files", () => {
    const root = makeRoot();
    const tool = createMinimal(root);
    fs.writeFileSync(path.join(tool, "LICENSE"), "MIT License\n");
    fs.writeFileSync(path.join(tool, "source.js"), "export const value = 1;\n");
    fs.writeFileSync(path.join(tool, ".env.example"), "OPTIONAL_SETTING=example\n");
    fs.writeFileSync(path.join(tool, "public.pem"), "-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----\n");
    expect(runJson(["doctor", tool, "--json"]).data.summary.failed).toBe(0);
    const packed = runJson(["pack", tool, path.join(root, "safe-out"), "--json"]).data;
    const entries = new AdmZip(packed.artifactPath).getEntries().map((entry) => entry.entryName);
    expect(entries).toEqual(expect.arrayContaining(["LICENSE", "source.js", ".env.example", "public.pem"]));
  }, CLI_WORKFLOW_TIMEOUT_MS);

  it("keeps the shared Agent command sequence self-contained", () => {
    expect(AGENT_DOC_COMMANDS.slice(0, 7).every((command) => command.startsWith("useful "))).toBe(true);
    expect(AGENT_DOC_COMMANDS.join("\n")).not.toMatch(/\b(?:npx|pnpm\s+dlx)\b/);
  });
});
