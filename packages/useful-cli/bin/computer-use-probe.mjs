import { createHash } from "node:crypto";
import {
  COMPUTER_USE_ACTION_TYPES,
  COMPUTER_USE_ENVIRONMENTS,
  COMPUTER_USE_ERROR_CODES,
  COMPUTER_USE_SCHEMA,
  DEFAULT_COMPUTER_USE_POLICY,
  createComputerUseController,
  normalizeComputerUsePolicy,
} from "@useful/computer-use-contract";
import { createIsolatedBrowserProvider } from "@useful/computer-use-browser-adapter";
import { createComputerUseProbe } from "@useful/protocol/computer-use-probe";
import { resolveAgentProbeInstallation } from "./agent-probe.mjs";

const EXPECTED_SCHEMA = "useful.computer-use.v1";
const EXPECTED_ENVIRONMENTS = Object.freeze(["isolated-browser", "isolated-vm"]);
const EXPECTED_ACTION_TYPES = Object.freeze([
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
const EXPECTED_ACTION_TYPES_SHA256 = "a9bce07e51d533f830833d94ddc5fd53ae7f0b837da31edc8b68f64394a10cf7";
const EXPECTED_DEFAULT_POLICY = Object.freeze({
  schemaVersion: EXPECTED_SCHEMA,
  environment: "isolated-browser",
  maxSteps: 25,
  stepDeadlineMs: 30_000,
  totalDeadlineMs: 300_000,
  maxScreenshotBytes: 10 * 1024 * 1024,
  allowDomains: Object.freeze([]),
  maxRedirects: 0,
  developmentMode: false,
  allowPrivateDomains: false,
});

export class ComputerUseProbeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ComputerUseProbeError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details = {}) {
  throw new ComputerUseProbeError(code, message, details);
}

function sha256Json(value) {
  return createHash("sha256").update(Buffer.from(JSON.stringify(value), "utf8")).digest("hex");
}

function exactJsonEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => exactJsonEqual(value, right[index]));
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && exactJsonEqual(left[key], right[key]));
}

function installationIdentity(resolved) {
  const installation = resolved?.installation;
  if (!installation || typeof installation !== "object" || Array.isArray(installation)) {
    fail("COMPUTER_USE_INSTALLATION_INVALID", "固定安装身份无效");
  }
  return Object.freeze({
    mode: installation.mode,
    artifactVerified: installation.artifactVerified,
    sourceRevision: installation.sourceRevision,
    version: installation.version,
  });
}

async function rejectionCode(operation) {
  try {
    await operation();
    return null;
  } catch (error) {
    return error?.code ?? null;
  }
}

async function executeProbe(dependencies = {}) {
  const resolveInstallation = dependencies.resolveInstallation ?? resolveAgentProbeInstallation;
  const createController = dependencies.createController ?? createComputerUseController;
  const normalizePolicy = dependencies.normalizePolicy ?? normalizeComputerUsePolicy;
  const createProbe = dependencies.createProbe ?? createComputerUseProbe;
  const browserAdapterFactory = dependencies.browserAdapterFactory ?? createIsolatedBrowserProvider;
  const contract = dependencies.contract ?? Object.freeze({
    actionTypes: COMPUTER_USE_ACTION_TYPES,
    defaultPolicy: DEFAULT_COMPUTER_USE_POLICY,
    environments: COMPUTER_USE_ENVIRONMENTS,
    errorCodes: COMPUTER_USE_ERROR_CODES,
    schemaVersion: COMPUTER_USE_SCHEMA,
  });

  const installationBefore = installationIdentity(resolveInstallation());

  if (contract.schemaVersion !== EXPECTED_SCHEMA) {
    fail("COMPUTER_USE_SCHEMA_MISMATCH", "Computer Use schema 身份漂移");
  }
  if (!exactJsonEqual(contract.environments, EXPECTED_ENVIRONMENTS)) {
    fail("COMPUTER_USE_ENVIRONMENTS_MISMATCH", "Computer Use environment 闭集漂移");
  }
  if (!exactJsonEqual(contract.actionTypes, EXPECTED_ACTION_TYPES)
    || sha256Json(contract.actionTypes) !== EXPECTED_ACTION_TYPES_SHA256) {
    fail("COMPUTER_USE_ACTION_TYPES_MISMATCH", "Computer Use action type 闭集漂移");
  }
  if (!exactJsonEqual(contract.defaultPolicy, EXPECTED_DEFAULT_POLICY)) {
    fail("COMPUTER_USE_DEFAULT_POLICY_MISMATCH", "Computer Use 默认策略漂移");
  }
  if (contract.errorCodes?.DISABLED !== "COMPUTER_USE_DISABLED"
    || contract.errorCodes?.HOST_DESKTOP_REJECTED !== "COMPUTER_USE_HOST_DESKTOP_REJECTED") {
    fail("COMPUTER_USE_ERROR_CODES_MISMATCH", "Computer Use fail-closed 错误码漂移");
  }
  if (typeof browserAdapterFactory !== "function") {
    fail("COMPUTER_USE_BROWSER_ADAPTER_INTERFACE_MISSING", "隔离浏览器 adapter 工厂接口不存在");
  }
  if (typeof createController !== "function" || typeof normalizePolicy !== "function" || typeof createProbe !== "function") {
    fail("COMPUTER_USE_PROBE_INTERFACE_MISSING", "Computer Use 探测所需接口不存在");
  }

  let controller;
  try {
    controller = createController();
  } catch {
    fail("COMPUTER_USE_DEFAULT_CONTROLLER_INVALID", "默认 Computer Use controller 无法创建");
  }
  if (!controller || typeof controller.createSession !== "function"
    || !exactJsonEqual(controller.policy, EXPECTED_DEFAULT_POLICY)) {
    fail("COMPUTER_USE_DEFAULT_CONTROLLER_INVALID", "默认 Computer Use controller 接口或策略无效");
  }
  const disabledCode = await rejectionCode(() => controller.createSession());
  if (disabledCode !== contract.errorCodes.DISABLED) {
    fail("COMPUTER_USE_DEFAULT_PROVIDER_NOT_DISABLED", "默认 Computer Use provider 未稳定拒绝 session 创建");
  }

  let hostDesktopCode = null;
  try {
    normalizePolicy({ environment: "host-desktop" });
  } catch (error) {
    hostDesktopCode = error?.code ?? null;
  }
  if (hostDesktopCode !== contract.errorCodes.HOST_DESKTOP_REJECTED) {
    fail("COMPUTER_USE_HOST_DESKTOP_NOT_REJECTED", "host-desktop 未被策略边界稳定拒绝");
  }

  const installationAfter = installationIdentity(resolveInstallation());
  if (!exactJsonEqual(installationAfter, installationBefore)) {
    fail("COMPUTER_USE_INSTALLATION_IDENTITY_DRIFT", "探测前后固定安装身份发生漂移");
  }

  return createProbe({ installation: installationBefore });
}

export async function runComputerUseProbe() {
  return executeProbe();
}

// Test seam only: production always uses the fixed installation resolver,
// default disabled controller, host-desktop policy rejection, and interface-only
// browser adapter reference. The adapter factory is deliberately never called.
export const computerUseProbeTesting = Object.freeze({
  executeProbe,
  expectedActionTypes: EXPECTED_ACTION_TYPES,
  expectedActionTypesSha256: EXPECTED_ACTION_TYPES_SHA256,
  expectedDefaultPolicy: EXPECTED_DEFAULT_POLICY,
  expectedEnvironments: EXPECTED_ENVIRONMENTS,
});
