import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  ActionRegistry,
  ERROR_CODES,
} from "@useful/action-runtime";
import { ACTION_IDS, OFFICE_ACTION_IDS } from "@useful/action-runtime/browser";
import {
  createActionToolHandler,
  descriptorToToolMetadata,
  DISCOVERY_TOOL_NAMES,
} from "../src/server.mjs";

const entry = fileURLToPath(new URL("../bin/useful-mcp.mjs", import.meta.url));
const runtimeCli = fileURLToPath(new URL("../../useful-runtime/bin/useful-runtime.mjs", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
const expectedActionNames = Object.freeze([
  ...Object.values(ACTION_IDS),
  ...Object.values(OFFICE_ACTION_IDS),
].sort());
const expectedNames = Object.freeze([
  ...expectedActionNames,
  DISCOVERY_TOOL_NAMES.SEARCH,
  DISCOVERY_TOOL_NAMES.DESCRIBE,
  DISCOVERY_TOOL_NAMES.SUGGEST,
  DISCOVERY_TOOL_NAMES.RECIPE,
]);

function inheritedEnvironment(overrides = {}) {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
    ...overrides,
  };
}

function runtimeResult(actionId, input) {
  const result = spawnSync(
    process.execPath,
    [runtimeCli, "actions", "run", actionId, "--output", "json"],
    {
      cwd: workspaceRoot,
      input: JSON.stringify(input),
      encoding: "utf8",
      windowsHide: true,
    },
  );
  return { ...result, json: JSON.parse(result.stdout) };
}

async function connectClient(versionNegotiation) {
  const client = new Client(
    { name: "useful-mcp-test", version: "1.0.0" },
    versionNegotiation ? { versionNegotiation } : undefined,
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: workspaceRoot,
    env: inheritedEnvironment({ USEFUL_MCP_DIAGNOSTICS: "1" }),
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  await client.connect(transport);
  return {
    client,
    transport,
    stderr: () => stderr,
  };
}

function textContent(result) {
  const block = result.content.find((entry) => entry.type === "text");
  assert.ok(block, "tool result must include a text fallback");
  return block.text;
}

function assertSafeError(result, expectedCode, secrets = []) {
  assert.equal(result.isError, true);
  const text = textContent(result);
  assert.match(text, new RegExp(expectedCode));
  assert.doesNotMatch(text, /\b(?:Error:|at\s+\S+\s+\(|stack)\b/i);
  for (const secret of secrets) assert.ok(!text.includes(secret));
}

async function closeAndAssertReaped(connection) {
  const pid = connection.transport.pid;
  assert.ok(pid, "stdio child must have a pid while connected");
  await connection.client.close();
  assert.equal(connection.transport.pid, null);
}

test("registry mapping exposes every eligible descriptor", () => {
  const registry = new ActionRegistry();
  const descriptors = registry.listAgentEligible();
  assert.equal(expectedActionNames.length, 36);
  assert.deepEqual(
    descriptors.map((descriptor) => descriptor.actionId),
    expectedActionNames,
    "eligible actions are listed in ascending actionId order",
  );

  for (const descriptor of descriptors) {
    const tool = descriptorToToolMetadata(descriptor);
    assert.equal(tool.name, descriptor.actionId);
    assert.equal(tool.title, descriptor.title);
    assert.equal(tool.description, descriptor.description);
    assert.deepEqual(tool.inputSchema, descriptor.inputSchema);
    assert.deepEqual(tool.outputSchema, descriptor.outputSchema);
    assert.deepEqual(tool.annotations, {
      readOnlyHint: descriptor.behavior.readOnly,
      destructiveHint: descriptor.behavior.destructive,
      idempotentHint: descriptor.behavior.idempotent,
      openWorldHint: descriptor.behavior.openWorld,
    });
  }
});

test("tool handler forwards the SDK request abort signal and redacts unexpected failures", async () => {
  const controller = new AbortController();
  let observed;
  const handler = createActionToolHandler("builtin.utilities.json", {
    async execute(actionId, input, options) {
      observed = { actionId, input, options };
      return { output: { text: "ok" }, receipt: { ignored: true } };
    },
  });
  const result = await handler(
    { operation: "format", text: "{}" },
    { mcpReq: { signal: controller.signal } },
  );
  assert.equal(observed.actionId, "builtin.utilities.json");
  assert.equal(observed.options.signal, controller.signal);
  assert.deepEqual(result.structuredContent, { text: "ok" });
  assert.deepEqual(JSON.parse(textContent(result)), result.structuredContent);
  assert.equal("receipt" in result, false);

  const failed = await createActionToolHandler("builtin.utilities.json", {
    async execute() {
      throw new Error("TOP_SECRET_FAILURE");
    },
  })({}, { mcpReq: { signal: controller.signal } });
  assertSafeError(failed, ERROR_CODES.ACTION_FAILED, ["TOP_SECRET_FAILURE"]);
});

test("official client drives real legacy stdio tools/list and tools/call", async () => {
  const connection = await connectClient();
  try {
    assert.equal(connection.client.getProtocolEra(), "legacy");
    const listed = await connection.client.listTools();
    assert.equal(listed.tools.length, 40);
    assert.deepEqual(listed.tools.map((tool) => tool.name), expectedNames);

    const allActions = await connection.client.callTool({
      name: DISCOVERY_TOOL_NAMES.SEARCH,
      arguments: {},
    });
    assert.equal(allActions.isError, undefined);
    assert.equal(allActions.structuredContent.actions.length, 36);
    assert.deepEqual(
      allActions.structuredContent.actions.map((action) => action.actionId),
      expectedActionNames,
      "empty discovery search returns all actions in ascending actionId order",
    );
    assert.equal(allActions.structuredContent.nextCursor, undefined);
    assert.deepEqual(JSON.parse(textContent(allActions)), allActions.structuredContent);

    const searched = await connection.client.callTool({
      name: DISCOVERY_TOOL_NAMES.SEARCH,
      arguments: { query: "sha digest", sort: "relevance", limit: 10 },
    });
    assert.equal(searched.isError, undefined);
    assert.equal(searched.structuredContent.actions[0].actionId, "builtin.utilities.hash");

    const suggestionSecret = '{"secret":"TOP_SECRET_SUGGEST"}';
    const suggested = await connection.client.callTool({
      name: DISCOVERY_TOOL_NAMES.SUGGEST,
      arguments: { text: suggestionSecret, limit: 3 },
    });
    assert.equal(suggested.isError, undefined);
    assert.equal(suggested.structuredContent.suggestions[0].actionId, "builtin.utilities.json");
    assert.ok(suggested.structuredContent.suggestions.some((entry) => entry.actionId === "builtin.utilities.data-format"));
    assert.equal(textContent(suggested).includes("TOP_SECRET_SUGGEST"), false);

    const recipe = {
      schemaVersion: "useful.action-recipe.v1",
      input: { source: "{ \"a\": 1 }" },
      steps: [
        { id: "minify", actionId: "builtin.utilities.json", input: { operation: "minify", text: { $ref: "/input/source" } } },
        { id: "encode", actionId: "builtin.utilities.base64", input: { operation: "encode", text: { $ref: "/steps/minify/output/text" } } },
      ],
      output: { encoded: { $ref: "/steps/encode/output/text" } },
    };
    const recipeValidation = await connection.client.callTool({
      name: DISCOVERY_TOOL_NAMES.RECIPE,
      arguments: { operation: "validate", recipe },
    });
    assert.equal(recipeValidation.isError, undefined);
    assert.deepEqual(recipeValidation.structuredContent.steps.map((step) => step.id), ["minify", "encode"]);
    const recipeRun = await connection.client.callTool({
      name: DISCOVERY_TOOL_NAMES.RECIPE,
      arguments: { operation: "run", recipe },
    });
    assert.equal(recipeRun.isError, undefined);
    assert.deepEqual(recipeRun.structuredContent.output, { encoded: "eyJhIjoxfQ==" });

    const descriptors = new ActionRegistry().listAgentEligible();
    for (const descriptor of descriptors) {
      const listedTool = listed.tools.find((tool) => tool.name === descriptor.actionId);
      assert.ok(listedTool);
      assert.equal(listedTool.title, descriptor.title);
      assert.equal(listedTool.description, descriptor.description);
      assert.deepEqual(listedTool.inputSchema, descriptor.inputSchema);
      assert.deepEqual(listedTool.outputSchema, descriptor.outputSchema);
      assert.deepEqual(listedTool.annotations, {
        readOnlyHint: descriptor.behavior.readOnly,
        destructiveHint: descriptor.behavior.destructive,
        idempotentHint: descriptor.behavior.idempotent,
        openWorldHint: descriptor.behavior.openWorld,
      });

      const described = await connection.client.callTool({
        name: DISCOVERY_TOOL_NAMES.DESCRIBE,
        arguments: { actionId: descriptor.actionId },
      });
      assert.equal(described.isError, undefined, descriptor.actionId);
      assert.deepEqual(described.structuredContent, { action: descriptor }, descriptor.actionId);
      assert.deepEqual(JSON.parse(textContent(described)), described.structuredContent, descriptor.actionId);

      for (const vector of descriptor.testVectors) {
        const mcpResult = await connection.client.callTool({
          name: descriptor.actionId,
          arguments: vector.input,
        });
        const cliResult = runtimeResult(descriptor.actionId, vector.input);
        if (vector.expectedOutput) {
          assert.equal(mcpResult.isError, undefined, `${descriptor.actionId}: ${vector.name}`);
          assert.deepEqual(mcpResult.structuredContent, vector.expectedOutput);
          assert.deepEqual(JSON.parse(textContent(mcpResult)), vector.expectedOutput);
          assert.equal(cliResult.status, 0);
          assert.deepEqual(cliResult.json.output, vector.expectedOutput);
        } else {
          assertSafeError(mcpResult, vector.expectedErrorCode);
          assert.notEqual(cliResult.status, 0);
          assert.equal(cliResult.json.error.code, vector.expectedErrorCode);
        }
      }
    }

    const invalidOperationSecret = "TOP_SECRET_INVALID_OPERATION";
    const invalidOperation = await connection.client.callTool({
      name: "builtin.utilities.json",
      arguments: { operation: invalidOperationSecret, text: "{}" },
    });
    assertSafeError(invalidOperation, ERROR_CODES.INPUT_INVALID, [invalidOperationSecret]);

    const unknownFieldSecret = "TOP_SECRET_UNKNOWN_FIELD";
    const unknownField = await connection.client.callTool({
      name: "builtin.utilities.base64",
      arguments: { operation: "encode", text: "safe", command: unknownFieldSecret },
    });
    assertSafeError(unknownField, ERROR_CODES.INPUT_INVALID, [unknownFieldSecret]);

    const oversizedPrefix = "TOP_SECRET_OVERSIZED_";
    const oversized = await connection.client.callTool({
      name: "builtin.utilities.hash",
      arguments: {
        algorithm: "SHA-256",
        text: `${oversizedPrefix}${"x".repeat(1048576 - oversizedPrefix.length)}`,
      },
    });
    assertSafeError(oversized, ERROR_CODES.INPUT_TOO_LARGE, [oversizedPrefix]);

    const unknownToolSecret = "TOP_SECRET_UNKNOWN_TOOL";
    await assert.rejects(
      connection.client.callTool({
        name: "missing.useful.action",
        arguments: { text: unknownToolSecret },
      }),
      (error) => {
        assert.equal(error.code, -32602);
        assert.ok(!error.message.includes(unknownToolSecret));
        assert.doesNotMatch(error.message, /\b(?:Error:|at\s+\S+\s+\(|stack)\b/i);
        return true;
      },
    );

    assert.match(connection.stderr(), /useful-mcp: ready/);
    assert.ok(!connection.stderr().includes("TOP_SECRET"));
  } finally {
    await closeAndAssertReaped(connection);
  }
});

test("official v2 client pins 2026-07-28 against the same serveStdio entry", async () => {
  const connection = await connectClient({ mode: { pin: "2026-07-28" } });
  try {
    assert.equal(connection.client.getProtocolEra(), "modern");
    assert.equal(connection.client.getNegotiatedProtocolVersion(), "2026-07-28");
    const listed = await connection.client.listTools();
    assert.equal(listed.tools.length, 40);
    assert.deepEqual(listed.tools.map((tool) => tool.name), expectedNames);
    const result = await connection.client.callTool({
      name: "builtin.utilities.hash",
      arguments: { algorithm: "SHA-256", text: "abc" },
    });
    assert.deepEqual(result.structuredContent, {
      algorithm: "SHA-256",
      digest: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      encoding: "hex",
    });
    assert.deepEqual(JSON.parse(textContent(result)), result.structuredContent);
    assert.match(connection.stderr(), /useful-mcp: ready/);
  } finally {
    await closeAndAssertReaped(connection);
  }
});

test("official client cancellation and direct disconnect leave no stdio child", async () => {
  const connection = await connectClient();
  let disconnected = false;
  try {
    const controller = new AbortController();
    const cancellationSecret = "TOP_SECRET_CANCELLED_";
    const pending = connection.client.callTool(
      {
        name: "builtin.utilities.hash",
        arguments: {
          algorithm: "SHA-256",
          text: `${cancellationSecret}${"x".repeat(1048576 - cancellationSecret.length)}`,
        },
      },
      { signal: controller.signal },
    );
    controller.abort();
    await assert.rejects(pending, (error) => {
      assert.ok(!error.message.includes(cancellationSecret));
      return true;
    });

    const afterCancellation = await connection.client.callTool({
      name: "builtin.utilities.hash",
      arguments: { algorithm: "SHA-256", text: "abc" },
    });
    assert.equal(afterCancellation.isError, undefined);

    assert.ok(connection.transport.pid);
    await connection.transport.close();
    disconnected = true;
    assert.equal(connection.transport.pid, null);
  } finally {
    if (!disconnected) await closeAndAssertReaped(connection);
  }
});
