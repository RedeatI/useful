import assert from "node:assert/strict";
import { test } from "node:test";
import { ActionExecutionError, ActionExecutor, ActionRegistry, BUILTIN_ACTIONS, JSON_DESCRIPTOR } from "../src/index.mjs";
import { BUILTIN_ACTION_DESCRIPTORS, createBrowserActionHandlers, runHashAction } from "../src/browser.mjs";
import { nodeHashHandler } from "../src/node-hash.mjs";

test("registry provides stable list/describe and MCP adapter seam", () => {
  const registry = new ActionRegistry();
  assert.equal(registry.list().length, 36);
  assert.deepEqual(registry.list().map((action) => action.actionId), [...registry.list().map((action) => action.actionId)].sort());
  assert.equal(registry.describe("builtin.utilities.hash").contractVersion, "1.0");
  assert.deepEqual(registry.describe("builtin.utilities.hash").source.publisher, { id: "useful.project", name: "Useful" });
  assert.equal(registry.describe("missing"), undefined);
  assert.equal(registry.listAgentEligible().length, 36);
});

test("registry can preserve explicit registration order for profile-filtered surfaces", () => {
  const entries = BUILTIN_ACTIONS.slice(0, 3).reverse();
  const registry = new ActionRegistry(entries, { listOrder: "registration" });
  assert.deepEqual(
    registry.list().map((action) => action.actionId),
    entries.map((entry) => entry.descriptor.actionId),
  );
  assert.throws(
    () => new ActionRegistry([], { listOrder: "locale" }),
    (error) => error.code === "ACTION_REGISTRY_OPTIONS_INVALID",
  );
});

test("browser catalog exposes every bundled action and browser-safe utility handlers", async () => {
  assert.equal(BUILTIN_ACTION_DESCRIPTORS.length, 36);
  const bytes = new Uint8Array(4096);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
  let offset = 0;
  const crypto = {
    getRandomValues(target) {
      for (let index = 0; index < target.length; index += 1) target[index] = bytes[offset++ % bytes.length];
      return target;
    },
  };
  const handlers = createBrowserActionHandlers({ crypto });
  assert.deepEqual(Object.keys(handlers), BUILTIN_ACTION_DESCRIPTORS.map((descriptor) => descriptor.actionId));
  assert.deepEqual(handlers["builtin.utilities.json"]({ operation: "minify", text: "{ \"ok\": true }" }), { text: "{\"ok\":true}" });
  assert.deepEqual(handlers["builtin.utilities.json"]({ operation: "query", text: "{\"items\":[1,2]}", pointer: "/items/1" }), { text: "2" });
  assert.deepEqual(handlers["builtin.utilities.url"]({ operation: "encode", text: "a b" }), { text: "a%20b" });
  assert.match(handlers["builtin.utilities.uuid"]({ count: 1 }).values[0], /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  const password = handlers["builtin.utilities.password"]({ length: 16, lower: true, upper: true, digits: true, symbols: true, excludeAmbiguous: true });
  assert.equal(password.password.length, 16);
});

test("new default utility actions share strict browser and Node semantics", async () => {
  const handlers = createBrowserActionHandlers({ crypto: globalThis.crypto });
  assert.deepEqual(
    handlers["builtin.utilities.data-format"]({ operation: "yaml-to-json", text: "z: 1\na: true\n" }),
    { text: "{\n  \"a\": true,\n  \"z\": 1\n}", format: "json" },
  );
  assert.deepEqual(
    handlers["builtin.utilities.text-diff"]({ before: "same\nold", after: "same\nnew", context: 0 }).summary,
    { added: 1, removed: 1, unchanged: 1, hunks: 1 },
  );
  assert.deepEqual(
    handlers["builtin.utilities.ipv4"]({ operation: "contains", cidr: "0.0.0.0/0", address: "255.255.255.255" }),
    { operation: "contains", cidr: "0.0.0.0/0", address: "255.255.255.255", contains: true },
  );
  assert.deepEqual(
    handlers["builtin.utilities.html"]({ operation: "strip", text: "&lt;p&gt;safe text&lt;/p&gt;" }),
    { text: "safe text" },
  );
  assert.deepEqual(
    handlers["builtin.utilities.html"]({ operation: "strip", text: "<<script>alert(1)</script>" }),
    { text: "alert(1)" },
  );

  const executor = new ActionExecutor();
  for (const input of [
    { operation: "yaml-to-json", text: "a: &x [1]\nb: *x\n" },
    { operation: "yaml-to-json", text: "value: !custom x\n" },
    { operation: "yaml-to-json", text: "---\na: 1\n---\nb: 2\n" },
  ]) {
    await assert.rejects(executor.execute("builtin.utilities.data-format", input), (error) => error.code === "INPUT_INVALID");
  }
  await assert.rejects(
    executor.execute("builtin.utilities.ipv4", { operation: "inspect", value: "127.0.00.1" }),
    (error) => error.code === "INPUT_INVALID",
  );
  assert.deepEqual(
    (await executor.execute("builtin.utilities.html", { operation: "strip", text: "&lt;p&gt;safe text&lt;/p&gt;" })).output,
    { text: "safe text" },
  );
});

test("all descriptor test vectors execute against the shared executor", async () => {
  const executor = new ActionExecutor();
  for (const { descriptor } of BUILTIN_ACTIONS) {
    for (const vector of descriptor.testVectors) {
      if (vector.expectedOutput !== undefined) {
        const result = await executor.execute(descriptor.actionId, vector.input);
        assert.deepEqual(result.output, vector.expectedOutput, `${descriptor.actionId}: ${vector.name}`);
      } else {
        await assert.rejects(
          executor.execute(descriptor.actionId, vector.input),
          (error) => error.code === vector.expectedErrorCode,
          `${descriptor.actionId}: ${vector.name}`,
        );
      }
    }
  }
});

test("three pure handlers are deterministic through one executor", async () => {
  const executor = new ActionExecutor();
  const json = await executor.execute("builtin.utilities.json", { operation: "format", text: "{\"b\":2,\"a\":1}", indent: 2 });
  assert.deepEqual(json.output, { text: "{\n  \"b\": 2,\n  \"a\": 1\n}" });

  const encoded = await executor.execute("builtin.utilities.base64", { operation: "encode", text: "Useful 工具" });
  assert.deepEqual(encoded.output, { text: "VXNlZnVsIOW3peWFtw==" });
  const decoded = await executor.execute("builtin.utilities.base64", { operation: "decode", text: encoded.output.text });
  assert.deepEqual(decoded.output, { text: "Useful 工具" });

  const hash = await executor.execute("builtin.utilities.hash", { algorithm: "SHA-256", text: "abc" });
  assert.equal(hash.output.digest, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("random actions are non-idempotent and password output is sensitive", () => {
  const registry = new ActionRegistry();
  for (const actionId of ["builtin.utilities.uuid", "builtin.utilities.password", "builtin.utilities.random-number"]) {
    assert.equal(registry.describe(actionId).behavior.idempotent, false);
  }
  assert.deepEqual(registry.describe("builtin.utilities.password").sensitive.output, ["/password"]);
  assert.equal(registry.describe("builtin.utilities.regex").execution.mode, "worker");
});

test("registry query is filtered, deterministic, cursor-based, and code-point ordered", () => {
  const registry = new ActionRegistry();
  const first = registry.search("encode", { sort: "relevance", limit: 2 });
  assert.equal(first.actions.length, 2);
  assert.match(first.nextCursor, /^v1:\d+$/);
  const second = registry.search("encode", { sort: "relevance", limit: 2, cursor: first.nextCursor });
  assert.ok(second.actions.every((action) => !first.actions.some((entry) => entry.actionId === action.actionId)));
  assert.deepEqual(
    registry.search("word markdown", { limit: 10 }).actions.map((action) => action.actionId),
    ["builtin.office.docx"],
  );

  const generated = registry.query({
    filters: { categories: ["generate"], sourceKinds: ["builtin"], executionModes: ["pure"], readOnly: true, idempotent: false },
    sort: "actionId",
    limit: 100,
  });
  assert.deepEqual(generated.actions.map((action) => action.actionId), [
    "builtin.utilities.password",
    "builtin.utilities.random-number",
    "builtin.utilities.uuid",
  ]);
  assert.throws(() => registry.query({ sort: "locale" }), (error) => error.code === "ACTION_QUERY_INVALID");
  assert.throws(() => registry.query({ cursor: "v2:0" }), (error) => error.code === "ACTION_QUERY_INVALID");
  assert.throws(() => registry.query({ filters: { categories: ["office", "office"] } }), (error) => error.code === "ACTION_QUERY_INVALID");
});

test("regex runs in a terminable Node worker", async () => {
  const executor = new ActionExecutor();
  const benign = await executor.execute("builtin.utilities.regex", { operation: "test", pattern: "a+", flags: "", text: "caaab" });
  assert.deepEqual(benign.output, { matches: [{ index: 1, match: "aaa", groups: [] }] });
  await assert.rejects(
    executor.execute("builtin.utilities.regex", {
      operation: "test",
      pattern: "(a+)+$",
      flags: "",
      text: `${"a".repeat(50000)}!`,
    }, { timeoutMs: 25 }),
    (error) => error.code === "TIMEOUT",
  );
});

test("browser Web Crypto and Node crypto adapters match every shared hash vector", async () => {
  const descriptor = BUILTIN_ACTIONS.find((entry) => entry.descriptor.actionId === "builtin.utilities.hash").descriptor;
  for (const vector of descriptor.testVectors.filter((entry) => entry.expectedOutput)) {
    const browserOutput = await runHashAction(vector.input);
    const nodeOutput = nodeHashHandler(vector.input);
    assert.deepEqual(browserOutput, vector.expectedOutput, `browser: ${vector.name}`);
    assert.deepEqual(nodeOutput, vector.expectedOutput, `node: ${vector.name}`);
    assert.deepEqual(browserOutput, nodeOutput, `cross-platform: ${vector.name}`);
  }
});

test("unknown action and dangerous undeclared parameters fail closed", async () => {
  const executor = new ActionExecutor();
  await assert.rejects(executor.execute("builtin.utilities.missing", {}), (error) => error.code === "UNKNOWN_ACTION");
  await assert.rejects(
    executor.execute("builtin.utilities.json", {
      operation: "format",
      text: "{}",
      command: "powershell -Command calc",
      path: "../../secret",
    }),
    (error) => error.code === "INPUT_INVALID" && error.issues.length === 2,
  );
});

test("invalid JSON and invalid Base64 do not expose sensitive input", async () => {
  const executor = new ActionExecutor();
  for (const [actionId, input] of [
    ["builtin.utilities.json", { operation: "format", text: "SECRET_{" }],
    ["builtin.utilities.base64", { operation: "decode", text: "SECRET_!!!" }],
  ]) {
    await assert.rejects(executor.execute(actionId, input), (error) => {
      assert.equal(error.code, "INPUT_INVALID");
      assert.ok(!JSON.stringify(error).includes("SECRET_"));
      assert.ok(!JSON.stringify(error.receipt).includes("SECRET_"));
      return true;
    });
  }
});

test("input and output byte limits are enforced", async () => {
  const executor = new ActionExecutor();
  await assert.rejects(
    executor.execute("builtin.utilities.base64", { operation: "encode", text: "x".repeat(1048576) }),
    (error) => error.code === "INPUT_TOO_LARGE",
  );

  const descriptor = structuredClone(JSON_DESCRIPTOR);
  descriptor.actionId = "local.test.large-output";
  descriptor.source.kind = "local";
  descriptor.source.toolId = "local.test";
  descriptor.execution.handler = descriptor.actionId;
  descriptor.execution.maxOutputBytes = 16;
  const registry = new ActionRegistry([{ descriptor, handler: async () => ({ text: "x".repeat(32) }) }]);
  await assert.rejects(
    new ActionExecutor(registry).execute(descriptor.actionId, { operation: "format", text: "{}" }),
    (error) => error.code === "OUTPUT_TOO_LARGE",
  );
});

test("timeouts and cancellation map to stable errors", async () => {
  const descriptor = structuredClone(JSON_DESCRIPTOR);
  descriptor.actionId = "local.test.wait";
  descriptor.source.kind = "local";
  descriptor.source.toolId = "local.test";
  descriptor.execution.handler = descriptor.actionId;
  descriptor.execution.timeoutMs = 20;
  descriptor.execution.supportsCancellation = true;
  const registry = new ActionRegistry([{ descriptor, handler: () => new Promise(() => {}) }]);
  const executor = new ActionExecutor(registry);
  await assert.rejects(executor.execute(descriptor.actionId, { operation: "format", text: "{}" }), (error) => error.code === "TIMEOUT");

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(executor.execute(descriptor.actionId, { operation: "format", text: "{}" }, { signal: controller.signal }), (error) => error.code === "CANCELLED");
});

test("permission and confirmation gates run before handlers", async () => {
  const descriptor = structuredClone(JSON_DESCRIPTOR);
  descriptor.actionId = "local.test.gated";
  descriptor.source.kind = "local";
  descriptor.source.toolId = "local.test";
  descriptor.execution.mode = "host";
  descriptor.execution.handler = descriptor.actionId;
  descriptor.permissions.required = ["fs.read.user-selected"];
  descriptor.behavior.requiresConfirmation = true;
  const registry = new ActionRegistry([{ descriptor, handler: async () => assert.fail("handler must not run") }]);
  const executor = new ActionExecutor(registry);
  await assert.rejects(executor.execute(descriptor.actionId, { operation: "format", text: "{}" }), (error) => error.code === "CONFIRMATION_REQUIRED");
  await assert.rejects(executor.execute(descriptor.actionId, { operation: "format", text: "{}" }, { confirmed: true }), (error) => error.code === "PERMISSION_DENIED");
});

test("successful receipts contain provenance but never input/output", async () => {
  const result = await new ActionExecutor().execute("builtin.utilities.hash", { algorithm: "SHA-256", text: "TOP_SECRET" });
  assert.equal(result.receipt.status, "success");
  assert.equal(result.receipt.source.digest.length, 64);
  assert.equal(result.receipt.actionVersion, "1.0.0");
  assert.ok(!JSON.stringify(result.receipt).includes("TOP_SECRET"));
  assert.ok(!("input" in result.receipt));
  assert.ok(!("output" in result.receipt));
});
