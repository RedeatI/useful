import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import { ActionExecutor, ActionRegistry } from "@useful/action-runtime";
import {
  createPipelineHandler,
  derivePluginAction,
  inspectUsefulArtifact,
  isValidActionId,
  loadPluginConfig,
  PluginActionError,
  signaturePayload,
  validateManifestActionContributions,
  validatePluginActionSchema,
  validatePluginActionSpec,
  verifyTestVectors,
} from "../src/index.mjs";

const pluginId = "com.example.pipeline";
const actionId = `${pluginId}.base64-sha256`;
const publisherKeyId = `ed25519:${"1".repeat(64)}`;
const schemaVectors = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../test-vectors/plugin-action-schema-vectors.json", import.meta.url)), "utf8"));
const pluginActionSchema = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../src/useful.plugin-action.v1.schema.json", import.meta.url)), "utf8"));

function validSpec() {
  return structuredClone(schemaVectors.valid);
}

function descriptorAndHandler(spec = validSpec(), options = {}) {
  const descriptor = derivePluginAction({ actionId: options.actionId ?? actionId, pluginId, pluginVersion: "1.2.3", publisherKeyId, spec });
  return { descriptor, handler: createPipelineHandler(spec) };
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => error instanceof PluginActionError && error.code === code);
}

function applyMutation(value, mutation) {
  let parent = value;
  for (const segment of mutation.path.slice(0, -1)) parent = parent[segment];
  const final = mutation.path.at(-1);
  if (mutation.delete) delete parent[final];
  else parent[final] = structuredClone(mutation.value);
}

test("Ajv 2020 schema compiles and stays aligned with the hand-written security validator", () => {
  assert.equal(pluginActionSchema.title, "Useful declarative plugin action v1");
  const positive = validSpec();
  assert.deepEqual(validatePluginActionSchema(positive), { valid: true, errors: [] });
  assert.equal(validatePluginActionSpec(positive), true);
  for (const mutation of schemaVectors.invalidMutations) {
    const candidate = validSpec();
    applyMutation(candidate, mutation);
    assert.equal(validatePluginActionSchema(candidate).valid, false, `Ajv accepted: ${mutation.name}`);
    assert.throws(() => validatePluginActionSpec(candidate), PluginActionError, `hand validator accepted: ${mutation.name}`);
  }
});

test("derives immutable security/provenance fields and executes the meaningful two-step pipeline", async () => {
  const { descriptor, handler } = descriptorAndHandler();
  assert.equal(descriptor.version, "1.2.3");
  assert.deepEqual(descriptor.source, { kind: "plugin", toolId: pluginId, publisher: { id: publisherKeyId }, digest: descriptor.source.digest });
  assert.match(descriptor.source.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(descriptor.behavior, { readOnly: true, destructive: false, idempotent: true, openWorld: false, sideEffects: [], requiresConfirmation: false });
  assert.deepEqual(descriptor.permissions, { required: [], capabilities: [] });
  assert.equal(descriptor.execution.mode, "pure");
  await verifyTestVectors(descriptor, handler);
  const registry = new ActionRegistry([]);
  registry.register({ descriptor, handler });
  const result = await new ActionExecutor(registry).execute(actionId, { text: "abc" });
  assert.equal(result.output.digest, "35d95694d3f160215db293c7899daa5907837838fb4b8119ed713e32446c1266");
  assert.equal(result.receipt.source.kind, "plugin");
  assert.equal(result.receipt.source.publisher.id, publisherKeyId);
  assert.equal(result.receipt.source.digest, descriptor.source.digest);
});

test("shared action ID vectors keep lowercase and numeric later segments aligned", () => {
  const vectors = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../../../fixtures/action-id-vectors.json", import.meta.url)), "utf8"));
  for (const value of vectors.valid) assert.equal(isValidActionId(value), true, value);
  for (const value of vectors.invalid) assert.equal(isValidActionId(value), false, value);
});

test("plugins cannot claim the reserved builtin namespace", () => {
  expectCode(
    () => derivePluginAction({
      actionId: "builtin.video-trim.probe",
      pluginId: "builtin.video-trim",
      pluginVersion: "1.2.3",
      publisherKeyId,
      spec: validSpec(),
    }),
    "PLUGIN_ACTION_NAMESPACE_INVALID",
  );
});

test("plugins cannot claim MCP discovery or orchestration names through an action ID or alias", () => {
  for (const name of [
    "useful.actions.search",
    "useful.actions.describe",
    "useful.actions.suggest",
    "useful.actions.recipe",
  ]) {
    expectCode(
      () => derivePluginAction({
        actionId: name,
        pluginId: "useful.actions",
        pluginVersion: "1.2.3",
        publisherKeyId,
        spec: validSpec(),
      }),
      "PLUGIN_ACTION_RESERVED_NAME",
    );

    const alias = validSpec();
    alias.aliases = [name];
    assert.equal(validatePluginActionSchema(alias).valid, false, name);
    expectCode(() => descriptorAndHandler(alias), "PLUGIN_ACTION_RESERVED_NAME");

    expectCode(
      () => validateManifestActionContributions({
        id: "useful.actions",
        contributes: { actions: [{ actionId: name, path: "actions/reserved.json" }] },
      }),
      "PLUGIN_ACTION_RESERVED_NAME",
    );
  }
});

test("pipeline validator rejects unknown builtins, forward/cycle refs, duplicate steps and namespace violations", () => {
  const unknown = validSpec();
  unknown.pipeline.steps[0].actionId = "plugin.other.action";
  expectCode(() => descriptorAndHandler(unknown), "PIPELINE_ACTION_NOT_ALLOWED");

  const forward = validSpec();
  forward.pipeline.steps[0].input.text = { $ref: "/steps/hash/output/digest" };
  expectCode(() => descriptorAndHandler(forward), "PIPELINE_FORWARD_REFERENCE");

  const selfCycle = validSpec();
  selfCycle.pipeline.steps[0].input.text = { $ref: "/steps/encode/output/text" };
  expectCode(() => descriptorAndHandler(selfCycle), "PIPELINE_FORWARD_REFERENCE");

  const duplicate = validSpec();
  duplicate.pipeline.steps[1].id = "encode";
  expectCode(() => descriptorAndHandler(duplicate), "PIPELINE_STEP_ID_INVALID");
  expectCode(() => descriptorAndHandler(validSpec(), { actionId: "com.attacker.action" }), "PLUGIN_ACTION_NAMESPACE_INVALID");
});

test("templates reject dangerous keys, excess depth/bytes, arbitrary expressions and missing refs", async () => {
  for (const dangerous of ["__proto__", "constructor", "prototype"]) {
    const spec = validSpec();
    spec.pipeline.steps[0].input = JSON.parse(`{"operation":"encode","text":{"$ref":"/input/text"},"${dangerous}":{}}`);
    expectCode(() => descriptorAndHandler(spec), "PIPELINE_FORBIDDEN_KEY");
  }
  const interpolated = validSpec();
  interpolated.pipeline.steps[0].input.text = "${input.text}";
  expectCode(() => descriptorAndHandler(interpolated), "PIPELINE_INTERPOLATION_FORBIDDEN");

  const incomplete = validSpec();
  incomplete.pipeline.steps[0].input.text = "${".repeat(10000);
  assert.doesNotThrow(() => descriptorAndHandler(incomplete));

  const completedAfterManyStarts = validSpec();
  completedAfterManyStarts.pipeline.steps[0].input.text = `${"${".repeat(10000)}}`;
  expectCode(() => descriptorAndHandler(completedAfterManyStarts), "PIPELINE_INTERPOLATION_FORBIDDEN");

  const deep = validSpec();
  let nested = {};
  for (let index = 0; index < 40; index += 1) nested = { value: nested };
  deep.pipeline.steps[0].input.extra = nested;
  expectCode(() => descriptorAndHandler(deep), "PIPELINE_TEMPLATE_TOO_DEEP");

  const large = validSpec();
  large.pipeline.steps[0].input.extra = "x".repeat(262145);
  expectCode(() => descriptorAndHandler(large), "PIPELINE_TEMPLATE_TOO_LARGE");

  const missing = validSpec();
  missing.pipeline.steps[0].input.text = { $ref: "/input/missing" };
  const missingHandler = descriptorAndHandler(missing).handler;
  await assert.rejects(missingHandler({ text: "abc" }), (error) => error.code === "PIPELINE_REFERENCE_MISSING");

  const expanded = validSpec();
  expanded.pipeline.output = { first: { $ref: "/input/text" }, second: { $ref: "/input/text" } };
  const expandedHandler = descriptorAndHandler(expanded).handler;
  await assert.rejects(expandedHandler({ text: "x".repeat(600000) }), (error) => error.code === "PIPELINE_EXPANSION_TOO_LARGE");

  const intermediate = validSpec();
  intermediate.pipeline.steps = Array.from({ length: 12 }, (_, index) => ({
    id: `encode${index}`,
    actionId: "builtin.utilities.base64",
    input: { operation: "encode", text: { $ref: "/input/text" } },
  }));
  intermediate.pipeline.output = { $ref: "/steps/encode11/output" };
  const intermediateHandler = descriptorAndHandler(intermediate).handler;
  await assert.rejects(intermediateHandler({ text: "x".repeat(300000) }), (error) => error.code === "PIPELINE_INTERMEDIATE_TOO_LARGE");
});

test("test vectors and output schema mismatches fail registration", async () => {
  const mismatch = validSpec();
  mismatch.testVectors[0].expectedOutput.digest = "0".repeat(64);
  const first = descriptorAndHandler(mismatch);
  await assert.rejects(verifyTestVectors(first.descriptor, first.handler), (error) => error.code === "PLUGIN_TEST_VECTOR_MISMATCH");

  const outputMismatch = validSpec();
  outputMismatch.outputSchema.properties.digest.const = "0".repeat(64);
  const second = descriptorAndHandler(outputMismatch);
  await assert.rejects(verifyTestVectors(second.descriptor, second.handler), (error) => error.code === "PLUGIN_TEST_VECTOR_MISMATCH");
});

function signedFixture(root, overrides = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicHex = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("hex");
  const keyId = `ed25519:${publicHex}`;
  const manifest = overrides.manifest ?? {
    schemaVersion: 1,
    id: pluginId,
    name: "Pipeline",
    version: "1.2.3",
    entry: { type: "web", path: "index.html" },
    contributes: { actions: [{ actionId, path: "actions/action.json" }] },
    permissions: [],
  };
  const zip = new AdmZip();
  zip.addFile("manifest.json", Buffer.from(JSON.stringify(manifest)));
  zip.addFile("index.html", Buffer.from("<!doctype html>"));
  if (!overrides.missingAction) zip.addFile("actions/action.json", Buffer.from(JSON.stringify(overrides.spec ?? validSpec())));
  const artifactBytes = overrides.archiveBytes ?? zip.toBuffer();
  const artifactPath = path.join(root, "plugin.useful");
  fs.writeFileSync(artifactPath, artifactBytes);
  const sha256 = createHash("sha256").update(artifactBytes).digest("hex");
  const receipt = {
    schemaVersion: 1,
    signatureDomain: "useful-artifact-v1",
    publisherKeyId: keyId,
    toolId: manifest.id,
    version: manifest.version,
    artifactSha256: sha256,
    artifactBytes: artifactBytes.length,
    signature: sign(null, signaturePayload(manifest.id, manifest.version, sha256), privateKey).toString("hex"),
  };
  const signaturePath = path.join(root, "plugin.useful.publisher-signature.json");
  fs.writeFileSync(signaturePath, JSON.stringify(overrides.receipt ?? receipt));
  const config = {
    schemaVersion: "useful.plugin-set.v1",
    plugins: [{ artifactPath: "plugin.useful", signaturePath: "plugin.useful.publisher-signature.json", expectedPublisherKeyId: keyId, expectedArtifactSha256: sha256 }],
  };
  const configPath = path.join(root, "plugins.json");
  fs.writeFileSync(configPath, JSON.stringify(overrides.config ?? config));
  return { artifactPath, signaturePath, configPath, config, receipt, keyId, sha256 };
}

function patchZipUncompressedSizes(bytes, sizes) {
  const result = Buffer.from(bytes);
  let index = 0;
  for (let offset = 0; offset <= result.length - 4; offset += 1) {
    const signature = result.readUInt32LE(offset);
    if (signature === 0x04034b50) result.writeUInt32LE(sizes[index++] ?? sizes.at(-1), offset + 22);
  }
  index = 0;
  for (let offset = 0; offset <= result.length - 4; offset += 1) {
    if (result.readUInt32LE(offset) === 0x02014b50) result.writeUInt32LE(sizes[index++] ?? sizes.at(-1), offset + 24);
  }
  return result;
}

test("signed config loader verifies archive, signature, both pins and action paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "plugin-actions-"));
  try {
    const fixture = signedFixture(root);
    const originalArtifact = fs.readFileSync(fixture.artifactPath);
    const actions = await loadPluginConfig(fixture.configPath);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].descriptor.source.publisher.id, fixture.keyId);

    fs.writeFileSync(fixture.artifactPath, Buffer.concat([originalArtifact, Buffer.from("tamper")]));
    await assert.rejects(loadPluginConfig(fixture.configPath), (error) => error.code === "ARTIFACT_PIN_MISMATCH");
    fs.writeFileSync(fixture.artifactPath, originalArtifact);

    const wrongHash = structuredClone(fixture.config);
    wrongHash.plugins[0].expectedArtifactSha256 = "0".repeat(64);
    fs.writeFileSync(fixture.configPath, JSON.stringify(wrongHash));
    await assert.rejects(loadPluginConfig(fixture.configPath), (error) => error.code === "ARTIFACT_PIN_MISMATCH");

    const wrongPublisher = structuredClone(fixture.config);
    wrongPublisher.plugins[0].expectedPublisherKeyId = `ed25519:${"0".repeat(64)}`;
    fs.writeFileSync(fixture.configPath, JSON.stringify(wrongPublisher));
    await assert.rejects(loadPluginConfig(fixture.configPath), (error) => error.code === "PUBLISHER_PIN_MISMATCH");

    fs.writeFileSync(fixture.configPath, JSON.stringify(fixture.config));
    const tamperedSidecar = { ...fixture.receipt, signature: `00${fixture.receipt.signature.slice(2)}` };
    fs.writeFileSync(fixture.signaturePath, JSON.stringify(tamperedSidecar));
    await assert.rejects(loadPluginConfig(fixture.configPath), (error) => error.code === "SIGNATURE_INVALID");

    fs.writeFileSync(fixture.signaturePath, "{}");
    await assert.rejects(loadPluginConfig(fixture.configPath), (error) => error.code === "SIGNATURE_INVALID");

    const escapingArtifact = structuredClone(fixture.config);
    escapingArtifact.plugins[0].artifactPath = "../plugin.useful";
    fs.writeFileSync(fixture.configPath, JSON.stringify(escapingArtifact));
    await assert.rejects(loadPluginConfig(fixture.configPath), (error) => error.code === "PLUGIN_CONFIG_INVALID");

    const absoluteArtifact = structuredClone(fixture.config);
    absoluteArtifact.plugins[0].artifactPath = fixture.artifactPath;
    fs.writeFileSync(fixture.configPath, JSON.stringify(absoluteArtifact));
    await assert.rejects(loadPluginConfig(fixture.configPath), (error) => error.code === "PLUGIN_CONFIG_INVALID");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archive and manifest negative matrix fails closed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "plugin-actions-negative-"));
  try {
    const traversal = new AdmZip();
    traversal.addFile("safe/escape", Buffer.from("x"));
    traversal.addFile("manifest.json", Buffer.from("{}"));
    const traversalBytes = Buffer.from(traversal.toBuffer());
    let offset = 0;
    while ((offset = traversalBytes.indexOf("safe/escape", offset, "utf8")) >= 0) {
      traversalBytes.write("../escapexx", offset, "utf8");
      offset += 11;
    }
    expectCode(() => inspectUsefulArtifact(traversalBytes), "ARCHIVE_PATH_INVALID");

    const largeHeader = new AdmZip();
    largeHeader.addFile("manifest.json", Buffer.from("{}"));
    expectCode(() => inspectUsefulArtifact(patchZipUncompressedSizes(largeHeader.toBuffer(), [64 * 1024 * 1024 + 1])), "ARCHIVE_ENTRY_TOO_LARGE");

    const expanded = new AdmZip();
    for (let index = 0; index < 5; index += 1) expanded.addFile(index === 0 ? "manifest.json" : `f${index}`, Buffer.from("{}"));
    expectCode(() => inspectUsefulArtifact(patchZipUncompressedSizes(expanded.toBuffer(), Array(5).fill(60 * 1024 * 1024))), "ARCHIVE_EXPANDED_TOO_LARGE");

    const tooMany = new AdmZip();
    for (let index = 0; index < 4097; index += 1) tooMany.addFile(index === 0 ? "manifest.json" : `f${index}`, Buffer.from("{}"));
    expectCode(() => inspectUsefulArtifact(tooMany.toBuffer()), "ARCHIVE_ENTRY_LIMIT");

    const missing = signedFixture(root, { missingAction: true });
    await assert.rejects(loadPluginConfig(missing.configPath), (error) => error.code === "ACTION_SPEC_MISSING");

    const escapedManifest = {
      schemaVersion: 1, id: pluginId, name: "bad", version: "1.2.3",
      entry: { type: "web", path: "index.html" },
      contributes: { actions: [{ actionId, path: "../action.json" }] }, permissions: [],
    };
    const escapedRoot = await mkdtemp(path.join(tmpdir(), "plugin-actions-escape-"));
    try {
      const escaped = signedFixture(escapedRoot, { manifest: escapedManifest });
      await assert.rejects(loadPluginConfig(escaped.configPath), (error) => error.code === "ARCHIVE_PATH_INVALID");
    } finally { await rm(escapedRoot, { recursive: true, force: true }); }

    const namespaceRoot = await mkdtemp(path.join(tmpdir(), "plugin-actions-namespace-"));
    try {
      const wrongNamespace = { ...escapedManifest, contributes: { actions: [{ actionId: "com.attacker.action", path: "actions/action.json" }] } };
      const invalid = signedFixture(namespaceRoot, { manifest: wrongNamespace });
      await assert.rejects(loadPluginConfig(invalid.configPath), (error) => error.code === "PLUGIN_ACTION_NAMESPACE_INVALID");
    } finally { await rm(namespaceRoot, { recursive: true, force: true }); }

    const malformedManifests = [
      {
        schemaVersion: 1, id: "builtin.video-trim", name: "reserved", version: "1.2.3",
        entry: { type: "web", path: "index.html" }, contributes: { actions: [{ actionId: "builtin.video-trim.probe", path: "actions/action.json" }] }, permissions: [],
      },
      {
        schemaVersion: 2, id: pluginId, name: "bad", version: "1.2.3",
        entry: { type: "web", path: "index.html" }, contributes: { actions: [{ actionId, path: "actions/action.json" }] }, permissions: [],
      },
      {
        schemaVersion: 1, id: pluginId, name: "bad", version: "1.2.3",
        contributes: { actions: [{ actionId, path: "actions/action.json" }] }, permissions: [],
      },
      {
        schemaVersion: 1, id: pluginId, name: "bad", version: "not-semver",
        entry: { type: "web", path: "index.html" }, contributes: { actions: [{ actionId, path: "actions/action.json" }] }, permissions: [],
      },
      {
        schemaVersion: 1, id: pluginId, name: "bad", version: "1.2.3",
        entry: { type: "web", path: "index.html" }, contributes: { actions: [{ actionId, path: "actions/action.json" }] }, permissions: {},
      },
      {
        schemaVersion: 1, id: pluginId, name: "bad", version: "1.2.3",
        entry: { type: "web", path: "index.html" }, contributes: { actions: [{ actionId, path: "actions/action.json" }], unknown: [] }, permissions: [],
      },
      {
        schemaVersion: 1, id: pluginId, name: "bad", version: "1.2.3",
        entry: { type: "web", path: "index.html" }, contributes: { actions: [{ actionId, path: "actions/action.json", extra: true }] }, permissions: [],
      },
    ];
    for (const [index, manifest] of malformedManifests.entries()) {
      const malformedRoot = await mkdtemp(path.join(tmpdir(), `plugin-actions-malformed-${index}-`));
      try {
        const malformed = signedFixture(malformedRoot, { manifest });
        await assert.rejects(loadPluginConfig(malformed.configPath), (error) => ["MANIFEST_MISSING_OR_INVALID", "MANIFEST_ACTIONS_INVALID"].includes(error.code));
      } finally { await rm(malformedRoot, { recursive: true, force: true }); }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registry rejects actionId and alias collisions globally", () => {
  const registry = new ActionRegistry();
  const first = descriptorAndHandler();
  registry.register(first);
  const aliasSpec = validSpec();
  aliasSpec.aliases = [actionId];
  const second = descriptorAndHandler(aliasSpec, { actionId: `${pluginId}.second` });
  assert.throws(() => registry.register(second), (error) => error.code === "ACTION_NAME_COLLISION");

  const selfAliasSpec = validSpec();
  selfAliasSpec.aliases = [`${pluginId}.self-alias`];
  const selfAlias = descriptorAndHandler(selfAliasSpec, { actionId: `${pluginId}.self-alias` });
  assert.throws(() => new ActionRegistry([]).register(selfAlias), (error) => error.code === "ACTION_NAME_COLLISION");
});
