import { validateValue } from "@useful/action-contract";
import { validateProfileSchema } from "./schema-validate.mjs";

export { validateProfileSchema };

export const PROFILE_SCHEMA_VERSION = "useful.agent-profile.v1";
export const PROFILE_LIMITS = Object.freeze({
  bytes: 256 * 1024,
  actions: 128,
  aliasesPerAction: 16,
  aliasesTotal: 256,
  presetsPerAction: 32,
  presetsTotal: 256,
  defaultsBytes: 32 * 1024,
  depth: 16,
  nodes: 4096,
});

export const PROFILE_ERROR_CODES = Object.freeze({
  INVALID: "AGENT_PROFILE_INVALID",
  TOO_LARGE: "AGENT_PROFILE_TOO_LARGE",
  UNKNOWN_ACTION: "AGENT_PROFILE_UNKNOWN_ACTION",
  PIN_MISMATCH: "AGENT_PROFILE_PIN_MISMATCH",
  COLLISION: "AGENT_PROFILE_COLLISION",
  SURFACE_DISABLED: "AGENT_PROFILE_SURFACE_DISABLED",
  PRESET_UNKNOWN: "AGENT_PROFILE_PRESET_UNKNOWN",
  PRESET_INVALID: "AGENT_PROFILE_PRESET_INVALID",
});

const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const FORBIDDEN_DEFAULT_KEYS = new Set([
  "command", "rawcommand", "flags", "argv", "env", "path", "pathtemplate",
  "cwd", "workingdirectory", "entry", "args", "target",
]);
const EXPRESSION_MARKERS = ["${", "{{", "}}", "$(", "<%", "%>"];
const encoder = new TextEncoder();

export class AgentProfileError extends Error {
  constructor(code, issues = []) {
    super(code);
    this.name = "AgentProfileError";
    this.code = code;
    this.issues = issues.map(({ path, code: issueCode }) => ({ path, code: issueCode }));
  }
}

function fail(code, path = "", issueCode = code) {
  throw new AgentProfileError(code, [{ path, code: issueCode }]);
}

function utf8Bytes(value) {
  try {
    return encoder.encode(typeof value === "string" ? value : JSON.stringify(value)).byteLength;
  } catch {
    fail(PROFILE_ERROR_CODES.INVALID, "", "NOT_JSON");
  }
}

function inspectTree(value, path = "", depth = 0, state = { nodes: 0 }) {
  state.nodes += 1;
  if (depth > PROFILE_LIMITS.depth) fail(PROFILE_ERROR_CODES.INVALID, path, "DEPTH_LIMIT");
  if (state.nodes > PROFILE_LIMITS.nodes) fail(PROFILE_ERROR_CODES.INVALID, path, "NODE_LIMIT");
  if (typeof value === "string" && EXPRESSION_MARKERS.some((marker) => value.includes(marker))) {
    fail(PROFILE_ERROR_CODES.INVALID, path, "EXPRESSION_FORBIDDEN");
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
    if (DANGEROUS_KEYS.has(key)) fail(PROFILE_ERROR_CODES.INVALID, childPath, "DANGEROUS_KEY");
    inspectTree(child, childPath, depth + 1, state);
  }
}

function schemaIssues() {
  return (validateProfileSchema.errors ?? []).map((entry) => ({
    path: entry.instancePath || "",
    code: `SCHEMA_${String(entry.keyword).toUpperCase()}`,
  }));
}

function sensitiveTopLevelKeys(descriptor) {
  const result = new Set();
  for (const pointer of descriptor.sensitive.input) {
    if (pointer === "") return null;
    const first = pointer.split("/")[1];
    if (first !== undefined) result.add(first.replaceAll("~1", "/").replaceAll("~0", "~"));
  }
  return result;
}

function validatePreset(action, preset, descriptor) {
  if (utf8Bytes(preset.defaults) > PROFILE_LIMITS.defaultsBytes) {
    fail(PROFILE_ERROR_CODES.PRESET_INVALID, `/actions/${action.actionId}/presets/${preset.presetId}`, "DEFAULTS_TOO_LARGE");
  }
  const properties = descriptor.inputSchema?.properties;
  if (!properties || descriptor.inputSchema.type !== "object" || descriptor.inputSchema.additionalProperties !== false) {
    fail(PROFILE_ERROR_CODES.PRESET_INVALID, `/actions/${action.actionId}/presets/${preset.presetId}`, "INPUT_SCHEMA_UNSUPPORTED");
  }
  const sensitive = sensitiveTopLevelKeys(descriptor);
  for (const [key, value] of Object.entries(preset.defaults)) {
    const path = `/actions/${action.actionId}/presets/${preset.presetId}/defaults/${key}`;
    if (!Object.hasOwn(properties, key)) fail(PROFILE_ERROR_CODES.PRESET_INVALID, path, "DEFAULT_UNKNOWN_FIELD");
    const normalizedKey = key.toLowerCase().replaceAll(/[_\-.]/g, "");
    if (FORBIDDEN_DEFAULT_KEYS.has(normalizedKey)) fail(PROFILE_ERROR_CODES.PRESET_INVALID, path, "DEFAULT_FORBIDDEN_FIELD");
    if (sensitive === null || sensitive.has(key)) fail(PROFILE_ERROR_CODES.PRESET_INVALID, path, "DEFAULT_SENSITIVE_FIELD");
    if (validateValue(properties[key], value).length) fail(PROFILE_ERROR_CODES.PRESET_INVALID, path, "DEFAULT_VALUE_INVALID");
  }
}

export function assertProfileDocument(profile) {
  if (utf8Bytes(profile) > PROFILE_LIMITS.bytes) fail(PROFILE_ERROR_CODES.TOO_LARGE);
  inspectTree(profile);
  if (!validateProfileSchema(profile)) throw new AgentProfileError(PROFILE_ERROR_CODES.INVALID, schemaIssues());

  const actionIds = new Set();
  const aliases = new Set();
  let aliasCount = 0;
  let presetCount = 0;
  for (const [actionIndex, action] of profile.actions.entries()) {
    if (actionIds.has(action.actionId)) fail(PROFILE_ERROR_CODES.COLLISION, `/actions/${actionIndex}/actionId`, "ACTION_DUPLICATE");
    actionIds.add(action.actionId);
    const presetIds = new Set();
    for (const [aliasIndex, alias] of action.aliases.entries()) {
      aliasCount += 1;
      if (aliases.has(alias) || actionIds.has(alias)) fail(PROFILE_ERROR_CODES.COLLISION, `/actions/${actionIndex}/aliases/${aliasIndex}`, "ALIAS_COLLISION");
      aliases.add(alias);
    }
    for (const [presetIndex, preset] of action.presets.entries()) {
      presetCount += 1;
      if (presetIds.has(preset.presetId)) fail(PROFILE_ERROR_CODES.COLLISION, `/actions/${actionIndex}/presets/${presetIndex}/presetId`, "PRESET_DUPLICATE");
      presetIds.add(preset.presetId);
    }
  }
  for (const alias of aliases) if (actionIds.has(alias)) fail(PROFILE_ERROR_CODES.COLLISION, "", "ALIAS_ACTION_COLLISION");
  if (aliasCount > PROFILE_LIMITS.aliasesTotal) fail(PROFILE_ERROR_CODES.INVALID, "/actions", "ALIAS_TOTAL_LIMIT");
  if (presetCount > PROFILE_LIMITS.presetsTotal) fail(PROFILE_ERROR_CODES.INVALID, "/actions", "PRESET_TOTAL_LIMIT");
  return profile;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const result = Object.create(null);
    for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]);
    return result;
  }
  return value;
}

export function canonicalProfileJson(profile) {
  assertProfileDocument(profile);
  return `${JSON.stringify(canonicalize(profile), null, 2)}\n`;
}

export function validateProfileAgainstRegistry(profile, registry) {
  assertProfileDocument(profile);
  const allRegistryNames = new Set();
  for (const descriptor of registry.list()) {
    allRegistryNames.add(descriptor.actionId);
    for (const alias of descriptor.aliases) allRegistryNames.add(alias);
  }
  const actions = new Map();
  const aliases = new Map();
  for (const action of profile.actions) {
    const resolved = registry.resolve(action.actionId);
    if (!resolved || resolved.descriptor.actionId !== action.actionId) {
      fail(PROFILE_ERROR_CODES.UNKNOWN_ACTION, `/actions/${action.actionId}`, "UNKNOWN_ACTION");
    }
    const descriptor = resolved.descriptor;
    if (
      descriptor.contractVersion !== action.expectedContractVersion ||
      descriptor.version !== action.expectedActionVersion ||
      descriptor.source.kind !== action.expectedSourceKind ||
      descriptor.source.publisher.id !== action.expectedPublisherId
    ) {
      fail(PROFILE_ERROR_CODES.PIN_MISMATCH, `/actions/${action.actionId}`, "IDENTITY_PIN_MISMATCH");
    }
    const presets = new Map();
    for (const preset of action.presets) {
      validatePreset(action, preset, descriptor);
      presets.set(preset.presetId, structuredClone(preset));
    }
    for (const alias of action.aliases) {
      if (allRegistryNames.has(alias) || aliases.has(alias)) fail(PROFILE_ERROR_CODES.COLLISION, `/actions/${action.actionId}/aliases`, "ALIAS_REGISTRY_COLLISION");
      aliases.set(alias, action.actionId);
    }
    actions.set(action.actionId, { config: structuredClone(action), descriptor: structuredClone(descriptor), presets });
  }
  return new AgentExposure(profile, registry, actions, aliases);
}

export class AgentExposure {
  constructor(profile, registry, actions, aliases) {
    this.profile = structuredClone(profile);
    this.registry = registry;
    this.actions = actions;
    this.aliases = aliases;
  }

  list(surface) {
    return [...this.actions.values()]
      .filter((entry) => entry.config.enabled[surface] === true)
      .map((entry) => ({
        ...structuredClone(entry.descriptor),
        aliases: surface === "cli" ? [...entry.config.aliases] : [],
      }));
  }

  resolve(name, surface) {
    const canonical = this.actions.has(name) ? name : surface === "cli" ? this.aliases.get(name) : undefined;
    const entry = canonical ? this.actions.get(canonical) : undefined;
    if (!entry || entry.config.enabled[surface] !== true) fail(PROFILE_ERROR_CODES.SURFACE_DISABLED, "", "ACTION_NOT_EXPOSED");
    return { actionId: canonical, entry: this.registry.resolve(canonical), config: entry.config };
  }

  describe(name, surface) {
    const { actionId } = this.resolve(name, surface);
    return this.list(surface).find((descriptor) => descriptor.actionId === actionId);
  }

  applyPreset(actionId, presetId, input) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) fail(PROFILE_ERROR_CODES.PRESET_INVALID, "", "INPUT_MUST_BE_OBJECT");
    if (presetId === undefined) return structuredClone(input);
    const configured = this.actions.get(actionId);
    const preset = configured?.presets.get(presetId);
    if (!preset) fail(PROFILE_ERROR_CODES.PRESET_UNKNOWN);
    return { ...structuredClone(preset.defaults), ...structuredClone(input) };
  }

  asRegistry(surface) {
    const exposure = this;
    return {
      list: () => exposure.list(surface),
      listAgentEligible: () => exposure.list(surface).filter((descriptor) => descriptor.execution.mode !== "ui-only"),
      describe(name) {
        try { return exposure.describe(name, surface); } catch { return undefined; }
      },
      resolve(name) {
        try { return exposure.resolve(name, surface).entry; } catch { return undefined; }
      },
    };
  }
}

export function createDefaultBuiltinProfile(descriptors, name = "默认 Agent 配置") {
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    profileId: "default",
    name,
    actions: descriptors.map((descriptor) => ({
      actionId: descriptor.actionId,
      expectedContractVersion: descriptor.contractVersion,
      expectedActionVersion: descriptor.version,
      expectedSourceKind: descriptor.source.kind,
      expectedPublisherId: descriptor.source.publisher.id,
      enabled: { cli: true, mcp: true },
      aliases: [],
      presets: [],
    })),
  };
}
