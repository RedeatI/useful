import { assertExecutionReceipt, utf8JsonBytes, validateValue } from "@useful/action-contract";
import { ActionExecutionError, ERROR_CODES } from "./errors.mjs";
import { ActionRegistry } from "./registry.mjs";

const nowNs = () => process.hrtime.bigint();
const elapsedMs = (started) => Number((process.hrtime.bigint() - started) / 1000000n);

function makeReceipt(descriptor, startedAt, started, status, errorCode) {
  const durationMs = elapsedMs(started);
  const receipt = {
    receiptVersion: "2.0",
    actionId: descriptor.actionId,
    actionVersion: descriptor.version,
    contractVersion: descriptor.contractVersion,
    source: structuredClone(descriptor.source),
    permissions: {
      required: [...descriptor.permissions.required],
      capabilities: [...descriptor.permissions.capabilities],
    },
    status,
    createdAt: startedAt,
    startedAt,
    completedAt: new Date(Date.parse(startedAt) + durationMs).toISOString(),
    durationMs,
    ...(errorCode ? { error: { code: errorCode } } : {}),
  };
  assertExecutionReceipt(receipt);
  return receipt;
}

function guardedCall(handler, input, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn(value);
    };
    const timer = setTimeout(() => {
      controller.abort(new ActionExecutionError(ERROR_CODES.TIMEOUT));
      settle(reject, new ActionExecutionError(ERROR_CODES.TIMEOUT));
    }, timeoutMs);
    const onAbort = () => {
      controller.abort(signal?.reason);
      settle(reject, new ActionExecutionError(ERROR_CODES.CANCELLED));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => handler(input, { signal: controller.signal }))
      .then((value) => settle(resolve, value), (error) => settle(reject, error));
  });
}

export class ActionExecutor {
  constructor(registry = new ActionRegistry()) {
    this.registry = registry;
  }

  async execute(actionId, input, options = {}) {
    const entry = this.registry.resolve(actionId);
    if (!entry) throw new ActionExecutionError(ERROR_CODES.UNKNOWN_ACTION);
    const { descriptor, handler } = entry;
    const startedAt = new Date().toISOString();
    const started = nowNs();
    const grantedPermissions = new Set(options.grantedPermissions ?? []);
    const grantedCapabilities = new Set(options.grantedCapabilities ?? []);
    const fail = (code, extra = {}) => {
      const receipt = makeReceipt(descriptor, startedAt, started, code === ERROR_CODES.CANCELLED ? "cancelled" : "error", code);
      throw new ActionExecutionError(code, { ...extra, receipt });
    };

    if (descriptor.execution.mode === "ui-only" || typeof handler !== "function") fail(ERROR_CODES.NOT_HEADLESS);
    if (descriptor.behavior.requiresConfirmation && options.confirmed !== true) fail(ERROR_CODES.CONFIRMATION_REQUIRED);
    if (descriptor.permissions.required.some((permission) => !grantedPermissions.has(permission))) fail(ERROR_CODES.PERMISSION_DENIED);
    if (descriptor.permissions.capabilities.some((capability) => !grantedCapabilities.has(capability))) fail(ERROR_CODES.PERMISSION_DENIED);

    let inputBytes;
    try {
      inputBytes = utf8JsonBytes(input);
    } catch (cause) {
      fail(ERROR_CODES.INPUT_INVALID, { cause });
    }
    if (inputBytes > descriptor.execution.maxInputBytes) fail(ERROR_CODES.INPUT_TOO_LARGE);
    const inputIssues = validateValue(descriptor.inputSchema, input);
    if (inputIssues.length) fail(ERROR_CODES.INPUT_INVALID, { issues: inputIssues });

    let output;
    try {
      output = await guardedCall(
        handler,
        structuredClone(input),
        Math.min(options.timeoutMs ?? descriptor.execution.timeoutMs, descriptor.execution.timeoutMs),
        options.signal,
      );
    } catch (cause) {
      if (cause instanceof ActionExecutionError && [ERROR_CODES.TIMEOUT, ERROR_CODES.CANCELLED].includes(cause.code)) fail(cause.code, { cause });
      if ([
        ERROR_CODES.INPUT_INVALID,
        ERROR_CODES.INPUT_TOO_LARGE,
        ERROR_CODES.OUTPUT_INVALID,
        ERROR_CODES.OUTPUT_TOO_LARGE,
      ].includes(cause?.actionCode)) {
        fail(cause.actionCode, { cause });
      }
      fail(ERROR_CODES.ACTION_FAILED, { cause });
    }

    let outputBytes;
    try {
      outputBytes = utf8JsonBytes(output);
    } catch (cause) {
      fail(ERROR_CODES.OUTPUT_INVALID, { cause });
    }
    if (outputBytes > descriptor.execution.maxOutputBytes) fail(ERROR_CODES.OUTPUT_TOO_LARGE);
    const outputIssues = validateValue(descriptor.outputSchema, output);
    if (outputIssues.length) fail(ERROR_CODES.OUTPUT_INVALID, { issues: outputIssues });

    return {
      output,
      receipt: makeReceipt(descriptor, startedAt, started, "success"),
    };
  }
}
