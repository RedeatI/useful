import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "@/i18n";
import { runOfficeWorker } from "./officeWorkerClient";

class FakeWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();

  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }
}

const factory = (worker: FakeWorker) => () => worker as unknown as Worker;

afterEach(() => vi.useRealTimers());

describe("office module Worker client", () => {
  it("transfers typed-array buffers and terminates the single-use Worker after success", async () => {
    const worker = new FakeWorker();
    const input = new Uint8Array([1, 2]);
    const pending = runOfficeWorker(
      { operation: "docx.inspect", input },
      { workerFactory: factory(worker), timeoutMs: 1_000 },
    );
    expect(worker.postMessage).toHaveBeenCalledWith(
      { operation: "docx.inspect", input },
      [input.buffer],
    );

    const bytes = new Uint8Array([3]);
    worker.emit({
      type: "success",
      operation: "docx.inspect",
      result: { kind: "json", json: `{"bytes":${bytes.byteLength}}\n` },
    });
    await expect(pending).resolves.toEqual({ kind: "json", json: '{"bytes":1}\n' });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("terminates on AbortSignal and ignores a captured late success message", async () => {
    const worker = new FakeWorker();
    const controller = new AbortController();
    const pending = runOfficeWorker(
      { operation: "pdf.merge", inputs: [new Uint8Array([1]), new Uint8Array([2])] },
      { signal: controller.signal, workerFactory: factory(worker), timeoutMs: 1_000 },
    );
    const lateHandler = worker.onmessage;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(worker.onmessage).toBeNull();

    lateHandler?.({
      data: {
        type: "success",
        operation: "pdf.merge",
        result: { kind: "binary", bytes: new Uint8Array([9]) },
      },
    } as MessageEvent<unknown>);
    await Promise.resolve();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("terminates on timeout and exposes only the localized public timeout", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const pending = runOfficeWorker(
      { operation: "markdown.parse", markdown: "# Local" },
      { workerFactory: factory(worker), timeoutMs: 25 },
    );
    const assertion = expect(pending).rejects.toThrow(t("toolErrors.requestTimeout"));
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("rejects non-closed responses without exposing Worker debug fields", async () => {
    const worker = new FakeWorker();
    const pending = runOfficeWorker(
      { operation: "spreadsheet.parseCsv", text: "a,b" },
      { workerFactory: factory(worker), timeoutMs: 1_000 },
    );
    worker.emit({ type: "error", code: "OPERATION_FAILED", debug: "SECRET_STACK" });
    await expect(pending).rejects.toThrow(t("toolErrors.workerInternal"));
    await expect(pending).rejects.not.toThrow("SECRET_STACK");
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("maps closed validation codes to localized public errors", async () => {
    const worker = new FakeWorker();
    const pending = runOfficeWorker(
      { operation: "docx.compose", json: "{" },
      { workerFactory: factory(worker), timeoutMs: 1_000 },
    );
    worker.emit({ type: "error", code: "INVALID_JSON" });
    await expect(pending).rejects.toThrow(t("office.errors.invalidJson"));
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("maps PDF page selection errors without exposing worker details", async () => {
    const worker = new FakeWorker();
    const pending = runOfficeWorker(
      { operation: "pdf.extractPages", input: new Uint8Array([1]), optionsJson: "{}" },
      { workerFactory: factory(worker), timeoutMs: 1_000 },
    );
    worker.emit({ type: "error", code: "MISSING_PDF_PAGES" });
    await expect(pending).rejects.toThrow(t("office.errors.pdfNeedsPages"));
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});
