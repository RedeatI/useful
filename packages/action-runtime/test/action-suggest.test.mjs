import assert from "node:assert/strict";
import test from "node:test";
import { ActionRegistry, suggestActions } from "../src/index.mjs";

test("content suggestions are deterministic, compact, and never echo the sample", () => {
  const registry = new ActionRegistry();
  const sample = '{"secret":"DO_NOT_ECHO"}';
  const result = registry.suggest(sample, { limit: 5 });
  assert.equal(result.suggestions[0].actionId, "builtin.utilities.json");
  assert.ok(result.suggestions.some((entry) => entry.actionId === "builtin.utilities.data-format"));
  assert.equal(JSON.stringify(result).includes("DO_NOT_ECHO"), false);
  assert.deepEqual(result, registry.suggest(sample, { limit: 5 }));
});

test("suggestions detect common structured inputs and respect the supplied descriptor set", () => {
  const descriptors = new ActionRegistry().listAgentEligible();
  const cases = [
    ["eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.", "builtin.utilities.jwt"],
    ["192.168.1.10/24", "builtin.utilities.ipv4"],
    ["name,age\nAda,36", "builtin.office.spreadsheet"],
    ["# Heading\n\n- item", "builtin.office.markdown"],
    ["<p>local text</p>", "builtin.utilities.html"],
    ["&lt;encoded&gt;", "builtin.utilities.html"],
  ];
  for (const [sample, expected] of cases) {
    assert.equal(suggestActions(descriptors, sample, { limit: 1 }).suggestions[0].actionId, expected);
  }

  const jsonOnly = descriptors.filter((descriptor) => descriptor.actionId === "builtin.utilities.json");
  assert.deepEqual(
    suggestActions(jsonOnly, '{"a":1}').suggestions.map((entry) => entry.actionId),
    ["builtin.utilities.json"],
  );
});

test("suggestions reject open-ended options and oversized samples", () => {
  const descriptors = new ActionRegistry().listAgentEligible();
  for (const [text, options] of [
    ["text", { limit: 0 }],
    ["text", { minimumScore: 1001 }],
    ["text", { detector: "eval" }],
    ["x".repeat(65537), {}],
  ]) {
    assert.throws(
      () => suggestActions(descriptors, text, options),
      (error) => error.code === "ACTION_SUGGEST_INVALID",
    );
  }
});
