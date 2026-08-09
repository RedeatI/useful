import { assert, exactObject } from "./errors.mjs";
import { OFFICE_LIMITS } from "./limits.mjs";

const FORMULA = /^\s*[=+\-@]/u;

export function escapeSpreadsheetFormula(value) {
  const text = String(value ?? "");
  return FORMULA.test(text) ? `'${text}` : text;
}

export function parseCsv(text, options = {}) {
  exactObject(options, ["delimiter", "maxRows", "maxColumns"]);
  assert(typeof text === "string", "INPUT_INVALID", "CSV input must be text");
  assert(new TextEncoder().encode(text).byteLength <= OFFICE_LIMITS.csvBytes, "INPUT_TOO_LARGE", "CSV exceeds limit");
  const delimiter = options.delimiter ?? ",";
  assert(typeof delimiter === "string" && delimiter.length === 1 && !/["\r\n]/.test(delimiter), "INPUT_INVALID", "CSV delimiter must be one character");
  const maxRows = options.maxRows ?? 100000;
  const maxColumns = options.maxColumns ?? 1000;
  assert(Number.isInteger(maxRows) && maxRows >= 1 && maxRows <= OFFICE_LIMITS.rowsPerSheet, "INPUT_INVALID", "Invalid CSV row limit");
  assert(Number.isInteger(maxColumns) && maxColumns >= 1 && maxColumns <= OFFICE_LIMITS.csvColumns, "INPUT_INVALID", "Invalid CSV column limit");

  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let cells = 0;
  const append = (value) => {
    field += value;
    assert(field.length <= OFFICE_LIMITS.modelTextChars, "INPUT_TOO_LARGE", "CSV field exceeds limit");
  };
  const pushField = () => {
    row.push(field);
    field = "";
    cells++;
    assert(row.length <= maxColumns, "CSV_TOO_MANY_COLUMNS", "CSV column count exceeds limit");
    assert(cells <= OFFICE_LIMITS.cells, "INPUT_TOO_LARGE", "CSV cell count exceeds limit");
  };
  const pushRow = () => {
    rows.push(row);
    row = [];
    assert(rows.length <= maxRows, "CSV_TOO_MANY_ROWS", "CSV row count exceeds limit");
  };
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          append('"');
          index++;
        } else {
          quoted = false;
        }
      } else {
        append(character);
      }
      continue;
    }
    if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === delimiter) {
      pushField();
    } else if (character === "\r" || character === "\n") {
      if (character === "\r" && text[index + 1] === "\n") index++;
      pushField();
      pushRow();
    } else {
      assert(character !== '"', "CSV_INVALID", "Quote inside unquoted CSV field");
      append(character);
    }
  }
  assert(!quoted, "CSV_INVALID", "Unterminated quoted CSV field");
  if (field.length || row.length || (!rows.length && text.length)) {
    pushField();
    pushRow();
  }
  assert(rows.length <= maxRows, "CSV_TOO_MANY_ROWS", "CSV row count exceeds limit");
  return { rows, delimiter };
}

export function stringifyCsv(rows, options = {}) {
  exactObject(options, ["delimiter", "lineEnding", "escapeFormulas"]);
  assert(Array.isArray(rows) && rows.length <= OFFICE_LIMITS.rowsPerSheet, "INPUT_INVALID", "CSV rows must be an array");
  const delimiter = options.delimiter ?? ",";
  const lineEnding = options.lineEnding ?? "\r\n";
  const escapeFormulas = options.escapeFormulas !== false;
  assert(typeof delimiter === "string" && delimiter.length === 1 && !/["\r\n]/.test(delimiter), "INPUT_INVALID", "CSV delimiter must be one character");
  assert(lineEnding === "\n" || lineEnding === "\r\n", "INPUT_INVALID", "Invalid line ending");
  const encode = (value) => {
    let text = String(value ?? "");
    assert(text.length <= OFFICE_LIMITS.modelTextChars, "INPUT_TOO_LARGE", "CSV field exceeds limit");
    if (escapeFormulas) text = escapeSpreadsheetFormula(text);
    if (text.includes('"')) text = text.replaceAll('"', '""');
    return text.includes(delimiter) || /["\r\n]/.test(text) ? `"${text}"` : text;
  };
  let cells = 0;
  const text = rows.map((row) => {
    assert(Array.isArray(row) && row.length <= OFFICE_LIMITS.csvColumns, "INPUT_INVALID", "CSV row must be an array");
    cells += row.length;
    assert(cells <= OFFICE_LIMITS.cells, "INPUT_TOO_LARGE", "CSV cell count exceeds limit");
    return row.map(encode).join(delimiter);
  }).join(lineEnding);
  assert(new TextEncoder().encode(text).byteLength <= OFFICE_LIMITS.csvBytes, "OUTPUT_TOO_LARGE", "CSV output exceeds limit");
  return text;
}

export function inspectCsv(text, options = {}) {
  exactObject(options, ["delimiter"]);
  const parsed = parseCsv(text, options);
  let cells = 0;
  let nonEmptyCells = 0;
  let formulaLikeCells = 0;
  let columns = 0;
  for (const row of parsed.rows) {
    cells += row.length;
    columns = Math.max(columns, row.length);
    for (const value of row) {
      if (value !== "") nonEmptyCells++;
      if (/^[\s\u00a0\ufeff]*[=+\-@]/u.test(value)) formulaLikeCells++;
    }
  }
  return {
    format: "csv",
    bytes: new TextEncoder().encode(text).byteLength,
    delimiter: parsed.delimiter,
    rows: parsed.rows.length,
    columns,
    cells,
    nonEmptyCells,
    formulaLikeCells,
    diagnostics: {
      unevenRows: parsed.rows.filter((row) => row.length !== columns).length,
      formulasEvaluated: false,
      externalResourcesFetched: false,
    },
    warnings: formulaLikeCells ? ["formula-like-cells-returned-as-text-not-executed"] : [],
  };
}
