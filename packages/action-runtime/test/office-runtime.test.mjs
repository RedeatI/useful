import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { validateValue } from "@useful/action-contract";
import { OFFICE_LIMITS } from "@useful/office-core";
import { PDFDocument } from "pdf-lib";
import {
  OFFICE_ACTION_IDS,
  OFFICE_ACTION_LIMITS,
  createOfficeActionDescriptors,
} from "../src/office-actions.mjs";
import { nodeOfficeHandler } from "../src/node-office.mjs";

const base64 = (bytes) => Buffer.from(bytes).toString("base64");
const decode = (value) => new Uint8Array(Buffer.from(value, "base64"));
const descriptors = new Map(
  Object.values(createOfficeActionDescriptors("0".repeat(64))).map((descriptor) => [descriptor.actionId, descriptor]),
);

async function office(actionId, input, options) {
  const descriptor = descriptors.get(actionId);
  assert.ok(descriptor);
  assert.deepEqual(validateValue(descriptor.inputSchema, input), []);
  const output = await nodeOfficeHandler(actionId, input, options);
  assert.deepEqual(validateValue(descriptor.outputSchema, output), []);
  return output;
}

function actionCode(expected) {
  return (error) => error?.actionCode === expected;
}

function assertBinaryResult(result) {
  assert.equal(typeof result.dataBase64, "string");
  const bytes = decode(result.dataBase64);
  assert.equal(result.sizeBytes, bytes.byteLength);
  assert.equal(result.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  return bytes;
}

test("DOCX worker composes, extracts, inspects and converts Markdown", async () => {
  const composed = await office(OFFICE_ACTION_IDS.DOCX, {
    operation: "compose",
    title: "本地报告",
    blocks: [
      { type: "heading", level: 1, text: "摘要" },
      { type: "paragraph", text: "内容不离开本机。" },
    ],
  });
  const bytes = assertBinaryResult(composed);
  const dataBase64 = base64(bytes);

  const extracted = await office(OFFICE_ACTION_IDS.DOCX, { operation: "extract", dataBase64 });
  assert.equal(extracted.document.title, "本地报告");
  assert.equal(extracted.document.blocks[0].type, "heading");

  const inspected = await office(OFFICE_ACTION_IDS.DOCX, { operation: "inspect", dataBase64 });
  assert.equal(inspected.summary.format, "docx");
  assert.equal(inspected.summary.metadata.title, "本地报告");

  const markdown = await office(OFFICE_ACTION_IDS.DOCX, { operation: "to-markdown", dataBase64 });
  assert.match(markdown.markdown, /^# 摘要/m);

  const fromMarkdown = await office(OFFICE_ACTION_IDS.DOCX, {
    operation: "from-markdown",
    title: "大纲",
    markdown: "# 计划\n\n- DOCX\n- PPTX",
  });
  assertBinaryResult(fromMarkdown);
});

test("PPTX worker composes, extracts, inspects and converts Markdown", async () => {
  const composed = await office(OFFICE_ACTION_IDS.PPTX, {
    operation: "compose",
    title: "路线图",
    slides: [{ title: "v1", bullets: ["Word", "PowerPoint"] }],
  });
  const dataBase64 = base64(assertBinaryResult(composed));
  const extracted = await office(OFFICE_ACTION_IDS.PPTX, { operation: "extract", dataBase64 });
  assert.equal(extracted.presentation.slides[0].title, "v1");
  const inspected = await office(OFFICE_ACTION_IDS.PPTX, { operation: "inspect", dataBase64 });
  assert.equal(inspected.summary.slides, 1);
  const markdown = await office(OFFICE_ACTION_IDS.PPTX, { operation: "to-markdown", dataBase64 });
  assert.match(markdown.markdown, /^## v1/m);
  assertBinaryResult(await office(OFFICE_ACTION_IDS.PPTX, {
    operation: "from-markdown",
    markdown: "## Slide\n\n- local only",
  }));
});

test("spreadsheet worker covers XLSX and both CSV directions without formula execution", async () => {
  const composed = await office(OFFICE_ACTION_IDS.SPREADSHEET, {
    operation: "compose",
    sheets: [{ name: "Data", rows: [["name", "value"], ["formula", { kind: "formula", formula: "1+1" }]] }],
  });
  const dataBase64 = base64(assertBinaryResult(composed));
  const extracted = await office(OFFICE_ACTION_IDS.SPREADSHEET, { operation: "extract", dataBase64 });
  assert.equal(extracted.workbook.sheets[0].rows[1][1], "'=1+1");

  const parsed = await office(OFFICE_ACTION_IDS.SPREADSHEET, {
    operation: "csv-parse",
    text: 'name,value\r\nformula,"=1+1"',
  });
  assert.equal(parsed.rows[1][1], "=1+1");
  const serialized = await office(OFFICE_ACTION_IDS.SPREADSHEET, {
    operation: "csv-stringify",
    rows: parsed.rows,
  });
  assert.match(serialized.text, /formula,'=1\+1/);

  const csvXlsx = await office(OFFICE_ACTION_IDS.SPREADSHEET, {
    operation: "csv-to-xlsx",
    sheetName: "Import",
    text: "a,b\n1,2",
  });
  const csvXlsxBase64 = base64(assertBinaryResult(csvXlsx));
  const xlsxCsv = await office(OFFICE_ACTION_IDS.SPREADSHEET, {
    operation: "xlsx-to-csv",
    dataBase64: csvXlsxBase64,
    sheetIndex: 0,
  });
  assert.equal(xlsxCsv.text, "a,b\r\n1,2");

  const inspectedXlsx = await office(OFFICE_ACTION_IDS.SPREADSHEET, { operation: "inspect-xlsx", dataBase64 });
  assert.equal(inspectedXlsx.summary.diagnostics.formulasEvaluated, false);
  const inspectedCsv = await office(OFFICE_ACTION_IDS.SPREADSHEET, { operation: "inspect-csv", text: "a,b\nformula,=1+1" });
  assert.equal(inspectedCsv.summary.formulaLikeCells, 1);

  const asMarkdown = await office(OFFICE_ACTION_IDS.SPREADSHEET, {
    operation: "to-markdown",
    sourceFormat: "csv",
    text: "a,b\n1,2",
  });
  assert.equal(asMarkdown.markdown, "| a | b |\n| --- | --- |\n| 1 | 2 |\n");
  const fromMarkdownCsv = await office(OFFICE_ACTION_IDS.SPREADSHEET, {
    operation: "from-markdown",
    outputFormat: "csv",
    markdown: "| a | b |\n| --- | --- |\n| formula | =1+1 |",
  });
  assert.equal(fromMarkdownCsv.text, "a,b\r\nformula,'=1+1");
  const fromMarkdownXlsx = await office(OFFICE_ACTION_IDS.SPREADSHEET, {
    operation: "from-markdown",
    outputFormat: "xlsx",
    markdown: "| a | b |\n| --- | --- |\n| 1 | 2 |",
  });
  assertBinaryResult(fromMarkdownXlsx);
});

async function makePdf(pages, metadata = false) {
  const document = await PDFDocument.create();
  for (let index = 0; index < pages; index++) document.addPage([200 + index, 300]);
  if (metadata) {
    document.setTitle("private title");
    document.setAuthor("private author");
  }
  return document.save();
}

test("PDF worker merges, splits, reorders, rotates and sanitizes", async () => {
  const one = await makePdf(1, true);
  const two = await makePdf(2);
  const merged = await office(OFFICE_ACTION_IDS.PDF, {
    operation: "merge",
    documentsBase64: [base64(one), base64(two)],
  });
  const mergedBytes = assertBinaryResult(merged);
  assert.equal((await PDFDocument.load(mergedBytes)).getPageCount(), 3);

  const split = await office(OFFICE_ACTION_IDS.PDF, {
    operation: "split",
    dataBase64: base64(mergedBytes),
    pageGroups: [[0, 2], [1]],
  });
  assert.deepEqual(split.sizesBytes.map((size) => Number.isInteger(size) && size > 0), [true, true]);
  split.documentsBase64.forEach((value, index) => {
    const bytes = decode(value);
    assert.equal(split.sha256s[index], createHash("sha256").update(bytes).digest("hex"));
  });

  const reordered = await office(OFFICE_ACTION_IDS.PDF, {
    operation: "reorder",
    dataBase64: base64(mergedBytes),
    order: [2, 1, 0],
  });
  assertBinaryResult(reordered);

  const rotated = await office(OFFICE_ACTION_IDS.PDF, {
    operation: "rotate",
    dataBase64: base64(mergedBytes),
    rotations: [{ page: 0, angle: 90 }],
  });
  assert.equal((await PDFDocument.load(assertBinaryResult(rotated))).getPage(0).getRotation().angle, 90);

  const sanitized = await office(OFFICE_ACTION_IDS.PDF, {
    operation: "sanitize",
    dataBase64: base64(one),
  });
  const sanitizedDocument = await PDFDocument.load(assertBinaryResult(sanitized), { updateMetadata: false });
  assert.equal(sanitizedDocument.context.trailerInfo.Info, undefined);
  assert.equal(sanitizedDocument.context.trailerInfo.ID, undefined);
  assert.equal(sanitizedDocument.getTitle(), undefined);
  assert.equal(sanitizedDocument.getAuthor(), undefined);

  const inspected = await office(OFFICE_ACTION_IDS.PDF, { operation: "inspect", dataBase64: base64(one) });
  assert.equal(inspected.summary.pageIndexBase, 0);
  assert.equal(inspected.summary.diagnostics.redactionVerified, false);
  const extracted = await office(OFFICE_ACTION_IDS.PDF, {
    operation: "extract-pages",
    dataBase64: base64(mergedBytes),
    pages: [2, 0],
  });
  assert.equal((await PDFDocument.load(assertBinaryResult(extracted))).getPageCount(), 2);
  const deleted = await office(OFFICE_ACTION_IDS.PDF, {
    operation: "delete-pages",
    dataBase64: base64(mergedBytes),
    pages: [1],
  });
  assert.equal((await PDFDocument.load(assertBinaryResult(deleted))).getPageCount(), 2);
  await assert.rejects(
    nodeOfficeHandler(OFFICE_ACTION_IDS.PDF, { operation: "extract-pages", dataBase64: base64(mergedBytes), pages: [0, 0] }),
    actionCode("INPUT_INVALID"),
  );
});

test("Markdown worker parses and emits both binary formats", async () => {
  const markdown = "# Product\n\n## v1\n\n- local\n- bounded";
  const parsed = await office(OFFICE_ACTION_IDS.MARKDOWN, { operation: "parse", markdown });
  assert.ok(parsed.blocks.some((block) => block.type === "heading"));
  assertBinaryResult(await office(OFFICE_ACTION_IDS.MARKDOWN, { operation: "to-docx", markdown }));
  assertBinaryResult(await office(OFFICE_ACTION_IDS.MARKDOWN, { operation: "to-pptx", markdown }));
});

test("worker rejects non-canonical Base64, unknown keys and missing required keys with stable codes", async () => {
  for (const dataBase64 of ["YQ", "YQ==\n", "YQ--", "YR=="]) {
    await assert.rejects(
      nodeOfficeHandler(OFFICE_ACTION_IDS.DOCX, { operation: "inspect", dataBase64 }),
      actionCode("INPUT_INVALID"),
    );
  }
  await assert.rejects(
    nodeOfficeHandler(OFFICE_ACTION_IDS.DOCX, { operation: "compose", blocks: [], command: "calc.exe" }),
    actionCode("INPUT_INVALID"),
  );
  await assert.rejects(
    nodeOfficeHandler(OFFICE_ACTION_IDS.DOCX, { operation: "inspect", dataBase64: "", path: "C:\\secret.docx" }),
    actionCode("INPUT_INVALID"),
  );
  await assert.rejects(
    nodeOfficeHandler(OFFICE_ACTION_IDS.PDF, { operation: "sanitize", dataBase64: "", url: "https://example.invalid/file.pdf" }),
    actionCode("INPUT_INVALID"),
  );
  await assert.rejects(
    nodeOfficeHandler(OFFICE_ACTION_IDS.SPREADSHEET, { operation: "inspect-xlsx", dataBase64: "", path: "C:\\secret.xlsx" }),
    actionCode("INPUT_INVALID"),
  );
  await assert.rejects(
    nodeOfficeHandler(OFFICE_ACTION_IDS.SPREADSHEET, { operation: "to-markdown", sourceFormat: "csv", text: "a", url: "https://example.invalid/a.csv" }),
    actionCode("INPUT_INVALID"),
  );
  await assert.rejects(
    nodeOfficeHandler(OFFICE_ACTION_IDS.PDF, { operation: "reorder", dataBase64: "" }),
    actionCode("INPUT_INVALID"),
  );
  await assert.rejects(
    nodeOfficeHandler("builtin.office.unknown", { operation: "inspect", dataBase64: "" }),
    actionCode("UNKNOWN_ACTION"),
  );
});

test("Office descriptors match the worker envelope and reject incomplete formula objects", () => {
  assert.equal(OFFICE_ACTION_LIMITS.maxBase64Chars, 6_000_000);
  assert.equal(OFFICE_ACTION_LIMITS.maxDecodedBase64Bytes, 4_500_000);
  assert.equal(OFFICE_ACTION_LIMITS.maxInputJsonBytes, 8 * 1024 * 1024);
  assert.equal(OFFICE_ACTION_LIMITS.maxOutputJsonBytes, 16 * 1024 * 1024);
  assert.equal(OFFICE_ACTION_LIMITS.maxBinaryOutputBytes, 8 * 1024 * 1024);
  assert.equal(OFFICE_LIMITS.archiveBytes, 64 * 1024 * 1024);
  assert.equal(OFFICE_LIMITS.pdfBytes, 128 * 1024 * 1024);
  assert.ok(OFFICE_ACTION_LIMITS.maxDecodedBase64Bytes < OFFICE_LIMITS.archiveBytes);
  assert.ok(OFFICE_ACTION_LIMITS.maxDecodedBase64Bytes < OFFICE_LIMITS.pdfBytes);
  for (const descriptor of descriptors.values()) {
    assert.equal(descriptor.execution.maxInputBytes, OFFICE_ACTION_LIMITS.maxInputJsonBytes);
    assert.equal(descriptor.execution.maxOutputBytes, OFFICE_ACTION_LIMITS.maxOutputJsonBytes);
  }
  const spreadsheet = descriptors.get(OFFICE_ACTION_IDS.SPREADSHEET);
  assert.notDeepEqual(validateValue(spreadsheet.inputSchema, {
    operation: "csv-stringify",
    rows: [[{}]],
  }), []);
});

test("worker maps Base64 and generated text limits to stable size errors", async () => {
  await assert.rejects(
    nodeOfficeHandler(OFFICE_ACTION_IDS.DOCX, {
      operation: "inspect",
      dataBase64: "AAAA".repeat(1_500_001),
    }),
    actionCode("INPUT_TOO_LARGE"),
  );
  const rows = Array.from({ length: 50 }, () => ["x".repeat(100000)]);
  await assert.rejects(
    office(OFFICE_ACTION_IDS.SPREADSHEET, { operation: "csv-stringify", rows }),
    actionCode("OUTPUT_TOO_LARGE"),
  );
});

test("AbortSignal terminates the single-use Office worker", async () => {
  const controller = new AbortController();
  const slides = Array.from({ length: 500 }, (_, index) => ({ title: `Slide ${index}`, body: "x".repeat(1000) }));
  const pending = office(OFFICE_ACTION_IDS.PPTX, { operation: "compose", slides }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, actionCode("CANCELLED"));

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(
    office(OFFICE_ACTION_IDS.DOCX, { operation: "compose", blocks: [] }, { signal: alreadyAborted.signal }),
    actionCode("CANCELLED"),
  );
  await assert.rejects(
    nodeOfficeHandler(OFFICE_ACTION_IDS.DOCX, { operation: "compose", blocks: [] }, { signal: {} }),
    actionCode("INPUT_INVALID"),
  );
});
