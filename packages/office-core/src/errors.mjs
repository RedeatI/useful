export class OfficeCoreError extends Error {
  constructor(code, message = code, details = undefined) {
    super(message);
    this.name = "OfficeCoreError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function fail(code, message = code, details) {
  throw new OfficeCoreError(code, message, details);
}

export function assert(condition, code, message, details) {
  if (!condition) fail(code, message, details);
}

export function exactObject(value, allowed, code = "INPUT_INVALID") {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), code, "Expected an object");
  for (const key of Object.keys(value)) {
    assert(allowed.includes(key), code, `Unknown field: ${key}`);
  }
  return value;
}

export function asBytes(value, code = "INPUT_INVALID") {
  assert(value instanceof Uint8Array, code, "Expected Uint8Array");
  return value;
}
