/**
 * Fixed-schema validator for useful.agent-profile.v1.
 * Avoids shipping Ajv into the browser Agent panel chunk; schema is stable and owned by this package.
 * Keep in lockstep with useful.agent-profile.v1.schema.json.
 */

const STABLE_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const ACTION_ID = /^[a-z][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)+$/;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const ALIAS = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SOURCE_KINDS = new Set(["builtin", "plugin", "local"]);

/**
 * @typedef {{ instancePath: string, keyword: string, message?: string }} SchemaError
 */

/** @type {SchemaError[] | null} */
let lastErrors = null;

function fail(errors, instancePath, keyword, message) {
  errors.push({ instancePath, keyword, message });
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringInRange(value, min, max) {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

function validateStableId(value, path, errors) {
  if (!stringInRange(value, 1, 64) || !STABLE_ID.test(value)) {
    fail(errors, path, "pattern", "stableId invalid");
  }
}

function validateActionId(value, path, errors) {
  if (!stringInRange(value, 3, 200) || !ACTION_ID.test(value)) {
    fail(errors, path, "pattern", "actionId invalid");
  }
}

function validateAlias(value, path, errors) {
  if (!stringInRange(value, 2, 64) || !ALIAS.test(value)) {
    fail(errors, path, "pattern", "alias invalid");
  }
}

function validateSemver(value, path, errors) {
  if (!stringInRange(value, 1, 80) || !SEMVER.test(value)) {
    fail(errors, path, "pattern", "semver invalid");
  }
}

function rejectUnknownKeys(value, allowed, path, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail(errors, `${path}/${key}`, "additionalProperties", "unknown key");
    }
  }
}

function requireKeys(value, required, path, errors) {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      fail(errors, `${path}/${key}`, "required", "missing required key");
    }
  }
}

function validateEnabled(value, path, errors) {
  if (!isObject(value)) {
    fail(errors, path, "type", "enabled must be object");
    return;
  }
  requireKeys(value, ["cli", "mcp"], path, errors);
  rejectUnknownKeys(value, new Set(["cli", "mcp"]), path, errors);
  if (Object.hasOwn(value, "cli") && typeof value.cli !== "boolean") {
    fail(errors, `${path}/cli`, "type", "cli must be boolean");
  }
  if (Object.hasOwn(value, "mcp") && typeof value.mcp !== "boolean") {
    fail(errors, `${path}/mcp`, "type", "mcp must be boolean");
  }
}

function validatePreset(value, path, errors) {
  if (!isObject(value)) {
    fail(errors, path, "type", "preset must be object");
    return;
  }
  requireKeys(value, ["presetId", "name", "defaults"], path, errors);
  rejectUnknownKeys(value, new Set(["presetId", "name", "defaults"]), path, errors);
  if (Object.hasOwn(value, "presetId")) validateStableId(value.presetId, `${path}/presetId`, errors);
  if (Object.hasOwn(value, "name") && !stringInRange(value.name, 1, 120)) {
    fail(errors, `${path}/name`, "type", "name length invalid");
  }
  if (Object.hasOwn(value, "defaults")) {
    if (!isObject(value.defaults)) {
      fail(errors, `${path}/defaults`, "type", "defaults must be object");
    } else if (Object.keys(value.defaults).length > 64) {
      fail(errors, `${path}/defaults`, "maxProperties", "defaults has too many properties");
    }
  }
}

function validateAction(value, path, errors) {
  if (!isObject(value)) {
    fail(errors, path, "type", "action must be object");
    return;
  }
  requireKeys(
    value,
    [
      "actionId",
      "expectedContractVersion",
      "expectedActionVersion",
      "expectedSourceKind",
      "expectedPublisherId",
      "enabled",
      "aliases",
      "presets",
    ],
    path,
    errors,
  );
  rejectUnknownKeys(
    value,
    new Set([
      "actionId",
      "expectedContractVersion",
      "expectedActionVersion",
      "expectedSourceKind",
      "expectedPublisherId",
      "enabled",
      "aliases",
      "presets",
    ]),
    path,
    errors,
  );
  if (Object.hasOwn(value, "actionId")) validateActionId(value.actionId, `${path}/actionId`, errors);
  if (Object.hasOwn(value, "expectedContractVersion") && value.expectedContractVersion !== "1.0") {
    fail(errors, `${path}/expectedContractVersion`, "const", "must be 1.0");
  }
  if (Object.hasOwn(value, "expectedActionVersion")) {
    validateSemver(value.expectedActionVersion, `${path}/expectedActionVersion`, errors);
  }
  if (Object.hasOwn(value, "expectedSourceKind") && !SOURCE_KINDS.has(value.expectedSourceKind)) {
    fail(errors, `${path}/expectedSourceKind`, "enum", "invalid source kind");
  }
  if (Object.hasOwn(value, "expectedPublisherId") && !stringInRange(value.expectedPublisherId, 1, 256)) {
    fail(errors, `${path}/expectedPublisherId`, "type", "publisher id invalid");
  }
  if (Object.hasOwn(value, "enabled")) validateEnabled(value.enabled, `${path}/enabled`, errors);
  if (Object.hasOwn(value, "aliases")) {
    if (!Array.isArray(value.aliases)) {
      fail(errors, `${path}/aliases`, "type", "aliases must be array");
    } else {
      if (value.aliases.length > 16) fail(errors, `${path}/aliases`, "maxItems", "too many aliases");
      const seen = new Set();
      value.aliases.forEach((alias, index) => {
        validateAlias(alias, `${path}/aliases/${index}`, errors);
        if (typeof alias === "string") {
          if (seen.has(alias)) fail(errors, `${path}/aliases/${index}`, "uniqueItems", "duplicate alias");
          seen.add(alias);
        }
      });
    }
  }
  if (Object.hasOwn(value, "presets")) {
    if (!Array.isArray(value.presets)) {
      fail(errors, `${path}/presets`, "type", "presets must be array");
    } else {
      if (value.presets.length > 32) fail(errors, `${path}/presets`, "maxItems", "too many presets");
      value.presets.forEach((preset, index) => validatePreset(preset, `${path}/presets/${index}`, errors));
    }
  }
}

/**
 * Ajv-compatible shape: returns boolean, exposes `.errors` after each call.
 * @param {unknown} profile
 * @returns {boolean}
 */
export function validateProfileSchema(profile) {
  /** @type {SchemaError[]} */
  const errors = [];
  if (!isObject(profile)) {
    fail(errors, "", "type", "profile must be object");
    lastErrors = errors;
    validateProfileSchema.errors = errors;
    return false;
  }
  requireKeys(profile, ["schemaVersion", "profileId", "name", "actions"], "", errors);
  rejectUnknownKeys(profile, new Set(["schemaVersion", "profileId", "name", "actions"]), "", errors);
  if (Object.hasOwn(profile, "schemaVersion") && profile.schemaVersion !== "useful.agent-profile.v1") {
    fail(errors, "/schemaVersion", "const", "schemaVersion must be useful.agent-profile.v1");
  }
  if (Object.hasOwn(profile, "profileId")) validateStableId(profile.profileId, "/profileId", errors);
  if (Object.hasOwn(profile, "name") && !stringInRange(profile.name, 1, 120)) {
    fail(errors, "/name", "type", "name length invalid");
  }
  if (Object.hasOwn(profile, "actions")) {
    if (!Array.isArray(profile.actions)) {
      fail(errors, "/actions", "type", "actions must be array");
    } else {
      if (profile.actions.length > 128) fail(errors, "/actions", "maxItems", "too many actions");
      profile.actions.forEach((action, index) => validateAction(action, `/actions/${index}`, errors));
    }
  }
  lastErrors = errors.length ? errors : null;
  validateProfileSchema.errors = lastErrors;
  return errors.length === 0;
}

validateProfileSchema.errors = null;
