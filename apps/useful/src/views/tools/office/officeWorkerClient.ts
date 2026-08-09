import { t } from "@/i18n";
import { officePublicError } from "./officeRuntime";
import {
  isOfficeWorkerResponse,
  officeRequestTransferables,
  type OfficeWorkerFailureCode,
  type OfficeWorkerRequest,
  type OfficeWorkerResultMap,
} from "./officeWorkerProtocol";

export const OFFICE_WORKER_TIMEOUT_MS = 60_000;

export interface OfficeWorkerClientOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  workerFactory?: () => Worker;
}

function createOfficeWorker(): Worker {
  return new Worker(new URL("./officeWorker.ts", import.meta.url), { type: "module" });
}

function abortedError(): DOMException {
  return new DOMException(t("office.workbench.cancelled"), "AbortError");
}

function workerError(): Error {
  return officePublicError("toolErrors.workerInternal");
}

function timeoutError(): Error {
  return officePublicError("toolErrors.requestTimeout");
}

function responseError(code: OfficeWorkerFailureCode): Error {
  if (code === "INVALID_JSON") return officePublicError("office.errors.invalidJson");
  if (code === "INVALID_CSV_ROWS") return officePublicError("office.errors.invalidCsvRows");
  if (code === "MISSING_PDF_ORDER") return officePublicError("office.errors.reorderNeedsOrder");
  if (code === "MISSING_PDF_ROTATIONS") return officePublicError("office.errors.rotateNeedsRotations");
  if (code === "MISSING_PDF_PAGES") return officePublicError("office.errors.pdfNeedsPages");
  return workerError();
}

export function runOfficeWorker<Request extends OfficeWorkerRequest>(
  request: Request,
  options: OfficeWorkerClientOptions = {},
): Promise<OfficeWorkerResultMap[Request["operation"]]> {
  if (options.signal?.aborted) return Promise.reject(abortedError());

  let worker: Worker;
  try {
    worker = (options.workerFactory ?? createOfficeWorker)();
  } catch {
    return Promise.reject(workerError());
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const requestedTimeout = options.timeoutMs ?? OFFICE_WORKER_TIMEOUT_MS;
    const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? requestedTimeout
      : OFFICE_WORKER_TIMEOUT_MS;

    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = () => finish(() => reject(abortedError()));
    const timer = setTimeout(() => finish(() => reject(timeoutError())), timeoutMs);

    worker.onmessage = (event: MessageEvent<unknown>) => {
      if (settled) return;
      const response = event.data;
      if (!isOfficeWorkerResponse(response, request.operation)) {
        finish(() => reject(workerError()));
        return;
      }
      if (response.type === "error") {
        finish(() => reject(responseError(response.code)));
        return;
      }
      finish(() => resolve(response.result as OfficeWorkerResultMap[Request["operation"]]));
    };
    worker.onerror = () => finish(() => reject(workerError()));
    worker.onmessageerror = () => finish(() => reject(workerError()));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }

    try {
      worker.postMessage(request, officeRequestTransferables(request));
    } catch {
      finish(() => reject(workerError()));
    }
  });
}
