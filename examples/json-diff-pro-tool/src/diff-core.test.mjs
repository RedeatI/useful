import assert from "node:assert/strict";
import test from "node:test";
import { diffJson, summarize } from "./diff-core.mjs";

test("reports deterministic path-level structural changes", () => {
  const result = diffJson(
    { name: "Useful", enabled: true, tags: ["offline", "free"], nested: { value: 1 }, gone: null },
    { name: "Useful Pro", enabled: "yes", tags: ["offline", "pro", "windows"], nested: { value: 1 }, added: 42 },
  );
  assert.deepEqual(result.changes.map(({ path, kind }) => ({ path, kind })), [
    { path: "$.added", kind: "added" },
    { path: "$.enabled", kind: "type-changed" },
    { path: "$.gone", kind: "removed" },
    { path: "$.name", kind: "changed" },
    { path: "$.tags[1]", kind: "changed" },
    { path: "$.tags[2]", kind: "added" },
  ]);
  assert.deepEqual(summarize(result.changes), { added: 2, removed: 1, changed: 2, typeChanged: 1, total: 6 });
});

test("distinguishes null, array, object, and escaped property paths", () => {
  const result = diffJson({ "a.b": null, list: [] }, { "a.b": {}, list: {} });
  assert.equal(result.changes[0].path, '$["a.b"]');
  assert.equal(result.changes[0].kind, "type-changed");
  assert.equal(result.changes[1].kind, "type-changed");
});

test("caps huge outputs and rejects excessive nesting", () => {
  const capped = diffJson({}, { a: 1, b: 2, c: 3 }, { maxChanges: 2 });
  assert.equal(capped.changes.length, 2);
  assert.equal(capped.truncated, true);
  assert.throws(() => diffJson({ a: { b: 1 } }, { a: { b: 2 } }, { maxDepth: 1 }), /嵌套超过/);
});

test("identical documents have no changes", () => {
  assert.deepEqual(diffJson({ stable: [1, true, null] }, { stable: [1, true, null] }), { changes: [], truncated: false });
});
