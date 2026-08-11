import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { types as utilTypes } from "node:util";
import {
  doctorAgentIntegration,
  exportAgentIntegration,
} from "@useful/agent-integrations";
import { createAgentConnectionVerification } from "@useful/protocol/agent-connection-verification";
import {
  resolveAgentProbeInstallation,
  runAgentSelfProbe,
} from "./agent-probe.mjs";

const ALLOWED_INPUT_FIELDS = Object.freeze([
  "environment",
  "launcher",
  "projectDirectory",
  "scope",
  "target",
]);

export class AgentConnectionVerifyError extends Error {
  constructor(code, message, details = {}, exitCode = 3) {
    super(message);
    this.name = "AgentConnectionVerifyError";
    this.code = code;
    this.details = Object.freeze({ ...details });
    this.exitCode = exitCode;
  }
}

function fail(code, message, details = {}, exitCode = 3) {
  throw new AgentConnectionVerifyError(code, message, details, exitCode);
}

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasControlCharacters(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function captureInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || utilTypes.isProxy(input)) {
    fail("AGENT_VERIFY_INPUT_INVALID", "Agent verify 输入必须是普通对象");
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("AGENT_VERIFY_INPUT_INVALID", "Agent verify 输入必须是普通对象");
  }
  if (Object.getOwnPropertySymbols(input).length > 0) {
    fail("AGENT_VERIFY_INPUT_INVALID", "Agent verify 输入不接受 symbol 字段");
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Object.keys(descriptors);
  const unknown = keys.filter((key) => !ALLOWED_INPUT_FIELDS.includes(key)).sort(compareCodePoints);
  if (unknown.length > 0) {
    fail("AGENT_VERIFY_INPUT_INVALID", "Agent verify 输入包含未知字段", { keys: unknown });
  }
  const captured = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !("value" in descriptor)) {
      fail("AGENT_VERIFY_INPUT_INVALID", "Agent verify 输入只接受可枚举数据字段", { field: key });
    }
    captured[key] = descriptor.value;
  }
  return captured;
}

function rejectUnsupportedProfile(environment) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment) || utilTypes.isProxy(environment)) return;
  if (Object.hasOwn(environment, "USEFUL_PROFILE")) {
    fail(
      "AGENT_VERIFY_PROFILE_NOT_SUPPORTED",
      "agent verify V1 不支持 USEFUL_PROFILE；固定 self-probe 不加载 Agent Profile",
      { name: "USEFUL_PROFILE" },
    );
  }
}

function comparablePath(value) {
  const normalized = path.resolve(value).replace(/^\\\\\?\\/u, "").replace(/[\\/]+$/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function assertAbsoluteLocalPath(value) {
  if (typeof value !== "string" || value.trim() === "" || value.length > 4096) {
    fail("AGENT_VERIFY_LAUNCHER_INVALID", "launcher 必须是非空绝对路径", {}, 4);
  }
  if (/^(?:\\\\|\/\/)/u.test(value)) {
    fail("AGENT_VERIFY_LAUNCHER_INVALID", "launcher 不允许 UNC 路径", {}, 4);
  }
  const fullyQualified = process.platform === "win32"
    ? /^[A-Za-z]:[\\/](?![\\/])/u.test(value)
    : /^\/(?!\/)/u.test(value);
  if (!fullyQualified || !path.isAbsolute(value) || hasControlCharacters(value)) {
    fail("AGENT_VERIFY_LAUNCHER_INVALID", "launcher 必须是有效的本机绝对路径", {}, 4);
  }
  return path.normalize(value);
}

function canonicalRegularFile(value, field) {
  const resolved = assertAbsoluteLocalPath(value);
  const parsed = path.parse(resolved);
  const segments = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  let finalMetadata;
  for (const segment of segments) {
    current = path.join(current, segment);
    let metadata;
    let real;
    try {
      metadata = fs.lstatSync(current);
      real = fs.realpathSync.native(current);
    } catch {
      fail("AGENT_VERIFY_LAUNCHER_INVALID", `${field} 不存在或不可解析`, {}, 4);
    }
    if (metadata.isSymbolicLink() || comparablePath(real) !== comparablePath(current)) {
      fail("AGENT_VERIFY_LINKED_PATH_FORBIDDEN", `${field} 不允许 symlink、junction 或 reparse point`, {}, 4);
    }
    finalMetadata = metadata;
  }
  if (!finalMetadata?.isFile() || finalMetadata.isSymbolicLink()) {
    fail("AGENT_VERIFY_LAUNCHER_INVALID", `${field} 必须是普通文件`, {}, 4);
  }
  let realPath;
  try {
    realPath = fs.realpathSync.native(resolved);
  } catch {
    fail("AGENT_VERIFY_LAUNCHER_INVALID", `${field} 不可解析`, {}, 4);
  }
  return Object.freeze({ normalized: resolved, realPath });
}

function assertFixedLauncher(candidate, fixedEntry) {
  const fixed = canonicalRegularFile(fixedEntry, "固定 Useful MCP 入口");
  const supplied = canonicalRegularFile(candidate, "launcher");
  if (comparablePath(supplied.realPath) !== comparablePath(fixed.realPath)) {
    fail(
      "AGENT_VERIFY_LAUNCHER_MISMATCH",
      "launcher 必须是当前 Useful 安装解析出的固定 MCP 入口",
      {},
      4,
    );
  }
  return fixed.normalized;
}

function sameInstallation(left, right) {
  return left?.mode === right?.mode
    && left?.artifactVerified === right?.artifactVerified
    && left?.sourceRevision === right?.sourceRevision
    && left?.version === right?.version;
}

function canonicalExportInput(doctor, fixedLauncher) {
  const plan = doctor.plan;
  return {
    target: plan.target,
    launcher: fixedLauncher,
    scope: plan.scope,
    ...(plan.scope === "project" ? { projectDirectory: plan.projectDirectory } : {}),
    environment: plan.server.env,
  };
}

function prepareAgentConnectionVerification(input, dependencies = {}) {
  const resolveInstallation = dependencies.resolveInstallation ?? resolveAgentProbeInstallation;
  const initial = resolveInstallation();
  const captured = captureInput(input);
  rejectUnsupportedProfile(captured.environment);
  const fixedLauncher = assertFixedLauncher(captured.launcher, initial.mcpEntry);
  return Object.freeze({ captured, fixedLauncher, initial });
}

function buildAgentConnectionCandidate(context, input, dependencies = {}) {
  const doctor = dependencies.doctor ?? doctorAgentIntegration;
  const exportConnection = dependencies.exportConnection ?? exportAgentIntegration;
  const captured = captureInput(input);
  rejectUnsupportedProfile(captured.environment);
  if (comparablePath(captured.launcher) !== comparablePath(context.fixedLauncher)) {
    fail("AGENT_VERIFY_LAUNCHER_MISMATCH", "launcher 必须与本次验证固定入口一致", {}, 4);
  }

  const doctorResult = doctor(captured);
  if (!doctorResult?.ok) {
    const failedChecks = Array.isArray(doctorResult?.checks)
      ? doctorResult.checks.filter((check) => check?.status === "fail").map((check) => check.id)
      : [];
    fail("AGENT_INTEGRATION_DOCTOR_FAILED", "Agent 集成诊断未通过", { failedChecks });
  }
  rejectUnsupportedProfile(doctorResult.plan?.server?.env);
  return exportConnection(canonicalExportInput(doctorResult, context.fixedLauncher));
}

function assertAgentConnectionVerificationIdentity(context, probeResult, dependencies = {}) {
  const resolveInstallation = dependencies.resolveInstallation ?? resolveAgentProbeInstallation;
  const final = resolveInstallation();
  const initial = context.initial;
  if (!sameInstallation(initial.installation, probeResult?.installation)
    || !sameInstallation(initial.installation, final.installation)
    || comparablePath(initial.mcpEntry) !== comparablePath(final.mcpEntry)
    || comparablePath(initial.root) !== comparablePath(final.root)) {
    fail("AGENT_VERIFY_INSTALLATION_DRIFT", "Agent verify 期间 Useful 安装身份发生变化", {}, 4);
  }
}

function createAgentConnectionCandidateVerification(connection, probeResult, dependencies = {}) {
  const createVerification = dependencies.createVerification ?? createAgentConnectionVerification;
  return createVerification({ connection, probe: probeResult });
}

async function executeAgentConnectionVerification(input, dependencies = {}) {
  const probe = dependencies.probe ?? runAgentSelfProbe;
  const context = prepareAgentConnectionVerification(input, dependencies);
  const connection = buildAgentConnectionCandidate(context, context.captured, dependencies);
  const probeResult = await probe();
  assertAgentConnectionVerificationIdentity(context, probeResult, dependencies);
  return createAgentConnectionCandidateVerification(connection, probeResult, dependencies);
}

export async function runAgentConnectionVerification(input) {
  return executeAgentConnectionVerification(input);
}

export const agentConnectionVerificationInternals = Object.freeze({
  prepare: prepareAgentConnectionVerification,
  buildCandidate: buildAgentConnectionCandidate,
  assertIdentity: assertAgentConnectionVerificationIdentity,
  createCandidateVerification: createAgentConnectionCandidateVerification,
});

// Test seam only. The production CLI never exposes dependency, launcher,
// process, argv, cwd, environment, host-command, or host-config overrides.
export const agentConnectionVerificationTesting = Object.freeze({
  execute: executeAgentConnectionVerification,
});
