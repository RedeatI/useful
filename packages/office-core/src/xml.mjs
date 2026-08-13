import { assert, fail } from "./errors.mjs";
import { OFFICE_LIMITS } from "./limits.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function isXmlCodePoint(point) {
  return point === 0x9 || point === 0xa || point === 0xd
    || (point >= 0x20 && point <= 0xd7ff)
    || (point >= 0xe000 && point <= 0xfffd)
    || (point >= 0x10000 && point <= 0x10ffff);
}

export function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function xmlUnescape(value) {
  return String(value).replace(/&(lt|gt|quot|apos|amp|#x[0-9a-fA-F]+|#[0-9]+);/g, (match, entity) => {
    if (entity === "lt") return "<";
    if (entity === "gt") return ">";
    if (entity === "quot") return '"';
    if (entity === "apos") return "'";
    if (entity === "amp") return "&";
    const radix = entity.startsWith("#x") ? 16 : 10;
    const raw = entity.slice(radix === 16 ? 2 : 1);
    const point = Number.parseInt(raw, radix);
    if (!Number.isInteger(point) || !isXmlCodePoint(point)) {
      fail("XML_INVALID", "Invalid numeric XML entity");
    }
    return String.fromCodePoint(point);
  });
}

export function xmlBytes(value) {
  return encoder.encode(value);
}

export function decodeXml(bytes, maxBytes = OFFICE_LIMITS.partBytes) {
  assert(bytes instanceof Uint8Array, "XML_INVALID", "XML part must be Uint8Array");
  assert(bytes.byteLength <= maxBytes, "XML_PART_TOO_LARGE", "XML part exceeds limit");
  let text;
  try {
    text = decoder.decode(bytes);
  } catch {
    fail("XML_INVALID", "XML part is not valid UTF-8");
  }
  assert(!/<!DOCTYPE|<!ENTITY/i.test(text), "XML_DTD_FORBIDDEN", "DTD and entities are forbidden");
  assert(!text.includes("\0"), "XML_INVALID", "NUL is forbidden in XML");
  return text.replace(/^\uFEFF/, "");
}

function stripTagLikeSegments(text) {
  let result = "";
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf("<", cursor);
    if (start < 0) return result + text.slice(cursor);
    const end = text.indexOf(">", start + 1);
    if (end < 0) return result + text.slice(cursor);
    result += text.slice(cursor, start);
    cursor = end + 1;
  }
  return result;
}

export function tagTexts(xml, qualifiedName) {
  const escaped = qualifiedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "g");
  return [...xml.matchAll(expression)].map((match) => xmlUnescape(stripTagLikeSegments(match[1])));
}

export function attribute(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(new RegExp(`(?:^|\\s)${escaped}=(?:"([^"]*)"|'([^']*)')`));
  return match ? xmlUnescape(match[1] ?? match[2]) : undefined;
}

export function countTags(xml, qualifiedName) {
  const escaped = qualifiedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...xml.matchAll(new RegExp(`<${escaped}(?:\\s|/?>)`, "g"))].length;
}

export function ooxmlSafetyWarnings(files) {
  assert(files instanceof Map, "INPUT_INVALID", "OOXML files must be a Map");
  const warnings = new Set();
  for (const [name, bytes] of files) {
    if (name.endsWith(".rels")) {
      const xml = decodeXml(bytes);
      for (const match of xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?Relationship\b[^>]*>/g)) {
        const tag = match[0];
        const target = (attribute(tag, "Target") ?? "").trim();
        const targetMode = (attribute(tag, "TargetMode") ?? "").trim().toLowerCase();
        const type = attribute(tag, "Type") ?? "";
        if (targetMode === "external" || /^(?:[a-z][a-z0-9+.-]*:|\/\/|\\\\)/i.test(target)) {
          warnings.add("external-relationships-blocked");
        }
        if (/(?:vbaProject|xlMacrosheet|xlIntlMacrosheet)/i.test(type)) warnings.add("macros-not-executed");
        if (/(?:oleObject|embeddedPackage|activeX|control|attachedTemplate)/i.test(type)) {
          warnings.add("embedded-objects-not-executed");
        }
      }
    }
    if (name === "[Content_Types].xml") {
      const xml = decodeXml(bytes);
      if (/(?:macroEnabled|vbaProject|macrosheet)/i.test(xml)) warnings.add("macros-not-executed");
    }
    if (/(?:^|\/)(?:vbaProject\.bin|vbaData\.xml)$/i.test(name) || /(?:^|\/)macrosheets\//i.test(name)) {
      warnings.add("macros-not-executed");
    }
    if (/(?:^|\/)(?:embeddings|activeX|ctrlProps|controls)\//i.test(name)) {
      warnings.add("embedded-objects-not-executed");
    }
    if (/(?:^|\/)externalLinks\//i.test(name)) warnings.add("external-relationships-blocked");
  }
  return [...warnings].sort();
}

export function safeText(value, maxLength = 100000) {
  assert(typeof value === "string", "INPUT_INVALID", "Expected text");
  assert(value.length <= maxLength, "INPUT_TOO_LARGE", "Text exceeds limit");
  for (let index = 0; index < value.length; index++) {
    const point = value.codePointAt(index);
    assert(isXmlCodePoint(point), "INPUT_INVALID", "Invalid XML character in text");
    if (point > 0xffff) index++;
  }
  return value;
}
