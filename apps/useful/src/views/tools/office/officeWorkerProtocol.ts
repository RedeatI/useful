export type OfficeWorkerRequest =
  | { operation: "docx.compose"; json: string }
  | { operation: "docx.extract" | "docx.inspect" | "docx.markdown"; input: Uint8Array }
  | { operation: "pptx.compose"; json: string }
  | { operation: "pptx.extract" | "pptx.inspect" | "pptx.markdown"; input: Uint8Array }
  | { operation: "spreadsheet.compose"; json: string }
  | { operation: "spreadsheet.extract"; input: Uint8Array }
  | { operation: "spreadsheet.parseCsv"; text: string }
  | { operation: "spreadsheet.stringifyCsv"; json: string }
  | { operation: "spreadsheet.inspectXlsx" | "spreadsheet.xlsxToMarkdown"; input: Uint8Array }
  | { operation: "spreadsheet.inspectCsv" | "spreadsheet.csvToMarkdown"; text: string }
  | { operation: "spreadsheet.markdownToXlsx"; markdown: string; sheetName: string }
  | { operation: "spreadsheet.markdownToCsv"; markdown: string }
  | { operation: "markdown.parse"; markdown: string }
  | { operation: "markdown.docx" | "markdown.pptx"; markdown: string; title: string }
  | { operation: "pdf.merge"; inputs: Uint8Array[] }
  | { operation: "pdf.split" | "pdf.reorder" | "pdf.rotate"; input: Uint8Array; optionsJson: string }
  | { operation: "pdf.sanitize" | "pdf.inspect"; input: Uint8Array }
  | { operation: "pdf.extractPages" | "pdf.deletePages"; input: Uint8Array; optionsJson: string };

export type OfficeWorkerOperation = OfficeWorkerRequest["operation"];

export interface OfficeBinaryResult {
  kind: "binary";
  bytes: Uint8Array;
}

export interface OfficeBinariesResult {
  kind: "binaries";
  files: Uint8Array[];
}

export interface OfficeJsonResult {
  kind: "json";
  json: string;
}

export interface OfficeMarkdownResult {
  kind: "markdown";
  markdown: string;
  warnings: string[];
}

export interface OfficeTextResult {
  kind: "text";
  text: string;
}

export interface OfficeWorkerResultMap {
  "docx.compose": OfficeBinaryResult;
  "docx.extract": OfficeJsonResult;
  "docx.inspect": OfficeJsonResult;
  "docx.markdown": OfficeMarkdownResult;
  "pptx.compose": OfficeBinaryResult;
  "pptx.extract": OfficeJsonResult;
  "pptx.inspect": OfficeJsonResult;
  "pptx.markdown": OfficeMarkdownResult;
  "spreadsheet.compose": OfficeBinaryResult;
  "spreadsheet.extract": OfficeJsonResult;
  "spreadsheet.parseCsv": OfficeJsonResult;
  "spreadsheet.stringifyCsv": OfficeTextResult;
  "spreadsheet.inspectXlsx": OfficeJsonResult;
  "spreadsheet.inspectCsv": OfficeJsonResult;
  "spreadsheet.xlsxToMarkdown": OfficeMarkdownResult;
  "spreadsheet.csvToMarkdown": OfficeMarkdownResult;
  "spreadsheet.markdownToXlsx": OfficeBinaryResult;
  "spreadsheet.markdownToCsv": OfficeTextResult;
  "markdown.parse": OfficeJsonResult;
  "markdown.docx": OfficeBinaryResult;
  "markdown.pptx": OfficeBinaryResult;
  "pdf.merge": OfficeBinaryResult;
  "pdf.split": OfficeBinariesResult;
  "pdf.reorder": OfficeBinaryResult;
  "pdf.rotate": OfficeBinaryResult;
  "pdf.sanitize": OfficeBinaryResult;
  "pdf.inspect": OfficeJsonResult;
  "pdf.extractPages": OfficeBinaryResult;
  "pdf.deletePages": OfficeBinaryResult;
}

export type OfficeWorkerResult = OfficeWorkerResultMap[OfficeWorkerOperation];

export type OfficeWorkerSuccessResponse = {
  [Operation in OfficeWorkerOperation]: {
    type: "success";
    operation: Operation;
    result: OfficeWorkerResultMap[Operation];
  };
}[OfficeWorkerOperation];

export type OfficeWorkerFailureCode =
  | "INVALID_REQUEST"
  | "OPERATION_FAILED"
  | "INVALID_JSON"
  | "INVALID_CSV_ROWS"
  | "MISSING_PDF_ORDER"
  | "MISSING_PDF_ROTATIONS"
  | "MISSING_PDF_PAGES";

export interface OfficeWorkerFailureResponse {
  type: "error";
  code: OfficeWorkerFailureCode;
}

export type OfficeWorkerResponse = OfficeWorkerSuccessResponse | OfficeWorkerFailureResponse;

const operations = new Set<OfficeWorkerOperation>([
  "docx.compose", "docx.extract", "docx.inspect", "docx.markdown",
  "pptx.compose", "pptx.extract", "pptx.inspect", "pptx.markdown",
  "spreadsheet.compose", "spreadsheet.extract", "spreadsheet.parseCsv", "spreadsheet.stringifyCsv",
  "spreadsheet.inspectXlsx", "spreadsheet.inspectCsv", "spreadsheet.xlsxToMarkdown", "spreadsheet.csvToMarkdown",
  "spreadsheet.markdownToXlsx", "spreadsheet.markdownToCsv",
  "markdown.parse", "markdown.docx", "markdown.pptx",
  "pdf.merge", "pdf.split", "pdf.reorder", "pdf.rotate", "pdf.sanitize", "pdf.inspect", "pdf.extractPages", "pdf.deletePages",
]);

const resultKinds: { [Operation in OfficeWorkerOperation]: OfficeWorkerResultMap[Operation]["kind"] } = {
  "docx.compose": "binary",
  "docx.extract": "json",
  "docx.inspect": "json",
  "docx.markdown": "markdown",
  "pptx.compose": "binary",
  "pptx.extract": "json",
  "pptx.inspect": "json",
  "pptx.markdown": "markdown",
  "spreadsheet.compose": "binary",
  "spreadsheet.extract": "json",
  "spreadsheet.parseCsv": "json",
  "spreadsheet.stringifyCsv": "text",
  "spreadsheet.inspectXlsx": "json",
  "spreadsheet.inspectCsv": "json",
  "spreadsheet.xlsxToMarkdown": "markdown",
  "spreadsheet.csvToMarkdown": "markdown",
  "spreadsheet.markdownToXlsx": "binary",
  "spreadsheet.markdownToCsv": "text",
  "markdown.parse": "json",
  "markdown.docx": "binary",
  "markdown.pptx": "binary",
  "pdf.merge": "binary",
  "pdf.split": "binaries",
  "pdf.reorder": "binary",
  "pdf.rotate": "binary",
  "pdf.sanitize": "binary",
  "pdf.inspect": "json",
  "pdf.extractPages": "binary",
  "pdf.deletePages": "binary",
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], required = allowed): boolean {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key)) && required.every((key) => key in value);
}

function byteArray(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array && value.buffer instanceof ArrayBuffer;
}

function byteArrays(value: unknown): value is Uint8Array[] {
  return Array.isArray(value) && value.every(byteArray);
}

export function isOfficeWorkerRequest(value: unknown): value is OfficeWorkerRequest {
  if (!record(value) || typeof value.operation !== "string" || !operations.has(value.operation as OfficeWorkerOperation)) {
    return false;
  }
  switch (value.operation as OfficeWorkerOperation) {
    case "docx.compose":
    case "pptx.compose":
    case "spreadsheet.compose":
    case "spreadsheet.stringifyCsv":
      return exactKeys(value, ["operation", "json"]) && typeof value.json === "string";
    case "spreadsheet.parseCsv":
    case "spreadsheet.inspectCsv":
    case "spreadsheet.csvToMarkdown":
      return exactKeys(value, ["operation", "text"]) && typeof value.text === "string";
    case "spreadsheet.markdownToCsv":
      return exactKeys(value, ["operation", "markdown"]) && typeof value.markdown === "string";
    case "spreadsheet.markdownToXlsx":
      return exactKeys(value, ["operation", "markdown", "sheetName"])
        && typeof value.markdown === "string"
        && typeof value.sheetName === "string";
    case "markdown.parse":
      return exactKeys(value, ["operation", "markdown"]) && typeof value.markdown === "string";
    case "markdown.docx":
    case "markdown.pptx":
      return exactKeys(value, ["operation", "markdown", "title"])
        && typeof value.markdown === "string"
        && typeof value.title === "string";
    case "pdf.merge":
      return exactKeys(value, ["operation", "inputs"]) && byteArrays(value.inputs);
    case "pdf.split":
    case "pdf.reorder":
    case "pdf.rotate":
    case "pdf.extractPages":
    case "pdf.deletePages":
      return exactKeys(value, ["operation", "input", "optionsJson"])
        && byteArray(value.input)
        && typeof value.optionsJson === "string";
    case "docx.extract":
    case "docx.inspect":
    case "docx.markdown":
    case "pptx.extract":
    case "pptx.inspect":
    case "pptx.markdown":
    case "spreadsheet.extract":
    case "spreadsheet.inspectXlsx":
    case "spreadsheet.xlsxToMarkdown":
    case "pdf.sanitize":
    case "pdf.inspect":
      return exactKeys(value, ["operation", "input"]) && byteArray(value.input);
    default:
      return false;
  }
}

function isOfficeWorkerResult(value: unknown, operation: OfficeWorkerOperation): value is OfficeWorkerResult {
  if (!record(value) || value.kind !== resultKinds[operation]) return false;
  if (value.kind === "binary") return exactKeys(value, ["kind", "bytes"]) && byteArray(value.bytes);
  if (value.kind === "binaries") return exactKeys(value, ["kind", "files"]) && byteArrays(value.files);
  if (value.kind === "json") return exactKeys(value, ["kind", "json"]) && typeof value.json === "string";
  if (value.kind === "text") return exactKeys(value, ["kind", "text"]) && typeof value.text === "string";
  return value.kind === "markdown"
    && exactKeys(value, ["kind", "markdown", "warnings"])
    && typeof value.markdown === "string"
    && Array.isArray(value.warnings)
    && value.warnings.every((warning) => typeof warning === "string");
}

export function isOfficeWorkerResponse(
  value: unknown,
  operation: OfficeWorkerOperation,
): value is OfficeWorkerResponse {
  if (!record(value) || typeof value.type !== "string") return false;
  if (value.type === "error") {
    return exactKeys(value, ["type", "code"])
      && [
        "INVALID_REQUEST",
        "OPERATION_FAILED",
        "INVALID_JSON",
        "INVALID_CSV_ROWS",
        "MISSING_PDF_ORDER",
        "MISSING_PDF_ROTATIONS",
        "MISSING_PDF_PAGES",
      ].includes(value.code as string);
  }
  return value.type === "success"
    && exactKeys(value, ["type", "operation", "result"])
    && value.operation === operation
    && isOfficeWorkerResult(value.result, operation);
}

function addBuffer(target: Set<ArrayBuffer>, bytes: Uint8Array): void {
  if (bytes.buffer instanceof ArrayBuffer) target.add(bytes.buffer);
}

export function officeRequestTransferables(request: OfficeWorkerRequest): Transferable[] {
  const buffers = new Set<ArrayBuffer>();
  if ("input" in request) addBuffer(buffers, request.input);
  if (request.operation === "pdf.merge") request.inputs.forEach((bytes) => addBuffer(buffers, bytes));
  return [...buffers];
}

export function officeResponseTransferables(response: OfficeWorkerResponse): Transferable[] {
  const buffers = new Set<ArrayBuffer>();
  if (response.type === "success") {
    if (response.result.kind === "binary") addBuffer(buffers, response.result.bytes);
    if (response.result.kind === "binaries") response.result.files.forEach((bytes) => addBuffer(buffers, bytes));
  }
  return [...buffers];
}
