const formerName = ["tool", "box"].join("");
const formerAbbreviation = ["t", "b", "x"].join("");
const formerLocalizedName = ["工具", "箱"].join("");
function abbreviationOffset(text) {
  // Integrity/checksum payloads are opaque and can contain the short token by chance. Mask only
  // recognized digest tokens; package names, module paths, keys, comments, and other text remain
  // fully scanned, including inside generated lock files.
  const masked = String(text).replace(
    /(?:sha(?:1|224|256|384|512)-|h1:)[A-Za-z0-9+/_=-]+/gi,
    (value) => " ".repeat(value.length),
  );
  return masked.toLowerCase().indexOf(formerAbbreviation);
}

export function formerBrandMatches(text, { includeAbbreviation = true } = {}) {
  const source = String(text);
  const normalized = source.toLowerCase();
  const matches = [];
  const nameOffset = normalized.indexOf(formerName);
  if (nameOffset !== -1) matches.push({ kind: "former-name", offset: nameOffset });
  const localizedNameOffset = source.indexOf(formerLocalizedName);
  if (localizedNameOffset !== -1) matches.push({ kind: "former-localized-name", offset: localizedNameOffset });
  if (includeAbbreviation) {
    const offset = abbreviationOffset(source);
    if (offset !== -1) matches.push({ kind: "former-abbreviation", offset });
  }
  return matches;
}

export function shouldScanFormerAbbreviation(relative) {
  return typeof relative === "string";
}

export function decodeBrandText(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le", { fatal: true }).decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be", { fatal: true }).decode(bytes.subarray(2));
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return text.includes("\0") ? null : text;
}
