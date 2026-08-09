import { parentPort } from "node:worker_threads";

if (!parentPort) throw new Error("REGEX_WORKER_CHANNEL_MISSING");

function execute(input) {
  if (input.operation === "replace") {
    return { text: input.text.replace(new RegExp(input.pattern, input.flags), input.replacement) };
  }
  const flags = input.flags.includes("g") ? input.flags : `${input.flags}g`;
  const expression = new RegExp(input.pattern, flags);
  const matches = [];
  let match;
  while ((match = expression.exec(input.text)) !== null) {
    matches.push({ index: match.index, match: match[0], groups: match.slice(1).map((value) => value ?? "") });
    if (matches.length > 10000) throw new RangeError("REGEX_MATCH_LIMIT");
    if (match.index === expression.lastIndex) expression.lastIndex += 1;
  }
  return { matches };
}

parentPort.once("message", (input) => {
  try {
    parentPort.postMessage({ ok: true, output: execute(input) });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      code: error instanceof SyntaxError ? "INPUT_INVALID" : error instanceof RangeError ? "OUTPUT_TOO_LARGE" : "ACTION_FAILED",
    });
  }
});
