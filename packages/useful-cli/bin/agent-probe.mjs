/* global __USEFUL_AGENT_KIT__ */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { DEFAULT_INHERITED_ENV_VARS, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createAgentProbe } from "@useful/protocol/agent-probe";

const AGENT_KIT_BUILD = typeof __USEFUL_AGENT_KIT__ !== "undefined" && __USEFUL_AGENT_KIT__ === true;
const DEADLINE_MS = 30_000;
const STDERR_LIMIT_BYTES = 64 * 1024;
const MAX_MANIFEST_FILES = 4096;
const MAX_AGENT_KIT_DIRECTORIES = 4096;
const MAX_AGENT_KIT_DEPTH = 64;
const MAX_MANIFEST_FILE_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_TOTAL_BYTES = 256 * 1024 * 1024;
const MCP_ENTRY_SOURCE = "packages/useful-mcp/bin/useful-mcp.mjs";
const MANIFEST_NAME = "MANIFEST.json";
const REQUIRED_AGENT_KIT_FILES = Object.freeze([
  "LICENSE",
  "LICENSES.md",
  "NOTICE",
  "README.txt",
  "THIRD_PARTY-LICENSES.json",
  "THIRD_PARTY_NOTICES.md",
  "TRADEMARKS.md",
  "bin/useful",
  "bin/useful.cmd",
  "bin/useful-mcp",
  "bin/useful-mcp.cmd",
  "bin/useful-runtime",
  "bin/useful-runtime.cmd",
  "lib/office-worker-thread.mjs",
  "lib/provenance/protocol/agent-probe.d.ts",
  "lib/provenance/protocol/agent-probe.mjs",
  "lib/regex-worker-thread.mjs",
  "lib/useful-mcp.mjs",
  "lib/useful-runtime.mjs",
  "lib/useful.mjs",
  "licenses/AGPL-3.0-or-later.txt",
  "licenses/Apache-2.0.txt",
  "licenses/CC-BY-4.0.txt",
  "licenses/MPL-2.0.txt",
  "licenses/README.md",
  "package.json",
  "schemas/agent-probe.schema.json",
]);
const EXPECTED_HELPER_ORDER = Object.freeze([
  "useful.actions.search",
  "useful.actions.describe",
  "useful.actions.suggest",
  "useful.actions.recipe",
]);
const EXPECTED_ACTION_NAMES = Object.freeze([
  "builtin.office.docx",
  "builtin.office.markdown",
  "builtin.office.pdf",
  "builtin.office.pptx",
  "builtin.office.spreadsheet",
  "builtin.utilities.base-convert",
  "builtin.utilities.base64",
  "builtin.utilities.byte-size",
  "builtin.utilities.byte-unit",
  "builtin.utilities.caesar",
  "builtin.utilities.case",
  "builtin.utilities.color",
  "builtin.utilities.contrast",
  "builtin.utilities.data-format",
  "builtin.utilities.duration",
  "builtin.utilities.hash",
  "builtin.utilities.hex-text",
  "builtin.utilities.html",
  "builtin.utilities.ipv4",
  "builtin.utilities.json",
  "builtin.utilities.jwt",
  "builtin.utilities.lorem",
  "builtin.utilities.luhn",
  "builtin.utilities.morse",
  "builtin.utilities.number-format",
  "builtin.utilities.password",
  "builtin.utilities.random-number",
  "builtin.utilities.regex",
  "builtin.utilities.slug",
  "builtin.utilities.text-diff",
  "builtin.utilities.text-lines",
  "builtin.utilities.text-stats",
  "builtin.utilities.timestamp",
  "builtin.utilities.unicode",
  "builtin.utilities.url",
  "builtin.utilities.uuid",
]);
const SAFE_ACTION_ID = "builtin.utilities.base64";
const SAFE_ACTION_INPUT = Object.freeze({ operation: "encode", text: "Useful self probe" });
const SAFE_ACTION_OUTPUT = "VXNlZnVsIHNlbGYgcHJvYmU=";
const PRODUCT_SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const SOURCE_REVISION = /^[a-f0-9]{40,64}$/u;
const MANIFEST_SHA256 = /^[a-f0-9]{64}$/u;
const PROTOCOL_VERSION = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;

export class AgentSelfProbeError extends Error {
  constructor(code, message, details = {}, exitCode = 3) {
    super(message);
    this.name = "AgentSelfProbeError";
    this.code = code;
    this.details = Object.freeze({ ...details });
    this.exitCode = exitCode;
  }
}

function fail(code, message, details = {}, exitCode = 3) {
  throw new AgentSelfProbeError(code, message, details, exitCode);
}

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function comparablePath(value) {
  const normalized = path.resolve(value).replace(/^\\\\\?\\/u, "").replace(/[\\/]+$/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertNoLinkedPathComponents(target, root = path.parse(path.resolve(target)).root) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(target);
  if (!isInside(resolvedRoot, resolved)) fail("PROBE_PATH_OUTSIDE_ROOT", "探测入口超出固定安装根目录", {}, 4);
  const parsed = path.parse(resolved);
  const segments = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let metadata;
    let real;
    try {
      metadata = fs.lstatSync(current);
      real = fs.realpathSync.native(current);
    } catch {
      fail("PROBE_PATH_MISSING", "固定探测入口或其父路径不存在", {}, 4);
    }
    if (metadata.isSymbolicLink() || comparablePath(real) !== comparablePath(current)) {
      fail("PROBE_LINKED_PATH_FORBIDDEN", "固定探测入口不允许 symlink、junction 或 reparse point", {}, 4);
    }
  }
}

function readRegularFile(file, root, code = "PROBE_FILE_INVALID") {
  assertNoLinkedPathComponents(file, root);
  let metadata;
  try {
    metadata = fs.lstatSync(file);
  } catch {
    fail(code, "固定探测文件不存在", {}, 4);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail(code, "固定探测文件必须是普通文件", {}, 4);
  if (metadata.size > MAX_MANIFEST_FILE_BYTES) fail("PROBE_FILE_TOO_LARGE", "固定探测文件超出大小限制", {}, 4);
  return fs.readFileSync(file);
}

function exactKeys(value, expected, code = "AGENT_KIT_MANIFEST_INVALID") {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code, "Agent Kit MANIFEST 结构无效", {}, 4);
  const actual = Object.keys(value).sort(compareCodePoints);
  const wanted = [...expected].sort(compareCodePoints);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(code, "Agent Kit MANIFEST 字段闭集无效", {}, 4);
  }
}

function normalizeManifestPath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0") || path.posix.isAbsolute(value)) {
    fail("AGENT_KIT_MANIFEST_INVALID", "Agent Kit MANIFEST 文件路径无效", {}, 4);
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..") || path.posix.normalize(value) !== value) {
    fail("AGENT_KIT_MANIFEST_INVALID", "Agent Kit MANIFEST 文件路径不安全", {}, 4);
  }
  return value;
}

function readJson(bytes, code, message) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(code, message, {}, 4);
  }
}

function collectAgentKitFiles(root) {
  const files = [];
  let directoryCount = 0;
  const walk = (directory, relativeDirectory = "", depth = 0) => {
    if (depth > MAX_AGENT_KIT_DEPTH) fail("AGENT_KIT_DEPTH_LIMIT_EXCEEDED", "Agent Kit 目录深度超限", {}, 4);
    directoryCount += 1;
    if (directoryCount > MAX_AGENT_KIT_DIRECTORIES) {
      fail("AGENT_KIT_DIRECTORY_LIMIT_EXCEEDED", "Agent Kit 目录数量超限", {}, 4);
    }
    assertNoLinkedPathComponents(directory, root);
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      fail("AGENT_KIT_DIRECTORY_UNREADABLE", "Agent Kit 目录不可读取", {}, 4);
    }
    entries.sort((left, right) => compareCodePoints(left.name, right.name));
    for (const entry of entries) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) fail("PROBE_LINKED_PATH_FORBIDDEN", "Agent Kit 不允许链接项", {}, 4);
      if (entry.isDirectory()) {
        walk(absolute, relative, depth + 1);
      } else if (entry.isFile()) {
        if (relative !== MANIFEST_NAME) files.push({ absolute, relative: normalizeManifestPath(relative) });
      } else {
        fail("AGENT_KIT_ENTRY_INVALID", "Agent Kit 仅允许普通文件和目录", {}, 4);
      }
      if (files.length > MAX_MANIFEST_FILES) fail("AGENT_KIT_FILE_LIMIT_EXCEEDED", "Agent Kit 文件数量超限", {}, 4);
    }
  };
  walk(root);
  return files.sort((left, right) => compareCodePoints(left.relative, right.relative));
}

function verifyAgentKit(moduleFile) {
  const libraryRoot = path.dirname(moduleFile);
  const root = path.dirname(libraryRoot);
  const baseName = path.basename(moduleFile);
  if (path.basename(libraryRoot) !== "lib" || baseName !== "useful.mjs") {
    fail("AGENT_KIT_LAYOUT_INVALID", "Agent Kit CLI 必须位于固定 lib 入口", {}, 4);
  }
  assertNoLinkedPathComponents(root);
  const manifestFile = path.join(root, MANIFEST_NAME);
  const mcpEntry = path.join(libraryRoot, "useful-mcp.mjs");
  const manifest = readJson(
    readRegularFile(manifestFile, root, "AGENT_KIT_MANIFEST_MISSING"),
    "AGENT_KIT_MANIFEST_INVALID",
    "Agent Kit MANIFEST 必须是 JSON",
  );
  exactKeys(manifest, ["schemaVersion", "product", "source", "node", "commands", "closure", "files"]);
  exactKeys(manifest.product, ["name", "version"]);
  exactKeys(manifest.source, ["revision"]);
  exactKeys(manifest.node, ["requirement"]);
  exactKeys(manifest.closure, ["manifestPath", "manifestSelfExcluded"]);
  if (manifest.schemaVersion !== "useful.agent-kit.manifest.v1"
    || manifest.product.name !== "Useful"
    || !PRODUCT_SEMVER.test(manifest.product.version ?? "")
    || !SOURCE_REVISION.test(manifest.source.revision ?? "")
    || manifest.node.requirement !== ">=20"
    || manifest.closure.manifestPath !== MANIFEST_NAME
    || manifest.closure.manifestSelfExcluded !== true) {
    fail("AGENT_KIT_MANIFEST_INVALID", "Agent Kit MANIFEST 身份或版本无效", {}, 4);
  }
  const expectedCliEntry = `lib/${baseName}`;
  exactKeys(manifest.commands, ["useful", "useful-runtime", "useful-mcp"]);
  const expectedCommands = [
    ["useful", expectedCliEntry, "bin/useful", "bin/useful.cmd"],
    ["useful-runtime", "lib/useful-runtime.mjs", "bin/useful-runtime", "bin/useful-runtime.cmd"],
    ["useful-mcp", "lib/useful-mcp.mjs", "bin/useful-mcp", "bin/useful-mcp.cmd"],
  ];
  for (const [name, entry, posix, windows] of expectedCommands) {
    const command = manifest.commands[name];
    exactKeys(command, ["entry", "posix", "windows"]);
    if (command.entry !== entry || command.posix !== posix || command.windows !== windows) {
      fail("AGENT_KIT_MANIFEST_INVALID", "Agent Kit command 未绑定固定入口", { command: name }, 4);
    }
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0 || manifest.files.length > MAX_MANIFEST_FILES) {
    fail("AGENT_KIT_MANIFEST_INVALID", "Agent Kit MANIFEST files 数量无效", {}, 4);
  }
  const listed = new Map();
  let prior;
  for (const record of manifest.files) {
    exactKeys(record, ["path", "sha256", "size"]);
    const relative = normalizeManifestPath(record.path);
    if ((prior !== undefined && compareCodePoints(prior, relative) >= 0)
      || !Number.isInteger(record.size) || record.size < 0 || record.size > MAX_MANIFEST_FILE_BYTES
      || typeof record.sha256 !== "string" || !MANIFEST_SHA256.test(record.sha256)) {
      fail("AGENT_KIT_MANIFEST_INVALID", "Agent Kit MANIFEST 文件记录无效", {}, 4);
    }
    prior = relative;
    listed.set(relative, record);
  }
  const actualFiles = collectAgentKitFiles(root);
  if (actualFiles.length !== listed.size) fail("AGENT_KIT_MANIFEST_NOT_CLOSED", "Agent Kit 文件闭集不匹配", {}, 4);
  for (const required of REQUIRED_AGENT_KIT_FILES) {
    if (!listed.has(required)) fail("AGENT_KIT_MANIFEST_INVALID", "Agent Kit MANIFEST 缺少固定运行、协议或法律文件", { path: required }, 4);
  }
  let totalBytes = 0;
  for (const file of actualFiles) {
    const record = listed.get(file.relative);
    if (!record) fail("AGENT_KIT_MANIFEST_NOT_CLOSED", "Agent Kit 存在未登记文件", {}, 4);
    const bytes = readRegularFile(file.absolute, root);
    totalBytes += bytes.length;
    if (totalBytes > MAX_MANIFEST_TOTAL_BYTES) fail("AGENT_KIT_TOTAL_SIZE_EXCEEDED", "Agent Kit 总大小超限", {}, 4);
    if (bytes.length !== record.size || sha256(bytes) !== record.sha256) {
      fail("AGENT_KIT_MANIFEST_MISMATCH", "Agent Kit 文件大小或 SHA-256 与 MANIFEST 不符", { path: file.relative }, 4);
    }
  }
  if (!listed.has(expectedCliEntry) || !listed.has("lib/useful-mcp.mjs")) {
    fail("AGENT_KIT_MANIFEST_INVALID", "Agent Kit MANIFEST 缺少固定 CLI/MCP 入口", {}, 4);
  }
  const kitPackage = readJson(
    readRegularFile(path.join(root, "package.json"), root),
    "AGENT_KIT_PACKAGE_INVALID",
    "Agent Kit package.json 必须是 JSON",
  );
  exactKeys(kitPackage, ["name", "version", "description", "private", "license", "type", "engines"], "AGENT_KIT_PACKAGE_INVALID");
  exactKeys(kitPackage.engines, ["node"], "AGENT_KIT_PACKAGE_INVALID");
  if (kitPackage.name !== "useful-agent-kit"
    || kitPackage.version !== manifest.product.version
    || kitPackage.private !== true
    || kitPackage.license !== "SEE LICENSE IN LICENSE"
    || kitPackage.type !== "module"
    || kitPackage.engines.node !== ">=20") {
    fail("AGENT_KIT_PACKAGE_INVALID", "Agent Kit package.json 身份与 MANIFEST 不一致", {}, 4);
  }
  readRegularFile(mcpEntry, root, "PROBE_MCP_ENTRY_INVALID");
  return Object.freeze({
    installation: Object.freeze({
      mode: "agent-kit",
      artifactVerified: true,
      sourceRevision: manifest.source.revision,
      version: manifest.product.version,
    }),
    mcpEntry,
    root,
  });
}

function readSourceRevision(root) {
  const gitRoot = path.join(root, ".git");
  assertNoLinkedPathComponents(gitRoot, root);
  let metadata;
  try {
    metadata = fs.lstatSync(gitRoot);
  } catch {
    fail("SOURCE_REVISION_UNAVAILABLE", "source 安装缺少固定 .git 元数据", {}, 4);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail("SOURCE_REVISION_UNAVAILABLE", "source .git 必须是本地普通目录", {}, 4);
  const head = readRegularFile(path.join(gitRoot, "HEAD"), gitRoot, "SOURCE_REVISION_UNAVAILABLE").toString("utf8").trim();
  if (SOURCE_REVISION.test(head)) return head;
  const match = /^ref: (refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+)$/u.exec(head);
  if (!match || match[1].split("/").some((part) => !part || part === "." || part === "..")) {
    fail("SOURCE_REVISION_UNAVAILABLE", "source HEAD 引用无效", {}, 4);
  }
  const looseRef = path.join(gitRoot, ...match[1].split("/"));
  if (fs.existsSync(looseRef)) {
    const revision = readRegularFile(looseRef, gitRoot, "SOURCE_REVISION_UNAVAILABLE").toString("utf8").trim();
    if (SOURCE_REVISION.test(revision)) return revision;
  }
  const packedRefs = path.join(gitRoot, "packed-refs");
  if (fs.existsSync(packedRefs)) {
    const rows = readRegularFile(packedRefs, gitRoot, "SOURCE_REVISION_UNAVAILABLE").toString("utf8").split(/\r?\n/u);
    for (const row of rows) {
      const separator = row.indexOf(" ");
      if (separator > 0 && row.slice(separator + 1) === match[1] && SOURCE_REVISION.test(row.slice(0, separator))) {
        return row.slice(0, separator);
      }
    }
  }
  fail("SOURCE_REVISION_UNAVAILABLE", "无法从固定 source .git 元数据解析 revision", {}, 4);
}

function verifySourceLayout(moduleFile) {
  const expectedSuffix = path.join("packages", "useful-cli", "bin", "agent-probe.mjs");
  if (!moduleFile.endsWith(expectedSuffix)) fail("SOURCE_LAYOUT_INVALID", "source CLI 模块不在固定仓库布局", {}, 4);
  const root = path.resolve(path.dirname(moduleFile), "../../..");
  const expectedModule = path.join(root, expectedSuffix);
  if (comparablePath(expectedModule) !== comparablePath(moduleFile)) fail("SOURCE_LAYOUT_INVALID", "source CLI 模块位置无效", {}, 4);
  assertNoLinkedPathComponents(root);
  readRegularFile(moduleFile, root, "PROBE_CLI_ENTRY_INVALID");
  const mcpEntry = path.join(root, ...MCP_ENTRY_SOURCE.split("/"));
  readRegularFile(mcpEntry, root, "PROBE_MCP_ENTRY_INVALID");
  const product = readJson(readRegularFile(path.join(root, "package.json"), root), "SOURCE_PACKAGE_INVALID", "source package.json 必须是 JSON");
  if (product.name !== "useful-monorepo" || typeof product.version !== "string" || !PRODUCT_SEMVER.test(product.version)) {
    fail("SOURCE_PACKAGE_INVALID", "source package.json 产品身份无效", {}, 4);
  }
  return Object.freeze({
    installation: Object.freeze({
      mode: "source",
      artifactVerified: false,
      sourceRevision: readSourceRevision(root),
      version: product.version,
    }),
    mcpEntry,
    root,
  });
}

export function resolveAgentProbeInstallation(moduleUrl = import.meta.url, agentKit = AGENT_KIT_BUILD) {
  let moduleFile;
  try {
    moduleFile = fileURLToPath(moduleUrl);
  } catch {
    fail("PROBE_MODULE_URL_INVALID", "self-probe 模块 URL 无效", {}, 4);
  }
  return agentKit ? verifyAgentKit(moduleFile) : verifySourceLayout(moduleFile);
}

function minimalEnvironment() {
  const env = Object.create(null);
  // The official stdio transport overlays this object on its own safe-default
  // environment. Empty values explicitly scrub every SDK default, including
  // PATH; the absolute process.execPath does not need executable discovery.
  for (const name of DEFAULT_INHERITED_ENV_VARS) env[name] = "";
  env.NO_COLOR = "1";
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot;
    if (typeof systemRoot !== "string" || !/^[A-Za-z]:[\\/](?![\\/])[\x20-\x7e]+$/u.test(systemRoot) || !path.isAbsolute(systemRoot)) {
      fail("SYSTEM_ROOT_INVALID", "Windows self-probe 需要有效的 SystemRoot", {}, 4);
    }
    const normalized = path.normalize(systemRoot);
    const temp = path.join(normalized, "Temp");
    for (const requiredDirectory of [normalized, path.join(normalized, "System32"), temp]) {
      let metadata;
      let real;
      try {
        metadata = fs.lstatSync(requiredDirectory);
        real = fs.realpathSync.native(requiredDirectory);
      } catch {
        fail("SYSTEM_ROOT_INVALID", "Windows SystemRoot 固定目录不可验证", {}, 4);
      }
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || comparablePath(real) !== comparablePath(requiredDirectory)) {
        fail("SYSTEM_ROOT_INVALID", "Windows SystemRoot 固定目录身份无效", {}, 4);
      }
    }
    env.SYSTEMROOT = normalized;
    env.WINDIR = normalized;
    env.TEMP = temp;
    env.TMP = temp;
  }
  return env;
}

function remainingTimeout(deadline) {
  return Math.max(1, deadline - Date.now());
}

function requestOptions(controller, deadline) {
  return { signal: controller.signal, timeout: remainingTimeout(deadline) };
}

async function boundedClose(closeOperation, deadline) {
  const timeout = remainingTimeout(deadline);
  let timer;
  try {
    return await Promise.race([
      closeOperation(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("AGENT_PROBE_CLOSE_TIMEOUT")), timeout);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function assertRecord(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code, "MCP 返回结构无效");
  return value;
}

function verifyToolSet(listed) {
  const tools = assertRecord(listed, "MCP_LIST_INVALID").tools;
  if (!Array.isArray(tools) || tools.some((tool) => !tool || typeof tool.name !== "string")) {
    fail("MCP_LIST_INVALID", "MCP tools/list 返回无效");
  }
  const names = tools.map((tool) => tool.name);
  const expectedNames = [...EXPECTED_ACTION_NAMES, ...EXPECTED_HELPER_ORDER];
  if (names.length !== expectedNames.length
    || new Set(names).size !== names.length
    || names.some((name, index) => name !== expectedNames[index])) {
    fail("MCP_TOOL_SET_MISMATCH", "MCP 工具闭集或顺序与 Useful 默认工具集不符", { expectedCount: 40, actualCount: names.length });
  }
  const actions = names.slice(0, EXPECTED_ACTION_NAMES.length);
  if (actions.length !== EXPECTED_ACTION_NAMES.length
    || actions.some((name, index) => name !== EXPECTED_ACTION_NAMES[index])) {
    fail("MCP_TOOL_SET_MISMATCH", "MCP 默认 action 闭集无效", { expectedActionCount: 36, actualActionCount: actions.length });
  }
  return Object.freeze({ actions, canonicalNames: [...names].sort(compareCodePoints), names });
}

function structuredContent(result, code) {
  if (result?.isError === true) fail(code, "MCP 工具调用返回安全失败");
  return assertRecord(result?.structuredContent, code);
}

async function executeProbe(resolved, dependencies = {}) {
  const ClientClass = dependencies.ClientClass ?? Client;
  const TransportClass = dependencies.TransportClass ?? StdioClientTransport;
  const deadlineMs = dependencies.deadlineMs ?? DEADLINE_MS;
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > DEADLINE_MS) throw new TypeError("deadlineMs must be between 1 and 30000");
  const controller = new AbortController();
  const deadline = Date.now() + deadlineMs;
  let timedOut = false;
  let stderrExceeded = false;
  let stderrBytes = 0;
  const stderrHash = createHash("sha256");
  let transport;
  let client;
  let transportClosed = false;
  let closeFailed = false;
  let clientClosed = false;
  let observations;
  let primaryError;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("AGENT_PROBE_DEADLINE_EXCEEDED"));
  }, deadlineMs);
  try {
    transport = new TransportClass({
      command: process.execPath,
      args: [resolved.mcpEntry],
      cwd: resolved.root,
      env: minimalEnvironment(),
      stderr: "pipe",
      maxBufferSize: 10 * 1024 * 1024,
    });
    if (!transport.stderr || typeof transport.stderr.on !== "function") fail("MCP_STDERR_PIPE_UNAVAILABLE", "MCP stderr pipe 不可用", {}, 4);
    transport.stderr.on("data", (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBytes += bytes.length;
      stderrHash.update(bytes);
      if (stderrBytes > STDERR_LIMIT_BYTES && !stderrExceeded) {
        stderrExceeded = true;
        controller.abort(new Error("AGENT_PROBE_STDERR_LIMIT_EXCEEDED"));
      }
    });
    client = new ClientClass(
      { name: "useful-agent-self-probe", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    await client.connect(transport, requestOptions(controller, deadline));
    if (timedOut) fail("AGENT_PROBE_TIMEOUT", "MCP 执行与 transport 关闭阶段超过 30 秒硬截止时间");
    if (stderrExceeded) fail("AGENT_PROBE_STDERR_LIMIT_EXCEEDED", "MCP stderr 超过 64 KiB 上限", { stderrBytes }, 4);
    const serverInfo = client.getServerVersion?.();
    const protocolVersion = client.getNegotiatedProtocolVersion?.();
    if (!serverInfo || serverInfo.name !== "useful-actions" || typeof serverInfo.version !== "string" || !PRODUCT_SEMVER.test(serverInfo.version)
      || typeof protocolVersion !== "string" || !PROTOCOL_VERSION.test(protocolVersion) || protocolVersion !== "2026-07-28") {
      fail("MCP_HANDSHAKE_IDENTITY_MISMATCH", "MCP initialize 身份或协议版本无效");
    }
    const toolSet = verifyToolSet(await client.listTools(undefined, { ...requestOptions(controller, deadline), cacheMode: "bypass" }));
    const search = structuredContent(await client.callTool({
      name: "useful.actions.search",
      arguments: {},
    }, requestOptions(controller, deadline)), "MCP_SEARCH_PROOF_FAILED");
    if (!Array.isArray(search.actions)
      || search.actions.length !== toolSet.actions.length
      || search.actions.some((entry, index) => entry?.actionId !== toolSet.actions[index])) {
      fail("MCP_SEARCH_PROOF_FAILED", "MCP search 未返回固定 36 action 闭集");
    }
    const described = structuredContent(await client.callTool({
      name: "useful.actions.describe",
      arguments: { actionId: SAFE_ACTION_ID },
    }, requestOptions(controller, deadline)), "MCP_DESCRIBE_PROOF_FAILED");
    if (described.action?.actionId !== SAFE_ACTION_ID
      || described.action.behavior?.readOnly !== true
      || described.action.behavior?.destructive !== false
      || described.action.behavior?.idempotent !== true
      || described.action.behavior?.openWorld !== false
      || described.action.behavior?.requiresConfirmation !== false
      || !Array.isArray(described.action.behavior?.sideEffects)
      || described.action.behavior.sideEffects.length !== 0
      || described.action.execution?.mode !== "pure"
      || !Array.isArray(described.action.permissions?.required)
      || described.action.permissions.required.length !== 0
      || !Array.isArray(described.action.permissions?.capabilities)
      || described.action.permissions.capabilities.length !== 0) {
      fail("MCP_DESCRIBE_PROOF_FAILED", "MCP describe 未证明确定性零权限只读 action");
    }
    const called = structuredContent(await client.callTool({
      name: SAFE_ACTION_ID,
      arguments: SAFE_ACTION_INPUT,
    }, requestOptions(controller, deadline)), "MCP_SAFE_CALL_PROOF_FAILED");
    if (called.text !== SAFE_ACTION_OUTPUT || Object.keys(called).length !== 1) {
      fail("MCP_SAFE_CALL_PROOF_FAILED", "MCP 确定性只读 action 输出不匹配");
    }
    observations = { protocolVersion, serverInfo, toolSet };
  } catch (error) {
    if (error instanceof AgentSelfProbeError) primaryError = error;
    else if (timedOut || controller.signal.aborted && !stderrExceeded) {
      primaryError = new AgentSelfProbeError("AGENT_PROBE_TIMEOUT", "MCP 执行与 transport 关闭阶段超过 30 秒硬截止时间");
    } else if (stderrExceeded) {
      primaryError = new AgentSelfProbeError("AGENT_PROBE_STDERR_LIMIT_EXCEEDED", "MCP stderr 超过 64 KiB 上限", { stderrBytes }, 4);
    } else {
      primaryError = new AgentSelfProbeError("MCP_PROBE_FAILED", "MCP self-probe 连接或协议调用失败");
    }
  } finally {
    if (client && typeof client.close === "function") {
      try {
        await boundedClose(() => client.close(), deadline);
        clientClosed = true;
      } catch {
        closeFailed = true;
      }
    }
    if (!clientClosed && transport && typeof transport.close === "function") {
      try {
        await boundedClose(() => transport.close(), deadline);
      } catch {
        closeFailed = true;
      }
    }
    transportClosed = transport === undefined || transport.pid === null;
    clearTimeout(timer);
  }
  if (!primaryError && timedOut) {
    primaryError = new AgentSelfProbeError("AGENT_PROBE_TIMEOUT", "MCP 执行与 transport 关闭阶段超过 30 秒硬截止时间");
  }
  if (!primaryError && stderrExceeded) {
    primaryError = new AgentSelfProbeError("AGENT_PROBE_STDERR_LIMIT_EXCEEDED", "MCP stderr 超过 64 KiB 上限", { stderrBytes }, 4);
  }
  if (closeFailed || !transportClosed) {
    fail(
      "MCP_TRANSPORT_CLOSE_FAILED",
      "MCP stdio transport 未确认关闭",
      primaryError?.code ? { priorCode: primaryError.code } : {},
      4,
    );
  }
  if (primaryError) throw primaryError;
  if (!observations) fail("MCP_PROBE_FAILED", "MCP self-probe 未产生完整观察结果");
  const namesSha256 = sha256(Buffer.from(JSON.stringify(observations.toolSet.canonicalNames), "utf8"));
  return createAgentProbe({
    installation: resolved.installation,
    server: {
      name: observations.serverInfo.name,
      version: observations.serverInfo.version,
      protocolVersion: observations.protocolVersion,
    },
    tools: {
      count: observations.toolSet.names.length,
      namesSha256,
      actionCount: observations.toolSet.actions.length,
      helperCount: EXPECTED_HELPER_ORDER.length,
    },
    proof: {
      handshake: true,
      list: true,
      search: true,
      describe: true,
      safeCall: true,
      transportClosed: true,
      externalAgentInstalled: false,
      codexConfigured: false,
      claudeConfigured: false,
      hostConfigWrittenByProbe: false,
      launcherNetworkAttested: false,
    },
    process: {
      stderrBytes,
      stderrSha256: stderrHash.digest("hex"),
      transportClosed: true,
    },
  });
}

export async function runAgentSelfProbe() {
  return executeProbe(resolveAgentProbeInstallation());
}

// Test seam only: callers cannot change the production CLI's launcher, argv,
// cwd, environment, or fixed installation resolver.
export const agentProbeTesting = Object.freeze({
  executeProbe,
  expectedActionNames: EXPECTED_ACTION_NAMES,
  expectedHelperOrder: EXPECTED_HELPER_ORDER,
  verifyAgentKit,
  verifySourceLayout,
});
