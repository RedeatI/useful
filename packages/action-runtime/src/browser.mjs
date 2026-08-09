import {
  ACTION_IDS,
  ERROR_CODES,
  HASH_ALGORITHMS,
  assertHashInput,
  base64Handler,
  createBuiltinDescriptors,
  digestToHex,
  jsonHandler,
} from "./semantics.mjs";
import { createAdditionalBuiltinDescriptors, createAdditionalBuiltinHandlers } from "./utility-actions.mjs";
import { createOfficeActionDescriptors, createOfficeActionHandlers, OFFICE_ACTION_IDS } from "./office-actions.mjs";
export { ACTION_SUGGEST_LIMITS, suggestActions } from "./action-suggest.mjs";

export {
  ACTION_IDS,
  ERROR_CODES,
  HASH_ALGORITHMS,
  OFFICE_ACTION_IDS,
  createBuiltinDescriptors,
  createAdditionalBuiltinDescriptors,
  createOfficeActionDescriptors,
};

// Browser presentation uses the exact shared descriptor semantics. The all-zero digest is
// an explicit non-trust UI placeholder; signed/runtime provenance remains Node-owned and
// Agent profiles deliberately do not pin source.digest.
export const BUILTIN_ACTION_DESCRIPTORS = Object.freeze(
  [
    ...Object.values(createBuiltinDescriptors("0".repeat(64))),
    ...Object.values(createAdditionalBuiltinDescriptors("0".repeat(64))),
    ...Object.values(createOfficeActionDescriptors("0".repeat(64))),
  ].map((descriptor) => Object.freeze(descriptor)),
);

export function createBrowserActionHandlers(options = {}) {
  const crypto = options.crypto ?? globalThis.crypto;
  return Object.freeze({
    [ACTION_IDS.JSON]: jsonHandler,
    [ACTION_IDS.BASE64]: base64Handler,
    [ACTION_IDS.HASH]: (input) => runHashAction(input, { subtle: options.subtle ?? crypto?.subtle }),
    ...createAdditionalBuiltinHandlers({
      crypto,
      regex: options.regex,
    }),
    ...createOfficeActionHandlers(options.office),
  });
}

export function runJsonAction(input) {
  return jsonHandler(input);
}

export function runBase64Action(input) {
  return base64Handler(input);
}

export async function runHashAction(input, options = {}) {
  assertHashInput(input);
  const subtle = options.subtle ?? globalThis.crypto?.subtle;
  if (!subtle) {
    const error = new Error("当前浏览器不支持 Web Crypto");
    error.actionCode = ERROR_CODES.ACTION_FAILED;
    throw error;
  }
  const bytes = new TextEncoder().encode(input.text);
  const digest = await subtle.digest(input.algorithm, bytes);
  return { algorithm: input.algorithm, digest: digestToHex(digest), encoding: "hex" };
}

// This is the narrow GUI adapter. It intentionally does not include the Node executor,
// receipt clock, or provenance file I/O in the browser graph.
export function runBrowserAction(actionId, input, options) {
  const handler = createBrowserActionHandlers(options)[actionId];
  if (handler) return handler(input, { signal: options?.signal });
  const error = new Error("未知 action");
  error.actionCode = ERROR_CODES.UNKNOWN_ACTION;
  throw error;
}
