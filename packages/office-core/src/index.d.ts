export class OfficeCoreError extends Error {
  readonly code: string;
  readonly details?: unknown;
}

export interface OfficeLimits {
  archiveBytes: number;
  entries: number;
  expandedBytes: number;
  partBytes: number;
  mediaPartBytes: number;
  mediaExpandedBytes: number;
  compressionRatio: number;
  xmlTextBytes: number;
  titleChars: number;
  modelTextChars: number;
  formulaChars: number;
  blocks: number;
  listItems: number;
  tableRows: number;
  tableColumns: number;
  slides: number;
  slideBullets: number;
  sheets: number;
  rowsPerSheet: number;
  sheetColumns: number;
  cells: number;
  csvBytes: number;
  csvColumns: number;
  pdfBytes: number;
  pdfPages: number;
}

export const OFFICE_LIMITS: Readonly<OfficeLimits>;

export interface ZipEntryReport {
  readonly name: string;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly method: number;
  readonly crc32: number;
  readonly directory: boolean;
}

export interface ZipPreflightReport {
  readonly archiveBytes: number;
  readonly expandedBytes: number;
  readonly mediaExpandedBytes: number;
  readonly entries: readonly ZipEntryReport[];
}

export function preflightZip(input: Uint8Array, overrides?: Partial<OfficeLimits>): ZipPreflightReport;
export function safeUnzip(input: Uint8Array, overrides?: Partial<OfficeLimits>): {
  report: ZipPreflightReport;
  files: Map<string, Uint8Array>;
};

export type DocxBlock =
  | { type: "paragraph"; text: string }
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "table"; rows: string[][] }
  | { type: "pageBreak" };

export interface DocxDocument {
  title?: string;
  blocks: DocxBlock[];
}

export interface ArchiveSummary {
  archiveBytes: number;
  expandedBytes: number;
  entries: number;
}

export function composeDocx(input: DocxDocument): Uint8Array;
export function extractDocx(input: Uint8Array): {
  document: { title: string; blocks: DocxBlock[] };
  warnings: string[];
  archive: ArchiveSummary;
};
export function inspectDocx(input: Uint8Array): {
  format: "docx";
  archiveBytes: number;
  expandedBytes: number;
  entries: number;
  paragraphs: number;
  tables: number;
  images: number;
  metadata: { title: string; creator: string };
  warnings: string[];
};
export function docxToMarkdown(input: Uint8Array): { markdown: string; warnings: string[] };

export interface PptxSlide {
  title?: string;
  body?: string;
  bullets?: string[];
}

export interface PptxPresentation {
  title?: string;
  slides: PptxSlide[];
}

export function composePptx(input: PptxPresentation): Uint8Array;
export function extractPptx(input: Uint8Array): {
  presentation: { title: string; slides: Array<{ title: string; body: string; notes?: string }> };
  warnings: string[];
  archive: ArchiveSummary;
};
export function inspectPptx(input: Uint8Array): {
  format: "pptx";
  archiveBytes: number;
  expandedBytes: number;
  entries: number;
  slides: number;
  textRuns: number;
  images: number;
  metadata: { title: string; creator: string };
  warnings: string[];
};
export function pptxToMarkdown(input: Uint8Array): { markdown: string; warnings: string[] };

export type SheetCell = string | number | boolean | null;
export interface WorkbookModel {
  sheets: Array<{ name: string; rows: SheetCell[][] }>;
}
export interface ExtractedWorkbook {
  sheets: Array<{ name: string; rows: Array<Array<SheetCell | { kind: "formula"; formula: string }>> }>;
}
export function composeXlsx(input: WorkbookModel): Uint8Array;
export function extractXlsx(input: Uint8Array): {
  workbook: ExtractedWorkbook;
  warnings: string[];
  archive: ArchiveSummary;
};
export function inspectXlsx(input: Uint8Array): {
  format: "xlsx";
  archiveBytes: number;
  expandedBytes: number;
  entries: number;
  sheetCount: number;
  rows: number;
  cells: number;
  formulaCells: number;
  sheets: Array<{ index: number; name: string; rows: number; columns: number; cells: number; formulaCells: number }>;
  diagnostics: { formulasEvaluated: false; externalRelationshipsFollowed: false };
  warnings: string[];
};

export function escapeSpreadsheetFormula(value: unknown): string;
export function parseCsv(text: string, options?: { delimiter?: string; maxRows?: number; maxColumns?: number }): {
  rows: string[][];
  delimiter: string;
};
export function stringifyCsv(rows: unknown[][], options?: {
  delimiter?: string;
  lineEnding?: "\n" | "\r\n";
  escapeFormulas?: boolean;
}): string;
export function inspectCsv(text: string, options?: { delimiter?: string }): {
  format: "csv";
  bytes: number;
  delimiter: string;
  rows: number;
  columns: number;
  cells: number;
  nonEmptyCells: number;
  formulaLikeCells: number;
  diagnostics: { unevenRows: number; formulasEvaluated: false; externalResourcesFetched: false };
  warnings: string[];
};

export function rowsToMarkdownTable(rows: unknown[][]): string;
export function parseMarkdownTable(markdown: string): { rows: string[][]; columns: number };
export function xlsxToMarkdown(input: Uint8Array, options?: { sheetIndex?: number }): {
  markdown: string;
  sheetName: string;
  warnings: string[];
};
export function csvToMarkdown(text: string, options?: { delimiter?: string }): {
  markdown: string;
  delimiter: string;
  warnings: string[];
};
export function markdownTableToXlsx(markdown: string, options?: { sheetName?: string }): Uint8Array;
export function markdownTableToCsv(markdown: string, options?: {
  delimiter?: string;
  lineEnding?: "\n" | "\r\n";
}): string;

export function parseMarkdownOutline(markdown: string): { blocks: DocxBlock[] };
export function markdownOutlineToDocx(markdown: string, options?: { title?: string }): Uint8Array;
export function markdownOutlineToPptx(markdown: string, options?: { title?: string }): Uint8Array;

export function mergePdfs(inputs: Uint8Array[]): Promise<Uint8Array>;
export function splitPdf(
  input: Uint8Array,
  pageGroups?: number[][],
  options?: { maxOutputBytes?: number },
): Promise<Uint8Array[]>;
export function reorderPdf(input: Uint8Array, order: number[]): Promise<Uint8Array>;
export function rotatePdf(input: Uint8Array, rotations: Array<{ page: number; angle: 0 | 90 | 180 | 270 }>): Promise<Uint8Array>;
export function sanitizePdfMetadata(input: Uint8Array): Promise<Uint8Array>;
export function inspectPdf(input: Uint8Array): Promise<{
  format: "pdf";
  bytes: number;
  pages: number;
  pageIndexBase: 0;
  metadataPresence: { infoDictionary: boolean; documentIdentifier: boolean; catalogMetadata: boolean };
  catalog: Record<string, boolean>;
  pageFeatures: Record<string, number>;
  pageDetails: Array<{ index: number; widthPoints: number; heightPoints: number; rotationDegrees: number }>;
  diagnostics: { structureOnly: true; contentSafetyAssessed: false; redactionVerified: false };
  warnings: string[];
}>;
export function extractPdfPages(input: Uint8Array, pages: number[]): Promise<Uint8Array>;
export function deletePdfPages(input: Uint8Array, pages: number[]): Promise<Uint8Array>;
