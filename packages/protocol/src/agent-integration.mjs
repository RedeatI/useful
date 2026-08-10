import path from "node:path";
import { types as utilTypes } from "node:util";

export const AGENT_INTEGRATION_SCHEMA_VERSION = "useful.agent-integration.v1";
export const AGENT_INTEGRATION_SCHEMA_FILE = "agent-integration.schema.json";
export const AGENT_INTEGRATION_SCHEMA_ID = "https://schemas.useful.example/agent/useful.agent-integration.v1.schema.json";
export const AGENT_INTEGRATION_TARGETS = Object.freeze(["codex", "claude-code", "claude-desktop", "mcp-servers-json"]);
export const AGENT_INTEGRATION_SCOPES = Object.freeze(["user", "project"]);
export const AGENT_INTEGRATION_HOST_PLATFORMS = Object.freeze(["win32", "linux", "darwin"]);

const UNSAFE_KEY = new Set(["__proto__", "prototype", "constructor"]);
const ALLOWED_ENVIRONMENT = Object.freeze({
  NO_COLOR: new Set(["1"]),
  USEFUL_LOG_LEVEL: new Set(["error", "warn", "info"]),
});
const PROFILE_VALUE = /^[a-z0-9][a-z0-9._-]{0,63}$/iu;
const MAX_PATH_LENGTH = 4096;

export class AgentIntegrationProtocolError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "AgentIntegrationProtocolError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details = {}) {
  throw new AgentIntegrationProtocolError(code, message, details);
}

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Capture a single fail-closed plain-data snapshot without invoking getters.
 * Proxies, accessors, symbols, hidden fields, sparse arrays, cycles and non-JSON
 * values are rejected before validation observes the returned copy.
 */
export function snapshotAgentIntegrationData(value, field = "input") {
  const ancestors = new Set();

  function visit(current, currentField) {
    if (current === null || typeof current === "string" || typeof current === "boolean") return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) fail("UNSUPPORTED_VALUE", `${currentField} 只接受有限数字`, { field: currentField });
      return current;
    }
    if (typeof current !== "object") {
      fail("UNSUPPORTED_VALUE", `${currentField} 只接受普通 JSON 数据`, { field: currentField });
    }
    if (utilTypes.isProxy(current)) fail("PROXY_FORBIDDEN", `${currentField} 不接受 Proxy`, { field: currentField });
    if (ancestors.has(current)) fail("CYCLIC_INPUT_FORBIDDEN", `${currentField} 不接受循环引用`, { field: currentField });
    ancestors.add(current);
    try {
      const prototype = Object.getPrototypeOf(current);
      const isArray = Array.isArray(current);
      if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
        fail("NON_PLAIN_DATA_FORBIDDEN", `${currentField} 必须是普通对象或数组`, { field: currentField });
      }
      const symbols = Object.getOwnPropertySymbols(current);
      if (symbols.length > 0) fail("SYMBOL_PROPERTY_FORBIDDEN", `${currentField} 不允许 symbol 字段`, { field: currentField });
      const descriptors = Object.getOwnPropertyDescriptors(current);
      if (isArray) {
        const keys = Object.keys(descriptors).filter((key) => key !== "length");
        if (keys.length !== current.length) fail("INVALID_ARRAY", `${currentField} 必须是稠密数组`, { field: currentField });
        const output = [];
        for (let index = 0; index < current.length; index += 1) {
          const key = String(index);
          const descriptor = descriptors[key];
          if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
            fail("ACCESSOR_PROPERTY_FORBIDDEN", `${currentField} 只允许可枚举数据项`, { field: currentField, key });
          }
          output.push(visit(descriptor.value, `${currentField}[${index}]`));
        }
        if (keys.some((key, index) => key !== String(index))) {
          fail("INVALID_ARRAY", `${currentField} 不允许额外或稀疏数组字段`, { field: currentField });
        }
        return output;
      }
      const output = {};
      for (const key of Object.keys(descriptors).sort(compareCodePoints)) {
        if (UNSAFE_KEY.has(key)) fail("PROTOTYPE_POLLUTION_FORBIDDEN", `${currentField} 包含不安全字段`, { field: currentField });
        const descriptor = descriptors[key];
        if (!descriptor.enumerable || !("value" in descriptor)) {
          fail("ACCESSOR_PROPERTY_FORBIDDEN", `${currentField} 只允许可枚举数据字段`, { field: currentField, key });
        }
        output[key] = visit(descriptor.value, `${currentField}.${key}`);
      }
      return output;
    } finally {
      ancestors.delete(current);
    }
  }

  return visit(value, field);
}

function deepFreezeCanonical(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) deepFreezeCanonical(value[key]);
    Object.freeze(value);
  }
  return value;
}

export function deepFreezeAgentIntegrationData(value) {
  return deepFreezeCanonical(snapshotAgentIntegrationData(value, "freeze.input"));
}

function entriesOf(record) {
  return Object.entries(record).sort(([left], [right]) => compareCodePoints(left, right));
}

function stableRecord(entries) {
  return Object.fromEntries([...entries].sort(([left], [right]) => compareCodePoints(left, right)));
}

function exactRecord(value, expected, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_RECORD", `${field} 必须是普通对象`, { field });
  const actual = Object.keys(value).sort(compareCodePoints);
  const wanted = [...expected].sort(compareCodePoints);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("UNKNOWN_FIELD", `${field} 字段集合无效`, { field, keys: actual });
  }
  return value;
}

function assertAbsoluteLocalPath(value, field, hostPlatform) {
  if (typeof value !== "string" || value.length < 2 || value.length > MAX_PATH_LENGTH || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("INVALID_PATH", `${field} 必须是受限本地绝对路径`, { field });
  }
  if (/^(?:\\\\|\/\/)/u.test(value)) fail("UNC_PATH_FORBIDDEN", `${field} 不允许 UNC 路径`, { field });
  const windows = /^[A-Za-z]:[\\/](?![\\/])/u.test(value);
  const posix = /^\/(?!\/)/u.test(value);
  if (!windows && !posix) fail("RELATIVE_PATH_FORBIDDEN", `${field} 必须是本地绝对路径`, { field });
  if (hostPlatform === "win32" && !windows) fail("HOST_PATH_MISMATCH", `${field} 不是 Windows 主机路径`, { field });
  if ((hostPlatform === "linux" || hostPlatform === "darwin") && !posix) {
    fail("HOST_PATH_MISMATCH", `${field} 不是 POSIX 主机路径`, { field });
  }
  return value;
}

function parseEnvironment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_ENVIRONMENT", "plan.server.env 必须是普通对象");
  const entries = entriesOf(value);
  for (const [name, raw] of entries) {
    if (!Object.hasOwn(ALLOWED_ENVIRONMENT, name) && name !== "USEFUL_PROFILE") {
      fail("ENVIRONMENT_NOT_ALLOWED", "环境变量不在 V1 安全闭集内", { name });
    }
    if (typeof raw !== "string") fail("INVALID_ENVIRONMENT", "环境变量值必须为字符串", { name });
    if (name === "USEFUL_PROFILE" && !PROFILE_VALUE.test(raw)) fail("INVALID_ENVIRONMENT", "USEFUL_PROFILE 无效", { name });
    if (name !== "USEFUL_PROFILE" && !ALLOWED_ENVIRONMENT[name].has(raw)) fail("INVALID_ENVIRONMENT", "环境变量值无效", { name });
  }
  return stableRecord(entries);
}

function parseHostPlatform(value) {
  if (!AGENT_INTEGRATION_HOST_PLATFORMS.includes(value)) fail("INVALID_HOST_PLATFORM", "hostPlatform 无效", { hostPlatform: value });
  return value;
}

export function parseAgentIntegrationPlan(document, options = {}) {
  const capturedOptions = snapshotAgentIntegrationData(options, "parseAgentIntegrationPlan.options");
  exactRecord(capturedOptions, Object.hasOwn(capturedOptions, "hostPlatform") ? ["hostPlatform"] : [], "parseAgentIntegrationPlan.options");
  const hostPlatform = capturedOptions.hostPlatform;
  const plan = snapshotAgentIntegrationData(document, "plan");
  const scope = plan?.scope;
  exactRecord(plan, scope === "project"
    ? ["schemaVersion", "target", "transport", "scope", "projectDirectory", "server"]
    : ["schemaVersion", "target", "transport", "scope", "server"], "plan");
  if (plan.schemaVersion !== AGENT_INTEGRATION_SCHEMA_VERSION) fail("INVALID_PLAN", "plan.schemaVersion 无效");
  if (!AGENT_INTEGRATION_TARGETS.includes(plan.target)) fail("UNKNOWN_TARGET", "plan.target 不受支持", { target: plan.target });
  if (!AGENT_INTEGRATION_SCOPES.includes(scope)) fail("UNKNOWN_SCOPE", "plan.scope 不受支持", { scope });
  if ((plan.target === "claude-desktop" || plan.target === "mcp-servers-json") && scope !== "user") {
    fail("SCOPE_NOT_SUPPORTED", "该 target 只支持 user scope", { target: plan.target, scope });
  }
  if (plan.transport !== "stdio") fail("INVALID_PLAN", "plan.transport 只能为 stdio");
  const platform = hostPlatform === undefined ? undefined : parseHostPlatform(hostPlatform);
  exactRecord(plan.server, ["name", "nodePath", "launcherPath", "args", "env"], "plan.server");
  if (plan.server.name !== "useful") fail("INVALID_PLAN", "plan.server.name 必须为 useful");
  if (!Array.isArray(plan.server.args) || plan.server.args.length !== 0) fail("INVALID_PLAN", "plan.server.args 必须为空数组");
  const canonical = stableRecord([
    ...(scope === "project" ? [["projectDirectory", assertAbsoluteLocalPath(plan.projectDirectory, "plan.projectDirectory", platform)]] : []),
    ["schemaVersion", AGENT_INTEGRATION_SCHEMA_VERSION],
    ["scope", scope],
    ["server", stableRecord([
      ["args", []],
      ["env", parseEnvironment(plan.server.env)],
      ["launcherPath", assertAbsoluteLocalPath(plan.server.launcherPath, "plan.server.launcherPath", platform)],
      ["name", "useful"],
      ["nodePath", assertAbsoluteLocalPath(plan.server.nodePath, "plan.server.nodePath", platform)],
    ])],
    ["target", plan.target],
    ["transport", "stdio"],
  ]);
  return deepFreezeAgentIntegrationData(canonical);
}

function quotePowerShellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function environmentArgv(environment) {
  return entriesOf(environment).flatMap(([name, value]) => ["--env", `${name}=${value}`]);
}

function mcpServer(plan) {
  return stableRecord([
    ["args", [plan.server.launcherPath]],
    ["command", plan.server.nodePath],
    ...(Object.keys(plan.server.env).length > 0 ? [["env", plan.server.env]] : []),
  ]);
}

/** The sole canonical renderer for all four V1 integration targets. */
export function renderAgentIntegrationOutput(document, options = {}) {
  const capturedOptions = snapshotAgentIntegrationData(options, "renderAgentIntegrationOutput.options");
  exactRecord(capturedOptions, ["hostPlatform"], "renderAgentIntegrationOutput.options");
  const hostPlatform = capturedOptions.hostPlatform;
  const platform = parseHostPlatform(hostPlatform);
  const plan = parseAgentIntegrationPlan(document, { hostPlatform: platform });
  const server = mcpServer(plan);
  let output;
  if (plan.target === "codex" && plan.scope === "project") {
    const fragment = [
      "[mcp_servers.useful]",
      `command = ${JSON.stringify(server.command)}`,
      `args = [${JSON.stringify(plan.server.launcherPath)}]`,
      ...(server.env ? [`env = { ${entriesOf(server.env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join(", ")} }`] : []),
    ].join("\n").concat("\n");
    const pathApi = platform === "win32" ? path.win32 : path.posix;
    output = stableRecord([
      ["configPath", pathApi.join(plan.projectDirectory, ".codex", "config.toml")],
      ["format", "toml"],
      ["kind", "merge-fragment"],
      ["mergeFragment", fragment],
      ["writesHostConfigWhenExecuted", false],
    ]);
  } else if (plan.target === "claude-desktop" || plan.target === "mcp-servers-json") {
    output = stableRecord([
      ["format", "json"],
      ["kind", "merge-fragment"],
      ["mergeFragment", stableRecord([["mcpServers", stableRecord([["useful", server]])]])],
      ["writesHostConfigWhenExecuted", false],
    ]);
  } else {
    const argv = plan.target === "codex"
      ? ["codex", "mcp", "add", "useful", ...environmentArgv(plan.server.env), "--", plan.server.nodePath, plan.server.launcherPath]
      : ["claude", "mcp", "add", ...environmentArgv(plan.server.env), "--transport", "stdio", "--scope", plan.scope, "useful", "--", plan.server.nodePath, plan.server.launcherPath];
    output = stableRecord([
      ["commandArgv", argv],
      ["kind", "host-command"],
      ["powershellCommand", `& ${argv.map(quotePowerShellLiteral).join(" ")}`],
      ...(plan.target === "claude-code" && plan.scope === "project" ? [["requiredWorkingDirectory", plan.projectDirectory]] : []),
      ["writesHostConfigWhenExecuted", true],
    ]);
  }
  return deepFreezeAgentIntegrationData(output);
}
