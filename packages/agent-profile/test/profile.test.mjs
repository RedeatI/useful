import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ActionExecutor, ActionRegistry, BASE64_DESCRIPTOR } from "@useful/action-runtime";
import {
  AgentProfileError,
  PROFILE_ERROR_CODES,
  assertProfileDocument,
  canonicalProfileJson,
  validateProfileAgainstRegistry,
  validateProfileSchema,
} from "../src/browser.mjs";

const fixture = async (kind, name) => JSON.parse(await readFile(new URL(`fixtures/${kind}/${name}.json`, import.meta.url), "utf8"));

function materialize(base, mutation) {
  const profile = structuredClone(base);
  const addActions = (count, configure = () => {}) => {
    profile.actions = Array.from({ length: count }, (_, actionIndex) => {
      const action = structuredClone(base.actions[0]);
      action.actionId = `test.action.x${actionIndex}`;
      action.aliases = [];
      action.presets = [];
      configure(action, actionIndex);
      return action;
    });
  };
  switch (mutation) {
    case "none": break;
    case "unknown-top-key": profile.command = "forbidden"; break;
    case "dangerous-key": Object.defineProperty(profile.actions[0].presets[0].defaults, "__proto__", { value: {}, enumerable: true }); break;
    case "dangerous-constructor": profile.actions[0].presets[0].defaults.constructor = {}; break;
    case "dangerous-prototype": profile.actions[0].presets[0].defaults.prototype = {}; break;
    case "expression": profile.name = "${HOME}"; break;
    case "duplicate-action": profile.actions.push(structuredClone(profile.actions[0])); break;
    case "global-alias-collision": {
      const second = structuredClone(profile.actions[0]);
      second.actionId = "builtin.utilities.hash";
      profile.actions.push(second);
      break;
    }
    case "registry-alias-collision": profile.actions[0].aliases = ["b64"]; break;
    case "action-count-limit": addActions(129); break;
    case "alias-item-limit": profile.actions[0].aliases = Array.from({ length: 17 }, (_, index) => `alias-${index}`); break;
    case "preset-item-limit": profile.actions[0].presets = Array.from({ length: 33 }, (_, index) => ({ presetId: `preset-${index}`, name: `preset ${index}`, defaults: {} })); break;
    case "alias-total-limit": addActions(17, (action, actionIndex) => {
      action.aliases = Array.from({ length: 16 }, (_, aliasIndex) => `alias-${actionIndex}-${aliasIndex}`);
    }); break;
    case "preset-total-limit": addActions(9, (action) => {
      action.presets = Array.from({ length: 32 }, (_, index) => ({ presetId: `preset-${index}`, name: `preset ${index}`, defaults: {} }));
    }); break;
    case "depth-limit": {
      let cursor = profile.actions[0].presets[0].defaults;
      for (let index = 0; index < 20; index += 1) cursor = cursor.value = {};
      break;
    }
    case "node-limit": profile.actions[0].presets[0].defaults.value = Array.from({ length: 4100 }, (_, index) => index); break;
    case "byte-limit": profile.actions[0].presets[0].defaults.value = "x".repeat(270000); break;
    case "defaults-byte-limit": profile.actions[0].presets[0].defaults.value = "x".repeat(33000); break;
    case "preset-unknown": profile.actions[0].presets[0].defaults.flags = "--unsafe"; break;
    case "preset-wrong-type": profile.actions[0].presets[0].defaults.operation = 7; break;
    case "preset-sensitive": profile.actions[0].presets[0].defaults.text = "TOP_SECRET"; break;
    default: throw new Error(`unknown vector mutation: ${mutation}`);
  }
  return profile;
}

test("fixed schema validator accepts shared fixtures (Ajv-free browser path)", async () => {
  const schema = JSON.parse(await readFile(new URL("../src/useful.agent-profile.v1.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.title, "Useful Agent Profile v1");
  const valid = await fixture("valid", "default");
  const invalid = await fixture("invalid", "unknown-key");
  assert.equal(validateProfileSchema(valid), true);
  assert.equal(validateProfileSchema(invalid), false);
  assertProfileDocument(valid);
  assert.throws(() => assertProfileDocument(invalid), (error) => error.code === PROFILE_ERROR_CODES.INVALID);
});

test("hand-written schema validator agrees with Ajv on shared vector matrix", async () => {
  const Ajv2020 = (await import("ajv/dist/2020.js")).default;
  const schema = JSON.parse(await readFile(new URL("../src/useful.agent-profile.v1.schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: true, unicodeRegExp: true });
  const ajvValidate = ajv.compile(schema);
  const matrix = JSON.parse(await readFile(new URL("../test-vectors/profile-vectors.json", import.meta.url), "utf8"));
  for (const vector of matrix.vectors) {
    const profile = materialize(matrix.baseProfile, vector.mutation);
    const hand = validateProfileSchema(profile);
    const viaAjv = ajvValidate(profile);
    assert.equal(hand, viaAjv, `${vector.name}: hand=${hand} ajv=${viaAjv}`);
    assert.equal(hand, vector.schemaValid, `${vector.name}: expected schemaValid=${vector.schemaValid}`);
  }
});

test("shared vector matrix proves Ajv shape and semantic safety layers independently", async () => {
  const matrix = JSON.parse(await readFile(new URL("../test-vectors/profile-vectors.json", import.meta.url), "utf8"));
  const registry = new ActionRegistry();
  for (const vector of matrix.vectors) {
    const profile = materialize(matrix.baseProfile, vector.mutation);
    assert.equal(validateProfileSchema(profile), vector.schemaValid, `${vector.name}: schema layer`);
    if (vector.semantic === "valid") {
      assert.doesNotThrow(() => validateProfileAgainstRegistry(profile, registry), vector.name);
      continue;
    }
    assert.throws(() => validateProfileAgainstRegistry(profile, registry), (error) => {
      assert.equal(error.code, vector.semantic, `${vector.name}: semantic code`);
      if (vector.issue) assert.ok(error.issues.some((entry) => entry.code === vector.issue), `${vector.name}: semantic issue`);
      assert.doesNotMatch(JSON.stringify(error), /TOP_SECRET|--unsafe|HOME/);
      return true;
    });
  }
});

test("registry pins, controlled aliases and partial defaults fail closed", async () => {
  const profile = await fixture("valid", "default");
  const registry = new ActionRegistry();
  const exposure = validateProfileAgainstRegistry(profile, registry);
  assert.deepEqual(exposure.list("cli").map((item) => item.actionId), ["builtin.utilities.base64"]);
  assert.equal(exposure.resolve("b64-encode", "cli").actionId, "builtin.utilities.base64");
  assert.throws(() => exposure.resolve("b64-encode", "mcp"), (error) => error.code === PROFILE_ERROR_CODES.SURFACE_DISABLED);
  assert.deepEqual(exposure.applyPreset("builtin.utilities.base64", "encode", { text: "Useful 工具" }), { operation: "encode", text: "Useful 工具" });
  const result = await new ActionExecutor(registry).execute(
    "builtin.utilities.base64",
    exposure.applyPreset("builtin.utilities.base64", "encode", { text: "Useful 工具" }),
  );
  assert.equal(result.output.text, "VXNlZnVsIOW3peWFtw==");

  const stale = structuredClone(profile);
  stale.actions[0].expectedActionVersion = "9.0.0";
  assert.throws(() => validateProfileAgainstRegistry(stale, registry), (error) => error.code === PROFILE_ERROR_CODES.PIN_MISMATCH);
  const unknown = structuredClone(profile);
  unknown.actions[0].actionId = "builtin.utilities.unknown";
  assert.throws(() => validateProfileAgainstRegistry(unknown, registry), (error) => error.code === PROFILE_ERROR_CODES.UNKNOWN_ACTION);
});

test("surface listings preserve the explicit profile order", () => {
  const registry = new ActionRegistry();
  const descriptors = registry.list().slice(0, 3).reverse();
  const profile = {
    schemaVersion: "useful.agent-profile.v1",
    profileId: "ordered",
    name: "Ordered profile",
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
  const exposure = validateProfileAgainstRegistry(profile, registry);
  assert.deepEqual(
    exposure.list("cli").map((descriptor) => descriptor.actionId),
    descriptors.map((descriptor) => descriptor.actionId),
  );
  assert.deepEqual(
    exposure.list("mcp").map((descriptor) => descriptor.actionId),
    descriptors.map((descriptor) => descriptor.actionId),
  );
});

test("preset values are property-valid but may omit required text; sensitive fields never persist", async () => {
  const base = await fixture("valid", "default");
  const registry = new ActionRegistry();
  validateProfileAgainstRegistry(base, registry);
  const wrongType = structuredClone(base);
  wrongType.actions[0].presets[0].defaults.operation = 7;
  assert.throws(() => validateProfileAgainstRegistry(wrongType, registry), (error) => error.code === PROFILE_ERROR_CODES.PRESET_INVALID);
  const unknown = structuredClone(base);
  unknown.actions[0].presets[0].defaults.flags = "--unsafe";
  assert.throws(() => validateProfileAgainstRegistry(unknown, registry), (error) => error.code === PROFILE_ERROR_CODES.PRESET_INVALID);
  const rawFieldDescriptor = structuredClone(BASE64_DESCRIPTOR);
  rawFieldDescriptor.actionId = "test.raw.path";
  rawFieldDescriptor.aliases = [];
  rawFieldDescriptor.source.kind = "local";
  rawFieldDescriptor.source.toolId = "test.raw";
  rawFieldDescriptor.inputSchema.properties.path = { type: "string" };
  const rawRegistry = new ActionRegistry([{ descriptor: rawFieldDescriptor, handler: async () => ({ text: "" }) }]);
  const rawProfile = createProfileForDescriptor(rawFieldDescriptor, { path: "C:/unsafe-template" });
  assert.throws(() => validateProfileAgainstRegistry(rawProfile, rawRegistry), (error) => {
    assert.equal(error.code, PROFILE_ERROR_CODES.PRESET_INVALID);
    assert.equal(error.issues[0].code, "DEFAULT_FORBIDDEN_FIELD");
    assert.doesNotMatch(JSON.stringify(error), /unsafe-template/);
    return true;
  });
  const secret = structuredClone(base);
  secret.actions[0].presets[0].defaults.text = "TOP_SECRET";
  assert.throws(() => validateProfileAgainstRegistry(secret, registry), (error) => {
    assert.equal(error.code, PROFILE_ERROR_CODES.PRESET_INVALID);
    assert.doesNotMatch(JSON.stringify(error), /TOP_SECRET/);
    return true;
  });
});

function createProfileForDescriptor(descriptor, defaults) {
  return {
    schemaVersion: "useful.agent-profile.v1",
    profileId: "descriptor-test",
    name: "descriptor test",
    actions: [{
      actionId: descriptor.actionId,
      expectedContractVersion: descriptor.contractVersion,
      expectedActionVersion: descriptor.version,
      expectedSourceKind: descriptor.source.kind,
      expectedPublisherId: descriptor.source.publisher.id,
      enabled: { cli: true, mcp: true },
      aliases: [],
      presets: [{ presetId: "blocked", name: "blocked", defaults }],
    }],
  };
}

test("duplicate/collision, dangerous keys, expressions, depth, nodes and bytes are bounded", async () => {
  const base = await fixture("valid", "default");
  const duplicate = structuredClone(base);
  duplicate.actions.push(structuredClone(duplicate.actions[0]));
  assert.throws(() => assertProfileDocument(duplicate), AgentProfileError);
  const aliasCollision = structuredClone(base);
  aliasCollision.actions[0].aliases = ["b64-encode", "b64-encode"];
  assert.throws(() => assertProfileDocument(aliasCollision), AgentProfileError);
  const expression = structuredClone(base);
  expression.name = "${HOME}";
  assert.throws(() => assertProfileDocument(expression), AgentProfileError);
  const dangerous = JSON.parse('{"schemaVersion":"useful.agent-profile.v1","profileId":"default","name":"x","actions":[],"__proto__":{}}');
  assert.throws(() => assertProfileDocument(dangerous), AgentProfileError);
  const deep = structuredClone(base);
  let cursor = deep.actions[0].presets[0].defaults;
  for (let index = 0; index < 20; index += 1) cursor = cursor.value = {};
  assert.throws(() => assertProfileDocument(deep), AgentProfileError);
  const many = structuredClone(base);
  many.actions[0].presets[0].defaults = Object.fromEntries(Array.from({ length: 4100 }, (_, index) => [`x${index}`, index]));
  assert.throws(() => assertProfileDocument(many), AgentProfileError);
  const large = structuredClone(base);
  large.name = "x".repeat(300000);
  assert.throws(() => assertProfileDocument(large), (error) => error.code === PROFILE_ERROR_CODES.TOO_LARGE);
});

test("canonical export is deterministic and excludes runtime input", async () => {
  const profile = await fixture("valid", "default");
  const first = canonicalProfileJson(profile);
  const second = canonicalProfileJson(JSON.parse(first));
  assert.equal(first, second);
  assert.doesNotMatch(first, /request|token|TOP_SECRET/);
});

function descriptorWithSensitive(actionId, propertyName, propertySchema, sensitivePointer) {
  const descriptor = structuredClone(BASE64_DESCRIPTOR);
  descriptor.actionId = actionId;
  descriptor.aliases = [];
  descriptor.source.kind = "local";
  descriptor.source.toolId = "test.sensitive";
  descriptor.inputSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    properties: { [propertyName]: propertySchema },
    required: [propertyName],
  };
  descriptor.sensitive.input = [sensitivePointer];
  return descriptor;
}

test("sensitive pointer ancestors, empty pointer and escaped segments cannot persist", () => {
  const objectSchema = {
    type: "object",
    additionalProperties: false,
    properties: { safe: { type: "string" }, value: { type: "string" } },
    required: [],
  };
  const vectors = [
    { id: "test.sensitive.descendant", key: "foo", pointer: "/foo/bar" },
    { id: "test.sensitive.escaped", key: "foo/bar", pointer: "/foo~1bar/value" },
  ];
  for (const vector of vectors) {
    const descriptor = descriptorWithSensitive(vector.id, vector.key, vector.schema ?? objectSchema, vector.pointer);
    const registry = new ActionRegistry([{ descriptor, handler: async () => ({ text: "" }) }]);
    const profile = {
      schemaVersion: "useful.agent-profile.v1",
      profileId: "sensitive-test",
      name: "sensitive pointer test",
      actions: [{
        actionId: vector.id,
        expectedContractVersion: descriptor.contractVersion,
        expectedActionVersion: descriptor.version,
        expectedSourceKind: descriptor.source.kind,
        expectedPublisherId: descriptor.source.publisher.id,
        enabled: { cli: true, mcp: true },
        aliases: [],
        presets: [{ presetId: "blocked", name: "blocked", defaults: { [vector.key]: vector.value ?? { safe: "x" } } }],
      }],
    };
    assert.throws(() => validateProfileAgainstRegistry(profile, registry), (error) => {
      assert.equal(error.code, PROFILE_ERROR_CODES.PRESET_INVALID);
      assert.equal(error.issues[0].code, "DEFAULT_SENSITIVE_FIELD");
      return true;
    }, vector.pointer || "empty pointer");
  }

  const emptyPointer = descriptorWithSensitive("test.sensitive.root", "operation", { type: "string" }, "");
  const rootSensitiveRegistry = new ActionRegistry([{ descriptor: emptyPointer, handler: async () => ({ text: "" }) }]);
  const rootSensitiveProfile = createProfileForDescriptor(emptyPointer, { operation: "read" });
  assert.throws(
    () => validateProfileAgainstRegistry(rootSensitiveProfile, rootSensitiveRegistry),
    (error) => error.code === PROFILE_ERROR_CODES.PRESET_INVALID
      && error.issues.some((entry) => entry.code === "DEFAULT_SENSITIVE_FIELD"),
    "an empty JSON Pointer marks the whole input sensitive and blocks every preset default",
  );
});
