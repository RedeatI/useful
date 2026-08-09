import { PDFDocument, PDFName, degrees } from "pdf-lib";
import { asBytes, assert, exactObject, fail } from "./errors.mjs";
import { OFFICE_LIMITS } from "./limits.mjs";

async function loadPdf(input) {
  const bytes = asBytes(input, "PDF_INVALID");
  assert(bytes.byteLength <= OFFICE_LIMITS.pdfBytes, "PDF_TOO_LARGE", "PDF exceeds limit");
  let document;
  try {
    document = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false });
  } catch {
    fail("PDF_INVALID_OR_ENCRYPTED", "PDF is invalid or encrypted");
  }
  assert(document.getPageCount() <= OFFICE_LIMITS.pdfPages, "PDF_TOO_MANY_PAGES", "PDF page count exceeds limit");
  return document;
}

function sanitizeDocument(document) {
  // Dropping the complete trailer dictionaries also removes unknown/custom
  // Info keys and the persistent document identifier, not only common fields.
  document.context.trailerInfo.Info = undefined;
  document.context.trailerInfo.ID = undefined;
  for (const key of ["OpenAction", "AA", "Names", "AcroForm", "Metadata", "Perms", "Outlines", "Collection", "AF"]) {
    document.catalog.delete(PDFName.of(key));
  }
  for (const page of document.getPages()) {
    for (const key of ["AA", "Annots", "Metadata", "PieceInfo", "PresSteps", "Trans", "Dur", "AF"]) {
      page.node.delete(PDFName.of(key));
    }
  }
  return document;
}

async function save(document) {
  let bytes;
  try {
    bytes = await document.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false });
  } catch {
    fail("PDF_WRITE_FAILED", "PDF serialization failed");
  }
  assert(bytes.byteLength <= OFFICE_LIMITS.pdfBytes, "OUTPUT_TOO_LARGE", "PDF output exceeds limit");
  return bytes;
}

function pageIndices(document) {
  return Array.from({ length: document.getPageCount() }, (_, index) => index);
}

function validatePageSelection(document, pages, { allowAll = true } = {}) {
  const count = document.getPageCount();
  assert(Array.isArray(pages) && pages.length >= 1 && pages.length <= count, "INPUT_INVALID", "PDF pages must be a non-empty array");
  assert(new Set(pages).size === pages.length, "INPUT_INVALID", "PDF pages contain duplicates");
  assert(pages.every((page) => Number.isInteger(page) && page >= 0 && page < count), "INPUT_INVALID", "PDF page index is out of range");
  assert(allowAll || pages.length < count, "INPUT_INVALID", "PDF operation must leave at least one page");
  return pages;
}

async function copySelection(source, indices) {
  const output = await PDFDocument.create();
  const copied = await output.copyPages(source, indices);
  copied.forEach((page) => output.addPage(page));
  sanitizeDocument(output);
  return output;
}

async function saveSanitized(document) {
  // A second copy only follows the already-sanitized page graph, so action/annotation
  // objects detached during the first pass are not serialized as unreachable objects.
  return save(await copySelection(document, pageIndices(document)));
}

export async function mergePdfs(inputs) {
  assert(Array.isArray(inputs) && inputs.length >= 1 && inputs.length <= 256, "INPUT_INVALID", "PDF inputs must be a non-empty array");
  const output = await PDFDocument.create();
  let pages = 0;
  let inputBytes = 0;
  for (const input of inputs) {
    const bytes = asBytes(input, "PDF_INVALID");
    inputBytes += bytes.byteLength;
    assert(inputBytes <= OFFICE_LIMITS.pdfBytes, "PDF_TOO_LARGE", "Combined PDF input exceeds limit");
    const source = await loadPdf(bytes);
    pages += source.getPageCount();
    assert(pages <= OFFICE_LIMITS.pdfPages, "PDF_TOO_MANY_PAGES", "Merged PDF page count exceeds limit");
    const copied = await output.copyPages(source, pageIndices(source));
    copied.forEach((page) => output.addPage(page));
  }
  sanitizeDocument(output);
  return saveSanitized(output);
}

export async function splitPdf(input, pageGroups = undefined, options = {}) {
  exactObject(options, ["maxOutputBytes"]);
  const maxOutputBytes = options.maxOutputBytes ?? OFFICE_LIMITS.pdfBytes;
  assert(
    Number.isInteger(maxOutputBytes) && maxOutputBytes >= 1 && maxOutputBytes <= OFFICE_LIMITS.pdfBytes,
    "INPUT_INVALID",
    "Invalid split PDF output limit",
  );
  const source = await loadPdf(input);
  const count = source.getPageCount();
  const groups = pageGroups ?? pageIndices(source).map((index) => [index]);
  assert(Array.isArray(groups) && groups.length >= 1 && groups.length <= count, "INPUT_INVALID", "Invalid PDF page groups");
  const outputs = [];
  let selectedPages = 0;
  let outputBytes = 0;
  for (const group of groups) {
    assert(Array.isArray(group) && group.length >= 1, "INPUT_INVALID", "PDF page group must not be empty");
    assert(new Set(group).size === group.length, "INPUT_INVALID", "PDF page group contains duplicates");
    assert(group.every((index) => Number.isInteger(index) && index >= 0 && index < count), "INPUT_INVALID", "PDF page index is out of range");
    selectedPages += group.length;
    assert(selectedPages <= OFFICE_LIMITS.pdfPages, "PDF_TOO_MANY_PAGES", "Split PDF output page count exceeds limit");
    const bytes = await saveSanitized(await copySelection(source, group));
    outputBytes += bytes.byteLength;
    assert(outputBytes <= maxOutputBytes, "OUTPUT_TOO_LARGE", "Combined split PDF output exceeds limit");
    outputs.push(bytes);
  }
  return outputs;
}

export async function reorderPdf(input, order) {
  const source = await loadPdf(input);
  const count = source.getPageCount();
  assert(Array.isArray(order) && order.length === count, "INPUT_INVALID", "PDF order must include every page exactly once");
  assert(new Set(order).size === count && order.every((index) => Number.isInteger(index) && index >= 0 && index < count), "INPUT_INVALID", "Invalid PDF page order");
  return saveSanitized(await copySelection(source, order));
}

export async function rotatePdf(input, rotations) {
  assert(Array.isArray(rotations) && rotations.length <= OFFICE_LIMITS.pdfPages, "INPUT_INVALID", "Invalid PDF rotations");
  const source = await loadPdf(input);
  const output = await copySelection(source, pageIndices(source));
  const seen = new Set();
  for (const rotation of rotations) {
    exactObject(rotation, ["page", "angle"]);
    assert(Number.isInteger(rotation.page) && rotation.page >= 0 && rotation.page < output.getPageCount(), "INPUT_INVALID", "PDF rotation page is out of range");
    assert([0, 90, 180, 270].includes(rotation.angle), "INPUT_INVALID", "PDF rotation must be 0, 90, 180 or 270");
    assert(!seen.has(rotation.page), "INPUT_INVALID", "PDF page rotation is duplicated");
    seen.add(rotation.page);
    const page = output.getPage(rotation.page);
    const current = ((page.getRotation().angle % 360) + 360) % 360;
    page.setRotation(degrees((current + rotation.angle) % 360));
  }
  return saveSanitized(output);
}

export async function sanitizePdfMetadata(input) {
  const source = await loadPdf(input);
  return saveSanitized(await copySelection(source, pageIndices(source)));
}

export async function inspectPdf(input) {
  const bytes = asBytes(input, "PDF_INVALID");
  const document = await loadPdf(bytes);
  const catalogKeys = ["OpenAction", "AA", "Names", "AcroForm", "Metadata", "Perms", "Outlines", "Collection", "AF"];
  const pageKeys = ["AA", "Annots", "Metadata", "PieceInfo", "PresSteps", "Trans", "Dur", "AF"];
  const catalog = Object.fromEntries(catalogKeys.map((key) => [key, document.catalog.has(PDFName.of(key))]));
  const pageFeatures = Object.fromEntries(pageKeys.map((key) => [
    key,
    document.getPages().filter((page) => page.node.has(PDFName.of(key))).length,
  ]));
  const pageDetails = document.getPages().map((page, index) => {
    const { width, height } = page.getSize();
    const rotation = page.getRotation().angle;
    const rounded = (value) => Math.round(value * 1000) / 1000;
    return {
      index,
      widthPoints: rounded(width),
      heightPoints: rounded(height),
      rotationDegrees: rounded(((rotation % 360) + 360) % 360),
    };
  });
  return {
    format: "pdf",
    bytes: bytes.byteLength,
    pages: document.getPageCount(),
    pageIndexBase: 0,
    metadataPresence: {
      infoDictionary: document.context.trailerInfo.Info !== undefined,
      documentIdentifier: document.context.trailerInfo.ID !== undefined,
      catalogMetadata: catalog.Metadata,
    },
    catalog,
    pageFeatures,
    pageDetails,
    diagnostics: {
      structureOnly: true,
      contentSafetyAssessed: false,
      redactionVerified: false,
    },
    warnings: ["structure-only-inspection-does-not-assess-content-safety-or-redaction"],
  };
}

export async function extractPdfPages(input, pages) {
  const source = await loadPdf(input);
  return saveSanitized(await copySelection(source, validatePageSelection(source, pages)));
}

export async function deletePdfPages(input, pages) {
  const source = await loadPdf(input);
  const deleted = new Set(validatePageSelection(source, pages, { allowAll: false }));
  const retained = pageIndices(source).filter((page) => !deleted.has(page));
  return saveSanitized(await copySelection(source, retained));
}
