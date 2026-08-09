import { createHash } from "node:crypto";

export const PINNED_LICENSE_FILE_SHA256 = Object.freeze({
  "LICENSE": "5a736847a35227fec61829bd26ddcaccb9b92a4520bc3d9fee6a874581e29d9c",
  "LICENSES.md": "dd71b10252a97620add1ef94f99ffe38e571dd406adaffeb874cd1dc5ad02d2e",
  "NOTICE": "36b1f666da545000b55679a01cf0e3741913f7bbc2c0b2748d0e01ce3e4d2b08",
  "THIRD_PARTY_NOTICES.md": "63bdb470e078c3059563af546012a4bd878d47169076c9d095c39ce5f71b2ec9",
  "TRADEMARKS.md": "37e0f83ee290e08004a1f8b1d330088def08282575c491a6497444842a34a89b",
  "licenses/README.md": "258edc2a7e080f82b80dfc5e4706452a41e7ade017b9e805468ad6dbc828b2fb",
  "licenses/MPL-2.0.txt": "3f3d9e0024b1921b067d6f7f88deb4a60cbe7a78e76c64e3f1d7fc3b779b9d04",
  "licenses/Apache-2.0.txt": "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
  "licenses/AGPL-3.0-or-later.txt": "0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0",
  "licenses/CC-BY-4.0.txt": "9e5f1b3c610b9c2da5c313bf81d577a7d1acec686bdb0384edefa6df0f90cd94",
  "services/source-server/LICENSE": "71ee6c4ea30975c1bd8ffdd04ff5e9f9760dc39a5dc6011c22bb83da49012540",
  "services/source-worker/LICENSE": "71ee6c4ea30975c1bd8ffdd04ff5e9f9760dc39a5dc6011c22bb83da49012540",
});

export function normalizeLegalTextBytes(bytes) {
  return Buffer.from(Buffer.from(bytes).toString("utf8").replace(/\r\n?/g, "\n"), "utf8");
}

export function digestLegalTextBytes(bytes) {
  return createHash("sha256").update(normalizeLegalTextBytes(bytes)).digest("hex");
}
