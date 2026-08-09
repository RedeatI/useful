import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMPUTER_USE_ERROR_CODES,
  COMPUTER_USE_SCHEMA,
  ComputerUseError,
  assertComputerUseAction,
  createComputerUseController,
  normalizeComputerUsePolicy,
} from "../src/index.mjs";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function ids() {
  let value = 0;
  return () => `id-${++value}`;
}

function hop(url = "https://example.com/app", resolvedIps = ["93.184.216.34"]) {
  return { complete: true, hops: [{ url, resolvedIps }] };
}

function provider(overrides = {}) {
  const calls = [];
  const implementation = {
    async createSession(request, context) {
      calls.push(["create", request, context]);
      return { opaque: "provider-handle-secret" };
    },
    async observe(_handle, context) {
      calls.push(["observe", context]);
      return { observationDigest: DIGEST_A, screenshot: new Uint8Array([1, 2, 3]) };
    },
    async execute(_handle, request, context) {
      calls.push(["execute", request, context]);
      if (request.phase === "prepare") return { status: "prepared", preparedActionId: `prepared-${request.step}` };
      return { status: "executed", resultCode: "OK" };
    },
    async close(_handle, context) {
      calls.push(["close", context]);
    },
    ...overrides,
  };
  implementation.calls = calls;
  return implementation;
}

function controller(overrides = {}) {
  return createComputerUseController({
    provider: provider(),
    policy: { allowDomains: [] },
    idFactory: ids(),
    ...overrides,
  });
}

async function opened(instance) {
  const session = await instance.createSession();
  const observation = await instance.observe(session.sessionId);
  return { session, observation };
}

function hasCode(code) {
  return (error) => error instanceof ComputerUseError && error.code === code;
}

test("schema identity, disabled provider, host rejection, and closed action set are stable", async () => {
  assert.equal(COMPUTER_USE_SCHEMA, "useful.computer-use.v1");
  await assert.rejects(createComputerUseController({ idFactory: ids() }).createSession(), hasCode(COMPUTER_USE_ERROR_CODES.DISABLED));
  assert.throws(() => normalizeComputerUsePolicy({ environment: "host-desktop" }), hasCode(COMPUTER_USE_ERROR_CODES.HOST_DESKTOP_REJECTED));
  assert.throws(() => assertComputerUseAction({ type: "type", text: "x", unknown: true }), hasCode(COMPUTER_USE_ERROR_CODES.ACTION_INVALID));
});

test("observe and execute share one operation slot; close is memoized and fences late observations", async () => {
  let releaseObserve;
  let markObserveStarted;
  const observeStarted = new Promise((resolve) => { markObserveStarted = resolve; });
  let closeCalls = 0;
  const controlled = provider({
    async observe() {
      const released = new Promise((resolve) => { releaseObserve = resolve; });
      markObserveStarted();
      await released;
      return { observationDigest: DIGEST_A, screenshot: new Uint8Array([9]) };
    },
    async close() { closeCalls += 1; },
  });
  const instance = controller({ provider: controlled });
  const session = await instance.createSession();
  const observation = instance.observe(session.sessionId);
  await observeStarted;
  assert.throws(
    () => instance.execute(session.sessionId, { step: 1, observationDigest: DIGEST_A, action: { type: "screenshot" } }),
    hasCode(COMPUTER_USE_ERROR_CODES.CONCURRENT_ACTION),
  );
  const firstClose = instance.close(session.sessionId);
  const secondClose = instance.close(session.sessionId);
  assert.strictEqual(secondClose, firstClose);
  assert.equal(await firstClose, true);
  await assert.rejects(observation, hasCode(COMPUTER_USE_ERROR_CODES.CANCELLED));
  releaseObserve();
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(instance.observe(session.sessionId), hasCode(COMPUTER_USE_ERROR_CODES.SESSION_CLOSED));
  assert.equal(await instance.close(session.sessionId), true);
  assert.equal(closeCalls, 1);
});

test("step, observation digest, replay, concurrency, and mandatory re-observe are fail closed", async () => {
  let releasePrepare;
  let markPrepareStarted;
  const prepareStarted = new Promise((resolve) => { markPrepareStarted = resolve; });
  const controlled = provider({
    async execute(_handle, request) {
      if (request.phase === "prepare") {
        const released = new Promise((resolve) => { releasePrepare = resolve; });
        markPrepareStarted();
        await released;
        return { status: "prepared", preparedActionId: "prepared-1" };
      }
      return { status: "executed", resultCode: "OK" };
    },
  });
  const instance = controller({ provider: controlled });
  const { session, observation } = await opened(instance);
  assert.throws(() => instance.execute(session.sessionId, { step: 2, observationDigest: DIGEST_A, action: { type: "screenshot" } }), hasCode(COMPUTER_USE_ERROR_CODES.STEP_INVALID));
  assert.throws(() => instance.execute(session.sessionId, { step: 1, observationDigest: DIGEST_B, action: { type: "screenshot" } }), hasCode(COMPUTER_USE_ERROR_CODES.OBSERVATION_STALE));
  const execution = instance.execute(session.sessionId, { step: 1, observationDigest: observation.observationDigest, action: { type: "screenshot" } });
  await prepareStarted;
  await assert.rejects(instance.observe(session.sessionId), hasCode(COMPUTER_USE_ERROR_CODES.CONCURRENT_ACTION));
  releasePrepare();
  await execution;
  assert.throws(() => instance.execute(session.sessionId, { step: 1, observationDigest: DIGEST_A, action: { type: "screenshot" } }), hasCode(COMPUTER_USE_ERROR_CODES.STEP_REPLAYED));
  assert.throws(() => instance.execute(session.sessionId, { step: 2, observationDigest: DIGEST_A, action: { type: "screenshot" } }), hasCode(COMPUTER_USE_ERROR_CODES.OBSERVATION_REQUIRED));
  const next = await instance.observe(session.sessionId);
  assert.equal(next.step, 2);
});

test("every approval binds prepared action, step, observation, canonical digest, and the exact full action", async () => {
  const approvalRequests = [];
  const events = [];
  const action = { type: "type", text: "exact text visible to approver" };
  const guarded = provider({
    async execute(_handle, request) {
      if (request.phase === "prepare") {
        return {
          status: "prepared",
          preparedActionId: "prepared-1",
          safetyChecks: [{ id: "provider.check", description: "Provider risk", severity: "medium" }],
        };
      }
      assert.equal(events.at(-1).kind, "authorization");
      assert.equal(request.approvals.length, 3);
      for (const approval of request.approvals) {
        assert.equal(approval.preparedActionId, request.preparedActionId);
        assert.equal(approval.step, request.step);
        assert.equal(approval.observationDigest, request.observationDigest);
        assert.equal(approval.actionDigest, request.actionDigest);
      }
      return { status: "executed", resultCode: "TYPED" };
    },
  });
  const instance = controller({
    provider: guarded,
    approval: async (request) => {
      approvalRequests.push(request);
      return { approved: true, approvalId: `approval-${approvalRequests.length}` };
    },
    audit: async (event) => events.push(event),
  });
  const { session, observation } = await opened(instance);
  await instance.execute(session.sessionId, {
    step: 1,
    observationDigest: observation.observationDigest,
    action,
    safetyChecks: [{ id: "model.check", description: "Model risk", severity: "low" }],
  });
  assert.deepEqual(approvalRequests.map((entry) => entry.safetyCheck.source), ["model", "provider", "contract"]);
  for (const request of approvalRequests) {
    assert.equal(request.preparedActionId, "prepared-1");
    assert.equal(request.step, 1);
    assert.equal(request.observationDigest, DIGEST_A);
    assert.match(request.actionDigest, /^[a-f0-9]{64}$/u);
    assert.deepEqual(request.action, action);
  }
  assert.equal(new Set(approvalRequests.map((entry) => entry.actionDigest)).size, 1);
});

test("authorization audit is precommit; precommit failure prevents commit and postcommit failure poisons and closes", async () => {
  let precommitCalls = 0;
  const precommitProvider = provider({
    async execute(_handle, request) {
      if (request.phase === "prepare") return { status: "prepared", preparedActionId: "prepared-1" };
      precommitCalls += 1;
      return { status: "executed", resultCode: "OK" };
    },
  });
  const precommit = controller({
    provider: precommitProvider,
    audit: async (event) => { if (event.kind === "authorization") throw new Error("sink unavailable"); },
  });
  const first = await opened(precommit);
  await assert.rejects(
    precommit.execute(first.session.sessionId, { step: 1, observationDigest: first.observation.observationDigest, action: { type: "screenshot" } }),
    hasCode(COMPUTER_USE_ERROR_CODES.AUDIT_FAILED),
  );
  assert.equal(precommitCalls, 0);
  assert.equal((await precommit.observe(first.session.sessionId)).step, 2);

  let postcommitCalls = 0;
  let closeCalls = 0;
  const postcommitProvider = provider({
    async execute(_handle, request) {
      if (request.phase === "prepare") return { status: "prepared", preparedActionId: "prepared-1" };
      postcommitCalls += 1;
      return { status: "executed", resultCode: "OK" };
    },
    async close() { closeCalls += 1; },
  });
  const postcommit = controller({
    provider: postcommitProvider,
    audit: async (event) => { if (event.kind === "action") throw new Error("sink unavailable"); },
  });
  const second = await opened(postcommit);
  await assert.rejects(
    postcommit.execute(second.session.sessionId, { step: 1, observationDigest: second.observation.observationDigest, action: { type: "screenshot" } }),
    hasCode(COMPUTER_USE_ERROR_CODES.AUDIT_FAILED),
  );
  assert.equal(postcommitCalls, 1);
  assert.equal(closeCalls, 1);
  await assert.rejects(postcommit.observe(second.session.sessionId), hasCode(COMPUTER_USE_ERROR_CODES.SESSION_CLOSED));
});

test("network mode requires complete hop/IP evidence and rejects redirects, private, metadata, mapped, multicast, and foreign domains", async () => {
  const networkPolicy = { allowDomains: ["example.com"], maxRedirects: 0 };
  const missing = controller({ provider: provider(), policy: networkPolicy });
  const missingSession = await missing.createSession();
  await assert.rejects(missing.observe(missingSession.sessionId), hasCode(COMPUTER_USE_ERROR_CODES.NETWORK_EVIDENCE_REQUIRED));

  const redirected = controller({
    provider: provider({
      async observe() {
        return { observationDigest: DIGEST_A, networkEvidence: { complete: true, hops: [
          { url: "https://example.com/one", resolvedIps: ["93.184.216.34"] },
          { url: "https://example.com/two", resolvedIps: ["93.184.216.34"] },
        ] } };
      },
    }),
    policy: networkPolicy,
  });
  const redirectedSession = await redirected.createSession();
  await assert.rejects(redirected.observe(redirectedSession.sessionId), hasCode(COMPUTER_USE_ERROR_CODES.REDIRECT_LIMIT_EXCEEDED));

  for (const address of ["127.0.0.1", "169.254.169.254", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "::", "fe80::1", "fc00::1", "ff02::1"] ) {
    const blocked = controller({
      provider: provider({ async observe() { return { observationDigest: DIGEST_A, networkEvidence: hop("https://example.com", [address]) }; } }),
      policy: networkPolicy,
    });
    const blockedSession = await blocked.createSession();
    await assert.rejects(blocked.observe(blockedSession.sessionId), hasCode(COMPUTER_USE_ERROR_CODES.NETWORK_ADDRESS_REJECTED), address);
  }

  const foreign = controller({
    provider: provider({ async observe() { return { observationDigest: DIGEST_A, networkEvidence: hop("https://example.net", ["93.184.216.34"]) }; } }),
    policy: networkPolicy,
  });
  const foreignSession = await foreign.createSession();
  await assert.rejects(foreign.observe(foreignSession.sessionId), hasCode(COMPUTER_USE_ERROR_CODES.DOMAIN_NOT_ALLOWED));

  const allowed = controller({
    provider: provider({
      async observe() { return { observationDigest: DIGEST_A, networkEvidence: hop() }; },
      async execute(_handle, request) {
        if (request.phase === "prepare") return { status: "prepared", preparedActionId: "prepared-1" };
        return { status: "executed", resultCode: "OK", networkEvidence: hop() };
      },
    }),
    policy: networkPolicy,
  });
  const allowedState = await opened(allowed);
  assert.equal(allowedState.observation.domain, "example.com");
  await allowed.execute(allowedState.session.sessionId, { step: 1, observationDigest: DIGEST_A, action: { type: "screenshot" } });
});

test("deadline/cancel abort internal signals; late prepare and approval cannot commit; uncertain commit poisons", async () => {
  let releasePrepare;
  let markPrepareStarted;
  const prepareStarted = new Promise((resolve) => { markPrepareStarted = resolve; });
  let prepareCommitCalls = 0;
  const latePrepareProvider = provider({
    async execute(_handle, request, { signal }) {
      if (request.phase === "commit") { prepareCommitCalls += 1; return { status: "executed", resultCode: "OK" }; }
      const released = new Promise((resolve) => { releasePrepare = resolve; });
      markPrepareStarted(signal);
      await released;
      return { status: "prepared", preparedActionId: "prepared-1" };
    },
  });
  const latePrepare = controller({
    provider: latePrepareProvider,
    policy: { allowDomains: [], stepDeadlineMs: 30, totalDeadlineMs: 500 },
  });
  const first = await opened(latePrepare);
  const firstExecution = latePrepare.execute(first.session.sessionId, { step: 1, observationDigest: DIGEST_A, action: { type: "screenshot" } });
  const prepareSignal = await prepareStarted;
  await assert.rejects(firstExecution, hasCode(COMPUTER_USE_ERROR_CODES.STEP_DEADLINE_EXCEEDED));
  assert.equal(prepareSignal.aborted, true);
  releasePrepare();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prepareCommitCalls, 0);
  assert.equal((await latePrepare.observe(first.session.sessionId)).step, 2);

  let releaseApproval;
  let markApprovalStarted;
  const approvalStarted = new Promise((resolve) => { markApprovalStarted = resolve; });
  let approvalCommitCalls = 0;
  const lateApproval = controller({
    provider: provider({
      async execute(_handle, request) {
        if (request.phase === "prepare") return { status: "prepared", preparedActionId: "prepared-1", highImpact: true };
        approvalCommitCalls += 1;
        return { status: "executed", resultCode: "OK" };
      },
    }),
    approval: async (_request, { signal }) => {
      const released = new Promise((resolve) => { releaseApproval = resolve; });
      markApprovalStarted(signal);
      await released;
      return { approved: true, approvalId: "approval-1" };
    },
  });
  const second = await opened(lateApproval);
  const secondExecution = lateApproval.execute(second.session.sessionId, { step: 1, observationDigest: DIGEST_A, action: { type: "screenshot" } });
  const approvalSignal = await approvalStarted;
  const closing = lateApproval.close(second.session.sessionId);
  await assert.rejects(secondExecution, hasCode(COMPUTER_USE_ERROR_CODES.CANCELLED));
  assert.equal(approvalSignal.aborted, true);
  await closing;
  releaseApproval();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(approvalCommitCalls, 0);

  let releaseCommit;
  let markCommitStarted;
  const commitStarted = new Promise((resolve) => { markCommitStarted = resolve; });
  let uncertainCloseCalls = 0;
  const uncertain = controller({
    provider: provider({
      async execute(_handle, request, { signal }) {
        if (request.phase === "prepare") return { status: "prepared", preparedActionId: "prepared-1" };
        const released = new Promise((resolve) => { releaseCommit = resolve; });
        markCommitStarted(signal);
        await released;
        return { status: "executed", resultCode: "OK" };
      },
      async close() { uncertainCloseCalls += 1; },
    }),
    policy: { allowDomains: [], stepDeadlineMs: 30, totalDeadlineMs: 500 },
  });
  const third = await opened(uncertain);
  const thirdExecution = uncertain.execute(third.session.sessionId, { step: 1, observationDigest: DIGEST_A, action: { type: "screenshot" } });
  const commitSignal = await commitStarted;
  await assert.rejects(thirdExecution, hasCode(COMPUTER_USE_ERROR_CODES.STEP_DEADLINE_EXCEEDED));
  assert.equal(commitSignal.aborted, true);
  assert.equal(uncertainCloseCalls, 1);
  await assert.rejects(uncertain.observe(third.session.sessionId), hasCode(COMPUTER_USE_ERROR_CODES.SESSION_CLOSED));
  releaseCommit();
  await new Promise((resolve) => setImmediate(resolve));

  let internalSignal;
  const cancellable = controller({
    provider: provider({
      async observe(_handle, { signal }) {
        internalSignal = signal;
        if (signal.aborted) throw new Error("cancelled");
        await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
      },
    }),
  });
  const cancellableSession = await cancellable.createSession();
  const abort = new AbortController();
  const cancelledObservation = cancellable.observe(cancellableSession.sessionId, { signal: abort.signal });
  abort.abort();
  await assert.rejects(cancelledObservation, hasCode(COMPUTER_USE_ERROR_CODES.CANCELLED));
  assert.equal(internalSignal.aborted, true);

  const never = new Promise(() => {});
  const totalLimited = controller({
    provider: provider({ async observe() { return never; } }),
    policy: { allowDomains: [], stepDeadlineMs: 40, totalDeadlineMs: 40 },
  });
  const totalSession = await totalLimited.createSession();
  await assert.rejects(totalLimited.observe(totalSession.sessionId), hasCode(COMPUTER_USE_ERROR_CODES.TOTAL_DEADLINE_EXCEEDED));
});

test("audit stays metadata-only and external free text cannot enter audit identifiers", async () => {
  const events = [];
  const instance = controller({
    approval: async () => ({ approved: true, approvalId: "approval-1" }),
    audit: async (event) => events.push(event),
  });
  const { session, observation } = await opened(instance);
  await instance.execute(session.sessionId, { step: 1, observationDigest: DIGEST_A, action: { type: "type", text: "typed-token-secret" } });
  const serialized = JSON.stringify(events);
  assert.match(serialized, /"screenshotBytes":3/u);
  assert.match(serialized, /"kind":"authorization"/u);
  assert.doesNotMatch(serialized, /typed-token-secret|provider-handle-secret|\[1,2,3\]|"description"|"text"|"keys"/u);

  const invalidCheck = controller();
  const invalidCheckState = await opened(invalidCheck);
  assert.throws(
    () => invalidCheck.execute(invalidCheckState.session.sessionId, {
      step: 1,
      observationDigest: DIGEST_A,
      action: { type: "screenshot" },
      safetyChecks: [{ id: "unsafe free text", description: "not auditable", severity: "low" }],
    }),
    hasCode(COMPUTER_USE_ERROR_CODES.SAFETY_CHECK_INVALID),
  );

  const unsafe = controller({
    provider: provider({
      async execute(_handle, request) {
        if (request.phase === "prepare") return { status: "prepared", preparedActionId: "prepared-1" };
        return { status: "executed", resultCode: "free text is forbidden" };
      },
    }),
  });
  const unsafeState = await opened(unsafe);
  await assert.rejects(
    unsafe.execute(unsafeState.session.sessionId, { step: 1, observationDigest: DIGEST_A, action: { type: "screenshot" } }),
    hasCode(COMPUTER_USE_ERROR_CODES.PROVIDER_PROTOCOL_ERROR),
  );
});

test("limits apply and reap retains failed close tombstones for a later retry", async () => {
  const oversized = controller({
    provider: provider({ async observe() { return { observationDigest: DIGEST_A, screenshot: new Uint8Array(5) }; } }),
    policy: { allowDomains: [], maxScreenshotBytes: 4 },
  });
  const oversizedSession = await oversized.createSession();
  await assert.rejects(oversized.observe(oversizedSession.sessionId), hasCode(COMPUTER_USE_ERROR_CODES.SCREENSHOT_TOO_LARGE));

  const limited = controller({ policy: { allowDomains: [], maxSteps: 1 } });
  const limitedState = await opened(limited);
  await limited.execute(limitedState.session.sessionId, { step: 1, observationDigest: DIGEST_A, action: { type: "screenshot" } });
  const next = await limited.observe(limitedState.session.sessionId);
  assert.throws(() => limited.execute(limitedState.session.sessionId, { step: 2, observationDigest: next.observationDigest, action: { type: "screenshot" } }), hasCode(COMPUTER_USE_ERROR_CODES.STEP_LIMIT_EXCEEDED));

  let time = 1_000;
  let closeAttempts = 0;
  const retryable = controller({
    provider: provider({
      async close() {
        closeAttempts += 1;
        if (closeAttempts === 1) throw new Error("transient close failure");
      },
    }),
    policy: { allowDomains: [], stepDeadlineMs: 10, totalDeadlineMs: 10 },
    clock: () => time,
  });
  const retryableSession = await retryable.createSession();
  time = 1_011;
  assert.equal(await retryable.reap(), 0);
  assert.equal(closeAttempts, 1);
  assert.equal(await retryable.reap(), 1);
  assert.equal(closeAttempts, 2);
  await assert.rejects(retryable.observe(retryableSession.sessionId), hasCode(COMPUTER_USE_ERROR_CODES.SESSION_CLOSED));
});
