import { describe, expect, it, vi } from "vitest";
import { t } from "@/i18n";
import {
  assertOfficeInputSize,
  assertOfficeTextInput,
  binaryOfficeOutput,
  describeOfficeOutput,
  downloadOfficeOutput,
  OFFICE_GUI_INPUT_LIMIT,
  OFFICE_PREVIEW_TEXT_LIMIT,
  readOfficeFiles,
  useOfficeOperation,
  textOfficeOutput,
} from "./officeRuntime";

describe("office GUI runtime", () => {
  it("enforces the 32 MiB aggregate input boundary before reading files", async () => {
    expect(() => assertOfficeInputSize(OFFICE_GUI_INPUT_LIMIT)).not.toThrow();
    expect(() => assertOfficeInputSize(OFFICE_GUI_INPUT_LIMIT + 1)).toThrow(t("office.errors.inputTooLarge"));
    expect(() => assertOfficeTextInput("本地文本")).not.toThrow();

    const oversized = { size: OFFICE_GUI_INPUT_LIMIT + 1, arrayBuffer: vi.fn() } as unknown as File;
    await expect(readOfficeFiles([oversized])).rejects.toThrow(t("office.errors.inputTooLarge"));
    expect(oversized.arrayBuffer).not.toHaveBeenCalled();

    const boundaryFile = { size: OFFICE_GUI_INPUT_LIMIT, arrayBuffer: vi.fn() } as unknown as File;
    await expect(readOfficeFiles([boundaryFile], "x")).rejects.toThrow(t("office.errors.inputTooLarge"));
    expect(boundaryFile.arrayBuffer).not.toHaveBeenCalled();
  });

  it("bounds live text previews without truncating the downloadable output", () => {
    const text = "x".repeat(OFFICE_PREVIEW_TEXT_LIMIT + 1);
    const output = textOfficeOutput("large.txt", "text/plain", text);
    expect(describeOfficeOutput(output)).toContain(t("office.workbench.previewTruncated", {
      shown: OFFICE_PREVIEW_TEXT_LIMIT,
      total: text.length,
    }));
    expect(output.text).toBe(text);
  });

  it("drops a late async result after explicit cancellation", async () => {
    let resolve!: (value: ReturnType<typeof binaryOfficeOutput>[]) => void;
    let workerSignal: AbortSignal | undefined;
    const pending = new Promise<ReturnType<typeof binaryOfficeOutput>[]>((done) => { resolve = done; });
    const state = useOfficeOperation();
    const execution = state.run((signal) => {
      workerSignal = signal;
      return pending;
    });
    expect(state.running.value).toBe(true);
    state.cancel();
    expect(workerSignal?.aborted).toBe(true);
    resolve([binaryOfficeOutput("late.pdf", "application/pdf", new Uint8Array([1]))]);
    await execution;
    expect(state.cancelled.value).toBe(true);
    expect(state.outputs.value).toEqual([]);
  });

  it("does not expose unexpected local or Worker diagnostics", async () => {
    const state = useOfficeOperation();
    await state.run(async () => { throw new Error("SECRET_STACK_AND_PATH"); });
    expect(state.error.value).toBe(t("common.error"));
    expect(state.error.value).not.toContain("SECRET_STACK_AND_PATH");
  });

  it("downloads only when the explicit download helper is invoked", async () => {
    const createObjectURL = vi.fn(() => "blob:office");
    const revokeObjectURL = vi.fn();
    const originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    try {
      const output = binaryOfficeOutput("local.docx", "application/octet-stream", new Uint8Array([1, 2]));
      expect(createObjectURL).not.toHaveBeenCalled();
      downloadOfficeOutput(output);
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(click).toHaveBeenCalledTimes(1);
      await Promise.resolve();
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:office");
    } finally {
      click.mockRestore();
      if (originalCreate) Object.defineProperty(URL, "createObjectURL", originalCreate);
      else Reflect.deleteProperty(URL, "createObjectURL");
      if (originalRevoke) Object.defineProperty(URL, "revokeObjectURL", originalRevoke);
      else Reflect.deleteProperty(URL, "revokeObjectURL");
    }
  });
});
