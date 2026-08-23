import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/useful-runtime.mjs", import.meta.url));

function run(args, input) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    input,
    encoding: "utf8",
    windowsHide: true,
  });
  return { ...result, json: JSON.parse(result.stdout) };
}

test("runtime CLI keeps the canonical color output and 36-action closure", () => {
  const list = run(["actions", "list", "--json"]);
  assert.equal(list.status, 0, list.stderr);
  assert.equal(list.json.actions.length, 36);

  const result = run(
    ["actions", "run", "builtin.utilities.color", "--output", "json"],
    JSON.stringify({ hex: "#3b82f6" }),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(result.json.output, {
    hex: "#3b82f6",
    rgb: { r: 59, g: 130, b: 246 },
    hsl: { h: 217, s: 91, l: 60 },
  });

  const overlong = run(
    ["actions", "run", "builtin.utilities.color", "--output", "json"],
    JSON.stringify({ hex: `${" ".repeat(17)}#f00` }),
  );
  assert.notEqual(overlong.status, 0);
  assert.equal(overlong.json.error.code, "INPUT_INVALID");
});
