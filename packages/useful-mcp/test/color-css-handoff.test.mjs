import assert from "node:assert/strict";
import { test } from "node:test";
import { ActionExecutor, ActionRegistry } from "@useful/action-runtime";
import { createActionToolHandler, DISCOVERY_TOOL_NAMES } from "../src/server.mjs";

test("in-process MCP color tool preserves output and the 36 plus 4 closed surface", async () => {
  const registry = new ActionRegistry();
  assert.equal(registry.listAgentEligible().length, 36);
  assert.equal(registry.listAgentEligible().length + Object.keys(DISCOVERY_TOOL_NAMES).length, 40);

  const actionId = "builtin.utilities.color";
  const handler = createActionToolHandler(
    actionId,
    new ActionExecutor(registry),
    undefined,
    registry.describe(actionId),
  );
  const result = await handler({ hex: "#3b82f6" });
  const output = {
    hex: "#3b82f6",
    rgb: { r: 59, g: 130, b: 246 },
    hsl: { h: 217, s: 91, l: 60 },
  };
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, output);
  assert.equal(result.content[0].text, JSON.stringify(output));
});

test("in-process MCP color tool rejects non-HEX expansion", async () => {
  const registry = new ActionRegistry();
  const result = await createActionToolHandler(
    "builtin.utilities.color",
    new ActionExecutor(registry),
  )({ hex: "rgb(59 130 246)" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /INPUT_INVALID/);
});
