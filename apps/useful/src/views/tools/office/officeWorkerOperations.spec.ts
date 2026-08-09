import { beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({
  composeDocx: vi.fn(() => new Uint8Array([1])),
  extractDocx: vi.fn(),
  inspectDocx: vi.fn(),
  docxToMarkdown: vi.fn(),
  composePptx: vi.fn(() => new Uint8Array([2])),
  extractPptx: vi.fn(),
  inspectPptx: vi.fn(),
  pptxToMarkdown: vi.fn(),
  composeXlsx: vi.fn(() => new Uint8Array([3])),
  extractXlsx: vi.fn(),
  inspectXlsx: vi.fn(() => ({ format: "xlsx", warnings: [] })),
  inspectCsv: vi.fn(() => ({ format: "csv", warnings: [] })),
  xlsxToMarkdown: vi.fn(() => ({ markdown: "| a |\n| --- |\n", warnings: [] })),
  csvToMarkdown: vi.fn(() => ({ markdown: "| a |\n| --- |\n", warnings: [] })),
  markdownTableToXlsx: vi.fn(() => new Uint8Array([3])),
  markdownTableToCsv: vi.fn(() => "a\r\n"),
  parseCsv: vi.fn(),
  stringifyCsv: vi.fn(() => "safe,csv\r\n"),
  parseMarkdownOutline: vi.fn(() => ({ blocks: [] })),
  markdownOutlineToDocx: vi.fn(),
  markdownOutlineToPptx: vi.fn(),
  mergePdfs: vi.fn(async () => new Uint8Array([4])),
  splitPdf: vi.fn(),
  reorderPdf: vi.fn(),
  rotatePdf: vi.fn(),
  sanitizePdfMetadata: vi.fn(),
  inspectPdf: vi.fn(async () => ({ format: "pdf", warnings: [] })),
  extractPdfPages: vi.fn(async () => new Uint8Array([5])),
  deletePdfPages: vi.fn(async () => new Uint8Array([6])),
}));

vi.mock("@useful/office-core", () => core);

import { executeOfficeWorkerRequest, OfficeWorkerOperationError } from "./officeWorkerOperations";

describe("office Worker operations", () => {
  beforeEach(() => vi.clearAllMocks());

  it("routes all five GUI families through the worker-only office-core adapter", async () => {
    await expect(executeOfficeWorkerRequest({
      operation: "docx.compose",
      json: '{"title":"","blocks":[]}',
    })).resolves.toMatchObject({ kind: "binary" });
    expect(core.composeDocx).toHaveBeenCalledWith({ title: "", blocks: [] });

    await expect(executeOfficeWorkerRequest({
      operation: "pptx.compose",
      json: '{"title":"","slides":[]}',
    })).resolves.toMatchObject({ kind: "binary" });
    expect(core.composePptx).toHaveBeenCalledWith({ title: "", slides: [] });

    await expect(executeOfficeWorkerRequest({
      operation: "spreadsheet.stringifyCsv",
      json: '{"rows":[["=1+1"]]}',
    })).resolves.toEqual({ kind: "text", text: "safe,csv\r\n" });
    expect(core.stringifyCsv).toHaveBeenCalledWith([["=1+1"]], {
      lineEnding: "\r\n",
      escapeFormulas: true,
    });

    await expect(executeOfficeWorkerRequest({
      operation: "markdown.parse",
      markdown: "# Local",
    })).resolves.toEqual({ kind: "json", json: '{\n  "blocks": []\n}\n' });

    await expect(executeOfficeWorkerRequest({
      operation: "pdf.merge",
      inputs: [new Uint8Array([1]), new Uint8Array([2])],
    })).resolves.toMatchObject({ kind: "binary" });
    expect(core.mergePdfs).toHaveBeenCalledTimes(1);
  });

  it("turns parser failures into a closed error code without parser diagnostics", async () => {
    const pending = executeOfficeWorkerRequest({ operation: "docx.compose", json: "SECRET_{" });
    await expect(pending).rejects.toBeInstanceOf(OfficeWorkerOperationError);
    await expect(pending).rejects.toMatchObject({ code: "INVALID_JSON", message: "INVALID_JSON" });
  });

  it("routes spreadsheet inspection/Markdown and PDF page operations through the worker adapter", async () => {
    await expect(executeOfficeWorkerRequest({
      operation: "spreadsheet.inspectCsv",
      text: "a,b\n1,2",
    })).resolves.toMatchObject({ kind: "json" });
    expect(core.inspectCsv).toHaveBeenCalledWith("a,b\n1,2");

    await expect(executeOfficeWorkerRequest({
      operation: "spreadsheet.markdownToXlsx",
      markdown: "| a |\n| --- |",
      sheetName: "Sheet1",
    })).resolves.toMatchObject({ kind: "binary" });
    expect(core.markdownTableToXlsx).toHaveBeenCalledWith("| a |\n| --- |", { sheetName: "Sheet1" });

    await expect(executeOfficeWorkerRequest({
      operation: "pdf.inspect",
      input: new Uint8Array([1]),
    })).resolves.toMatchObject({ kind: "json" });
    await expect(executeOfficeWorkerRequest({
      operation: "pdf.extractPages",
      input: new Uint8Array([1]),
      optionsJson: '{"pages":[0]}',
    })).resolves.toMatchObject({ kind: "binary" });
    expect(core.extractPdfPages).toHaveBeenCalledWith(expect.any(Uint8Array), [0]);
  });
});
