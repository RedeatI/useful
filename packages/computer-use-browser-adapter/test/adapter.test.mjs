import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPUTER_USE_ERROR_CODES,
  COMPUTER_USE_SCHEMA,
  ComputerUseError,
  createComputerUseController,
  normalizeComputerUsePolicy,
} from "../../computer-use-contract/src/index.mjs";
import { createIsolatedBrowserProvider } from "../src/index.mjs";

const START_URL = "https://example.com/";
const PUBLIC_IP = "93.184.216.34";

const hasCode = (code) => (error) => error?.code === code;

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

async function actionDigest(action) {
  const bytes = new TextEncoder().encode(canonicalJson(action));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function enforcement(overrides = {}) {
  return {
    transport: "host-enforced",
    requests: "every-request",
    dns: "all-addresses",
    redirects: "every-hop",
    ports: "explicit",
    ...overrides,
  };
}

function evidence(url = START_URL, addresses = [PUBLIC_IP]) {
  return { complete: true, hops: [{ url, resolvedIps: addresses }] };
}

function driver(overrides = {}) {
  const result = async () => ({ resultCode: "OK" });
  return {
    async observe() {
      return { screenshot: new Uint8Array([1, 2, 3]), url: START_URL, documentToken: "document-1" };
    },
    screenshot: result,
    click: result,
    doubleClick: result,
    drag: result,
    move: result,
    scroll: result,
    typeText: result,
    pressKeys: result,
    wait: result,
    async close() {},
    ...overrides,
  };
}

function guard(overrides = {}) {
  const sessionOverrides = overrides.session ?? {};
  const guardOverrides = { ...overrides };
  delete guardOverrides.session;
  return {
    enforcement: enforcement(),
    async open() {
      return {
        binding: Object.freeze({ kind: "test-binding" }),
        async evidence() { return evidence(); },
        async close() {},
        ...sessionOverrides,
      };
    },
    ...guardOverrides,
  };
}

function policy(overrides = {}) {
  return normalizeComputerUsePolicy({ allowDomains: ["example.com"], maxRedirects: 4, ...overrides });
}

function sessionRequest(environment = "isolated-browser", policyValue = policy({ environment })) {
  return { schemaVersion: COMPUTER_USE_SCHEMA, environment, policy: policyValue };
}

function adapter(overrides = {}) {
  let nextId = 0;
  return createIsolatedBrowserProvider({
    startUrl: START_URL,
    networkGuard: guard(),
    async createContext() { return driver(); },
    idFactory: () => `prepared-${++nextId}`,
    ...overrides,
  });
}

async function opened(provider = adapter(), policyValue = policy()) {
  const signal = new AbortController().signal;
  const handle = await provider.createSession(sessionRequest(policyValue.environment, policyValue), { signal });
  const observation = await provider.observe(handle, { signal });
  return { provider, handle, observation, signal };
}

async function prepare(state, action = { type: "screenshot" }) {
  const prepared = await state.provider.execute(state.handle, {
    phase: "prepare",
    step: 1,
    observationDigest: state.observation.observationDigest,
    action,
  }, { signal: state.signal });
  return { ...prepared, action, digest: await actionDigest(action) };
}

function commitRequest(state, prepared, overrides = {}) {
  return {
    phase: "commit",
    preparedActionId: prepared.preparedActionId,
    step: 1,
    observationDigest: state.observation.observationDigest,
    actionDigest: prepared.digest,
    action: prepared.action,
    approvals: [],
    ...overrides,
  };
}

test("factory is closed-world and requires a host-enforced request/DNS/redirect/port guard", () => {
  assert.throws(() => createIsolatedBrowserProvider({ startUrl: START_URL, createContext: async () => driver() }), hasCode(COMPUTER_USE_ERROR_CODES.PROVIDER_INVALID));
  assert.throws(() => adapter({ networkGuard: guard({ enforcement: enforcement({ dns: "first-address" }) }) }), hasCode(COMPUTER_USE_ERROR_CODES.PROVIDER_INVALID));
  assert.throws(() => adapter({ networkGuard: { ...guard(), capability: "driver-claimed" } }), hasCode(COMPUTER_USE_ERROR_CODES.PROVIDER_INVALID));
  assert.throws(() => adapter({ evaluate: () => {} }), hasCode(COMPUTER_USE_ERROR_CODES.PROVIDER_INVALID));

  const accessor = { startUrl: START_URL, networkGuard: guard(), createContext: async () => driver() };
  Object.defineProperty(accessor, "idFactory", { enumerable: true, get() { throw new Error("must not run"); } });
  assert.throws(() => createIsolatedBrowserProvider(accessor), hasCode(COMPUTER_USE_ERROR_CODES.PROVIDER_INVALID));
});

test("factory descriptor values and receivers are fixed after construction", async () => {
  let originalGuardOpens = 0;
  let originalContextCreates = 0;
  const mutableGuard = guard({
    marker: undefined,
  });
  delete mutableGuard.marker;
  mutableGuard.open = async function open() {
    originalGuardOpens += 1;
    assert.equal(this.open, open);
    return {
      binding: {},
      async evidence() { return evidence(); },
      async close() {},
    };
  };
  let nextId = 0;
  const options = {
    startUrl: START_URL,
    networkGuard: mutableGuard,
    async createContext() { originalContextCreates += 1; return driver(); },
    idFactory() { return `fixed-${++nextId}`; },
  };
  const provider = createIsolatedBrowserProvider(options);
  options.createContext = async () => { throw new Error("mutated secret"); };
  options.idFactory = () => "mutated";
  mutableGuard.open = async () => { throw new Error("mutated guard secret"); };
  mutableGuard.enforcement.dns = "first-address";

  const state = await opened(provider);
  const prepared = await prepare(state);
  assert.equal(prepared.preparedActionId, "fixed-1");
  assert.equal(originalGuardOpens, 1);
  assert.equal(originalContextCreates, 1);
});

test("only isolated-browser sessions are accepted", async () => {
  const provider = adapter();
  const signal = new AbortController().signal;
  const vmPolicy = policy({ environment: "isolated-vm" });
  await assert.rejects(provider.createSession(sessionRequest("isolated-vm", vmPolicy), { signal }), hasCode(COMPUTER_USE_ERROR_CODES.POLICY_INVALID));
  const hostPolicy = { ...policy(), environment: "host-desktop" };
  await assert.rejects(provider.createSession(sessionRequest("host-desktop", hostPolicy), { signal }), hasCode(COMPUTER_USE_ERROR_CODES.HOST_DESKTOP_REJECTED));
});

test("guard authorizes the normalized fixed URL before context creation and owns private/IP/redirect denial", async () => {
  const order = [];
  const rejecting = (code) => guard({
    async open(request) {
      order.push(`guard:${request.startUrl}`);
      throw new ComputerUseError(code, "untrusted URL detail must not escape");
    },
  });
  for (const code of [
    COMPUTER_USE_ERROR_CODES.DOMAIN_NOT_ALLOWED,
    COMPUTER_USE_ERROR_CODES.NETWORK_ADDRESS_REJECTED,
    COMPUTER_USE_ERROR_CODES.REDIRECT_LIMIT_EXCEEDED,
  ]) {
    order.length = 0;
    const provider = adapter({
      networkGuard: rejecting(code),
      async createContext() { order.push("context"); return driver(); },
    });
    await assert.rejects(provider.createSession(sessionRequest(), { signal: new AbortController().signal }), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.message, code);
      return true;
    });
    assert.deepEqual(order, [`guard:${START_URL}`]);
  }

  const privateUrl = "http://127.0.0.1/";
  const privatePolicy = {
    ...policy(),
    allowDomains: ["127.0.0.1"],
    developmentMode: true,
    allowPrivateDomains: true,
  };
  let privateGuardCalls = 0;
  const privateProvider = adapter({
    startUrl: privateUrl,
    networkGuard: guard({
      async open({ startUrl }) {
        privateGuardCalls += 1;
        assert.equal(startUrl, privateUrl);
        throw new ComputerUseError(COMPUTER_USE_ERROR_CODES.NETWORK_ADDRESS_REJECTED);
      },
    }),
  });
  await assert.rejects(
    privateProvider.createSession(sessionRequest("isolated-browser", privatePolicy), { signal: new AbortController().signal }),
    hasCode(COMPUTER_USE_ERROR_CODES.NETWORK_ADDRESS_REJECTED),
  );
  assert.equal(privateGuardCalls, 1);
});

test("late guard/context acquisition is quarantined and force-closed after abort", async () => {
  let releaseGuard;
  let lateGuardCloses = 0;
  let contextCalls = 0;
  const guardPending = new Promise((resolve) => { releaseGuard = resolve; });
  const lateGuardProvider = adapter({
    networkGuard: guard({ async open() { return guardPending; } }),
    async createContext() { contextCalls += 1; return driver(); },
  });
  const firstAbort = new AbortController();
  const firstCreate = lateGuardProvider.createSession(sessionRequest(), { signal: firstAbort.signal });
  firstAbort.abort();
  await assert.rejects(firstCreate, hasCode(COMPUTER_USE_ERROR_CODES.CANCELLED));
  releaseGuard({
    binding: {},
    async evidence() { return evidence(); },
    async close() { lateGuardCloses += 1; },
    invalid: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lateGuardCloses, 1);
  assert.equal(contextCalls, 0);

  let releaseContext;
  let lateDriverCloses = 0;
  let currentGuardCloses = 0;
  const contextPending = new Promise((resolve) => { releaseContext = resolve; });
  const lateContextProvider = adapter({
    networkGuard: guard({ session: { async close() { currentGuardCloses += 1; } } }),
    async createContext() { return contextPending; },
  });
  const secondAbort = new AbortController();
  const secondCreate = lateContextProvider.createSession(sessionRequest(), { signal: secondAbort.signal });
  await new Promise((resolve) => setImmediate(resolve));
  secondAbort.abort();
  await assert.rejects(secondCreate, hasCode(COMPUTER_USE_ERROR_CODES.CANCELLED));
  releaseContext({ ...driver({ async close() { lateDriverCloses += 1; } }), invalid: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(currentGuardCloses, 1);
  assert.equal(lateDriverCloses, 1);
});

test("unknown driver capabilities and observation/result fields fail closed", async () => {
  const signal = new AbortController().signal;
  let invalidDriverCloses = 0;
  let invalidGuardCloses = 0;
  const extraCapability = adapter({
    networkGuard: guard({ session: { async close() { invalidGuardCloses += 1; } } }),
    async createContext() {
      return { ...driver({ async close() { invalidDriverCloses += 1; } }), evaluate: async () => {} };
    },
  });
  await assert.rejects(extraCapability.createSession(sessionRequest(), { signal }), hasCode(COMPUTER_USE_ERROR_CODES.PROVIDER_INVALID));
  assert.equal(invalidDriverCloses, 1);
  assert.equal(invalidGuardCloses, 1);

  let invalidGuardSurfaceCloses = 0;
  let invalidGuardContextCalls = 0;
  const invalidGuardSurface = adapter({
    networkGuard: guard({
      async open() {
        return { binding: {}, async evidence() { return evidence(); }, async close() { invalidGuardSurfaceCloses += 1; }, extra: true };
      },
    }),
    async createContext() { invalidGuardContextCalls += 1; return driver(); },
  });
  await assert.rejects(invalidGuardSurface.createSession(sessionRequest(), { signal }), hasCode(COMPUTER_USE_ERROR_CODES.PROVIDER_INVALID));
  assert.equal(invalidGuardSurfaceCloses, 1);
  assert.equal(invalidGuardContextCalls, 0);

  const extraObservation = adapter({
    async createContext() {
      return driver({ async observe() { return { screenshot: new Uint8Array(), url: START_URL, documentToken: "document-1", page: {} }; } });
    },
  });
  const observationHandle = await extraObservation.createSession(sessionRequest(), { signal });
  await assert.rejects(extraObservation.observe(observationHandle, { signal }), hasCode(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR));

  const extraResult = adapter({ async createContext() { return driver({ async screenshot() { return { resultCode: "OK", raw: "secret" }; } }); } });
  const state = await opened(extraResult);
  const prepared = await prepare(state);
  await assert.rejects(extraResult.execute(state.handle, commitRequest(state, prepared), { signal }), hasCode(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR));
});

test("prepare has no driver side effects and commit maps the closed action set", async () => {
  const calls = [];
  const methods = ["screenshot", "click", "doubleClick", "drag", "move", "scroll", "typeText", "pressKeys", "wait"];
  const actions = [
    { type: "screenshot" },
    { type: "click", x: 1, y: 2 },
    { type: "double-click", x: 1, y: 2, button: "right" },
    { type: "drag", startX: 1, startY: 2, endX: 3, endY: 4 },
    { type: "move", x: 1, y: 2 },
    { type: "scroll", deltaX: 0, deltaY: 3 },
    { type: "type", text: "not-logged" },
    { type: "key", keys: ["CTRL", "A"] },
    { type: "wait", durationMs: 1 },
  ];
  let currentDocument = 0;
  const context = driver(Object.fromEntries(methods.map((method) => [method, async (request) => {
    calls.push({ method, request });
    return { resultCode: "OK" };
  }])));
  context.observe = async () => ({ screenshot: new Uint8Array(), url: START_URL, documentToken: `document-${++currentDocument}` });
  const provider = adapter({ async createContext() { return context; } });
  const signal = new AbortController().signal;
  const handle = await provider.createSession(sessionRequest(), { signal });
  for (let index = 0; index < actions.length; index += 1) {
    const observation = await provider.observe(handle, { signal });
    const action = actions[index];
    const prepared = await provider.execute(handle, { phase: "prepare", step: index + 1, observationDigest: observation.observationDigest, action }, { signal });
    assert.equal(calls.length, index);
    await provider.execute(handle, {
      phase: "commit",
      preparedActionId: prepared.preparedActionId,
      step: index + 1,
      observationDigest: observation.observationDigest,
      actionDigest: await actionDigest(action),
      action,
      approvals: [],
    }, { signal });
  }
  assert.deepEqual(calls.map((entry) => entry.method), methods);
  assert.equal(calls.every((entry, index) => entry.request.documentToken === `document-${index + 1}`), true);
});

test("controller never commits a high-impact action before explicit approval", async () => {
  let releaseApproval;
  let commitCalls = 0;
  const approvalStarted = new Promise((resolve) => {
    releaseApproval = () => resolve({ approved: true, approvalId: "approval-1" });
  });
  const provider = adapter({ async createContext() { return driver({ async click() { commitCalls += 1; return { resultCode: "OK" }; } }); } });
  let controllerId = 0;
  const controller = createComputerUseController({
    provider,
    policy: { allowDomains: ["example.com"], maxRedirects: 4, stepDeadlineMs: 1_000, totalDeadlineMs: 5_000 },
    approval: async () => approvalStarted,
    idFactory: () => `controller-${++controllerId}`,
  });
  const session = await controller.createSession();
  const observation = await controller.observe(session.sessionId);
  const execution = controller.execute(session.sessionId, {
    step: 1,
    observationDigest: observation.observationDigest,
    action: { type: "click", x: 1, y: 2 },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(commitCalls, 0);
  releaseApproval();
  assert.equal((await execution).resultCode, "OK");
  assert.equal(commitCalls, 1);
});

test("prepared records bind session, step, observation, document and canonical action, then consume once", async () => {
  const state = await opened();
  const prepared = await prepare(state, { type: "scroll", deltaX: 0, deltaY: 2 });
  const other = await opened(state.provider);
  await assert.rejects(state.provider.execute(other.handle, commitRequest(other, prepared), { signal: other.signal }), hasCode(COMPUTER_USE_ERROR_CODES.STEP_REPLAYED));
  await assert.rejects(state.provider.execute(state.handle, commitRequest(state, prepared, { step: 2 }), { signal: state.signal }), hasCode(COMPUTER_USE_ERROR_CODES.STEP_INVALID));
  await assert.rejects(state.provider.execute(state.handle, commitRequest(state, prepared, { observationDigest: "f".repeat(64) }), { signal: state.signal }), hasCode(COMPUTER_USE_ERROR_CODES.OBSERVATION_STALE));
  await assert.rejects(state.provider.execute(state.handle, commitRequest(state, prepared, { action: { type: "scroll", deltaX: 0, deltaY: 3 } }), { signal: state.signal }), hasCode(COMPUTER_USE_ERROR_CODES.ACTION_INVALID));
  await state.provider.execute(state.handle, commitRequest(state, prepared), { signal: state.signal });
  await assert.rejects(state.provider.execute(state.handle, commitRequest(state, prepared), { signal: state.signal }), hasCode(COMPUTER_USE_ERROR_CODES.STEP_REPLAYED));

  const nextObservation = await state.provider.observe(state.handle, { signal: state.signal });
  const nextPrepared = await state.provider.execute(state.handle, {
    phase: "prepare", step: 2, observationDigest: nextObservation.observationDigest, action: { type: "screenshot" },
  }, { signal: state.signal });
  await state.provider.observe(state.handle, { signal: state.signal });
  await assert.rejects(state.provider.execute(state.handle, {
    phase: "commit", preparedActionId: nextPrepared.preparedActionId, step: 2,
    observationDigest: nextObservation.observationDigest, actionDigest: await actionDigest({ type: "screenshot" }),
    action: { type: "screenshot" }, approvals: [],
  }, { signal: state.signal }), hasCode(COMPUTER_USE_ERROR_CODES.STEP_REPLAYED));
});

test("adapter generation fences late observe, prepare, and commit state writes after close", async () => {
  let releaseObserve;
  let observeCalls = 0;
  const observePending = new Promise((resolve) => { releaseObserve = resolve; });
  const observeProvider = adapter({
    async createContext() {
      return driver({
        async observe() {
          observeCalls += 1;
          return observePending;
        },
      });
    },
  });
  const signal = new AbortController().signal;
  const observeHandle = await observeProvider.createSession(sessionRequest(), { signal });
  const lateObservation = observeProvider.observe(observeHandle, { signal });
  await new Promise((resolve) => setImmediate(resolve));
  await observeProvider.close(observeHandle, { signal });
  releaseObserve({ screenshot: new Uint8Array([1]), url: START_URL, documentToken: "late-document" });
  await assert.rejects(lateObservation, hasCode(COMPUTER_USE_ERROR_CODES.SESSION_CLOSED));
  assert.equal(observeCalls, 1);

  const prepareState = await opened();
  const latePrepare = prepareState.provider.execute(prepareState.handle, {
    phase: "prepare",
    step: 1,
    observationDigest: prepareState.observation.observationDigest,
    action: { type: "screenshot" },
  }, { signal: prepareState.signal });
  await prepareState.provider.close(prepareState.handle, { signal: prepareState.signal });
  await assert.rejects(latePrepare, hasCode(COMPUTER_USE_ERROR_CODES.SESSION_CLOSED));

  let releaseClick;
  let commitDriverCloses = 0;
  let commitGuardCloses = 0;
  const clickPending = new Promise((resolve) => { releaseClick = resolve; });
  const commitProvider = adapter({
    networkGuard: guard({ session: { async close() { commitGuardCloses += 1; } } }),
    async createContext() {
      return driver({
        async click() { return clickPending; },
        async close() { commitDriverCloses += 1; },
      });
    },
  });
  const commitState = await opened(commitProvider);
  const prepared = await prepare(commitState, { type: "click", x: 1, y: 2 });
  const committing = commitProvider.execute(commitState.handle, commitRequest(commitState, prepared), { signal: commitState.signal });
  await new Promise((resolve) => setImmediate(resolve));
  await commitProvider.close(commitState.handle, { signal: commitState.signal });
  releaseClick({ resultCode: "OK" });
  await assert.rejects(committing, hasCode(COMPUTER_USE_ERROR_CODES.SESSION_CLOSED));
  assert.equal(commitDriverCloses, 1);
  assert.equal(commitGuardCloses, 1);
});

test("screenshots are copied into owned buffers and policy/SAB limits fail closed", async () => {
  const source = new Uint8Array([7, 8, 9]);
  let releaseEvidence;
  const evidenceGate = new Promise((resolve) => { releaseEvidence = resolve; });
  const provider = adapter({
    networkGuard: guard({ session: { async evidence() { await evidenceGate; return evidence(); } } }),
    async createContext() { return driver({ async observe() { return { screenshot: source, url: START_URL, documentToken: "document-1" }; } }); },
  });
  const signal = new AbortController().signal;
  const handle = await provider.createSession(sessionRequest(), { signal });
  const observing = provider.observe(handle, { signal });
  await new Promise((resolve) => setImmediate(resolve));
  source[0] = 99;
  releaseEvidence();
  const observation = await observing;
  assert.deepEqual([...observation.screenshot], [7, 8, 9]);

  const tooLarge = adapter({ async createContext() { return driver({ async observe() { return { screenshot: new Uint8Array(5), url: START_URL, documentToken: "document-1" }; } }); } });
  const limitedPolicy = policy({ maxScreenshotBytes: 4 });
  const limitedHandle = await tooLarge.createSession(sessionRequest("isolated-browser", limitedPolicy), { signal });
  await assert.rejects(tooLarge.observe(limitedHandle, { signal }), hasCode(COMPUTER_USE_ERROR_CODES.SCREENSHOT_TOO_LARGE));

  if (typeof SharedArrayBuffer === "function") {
    const shared = adapter({ async createContext() { return driver({ async observe() { return { screenshot: new Uint8Array(new SharedArrayBuffer(4)), url: START_URL, documentToken: "document-1" }; } }); } });
    const sharedHandle = await shared.createSession(sessionRequest(), { signal });
    await assert.rejects(shared.observe(sharedHandle, { signal }), hasCode(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR));
  }
});

test("abort/deadline during commit poisons and force-closes context and guard", async () => {
  let driverCloseCalls = 0;
  let guardCloseCalls = 0;
  let clickSignal;
  const clickStarted = new Promise((resolve) => {
    clickSignal = resolve;
  });
  const provider = adapter({
    networkGuard: guard({ session: { async close() { guardCloseCalls += 1; } } }),
    async createContext() {
      return driver({
        async click(_request, { signal }) {
          clickSignal(signal);
          return new Promise(() => {});
        },
        async close() { driverCloseCalls += 1; },
      });
    },
  });
  let controllerId = 0;
  const controller = createComputerUseController({
    provider,
    policy: { allowDomains: ["example.com"], maxRedirects: 4, stepDeadlineMs: 30, totalDeadlineMs: 500 },
    approval: async () => ({ approved: true, approvalId: "approval-1" }),
    idFactory: () => `controller-${++controllerId}`,
  });
  const session = await controller.createSession();
  const observation = await controller.observe(session.sessionId);
  const execution = controller.execute(session.sessionId, {
    step: 1, observationDigest: observation.observationDigest, action: { type: "click", x: 1, y: 2 },
  });
  const internalSignal = await clickStarted;
  await assert.rejects(execution, hasCode(COMPUTER_USE_ERROR_CODES.STEP_DEADLINE_EXCEEDED));
  assert.equal(internalSignal.aborted, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(driverCloseCalls, 1);
  assert.equal(guardCloseCalls, 1);
  await assert.rejects(controller.observe(session.sessionId), hasCode(COMPUTER_USE_ERROR_CODES.SESSION_CLOSED));
});

test("close is idempotent, releases both resources, and retains a retryable failure tombstone", async () => {
  let driverCloses = 0;
  let guardCloses = 0;
  const provider = adapter({
    networkGuard: guard({ session: { async close() { guardCloses += 1; if (guardCloses === 1) throw new Error("secret path"); } } }),
    async createContext() { return driver({ async close() { driverCloses += 1; } }); },
  });
  const signal = new AbortController().signal;
  const handle = await provider.createSession(sessionRequest(), { signal });
  await assert.rejects(provider.close(handle, { signal }), (error) => {
    assert.equal(error.code, COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR);
    assert.doesNotMatch(String(error), /secret path/u);
    return true;
  });
  assert.equal(driverCloses, 1);
  assert.equal(guardCloses, 1);
  await Promise.all([provider.close(handle, { signal }), provider.close(handle, { signal })]);
  await provider.close(handle, { signal: AbortSignal.abort() });
  assert.equal(driverCloses, 1);
  assert.equal(guardCloses, 2);

  let time = 1_000;
  let reapGuardCloses = 0;
  const reapProvider = adapter({
    networkGuard: guard({ session: { async close() { reapGuardCloses += 1; if (reapGuardCloses === 1) throw new Error("retry"); } } }),
  });
  let controllerId = 0;
  const controller = createComputerUseController({
    provider: reapProvider,
    policy: { allowDomains: ["example.com"], maxRedirects: 4, stepDeadlineMs: 10, totalDeadlineMs: 10 },
    clock: () => time,
    idFactory: () => `reap-${++controllerId}`,
  });
  await controller.createSession();
  time = 1_011;
  assert.equal(await controller.reap(), 0);
  assert.equal(await controller.reap(), 1);
  assert.equal(reapGuardCloses, 2);
});

test("first close permanently shuts admission and never releases guard before driver confirms close", async () => {
  const order = [];
  let driverCloses = 0;
  let guardCloses = 0;
  const provider = adapter({
    networkGuard: guard({ session: { async close() { guardCloses += 1; order.push("guard"); } } }),
    async createContext() {
      return driver({
        async close() {
          driverCloses += 1;
          order.push(`driver-${driverCloses}`);
          if (driverCloses === 1) throw new Error("transient driver close");
        },
      });
    },
  });
  const state = await opened(provider);
  await assert.rejects(provider.close(state.handle, { signal: state.signal }), hasCode(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR));
  assert.equal(driverCloses, 1);
  assert.equal(guardCloses, 0);
  await assert.rejects(provider.observe(state.handle, { signal: state.signal }), hasCode(COMPUTER_USE_ERROR_CODES.SESSION_CLOSED));
  await assert.rejects(provider.execute(state.handle, {
    phase: "prepare", step: 1, observationDigest: state.observation.observationDigest, action: { type: "screenshot" },
  }, { signal: state.signal }), hasCode(COMPUTER_USE_ERROR_CODES.SESSION_CLOSED));
  await provider.close(state.handle, { signal: state.signal });
  assert.deepEqual(order, ["driver-1", "driver-2", "guard"]);
  assert.equal(guardCloses, 1);
});

test("invalid, late-invalid, and partial acquisitions retain transient cleanup failures for explicit reap", async () => {
  const signal = new AbortController().signal;

  let invalidDriverCloses = 0;
  let invalidGuardCloses = 0;
  const invalidProvider = adapter({
    networkGuard: guard({ session: { async close() { invalidGuardCloses += 1; } } }),
    async createContext() {
      return {
        ...driver({
          async close() {
            invalidDriverCloses += 1;
            if (invalidDriverCloses === 1) throw new Error("transient invalid close");
          },
        }),
        invalid: true,
      };
    },
  });
  await assert.rejects(invalidProvider.createSession(sessionRequest(), { signal }), hasCode(COMPUTER_USE_ERROR_CODES.PROVIDER_INVALID));
  assert.equal(invalidDriverCloses, 1);
  assert.equal(invalidGuardCloses, 0);
  assert.deepEqual(await invalidProvider.reapQuarantine(), { remaining: 0, closed: 1 });
  assert.equal(invalidDriverCloses, 2);
  assert.equal(invalidGuardCloses, 1);

  let releaseLate;
  let lateCloses = 0;
  const latePending = new Promise((resolve) => { releaseLate = resolve; });
  const lateProvider = adapter({ networkGuard: guard({ async open() { return latePending; } }) });
  const lateAbort = new AbortController();
  const lateCreate = lateProvider.createSession(sessionRequest(), { signal: lateAbort.signal });
  lateAbort.abort();
  await assert.rejects(lateCreate, hasCode(COMPUTER_USE_ERROR_CODES.CANCELLED));
  releaseLate({
    binding: {},
    async evidence() { return evidence(); },
    async close() {
      lateCloses += 1;
      if (lateCloses === 1) throw new Error("transient late close");
    },
    invalid: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lateCloses, 1);
  assert.deepEqual(await lateProvider.reapQuarantine(), { remaining: 0, closed: 1 });
  assert.equal(lateCloses, 2);

  let releaseLateContext;
  let lateContextDriverCloses = 0;
  let lateContextGuardCloses = 0;
  const lateContextPending = new Promise((resolve) => { releaseLateContext = resolve; });
  const lateContextProvider = adapter({
    networkGuard: guard({ session: { async close() { lateContextGuardCloses += 1; } } }),
    async createContext() { return lateContextPending; },
  });
  const lateContextAbort = new AbortController();
  const lateContextCreate = lateContextProvider.createSession(sessionRequest(), { signal: lateContextAbort.signal });
  await new Promise((resolve) => setImmediate(resolve));
  lateContextAbort.abort();
  await assert.rejects(lateContextCreate, hasCode(COMPUTER_USE_ERROR_CODES.CANCELLED));
  assert.equal(lateContextGuardCloses, 0);
  releaseLateContext({
    ...driver({
      async close() {
        lateContextDriverCloses += 1;
        if (lateContextDriverCloses === 1) throw new Error("transient late context close");
      },
    }),
    invalid: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lateContextDriverCloses, 1);
  assert.equal(lateContextGuardCloses, 0);
  assert.deepEqual(await lateContextProvider.reapQuarantine(), { remaining: 0, closed: 1 });
  assert.equal(lateContextDriverCloses, 2);
  assert.equal(lateContextGuardCloses, 1);

  let partialGuardCloses = 0;
  const partialProvider = adapter({
    networkGuard: guard({ session: { async close() { partialGuardCloses += 1; if (partialGuardCloses === 1) throw new Error("transient partial close"); } } }),
    async createContext() { throw new Error("context creation failed"); },
  });
  await assert.rejects(partialProvider.createSession(sessionRequest(), { signal }), hasCode(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR));
  assert.equal(partialGuardCloses, 1);
  assert.deepEqual(await partialProvider.reapQuarantine(), { remaining: 0, closed: 1 });
  assert.equal(partialGuardCloses, 2);
  assert.deepEqual(await partialProvider.reapQuarantine(), { remaining: 0, closed: 0 });
  await assert.rejects(partialProvider.reapQuarantine({ signal: AbortSignal.abort() }), hasCode(COMPUTER_USE_ERROR_CODES.CANCELLED));
});

test("shared invalid driver keeps both acquisition records and closes each distinct guard in order", async () => {
  let driverCloses = 0;
  let driverConfirmedClosed = false;
  const guardCloses = [0, 0];
  const sharedDriver = {
    ...driver({
      async close() {
        driverCloses += 1;
        if (driverCloses < 2) throw new Error("transient shared driver close");
        driverConfirmedClosed = true;
      },
    }),
    invalid: true,
  };
  let guardIndex = 0;
  const sharedProvider = adapter({
    networkGuard: guard({
      async open() {
        const index = guardIndex;
        guardIndex += 1;
        return {
          binding: { index },
          async evidence() { return evidence(); },
          async close() {
            assert.equal(driverConfirmedClosed, true);
            guardCloses[index] += 1;
          },
        };
      },
    }),
    async createContext() { return sharedDriver; },
  });
  const signal = new AbortController().signal;
  await assert.rejects(sharedProvider.createSession(sessionRequest(), { signal }), hasCode(COMPUTER_USE_ERROR_CODES.PROVIDER_INVALID));
  await assert.rejects(sharedProvider.createSession(sessionRequest(), { signal }), hasCode(COMPUTER_USE_ERROR_CODES.SESSION_CLOSED));
  assert.equal(driverCloses, 1);
  assert.deepEqual(guardCloses, [0, 0]);
  const results = await Promise.all([sharedProvider.reapQuarantine(), sharedProvider.reapQuarantine()]);
  assert.equal(driverCloses, 2);
  assert.deepEqual(guardCloses, [1, 1]);
  assert.equal(results.some((result) => result.remaining === 0), true);
  assert.deepEqual(await sharedProvider.reapQuarantine(), { remaining: 0, closed: 0 });
});

test("shared guard waits for both abort-late context drivers and concurrent reap closes it once", async () => {
  const sharedGuard = {
    binding: {},
    async evidence() { return evidence(); },
    async close() {
      assert.equal(driverCloses[0], 1);
      assert.equal(driverCloses[1], 1);
      guardCloses += 1;
    },
  };
  const releases = [];
  const driverCloses = [0, 0];
  let guardCloses = 0;
  let contextIndex = 0;
  const provider = adapter({
    networkGuard: guard({ async open() { return sharedGuard; } }),
    async createContext() {
      const index = contextIndex;
      contextIndex += 1;
      return new Promise((resolve) => { releases[index] = resolve; });
    },
  });
  const aborts = [new AbortController(), new AbortController()];
  const creates = aborts.map((abort) => provider.createSession(sessionRequest(), { signal: abort.signal }));
  await new Promise((resolve) => setImmediate(resolve));
  aborts.forEach((abort) => abort.abort());
  await Promise.all(creates.map((created) => assert.rejects(created, hasCode(COMPUTER_USE_ERROR_CODES.CANCELLED))));
  releases.forEach((release, index) => release({
    ...driver({ async close() { driverCloses[index] += 1; } }),
    invalid: true,
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(driverCloses, [1, 1]);
  assert.equal(guardCloses, 1);
  await Promise.all([provider.reapQuarantine(), provider.reapQuarantine()]);
  assert.equal(guardCloses, 1);
  assert.deepEqual(await provider.reapQuarantine(), { remaining: 0, closed: 0 });
});

test("global resource blockers prevent a deferred guard shared as another acquisition driver from closing early", async () => {
  let sharedRawCloses = 0;
  let secondGuardCloses = 0;
  let lateDriverCloses = 0;
  const sharedRaw = {
    binding: {},
    async evidence() { return evidence(); },
    async close() {
      assert.equal(lateDriverCloses, 1);
      sharedRawCloses += 1;
    },
  };
  const secondGuard = {
    binding: {},
    async evidence() { return evidence(); },
    async close() {
      assert.equal(sharedRawCloses, 1);
      secondGuardCloses += 1;
    },
  };
  let guardOpens = 0;
  let contextCreates = 0;
  let releaseLateDriver;
  const lateDriverPending = new Promise((resolve) => { releaseLateDriver = resolve; });
  const provider = adapter({
    networkGuard: guard({ async open() { return guardOpens++ === 0 ? sharedRaw : secondGuard; } }),
    async createContext() { return contextCreates++ === 0 ? lateDriverPending : sharedRaw; },
  });
  const abort = new AbortController();
  const firstCreate = provider.createSession(sessionRequest(), { signal: abort.signal });
  await new Promise((resolve) => setImmediate(resolve));
  abort.abort();
  await assert.rejects(firstCreate, hasCode(COMPUTER_USE_ERROR_CODES.CANCELLED));

  const signal = new AbortController().signal;
  await assert.rejects(provider.createSession(sessionRequest(), { signal }), hasCode(COMPUTER_USE_ERROR_CODES.SESSION_CLOSED));
  assert.equal(sharedRawCloses, 0);
  assert.equal(secondGuardCloses, 0);

  releaseLateDriver({
    ...driver({ async close() { lateDriverCloses += 1; } }),
    invalid: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lateDriverCloses, 1);
  assert.equal(sharedRawCloses, 1);
  assert.equal(secondGuardCloses, 0);
  await provider.reapQuarantine();
  assert.equal(sharedRawCloses, 1);
  assert.equal(secondGuardCloses, 1);
  assert.deepEqual(await provider.reapQuarantine(), { remaining: 0, closed: 0 });
});

test("callable raw close is supported and transient descriptor traps stay sanitized and retryable", async () => {
  let callableCloses = 0;
  let callableGuardCloses = 0;
  const callableTarget = function callableTarget() {};
  Object.defineProperty(callableTarget, "close", {
    value: async () => { callableCloses += 1; },
    enumerable: true,
    configurable: true,
  });
  const callableRaw = new Proxy(callableTarget, {});
  const callableProvider = adapter({
    networkGuard: guard({ session: { async close() { callableGuardCloses += 1; } } }),
    async createContext() { return callableRaw; },
  });
  await assert.rejects(
    callableProvider.createSession(sessionRequest(), { signal: new AbortController().signal }),
    hasCode(COMPUTER_USE_ERROR_CODES.PROVIDER_INVALID),
  );
  assert.equal(callableCloses, 1);
  assert.equal(callableGuardCloses, 1);
  assert.deepEqual(await callableProvider.reapQuarantine(), { remaining: 0, closed: 0 });

  let trapEnabled = true;
  let trappedCloses = 0;
  let trappedGuardCloses = 0;
  const trappedTarget = function trappedTarget() {};
  Object.defineProperty(trappedTarget, "close", {
    value: async () => { trappedCloses += 1; },
    enumerable: true,
    configurable: true,
  });
  const trappedRaw = new Proxy(trappedTarget, {
    ownKeys(target) {
      if (trapEnabled) throw new Error("descriptor-secret");
      return Reflect.ownKeys(target);
    },
  });
  const trappedProvider = adapter({
    networkGuard: guard({ session: { async close() { trappedGuardCloses += 1; } } }),
    async createContext() { return trappedRaw; },
  });
  await assert.rejects(
    trappedProvider.createSession(sessionRequest(), { signal: new AbortController().signal }),
    (error) => {
      assert.equal(error.code, COMPUTER_USE_ERROR_CODES.PROVIDER_INVALID);
      assert.doesNotMatch(String(error), /descriptor-secret/u);
      assert.equal(error.cause, undefined);
      return true;
    },
  );
  assert.deepEqual(await trappedProvider.reapQuarantine(), { remaining: 1, closed: 0 });
  assert.equal(trappedCloses, 0);
  assert.equal(trappedGuardCloses, 0);
  trapEnabled = false;
  assert.deepEqual(await trappedProvider.reapQuarantine(), { remaining: 0, closed: 1 });
  assert.equal(trappedCloses, 1);
  assert.equal(trappedGuardCloses, 1);

  let retryCloses = 0;
  let replacementCloses = 0;
  const retryTarget = function retryTarget() {};
  Object.defineProperty(retryTarget, "close", {
    value: async () => {
      retryCloses += 1;
      if (retryCloses === 1) {
        Object.defineProperty(retryTarget, "close", {
          value: async () => { replacementCloses += 1; },
          enumerable: true,
          configurable: true,
        });
        throw new Error("retry callable");
      }
    },
    enumerable: true,
    configurable: true,
  });
  const retryProvider = adapter({ async createContext() { return new Proxy(retryTarget, {}); } });
  await assert.rejects(retryProvider.createSession(sessionRequest(), { signal: new AbortController().signal }), hasCode(COMPUTER_USE_ERROR_CODES.PROVIDER_INVALID));
  assert.equal(retryCloses, 1);
  assert.deepEqual(await retryProvider.reapQuarantine(), { remaining: 0, closed: 1 });
  assert.equal(retryCloses, 2);
  assert.equal(replacementCloses, 0);
});

test("one raw descriptor snapshot binds validation and canonical close while identity drift is rejected", async () => {
  let descriptorEnumerations = 0;
  let validatedCloses = 0;
  let alternateCloses = 0;
  const validatedClose = async () => { validatedCloses += 1; };
  const alternateClose = async () => { alternateCloses += 1; };
  const alternatingTarget = driver({ close: validatedClose });
  const alternatingDriver = new Proxy(alternatingTarget, {
    ownKeys(target) {
      descriptorEnumerations += 1;
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (key !== "close") return descriptor;
      return { ...descriptor, value: descriptorEnumerations === 1 ? validatedClose : alternateClose };
    },
  });
  const alternatingProvider = adapter({ async createContext() { return alternatingDriver; } });
  const signal = new AbortController().signal;
  const alternatingHandle = await alternatingProvider.createSession(sessionRequest(), { signal });
  await alternatingProvider.close(alternatingHandle, { signal });
  assert.equal(descriptorEnumerations, 1);
  assert.equal(validatedCloses, 1);
  assert.equal(alternateCloses, 0);

  let firstGuardCloses = 0;
  let driftedGuardCloses = 0;
  let contextCreates = 0;
  const firstGuardClose = async () => { firstGuardCloses += 1; };
  const driftedGuardClose = async () => { driftedGuardCloses += 1; };
  const sharedGuard = {
    binding: {},
    async evidence() { return evidence(); },
    close: firstGuardClose,
  };
  const driftProvider = adapter({
    networkGuard: guard({ async open() { return sharedGuard; } }),
    async createContext() { contextCreates += 1; return driver(); },
  });
  const firstHandle = await driftProvider.createSession(sessionRequest(), { signal });
  sharedGuard.close = driftedGuardClose;
  await assert.rejects(
    driftProvider.createSession(sessionRequest(), { signal }),
    hasCode(COMPUTER_USE_ERROR_CODES.PROVIDER_INVALID),
  );
  assert.equal(contextCreates, 1);
  await driftProvider.close(firstHandle, { signal });
  assert.equal(firstGuardCloses, 1);
  assert.equal(driftedGuardCloses, 0);
});

test("resource leases reject closing identities before context creation and preserve live shared claims", async () => {
  let sharedDriverCloses = 0;
  let firstGuardCloses = 0;
  let secondGuardCloses = 0;
  let contextCreates = 0;
  let releaseClosingDriver;
  const closingDriverPending = new Promise((resolve) => { releaseClosingDriver = resolve; });
  const sharedDriver = driver({
    async close() {
      sharedDriverCloses += 1;
      if (sharedDriverCloses === 1) throw new Error("transient close");
      await closingDriverPending;
    },
  });
  const firstGuard = { binding: {}, async evidence() { return evidence(); }, async close() { firstGuardCloses += 1; } };
  const secondGuard = { binding: {}, async evidence() { return evidence(); }, async close() { secondGuardCloses += 1; } };
  let opens = 0;
  const provider = adapter({
    networkGuard: guard({
      async open() {
        const index = opens++;
        if (index === 0) return firstGuard;
        if (index === 1) return sharedDriver;
        return secondGuard;
      },
    }),
    async createContext() { contextCreates += 1; return sharedDriver; },
  });
  const state = await opened(provider);
  await assert.rejects(provider.close(state.handle, { signal: state.signal }), hasCode(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR));
  const retryClose = provider.close(state.handle, { signal: state.signal });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(provider.createSession(sessionRequest(), { signal: state.signal }), hasCode(COMPUTER_USE_ERROR_CODES.SESSION_CLOSED));
  assert.equal(contextCreates, 1);
  assert.equal(firstGuardCloses, 0);
  await assert.rejects(provider.createSession(sessionRequest(), { signal: state.signal }), hasCode(COMPUTER_USE_ERROR_CODES.SESSION_CLOSED));
  assert.equal(contextCreates, 2);
  releaseClosingDriver();
  await retryClose;
  assert.equal(sharedDriverCloses, 2);
  assert.equal(firstGuardCloses, 1);
  assert.equal(secondGuardCloses, 0);
  await provider.reapQuarantine();
  assert.equal(secondGuardCloses, 1);

  let liveDriverCloses = 0;
  const liveRaw = driver({ async close() { liveDriverCloses += 1; } });
  let liveContextCalls = 0;
  const liveGuards = [
    { binding: {}, async evidence() { return evidence(); }, async close() {} },
    { binding: {}, async evidence() { return evidence(); }, async close() { secondGuardCloses += 1; } },
  ];
  let liveGuardIndex = 0;
  const liveProvider = adapter({
    networkGuard: guard({ async open() { return liveGuards[liveGuardIndex++]; } }),
    async createContext() {
      liveContextCalls += 1;
      if (liveContextCalls === 2) liveRaw.invalid = true;
      return liveRaw;
    },
  });
  const live = await opened(liveProvider);
  await assert.rejects(liveProvider.createSession(sessionRequest(), { signal: live.signal }), hasCode(COMPUTER_USE_ERROR_CODES.PROVIDER_INVALID));
  assert.equal(liveDriverCloses, 0);
  delete liveRaw.invalid;
  await liveProvider.close(live.handle, { signal: live.signal });
  assert.equal(liveDriverCloses, 1);
  await liveProvider.reapQuarantine();
  assert.equal(secondGuardCloses, 2);
});

test("two normal handles share a guard lease until both drivers are closed", async () => {
  let guardCloses = 0;
  const driverCloses = [0, 0];
  const sharedGuard = { binding: {}, async evidence() { return evidence(); }, async close() { guardCloses += 1; } };
  let driverIndex = 0;
  const provider = adapter({
    networkGuard: guard({ async open() { return sharedGuard; } }),
    async createContext() {
      const index = driverIndex++;
      return driver({ async close() { driverCloses[index] += 1; } });
    },
  });
  const first = await opened(provider);
  const secondHandle = await provider.createSession(sessionRequest(), { signal: first.signal });
  await provider.close(first.handle, { signal: first.signal });
  assert.deepEqual(driverCloses, [1, 0]);
  assert.equal(guardCloses, 0);
  await provider.close(secondHandle, { signal: first.signal });
  assert.deepEqual(driverCloses, [1, 1]);
  assert.equal(guardCloses, 1);
});

test("cross-role cycles and rawDriver===guard remain tombstoned without premature close", async () => {
  let rawCloses = 0;
  const closeRaw = async () => { rawCloses += 1; };
  const raw = { binding: {}, async evidence() { return evidence(); }, close: closeRaw };
  const provider = adapter({
    networkGuard: guard({ async open() { return raw; } }),
    async createContext() {
      delete raw.binding;
      delete raw.evidence;
      Object.assign(raw, driver({ close: closeRaw }));
      return raw;
    },
  });
  const state = await opened(provider);
  await assert.rejects(provider.close(state.handle, { signal: state.signal }), hasCode(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR));
  assert.equal(rawCloses, 0);
  assert.deepEqual(await provider.reapQuarantine(), { remaining: 1, closed: 0 });

  const closeCounts = { a: 0, b: 0 };
  const rawA = {};
  const rawB = {};
  const closeFunctions = {
    a: async () => { closeCounts.a += 1; },
    b: async () => { closeCounts.b += 1; },
  };
  const toGuard = (target, key) => {
    for (const method of ["observe", "screenshot", "click", "doubleClick", "drag", "move", "scroll", "typeText", "pressKeys", "wait"]) delete target[method];
    Object.assign(target, {
      binding: {},
      async evidence() { return evidence(); },
      close: closeFunctions[key],
    });
  };
  const toDriver = (target, key) => {
    delete target.binding;
    delete target.evidence;
    Object.assign(target, driver({ close: closeFunctions[key] }));
  };
  toGuard(rawB, "b");
  let cycleOpen = 0;
  let cycleContext = 0;
  const cycleProvider = adapter({
    networkGuard: guard({ async open() { return cycleOpen++ === 0 ? rawB : rawA; } }),
    async createContext() {
      if (cycleContext++ === 0) { toDriver(rawA, "a"); return rawA; }
      return rawB;
    },
  });
  const cycleSignal = new AbortController().signal;
  const firstHandle = await cycleProvider.createSession(sessionRequest(), { signal: cycleSignal });
  toGuard(rawA, "a");
  toDriver(rawB, "b");
  const secondHandle = await cycleProvider.createSession(sessionRequest(), { signal: cycleSignal });
  await assert.rejects(cycleProvider.close(firstHandle, { signal: cycleSignal }), hasCode(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR));
  await assert.rejects(cycleProvider.close(secondHandle, { signal: cycleSignal }), hasCode(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR));
  assert.deepEqual(closeCounts, { a: 0, b: 0 });
  assert.deepEqual(await cycleProvider.reapQuarantine(), { remaining: 2, closed: 0 });
});

test("resolve/reap races and cancellation share lifecycle promises without duplicate raw close", async () => {
  let releaseDriver;
  let driverCloses = 0;
  let guardCloses = 0;
  const pendingDriver = new Promise((resolve) => { releaseDriver = resolve; });
  const provider = adapter({
    networkGuard: guard({ session: { async close() { guardCloses += 1; } } }),
    async createContext() { return pendingDriver; },
  });
  const abort = new AbortController();
  const creating = provider.createSession(sessionRequest(), { signal: abort.signal });
  await new Promise((resolve) => setImmediate(resolve));
  abort.abort();
  await assert.rejects(creating, hasCode(COMPUTER_USE_ERROR_CODES.CANCELLED));
  releaseDriver(driver({ async close() { driverCloses += 1; } }));
  await Promise.all([provider.reapQuarantine(), provider.reapQuarantine()]);
  await new Promise((resolve) => setImmediate(resolve));
  await provider.reapQuarantine();
  assert.equal(driverCloses, 1);
  assert.equal(guardCloses, 1);

  let attempts = 0;
  let releaseRetry;
  const retryPending = new Promise((resolve) => { releaseRetry = resolve; });
  const cancellingProvider = adapter({
    async createContext() {
      return { ...driver({ async close() { attempts += 1; if (attempts === 1) throw new Error("first"); await retryPending; } }), invalid: true };
    },
  });
  await assert.rejects(cancellingProvider.createSession(sessionRequest(), { signal: new AbortController().signal }), hasCode(COMPUTER_USE_ERROR_CODES.PROVIDER_INVALID));
  const cancel = new AbortController();
  const cancelledReap = cancellingProvider.reapQuarantine({ signal: cancel.signal });
  const continuingReap = cancellingProvider.reapQuarantine();
  cancel.abort();
  await assert.rejects(cancelledReap, hasCode(COMPUTER_USE_ERROR_CODES.CANCELLED));
  releaseRetry();
  await continuingReap;
  assert.equal(attempts, 2);
  assert.deepEqual(await cancellingProvider.reapQuarantine(), { remaining: 0, closed: 0 });

  let providerCloseAttempts = 0;
  let releaseProviderClose;
  const providerClosePending = new Promise((resolve) => { releaseProviderClose = resolve; });
  const closeAndReapProvider = adapter({
    async createContext() {
      return driver({
        async close() {
          providerCloseAttempts += 1;
          if (providerCloseAttempts === 1) throw new Error("first provider close");
          await providerClosePending;
        },
      });
    },
  });
  const closeAndReapState = await opened(closeAndReapProvider);
  await assert.rejects(closeAndReapProvider.close(closeAndReapState.handle, { signal: closeAndReapState.signal }), hasCode(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR));
  const providerClose = closeAndReapProvider.close(closeAndReapState.handle, { signal: closeAndReapState.signal });
  const providerReap = closeAndReapProvider.reapQuarantine();
  releaseProviderClose();
  await Promise.all([providerClose, providerReap]);
  assert.equal(providerCloseAttempts, 2);
  assert.deepEqual(await closeAndReapProvider.reapQuarantine(), { remaining: 0, closed: 0 });
});

test("unknown fields, prototypes, accessors and malformed approval bindings are rejected", async () => {
  const state = await opened();
  const prepared = await prepare(state, { type: "click", x: 1, y: 2 });
  const inherited = Object.create({ phase: "commit" });
  await assert.rejects(state.provider.execute(state.handle, inherited, { signal: state.signal }), hasCode(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR));
  const malformed = commitRequest(state, prepared, {
    approvals: [{
      safetyCheckId: "useful.high-impact.click", source: "contract", approvalId: "approval-1",
      preparedActionId: "wrong", step: 1, observationDigest: state.observation.observationDigest,
      actionDigest: prepared.digest,
    }],
  });
  await assert.rejects(state.provider.execute(state.handle, malformed, { signal: state.signal }), hasCode(COMPUTER_USE_ERROR_CODES.APPROVAL_DENIED));
});

test("hidden/symbol action fields and Proxy traps fail with stable sanitized errors", async () => {
  const state = await opened();
  const hiddenAction = { type: "screenshot" };
  Object.defineProperty(hiddenAction, "hidden", { value: "secret-path", enumerable: false });
  await assert.rejects(state.provider.execute(state.handle, {
    phase: "prepare", step: 1, observationDigest: state.observation.observationDigest, action: hiddenAction,
  }, { signal: state.signal }), hasCode(COMPUTER_USE_ERROR_CODES.ACTION_INVALID));

  const symbolAction = { type: "screenshot", [Symbol("secret")]: true };
  await assert.rejects(state.provider.execute(state.handle, {
    phase: "prepare", step: 1, observationDigest: state.observation.observationDigest, action: symbolAction,
  }, { signal: state.signal }), hasCode(COMPUTER_USE_ERROR_CODES.ACTION_INVALID));

  const trappedAction = new Proxy({ type: "screenshot" }, {
    ownKeys() { throw new Error("proxy-secret-query"); },
  });
  await assert.rejects(state.provider.execute(state.handle, {
    phase: "prepare", step: 1, observationDigest: state.observation.observationDigest, action: trappedAction,
  }, { signal: state.signal }), (error) => {
    assert.equal(error.code, COMPUTER_USE_ERROR_CODES.ACTION_INVALID);
    assert.doesNotMatch(String(error), /proxy-secret-query/u);
    assert.equal(error.cause, undefined);
    return true;
  });

  const trappedOptions = new Proxy({
    startUrl: START_URL,
    networkGuard: guard(),
    async createContext() { return driver(); },
  }, {
    getPrototypeOf() { throw new Error("factory-proxy-secret"); },
  });
  assert.throws(() => createIsolatedBrowserProvider(trappedOptions), (error) => {
    assert.equal(error.code, COMPUTER_USE_ERROR_CODES.PROVIDER_INVALID);
    assert.doesNotMatch(String(error), /factory-proxy-secret/u);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test("descriptor snapshots never perform ordinary property gets and detached screenshots fail closed", async () => {
  let ordinaryGets = 0;
  const descriptorOnlyOptions = new Proxy({
    startUrl: START_URL,
    networkGuard: guard(),
    async createContext() { return driver(); },
    idFactory: () => "descriptor-only",
  }, {
    get() {
      ordinaryGets += 1;
      throw new Error("ordinary-get-secret");
    },
  });
  const provider = createIsolatedBrowserProvider(descriptorOnlyOptions);
  const state = await opened(provider);
  assert.equal((await prepare(state)).preparedActionId, "descriptor-only");
  assert.equal(ordinaryGets, 0);

  const detached = new ArrayBuffer(8);
  structuredClone(detached, { transfer: [detached] });
  const detachedProvider = adapter({
    async createContext() {
      return driver({
        async observe() { return { screenshot: detached, url: START_URL, documentToken: "document-1" }; },
      });
    },
  });
  const signal = new AbortController().signal;
  const handle = await detachedProvider.createSession(sessionRequest(), { signal });
  await assert.rejects(detachedProvider.observe(handle, { signal }), (error) => {
    assert.equal(error.code, COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR);
    assert.equal(error.cause, undefined);
    return true;
  });

  const trappedObservation = new Proxy({}, {
    ownKeys() { throw new Error("observation-secret"); },
  });
  const trappedProvider = adapter({ async createContext() { return driver({ async observe() { return trappedObservation; } }); } });
  const trappedHandle = await trappedProvider.createSession(sessionRequest(), { signal });
  await assert.rejects(trappedProvider.observe(trappedHandle, { signal }), (error) => {
    assert.equal(error.code, COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR);
    assert.doesNotMatch(String(error), /observation-secret/u);
    assert.equal(error.cause, undefined);
    return true;
  });
});
