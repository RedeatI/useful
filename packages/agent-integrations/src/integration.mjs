import fs from "node:fs";
import path from "node:path";
import process from "node:process";

export const AGENT_INTEGRATION_SCHEMA_VERSION = "useful.agent-integration.v1";
export const AGENT_INTEGRATION_TARGETS = Object.freeze([
  "codex",
  "claude-code",
  "claude-desktop",
  "mcp-servers-json",
]);
export const AGENT_INTEGRATION_SCOPES = Object.freeze(["user", "project"]);

const ALLOWED_ENVIRONMENT = Object.freeze({
  NO_COLOR: new Set(["1"]),
  USEFUL_LOG_LEVEL: new Set(["error", "warn", "info"]),
});
const PROFILE_VALUE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const SECRET_NAME = /(?:api[-_]?key|token|secret|password|credential|private[-_]?key|bearer)/i;

export class AgentIntegrationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "AgentIntegrationError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new AgentIntegrationError(code, message, details);
}

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableObject(entries) {
  return Object.fromEntries(Object.entries(entries).sort(([left], [right]) => compareCodePoints(left, right)));
}

function isPlainRecord(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, expected, field) {
  if (!isPlainRecord(value)) fail("INVALID_PLAN", `${field} 必须是普通对象`, { field });
  const actual = Object.keys(value).sort(compareCodePoints);
  const wanted = [...expected].sort(compareCodePoints);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("INVALID_PLAN", `${field} 字段集合无效`, { field, keys: actual });
  }
}

function assertAbsoluteLocalPath(value, field) {
  if (typeof value !== "string" || value.trim() === "" || value.length < 2 || value.length > 4096) {
    fail("MISSING_REQUIRED_VALUE", `${field} 必须是非空绝对路径`, { field });
  }
  if (/^(?:\\\\|\/\/)/.test(value)) {
    fail("UNC_PATH_FORBIDDEN", `${field} 不允许 UNC 路径`, { field });
  }
  const fullyQualified = process.platform === "win32"
    ? /^[A-Za-z]:[\\/](?![\\/])/u.test(value)
    : /^\/(?!\/)/u.test(value);
  if (!fullyQualified || !path.isAbsolute(value)) {
    fail("RELATIVE_PATH_FORBIDDEN", `${field} 必须是绝对路径`, { field });
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    fail("INVALID_PATH", `${field} 包含控制字符`, { field });
  }
  return path.normalize(value);
}

function samePath(left, right) {
  const normalize = (value) => path.normalize(value).replace(/^\\\\\?\\/, "").replace(/[\\/]+$/, "");
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function assertTarget(target) {
  if (!AGENT_INTEGRATION_TARGETS.includes(target)) {
    fail("UNKNOWN_TARGET", "target 必须是受支持的 Agent 目标", { target, allowed: AGENT_INTEGRATION_TARGETS });
  }
  return target;
}

function assertScope(scope) {
  if (!AGENT_INTEGRATION_SCOPES.includes(scope)) {
    fail("UNKNOWN_SCOPE", "scope 必须是 user 或 project", { scope, allowed: AGENT_INTEGRATION_SCOPES });
  }
  return scope;
}

function assertTargetScope(target, scope) {
  if ((target === "claude-desktop" || target === "mcp-servers-json") && scope !== "user") {
    fail("SCOPE_NOT_SUPPORTED", `${target} 在 V1 只支持 user scope`, { target, scope, allowed: ["user"] });
  }
}

export function validateEnvironment(environment = {}) {
  if (!isPlainRecord(environment)) {
    fail("INVALID_ENVIRONMENT", "env 必须是普通键值对象");
  }
  const normalized = {};
  for (const [name, value] of Object.entries(environment)) {
    if (SECRET_NAME.test(name)) {
      fail("SECRET_ENVIRONMENT_FORBIDDEN", "集成配置不接受秘密环境变量", { name });
    }
    if (typeof value !== "string") {
      fail("INVALID_ENVIRONMENT_VALUE", "环境变量值必须是字符串", { name });
    }
    if (name === "USEFUL_PROFILE") {
      if (!PROFILE_VALUE.test(value)) {
        fail("INVALID_ENVIRONMENT_VALUE", "USEFUL_PROFILE 仅允许字母、数字、点、下划线和连字符", { name });
      }
    } else if (!ALLOWED_ENVIRONMENT[name]?.has(value)) {
      fail("ENVIRONMENT_NOT_ALLOWED", "环境变量不在 V1 安全闭集内", {
        name,
        allowed: [...Object.keys(ALLOWED_ENVIRONMENT), "USEFUL_PROFILE"],
      });
    }
    normalized[name] = value;
  }
  return stableObject(normalized);
}

export function parseEnvironmentAssignments(assignments = []) {
  if (!Array.isArray(assignments)) fail("INVALID_ENVIRONMENT_ASSIGNMENT", "env assignments 必须是数组");
  const environment = {};
  for (let index = 0; index < assignments.length; index += 1) {
    const assignment = assignments[index];
    if (typeof assignment !== "string") {
      fail("INVALID_ENVIRONMENT_ASSIGNMENT", "--env 必须使用 NAME=VALUE", { index });
    }
    const separator = assignment.indexOf("=");
    if (separator <= 0) {
      fail("INVALID_ENVIRONMENT_ASSIGNMENT", "--env 必须使用 NAME=VALUE", { index });
    }
    const name = assignment.slice(0, separator);
    const value = assignment.slice(separator + 1);
    if (Object.hasOwn(environment, name)) {
      fail("DUPLICATE_ENVIRONMENT", "同一环境变量只能声明一次", { name });
    }
    environment[name] = value;
  }
  return validateEnvironment(environment);
}

export function quotePowerShellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function toPowerShellInvocation(commandArgv) {
  if (!Array.isArray(commandArgv) || commandArgv.length === 0 || commandArgv.some((value) => typeof value !== "string")) {
    fail("INVALID_COMMAND_ARGV", "commandArgv 必须是非空字符串数组");
  }
  return `& ${commandArgv.map(quotePowerShellLiteral).join(" ")}`;
}

function validatePlan(plan) {
  const scope = assertScope(plan?.scope);
  const expectedKeys = ["schemaVersion", "target", "transport", "scope", "server"];
  if (scope === "project") expectedKeys.push("projectDirectory");
  assertExactKeys(plan, expectedKeys, "plan");
  if (plan.schemaVersion !== AGENT_INTEGRATION_SCHEMA_VERSION) {
    fail("INVALID_PLAN", "plan schemaVersion 无效", { schemaVersion: plan.schemaVersion });
  }
  const target = assertTarget(plan.target);
  assertTargetScope(target, scope);
  if (plan.transport !== "stdio") fail("INVALID_PLAN", "V1 transport 只能是 stdio", { transport: plan.transport });
  assertExactKeys(plan.server, ["name", "nodePath", "launcherPath", "args", "env"], "plan.server");
  if (plan.server.name !== "useful") fail("INVALID_PLAN", "server name 必须是 useful");
  const nodePath = assertAbsoluteLocalPath(plan.server.nodePath, "nodePath");
  if (!samePath(nodePath, process.execPath)) {
    fail("NODE_PATH_MISMATCH", "nodePath 必须是当前进程的 process.execPath", { field: "nodePath" });
  }
  const launcherPath = assertAbsoluteLocalPath(plan.server.launcherPath, "launcher");
  if (!Array.isArray(plan.server.args) || plan.server.args.length !== 0) {
    fail("INVALID_PLAN", "V1 server.args 必须为空数组", { field: "server.args" });
  }
  const environment = validateEnvironment(plan.server.env);
  const projectDirectory = scope === "project"
    ? assertAbsoluteLocalPath(plan.projectDirectory, "projectDirectory")
    : undefined;
  if (projectDirectory) {
    const projectChecks = [];
    if (!checkSafePath(projectDirectory, "projectDirectory", "directory", projectChecks)) {
      fail("PROJECT_DIRECTORY_UNSAFE", "projectDirectory 必须是存在且不含链接组件的常规目录", {
        failedChecks: projectChecks.filter((check) => check.status === "fail").map((check) => check.id),
      });
    }
  }
  return { target, scope, nodePath, launcherPath, environment, projectDirectory };
}

export function buildAgentIntegrationPlan({
  target,
  launcher,
  scope = "user",
  environment = {},
  nodePath = process.execPath,
  projectDirectory,
} = {}) {
  const normalizedTarget = assertTarget(target);
  const normalizedScope = assertScope(scope);
  assertTargetScope(normalizedTarget, normalizedScope);
  const normalizedNodePath = assertAbsoluteLocalPath(nodePath, "nodePath");
  if (!samePath(normalizedNodePath, process.execPath)) {
    fail("NODE_PATH_MISMATCH", "nodePath 必须是当前进程的 process.execPath", { field: "nodePath" });
  }
  const normalizedLauncher = assertAbsoluteLocalPath(launcher, "launcher");
  const normalizedProjectDirectory = normalizedScope === "project"
    ? assertAbsoluteLocalPath(projectDirectory, "projectDirectory")
    : undefined;
  if (normalizedScope === "user" && projectDirectory !== undefined) {
    fail("PROJECT_DIRECTORY_FORBIDDEN", "user scope 不接受 projectDirectory", { field: "projectDirectory" });
  }
  const plan = {
    schemaVersion: AGENT_INTEGRATION_SCHEMA_VERSION,
    target: normalizedTarget,
    transport: "stdio",
    scope: normalizedScope,
    ...(normalizedProjectDirectory ? { projectDirectory: normalizedProjectDirectory } : {}),
    server: {
      name: "useful",
      nodePath: normalizedNodePath,
      launcherPath: normalizedLauncher,
      args: [],
      env: validateEnvironment(environment),
    },
  };
  validatePlan(plan);
  Object.freeze(plan.server.args);
  Object.freeze(plan.server.env);
  Object.freeze(plan.server);
  return Object.freeze(plan);
}

function asMcpServer(validated) {
  return {
    command: validated.nodePath,
    args: [validated.launcherPath],
    ...(Object.keys(validated.environment).length > 0 ? { env: validated.environment } : {}),
  };
}

function environmentArgv(environment) {
  return Object.entries(environment).flatMap(([name, value]) => ["--env", `${name}=${value}`]);
}

function toTomlString(value) {
  return JSON.stringify(value);
}

function renderCodexToml(validated) {
  const server = asMcpServer(validated);
  const lines = [
    "[mcp_servers.useful]",
    `command = ${toTomlString(server.command)}`,
    `args = [${server.args.map(toTomlString).join(", ")}]`,
  ];
  if (server.env) {
    lines.push(`env = { ${Object.entries(server.env).map(([key, value]) => `${key} = ${toTomlString(value)}`).join(", ")} }`);
  }
  return `${lines.join("\n")}\n`;
}

function commandOutput(commandArgv, requiredWorkingDirectory) {
  return {
    kind: "host-command",
    commandArgv,
    powershellCommand: toPowerShellInvocation(commandArgv),
    ...(requiredWorkingDirectory ? { requiredWorkingDirectory } : {}),
    writesHostConfigWhenExecuted: true,
  };
}

export function renderAgentIntegration(plan) {
  const validated = validatePlan(plan);
  const mcpServer = asMcpServer(validated);
  if (validated.target === "codex") {
    if (validated.scope === "project") {
      return {
        kind: "merge-fragment",
        format: "toml",
        configPath: path.join(validated.projectDirectory, ".codex", "config.toml"),
        mergeFragment: renderCodexToml(validated),
        writesHostConfigWhenExecuted: false,
      };
    }
    return commandOutput([
      "codex", "mcp", "add", "useful",
      ...environmentArgv(validated.environment),
      "--", validated.nodePath, validated.launcherPath,
    ]);
  }
  if (validated.target === "claude-code") {
    const hostScope = validated.scope === "project" ? "project" : "user";
    return commandOutput([
      "claude", "mcp", "add",
      ...environmentArgv(validated.environment),
      "--transport", "stdio",
      "--scope", hostScope,
      "useful", "--", validated.nodePath, validated.launcherPath,
    ], validated.scope === "project" ? validated.projectDirectory : undefined);
  }
  if (validated.target === "claude-desktop" || validated.target === "mcp-servers-json") {
    return {
      kind: "merge-fragment",
      format: "json",
      mergeFragment: { mcpServers: { useful: mcpServer } },
      writesHostConfigWhenExecuted: false,
    };
  }
  return fail("UNKNOWN_TARGET", "target 必须是受支持的 Agent 目标", { target: validated.target });
}

function addCheck(checks, id, status, message, details = undefined) {
  checks.push({ id, status, message, ...(details === undefined ? {} : { details }) });
}

function comparableRealPath(value) {
  const normalized = path.resolve(value).replace(/^\\\\\?\\/, "").replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function checkSafePath(target, field, expectedKind, checks) {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  const segments = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let metadata;
    try {
      metadata = fs.lstatSync(current);
    } catch {
      addCheck(checks, `${field}.exists`, "fail", `${field} 不存在或不可读取`, { path: resolved });
      return false;
    }
    let real;
    try {
      real = fs.realpathSync.native(current);
    } catch {
      addCheck(checks, `${field}.readable`, "fail", `${field} 路径组件不可解析`, { path: current });
      return false;
    }
    if (metadata.isSymbolicLink() || comparableRealPath(real) !== comparableRealPath(current)) {
      addCheck(checks, `${field}.linked-path`, "fail", `${field} 不允许 symlink、junction 或 reparse point`, { path: current });
      return false;
    }
    if (current === resolved) {
      const validKind = expectedKind === "file" ? metadata.isFile() : metadata.isDirectory();
      if (!validKind) {
        addCheck(checks, `${field}.${expectedKind}`, "fail", `${field} 不是常规${expectedKind === "file" ? "文件" : "目录"}`, { path: resolved });
        return false;
      }
    }
  }
  addCheck(checks, `${field}.${expectedKind}`, "pass", `${field} 路径预检通过`, { path: resolved });
  return true;
}

function checkGeneratedOutput(output, checks) {
  try {
    if (output.kind === "host-command") {
      if (!Array.isArray(output.commandArgv) || output.commandArgv.length === 0) throw new Error("commandArgv invalid");
      if (output.powershellCommand !== toPowerShellInvocation(output.commandArgv)) throw new Error("PowerShell derivation mismatch");
    } else if (output.format === "json") {
      JSON.parse(JSON.stringify(output.mergeFragment));
    } else if (output.format === "toml") {
      if (!/^\[mcp_servers\.useful\]\ncommand = /u.test(output.mergeFragment)) throw new Error("TOML fragment invalid");
    } else {
      throw new Error("output kind invalid");
    }
    addCheck(checks, "generated-output.parse", "pass", "生成物结构预检通过", { kind: output.kind });
    return true;
  } catch {
    addCheck(checks, "generated-output.parse", "fail", "生成物结构预检失败");
    return false;
  }
}

export function doctorAgentIntegration(input) {
  const plan = buildAgentIntegrationPlan(input);
  const checks = [];
  const launcherOk = checkSafePath(plan.server.launcherPath, "launcher", "file", checks);
  const nodeOk = checkSafePath(plan.server.nodePath, "nodePath", "file", checks);
  const projectOk = plan.scope === "project"
    ? checkSafePath(plan.projectDirectory, "projectDirectory", "directory", checks)
    : true;
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (Number.isInteger(nodeMajor) && nodeMajor >= 20) {
    addCheck(checks, "node.version", "pass", `当前 Node.js ${process.versions.node} 满足 >=20`, { version: process.versions.node });
  } else {
    addCheck(checks, "node.version", "fail", `当前 Node.js ${process.versions.node} 不满足 >=20`, { version: process.versions.node, required: ">=20" });
  }
  const output = renderAgentIntegration(plan);
  const generatedOutputOk = checkGeneratedOutput(output, checks);
  return {
    schemaVersion: AGENT_INTEGRATION_SCHEMA_VERSION,
    ok: launcherOk && nodeOk && projectOk && nodeMajor >= 20 && generatedOutputOk,
    plan,
    output,
    checks,
  };
}

export function planAgentIntegration(input) {
  const plan = buildAgentIntegrationPlan(input);
  return {
    schemaVersion: AGENT_INTEGRATION_SCHEMA_VERSION,
    plan,
    output: renderAgentIntegration(plan),
  };
}
