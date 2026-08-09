import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { assertActionDescriptor, validateActionDescriptor, validateValue } from "../src/index.mjs";

const objectSchema = (properties, required = Object.keys(properties)) => ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  properties,
  required,
});

function descriptor() {
  return {
    contractVersion: "1.0",
    actionId: "builtin.utilities.echo",
    version: "1.0.0",
    source: {
      kind: "builtin",
      toolId: "builtin.utilities",
      publisher: { id: "useful.project" },
      digest: "a".repeat(64),
    },
    title: "Echo",
    description: "Echo text",
    keywords: ["echo"],
    aliases: [],
    inputSchema: objectSchema({ text: { type: "string", maxLength: 32 } }),
    outputSchema: objectSchema({ text: { type: "string", maxLength: 32 } }),
    examples: [{ name: "basic", input: { text: "a" }, output: { text: "a" } }],
    testVectors: [{ name: "basic", input: { text: "a" }, expectedOutput: { text: "a" } }],
    execution: {
      mode: "pure",
      handler: "echo",
      timeoutMs: 100,
      maxInputBytes: 1024,
      maxOutputBytes: 1024,
      supportsCancellation: false,
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
    sensitive: { input: ["/text"], output: [], redactLogs: true },
  };
}

test("schema artifact is JSON Schema 2020-12 with a stable id", async () => {
  const schema = JSON.parse(await readFile(new URL("../src/action-descriptor.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.title, "Useful ActionDescriptor v1");
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.$id, "https://schemas.useful.local/actions/v1/action-descriptor.schema.json");
  assert.equal(schema.properties.contractVersion.const, "1.0");
});

test("Ajv 2020 compiles the artifact and accepts/rejects real descriptors", async () => {
  const schema = JSON.parse(await readFile(new URL("../src/action-descriptor.schema.json", import.meta.url), "utf8"));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

  assert.equal(validate(descriptor()), true, JSON.stringify(validate.errors));

  const rootSensitive = descriptor();
  rootSensitive.sensitive.input = [""];
  assert.equal(validate(rootSensitive), true, JSON.stringify(validate.errors));
  assert.deepEqual(validateActionDescriptor(rootSensitive), []);

  const missingRequired = descriptor();
  delete missingRequired.actionId;
  assert.equal(validate(missingRequired), false);
  assert.ok(validate.errors?.some((entry) => entry.keyword === "required" && entry.params.missingProperty === "actionId"));

  const injected = descriptor();
  injected.inputSchema.command = { type: "string" };
  assert.equal(validate(injected), false);
  assert.ok(validate.errors?.some((entry) => entry.keyword === "additionalProperties"));
});

test("accepts a valid fail-closed pure descriptor", () => {
  assert.doesNotThrow(() => assertActionDescriptor(descriptor()));
});

test("manual and JSON Schema validators keep presentation closed and bounded", async () => {
  const schema = JSON.parse(await readFile(new URL("../src/action-descriptor.schema.json", import.meta.url), "utf8"));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  const valid = descriptor();
  valid.presentation = { route: "/tools/echo", icon: "copy", category: "text" };
  assert.equal(validate(valid), true, JSON.stringify(validate.errors));
  assert.deepEqual(validateActionDescriptor(valid), []);

  for (const presentation of [{ route: "" }, { category: "x".repeat(129) }, { unknown: "value" }, "text"]) {
    const candidate = descriptor();
    candidate.presentation = presentation;
    assert.equal(validate(candidate), false, JSON.stringify(presentation));
    assert.ok(validateActionDescriptor(candidate).some((entry) => entry.path.startsWith("/presentation")));
  }
});

test("rejects duplicate aliases, external refs, and open object inputs", () => {
  const duplicate = descriptor();
  duplicate.aliases = ["echo", "echo"];
  assert.ok(validateActionDescriptor(duplicate).some((entry) => entry.path === "/aliases/1"));

  const external = descriptor();
  external.inputSchema.$ref = "https://attacker.invalid/schema.json";
  assert.ok(validateActionDescriptor(external).some((entry) => entry.path === "/inputSchema/$ref"));

  const open = descriptor();
  open.inputSchema.additionalProperties = true;
  assert.ok(validateActionDescriptor(open).some((entry) => entry.path === "/inputSchema/additionalProperties"));
});

test("pure descriptors cannot request permissions or hide side effects", () => {
  const invalid = descriptor();
  invalid.permissions.required = ["shell.execute"];
  invalid.behavior.sideEffects = ["process-spawn"];
  const issues = validateActionDescriptor(invalid);
  assert.ok(issues.some((entry) => entry.path === "/permissions"));
  assert.ok(issues.some((entry) => entry.path === "/behavior"));
});

test("source kind and reserved builtin namespaces cannot be impersonated", async () => {
  const schema = JSON.parse(await readFile(new URL("../src/action-descriptor.schema.json", import.meta.url), "utf8"));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

  const plugin = descriptor();
  plugin.source.kind = "plugin";
  plugin.source.toolId = "com.example.plugin";
  plugin.actionId = "com.example.plugin.echo";
  assert.equal(validate(plugin), true, JSON.stringify(validate.errors));
  assert.deepEqual(validateActionDescriptor(plugin), []);

  for (const mutate of [
    (candidate) => { candidate.actionId = "builtin.video-trim.probe"; },
    (candidate) => { candidate.source.toolId = "builtin.video-trim"; },
    (candidate) => { candidate.aliases = ["builtin.process-monitor.snapshot"]; },
  ]) {
    const candidate = structuredClone(plugin);
    mutate(candidate);
    assert.equal(validate(candidate), false);
    assert.ok(validateActionDescriptor(candidate).length > 0);
  }

  const wrongPluginNamespace = structuredClone(plugin);
  wrongPluginNamespace.actionId = "com.other.echo";
  assert.equal(validate(wrongPluginNamespace), true, "JSON Schema cannot compare actionId with dynamic source.toolId");
  assert.ok(validateActionDescriptor(wrongPluginNamespace).some((entry) => entry.path === "/actionId"));

  const falseBuiltin = descriptor();
  falseBuiltin.actionId = "com.example.echo";
  assert.equal(validate(falseBuiltin), false);
  assert.ok(validateActionDescriptor(falseBuiltin).some((entry) => entry.path === "/actionId"));
});

test("MCP discovery and orchestration tool names are reserved across action IDs and aliases", async () => {
  const schema = JSON.parse(await readFile(new URL("../src/action-descriptor.schema.json", import.meta.url), "utf8"));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

  for (const name of [
    "useful.actions.search",
    "useful.actions.describe",
    "useful.actions.suggest",
    "useful.actions.recipe",
  ]) {
    const reservedId = descriptor();
    reservedId.source.kind = "plugin";
    reservedId.source.toolId = "useful.actions";
    reservedId.actionId = name;
    assert.equal(validate(reservedId), false, name);
    assert.ok(validateActionDescriptor(reservedId).some((entry) => entry.path === "/actionId"), name);

    const reservedAlias = descriptor();
    reservedAlias.aliases = [name];
    assert.equal(validate(reservedAlias), false, name);
    assert.ok(validateActionDescriptor(reservedAlias).some((entry) => entry.path === "/aliases/0"), name);
  }
});

test("value validation rejects undeclared injection-shaped properties", () => {
  const schema = descriptor().inputSchema;
  const input = JSON.parse('{"text":"safe","command":"calc.exe","path":"../../secret","__proto__":{"polluted":true}}');
  const issues = validateValue(schema, input);
  assert.deepEqual(issues.map((entry) => entry.path), ["/command", "/path", "/__proto__"]);
  assert.equal({}.polluted, undefined);
});
