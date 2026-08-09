import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { t } from "@/i18n";
import { officePublicError } from "./officeRuntime";

const workerMocks = vi.hoisted(() => ({ runOfficeWorker: vi.fn() }));

vi.mock("./officeWorkerClient", () => workerMocks);

import DocxTool from "./DocxTool.vue";
import MarkdownTool from "./MarkdownTool.vue";
import PdfTool from "./PdfTool.vue";
import PptxTool from "./PptxTool.vue";
import SpreadsheetTool from "./SpreadsheetTool.vue";

function runButton(wrapper: ReturnType<typeof mount>) {
  return wrapper.get(".office-workbench__actions .useful-btn--primary");
}

function localFile(name: string, bytes: number[]): File {
  const file = new File([new Uint8Array(bytes)], name);
  Object.defineProperty(file, "arrayBuffer", {
    configurable: true,
    value: vi.fn(async () => Uint8Array.from(bytes).buffer),
  });
  return file;
}

describe("office tool GUIs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workerMocks.runOfficeWorker.mockImplementation(async (request: { operation: string; json?: string }) => {
      if (request.operation === "docx.compose") {
        try {
          JSON.parse(request.json ?? "");
        } catch {
          throw officePublicError("office.errors.invalidJson");
        }
        return { kind: "binary", bytes: new Uint8Array([1]) };
      }
      if (request.operation === "pptx.compose") return { kind: "binary", bytes: new Uint8Array([2]) };
      if (request.operation === "spreadsheet.stringifyCsv") return { kind: "text", text: "'=1+1\r\n" };
      if (request.operation === "spreadsheet.inspectCsv") return { kind: "json", json: '{"format":"csv"}\n' };
      if (request.operation === "spreadsheet.markdownToCsv") return { kind: "text", text: "a,b\r\n" };
      if (request.operation === "pdf.inspect") return { kind: "json", json: '{"format":"pdf","pageIndexBase":0}\n' };
      if (request.operation === "markdown.parse") return { kind: "json", json: '{"blocks":[]}\n' };
      throw new Error("unexpected worker request");
    });
  });

  it("creates DOCX and PPTX from structured JSON and only exposes explicit downloads", async () => {
    const docx = mount(DocxTool);
    await runButton(docx).trigger("click");
    await flushPromises();
    expect(workerMocks.runOfficeWorker).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "docx.compose" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(docx.get(".office-workbench__downloads button").text()).toContain("document.docx");

    const pptx = mount(PptxTool);
    await runButton(pptx).trigger("click");
    await flushPromises();
    expect(workerMocks.runOfficeWorker).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "pptx.compose" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(pptx.get(".office-workbench__downloads button").text()).toContain("presentation.pptx");
  });

  it("shows JSON errors and clears the result state", async () => {
    const wrapper = mount(DocxTool);
    await wrapper.get<HTMLTextAreaElement>('[data-testid="docx-json"]').setValue("SECRET_{");
    await runButton(wrapper).trigger("click");
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe(t("office.errors.invalidJson"));
    expect(wrapper.text()).not.toContain("SECRET_");
    const clear = wrapper.findAll(".office-workbench__actions button")
      .find((button) => button.text() === t("office.workbench.clear"))!;
    await clear.trigger("click");
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.get<HTMLTextAreaElement>('[data-testid="docx-json"]').element.value).toBe("");
  });

  it("generates formula-escaped CSV and previews Markdown structure", async () => {
    const sheet = mount(SpreadsheetTool);
    await sheet.get<HTMLSelectElement>('[data-testid="spreadsheet-operation"]').setValue("create-csv");
    await sheet.get<HTMLTextAreaElement>('[data-testid="spreadsheet-input"]').setValue('{"rows":[["=1+1"]]}');
    await runButton(sheet).trigger("click");
    await flushPromises();
    expect(workerMocks.runOfficeWorker).toHaveBeenCalledWith(
      { operation: "spreadsheet.stringifyCsv", json: '{"rows":[["=1+1"]]}' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(sheet.text()).toContain("table.csv");

    const markdown = mount(MarkdownTool);
    await runButton(markdown).trigger("click");
    await flushPromises();
    expect(workerMocks.runOfficeWorker).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "markdown.parse" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(markdown.text()).toContain("outline.json");
  });

  it("awaits PDF processing and discards a resolved result after cancellation", async () => {
    let resolveMerge!: (bytes: Uint8Array) => void;
    let workerSignal: AbortSignal | undefined;
    workerMocks.runOfficeWorker.mockImplementation((_request: unknown, options: { signal?: AbortSignal }) => {
      workerSignal = options.signal;
      return new Promise<{ kind: "binary"; bytes: Uint8Array }>((resolve) => {
        resolveMerge = (bytes) => resolve({ kind: "binary", bytes });
      });
    });
    const wrapper = mount(PdfTool);
    const input = wrapper.get<HTMLInputElement>('input[type="file"]');
    Object.defineProperty(input.element, "files", {
      configurable: true,
      value: [localFile("a.pdf", [1]), localFile("b.pdf", [2])],
    });
    await input.trigger("change");
    await runButton(wrapper).trigger("click");
    await flushPromises();
    expect(workerMocks.runOfficeWorker).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "pdf.merge" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const cancel = wrapper.findAll(".office-workbench__actions button").find((button) => button.text() === t("common.cancel"))!;
    await cancel.trigger("click");
    expect(workerSignal?.aborted).toBe(true);
    resolveMerge(new Uint8Array([9]));
    await flushPromises();
    expect(wrapper.text()).toContain(t("office.workbench.cancelled"));
    expect(wrapper.find(".office-workbench__downloads").exists()).toBe(false);
  });

  it("exposes spreadsheet inspection/Markdown and PDF structure/page operations", async () => {
    const sheet = mount(SpreadsheetTool);
    const sheetOptions = sheet.findAll<HTMLSelectElement>('[data-testid="spreadsheet-operation"] option').map((option) => option.attributes("value"));
    expect(sheetOptions).toEqual(expect.arrayContaining(["inspect-xlsx", "inspect-csv", "to-markdown", "from-markdown"]));
    await sheet.get<HTMLSelectElement>('[data-testid="spreadsheet-operation"]').setValue("inspect-csv");
    await sheet.get<HTMLTextAreaElement>('[data-testid="spreadsheet-input"]').setValue("a,b\n1,2");
    await runButton(sheet).trigger("click");
    await flushPromises();
    expect(workerMocks.runOfficeWorker).toHaveBeenCalledWith(
      { operation: "spreadsheet.inspectCsv", text: "a,b\n1,2" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    const pdf = mount(PdfTool);
    const pdfOptions = pdf.findAll<HTMLSelectElement>('[data-testid="pdf-operation"] option').map((option) => option.attributes("value"));
    expect(pdfOptions).toEqual(expect.arrayContaining(["inspect", "extract-pages", "delete-pages"]));
  });
});
