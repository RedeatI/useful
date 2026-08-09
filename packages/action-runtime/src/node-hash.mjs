import { createHash } from "node:crypto";
import { assertHashInput } from "./semantics.mjs";

const NODE_HASH_NAMES = Object.freeze({
  "SHA-1": "sha1",
  "SHA-256": "sha256",
  "SHA-384": "sha384",
  "SHA-512": "sha512",
});

export function nodeHashHandler(input) {
  assertHashInput(input);
  return {
    algorithm: input.algorithm,
    digest: createHash(NODE_HASH_NAMES[input.algorithm]).update(input.text, "utf8").digest("hex"),
    encoding: "hex",
  };
}
