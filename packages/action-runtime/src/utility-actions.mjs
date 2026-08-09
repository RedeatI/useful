// Browser-safe semantics for the remaining built-in utilities. Node-only adapters
// (CSPRNG provenance and the terminable regex worker) are injected by builtins.mjs.
import YAML from "yaml";
import { ACTION_IDS, ERROR_CODES } from "./semantics.mjs";

const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const MAX_TEXT = 1048576;
const MAX_OUTPUT = 2097152;
const string = (maxLength = MAX_TEXT) => ({ type: "string", maxLength });
const integer = (minimum, maximum) => ({ type: "integer", minimum, maximum });
const number = (minimum, maximum) => ({ type: "number", minimum, maximum });
const boolean = () => ({ type: "boolean" });
const object = (properties, required = Object.keys(properties)) => ({
  $schema: DRAFT,
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
const nestedObject = (properties, required = Object.keys(properties)) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
const array = (items, maxItems = 1000) => ({ type: "array", items, maxItems });
const enumeration = (...values) => ({ type: "string", enum: values });

function actionInputError(message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.actionCode = ERROR_CODES.INPUT_INVALID;
  return error;
}

function assertExactObject(input, required, optional = []) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw actionInputError("action 输入必须是对象");
  }
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(input, key)) || Object.keys(input).some((key) => !allowed.has(key))) {
    throw actionInputError("action 输入字段不符合契约");
  }
}

function descriptor(sourceDigest, options) {
  return {
    contractVersion: "1.0",
    actionId: options.actionId,
    version: "1.0.0",
    source: {
      kind: "builtin",
      toolId: "builtin.utilities",
      publisher: { id: "useful.project", name: "Useful" },
      digest: sourceDigest,
    },
    title: options.title,
    description: options.description,
    keywords: options.keywords,
    aliases: options.aliases ?? [],
    inputSchema: options.inputSchema,
    outputSchema: options.outputSchema,
    examples: options.examples ?? [],
    testVectors: options.testVectors,
    execution: {
      mode: options.executionMode ?? "pure",
      handler: options.actionId,
      timeoutMs: options.timeoutMs ?? 2000,
      maxInputBytes: options.maxInputBytes ?? 1048576,
      maxOutputBytes: options.maxOutputBytes ?? MAX_OUTPUT,
      supportsCancellation: options.supportsCancellation ?? false,
    },
    behavior: {
      readOnly: true,
      destructive: false,
      idempotent: options.idempotent ?? true,
      openWorld: false,
      sideEffects: [],
      requiresConfirmation: false,
    },
    permissions: { required: [], capabilities: [] },
    sensitive: {
      input: options.sensitiveInput ?? [],
      output: options.sensitiveOutput ?? [],
      redactLogs: true,
    },
    presentation: {
      route: `/tools/utilities/${options.actionId.split(".").at(-1)}`,
      category: options.category,
    },
  };
}

const textOutput = object({ text: string(MAX_OUTPUT) });
const operationTextInput = (operations, extra = {}, requiredExtra = []) => object({
  operation: enumeration(...operations),
  text: string(),
  ...extra,
}, ["operation", "text", ...requiredExtra]);

export function createAdditionalBuiltinDescriptors(sourceDigest) {
  if (!/^[a-f0-9]{64}$/.test(sourceDigest)) throw new TypeError("sourceDigest must be SHA-256 hex");
  const entries = [
    descriptor(sourceDigest, {
      actionId: ACTION_IDS.URL, title: "URL encode/decode", description: "Encode text as a URL component or decode percent-encoded text.",
      keywords: ["url", "percent", "encode", "decode"], category: "encode", sensitiveInput: ["/text"],
      inputSchema: operationTextInput(["encode", "decode"]), outputSchema: object({ text: string(12582912) }), maxOutputBytes: 16777216,
      testVectors: [{ name: "encode", input: { operation: "encode", text: "a b" }, expectedOutput: { text: "a%20b" } }],
    }),
    descriptor(sourceDigest, {
      actionId: ACTION_IDS.UUID, title: "UUID generator", description: "Generate cryptographically random UUID v4 values.",
      keywords: ["uuid", "guid", "random"], aliases: ["guid"], category: "generate", idempotent: false,
      inputSchema: object({ count: integer(1, 1000) }), outputSchema: object({ values: array(string(36), 1000) }),
      testVectors: [{ name: "reject zero", input: { count: 0 }, expectedErrorCode: ERROR_CODES.INPUT_INVALID }],
    }),
    descriptor(sourceDigest, {
      actionId: ACTION_IDS.PASSWORD, title: "Password generator", description: "Generate a password with a cryptographically secure random source.",
      keywords: ["password", "random", "secret"], aliases: ["pwd"], category: "generate", idempotent: false,
      sensitiveOutput: ["/password"],
      inputSchema: object({ length: integer(4, 256), lower: boolean(), upper: boolean(), digits: boolean(), symbols: boolean(), excludeAmbiguous: boolean() }),
      outputSchema: object({ password: string(256), entropyBits: integer(0, 4096) }),
      testVectors: [{ name: "reject empty alphabet", input: { length: 16, lower: false, upper: false, digits: false, symbols: false, excludeAmbiguous: false }, expectedErrorCode: ERROR_CODES.INPUT_INVALID }],
    }),
    descriptor(sourceDigest, {
      actionId: ACTION_IDS.TIMESTAMP, title: "Timestamp converter", description: "Convert a Unix timestamp or strict ISO-8601 UTC string to stable UTC representations.",
      keywords: ["timestamp", "unix", "iso", "utc"], aliases: ["epoch"], category: "convert", sensitiveInput: ["/value"],
      inputSchema: object({ operation: enumeration("from-unix", "from-iso"), value: string(128) }),
      outputSchema: object({ unixSeconds: integer(-8640000000000, 8640000000000), unixMillis: integer(-8640000000000000, 8640000000000000), iso: string(64), utc: string(64) }),
      testVectors: [{ name: "unix epoch", input: { operation: "from-unix", value: "0" }, expectedOutput: { unixSeconds: 0, unixMillis: 0, iso: "1970-01-01T00:00:00.000Z", utc: "Thu, 01 Jan 1970 00:00:00 GMT" } }],
    }),
    descriptor(sourceDigest, {
      actionId: ACTION_IDS.BASE_CONVERT, title: "Base converter", description: "Convert an integer between bases 2, 8, 10, and 16 without precision loss.",
      keywords: ["base", "binary", "octal", "hex"], aliases: ["bin"], category: "convert", sensitiveInput: ["/value"],
      inputSchema: object({ value: string(4096), fromBase: { type: "integer", enum: [2, 8, 10, 16] }, toBase: { type: "integer", enum: [2, 8, 10, 16] } }),
      outputSchema: object({ value: string(16385) }),
      testVectors: [{ name: "hex to decimal", input: { value: "ff", fromBase: 16, toBase: 10 }, expectedOutput: { value: "255" } }],
    }),
    descriptor(sourceDigest, {
      actionId: ACTION_IDS.COLOR, title: "Color converter", description: "Convert a HEX color to normalized HEX, RGB, and HSL values.",
      keywords: ["color", "hex", "rgb", "hsl"], category: "convert",
      inputSchema: object({ hex: string(16) }),
      outputSchema: object({ hex: string(7), rgb: nestedObject({ r: integer(0, 255), g: integer(0, 255), b: integer(0, 255) }), hsl: nestedObject({ h: integer(0, 360), s: integer(0, 100), l: integer(0, 100) }) }),
      testVectors: [{ name: "red", input: { hex: "#f00" }, expectedOutput: { hex: "#ff0000", rgb: { r: 255, g: 0, b: 0 }, hsl: { h: 0, s: 100, l: 50 } } }],
    }),
    descriptor(sourceDigest, {
      actionId: ACTION_IDS.CASE, title: "Case converter", description: "Convert text between common identifier naming conventions.",
      keywords: ["case", "camel", "snake", "kebab"], category: "text", sensitiveInput: ["/text"],
      inputSchema: object({ text: string(), style: enumeration("camel", "pascal", "snake", "kebab", "constant", "title") }), outputSchema: textOutput,
      testVectors: [{ name: "snake", input: { text: "helloWorld", style: "snake" }, expectedOutput: { text: "hello_world" } }],
    }),
    descriptor(sourceDigest, {
      actionId: ACTION_IDS.REGEX, title: "Regular expression", description: "Test or replace text with a bounded regular expression worker.",
      keywords: ["regex", "regexp", "match", "replace"], category: "text", sensitiveInput: ["/text"], executionMode: "worker", supportsCancellation: true, timeoutMs: 1000,
      inputSchema: object({ operation: enumeration("test", "replace"), pattern: string(4096), flags: string(16), text: string(), replacement: string() }, ["operation", "pattern", "flags", "text"]),
      outputSchema: object({ matches: array(nestedObject({ index: integer(0, MAX_TEXT), match: string(), groups: array(string(), 100) }), 10000), text: string() }, []),
      testVectors: [{ name: "match words", input: { operation: "test", pattern: "a+", flags: "", text: "caaab" }, expectedOutput: { matches: [{ index: 1, match: "aaa", groups: [] }] } }],
    }),
    descriptor(sourceDigest, {
      actionId: ACTION_IDS.JWT, title: "JWT decoder", description: "Decode JWT header and payload JSON without verifying the signature.",
      keywords: ["jwt", "token", "decode"], category: "web", sensitiveInput: ["/token"], sensitiveOutput: ["/headerJson", "/payloadJson", "/signature"],
      inputSchema: object({ token: string() }), outputSchema: object({ headerJson: string(), payloadJson: string(), signature: string() }),
      testVectors: [{ name: "decode", input: { token: "eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0." }, expectedOutput: { headerJson: "{\"alg\":\"none\"}", payloadJson: "{\"sub\":\"1\"}", signature: "" } }],
    }),
    descriptor(sourceDigest, {
      actionId: ACTION_IDS.HTML, title: "HTML entities", description: "Encode, decode, or strip a bounded set of HTML entities and tags.",
      keywords: ["html", "entity", "escape"], category: "encode", sensitiveInput: ["/text"],
      inputSchema: operationTextInput(["encode", "decode", "strip"]), outputSchema: object({ text: string(6291456) }), maxOutputBytes: 8388608,
      testVectors: [{ name: "encode", input: { operation: "encode", text: "<a>" }, expectedOutput: { text: "&lt;a&gt;" } }],
    }),
    descriptor(sourceDigest, {
      actionId: ACTION_IDS.HEX_TEXT, title: "HEX text", description: "Convert UTF-8 text to hexadecimal bytes or decode hexadecimal bytes to text.",
      keywords: ["hex", "text", "bytes"], category: "encode", sensitiveInput: ["/text"],
      inputSchema: operationTextInput(["encode", "decode"], { separator: string(8) }), outputSchema: object({ text: string(12582912) }), maxOutputBytes: 16777216,
      testVectors: [{ name: "encode", input: { operation: "encode", text: "A" }, expectedOutput: { text: "41" } }],
    }),
    descriptor(sourceDigest, {
      actionId: ACTION_IDS.MORSE, title: "Morse code", description: "Encode supported text as Morse code or decode Morse symbols.",
      keywords: ["morse", "encode", "decode"], category: "encode", sensitiveInput: ["/text"],
      inputSchema: operationTextInput(["encode", "decode"]), outputSchema: object({ text: string(8388608) }), maxOutputBytes: 10485760,
      testVectors: [
        { name: "encode", input: { operation: "encode", text: "sos!" }, expectedOutput: { text: "... --- ... -.-.--" } },
        { name: "reject unsupported character", input: { operation: "encode", text: "sos🙂" }, expectedErrorCode: ERROR_CODES.INPUT_INVALID },
      ],
    }),
    descriptor(sourceDigest, {
      actionId: ACTION_IDS.TEXT_STATS, title: "Text statistics", description: "Count characters, non-space characters, words, lines, and UTF-8 bytes.",
      keywords: ["text", "count", "words", "lines"], category: "text", sensitiveInput: ["/text"],
      inputSchema: object({ text: string() }), outputSchema: object({ chars: integer(0, MAX_TEXT), charsNoSpaces: integer(0, MAX_TEXT), words: integer(0, MAX_TEXT), lines: integer(0, MAX_TEXT), bytes: integer(0, 4194304) }),
      testVectors: [{ name: "counts", input: { text: "a b\n" }, expectedOutput: { chars: 4, charsNoSpaces: 2, words: 2, lines: 2, bytes: 4 } }],
    }),
    descriptor(sourceDigest, {
      actionId: ACTION_IDS.TEXT_LINES, title: "Text line operations", description: "Trim, filter, deduplicate, sort, and reverse text lines deterministically.",
      keywords: ["lines", "sort", "dedupe"], category: "text", sensitiveInput: ["/text"],
      inputSchema: object({ text: string(), trim: boolean(), dropEmpty: boolean(), dedupe: boolean(), sort: enumeration("none", "asc", "desc"), reverse: boolean() }), outputSchema: textOutput,
      testVectors: [{ name: "sort", input: { text: "b\na\nb", trim: false, dropEmpty: false, dedupe: true, sort: "asc", reverse: false }, expectedOutput: { text: "a\nb" } }],
    }),
    descriptor(sourceDigest, {
      actionId: ACTION_IDS.SLUG, title: "Slug generator", description: "Convert text to a lowercase ASCII URL slug.",
      keywords: ["slug", "url", "kebab"], category: "text", sensitiveInput: ["/text"],
      inputSchema: object({ text: string() }), outputSchema: textOutput,
      testVectors: [{ name: "slug", input: { text: "Hello, World!" }, expectedOutput: { text: "hello-world" } }],
    }),
    descriptor(sourceDigest, {
      actionId: ACTION_IDS.BYTE_SIZE, title: "Byte size", description: "Format a non-negative byte count and return binary-unit breakdowns.",
      keywords: ["byte", "size", "kib", "mib"], category: "convert",
      inputSchema: object({ bytes: number(0, Number.MAX_SAFE_INTEGER) }), outputSchema: object({ text: string(64), breakdown: array(nestedObject({ unit: string(8), value: string(64) }), 8) }),
      testVectors: [{ name: "kibibyte", input: { bytes: 1024 }, expectedOutput: { text: "1 KiB", breakdown: [{ unit: "B", value: "1024" }, { unit: "KiB", value: "1" }, { unit: "MiB", value: "0.000977" }, { unit: "GiB", value: "0.000001" }] } }],
    }),
    descriptor(sourceDigest, {
      actionId: ACTION_IDS.LOREM, title: "Lorem ipsum", description: "Generate deterministic placeholder paragraphs.",
      keywords: ["lorem", "ipsum", "placeholder"], category: "generate",
      inputSchema: object({ paragraphs: integer(1, 50), sentences: integer(1, 20) }), outputSchema: textOutput,
      testVectors: [{ name: "reject zero", input: { paragraphs: 0, sentences: 1 }, expectedErrorCode: ERROR_CODES.INPUT_INVALID }],
    }),
    descriptor(sourceDigest, {
      actionId: ACTION_IDS.DURATION, title: "Duration", description: "Calculate the absolute duration between two strict ISO-8601 UTC instants.",
      keywords: ["duration", "date", "time"], category: "convert", sensitiveInput: ["/start", "/end"],
      inputSchema: object({ start: string(64), end: string(64) }), outputSchema: object({ totalSeconds: integer(0, Number.MAX_SAFE_INTEGER), negative: boolean(), days: integer(0, Number.MAX_SAFE_INTEGER), hours: integer(0, 23), minutes: integer(0, 59), seconds: integer(0, 59) }),
      testVectors: [{ name: "one day", input: { start: "2020-01-01T00:00:00.000Z", end: "2020-01-02T01:02:03.000Z" }, expectedOutput: { totalSeconds: 90123, negative: false, days: 1, hours: 1, minutes: 2, seconds: 3 } }],
    }),
    descriptor(sourceDigest, {
      actionId: ACTION_IDS.BYTE_UNIT, title: "Unit converter", description: "Convert length, weight, or temperature units.",
      keywords: ["unit", "length", "weight", "temperature"], category: "convert",
      inputSchema: object({ kind: enumeration("length", "weight", "temperature"), value: number(-1e15, 1e15), from: string(16), to: string(16) }), outputSchema: object({ value: number(-1e25, 1e25) }),
      testVectors: [{ name: "meters", input: { kind: "length", value: 1, from: "km", to: "m" }, expectedOutput: { value: 1000 } }],
    }),
    descriptor(sourceDigest, {
      actionId: ACTION_IDS.NUMBER_FORMAT, title: "Number formatter", description: "Format a finite decimal number with en-US grouping or scientific notation.",
      keywords: ["number", "format", "scientific"], category: "convert", sensitiveInput: ["/value"],
      inputSchema: object({ operation: enumeration("group", "scientific"), value: string(256), decimals: integer(0, 20) }, ["operation", "value"]), outputSchema: textOutput,
      testVectors: [
        { name: "group", input: { operation: "group", value: "1234.5", decimals: 2 }, expectedOutput: { text: "1,234.50" } },
        { name: "reject malformed grouping", input: { operation: "group", value: "1,2,3" }, expectedErrorCode: ERROR_CODES.INPUT_INVALID },
      ],
    }),
    descriptor(sourceDigest, {
      actionId: ACTION_IDS.UNICODE, title: "Unicode escape", description: "Escape text as JavaScript Unicode sequences or decode Unicode escape sequences.",
      keywords: ["unicode", "escape", "codepoint"], category: "encode", sensitiveInput: ["/text"],
      inputSchema: operationTextInput(["escape", "unescape"], { asciiOnly: boolean() }), outputSchema: object({ text: string(6291456) }), maxOutputBytes: 8388608,
      testVectors: [{ name: "escape", input: { operation: "escape", text: "中", asciiOnly: true }, expectedOutput: { text: "\\u4e2d" } }],
    }),
    descriptor(sourceDigest, {
      actionId: ACTION_IDS.CAESAR, title: "Caesar cipher", description: "Apply a Caesar shift or ROT13 to ASCII letters.",
      keywords: ["caesar", "rot13", "cipher"], category: "text", sensitiveInput: ["/text"],
      inputSchema: object({ operation: enumeration("shift", "rot13"), text: string(), shift: integer(-1000000, 1000000) }, ["operation", "text"]), outputSchema: textOutput,
      testVectors: [{ name: "rot13", input: { operation: "rot13", text: "Hello" }, expectedOutput: { text: "Uryyb" } }],
    }),
    descriptor(sourceDigest, {
      actionId: ACTION_IDS.LUHN, title: "Luhn checksum", description: "Validate a numeric Luhn checksum or calculate a check digit.",
      keywords: ["luhn", "checksum", "card"], category: "web", sensitiveInput: ["/input"],
      inputSchema: object({ operation: enumeration("validate", "check-digit"), input: string(4096) }), outputSchema: object({ valid: boolean(), checkDigit: integer(0, 9) }, []),
      testVectors: [{ name: "validate", input: { operation: "validate", input: "79927398713" }, expectedOutput: { valid: true } }],
    }),
    descriptor(sourceDigest, {
      actionId: ACTION_IDS.CONTRAST, title: "Color contrast", description: "Calculate WCAG contrast ratio and threshold results for two HEX colors.",
      keywords: ["contrast", "wcag", "a11y"], category: "web",
      inputSchema: object({ foreground: string(16), background: string(16) }), outputSchema: object({ ratio: number(1, 21), aaNormal: boolean(), aaLarge: boolean(), aaaNormal: boolean(), aaaLarge: boolean() }),
      testVectors: [{ name: "black white", input: { foreground: "#000000", background: "#ffffff" }, expectedOutput: { ratio: 21, aaNormal: true, aaLarge: true, aaaNormal: true, aaaLarge: true } }],
    }),
    descriptor(sourceDigest, {
      actionId: ACTION_IDS.RANDOM_NUMBER, title: "Random integers", description: "Generate cryptographically random integers in a closed interval without modulo bias.",
      keywords: ["random", "integer", "number"], category: "generate", idempotent: false,
      inputSchema: object({ min: integer(-1000000000, 1000000000), max: integer(-1000000000, 1000000000), count: integer(1, 1000) }), outputSchema: object({ values: array(integer(-1000000000, 1000000000), 1000) }),
      testVectors: [{ name: "reject zero", input: { min: 1, max: 2, count: 0 }, expectedErrorCode: ERROR_CODES.INPUT_INVALID }],
    }),
    descriptor(sourceDigest, {
      actionId: ACTION_IDS.DATA_FORMAT, title: "JSON / YAML converter", description: "Convert one bounded JSON or YAML document with deterministic output and no aliases or custom tags.",
      keywords: ["json", "yaml", "format", "convert"], aliases: ["yml"], category: "convert", sensitiveInput: ["/text"],
      inputSchema: object({ operation: enumeration("json-to-yaml", "yaml-to-json"), text: string(262144), indent: integer(2, 8) }, ["operation", "text"]),
      outputSchema: object({ text: string(1048576), format: enumeration("json", "yaml") }), maxInputBytes: 524288, maxOutputBytes: 1572864,
      testVectors: [
        { name: "JSON to stable YAML", input: { operation: "json-to-yaml", text: "{\"z\":1,\"a\":[true,null]}" }, expectedOutput: { text: "a:\n  - true\n  - null\nz: 1\n", format: "yaml" } },
        { name: "YAML to stable JSON", input: { operation: "yaml-to-json", text: "z: 1\na: true\n", indent: 2 }, expectedOutput: { text: "{\n  \"a\": true,\n  \"z\": 1\n}", format: "json" } },
        { name: "reject multiple YAML documents", input: { operation: "yaml-to-json", text: "---\na: 1\n---\nb: 2\n" }, expectedErrorCode: ERROR_CODES.INPUT_INVALID },
        { name: "reject YAML aliases", input: { operation: "yaml-to-json", text: "a: &x [1]\nb: *x\n" }, expectedErrorCode: ERROR_CODES.INPUT_INVALID },
        { name: "reject custom YAML tags", input: { operation: "yaml-to-json", text: "value: !custom x\n" }, expectedErrorCode: ERROR_CODES.INPUT_INVALID },
        { name: "reject unsafe integer precision loss", input: { operation: "yaml-to-json", text: "value: 9007199254740993\n" }, expectedErrorCode: ERROR_CODES.INPUT_INVALID },
      ],
    }),
    descriptor(sourceDigest, {
      actionId: ACTION_IDS.TEXT_DIFF, title: "Text diff", description: "Create a deterministic bounded line diff with structured hunks and readable text.",
      keywords: ["diff", "compare", "text", "lines"], category: "text", sensitiveInput: ["/before", "/after"],
      inputSchema: object({ before: string(262144), after: string(262144), context: integer(0, 10) }, ["before", "after"]),
      outputSchema: object({
        summary: nestedObject({ added: integer(0, 2000), removed: integer(0, 2000), unchanged: integer(0, 2000), hunks: integer(0, 2000) }),
        hunks: array(nestedObject({
          oldStart: integer(1, 2001), oldLines: integer(0, 2000), newStart: integer(1, 2001), newLines: integer(0, 2000),
          lines: array(nestedObject({
            type: enumeration("context", "remove", "add"), text: string(262144),
            oldLine: { type: ["integer", "null"], minimum: 1, maximum: 2000 }, newLine: { type: ["integer", "null"], minimum: 1, maximum: 2000 },
          }), 2000),
        }), 2000),
        text: string(2097152),
      }),
      testVectors: [
        { name: "single replacement", input: { before: "a\nb", after: "a\nc", context: 1 }, expectedOutput: { summary: { added: 1, removed: 1, unchanged: 1, hunks: 1 }, hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [{ type: "context", text: "a", oldLine: 1, newLine: 1 }, { type: "remove", text: "b", oldLine: 2, newLine: null }, { type: "add", text: "c", oldLine: null, newLine: 2 }] }], text: "@@ -1,2 +1,2 @@\n a\n-b\n+c" } },
        { name: "reject excessive complexity", input: { before: "x\n".repeat(1001), after: "y\n".repeat(1001) }, expectedErrorCode: ERROR_CODES.INPUT_INVALID },
      ],
    }),
    descriptor(sourceDigest, {
      actionId: ACTION_IDS.IPV4, title: "IPv4 / CIDR", description: "Inspect an IPv4 address or CIDR and test exact address containment without network access.",
      keywords: ["ipv4", "cidr", "subnet", "network"], aliases: ["ip"], category: "web",
      inputSchema: object({
        operation: enumeration("inspect", "contains"),
        value: string(64),
        cidr: string(64),
        address: string(32),
      }, ["operation"]),
      outputSchema: object({
        operation: enumeration("inspect", "contains"), input: string(64), address: string(15), prefixLength: integer(0, 32), network: string(15), broadcast: string(15),
        firstAddress: string(15), lastAddress: string(15), totalAddresses: integer(1, 4294967296), isPrivate: boolean(), isLoopback: boolean(), isMulticast: boolean(),
        cidr: string(18), contains: boolean(),
      }, ["operation"]),
      maxOutputBytes: 4096,
      testVectors: [
        { name: "inspect private CIDR", input: { operation: "inspect", value: "192.168.1.42/24" }, expectedOutput: { operation: "inspect", input: "192.168.1.42/24", address: "192.168.1.42", prefixLength: 24, network: "192.168.1.0", broadcast: "192.168.1.255", firstAddress: "192.168.1.0", lastAddress: "192.168.1.255", totalAddresses: 256, isPrivate: true, isLoopback: false, isMulticast: false } },
        { name: "contains address", input: { operation: "contains", cidr: "10.0.0.0/8", address: "10.2.3.4" }, expectedOutput: { operation: "contains", cidr: "10.0.0.0/8", address: "10.2.3.4", contains: true } },
        { name: "reject ambiguous leading zero", input: { operation: "inspect", value: "192.168.001.1" }, expectedErrorCode: ERROR_CODES.INPUT_INVALID },
      ],
    }),
  ];
  return Object.freeze(Object.fromEntries(entries.map((entry) => [entry.actionId.split(".").at(-1), entry])));
}

export function compareCodePoints(left, right) {
  const a = [...String(left)];
  const b = [...String(right)];
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = a[index].codePointAt(0) - b[index].codePointAt(0);
    if (difference) return difference < 0 ? -1 : 1;
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}

function urlHandler(input) {
  assertExactObject(input, ["operation", "text"]);
  if (typeof input.text !== "string" || !["encode", "decode"].includes(input.operation)) throw actionInputError("URL action 输入不符合契约");
  try {
    return { text: input.operation === "encode" ? encodeURIComponent(input.text) : decodeURIComponent(input.text.replaceAll("+", " ")) };
  } catch (cause) { throw actionInputError("不是合法的 URL 编码", cause); }
}

function randomBytes(cryptoAdapter, count) {
  if (!cryptoAdapter || typeof cryptoAdapter.getRandomValues !== "function") throw new Error("安全随机源不可用");
  return cryptoAdapter.getRandomValues(new Uint8Array(count));
}

function uuidHandler(input, cryptoAdapter) {
  assertExactObject(input, ["count"]);
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > 1000) throw actionInputError("UUID count 不符合契约");
  const values = [];
  for (let index = 0; index < input.count; index += 1) {
    const bytes = randomBytes(cryptoAdapter, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
    values.push(`${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`);
  }
  return { values };
}

const AMBIGUOUS = new Set("0O1lI|`'");
function uniformPick(cryptoAdapter, alphabet) {
  const ceiling = Math.floor(256 / alphabet.length) * alphabet.length;
  for (;;) {
    const value = randomBytes(cryptoAdapter, 1)[0];
    if (value < ceiling) return alphabet[value % alphabet.length];
  }
}

function passwordHandler(input, cryptoAdapter) {
  assertExactObject(input, ["length", "lower", "upper", "digits", "symbols", "excludeAmbiguous"]);
  if (!Number.isInteger(input.length) || input.length < 4 || input.length > 256 || [input.lower, input.upper, input.digits, input.symbols, input.excludeAmbiguous].some((value) => typeof value !== "boolean")) throw actionInputError("Password action 输入不符合契约");
  let sets = [input.lower && "abcdefghijklmnopqrstuvwxyz", input.upper && "ABCDEFGHIJKLMNOPQRSTUVWXYZ", input.digits && "0123456789", input.symbols && "!@#$%^&*()-_=+[]{};:,.<>?"].filter(Boolean);
  if (input.excludeAmbiguous) sets = sets.map((set) => [...set].filter((character) => !AMBIGUOUS.has(character)).join(""));
  if (!sets.length || sets.some((set) => !set.length)) throw actionInputError("至少选择一种字符集");
  const pool = sets.join("");
  const output = sets.map((set) => uniformPick(cryptoAdapter, set));
  while (output.length < input.length) output.push(uniformPick(cryptoAdapter, pool));
  for (let index = output.length - 1; index > 0; index -= 1) {
    const ceiling = Math.floor(256 / (index + 1)) * (index + 1);
    let value;
    do { value = randomBytes(cryptoAdapter, 1)[0]; } while (value >= ceiling);
    const target = value % (index + 1);
    [output[index], output[target]] = [output[target], output[index]];
  }
  return { password: output.join(""), entropyBits: Math.round(input.length * Math.log2(pool.length)) };
}

const STRICT_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
function timestampHandler(input) {
  assertExactObject(input, ["operation", "value"]);
  let milliseconds;
  if (input.operation === "from-unix" && typeof input.value === "string" && /^-?\d+(?:\.\d+)?$/.test(input.value)) {
    const value = Number(input.value);
    milliseconds = Math.abs(value) >= 1e12 ? value : value * 1000;
  } else if (input.operation === "from-iso" && typeof input.value === "string" && STRICT_ISO.test(input.value)) {
    milliseconds = Date.parse(input.value);
  } else throw actionInputError("Timestamp action 输入不符合契约");
  if (!Number.isSafeInteger(milliseconds)) throw actionInputError("时间戳超出安全范围");
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) throw actionInputError("非法时间戳");
  return { unixSeconds: Math.floor(milliseconds / 1000), unixMillis: milliseconds, iso: date.toISOString(), utc: date.toUTCString() };
}

function baseConvertHandler(input) {
  assertExactObject(input, ["value", "fromBase", "toBase"]);
  if (typeof input.value !== "string" || ![2, 8, 10, 16].includes(input.fromBase) || ![2, 8, 10, 16].includes(input.toBase)) throw actionInputError("Base conversion 输入不符合契约");
  let value = input.value.trim().toLowerCase();
  const negative = value.startsWith("-");
  if (negative) value = value.slice(1);
  if (input.fromBase === 16 && value.startsWith("0x")) value = value.slice(2);
  const patterns = { 2: /^[01]+$/, 8: /^[0-7]+$/, 10: /^\d+$/, 16: /^[0-9a-f]+$/ };
  if (!patterns[input.fromBase].test(value)) throw actionInputError("不是合法的进制数");
  let parsed = 0n;
  for (const character of value) parsed = parsed * BigInt(input.fromBase) + BigInt(parseInt(character, 16));
  if (negative) parsed = -parsed;
  return { value: parsed.toString(input.toBase) };
}

function parseHex(value) {
  if (typeof value !== "string") return undefined;
  let hex = value.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(hex)) hex = [...hex].map((character) => character.repeat(2)).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return undefined;
  return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4), 16) };
}

function rgbToHsl({ r, g, b }) {
  const [red, green, blue] = [r, g, b].map((value) => value / 255);
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const lightness = (maximum + minimum) / 2;
  const difference = maximum - minimum;
  let hue = 0;
  let saturation = 0;
  if (difference) {
    saturation = lightness > 0.5 ? difference / (2 - maximum - minimum) : difference / (maximum + minimum);
    if (maximum === red) hue = (green - blue) / difference + (green < blue ? 6 : 0);
    else if (maximum === green) hue = (blue - red) / difference + 2;
    else hue = (red - green) / difference + 4;
    hue /= 6;
  }
  return { h: Math.round(hue * 360), s: Math.round(saturation * 100), l: Math.round(lightness * 100) };
}

function colorHandler(input) {
  assertExactObject(input, ["hex"]);
  const rgb = parseHex(input.hex);
  if (!rgb) throw actionInputError("非法 HEX 颜色");
  const hex = `#${[rgb.r, rgb.g, rgb.b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
  return { hex, rgb, hsl: rgbToHsl(rgb) };
}

function splitWords(input) { return input.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().split(/\s+/).filter(Boolean); }
function caseHandler(input) {
  assertExactObject(input, ["text", "style"]);
  if (typeof input.text !== "string" || !["camel", "pascal", "snake", "kebab", "constant", "title"].includes(input.style)) throw actionInputError("Case action 输入不符合契约");
  const words = splitWords(input.text).map((word) => word.toLowerCase());
  const capitalized = (word) => word ? word[0].toUpperCase() + word.slice(1) : word;
  const values = {
    camel: words.map((word, index) => index ? capitalized(word) : word).join(""), pascal: words.map(capitalized).join(""),
    snake: words.join("_"), kebab: words.join("-"), constant: words.join("_").toUpperCase(), title: words.map(capitalized).join(" "),
  };
  return { text: values[input.style] };
}

function validateRegexInput(input) {
  assertExactObject(input, ["operation", "pattern", "flags", "text"], ["replacement"]);
  if (!["test", "replace"].includes(input.operation) || typeof input.pattern !== "string" || input.pattern.length > 4096 || typeof input.flags !== "string" || !/^[dgimsuvy]*$/.test(input.flags) || new Set(input.flags).size !== input.flags.length || typeof input.text !== "string" || (input.replacement !== undefined && typeof input.replacement !== "string")) throw actionInputError("Regex action 输入不符合契约");
  if (input.operation === "replace" && input.replacement === undefined) throw actionInputError("Regex replace 缺少 replacement");
}

function base64UrlJson(segment) {
  if (typeof segment !== "string" || !/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw actionInputError("JWT 段不是合法的 Base64URL/JSON");
  }
  const normalized = segment.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  try {
    const binary = atob(padded);
    const canonical = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    if (canonical !== segment) throw new Error("non-canonical Base64URL");
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return JSON.stringify(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch (cause) { throw actionInputError("JWT 段不是合法的 Base64URL/JSON", cause); }
}

function jwtHandler(input) {
  assertExactObject(input, ["token"]);
  if (typeof input.token !== "string") throw actionInputError("JWT action 输入不符合契约");
  const parts = input.token.trim().split(".");
  if (parts.length !== 3) throw actionInputError("JWT 必须为三段");
  return { headerJson: base64UrlJson(parts[0]), payloadJson: base64UrlJson(parts[1]), signature: parts[2] };
}

const HTML_ESCAPE = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };
const HTML_UNESCAPE = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", "#39": "'" };
function decodeHtml(text) {
  try {
    return text.replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_, name) => HTML_UNESCAPE[name])
      .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number(value)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, value) => String.fromCodePoint(parseInt(value, 16)));
  } catch (cause) { throw actionInputError("HTML 实体非法", cause); }
}
function htmlHandler(input) {
  assertExactObject(input, ["operation", "text"]);
  if (typeof input.text !== "string" || !["encode", "decode", "strip"].includes(input.operation)) throw actionInputError("HTML action 输入不符合契约");
  if (input.operation === "encode") return { text: input.text.replace(/[&<>"']/g, (character) => HTML_ESCAPE[character]) };
  if (input.operation === "decode") return { text: decodeHtml(input.text) };
  return { text: decodeHtml(input.text.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim() };
}

function hexTextHandler(input) {
  assertExactObject(input, ["operation", "text"], ["separator"]);
  if (typeof input.text !== "string" || !["encode", "decode"].includes(input.operation) || (input.separator !== undefined && typeof input.separator !== "string")) throw actionInputError("HEX text 输入不符合契约");
  if (input.operation === "encode") return { text: [...new TextEncoder().encode(input.text)].map((value) => value.toString(16).padStart(2, "0")).join(input.separator ?? "") };
  const cleaned = input.text.replace(/0x/gi, "").replace(/[\s,]+/g, "");
  if (cleaned.length % 2 || !/^[0-9a-fA-F]*$/.test(cleaned)) throw actionInputError("不是合法的十六进制文本");
  const bytes = Uint8Array.from({ length: cleaned.length / 2 }, (_, index) => parseInt(cleaned.slice(index * 2, index * 2 + 2), 16));
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch (cause) {
    throw actionInputError("十六进制字节不是合法的 UTF-8", cause);
  }
}

const MORSE = { a: ".-", b: "-...", c: "-.-.", d: "-..", e: ".", f: "..-.", g: "--.", h: "....", i: "..", j: ".---", k: "-.-", l: ".-..", m: "--", n: "-.", o: "---", p: ".--.", q: "--.-", r: ".-.", s: "...", t: "-", u: "..-", v: "...-", w: ".--", x: "-..-", y: "-.--", z: "--..", 0: "-----", 1: ".----", 2: "..---", 3: "...--", 4: "....-", 5: ".....", 6: "-....", 7: "--...", 8: "---..", 9: "----.", ".": ".-.-.-", ",": "--..--", "?": "..--..", "!": "-.-.--", "/": "-..-.", "@": ".--.-.", "-": "-....-", "(": "-.--.", ")": "-.--.-" };
const MORSE_REVERSE = Object.fromEntries(Object.entries(MORSE).map(([key, value]) => [value, key]));
function morseHandler(input) {
  assertExactObject(input, ["operation", "text"]);
  if (typeof input.text !== "string" || !["encode", "decode"].includes(input.operation)) throw actionInputError("Morse action 输入不符合契约");
  if (input.text === "") return { text: "" };
  if (input.operation === "encode") {
    const characters = [...input.text.toLowerCase()];
    if (characters.some((character) => character !== " " && !Object.hasOwn(MORSE, character))) throw actionInputError("包含不支持的 Morse 字符");
    return { text: characters.map((character) => character === " " ? "/" : MORSE[character]).join(" ") };
  }
  const symbols = input.text.trim().split(/\s+/);
  if (symbols.some((symbol) => symbol !== "/" && !Object.hasOwn(MORSE_REVERSE, symbol))) throw actionInputError("包含不支持的 Morse 符号");
  return { text: symbols.map((symbol) => symbol === "/" ? " " : MORSE_REVERSE[symbol]).join("") };
}

function textStatsHandler(input) {
  assertExactObject(input, ["text"]);
  if (typeof input.text !== "string") throw actionInputError("Text stats 输入不符合契约");
  return { chars: [...input.text].length, charsNoSpaces: [...input.text.replace(/\s/g, "")].length, words: input.text.trim() ? input.text.trim().split(/\s+/).length : 0, lines: input.text === "" ? 0 : input.text.split(/\r\n|\r|\n/).length, bytes: new TextEncoder().encode(input.text).length };
}

function textLinesHandler(input) {
  assertExactObject(input, ["text", "trim", "dropEmpty", "dedupe", "sort", "reverse"]);
  if (typeof input.text !== "string" || [input.trim, input.dropEmpty, input.dedupe, input.reverse].some((value) => typeof value !== "boolean") || !["none", "asc", "desc"].includes(input.sort)) throw actionInputError("Text lines 输入不符合契约");
  let lines = input.text.split(/\r\n|\r|\n/);
  if (input.trim) lines = lines.map((line) => line.trim());
  if (input.dropEmpty) lines = lines.filter(Boolean);
  if (input.dedupe) lines = [...new Set(lines)];
  if (input.sort !== "none") lines.sort((left, right) => input.sort === "asc" ? compareCodePoints(left, right) : compareCodePoints(right, left));
  if (input.reverse) lines.reverse();
  return { text: lines.join("\n") };
}

function slugHandler(input) {
  assertExactObject(input, ["text"]);
  if (typeof input.text !== "string") throw actionInputError("Slug 输入不符合契约");
  return { text: input.text.toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "") };
}

function byteBreakdown(bytes) {
  return [["B", 1], ["KiB", 1024], ["MiB", 1024 ** 2], ["GiB", 1024 ** 3]].map(([unit, divisor]) => ({ unit, value: (Math.round(bytes / divisor * 1e6) / 1e6).toString() }));
}
function byteSizeHandler(input) {
  assertExactObject(input, ["bytes"]);
  if (typeof input.bytes !== "number" || !Number.isFinite(input.bytes) || input.bytes < 0) throw actionInputError("Byte size 输入不符合契约");
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let value = input.bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return { text: `${index ? Math.round(value * 100) / 100 : value} ${units[index]}`, breakdown: byteBreakdown(input.bytes) };
}

const LOREM_WORDS = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat".split(" ");
function loremHandler(input) {
  assertExactObject(input, ["paragraphs", "sentences"]);
  if (!Number.isInteger(input.paragraphs) || input.paragraphs < 1 || input.paragraphs > 50 || !Number.isInteger(input.sentences) || input.sentences < 1 || input.sentences > 20) throw actionInputError("Lorem 输入不符合契约");
  let seed = 1;
  const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const paragraphs = [];
  for (let p = 0; p < input.paragraphs; p += 1) {
    const sentences = [];
    for (let s = 0; s < input.sentences; s += 1) {
      const words = Array.from({ length: 6 + Math.floor(random() * 8) }, () => LOREM_WORDS[Math.floor(random() * LOREM_WORDS.length)]);
      sentences.push(words.join(" ").replace(/^./, (character) => character.toUpperCase()) + ".");
    }
    paragraphs.push(sentences.join(" "));
  }
  return { text: paragraphs.join("\n\n") };
}

function strictInstant(value) {
  if (typeof value !== "string" || !STRICT_ISO.test(value)) throw actionInputError("日期必须是 ISO-8601 UTC");
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw actionInputError("无法解析日期");
  return milliseconds;
}
function durationHandler(input) {
  assertExactObject(input, ["start", "end"]);
  const difference = strictInstant(input.end) - strictInstant(input.start);
  let remaining = Math.floor(Math.abs(difference) / 1000);
  const totalSeconds = remaining;
  const days = Math.floor(remaining / 86400); remaining -= days * 86400;
  const hours = Math.floor(remaining / 3600); remaining -= hours * 3600;
  const minutes = Math.floor(remaining / 60); remaining -= minutes * 60;
  return { totalSeconds, negative: difference < 0, days, hours, minutes, seconds: remaining };
}

const LENGTH = { mm: 0.001, cm: 0.01, m: 1, km: 1000, in: 0.0254, ft: 0.3048, mi: 1609.344 };
const WEIGHT = { mg: 0.001, g: 1, kg: 1000, t: 1000000, oz: 28.349523125, lb: 453.59237 };
function unitHandler(input) {
  assertExactObject(input, ["kind", "value", "from", "to"]);
  if (!["length", "weight", "temperature"].includes(input.kind) || typeof input.value !== "number" || !Number.isFinite(input.value) || typeof input.from !== "string" || typeof input.to !== "string") throw actionInputError("Unit 输入不符合契约");
  if (input.kind === "temperature") {
    const celsius = input.from === "C" ? input.value : input.from === "F" ? (input.value - 32) / 1.8 : input.from === "K" ? input.value - 273.15 : undefined;
    if (celsius === undefined || !["C", "F", "K"].includes(input.to)) throw actionInputError("未知温度单位");
    return { value: input.to === "C" ? celsius : input.to === "F" ? celsius * 1.8 + 32 : celsius + 273.15 };
  }
  const table = input.kind === "length" ? LENGTH : WEIGHT;
  if (table[input.from] === undefined || table[input.to] === undefined) throw actionInputError("未知单位");
  return { value: input.value * table[input.from] / table[input.to] };
}

function numberFormatHandler(input) {
  assertExactObject(input, ["operation", "value"], ["decimals"]);
  const normalized = typeof input.value === "string" ? input.value.trim() : "";
  const validNumber = /^[+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  const value = validNumber.test(normalized) ? Number(normalized.replaceAll(",", "")) : NaN;
  if (!Number.isFinite(value) || !["group", "scientific"].includes(input.operation) || (input.decimals !== undefined && (!Number.isInteger(input.decimals) || input.decimals < 0 || input.decimals > 20))) throw actionInputError("Number format 输入不符合契约");
  if (input.operation === "scientific") return { text: value.toExponential(input.decimals) };
  const options = input.decimals === undefined ? {} : { minimumFractionDigits: input.decimals, maximumFractionDigits: input.decimals };
  return { text: new Intl.NumberFormat("en-US", { ...options, useGrouping: true }).format(value) };
}

function unicodeHandler(input) {
  assertExactObject(input, ["operation", "text"], ["asciiOnly"]);
  if (typeof input.text !== "string" || !["escape", "unescape"].includes(input.operation) || (input.asciiOnly !== undefined && typeof input.asciiOnly !== "boolean")) throw actionInputError("Unicode 输入不符合契约");
  if (input.operation === "unescape") return { text: input.text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))) };
  let text = "";
  for (const character of input.text) {
    const codePoint = character.codePointAt(0);
    if ((input.asciiOnly ?? true) && codePoint < 128) text += character;
    else {
      for (let index = 0; index < character.length; index += 1) {
        text += `\\u${character.charCodeAt(index).toString(16).padStart(4, "0")}`;
      }
    }
  }
  return { text };
}

function caesar(text, shift) {
  const normalized = ((shift % 26) + 26) % 26;
  return text.replace(/[a-zA-Z]/g, (character) => { const base = character <= "Z" ? 65 : 97; return String.fromCharCode((character.charCodeAt(0) - base + normalized) % 26 + base); });
}
function caesarHandler(input) {
  assertExactObject(input, ["operation", "text"], ["shift"]);
  if (typeof input.text !== "string" || !["shift", "rot13"].includes(input.operation) || (input.shift !== undefined && !Number.isInteger(input.shift))) throw actionInputError("Caesar 输入不符合契约");
  if (input.operation === "shift" && input.shift === undefined) throw actionInputError("Caesar shift 缺少 shift");
  return { text: caesar(input.text, input.operation === "rot13" ? 13 : input.shift) };
}

function luhnValidate(value) {
  const digits = value.replace(/[\s-]/g, "");
  if (!/^\d{2,}$/.test(digits)) return false;
  let sum = 0; let alternate = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) { let digit = Number(digits[index]); if (alternate) { digit *= 2; if (digit > 9) digit -= 9; } sum += digit; alternate = !alternate; }
  return sum % 10 === 0;
}
function luhnDigit(value) {
  const digits = value.replace(/[\s-]/g, "");
  if (!/^\d+$/.test(digits)) throw actionInputError("只能包含数字");
  let sum = 0; let alternate = true;
  for (let index = digits.length - 1; index >= 0; index -= 1) { let digit = Number(digits[index]); if (alternate) { digit *= 2; if (digit > 9) digit -= 9; } sum += digit; alternate = !alternate; }
  return (10 - sum % 10) % 10;
}
function luhnHandler(input) {
  assertExactObject(input, ["operation", "input"]);
  if (typeof input.input !== "string" || !["validate", "check-digit"].includes(input.operation)) throw actionInputError("Luhn 输入不符合契约");
  return input.operation === "validate" ? { valid: luhnValidate(input.input) } : { checkDigit: luhnDigit(input.input) };
}

function luminance(value) {
  const rgb = parseHex(value);
  if (!rgb) throw actionInputError("非法 HEX 颜色");
  const [red, green, blue] = [rgb.r, rgb.g, rgb.b].map((component) => { const normalized = component / 255; return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}
function contrastHandler(input) {
  assertExactObject(input, ["foreground", "background"]);
  const rawRatio = (Math.max(luminance(input.foreground), luminance(input.background)) + 0.05) / (Math.min(luminance(input.foreground), luminance(input.background)) + 0.05);
  const ratio = Math.round(rawRatio * 100) / 100;
  return { ratio, aaNormal: rawRatio >= 4.5, aaLarge: rawRatio >= 3, aaaNormal: rawRatio >= 7, aaaLarge: rawRatio >= 4.5 };
}

const MAX_DATA_NODES = 100000;

function canonicalData(value, state = { nodes: 0 }, depth = 0) {
  state.nodes += 1;
  if (state.nodes > MAX_DATA_NODES || depth > 100) throw actionInputError("数据结构超出安全上限");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw actionInputError("数据包含 JSON 不支持的数值");
    return value;
  }
  if (typeof value === "bigint") {
    if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw actionInputError("YAML 整数超出 JSON 安全精度范围");
    }
    return Number(value);
  }
  if (Array.isArray(value)) return value.map((entry) => canonicalData(entry, state, depth + 1));
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value ?? {});
  if (value instanceof Map && entries.some(([key]) => typeof key !== "string")) throw actionInputError("YAML map 的键必须是字符串");
  if (value === null || typeof value !== "object") throw actionInputError("数据包含 JSON 不支持的类型");
  entries.sort(([left], [right]) => compareCodePoints(left, right));
  const result = {};
  for (const [key, entry] of entries) {
    Object.defineProperty(result, key, {
      value: canonicalData(entry, state, depth + 1), enumerable: true, configurable: true, writable: true,
    });
  }
  return result;
}

function parseSafeYaml(text) {
  let documents;
  try {
    documents = YAML.parseAllDocuments(text, {
      version: "1.2",
      schema: "core",
      strict: true,
      uniqueKeys: true,
      merge: false,
      maxAliasCount: 0,
      intAsBigInt: true,
    });
  } catch (cause) {
    throw actionInputError("不是合法的 YAML", cause);
  }
  if (documents.length !== 1) throw actionInputError("YAML 必须且只能包含一个文档");
  const [document] = documents;
  if (document.errors.length) throw actionInputError("不是合法的 YAML", document.errors[0]);
  let forbidden;
  YAML.visit(document, (_key, node) => {
    if (YAML.isAlias(node)) forbidden = "YAML alias 不被允许";
    else if (node && typeof node === "object" && typeof node.tag === "string" && !node.tag.startsWith("tag:yaml.org,2002:")) {
      forbidden = "YAML custom tag 不被允许";
    }
  });
  if (forbidden) throw actionInputError(forbidden);
  try {
    return document.toJS({ mapAsMap: true, maxAliasCount: 0 });
  } catch (cause) {
    throw actionInputError("YAML 结构不安全或不受支持", cause);
  }
}

function dataFormatHandler(input) {
  assertExactObject(input, ["operation", "text"], ["indent"]);
  if (!['json-to-yaml', 'yaml-to-json'].includes(input.operation) || typeof input.text !== "string" || input.text.length > 262144) {
    throw actionInputError("Data format action 输入不符合契约");
  }
  if (input.indent !== undefined && (!Number.isInteger(input.indent) || input.indent < 2 || input.indent > 8)) {
    throw actionInputError("Data format 缩进不符合契约");
  }
  if (input.operation === "json-to-yaml") {
    let value;
    try { value = JSON.parse(input.text); } catch (cause) { throw actionInputError("不是合法的 JSON", cause); }
    const canonical = canonicalData(value);
    return { text: YAML.stringify(canonical, { indent: input.indent ?? 2, lineWidth: 0 }), format: "yaml" };
  }
  const canonical = canonicalData(parseSafeYaml(input.text));
  return { text: JSON.stringify(canonical, null, input.indent ?? 2), format: "json" };
}

const MAX_DIFF_LINES = 2000;
const MAX_DIFF_CELLS = 1000000;

function splitDiffLines(text) {
  return text === "" ? [] : text.split(/\r\n|\r|\n/);
}

function buildDiffRecords(before, after) {
  const width = after.length + 1;
  const cells = (before.length + 1) * width;
  if (before.length > MAX_DIFF_LINES || after.length > MAX_DIFF_LINES || cells > MAX_DIFF_CELLS) {
    throw actionInputError(`Text diff 复杂度超出上限（最多 ${MAX_DIFF_LINES} 行且 DP cells 不超过 ${MAX_DIFF_CELLS}）`);
  }
  const lcs = new Uint16Array(cells);
  for (let oldIndex = before.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = after.length - 1; newIndex >= 0; newIndex -= 1) {
      const index = oldIndex * width + newIndex;
      lcs[index] = before[oldIndex] === after[newIndex]
        ? lcs[(oldIndex + 1) * width + newIndex + 1] + 1
        : Math.max(lcs[(oldIndex + 1) * width + newIndex], lcs[index + 1]);
    }
  }
  const records = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < before.length || newIndex < after.length) {
    if (oldIndex < before.length && newIndex < after.length && before[oldIndex] === after[newIndex]) {
      records.push({ type: "context", text: before[oldIndex], oldLine: oldIndex + 1, newLine: newIndex + 1 });
      oldIndex += 1;
      newIndex += 1;
    } else if (oldIndex < before.length && (newIndex >= after.length || lcs[(oldIndex + 1) * width + newIndex] >= lcs[oldIndex * width + newIndex + 1])) {
      records.push({ type: "remove", text: before[oldIndex], oldLine: oldIndex + 1, newLine: null });
      oldIndex += 1;
    } else {
      records.push({ type: "add", text: after[newIndex], oldLine: null, newLine: newIndex + 1 });
      newIndex += 1;
    }
  }
  return records;
}

function diffHunks(records, context) {
  const ranges = [];
  for (let index = 0; index < records.length; index += 1) {
    if (records[index].type === "context") continue;
    const start = Math.max(0, index - context);
    const end = Math.min(records.length, index + context + 1);
    const previous = ranges.at(-1);
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
    else ranges.push({ start, end });
  }
  return ranges.map(({ start, end }) => {
    const lines = records.slice(start, end);
    let oldConsumed = 0;
    let newConsumed = 0;
    for (let index = 0; index < start; index += 1) {
      if (records[index].oldLine !== null) oldConsumed += 1;
      if (records[index].newLine !== null) newConsumed += 1;
    }
    return {
      oldStart: oldConsumed + 1,
      oldLines: lines.filter((line) => line.oldLine !== null).length,
      newStart: newConsumed + 1,
      newLines: lines.filter((line) => line.newLine !== null).length,
      lines,
    };
  });
}

function textDiffHandler(input) {
  assertExactObject(input, ["before", "after"], ["context"]);
  if (typeof input.before !== "string" || typeof input.after !== "string" || input.before.length > 262144 || input.after.length > 262144) {
    throw actionInputError("Text diff action 输入不符合契约");
  }
  const context = input.context ?? 3;
  if (!Number.isInteger(context) || context < 0 || context > 10) throw actionInputError("Text diff context 不符合契约");
  const records = buildDiffRecords(splitDiffLines(input.before), splitDiffLines(input.after));
  const hunks = diffHunks(records, context);
  const summary = {
    added: records.filter((line) => line.type === "add").length,
    removed: records.filter((line) => line.type === "remove").length,
    unchanged: records.filter((line) => line.type === "context").length,
    hunks: hunks.length,
  };
  const text = hunks.flatMap((hunk) => [
    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    ...hunk.lines.map((line) => `${line.type === "context" ? " " : line.type === "remove" ? "-" : "+"}${line.text}`),
  ]).join("\n");
  return { summary, hunks, text };
}

function parseIpv4(value) {
  if (typeof value !== "string" || value.length > 15) throw actionInputError("不是合法的 IPv4 地址");
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^(?:0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) {
    throw actionInputError("不是合法的 IPv4 地址");
  }
  const octets = parts.map(Number);
  return { text: octets.join("."), value: octets.reduce((result, octet) => result * 256 + octet, 0) };
}

function parseCidr(value, requirePrefix = false) {
  if (typeof value !== "string") throw actionInputError("不是合法的 IPv4/CIDR");
  const parts = value.split("/");
  if (parts.length > 2 || (requirePrefix && parts.length !== 2)) throw actionInputError("不是合法的 IPv4/CIDR");
  const address = parseIpv4(parts[0]);
  const prefixLength = parts.length === 1 ? 32 : (/^(?:[0-9]|[12]\d|3[0-2])$/.test(parts[1]) ? Number(parts[1]) : undefined);
  if (prefixLength === undefined) throw actionInputError("CIDR 前缀必须为 0 到 32");
  const size = 2 ** (32 - prefixLength);
  const networkValue = Math.floor(address.value / size) * size;
  return { address, prefixLength, size, networkValue, broadcastValue: networkValue + size - 1 };
}

function formatIpv4(value) {
  return [24, 16, 8, 0].map((shift) => Math.floor(value / (2 ** shift)) % 256).join(".");
}

function ipv4Handler(input) {
  if (input?.operation === "inspect") {
    assertExactObject(input, ["operation", "value"]);
    const parsed = parseCidr(input.value);
    const value = parsed.address.value;
    return {
      operation: "inspect", input: input.value, address: parsed.address.text, prefixLength: parsed.prefixLength,
      network: formatIpv4(parsed.networkValue), broadcast: formatIpv4(parsed.broadcastValue),
      firstAddress: formatIpv4(parsed.networkValue), lastAddress: formatIpv4(parsed.broadcastValue), totalAddresses: parsed.size,
      isPrivate: Math.floor(value / 2 ** 24) === 10 || Math.floor(value / 2 ** 20) === 0xac1 || Math.floor(value / 2 ** 16) === 0xc0a8,
      isLoopback: Math.floor(value / 2 ** 24) === 127,
      isMulticast: Math.floor(value / 2 ** 28) === 14,
    };
  }
  if (input?.operation === "contains") {
    assertExactObject(input, ["operation", "cidr", "address"]);
    const cidr = parseCidr(input.cidr, true);
    const address = parseIpv4(input.address);
    return { operation: "contains", cidr: `${formatIpv4(cidr.networkValue)}/${cidr.prefixLength}`, address: address.text, contains: address.value >= cidr.networkValue && address.value <= cidr.broadcastValue };
  }
  throw actionInputError("IPv4 action 输入不符合契约");
}

function randomNumberHandler(input, cryptoAdapter) {
  assertExactObject(input, ["min", "max", "count"]);
  if (![input.min, input.max, input.count].every(Number.isInteger) || input.count < 1 || input.count > 1000 || input.min < -1e9 || input.max > 1e9 || input.min > input.max) throw actionInputError("Random number 输入不符合契约");
  const range = input.max - input.min + 1;
  const ceiling = Math.floor(0x100000000 / range) * range;
  const values = [];
  while (values.length < input.count) {
    if (!cryptoAdapter || typeof cryptoAdapter.getRandomValues !== "function") throw new Error("安全随机源不可用");
    const sample = cryptoAdapter.getRandomValues(new Uint32Array(1))[0];
    if (sample < ceiling) values.push(input.min + sample % range);
  }
  return { values };
}

export function createAdditionalBuiltinHandlers(adapters = {}) {
  const cryptoAdapter = adapters.crypto ?? globalThis.crypto;
  const regex = async (input, context) => {
    validateRegexInput(input);
    if (typeof adapters.regex !== "function") throw new Error("Regex worker adapter 不可用");
    return adapters.regex(structuredClone(input), context);
  };
  return Object.freeze({
    [ACTION_IDS.URL]: urlHandler,
    [ACTION_IDS.UUID]: (input) => uuidHandler(input, cryptoAdapter),
    [ACTION_IDS.PASSWORD]: (input) => passwordHandler(input, cryptoAdapter),
    [ACTION_IDS.TIMESTAMP]: timestampHandler,
    [ACTION_IDS.BASE_CONVERT]: baseConvertHandler,
    [ACTION_IDS.COLOR]: colorHandler,
    [ACTION_IDS.CASE]: caseHandler,
    [ACTION_IDS.REGEX]: regex,
    [ACTION_IDS.JWT]: jwtHandler,
    [ACTION_IDS.HTML]: htmlHandler,
    [ACTION_IDS.HEX_TEXT]: hexTextHandler,
    [ACTION_IDS.MORSE]: morseHandler,
    [ACTION_IDS.TEXT_STATS]: textStatsHandler,
    [ACTION_IDS.TEXT_LINES]: textLinesHandler,
    [ACTION_IDS.SLUG]: slugHandler,
    [ACTION_IDS.BYTE_SIZE]: byteSizeHandler,
    [ACTION_IDS.LOREM]: loremHandler,
    [ACTION_IDS.DURATION]: durationHandler,
    [ACTION_IDS.BYTE_UNIT]: unitHandler,
    [ACTION_IDS.NUMBER_FORMAT]: numberFormatHandler,
    [ACTION_IDS.UNICODE]: unicodeHandler,
    [ACTION_IDS.CAESAR]: caesarHandler,
    [ACTION_IDS.LUHN]: luhnHandler,
    [ACTION_IDS.CONTRAST]: contrastHandler,
    [ACTION_IDS.RANDOM_NUMBER]: (input) => randomNumberHandler(input, cryptoAdapter),
    [ACTION_IDS.DATA_FORMAT]: dataFormatHandler,
    [ACTION_IDS.TEXT_DIFF]: textDiffHandler,
    [ACTION_IDS.IPV4]: ipv4Handler,
  });
}
