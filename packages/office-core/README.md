# @useful/office-core

Browser/Node-safe office primitives for Useful. The package is deliberately data-only:
it accepts `Uint8Array`, strings, and closed structured models; it has no path, process,
network, shell, Office automation, macro, relationship, or formula execution API.

## Public surface

- ZIP: `preflightZip`, `safeUnzip`, `OFFICE_LIMITS`, `OfficeCoreError`
- DOCX: `composeDocx`, `extractDocx`, `inspectDocx`, `docxToMarkdown`
- PPTX: `composePptx`, `extractPptx`, `inspectPptx`, `pptxToMarkdown`
- XLSX/CSV: `composeXlsx`, `extractXlsx`, `inspectXlsx`, `parseCsv`, `stringifyCsv`,
  `inspectCsv`, and simple-table Markdown conversions
- Markdown: `parseMarkdownOutline`, `markdownOutlineToDocx`, `markdownOutlineToPptx`
- PDF: `inspectPdf`, `mergePdfs`, `splitPdf`, `extractPdfPages`, `deletePdfPages`,
  `reorderPdf`, `rotatePdf`, `sanitizePdfMetadata`

OOXML support is intentionally compact, not a claim of Microsoft Office fidelity.
Composition covers the package's documented closed models. Extraction returns text and
structure only. Macros, embedded objects, external relationships, formulas, animation,
charts, tracked changes, and active PDF content are never executed.

Spreadsheet Markdown conversion accepts exactly one simple pipe table with a header and
separator row. It does not interpret inline HTML, links, formulas, or other Markdown
blocks; formula-like values are emitted to XLSX/CSV as escaped text.

All PDF page arrays use zero-based indexes. Page selections must be non-empty, unique,
integer indexes within the source document; deleting every page is rejected. PDF
inspection reports bounded structural and metadata-presence signals only. It does not
assess content safety and does not prove that visual redaction occurred.

## Dependencies and licenses

- `fflate` 0.8.3 — MIT; bounded OOXML ZIP compression/decompression.
- `pdf-lib` 1.17.1 — MIT; local PDF page and metadata operations.

The package itself is Apache-2.0. Dependency installation and lockfile updates are owned
by the integrating workspace change, not by this isolated package slice.
