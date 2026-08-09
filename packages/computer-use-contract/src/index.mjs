export const COMPUTER_USE_SCHEMA = "useful.computer-use.v1";

export const COMPUTER_USE_ENVIRONMENTS = Object.freeze([
  "isolated-browser",
  "isolated-vm",
]);

export const COMPUTER_USE_ACTION_TYPES = Object.freeze([
  "screenshot",
  "click",
  "double-click",
  "drag",
  "move",
  "scroll",
  "type",
  "key",
  "wait",
]);

export const COMPUTER_USE_ERROR_CODES = Object.freeze({
  DISABLED: "COMPUTER_USE_DISABLED",
  POLICY_INVALID: "COMPUTER_USE_POLICY_INVALID",
  HOST_DESKTOP_REJECTED: "COMPUTER_USE_HOST_DESKTOP_REJECTED",
  PROVIDER_INVALID: "COMPUTER_USE_PROVIDER_INVALID",
  PROVIDER_PROTOCOL_ERROR: "COMPUTER_USE_PROVIDER_PROTOCOL_ERROR",
  SESSION_NOT_FOUND: "COMPUTER_USE_SESSION_NOT_FOUND",
  SESSION_CLOSED: "COMPUTER_USE_SESSION_CLOSED",
  SESSION_POISONED: "COMPUTER_USE_SESSION_POISONED",
  SESSION_EXPIRED: "COMPUTER_USE_SESSION_EXPIRED",
  OBSERVATION_REQUIRED: "COMPUTER_USE_OBSERVATION_REQUIRED",
  OBSERVATION_STALE: "COMPUTER_USE_OBSERVATION_STALE",
  STEP_INVALID: "COMPUTER_USE_STEP_INVALID",
  STEP_REPLAYED: "COMPUTER_USE_STEP_REPLAYED",
  STEP_LIMIT_EXCEEDED: "COMPUTER_USE_STEP_LIMIT_EXCEEDED",
  CONCURRENT_ACTION: "COMPUTER_USE_CONCURRENT_ACTION",
  ACTION_INVALID: "COMPUTER_USE_ACTION_INVALID",
  SCREENSHOT_TOO_LARGE: "COMPUTER_USE_SCREENSHOT_TOO_LARGE",
  DOMAIN_NOT_ALLOWED: "COMPUTER_USE_DOMAIN_NOT_ALLOWED",
  PRIVATE_DOMAIN_REJECTED: "COMPUTER_USE_PRIVATE_DOMAIN_REJECTED",
  NETWORK_EVIDENCE_REQUIRED: "COMPUTER_USE_NETWORK_EVIDENCE_REQUIRED",
  NETWORK_ADDRESS_REJECTED: "COMPUTER_USE_NETWORK_ADDRESS_REJECTED",
  REDIRECT_LIMIT_EXCEEDED: "COMPUTER_USE_REDIRECT_LIMIT_EXCEEDED",
  APPROVAL_REQUIRED: "COMPUTER_USE_APPROVAL_REQUIRED",
  APPROVAL_DENIED: "COMPUTER_USE_APPROVAL_DENIED",
  SAFETY_CHECK_INVALID: "COMPUTER_USE_SAFETY_CHECK_INVALID",
  CANCELLED: "COMPUTER_USE_CANCELLED",
  STEP_DEADLINE_EXCEEDED: "COMPUTER_USE_STEP_DEADLINE_EXCEEDED",
  TOTAL_DEADLINE_EXCEEDED: "COMPUTER_USE_TOTAL_DEADLINE_EXCEEDED",
  AUDIT_FAILED: "COMPUTER_USE_AUDIT_FAILED",
});

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ENVIRONMENT_SET = new Set(COMPUTER_USE_ENVIRONMENTS);
const ACTION_TYPE_SET = new Set(COMPUTER_USE_ACTION_TYPES);
const HIGH_IMPACT_ACTIONS = new Set(["click", "double-click", "drag", "type", "key"]);
const ACTION_FIELDS = Object.freeze({
  screenshot: ["type"],
  click: ["type", "x", "y", "button"],
  "double-click": ["type", "x", "y", "button"],
  drag: ["type", "startX", "startY", "endX", "endY", "durationMs"],
  move: ["type", "x", "y"],
  scroll: ["type", "deltaX", "deltaY", "x", "y"],
  type: ["type", "text"],
  key: ["type", "keys"],
  wait: ["type", "durationMs"],
});

const isSafeId = (value) => typeof value === "string" && SAFE_ID.test(value);

const DEFAULT_POLICY_VALUE = {
  schemaVersion: COMPUTER_USE_SCHEMA,
  environment: "isolated-browser",
  maxSteps: 25,
  stepDeadlineMs: 30_000,
  totalDeadlineMs: 300_000,
  maxScreenshotBytes: 10 * 1024 * 1024,
  allowDomains: [],
  maxRedirects: 0,
  developmentMode: false,
  allowPrivateDomains: false,
};

export const DEFAULT_COMPUTER_USE_POLICY = deepFreeze(structuredClone(DEFAULT_POLICY_VALUE));

export class ComputerUseError extends Error {
  constructor(code, message = code, options = {}) {
    super(message, options);
    this.name = "ComputerUseError";
    this.code = code;
  }
}

function fail(code, message = code, options) {
  throw new ComputerUseError(code, message, options);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertKnownKeys(value, allowed, code, label) {
  if (!isObject(value)) fail(code, `${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(code, `${label} contains an unknown field`);
  }
}

function assertInteger(value, minimum, maximum, code, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail(code, `${label} must be an integer in ${minimum}..${maximum}`);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function canonicalHostname(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 253 || value.trim() !== value) {
    fail(COMPUTER_USE_ERROR_CODES.POLICY_INVALID, "allowDomains entries must be canonical host names");
  }
  if (value.includes("://") || /[/?#@]/u.test(value)) {
    fail(COMPUTER_USE_ERROR_CODES.POLICY_INVALID, "allowDomains entries must not contain a scheme, path, query, fragment, or credentials");
  }
  let hostname;
  try {
    hostname = new URL(`https://${value}`).hostname.toLowerCase().replace(/\.$/u, "");
  } catch {
    fail(COMPUTER_USE_ERROR_CODES.POLICY_INVALID, "allowDomains contains an invalid host name");
  }
  const source = value.toLowerCase().replace(/\.$/u, "");
  if (!hostname || (hostname !== source && !source.includes("["))) {
    fail(COMPUTER_USE_ERROR_CODES.POLICY_INVALID, "allowDomains entries must already be normalized ASCII host names");
  }
  return hostname;
}

function parseIpv4(hostname) {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/u.test(part) || (part.length > 1 && part.startsWith("0")))) return null;
  const numbers = parts.map(Number);
  if (numbers.some((part) => part > 255)) return null;
  return numbers;
}

function isRejectedIpv4(parts) {
  const [a, b, c] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function parseIpv6(value) {
  let input = value.toLowerCase().replace(/^\[|\]$/gu, "");
  if (!input.includes(":") || input.includes("%") || input.split("::").length > 2) return null;
  const embedded = input.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/u)?.[1];
  if (embedded) {
    const ipv4 = parseIpv4(embedded);
    if (!ipv4) return null;
    input = `${input.slice(0, -embedded.length)}${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }
  const [leftText, rightText] = input.split("::");
  const left = leftText ? leftText.split(":") : [];
  const right = rightText ? rightText.split(":") : [];
  if ([...left, ...right].some((part) => !/^[a-f0-9]{1,4}$/u.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if ((input.includes("::") && missing < 1) || (!input.includes("::") && missing !== 0)) return null;
  const groups = [...left, ...Array(Math.max(0, missing)).fill("0"), ...right].map((part) => Number.parseInt(part, 16));
  if (groups.length !== 8) return null;
  return groups.flatMap((group) => [group >> 8, group & 0xff]);
}

function isRejectedIpv6(bytes) {
  if (bytes.every((byte) => byte === 0)) return true;
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return true;
  if ((bytes[0] & 0xfe) === 0xfc) return true;
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0xc0) return true;
  if (bytes[0] === 0xff) return true;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true;
  const mapped = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  const compatible = bytes.slice(0, 12).every((byte) => byte === 0);
  return mapped || compatible;
}

function isPrivateOrLocalHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const ipv6 = parseIpv6(host);
  if (ipv6) return isRejectedIpv6(ipv6);
  const ip = parseIpv4(host);
  if (!ip) return !host.includes(".");
  return isRejectedIpv4(ip);
}

export function normalizeComputerUsePolicy(policy = {}) {
  assertKnownKeys(policy, Object.keys(DEFAULT_POLICY_VALUE), COMPUTER_USE_ERROR_CODES.POLICY_INVALID, "policy");
  const normalized = { ...DEFAULT_POLICY_VALUE, ...policy };
  if (normalized.environment === "host-desktop") {
    fail(COMPUTER_USE_ERROR_CODES.HOST_DESKTOP_REJECTED, "host-desktop is outside the Computer Use v1 trust boundary");
  }
  if (!ENVIRONMENT_SET.has(normalized.environment)) {
    fail(COMPUTER_USE_ERROR_CODES.POLICY_INVALID, "environment must be isolated-browser or isolated-vm");
  }
  if (normalized.schemaVersion !== COMPUTER_USE_SCHEMA) {
    fail(COMPUTER_USE_ERROR_CODES.POLICY_INVALID, `schemaVersion must be ${COMPUTER_USE_SCHEMA}`);
  }
  assertInteger(normalized.maxSteps, 1, 10_000, COMPUTER_USE_ERROR_CODES.POLICY_INVALID, "maxSteps");
  assertInteger(normalized.stepDeadlineMs, 1, 3_600_000, COMPUTER_USE_ERROR_CODES.POLICY_INVALID, "stepDeadlineMs");
  assertInteger(normalized.totalDeadlineMs, 1, 86_400_000, COMPUTER_USE_ERROR_CODES.POLICY_INVALID, "totalDeadlineMs");
  if (normalized.totalDeadlineMs < normalized.stepDeadlineMs) {
    fail(COMPUTER_USE_ERROR_CODES.POLICY_INVALID, "totalDeadlineMs must be at least stepDeadlineMs");
  }
  assertInteger(normalized.maxScreenshotBytes, 1, 64 * 1024 * 1024, COMPUTER_USE_ERROR_CODES.POLICY_INVALID, "maxScreenshotBytes");
  assertInteger(normalized.maxRedirects, 0, 20, COMPUTER_USE_ERROR_CODES.POLICY_INVALID, "maxRedirects");
  if (typeof normalized.developmentMode !== "boolean" || typeof normalized.allowPrivateDomains !== "boolean") {
    fail(COMPUTER_USE_ERROR_CODES.POLICY_INVALID, "developmentMode and allowPrivateDomains must be booleans");
  }
  if (normalized.allowPrivateDomains && !normalized.developmentMode) {
    fail(COMPUTER_USE_ERROR_CODES.POLICY_INVALID, "private domains require both developmentMode and allowPrivateDomains");
  }
  if (!Array.isArray(normalized.allowDomains) || normalized.allowDomains.length > 256) {
    fail(COMPUTER_USE_ERROR_CODES.POLICY_INVALID, "allowDomains must be an array with at most 256 entries");
  }
  const domains = normalized.allowDomains.map(canonicalHostname);
  if (new Set(domains).size !== domains.length) {
    fail(COMPUTER_USE_ERROR_CODES.POLICY_INVALID, "allowDomains must not contain duplicates");
  }
  if (!(normalized.developmentMode && normalized.allowPrivateDomains)) {
    for (const domain of domains) {
      if (isPrivateOrLocalHost(domain)) {
        fail(COMPUTER_USE_ERROR_CODES.PRIVATE_DOMAIN_REJECTED, "private, local, and single-label hosts are rejected by default");
      }
    }
  }
  normalized.allowDomains = domains.sort();
  return deepFreeze(normalized);
}

function inspectAllowedUrl(rawUrl, policy) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    fail(COMPUTER_USE_ERROR_CODES.DOMAIN_NOT_ALLOWED, "provider returned an invalid URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    fail(COMPUTER_USE_ERROR_CODES.DOMAIN_NOT_ALLOWED, "only credential-free HTTP(S) URLs are allowed");
  }
  const domain = parsed.hostname.toLowerCase().replace(/\.$/u, "");
  if (isPrivateOrLocalHost(domain) && !(policy.developmentMode && policy.allowPrivateDomains)) {
    fail(COMPUTER_USE_ERROR_CODES.PRIVATE_DOMAIN_REJECTED, "private and local destinations are rejected");
  }
  if (!policy.allowDomains.includes(domain)) {
    fail(COMPUTER_USE_ERROR_CODES.DOMAIN_NOT_ALLOWED, "destination is not in allowDomains");
  }
  return domain;
}

function assertReportedIp(value, policy) {
  if (typeof value !== "string" || value.length < 2 || value.length > 64 || value.trim() !== value) {
    fail(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, "resolvedIps must contain IP literals");
  }
  const ipv4 = parseIpv4(value);
  const ipv6 = parseIpv6(value);
  if (!ipv4 && !ipv6) fail(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, "resolvedIps must contain valid IP literals");
  if (!(policy.developmentMode && policy.allowPrivateDomains)
    && (ipv4 ? isRejectedIpv4(ipv4) : isRejectedIpv6(ipv6))) {
    fail(COMPUTER_USE_ERROR_CODES.NETWORK_ADDRESS_REJECTED, "reported destination address is private, local, reserved, multicast, or metadata-reachable");
  }
}

function validateNetworkEvidence(value, policy) {
  const evidence = value.networkEvidence;
  if (policy.allowDomains.length === 0) {
    if (evidence !== undefined || value.url !== undefined || value.redirects !== undefined || value.finalUrl !== undefined) {
      fail(COMPUTER_USE_ERROR_CODES.DOMAIN_NOT_ALLOWED, "network output is forbidden while allowDomains is empty");
    }
    return undefined;
  }
  if (!isObject(evidence) || evidence.complete !== true || !Array.isArray(evidence.hops) || evidence.hops.length < 1) {
    fail(COMPUTER_USE_ERROR_CODES.NETWORK_EVIDENCE_REQUIRED, "complete network hop evidence is required when networking is enabled");
  }
  assertKnownKeys(evidence, ["complete", "hops"], COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, "networkEvidence");
  if (evidence.hops.length - 1 > policy.maxRedirects) fail(COMPUTER_USE_ERROR_CODES.REDIRECT_LIMIT_EXCEEDED, "provider exceeded maxRedirects");
  let domain;
  for (const hop of evidence.hops) {
    assertKnownKeys(hop, ["url", "resolvedIps"], COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, "network hop");
    domain = inspectAllowedUrl(hop.url, policy);
    if (!Array.isArray(hop.resolvedIps) || hop.resolvedIps.length < 1 || hop.resolvedIps.length > 16) {
      fail(COMPUTER_USE_ERROR_CODES.NETWORK_EVIDENCE_REQUIRED, "every network hop requires 1..16 resolved IP addresses");
    }
    for (const address of hop.resolvedIps) assertReportedIp(address, policy);
  }
  return { domain, url: evidence.hops.at(-1).url };
}

function screenshotLength(value) {
  if (value === undefined) return 0;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  fail(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, "screenshot must be an ArrayBuffer or typed-array view");
}

function assertCoordinate(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 100_000) {
    fail(COMPUTER_USE_ERROR_CODES.ACTION_INVALID, `${label} must be an integer in 0..100000`);
  }
}

export function assertComputerUseAction(action) {
  if (!isObject(action) || !ACTION_TYPE_SET.has(action.type)) {
    fail(COMPUTER_USE_ERROR_CODES.ACTION_INVALID, "action.type is not supported");
  }
  assertKnownKeys(action, ACTION_FIELDS[action.type], COMPUTER_USE_ERROR_CODES.ACTION_INVALID, "action");
  if (Object.values(action).some((value) => value === undefined)) {
    fail(COMPUTER_USE_ERROR_CODES.ACTION_INVALID, "present action fields must not be undefined");
  }
  switch (action.type) {
    case "click":
    case "double-click":
      assertCoordinate(action.x, "x");
      assertCoordinate(action.y, "y");
      if (action.button !== undefined && !["left", "middle", "right"].includes(action.button)) {
        fail(COMPUTER_USE_ERROR_CODES.ACTION_INVALID, "button must be left, middle, or right");
      }
      break;
    case "drag":
      for (const key of ["startX", "startY", "endX", "endY"]) assertCoordinate(action[key], key);
      if (action.durationMs !== undefined) assertInteger(action.durationMs, 0, 30_000, COMPUTER_USE_ERROR_CODES.ACTION_INVALID, "durationMs");
      break;
    case "move":
      assertCoordinate(action.x, "x");
      assertCoordinate(action.y, "y");
      break;
    case "scroll":
      for (const key of ["deltaX", "deltaY"]) {
        if (!Number.isInteger(action[key]) || Math.abs(action[key]) > 100_000) fail(COMPUTER_USE_ERROR_CODES.ACTION_INVALID, `${key} is out of range`);
      }
      if (action.x !== undefined) assertCoordinate(action.x, "x");
      if (action.y !== undefined) assertCoordinate(action.y, "y");
      break;
    case "type":
      if (typeof action.text !== "string" || action.text.length < 1 || action.text.length > 32_768) {
        fail(COMPUTER_USE_ERROR_CODES.ACTION_INVALID, "text must contain 1..32768 characters");
      }
      break;
    case "key":
      if (!Array.isArray(action.keys) || action.keys.length < 1 || action.keys.length > 16
        || action.keys.some((key) => !isSafeId(key))) {
        fail(COMPUTER_USE_ERROR_CODES.ACTION_INVALID, "keys must contain 1..16 safe key identifiers");
      }
      break;
    case "wait":
      assertInteger(action.durationMs, 0, 30_000, COMPUTER_USE_ERROR_CODES.ACTION_INVALID, "durationMs");
      break;
    default:
      break;
  }
  return action;
}

function validateSafetyChecks(checks, source) {
  if (checks === undefined) return [];
  if (!Array.isArray(checks) || checks.length > 64) {
    fail(COMPUTER_USE_ERROR_CODES.SAFETY_CHECK_INVALID, "safetyChecks must contain at most 64 entries");
  }
  const seen = new Set();
  return checks.map((check) => {
    assertKnownKeys(check, ["id", "description", "severity"], COMPUTER_USE_ERROR_CODES.SAFETY_CHECK_INVALID, "safetyCheck");
    if (!isSafeId(check.id) || typeof check.description !== "string" || check.description.length < 1 || check.description.length > 1_024
      || !["low", "medium", "high"].includes(check.severity)) {
      fail(COMPUTER_USE_ERROR_CODES.SAFETY_CHECK_INVALID, "safetyCheck is invalid");
    }
    const unique = `${source}:${check.id}`;
    if (seen.has(unique)) fail(COMPUTER_USE_ERROR_CODES.SAFETY_CHECK_INVALID, "duplicate safetyCheck id");
    seen.add(unique);
    return Object.freeze({ ...check, source });
  });
}

function actionCoordinates(action) {
  switch (action.type) {
    case "click":
    case "double-click":
    case "move": return { x: action.x, y: action.y };
    case "drag": return { startX: action.startX, startY: action.startY, endX: action.endX, endY: action.endY };
    case "scroll": return { ...(action.x === undefined ? {} : { x: action.x }), ...(action.y === undefined ? {} : { y: action.y }), deltaX: action.deltaX, deltaY: action.deltaY };
    default: return undefined;
  }
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

async function digestAction(action) {
  if (!globalThis.crypto?.subtle) fail(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, "Web Crypto is required for canonical action binding");
  const bytes = new TextEncoder().encode(canonicalJson(action));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertSafeId(value, label) {
  if (!isSafeId(value)) {
    fail(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, `${label} must be a safe identifier`);
  }
  return value;
}

function assertAuditMetadata(event) {
  for (const [key, value] of Object.entries(event)) {
    if (key.endsWith("Id") && value !== undefined) assertSafeId(value, key);
  }
  if (!isSafeId(event.resultCode)) fail(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, "audit resultCode must be a safe identifier");
  if (event.observationDigest !== undefined && !SHA256.test(event.observationDigest)) fail(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, "audit observationDigest is invalid");
  if (event.actionDigest !== undefined && !SHA256.test(event.actionDigest)) fail(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, "audit actionDigest is invalid");
  if (event.safetyCheckIds !== undefined
    && (!Array.isArray(event.safetyCheckIds) || event.safetyCheckIds.some((id) => !isSafeId(id)))) {
    fail(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, "audit safetyCheckIds are invalid");
  }
  if (event.approvalIds !== undefined
    && (!Array.isArray(event.approvalIds) || event.approvalIds.some((id) => !isSafeId(id)))) {
    fail(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, "audit approvalIds are invalid");
  }
}

function remainingTotal(state, now) {
  return state.expiresAt - now();
}

async function runBounded(operation, { signal, timeoutMs, timeoutCode }) {
  if (signal?.aborted) fail(COMPUTER_USE_ERROR_CODES.CANCELLED, "operation was cancelled");
  const controller = new AbortController();
  let timeout;
  let rejectAbort;
  const abortPromise = new Promise((_, reject) => { rejectAbort = reject; });
  const onExternalAbort = () => {
    controller.abort(signal.reason ?? COMPUTER_USE_ERROR_CODES.CANCELLED);
    rejectAbort(new ComputerUseError(COMPUTER_USE_ERROR_CODES.CANCELLED, "operation was cancelled"));
  };
  signal?.addEventListener("abort", onExternalAbort, { once: true });
  timeout = setTimeout(() => {
    controller.abort(timeoutCode);
    rejectAbort(new ComputerUseError(timeoutCode, "operation deadline exceeded"));
  }, timeoutMs);
  try {
    return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), abortPromise]);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

function boundedOptions(state, policy, now, signal) {
  const total = remainingTotal(state, now);
  if (total <= 0) fail(COMPUTER_USE_ERROR_CODES.SESSION_EXPIRED, "session total deadline has elapsed");
  return total <= policy.stepDeadlineMs
    ? { signal, timeoutMs: total, timeoutCode: COMPUTER_USE_ERROR_CODES.TOTAL_DEADLINE_EXCEEDED }
    : { signal, timeoutMs: policy.stepDeadlineMs, timeoutCode: COMPUTER_USE_ERROR_CODES.STEP_DEADLINE_EXCEEDED };
}

function assertProvider(provider) {
  if (!isObject(provider)) fail(COMPUTER_USE_ERROR_CODES.PROVIDER_INVALID, "provider must be an object");
  for (const method of ["createSession", "observe", "execute", "close"]) {
    if (typeof provider[method] !== "function") fail(COMPUTER_USE_ERROR_CODES.PROVIDER_INVALID, `provider.${method} is required`);
  }
}

function disabled() {
  return Promise.reject(new ComputerUseError(COMPUTER_USE_ERROR_CODES.DISABLED));
}

export const disabledComputerUseProvider = Object.freeze({
  createSession: disabled,
  observe: disabled,
  execute: disabled,
  close: disabled,
});

export function createComputerUseController(options = {}) {
  assertKnownKeys(options, ["provider", "policy", "approval", "audit", "clock", "idFactory"], COMPUTER_USE_ERROR_CODES.POLICY_INVALID, "controller options");
  const provider = options.provider ?? disabledComputerUseProvider;
  const policy = normalizeComputerUsePolicy(options.policy);
  const approval = options.approval;
  const audit = options.audit;
  const now = options.clock ?? Date.now;
  const idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
  assertProvider(provider);
  if (approval !== undefined && typeof approval !== "function") fail(COMPUTER_USE_ERROR_CODES.POLICY_INVALID, "approval must be a function");
  if (audit !== undefined && typeof audit !== "function") fail(COMPUTER_USE_ERROR_CODES.POLICY_INVALID, "audit must be a function");
  if (typeof now !== "function" || typeof idFactory !== "function") fail(COMPUTER_USE_ERROR_CODES.POLICY_INVALID, "clock and idFactory must be functions");
  const sessions = new Map();
  const closedSessions = new Map();

  const emit = async (event) => {
    if (!audit) return;
    assertAuditMetadata(event);
    const eventId = assertSafeId(String(idFactory()), "eventId");
    const safe = deepFreeze({
      schemaVersion: COMPUTER_USE_SCHEMA,
      eventId,
      timestamp: new Date(now()).toISOString(),
      ...event,
    });
    try {
      await audit(safe);
    } catch (error) {
      throw new ComputerUseError(COMPUTER_USE_ERROR_CODES.AUDIT_FAILED, "audit sink failed", { cause: error });
    }
  };

  const getSession = (sessionId) => {
    if (closedSessions.has(sessionId)) fail(COMPUTER_USE_ERROR_CODES.SESSION_CLOSED);
    const state = sessions.get(sessionId);
    if (!state) fail(COMPUTER_USE_ERROR_CODES.SESSION_NOT_FOUND);
    if (state.closed || state.closing) fail(COMPUTER_USE_ERROR_CODES.SESSION_CLOSED);
    if (state.poisoned) fail(COMPUTER_USE_ERROR_CODES.SESSION_POISONED);
    if (remainingTotal(state, now) <= 0) fail(COMPUTER_USE_ERROR_CODES.SESSION_EXPIRED);
    return state;
  };

  const assertCurrent = (state, generation, signal) => {
    if (signal.aborted) {
      const reason = isSafeId(signal.reason)
        ? signal.reason
        : COMPUTER_USE_ERROR_CODES.CANCELLED;
      fail(reason, "operation was aborted");
    }
    if (state.generation !== generation || state.closed || state.closing) fail(COMPUTER_USE_ERROR_CODES.SESSION_CLOSED);
    if (state.poisoned) fail(COMPUTER_USE_ERROR_CODES.SESSION_POISONED);
  };

  const startOperation = (state, kind, externalSignal, operation, onFinally = () => {}) => {
    if (state.operationPromise) fail(COMPUTER_USE_ERROR_CODES.CONCURRENT_ACTION, "session already has an active operation");
    if (externalSignal?.aborted) fail(COMPUTER_USE_ERROR_CODES.CANCELLED);
    const generation = state.generation;
    const operationController = new AbortController();
    const onExternalAbort = () => operationController.abort(externalSignal.reason ?? COMPUTER_USE_ERROR_CODES.CANCELLED);
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
    state.operationController = operationController;
    state.operationKind = kind;
    const bounded = runBounded(
      (boundedSignal) => operation(boundedSignal, generation),
      boundedOptions(state, policy, now, operationController.signal),
    );
    const tracked = bounded.finally(() => {
      externalSignal?.removeEventListener("abort", onExternalAbort);
      onFinally();
      if (state.operationController === operationController) {
        state.operationController = undefined;
        state.operationKind = undefined;
        state.operationPromise = undefined;
      }
    });
    state.operationPromise = tracked;
    return tracked;
  };

  const createSession = async ({ signal } = {}) => {
    const createdAt = now();
    const shell = { expiresAt: createdAt + policy.totalDeadlineMs };
    const handle = await runBounded(
      async (boundedSignal) => {
        const created = await provider.createSession({ schemaVersion: COMPUTER_USE_SCHEMA, environment: policy.environment, policy }, { signal: boundedSignal });
        if (boundedSignal.aborted) fail(COMPUTER_USE_ERROR_CODES.CANCELLED, "createSession completed after cancellation");
        return created;
      },
      boundedOptions(shell, policy, now, signal),
    );
    if (handle === null || handle === undefined) fail(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, "provider returned an empty session handle");
    const sessionId = String(idFactory());
    if (!isSafeId(sessionId) || sessions.has(sessionId) || closedSessions.has(sessionId)) fail(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, "idFactory returned an invalid or duplicate session id");
    const state = {
      sessionId,
      handle,
      createdAt,
      expiresAt: shell.expiresAt,
      nextStep: 1,
      latestDigest: undefined,
      latestDomain: undefined,
      usedSteps: new Set(),
      operationPromise: undefined,
      operationController: undefined,
      operationKind: undefined,
      generation: 1,
      poisoned: false,
      poisonReason: undefined,
      commitStarted: false,
      commitCompleted: false,
      closePromise: undefined,
      closing: false,
      closed: false,
    };
    sessions.set(sessionId, state);
    try {
      await runBounded(async (boundedSignal) => {
        await emit({ kind: "session-created", sessionId, resultCode: "CREATED" });
        if (boundedSignal.aborted) fail(COMPUTER_USE_ERROR_CODES.CANCELLED, "session audit completed after cancellation");
      }, boundedOptions(state, policy, now, signal));
    } catch (error) {
      state.poisoned = true;
      state.poisonReason = COMPUTER_USE_ERROR_CODES.AUDIT_FAILED;
      await close(sessionId, { reason: "audit-failed" }).catch(() => {});
      throw error;
    }
    return deepFreeze({ schemaVersion: COMPUTER_USE_SCHEMA, sessionId, environment: policy.environment, createdAt, expiresAt: state.expiresAt, nextStep: 1 });
  };

  const observe = async (sessionId, { signal } = {}) => {
    const state = getSession(sessionId);
    return startOperation(state, "observe", signal, async (boundedSignal, generation) => {
      const value = await provider.observe(state.handle, { signal: boundedSignal });
      assertCurrent(state, generation, boundedSignal);
      if (!isObject(value) || !SHA256.test(value.observationDigest)) {
        fail(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, "observationDigest must be lowercase SHA-256 hex");
      }
      const bytes = screenshotLength(value.screenshot);
      if (bytes > policy.maxScreenshotBytes) fail(COMPUTER_USE_ERROR_CODES.SCREENSHOT_TOO_LARGE);
      const network = validateNetworkEvidence(value, policy);
      assertCurrent(state, generation, boundedSignal);
      state.latestDigest = value.observationDigest;
      state.latestDomain = network?.domain;
      try {
        await emit({
          kind: "observation",
          sessionId,
          step: state.nextStep,
          observationDigest: value.observationDigest,
          screenshotBytes: bytes,
          ...(network?.domain ? { domain: network.domain } : {}),
          resultCode: "OBSERVED",
        });
      } catch (error) {
        state.latestDigest = undefined;
        state.latestDomain = undefined;
        throw error;
      }
      assertCurrent(state, generation, boundedSignal);
      return deepFreeze({
        schemaVersion: COMPUTER_USE_SCHEMA,
        sessionId,
        step: state.nextStep,
        observationDigest: value.observationDigest,
        screenshot: value.screenshot,
        screenshotBytes: bytes,
        ...(network?.url ? { url: network.url } : {}),
        ...(network?.domain ? { domain: network.domain } : {}),
      });
    });
  };

  const approveChecks = async (state, generation, request, preparedActionId, actionDigest, checks, boundedSignal) => {
    if (checks.length === 0) return [];
    if (!approval) fail(COMPUTER_USE_ERROR_CODES.APPROVAL_REQUIRED, "an explicit approval callback is required");
    const approvals = [];
    for (const check of checks) {
      const decision = await approval(deepFreeze({
        schemaVersion: COMPUTER_USE_SCHEMA,
        sessionId: state.sessionId,
        preparedActionId,
        step: request.step,
        observationDigest: request.observationDigest,
        actionDigest,
        actionType: request.action.type,
        action: request.action,
        domain: state.latestDomain,
        safetyCheck: check,
      }), { signal: boundedSignal });
      assertCurrent(state, generation, boundedSignal);
      if (!isObject(decision) || decision.approved !== true || !isSafeId(decision.approvalId)) {
        fail(COMPUTER_USE_ERROR_CODES.APPROVAL_DENIED, "safety check was not explicitly approved");
      }
      approvals.push(Object.freeze({
        safetyCheckId: check.id,
        source: check.source,
        approvalId: decision.approvalId,
        preparedActionId,
        step: request.step,
        observationDigest: request.observationDigest,
        actionDigest,
      }));
    }
    return approvals;
  };

  const execute = (sessionId, request, { signal } = {}) => {
    const state = getSession(sessionId);
    if (state.operationPromise) fail(COMPUTER_USE_ERROR_CODES.CONCURRENT_ACTION);
    if (signal?.aborted) fail(COMPUTER_USE_ERROR_CODES.CANCELLED);
    assertKnownKeys(request, ["step", "observationDigest", "action", "safetyChecks"], COMPUTER_USE_ERROR_CODES.ACTION_INVALID, "execute request");
    if (!Number.isInteger(request.step) || request.step < 1) fail(COMPUTER_USE_ERROR_CODES.STEP_INVALID);
    if (state.usedSteps.has(request.step) || request.step < state.nextStep) fail(COMPUTER_USE_ERROR_CODES.STEP_REPLAYED);
    if (request.step !== state.nextStep) fail(COMPUTER_USE_ERROR_CODES.STEP_INVALID, "step must equal nextStep");
    if (request.step > policy.maxSteps) fail(COMPUTER_USE_ERROR_CODES.STEP_LIMIT_EXCEEDED);
    if (!state.latestDigest) fail(COMPUTER_USE_ERROR_CODES.OBSERVATION_REQUIRED);
    if (request.observationDigest !== state.latestDigest) fail(COMPUTER_USE_ERROR_CODES.OBSERVATION_STALE);
    assertComputerUseAction(request.action);
    const action = deepFreeze(structuredClone(request.action));
    const safeRequest = Object.freeze({ step: request.step, observationDigest: request.observationDigest, action });
    const modelChecks = validateSafetyChecks(request.safetyChecks, "model");
    state.usedSteps.add(request.step);
    state.latestDigest = undefined;
    state.commitStarted = false;
    state.commitCompleted = false;

    const operation = startOperation(state, "execute", signal, async (boundedSignal, generation) => {
      const actionDigest = await digestAction(action);
      assertCurrent(state, generation, boundedSignal);
      const prepared = await provider.execute(state.handle, { phase: "prepare", step: request.step, observationDigest: request.observationDigest, action }, { signal: boundedSignal });
      assertCurrent(state, generation, boundedSignal);
      if (!isObject(prepared) || prepared.status !== "prepared") {
        fail(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, "provider prepare response is invalid");
      }
      const preparedActionId = assertSafeId(prepared.preparedActionId, "preparedActionId");
      if (prepared.highImpact !== undefined && typeof prepared.highImpact !== "boolean") {
        fail(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, "provider highImpact must be a boolean");
      }
      const providerChecks = validateSafetyChecks(prepared.safetyChecks, "provider");
      const checks = [...modelChecks, ...providerChecks];
      if (HIGH_IMPACT_ACTIONS.has(action.type) || prepared.highImpact === true) {
        checks.push(Object.freeze({
          id: `useful.high-impact.${action.type}`,
          description: `Confirm high-impact ${action.type} action`,
          severity: "high",
          source: "contract",
        }));
      }
      const unique = new Set();
      for (const check of checks) {
        const id = `${check.source}:${check.id}`;
        if (unique.has(id)) fail(COMPUTER_USE_ERROR_CODES.SAFETY_CHECK_INVALID, "duplicate safety check");
        unique.add(id);
      }
      const approvals = await approveChecks(state, generation, safeRequest, preparedActionId, actionDigest, checks, boundedSignal);
      assertCurrent(state, generation, boundedSignal);
      await emit({
        kind: "authorization",
        sessionId,
        preparedActionId,
        step: request.step,
        actionType: action.type,
        actionDigest,
        observationDigest: request.observationDigest,
        ...(state.latestDomain ? { domain: state.latestDomain } : {}),
        ...(actionCoordinates(action) ? { coordinates: actionCoordinates(action) } : {}),
        safetyCheckIds: checks.map((check) => check.id),
        approvalIds: approvals.map((entry) => entry.approvalId),
        resultCode: "AUTHORIZED",
      });
      assertCurrent(state, generation, boundedSignal);
      state.commitStarted = true;
      const committed = await provider.execute(state.handle, {
        phase: "commit",
        preparedActionId,
        step: request.step,
        observationDigest: request.observationDigest,
        actionDigest,
        action,
        approvals,
      }, { signal: boundedSignal });
      state.commitCompleted = true;
      assertCurrent(state, generation, boundedSignal);
      if (!isObject(committed) || committed.status !== "executed" || !isSafeId(committed.resultCode)) {
        fail(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, "provider commit response is invalid");
      }
      const network = validateNetworkEvidence(committed, policy);
      const resultDomain = network?.domain ?? state.latestDomain;
      await emit({
        kind: "action",
        sessionId,
        preparedActionId,
        step: request.step,
        actionType: action.type,
        actionDigest,
        observationDigest: request.observationDigest,
        ...(resultDomain ? { domain: resultDomain } : {}),
        ...(actionCoordinates(action) ? { coordinates: actionCoordinates(action) } : {}),
        safetyCheckIds: checks.map((check) => check.id),
        approvalIds: approvals.map((entry) => entry.approvalId),
        resultCode: committed.resultCode,
      });
      assertCurrent(state, generation, boundedSignal);
      state.commitStarted = false;
      state.commitCompleted = false;
      return deepFreeze({ schemaVersion: COMPUTER_USE_SCHEMA, sessionId, step: request.step, resultCode: committed.resultCode, nextStep: request.step + 1 });
    }, () => {
      state.nextStep = Math.max(state.nextStep, request.step + 1);
    });

    return operation.catch(async (error) => {
      if (state.commitStarted) {
        state.poisoned = true;
        state.poisonReason = error instanceof ComputerUseError && isSafeId(error.code)
          ? error.code
          : "COMMIT_OUTCOME_UNKNOWN";
        await close(sessionId, { reason: "commit-outcome-unknown" }).catch(() => {});
      }
      throw error;
    });
  };

  const close = (sessionId, { signal, reason = "closed" } = {}) => {
    if (closedSessions.has(sessionId)) return closedSessions.get(sessionId);
    const state = sessions.get(sessionId);
    if (!state) return Promise.resolve(false);
    if (state.closePromise) return state.closePromise;
    state.closing = true;
    state.generation += 1;
    state.operationController?.abort(COMPUTER_USE_ERROR_CODES.SESSION_CLOSED);
    const activeOperation = state.operationPromise;
    const closeDeadlineMs = Math.max(1_000, Math.min(30_000, policy.stepDeadlineMs));
    const attempt = (async () => {
      await activeOperation?.catch(() => {});
      let providerClosed = false;
      try {
        await runBounded(async (boundedSignal) => {
          await provider.close(state.handle, { signal: boundedSignal, reason });
          if (boundedSignal.aborted) fail(COMPUTER_USE_ERROR_CODES.CANCELLED, "provider close completed after cancellation");
        }, { signal, timeoutMs: closeDeadlineMs, timeoutCode: COMPUTER_USE_ERROR_CODES.STEP_DEADLINE_EXCEEDED });
        providerClosed = true;
        state.closed = true;
        state.closing = false;
        sessions.delete(sessionId);
        const closedResult = Promise.resolve(true);
        closedSessions.set(sessionId, closedResult);
        await emit({ kind: "session-closed", sessionId, resultCode: "CLOSED" });
        return true;
      } catch (error) {
        if (providerClosed) throw error;
        state.closing = false;
        state.poisoned = true;
        state.poisonReason = error instanceof ComputerUseError && isSafeId(error.code)
          ? error.code
          : "PROVIDER_CLOSE_FAILED";
        state.closePromise = undefined;
        throw error;
      }
    })();
    state.closePromise = attempt;
    return attempt;
  };

  const reap = async () => {
    const candidates = [...sessions.values()].filter((state) => state.poisoned || remainingTotal(state, now) <= 0);
    let closed = 0;
    for (const state of candidates) {
      try {
        if (await close(state.sessionId, { reason: state.poisoned ? "poisoned" : "expired" })) closed += 1;
      } catch {
        // The poisoned tombstone remains in sessions so a later reap can retry.
      }
    }
    return closed;
  };

  return Object.freeze({ policy, createSession, observe, execute, close, reap });
}
