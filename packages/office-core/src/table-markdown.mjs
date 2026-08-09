import { assert, exactObject } from "./errors.mjs";
import { OFFICE_LIMITS } from "./limits.mjs";
import { composeXlsx, extractXlsx } from "./xlsx.mjs";
import { parseCsv, stringifyCsv } from "./csv.mjs";

const MARKDOWN_ROWS = OFFICE_LIMITS.tableRows;
const MARKDOWN_COLUMNS = OFFICE_LIMITS.tableColumns;

function cellText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    assert(Number.isFinite(value), "INPUT_INVALID", "Table numbers must be finite");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object" && value.kind === "formula" && typeof value.formula === "string") {
    return `=${value.formula}`;
  }
  assert(typeof value === "string", "INPUT_INVALID", "Unsupported Markdown table cell");
  return value;
}

function escapeCell(value) {
  const text = cellText(value);
  assert(text.length <= OFFICE_LIMITS.modelTextChars, "INPUT_TOO_LARGE", "Markdown table cell exceeds limit");
  assert(!/[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text), "INPUT_INVALID", "Markdown table cells must be single-line text");
  return text
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function normalizeRows(rows) {
  assert(Array.isArray(rows) && rows.length >= 1 && rows.length <= MARKDOWN_ROWS, "INPUT_INVALID", "Markdown table rows must be a non-empty array");
  let columns = 0;
  let cells = 0;
  const normalized = rows.map((row) => {
    assert(Array.isArray(row), "INPUT_INVALID", "Markdown table row must be an array");
    assert(row.length <= MARKDOWN_COLUMNS, "INPUT_TOO_LARGE", "Markdown table column count exceeds limit");
    columns = Math.max(columns, row.length);
    cells += row.length;
    assert(cells <= OFFICE_LIMITS.cells, "INPUT_TOO_LARGE", "Markdown table cell count exceeds limit");
    return row.map(escapeCell);
  });
  assert(columns >= 1, "INPUT_INVALID", "Markdown table must contain at least one column");
  return { rows: normalized.map((row) => [...row, ...Array(columns - row.length).fill("")]), columns };
}

export function rowsToMarkdownTable(rows) {
  const normalized = normalizeRows(rows);
  const line = (row) => `| ${row.join(" | ")} |`;
  const separator = Array(normalized.columns).fill("---");
  const markdown = `${line(normalized.rows[0])}\n${line(separator)}${normalized.rows.length > 1 ? `\n${normalized.rows.slice(1).map(line).join("\n")}` : ""}\n`;
  assert(new TextEncoder().encode(markdown).byteLength <= OFFICE_LIMITS.csvBytes, "OUTPUT_TOO_LARGE", "Markdown table output exceeds limit");
  return markdown;
}

function parseLine(line) {
  const trimmed = line.trim();
  assert(trimmed.startsWith("|") && trimmed.endsWith("|"), "MARKDOWN_TABLE_INVALID", "Markdown table rows must start and end with a pipe");
  const cells = [];
  let cell = "";
  let escaped = false;
  for (const character of trimmed.slice(1, -1)) {
    if (escaped) {
      cell += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  assert(!escaped, "MARKDOWN_TABLE_INVALID", "Markdown table contains a dangling escape");
  cells.push(cell.trim());
  assert(cells.length >= 1 && cells.length <= MARKDOWN_COLUMNS, "MARKDOWN_TABLE_INVALID", "Invalid Markdown table column count");
  cells.forEach((value) => assert(value.length <= OFFICE_LIMITS.modelTextChars, "INPUT_TOO_LARGE", "Markdown table cell exceeds limit"));
  return cells;
}

export function parseMarkdownTable(markdown) {
  assert(typeof markdown === "string", "INPUT_INVALID", "Markdown table input must be text");
  assert(new TextEncoder().encode(markdown).byteLength <= OFFICE_LIMITS.csvBytes, "INPUT_TOO_LARGE", "Markdown table exceeds limit");
  const lines = markdown.split(/\r?\n/u);
  while (lines.length && lines[0].trim() === "") lines.shift();
  while (lines.length && lines.at(-1).trim() === "") lines.pop();
  assert(lines.length >= 2 && lines.length <= MARKDOWN_ROWS + 1, "MARKDOWN_TABLE_INVALID", "Expected one simple Markdown table");
  assert(lines.every((line) => line.trim() !== ""), "MARKDOWN_TABLE_INVALID", "Markdown table must not contain blank rows");
  const header = parseLine(lines[0]);
  const separator = parseLine(lines[1]);
  assert(separator.length === header.length, "MARKDOWN_TABLE_INVALID", "Markdown table separator width differs from header");
  assert(separator.every((cell) => /^:?-{3,}:?$/u.test(cell)), "MARKDOWN_TABLE_INVALID", "Invalid Markdown table separator");
  const body = lines.slice(2).map(parseLine);
  assert(body.every((row) => row.length === header.length), "MARKDOWN_TABLE_INVALID", "Markdown table rows must have equal width");
  const rows = [header, ...body];
  assert(rows.reduce((total, row) => total + row.length, 0) <= OFFICE_LIMITS.cells, "INPUT_TOO_LARGE", "Markdown table cell count exceeds limit");
  return { rows, columns: header.length };
}

export function xlsxToMarkdown(input, options = {}) {
  exactObject(options, ["sheetIndex"]);
  const result = extractXlsx(input);
  const sheetIndex = options.sheetIndex ?? 0;
  assert(Number.isInteger(sheetIndex) && sheetIndex >= 0 && sheetIndex < result.workbook.sheets.length, "INPUT_INVALID", "XLSX sheet index is out of range");
  const sheet = result.workbook.sheets[sheetIndex];
  const formulaCells = sheet.rows.flat().filter((value) => value && typeof value === "object" && value.kind === "formula").length;
  return {
    markdown: rowsToMarkdownTable(sheet.rows.length ? sheet.rows : [[""]]),
    sheetName: sheet.name,
    warnings: [...result.warnings, ...(formulaCells ? ["formulas-returned-as-text-not-executed"] : [])],
  };
}

export function csvToMarkdown(text, options = {}) {
  exactObject(options, ["delimiter"]);
  const parsed = parseCsv(text, options);
  return { markdown: rowsToMarkdownTable(parsed.rows.length ? parsed.rows : [[""]]), delimiter: parsed.delimiter, warnings: [] };
}

export function markdownTableToXlsx(markdown, options = {}) {
  exactObject(options, ["sheetName"]);
  const parsed = parseMarkdownTable(markdown);
  return composeXlsx({ sheets: [{ name: options.sheetName ?? "Sheet1", rows: parsed.rows }] });
}

export function markdownTableToCsv(markdown, options = {}) {
  exactObject(options, ["delimiter", "lineEnding"]);
  const parsed = parseMarkdownTable(markdown);
  return stringifyCsv(parsed.rows, {
    ...(options.delimiter === undefined ? {} : { delimiter: options.delimiter }),
    ...(options.lineEnding === undefined ? {} : { lineEnding: options.lineEnding }),
    escapeFormulas: true,
  });
}
