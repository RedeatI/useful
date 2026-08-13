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
  await mkdir(path.join(root, "services"), { recursive: true });
  for (const file of ["go.mod", "Dockerfile"]) {
    await copyFile(path.join(repoRoot, "services", file), path.join(root, "services", file));
  }
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

test("CI serializes workspace tests to avoid runner-load RPC timeouts", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "ci.yml", (workflow) => {
    const step = workflow.jobs["build-and-test"].steps
      .find((candidate) => String(candidate.run ?? "").includes("workspace-concurrency"));
    step.run = "pnpm -r test";
  });
  assertViolation(runChecker(root), "ci.yml", "ci-workspace-tests-not-serialized");
});

test("CI requires size measurement and production enforcement after Lite packaging", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "ci.yml", (workflow) => {
    workflow.jobs["build-and-test"].steps = workflow.jobs["build-and-test"].steps
      .filter((step) => !String(step.run ?? "").includes("pnpm size:check --profile ci --json"));
  });
  assertViolation(runChecker(root), "ci.yml", "ci-size-budget-production-gate-invalid");
});

test("CI rejects a size gate moved before the package it measures", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "ci.yml", (workflow) => {
    const steps = workflow.jobs["build-and-test"].steps;
    const sizeIndex = steps.findIndex((step) => String(step.run ?? "").includes("pnpm size:check --profile ci --json"));
    const [sizeStep] = steps.splice(sizeIndex, 1);
    const packageIndex = steps.findIndex((step) => String(step.run ?? "").includes("package-release.ps1 -Edition Lite"));
    steps.splice(packageIndex, 0, sizeStep);
  });
  assertViolation(runChecker(root), "ci.yml", "ci-size-budget-production-gate-invalid");
});

test("CI size gate receives expected commit through env rather than inline shell interpolation", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "ci.yml", (workflow) => {
    const step = workflow.jobs["build-and-test"].steps
      .find((candidate) => String(candidate.run ?? "").includes("pnpm size:check --profile ci --json"));
    delete step.env.USEFUL_SIZE_EXPECTED_COMMIT;
    step.run = step.run.replaceAll("$env:USEFUL_SIZE_EXPECTED_COMMIT", "${{ github.sha }}");
  });
  assertViolation(runChecker(root), "ci.yml", "ci-size-budget-production-gate-invalid");
});

test("CI size gate rejects continue-on-error, early exit, and command substring spoofing", async (t) => {
  for (const mutation of ["continue", "exit", "spoof"]) {
    await t.test(mutation, async (subtest) => {
      const root = await createFixture(subtest);
      await mutateWorkflow(root, "ci.yml", (workflow) => {
        const step = workflow.jobs["build-and-test"].steps
          .find((candidate) => String(candidate.run ?? "").includes("pnpm size:check --profile ci --json"));
        if (mutation === "continue") step["continue-on-error"] = "${{ true }}";
        if (mutation === "exit") step.run = `exit 0\n${step.run}`;
        if (mutation === "spoof") step.run = step.run.replace(
          "pnpm size:check --profile ci --json",
          "echo pnpm size:check --profile ci --json",
        );
      });
      assertViolation(runChecker(root), "ci.yml", "ci-size-budget-production-gate-invalid");
    });
  }
});

test("CI size gate rejects extra report arguments, extra env, and upload-before-check order", async (t) => {
  for (const mutation of ["argument", "env", "order"]) {
    await t.test(mutation, async (subtest) => {
      const root = await createFixture(subtest);
      await mutateWorkflow(root, "ci.yml", (workflow) => {
        const steps = workflow.jobs["build-and-test"].steps;
        const size = steps.find((candidate) => String(candidate.run ?? "").includes("pnpm size:check --profile ci --json"));
        if (mutation === "argument") {
          size.run = size.run.replace("measure-size.ps1", "measure-size.ps1 -ReportDir release-assets");
        }
        if (mutation === "env") size.env.UNREVIEWED = "1";
        if (mutation === "order") {
          const uploadIndex = steps.findIndex((step) => String(step.uses ?? "").startsWith("actions/upload-artifact@"));
          const [upload] = steps.splice(uploadIndex, 1);
          steps.splice(steps.indexOf(size), 0, upload);
        }
      });
      assertViolation(runChecker(root), "ci.yml", "ci-size-budget-production-gate-invalid");
    });
  }
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

test("release requires the Windows production size gate after packaging", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "release.yml", (workflow) => {
    workflow.jobs.build.steps = workflow.jobs.build.steps
      .filter((step) => !String(step.run ?? "").includes('pnpm size:check --profile "$env:SIZE_PROFILE" --json'));
  });
  assertViolation(runChecker(root), "release.yml", "release-size-budget-production-gate-invalid");
});

test("release size gate is Windows-only and binds expected commit through env", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "release.yml", (workflow) => {
    const step = workflow.jobs.build.steps
      .find((candidate) => String(candidate.run ?? "").includes('pnpm size:check --profile "$env:SIZE_PROFILE" --json'));
    step.if = "matrix.platform == 'linux'";
    step.env.USEFUL_SIZE_EXPECTED_COMMIT = "not-a-sha";
  });
  assertViolation(runChecker(root), "release.yml", "release-size-budget-production-gate-invalid");
});

test("release size gate rejects continue-on-error, early exit, and command substring spoofing", async (t) => {
  for (const mutation of ["continue", "exit", "spoof"]) {
    await t.test(mutation, async (subtest) => {
      const root = await createFixture(subtest);
      await mutateWorkflow(root, "release.yml", (workflow) => {
        const step = workflow.jobs.build.steps
          .find((candidate) => String(candidate.run ?? "").includes('pnpm size:check --profile "$env:SIZE_PROFILE" --json'));
        if (mutation === "continue") step["continue-on-error"] = true;
        if (mutation === "exit") step.run = `exit 0\n${step.run}`;
        if (mutation === "spoof") step.run = step.run.replace(
          'pnpm size:check --profile "$env:SIZE_PROFILE" --json',
          'echo pnpm size:check --profile "$env:SIZE_PROFILE" --json',
        );
      });
      assertViolation(runChecker(root), "release.yml", "release-size-budget-production-gate-invalid");
    });
  }
});

test("release size gate rejects extra report arguments, extra env, and upload-before-check order", async (t) => {
  for (const mutation of ["argument", "env", "order"]) {
    await t.test(mutation, async (subtest) => {
      const root = await createFixture(subtest);
      await mutateWorkflow(root, "release.yml", (workflow) => {
        const steps = workflow.jobs.build.steps;
        const size = steps.find((candidate) => String(candidate.run ?? "").includes('pnpm size:check --profile "$env:SIZE_PROFILE" --json'));
        if (mutation === "argument") {
          size.run = size.run.replace(
            'pnpm size:check --profile "$env:SIZE_PROFILE" --json',
            'pnpm size:check --profile "$env:SIZE_PROFILE" --report release-assets/size-report.json --json',
          );
        }
        if (mutation === "env") size.env.UNREVIEWED = "1";
        if (mutation === "order") {
          const uploadIndex = steps.findIndex((step) => String(step.uses ?? "").startsWith("actions/upload-artifact@"));
          const [upload] = steps.splice(uploadIndex, 1);
          steps.splice(steps.indexOf(size), 0, upload);
        }
      });
      assertViolation(runChecker(root), "release.yml", "release-size-budget-production-gate-invalid");
    });
  }
});

test("size reports cannot enter CI artifact uploads", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "ci.yml", (workflow) => {
    const upload = workflow.jobs["build-and-test"].steps
      .find((step) => String(step.uses ?? "").startsWith("actions/upload-artifact@"));
    upload.with.path += "\nartifacts/size/size-report.json";
  });
  assertViolation(runChecker(root), "ci.yml", "ci-size-report-upload-forbidden");
});

test("CI upload paths are an exact allowlist and reject broad globs", async (t) => {
  for (const candidate of ["artifacts/size/size-report.json", "artifacts/**", ".", "**/*"]) {
    await t.test(candidate, async (subtest) => {
      const root = await createFixture(subtest);
      await mutateWorkflow(root, "ci.yml", (workflow) => {
        const upload = workflow.jobs["build-and-test"].steps
          .find((step) => String(step.uses ?? "").startsWith("actions/upload-artifact@"));
        upload.with.path = candidate;
      });
      assertViolation(runChecker(root), "ci.yml", "ci-size-report-upload-forbidden");
    });
  }
});

test("release upload paths are an exact allowlist and reject broad globs", async (t) => {
  for (const candidate of ["artifacts/size/size-report.json", "artifacts/**", ".", "**/*"]) {
    await t.test(candidate, async (subtest) => {
      const root = await createFixture(subtest);
      await mutateWorkflow(root, "release.yml", (workflow) => {
        const upload = workflow.jobs.build.steps
          .find((step) => String(step.uses ?? "").startsWith("actions/upload-artifact@"));
        upload.with.path = candidate;
      });
      assertViolation(runChecker(root), "release.yml", "release-size-report-asset-forbidden");
    });
  }
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

test("CI Compose E2E requires frozen pnpm dependencies before preparation", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "ci.yml", (workflow) => {
    workflow.jobs["compose-e2e"].steps = workflow.jobs["compose-e2e"].steps
      .filter((step) => String(step.run ?? "") !== "pnpm install --frozen-lockfile");
  });
  assertViolation(runChecker(root), "ci.yml", "ci-compose-dependency-bootstrap-missing");
});

test("CI Compose E2E builds the workspace SDK after dependency installation", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "ci.yml", (workflow) => {
    workflow.jobs["compose-e2e"].steps = workflow.jobs["compose-e2e"].steps
      .filter((step) => String(step.run ?? "") !== "pnpm --filter @useful/sdk build");
  });
  assertViolation(runChecker(root), "ci.yml", "ci-compose-dependency-bootstrap-missing");
});

test("CI Compose E2E runs public release policy on Linux", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "ci.yml", (workflow) => {
    workflow.jobs["compose-e2e"].steps = workflow.jobs["compose-e2e"].steps
      .filter((step) => String(step.run ?? "") !== "pnpm policy:test");
  });
  assertViolation(runChecker(root), "ci.yml", "ci-compose-linux-policy-tests-missing");
});

test("CI matches the Linux release Clippy gate", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "ci.yml", (workflow) => {
    workflow.jobs["linux-rust-lint"].steps = workflow.jobs["linux-rust-lint"].steps
      .filter((step) => String(step.run ?? "") !== "cargo clippy --workspace --all-targets -- -D warnings");
  });
  assertViolation(runChecker(root), "ci.yml", "ci-linux-release-clippy-missing");
});

test("CI matches the Linux release test gate after Clippy", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "ci.yml", (workflow) => {
    workflow.jobs["linux-rust-lint"].steps = workflow.jobs["linux-rust-lint"].steps
      .filter((step) => String(step.run ?? "") !== "cargo test --workspace");
  });
  assertViolation(runChecker(root), "ci.yml", "ci-linux-release-tests-missing");

  await mutateWorkflow(root, "ci.yml", (workflow) => {
    const steps = workflow.jobs["linux-rust-lint"].steps;
    const clippyIndex = steps.findIndex((step) => String(step.run ?? "").includes("cargo clippy"));
    steps.splice(clippyIndex, 0, { run: "cargo test --workspace" });
  });
  assertViolation(runChecker(root), "ci.yml", "ci-linux-release-tests-order-invalid");
});

test("CI Linux release Clippy installs the release desktop dependencies", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "ci.yml", (workflow) => {
    const step = workflow.jobs["linux-rust-lint"].steps
      .find((candidate) => String(candidate.name ?? "").includes("Linux desktop bundling dependencies"));
    step.run = String(step.run).replace("libwebkit2gtk-4.1-dev", "");
  });
  assertViolation(runChecker(root), "ci.yml", "ci-linux-release-clippy-dependency-missing");
});

test("CI Linux release Clippy uses a frozen pnpm bootstrap", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "ci.yml", (workflow) => {
    workflow.jobs["linux-rust-lint"].steps = workflow.jobs["linux-rust-lint"].steps
      .filter((step) => String(step.run ?? "") !== "pnpm install --frozen-lockfile");
  });
  assertViolation(runChecker(root), "ci.yml", "ci-linux-release-clippy-bootstrap-missing");
});

test("CI Linux release Clippy builds Tauri frontend context before linting", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "ci.yml", (workflow) => {
    workflow.jobs["linux-rust-lint"].steps = workflow.jobs["linux-rust-lint"].steps
      .filter((step) => String(step.run ?? "") !== "pnpm -r build");
  });
  assertViolation(runChecker(root), "ci.yml", "ci-linux-release-clippy-build-order-invalid");
});

test("release Compose E2E requires frozen pnpm dependencies and SDK build", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "release.yml", (workflow) => {
    workflow.jobs["verify-compose"].steps = workflow.jobs["verify-compose"].steps
      .filter((step) => String(step.run ?? "") !== "pnpm install --frozen-lockfile");
  });
  assertViolation(runChecker(root), "release.yml", "release-compose-dependency-bootstrap-missing");
});

test("CI platform matrix requires frozen pnpm dependencies", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "ci.yml", (workflow) => {
    workflow.jobs["platform-limited-matrix"].steps = workflow.jobs["platform-limited-matrix"].steps
      .filter((step) => !String(step.uses ?? "").startsWith("pnpm/action-setup@"));
  });
  assertViolation(runChecker(root), "ci.yml", "ci-platform-matrix-dependency-bootstrap-missing");
});

test("CI platform scenarios use their required runners and cross-platform PowerShell", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "ci.yml", (workflow) => {
    const compose = workflow.jobs["platform-limited-matrix"].strategy.matrix.include
      .find((entry) => entry.scenario === "compose-fault-injection");
    compose.runner = "windows-latest";
  });
  assertViolation(runChecker(root), "ci.yml", "ci-platform-matrix-runner-contract-invalid");
});

test("CodeQL uses a supported build mode for each language", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "codeql.yml", (workflow) => {
    const go = workflow.jobs.analyze.strategy.matrix.include
      .find((entry) => entry.language === "go");
    go["build-mode"] = "none";
  });
  assertViolation(runChecker(root), "codeql.yml", "codeql-language-build-mode-invalid");
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

test("release verification serializes workspace tests", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "release.yml", (workflow) => {
    const step = workflow.jobs.verify.steps
      .find((candidate) => String(candidate.run ?? "").includes("workspace-concurrency"));
    step.run = "pnpm -r test";
  });
  assertViolation(
    runChecker(root),
    "release.yml",
    "release-verification-command-missing",
    "pnpm -r --workspace-concurrency=1 test",
  );
});

test("platform bundles build the frontend before native compilation", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "platform-bundles.yml", (workflow) => {
    const steps = workflow.jobs.bundle.steps;
    const frontendIndex = steps.findIndex((step) => String(step.run ?? "") === "pnpm --filter @useful/app build");
    const [frontend] = steps.splice(frontendIndex, 1);
    const nativeIndex = steps.findIndex((step) => String(step.run ?? "").includes("cargo check -p useful-app"));
    steps.splice(nativeIndex + 1, 0, frontend);
  });
  assertViolation(
    runChecker(root),
    "platform-bundles.yml",
    "platform-bundles-frontend-before-native-missing",
  );
});

test("platform bundles select only the intended bundle formats", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "platform-bundles.yml", (workflow) => {
    const windows = workflow.jobs.bundle.strategy.matrix.include
      .find((entry) => entry.platform === "windows");
    windows.bundleArgs = "msi nsis";
  });
  assertViolation(
    runChecker(root),
    "platform-bundles.yml",
    "platform-bundles-target-bundle-selection-invalid",
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

test("workflow Go toolchains must match the patched repository pin", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "ci.yml", (workflow) => {
    const step = workflow.jobs["source-backend"].steps
      .find((candidate) => String(candidate.uses ?? "").startsWith("actions/setup-go@"));
    step.with["go-version"] = "1.26";
  });
  assertViolation(runChecker(root), "ci.yml", "go-toolchain-version-not-exact", "1.26");
});

test("Go module and container builder must match the patched toolchain", async (t) => {
  const root = await createFixture(t);
  await writeFile(path.join(root, "services", "go.mod"), "module useful.dev/source\n\ngo 1.26.5\n", "utf8");
  assertViolation(runChecker(root), "services/go.mod", "go-toolchain-version-not-exact", "1.26.6");

  await copyFile(path.join(repoRoot, "services", "go.mod"), path.join(root, "services", "go.mod"));
  await writeFile(path.join(root, "services", "Dockerfile"), "FROM golang:1.26 AS build\n", "utf8");
  assertViolation(runChecker(root), "services/Dockerfile", "docker-go-toolchain-version-not-exact", "1.26.6");
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

test("release requires the Linux Rust check before and during publish", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "release.yml", (workflow) => {
    const identityStep = workflow.jobs.identity.steps
      .find((step) => String(step.run ?? "").includes("Require all exact-commit") || String(step.name ?? "").includes("Require all exact-commit"));
    identityStep.run = identityStep.run.replace(/^\s*linux-rust-lint\s*$/m, "");
  });
  assertViolation(runChecker(root), "release.yml", "release-linux-rust-check-not-required-before-publish");

  await mutateWorkflow(root, "release.yml", (workflow) => {
    const publishStep = workflow.jobs.publish.steps
      .find((step) => String(step.name ?? "").includes("Revalidate exact-commit CI checks"));
    publishStep.run = publishStep.run.replace(/^\s*linux-rust-lint\s*$/m, "");
  });
  assertViolation(runChecker(root), "release.yml", "release-linux-rust-check-not-revalidated-at-publish");
});

test("release actor allowlist preserves a newline for a single configured actor", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "release.yml", (workflow) => {
    const step = workflow.jobs.identity.steps
      .find((candidate) => String(candidate.run ?? "").includes("actor_allowed=false"));
    step.run = step.run.replace(
      "printf '%s\\n' \"$RELEASE_ACTORS\"",
      "printf '%s' \"$RELEASE_ACTORS\"",
    );
  });
  assertViolation(
    runChecker(root),
    "release.yml",
    "release-source-actor-allowlist-parser-unsafe",
  );
});

test("release Agent Kit invocation does not forward a literal option separator", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "release.yml", (workflow) => {
    for (const jobName of ["source-agent-kit", "agent-kit"]) {
      const step = workflow.jobs[jobName].steps
        .find((candidate) => String(candidate.run ?? "").includes("agent-kit:build --out-dir"));
      step.run = step.run.replace(
        "agent-kit:build --out-dir",
        "agent-kit:build -- --out-dir",
      );
    }
  });
  assertViolation(
    runChecker(root),
    "release.yml",
    "release-agent-kit-argument-separator-invalid",
  );
});

test("source publish installs dependencies before revalidating public source", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "release.yml", (workflow) => {
    workflow.jobs["publish-source-agent-kit"].steps = workflow.jobs["publish-source-agent-kit"].steps
      .filter((step) => !String(step.run ?? "").includes("pnpm install --frozen-lockfile"));
  });
  assertViolation(
    runChecker(root),
    "release.yml",
    "release-source-publish-dependencies-missing",
  );
});

test("source publish cannot defer dependency installation until after public-source revalidation", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "release.yml", (workflow) => {
    const steps = workflow.jobs["publish-source-agent-kit"].steps;
    const installIndex = steps.findIndex((step) => String(step.run ?? "").includes("pnpm install --frozen-lockfile"));
    const [install] = steps.splice(installIndex, 1);
    const sourceCheckIndex = steps.findIndex((step) => String(step.run ?? "").includes("public-source-check.mjs --json"));
    steps.splice(sourceCheckIndex + 1, 0, install);
  });
  assertViolation(
    runChecker(root),
    "release.yml",
    "release-source-publish-dependencies-missing",
  );
});

test("source publish requires one exact frozen dependency installation command", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "release.yml", (workflow) => {
    const steps = workflow.jobs["publish-source-agent-kit"].steps;
    const install = steps.find((step) => String(step.run ?? "").includes("pnpm install --frozen-lockfile"));
    install.run = "pnpm install --frozen-lockfile || true";
  });
  assertViolation(
    runChecker(root),
    "release.yml",
    "release-source-publish-dependencies-missing",
  );
});

test("source publish requires pnpm setup before setup-node", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "release.yml", (workflow) => {
    const steps = workflow.jobs["publish-source-agent-kit"].steps;
    const pnpm = steps.find((step) => String(step.uses ?? "").startsWith("pnpm/action-setup@"));
    const node = steps.find((step) => String(step.uses ?? "").startsWith("actions/setup-node@"));
    const pnpmIndex = steps.indexOf(pnpm);
    const nodeIndex = steps.indexOf(node);
    [steps[pnpmIndex], steps[nodeIndex]] = [steps[nodeIndex], steps[pnpmIndex]];
  });
  assertViolation(
    runChecker(root),
    "release.yml",
    "release-source-publish-dependencies-missing",
  );
});

test("source publish requires exact package-manager setup configuration", async (t) => {
  const root = await createFixture(t);
  await mutateWorkflow(root, "release.yml", (workflow) => {
    const steps = workflow.jobs["publish-source-agent-kit"].steps;
    const pnpm = steps.find((step) => String(step.uses ?? "").startsWith("pnpm/action-setup@"));
    const node = steps.find((step) => String(step.uses ?? "").startsWith("actions/setup-node@"));
    pnpm.with.version = "9.14.0";
    node.with.cache = "npm";
  });
  assertViolation(
    runChecker(root),
    "release.yml",
    "release-source-publish-dependencies-missing",
  );
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
