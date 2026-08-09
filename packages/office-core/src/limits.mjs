export const OFFICE_LIMITS = Object.freeze({
  archiveBytes: 64 * 1024 * 1024,
  entries: 4096,
  expandedBytes: 256 * 1024 * 1024,
  partBytes: 16 * 1024 * 1024,
  mediaPartBytes: 32 * 1024 * 1024,
  mediaExpandedBytes: 128 * 1024 * 1024,
  compressionRatio: 200,
  xmlTextBytes: 2 * 1024 * 1024,
  titleChars: 512,
  modelTextChars: 100000,
  formulaChars: 32768,
  blocks: 2000,
  listItems: 4096,
  tableRows: 4096,
  tableColumns: 256,
  slides: 500,
  slideBullets: 1000,
  sheets: 64,
  rowsPerSheet: 100000,
  sheetColumns: 16384,
  cells: 1000000,
  csvBytes: 16 * 1024 * 1024,
  csvColumns: 10000,
  pdfBytes: 128 * 1024 * 1024,
  pdfPages: 5000,
});

export function limitsWith(overrides = {}) {
  return { ...OFFICE_LIMITS, ...overrides };
}
