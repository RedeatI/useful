import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { evaluateCurrentReleaseDocumentation } from "./check-version-drift.mjs";

const VERSION = "0.1.0-beta.10";
const DOCUMENTS = [
  "docs/BETA-FEEDBACK.md",
  "docs/BETA-UPGRADE-ROLLBACK.md",
  "docs/KNOWN-LIMITATIONS.md",
  "docs/KNOWN-LIMITATIONS.en.md",
  "docs/OPEN-SOURCE-REMAINING-GATES.md",
  "docs/OWNER-SIGNING-GATE-CHECKLIST.md",
  "docs/OWNER-WINDOWS-CODE-SIGN-GUIDE.zh-CN.md",
  "docs/releases/0.1.0-beta.10.md",
];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "useful-version-docs-"));
  const common = `https://github.com/RedeatI/useful/releases/tag/v${VERSION}\n`;
  for (const relative of DOCUMENTS) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    const assets = relative === "docs/BETA-UPGRADE-ROLLBACK.md"
      ? `Useful-${VERSION}-windows-x64-portable-lite.zip\nUseful-${VERSION}-windows-x64-setup-lite.exe\nSHA256SUMS.txt\n`
      : "";
    await writeFile(absolute, common + assets, "utf8");
  }
  return root;
}

test("current public release documentation matches the product version", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await evaluateCurrentReleaseDocumentation({ repoRoot: root, expected: VERSION });
  assert.equal(result.ok, true);
  assert.equal(result.files.length, DOCUMENTS.length);
  assert.deepEqual(result.failures, []);
});

test("a stale current-release document fails closed with path and field", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, "docs/BETA-FEEDBACK.md"),
    "https://github.com/RedeatI/useful/releases/tag/v0.1.0-beta.4\n",
    "utf8",
  );

  const result = await evaluateCurrentReleaseDocumentation({ repoRoot: root, expected: VERSION });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failures, [{
    code: "current-release-documentation-missing",
    path: "docs/BETA-FEEDBACK.md",
    field: "releaseTag",
  }]);
});

test("a missing current release note fails closed without throwing", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await rm(path.join(root, `docs/releases/${VERSION}.md`));

  const result = await evaluateCurrentReleaseDocumentation({ repoRoot: root, expected: VERSION });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failures, [{
    code: "current-release-documentation-file-missing",
    path: `docs/releases/${VERSION}.md`,
  }]);
});
