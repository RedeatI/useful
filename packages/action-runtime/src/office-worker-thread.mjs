import { createHash } from "node:crypto";
import { parentPort } from "node:worker_threads";
import {
  OfficeCoreError,
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
  markdownTableToCsv,
  markdownTableToXlsx,
  markdownOutlineToDocx,
  markdownOutlineToPptx,
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
import { OFFICE_ACTION_IDS, OFFICE_ACTION_LIMITS } from "./office-actions.mjs";
import { ERROR_CODES } from "./semantics.mjs";

if (!parentPort) throw new Error("OFFICE_WORKER_CHANNEL_MISSING");

const MAX_BASE64_CHARS = OFFICE_ACTION_LIMITS.maxBase64Chars;
const MAX_BINARY_OUTPUT = OFFICE_ACTION_LIMITS.maxBinaryOutputBytes;
const MAX_TOTAL_BINARY_INPUT = 6 * 1024 * 1024;
const MAX_INPUT_JSON_BYTES = OFFICE_ACTION_LIMITS.maxInputJsonBytes;
const MAX_OUTPUT_JSON_BYTES = OFFICE_ACTION_LIMITS.maxOutputJsonBytes;
const MAX_OUTPUT_TEXT_CHARS = OFFICE_ACTION_LIMITS.maxOutputTextChars;
const MODEL_TEXT_CHARS = 100000;
const FORMULA_CHARS = 32768;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function inputError() {
  const error = new Error(ERROR_CODES.INPUT_INVALID);
  error.stableCode = ERROR_CODES.INPUT_INVALID;
  throw error;
}

function inputTooLarge() {
  const error = new Error(ERROR_CODES.INPUT_TOO_LARGE);
  error.stableCode = ERROR_CODES.INPUT_TOO_LARGE;
  throw error;
}

function outputTooLarge() {
  const error = new Error(ERROR_CODES.OUTPUT_TOO_LARGE);
  error.stableCode = ERROR_CODES.OUTPUT_TOO_LARGE;
  throw error;
}

function outputInvalid() {
  const error = new Error(ERROR_CODES.OUTPUT_INVALID);
  error.stableCode = ERROR_CODES.OUTPUT_INVALID;
  throw error;
}

function jsonBytes(value, output = false) {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) output ? outputInvalid() : inputError();
    return Buffer.byteLength(serialized, "utf8");
  } catch (error) {
    if (error?.stableCode) throw error;
    output ? outputInvalid() : inputError();
  }
}

function outputText(value) {
  if (typeof value !== "string") outputInvalid();
  if (value.length > MAX_OUTPUT_TEXT_CHARS) outputTooLarge();
  return value;
}

function exact(value, allowed, required = allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) inputError();
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) inputError();
  return value;
}

function canonicalBase64(value) {
  if (typeof value !== "string" || value.length > MAX_BASE64_CHARS || value.length % 4 !== 0 || !CANONICAL_BASE64.test(value)) {
    if (typeof value === "string" && value.length > MAX_BASE64_CHARS) inputTooLarge();
    inputError();
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) inputError();
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function binaryOutput(bytes) {
  if (!(bytes instanceof Uint8Array)) outputInvalid();
  if (bytes.byteLength > MAX_BINARY_OUTPUT) outputTooLarge();
  return {
    dataBase64: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64"),
    sizeBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function binaryOutputs(values) {
  if (!Array.isArray(values)) outputInvalid();
  let total = 0;
  const encoded = values.map((bytes) => {
    if (!(bytes instanceof Uint8Array)) outputInvalid();
    total += bytes.byteLength;
    if (total > MAX_BINARY_OUTPUT) outputTooLarge();
    return binaryOutput(bytes);
  });
  return {
    documentsBase64: encoded.map((entry) => entry.dataBase64),
    sizesBytes: encoded.map((entry) => entry.sizeBytes),
    sha256s: encoded.map((entry) => entry.sha256),
  };
}

function formulaCell(value) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) inputError();
    return value;
  }
  if (typeof value === "string") {
    if (value.length > MODEL_TEXT_CHARS) inputTooLarge();
    return value;
  }
  exact(value, ["kind", "formula"]);
  if (value.kind !== "formula" || typeof value.formula !== "string") inputError();
  if (value.formula.length > FORMULA_CHARS) inputTooLarge();
  return `=${value.formula}`;
}

function normalizeRows(rows, { maxColumns = 10000, budget = { cells: 0 } } = {}) {
  if (!Array.isArray(rows)) inputError();
  if (rows.length > 100000) inputTooLarge();
  return rows.map((row) => {
    if (!Array.isArray(row)) inputError();
    if (row.length > maxColumns) inputTooLarge();
    budget.cells += row.length;
    if (budget.cells > 1000000) inputTooLarge();
    return row.map(formulaCell);
  });
}

function normalizeSheets(sheets) {
  if (!Array.isArray(sheets) || sheets.length === 0) inputError();
  if (sheets.length > 64) inputTooLarge();
  const budget = { cells: 0 };
  return sheets.map((sheet) => {
    exact(sheet, ["name", "rows"]);
    if (typeof sheet.name !== "string" || sheet.name.length > 31) inputError();
    return { name: sheet.name, rows: normalizeRows(sheet.rows, { maxColumns: 16384, budget }) };
  });
}

function docx(input) {
  const operation = input?.operation;
  if (operation === "compose") {
    exact(input, ["operation", "title", "blocks"], ["operation", "blocks"]);
    return { operation, warnings: [], ...binaryOutput(composeDocx({ ...(input.title === undefined ? {} : { title: input.title }), blocks: input.blocks })) };
  }
  if (operation === "extract") {
    exact(input, ["operation", "dataBase64"]);
    const result = extractDocx(canonicalBase64(input.dataBase64));
    return { operation, warnings: result.warnings, document: result.document, archive: result.archive };
  }
  if (operation === "inspect") {
    exact(input, ["operation", "dataBase64"]);
    const summary = inspectDocx(canonicalBase64(input.dataBase64));
    return { operation, warnings: summary.warnings, summary };
  }
  if (operation === "to-markdown") {
    exact(input, ["operation", "dataBase64"]);
    const result = docxToMarkdown(canonicalBase64(input.dataBase64));
    return { operation, warnings: result.warnings, markdown: outputText(result.markdown) };
  }
  if (operation === "from-markdown") {
    exact(input, ["operation", "markdown", "title"], ["operation", "markdown"]);
    return { operation, warnings: [], ...binaryOutput(markdownOutlineToDocx(input.markdown, input.title === undefined ? {} : { title: input.title })) };
  }
  inputError();
}

function pptx(input) {
  const operation = input?.operation;
  if (operation === "compose") {
    exact(input, ["operation", "title", "slides"], ["operation", "slides"]);
    return { operation, warnings: [], ...binaryOutput(composePptx({ ...(input.title === undefined ? {} : { title: input.title }), slides: input.slides })) };
  }
  if (operation === "extract") {
    exact(input, ["operation", "dataBase64"]);
    const result = extractPptx(canonicalBase64(input.dataBase64));
    return { operation, warnings: result.warnings, presentation: result.presentation, archive: result.archive };
  }
  if (operation === "inspect") {
    exact(input, ["operation", "dataBase64"]);
    const summary = inspectPptx(canonicalBase64(input.dataBase64));
    return { operation, warnings: summary.warnings, summary };
  }
  if (operation === "to-markdown") {
    exact(input, ["operation", "dataBase64"]);
    const result = pptxToMarkdown(canonicalBase64(input.dataBase64));
    return { operation, warnings: result.warnings, markdown: outputText(result.markdown) };
  }
  if (operation === "from-markdown") {
    exact(input, ["operation", "markdown", "title"], ["operation", "markdown"]);
    return { operation, warnings: [], ...binaryOutput(markdownOutlineToPptx(input.markdown, input.title === undefined ? {} : { title: input.title })) };
  }
  inputError();
}

function spreadsheet(input) {
  const operation = input?.operation;
  if (operation === "compose") {
    exact(input, ["operation", "sheets"]);
    return { operation, warnings: [], ...binaryOutput(composeXlsx({ sheets: normalizeSheets(input.sheets) })) };
  }
  if (operation === "extract") {
    exact(input, ["operation", "dataBase64"]);
    const result = extractXlsx(canonicalBase64(input.dataBase64));
    return { operation, warnings: result.warnings, workbook: result.workbook, archive: result.archive };
  }
  if (operation === "csv-parse") {
    exact(input, ["operation", "text", "delimiter"], ["operation", "text"]);
    const result = parseCsv(input.text, input.delimiter === undefined ? {} : { delimiter: input.delimiter });
    return { operation, warnings: [], rows: result.rows, delimiter: result.delimiter };
  }
  if (operation === "csv-stringify") {
    exact(input, ["operation", "rows", "delimiter", "escapeFormulas"], ["operation", "rows"]);
    const options = {};
    if (input.delimiter !== undefined) options.delimiter = input.delimiter;
    if (input.escapeFormulas !== undefined) options.escapeFormulas = input.escapeFormulas;
    return { operation, warnings: [], text: outputText(stringifyCsv(normalizeRows(input.rows), options)) };
  }
  if (operation === "csv-to-xlsx") {
    exact(input, ["operation", "text", "delimiter", "sheetName"], ["operation", "text"]);
    const parsed = parseCsv(input.text, input.delimiter === undefined ? {} : { delimiter: input.delimiter });
    const sheets = [{ name: input.sheetName ?? "Sheet1", rows: parsed.rows }];
    return { operation, warnings: [], ...binaryOutput(composeXlsx({ sheets })) };
  }
  if (operation === "xlsx-to-csv") {
    exact(input, ["operation", "dataBase64", "sheetIndex", "delimiter", "escapeFormulas"], ["operation", "dataBase64"]);
    const result = extractXlsx(canonicalBase64(input.dataBase64));
    const index = input.sheetIndex ?? 0;
    if (!Number.isInteger(index) || index < 0 || index >= result.workbook.sheets.length) inputError();
    const options = {};
    if (input.delimiter !== undefined) options.delimiter = input.delimiter;
    if (input.escapeFormulas !== undefined) options.escapeFormulas = input.escapeFormulas;
    return { operation, warnings: result.warnings, text: outputText(stringifyCsv(normalizeRows(result.workbook.sheets[index].rows), options)) };
  }
  if (operation === "inspect-xlsx") {
    exact(input, ["operation", "dataBase64"]);
    const summary = inspectXlsx(canonicalBase64(input.dataBase64));
    return { operation, warnings: summary.warnings, summary };
  }
  if (operation === "inspect-csv") {
    exact(input, ["operation", "text", "delimiter"], ["operation", "text"]);
    const summary = inspectCsv(input.text, input.delimiter === undefined ? {} : { delimiter: input.delimiter });
    return { operation, warnings: summary.warnings, summary };
  }
  if (operation === "to-markdown") {
    if (input?.sourceFormat === "xlsx") {
      exact(input, ["operation", "sourceFormat", "dataBase64", "sheetIndex"], ["operation", "sourceFormat", "dataBase64"]);
      const result = xlsxToMarkdown(canonicalBase64(input.dataBase64), input.sheetIndex === undefined ? {} : { sheetIndex: input.sheetIndex });
      return { operation, warnings: result.warnings, markdown: outputText(result.markdown) };
    }
    if (input?.sourceFormat === "csv") {
      exact(input, ["operation", "sourceFormat", "text", "delimiter"], ["operation", "sourceFormat", "text"]);
      const result = csvToMarkdown(input.text, input.delimiter === undefined ? {} : { delimiter: input.delimiter });
      return { operation, warnings: result.warnings, markdown: outputText(result.markdown) };
    }
    inputError();
  }
  if (operation === "from-markdown") {
    if (input?.outputFormat === "xlsx") {
      exact(input, ["operation", "outputFormat", "markdown", "sheetName"], ["operation", "outputFormat", "markdown"]);
      return {
        operation,
        outputFormat: "xlsx",
        warnings: [],
        ...binaryOutput(markdownTableToXlsx(input.markdown, input.sheetName === undefined ? {} : { sheetName: input.sheetName })),
      };
    }
    if (input?.outputFormat === "csv") {
      exact(input, ["operation", "outputFormat", "markdown", "delimiter"], ["operation", "outputFormat", "markdown"]);
      return {
        operation,
        outputFormat: "csv",
        warnings: [],
        text: outputText(markdownTableToCsv(input.markdown, input.delimiter === undefined ? {} : { delimiter: input.delimiter })),
      };
    }
    inputError();
  }
  inputError();
}

async function pdf(input) {
  const operation = input?.operation;
  if (operation === "merge") {
    exact(input, ["operation", "documentsBase64"]);
    if (!Array.isArray(input.documentsBase64) || input.documentsBase64.length === 0) inputError();
    const documents = input.documentsBase64.map(canonicalBase64);
    if (documents.reduce((sum, bytes) => sum + bytes.byteLength, 0) > MAX_TOTAL_BINARY_INPUT) inputTooLarge();
    return { operation, warnings: [], ...binaryOutput(await mergePdfs(documents)) };
  }
  if (operation === "split") {
    exact(input, ["operation", "dataBase64", "pageGroups"], ["operation", "dataBase64"]);
    const values = await splitPdf(
      canonicalBase64(input.dataBase64),
      input.pageGroups,
      { maxOutputBytes: MAX_BINARY_OUTPUT },
    );
    return { operation, warnings: [], ...binaryOutputs(values) };
  }
  if (operation === "reorder") {
    exact(input, ["operation", "dataBase64", "order"]);
    return { operation, warnings: [], ...binaryOutput(await reorderPdf(canonicalBase64(input.dataBase64), input.order)) };
  }
  if (operation === "rotate") {
    exact(input, ["operation", "dataBase64", "rotations"]);
    return { operation, warnings: [], ...binaryOutput(await rotatePdf(canonicalBase64(input.dataBase64), input.rotations)) };
  }
  if (operation === "sanitize") {
    exact(input, ["operation", "dataBase64"]);
    return { operation, warnings: [], ...binaryOutput(await sanitizePdfMetadata(canonicalBase64(input.dataBase64))) };
  }
  if (operation === "inspect") {
    exact(input, ["operation", "dataBase64"]);
    const summary = await inspectPdf(canonicalBase64(input.dataBase64));
    return { operation, warnings: summary.warnings, summary };
  }
  if (operation === "extract-pages") {
    exact(input, ["operation", "dataBase64", "pages"]);
    return { operation, warnings: [], ...binaryOutput(await extractPdfPages(canonicalBase64(input.dataBase64), input.pages)) };
  }
  if (operation === "delete-pages") {
    exact(input, ["operation", "dataBase64", "pages"]);
    return { operation, warnings: [], ...binaryOutput(await deletePdfPages(canonicalBase64(input.dataBase64), input.pages)) };
  }
  inputError();
}

function markdown(input) {
  const operation = input?.operation;
  if (operation === "parse") {
    exact(input, ["operation", "markdown"]);
    return { operation, warnings: [], blocks: parseMarkdownOutline(input.markdown).blocks };
  }
  if (operation === "to-docx") {
    exact(input, ["operation", "markdown", "title"], ["operation", "markdown"]);
    return { operation, warnings: [], ...binaryOutput(markdownOutlineToDocx(input.markdown, input.title === undefined ? {} : { title: input.title })) };
  }
  if (operation === "to-pptx") {
    exact(input, ["operation", "markdown", "title"], ["operation", "markdown"]);
    return { operation, warnings: [], ...binaryOutput(markdownOutlineToPptx(input.markdown, input.title === undefined ? {} : { title: input.title })) };
  }
  inputError();
}

async function execute(actionId, input) {
  if (actionId === OFFICE_ACTION_IDS.DOCX) return docx(input);
  if (actionId === OFFICE_ACTION_IDS.PPTX) return pptx(input);
  if (actionId === OFFICE_ACTION_IDS.SPREADSHEET) return spreadsheet(input);
  if (actionId === OFFICE_ACTION_IDS.PDF) return pdf(input);
  if (actionId === OFFICE_ACTION_IDS.MARKDOWN) return markdown(input);
  inputError();
}

function stableCode(error) {
  if (error?.stableCode) return error.stableCode;
  if (error instanceof OfficeCoreError) {
    if (error.code === "OUTPUT_TOO_LARGE") return ERROR_CODES.OUTPUT_TOO_LARGE;
    if (/TOO_LARGE|TOO_MANY|RATIO_EXCEEDED/.test(error.code)) return ERROR_CODES.INPUT_TOO_LARGE;
    return ERROR_CODES.INPUT_INVALID;
  }
  return ERROR_CODES.ACTION_FAILED;
}

parentPort.once("message", async (message) => {
  try {
    exact(message, ["actionId", "input"]);
    if (jsonBytes(message.input) > MAX_INPUT_JSON_BYTES) inputTooLarge();
    const output = await execute(message.actionId, message.input);
    if (jsonBytes(output, true) > MAX_OUTPUT_JSON_BYTES) outputTooLarge();
    parentPort.postMessage({ ok: true, output });
  } catch (error) {
    parentPort.postMessage({ ok: false, code: stableCode(error) });
  }
});
