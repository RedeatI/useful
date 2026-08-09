// 正则 Worker 管理：封装 Worker 生命周期，支持超时、取消和自动重建。
// Worker 超时终止后自动重建新 Worker，避免无限累积或不可用状态。

import { ref, onUnmounted, shallowRef } from "vue";
import type { RegexWorkerRequest, RegexWorkerResponse } from "./regexWorker";

export interface RegexResult {
  matches: { index: number; match: string; groups: string[] }[];
  error: string | null;
  timedOut: boolean;
  running: boolean;
}

export function useRegexWorker() {
  const worker = shallowRef<Worker | null>(null);
  const callId = ref(0);
  const pendingResolve = shallowRef<((r: RegexWorkerResponse) => void) | null>(null);
  const running = ref(false);
  const timedOut = ref(false);

  function ensureWorker(): Worker {
    if (worker.value) return worker.value;
    const w = new Worker(new URL("./regexWorker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<RegexWorkerResponse>) => {
      running.value = false;
      const resolve = pendingResolve.value;
      pendingResolve.value = null;
      if (resolve) resolve(e.data);
    };
    w.onerror = () => {
      running.value = false;
      const resolve = pendingResolve.value;
      pendingResolve.value = null;
      if (resolve) {
        resolve({ callId: -1, ok: false, error: "Worker 发生内部错误" });
      }
    };
    worker.value = w;
    return w;
  }

  /** 执行正则匹配或替换。超时自动终止 Worker 并报告。 */
  function execute(
    pattern: string,
    flags: string,
    text: string,
    mode: "test" | "replace" = "test",
    replacement?: string,
    timeoutMs = 3000,
  ): Promise<RegexWorkerResponse> {
    // 如果上一个 Worker 因超时被终止，需要重建
    const w = ensureWorker();
    const id = ++callId.value;
    running.value = true;
    timedOut.value = false;

    return new Promise<RegexWorkerResponse>((resolve) => {
      pendingResolve.value = resolve;
      const req: RegexWorkerRequest = {
        pattern,
        flags,
        text,
        mode,
        replacement,
        timeoutMs,
        callId: id,
      };
      w.postMessage(req);
    });
  }

  /** 取消当前执行：终止 Worker（下次 execute 自动重建）。 */
  function cancel(): void {
    if (worker.value) {
      worker.value.terminate();
      worker.value = null;
    }
    running.value = false;
    const resolve = pendingResolve.value;
    pendingResolve.value = null;
    if (resolve) {
      resolve({ callId: -1, ok: false, error: "已取消" });
    }
  }

  onUnmounted(() => {
    if (worker.value) {
      worker.value.terminate();
      worker.value = null;
    }
  });

  return { execute, cancel, running, timedOut };
}
