// Browser-safe, content-based Action suggestions. Detection is deliberately
// local and bounded: callers provide an explicit sample and the sample is never
// copied into the result.

export const ACTION_SUGGEST_LIMITS = Object.freeze({
  inputBytes: 65536,
  limit: 20,
});

const MAX_SCORE = 1000;

function suggestionError() {
  const error = new TypeError("Action suggestion input invalid");
  error.code = "ACTION_SUGGEST_INVALID";
  throw error;
}

function compareCodePoints(left, right) {
  const a = Array.from(left);
  const b = Array.from(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const delta = a[index].codePointAt(0) - b[index].codePointAt(0);
    if (delta !== 0) return delta;
  }
  return a.length - b.length;
}

function looksLikeIpv4(value) {
  const [address, prefix] = value.split("/");
  if (value.split("/").length > 2 || (prefix !== undefined && (!/^\d{1,2}$/.test(prefix) || String(Number(prefix)) !== prefix || Number(prefix) > 32))) return false;
  const octets = address.split(".");
  return octets.length === 4 && octets.every((octet) => /^\d{1,3}$/.test(octet)
    && String(Number(octet)) === octet
    && Number(octet) <= 255);
}

function looksLikeDelimitedTable(value) {
  const lines = value.split(/\r?\n/u).filter((line) => line.trim()).slice(0, 20);
  if (lines.length < 2) return false;
  for (const delimiter of [",", "\t", ";"]) {
    const counts = lines.map((line) => line.split(delimiter).length);
    if (counts[0] > 1 && counts.every((count) => count === counts[0])) return true;
  }
  return false;
}

function looksLikeYaml(value) {
  if (/^---(?:\r?\n|$)/u.test(value)) return true;
  const mappingLines = value.split(/\r?\n/u).filter((line) => /^\s*[A-Za-z_][\w.-]*\s*:\s*(?:\S.*)?$/u.test(line));
  return mappingLines.length >= 2;
}

function isCanonicalBase64Candidate(value) {
  if (value.length < 8 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return false;
  if (/^\d+$/u.test(value)) return false;
  return /[+/=]/u.test(value) || value.length >= 16;
}

function looksLikeHtml(value) {
  for (let cursor = 0; cursor < value.length;) {
    const start = value.indexOf("<", cursor);
    if (start < 0) break;
    const first = value.codePointAt(start + 1);
    if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) {
      if (value.indexOf(">", start + 2) >= 0) return true;
    }
    cursor = start + 1;
  }
  for (let cursor = 0; cursor < value.length;) {
    const start = value.indexOf("&", cursor);
    if (start < 0) return false;
    const end = value.indexOf(";", start + 1);
    if (end < 0) return false;
    const entity = value.slice(start + 1, end);
    if (/^(?:[A-Za-z]+|#\d+|#x[0-9a-f]+)$/iu.test(entity)) return true;
    cursor = start + 1;
  }
  return false;
}

function validateOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) suggestionError();
  const allowed = new Set(["limit", "minimumScore"]);
  if (Object.keys(options).some((key) => !allowed.has(key))) suggestionError();
  const limit = options.limit ?? 5;
  const minimumScore = options.minimumScore ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > ACTION_SUGGEST_LIMITS.limit) suggestionError();
  if (!Number.isInteger(minimumScore) || minimumScore < 0 || minimumScore > MAX_SCORE) suggestionError();
  return { limit, minimumScore };
}

function confidence(score) {
  if (score >= 900) return "high";
  if (score >= 700) return "medium";
  return "low";
}

/**
 * Suggest Actions for an explicit text sample without returning or retaining
 * the sample. The descriptors argument is normally a profile-filtered registry
 * list, so suggestions cannot bypass exposure policy.
 */
export function suggestActions(descriptors, text, options = {}) {
  if (!Array.isArray(descriptors) || typeof text !== "string") suggestionError();
  if (new TextEncoder().encode(text).byteLength > ACTION_SUGGEST_LIMITS.inputBytes) suggestionError();
  const { limit, minimumScore } = validateOptions(options);
  const available = new Map();
  for (const descriptor of descriptors) {
    if (descriptor === null || typeof descriptor !== "object" || Array.isArray(descriptor)
      || typeof descriptor.actionId !== "string" || typeof descriptor.title !== "string") suggestionError();
    if (descriptor.execution?.mode !== "ui-only") available.set(descriptor.actionId, descriptor);
  }

  const ranked = new Map();
  const add = (actionId, score, reason) => {
    if (!available.has(actionId)) return;
    const current = ranked.get(actionId) ?? { score: 0, reasons: new Set() };
    current.score = Math.max(current.score, score);
    current.reasons.add(reason);
    ranked.set(actionId, current);
  };

  const trimmed = text.trim();
  if (!trimmed) return { suggestions: [] };
  add("builtin.utilities.text-stats", 100, "plain-text");
  if (/\r?\n/u.test(text)) add("builtin.utilities.text-lines", 150, "multi-line-text");

  let validJson = false;
  if (/^[\[{]/u.test(trimmed)) {
    try {
      JSON.parse(trimmed);
      validJson = true;
      add("builtin.utilities.json", 1000, "valid-json");
      add("builtin.utilities.data-format", 980, "valid-json");
    } catch {
      add("builtin.utilities.json", 650, "json-like");
    }
  }
  if (!validJson && looksLikeYaml(trimmed)) add("builtin.utilities.data-format", 820, "yaml-like");

  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/u.test(trimmed)) {
    add("builtin.utilities.jwt", 970, "compact-jwt");
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) add("builtin.utilities.url", 930, "absolute-url");
  else if (/%[0-9a-f]{2}/iu.test(trimmed)) add("builtin.utilities.url", 700, "percent-encoded");

  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(trimmed)) {
    add("builtin.utilities.uuid", 900, "uuid");
  }
  if (/^(?:\d{10}|\d{13})$/u.test(trimmed) || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(trimmed)) {
    add("builtin.utilities.timestamp", 920, "timestamp");
  }
  if (looksLikeIpv4(trimmed)) add("builtin.utilities.ipv4", trimmed.includes("/") ? 960 : 900, trimmed.includes("/") ? "ipv4-cidr" : "ipv4-address");

  const base64Candidate = trimmed.replace(/\r?\n/gu, "");
  if (isCanonicalBase64Candidate(base64Candidate)) add("builtin.utilities.base64", 800, "canonical-base64");
  const hexCandidate = trimmed.replace(/^0x/iu, "");
  if (hexCandidate.length >= 4 && hexCandidate.length % 2 === 0 && /^[0-9a-f]+$/iu.test(hexCandidate) && /[a-f]/iu.test(hexCandidate)) {
    add("builtin.utilities.hex-text", 780, "hex-bytes");
  }
  if (/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/iu.test(trimmed)) {
    add("builtin.utilities.color", 900, "hex-color");
    add("builtin.utilities.contrast", 600, "hex-color");
  }
  if (looksLikeHtml(trimmed)) add("builtin.utilities.html", 760, "html-markup");
  if (/\\u[0-9a-f]{4}/iu.test(trimmed)) add("builtin.utilities.unicode", 760, "unicode-escape");
  if (/^[.\-/\s]+$/u.test(trimmed) && /[.-]/u.test(trimmed)) add("builtin.utilities.morse", 720, "morse-symbols");
  if (looksLikeDelimitedTable(text)) add("builtin.office.spreadsheet", 780, "delimited-table");
  if (/^(?:#{1,6}\s|```|>\s|[-*+]\s|\|.+\|)/mu.test(text)) add("builtin.office.markdown", 740, "markdown-structure");

  return {
    suggestions: [...ranked.entries()]
      .filter(([, value]) => value.score >= minimumScore)
      .map(([actionId, value]) => {
        const descriptor = available.get(actionId);
        return {
          actionId,
          title: descriptor.title,
          description: descriptor.description ?? "",
          score: value.score,
          confidence: confidence(value.score),
          reasonCodes: [...value.reasons].sort(compareCodePoints),
        };
      })
      .sort((left, right) => right.score - left.score || compareCodePoints(left.actionId, right.actionId))
      .slice(0, limit),
  };
}
