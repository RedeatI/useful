// Lightweight, browser-safe metadata for discovery surfaces. Keep this module
// free of handlers, schemas, YAML, office execution code, and node:* imports.

export const ACTION_IDS = Object.freeze({
  JSON: "builtin.utilities.json",
  BASE64: "builtin.utilities.base64",
  HASH: "builtin.utilities.hash",
  URL: "builtin.utilities.url",
  UUID: "builtin.utilities.uuid",
  PASSWORD: "builtin.utilities.password",
  TIMESTAMP: "builtin.utilities.timestamp",
  BASE_CONVERT: "builtin.utilities.base-convert",
  COLOR: "builtin.utilities.color",
  CASE: "builtin.utilities.case",
  REGEX: "builtin.utilities.regex",
  JWT: "builtin.utilities.jwt",
  HTML: "builtin.utilities.html",
  HEX_TEXT: "builtin.utilities.hex-text",
  MORSE: "builtin.utilities.morse",
  TEXT_STATS: "builtin.utilities.text-stats",
  TEXT_LINES: "builtin.utilities.text-lines",
  SLUG: "builtin.utilities.slug",
  BYTE_SIZE: "builtin.utilities.byte-size",
  LOREM: "builtin.utilities.lorem",
  DURATION: "builtin.utilities.duration",
  BYTE_UNIT: "builtin.utilities.byte-unit",
  NUMBER_FORMAT: "builtin.utilities.number-format",
  UNICODE: "builtin.utilities.unicode",
  CAESAR: "builtin.utilities.caesar",
  LUHN: "builtin.utilities.luhn",
  CONTRAST: "builtin.utilities.contrast",
  RANDOM_NUMBER: "builtin.utilities.random-number",
  DATA_FORMAT: "builtin.utilities.data-format",
  TEXT_DIFF: "builtin.utilities.text-diff",
  IPV4: "builtin.utilities.ipv4",
});

export const OFFICE_ACTION_IDS = Object.freeze({
  DOCX: "builtin.office.docx",
  PPTX: "builtin.office.pptx",
  SPREADSHEET: "builtin.office.spreadsheet",
  PDF: "builtin.office.pdf",
  MARKDOWN: "builtin.office.markdown",
});

const EMPTY = Object.freeze([]);
const PUBLISHER = Object.freeze({ id: "useful.project", name: "Useful" });

function defineMetadata({
  actionId,
  title,
  description,
  keywords,
  aliases = EMPTY,
  category,
  icon,
  executionMode = "pure",
  idempotent = true,
}) {
  const office = actionId.startsWith("builtin.office.");
  return Object.freeze({
    contractVersion: "1.0",
    actionId,
    version: "1.0.0",
    source: Object.freeze({
      kind: "builtin",
      toolId: office ? "builtin.office" : "builtin.utilities",
      publisher: PUBLISHER,
    }),
    title,
    description,
    keywords: Object.freeze([...keywords]),
    aliases: Object.freeze([...aliases]),
    execution: Object.freeze({ mode: executionMode }),
    behavior: Object.freeze({
      readOnly: true,
      destructive: false,
      idempotent,
      openWorld: false,
      sideEffects: EMPTY,
      requiresConfirmation: false,
    }),
    permissions: Object.freeze({ required: EMPTY, capabilities: EMPTY }),
    presentation: Object.freeze({
      route: office
        ? `/tools/office/${actionId.split(".").at(-1)}`
        : `/tools/utilities/${actionId.split(".").at(-1)}`,
      ...(icon ? { icon } : {}),
      category,
    }),
  });
}

export const BUILTIN_ACTION_CATALOG = Object.freeze([
  defineMetadata({
    actionId: ACTION_IDS.JSON,
    title: "JSON format",
    description: "Parse and deterministically format or minify JSON text.",
    keywords: ["json", "format", "pretty", "minify"],
    aliases: ["beautify"],
    category: "utilities",
  }),
  defineMetadata({
    actionId: ACTION_IDS.BASE64,
    title: "Base64 encode/decode",
    description: "Encode UTF-8 text to Base64 or decode canonical Base64 to UTF-8 text.",
    keywords: ["base64", "encode", "decode"],
    aliases: ["b64"],
    category: "utilities",
  }),
  defineMetadata({
    actionId: ACTION_IDS.HASH,
    title: "Text hash",
    description: "Hash UTF-8 text with a selected SHA algorithm and return lowercase hexadecimal output.",
    keywords: ["hash", "sha", "digest", "checksum"],
    aliases: ["sha256"],
    category: "utilities",
  }),
  defineMetadata({ actionId: ACTION_IDS.URL, title: "URL encode/decode", description: "Encode text as a URL component or decode percent-encoded text.", keywords: ["url", "percent", "encode", "decode"], category: "encode" }),
  defineMetadata({ actionId: ACTION_IDS.UUID, title: "UUID generator", description: "Generate cryptographically random UUID v4 values.", keywords: ["uuid", "guid", "random"], aliases: ["guid"], category: "generate", idempotent: false }),
  defineMetadata({ actionId: ACTION_IDS.PASSWORD, title: "Password generator", description: "Generate a password with a cryptographically secure random source.", keywords: ["password", "random", "secret"], aliases: ["pwd"], category: "generate", idempotent: false }),
  defineMetadata({ actionId: ACTION_IDS.TIMESTAMP, title: "Timestamp converter", description: "Convert a Unix timestamp or strict ISO-8601 UTC string to stable UTC representations.", keywords: ["timestamp", "unix", "iso", "utc"], aliases: ["epoch"], category: "convert" }),
  defineMetadata({ actionId: ACTION_IDS.BASE_CONVERT, title: "Base converter", description: "Convert an integer between bases 2, 8, 10, and 16 without precision loss.", keywords: ["base", "binary", "octal", "hex"], aliases: ["bin"], category: "convert" }),
  defineMetadata({ actionId: ACTION_IDS.COLOR, title: "Color converter", description: "Convert a HEX color to normalized HEX, RGB, and HSL values.", keywords: ["color", "hex", "rgb", "hsl"], category: "convert" }),
  defineMetadata({ actionId: ACTION_IDS.CASE, title: "Case converter", description: "Convert text between common identifier naming conventions.", keywords: ["case", "camel", "snake", "kebab"], category: "text" }),
  defineMetadata({ actionId: ACTION_IDS.REGEX, title: "Regular expression", description: "Test or replace text with a bounded regular expression worker.", keywords: ["regex", "regexp", "match", "replace"], category: "text", executionMode: "worker" }),
  defineMetadata({ actionId: ACTION_IDS.JWT, title: "JWT decoder", description: "Decode JWT header and payload JSON without verifying the signature.", keywords: ["jwt", "token", "decode"], category: "web" }),
  defineMetadata({ actionId: ACTION_IDS.HTML, title: "HTML entities", description: "Encode, decode, or strip a bounded set of HTML entities and tags.", keywords: ["html", "entity", "escape"], category: "encode" }),
  defineMetadata({ actionId: ACTION_IDS.HEX_TEXT, title: "HEX text", description: "Convert UTF-8 text to hexadecimal bytes or decode hexadecimal bytes to text.", keywords: ["hex", "text", "bytes"], category: "encode" }),
  defineMetadata({ actionId: ACTION_IDS.MORSE, title: "Morse code", description: "Encode supported text as Morse code or decode Morse symbols.", keywords: ["morse", "encode", "decode"], category: "encode" }),
  defineMetadata({ actionId: ACTION_IDS.TEXT_STATS, title: "Text statistics", description: "Count characters, non-space characters, words, lines, and UTF-8 bytes.", keywords: ["text", "count", "words", "lines"], category: "text" }),
  defineMetadata({ actionId: ACTION_IDS.TEXT_LINES, title: "Text line operations", description: "Trim, filter, deduplicate, sort, and reverse text lines deterministically.", keywords: ["lines", "sort", "dedupe"], category: "text" }),
  defineMetadata({ actionId: ACTION_IDS.SLUG, title: "Slug generator", description: "Convert text to a lowercase ASCII URL slug.", keywords: ["slug", "url", "kebab"], category: "text" }),
  defineMetadata({ actionId: ACTION_IDS.BYTE_SIZE, title: "Byte size", description: "Format a non-negative byte count and return binary-unit breakdowns.", keywords: ["byte", "size", "kib", "mib"], category: "convert" }),
  defineMetadata({ actionId: ACTION_IDS.LOREM, title: "Lorem ipsum", description: "Generate deterministic placeholder paragraphs.", keywords: ["lorem", "ipsum", "placeholder"], category: "generate" }),
  defineMetadata({ actionId: ACTION_IDS.DURATION, title: "Duration", description: "Calculate the absolute duration between two strict ISO-8601 UTC instants.", keywords: ["duration", "date", "time"], category: "convert" }),
  defineMetadata({ actionId: ACTION_IDS.BYTE_UNIT, title: "Unit converter", description: "Convert length, weight, or temperature units.", keywords: ["unit", "length", "weight", "temperature"], category: "convert" }),
  defineMetadata({ actionId: ACTION_IDS.NUMBER_FORMAT, title: "Number formatter", description: "Format a finite decimal number with en-US grouping or scientific notation.", keywords: ["number", "format", "scientific"], category: "convert" }),
  defineMetadata({ actionId: ACTION_IDS.UNICODE, title: "Unicode escape", description: "Escape text as JavaScript Unicode sequences or decode Unicode escape sequences.", keywords: ["unicode", "escape", "codepoint"], category: "encode" }),
  defineMetadata({ actionId: ACTION_IDS.CAESAR, title: "Caesar cipher", description: "Apply a Caesar shift or ROT13 to ASCII letters.", keywords: ["caesar", "rot13", "cipher"], category: "text" }),
  defineMetadata({ actionId: ACTION_IDS.LUHN, title: "Luhn checksum", description: "Validate a numeric Luhn checksum or calculate a check digit.", keywords: ["luhn", "checksum", "card"], category: "web" }),
  defineMetadata({ actionId: ACTION_IDS.CONTRAST, title: "Color contrast", description: "Calculate WCAG contrast ratio and threshold results for two HEX colors.", keywords: ["contrast", "wcag", "a11y"], category: "web" }),
  defineMetadata({ actionId: ACTION_IDS.RANDOM_NUMBER, title: "Random integers", description: "Generate cryptographically random integers in a closed interval without modulo bias.", keywords: ["random", "integer", "number"], category: "generate", idempotent: false }),
  defineMetadata({ actionId: ACTION_IDS.DATA_FORMAT, title: "JSON / YAML converter", description: "Convert one bounded JSON or YAML document with deterministic output and no aliases or custom tags.", keywords: ["json", "yaml", "format", "convert"], aliases: ["yml"], category: "convert" }),
  defineMetadata({ actionId: ACTION_IDS.TEXT_DIFF, title: "Text diff", description: "Create a deterministic bounded line diff with structured hunks and readable text.", keywords: ["diff", "compare", "text", "lines"], category: "text" }),
  defineMetadata({ actionId: ACTION_IDS.IPV4, title: "IPv4 / CIDR", description: "Inspect an IPv4 address or CIDR and test exact address containment without network access.", keywords: ["ipv4", "cidr", "subnet", "network"], aliases: ["ip"], category: "web" }),
  defineMetadata({ actionId: OFFICE_ACTION_IDS.DOCX, title: "Word / DOCX", description: "Compose, extract, inspect, or convert a bounded local DOCX document without executing macros, embedded objects, or external relationships.", keywords: ["word", "docx", "document", "markdown"], aliases: ["word"], category: "office", icon: "document", executionMode: "worker" }),
  defineMetadata({ actionId: OFFICE_ACTION_IDS.PPTX, title: "PowerPoint / PPTX", description: "Compose, extract, inspect, or convert a bounded local PPTX presentation without executing macros, embedded objects, or external relationships.", keywords: ["powerpoint", "pptx", "slides", "presentation", "markdown"], aliases: ["powerpoint", "slides"], category: "office", icon: "presentation", executionMode: "worker" }),
  defineMetadata({ actionId: OFFICE_ACTION_IDS.SPREADSHEET, title: "Spreadsheet / CSV / XLSX", description: "Compose, extract, inspect, or convert bounded XLSX, CSV, and simple Markdown tables locally; formulas are returned as text and are never evaluated.", keywords: ["excel", "xlsx", "csv", "spreadsheet", "table"], aliases: ["excel", "csv"], category: "office", icon: "spreadsheet", executionMode: "worker" }),
  defineMetadata({ actionId: OFFICE_ACTION_IDS.PDF, title: "PDF pages", description: "Inspect structure or locally merge, split, extract, delete, reorder, rotate, or sanitize bounded PDF pages using unique zero-based page indexes; inspection does not assess content safety or prove redaction.", keywords: ["pdf", "merge", "split", "rotate", "metadata"], aliases: ["pdf-pages"], category: "office", icon: "pdf", executionMode: "worker", idempotent: false }),
  defineMetadata({ actionId: OFFICE_ACTION_IDS.MARKDOWN, title: "Markdown office outline", description: "Parse a bounded Markdown outline or turn it into a local DOCX or PPTX file.", keywords: ["markdown", "md", "outline", "docx", "pptx"], aliases: ["md"], category: "office", icon: "markdown", executionMode: "worker" }),
]);

const METADATA_BY_ID = new Map(BUILTIN_ACTION_CATALOG.map((entry) => [entry.actionId, entry]));

export function findBuiltinActionMetadata(actionId) {
  return METADATA_BY_ID.get(actionId);
}

// Full descriptor builders use the same frozen catalog facts and add only
// execution limits, schemas, test vectors, sensitive paths, and provenance.
export function createBuiltinDescriptorMetadata(actionId, sourceDigest) {
  if (!/^[a-f0-9]{64}$/.test(sourceDigest)) throw new TypeError("sourceDigest must be SHA-256 hex");
  const metadata = findBuiltinActionMetadata(actionId);
  if (!metadata) throw new TypeError(`Unknown built-in action metadata: ${actionId}`);
  return {
    contractVersion: metadata.contractVersion,
    actionId: metadata.actionId,
    version: metadata.version,
    source: {
      ...metadata.source,
      publisher: { ...metadata.source.publisher },
      digest: sourceDigest,
    },
    title: metadata.title,
    description: metadata.description,
    keywords: [...metadata.keywords],
    aliases: [...metadata.aliases],
    execution: { ...metadata.execution },
    behavior: { ...metadata.behavior, sideEffects: [...metadata.behavior.sideEffects] },
    permissions: {
      required: [...metadata.permissions.required],
      capabilities: [...metadata.permissions.capabilities],
    },
    presentation: { ...metadata.presentation },
  };
}
