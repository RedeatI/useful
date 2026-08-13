// Browser-safe action semantics. This module must stay free of node:* imports.
import { ACTION_IDS, createBuiltinDescriptorMetadata } from "./catalog.mjs";

export { ACTION_IDS };

export const ERROR_CODES = Object.freeze({
  UNKNOWN_ACTION: "UNKNOWN_ACTION",
  DESCRIPTOR_INVALID: "DESCRIPTOR_INVALID",
  INPUT_INVALID: "INPUT_INVALID",
  OUTPUT_INVALID: "OUTPUT_INVALID",
  INPUT_TOO_LARGE: "INPUT_TOO_LARGE",
  OUTPUT_TOO_LARGE: "OUTPUT_TOO_LARGE",
  NOT_HEADLESS: "NOT_HEADLESS",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  CONFIRMATION_REQUIRED: "CONFIRMATION_REQUIRED",
  CANCELLED: "CANCELLED",
  TIMEOUT: "TIMEOUT",
  ACTION_FAILED: "ACTION_FAILED",
});

export const HASH_ALGORITHMS = Object.freeze(["SHA-1", "SHA-256", "SHA-384", "SHA-512"]);

const schema = (properties, required = Object.keys(properties)) => ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  properties,
  required,
});

const string = (maxLength = 1048576) => ({ type: "string", maxLength });

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

function common({ sourceDigest, actionId, inputSchema, outputSchema, examples, testVectors, maxOutputBytes = 2097152 }) {
  const metadata = createBuiltinDescriptorMetadata(actionId, sourceDigest);
  return {
    ...metadata,
    inputSchema,
    outputSchema,
    examples,
    testVectors,
    execution: {
      ...metadata.execution,
      handler: actionId,
      timeoutMs: 2000,
      maxInputBytes: 1048576,
      maxOutputBytes,
      supportsCancellation: false,
    },
    sensitive: { input: ["/text"], output: [], redactLogs: true },
  };
}

export function createBuiltinDescriptors(sourceDigest) {
  const textOutput = schema({ text: string(2097152) });
  const json = common({
    sourceDigest,
    actionId: ACTION_IDS.JSON,
    inputSchema: schema({
      operation: { type: "string", enum: ["format", "minify", "query"] },
      text: string(),
      indent: { type: "integer", minimum: 0, maximum: 8 },
      pointer: {
        type: "string",
        maxLength: 4096,
      },
    }, ["operation", "text"]),
    outputSchema: textOutput,
    examples: [{
      name: "format object",
      input: { operation: "format", text: "{\"a\":1}", indent: 2 },
      output: { text: "{\n  \"a\": 1\n}" },
    }],
    testVectors: [
      {
        name: "format object",
        input: { operation: "format", text: "{\"a\":1}", indent: 2 },
        expectedOutput: { text: "{\n  \"a\": 1\n}" },
      },
      {
        name: "minify array",
        input: { operation: "minify", text: "[ 1, 2 ]" },
        expectedOutput: { text: "[1,2]" },
      },
      {
        name: "query escaped pointer",
        input: { operation: "query", text: "{\"a/b\":{\"~key\":[1,2]}}", pointer: "/a~1b/~0key/1" },
        expectedOutput: { text: "2" },
      },
      { name: "query missing path", input: { operation: "query", text: "{}", pointer: "/missing" }, expectedErrorCode: ERROR_CODES.INPUT_INVALID },
      { name: "invalid json", input: { operation: "format", text: "{" }, expectedErrorCode: ERROR_CODES.INPUT_INVALID },
      { name: "reject injected field", input: { operation: "format", text: "{}", command: "calc.exe" }, expectedErrorCode: ERROR_CODES.INPUT_INVALID },
    ],
  });

  const base64 = common({
    sourceDigest,
    actionId: ACTION_IDS.BASE64,
    inputSchema: schema({
      operation: { type: "string", enum: ["encode", "decode"] },
      text: string(),
    }),
    outputSchema: textOutput,
    examples: [{ name: "encode", input: { operation: "encode", text: "Man" }, output: { text: "TWFu" } }],
    testVectors: [
      { name: "encode ASCII", input: { operation: "encode", text: "Man" }, expectedOutput: { text: "TWFu" } },
      { name: "encode UTF-8", input: { operation: "encode", text: "Useful 工具" }, expectedOutput: { text: "VXNlZnVsIOW3peWFtw==" } },
      { name: "decode UTF-8", input: { operation: "decode", text: "VXNlZnVsIOW3peWFtw==" }, expectedOutput: { text: "Useful 工具" } },
      { name: "reject non-canonical Base64", input: { operation: "decode", text: "TR==" }, expectedErrorCode: ERROR_CODES.INPUT_INVALID },
      { name: "reject invalid UTF-8", input: { operation: "decode", text: "/w==" }, expectedErrorCode: ERROR_CODES.INPUT_INVALID },
      { name: "invalid base64", input: { operation: "decode", text: "!!!" }, expectedErrorCode: ERROR_CODES.INPUT_INVALID },
    ],
  });

  const hashVectors = [
    ["SHA-1", "a9993e364706816aba3e25717850c26c9cd0d89d"],
    ["SHA-256", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["SHA-384", "cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7"],
    ["SHA-512", "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f"],
  ].map(([algorithm, digest]) => ({
    name: `${algorithm} abc`,
    input: { algorithm, text: "abc" },
    expectedOutput: { algorithm, digest, encoding: "hex" },
  }));

  const hash = common({
    sourceDigest,
    actionId: ACTION_IDS.HASH,
    inputSchema: schema({
      algorithm: { type: "string", enum: [...HASH_ALGORITHMS] },
      text: string(),
    }),
    outputSchema: schema({
      algorithm: { type: "string", enum: [...HASH_ALGORITHMS] },
      digest: { type: "string", minLength: 40, maxLength: 128 },
      encoding: { type: "string", const: "hex" },
    }),
    examples: [{ name: "sha256 abc", input: hashVectors[1].input, output: hashVectors[1].expectedOutput }],
    testVectors: [
      ...hashVectors,
      { name: "invalid algorithm", input: { algorithm: "MD5", text: "abc" }, expectedErrorCode: ERROR_CODES.INPUT_INVALID },
    ],
    maxOutputBytes: 1024,
  });

  return Object.freeze({ json, base64, hash });
}

export function jsonHandler(input) {
  assertExactObject(input, ["operation", "text"], ["indent", "pointer"]);
  if (!["format", "minify", "query"].includes(input.operation) || typeof input.text !== "string") {
    throw actionInputError("JSON action 输入不符合契约");
  }
  if (input.operation === "query") {
    if (typeof input.pointer !== "string" || input.pointer.length > 4096) {
      throw actionInputError("JSON Pointer 不符合契约");
    }
  } else if (input.pointer !== undefined) {
    throw actionInputError("只有 query 操作可声明 JSON Pointer");
  }
  if (input.indent !== undefined && (!Number.isInteger(input.indent) || input.indent < 0 || input.indent > 8)) {
    throw actionInputError("JSON 缩进不符合契约");
  }
  let value;
  try {
    value = JSON.parse(input.text);
  } catch (cause) {
    throw actionInputError("不是合法的 JSON", cause);
  }
  if (input.operation === "query") value = resolveJsonPointer(value, input.pointer);
  return {
    text: input.operation === "minify"
      ? JSON.stringify(value)
      : JSON.stringify(value, null, input.indent ?? 2),
  };
}

function resolveJsonPointer(root, pointer) {
  if (pointer === "") return root;
  if (!pointer.startsWith("/")) throw actionInputError("JSON Pointer 不符合契约");
  const tokens = pointer.slice(1).split("/").map((token) => {
    if (/~(?:[^01]|$)/.test(token)) throw actionInputError("JSON Pointer 转义不合法");
    return token.replaceAll("~1", "/").replaceAll("~0", "~");
  });
  let current = root;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/.test(token)) throw actionInputError("JSON Pointer 数组索引不合法");
      const index = Number(token);
      if (!Number.isSafeInteger(index) || index >= current.length) throw actionInputError("JSON Pointer 路径不存在");
      current = current[index];
      continue;
    }
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, token)) {
      throw actionInputError("JSON Pointer 路径不存在");
    }
    current = current[token];
  }
  return current;
}

function encodeBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunk = 32768;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function isCanonicalBase64(text) {
  if (text.length % 4 !== 0) return false;
  if (text.length === 0) return true;
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const contentLength = text.length - padding;
  if ((padding === 2 && contentLength % 4 !== 2) || (padding === 1 && contentLength % 4 !== 3)) return false;
  for (let index = 0; index < contentLength; index += 1) {
    const code = text.charCodeAt(index);
    const allowed =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!allowed) return false;
  }
  for (let index = contentLength; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 61) return false;
  }
  return true;
}

function decodeBase64(text) {
  const cleaned = text.trim();
  if (!isCanonicalBase64(cleaned)) {
    throw actionInputError("不是合法的 Base64");
  }
  try {
    const binary = atob(cleaned);
    if (btoa(binary) !== cleaned) throw new Error("non-canonical Base64");
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw actionInputError("不是合法的 Base64", cause);
  }
}

export function base64Handler(input) {
  assertExactObject(input, ["operation", "text"]);
  if (!["encode", "decode"].includes(input.operation) || typeof input.text !== "string") {
    throw actionInputError("Base64 action 输入不符合契约");
  }
  return { text: input.operation === "encode" ? encodeBase64(input.text) : decodeBase64(input.text) };
}

export function digestToHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function assertHashAlgorithm(algorithm) {
  if (!HASH_ALGORITHMS.includes(algorithm)) throw actionInputError("不支持的哈希算法");
}

export function assertHashInput(input) {
  assertExactObject(input, ["algorithm", "text"]);
  assertHashAlgorithm(input.algorithm);
  if (typeof input.text !== "string") throw actionInputError("Hash action 输入不符合契约");
}
