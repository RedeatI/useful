import { createHash, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { base64Handler, createBuiltinDescriptors, jsonHandler } from "./semantics.mjs";
import { nodeHashHandler } from "./node-hash.mjs";
import { nodeRegexHandler } from "./node-regex.mjs";
import { nodeOfficeHandler } from "./node-office.mjs";
import { createOfficeActionDescriptors, createOfficeActionHandlers } from "./office-actions.mjs";
import { createAdditionalBuiltinDescriptors, createAdditionalBuiltinHandlers } from "./utility-actions.mjs";

// Node development provenance remains in the Node adapter/build boundary and covers
// every source file that participates in the built-in runtime implementation.
// Agent Kit bundles define __USEFUL_AGENT_KIT__ and ship the same normalized source
// bytes under lib/provenance so a bundled file never hashes itself or a build path.
const agentKitProvenance = typeof __USEFUL_AGENT_KIT__ !== "undefined" && __USEFUL_AGENT_KIT__ === true;

function provenanceUrl(packageName, relativePath) {
  if (agentKitProvenance) {
    return new URL(`./provenance/${packageName}/${relativePath}`, import.meta.url);
  }
  return packageName === "action-runtime"
    ? new URL(relativePath, import.meta.url)
    : new URL(`../../office-core/src/${relativePath}`, import.meta.url);
}

function canonicalSourceBytes(url) {
  return Buffer.from(readFileSync(fileURLToPath(url), "utf8").replace(/\r\n?/g, "\n"), "utf8");
}

const provenance = createHash("sha256");
for (const relativePath of [
  "builtins.mjs",
  "catalog.mjs",
  "semantics.mjs",
  "node-hash.mjs",
  "node-regex.mjs",
  "regex-worker-thread.mjs",
  "utility-actions.mjs",
  "office-actions.mjs",
  "node-office.mjs",
  "office-worker-thread.mjs",
]) {
  provenance.update(relativePath).update("\0");
  provenance.update(canonicalSourceBytes(provenanceUrl("action-runtime", relativePath))).update("\0");
}
for (const relativePath of [
  "index.mjs",
  "errors.mjs",
  "limits.mjs",
  "xml.mjs",
  "zip.mjs",
  "docx.mjs",
  "pptx.mjs",
  "xlsx.mjs",
  "csv.mjs",
  "table-markdown.mjs",
  "markdown.mjs",
  "pdf.mjs",
]) {
  provenance.update(`office-core/${relativePath}`).update("\0");
  provenance.update(canonicalSourceBytes(provenanceUrl("office-core", relativePath))).update("\0");
}
const BUILTINS_SOURCE_DIGEST = provenance.digest("hex");

const descriptors = createBuiltinDescriptors(BUILTINS_SOURCE_DIGEST);
const additionalDescriptors = createAdditionalBuiltinDescriptors(BUILTINS_SOURCE_DIGEST);
const additionalHandlers = createAdditionalBuiltinHandlers({ crypto: webcrypto, regex: nodeRegexHandler });
const officeDescriptors = createOfficeActionDescriptors(BUILTINS_SOURCE_DIGEST);
const officeHandlers = createOfficeActionHandlers(nodeOfficeHandler);

export const JSON_DESCRIPTOR = descriptors.json;
export const BASE64_DESCRIPTOR = descriptors.base64;
export const HASH_DESCRIPTOR = descriptors.hash;
export const ADDITIONAL_BUILTIN_DESCRIPTORS = Object.freeze(Object.values(additionalDescriptors));
export const OFFICE_BUILTIN_DESCRIPTORS = Object.freeze(Object.values(officeDescriptors));

export { base64Handler, jsonHandler, nodeHashHandler as hashHandler };

export const BUILTIN_ACTIONS = Object.freeze([
  { descriptor: JSON_DESCRIPTOR, handler: jsonHandler },
  { descriptor: BASE64_DESCRIPTOR, handler: base64Handler },
  { descriptor: HASH_DESCRIPTOR, handler: nodeHashHandler },
  ...ADDITIONAL_BUILTIN_DESCRIPTORS.map((descriptor) => ({
    descriptor,
    handler: additionalHandlers[descriptor.actionId],
  })),
  ...OFFICE_BUILTIN_DESCRIPTORS.map((descriptor) => ({
    descriptor,
    handler: officeHandlers[descriptor.actionId],
  })),
]);
