import assert from "node:assert/strict";
import test from "node:test";

import { assertActionDescriptor } from "@useful/action-contract";
import { BUILTIN_ACTIONS } from "../src/index.mjs";
import { BUILTIN_ACTION_CATALOG } from "../src/catalog.mjs";

test("every built-in Action is admitted through one closed GUI CLI MCP contract", () => {
  assert.deepEqual(
    BUILTIN_ACTIONS.map(({ descriptor }) => descriptor.actionId),
    BUILTIN_ACTION_CATALOG.map((metadata) => metadata.actionId),
    "runtime and browser-safe GUI discovery catalogs must have the same ordered closure",
  );

  for (const { descriptor, handler } of BUILTIN_ACTIONS) {
    assert.doesNotThrow(() => assertActionDescriptor(descriptor), descriptor.actionId);
    assert.equal(typeof handler, "function", `${descriptor.actionId}: CLI/MCP handler missing`);
    assert.equal(descriptor.source.kind, "builtin", descriptor.actionId);
    assert.match(descriptor.presentation.route, /^\/tools\/(?:utilities|office)\//, descriptor.actionId);
    assert.equal(descriptor.inputSchema.additionalProperties, false, `${descriptor.actionId}: open input`);
    assert.equal(descriptor.outputSchema.additionalProperties, false, `${descriptor.actionId}: open output`);
    assert.ok(descriptor.testVectors.length > 0, `${descriptor.actionId}: deterministic vector missing`);
    assert.deepEqual(descriptor.permissions.required, [], `${descriptor.actionId}: default permission drift`);
    assert.deepEqual(descriptor.permissions.capabilities, [], `${descriptor.actionId}: capability drift`);
  }
});
