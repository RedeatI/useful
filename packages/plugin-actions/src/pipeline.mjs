import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { assertActionDescriptor, isReservedActionName, utf8JsonBytes } from "@useful/action-contract";
import Ajv2020 from "ajv/dist/2020.js";
import {
  ActionExecutionError,
  ActionExecutor,
  ActionRegistry,
  ERROR_CODES,
} from "@useful/action-runtime";

export const PLUGIN_ACTION_SCHEMA_VERSION = "useful.plugin-action.v1";
export const PIPELINE_HANDLER = "useful.pipeline-v1";
export const ALLOWED_PIPELINE_ACTIONS = Object.freeze([
  "builtin.utilities.json",
  "builtin.utilities.base64",
  "builtin.utilities.hash",
]);

export const PIPELINE_LIMITS = Object.freeze({
  steps: 16,
  templateDepth: 32,
  templateNodes: 4096,
  templateBytes: 262144,
  expandedBytes: 1048576,
  intermediateBytes: 4194304,
});

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const STEP_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const ACTION_ID = /^[a-z][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)+$/;
const REF = /^(?:\/input(?:\/(?:[^~/]|~0|~1)*)*|\/steps\/([a-z][a-z0-9_-]{0,31})\/output(?:\/(?:[^~/]|~0|~1)*)*)$/;
const pluginActionSchema = JSON.parse(readFileSync(new URL("./useful.plugin-action.v1.schema.json", import.meta.url), "utf8"));
const schemaValidator = new Ajv2020({ allErrors: true, strict: true }).compile(pluginActionSchema);

export class PluginActionError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "PluginActionError";
    this.code = code;
  }
}

function fail(code) {
  throw new PluginActionError(code);
}

function isObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactObject(value, required, allowed, code = "PLUGIN_ACTION_INVALID") {
  if (!isObject(value)) fail(code);
  for (const key of required) if (!Object.hasOwn(value, key)) fail(code);
  for (const key of Object.keys(value)) if (!allowed.includes(key) || FORBIDDEN_KEYS.has(key)) fail(code);
}

function stringList(value, maxItems, maxLength) {
  if (!Array.isArray(value) || value.length > maxItems || new Set(value).size !== value.length) fail("PLUGIN_ACTION_INVALID");
  if (value.some((entry) => typeof entry !== "string" || entry.length < 1 || entry.length > maxLength)) fail("PLUGIN_ACTION_INVALID");
}

export function inspectJson(value, limits = PIPELINE_LIMITS) {
  let nodes = 0;
  const walk = (current, depth) => {
    nodes += 1;
    if (nodes > limits.templateNodes) fail("PIPELINE_TEMPLATE_TOO_LARGE");
    if (depth > limits.templateDepth) fail("PIPELINE_TEMPLATE_TOO_DEEP");
    if (typeof current === "number" && !Number.isFinite(current)) fail("PLUGIN_ACTION_INVALID");
    if (current === null || ["string", "boolean", "number"].includes(typeof current)) return;
    if (Array.isArray(current)) {
      for (const entry of current) walk(entry, depth + 1);
      return;
    }
    if (!isObject(current)) fail("PLUGIN_ACTION_INVALID");
    for (const [key, child] of Object.entries(current)) {
      if (FORBIDDEN_KEYS.has(key)) fail("PIPELINE_FORBIDDEN_KEY");
      walk(child, depth + 1);
    }
  };
  walk(value, 0);
  let bytes;
  try { bytes = utf8JsonBytes(value); } catch { fail("PLUGIN_ACTION_INVALID"); }
  return { nodes, bytes };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function canonicalActionDigest(spec) {
  return createHash("sha256").update(canonical(spec), "utf8").digest("hex");
}

export function validatePluginActionSchema(value) {
  const valid = schemaValidator(value);
  return {
    valid: valid === true,
    errors: valid === true ? [] : (schemaValidator.errors ?? []).map((error) => ({
      instancePath: error.instancePath,
      keyword: error.keyword,
    })),
  };
}

export function isValidActionId(value) {
  return typeof value === "string" && value.length <= 200 && ACTION_ID.test(value);
}

function decodePointerSegment(value) {
  const decoded = value.replace(/~1/g, "/").replace(/~0/g, "~");
  if (FORBIDDEN_KEYS.has(decoded)) fail("PIPELINE_FORBIDDEN_KEY");
  return decoded;
}

function validateReference(pointer, completed) {
  if (typeof pointer !== "string") fail("PIPELINE_REFERENCE_INVALID");
  const match = REF.exec(pointer);
  if (!match) fail("PIPELINE_REFERENCE_INVALID");
  if (match[1] && !completed.has(match[1])) fail("PIPELINE_FORWARD_REFERENCE");
  for (const segment of pointer.split("/").slice(1)) decodePointerSegment(segment);
}

function validateTemplate(template, completed) {
  const details = inspectJson(template);
  if (details.bytes > PIPELINE_LIMITS.templateBytes) fail("PIPELINE_TEMPLATE_TOO_LARGE");
  const walk = (current) => {
    if (typeof current === "string" && /\$\{[^}]*\}/.test(current)) fail("PIPELINE_INTERPOLATION_FORBIDDEN");
    if (Array.isArray(current)) return current.forEach(walk);
    if (!isObject(current)) return;
    if (Object.keys(current).length === 1 && Object.hasOwn(current, "$ref")) {
      validateReference(current.$ref, completed);
      return;
    }
    for (const child of Object.values(current)) walk(child);
  };
  walk(template);
}

export function validatePluginActionSpec(spec) {
  exactObject(
    spec,
    ["schemaVersion", "title", "description", "keywords", "aliases", "inputSchema", "outputSchema", "examples", "testVectors", "execution", "pipeline"],
    ["schemaVersion", "title", "description", "keywords", "aliases", "inputSchema", "outputSchema", "examples", "testVectors", "execution", "presentation", "pipeline"],
  );
  inspectJson(spec);
  if (spec.schemaVersion !== PLUGIN_ACTION_SCHEMA_VERSION) fail("PLUGIN_ACTION_VERSION_UNSUPPORTED");
  if (typeof spec.title !== "string" || !spec.title.length || spec.title.length > 200) fail("PLUGIN_ACTION_INVALID");
  if (typeof spec.description !== "string" || !spec.description.length || spec.description.length > 4000) fail("PLUGIN_ACTION_INVALID");
  stringList(spec.keywords, 64, 80);
  stringList(spec.aliases, 32, 80);
  if (spec.aliases.some(isReservedActionName)) fail("PLUGIN_ACTION_RESERVED_NAME");
  if (!Array.isArray(spec.examples) || spec.examples.length > 32) fail("PLUGIN_ACTION_INVALID");
  if (!Array.isArray(spec.testVectors) || spec.testVectors.length < 1 || spec.testVectors.length > 64) fail("PLUGIN_TEST_VECTOR_REQUIRED");
  for (const example of spec.examples) {
    exactObject(example, ["name", "input", "output"], ["name", "input", "output"]);
    if (typeof example.name !== "string" || !example.name.length || example.name.length > 200) fail("PLUGIN_ACTION_INVALID");
  }
  for (const vector of spec.testVectors) {
    exactObject(vector, ["name", "input"], ["name", "input", "expectedOutput", "expectedErrorCode"]);
    if (typeof vector.name !== "string" || !vector.name.length || vector.name.length > 200) fail("PLUGIN_ACTION_INVALID");
    const expected = Number(Object.hasOwn(vector, "expectedOutput")) + Number(Object.hasOwn(vector, "expectedErrorCode"));
    if (expected !== 1 || (Object.hasOwn(vector, "expectedErrorCode") && (typeof vector.expectedErrorCode !== "string" || !vector.expectedErrorCode.length || vector.expectedErrorCode.length > 80))) fail("PLUGIN_ACTION_INVALID");
  }
  exactObject(spec.execution, ["timeoutMs", "maxInputBytes", "maxOutputBytes"], ["timeoutMs", "maxInputBytes", "maxOutputBytes"]);
  const ranges = [["timeoutMs", 5000], ["maxInputBytes", 1048576], ["maxOutputBytes", 1048576]];
  for (const [key, max] of ranges) if (!Number.isInteger(spec.execution[key]) || spec.execution[key] < 1 || spec.execution[key] > max) fail("PLUGIN_EXECUTION_LIMIT_INVALID");
  exactObject(spec.pipeline, ["steps", "output"], ["steps", "output"]);
  if (!Array.isArray(spec.pipeline.steps) || spec.pipeline.steps.length < 1 || spec.pipeline.steps.length > PIPELINE_LIMITS.steps) fail("PIPELINE_STEP_LIMIT");
  const completed = new Set();
  for (const step of spec.pipeline.steps) {
    exactObject(step, ["id", "actionId", "input"], ["id", "actionId", "input"]);
    if (typeof step.id !== "string" || !STEP_ID.test(step.id) || completed.has(step.id)) fail("PIPELINE_STEP_ID_INVALID");
    if (!ALLOWED_PIPELINE_ACTIONS.includes(step.actionId)) fail("PIPELINE_ACTION_NOT_ALLOWED");
    validateTemplate(step.input, completed);
    completed.add(step.id);
  }
  validateTemplate(spec.pipeline.output, completed);
  if (!validatePluginActionSchema(spec).valid) fail("PLUGIN_ACTION_SCHEMA_INVALID");
  return true;
}

function pointerValue(root, pointer) {
  let current = root;
  for (const raw of pointer.split("/").slice(1)) {
    const segment = decodePointerSegment(raw);
    if ((typeof current !== "object" || current === null) || !Object.hasOwn(current, segment)) fail("PIPELINE_REFERENCE_MISSING");
    current = current[segment];
  }
  return structuredClone(current);
}

function expandTemplate(template, root) {
  const walk = (current) => {
    if (Array.isArray(current)) return current.map(walk);
    if (!isObject(current)) return current;
    if (Object.keys(current).length === 1 && Object.hasOwn(current, "$ref")) return pointerValue(root, current.$ref);
    const result = Object.create(null);
    for (const [key, child] of Object.entries(current)) result[key] = walk(child);
    return result;
  };
  const expanded = walk(template);
  const details = inspectJson(expanded);
  if (details.bytes > PIPELINE_LIMITS.expandedBytes) fail("PIPELINE_EXPANSION_TOO_LARGE");
  return { value: expanded, bytes: details.bytes };
}

export function createPipelineHandler(spec) {
  validatePluginActionSpec(spec);
  const builtinExecutor = new ActionExecutor(new ActionRegistry());
  return async (input, context = {}) => {
    const root = { input: structuredClone(input), steps: Object.create(null) };
    let intermediateBytes = inspectJson(root.input).bytes;
    for (const step of spec.pipeline.steps) {
      if (context.signal?.aborted) throw new ActionExecutionError(ERROR_CODES.CANCELLED);
      const expanded = expandTemplate(step.input, root);
      intermediateBytes += expanded.bytes;
      if (intermediateBytes > PIPELINE_LIMITS.intermediateBytes) fail("PIPELINE_INTERMEDIATE_TOO_LARGE");
      const result = await builtinExecutor.execute(step.actionId, expanded.value, { signal: context.signal });
      root.steps[step.id] = { output: result.output };
      intermediateBytes += inspectJson(result.output).bytes;
      if (intermediateBytes > PIPELINE_LIMITS.intermediateBytes) fail("PIPELINE_INTERMEDIATE_TOO_LARGE");
    }
    return expandTemplate(spec.pipeline.output, root).value;
  };
}

export function derivePluginAction({ actionId, pluginId, pluginVersion, publisherKeyId, spec }) {
  if (isReservedActionName(actionId)) fail("PLUGIN_ACTION_RESERVED_NAME");
  if (Array.isArray(spec?.aliases) && spec.aliases.some(isReservedActionName)) fail("PLUGIN_ACTION_RESERVED_NAME");
  if (!isValidActionId(actionId)
    || typeof pluginId !== "string"
    || pluginId.toLowerCase() === "builtin"
    || pluginId.toLowerCase().startsWith("builtin.")
    || !actionId.startsWith(`${pluginId}.`)) fail("PLUGIN_ACTION_NAMESPACE_INVALID");
  if (typeof publisherKeyId !== "string" || !/^ed25519:[a-f0-9]{64}$/i.test(publisherKeyId)) fail("PUBLISHER_KEY_ID_INVALID");
  validatePluginActionSpec(spec);
  const descriptor = {
    contractVersion: "1.0",
    actionId,
    version: pluginVersion,
    source: {
      kind: "plugin",
      toolId: pluginId,
      publisher: { id: publisherKeyId },
      digest: canonicalActionDigest(spec),
    },
    title: spec.title,
    description: spec.description,
    keywords: structuredClone(spec.keywords),
    aliases: structuredClone(spec.aliases),
    inputSchema: structuredClone(spec.inputSchema),
    outputSchema: structuredClone(spec.outputSchema),
    examples: structuredClone(spec.examples),
    testVectors: structuredClone(spec.testVectors),
    execution: {
      mode: "pure",
      handler: PIPELINE_HANDLER,
      timeoutMs: spec.execution.timeoutMs,
      maxInputBytes: spec.execution.maxInputBytes,
      maxOutputBytes: spec.execution.maxOutputBytes,
      supportsCancellation: true,
    },
    behavior: {
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
      sideEffects: [],
      requiresConfirmation: false,
    },
    permissions: { required: [], capabilities: [] },
    sensitive: { input: [], output: [], redactLogs: true },
    ...(spec.presentation === undefined ? {} : { presentation: structuredClone(spec.presentation) }),
  };
  try { assertActionDescriptor(descriptor); } catch { fail("PLUGIN_DESCRIPTOR_INVALID"); }
  return descriptor;
}

export async function verifyTestVectors(descriptor, handler) {
  const registry = new ActionRegistry([]);
  registry.register({ descriptor, handler });
  const executor = new ActionExecutor(registry);
  for (const vector of descriptor.testVectors) {
    try {
      const result = await executor.execute(descriptor.actionId, vector.input);
      if (!Object.hasOwn(vector, "expectedOutput") || canonical(result.output) !== canonical(vector.expectedOutput)) fail("PLUGIN_TEST_VECTOR_MISMATCH");
    } catch (error) {
      if (error instanceof PluginActionError) throw error;
      if (!Object.hasOwn(vector, "expectedErrorCode") || error?.code !== vector.expectedErrorCode) fail("PLUGIN_TEST_VECTOR_MISMATCH");
    }
  }
}
