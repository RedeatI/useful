import { utf8JsonBytes } from "@useful/action-contract";
import { ActionExecutionError, ERROR_CODES } from "./errors.mjs";

export const ACTION_RECIPE_SCHEMA_VERSION = "useful.action-recipe.v1";
export const ACTION_RECIPE_LIMITS = Object.freeze({
  steps: 16,
  requestBytes: 1048576,
  templateBytes: 262144,
  templateDepth: 32,
  templateNodes: 4096,
  expandedBytes: 1048576,
  intermediateBytes: 8388608,
  timeoutMs: 60000,
});

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const STEP_ID = /^[a-z][a-z0-9_-]{0,31}$/u;
const ACTION_ID = /^[a-z][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)+$/u;
const REFERENCE = /^(?:\/input(?:\/(?:[^~/]|~0|~1)*)*|\/steps\/([a-z][a-z0-9_-]{0,31})\/output(?:\/(?:[^~/]|~0|~1)*)*)$/u;

export class ActionRecipeError extends Error {
  constructor(code) {
    super(code);
    this.name = "ActionRecipeError";
    this.code = code;
  }
}

function fail(code) {
  throw new ActionRecipeError(code);
}

function isObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactObject(value, required, allowed, code = "ACTION_RECIPE_INVALID") {
  if (!isObject(value)) fail(code);
  for (const key of required) if (!Object.hasOwn(value, key)) fail(code);
  for (const key of Object.keys(value)) if (!allowed.includes(key) || FORBIDDEN_KEYS.has(key)) fail(code);
}

function jsonBytes(value, code = "ACTION_RECIPE_INVALID") {
  try {
    return utf8JsonBytes(value);
  } catch {
    fail(code);
  }
}

function decodePointerSegment(segment) {
  const decoded = segment.replace(/~1/gu, "/").replace(/~0/gu, "~");
  if (FORBIDDEN_KEYS.has(decoded)) fail("ACTION_RECIPE_FORBIDDEN_KEY");
  return decoded;
}

function validateReference(pointer, completed) {
  if (typeof pointer !== "string") fail("ACTION_RECIPE_REFERENCE_INVALID");
  const match = REFERENCE.exec(pointer);
  if (!match) fail("ACTION_RECIPE_REFERENCE_INVALID");
  if (match[1] && !completed.has(match[1])) fail("ACTION_RECIPE_FORWARD_REFERENCE");
  for (const segment of pointer.split("/").slice(1)) decodePointerSegment(segment);
}

function hasInterpolation(value) {
  const start = value.indexOf("${");
  return start >= 0 && value.indexOf("}", start + 2) >= 0;
}

function inspectTemplate(template, completed) {
  const seen = new WeakSet();
  let nodes = 0;
  const walk = (current, depth) => {
    nodes += 1;
    if (nodes > ACTION_RECIPE_LIMITS.templateNodes) fail("ACTION_RECIPE_TEMPLATE_TOO_LARGE");
    if (depth > ACTION_RECIPE_LIMITS.templateDepth) fail("ACTION_RECIPE_TEMPLATE_TOO_DEEP");
    if (typeof current === "number" && !Number.isFinite(current)) fail("ACTION_RECIPE_INVALID");
    if (current === null || ["string", "boolean", "number"].includes(typeof current)) {
      if (typeof current === "string" && hasInterpolation(current)) fail("ACTION_RECIPE_INTERPOLATION_FORBIDDEN");
      return;
    }
    if (typeof current !== "object") fail("ACTION_RECIPE_INVALID");
    if (seen.has(current)) fail("ACTION_RECIPE_INVALID");
    seen.add(current);
    if (Array.isArray(current)) {
      for (const child of current) walk(child, depth + 1);
      seen.delete(current);
      return;
    }
    if (!isObject(current)) fail("ACTION_RECIPE_INVALID");
    const keys = Object.keys(current);
    if (keys.length === 1 && Object.hasOwn(current, "$ref")) {
      validateReference(current.$ref, completed);
      seen.delete(current);
      return;
    }
    for (const [key, child] of Object.entries(current)) {
      if (FORBIDDEN_KEYS.has(key)) fail("ACTION_RECIPE_FORBIDDEN_KEY");
      walk(child, depth + 1);
    }
    seen.delete(current);
  };
  walk(template, 0);
  if (jsonBytes(template) > ACTION_RECIPE_LIMITS.templateBytes) fail("ACTION_RECIPE_TEMPLATE_TOO_LARGE");
}

function inspectRecipeInput(input) {
  const seen = new WeakSet();
  let nodes = 0;
  const walk = (current, depth) => {
    nodes += 1;
    if (nodes > ACTION_RECIPE_LIMITS.templateNodes) fail("ACTION_RECIPE_TEMPLATE_TOO_LARGE");
    if (depth > ACTION_RECIPE_LIMITS.templateDepth) fail("ACTION_RECIPE_TEMPLATE_TOO_DEEP");
    if (typeof current === "number" && !Number.isFinite(current)) fail("ACTION_RECIPE_INVALID");
    if (current === null || ["string", "boolean", "number"].includes(typeof current)) return;
    if (typeof current !== "object" || seen.has(current)) fail("ACTION_RECIPE_INVALID");
    seen.add(current);
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) {
        if (!Object.hasOwn(current, index)) fail("ACTION_RECIPE_INVALID");
        walk(current[index], depth + 1);
      }
    } else {
      if (!isObject(current)) fail("ACTION_RECIPE_INVALID");
      for (const [key, child] of Object.entries(current)) {
        if (FORBIDDEN_KEYS.has(key)) fail("ACTION_RECIPE_FORBIDDEN_KEY");
        walk(child, depth + 1);
      }
    }
    seen.delete(current);
  };
  walk(input, 0);
}

function eligible(descriptor) {
  return descriptor.execution.mode !== "ui-only"
    && descriptor.behavior.readOnly === true
    && descriptor.behavior.destructive === false
    && descriptor.behavior.idempotent === true
    && descriptor.behavior.openWorld === false
    && descriptor.behavior.requiresConfirmation === false
    && descriptor.behavior.sideEffects.length === 0
    && descriptor.permissions.required.length === 0
    && descriptor.permissions.capabilities.length === 0;
}

function validateRecipe(recipe, registry) {
  exactObject(recipe, ["schemaVersion", "steps", "output"], ["schemaVersion", "input", "steps", "output"]);
  if (recipe.schemaVersion !== ACTION_RECIPE_SCHEMA_VERSION) fail("ACTION_RECIPE_VERSION_UNSUPPORTED");
  if (jsonBytes(recipe) > ACTION_RECIPE_LIMITS.requestBytes) fail("ACTION_RECIPE_TOO_LARGE");
  if (Object.hasOwn(recipe, "input")) inspectRecipeInput(recipe.input);
  if (!Array.isArray(recipe.steps) || recipe.steps.length < 1 || recipe.steps.length > ACTION_RECIPE_LIMITS.steps) {
    fail("ACTION_RECIPE_STEP_LIMIT");
  }
  if (!registry || typeof registry.describe !== "function" || typeof registry.resolve !== "function") fail("ACTION_RECIPE_RUNTIME_INVALID");

  const completed = new Set();
  const plan = [];
  for (const step of recipe.steps) {
    exactObject(step, ["id", "actionId", "input"], ["id", "actionId", "input"]);
    if (typeof step.id !== "string" || !STEP_ID.test(step.id) || completed.has(step.id)) fail("ACTION_RECIPE_STEP_ID_INVALID");
    if (typeof step.actionId !== "string" || step.actionId.length > 200 || !ACTION_ID.test(step.actionId)) fail("ACTION_RECIPE_ACTION_INVALID");
    const entry = registry.resolve(step.actionId);
    if (!entry) fail("ACTION_RECIPE_UNKNOWN_ACTION");
    if (entry.descriptor.actionId !== step.actionId) fail("ACTION_RECIPE_ALIAS_FORBIDDEN");
    if (!eligible(entry.descriptor)) fail("ACTION_RECIPE_ACTION_NOT_ALLOWED");
    inspectTemplate(step.input, completed);
    completed.add(step.id);
    plan.push(Object.freeze({
      id: step.id,
      actionId: step.actionId,
      actionVersion: entry.descriptor.version,
      executionMode: entry.descriptor.execution.mode,
    }));
  }
  inspectTemplate(recipe.output, completed);
  return Object.freeze(plan);
}

function pointerValue(root, pointer) {
  let current = root;
  for (const raw of pointer.split("/").slice(1)) {
    const segment = decodePointerSegment(raw);
    if ((typeof current !== "object" || current === null) || !Object.hasOwn(current, segment)) {
      fail("ACTION_RECIPE_REFERENCE_MISSING");
    }
    current = current[segment];
  }
  return structuredClone(current);
}

function expandTemplate(template, root) {
  const walk = (current) => {
    if (Array.isArray(current)) return current.map(walk);
    if (!isObject(current)) return current;
    if (Object.keys(current).length === 1 && Object.hasOwn(current, "$ref")) return pointerValue(root, current.$ref);
    const result = {};
    for (const [key, child] of Object.entries(current)) result[key] = walk(child);
    return result;
  };
  const expanded = walk(template);
  if (jsonBytes(expanded) > ACTION_RECIPE_LIMITS.expandedBytes) fail("ACTION_RECIPE_EXPANSION_TOO_LARGE");
  return expanded;
}

export function validateActionRecipe(recipe, registry) {
  const plan = validateRecipe(recipe, registry);
  return {
    schemaVersion: ACTION_RECIPE_SCHEMA_VERSION,
    valid: true,
    steps: plan.map((step) => ({ ...step })),
  };
}

export async function runActionRecipe(recipe, { registry, executor, signal } = {}) {
  const plan = validateRecipe(recipe, registry);
  if (!executor || typeof executor.execute !== "function") fail("ACTION_RECIPE_RUNTIME_INVALID");
  if (signal !== undefined && (signal === null || typeof signal !== "object" || typeof signal.addEventListener !== "function" || typeof signal.aborted !== "boolean")) {
    fail("ACTION_RECIPE_RUNTIME_INVALID");
  }

  const root = {
    input: structuredClone(recipe.input ?? Object.create(null)),
    steps: Object.create(null),
  };
  let intermediateBytes = jsonBytes(root.input);
  const receipts = [];
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new ActionExecutionError(ERROR_CODES.TIMEOUT));
  }, ACTION_RECIPE_LIMITS.timeoutMs);
  try {
    for (const step of recipe.steps) {
      if (controller.signal.aborted) throw new ActionExecutionError(timedOut ? ERROR_CODES.TIMEOUT : ERROR_CODES.CANCELLED);
      const input = expandTemplate(step.input, root);
      intermediateBytes += jsonBytes(input);
      if (intermediateBytes > ACTION_RECIPE_LIMITS.intermediateBytes) fail("ACTION_RECIPE_INTERMEDIATE_TOO_LARGE");
      let result;
      try {
        result = await executor.execute(step.actionId, input, { signal: controller.signal });
      } catch (error) {
        if (timedOut) throw new ActionExecutionError(ERROR_CODES.TIMEOUT);
        throw error;
      }
      root.steps[step.id] = { output: result.output };
      intermediateBytes += jsonBytes(result.output);
      if (intermediateBytes > ACTION_RECIPE_LIMITS.intermediateBytes) fail("ACTION_RECIPE_INTERMEDIATE_TOO_LARGE");
      receipts.push({ id: step.id, actionId: step.actionId, receipt: result.receipt });
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  const output = expandTemplate(recipe.output, root);
  intermediateBytes += jsonBytes(output);
  if (intermediateBytes > ACTION_RECIPE_LIMITS.intermediateBytes) fail("ACTION_RECIPE_INTERMEDIATE_TOO_LARGE");
  return {
    schemaVersion: ACTION_RECIPE_SCHEMA_VERSION,
    output,
    steps: plan.map((step, index) => ({ ...step, receipt: receipts[index].receipt })),
  };
}
