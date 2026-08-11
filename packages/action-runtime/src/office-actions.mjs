import { createBuiltinDescriptorMetadata, OFFICE_ACTION_IDS } from "./catalog.mjs";
import { ERROR_CODES } from "./semantics.mjs";

export { OFFICE_ACTION_IDS };

const DRAFT = "https://json-schema.org/draft/2020-12/schema";
export const OFFICE_ACTION_LIMITS = Object.freeze({
  maxInputJsonBytes: 8 * 1024 * 1024,
  maxOutputJsonBytes: 16 * 1024 * 1024,
  maxBase64Chars: 6_000_000,
  maxDecodedBase64Bytes: 4_500_000,
  maxBinaryOutputBytes: 8 * 1024 * 1024,
  maxBinaryOutputBase64Chars: 4 * Math.ceil((8 * 1024 * 1024) / 3),
  maxTextChars: 1_048_576,
  maxOutputTextChars: 4_194_304,
});
const MODEL_TEXT_CHARS = 100000;
const FORMULA_CHARS = 32768;
const string = (maxLength = OFFICE_ACTION_LIMITS.maxTextChars) => ({ type: "string", maxLength });
const fixedString = (length) => ({ type: "string", minLength: length, maxLength: length });
const integer = (minimum, maximum) => ({ type: "integer", minimum, maximum });
const number = (minimum, maximum) => ({ type: "number", minimum, maximum });
const boolean = () => ({ type: "boolean" });
const enumeration = (...values) => ({ type: "string", enum: values });
const object = (properties, required = Object.keys(properties)) => ({
  $schema: DRAFT,
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
const nestedObject = (properties, required = Object.keys(properties)) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
const array = (items, maxItems, minItems = undefined) => ({
  type: "array",
  items,
  maxItems,
  ...(minItems === undefined ? {} : { minItems }),
});

const warningList = array(string(256), 256);
const archive = nestedObject({
  archiveBytes: integer(0, OFFICE_ACTION_LIMITS.maxDecodedBase64Bytes),
  expandedBytes: integer(0, 268435456),
  entries: integer(0, 4096),
});
const binaryResult = {
  dataBase64: string(OFFICE_ACTION_LIMITS.maxBinaryOutputBase64Chars),
  sizeBytes: integer(0, OFFICE_ACTION_LIMITS.maxBinaryOutputBytes),
  sha256: fixedString(64),
};
const docxBlock = nestedObject({
  type: enumeration("paragraph", "heading", "list", "table", "pageBreak"),
  text: string(MODEL_TEXT_CHARS),
  level: integer(1, 6),
  ordered: boolean(),
  items: array(string(MODEL_TEXT_CHARS), 4096),
  rows: array(array(string(MODEL_TEXT_CHARS), 256), 4096),
}, ["type"]);
const slide = nestedObject({
  title: string(4096),
  body: string(MODEL_TEXT_CHARS),
  bullets: array(string(MODEL_TEXT_CHARS), 1000),
}, []);
const primitiveCell = {
  type: ["string", "number", "boolean", "null", "object"],
  maxLength: MODEL_TEXT_CHARS,
  properties: { kind: { type: "string", const: "formula" }, formula: string(FORMULA_CHARS) },
  required: ["kind", "formula"],
  additionalProperties: false,
};
const rows = array(array(primitiveCell, 10000), 100000);
const sheetRows = array(array(primitiveCell, 16384), 100000);
const sheet = nestedObject({ name: string(31), rows: sheetRows }, ["name", "rows"]);
const rotation = nestedObject({ page: integer(0, 4999), angle: { type: "integer", enum: [0, 90, 180, 270] } });
const pdfCatalog = nestedObject(Object.fromEntries(
  ["OpenAction", "AA", "Names", "AcroForm", "Metadata", "Perms", "Outlines", "Collection", "AF"].map((key) => [key, boolean()]),
));
const pdfPageFeatures = nestedObject(Object.fromEntries(
  ["AA", "Annots", "Metadata", "PieceInfo", "PresSteps", "Trans", "Dur", "AF"].map((key) => [key, integer(0, 5000)]),
));
const pdfPageDetail = nestedObject({
  index: integer(0, 4999),
  widthPoints: number(0, 1_000_000),
  heightPoints: number(0, 1_000_000),
  rotationDegrees: number(0, 359.999),
});

function descriptor(sourceDigest, options) {
  const metadata = createBuiltinDescriptorMetadata(options.actionId, sourceDigest);
  return {
    ...metadata,
    inputSchema: options.inputSchema,
    outputSchema: options.outputSchema,
    examples: [],
    testVectors: [{
      name: "reject unknown operation",
      input: { operation: "execute-macro" },
      expectedErrorCode: ERROR_CODES.INPUT_INVALID,
    }],
    execution: {
      ...metadata.execution,
      handler: options.actionId,
      timeoutMs: 15000,
      maxInputBytes: OFFICE_ACTION_LIMITS.maxInputJsonBytes,
      maxOutputBytes: OFFICE_ACTION_LIMITS.maxOutputJsonBytes,
      supportsCancellation: true,
    },
    sensitive: {
      input: options.sensitiveInput,
      output: options.sensitiveOutput,
      redactLogs: true,
    },
  };
}

export function createOfficeActionDescriptors(sourceDigest) {
  if (!/^[a-f0-9]{64}$/.test(sourceDigest)) throw new TypeError("sourceDigest must be SHA-256 hex");
  const docx = descriptor(sourceDigest, {
    actionId: OFFICE_ACTION_IDS.DOCX,
    sensitiveInput: ["/dataBase64", "/blocks", "/markdown", "/title"],
    sensitiveOutput: ["/dataBase64", "/document", "/markdown", "/summary"],
    inputSchema: object({
      operation: enumeration("compose", "extract", "inspect", "to-markdown", "from-markdown"),
      dataBase64: string(OFFICE_ACTION_LIMITS.maxBase64Chars), title: string(512), blocks: array(docxBlock, 2000), markdown: string(OFFICE_ACTION_LIMITS.maxTextChars),
    }, ["operation"]),
    outputSchema: object({
      operation: enumeration("compose", "extract", "inspect", "to-markdown", "from-markdown"), warnings: warningList,
      ...binaryResult,
      document: nestedObject({ title: string(512), blocks: array(docxBlock, 2000) }),
      markdown: string(OFFICE_ACTION_LIMITS.maxOutputTextChars),
      summary: nestedObject({
        format: { type: "string", const: "docx" }, archiveBytes: integer(0, OFFICE_ACTION_LIMITS.maxDecodedBase64Bytes), expandedBytes: integer(0, 268435456), entries: integer(0, 4096),
        paragraphs: integer(0, 100000), tables: integer(0, 10000), images: integer(0, 4096),
        metadata: nestedObject({ title: string(512), creator: string(512) }), warnings: warningList,
      }),
      archive,
    }, ["operation", "warnings"]),
  });
  const pptx = descriptor(sourceDigest, {
    actionId: OFFICE_ACTION_IDS.PPTX,
    sensitiveInput: ["/dataBase64", "/slides", "/markdown", "/title"],
    sensitiveOutput: ["/dataBase64", "/presentation", "/markdown", "/summary"],
    inputSchema: object({
      operation: enumeration("compose", "extract", "inspect", "to-markdown", "from-markdown"),
      dataBase64: string(OFFICE_ACTION_LIMITS.maxBase64Chars), title: string(512), slides: array(slide, 500), markdown: string(OFFICE_ACTION_LIMITS.maxTextChars),
    }, ["operation"]),
    outputSchema: object({
      operation: enumeration("compose", "extract", "inspect", "to-markdown", "from-markdown"), warnings: warningList,
      ...binaryResult,
      presentation: nestedObject({ title: string(512), slides: array(nestedObject({ title: string(4096), body: string(MODEL_TEXT_CHARS), notes: string(MODEL_TEXT_CHARS) }, ["title", "body"]), 500) }),
      markdown: string(OFFICE_ACTION_LIMITS.maxOutputTextChars),
      summary: nestedObject({
        format: { type: "string", const: "pptx" }, archiveBytes: integer(0, OFFICE_ACTION_LIMITS.maxDecodedBase64Bytes), expandedBytes: integer(0, 268435456), entries: integer(0, 4096),
        slides: integer(0, 500), textRuns: integer(0, 100000), images: integer(0, 4096),
        metadata: nestedObject({ title: string(512), creator: string(512) }), warnings: warningList,
      }),
      archive,
    }, ["operation", "warnings"]),
  });
  const spreadsheet = descriptor(sourceDigest, {
    actionId: OFFICE_ACTION_IDS.SPREADSHEET,
    sensitiveInput: ["/dataBase64", "/sheets", "/rows", "/text", "/markdown"],
    sensitiveOutput: ["/dataBase64", "/workbook", "/rows", "/text", "/markdown", "/summary"],
    inputSchema: object({
      operation: enumeration("compose", "extract", "csv-parse", "csv-stringify", "csv-to-xlsx", "xlsx-to-csv", "inspect-xlsx", "inspect-csv", "to-markdown", "from-markdown"),
      dataBase64: string(OFFICE_ACTION_LIMITS.maxBase64Chars), sheets: array(sheet, 64, 1), rows, text: string(OFFICE_ACTION_LIMITS.maxTextChars),
      markdown: string(OFFICE_ACTION_LIMITS.maxTextChars), sourceFormat: enumeration("xlsx", "csv"), outputFormat: enumeration("xlsx", "csv"),
      delimiter: string(1), sheetName: string(31), sheetIndex: integer(0, 63), escapeFormulas: boolean(),
    }, ["operation"]),
    outputSchema: object({
      operation: enumeration("compose", "extract", "csv-parse", "csv-stringify", "csv-to-xlsx", "xlsx-to-csv", "inspect-xlsx", "inspect-csv", "to-markdown", "from-markdown"), warnings: warningList,
      ...binaryResult, outputFormat: enumeration("xlsx", "csv"),
      workbook: nestedObject({ sheets: array(sheet, 64, 1) }), rows, text: string(OFFICE_ACTION_LIMITS.maxOutputTextChars), markdown: string(OFFICE_ACTION_LIMITS.maxOutputTextChars), delimiter: string(1), archive,
      summary: nestedObject({
        format: enumeration("xlsx", "csv"), archiveBytes: integer(0, OFFICE_ACTION_LIMITS.maxDecodedBase64Bytes), expandedBytes: integer(0, 268435456), entries: integer(0, 4096),
        sheetCount: integer(0, 64), rows: integer(0, 100000), columns: integer(0, 16384), cells: integer(0, 1000000), nonEmptyCells: integer(0, 1000000), formulaCells: integer(0, 1000000), formulaLikeCells: integer(0, 1000000), bytes: integer(0, 16777216), delimiter: string(1),
        sheets: array(nestedObject({ index: integer(0, 63), name: string(31), rows: integer(0, 100000), columns: integer(0, 16384), cells: integer(0, 1000000), formulaCells: integer(0, 1000000) }), 64),
        diagnostics: nestedObject({ formulasEvaluated: boolean(), externalRelationshipsFollowed: boolean(), externalResourcesFetched: boolean(), unevenRows: integer(0, 100000) }, ["formulasEvaluated"]),
        warnings: warningList,
      }, ["format", "rows", "cells", "diagnostics", "warnings"]),
    }, ["operation", "warnings"]),
  });
  const pdf = descriptor(sourceDigest, {
    actionId: OFFICE_ACTION_IDS.PDF,
    sensitiveInput: ["/dataBase64", "/documentsBase64"],
    sensitiveOutput: ["/dataBase64", "/documentsBase64"],
    inputSchema: object({
      operation: enumeration("merge", "split", "reorder", "rotate", "sanitize", "inspect", "extract-pages", "delete-pages"),
      dataBase64: string(OFFICE_ACTION_LIMITS.maxBase64Chars), documentsBase64: array(string(OFFICE_ACTION_LIMITS.maxBase64Chars), 256, 1),
      pageGroups: array(array(integer(0, 4999), 5000, 1), 5000, 1), pages: array(integer(0, 4999), 5000, 1), order: array(integer(0, 4999), 5000), rotations: array(rotation, 5000),
    }, ["operation"]),
    outputSchema: object({
      operation: enumeration("merge", "split", "reorder", "rotate", "sanitize", "inspect", "extract-pages", "delete-pages"), warnings: warningList,
      ...binaryResult,
      documentsBase64: array(string(OFFICE_ACTION_LIMITS.maxBinaryOutputBase64Chars), 5000),
      sizesBytes: array(integer(0, OFFICE_ACTION_LIMITS.maxBinaryOutputBytes), 5000),
      sha256s: array(fixedString(64), 5000),
      summary: nestedObject({
        format: { type: "string", const: "pdf" }, bytes: integer(0, OFFICE_ACTION_LIMITS.maxDecodedBase64Bytes), pages: integer(0, 5000), pageIndexBase: { type: "integer", const: 0 },
        metadataPresence: nestedObject({ infoDictionary: boolean(), documentIdentifier: boolean(), catalogMetadata: boolean() }),
        catalog: pdfCatalog, pageFeatures: pdfPageFeatures, pageDetails: array(pdfPageDetail, 5000),
        diagnostics: nestedObject({ structureOnly: { type: "boolean", const: true }, contentSafetyAssessed: { type: "boolean", const: false }, redactionVerified: { type: "boolean", const: false } }),
        warnings: warningList,
      }),
    }, ["operation", "warnings"]),
  });
  const markdown = descriptor(sourceDigest, {
    actionId: OFFICE_ACTION_IDS.MARKDOWN,
    sensitiveInput: ["/markdown", "/title"],
    sensitiveOutput: ["/dataBase64", "/blocks"],
    inputSchema: object({ operation: enumeration("parse", "to-docx", "to-pptx"), markdown: string(OFFICE_ACTION_LIMITS.maxTextChars), title: string(512) }, ["operation", "markdown"]),
    outputSchema: object({ operation: enumeration("parse", "to-docx", "to-pptx"), warnings: warningList, ...binaryResult, blocks: array(docxBlock, 2000) }, ["operation", "warnings"]),
  });
  return Object.freeze({ docx, pptx, spreadsheet, pdf, markdown });
}

export function createOfficeActionHandlers(adapter) {
  const execute = typeof adapter === "function" ? adapter : adapter?.execute;
  return Object.freeze(Object.fromEntries(Object.values(OFFICE_ACTION_IDS).map((actionId) => [
    actionId,
    async (input, context) => {
      if (typeof execute !== "function") {
        const error = new Error("Office worker adapter is unavailable");
        error.actionCode = ERROR_CODES.ACTION_FAILED;
        throw error;
      }
      return execute(actionId, input, context);
    },
  ])));
}
