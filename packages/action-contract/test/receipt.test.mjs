import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import {
  EXECUTION_RECEIPT_MAX_BYTES,
  EXECUTION_RECEIPT_STATUSES,
  ExecutionReceiptError,
  assertExecutionReceipt,
  parseExecutionReceipt,
  upgradeExecutionReceipt,
  validateExecutionReceipt,
} from "../src/index.mjs";

const timestamp = "2026-08-16T01:02:03.004Z";

function receipt(overrides = {}) {
  return {
    receiptVersion: "2.0",
    actionId: "builtin.utilities.hash",
    actionVersion: "1.0.0",
    contractVersion: "1.0",
    source: {
      kind: "builtin",
      toolId: "builtin.utilities",
      publisher: { id: "useful.project", name: "Useful" },
      digest: "a".repeat(64),
    },
    permissions: { required: [], capabilities: [] },
    status: "success",
    createdAt: timestamp,
    startedAt: timestamp,
    completedAt: "2026-08-16T01:02:03.009Z",
    durationMs: 5,
    ...overrides,
  };
}

test("receipt v2 schema is strict JSON Schema 2020-12 and matches the manual validator", async () => {
  const schema = JSON.parse(await readFile(new URL("../src/execution-receipt.v2.schema.json", import.meta.url), "utf8"));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  assert.equal(schema.title, "Useful Execution Receipt v2");
  assert.equal(schema.properties.receiptVersion.const, "2.0");
  assert.equal(validate(receipt()), true, JSON.stringify(validate.errors));
  assert.deepEqual(validateExecutionReceipt(receipt()), []);

  const injected = receipt({ input: { secret: "TOP_SECRET_INPUT" }, stack: "TOP_SECRET_STACK" });
  assert.equal(validate(injected), false);
  assert.ok(validate.errors?.some((entry) => entry.keyword === "additionalProperties"));
  assert.ok(validateExecutionReceipt(injected).some((entry) => entry.message === "未知字段被拒绝"));

  for (const toolId of ["/home/user/private", "C:\\Users\\private", "\\\\server\\share"]) {
    const pathBearing = receipt({ source: { ...receipt().source, toolId } });
    assert.equal(validate(pathBearing), false, toolId);
    assert.ok(validateExecutionReceipt(pathBearing).some((entry) => entry.message === "不得包含绝对路径"), toolId);
  }
});

test("all lifecycle statuses have one canonical, fail-closed field shape", () => {
  const queued = receipt({ status: "queued" });
  delete queued.startedAt;
  delete queued.completedAt;
  delete queued.durationMs;
  assert.doesNotThrow(() => assertExecutionReceipt(queued));

  const running = receipt({ status: "running" });
  delete running.completedAt;
  delete running.durationMs;
  assert.doesNotThrow(() => assertExecutionReceipt(running));

  const failed = receipt({ status: "error", error: { code: "PERMISSION_DENIED" } });
  assert.doesNotThrow(() => assertExecutionReceipt(failed));

  const cancelled = receipt({ status: "cancelled", error: { code: "CANCELLED" } });
  assert.doesNotThrow(() => assertExecutionReceipt(cancelled));
  assert.deepEqual(EXECUTION_RECEIPT_STATUSES, ["queued", "running", "success", "error", "cancelled"]);

  assert.throws(
    () => assertExecutionReceipt(receipt({ status: "success", error: { code: "ACTION_FAILED" } })),
    (error) => error.code === "RECEIPT_INVALID",
  );
  assert.throws(
    () => assertExecutionReceipt(receipt({ status: "cancelled", error: { code: "TIMEOUT" } })),
    (error) => error.code === "RECEIPT_INVALID",
  );
});

test("a strict v1 terminal receipt upgrades to canonical v2 without input or output material", () => {
  const legacy = {
    receiptVersion: "1.0",
    actionId: "builtin.utilities.hash",
    actionVersion: "1.0.0",
    contractVersion: "1.0",
    source: receipt().source,
    permissions: ["fs.read.user-selected"],
    startedAt: timestamp,
    durationMs: 5,
    status: "error",
    error: { code: "PERMISSION_DENIED" },
  };
  const upgraded = upgradeExecutionReceipt(legacy);
  assert.equal(upgraded.receiptVersion, "2.0");
  assert.deepEqual(upgraded.permissions, { required: ["fs.read.user-selected"], capabilities: [] });
  assert.equal(upgraded.createdAt, timestamp);
  assert.equal(upgraded.completedAt, "2026-08-16T01:02:03.009Z");
  assert.deepEqual(parseExecutionReceipt(JSON.stringify(legacy)), upgraded);
  assert.equal(JSON.stringify(upgraded).includes("input"), false);
  assert.equal(JSON.stringify(upgraded).includes("output"), false);
});

test("unknown, corrupt, oversized, and privacy-bearing receipts fail closed with safe codes", () => {
  const cases = [
    [JSON.stringify({ receiptVersion: "3.0" }), "RECEIPT_VERSION_UNSUPPORTED"],
    ["{", "RECEIPT_INVALID"],
    ["x".repeat(EXECUTION_RECEIPT_MAX_BYTES + 1), "RECEIPT_TOO_LARGE"],
    [JSON.stringify(receipt({ cause: "TOP_SECRET_CAUSE", inputDigest: "f".repeat(64) })), "RECEIPT_INVALID"],
    [JSON.stringify(receipt({ source: { ...receipt().source, toolId: "/home/user/private" } })), "RECEIPT_INVALID"],
  ];
  for (const [input, code] of cases) {
    assert.throws(parseExecutionReceipt.bind(undefined, input), (error) => {
      assert.ok(error instanceof ExecutionReceiptError);
      assert.equal(error.code, code);
      assert.equal(JSON.stringify(error).includes("TOP_SECRET"), false);
      assert.equal("cause" in error, false);
      return true;
    });
  }
});
