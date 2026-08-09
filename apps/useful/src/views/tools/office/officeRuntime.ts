import { computed, getCurrentScope, onScopeDispose, ref } from "vue";
import { t } from "@/i18n";

export const OFFICE_GUI_INPUT_LIMIT = 32 * 1024 * 1024;
export const OFFICE_PREVIEW_TEXT_LIMIT = 128 * 1024;

export interface OfficeOutput {
  name: string;
  mime: string;
  kind: "binary" | "text";
  bytes?: Uint8Array;
  text?: string;
}

export class OfficePublicError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfficePublicError";
  }
}

export function officePublicError(key: string, params?: Record<string, string | number>): OfficePublicError {
  return new OfficePublicError(t(key, params));
}

const encoder = new TextEncoder();

function officeTextBytes(values: readonly string[]): number {
  return values.reduce((total, value) => total + encoder.encode(value).byteLength, 0);
}

export function assertOfficeInputSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0) throw officePublicError("office.errors.invalidInputSize");
  if (size > OFFICE_GUI_INPUT_LIMIT) throw officePublicError("office.errors.inputTooLarge");
}

export function assertOfficeTextInput(...values: string[]): void {
  assertOfficeInputSize(officeTextBytes(values));
}

export async function readOfficeFiles(files: readonly File[], ...additionalText: string[]): Promise<Uint8Array[]> {
  const total = files.reduce((sum, file) => sum + file.size, 0) + officeTextBytes(additionalText);
  assertOfficeInputSize(total);
  return Promise.all(files.map(async (file) => new Uint8Array(await file.arrayBuffer())));
}

export async function readOfficeTextFile(file: File, ...additionalText: string[]): Promise<string> {
  assertOfficeInputSize(file.size + officeTextBytes(additionalText));
  const text = await file.text();
  assertOfficeTextInput(text, ...additionalText);
  return text;
}

export function binaryOfficeOutput(name: string, mime: string, bytes: Uint8Array): OfficeOutput {
  return { name, mime, kind: "binary", bytes };
}

export function textOfficeOutput(name: string, mime: string, text: string): OfficeOutput {
  return { name, mime, kind: "text", text };
}

export function jsonOfficeOutput(name: string, value: unknown): OfficeOutput {
  return textOfficeOutput(name, "application/json;charset=utf-8", `${JSON.stringify(value, null, 2)}\n`);
}

export function describeOfficeOutput(output: OfficeOutput): string {
  if (output.kind === "text") {
    const value = output.text ?? "";
    if (value.length <= OFFICE_PREVIEW_TEXT_LIMIT) return value;
    return `${value.slice(0, OFFICE_PREVIEW_TEXT_LIMIT)}\n\n${t("office.workbench.previewTruncated", {
      shown: OFFICE_PREVIEW_TEXT_LIMIT,
      total: value.length,
    })}`;
  }
  return t("office.workbench.binaryPreview", {
    name: output.name,
    size: output.bytes?.byteLength ?? 0,
    mime: output.mime,
  });
}

export function downloadOfficeOutput(output: OfficeOutput): void {
  const content: BlobPart = output.kind === "binary"
    ? Uint8Array.from(output.bytes ?? []).buffer
    : output.text ?? "";
  const blob = new Blob([content], { type: output.mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = output.name;
  anchor.rel = "noopener";
  anchor.click();
  queueMicrotask(() => URL.revokeObjectURL(url));
}

export function useOfficeOperation() {
  const running = ref(false);
  const error = ref<string | null>(null);
  const cancelled = ref(false);
  const outputs = ref<OfficeOutput[]>([]);
  let generation = 0;
  let controller: AbortController | null = null;

  const preview = computed(() => outputs.value.map(describeOfficeOutput).join("\n\n"));

  async function run(task: (signal: AbortSignal) => OfficeOutput[] | Promise<OfficeOutput[]>): Promise<void> {
    controller?.abort();
    const activeController = new AbortController();
    controller = activeController;
    const current = ++generation;
    running.value = true;
    error.value = null;
    cancelled.value = false;
    outputs.value = [];
    try {
      const next = await task(activeController.signal);
      if (current !== generation) return;
      outputs.value = next;
    } catch (cause) {
      if (current !== generation) return;
      error.value = cause instanceof OfficePublicError ? cause.message : t("common.error");
    } finally {
      if (current === generation) {
        controller = null;
        running.value = false;
      }
    }
  }

  function cancel(): void {
    if (!running.value) return;
    generation += 1;
    controller?.abort();
    controller = null;
    running.value = false;
    cancelled.value = true;
  }

  function clear(): void {
    generation += 1;
    controller?.abort();
    controller = null;
    running.value = false;
    error.value = null;
    cancelled.value = false;
    outputs.value = [];
  }

  if (getCurrentScope()) {
    onScopeDispose(() => {
      generation += 1;
      controller?.abort();
      controller = null;
    });
  }

  return { running, error, cancelled, outputs, preview, run, cancel, clear };
}
