import { createHash } from "node:crypto";

export const PINNED_LICENSE_FILE_SHA256 = Object.freeze({
  "LICENSE": "81891db472dffbe31e5d2e702d47fa5a1025a64bbf19a3dd07ec67d889787f83",
  "LICENSES.md": "817439ec0ecfb399ab14e97e384f6a14f99b9a783b7a43b1e15cf6f8e7a2ad88",
  "NOTICE": "73a27320bda0ef82a656225c24d1dfcec6509f8273867d014daa9ca56e160d29",
  "THIRD_PARTY_NOTICES.md": "f4ea4ba7c2c1465df21102d177681e9072f746befc332f72914b7dfd13ec51a5",
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
