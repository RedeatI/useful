export const EXECUTION_RECEIPT_VERSION = "2.0";
export const EXECUTION_RECEIPT_MAX_BYTES = 65536;
export const EXECUTION_RECEIPT_STATUSES = /* @__PURE__ */ Object.freeze(["queued", "running", "success", "error", "cancelled"]);

const STATUS_SET = /* @__PURE__ */ new Set(EXECUTION_RECEIPT_STATUSES);
const TERMINAL_STATUSES = /* @__PURE__ */ new Set(["success", "error", "cancelled"]);
const SOURCE_KINDS = /* @__PURE__ */ new Set(["builtin", "plugin", "local"]);
const SHA256 = /^[a-f0-9]{64}$/;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const ACTION_ID = /^[a-z][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)+$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ABSOLUTE_PATH = /^(?:\/|\\\\|[A-Za-z]:[\\/])/;

const V2_KEYS = /* @__PURE__ */ Object.freeze([
  "receiptVersion", "actionId", "actionVersion", "contractVersion", "source", "permissions",
  "status", "createdAt", "startedAt", "completedAt", "durationMs", "error",
]);
const V1_KEYS = /* @__PURE__ */ Object.freeze([
  "receiptVersion", "actionId", "actionVersion", "contractVersion", "source", "permissions",
  "startedAt", "durationMs", "status", "error",
]);

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const add = (issues, path, message) => issues.push({ path, message });

function exactObject(value, required, allowed, path, issues) {
  if (!isObject(value)) {
    add(issues, path, "必须是对象");
    return false;
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) add(issues, `${path}/${key}`, "缺少必填字段");
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) add(issues, `${path}/${key}`, "未知字段被拒绝");
  }
  return true;
}

function boundedString(value, path, issues, { maximum = 256, pattern, allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > maximum) {
    add(issues, path, `必须是${allowEmpty ? "" : "非空"}且不超过 ${maximum} 字符的字符串`);
    return;
  }
  if (ABSOLUTE_PATH.test(value)) add(issues, path, "不得包含绝对路径");
  if (pattern && !pattern.test(value)) add(issues, path, "格式非法");
}

function stringSet(value, path, issues) {
  if (!Array.isArray(value)) {
    add(issues, path, "必须是字符串数组");
    return;
  }
  if (value.length > 128) add(issues, path, "最多 128 项");
  const seen = new Set();
  value.forEach((entry, index) => {
    boundedString(entry, `${path}/${index}`, issues);
    if (seen.has(entry)) add(issues, `${path}/${index}`, "不允许重复项");
    seen.add(entry);
  });
}

function timestamp(value, path, issues) {
  if (typeof value !== "string" || !UTC_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
    add(issues, path, "必须是带毫秒的 UTC ISO-8601 时间");
  }
}

function validateSource(value, path, issues) {
  if (!exactObject(value, ["kind", "toolId", "publisher", "digest"], ["kind", "toolId", "publisher", "digest"], path, issues)) return;
  if (!SOURCE_KINDS.has(value.kind)) add(issues, `${path}/kind`, "source.kind 非法");
  boundedString(value.toolId, `${path}/toolId`, issues);
  boundedString(value.digest, `${path}/digest`, issues, { maximum: 64, pattern: SHA256 });
  if (exactObject(value.publisher, ["id"], ["id", "name"], `${path}/publisher`, issues)) {
    boundedString(value.publisher.id, `${path}/publisher/id`, issues);
    if (value.publisher.name !== undefined) boundedString(value.publisher.name, `${path}/publisher/name`, issues);
  }
}

function validatePermissions(value, path, issues) {
  if (!exactObject(value, ["required", "capabilities"], ["required", "capabilities"], path, issues)) return;
  stringSet(value.required, `${path}/required`, issues);
  stringSet(value.capabilities, `${path}/capabilities`, issues);
}

function validateError(value, path, issues) {
  if (!exactObject(value, ["code"], ["code"], path, issues)) return;
  boundedString(value.code, `${path}/code`, issues, { maximum: 64, pattern: ERROR_CODE });
}

export function validateExecutionReceipt(value) {
  const issues = [];
  if (!exactObject(value, [
    "receiptVersion", "actionId", "actionVersion", "contractVersion", "source", "permissions", "status", "createdAt",
  ], V2_KEYS, "", issues)) return issues;

  if (value.receiptVersion !== EXECUTION_RECEIPT_VERSION) add(issues, "/receiptVersion", "只支持 2.0 canonical receipt");
  boundedString(value.actionId, "/actionId", issues, { maximum: 200, pattern: ACTION_ID });
  boundedString(value.actionVersion, "/actionVersion", issues, { maximum: 128, pattern: SEMVER });
  boundedString(value.contractVersion, "/contractVersion", issues, { maximum: 32 });
  validateSource(value.source, "/source", issues);
  validatePermissions(value.permissions, "/permissions", issues);
  if (!STATUS_SET.has(value.status)) add(issues, "/status", "status 非法");
  timestamp(value.createdAt, "/createdAt", issues);
  if (value.startedAt !== undefined) timestamp(value.startedAt, "/startedAt", issues);
  if (value.completedAt !== undefined) timestamp(value.completedAt, "/completedAt", issues);
  if (value.durationMs !== undefined && (!Number.isInteger(value.durationMs) || value.durationMs < 0 || !Number.isSafeInteger(value.durationMs))) {
    add(issues, "/durationMs", "必须是非负安全整数");
  }
  if (value.error !== undefined) validateError(value.error, "/error", issues);

  if (value.status === "queued") {
    for (const key of ["startedAt", "completedAt", "durationMs", "error"]) {
      if (value[key] !== undefined) add(issues, `/${key}`, "queued receipt 不得包含此字段");
    }
  } else if (value.status === "running") {
    if (value.startedAt === undefined) add(issues, "/startedAt", "running receipt 必须包含 startedAt");
    for (const key of ["completedAt", "durationMs", "error"]) {
      if (value[key] !== undefined) add(issues, `/${key}`, "running receipt 不得包含此字段");
    }
  } else if (TERMINAL_STATUSES.has(value.status)) {
    for (const key of ["startedAt", "completedAt", "durationMs"]) {
      if (value[key] === undefined) add(issues, `/${key}`, "terminal receipt 必须包含此字段");
    }
    if (value.status === "success" && value.error !== undefined) add(issues, "/error", "success receipt 不得包含 error");
    if (["error", "cancelled"].includes(value.status) && value.error === undefined) add(issues, "/error", "失败 receipt 必须包含 error code");
    if (value.status === "cancelled" && value.error?.code !== "CANCELLED") add(issues, "/error/code", "cancelled receipt 必须使用 CANCELLED");
    if (value.status === "error" && value.error?.code === "CANCELLED") add(issues, "/error/code", "CANCELLED 必须映射为 cancelled status");
  }

  const created = Date.parse(value.createdAt);
  const started = Date.parse(value.startedAt);
  const completed = Date.parse(value.completedAt);
  if (Number.isFinite(created) && Number.isFinite(started) && started < created) add(issues, "/startedAt", "不得早于 createdAt");
  if (Number.isFinite(started) && Number.isFinite(completed) && completed < started) add(issues, "/completedAt", "不得早于 startedAt");
  return issues;
}

const SAFE_MESSAGES = /* @__PURE__ */ Object.freeze({
  RECEIPT_INVALID: "execution receipt 无效",
  RECEIPT_TOO_LARGE: "execution receipt 超过上限",
  RECEIPT_VERSION_UNSUPPORTED: "execution receipt 版本不受支持",
});

export class ExecutionReceiptError extends Error {
  constructor(code, issues = []) {
    super(SAFE_MESSAGES[code] ?? SAFE_MESSAGES.RECEIPT_INVALID);
    this.name = "ExecutionReceiptError";
    this.code = code;
    this.issues = issues;
  }
}

export function assertExecutionReceipt(value) {
  const issues = validateExecutionReceipt(value);
  if (issues.length) throw new ExecutionReceiptError("RECEIPT_INVALID", issues);
}

function validateV1(value) {
  const issues = [];
  if (!exactObject(value, [
    "receiptVersion", "actionId", "actionVersion", "contractVersion", "source", "permissions", "startedAt", "durationMs", "status",
  ], V1_KEYS, "", issues)) return issues;
  boundedString(value.actionId, "/actionId", issues, { maximum: 200, pattern: ACTION_ID });
  boundedString(value.actionVersion, "/actionVersion", issues, { maximum: 128, pattern: SEMVER });
  boundedString(value.contractVersion, "/contractVersion", issues, { maximum: 32 });
  validateSource(value.source, "/source", issues);
  stringSet(value.permissions, "/permissions", issues);
  timestamp(value.startedAt, "/startedAt", issues);
  if (!Number.isInteger(value.durationMs) || value.durationMs < 0 || !Number.isSafeInteger(value.durationMs)) add(issues, "/durationMs", "必须是非负安全整数");
  if (!TERMINAL_STATUSES.has(value.status)) add(issues, "/status", "v1 只接受 terminal status");
  if (value.error !== undefined) validateError(value.error, "/error", issues);
  if (value.status === "success" && value.error !== undefined) add(issues, "/error", "success receipt 不得包含 error");
  if (["error", "cancelled"].includes(value.status) && value.error === undefined) add(issues, "/error", "失败 receipt 必须包含 error code");
  if (value.status === "cancelled" && value.error?.code !== "CANCELLED") add(issues, "/error/code", "cancelled receipt 必须使用 CANCELLED");
  return issues;
}

export function upgradeExecutionReceipt(value) {
  if (!isObject(value)) throw new ExecutionReceiptError("RECEIPT_INVALID");
  if (value.receiptVersion === EXECUTION_RECEIPT_VERSION) {
    assertExecutionReceipt(value);
    return structuredClone(value);
  }
  if (value.receiptVersion !== "1.0") {
    throw new ExecutionReceiptError(typeof value.receiptVersion === "string" ? "RECEIPT_VERSION_UNSUPPORTED" : "RECEIPT_INVALID");
  }
  const issues = validateV1(value);
  if (issues.length) throw new ExecutionReceiptError("RECEIPT_INVALID", issues);
  const completedEpochMs = Date.parse(value.startedAt) + value.durationMs;
  if (!Number.isFinite(completedEpochMs) || Math.abs(completedEpochMs) > 8640000000000000) {
    throw new ExecutionReceiptError("RECEIPT_INVALID");
  }
  const completedAt = new Date(completedEpochMs).toISOString();
  const upgraded = {
    receiptVersion: EXECUTION_RECEIPT_VERSION,
    actionId: value.actionId,
    actionVersion: value.actionVersion,
    contractVersion: value.contractVersion,
    source: structuredClone(value.source),
    permissions: { required: [...value.permissions], capabilities: [] },
    status: value.status,
    createdAt: value.startedAt,
    startedAt: value.startedAt,
    completedAt,
    durationMs: value.durationMs,
    ...(value.error ? { error: structuredClone(value.error) } : {}),
  };
  assertExecutionReceipt(upgraded);
  return upgraded;
}

function serializedBytes(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new ExecutionReceiptError("RECEIPT_INVALID");
  return { serialized, bytes: Buffer.byteLength(serialized, "utf8") };
}

export function parseExecutionReceipt(value, options = {}) {
  const maxBytes = options.maxBytes ?? EXECUTION_RECEIPT_MAX_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > EXECUTION_RECEIPT_MAX_BYTES) {
    throw new TypeError("maxBytes 必须在 1..65536 范围内");
  }
  let parsed = value;
  if (typeof value === "string" || value instanceof Uint8Array) {
    const bytes = typeof value === "string" ? Buffer.byteLength(value, "utf8") : value.byteLength;
    if (bytes > maxBytes) throw new ExecutionReceiptError("RECEIPT_TOO_LARGE");
    try {
      parsed = JSON.parse(typeof value === "string" ? value : Buffer.from(value).toString("utf8"));
    } catch {
      throw new ExecutionReceiptError("RECEIPT_INVALID");
    }
  } else {
    let measured;
    try {
      measured = serializedBytes(value);
    } catch (error) {
      if (error instanceof ExecutionReceiptError) throw error;
      throw new ExecutionReceiptError("RECEIPT_INVALID");
    }
    if (measured.bytes > maxBytes) throw new ExecutionReceiptError("RECEIPT_TOO_LARGE");
    try {
      parsed = JSON.parse(measured.serialized);
    } catch {
      throw new ExecutionReceiptError("RECEIPT_INVALID");
    }
  }
  return upgradeExecutionReceipt(parsed);
}
