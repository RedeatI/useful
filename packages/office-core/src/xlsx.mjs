import { assert, exactObject } from "./errors.mjs";
import { OFFICE_LIMITS } from "./limits.mjs";
import { attribute, decodeXml, ooxmlSafetyWarnings, safeText, tagTexts, xmlBytes, xmlEscape } from "./xml.mjs";
import { makeZip, safeUnzip, safeZipPath } from "./zip.mjs";
import { escapeSpreadsheetFormula } from "./csv.mjs";

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function columnName(index) {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    value--;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function validateWorkbook(input) {
  exactObject(input, ["sheets"]);
  assert(Array.isArray(input.sheets) && input.sheets.length >= 1 && input.sheets.length <= OFFICE_LIMITS.sheets, "INPUT_INVALID", "Invalid workbook sheets");
  const names = new Set();
  let cells = 0;
  let textLength = 0;
  for (const sheet of input.sheets) {
    exactObject(sheet, ["name", "rows"]);
    safeText(sheet.name, 31);
    textLength += sheet.name.length;
    assert(sheet.name.length > 0 && !/[:\\/?*\[\]]/.test(sheet.name) && !sheet.name.startsWith("'") && !sheet.name.endsWith("'"), "INPUT_INVALID", "Invalid sheet name");
    const key = sheet.name.toLocaleLowerCase("en-US");
    assert(!names.has(key), "INPUT_INVALID", "Duplicate sheet name");
    names.add(key);
    assert(Array.isArray(sheet.rows) && sheet.rows.length <= OFFICE_LIMITS.rowsPerSheet, "INPUT_INVALID", "Invalid sheet rows");
    for (const row of sheet.rows) {
      assert(Array.isArray(row) && row.length <= OFFICE_LIMITS.sheetColumns, "INPUT_INVALID", "Invalid sheet row");
      cells += row.length;
      assert(cells <= OFFICE_LIMITS.cells, "INPUT_TOO_LARGE", "Workbook cell count exceeds limit");
      for (const cell of row) {
        assert(cell === null || ["string", "number", "boolean"].includes(typeof cell), "INPUT_INVALID", "Unsupported cell value");
        if (typeof cell === "number") assert(Number.isFinite(cell), "INPUT_INVALID", "Cell number must be finite");
        if (typeof cell === "string") {
          safeText(cell);
          textLength += cell.length;
          assert(textLength <= OFFICE_LIMITS.xmlTextBytes, "INPUT_TOO_LARGE", "Workbook text exceeds limit");
        }
      }
    }
  }
  return input;
}

function cellXml(value, reference) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return `<c r="${reference}"><v>${value}</v></c>`;
  if (typeof value === "boolean") return `<c r="${reference}" t="b"><v>${value ? 1 : 0}</v></c>`;
  const safe = escapeSpreadsheetFormula(value);
  const preserve = /^\s|\s$/.test(safe) ? ' xml:space="preserve"' : "";
  return `<c r="${reference}" t="inlineStr"><is><t${preserve}>${xmlEscape(safe)}</t></is></c>`;
}

function sheetXml(rows) {
  return `${XML}<worksheet xmlns="${MAIN}"><sheetData>${rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((cell, columnIndex) => cellXml(cell, `${columnName(columnIndex)}${rowIndex + 1}`)).join("")}</row>`).join("")}</sheetData></worksheet>`;
}

export function composeXlsx(input) {
  const workbook = validateWorkbook(structuredClone(input));
  const sheetOverrides = workbook.sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("");
  const files = {
    "[Content_Types].xml": xmlBytes(`${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheetOverrides}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`),
    "_rels/.rels": xmlBytes(`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`),
    "xl/workbook.xml": xmlBytes(`${XML}<workbook xmlns="${MAIN}" xmlns:r="${R}"><sheets>${workbook.sheets.map((sheet, index) => `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": xmlBytes(`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${workbook.sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}<Relationship Id="rId${workbook.sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    "xl/styles.xml": xmlBytes(`${XML}<styleSheet xmlns="${MAIN}"><fonts count="1"><font><sz val="11"/><name val="Aptos"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`),
    "docProps/core.xml": xmlBytes(`${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator></dc:creator><cp:lastModifiedBy></cp:lastModifiedBy></cp:coreProperties>`),
    "docProps/app.xml": xmlBytes(`${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Useful</Application></Properties>`),
  };
  workbook.sheets.forEach((sheet, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = xmlBytes(sheetXml(sheet.rows));
  });
  return makeZip(files);
}

function relationships(xml) {
  const result = new Map();
  const seen = new Set();
  for (const match of xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?Relationship\b[^>]*>/g)) {
    const id = attribute(match[0], "Id");
    const target = (attribute(match[0], "Target") ?? "").trim();
    const type = (attribute(match[0], "Type") ?? "").trim();
    const mode = (attribute(match[0], "TargetMode") ?? "").trim().toLowerCase();
    assert(id && target && type, "XLSX_INVALID", "Invalid workbook relationship");
    assert(!seen.has(id), "XLSX_INVALID", "Duplicate workbook relationship id");
    seen.add(id);
    assert(mode === "" || mode === "internal" || mode === "external", "XLSX_INVALID", "Invalid workbook relationship mode");
    if (mode === "external" || /^(?:[a-z][a-z0-9+.-]*:|\/\/|\\\\)/i.test(target)) continue;
    if (!/\/worksheet$/i.test(type)) continue;
    result.set(id, target);
  }
  return result;
}

function resolveWorkbookTarget(target) {
  const normalized = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
  return safeZipPath(normalized.replace(/^xl\/\.\//, "xl/"));
}

function parseSharedStrings(files) {
  const bytes = files.get("xl/sharedStrings.xml");
  if (!bytes) return [];
  const xml = decodeXml(bytes);
  const values = [...xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map((match) =>
    safeText(tagTexts(match[1], "t").join(""), OFFICE_LIMITS.modelTextChars),
  );
  assert(values.length <= OFFICE_LIMITS.cells, "INPUT_TOO_LARGE", "Shared string count exceeds limit");
  return values;
}

function columnIndex(reference) {
  const match = reference.match(/^([A-Z]+)[1-9][0-9]*$/);
  if (!match) return undefined;
  let value = 0;
  for (const character of match[1]) value = value * 26 + character.charCodeAt(0) - 64;
  return value - 1;
}

function parseSheet(xml, sharedStrings, budget) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    const occupied = new Set();
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const opening = `<c ${cellMatch[1]}>`;
      const reference = attribute(opening, "r");
      const type = attribute(opening, "t");
      const index = reference ? columnIndex(reference) : row.length;
      assert(Number.isInteger(index) && index >= 0 && index < OFFICE_LIMITS.sheetColumns, "XLSX_INVALID", "Invalid cell reference");
      assert(!occupied.has(index), "XLSX_INVALID", "Duplicate cell reference");
      occupied.add(index);
      const formula = tagTexts(cellMatch[2], "f")[0];
      let value;
      if (formula !== undefined) {
        value = { kind: "formula", formula: safeText(formula, OFFICE_LIMITS.formulaChars) };
      } else if (type === "inlineStr") {
        value = safeText(tagTexts(cellMatch[2], "t").join(""), OFFICE_LIMITS.modelTextChars);
      } else {
        const raw = tagTexts(cellMatch[2], "v")[0] ?? "";
        if (type === "s") {
          const sharedIndex = Number(raw);
          assert(Number.isInteger(sharedIndex) && sharedIndex >= 0 && sharedIndex < sharedStrings.length, "XLSX_INVALID", "Invalid shared string index");
          value = sharedStrings[sharedIndex];
        } else if (type === "b") {
          assert(raw === "0" || raw === "1", "XLSX_INVALID", "Invalid boolean cell value");
          value = raw === "1";
        } else if (raw === "") value = null;
        else {
          const number = Number(raw);
          value = Number.isFinite(number) ? number : safeText(raw, OFFICE_LIMITS.modelTextChars);
        }
      }
      budget.textChars += typeof value === "string" ? value.length : value?.kind === "formula" ? value.formula.length : 0;
      assert(budget.textChars <= OFFICE_LIMITS.xmlTextBytes, "INPUT_TOO_LARGE", "Workbook extracted text exceeds limit");
      row[index] = value;
    }
    budget.cells += row.length;
    assert(budget.cells <= OFFICE_LIMITS.cells, "INPUT_TOO_LARGE", "Workbook cell count exceeds limit");
    rows.push(Array.from({ length: row.length }, (_, index) => row[index] ?? null));
    assert(rows.length <= OFFICE_LIMITS.rowsPerSheet, "INPUT_TOO_LARGE", "Workbook row count exceeds limit");
  }
  return rows;
}

export function extractXlsx(input) {
  const { report, files } = safeUnzip(input);
  const workbookBytes = files.get("xl/workbook.xml");
  const relsBytes = files.get("xl/_rels/workbook.xml.rels");
  assert(workbookBytes && relsBytes, "XLSX_INVALID", "Required XLSX parts are missing");
  const workbookXml = decodeXml(workbookBytes);
  const relsXml = decodeXml(relsBytes);
  const rels = relationships(relsXml);
  const sharedStrings = parseSharedStrings(files);
  const sheets = [];
  const names = new Set();
  const budget = { cells: 0, textChars: 0 };
  for (const match of workbookXml.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attribute(match[0], "name");
    const id = attribute(match[0], "r:id");
    assert(name && id && rels.has(id), "XLSX_INVALID", "Invalid workbook sheet relationship");
    safeText(name, 31);
    budget.textChars += name.length;
    assert(budget.textChars <= OFFICE_LIMITS.xmlTextBytes, "INPUT_TOO_LARGE", "Workbook extracted text exceeds limit");
    assert(!/[:\\/?*\[\]]/.test(name) && !name.startsWith("'") && !name.endsWith("'"), "XLSX_INVALID", "Invalid sheet name");
    const key = name.toLocaleLowerCase("en-US");
    assert(!names.has(key), "XLSX_INVALID", "Duplicate sheet name");
    names.add(key);
    const target = resolveWorkbookTarget(rels.get(id));
    const bytes = files.get(target);
    assert(bytes, "XLSX_INVALID", "Worksheet part is missing");
    sheets.push({ name, rows: parseSheet(decodeXml(bytes), sharedStrings, budget) });
    assert(sheets.length <= OFFICE_LIMITS.sheets, "INPUT_TOO_LARGE", "Workbook sheet count exceeds limit");
  }
  assert(sheets.length >= 1, "XLSX_INVALID", "Workbook contains no sheets");
  return {
    workbook: { sheets },
    warnings: ooxmlSafetyWarnings(files),
    archive: { archiveBytes: report.archiveBytes, expandedBytes: report.expandedBytes, entries: report.entries.length },
  };
}

export function inspectXlsx(input) {
  const result = extractXlsx(input);
  let rows = 0;
  let cells = 0;
  let formulaCells = 0;
  const sheets = result.workbook.sheets.map((sheet, index) => {
    const sheetRows = sheet.rows.length;
    const sheetCells = sheet.rows.reduce((total, row) => total + row.length, 0);
    const sheetFormulaCells = sheet.rows.reduce((total, row) => total + row.filter(
      (value) => value && typeof value === "object" && value.kind === "formula",
    ).length, 0);
    rows += sheetRows;
    cells += sheetCells;
    formulaCells += sheetFormulaCells;
    return {
      index,
      name: sheet.name,
      rows: sheetRows,
      columns: sheet.rows.reduce((maximum, row) => Math.max(maximum, row.length), 0),
      cells: sheetCells,
      formulaCells: sheetFormulaCells,
    };
  });
  return {
    format: "xlsx",
    archiveBytes: result.archive.archiveBytes,
    expandedBytes: result.archive.expandedBytes,
    entries: result.archive.entries,
    sheetCount: sheets.length,
    rows,
    cells,
    formulaCells,
    sheets,
    diagnostics: {
      formulasEvaluated: false,
      externalRelationshipsFollowed: false,
    },
    warnings: result.warnings,
  };
}
