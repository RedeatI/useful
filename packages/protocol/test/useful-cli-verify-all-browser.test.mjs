import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { build } from "esbuild";
import { createAgentConnection } from "../src/agent-connection.mjs";
import { createAgentConnectionVerification } from "../src/agent-connection-verification.mjs";
import {
  AGENT_CONNECTION_VERIFICATION_SET_TARGETS,
  createAgentConnectionVerificationSet,
  parseAgentConnectionVerificationSet,
} from "../src/agent-connection-verification-set.mjs";
import { createAgentProbe } from "../src/agent-probe.mjs";
import {
  USEFUL_CLI_VERIFY_ALL_MAX_CODE_UNITS,
  USEFUL_CLI_VERIFY_ALL_MAX_NODES,
  UsefulCliVerifyAllBrowserError,
  parseUsefulCliVerifyAllJson,
} from "../src/useful-cli-verify-all-browser.mjs";

const WINDOWS = process.platform === "win32";
const NODE_PATH = WINDOWS ? "C:\\程序 Files\\node's runtime\\node.exe" : "/opt/程序/node's runtime/node";
const LAUNCHER_PATH = WINDOWS ? "C:\\Useful 工具's Kit\\lib\\useful-mcp.mjs" : "/opt/Useful 工具's Kit/lib/useful-mcp.mjs";
const OTHER_NODE_PATH = WINDOWS ? "D:\\Other\\node.exe" : "/other/node";
const OTHER_LAUNCHER_PATH = WINDOWS ? "D:\\Other\\useful-mcp.mjs" : "/other/useful-mcp.mjs";
const TOOL_NAMES_SHA256 = "2740f646530580de5ad2079f3290c01517e8b37f58c6d624293ae74e665c6f17";
const SECRET_SENTINEL = "SECRET_SENTINEL_7d905aa1";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeProbe(mode, { revision, stderrBytes = 0, version } = {}) {
  return createAgentProbe({
    installation: {
      mode,
      artifactVerified: mode === "agent-kit",
      sourceRevision: revision ?? (mode === "source" ? "a".repeat(40) : "b".repeat(64)),
      version: version ?? (mode === "source" ? "0.1.0-source.1" : "0.1.0-kit.1"),
    },
    server: { name: "useful-actions", version: "0.1.0", protocolVersion: "2026-07-28" },
    tools: { count: 40, namesSha256: TOOL_NAMES_SHA256, actionCount: 36, helperCount: 4 },
    proof: {
      handshake: true,
      list: true,
      search: true,
      describe: true,
      safeCall: true,
      transportClosed: true,
      externalAgentInstalled: false,
      codexConfigured: false,
      claudeConfigured: false,
      hostConfigWrittenByProbe: false,
      launcherNetworkAttested: false,
    },
    process: { stderrBytes, stderrSha256: "c".repeat(64), transportClosed: true },
  });
}

function makeSet(mode = "source", options = {}) {
  const probe = makeProbe(mode, options);
  return createAgentConnectionVerificationSet({
    verifications: AGENT_CONNECTION_VERIFICATION_SET_TARGETS.map((target) => createAgentConnectionVerification({
      connection: createAgentConnection({
        plan: {
          schemaVersion: "useful.agent-integration.v1",
          target,
          transport: "stdio",
          scope: "user",
          server: {
            name: "useful",
            nodePath: options.nodePath ?? NODE_PATH,
            launcherPath: options.launcherPath ?? LAUNCHER_PATH,
            args: [],
            env: {},
          },
        },
      }),
      probe,
    })),
  });
}

function envelope(data) {
  return { schemaVersion: "useful.cli.result.v1", ok: true, command: "agent verify-all", data };
}

function parseDocument(document) {
  return parseUsefulCliVerifyAllJson(JSON.stringify(document));
}

function expectCode(operation, code) {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof UsefulCliVerifyAllBrowserError);
    assert.equal(error.code, code);
    assert.ok(Object.isFrozen(error.details));
    return true;
  });
}

const schemaFiles = [
  "agent-integration.schema.json",
  "agent-connection.schema.json",
  "agent-probe.schema.json",
  "agent-connection-verification.schema.json",
  "agent-connection-verification-set.schema.json",
];

function buildFiveSchemaValidator() {
  const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
  const schemas = schemaFiles.map((file) => JSON.parse(readFileSync(new URL(`../schemas/${file}`, import.meta.url), "utf8")));
  for (const schema of schemas) ajv.addSchema(schema);
  return ajv.getSchema(schemas.at(-1).$id);
}

function evaluateDifferential(validate, rawData, label, expectedAccept) {
  const text = JSON.stringify(envelope(rawData));
  const oracleData = JSON.parse(text).data;
  const ajvAccept = Boolean(validate(oracleData));
  let nodeAccept = false;
  let nodeResult;
  try {
    nodeResult = parseAgentConnectionVerificationSet(oracleData);
    nodeAccept = true;
  } catch {
    // Acceptance is the oracle signal; error wording and ordering are not.
  }
  let browserAccept = false;
  let browserResult;
  try {
    browserResult = parseUsefulCliVerifyAllJson(text);
    browserAccept = true;
  } catch (error) {
    assert.ok(error instanceof UsefulCliVerifyAllBrowserError, `${label}: stable browser error class`);
  }
  const oracleAccept = ajvAccept && nodeAccept;
  assert.equal(browserAccept, oracleAccept, `${label}: browser=${browserAccept} Ajv=${ajvAccept} Node=${nodeAccept}`);
  if (expectedAccept !== undefined) assert.equal(browserAccept, expectedAccept, `${label}: expected acceptance`);
  if (browserAccept) assert.deepEqual(browserResult, nodeResult, `${label}: canonical Node/browser result`);
  return { ajvAccept, browserAccept, nodeAccept };
}

function valueAt(root, path) {
  return path.reduce((value, part) => value[part], root);
}

function collectPaths(value, path = [], output = { objects: [], arrays: [], scalars: [] }) {
  if (Array.isArray(value)) {
    output.arrays.push(path);
    value.forEach((child, index) => collectPaths(child, [...path, index], output));
  } else if (value && typeof value === "object") {
    output.objects.push(path);
    for (const [key, child] of Object.entries(value)) collectPaths(child, [...path, key], output);
  } else output.scalars.push(path);
  return output;
}

function mutate(base, operation) {
  const candidate = clone(base);
  operation(candidate);
  return candidate;
}

function alternateScalar(value) {
  if (typeof value === "string") return `${value}${SECRET_SENTINEL}`;
  if (typeof value === "boolean") return !value;
  if (typeof value === "number") return value + 1;
  return {};
}

function assertNoLeak(operation, fragments) {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof UsefulCliVerifyAllBrowserError);
    for (const fragment of fragments) {
      assert.equal(String(error).includes(fragment), false, `String(error) leaked ${JSON.stringify(fragment)}`);
      assert.equal(error.message.includes(fragment), false, `message leaked ${JSON.stringify(fragment)}`);
      assert.equal(JSON.stringify(error.details).includes(fragment), false, `details leaked ${JSON.stringify(fragment)}`);
    }
    return true;
  });
}

test("accepts and canonically matches Node for real source/Agent Kit boundary corpora", () => {
  const validate = buildFiveSchemaValidator();
  for (const [label, data] of [
    ["source/revision40/stderr0", makeSet("source", { revision: "a".repeat(40), stderrBytes: 0 })],
    ["agent-kit/revision64/stderr65536", makeSet("agent-kit", { revision: "b".repeat(64), stderrBytes: 65536 })],
  ]) {
    const result = evaluateDifferential(validate, data, label, true);
    assert.equal(result.ajvAccept, true);
  }
  const parsed = parseDocument(envelope(makeSet("source")));
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.verifications[0].connection.plan.server.env));
  for (const index of [0, 1]) {
    assert.equal(parsed.verifications[index].connection.output.powershellCommand.includes("node''s runtime"), true);
    assert.equal(parsed.verifications[index].connection.output.powershellCommand.includes("工具''s Kit"), true);
  }
});

test("closed-schema field/type/literal matrix is exactly differential", () => {
  const validate = buildFiveSchemaValidator();
  const valid = clone(makeSet("source"));
  const paths = collectPaths(valid);

  for (const path of paths.objects) {
    evaluateDifferential(validate, mutate(valid, (candidate) => {
      valueAt(candidate, path)[`${SECRET_SENTINEL}-unknown`] = null;
    }), `unknown:${path.join(".") || "root"}`, false);
  }
  for (const path of paths.objects) {
    for (const key of Object.keys(valueAt(valid, path))) {
      evaluateDifferential(validate, mutate(valid, (candidate) => {
        delete valueAt(candidate, path)[key];
      }), `missing:${[...path, key].join(".")}`, false);
    }
  }
  for (const path of paths.arrays) {
    evaluateDifferential(validate, mutate(valid, (candidate) => {
      valueAt(candidate, path).push(null);
    }), `array-shape:${path.join(".")}`);
  }
  for (const path of paths.scalars) {
    evaluateDifferential(validate, mutate(valid, (candidate) => {
      valueAt(candidate, path.slice(0, -1))[path.at(-1)] = {};
    }), `type:${path.join(".")}`, false);
    evaluateDifferential(validate, mutate(valid, (candidate) => {
      const parent = valueAt(candidate, path.slice(0, -1));
      parent[path.at(-1)] = alternateScalar(parent[path.at(-1)]);
    }), `literal:${path.join(".")}`);
  }
});

test("all four renderer slots and every endpoint binding are exactly differential", () => {
  const validate = buildFiveSchemaValidator();
  const valid = clone(makeSet("source"));
  const rendererMutations = [];
  for (const slot of [0, 1]) {
    const output = valid.verifications[slot].connection.output;
    for (let index = 0; index < output.commandArgv.length; index += 1) {
      rendererMutations.push([`slot${slot}.argv[${index}]`, (data) => { data.verifications[slot].connection.output.commandArgv[index] += "-changed"; }]);
    }
    rendererMutations.push(
      [`slot${slot}.argv-order`, (data) => {
        const argv = data.verifications[slot].connection.output.commandArgv;
        const nodeIndex = argv.length - 2;
        const launcherIndex = argv.length - 1;
        const node = argv[nodeIndex];
        argv[nodeIndex] = argv[launcherIndex];
        argv[launcherIndex] = node;
      }],
      [`slot${slot}.powershell`, (data) => { data.verifications[slot].connection.output.powershellCommand += " -changed"; }],
      [`slot${slot}.kind`, (data) => { data.verifications[slot].connection.output.kind = "merge-fragment"; }],
      [`slot${slot}.writes`, (data) => { data.verifications[slot].connection.output.writesHostConfigWhenExecuted = false; }],
    );
  }
  for (const slot of [2, 3]) {
    rendererMutations.push(
      [`slot${slot}.format`, (data) => { data.verifications[slot].connection.output.format = "toml"; }],
      [`slot${slot}.kind`, (data) => { data.verifications[slot].connection.output.kind = "host-command"; }],
      [`slot${slot}.writes`, (data) => { data.verifications[slot].connection.output.writesHostConfigWhenExecuted = true; }],
      [`slot${slot}.merge.command`, (data) => { data.verifications[slot].connection.output.mergeFragment.mcpServers.useful.command = OTHER_NODE_PATH; }],
      [`slot${slot}.merge.args`, (data) => { data.verifications[slot].connection.output.mergeFragment.mcpServers.useful.args[0] = OTHER_LAUNCHER_PATH; }],
      [`slot${slot}.merge.env`, (data) => { data.verifications[slot].connection.output.mergeFragment.mcpServers.useful.env = { NO_COLOR: "1" }; }],
    );
  }
  for (const [label, operation] of rendererMutations) {
    evaluateDifferential(validate, mutate(valid, operation), label, false);
  }

  const endpointAlternates = {
    nodePath: OTHER_NODE_PATH,
    launcherPath: OTHER_LAUNCHER_PATH,
    installationMode: "agent-kit",
    sourceRevision: "d".repeat(40),
    productVersion: "9.9.9",
  };
  for (let slot = 0; slot < 4; slot += 1) {
    for (const [field, alternate] of Object.entries(endpointAlternates)) {
      evaluateDifferential(validate, mutate(valid, (data) => {
        data.verifications[slot].endpoint[field] = alternate;
      }), `slot${slot}.endpoint.${field}`, false);
    }
  }
  for (const slot of [1, 2, 3]) {
    evaluateDifferential(validate, mutate(valid, (data) => {
      data.verifications[slot].probe.process.stderrBytes = 1;
    }), `slot${slot}.shared-probe`, false);
  }
});

test("claims, proof, tool closure, ordering, user/env, hashes, semver and number bounds are exactly differential", () => {
  const validate = buildFiveSchemaValidator();
  const valid = clone(makeSet("source"));

  for (const field of Object.keys(valid.claims)) {
    evaluateDifferential(validate, mutate(valid, (data) => { data.claims[field] = !data.claims[field]; }), `set.claims.${field}`, false);
  }
  for (let slot = 0; slot < 4; slot += 1) {
    for (const field of Object.keys(valid.verifications[slot].claims)) {
      evaluateDifferential(validate, mutate(valid, (data) => {
        data.verifications[slot].claims[field] = !data.verifications[slot].claims[field];
      }), `slot${slot}.claims.${field}`, false);
    }
    for (const field of Object.keys(valid.verifications[slot].probe.proof)) {
      evaluateDifferential(validate, mutate(valid, (data) => {
        data.verifications[slot].probe.proof[field] = !data.verifications[slot].probe.proof[field];
      }), `slot${slot}.proof.${field}`, false);
    }
    for (const field of Object.keys(valid.verifications[slot].probe.tools)) {
      evaluateDifferential(validate, mutate(valid, (data) => {
        const tools = data.verifications[slot].probe.tools;
        tools[field] = typeof tools[field] === "number" ? tools[field] + 1 : "e".repeat(64);
      }), `slot${slot}.tools.${field}`, false);
    }
  }

  const semanticMutations = [
    ["target", (data) => { data.verifications[0].connection.plan.target = "claude-code"; }],
    ["order", (data) => { [data.verifications[0], data.verifications[1]] = [data.verifications[1], data.verifications[0]]; }],
    ["user-scope", (data) => { data.verifications[0].connection.plan.scope = "project"; }],
    ["empty-env", (data) => { data.verifications[0].connection.plan.server.env = { NO_COLOR: "1" }; }],
    ["hostPlatform", (data) => { data.verifications[0].connection.hostPlatform = WINDOWS ? "linux" : "win32"; }],
    ["revision39", (data) => { data.verifications[0].probe.installation.sourceRevision = "a".repeat(39); }],
    ["revision65", (data) => { data.verifications[0].probe.installation.sourceRevision = "a".repeat(65); }],
    ["revision-uppercase", (data) => { data.verifications[0].probe.installation.sourceRevision = "A".repeat(40); }],
    ["hash", (data) => { data.verifications[0].probe.process.stderrSha256 = "z".repeat(64); }],
    ["semver", (data) => { data.verifications[0].probe.installation.version = "01.0.0"; }],
    ["stderr-negative", (data) => { data.verifications[0].probe.process.stderrBytes = -1; }],
    ["stderr-over", (data) => { data.verifications[0].probe.process.stderrBytes = 65537; }],
    ["stderr-fraction", (data) => { data.verifications[0].probe.process.stderrBytes = 0.5; }],
  ];
  for (const [label, operation] of semanticMutations) {
    evaluateDifferential(validate, mutate(valid, operation), label, false);
  }
});

test("type, envelope, UTF-8/code-unit, depth and node gates fail closed without input disclosure", () => {
  expectCode(() => parseUsefulCliVerifyAllJson(new String("{}")), "INVALID_INPUT_TYPE");
  assertNoLeak(() => parseUsefulCliVerifyAllJson(`not-json-${SECRET_SENTINEL}`), [SECRET_SENTINEL]);
  expectCode(() => parseUsefulCliVerifyAllJson("x".repeat(USEFUL_CLI_VERIFY_ALL_MAX_CODE_UNITS + 1)), "INPUT_TOO_LARGE");
  expectCode(() => parseUsefulCliVerifyAllJson("é".repeat(Math.floor(USEFUL_CLI_VERIFY_ALL_MAX_CODE_UNITS / 2) + 1)), "INPUT_TOO_LARGE");

  for (const operation of [
    (document) => { document.schemaVersion = SECRET_SENTINEL; },
    (document) => { document.ok = false; document[`${SECRET_SENTINEL}\nunknown`] = true; },
    (document) => { document.command = `${SECRET_SENTINEL}\nagent verify`; },
  ]) {
    const document = envelope(clone(makeSet("source")));
    operation(document);
    assertNoLeak(() => parseDocument(document), [SECRET_SENTINEL, "unknown", "agent verify"]);
  }

  const deep = {};
  let cursor = deep;
  for (let index = 0; index < 65; index += 1) {
    cursor[`${SECRET_SENTINEL}\nlevel-${index}`] = {};
    cursor = cursor[`${SECRET_SENTINEL}\nlevel-${index}`];
  }
  assertNoLeak(() => parseDocument(envelope(deep)), [SECRET_SENTINEL, "level-64", "\n"]);

  const many = { [`${SECRET_SENTINEL}\nvalues`]: Array.from({ length: USEFUL_CLI_VERIFY_ALL_MAX_NODES }, () => null) };
  assertNoLeak(() => parseDocument(envelope(many)), [SECRET_SENTINEL, "values", "\n"]);

  const unknown = envelope(clone(makeSet("source")));
  unknown.data[`${SECRET_SENTINEL}\nunknown-field`] = { nested: true };
  assertNoLeak(() => parseDocument(unknown), [SECRET_SENTINEL, "unknown-field", "\n"]);

  for (const key of ["__proto__", "prototype", "constructor"]) {
    const unsafe = envelope(clone(makeSet("source")));
    const outer = `${SECRET_SENTINEL}\ncustom-${key}`;
    unsafe.data.verifications[0].probe[outer] = {};
    Object.defineProperty(unsafe.data.verifications[0].probe[outer], key, {
      value: { [`${SECRET_SENTINEL}\ninner`]: true },
      enumerable: true,
    });
    assertNoLeak(() => parseDocument(unsafe), [SECRET_SENTINEL, `custom-${key}`, "inner", "\n", key]);
  }
});

test("actual package browser subpath bundles once with no node:/Ajv inputs and at most 40 KiB", async () => {
  const resolved = import.meta.resolve("@useful/protocol/useful-cli-verify-all-browser");
  const entry = fileURLToPath(resolved);
  const source = readFileSync(entry, "utf8");
  assert.equal(source.match(/JSON\.parse\s*\(/gu)?.length, 1);
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "browser",
    minify: true,
    metafile: true,
    write: false,
  });
  const output = result.outputFiles[0];
  assert.ok(output.contents.byteLength <= 40_960, `bundle is ${output.contents.byteLength} bytes`);
  for (const [input, metadata] of Object.entries(result.metafile.inputs)) {
    const segments = input.replaceAll("\\", "/").split("/");
    assert.equal(segments.some((segment) => segment === "ajv" || segment === "ajv-formats" || segment.startsWith("ajv@") || segment.startsWith("ajv-formats@")), false, `Ajv input: ${input}`);
    for (const imported of metadata.imports) assert.equal(imported.path.startsWith("node:"), false, `Node import: ${imported.path}`);
  }
  for (const metadata of Object.values(result.metafile.outputs)) {
    for (const imported of metadata.imports) assert.equal(imported.path.startsWith("node:"), false, `Node output import: ${imported.path}`);
  }
  assert.doesNotMatch(output.text, /node:/u);
});
