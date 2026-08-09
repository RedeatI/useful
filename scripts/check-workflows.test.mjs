import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checker = path.join(repoRoot, "scripts", "check-workflows.mjs");
const workflowFiles = [
  "ci.yml",
  "codeql.yml",
  "dependency-review.yml",
  "platform-bundles.yml",
  "release.yml",
];

async function createFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "useful-workflow-fixture-"));
  t.after(async () => rm(root, { force: true, recursive: true }));
  const workflowRoot = path.join(root, ".github", "workflows");
  await mkdir(workflowRoot, { recursive: true });
  for (const file of workflowFiles) {
    await copyFile(
      path.join(repoRoot, ".github", "workflows", file),
      path.join(workflowRoot, file),
    );
  }
  await copyFile(
    path.join(repoRoot, ".github", "dependabot.yml.example"),
    path.join(root, ".github", "dependabot.yml.example"),
  );
  return root;
}

async function mutateWorkflow(root, file, mutate) {
  const target = path.join(root, ".github", "workflows", file);
  const workflow = parse(await readFile(target, "utf8"));
  mutate(workflow);
  await writeFile(target, stringify(workflow), "utf8");
}

function runChecker(root) {
  const run = spawnSync(
    process.execPath,
    [checker, "--json", "--repo-root", root],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(run.stderr, "");
  assert.notEqual(run.stdout, "");
  return { ...run, result: JSON.parse(run.stdout) };
}

function assertViolation(run, file, code, details) {
  assert.equal(run.status, 1);
  assert.equal(run.result.ok, false);
  assert.ok(run.result.violations.some((violation) => (
    violation.file === file
      && violation.code === code
      && (details === undefined || violation.details === details)
  )), JSON.stringify(run.result.violations));
}

test("manual-only first-public fixture passes as local static evidence", async (t) => {
  const root = await createFixture(t);
  const run = runChecker(root);
  assert.equal(run.status, 0);
  assert.equal(run.result.ok, true);
  assert.equal(run.result.schemaVersion, "useful.workflow-check.v1");
  assert.equal(run.result.activationPolicy, "first-public-manual-only");
  assert.equal(run.result.evidenceKind, "local-static-configuration");
  assert.equal(run.result.remoteExecutionChecked, false);
  assert.equal(run.result.dependabot.activePresent, false);
  assert.equal(run.result.dependabot.examplePresent, true);
  assert.ok(run.result.workflows.every((workflow) => workflow.manualOnly));
});

test("CI requires the repository brand gate", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "ci.yml", (workflow) => {
    workflow.jobs["build-and-test"].steps = workflow.jobs["build-and-test"].steps
      .filter((step) => !String(step.run ?? "").includes("check-brand.mjs"));
    workflow.jobs["protocol-and-cli"].steps.push({ run: "echo node scripts/check-brand.mjs --json" });
  });
  assertViolation(runChecker(root), "ci.yml", "ci-brand-check-missing");
});

test("CI rejects a brand gate hidden behind a false expression", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "ci.yml", (workflow) => {
    const step = workflow.jobs["build-and-test"].steps
      .find((candidate) => String(candidate.run ?? "").includes("check-brand.mjs"));
    step.if = "${{ false && success() }}";
  });
  assertViolation(runChecker(root), "ci.yml", "ci-brand-check-missing");
});

test("CI requires the public-release policy regression suite", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "ci.yml", (workflow) => {
    workflow.jobs["build-and-test"].steps = workflow.jobs["build-and-test"].steps
      .filter((step) => !String(step.run ?? "").includes("pnpm policy:test"));
  });
  assertViolation(runChecker(root), "ci.yml", "ci-policy-tests-missing");
});

test("CI rejects expression-valued continue-on-error on policy tests", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "ci.yml", (workflow) => {
    const step = workflow.jobs["build-and-test"].steps
      .find((candidate) => String(candidate.run ?? "").includes("pnpm policy:test"));
    step["continue-on-error"] = "${{ true }}";
  });
  assertViolation(runChecker(root), "ci.yml", "ci-policy-tests-missing");
});

test("CI rejects an unreachable policy command after an early successful exit", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "ci.yml", (workflow) => {
    const step = workflow.jobs["build-and-test"].steps
      .find((candidate) => String(candidate.run ?? "").includes("pnpm policy:test"));
    step.run = `exit 0\n${step.run}`;
  });
  assertViolation(runChecker(root), "ci.yml", "ci-policy-tests-missing");
});

test("CI requires the fail-closed release-readiness command", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "ci.yml", (workflow) => {
    workflow.jobs["build-and-test"].steps = workflow.jobs["build-and-test"].steps
      .filter((step) => !String(step.run ?? "").includes("release-readiness.mjs"));
  });
  assertViolation(runChecker(root), "ci.yml", "ci-release-readiness-gate-missing");
});

test("release verification requires the public-release policy regression suite", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "release.yml", (workflow) => {
    const step = workflow.jobs.verify.steps
      .find((candidate) => String(candidate.run ?? "").includes("pnpm policy:test"));
    step.run = step.run.replace("pnpm policy:test", "pnpm release:checks");
    workflow.jobs.identity.steps.push({ run: "echo pnpm policy:test" });
  });
  assertViolation(
    runChecker(root),
    "release.yml",
    "release-verification-command-missing",
    "pnpm policy:test",
  );
});

test("CI requires the Useful CLI workspace path", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "ci.yml", (workflow) => {
    const step = workflow.jobs["protocol-and-cli"].steps
      .find((candidate) => String(candidate.name ?? "").includes("CLI"));
    step["working-directory"] = "packages/missing-cli";
  });
  assertViolation(runChecker(root), "ci.yml", "ci-useful-cli-working-directory-invalid");
});

test("CI ignores a misleading CLI step name and binds the command to its workspace", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "ci.yml", (workflow) => {
    workflow.jobs["protocol-and-cli"].steps.unshift({
      name: "Install CLI dependencies",
      run: "echo setup only",
      "working-directory": "packages/missing-cli",
    });
  });
  const run = runChecker(root);
  assert.equal(run.status, 0, JSON.stringify(run.result.violations));
  assert.equal(run.result.ok, true);
});

test("platform bundles require the committed Useful application paths", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "platform-bundles.yml", (workflow) => {
    const step = workflow.jobs.bundle.steps
      .find((candidate) => String(candidate.run ?? "").includes("apps/useful/src-tauri/icons/icon.ico"));
    step.run = step.run.replace("apps/useful/src-tauri/icons/icon.ico", "apps/missing/src-tauri/icons/icon.ico");
  });
  assertViolation(
    runChecker(root),
    "platform-bundles.yml",
    "platform-bundles-committed-icon-gate-missing",
    "platform icon step",
  );
});

test("workflow Rust toolchains must match the exact repository pin", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "platform-bundles.yml", (workflow) => {
    const step = workflow.jobs.bundle.steps
      .find((candidate) => String(candidate.uses ?? "").startsWith("dtolnay/rust-toolchain@"));
    step.with.toolchain = "stable";
  });
  assertViolation(
    runChecker(root),
    "platform-bundles.yml",
    "rust-toolchain-version-not-exact",
    "stable",
  );
});

test("release requires Useful executable and bootstrap paths", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "release.yml", (workflow) => {
    const step = workflow.jobs.build.steps
      .find((candidate) => String(candidate.run ?? "").includes("release\\Useful.exe"));
    step.run = step.run.replace("release\\Useful.exe", "release\\Missing.exe");
  });
  assertViolation(
    runChecker(root),
    "release.yml",
    "release-useful-identity-contract-missing",
    "release\\Useful.exe",
  );
});

test("push trigger is rejected", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "ci.yml", (workflow) => {
    workflow.on.push = { branches: ["main"] };
  });
  assertViolation(runChecker(root), "ci.yml", "automatic-trigger-forbidden", "push");
});

test("pull_request trigger is rejected", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "ci.yml", (workflow) => {
    workflow.on.pull_request = {};
  });
  assertViolation(runChecker(root), "ci.yml", "automatic-trigger-forbidden", "pull_request");
});

test("schedule trigger is rejected", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "ci.yml", (workflow) => {
    workflow.on.schedule = [{ cron: "17 3 * * 1" }];
  });
  assertViolation(runChecker(root), "ci.yml", "automatic-trigger-forbidden", "schedule");
});

test("automatic CodeQL trigger is rejected", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "codeql.yml", (workflow) => {
    workflow.on.push = { branches: ["main"] };
  });
  assertViolation(runChecker(root), "codeql.yml", "automatic-trigger-forbidden", "push");
});

test("active Dependabot configuration is rejected", async (t) => {
  const root = await createFixture(t);
  await copyFile(
    path.join(root, ".github", "dependabot.yml.example"),
    path.join(root, ".github", "dependabot.yml"),
  );
  assertViolation(runChecker(root), ".github/dependabot.yml", "active-dependabot-forbidden");
});

test("release publish default true is rejected", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "release.yml", (workflow) => {
    workflow.on.workflow_dispatch.inputs.publish.default = true;
  });
  assertViolation(runChecker(root), "release.yml", "release-publish-input-not-fail-closed");
});

test("release shell rejects inline github context interpolation", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "release.yml", (workflow) => {
    workflow.jobs.identity.steps.push({ run: 'echo "${{ github.ref_name }}"' });
  });
  assertViolation(runChecker(root), "release.yml", "release-inline-dynamic-context-forbidden");
});

test("release shell rejects inline dispatch input interpolation", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "release.yml", (workflow) => {
    workflow.jobs.identity.steps.push({ run: 'echo "${{ inputs.channel }}"' });
  });
  assertViolation(runChecker(root), "release.yml", "release-inline-dynamic-context-forbidden");
});

test("automatic release tag push is rejected", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "release.yml", (workflow) => {
    workflow.on.push = { tags: ["v*"] };
  });
  assertViolation(runChecker(root), "release.yml", "automatic-trigger-forbidden", "push");
});

test("manual Dependency Review without a PR context guard is rejected", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "dependency-review.yml", (workflow) => {
    workflow.jobs["dependency-review"].steps = workflow.jobs["dependency-review"].steps
      .filter((step) => step.name !== "Require pull request event context");
  });
  assertViolation(
    runChecker(root),
    "dependency-review.yml",
    "dependency-review-manual-context-guard-missing",
  );
});
