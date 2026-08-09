import { exactObject, assert } from "./errors.mjs";
import { OFFICE_LIMITS } from "./limits.mjs";
import { countTags, decodeXml, ooxmlSafetyWarnings, safeText, tagTexts, xmlBytes, xmlEscape } from "./xml.mjs";
import { makeZip, safeUnzip } from "./zip.mjs";

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function validateBlocks(document) {
  exactObject(document, ["title", "blocks"]);
  if (document.title !== undefined) safeText(document.title, OFFICE_LIMITS.titleChars);
  assert(Array.isArray(document.blocks), "INPUT_INVALID", "document.blocks must be an array");
  assert(document.blocks.length <= OFFICE_LIMITS.blocks, "INPUT_TOO_LARGE", "Too many document blocks");
  let textLength = 0;
  let modelItems = 0;
  for (const block of document.blocks) {
    assert(typeof block.type === "string", "INPUT_INVALID", "Block type is required");
    if (block.type === "paragraph") {
      exactObject(block, ["type", "text"]);
      safeText(block.text);
      textLength += block.text.length;
    } else if (block.type === "heading") {
      exactObject(block, ["type", "level", "text"]);
      safeText(block.text);
      assert(Number.isInteger(block.level) && block.level >= 1 && block.level <= 6, "INPUT_INVALID", "Heading level must be 1..6");
      textLength += block.text.length;
    } else if (block.type === "list") {
      exactObject(block, ["type", "ordered", "items"]);
      assert(typeof block.ordered === "boolean", "INPUT_INVALID", "List ordered must be boolean");
      assert(Array.isArray(block.items) && block.items.length <= OFFICE_LIMITS.listItems, "INPUT_INVALID", "Invalid list items");
      for (const item of block.items) {
        safeText(item);
        textLength += item.length;
      }
      modelItems += block.items.length;
    } else if (block.type === "table") {
      exactObject(block, ["type", "rows"]);
      assert(Array.isArray(block.rows) && block.rows.length <= OFFICE_LIMITS.tableRows, "INPUT_INVALID", "Invalid table rows");
      for (const row of block.rows) {
        assert(Array.isArray(row) && row.length <= OFFICE_LIMITS.tableColumns, "INPUT_INVALID", "Invalid table row");
        for (const cell of row) {
          safeText(cell);
          textLength += cell.length;
        }
        modelItems += row.length;
      }
    } else {
      assert(block.type === "pageBreak", "INPUT_INVALID", `Unsupported block type: ${block.type}`);
      exactObject(block, ["type"]);
    }
    assert(textLength <= OFFICE_LIMITS.xmlTextBytes, "INPUT_TOO_LARGE", "Document text exceeds limit");
    assert(modelItems <= OFFICE_LIMITS.cells, "INPUT_TOO_LARGE", "Document item count exceeds limit");
  }
  return document;
}

function run(text, extra = "") {
  const preserve = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : "";
  return `<w:r>${extra}<w:t${preserve}>${xmlEscape(text)}</w:t></w:r>`;
}

function paragraph(text, style) {
  const properties = style ? `<w:pPr><w:pStyle w:val="${xmlEscape(style)}"/></w:pPr>` : "";
  return `<w:p>${properties}${run(text)}</w:p>`;
}

function listParagraph(text, ordered) {
  const marker = ordered ? "1. " : "• ";
  return `<w:p><w:pPr><w:ind w:left="360" w:hanging="180"/></w:pPr>${run(`${marker}${text}`)}</w:p>`;
}

function table(rows) {
  return `<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr>${rows.map((row) => `<w:tr>${row.map((cell) => `<w:tc><w:tcPr/>${paragraph(cell)}</w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`;
}

function documentXml(document) {
  const body = document.blocks.map((block) => {
    if (block.type === "paragraph") return paragraph(block.text);
    if (block.type === "heading") return paragraph(block.text, `Heading${block.level}`);
    if (block.type === "list") return block.items.map((item) => listParagraph(item, block.ordered)).join("");
    if (block.type === "table") return table(block.rows);
    return "<w:p><w:r><w:br w:type=\"page\"/></w:r></w:p>";
  }).join("");
  return `${XML}<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;
}

function stylesXml() {
  const headings = Array.from({ length: 6 }, (_, index) => {
    const level = index + 1;
    const size = 36 - index * 3;
    return `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="${level + 8}"/><w:qFormat/><w:pPr><w:outlineLvl w:val="${index}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr></w:style>`;
  }).join("");
  return `${XML}<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>${headings}</w:styles>`;
}

function coreProperties(title = "") {
  return `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlEscape(title)}</dc:title><dc:creator></dc:creator><cp:lastModifiedBy></cp:lastModifiedBy></cp:coreProperties>`;
}

export function composeDocx(input) {
  const document = validateBlocks(structuredClone(input));
  return makeZip({
    "[Content_Types].xml": xmlBytes(`${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`),
    "_rels/.rels": xmlBytes(`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`),
    "word/document.xml": xmlBytes(documentXml(document)),
    "word/styles.xml": xmlBytes(stylesXml()),
    "word/_rels/document.xml.rels": xmlBytes(`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`),
    "docProps/core.xml": xmlBytes(coreProperties(document.title ?? "")),
    "docProps/app.xml": xmlBytes(`${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Useful</Application><AppVersion>1.0</AppVersion></Properties>`),
  });
}

function requiredPart(files, name) {
  const bytes = files.get(name);
  assert(bytes, "DOCX_INVALID", `DOCX part is missing: ${name}`);
  return decodeXml(bytes);
}

function paragraphText(xml) {
  return safeText(tagTexts(xml, "w:t").join(""), OFFICE_LIMITS.modelTextChars);
}

export function extractDocx(input) {
  const { report, files } = safeUnzip(input);
  requiredPart(files, "[Content_Types].xml");
  const xml = requiredPart(files, "word/document.xml");
  const blocks = [];
  let textLength = 0;
  let modelItems = 0;
  const token = /<w:(p|tbl)(?:\s[^>]*)?>[\s\S]*?<\/w:\1>/g;
  for (const match of xml.matchAll(token)) {
    if (match[1] === "p") {
      const text = paragraphText(match[0]);
      const style = match[0].match(/<w:pStyle\b[^>]*\bw:val=["']Heading([1-6])["']/)?.[1];
      if (style) blocks.push({ type: "heading", level: Number(style), text });
      else if (text) blocks.push({ type: "paragraph", text });
      textLength += text.length;
    } else {
      const rows = [...match[0].matchAll(/<w:tr(?:\s[^>]*)?>([\s\S]*?)<\/w:tr>/g)].map((row) =>
        [...row[1].matchAll(/<w:tc(?:\s[^>]*)?>([\s\S]*?)<\/w:tc>/g)].map((cell) => paragraphText(cell[1])),
      );
      assert(rows.length <= OFFICE_LIMITS.tableRows, "INPUT_TOO_LARGE", "DOCX table row count exceeds limit");
      for (const row of rows) {
        assert(row.length <= OFFICE_LIMITS.tableColumns, "INPUT_TOO_LARGE", "DOCX table column count exceeds limit");
        textLength += row.reduce((sum, cell) => sum + cell.length, 0);
        modelItems += row.length;
      }
      blocks.push({ type: "table", rows });
    }
    assert(blocks.length <= OFFICE_LIMITS.blocks, "INPUT_TOO_LARGE", "DOCX block count exceeds limit");
    assert(textLength <= OFFICE_LIMITS.xmlTextBytes, "INPUT_TOO_LARGE", "DOCX extracted text exceeds limit");
    assert(modelItems <= OFFICE_LIMITS.cells, "INPUT_TOO_LARGE", "DOCX extracted item count exceeds limit");
  }
  const titleXml = files.get("docProps/core.xml");
  const title = safeText(titleXml ? tagTexts(decodeXml(titleXml), "dc:title")[0] ?? "" : "", OFFICE_LIMITS.titleChars);
  return {
    document: { title, blocks },
    warnings: ooxmlSafetyWarnings(files),
    archive: { archiveBytes: report.archiveBytes, expandedBytes: report.expandedBytes, entries: report.entries.length },
  };
}

export function inspectDocx(input) {
  const { report, files } = safeUnzip(input);
  requiredPart(files, "[Content_Types].xml");
  const xml = requiredPart(files, "word/document.xml");
  const core = files.get("docProps/core.xml");
  const coreXml = core ? decodeXml(core) : "";
  const paragraphs = countTags(xml, "w:p");
  const tables = countTags(xml, "w:tbl");
  assert(paragraphs <= 100000 && tables <= 10000, "INPUT_TOO_LARGE", "DOCX structure count exceeds limit");
  return {
    format: "docx",
    archiveBytes: report.archiveBytes,
    expandedBytes: report.expandedBytes,
    entries: report.entries.length,
    paragraphs,
    tables,
    images: [...files.keys()].filter((name) => name.startsWith("word/media/")).length,
    metadata: {
      title: safeText(tagTexts(coreXml, "dc:title")[0] ?? "", OFFICE_LIMITS.titleChars),
      creator: safeText(tagTexts(coreXml, "dc:creator")[0] ?? "", OFFICE_LIMITS.titleChars),
    },
    warnings: ooxmlSafetyWarnings(files),
  };
}

export function docxToMarkdown(input) {
  const extracted = extractDocx(input);
  const markdown = extracted.document.blocks.map((block) => {
    if (block.type === "heading") return `${"#".repeat(block.level)} ${block.text}`;
    if (block.type === "paragraph") return block.text;
    if (block.type === "table") {
      if (!block.rows.length) return "";
      const width = Math.max(...block.rows.map((row) => row.length));
      const rows = block.rows.map((row) => `| ${Array.from({ length: width }, (_, index) => (row[index] ?? "").replaceAll("|", "\\|")).join(" | ")} |`);
      rows.splice(1, 0, `| ${Array.from({ length: width }, () => "---").join(" | ")} |`);
      return rows.join("\n");
    }
    return "";
  }).filter(Boolean).join("\n\n");
  return { markdown, warnings: extracted.warnings };
}
