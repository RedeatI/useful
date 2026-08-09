import { Worker } from "node:worker_threads";
import { OFFICE_ACTION_IDS } from "./office-actions.mjs";
import { ERROR_CODES } from "./semantics.mjs";

const ACTION_IDS = new Set(Object.values(OFFICE_ACTION_IDS));
const WORKER_CODES = new Set([
  ERROR_CODES.UNKNOWN_ACTION,
  ERROR_CODES.INPUT_INVALID,
  ERROR_CODES.INPUT_TOO_LARGE,
  ERROR_CODES.OUTPUT_INVALID,
  ERROR_CODES.OUTPUT_TOO_LARGE,
  ERROR_CODES.CANCELLED,
  ERROR_CODES.TIMEOUT,
  ERROR_CODES.ACTION_FAILED,
]);

function stableError(code) {
  const stable = WORKER_CODES.has(code) ? code : ERROR_CODES.ACTION_FAILED;
  const error = new Error(stable);
  error.actionCode = stable;
  return error;
}

/**
 * Execute one built-in Office action in a real, terminable Node worker thread.
 * The worker is single-use so cancellation and timeout can always reclaim it.
 */
export function nodeOfficeHandler(actionId, input, { signal } = {}) {
  if (!ACTION_IDS.has(actionId)) return Promise.reject(stableError(ERROR_CODES.UNKNOWN_ACTION));
  if (signal !== undefined && (
    signal === null
    || typeof signal !== "object"
    || typeof signal.aborted !== "boolean"
    || typeof signal.addEventListener !== "function"
    || typeof signal.removeEventListener !== "function"
  )) return Promise.reject(stableError(ERROR_CODES.INPUT_INVALID));
  if (signal?.aborted) return Promise.reject(stableError(ERROR_CODES.CANCELLED));

  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL("./office-worker-thread.mjs", import.meta.url));
    } catch {
      reject(stableError(ERROR_CODES.ACTION_FAILED));
      return;
    }
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      void worker.terminate();
      callback(value);
    };
    const onAbort = () => settle(reject, stableError(ERROR_CODES.CANCELLED));

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (message) => {
      if (message?.ok === true && message.output && typeof message.output === "object" && !Array.isArray(message.output)) {
        settle(resolve, message.output);
      } else {
        settle(reject, stableError(message?.code));
      }
    });
    worker.once("error", () => settle(reject, stableError(ERROR_CODES.ACTION_FAILED)));
    worker.once("messageerror", () => settle(reject, stableError(ERROR_CODES.ACTION_FAILED)));
    worker.once("exit", () => {
      if (!settled) settle(reject, stableError(ERROR_CODES.ACTION_FAILED));
    });
    try {
      worker.postMessage({ actionId, input });
    } catch {
      settle(reject, stableError(ERROR_CODES.INPUT_INVALID));
    }
  });
}
