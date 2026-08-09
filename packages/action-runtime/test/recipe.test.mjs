import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTION_RECIPE_SCHEMA_VERSION,
  ActionExecutionError,
  ActionExecutor,
  ActionRegistry,
  ERROR_CODES,
  runActionRecipe,
  validateActionRecipe,
} from "../src/index.mjs";

function sampleRecipe() {
  return {
    schemaVersion: ACTION_RECIPE_SCHEMA_VERSION,
    input: { source: "{ \"a\": 1 }" },
    steps: [
      {
        id: "minify",
        actionId: "builtin.utilities.json",
        input: { operation: "minify", text: { $ref: "/input/source" } },
      },
      {
        id: "encode",
        actionId: "builtin.utilities.base64",
        input: { operation: "encode", text: { $ref: "/steps/minify/output/text" } },
      },
    ],
    output: {
      encoded: { $ref: "/steps/encode/output/text" },
    },
  };
}

test("recipe validation and execution preserve order and step receipts", async () => {
  const registry = new ActionRegistry();
  const validation = validateActionRecipe(sampleRecipe(), registry);
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.steps.map((step) => step.id), ["minify", "encode"]);

  const result = await runActionRecipe(sampleRecipe(), {
    registry,
    executor: new ActionExecutor(registry),
  });
  assert.deepEqual(result.output, { encoded: "eyJhIjoxfQ==" });
  assert.deepEqual(result.steps.map((step) => step.id), ["minify", "encode"]);
  assert.ok(result.steps.every((step) => step.receipt.status === "success"));
});

test("recipe execution is limited to exposed deterministic no-permission actions", async () => {
  const full = new ActionRegistry();
  const jsonEntry = full.resolve("builtin.utilities.json");
  const filtered = new ActionRegistry([jsonEntry]);
  const unknown = sampleRecipe();
  assert.throws(
    () => validateActionRecipe(unknown, filtered),
    (error) => error.code === "ACTION_RECIPE_UNKNOWN_ACTION",
  );

  const random = sampleRecipe();
  random.steps = [{ id: "random", actionId: "builtin.utilities.random-number", input: { min: 1, max: 6, count: 1 } }];
  random.output = { $ref: "/steps/random/output" };
  assert.throws(
    () => validateActionRecipe(random, full),
    (error) => error.code === "ACTION_RECIPE_ACTION_NOT_ALLOWED",
  );
});

test("recipe references and templates fail closed", () => {
  const registry = new ActionRegistry();
  const cases = [
    ["ACTION_RECIPE_FORWARD_REFERENCE", (recipe) => {
      recipe.steps[0].input.text = { $ref: "/steps/encode/output/text" };
    }],
    ["ACTION_RECIPE_INTERPOLATION_FORBIDDEN", (recipe) => {
      recipe.steps[0].input.text = "${input.source}";
    }],
    ["ACTION_RECIPE_STEP_ID_INVALID", (recipe) => {
      recipe.steps[1].id = "minify";
    }],
    ["ACTION_RECIPE_VERSION_UNSUPPORTED", (recipe) => {
      recipe.schemaVersion = "useful.action-recipe.v2";
    }],
  ];
  for (const [code, mutate] of cases) {
    const recipe = sampleRecipe();
    mutate(recipe);
    assert.throws(() => validateActionRecipe(recipe, registry), (error) => error.code === code);
  }
});

test("recipe input must remain exact JSON data", () => {
  const registry = new ActionRegistry();
  const cases = [
    { source: undefined },
    new Date("2026-01-01T00:00:00.000Z"),
    JSON.parse('{"__proto__":{"polluted":true}}'),
  ];
  for (const input of cases) {
    const recipe = sampleRecipe();
    recipe.input = input;
    assert.throws(
      () => validateActionRecipe(recipe, registry),
      (error) => ["ACTION_RECIPE_INVALID", "ACTION_RECIPE_FORBIDDEN_KEY"].includes(error.code),
    );
  }
});

test("recipe missing references and cancellation return stable errors", async () => {
  const registry = new ActionRegistry();
  const missing = sampleRecipe();
  missing.input = {};
  await assert.rejects(
    runActionRecipe(missing, { registry, executor: new ActionExecutor(registry) }),
    (error) => error.code === "ACTION_RECIPE_REFERENCE_MISSING",
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runActionRecipe(sampleRecipe(), { registry, executor: new ActionExecutor(registry), signal: controller.signal }),
    (error) => error instanceof ActionExecutionError && error.code === ERROR_CODES.CANCELLED,
  );
});
