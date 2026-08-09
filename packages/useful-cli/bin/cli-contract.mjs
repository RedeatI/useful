import process from "node:process";

export const RESULT_SCHEMA_VERSION = "useful.cli.result.v1";

export const EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  USAGE: 2,
  VALIDATION: 3,
  SECURITY_OR_IO: 4,
  INTERNAL: 5,
});

export class CliError extends Error {
  constructor(code, message, exitCode, details, data) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
    this.data = data;
  }
}

export function usageError(code, message, details) {
  return new CliError(code, message, EXIT_CODES.USAGE, details);
}

export function validationError(code, message, details, data) {
  return new CliError(code, message, EXIT_CODES.VALIDATION, details, data);
}

export function securityError(code, message, details, data) {
  return new CliError(code, message, EXIT_CODES.SECURITY_OR_IO, details, data);
}

function redactText(value) {
  return String(value)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/((?:admin[-_]?token|access[-_]?token|private[-_]?key|token)\s*[=:]\s*)[^\s,;"']+/gi, "$1[REDACTED]");
}

function sanitize(value, key = "") {
  if (/^(?:token|admin-token|admin_token|privateKey|private_key|privatePem|signature)$/i.test(key)) {
    return "[REDACTED]";
  }
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, sanitize(child, childKey)]));
  }
  return value;
}

export function successEnvelope(command, data) {
  return { schemaVersion: RESULT_SCHEMA_VERSION, ok: true, command, data: sanitize(data) };
}

export function failureEnvelope(command, error) {
  const known = error instanceof CliError;
  const envelope = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    ok: false,
    command,
    error: {
      code: known ? error.code : "INTERNAL_ERROR",
      message: redactText(error instanceof Error ? error.message : String(error)),
      details: sanitize(known ? error.details ?? null : null),
    },
  };
  if (known && error.data !== undefined) envelope.data = sanitize(error.data);
  return envelope;
}

export function writeJson(document) {
  process.stdout.write(`${JSON.stringify(document)}\n`);
}

export function exitCodeFor(error) {
  return error instanceof CliError ? error.exitCode : EXIT_CODES.INTERNAL;
}
