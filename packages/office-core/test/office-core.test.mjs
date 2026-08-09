import assert from "node:assert/strict";
import { test } from "node:test";
import { strToU8, unzipSync, zipSync } from "fflate";
import { PDFDocument, PDFName } from "pdf-lib";
import {
  OfficeCoreError,
  composeDocx,
  composePptx,
  composeXlsx,
  csvToMarkdown,
  deletePdfPages,
  docxToMarkdown,
  escapeSpreadsheetFormula,
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
  parseMarkdownTable,
  markdownOutlineToDocx,
  markdownOutlineToPptx,
  mergePdfs,
  parseCsv,
  preflightZip,
  reorderPdf,
  rotatePdf,
  safeUnzip,
  sanitizePdfMetadata,
  splitPdf,
  stringifyCsv,
  xlsxToMarkdown,
} from "../src/index.mjs";

function code(expected) {
  return (error) => error instanceof OfficeCoreError && error.code === expected;
}

function localDataOffset(bytes, localOffset = 0) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
}

test("OOXML ZIP preflight rejects traversal, duplicates, bombs and oversize parts", () => {
  const traversal = zipSync({ "../evil.xml": strToU8("x") });
  assert.throws(() => preflightZip(traversal), code("ZIP_PATH_INVALID"));
  assert.throws(() => preflightZip(zipSync({ "__proto__/evil.xml": strToU8("x") })), code("ZIP_PATH_INVALID"));

  const duplicate = zipSync({ "a.xml": strToU8("a"), "b.xml": strToU8("b") });
  const duplicateText = new TextDecoder("latin1").decode(duplicate);
  const centralB = duplicateText.lastIndexOf("b.xml");
  assert.ok(centralB > 0);
  duplicate[centralB] = "a".charCodeAt(0);
  assert.throws(() => preflightZip(duplicate), code("ZIP_DUPLICATE_ENTRY"));

  const bomb = zipSync({ "word/document.xml": new Uint8Array(1024 * 1024).fill(65) }, { level: 9 });
  assert.throws(() => preflightZip(bomb, { compressionRatio: 2 }), code("ZIP_RATIO_EXCEEDED"));

  const large = zipSync({ "word/document.xml": new Uint8Array(1024).fill(65) }, { level: 0 });
  assert.throws(() => preflightZip(large, { partBytes: 100 }), code("ZIP_PART_TOO_LARGE"));

  const headerMismatch = zipSync({ "a.xml": strToU8("abc") }, { level: 0 });
  new DataView(headerMismatch.buffer, headerMismatch.byteOffset, headerMismatch.byteLength).setUint32(18, 2, true);
  assert.throws(() => preflightZip(headerMismatch), code("ZIP_HEADER_MISMATCH"));

  const corrupt = zipSync({ "a.xml": strToU8("abc") }, { level: 0 });
  corrupt[localDataOffset(corrupt)] ^= 1;
  assert.throws(() => safeUnzip(corrupt), code("ZIP_CRC_MISMATCH"));
});

test("DOCX compose, inspect, extract and Markdown stay in the closed document model", () => {
  assert.throws(
    () => composeDocx({ blocks: [{ type: "paragraph", text: "bad\u0001text" }] }),
    code("INPUT_INVALID"),
  );
  const bytes = composeDocx({
    title: "季度总结",
    blocks: [
      { type: "heading", level: 1, text: "摘要" },
      { type: "paragraph", text: "全部数据仅在本地处理。" },
      { type: "list", ordered: false, items: ["第一项", "第二项"] },
      { type: "table", rows: [["项目", "状态"], ["文档", "完成"]] },
      { type: "pageBreak" },
    ],
  });
  assert.ok(bytes instanceof Uint8Array);
  const report = inspectDocx(bytes);
  assert.equal(report.format, "docx");
  assert.equal(report.metadata.title, "季度总结");
  assert.equal(report.tables, 1);
  assert.deepEqual(report.warnings, []);
  const extracted = extractDocx(bytes);
  assert.equal(extracted.document.title, "季度总结");
  assert.ok(extracted.document.blocks.some((block) => block.type === "heading" && block.text === "摘要"));
  const markdown = docxToMarkdown(bytes).markdown;
  assert.match(markdown, /^# 摘要/m);
  assert.match(markdown, /\| 项目 \| 状态 \|/);
});

test("OOXML extraction reports encoded external relationships, macros and embedded objects without following them", () => {
  const files = unzipSync(composeDocx({ title: "safe", blocks: [{ type: "paragraph", text: "local" }] }));
  files["word/_rels/document.xml.rels"] = strToU8(
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rExternal" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/secret" TargetMode="Extern&#x61;l"/>'
      + '<Relationship Id="rObject" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="../embeddings/object1.bin"/>'
      + "</Relationships>",
  );
  files["word/vbaProject.bin"] = strToU8("not executed");
  files["word/embeddings/object1.bin"] = strToU8("not opened");
  const extracted = extractDocx(zipSync(files, { level: 0 }));
  assert.deepEqual(extracted.warnings, [
    "embedded-objects-not-executed",
    "external-relationships-blocked",
    "macros-not-executed",
  ]);

  const dtdFiles = unzipSync(composeDocx({ blocks: [] }));
  dtdFiles["word/document.xml"] = strToU8(
    '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY secret "value">]><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>',
  );
  assert.throws(() => extractDocx(zipSync(dtdFiles, { level: 0 })), code("XML_DTD_FORBIDDEN"));
});

test("PPTX compose, inspect and extract preserve title/body without external relationships", () => {
  const bytes = composePptx({
    title: "路线图",
    slides: [
      { title: "目标", bullets: ["离线", "可取消"] },
      { title: "边界", body: "不执行宏、关系或公式" },
    ],
  });
  const report = inspectPptx(bytes);
  assert.equal(report.slides, 2);
  assert.deepEqual(report.warnings, []);
  const extracted = extractPptx(bytes);
  assert.equal(extracted.presentation.title, "路线图");
  assert.equal(extracted.presentation.slides[0].title, "目标");
  assert.match(extracted.presentation.slides[0].body, /离线/);
});

test("XLSX compose/extract never emits formulas and extraction reports formulas as data", () => {
  const bytes = composeXlsx({
    sheets: [{ name: "数据", rows: [["名称", "值"], ["危险", "=HYPERLINK(\"https://example.test\")"], ["计数", 3], ["有效", true]] }],
  });
  const extracted = extractXlsx(bytes);
  assert.equal(extracted.workbook.sheets[0].name, "数据");
  assert.equal(extracted.workbook.sheets[0].rows[1][1], "'=HYPERLINK(\"https://example.test\")");
  assert.equal(extracted.workbook.sheets[0].rows[2][1], 3);
  assert.equal(extracted.workbook.sheets[0].rows[3][1], true);

  const formulaFiles = unzipSync(composeXlsx({ sheets: [{ name: "Formula", rows: [["safe"]] }] }));
  const sheetXml = new TextDecoder().decode(formulaFiles["xl/worksheets/sheet1.xml"]);
  const formulaXml = sheetXml.replace(
    '<c r="A1" t="inlineStr"><is><t>safe</t></is></c>',
    '<c r="A1"><f>SUM(1,1)</f><v>2</v></c>',
  );
  assert.notEqual(formulaXml, sheetXml);
  formulaFiles["xl/worksheets/sheet1.xml"] = strToU8(formulaXml);
  assert.deepEqual(
    extractXlsx(zipSync(formulaFiles, { level: 0 })).workbook.sheets[0].rows[0][0],
    { kind: "formula", formula: "SUM(1,1)" },
  );

  const wrongTypeFiles = unzipSync(composeXlsx({ sheets: [{ name: "Data", rows: [["safe"]] }] }));
  wrongTypeFiles["xl/_rels/workbook.xml.rels"] = strToU8(
    new TextDecoder().decode(wrongTypeFiles["xl/_rels/workbook.xml.rels"]).replace(
      "/relationships/worksheet\"",
      "/relationships/styles\"",
    ),
  );
  assert.throws(() => extractXlsx(zipSync(wrongTypeFiles, { level: 0 })), code("XLSX_INVALID"));

  const externalFiles = unzipSync(composeXlsx({ sheets: [{ name: "Data", rows: [["safe"]] }] }));
  externalFiles["xl/_rels/workbook.xml.rels"] = strToU8(
    new TextDecoder().decode(externalFiles["xl/_rels/workbook.xml.rels"]).replace(
      'Target="worksheets/sheet1.xml"',
      'Target="\\\\server\\share\\sheet1.xml"',
    ),
  );
  assert.throws(() => extractXlsx(zipSync(externalFiles, { level: 0 })), code("XLSX_INVALID"));
});

test("CSV is RFC-style quoted and escapes spreadsheet formulas by default", () => {
  assert.equal(escapeSpreadsheetFormula(" =1+1"), "' =1+1");
  assert.equal(escapeSpreadsheetFormula("\n=1+1"), "'\n=1+1");
  assert.equal(escapeSpreadsheetFormula("\u00a0@SUM(A1)"), "'\u00a0@SUM(A1)");
  assert.equal(escapeSpreadsheetFormula("\ufeff-HYPERLINK(\"x\")"), "'\ufeff-HYPERLINK(\"x\")");
  const text = stringifyCsv([["name", "value"], ["quoted", "a,b"], ["formula", "=1+1"]]);
  assert.equal(text, 'name,value\r\nquoted,"a,b"\r\nformula,\'=1+1');
  assert.deepEqual(parseCsv(text).rows, [["name", "value"], ["quoted", "a,b"], ["formula", "'=1+1"]]);
  assert.throws(() => parseCsv('"unterminated'), code("CSV_INVALID"));
});

test("spreadsheet inspection is bounded and simple Markdown tables never evaluate formulas", () => {
  const xlsx = composeXlsx({
    sheets: [{ name: "Data", rows: [["name", "value"], ["formula", "=1+1"]] }],
  });
  const xlsxSummary = inspectXlsx(xlsx);
  assert.equal(xlsxSummary.format, "xlsx");
  assert.equal(xlsxSummary.sheetCount, 1);
  assert.equal(xlsxSummary.diagnostics.formulasEvaluated, false);
  assert.equal(xlsxSummary.diagnostics.externalRelationshipsFollowed, false);

  const csvSummary = inspectCsv("name,value\nformula,=1+1");
  assert.equal(csvSummary.formulaLikeCells, 1);
  assert.equal(csvSummary.diagnostics.formulasEvaluated, false);
  assert.deepEqual(Object.keys(csvSummary).sort(), [
    "bytes", "cells", "columns", "delimiter", "diagnostics", "format", "formulaLikeCells", "nonEmptyCells", "rows", "warnings",
  ]);

  const markdown = xlsxToMarkdown(xlsx).markdown;
  assert.match(markdown, /^\| name \| value \|/u);
  assert.deepEqual(parseMarkdownTable(markdown).rows[1], ["formula", "'=1+1"]);
  assert.equal(csvToMarkdown("a,b\n1,2").markdown, "| a | b |\n| --- | --- |\n| 1 | 2 |\n");

  const table = "| name | value |\n| --- | --- |\n| formula | =1+1 |\n";
  assert.equal(markdownTableToCsv(table), "name,value\r\nformula,'=1+1");
  const tableXlsx = extractXlsx(markdownTableToXlsx(table));
  assert.equal(tableXlsx.workbook.sheets[0].rows[1][1], "'=1+1");
  assert.throws(() => parseMarkdownTable("[remote](https://example.invalid)"), code("MARKDOWN_TABLE_INVALID"));
  assert.throws(() => parseMarkdownTable("| a | b |\n| --- | --- |\n| only-one |"), code("MARKDOWN_TABLE_INVALID"));
});

test("Markdown outline produces both DOCX and PPTX closed models", () => {
  const markdown = "# 产品计划\n\n## v1\n\n- DOCX\n- PPTX\n\n## v2\n\nPDF pages";
  assert.equal(inspectDocx(markdownOutlineToDocx(markdown, { title: "产品计划" })).metadata.title, "产品计划");
  assert.equal(inspectPptx(markdownOutlineToPptx(markdown, { title: "产品计划" })).slides, 3);
});

async function pdfWithPages(count, metadata = false) {
  const document = await PDFDocument.create();
  for (let index = 0; index < count; index++) document.addPage([200 + index, 300]);
  if (metadata) {
    document.setTitle("secret title");
    document.setAuthor("secret author");
  }
  return document.save();
}

async function pdfWithActiveHooks() {
  const document = await PDFDocument.create();
  const page = document.addPage([200, 300]);
  document.setTitle("secret title");
  document.setAuthor("secret author");
  const action = document.context.obj({});
  document.catalog.set(PDFName.of("OpenAction"), action);
  document.catalog.set(PDFName.of("AA"), action);
  document.catalog.set(PDFName.of("AcroForm"), document.context.obj({ XFA: action }));
  document.catalog.set(PDFName.of("Names"), document.context.obj({
    JavaScript: document.context.obj({ Names: ["run", action] }),
    EmbeddedFiles: document.context.obj({ Names: ["payload", action] }),
  }));
  page.node.set(PDFName.of("AA"), action);
  page.node.set(PDFName.of("Annots"), document.context.obj([action]));
  page.node.set(PDFName.of("Metadata"), action);
  return document.save();
}

test("PDF merge/split/reorder/rotate and sanitize return bounded valid documents", async () => {
  const one = await pdfWithPages(1, true);
  const two = await pdfWithPages(2);
  const merged = await mergePdfs([one, two]);
  assert.equal((await PDFDocument.load(merged)).getPageCount(), 3);

  const pieces = await splitPdf(merged, [[0, 2], [1]]);
  assert.deepEqual(await Promise.all(pieces.map(async (bytes) => (await PDFDocument.load(bytes)).getPageCount())), [2, 1]);
  await assert.rejects(splitPdf(merged, [[0], [1]], { maxOutputBytes: 1 }), code("OUTPUT_TOO_LARGE"));

  const reordered = await reorderPdf(merged, [2, 1, 0]);
  assert.equal((await PDFDocument.load(reordered)).getPageCount(), 3);

  const rotated = await rotatePdf(merged, [{ page: 0, angle: 90 }]);
  assert.equal((await PDFDocument.load(rotated)).getPage(0).getRotation().angle, 90);

  const sanitized = await PDFDocument.load(await sanitizePdfMetadata(await pdfWithActiveHooks()), { updateMetadata: false });
  assert.equal(sanitized.getPageCount(), 1);
  assert.equal(sanitized.context.trailerInfo.Info, undefined);
  assert.equal(sanitized.context.trailerInfo.ID, undefined);
  // pdf-lib metadata getters lazily create an empty Info dictionary, so verify
  // the serialized trailer before calling them.
  assert.equal(sanitized.getTitle(), undefined);
  assert.equal(sanitized.getAuthor(), undefined);
  for (const key of ["OpenAction", "AA", "Names", "AcroForm", "Metadata", "Perms", "Outlines", "Collection", "AF"]) {
    assert.equal(sanitized.catalog.has(PDFName.of(key)), false);
  }
  for (const key of ["AA", "Annots", "Metadata", "PieceInfo", "PresSteps", "Trans", "Dur", "AF"]) {
    assert.equal(sanitized.getPage(0).node.has(PDFName.of(key)), false);
  }
  await assert.rejects(reorderPdf(merged, [0, 0, 1]));
});

test("PDF structure inspection and zero-based page extraction/deletion validate duplicates and range", async () => {
  const source = await pdfWithActiveHooks();
  const summary = await inspectPdf(source);
  assert.equal(summary.format, "pdf");
  assert.equal(summary.pageIndexBase, 0);
  assert.equal(summary.catalog.OpenAction, true);
  assert.equal(summary.pageFeatures.Annots, 1);
  assert.equal(summary.pageDetails.length, summary.pages);
  assert.deepEqual(Object.keys(summary.pageDetails[0]), ["index", "widthPoints", "heightPoints", "rotationDegrees"]);
  assert.ok(summary.pageDetails[0].widthPoints > 0 && summary.pageDetails[0].heightPoints > 0);
  assert.deepEqual(summary.diagnostics, {
    structureOnly: true,
    contentSafetyAssessed: false,
    redactionVerified: false,
  });

  const three = await pdfWithPages(3);
  const extracted = await extractPdfPages(three, [2, 0]);
  assert.equal((await PDFDocument.load(extracted)).getPageCount(), 2);
  const deleted = await deletePdfPages(three, [1]);
  assert.equal((await PDFDocument.load(deleted)).getPageCount(), 2);
  await assert.rejects(extractPdfPages(three, [0, 0]), code("INPUT_INVALID"));
  await assert.rejects(extractPdfPages(three, [3]), code("INPUT_INVALID"));
  await assert.rejects(deletePdfPages(three, [0, 1, 2]), code("INPUT_INVALID"));
});
