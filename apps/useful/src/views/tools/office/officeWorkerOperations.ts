import {
  composeDocx,
  composePptx,
  composeXlsx,
  csvToMarkdown,
  deletePdfPages,
  docxToMarkdown,
  extractDocx,
  extractPptx,
  extractXlsx,
  extractPdfPages,
  inspectDocx,
  inspectPptx,
  inspectCsv,
  inspectPdf,
  inspectXlsx,
  markdownOutlineToDocx,
  markdownOutlineToPptx,
  markdownTableToCsv,
  markdownTableToXlsx,
  mergePdfs,
  parseCsv,
  parseMarkdownOutline,
  pptxToMarkdown,
  reorderPdf,
  rotatePdf,
  sanitizePdfMetadata,
  splitPdf,
  stringifyCsv,
  xlsxToMarkdown,
} from "@useful/office-core";
import type { DocxDocument, PptxPresentation, WorkbookModel } from "@useful/office-core";
import type {
  OfficeBinaryResult,
  OfficeJsonResult,
  OfficeMarkdownResult,
  OfficeTextResult,
  OfficeWorkerRequest,
  OfficeWorkerFailureCode,
  OfficeWorkerResult,
} from "./officeWorkerProtocol";

type OperationFailureCode = Exclude<OfficeWorkerFailureCode, "INVALID_REQUEST" | "OPERATION_FAILED">;

export class OfficeWorkerOperationError extends Error {
  readonly code: OperationFailureCode;

  constructor(code: OperationFailureCode) {
    super(code);
    this.name = "OfficeWorkerOperationError";
    this.code = code;
  }
}

interface PdfOptions {
  pageGroups?: number[][];
  pages?: number[];
  order?: number[];
  rotations?: Array<{ page: number; angle: 0 | 90 | 180 | 270 }>;
}

function parseJson<T>(value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new OfficeWorkerOperationError("INVALID_JSON");
  }
}

function csvRows(value: unknown): unknown[][] {
  if (Array.isArray(value) && value.every(Array.isArray)) return value as unknown[][];
  if (value && typeof value === "object") {
    const rows = (value as { rows?: unknown }).rows;
    if (Array.isArray(rows) && rows.every(Array.isArray)) return rows as unknown[][];
  }
  throw new OfficeWorkerOperationError("INVALID_CSV_ROWS");
}

const binary = (bytes: Uint8Array): OfficeBinaryResult => ({ kind: "binary", bytes });
const json = (value: unknown): OfficeJsonResult => ({
  kind: "json",
  json: `${JSON.stringify(value, null, 2)}\n`,
});
const text = (value: string): OfficeTextResult => ({ kind: "text", text: value });
const markdown = (value: { markdown: string; warnings: string[] }): OfficeMarkdownResult => ({
  kind: "markdown",
  markdown: value.markdown,
  warnings: value.warnings,
});

export async function executeOfficeWorkerRequest(request: OfficeWorkerRequest): Promise<OfficeWorkerResult> {
  switch (request.operation) {
    case "docx.compose":
      return binary(composeDocx(parseJson<DocxDocument>(request.json)));
    case "docx.extract":
      return json(extractDocx(request.input));
    case "docx.inspect":
      return json(inspectDocx(request.input));
    case "docx.markdown":
      return markdown(docxToMarkdown(request.input));
    case "pptx.compose":
      return binary(composePptx(parseJson<PptxPresentation>(request.json)));
    case "pptx.extract":
      return json(extractPptx(request.input));
    case "pptx.inspect":
      return json(inspectPptx(request.input));
    case "pptx.markdown":
      return markdown(pptxToMarkdown(request.input));
    case "spreadsheet.compose":
      return binary(composeXlsx(parseJson<WorkbookModel>(request.json)));
    case "spreadsheet.extract":
      return json(extractXlsx(request.input));
    case "spreadsheet.parseCsv":
      return json(parseCsv(request.text));
    case "spreadsheet.stringifyCsv":
      return text(stringifyCsv(csvRows(parseJson<unknown>(request.json)), { lineEnding: "\r\n", escapeFormulas: true }));
    case "spreadsheet.inspectXlsx":
      return json(inspectXlsx(request.input));
    case "spreadsheet.inspectCsv":
      return json(inspectCsv(request.text));
    case "spreadsheet.xlsxToMarkdown":
      return markdown(xlsxToMarkdown(request.input));
    case "spreadsheet.csvToMarkdown":
      return markdown(csvToMarkdown(request.text));
    case "spreadsheet.markdownToXlsx":
      return binary(markdownTableToXlsx(request.markdown, { sheetName: request.sheetName }));
    case "spreadsheet.markdownToCsv":
      return text(markdownTableToCsv(request.markdown, { lineEnding: "\r\n" }));
    case "markdown.parse":
      return json(parseMarkdownOutline(request.markdown));
    case "markdown.docx":
      return binary(markdownOutlineToDocx(request.markdown, { title: request.title }));
    case "markdown.pptx":
      return binary(markdownOutlineToPptx(request.markdown, { title: request.title }));
    case "pdf.merge":
      return binary(await mergePdfs(request.inputs));
    case "pdf.split":
      return {
        kind: "binaries",
        files: await splitPdf(request.input, parseJson<PdfOptions>(request.optionsJson).pageGroups),
      };
    case "pdf.reorder": {
      const order = parseJson<PdfOptions>(request.optionsJson).order;
      if (!Array.isArray(order)) throw new OfficeWorkerOperationError("MISSING_PDF_ORDER");
      return binary(await reorderPdf(request.input, order));
    }
    case "pdf.rotate": {
      const rotations = parseJson<PdfOptions>(request.optionsJson).rotations;
      if (!Array.isArray(rotations)) throw new OfficeWorkerOperationError("MISSING_PDF_ROTATIONS");
      return binary(await rotatePdf(request.input, rotations));
    }
    case "pdf.sanitize":
      return binary(await sanitizePdfMetadata(request.input));
    case "pdf.inspect":
      return json(await inspectPdf(request.input));
    case "pdf.extractPages": {
      const pages = parseJson<PdfOptions>(request.optionsJson).pages;
      if (!Array.isArray(pages)) throw new OfficeWorkerOperationError("MISSING_PDF_PAGES");
      return binary(await extractPdfPages(request.input, pages));
    }
    case "pdf.deletePages": {
      const pages = parseJson<PdfOptions>(request.optionsJson).pages;
      if (!Array.isArray(pages)) throw new OfficeWorkerOperationError("MISSING_PDF_PAGES");
      return binary(await deletePdfPages(request.input, pages));
    }
  }
  const exhaustive: never = request;
  throw exhaustive;
}
