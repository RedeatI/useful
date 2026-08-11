#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRootArgument = process.argv.indexOf("--repo-root");
const repoRoot = repoRootArgument >= 0
  ? path.resolve(process.argv[repoRootArgument + 1] ?? "")
  : defaultRepoRoot;
const workflowRoot = path.join(repoRoot, ".github", "workflows");
const jsonMode = process.argv.includes("--json");
const violations = [];
const workflowEvidence = [];
const dependabotEvidence = {
  activePath: ".github/dependabot.yml",
  activePresent: false,
  examplePath: ".github/dependabot.yml.example",
  examplePresent: false,
  ecosystems: [],
};

function triggerNames(workflow) {
  const trigger = workflow?.on;
  if (typeof trigger === "string") return [trigger];
  if (Array.isArray(trigger)) return trigger.map(String).sort();
  if (trigger && typeof trigger === "object") return Object.keys(trigger).sort();
  return [];
}

function inspectFirstPublicActivation(file, workflow) {
  const triggers = triggerNames(workflow);
  const manualOnly = triggers.length === 1 && triggers[0] === "workflow_dispatch";
  workflowEvidence.push({
    file,
    triggers,
    manualOnly,
    jobCount: Object.keys(workflow.jobs ?? {}).length,
  });
  if (!manualOnly) {
    violations.push({
      file,
      code: "first-public-trigger-not-manual-only",
      details: triggers.length > 0 ? triggers.join(",") : "missing",
    });
  }
  for (const trigger of triggers) {
    if (trigger !== "workflow_dispatch") {
      violations.push({ file, code: "automatic-trigger-forbidden", details: trigger });
    }
  }
}

function inspectDependencyReviewWorkflow(file, workflow) {
  const steps = workflow.jobs?.["dependency-review"]?.steps ?? [];
  const actionIndex = steps.findIndex((step) => (
    String(step?.uses ?? "").startsWith("actions/dependency-review-action@")
  ));
  const guardIndex = steps.findIndex((step) => {
    const condition = String(step?.if ?? "");
    const run = String(step?.run ?? "");
    return condition.includes("github.event_name != 'pull_request'")
      && run.includes("requires pull_request event context")
      && /(^|\n)\s*exit 1\s*($|\n)/.test(run);
  });
  if (actionIndex < 0) {
    violations.push({ file, code: "dependency-review-action-missing" });
  }
  if (guardIndex < 0 || actionIndex < 0 || guardIndex >= actionIndex) {
    violations.push({ file, code: "dependency-review-manual-context-guard-missing" });
  }
}

function inspectSteps(file, steps, location) {
  if (!Array.isArray(steps)) return;
  for (const [index, step] of steps.entries()) {
    if (!step || typeof step !== "object" || typeof step.uses !== "string") continue;
    const uses = step.uses.trim();
    if (uses.startsWith("./") || uses.startsWith("docker://")) continue;
    if (!/@[0-9a-f]{40}$/i.test(uses)) {
      violations.push({
        file,
        code: "action-not-pinned-to-commit",
        location: `${location}.steps[${index}]`,
        details: uses,
      });
    }
    if (
      uses.startsWith("dtolnay/rust-toolchain@")
      && String(step?.with?.toolchain ?? "") !== "1.97.1"
    ) {
      violations.push({
        file,
        code: "rust-toolchain-version-not-exact",
        location: `${location}.steps[${index}]`,
        details: String(step?.with?.toolchain ?? "missing"),
      });
    }
  }
}

function needsOf(job) {
  if (Array.isArray(job?.needs)) return job.needs;
  if (typeof job?.needs === "string") return [job.needs];
  return [];
}

function jobRunText(job) {
  return (job?.steps ?? []).map((step) => String(step?.run ?? "")).join("\n");
}

function stepIndex(job, predicate) {
  return (job?.steps ?? []).findIndex(predicate);
}

function runnableStep(step, { allowedCondition = "" } = {}) {
  if (!step || typeof step !== "object") return false;
  if (
    Object.prototype.hasOwnProperty.call(step, "continue-on-error")
    && step["continue-on-error"] !== false
  ) {
    return false;
  }
  return String(step.if ?? "").trim() === allowedCondition;
}

function runLines(step) {
  return String(step?.run ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function uploadPathLines(step) {
  if (typeof step?.with?.path !== "string") return [];
  return step.with.path
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function inspectUploadPathClosure(file, workflow, expectedUploads, code) {
  const actualUploads = [];
  for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
    for (const step of job?.steps ?? []) {
      if (!String(step?.uses ?? "").startsWith("actions/upload-artifact@")) continue;
      actualUploads.push({
        jobId,
        name: String(step?.with?.name ?? ""),
        paths: uploadPathLines(step),
      });
    }
  }
  const closed = actualUploads.length === expectedUploads.length && expectedUploads.every((expected) => {
    const matches = actualUploads.filter((actual) => (
      actual.jobId === expected.jobId && actual.name === expected.name
    ));
    return matches.length === 1 && JSON.stringify(matches[0].paths) === JSON.stringify(expected.paths);
  });
  if (!closed) violations.push({ file, code });
}

function stepRunsExact(step, command) {
  const lines = runLines(step);
  return runnableStep(step) && lines.length === 1 && lines[0] === command;
}

function stepRunsExactLines(step, expectedLines, options = undefined) {
  return runnableStep(step, options) && JSON.stringify(runLines(step)) === JSON.stringify(expectedLines);
}

function stepEnvIsExact(step, expected) {
  const env = step?.env;
  if (!env || typeof env !== "object" || Array.isArray(env)) return false;
  const byKey = ([left], [right]) => left < right ? -1 : left > right ? 1 : 0;
  const actualEntries = Object.entries(env).sort(byKey);
  const expectedEntries = Object.entries(expected).sort(byKey);
  return JSON.stringify(actualEntries) === JSON.stringify(expectedEntries);
}

function stepRunsPrefix(step, prefix, options = undefined) {
  return runnableStep(step, options) && runLines(step).some((line) => line.startsWith(prefix));
}

const TAURI_LINUX_PACKAGES = [
  "build-essential",
  "curl",
  "file",
  "libayatana-appindicator3-dev",
  "librsvg2-dev",
  "libssl-dev",
  "libwebkit2gtk-4.1-dev",
  "libxdo-dev",
  "patchelf",
  "wget",
];

function inspectLinuxDesktopDependencies(file, job, code, expectedCondition) {
  const step = (job?.steps ?? []).find((candidate) => (
    String(candidate?.name ?? "").includes("Linux desktop bundling dependencies")
  ));
  const run = String(step?.run ?? "");
  if (expectedCondition !== undefined && String(step?.if ?? "") !== expectedCondition) {
    violations.push({ file, code, details: "platform condition" });
  }
  for (const dependency of TAURI_LINUX_PACKAGES) {
    if (!run.includes(dependency)) violations.push({ file, code, details: dependency });
  }
}

function inspectForbiddenReleaseEnv(file, workflow) {
  const forbidden = "USEFUL_ALLOW_DEVELOPMENT_UPDATE_TRUST";
  const inspect = (value, location) => {
    if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, forbidden)) {
      violations.push({ file, code: "release-development-trust-opt-in-forbidden", location });
    }
  };
  inspect(workflow.env, "env");
  for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
    inspect(job?.env, `jobs.${jobId}.env`);
    for (const [index, step] of (job?.steps ?? []).entries()) {
      inspect(step?.env, `jobs.${jobId}.steps[${index}].env`);
    }
  }
}

function inspectPreviewWorkflow(file, workflow) {
  const optIn = "USEFUL_ALLOW_DEVELOPMENT_UPDATE_TRUST";
  const optInLocations = [];
  const buildSteps = [];
  const uploadNames = [];
  if (workflow.env && Object.prototype.hasOwnProperty.call(workflow.env, optIn)) {
    optInLocations.push({ location: "env", value: workflow.env[optIn] });
  }
  for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
    if (job?.env && Object.prototype.hasOwnProperty.call(job.env, optIn)) {
      optInLocations.push({ location: `jobs.${jobId}.env`, value: job.env[optIn] });
    }
    for (const [index, step] of (job?.steps ?? []).entries()) {
      const location = `jobs.${jobId}.steps[${index}]`;
      if (step?.env && Object.prototype.hasOwnProperty.call(step.env, optIn)) {
        optInLocations.push({ location: `${location}.env`, value: step.env[optIn] });
      }
      if (String(step?.run ?? "").includes("tauri build")) buildSteps.push({ step, location });
      if (String(step?.uses ?? "").startsWith("actions/upload-artifact@")) {
        uploadNames.push(String(step?.with?.name ?? ""));
      }
    }
  }
  const build = buildSteps[0];
  const buildName = String(build?.step?.name ?? "").toLowerCase();
  if (
    buildSteps.length !== 1
    || String(build?.step?.env?.[optIn] ?? "") !== "1"
    || !buildName.includes("development-trust")
    || !buildName.includes("unsigned preview")
  ) {
    violations.push({ file, code: "preview-development-trust-build-contract-invalid" });
  }
  if (
    optInLocations.length !== 1
    || optInLocations[0]?.location !== `${build?.location}.env`
    || String(optInLocations[0]?.value ?? "") !== "1"
  ) {
    violations.push({ file, code: "preview-development-trust-opt-in-not-step-local" });
  }
  if (!uploadNames.some((name) => name.includes("development-trust-unsigned-preview"))) {
    violations.push({ file, code: "preview-artifact-trust-label-missing" });
  }
}

function inspectCiWorkflow(file, workflow) {
  const runText = Object.values(workflow.jobs ?? {}).map(jobRunText).join("\n");
  const buildSteps = workflow.jobs?.["build-and-test"]?.steps ?? [];
  const uploadNames = Object.values(workflow.jobs ?? {}).flatMap((job) => (
    (job?.steps ?? [])
      .filter((step) => String(step?.uses ?? "").startsWith("actions/upload-artifact@"))
      .map((step) => String(step?.with?.name ?? ""))
  ));
  if (runText.includes("fetch-binaries.ps1") || runText.includes("-Edition Full") || runText.includes("-Edition All")) {
    violations.push({ file, code: "ci-media-runtime-download-or-full-preview-forbidden" });
  }
  if (!runText.includes("package-release.ps1 -Edition Lite")) {
    violations.push({ file, code: "ci-portable-lite-package-contract-missing" });
  }
  if (!buildSteps.some((step) => stepRunsExact(step, "node scripts/check-brand.mjs --json"))) {
    violations.push({ file, code: "ci-brand-check-missing" });
  }
  if (!buildSteps.some((step) => stepRunsExact(step, "pnpm policy:test"))) {
    violations.push({ file, code: "ci-policy-tests-missing" });
  }
  if (!buildSteps.some((step) => stepRunsExact(step, "node scripts/release-readiness.mjs --json"))) {
    violations.push({ file, code: "ci-release-readiness-gate-missing" });
  }
  const cliSteps = (workflow.jobs?.["protocol-and-cli"]?.steps ?? []).filter((step) => (
    String(step?.["working-directory"] ?? "") === "packages/useful-cli"
    && stepRunsExact(step, "npx vitest run")
  ));
  if (cliSteps.length !== 1) {
    violations.push({ file, code: "ci-useful-cli-working-directory-invalid" });
  }
  const tauriStep = buildSteps
    .find((step) => String(step?.run ?? "").includes("tauri build --no-bundle"));
  if (
    !String(tauriStep?.run ?? "").includes("cargo build -p useful-bootstrap --release")
    || String(tauriStep?.env?.USEFUL_ALLOW_DEVELOPMENT_UPDATE_TRUST ?? "") !== "1"
  ) {
    violations.push({ file, code: "ci-tauri-bootstrap-step-local-development-trust-contract-invalid" });
  }
  if (!uploadNames.includes("useful-portable-lite-x64-development-trust-unsigned-preview")) {
    violations.push({ file, code: "ci-useful-lite-preview-artifact-name-invalid" });
  }
  if (!uploadNames.includes("useful-sbom")) {
    violations.push({ file, code: "ci-useful-sbom-artifact-name-invalid" });
  }
  inspectUploadPathClosure(file, workflow, [
    {
      jobId: "build-and-test",
      name: "useful-portable-lite-x64-development-trust-unsigned-preview",
      paths: ["dist-release/Useful-Portable-Lite-x64.zip", "dist-release/SHA256SUMS.txt"],
    },
    {
      jobId: "build-and-test",
      name: "useful-sbom",
      paths: ["dist-sbom/sbom.cdx.json", "THIRD_PARTY_NOTICES.md"],
    },
  ], "ci-size-report-upload-forbidden");
  const source = Object.values(workflow.jobs ?? {}).flatMap((job) => job?.steps ?? [])
    .map((step) => `${String(step?.name ?? "")}\n${String(step?.with?.path ?? "")}`)
    .join("\n");
  if (!source.includes("dist-release/Useful-Portable-Lite-x64.zip") || source.includes("Portable-Full")) {
    violations.push({ file, code: "ci-portable-lite-preview-path-invalid" });
  }
  const ciPackageCommand = "powershell -ExecutionPolicy Bypass -File scripts/package-release.ps1 -Edition Lite";
  const packageIndexes = buildSteps
    .map((step, index) => stepRunsExact(step, ciPackageCommand) ? index : -1)
    .filter((index) => index >= 0);
  const ciSizeLines = [
    "$ErrorActionPreference = 'Stop'",
    "& ./scripts/measure-size.ps1 -ExpectedCommit $env:USEFUL_SIZE_EXPECTED_COMMIT",
    "pnpm size:check --profile ci --json",
    "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
  ];
  const sizeIndexes = buildSteps
    .map((step, index) => runLines(step).includes("pnpm size:check --profile ci --json") ? index : -1)
    .filter((index) => index >= 0);
  const sizeIndex = sizeIndexes.length === 1 ? sizeIndexes[0] : -1;
  const sizeStep = sizeIndex >= 0 ? buildSteps[sizeIndex] : undefined;
  const uploadBuildIndex = buildSteps.findIndex((step) => (
    runnableStep(step) && String(step?.uses ?? "").startsWith("actions/upload-artifact@")
  ));
  if (
    packageIndexes.length !== 1
    || sizeIndexes.length !== 1
    || uploadBuildIndex < 0
    || !(packageIndexes[0] < sizeIndex && sizeIndex < uploadBuildIndex)
    || !stepRunsExactLines(sizeStep, ciSizeLines)
    || String(sizeStep?.shell ?? "") !== "pwsh"
    || !stepEnvIsExact(sizeStep, { USEFUL_SIZE_EXPECTED_COMMIT: "${{ github.sha }}" })
  ) {
    violations.push({ file, code: "ci-size-budget-production-gate-invalid" });
  }
}

function inspectPlatformBundlesWorkflow(file, workflow) {
  const bundle = workflow.jobs?.bundle;
  const steps = bundle?.steps ?? [];
  const checkouts = steps.filter((step) => String(step?.uses ?? "").startsWith("actions/checkout@"));
  if (checkouts.length !== 1 || checkouts[0]?.with?.["persist-credentials"] !== false) {
    violations.push({ file, code: "platform-bundles-checkout-invalid" });
  }
  const linux = (bundle?.strategy?.matrix?.include ?? []).find((entry) => entry?.platform === "linux");
  if (linux?.runner !== "ubuntu-22.04") {
    violations.push({ file, code: "platform-bundles-linux-baseline-invalid", details: linux?.runner ?? "missing" });
  }
  inspectLinuxDesktopDependencies(
    file,
    bundle,
    "platform-bundles-linux-desktop-dependency-missing",
    "matrix.platform == 'linux'",
  );
  const runText = jobRunText(bundle);
  if (runText.includes("tauri icon")) {
    violations.push({ file, code: "platform-bundles-icon-generation-forbidden" });
  }
  const iconStep = steps.find((step) => runnableStep(step) && String(step?.shell ?? "") === "bash" && [
    "git status --porcelain --untracked-files=all",
    "apps/useful/src-tauri/icons/icon.icns",
    "apps/useful/src-tauri/icons/icon.ico",
    "apps/useful/src-tauri/icons/icon.png",
    'test -s "$icon"',
  ].every((required) => String(step?.run ?? "").includes(required)));
  if (!iconStep) {
    violations.push({ file, code: "platform-bundles-committed-icon-gate-missing", details: "platform icon step" });
  }
  if (!steps.some((step) => stepRunsExact(step, "cargo check -p useful-app --lib --target ${{ matrix.target }}"))) {
    violations.push({ file, code: "platform-bundles-native-command-missing", details: "cargo check -p useful-app" });
  }
  if (!steps.some((step) => stepRunsExact(step, "pnpm --filter @useful/app tauri build --target ${{ matrix.target }}"))) {
    violations.push({ file, code: "platform-bundles-native-command-missing", details: "pnpm --filter @useful/app" });
  }
}

function inspectReleaseWorkflow(file, workflow) {
  const dispatch = workflow.on?.workflow_dispatch;
  const publishInput = dispatch?.inputs?.publish;
  const scopeInput = dispatch?.inputs?.scope;
  if (
    !dispatch
    || publishInput?.type !== "boolean"
    || publishInput?.required !== true
    || publishInput?.default !== false
  ) {
    violations.push({ file, code: "release-publish-input-not-fail-closed" });
  }
  if (
    scopeInput?.type !== "choice"
    || scopeInput?.required !== true
    || scopeInput?.default !== "source-agent-kit"
    || JSON.stringify(scopeInput?.options) !== JSON.stringify(["source-agent-kit", "desktop-full"])
  ) {
    violations.push({ file, code: "release-scope-input-not-closed" });
  }
  const requiredJobs = [
    "identity", "verify", "verify-compose", "source-agent-kit", "publish-source-agent-kit",
    "sbom", "agent-kit", "build", "assemble", "publish",
  ];
  for (const jobId of requiredJobs) {
    if (!workflow.jobs?.[jobId]) violations.push({ file, code: "release-required-job-missing", details: jobId });
  }
  const buildNeeds = new Set(needsOf(workflow.jobs?.build));
  const sbomNeeds = new Set(needsOf(workflow.jobs?.sbom));
  const agentKitNeeds = new Set(needsOf(workflow.jobs?.["agent-kit"]));
  for (const dependency of ["identity", "verify", "verify-compose"]) {
    if (!buildNeeds.has(dependency)) violations.push({ file, code: "release-build-gate-missing", details: dependency });
    if (!sbomNeeds.has(dependency)) violations.push({ file, code: "release-sbom-gate-missing", details: dependency });
    if (!agentKitNeeds.has(dependency)) violations.push({ file, code: "release-agent-kit-gate-missing", details: dependency });
  }

  for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
    if (!["publish", "publish-source-agent-kit"].includes(jobId) && job?.permissions?.contents === "write") {
      violations.push({ file, code: "release-write-permission-outside-publish", details: jobId });
    }
    const checkouts = (job?.steps ?? []).filter((step) => String(step?.uses ?? "").startsWith("actions/checkout@"));
    if (checkouts.length !== 1 || checkouts[0]?.with?.["persist-credentials"] !== false) {
      violations.push({ file, code: "release-exact-checkout-invalid", details: jobId });
    }
    const runText = jobRunText(job);
    for (const [stepIndexValue, step] of (job?.steps ?? []).entries()) {
      const run = String(step?.run ?? "");
      const inline = run.match(/\$\{\{[^}]+\}\}/);
      if (inline) {
        violations.push({
          file,
          code: "release-inline-dynamic-context-forbidden",
          details: `${jobId}:${stepIndexValue}:${inline[0]}`,
        });
      }
    }
    for (const command of ["git rev-parse HEAD", "git status --porcelain --untracked-files=all", "SOURCE_DATE_EPOCH="]) {
      if (!runText.includes(command)) {
        violations.push({ file, code: "release-clean-checkout-gate-missing", details: `${jobId}:${command}` });
      }
    }
  }
  inspectForbiddenReleaseEnv(file, workflow);
  const buildJob = workflow.jobs?.build;
  const buildSteps = buildJob?.steps ?? [];
  const identityIconStep = buildSteps.find((step) => runnableStep(step) && [
    "apps/useful/src-tauri/icons/icon.icns",
    "apps/useful/src-tauri/icons/icon.ico",
    "apps/useful/src-tauri/icons/icon.png",
  ].every((required) => String(step?.run ?? "").includes(required)));
  const windowsIdentityStep = buildSteps.find((step) => (
    runnableStep(step, { allowedCondition: "matrix.platform == 'windows'" })
    &&
    String(step?.name ?? "").includes("Setup Lite and deterministic Portable Lite/Full")
  ));
  const windowsIdentityRun = String(windowsIdentityStep?.run ?? "");
  const identityContracts = [
    ["apps/useful/src-tauri/icons/icon.icns", Boolean(identityIconStep)],
    ["apps/useful/src-tauri/icons/icon.ico", Boolean(identityIconStep)],
    ["apps/useful/src-tauri/icons/icon.png", Boolean(identityIconStep)],
    [
      "pnpm --filter @useful/app tauri build",
      buildSteps.some((step) => stepRunsPrefix(step, "pnpm --filter @useful/app tauri build --target")),
    ],
    [
      "cargo build -p useful-bootstrap --release",
      buildSteps.some((step) => (
        stepRunsPrefix(
          step,
          "cargo build -p useful-bootstrap --release",
          { allowedCondition: "matrix.platform == 'windows'" },
        )
        || stepRunsPrefix(step, "cargo build -p useful-bootstrap --release")
      )),
    ],
    ["release\\Useful.exe", windowsIdentityRun.includes("release\\Useful.exe")],
    ["release\\useful-bootstrap.exe", windowsIdentityRun.includes("release\\useful-bootstrap.exe")],
  ];
  for (const [required, present] of identityContracts) {
    if (!present) violations.push({ file, code: "release-useful-identity-contract-missing", details: required });
  }
  const allReleaseRunText = Object.values(workflow.jobs ?? {}).map(jobRunText).join("\n");
  if (/USEFUL_ALLOW_DEVELOPMENT_UPDATE_TRUST\s*=\s*["']?1/.test(allReleaseRunText)) {
    violations.push({ file, code: "release-development-trust-runtime-opt-in-forbidden" });
  }
  const publish = workflow.jobs?.publish;
  if (!String(publish?.if ?? "").includes("inputs.publish == true")) {
    violations.push({ file, code: "release-publish-job-gate-invalid" });
  }
  if (publish?.permissions?.contents !== "write" || publish?.permissions?.checks !== "read") {
    violations.push({ file, code: "release-publish-permissions-invalid" });
  }
  if (publish?.environment !== "release") violations.push({ file, code: "release-environment-gate-missing" });

  const desktopCondition = "inputs.scope == 'desktop-full'";
  for (const jobId of ["verify", "verify-compose", "sbom", "agent-kit", "build", "assemble", "publish"]) {
    if (!String(workflow.jobs?.[jobId]?.if ?? "").includes(desktopCondition)) {
      violations.push({ file, code: "release-desktop-scope-gate-missing", details: jobId });
    }
  }
  const sourceJob = workflow.jobs?.["source-agent-kit"];
  const sourcePublish = workflow.jobs?.["publish-source-agent-kit"];
  const sourceCondition = "inputs.scope == 'source-agent-kit'";
  if (!String(sourceJob?.if ?? "").includes(sourceCondition) || !needsOf(sourceJob).includes("identity")) {
    violations.push({ file, code: "release-source-scope-gate-invalid", details: "source-agent-kit" });
  }
  if (
    !String(sourcePublish?.if ?? "").includes("inputs.publish == true")
    || !String(sourcePublish?.if ?? "").includes(sourceCondition)
    || sourcePublish?.permissions?.contents !== "write"
    || sourcePublish?.permissions?.checks !== "read"
    || sourcePublish?.environment !== "release"
    || !needsOf(sourcePublish).includes("identity")
    || !needsOf(sourcePublish).includes("source-agent-kit")
  ) {
    violations.push({ file, code: "release-source-publish-gate-invalid" });
  }

  const identityRun = jobRunText(workflow.jobs?.identity);
  const verifyRun = jobRunText(workflow.jobs?.verify);
  const buildRun = jobRunText(buildJob);
  const agentKitRun = jobRunText(workflow.jobs?.["agent-kit"]);
  const assembleRun = jobRunText(workflow.jobs?.assemble);
  const publishRun = jobRunText(publish);
  const sourceRun = jobRunText(sourceJob);
  const sourcePublishRun = jobRunText(sourcePublish);
  if (
    !identityRun.includes('test "$EVENT_NAME" = "workflow_dispatch"')
    || !identityRun.includes('test "$REF_TYPE" = "tag"')
  ) {
    violations.push({ file, code: "release-manual-tag-ref-gate-missing" });
  }
  for (const required of [
    "pnpm --silent agent-kit:build --out-dir",
    "useful.agent-kit.build-result.v1",
    "useful.agent-kit.manifest.v1",
    'receipt="$zip.sha256"',
    "sha256sum --check --strict",
    "value.product.version !== process.env.VERSION",
    "value.source.revision !== process.env.REVISION",
    "Agent Kit asset name/path binding failed",
    "Agent Kit asset digest binding failed",
    "Agent Kit receipt bytes binding failed",
    "publicationAuthorized",
    "legalMappingApproved",
    "Agent Kit builder must not authorize publication",
    "Agent Kit legal mapping is not approved",
  ]) {
    if (!agentKitRun.includes(required)) violations.push({ file, code: "release-agent-kit-contract-missing", details: required });
  }
  for (const required of [
    "public-source-check.mjs --json",
    "gen-sbom.mjs",
    "pnpm --silent agent-kit:build --out-dir",
    "publicationAuthorized !== false",
    "legalMappingApproved !== true",
    "SOURCE-CHECK.json",
    "SOURCE-MANIFEST.json",
    "SOURCE-PUBLISH-GATE.json",
    "BUILD-PROVENANCE.json",
    "RELEASE-ASSETS.txt",
    "SHA256SUMS.txt",
    "NON-DESKTOP PREVIEW",
    "desktopAssetsIncluded: false",
    "sha256sum --check --strict",
    "unzip -Z1",
    "useful.agent-kit.manifest.v1",
    "Agent Kit MANIFEST",
    "is not a closed schema",
    "Agent Kit MANIFEST command drifted",
    "Agent Kit ZIP entries are not closed by MANIFEST.json",
  ]) {
    if (!sourceRun.includes(required)) violations.push({ file, code: "release-source-evidence-contract-missing", details: required });
  }
  if (agentKitRun.includes("agent-kit:build -- --out-dir") || sourceRun.includes("agent-kit:build -- --out-dir")) {
    violations.push({
      file,
      code: "release-agent-kit-argument-separator-invalid",
      details: "pnpm must not forward a literal -- argument to the strict Agent Kit CLI",
    });
  }
  for (const forbidden of [
    "tauri build", "WINDOWS_CERTIFICATE_BASE64", "APPLE_CERTIFICATE", "USEFUL_UPDATE_ROOT_PUBKEY_HEX",
    "MEDIA-RUNTIMES.json", "release-signing-status.mjs",
  ]) {
    if (sourceRun.includes(forbidden)) violations.push({ file, code: "release-source-desktop-gate-leak", details: forbidden });
  }
  for (const required of [
    "status=success&per_page=100",
    ".display_title == $dryRunTitle",
    "Useful source-agent-kit $RELEASE_CHANNEL $RELEASE_TAG publish=false",
    "earlier successful source-agent-kit dry-run",
    "ownerAuthorized:true",
    "desktopAssetsAuthorized:false",
  ]) {
    if (!identityRun.includes(required)) violations.push({ file, code: "release-source-owner-gate-missing", details: required });
  }
  if (!identityRun.includes("printf '%s\\n' \"$RELEASE_ACTORS\" | tr ',[:space:]' '\\n' | sed '/^$/d'")) {
    violations.push({
      file,
      code: "release-source-actor-allowlist-parser-unsafe",
      details: "USEFUL_RELEASE_ACTORS must be newline-terminated before exact per-entry matching",
    });
  }
  for (const required of [
    "public-source-check.mjs --json",
    "RELEASE-ASSETS.txt",
    "SHA256SUMS.txt",
    "SOURCE-PUBLISH-GATE.json",
    "desktopAssetsIncluded !== false",
    "gh release create",
    "--verify-tag",
    "--prerelease",
    "No Desktop Binaries",
    "git ls-remote --tags origin",
    "refs/tags/$IDENTITY_TAG^{}",
    "REMOTE_TAG_COMMIT",
    'test "$REF_NAME" = "$IDENTITY_TAG"',
    "gate.repository !== process.env.REPOSITORY",
    "gate.actor !== process.env.RELEASE_ACTOR",
    "gate.tag !== process.env.IDENTITY_TAG",
    "gate.sourceRevision !== process.env.EXPECTED_SHA",
  ]) {
    if (!sourcePublishRun.includes(required)) violations.push({ file, code: "release-source-publish-revalidation-missing", details: required });
  }
  const sourceCheckoutIndex = stepIndex(sourcePublish, (step) => (
    runnableStep(step) && String(step?.uses ?? "").startsWith("actions/checkout@")
  ));
  const sourcePnpmSetupIndex = stepIndex(sourcePublish, (step) => (
    runnableStep(step)
    && String(step?.uses ?? "").startsWith("pnpm/action-setup@")
    && String(step?.with?.version ?? "") === "9.15.0"
  ));
  const sourceNodeSetupIndex = stepIndex(sourcePublish, (step) => (
    runnableStep(step)
    && String(step?.uses ?? "").startsWith("actions/setup-node@")
    && String(step?.with?.["node-version"] ?? "") === "20"
    && String(step?.with?.cache ?? "") === "pnpm"
  ));
  const sourceInstallIndex = stepIndex(sourcePublish, (step) => (
    stepRunsExact(step, "pnpm install --frozen-lockfile")
  ));
  const sourceCheckIndex = stepIndex(sourcePublish, (step) => String(step?.run ?? "").includes("public-source-check.mjs --json"));
  const sourceDownloadIndex = stepIndex(sourcePublish, (step) => String(step?.uses ?? "").startsWith("actions/download-artifact@"));
  if (
    sourceCheckoutIndex < 0
    || sourcePnpmSetupIndex < 0
    || sourceNodeSetupIndex < 0
    || sourceInstallIndex < 0
    || sourceCheckoutIndex >= sourcePnpmSetupIndex
    || sourcePnpmSetupIndex >= sourceNodeSetupIndex
    || sourceNodeSetupIndex >= sourceInstallIndex
    || sourceInstallIndex >= sourceCheckIndex
  ) {
    violations.push({ file, code: "release-source-publish-dependencies-missing" });
  }
  if (sourceCheckIndex < 0 || sourceDownloadIndex < 0 || sourceCheckIndex >= sourceDownloadIndex) {
    violations.push({ file, code: "release-source-check-not-clean", details: "publish-source-agent-kit" });
  }
  if (sourcePublishRun.includes("source-release-candidate/*")) {
    violations.push({ file, code: "release-source-publish-wildcard-forbidden" });
  }
  const sourceCreateRun = String((sourcePublish?.steps ?? []).find((step) => String(step?.run ?? "").includes("gh release create"))?.run ?? "");
  if (
    sourceCreateRun.indexOf("git ls-remote --tags origin") < 0
    || sourceCreateRun.indexOf("git ls-remote --tags origin") > sourceCreateRun.indexOf("gh release create")
    || !sourceCreateRun.includes('test "$REMOTE_TAG_COMMIT" = "$EXPECTED_SHA"')
  ) {
    violations.push({ file, code: "release-source-remote-tag-check-order-invalid" });
  }
  for (const required of [
    "git ls-remote --tags origin",
    "refs/tags/$TAG^{}",
    "REMOTE_TAG_COMMIT",
    'test "$REF_NAME" = "$TAG"',
    'test "$REMOTE_TAG_COMMIT" = "$EXPECTED_SHA"',
  ]) {
    if (!publishRun.includes(required)) violations.push({ file, code: "release-desktop-remote-tag-gate-missing", details: required });
  }
  const desktopCreateRun = String((publish?.steps ?? []).find((step) => String(step?.name ?? "").includes("Create GitHub Release"))?.run ?? "");
  if (
    desktopCreateRun.indexOf("git ls-remote --tags origin") < 0
    || desktopCreateRun.indexOf("git ls-remote --tags origin") > desktopCreateRun.indexOf("release create")
    || !desktopCreateRun.includes('test "$REMOTE_TAG_COMMIT" = "$EXPECTED_SHA"')
  ) {
    violations.push({ file, code: "release-desktop-remote-tag-check-order-invalid" });
  }
  const assembleNeeds = new Set(needsOf(workflow.jobs?.assemble));
  if (!assembleNeeds.has("agent-kit")) violations.push({ file, code: "release-assemble-agent-kit-need-missing" });
  for (const required of [
    "release-publish-gate.mjs",
    "check-runs?filter=all&per_page=100",
    "--paginate --slurp",
    "max_by(.id)",
    "--media-source-evidence-path",
    "--media-source-evidence-sha256",
  ]) {
    if (!identityRun.includes(required)) violations.push({ file, code: "release-identity-gate-missing", details: required });
  }
  for (const required of [
    "node scripts/public-source-check.mjs --json",
    "node scripts/check-brand.mjs --json",
    "pnpm policy:test",
    "node scripts/release-readiness.mjs --json",
    "pnpm -r test",
    "cargo test --workspace",
    "go test -race ./...",
  ]) {
    if (!(workflow.jobs?.verify?.steps ?? []).some((step) => stepRunsExact(step, required))) {
      violations.push({ file, code: "release-verification-command-missing", details: required });
    }
  }
  for (const required of [
    "go build -o \"$RUNNER_TEMP/useful-source-server\"",
    "git status --porcelain --untracked-files=all",
  ]) {
    if (!verifyRun.includes(required)) violations.push({ file, code: "release-verification-command-missing", details: required });
  }
  const buildEnv = workflow.jobs?.build?.env ?? {};
  if (
    !String(buildEnv.USEFUL_UPDATE_ROOT_PUBKEY_HEX ?? "").includes("needs.identity.outputs.update_root_pubkey")
    || !String(buildEnv.USEFUL_UPDATE_FEED_URL_TEMPLATE ?? "").includes("needs.identity.outputs.update_feed_template")
  ) {
    violations.push({ file, code: "release-production-update-trust-injection-missing" });
  }
  if (!buildRun.includes('test -z "${USEFUL_ALLOW_DEVELOPMENT_UPDATE_TRUST:-}"')) {
    violations.push({ file, code: "release-development-trust-rejection-missing" });
  }
  inspectLinuxDesktopDependencies(file, workflow.jobs?.verify, "release-verify-linux-desktop-dependency-missing");
  inspectLinuxDesktopDependencies(
    file,
    buildJob,
    "release-linux-desktop-dependency-missing",
    "matrix.platform == 'linux'",
  );
  const windowsMatrix = (buildJob?.strategy?.matrix?.include ?? []).find((entry) => entry?.platform === "windows");
  if (windowsMatrix?.runner !== "windows-2022") {
    violations.push({ file, code: "release-windows-runner-baseline-invalid", details: windowsMatrix?.runner ?? "missing" });
  }
  const iconValidate = stepIndex(buildJob, (step) => {
    const run = String(step?.run ?? "");
    return [
      "git status --porcelain --untracked-files=all",
      "icons/icon.icns",
      "icons/icon.ico",
      "icons/icon.png",
      'test -s "$icon"',
    ]
      .every((required) => run.includes(required));
  });
  const nativeCompile = stepIndex(buildJob, (step) => String(step?.run ?? "").includes("tauri build --target"));
  if (iconValidate < 0 || nativeCompile < 0 || iconValidate >= nativeCompile) {
    violations.push({ file, code: "release-platform-icon-gate-missing" });
  }
  if (buildRun.includes("tauri icon")) {
    violations.push({ file, code: "release-icon-generation-forbidden" });
  }
  const windowsFetch = buildSteps.find((step) => String(step?.run ?? "").includes("scripts/fetch-binaries.ps1"));
  const windowsFetchIndex = buildSteps.indexOf(windowsFetch);
  const windowsBundleIndexes = buildSteps
    .map((step, index) => String(step?.run ?? "").includes("--bundles nsis") ? index : -1)
    .filter((index) => index >= 0);
  if (
    !windowsFetch
    || String(windowsFetch?.if ?? "") !== "matrix.platform == 'windows'"
    || windowsFetch?.["continue-on-error"] === true
    || windowsBundleIndexes.length !== 2
    || windowsBundleIndexes.some((index) => index >= windowsFetchIndex)
  ) {
    violations.push({ file, code: "release-windows-full-media-fetch-gate-invalid" });
  }
  const windowsPackage = windowsIdentityStep;
  const windowsPackageRun = String(windowsPackage?.run ?? "");
  for (const required of [
    "windows-x64-setup-lite.exe",
    "windows-x64-portable-lite.zip",
    "windows-x64-portable-full.zip",
    "MEDIA-RUNTIMES.json",
    "release-metadata-media.mjs",
    "ffmpeg.exe",
    "ffprobe.exe",
    "mpv.exe",
    "CHECKSUMS.txt",
    "New-DeterministicPortableZip",
    "$ErrorActionPreference = 'Stop'",
    "$PSNativeCommandUseErrorActionPreference = $true",
    "[StringComparer]::Ordinal",
    "2107-12-31T23:59:58Z",
    "Assert-NoReparsePath",
    "Copy-NewFile",
    "LICENSE",
    "NOTICE",
  ]) {
    if (!windowsPackageRun.includes(required)) {
      violations.push({ file, code: "release-windows-edition-contract-missing", details: required });
    }
  }
  if (windowsPackageRun.includes("Sort-Object FullName")) {
    violations.push({ file, code: "release-windows-culture-sensitive-zip-order-forbidden" });
  }
  const windowsPackageIndex = buildSteps.indexOf(windowsPackage);
  const releaseSizeLines = [
    "$ErrorActionPreference = 'Stop'",
    "& ./scripts/measure-size.ps1 -OutDir release-assets -Target $env:TARGET -ExpectedCommit $env:USEFUL_SIZE_EXPECTED_COMMIT",
    "pnpm size:check --profile release --json",
    "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
  ];
  const sizeIndexes = buildSteps
    .map((step, index) => runLines(step).includes("pnpm size:check --profile release --json") ? index : -1)
    .filter((index) => index >= 0);
  const sizeIndex = sizeIndexes.length === 1 ? sizeIndexes[0] : -1;
  const sizeStep = sizeIndex >= 0 ? buildSteps[sizeIndex] : undefined;
  const uploadBuildIndex = buildSteps.findIndex((step) => (
    runnableStep(step) && String(step?.uses ?? "").startsWith("actions/upload-artifact@")
  ));
  if (
    windowsPackageIndex < 0
    || sizeIndexes.length !== 1
    || uploadBuildIndex < 0
    || !(windowsPackageIndex < sizeIndex && sizeIndex < uploadBuildIndex)
    || !stepRunsExactLines(sizeStep, releaseSizeLines, { allowedCondition: "matrix.platform == 'windows'" })
    || String(sizeStep?.shell ?? "") !== "pwsh"
    || !stepEnvIsExact(sizeStep, {
      USEFUL_SIZE_EXPECTED_COMMIT: "${{ github.sha }}",
      TARGET: "${{ matrix.target }}",
    })
  ) {
    violations.push({ file, code: "release-size-budget-production-gate-invalid" });
  }
  inspectUploadPathClosure(file, workflow, [
    {
      jobId: "source-agent-kit",
      name: "useful-source-agent-kit-candidate-${{ needs.identity.outputs.version }}",
      paths: ["source-release-candidate/*"],
    },
    { jobId: "sbom", name: "useful-sbom", paths: ["dist-sbom/sbom.cdx.json"] },
    {
      jobId: "agent-kit",
      name: "useful-agent-kit",
      paths: ["${{ runner.temp }}/useful-agent-kit/*"],
    },
    {
      jobId: "build",
      name: "useful-build-${{ matrix.platform }}-${{ matrix.arch }}",
      paths: ["release-assets/*", "signing-${{ matrix.platform }}-${{ matrix.arch }}.json"],
    },
    {
      jobId: "assemble",
      name: "useful-release-candidate-${{ needs.identity.outputs.version }}",
      paths: ["release-candidate/*"],
    },
  ], "release-size-report-asset-forbidden");
  const windowsImport = buildSteps.find((step) => step?.id === "windows-cert");
  const windowsCleanup = buildSteps.find((step) => String(step?.name ?? "").includes("Remove ephemeral Windows certificate material"));
  const windowsImportRun = String(windowsImport?.run ?? "");
  if (
    windowsImportRun.indexOf("thumbprint=$($cert.Thumbprint)") < 0
    || windowsImportRun.indexOf("thumbprint=$($cert.Thumbprint)") > windowsImportRun.indexOf("ConvertTo-Json")
    || !windowsImportRun.includes("useful-signing-thumbprint.txt")
    || !windowsImportRun.includes("[IO.FileMode]::CreateNew")
    || !windowsImportRun.includes("} catch {")
    || !windowsImportRun.includes('Remove-Item -LiteralPath "Cert:\\CurrentUser\\My\\$($cert.Thumbprint)"')
  ) {
    violations.push({ file, code: "release-windows-thumbprint-output-too-late" });
  }
  const windowsCleanupRun = String(windowsCleanup?.run ?? "");
  if (
    String(windowsCleanup?.if ?? "") !== "always() && matrix.platform == 'windows'"
    || !String(windowsCleanup?.env?.SIGNING_THUMBPRINT ?? "").includes("steps.windows-cert.outputs.thumbprint")
    || !windowsCleanupRun.includes("$env:SIGNING_THUMBPRINT")
    || !windowsCleanupRun.includes("useful-signing-thumbprint.txt")
    || !windowsCleanupRun.includes("Get-Content -LiteralPath $receiptPath")
    || !windowsCleanupRun.includes("finally")
    || !windowsCleanupRun.includes("useful-signing.pfx")
    || !windowsCleanupRun.includes("tauri.windows.signing.json")
  ) {
    violations.push({ file, code: "release-windows-certificate-cleanup-invalid" });
  }

  const macosAvailability = buildSteps.find((step) => step?.id === "macos-signing");
  const macosImport = buildSteps.find((step) => step?.id === "macos-cert");
  const macosSignedBundle = buildSteps.find((step) => (
    String(step?.name ?? "").includes("signed and notarized macOS DMG")
  ));
  const macosCleanup = buildSteps.find((step) => String(step?.name ?? "").includes("Remove ephemeral macOS certificate material"));
  const requiredMacSecrets = [
    "APPLE_CERTIFICATE",
    "APPLE_CERTIFICATE_PASSWORD",
    "APPLE_KEYCHAIN_PASSWORD",
    "APPLE_ID",
    "APPLE_PASSWORD",
    "APPLE_TEAM_ID",
  ];
  if (
    !macosAvailability
    || requiredMacSecrets.some((name) => !String(macosAvailability.env?.[name] ?? "").includes(`secrets.${name}`))
    || !requiredMacSecrets.every((name) => String(macosAvailability.run ?? "").includes(name))
  ) {
    violations.push({ file, code: "release-macos-signing-completeness-gate-invalid" });
  }
  const macosImportRun = String(macosImport?.run ?? "");
  for (const required of [
    "/usr/bin/base64 -D",
    "security create-keychain",
    "security unlock-keychain",
    "security import",
    "security set-key-partition-list",
    "security find-identity -v -p codesigning",
    "Expected exactly one valid codesigning identity",
    "identity=%s",
  ]) {
    if (!macosImportRun.includes(required)) {
      violations.push({ file, code: "release-macos-ephemeral-keychain-import-invalid", details: required });
    }
  }
  if (
    !String(macosSignedBundle?.env?.APPLE_SIGNING_IDENTITY ?? "").includes("steps.macos-cert.outputs.identity")
    || Object.prototype.hasOwnProperty.call(macosSignedBundle?.env ?? {}, "APPLE_CERTIFICATE")
    || Object.prototype.hasOwnProperty.call(macosSignedBundle?.env ?? {}, "APPLE_CERTIFICATE_PASSWORD")
  ) {
    violations.push({ file, code: "release-macos-derived-identity-not-used" });
  }
  const macosCleanupRun = String(macosCleanup?.run ?? "");
  if (
    !String(macosCleanup?.if ?? "").includes("always()")
    || !macosCleanupRun.includes("security delete-keychain")
    || !macosCleanupRun.includes('rm -f -- "$p12" "$keychain"')
  ) {
    violations.push({ file, code: "release-macos-keychain-cleanup-missing" });
  }
  for (const jobId of ["assemble", "publish"]) {
    const job = workflow.jobs?.[jobId];
    const sourceCheck = stepIndex(job, (step) => String(step?.run ?? "").includes("public-source-check.mjs --json"));
    const download = stepIndex(job, (step) => String(step?.uses ?? "").startsWith("actions/download-artifact@"));
    if (sourceCheck < 0 || download < 0 || sourceCheck >= download) {
      violations.push({ file, code: "release-source-check-not-clean", details: jobId });
    }
  }
  for (const required of [
    "SOURCE-MANIFEST.json",
    "SOURCE-CHECK.json",
    "BUILD-PROVENANCE.json",
    "MEDIA-RUNTIMES.json",
    "RELEASE-ASSETS.txt",
    "THIRD_PARTY_NOTICES.md",
    "SHA256SUMS.txt",
    "release-signing-status.mjs",
    "sourceTimestamp",
    "subjects",
    "sha256sum --check SHA256SUMS.txt",
    "agent-kit.zip",
    "agent-kit.zip.sha256",
    "NOT FOR PUBLIC DISTRIBUTION",
    "mediaSourceCompliance",
    "media.releaseAssets",
    "duplicate release candidate basename",
    "constants.COPYFILE_EXCL",
    "flag: 'wx'",
    "assertPathChain",
    "release candidate input collides with reserved generated name",
  ]) {
    if (!assembleRun.includes(required)) violations.push({ file, code: "release-evidence-asset-missing", details: required });
  }
  if (assembleRun.includes("-exec cp") || /\bcp\s+[^\n]+release-candidate/.test(assembleRun)) {
    violations.push({ file, code: "release-candidate-overwriting-copy-forbidden" });
  }
  for (const generated of ["RELEASE-METADATA.json", "RELEASE-NOTES.md", "RELEASE-ASSETS.txt", "BUILD-PROVENANCE.json", "SHA256SUMS.txt"]) {
    if (!assembleRun.includes(`'${generated}'`)) violations.push({ file, code: "release-generated-name-not-reserved", details: generated });
  }
  if ((assembleRun.match(/set -o noclobber/g) ?? []).length < 3) {
    violations.push({ file, code: "release-generated-output-exclusive-create-missing" });
  }
  if (
    !publishRun.includes("RELEASE-ASSETS.txt")
    || !publishRun.includes("check-runs?filter=all&per_page=100")
    || !publishRun.includes("--paginate --slurp")
    || !publishRun.includes("max_by(.id)")
    || !publishRun.includes("--media-source-evidence-path")
    || !publishRun.includes("--media-source-evidence-sha256")
    || !publishRun.includes("--status release-candidate/SIGNING-STATUS.json")
    || !publishRun.includes("--manifest release-candidate/MEDIA-RUNTIMES.json")
    || !publishRun.includes("BUILD-PROVENANCE.json is not the exact closed release statement")
    || !publishRun.includes("agent_receipt_hash")
    || !publishRun.includes("SHA256SUMS.txt")
  ) {
    violations.push({ file, code: "release-publish-revalidation-missing" });
  }
  const publishChecksumStep = (publish?.steps ?? []).find((step) => String(step?.run ?? "").includes("sha256sum --check SHA256SUMS.txt"));
  const publishChecksumRun = String(publishChecksumStep?.run ?? "");
  const checksumSetMarker = "SHA256SUMS entry set does not exactly match RELEASE-ASSETS.txt";
  for (const required of [
    "Invalid SHA256SUMS entry format",
    "SHA256SUMS.txt contains duplicate asset entries",
    checksumSetMarker,
    "checksumText.endsWith('\\n')",
  ]) {
    if (!publishChecksumRun.includes(required)) {
      violations.push({ file, code: "release-checksum-closed-set-gate-missing", details: required });
    }
  }
  if (
    publishChecksumRun.indexOf(checksumSetMarker) < 0
    || publishChecksumRun.indexOf(checksumSetMarker) > publishChecksumRun.indexOf("sha256sum --check SHA256SUMS.txt")
  ) {
    violations.push({ file, code: "release-checksum-set-check-order-invalid" });
  }
  if (assembleRun.includes("new Date(")) {
    violations.push({ file, code: "release-wall-clock-metadata-forbidden" });
  }
  if (
    !assembleRun.includes("name !== 'BUILD-PROVENANCE.json' && name !== 'SHA256SUMS.txt'")
    || !assembleRun.includes('sha256sum "$asset" >> SHA256SUMS.txt')
  ) {
    violations.push({ file, code: "release-provenance-subject-boundary-invalid" });
  }
  for (const step of publish?.steps ?? []) {
    const run = String(step?.run ?? "");
    if (run.includes("release create") && run.includes("release-candidate/*")) {
      violations.push({ file, code: "release-publish-wildcard-forbidden" });
    }
  }
}

async function inspectDependabotConfiguration() {
  const activePath = path.join(repoRoot, ".github", "dependabot.yml");
  try {
    await readFile(activePath, "utf8");
    dependabotEvidence.activePresent = true;
    violations.push({ file: ".github/dependabot.yml", code: "active-dependabot-forbidden" });
  } catch (error) {
    if (error?.code !== "ENOENT") {
      dependabotEvidence.activePresent = true;
      violations.push({ file: ".github/dependabot.yml", code: "active-dependabot-unreadable", details: String(error) });
    }
  }

  const examplePath = path.join(repoRoot, ".github", "dependabot.yml.example");
  let source;
  try {
    source = await readFile(examplePath, "utf8");
    dependabotEvidence.examplePresent = true;
  } catch (error) {
    violations.push({
      file: ".github/dependabot.yml.example",
      code: error?.code === "ENOENT" ? "dependabot-example-missing" : "dependabot-example-unreadable",
      details: error?.code === "ENOENT" ? undefined : String(error),
    });
    return;
  }

  let config;
  try {
    config = parse(source);
  } catch (error) {
    violations.push({ file: ".github/dependabot.yml.example", code: "dependabot-example-invalid-yaml", details: String(error) });
    return;
  }
  const updates = Array.isArray(config?.updates) ? config.updates : [];
  dependabotEvidence.ecosystems = updates.map((update) => String(update?.["package-ecosystem"] ?? "")).sort();
  const expected = new Map([
    ["npm", "/"],
    ["cargo", "/"],
    ["gomod", "/services"],
    ["docker", "/deploy/docker-compose"],
    ["github-actions", "/"],
  ]);
  if (config?.version !== 2 || updates.length !== expected.size) {
    violations.push({ file: ".github/dependabot.yml.example", code: "dependabot-example-ecosystem-set-invalid" });
    return;
  }
  const seen = new Set();
  for (const update of updates) {
    const ecosystem = String(update?.["package-ecosystem"] ?? "");
    if (
      !expected.has(ecosystem)
      || seen.has(ecosystem)
      || update?.directory !== expected.get(ecosystem)
      || update?.schedule?.interval !== "weekly"
      || update?.schedule?.day !== "monday"
      || update?.["open-pull-requests-limit"] !== 5
    ) {
      violations.push({
        file: ".github/dependabot.yml.example",
        code: "dependabot-example-entry-invalid",
        details: ecosystem || "missing",
      });
    }
    seen.add(ecosystem);
  }
}

const files = (await readdir(workflowRoot))
  .filter((file) => /\.ya?ml$/i.test(file))
  .sort();

for (const required of ["ci.yml", "codeql.yml", "dependency-review.yml", "platform-bundles.yml", "release.yml"]) {
  if (!files.includes(required)) violations.push({ file: required, code: "required-workflow-missing" });
}

for (const file of files) {
  const source = await readFile(path.join(workflowRoot, file), "utf8");
  let workflow;
  try {
    workflow = parse(source);
  } catch (error) {
    violations.push({ file, code: "invalid-yaml", details: String(error) });
    continue;
  }

  if (!workflow || typeof workflow !== "object") {
    violations.push({ file, code: "invalid-workflow-root" });
    continue;
  }
  inspectFirstPublicActivation(file, workflow);
  if (workflow.on && Object.prototype.hasOwnProperty.call(workflow.on, "pull_request_target")) {
    violations.push({ file, code: "pull-request-target-forbidden" });
  }
  if (!Object.prototype.hasOwnProperty.call(workflow, "permissions")) {
    violations.push({ file, code: "top-level-permissions-missing" });
  } else if (workflow.permissions === "write-all") {
    violations.push({ file, code: "write-all-forbidden", location: "permissions" });
  }

  for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
    if (!job || typeof job !== "object") continue;
    if (job.permissions === "write-all") {
      violations.push({ file, code: "write-all-forbidden", location: `jobs.${jobId}.permissions` });
    }
    inspectSteps(file, job.steps, `jobs.${jobId}`);
  }
  if (file === "ci.yml" || file === "platform-bundles.yml") inspectPreviewWorkflow(file, workflow);
  if (file === "ci.yml") inspectCiWorkflow(file, workflow);
  if (file === "dependency-review.yml") inspectDependencyReviewWorkflow(file, workflow);
  if (file === "platform-bundles.yml") inspectPlatformBundlesWorkflow(file, workflow);
  if (file === "release.yml") inspectReleaseWorkflow(file, workflow);
}

await inspectDependabotConfiguration();
workflowEvidence.sort((left, right) => left.file.localeCompare(right.file));

const result = {
  schemaVersion: "useful.workflow-check.v1",
  ok: violations.length === 0,
  workflowCount: files.length,
  violations,
  activationPolicy: "first-public-manual-only",
  evidenceKind: "local-static-configuration",
  remoteExecutionChecked: false,
  workflows: workflowEvidence,
  dependabot: dependabotEvidence,
};

if (jsonMode) process.stdout.write(`${JSON.stringify(result)}\n`);
else {
  process.stdout.write(`Useful workflows: ${result.ok ? "PASS" : "FAIL"}; workflows=${files.length}; violations=${violations.length}\n`);
  for (const violation of violations) {
    process.stderr.write(`- ${violation.file}: ${violation.code}${violation.details ? ` (${violation.details})` : ""}\n`);
  }
}
process.exitCode = result.ok ? 0 : 1;
