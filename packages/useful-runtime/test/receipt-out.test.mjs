import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { main } from "../bin/useful-runtime.mjs";

async function runMain(args, input) {
  let stdout = "";
  const exitCode = await main(args, {
    stdin: Readable.from([input]),
    stdout: { write(chunk) { stdout += chunk; } },
  });
  return { exitCode, stdout, json: JSON.parse(stdout) };
}

test("actions run writes a v2 receipt only for explicit --receipt-out and never overwrites", async () => {
  const directory = await mkdtemp(join(tmpdir(), "useful-runtime-receipt-"));
  try {
    const destination = join(directory, "run.receipt.json");
    const first = await runMain(
      ["actions", "run", "builtin.utilities.hash", "--output", "json", "--receipt-out", destination],
      JSON.stringify({ algorithm: "SHA-256", text: "TOP_SECRET_RECEIPT_INPUT" }),
    );
    assert.equal(first.exitCode, 0, first.stdout);
    const persisted = JSON.parse(await readFile(destination, "utf8"));
    assert.deepEqual(persisted, first.json.receipt);
    assert.equal(persisted.receiptVersion, "2.0");
    assert.equal(JSON.stringify(persisted).includes("TOP_SECRET"), false);
    if (process.platform !== "win32") assert.equal((await stat(destination)).mode & 0o777, 0o600);

    await writeFile(destination, "DO_NOT_OVERWRITE", "utf8");
    const existing = await runMain(
      ["actions", "run", "builtin.utilities.hash", "--output", "json", "--receipt-out", destination],
      JSON.stringify({ algorithm: "SHA-256", text: "abc" }),
    );
    assert.equal(existing.exitCode, 2);
    assert.equal(existing.json.error.code, "RECEIPT_OUTPUT_EXISTS");
    assert.equal(await readFile(destination, "utf8"), "DO_NOT_OVERWRITE");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("--receipt-out persists stable failure metadata without secret input or cause", async () => {
  const directory = await mkdtemp(join(tmpdir(), "useful-runtime-error-receipt-"));
  try {
    const destination = join(directory, "failed.receipt.json");
    const result = await runMain(
      ["actions", "run", "builtin.utilities.json", "--output", "json", "--receipt-out", destination],
      JSON.stringify({ operation: "format", text: "TOP_SECRET_{" }),
    );
    assert.equal(result.exitCode, 2);
    assert.equal(result.json.error.code, "INPUT_INVALID");
    const persisted = JSON.parse(await readFile(destination, "utf8"));
    assert.equal(persisted.status, "error");
    assert.deepEqual(persisted.error, { code: "INPUT_INVALID" });
    assert.equal(JSON.stringify(persisted).includes("TOP_SECRET"), false);
    assert.equal("cause" in persisted, false);
    assert.equal("stack" in persisted, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
