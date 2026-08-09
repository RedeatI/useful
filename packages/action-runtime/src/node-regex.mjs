import { Worker } from "node:worker_threads";
import { ERROR_CODES } from "./semantics.mjs";

function workerError(code) {
  const error = new Error(code === ERROR_CODES.INPUT_INVALID ? "正则表达式非法" : "Regex worker 执行失败");
  if ([ERROR_CODES.INPUT_INVALID, ERROR_CODES.OUTPUT_TOO_LARGE].includes(code)) error.actionCode = code;
  return error;
}

export function nodeRegexHandler(input, context = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./regex-worker-thread.mjs", import.meta.url));
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      context.signal?.removeEventListener("abort", onAbort);
      void worker.terminate();
      callback(value);
    };
    const onAbort = () => settle(reject, workerError(ERROR_CODES.CANCELLED));
    if (context.signal?.aborted) return onAbort();
    context.signal?.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (message) => {
      if (message?.ok === true) settle(resolve, message.output);
      else settle(reject, workerError(message?.code));
    });
    worker.once("error", () => settle(reject, workerError(ERROR_CODES.ACTION_FAILED)));
    worker.once("exit", (code) => {
      if (!settled && code !== 0) settle(reject, workerError(ERROR_CODES.ACTION_FAILED));
    });
    worker.postMessage(input);
  });
}
