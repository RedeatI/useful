import { executeOfficeWorkerRequest, OfficeWorkerOperationError } from "./officeWorkerOperations";
import {
  isOfficeWorkerRequest,
  officeResponseTransferables,
  type OfficeWorkerResponse,
} from "./officeWorkerProtocol";

interface OfficeWorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: OfficeWorkerResponse, transfer: Transferable[]): void;
  close(): void;
}

const scope = self as unknown as OfficeWorkerScope;
let started = false;

function respond(response: OfficeWorkerResponse): void {
  scope.postMessage(response, officeResponseTransferables(response));
  scope.close();
}

scope.onmessage = (event) => {
  if (started) return;
  started = true;
  const request = event.data;
  if (!isOfficeWorkerRequest(request)) {
    respond({ type: "error", code: "INVALID_REQUEST" });
    return;
  }
  void executeOfficeWorkerRequest(request)
    .then((result) => respond({
      type: "success",
      operation: request.operation,
      result,
    } as OfficeWorkerResponse))
    .catch((cause: unknown) => respond({
      type: "error",
      code: cause instanceof OfficeWorkerOperationError ? cause.code : "OPERATION_FAILED",
    }));
};
