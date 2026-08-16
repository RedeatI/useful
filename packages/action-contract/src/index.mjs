const CONTRACT_VERSION = "1.0";
const ACTION_ID = /^[a-z][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)+$/;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const JSON_POINTER = /^(?:\/(?:[^~/]|~0|~1)*)*$/;
const EXECUTION_MODES = new Set(["pure", "host", "worker", "ui-only"]);
const JSON_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const SCHEMA_KEYS = new Set([
  "$schema",
  "type",
  "title",
  "description",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "uniqueItems",
]);

export {
  EXECUTION_RECEIPT_MAX_BYTES,
  EXECUTION_RECEIPT_STATUSES,
  EXECUTION_RECEIPT_VERSION,
  ExecutionReceiptError,
  assertExecutionReceipt,
  parseExecutionReceipt,
  upgradeExecutionReceipt,
  validateExecutionReceipt,
} from "./receipt.mjs";

export const RESERVED_ACTION_NAMES = Object.freeze([
  "useful.actions.search",
  "useful.actions.describe",
  "useful.actions.suggest",
  "useful.actions.recipe",
]);
const RESERVED_ACTION_NAME_SET = new Set(RESERVED_ACTION_NAMES);

export function isReservedActionName(value) {
  return typeof value === "string" && RESERVED_ACTION_NAME_SET.has(value);
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const issue = (issues, path, message) => issues.push({ path, message });

function requireKeys(value, required, allowed, path, issues) {
  if (!isObject(value)) {
    issue(issues, path, "必须是对象");
    return false;
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) issue(issues, `${path}/${key}`, "缺少必填字段");
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issue(issues, `${path}/${key}`, "未知字段被拒绝");
  }
  return true;
}

function stringArray(value, path, issues, maxItems = 128, allowEmpty = false) {
  if (!Array.isArray(value)) {
    issue(issues, path, "必须是字符串数组");
    return;
  }
  if (value.length > maxItems) issue(issues, path, `最多 ${maxItems} 项`);
  const seen = new Set();
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || (!allowEmpty && entry.length === 0)) {
      issue(issues, `${path}/${index}`, allowEmpty ? "必须是字符串" : "必须是非空字符串");
    } else if (seen.has(entry)) {
      issue(issues, `${path}/${index}`, "不允许重复项");
    }
    seen.add(entry);
  });
}

function validateSchemaShape(schema, path, issues) {
  if (!isObject(schema)) {
    issue(issues, path, "JSON Schema 必须是对象");
    return;
  }
  for (const key of Object.keys(schema)) {
    if (!SCHEMA_KEYS.has(key)) issue(issues, `${path}/${key}`, "Action v1 不支持此 schema 关键字");
  }
  if (schema.$schema !== undefined && schema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
    issue(issues, `${path}/$schema`, "只接受 JSON Schema 2020-12");
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.length || types.some((type) => !JSON_TYPES.has(type))) {
    issue(issues, `${path}/type`, "必须声明受支持的 JSON type");
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    issue(issues, `${path}/enum`, "enum 必须是非空数组");
  }
  for (const key of ["minLength", "maxLength", "minItems", "maxItems"]) {
    if (schema[key] !== undefined && (!Number.isInteger(schema[key]) || schema[key] < 0)) {
      issue(issues, `${path}/${key}`, "必须是非负整数");
    }
  }
  for (const key of ["minimum", "maximum"]) {
    if (schema[key] !== undefined && (typeof schema[key] !== "number" || !Number.isFinite(schema[key]))) {
      issue(issues, `${path}/${key}`, "必须是有限数字");
    }
  }
  if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== "boolean") {
    issue(issues, `${path}/uniqueItems`, "必须是 boolean");
  }
  if (schema.required !== undefined) stringArray(schema.required, `${path}/required`, issues, 128);
  if (types.includes("object")) {
    if (!isObject(schema.properties)) issue(issues, `${path}/properties`, "object schema 必须声明 properties");
    if (schema.additionalProperties !== false) {
      issue(issues, `${path}/additionalProperties`, "object schema 必须 fail closed（值为 false）");
    }
    if (isObject(schema.properties)) {
      for (const [name, child] of Object.entries(schema.properties)) {
        validateSchemaShape(child, `${path}/properties/${name}`, issues);
      }
    }
  }
  if (types.includes("array")) {
    if (!isObject(schema.items)) issue(issues, `${path}/items`, "array schema 必须声明单一 items schema");
    else validateSchemaShape(schema.items, `${path}/items`, issues);
  }
}

export function validateActionDescriptor(value) {
  const issues = [];
  const topRequired = [
    "contractVersion", "actionId", "version", "source", "title", "description",
    "keywords", "aliases", "inputSchema", "outputSchema", "examples", "testVectors",
    "execution", "behavior", "permissions", "sensitive",
  ];
  const topAllowed = [...topRequired, "presentation"];
  if (!requireKeys(value, topRequired, topAllowed, "", issues)) return issues;

  if (value.contractVersion !== CONTRACT_VERSION) issue(issues, "/contractVersion", "只支持 1.0");
  if (typeof value.actionId !== "string" || !ACTION_ID.test(value.actionId)) issue(issues, "/actionId", "actionId 格式非法");
  if (isReservedActionName(value.actionId)) issue(issues, "/actionId", "actionId 是 Useful discovery 保留名");
  if (typeof value.version !== "string" || !SEMVER.test(value.version)) issue(issues, "/version", "version 必须是 semver");
  if (typeof value.title !== "string" || value.title.length === 0) issue(issues, "/title", "title 必须非空");
  if (typeof value.description !== "string" || value.description.length === 0) issue(issues, "/description", "description 必须非空");
  stringArray(value.keywords, "/keywords", issues, 64);
  stringArray(value.aliases, "/aliases", issues, 32);
  value.aliases?.forEach((alias, index) => {
    if (isReservedActionName(alias)) issue(issues, `/aliases/${index}`, "alias 是 Useful discovery 保留名");
  });

  if (requireKeys(value.source, ["kind", "toolId", "publisher", "digest"], ["kind", "toolId", "publisher", "digest"], "/source", issues)) {
    if (!["builtin", "plugin", "local"].includes(value.source.kind)) issue(issues, "/source/kind", "source.kind 非法");
    if (typeof value.source.toolId !== "string" || value.source.toolId.length === 0) issue(issues, "/source/toolId", "toolId 必须非空");
    if (typeof value.source.digest !== "string" || !SHA256.test(value.source.digest)) issue(issues, "/source/digest", "digest 必须是 SHA-256 hex");
    if (requireKeys(value.source.publisher, ["id"], ["id", "name"], "/source/publisher", issues)) {
      if (typeof value.source.publisher.id !== "string" || value.source.publisher.id.length === 0) issue(issues, "/source/publisher/id", "publisher.id 必须非空");
    }
    const actionUsesBuiltinNamespace = typeof value.actionId === "string" && value.actionId.startsWith("builtin.");
    const toolUsesBuiltinNamespace = typeof value.source.toolId === "string"
      && value.source.toolId.startsWith("builtin.");
    if (value.source.kind === "builtin") {
      if (!actionUsesBuiltinNamespace) issue(issues, "/actionId", "builtin source 必须使用 builtin.* 命名空间");
      if (!toolUsesBuiltinNamespace) issue(issues, "/source/toolId", "builtin source toolId 必须使用 builtin.* 命名空间");
    } else {
      if (actionUsesBuiltinNamespace) issue(issues, "/actionId", "非 builtin source 不得使用 builtin.* 命名空间");
      if (toolUsesBuiltinNamespace) issue(issues, "/source/toolId", "非 builtin source 不得使用 builtin.* 命名空间");
      value.aliases?.forEach((alias, index) => {
        if (typeof alias === "string" && alias.startsWith("builtin.")) issue(issues, `/aliases/${index}`, "非 builtin source alias 不得使用 builtin.* 命名空间");
      });
      if (value.source.kind === "plugin"
        && typeof value.actionId === "string"
        && typeof value.source.toolId === "string"
        && !value.actionId.startsWith(`${value.source.toolId}.`)) {
        issue(issues, "/actionId", "plugin actionId 必须位于 source.toolId 命名空间");
      }
    }
  }

  validateSchemaShape(value.inputSchema, "/inputSchema", issues);
  validateSchemaShape(value.outputSchema, "/outputSchema", issues);

  if (!Array.isArray(value.examples)) issue(issues, "/examples", "examples 必须是数组");
  if (!Array.isArray(value.testVectors) || value.testVectors.length === 0) issue(issues, "/testVectors", "至少需要一个 test vector");
  if (Array.isArray(value.testVectors)) {
    value.testVectors.forEach((vector, index) => {
      const path = `/testVectors/${index}`;
      if (!requireKeys(vector, ["name", "input"], ["name", "input", "expectedOutput", "expectedErrorCode"], path, issues)) return;
      const expected = Number(Object.hasOwn(vector, "expectedOutput")) + Number(Object.hasOwn(vector, "expectedErrorCode"));
      if (expected !== 1) issue(issues, path, "必须且只能声明 expectedOutput 或 expectedErrorCode");
    });
  }

  if (requireKeys(value.execution, ["mode", "timeoutMs", "maxInputBytes", "maxOutputBytes", "supportsCancellation"], ["mode", "handler", "timeoutMs", "maxInputBytes", "maxOutputBytes", "supportsCancellation"], "/execution", issues)) {
    const execution = value.execution;
    if (!EXECUTION_MODES.has(execution.mode)) issue(issues, "/execution/mode", "execution.mode 非法");
    if (execution.mode === "ui-only" && execution.handler !== undefined) issue(issues, "/execution/handler", "ui-only 不得声明 headless handler");
    if (execution.mode !== "ui-only" && (typeof execution.handler !== "string" || execution.handler.length === 0)) issue(issues, "/execution/handler", "headless action 必须显式声明 handler");
    for (const [name, max] of [["timeoutMs", 3600000], ["maxInputBytes", 16777216], ["maxOutputBytes", 16777216]]) {
      if (!Number.isInteger(execution[name]) || execution[name] < 1 || execution[name] > max) issue(issues, `/execution/${name}`, `必须是 1..${max} 的整数`);
    }
    if (typeof execution.supportsCancellation !== "boolean") issue(issues, "/execution/supportsCancellation", "必须是 boolean");
  }

  const behaviorKeys = ["readOnly", "destructive", "idempotent", "openWorld", "sideEffects", "requiresConfirmation"];
  if (requireKeys(value.behavior, behaviorKeys, behaviorKeys, "/behavior", issues)) {
    for (const name of behaviorKeys.filter((key) => key !== "sideEffects")) {
      if (typeof value.behavior[name] !== "boolean") issue(issues, `/behavior/${name}`, "必须是 boolean");
    }
    stringArray(value.behavior.sideEffects, "/behavior/sideEffects", issues, 32);
    if (value.behavior.destructive && !value.behavior.requiresConfirmation) issue(issues, "/behavior/requiresConfirmation", "destructive action 必须确认");
    if (value.execution?.mode === "pure") {
      if (value.behavior.openWorld || value.behavior.destructive || value.behavior.sideEffects?.length) {
        issue(issues, "/behavior", "pure action 不得 destructive、openWorld 或有副作用");
      }
    }
  }

  if (requireKeys(value.permissions, ["required", "capabilities"], ["required", "capabilities"], "/permissions", issues)) {
    stringArray(value.permissions.required, "/permissions/required", issues);
    stringArray(value.permissions.capabilities, "/permissions/capabilities", issues);
    if (value.execution?.mode === "pure" && (value.permissions.required?.length || value.permissions.capabilities?.length)) {
      issue(issues, "/permissions", "pure action 不得请求宿主权限或能力");
    }
  }

  if (requireKeys(value.sensitive, ["input", "output", "redactLogs"], ["input", "output", "redactLogs"], "/sensitive", issues)) {
    for (const name of ["input", "output"]) {
      // RFC 6901 uses the empty string for the document root. It is valid only
      // for sensitive JSON Pointer lists, where it means redact the whole value.
      stringArray(value.sensitive[name], `/sensitive/${name}`, issues, 64, true);
      if (Array.isArray(value.sensitive[name])) {
        value.sensitive[name].forEach((pointer, index) => {
          if (typeof pointer === "string" && !JSON_POINTER.test(pointer)) issue(issues, `/sensitive/${name}/${index}`, "必须是合法 JSON Pointer");
        });
      }
    }
    if (value.sensitive.redactLogs !== true) issue(issues, "/sensitive/redactLogs", "日志脱敏必须开启");
  }
  if (value.presentation !== undefined
    && requireKeys(value.presentation, [], ["route", "icon", "category"], "/presentation", issues)) {
    for (const [name, maximum] of [["route", 512], ["icon", 128], ["category", 128]]) {
      const field = value.presentation[name];
      if (field !== undefined && (typeof field !== "string" || field.length < 1 || field.length > maximum)) {
        issue(issues, `/presentation/${name}`, `必须是 1..${maximum} 字符的字符串`);
      }
    }
  }
  return issues;
}

export function assertActionDescriptor(value) {
  const issues = validateActionDescriptor(value);
  if (issues.length) {
    const error = new TypeError(`ActionDescriptor 无效: ${issues.map((entry) => `${entry.path || "/"} ${entry.message}`).join("; ")}`);
    error.code = "DESCRIPTOR_INVALID";
    error.issues = issues;
    throw error;
  }
}

function actualType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validateValue(schema, value) {
  const issues = [];
  validateSchemaShape(schema, "", issues);
  if (issues.length) return issues;

  const walk = (currentSchema, current, path) => {
    const allowedTypes = Array.isArray(currentSchema.type) ? currentSchema.type : [currentSchema.type];
    const type = actualType(current);
    const compatible = allowedTypes.includes(type) || (type === "integer" && allowedTypes.includes("number"));
    if (!compatible) {
      issue(issues, path, `期望 ${allowedTypes.join("|")}，实际 ${type}`);
      return;
    }
    if (currentSchema.const !== undefined && !deepEqual(current, currentSchema.const)) issue(issues, path, "不等于 const");
    if (currentSchema.enum && !currentSchema.enum.some((entry) => deepEqual(entry, current))) issue(issues, path, "不在 enum 中");
    if (typeof current === "string") {
      if (currentSchema.minLength !== undefined && current.length < currentSchema.minLength) issue(issues, path, `长度小于 ${currentSchema.minLength}`);
      if (currentSchema.maxLength !== undefined && current.length > currentSchema.maxLength) issue(issues, path, `长度大于 ${currentSchema.maxLength}`);
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) issue(issues, path, "必须是有限数字");
      if (currentSchema.minimum !== undefined && current < currentSchema.minimum) issue(issues, path, `小于 ${currentSchema.minimum}`);
      if (currentSchema.maximum !== undefined && current > currentSchema.maximum) issue(issues, path, `大于 ${currentSchema.maximum}`);
    }
    if (Array.isArray(current)) {
      if (currentSchema.minItems !== undefined && current.length < currentSchema.minItems) issue(issues, path, `少于 ${currentSchema.minItems} 项`);
      if (currentSchema.maxItems !== undefined && current.length > currentSchema.maxItems) issue(issues, path, `多于 ${currentSchema.maxItems} 项`);
      if (currentSchema.uniqueItems && new Set(current.map((entry) => JSON.stringify(entry))).size !== current.length) issue(issues, path, "不允许重复项");
      current.forEach((entry, index) => walk(currentSchema.items, entry, `${path}/${index}`));
    }
    if (isObject(current)) {
      for (const required of currentSchema.required ?? []) {
        if (!Object.hasOwn(current, required)) issue(issues, `${path}/${required}`, "缺少必填字段");
      }
      for (const [name, entry] of Object.entries(current)) {
        if (!Object.hasOwn(currentSchema.properties, name)) issue(issues, `${path}/${name}`, "未知字段被拒绝");
        else walk(currentSchema.properties[name], entry, `${path}/${name}`);
      }
    }
  };
  walk(schema, value, "");
  return issues;
}

export function utf8JsonBytes(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("值不是可序列化 JSON");
  return Buffer.byteLength(serialized, "utf8");
}
