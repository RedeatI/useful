import assert from "node:assert/strict";
import { test } from "node:test";
import { ActionExecutor } from "../src/index.mjs";
import { runBrowserAction, runColorAction } from "../src/browser.mjs";

const vectors = [
  {
    input: { hex: "#f00" },
    output: { hex: "#ff0000", rgb: { r: 255, g: 0, b: 0 }, hsl: { h: 0, s: 100, l: 50 } },
  },
  {
    input: { hex: "#3b82f6" },
    output: { hex: "#3b82f6", rgb: { r: 59, g: 130, b: 246 }, hsl: { h: 217, s: 91, l: 60 } },
  },
];

test("typed color browser adapter stays byte-for-byte aligned with the canonical Action", async () => {
  const executor = new ActionExecutor();
  for (const vector of vectors) {
    const typed = runColorAction(vector.input);
    const browser = await runBrowserAction("builtin.utilities.color", vector.input);
    const runtime = await executor.execute("builtin.utilities.color", vector.input);
    assert.deepEqual(typed, vector.output);
    assert.deepEqual(browser, vector.output);
    assert.deepEqual(runtime.output, vector.output);
  }
});

test("typed color adapter keeps the canonical closed HEX-only input boundary", () => {
  for (const hex of ["", "red", "rgb(255 0 0)", "hsl(0 100% 50%)", "#ff000080"]) {
    assert.throws(
      () => runColorAction({ hex }),
      (error) => error.actionCode === "INPUT_INVALID",
      hex,
    );
  }
});
