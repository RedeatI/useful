import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ACTION_IDS,
  BUILTIN_ACTION_DESCRIPTORS,
  OFFICE_ACTION_IDS,
  runBrowserAction,
} from "@useful/action-runtime/browser";

const cli = fileURLToPath(new URL("../bin/useful-runtime.mjs", import.meta.url));
const EXPECTED_DEFAULT_ACTION_IDS = Object.freeze([
  ...Object.values(ACTION_IDS),
  ...Object.values(OFFICE_ACTION_IDS),
].sort());

function runRaw(args, input) {
  return spawnSync(process.execPath, [cli, ...args], {
    input,
    encoding: "utf8",
    windowsHide: true,
  });
}

function run(args, input) {
  const result = runRaw(args, input);
  return { ...result, json: JSON.parse(result.stdout) };
}

test("actions list emits one stable JSON document and no stderr logs", () => {
  const result = run(["actions", "list", "--json"]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.json.protocolVersion, "1.0");
  assert.equal(result.json.operation, "actions.list");
  assert.equal(EXPECTED_DEFAULT_ACTION_IDS.length, 36);
  assert.equal(result.json.actions.length, 36);
  assert.deepEqual(
    result.json.actions.map((action) => action.actionId),
    EXPECTED_DEFAULT_ACTION_IDS,
    "default list order is ascending actionId",
  );
});

test("actions search with an empty query returns all default actions in actionId order", () => {
  const result = run(["actions", "search", "--json"]);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stderr, "");
  assert.equal(result.json.operation, "actions.search");
  assert.equal(result.json.actions.length, 36);
  assert.deepEqual(
    result.json.actions.map((action) => action.actionId),
    EXPECTED_DEFAULT_ACTION_IDS,
    "default empty search order is ascending actionId",
  );
  assert.equal(result.json.nextCursor, undefined);
});

test("actions search supports deterministic relevance, filters, ordering, and cursor pagination", () => {
  const first = run([
    "actions", "search",
    "--query", "sha digest",
    "--source", "builtin",
    "--read-only", "true",
    "--sort", "relevance",
    "--limit", "1",
    "--json",
  ]);
  assert.equal(first.status, 0, first.stdout);
  assert.equal(first.stderr, "");
  assert.equal(first.json.operation, "actions.search");
  assert.equal(first.json.actions[0].actionId, "builtin.utilities.hash");
  if (first.json.nextCursor) {
    const next = run([
      "actions", "search",
      "--query", "sha digest",
      "--source", "builtin",
      "--read-only", "true",
      "--sort", "relevance",
      "--limit", "1",
      "--cursor", first.json.nextCursor,
      "--json",
    ]);
    assert.equal(next.status, 0, next.stdout);
    assert.notEqual(next.json.actions[0]?.actionId, first.json.actions[0].actionId);
  }

  const ordered = run(["actions", "search", "--sort", "title", "--direction", "desc", "--limit", "100", "--json"]);
  assert.equal(ordered.status, 0, ordered.stdout);
  assert.equal(ordered.json.actions.length, 36);
  assert.equal(new Set(ordered.json.actions.map((action) => action.actionId)).size, ordered.json.actions.length);
});

test("actions search rejects open-ended query syntax and invalid cursors", () => {
  for (const args of [
    ["actions", "search", "--sort", "expression", "--json"],
    ["actions", "search", "--limit", "0", "--json"],
    ["actions", "search", "--cursor", "../../secret", "--json"],
    ["actions", "search", "--unknown", "value", "--json"],
  ]) {
    const result = run(args);
    assert.equal(result.status, 2, result.stdout);
    assert.ok(["USAGE", "ACTION_QUERY_INVALID"].includes(result.json.error.code));
    assert.ok(!result.stdout.includes("../../secret"));
  }
});

test("actions suggest detects explicit content without echoing it", () => {
  const secret = '{"secret":"DO_NOT_ECHO"}';
  const result = run(["actions", "suggest", "--limit", "3", "--json"], secret);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stderr, "");
  assert.equal(result.json.operation, "actions.suggest");
  assert.equal(result.json.suggestions[0].actionId, "builtin.utilities.json");
  assert.ok(result.json.suggestions.some((entry) => entry.actionId === "builtin.utilities.data-format"));
  assert.equal(result.stdout.includes("DO_NOT_ECHO"), false);

  const invalid = run(["actions", "suggest", "--minimum-score", "1001", "--json"], "text");
  assert.equal(invalid.status, 2);
  assert.equal(invalid.json.error.code, "USAGE");
});

test("actions recipe validates and runs an ordered bounded workflow", () => {
  const recipe = {
    schemaVersion: "useful.action-recipe.v1",
    input: { source: "{ \"a\": 1 }" },
    steps: [
      { id: "minify", actionId: "builtin.utilities.json", input: { operation: "minify", text: { $ref: "/input/source" } } },
      { id: "encode", actionId: "builtin.utilities.base64", input: { operation: "encode", text: { $ref: "/steps/minify/output/text" } } },
    ],
    output: { encoded: { $ref: "/steps/encode/output/text" } },
  };
  const validated = run(["actions", "recipe", "--validate-only", "--output", "json"], JSON.stringify(recipe));
  assert.equal(validated.status, 0, validated.stdout);
  assert.equal(validated.json.operation, "actions.recipe.validate");
  assert.deepEqual(validated.json.steps.map((step) => step.id), ["minify", "encode"]);

  const executed = run(["actions", "recipe", "--output", "json"], JSON.stringify(recipe));
  assert.equal(executed.status, 0, executed.stdout);
  assert.equal(executed.json.operation, "actions.recipe.run");
  assert.deepEqual(executed.json.output, { encoded: "eyJhIjoxfQ==" });
  assert.ok(executed.json.steps.every((step) => step.receipt.status === "success"));
});

test("actions recipe cannot bypass deterministic-action or profile policy", async () => {
  const randomRecipe = {
    schemaVersion: "useful.action-recipe.v1",
    steps: [{ id: "random", actionId: "builtin.utilities.random-number", input: { min: 1, max: 6, count: 1 } }],
    output: { $ref: "/steps/random/output" },
  };
  const denied = run(["actions", "recipe", "--output", "json"], JSON.stringify(randomRecipe));
  assert.equal(denied.status, 4);
  assert.equal(denied.json.error.code, "ACTION_RECIPE_ACTION_NOT_ALLOWED");

  const directory = await mkdtemp(join(tmpdir(), "useful-recipe-profile-"));
  try {
    const profilePath = join(directory, "profile.json");
    await writeFile(profilePath, JSON.stringify({
      schemaVersion: "useful.agent-profile.v1",
      profileId: "recipe-test",
      name: "Recipe test",
      actions: [{
        actionId: "builtin.utilities.json",
        expectedContractVersion: "1.0",
        expectedActionVersion: "1.0.0",
        expectedSourceKind: "builtin",
        expectedPublisherId: "useful.project",
        enabled: { cli: true, mcp: false },
        aliases: [],
        presets: [],
      }],
    }), "utf8");
    const hidden = run([
      "--agent-profile", profilePath,
      "actions", "recipe", "--validate-only", "--output", "json",
    ], JSON.stringify({
      schemaVersion: "useful.action-recipe.v1",
      steps: [{ id: "encode", actionId: "builtin.utilities.base64", input: { operation: "encode", text: "x" } }],
      output: { $ref: "/steps/encode/output" },
    }));
    assert.equal(hidden.status, 3);
    assert.equal(hidden.json.error.code, "ACTION_RECIPE_UNKNOWN_ACTION");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("actions describe returns the full versioned descriptor", () => {
  const result = run(["actions", "describe", "builtin.utilities.json", "--json"]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.json.action.contractVersion, "1.0");
  assert.equal(result.json.action.inputSchema.additionalProperties, false);
});

test("actions run accepts stdin JSON and keeps results on stdout", () => {
  const result = run(
    ["actions", "run", "builtin.utilities.hash", "--output", "json"],
    JSON.stringify({ algorithm: "SHA-256", text: "abc" }),
  );
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.json.ok, true);
  assert.equal(result.json.output.digest, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(result.json.receipt.status, "success");
});

test("actions run plain writes only formatted output and still persists receipts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "useful-runtime-plain-"));
  try {
    const receipt = join(directory, "receipt.json");
    const result = runRaw(
      ["actions", "run", "builtin.utilities.base64", "--output", "plain", "--receipt-out", receipt],
      JSON.stringify({ operation: "encode", text: "Man" }),
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, '{\n  "text": "TWFu"\n}\n');
    assert.ok(!result.stdout.includes("receipt"));
    assert.equal(JSON.parse(await readFile(receipt, "utf8")).status, "success");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("actions run rejects unknown output modes and keeps plain errors as JSON", () => {
  const invalid = run(
    ["actions", "run", "builtin.utilities.base64", "--output", "text"],
    JSON.stringify({ operation: "encode", text: "Man" }),
  );
  assert.equal(invalid.status, 2);
  assert.equal(invalid.json.error.code, "USAGE");

  const failed = run(["actions", "run", "missing.action", "--output", "plain"], "{}");
  assert.equal(failed.status, 3);
  assert.equal(failed.json.error.code, "UNKNOWN_ACTION");
});

test("GUI browser adapter and runtime CLI consume the same utility vectors", async () => {
  const descriptors = BUILTIN_ACTION_DESCRIPTORS.filter(
    (descriptor) => descriptor.source.toolId === "builtin.utilities",
  );
  assert.equal(descriptors.length, 31);
  for (const descriptor of descriptors) {
    for (const vector of descriptor.testVectors) {
      const cliResult = run(
        ["actions", "run", descriptor.actionId, "--output", "json"],
        JSON.stringify(vector.input),
      );
      if (vector.expectedOutput) {
        const browserOutput = await runBrowserAction(descriptor.actionId, vector.input, {
          regex: async (input) => {
            const expression = new RegExp(input.pattern, input.flags);
            if (input.operation === "replace") {
              return { text: input.text.replace(expression, input.replacement ?? "") };
            }
            const match = expression.exec(input.text);
            return { matches: match ? [{ index: match.index, match: match[0], groups: match.slice(1).map((value) => value ?? "") }] : [] };
          },
        });
        assert.equal(cliResult.status, 0, `${descriptor.actionId}: ${vector.name}`);
        assert.deepEqual(browserOutput, vector.expectedOutput, `GUI adapter: ${descriptor.actionId}: ${vector.name}`);
        assert.deepEqual(cliResult.json.output, browserOutput, `CLI parity: ${descriptor.actionId}: ${vector.name}`);
      } else {
        await assert.rejects(
          Promise.resolve().then(() => runBrowserAction(descriptor.actionId, vector.input, {
            regex: async () => { throw Object.assign(new Error("invalid regex"), { actionCode: "INPUT_INVALID" }); },
          })),
          (error) => error.actionCode === vector.expectedErrorCode,
          `GUI adapter error: ${descriptor.actionId}: ${vector.name}`,
        );
        assert.equal(cliResult.status, 2, `${descriptor.actionId}: ${vector.name}`);
        assert.equal(cliResult.json.error.code, vector.expectedErrorCode, `${descriptor.actionId}: ${vector.name}`);
      }
    }
  }
});

test("actions run accepts Windows PowerShell BOM-prefixed stdin", () => {
  const result = run(
    ["actions", "run", "builtin.utilities.hash", "--output", "json"],
    `\uFEFF\uFEFF${JSON.stringify({ algorithm: "SHA-256", text: "abc" })}\r\n`,
  );
  assert.equal(result.status, 0);
  assert.equal(result.json.output.digest, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("actions run accepts @request.json", async () => {
  const directory = await mkdtemp(join(tmpdir(), "useful-runtime-"));
  try {
    const request = join(directory, "request.json");
    await writeFile(request, JSON.stringify({ operation: "encode", text: "Man" }), "utf8");
    const result = run(["actions", "run", "builtin.utilities.base64", "--input", `@${request}`, "--output", "json"]);
    assert.equal(result.status, 0);
    assert.deepEqual(result.json.output, { text: "TWFu" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unknown action has stable exit code 3", () => {
  const result = run(["actions", "describe", "missing.action", "--json"]);
  assert.equal(result.status, 3);
  assert.equal(result.stderr, "");
  assert.equal(result.json.error.code, "UNKNOWN_ACTION");
});

test("schema injection and dangerous path-shaped fields fail with exit code 2", () => {
  const result = run(
    ["actions", "run", "builtin.utilities.json", "--output", "json"],
    JSON.stringify({ operation: "format", text: "{}", command: "calc.exe", path: "../../secret" }),
  );
  assert.equal(result.status, 2);
  assert.equal(result.stderr, "");
  assert.equal(result.json.error.code, "INPUT_INVALID");
  assert.ok(!result.stdout.includes("calc.exe"));
  assert.ok(!result.stdout.includes("../../secret"));
});

test("malformed JSON and raw --input values fail without echoing secrets", () => {
  const malformed = run(["actions", "run", "builtin.utilities.json"], "SECRET_{");
  assert.equal(malformed.status, 2);
  assert.equal(malformed.json.error.code, "INPUT_INVALID");
  assert.ok(!malformed.stdout.includes("SECRET_"));

  const raw = run(["actions", "run", "builtin.utilities.json", "--input", "{\"text\":\"x\"}"]);
  assert.equal(raw.status, 2);
  assert.equal(raw.json.error.code, "USAGE");
});

test("oversized action input and arbitrary runtime flags fail closed", () => {
  const oversized = run(
    ["actions", "run", "builtin.utilities.base64", "--output", "json"],
    JSON.stringify({ operation: "encode", text: "x".repeat(1048576) }),
  );
  assert.equal(oversized.status, 6);
  assert.equal(oversized.json.error.code, "INPUT_TOO_LARGE");

  const rawFlag = run(
    ["actions", "run", "builtin.utilities.json", "--command", "calc.exe"],
    JSON.stringify({ operation: "format", text: "{}" }),
  );
  assert.equal(rawFlag.status, 2);
  assert.equal(rawFlag.json.error.code, "USAGE");
  assert.ok(!rawFlag.stdout.includes("calc.exe"));
});
