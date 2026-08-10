import {
  assertComputerUseAction,
  COMPUTER_USE_ERROR_CODES,
  COMPUTER_USE_SCHEMA,
  ComputerUseError,
} from "../../computer-use-contract/src/index.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const ERROR_CODE_SET = new Set(Object.values(COMPUTER_USE_ERROR_CODES));
const ADD_EVENT_LISTENER = EventTarget.prototype.addEventListener;
const REMOVE_EVENT_LISTENER = EventTarget.prototype.removeEventListener;
const ABORTED_GETTER = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted").get;
const FACTORY_KEYS = ["createContext", "startUrl", "networkGuard", "idFactory"];
const POLICY_KEYS = [
  "schemaVersion",
  "environment",
  "maxSteps",
  "stepDeadlineMs",
  "totalDeadlineMs",
  "maxScreenshotBytes",
  "allowDomains",
  "maxRedirects",
  "developmentMode",
  "allowPrivateDomains",
];
const GUARD_KEYS = ["enforcement", "open"];
const ENFORCEMENT_KEYS = ["transport", "requests", "dns", "redirects", "ports"];
const GUARD_SESSION_KEYS = ["binding", "evidence", "close"];
const DRIVER_KEYS = [
  "observe",
  "screenshot",
  "click",
  "doubleClick",
  "drag",
  "move",
  "scroll",
  "typeText",
  "pressKeys",
  "wait",
  "close",
];
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

function fail(code, message) {
  throw new ComputerUseError(code, message);
}

function inspectDescriptors(value) {
  return {
    array: Array.isArray(value),
    prototype: Object.getPrototypeOf(value),
    descriptors: Object.getOwnPropertyDescriptors(value),
  };
}

function descriptorSnapshot(value, code, label, kind = "record", captured) {
  let inspection = captured;
  try {
    inspection ??= inspectDescriptors(value);
  } catch {
    fail(code, `${label} could not be inspected safely`);
  }
  if (value === null || typeof value !== "object") fail(code, `${label} must be an object`);
  if (kind === "record" && (inspection.array || (inspection.prototype !== Object.prototype && inspection.prototype !== null))) {
    fail(code, `${label} must be a plain object`);
  }
  if (kind === "array" && !inspection.array) fail(code, `${label} must be an array`);
  for (const key of Reflect.ownKeys(inspection.descriptors)) {
    const descriptor = inspection.descriptors[key];
    if (typeof key !== "string" || !("value" in descriptor)) {
      fail(code, `${label} must only contain string own data properties`);
    }
  }
  return inspection.descriptors;
}

function snapshotRecord(value, allowed, code, label, exact = false, captured) {
  const descriptors = descriptorSnapshot(value, code, label, "record", captured);
  const keys = Object.keys(descriptors);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !allowed.includes(key)) fail(code, `${label} contains an unknown field`);
  }
  if (exact && (keys.length !== allowed.length || allowed.some((key) => !Object.hasOwn(descriptors, key)))) {
    fail(code, `${label} must expose exactly the documented fields`);
  }
  const snapshot = Object.create(null);
  for (const key of keys) snapshot[key] = descriptors[key].value;
  return Object.freeze(snapshot);
}

function assertSnapshotExactKeys(snapshot, allowed, code, label) {
  const keys = Object.keys(snapshot);
  if (keys.length !== allowed.length || allowed.some((key) => !Object.hasOwn(snapshot, key))) {
    fail(code, `${label} must expose exactly the documented fields`);
  }
}

function snapshotArray(value, maximum, code, label) {
  const descriptors = descriptorSnapshot(value, code, label, "array");
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum) fail(code, `${label} has an invalid length`);
  const allowed = new Set(["length", ...Array.from({ length }, (_, index) => String(index))]);
  if (Reflect.ownKeys(descriptors).some((key) => !allowed.has(key))) fail(code, `${label} contains an unknown field`);
  const snapshot = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable) fail(code, `${label} must be a dense own-data-property array`);
    snapshot.push(descriptor.value);
  }
  return Object.freeze(snapshot);
}

function assertSignal(signal) {
  let aborted;
  try {
    if (!(signal instanceof AbortSignal)) throw new TypeError("invalid signal");
    aborted = Reflect.apply(ABORTED_GETTER, signal, []);
  } catch {
    fail(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, "context.signal must be an AbortSignal");
  }
  if (aborted) fail(COMPUTER_USE_ERROR_CODES.CANCELLED, "operation was cancelled");
}

function providerContext(value, allowed, label) {
  return snapshotRecord(value, allowed, COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, label);
}

async function awaitWithSignal(operation, signal, onAbort) {
  assertSignal(signal);
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const handleAbort = () => {
    try {
      onAbort?.();
    } finally {
      rejectAbort(new ComputerUseError(COMPUTER_USE_ERROR_CODES.CANCELLED, "operation was cancelled"));
    }
  };
  Reflect.apply(ADD_EVENT_LISTENER, signal, ["abort", handleAbort, { once: true }]);
  try {
    const value = await Promise.race([Promise.resolve().then(operation), aborted]);
    if (Reflect.apply(ABORTED_GETTER, signal, [])) fail(COMPUTER_USE_ERROR_CODES.CANCELLED, "operation completed after cancellation");
    return value;
  } finally {
    Reflect.apply(REMOVE_EVENT_LISTENER, signal, ["abort", handleAbort]);
  }
}

async function callInjected(label, operation, signal, onAbort) {
  try {
    return await awaitWithSignal(operation, signal, onAbort);
  } catch (error) {
    let safeCode;
    try {
      const prototype = Object.getPrototypeOf(error);
      const descriptors = Object.getOwnPropertyDescriptors(error);
      const code = descriptors.code?.value;
      if (prototype === ComputerUseError.prototype && typeof code === "string" && ERROR_CODE_SET.has(code)) safeCode = code;
    } catch {
      safeCode = undefined;
    }
    if (safeCode) throw new ComputerUseError(safeCode);
    fail(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, `${label} failed`);
  }
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

async function sha256(parts) {
  if (!globalThis.crypto?.subtle) {
    fail(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, "Web Crypto is required for binding digests");
  }
  let size = 0;
  for (const part of parts) size += part.byteLength;
  const input = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    input.set(part, offset);
    offset += part.byteLength;
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function digestAction(action) {
  return sha256([new TextEncoder().encode(canonicalJson(action))]);
}

function copyScreenshot(value, maximum) {
  let bytes;
  try {
    if (value instanceof ArrayBuffer) bytes = new Uint8Array(value.slice(0));
    else if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) {
      bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
    }
  } catch {
    fail(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, "driver screenshot is invalid");
  }
  if (!bytes) fail(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, "driver screenshot must be binary data");
  if (bytes.byteLength > maximum) fail(COMPUTER_USE_ERROR_CODES.SCREENSHOT_TOO_LARGE, "driver screenshot exceeds policy limit");
  return bytes;
}

function validateEvidence(value) {
  const evidenceValue = snapshotRecord(
    value,
    ["complete", "hops"],
    COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR,
    "network guard evidence",
    true,
  );
  if (evidenceValue.complete !== true) {
    fail(COMPUTER_USE_ERROR_CODES.NETWORK_EVIDENCE_REQUIRED, "network guard evidence must be complete");
  }
  const rawHops = snapshotArray(evidenceValue.hops, 10_000, COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, "network guard hops");
  if (rawHops.length < 1) fail(COMPUTER_USE_ERROR_CODES.NETWORK_EVIDENCE_REQUIRED, "network guard evidence must be complete");
  const hops = rawHops.map((rawHop) => {
    const hop = snapshotRecord(
      rawHop,
      ["url", "resolvedIps"],
      COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR,
      "network guard hop",
      true,
    );
    if (typeof hop.url !== "string") {
      fail(COMPUTER_USE_ERROR_CODES.NETWORK_EVIDENCE_REQUIRED, "every network guard hop requires a URL and resolved addresses");
    }
    const resolvedIps = snapshotArray(hop.resolvedIps, 16, COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, "network guard addresses");
    if (resolvedIps.length < 1) fail(COMPUTER_USE_ERROR_CODES.NETWORK_EVIDENCE_REQUIRED, "every network guard hop requires resolved addresses");
    let url;
    try {
      url = new URL(hop.url);
    } catch {
      fail(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, "network guard hop URL is invalid");
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      fail(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, "network guard hop URL must be credential-free HTTP(S)");
    }
    if (resolvedIps.some((address) => typeof address !== "string")) {
      fail(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, "network guard addresses must be strings");
    }
    return Object.freeze({ url: url.href, resolvedIps });
  });
  return Object.freeze({ complete: true, hops: Object.freeze(hops) });
}

function validateDriver(driver, captured) {
  if (!captured) fail(COMPUTER_USE_ERROR_CODES.PROVIDER_INVALID, "browser context could not be inspected safely");
  const snapshot = snapshotRecord(driver, DRIVER_KEYS, COMPUTER_USE_ERROR_CODES.PROVIDER_INVALID, "browser context", true, captured);
  for (const method of DRIVER_KEYS) {
    if (typeof snapshot[method] !== "function") {
      fail(COMPUTER_USE_ERROR_CODES.PROVIDER_INVALID, `browser context ${method} must be a function`);
    }
  }
  return snapshot;
}

function validateGuardSession(session, captured) {
  if (!captured) fail(COMPUTER_USE_ERROR_CODES.PROVIDER_INVALID, "network guard session could not be inspected safely");
  const snapshot = snapshotRecord(session, GUARD_SESSION_KEYS, COMPUTER_USE_ERROR_CODES.PROVIDER_INVALID, "network guard session", true, captured);
  if (snapshot.binding === null || snapshot.binding === undefined) {
    fail(COMPUTER_USE_ERROR_CODES.PROVIDER_INVALID, "network guard session binding is required");
  }
  for (const method of ["evidence", "close"]) {
    if (typeof snapshot[method] !== "function") fail(COMPUTER_USE_ERROR_CODES.PROVIDER_INVALID, `network guard ${method} must be a function`);
  }
  return snapshot;
}

function validateDriverResult(value) {
  const snapshot = snapshotRecord(value, ["resultCode"], COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, "driver action result", true);
  if (typeof snapshot.resultCode !== "string" || !SAFE_ID.test(snapshot.resultCode)) {
    fail(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, "driver resultCode must be a safe identifier");
  }
  return snapshot.resultCode;
}

function cloneAction(action) {
  const snapshot = snapshotRecord(
    action,
    Object.values(ACTION_FIELDS).flat(),
    COMPUTER_USE_ERROR_CODES.ACTION_INVALID,
    "action",
  );
  const allowed = ACTION_FIELDS[snapshot.type];
  if (!allowed) fail(COMPUTER_USE_ERROR_CODES.ACTION_INVALID, "action.type is not supported");
  for (const key of Object.keys(snapshot)) {
    if (!allowed.includes(key)) fail(COMPUTER_USE_ERROR_CODES.ACTION_INVALID, "action contains an unknown field");
  }
  const owned = { ...snapshot };
  if (snapshot.type === "key") {
    owned.keys = snapshotArray(snapshot.keys, 16, COMPUTER_USE_ERROR_CODES.ACTION_INVALID, "action keys");
  }
  assertComputerUseAction(owned);
  return Object.freeze(owned);
}

function validateApprovals(approvals, record, request) {
  const snapshot = snapshotArray(approvals, 64, COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, "commit approvals");
  for (const rawApproval of snapshot) {
    const approval = snapshotRecord(
      rawApproval,
      ["safetyCheckId", "source", "approvalId", "preparedActionId", "step", "observationDigest", "actionDigest"],
      COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR,
      "commit approval",
      true,
    );
    if (typeof approval.safetyCheckId !== "string"
      || typeof approval.approvalId !== "string"
      || !SAFE_ID.test(approval.safetyCheckId)
      || !SAFE_ID.test(approval.approvalId)
      || !["model", "provider", "contract"].includes(approval.source)
      || approval.preparedActionId !== request.preparedActionId
      || approval.step !== record.step
      || approval.observationDigest !== record.observationDigest
      || approval.actionDigest !== record.actionDigest) {
      fail(COMPUTER_USE_ERROR_CODES.APPROVAL_DENIED, "commit approval is not bound to the prepared action");
    }
  }
}

function actionArguments(action) {
  const { type: _type, ...argumentsValue } = action;
  return Object.freeze(argumentsValue);
}

function driverMethod(type) {
  return ({ "double-click": "doubleClick", type: "typeText", key: "pressKeys" })[type] ?? type;
}

function safeId(idFactory, receiver) {
  let value;
  try {
    value = String(Reflect.apply(idFactory, receiver, []));
  } catch {
    fail(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, "idFactory failed");
  }
  if (!SAFE_ID.test(value)) fail(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, "idFactory must return a safe identifier");
  return value;
}

function rawCloseCapability(raw) {
  try {
    if (raw === null || (typeof raw !== "object" && typeof raw !== "function")) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    const descriptor = descriptors.close;
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function") return undefined;
    return Object.freeze({ close: descriptor.value, receiver: raw });
  } catch {
    return undefined;
  }
}

function captureRawAcquisition(raw) {
  try {
    const captured = inspectDescriptors(raw);
    const descriptor = captured.descriptors.close;
    const capability = descriptor && "value" in descriptor && typeof descriptor.value === "function"
      ? Object.freeze({ close: descriptor.value, receiver: raw })
      : undefined;
    return Object.freeze({ captured, capability, inspected: true });
  } catch {
    return Object.freeze({ captured: undefined, capability: undefined, inspected: false });
  }
}

function sameCloseCapability(left, right) {
  if (!left || !right) return left === right;
  return left.close === right.close && left.receiver === right.receiver;
}

function begin(handle) {
  if (handle.shutdown || handle.closed) fail(COMPUTER_USE_ERROR_CODES.SESSION_CLOSED, "browser session is shut down");
  if (handle.poisoned) fail(COMPUTER_USE_ERROR_CODES.SESSION_POISONED, "browser session is unavailable");
  if (handle.active) fail(COMPUTER_USE_ERROR_CODES.CONCURRENT_ACTION, "browser session already has an active operation");
  handle.active = true;
  handle.activeGeneration = handle.generation;
  return handle.generation;
}

function end(handle, generation) {
  if (handle.activeGeneration === generation) {
    handle.active = false;
    handle.activeGeneration = undefined;
  }
}

function assertGeneration(handle, generation) {
  if (handle.generation !== generation || handle.closed) {
    fail(COMPUTER_USE_ERROR_CODES.SESSION_CLOSED, "browser session generation changed");
  }
  if (handle.poisoned) fail(COMPUTER_USE_ERROR_CODES.SESSION_POISONED, "browser session is poisoned");
}

export function createIsolatedBrowserProvider(options) {
  const factory = snapshotRecord(options, FACTORY_KEYS, COMPUTER_USE_ERROR_CODES.PROVIDER_INVALID, "browser adapter options");
  for (const required of ["createContext", "startUrl", "networkGuard"]) {
    if (!Object.hasOwn(factory, required)) fail(COMPUTER_USE_ERROR_CODES.PROVIDER_INVALID, `browser adapter option ${required} is required`);
  }
  if (typeof factory.createContext !== "function") fail(COMPUTER_USE_ERROR_CODES.PROVIDER_INVALID, "createContext must be a function");
  if (typeof factory.startUrl !== "string" || factory.startUrl.trim() !== factory.startUrl) {
    fail(COMPUTER_USE_ERROR_CODES.PROVIDER_INVALID, "startUrl must be a fixed URL string");
  }
  let parsedStart;
  try {
    parsedStart = new URL(factory.startUrl);
  } catch {
    fail(COMPUTER_USE_ERROR_CODES.PROVIDER_INVALID, "startUrl must be a valid URL");
  }
  if (!["http:", "https:"].includes(parsedStart.protocol) || parsedStart.username || parsedStart.password) {
    fail(COMPUTER_USE_ERROR_CODES.PROVIDER_INVALID, "startUrl must be credential-free HTTP(S)");
  }
  const guardReceiver = snapshotRecord(factory.networkGuard, GUARD_KEYS, COMPUTER_USE_ERROR_CODES.PROVIDER_INVALID, "networkGuard", true);
  const guardEnforcement = snapshotRecord(
    guardReceiver.enforcement,
    ENFORCEMENT_KEYS,
    COMPUTER_USE_ERROR_CODES.PROVIDER_INVALID,
    "networkGuard.enforcement",
    true,
  );
  const requiredEnforcement = {
    transport: "host-enforced",
    requests: "every-request",
    dns: "all-addresses",
    redirects: "every-hop",
    ports: "explicit",
  };
  for (const [key, value] of Object.entries(requiredEnforcement)) {
    if (guardEnforcement[key] !== value) {
      fail(COMPUTER_USE_ERROR_CODES.PROVIDER_INVALID, "networkGuard does not declare mandatory enforcement capabilities");
    }
  }
  if (typeof guardReceiver.open !== "function") fail(COMPUTER_USE_ERROR_CODES.PROVIDER_INVALID, "networkGuard.open must be a function");
  if (factory.idFactory !== undefined && typeof factory.idFactory !== "function") {
    fail(COMPUTER_USE_ERROR_CODES.PROVIDER_INVALID, "idFactory must be a function");
  }
  const createContext = factory.createContext;
  const guardOpen = guardReceiver.open;
  const makeId = factory.idFactory ?? (() => globalThis.crypto.randomUUID());
  const startUrl = parsedStart.href;
  const issuedIds = new Set();
  const handles = new WeakMap();
  const quarantines = new Set();
  const resourceByRaw = new WeakMap();

  const resourceFor = (raw, rawAcquisition) => {
    if (raw === null || (typeof raw !== "object" && typeof raw !== "function")) {
      return {
        raw,
        closeCapability: rawAcquisition.capability,
        capabilityKnown: rawAcquisition.inspected,
        capabilityProbeAllowed: false,
        claims: new Set(),
        acceptingClaims: true,
        closePromise: undefined,
        closed: false,
      };
    }
    const existing = resourceByRaw.get(raw);
    if (existing) return existing;
    const resource = {
      raw,
      closeCapability: rawAcquisition.capability,
      capabilityKnown: rawAcquisition.inspected,
      capabilityProbeAllowed: false,
      claims: new Set(),
      acceptingClaims: true,
      closePromise: undefined,
      closed: false,
    };
    resourceByRaw.set(raw, resource);
    return resource;
  };

  const claimResource = (raw, role, dependency, rawAcquisition) => {
    const resource = resourceFor(raw, rawAcquisition);
    if (resource.closed || resource.closePromise || !resource.acceptingClaims) {
      fail(COMPUTER_USE_ERROR_CODES.SESSION_CLOSED, "raw resource is closing or closed");
    }
    if (resource.capabilityKnown && rawAcquisition.inspected
      && !sameCloseCapability(resource.closeCapability, rawAcquisition.capability)) {
      fail(COMPUTER_USE_ERROR_CODES.PROVIDER_INVALID, "raw resource close capability changed");
    }
    if (!resource.capabilityKnown && rawAcquisition.inspected) {
      resource.closeCapability = rawAcquisition.capability;
      resource.capabilityKnown = true;
    }
    const claim = {
      resource,
      role,
      closeRequested: false,
      dependency,
    };
    resource.claims.add(claim);
    return claim;
  };

  const createAcquisition = (guardClaim, reason, quarantined = false) => {
    const record = {
      guardClaim,
      driverClaim: undefined,
      rejectedDriverResource: undefined,
      reason,
      closePromise: undefined,
      completed: false,
      reapReported: false,
    };
    if (quarantined) quarantines.add(record);
    return record;
  };

  const quarantineAcquisition = (record) => {
    quarantines.add(record);
    return record;
  };

  const dependencySatisfied = (dependency) => dependency === "satisfied"
    || (dependency !== "pending" && dependency.closed === true);

  const requestClaim = (claim) => {
    claim.closeRequested = true;
    if ([...claim.resource.claims].every((entry) => entry.closeRequested)) claim.resource.acceptingClaims = false;
  };

  const requestResourceClose = async (claim, signal, reason) => {
    const { resource } = claim;
    requestClaim(claim);
    if (resource.closed) return "closed";
    if (resource.closePromise) {
      await awaitWithSignal(() => resource.closePromise, signal);
      return "closed";
    }
    if ([...resource.claims].some((entry) => !entry.closeRequested)) return "shared";
    resource.acceptingClaims = false;
    if ([...resource.claims].some((entry) => entry.role === "guard" && !dependencySatisfied(entry.dependency))) {
      return "blocked";
    }
    const closeSignal = new AbortController().signal;
    const capability = resource.capabilityKnown
      ? resource.closeCapability
      : (resource.capabilityProbeAllowed ? rawCloseCapability(resource.raw) : undefined);
    resource.capabilityProbeAllowed = true;
    const operation = capability
      ? callInjected(
        "resource close",
        () => Reflect.apply(capability.close, capability.receiver, [{ signal: closeSignal, reason }]),
        closeSignal,
      )
      : Promise.reject(new ComputerUseError(COMPUTER_USE_ERROR_CODES.PROVIDER_INVALID, "raw resource has no safe close capability"));
    const tracked = operation.then(
      () => { resource.closed = true; },
      (error) => {
        resource.closePromise = undefined;
        throw error;
      },
    );
    resource.closePromise = tracked;
    await awaitWithSignal(() => tracked, signal);
    return "closed";
  };

  const advanceAcquisition = async (record, signal) => {
    if (record.completed) return true;
    if (record.closePromise) return awaitWithSignal(() => record.closePromise, signal);
    const lifecycleSignal = new AbortController().signal;
    const attempt = (async () => {
      if (record.driverClaim) requestClaim(record.driverClaim);
      requestClaim(record.guardClaim);
      if (record.driverClaim) {
        const driverStatus = await requestResourceClose(record.driverClaim, lifecycleSignal, record.reason);
        assertSignal(lifecycleSignal);
        if (driverStatus !== "closed") return false;
        record.guardClaim.dependency = "satisfied";
      } else if (record.rejectedDriverResource) {
        if (!record.rejectedDriverResource.closed) return false;
        record.guardClaim.dependency = "satisfied";
      } else if (record.guardClaim.dependency === "pending") {
        return false;
      }
      const guardStatus = await requestResourceClose(record.guardClaim, lifecycleSignal, record.reason);
      assertSignal(lifecycleSignal);
      if (guardStatus === "blocked") return false;
      return guardStatus === "closed" || guardStatus === "shared";
    })();
    const tracked = attempt.then(
      (completed) => {
      if (completed) {
        record.completed = true;
        quarantines.delete(record);
      } else {
        record.closePromise = undefined;
      }
      return completed;
      },
      (error) => {
        record.closePromise = undefined;
        throw error;
      },
    );
    record.closePromise = tracked;
    return awaitWithSignal(() => tracked, signal);
  };

  const tryAdvance = async (record) => {
    const signal = new AbortController().signal;
    try {
      return await advanceAcquisition(record, signal);
    } catch {
      return false;
    }
  };

  const poisonHandle = (handle) => {
    handle.poisoned = true;
    if (!handle.shutdown) {
      handle.shutdown = true;
      handle.generation += 1;
    }
    handle.acquisition.reason = "commit-outcome-unknown";
    quarantineAcquisition(handle.acquisition);
    void tryAdvance(handle.acquisition);
  };

  const registerDeferredContextQuarantine = (contextAcquisition, record) => {
    requestClaim(record.guardClaim);
    quarantineAcquisition(record);
    void contextAcquisition.then(
      async (lateDriver) => {
        const rawAcquisition = captureRawAcquisition(lateDriver);
        try {
          record.driverClaim = claimResource(lateDriver, "driver", "satisfied", rawAcquisition);
          record.guardClaim.dependency = record.driverClaim.resource;
        } catch {
          record.rejectedDriverResource = resourceFor(lateDriver, rawAcquisition);
          record.guardClaim.dependency = record.rejectedDriverResource;
        }
        try {
          await tryAdvance(record);
        } catch {
          // The acquisition remains available to explicit reap.
        }
      },
      async () => {
        record.guardClaim.dependency = "satisfied";
        try {
          await tryAdvance(record);
        } catch {
          // The acquisition remains available to explicit reap.
        }
      },
    );
    return record;
  };

  const resolveHandle = (token) => {
    let handle;
    try {
      handle = handles.get(token);
    } catch {
      handle = undefined;
    }
    if (!handle) fail(COMPUTER_USE_ERROR_CODES.SESSION_NOT_FOUND, "browser session handle is invalid");
    return handle;
  };

  const createSession = async (request, context = {}) => {
    const contextValue = providerContext(context, ["signal"], "createSession context");
    const signal = contextValue.signal;
    const requestValue = snapshotRecord(
      request,
      ["schemaVersion", "environment", "policy"],
      COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR,
      "createSession request",
      true,
    );
    const rawPolicy = snapshotRecord(requestValue.policy, POLICY_KEYS, COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, "policy", true);
    const allowDomains = snapshotArray(rawPolicy.allowDomains, 256, COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, "policy allowDomains");
    const policyValue = Object.freeze({ ...rawPolicy, allowDomains });
    if (requestValue.schemaVersion !== COMPUTER_USE_SCHEMA) fail(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, "schemaVersion is not supported");
    if (requestValue.environment !== "isolated-browser" || policyValue.environment !== "isolated-browser") {
      fail(requestValue.environment === "host-desktop" ? COMPUTER_USE_ERROR_CODES.HOST_DESKTOP_REJECTED : COMPUTER_USE_ERROR_CODES.POLICY_INVALID, "browser adapter requires isolated-browser policy");
    }
    if (allowDomains.some((domain) => typeof domain !== "string")
      || !allowDomains.includes(parsedStart.hostname.toLowerCase().replace(/\.$/u, ""))) {
      fail(COMPUTER_USE_ERROR_CODES.DOMAIN_NOT_ALLOWED, "fixed startUrl is not allowed by policy");
    }
    assertSignal(signal);
    let rawGuard;
    let rawDriver;
    let guard;
    let driver;
    let acquisition;
    let deferred = false;
    try {
      const guardAcquisition = Promise.resolve().then(() => Reflect.apply(
        guardOpen,
        guardReceiver,
        [Object.freeze({ startUrl, policy: policyValue }), { signal }],
      ));
      rawGuard = await callInjected(
        "network guard open",
        () => guardAcquisition,
        signal,
        () => {
          void guardAcquisition.then(async (lateGuard) => {
            const rawAcquisition = captureRawAcquisition(lateGuard);
            try {
              const lateClaim = claimResource(lateGuard, "guard", "satisfied", rawAcquisition);
              const lateRecord = createAcquisition(lateClaim, "late-create", true);
              await tryAdvance(lateRecord);
            } catch {
              // A closing identity rejects the new claim; its existing lifecycle retains it.
            }
          }, () => {});
        },
      );
      const guardAcquisitionSnapshot = captureRawAcquisition(rawGuard);
      const guardClaim = claimResource(rawGuard, "guard", "pending", guardAcquisitionSnapshot);
      acquisition = createAcquisition(guardClaim, "create-failed");
      try {
        guard = validateGuardSession(rawGuard, guardAcquisitionSnapshot.captured);
      } catch (error) {
        acquisition.guardClaim.dependency = "satisfied";
        throw error;
      }
      assertSignal(signal);
      const contextAcquisition = Promise.resolve().then(() => Reflect.apply(
        createContext,
        factory,
        [Object.freeze({ startUrl, networkGuardBinding: guard.binding }), { signal }],
      ));
      rawDriver = await callInjected(
        "browser context create",
        () => contextAcquisition,
        signal,
        () => {
          deferred = true;
          acquisition.reason = "late-create";
          registerDeferredContextQuarantine(contextAcquisition, acquisition);
        },
      );
      const driverAcquisitionSnapshot = captureRawAcquisition(rawDriver);
      try {
        acquisition.driverClaim = claimResource(rawDriver, "driver", "satisfied", driverAcquisitionSnapshot);
        acquisition.guardClaim.dependency = acquisition.driverClaim.resource;
      } catch (error) {
        acquisition.rejectedDriverResource = resourceFor(rawDriver, driverAcquisitionSnapshot);
        acquisition.guardClaim.dependency = acquisition.rejectedDriverResource;
        throw error;
      }
      try {
        driver = validateDriver(rawDriver, driverAcquisitionSnapshot.captured);
      } catch (error) {
        throw error;
      }
      assertSignal(signal);
      const handle = {
        guard,
        driver,
        acquisition,
        policy: policyValue,
        sessionBinding: Object.freeze({}),
        generation: 1,
        observationGeneration: 0,
        documentToken: undefined,
        nextStep: 1,
        latestDigest: undefined,
        prepared: new Map(),
        active: false,
        activeGeneration: undefined,
        poisoned: false,
        shutdown: false,
        closed: false,
        closePromise: undefined,
      };
      const token = Object.freeze(Object.create(null));
      handles.set(token, handle);
      return token;
    } catch (error) {
      if (acquisition && !deferred) {
        if (acquisition.guardClaim.dependency === "pending") acquisition.guardClaim.dependency = "satisfied";
        quarantineAcquisition(acquisition);
        await tryAdvance(acquisition);
      }
      if (error instanceof ComputerUseError) throw error;
      fail(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, "browser session creation failed");
    }
  };

  const observe = async (token, context = {}) => {
    const handle = resolveHandle(token);
    const contextValue = providerContext(context, ["signal"], "observe context");
    const signal = contextValue.signal;
    const generation = begin(handle);
    try {
      assertSignal(signal);
      handle.prepared.clear();
      const raw = await callInjected("browser observe",
        () => Reflect.apply(
          handle.driver.observe,
          handle.driver,
          [Object.freeze({ maxScreenshotBytes: handle.policy.maxScreenshotBytes }), { signal }],
        ),
        signal,
      );
      assertGeneration(handle, generation);
      const observationValue = snapshotRecord(
        raw,
        ["screenshot", "url", "documentToken"],
        COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR,
        "driver observation",
        true,
      );
      if (typeof observationValue.url !== "string"
        || typeof observationValue.documentToken !== "string"
        || !SAFE_ID.test(observationValue.documentToken)) {
        fail(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, "driver observation metadata is invalid");
      }
      let observedUrl;
      try {
        observedUrl = new URL(observationValue.url).href;
      } catch {
        fail(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, "driver observation URL is invalid");
      }
      const screenshot = copyScreenshot(observationValue.screenshot, handle.policy.maxScreenshotBytes);
      const rawEvidence = await callInjected(
        "network guard evidence",
        () => Reflect.apply(handle.guard.evidence, handle.guard, [{ signal }]),
        signal,
      );
      assertGeneration(handle, generation);
      const networkEvidence = validateEvidence(rawEvidence);
      const finalUrl = networkEvidence.hops.at(-1).url;
      if (observedUrl !== finalUrl) fail(COMPUTER_USE_ERROR_CODES.NETWORK_EVIDENCE_REQUIRED, "driver URL is not bound to the guard's final hop");
      const metadata = new TextEncoder().encode(canonicalJson({ url: observedUrl, documentToken: observationValue.documentToken, networkEvidence }));
      const observationDigest = await sha256([metadata, screenshot]);
      assertSignal(signal);
      assertGeneration(handle, generation);
      handle.latestDigest = observationDigest;
      handle.documentToken = observationValue.documentToken;
      handle.observationGeneration += 1;
      assertGeneration(handle, generation);
      return { observationDigest, screenshot, networkEvidence };
    } finally {
      end(handle, generation);
    }
  };

  const execute = async (token, request, context = {}) => {
    const handle = resolveHandle(token);
    const contextValue = providerContext(context, ["signal"], "execute context");
    const signal = contextValue.signal;
    const generation = begin(handle);
    try {
      assertSignal(signal);
      const requestValue = snapshotRecord(
        request,
        ["phase", "step", "observationDigest", "action", "preparedActionId", "actionDigest", "approvals"],
        COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR,
        "execute request",
      );
      if (requestValue.phase === "prepare") {
        assertSnapshotExactKeys(requestValue, ["phase", "step", "observationDigest", "action"], COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, "prepare request");
        const action = cloneAction(requestValue.action);
        if (!Number.isInteger(requestValue.step) || requestValue.step !== handle.nextStep) fail(COMPUTER_USE_ERROR_CODES.STEP_INVALID, "prepare step is stale");
        if (typeof requestValue.observationDigest !== "string"
          || !SHA256.test(requestValue.observationDigest)
          || requestValue.observationDigest !== handle.latestDigest) {
          fail(COMPUTER_USE_ERROR_CODES.OBSERVATION_STALE, "prepare observation is stale");
        }
        if ([...handle.prepared.values()].some((record) => record.step === requestValue.step)) {
          fail(COMPUTER_USE_ERROR_CODES.STEP_REPLAYED, "step is already prepared");
        }
        const preparedActionId = safeId(makeId, factory);
        if (issuedIds.has(preparedActionId)) fail(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, "idFactory returned a duplicate identifier");
        issuedIds.add(preparedActionId);
        const canonicalAction = canonicalJson(action);
        const actionDigest = await digestAction(action);
        assertSignal(signal);
        assertGeneration(handle, generation);
        handle.prepared.set(preparedActionId, Object.freeze({
          sessionBinding: handle.sessionBinding,
          sessionGeneration: handle.generation,
          observationGeneration: handle.observationGeneration,
          documentToken: handle.documentToken,
          step: requestValue.step,
          observationDigest: requestValue.observationDigest,
          canonicalAction,
          actionDigest,
        }));
        assertGeneration(handle, generation);
        return { status: "prepared", preparedActionId };
      }

      if (requestValue.phase !== "commit") fail(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, "execute phase is not supported");
      assertSnapshotExactKeys(requestValue, ["phase", "preparedActionId", "step", "observationDigest", "actionDigest", "action", "approvals"], COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, "commit request");
      const action = cloneAction(requestValue.action);
      const record = handle.prepared.get(requestValue.preparedActionId);
      if (!record) fail(COMPUTER_USE_ERROR_CODES.STEP_REPLAYED, "prepared action is stale or already consumed");
      if (record.sessionBinding !== handle.sessionBinding
        || record.sessionGeneration !== handle.generation
        || record.observationGeneration !== handle.observationGeneration
        || record.documentToken !== handle.documentToken) {
        fail(COMPUTER_USE_ERROR_CODES.OBSERVATION_STALE, "prepared action is not bound to the current document");
      }
      if (requestValue.step !== record.step || requestValue.step !== handle.nextStep) fail(COMPUTER_USE_ERROR_CODES.STEP_INVALID, "commit step does not match prepared action");
      if (requestValue.observationDigest !== record.observationDigest || requestValue.observationDigest !== handle.latestDigest) {
        fail(COMPUTER_USE_ERROR_CODES.OBSERVATION_STALE, "commit observation does not match prepared action");
      }
      if (typeof requestValue.actionDigest !== "string"
        || !SHA256.test(requestValue.actionDigest)
        || requestValue.actionDigest !== record.actionDigest
        || canonicalJson(action) !== record.canonicalAction) {
        fail(COMPUTER_USE_ERROR_CODES.ACTION_INVALID, "commit action does not match prepared action");
      }
      validateApprovals(requestValue.approvals, record, requestValue);
      assertGeneration(handle, generation);

      handle.prepared.delete(requestValue.preparedActionId);
      handle.latestDigest = undefined;
      handle.nextStep += 1;
      const method = driverMethod(action.type);
      let actionStarted = false;
      let result;
      try {
        actionStarted = true;
        result = await callInjected(
          "browser action",
          () => Reflect.apply(
            handle.driver[method],
            handle.driver,
            [Object.freeze({ ...actionArguments(action), documentToken: record.documentToken }), { signal }],
          ),
          signal,
          () => {
            poisonHandle(handle);
          },
        );
        assertGeneration(handle, generation);
      } catch (error) {
        if (actionStarted) {
          poisonHandle(handle);
        }
        throw error;
      }
      try {
        const resultCode = validateDriverResult(result);
        const rawEvidence = await callInjected(
          "network guard evidence",
          () => Reflect.apply(handle.guard.evidence, handle.guard, [{ signal }]),
          signal,
          () => {
            poisonHandle(handle);
          },
        );
        assertGeneration(handle, generation);
        const networkEvidence = validateEvidence(rawEvidence);
        assertGeneration(handle, generation);
        return { status: "executed", resultCode, networkEvidence };
      } catch (error) {
        poisonHandle(handle);
        throw error;
      }
    } finally {
      end(handle, generation);
    }
  };

  const close = async (token, context = {}) => {
    const handle = resolveHandle(token);
    if (handle.closed) return;
    const contextValue = providerContext(context, ["signal", "reason"], "close context");
    const { signal, reason } = contextValue;
    if (signal !== undefined) assertSignal(signal);
    if (!handle.shutdown) {
      handle.shutdown = true;
      handle.generation += 1;
    }
    handle.acquisition.reason = typeof reason === "string" && SAFE_ID.test(reason) ? reason : "closed";
    quarantineAcquisition(handle.acquisition);
    const completed = await advanceAcquisition(handle.acquisition, signal ?? new AbortController().signal);
    if (!completed) fail(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR, "resource lifecycle is waiting for another claim");
    handle.closed = true;
    handle.prepared.clear();
  };

  const reapQuarantine = async (context = {}) => {
    const contextValue = providerContext(context, ["signal"], "reapQuarantine context");
    const signal = contextValue.signal ?? new AbortController().signal;
    assertSignal(signal);
    let closed = 0;
    for (const record of [...quarantines]) {
      assertSignal(signal);
      try {
        if (await advanceAcquisition(record, signal) && !record.reapReported) {
          record.reapReported = true;
          closed += 1;
        }
      } catch {
        assertSignal(signal);
        // A failed quarantine remains strongly held for a later explicit reap.
      }
    }
    assertSignal(signal);
    return Object.freeze({ remaining: quarantines.size, closed });
  };

  return Object.freeze({ createSession, observe, execute, close, reapQuarantine });
}
