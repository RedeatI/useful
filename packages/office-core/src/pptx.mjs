import { exactObject, assert } from "./errors.mjs";
import { OFFICE_LIMITS } from "./limits.mjs";
import { countTags, decodeXml, ooxmlSafetyWarnings, safeText, tagTexts, xmlBytes, xmlEscape } from "./xml.mjs";
import { makeZip, safeUnzip } from "./zip.mjs";

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function validatePresentation(input) {
  exactObject(input, ["title", "slides"]);
  if (input.title !== undefined) safeText(input.title, OFFICE_LIMITS.titleChars);
  assert(Array.isArray(input.slides) && input.slides.length <= OFFICE_LIMITS.slides, "INPUT_INVALID", "Invalid slides");
  let textLength = 0;
  for (const slide of input.slides) {
    exactObject(slide, ["title", "body", "bullets"]);
    if (slide.title !== undefined) {
      safeText(slide.title, 4096);
      textLength += slide.title.length;
    }
    if (slide.body !== undefined) {
      safeText(slide.body, OFFICE_LIMITS.modelTextChars);
      textLength += slide.body.length;
    }
    if (slide.bullets !== undefined) {
      assert(Array.isArray(slide.bullets) && slide.bullets.length <= OFFICE_LIMITS.slideBullets, "INPUT_INVALID", "Invalid slide bullets");
      for (const bullet of slide.bullets) {
        safeText(bullet);
        textLength += bullet.length;
      }
    }
    assert(textLength <= OFFICE_LIMITS.xmlTextBytes, "INPUT_TOO_LARGE", "Presentation text exceeds limit");
  }
  return input;
}

function textShape(id, name, text, x, y, cx, cy, options = {}) {
  const paragraphs = Array.isArray(text) ? text : [text];
  const body = paragraphs.map((value, index) => `<a:p>${options.bullets && index >= 0 ? '<a:pPr marL="342900" indent="-171450"><a:buChar char="•"/></a:pPr>' : ""}<a:r><a:rPr lang="zh-CN" sz="${options.size ?? 2400}"${options.bold ? ' b="1"' : ""}/><a:t>${xmlEscape(value)}</a:t></a:r><a:endParaRPr lang="zh-CN"/></a:p>`).join("");
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xmlEscape(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${body}</p:txBody></p:sp>`;
}

function slideXml(slide) {
  const title = slide.title ?? "";
  const body = slide.bullets?.length ? slide.bullets : slide.body ? [slide.body] : [];
  const shapes = [textShape(2, "Title", title, 457200, 274638, 8229600, 914400, { size: 3200, bold: true })];
  if (body.length) shapes.push(textShape(3, "Body", body, 685800, 1371600, 7772400, 4572000, { size: 2200, bullets: Boolean(slide.bullets?.length) }));
  return `${XML}<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes.join("")}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

function slideMasterXml() {
  return `${XML}<p:sldMaster xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"><p:cSld name="Useful"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`;
}

function themeXml() {
  return `${XML}<a:theme xmlns:a="${A}" name="Useful"><a:themeElements><a:clrScheme name="Useful"><a:dk1><a:srgbClr val="111827"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="374151"/></a:dk2><a:lt2><a:srgbClr val="F3F4F6"/></a:lt2><a:accent1><a:srgbClr val="2563EB"/></a:accent1><a:accent2><a:srgbClr val="0D9488"/></a:accent2><a:accent3><a:srgbClr val="9333EA"/></a:accent3><a:accent4><a:srgbClr val="EA580C"/></a:accent4><a:accent5><a:srgbClr val="DC2626"/></a:accent5><a:accent6><a:srgbClr val="4D7C0F"/></a:accent6><a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink></a:clrScheme><a:fontScheme name="Useful"><a:majorFont><a:latin typeface="Aptos Display"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Useful"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
}

function contentTypes(slides) {
  const overrides = Array.from({ length: slides }, (_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("");
  return `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${overrides}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
}

export function composePptx(input) {
  const presentation = validatePresentation(structuredClone(input));
  const files = {
    "[Content_Types].xml": xmlBytes(contentTypes(presentation.slides.length)),
    "_rels/.rels": xmlBytes(`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`),
    "ppt/presentation.xml": xmlBytes(`${XML}<p:presentation xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${presentation.slides.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`).join("")}</p:sldIdLst><p:sldSz cx="9144000" cy="5143500" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`),
    "ppt/_rels/presentation.xml.rels": xmlBytes(`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>${presentation.slides.map((_, index) => `<Relationship Id="rId${index + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`).join("")}</Relationships>`),
    "ppt/slideMasters/slideMaster1.xml": xmlBytes(slideMasterXml()),
    "ppt/slideMasters/_rels/slideMaster1.xml.rels": xmlBytes(`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`),
    "ppt/slideLayouts/slideLayout1.xml": xmlBytes(`${XML}<p:sldLayout xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`),
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels": xmlBytes(`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`),
    "ppt/theme/theme1.xml": xmlBytes(themeXml()),
    "docProps/core.xml": xmlBytes(`${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xmlEscape(presentation.title ?? "")}</dc:title><dc:creator></dc:creator><cp:lastModifiedBy></cp:lastModifiedBy></cp:coreProperties>`),
    "docProps/app.xml": xmlBytes(`${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Useful</Application><PresentationFormat>Widescreen</PresentationFormat><Slides>${presentation.slides.length}</Slides></Properties>`),
  };
  presentation.slides.forEach((slide, index) => {
    files[`ppt/slides/slide${index + 1}.xml`] = xmlBytes(slideXml(slide));
    files[`ppt/slides/_rels/slide${index + 1}.xml.rels`] = xmlBytes(`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`);
  });
  return makeZip(files);
}

function slideNames(files) {
  const names = [...files.keys()].filter((name) => /^ppt\/slides\/slide[0-9]+\.xml$/.test(name)).sort((left, right) => Number(left.match(/[0-9]+/)[0]) - Number(right.match(/[0-9]+/)[0]));
  assert(names.length <= OFFICE_LIMITS.slides, "INPUT_TOO_LARGE", "PPTX slide count exceeds limit");
  return names;
}

export function extractPptx(input) {
  const { report, files } = safeUnzip(input);
  assert(files.has("[Content_Types].xml") && files.has("ppt/presentation.xml"), "PPTX_INVALID", "Required PPTX parts are missing");
  decodeXml(files.get("[Content_Types].xml"));
  decodeXml(files.get("ppt/presentation.xml"));
  let textLength = 0;
  const slides = slideNames(files).map((name) => {
    const xml = decodeXml(files.get(name));
    const text = tagTexts(xml, "a:t");
    const notesName = name.replace("ppt/slides/slide", "ppt/notesSlides/notesSlide");
    const title = safeText(text[0] ?? "", 4096);
    const body = safeText(text.slice(1).join("\n"), OFFICE_LIMITS.modelTextChars);
    const notes = files.has(notesName)
      ? safeText(tagTexts(decodeXml(files.get(notesName)), "a:t").join("\n"), OFFICE_LIMITS.modelTextChars)
      : undefined;
    textLength += title.length + body.length + (notes?.length ?? 0);
    assert(textLength <= OFFICE_LIMITS.xmlTextBytes, "INPUT_TOO_LARGE", "PPTX extracted text exceeds limit");
    return { title, body, ...(notes ? { notes } : {}) };
  });
  const core = files.get("docProps/core.xml");
  const title = safeText(core ? tagTexts(decodeXml(core), "dc:title")[0] ?? "" : "", OFFICE_LIMITS.titleChars);
  return {
    presentation: { title, slides },
    warnings: ooxmlSafetyWarnings(files),
    archive: { archiveBytes: report.archiveBytes, expandedBytes: report.expandedBytes, entries: report.entries.length },
  };
}

export function inspectPptx(input) {
  const { report, files } = safeUnzip(input);
  assert(files.has("[Content_Types].xml") && files.has("ppt/presentation.xml"), "PPTX_INVALID", "Required PPTX parts are missing");
  decodeXml(files.get("[Content_Types].xml"));
  decodeXml(files.get("ppt/presentation.xml"));
  const names = slideNames(files);
  const core = files.get("docProps/core.xml");
  const coreXml = core ? decodeXml(core) : "";
  const textRuns = names.reduce((sum, name) => sum + countTags(decodeXml(files.get(name)), "a:t"), 0);
  assert(textRuns <= 100000, "INPUT_TOO_LARGE", "PPTX text run count exceeds limit");
  return {
    format: "pptx",
    archiveBytes: report.archiveBytes,
    expandedBytes: report.expandedBytes,
    entries: report.entries.length,
    slides: names.length,
    textRuns,
    images: [...files.keys()].filter((name) => name.startsWith("ppt/media/")).length,
    metadata: {
      title: safeText(tagTexts(coreXml, "dc:title")[0] ?? "", OFFICE_LIMITS.titleChars),
      creator: safeText(tagTexts(coreXml, "dc:creator")[0] ?? "", OFFICE_LIMITS.titleChars),
    },
    warnings: ooxmlSafetyWarnings(files),
  };
}

export function pptxToMarkdown(input) {
  const extracted = extractPptx(input);
  const markdown = extracted.presentation.slides.map((slide) => {
    const body = slide.body ? `\n\n${slide.body.split("\n").map((line) => `- ${line}`).join("\n")}` : "";
    const notes = slide.notes ? `\n\n> ${slide.notes.replaceAll("\n", "\n> ")}` : "";
    return `## ${slide.title || "Untitled slide"}${body}${notes}`;
  }).join("\n\n");
  return { markdown, warnings: extracted.warnings };
}
