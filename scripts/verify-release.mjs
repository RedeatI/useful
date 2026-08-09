#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gateRoot = path.join(repoRoot, "artifacts", "release-gate");
const resumeIndex = process.argv.indexOf("--resume-from");
const resumeFrom = resumeIndex >= 0 ? process.argv[resumeIndex + 1] : undefined;
if (resumeIndex >= 0 && !resumeFrom) throw new Error("--resume-from 需要阶段 ID");

const psFile = (file, ...args) => ({
  command: "powershell.exe",
  args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file, ...args],
});
const psCommand = (command) => ({
  command: "powershell.exe",
  args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
});

const stages = [
  { id: "git-state", label: "检查 Git 工作区状态", internal: "git" },
  { id: "version-contract", label: "Useful 产品版本与发布通道漂移检查", command: process.execPath, args: [path.join(repoRoot, "scripts", "check-version-drift.mjs"), "--json"] },
  { id: "doctor", label: "doctor", ...psFile(path.join(repoRoot, "scripts", "useful.ps1"), "doctor") },
  { id: "quality", label: "格式化、lint、typecheck、全语言测试、协议、漂移、迁移、Compose E2E、SBOM", ...psFile(path.join(repoRoot, "scripts", "useful.ps1"), "verify:all") },
  { id: "plugins", label: ".useful 静态源、原生客户端与 Docker 动态源完整生命周期", ...psFile(path.join(repoRoot, "scripts", "useful.ps1"), "test:plugins") },
  { id: "tauri-release", label: "Tauri native-test development-trust unsigned QA Release 构建", env: { USEFUL_ALLOW_DEVELOPMENT_UPDATE_TRUST: "1" }, ...psCommand("& pnpm --filter '@useful/app' tauri build --no-bundle --features native-test; exit $LASTEXITCODE") },
  { id: "native-smoke", label: "真实 Tauri 38/38 全工具路由、SQLite、剪贴板、媒体 deep-link 与导出", ...psFile(path.join(repoRoot, "scripts", "native-smoke.ps1"), "-SkipBuild") },
  { id: "action-deeplinks", label: "36/36 action 冷启动与单实例直达", ...psFile(path.join(repoRoot, "scripts", "action-deeplink-smoke.ps1"), "-SkipBuild") },
  { id: "shortcuts", label: "五个 action 快捷方式创建、启动、修复、删除", ...psFile(path.join(repoRoot, "scripts", "useful.ps1"), "test:shortcuts") },
  { id: "sidecar-leaks", label: "Useful、mpv、ffmpeg、ffprobe 残留检查", internal: "processes" },
  { id: "media-runtimes", label: "固定版本媒体运行时下载与 SHA-256 校验", ...psFile(path.join(repoRoot, "scripts", "fetch-binaries.ps1")) },
  { id: "bootstrap-tests", label: "development-trust unsigned QA bootstrap Release 构建与测试", env: { USEFUL_ALLOW_DEVELOPMENT_UPDATE_TRUST: "1" }, ...psCommand("& cargo build --release -p useful-bootstrap; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; & cargo test -p useful-bootstrap --no-fail-fast; exit $LASTEXITCODE") },
  { id: "portable-packages", label: "Useful Lite/Full 便携包构建与 SHA-256", ...psFile(path.join(repoRoot, "scripts", "package-release.ps1"), "-Edition", "All") },
  { id: "release-dry-run", label: "SBOM、测试签名、生产隔离与签名验证", ...psFile(path.join(repoRoot, "scripts", "useful.ps1"), "release:dry-run") },
  { id: "signature-reverify", label: "Release 制品独立重新验签", ...psCommand("& node packages/useful-cli/bin/useful.mjs app-update verify dist-release/app-update.test.json --root dist-release/test-keys; exit $LASTEXITCODE") },
  { id: "release-evidence", label: "Release Evidence、制品哈希与目录归档", internal: "evidence" },
];

function runGit(args, options = {}) {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} 失败`);
  return result.stdout;
}

async function sha256File(file) {
  const bytes = await readFile(file);
  return createHash("sha256").update(bytes).digest("hex");
}

async function sourceState() {
  const head = runGit(["rev-parse", "HEAD"]).trim();
  const branch = runGit(["branch", "--show-current"]).trim();
  const names = runGit(["ls-files", "-m", "-o", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean)
    .sort();
  const files = [];
  for (const name of names) {
    const absolute = path.join(repoRoot, name);
    try {
      if ((await stat(absolute)).isFile()) files.push({ path: name, sha256: await sha256File(absolute) });
    } catch {}
  }
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ head, files }))
    .digest("hex");
  return { head, branch, dirty: files.length > 0, changedFileCount: files.length, files, fingerprint };
}

async function newestGate() {
  await mkdir(gateRoot, { recursive: true });
  const entries = await readdir(gateRoot, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().at(-1);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function verifyResumeManifest(runDir) {
  const manifestPath = path.join(runDir, "resume-manifest.json");
  const manifest = await readJson(manifestPath);
  for (const entry of manifest.files) {
    const file = path.join(runDir, entry.path);
    if (await sha256File(file) !== entry.sha256) {
      throw new Error(`前序证据摘要变化，拒绝恢复: ${entry.path}`);
    }
  }
}

async function writeResumeManifest(runDir, results) {
  const files = [];
  for (const result of results.filter((item) => item.status === "passed")) {
    for (const relative of [result.check, result.log].filter(Boolean)) {
      const file = path.join(runDir, relative);
      files.push({ path: relative, sha256: await sha256File(file) });
    }
  }
  await writeFile(path.join(runDir, "resume-manifest.json"), `${JSON.stringify({ files }, null, 2)}\n`);
}

let runDir;
let result;
let startIndex = 0;
const currentSource = await sourceState();

if (resumeFrom) {
  const latest = await newestGate();
  if (!latest) throw new Error("没有可恢复的 release-gate 运行");
  runDir = path.join(gateRoot, latest);
  result = await readJson(path.join(runDir, "result.json"));
  if (result.source.fingerprint !== currentSource.fingerprint) {
    throw new Error("源码指纹已变化，拒绝 ResumeFrom；请完整运行 verify:release");
  }
  await verifyResumeManifest(runDir);
  startIndex = stages.findIndex((stage) => stage.id === resumeFrom);
  if (startIndex < 0) throw new Error(`未知恢复阶段: ${resumeFrom}`);
  result.stages = result.stages.filter((item) => stages.findIndex((stage) => stage.id === item.id) < startIndex);
  result.status = "running";
  result.resumedAt = new Date().toISOString();
} else {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  runDir = path.join(gateRoot, stamp);
  await Promise.all(["checks", "logs", "screenshots", "packages", "hashes", "sbom"].map((name) => mkdir(path.join(runDir, name), { recursive: true })));
  result = {
    scenario: "useful-release-candidate-gate",
    status: "running",
    startedAt: new Date().toISOString(),
    source: currentSource,
    stages: [],
  };
  await writeFile(path.join(runDir, "source-state.json"), `${JSON.stringify(currentSource, null, 2)}\n`);
}

async function persist() {
  await writeFile(path.join(runDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
}

async function runExternal(stage, logPath) {
  return await new Promise((resolve, reject) => {
    const log = createWriteStream(logPath, { flags: "w" });
    const child = spawn(stage.command, stage.args, {
      cwd: repoRoot,
      env: { ...process.env, ...stage.env, PYTHONUTF8: "1" },
      windowsHide: true,
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on("error", (error) => {
      log.end(() => reject(error));
    });
    child.on("close", (code) => {
      log.end(() => resolve(code ?? 1));
    });
  });
}

async function collectEvidence() {
  const dist = path.join(repoRoot, "dist-release");
  const packageNames = ["Useful-Portable-Lite-x64.zip", "Useful-Portable-Full-x64.zip", "MEDIA-RUNTIMES.json"];
  const packages = [];
  for (const name of packageNames) {
    const source = path.join(dist, name);
    const destination = path.join(runDir, "packages", name);
    await copyFile(source, destination);
    const info = await stat(destination);
    packages.push({ name, bytes: info.size, sha256: await sha256File(destination) });
  }
  await copyFile(path.join(dist, "SHA256SUMS.txt"), path.join(runDir, "hashes", "SHA256SUMS.txt"));
  const sbomSource = path.join(repoRoot, "dist-sbom");
  await cp(sbomSource, path.join(runDir, "sbom"), { recursive: true });
  const recorded = (await readFile(path.join(dist, "SHA256SUMS.txt"), "utf8")).toLowerCase();
  for (const item of packages) {
    if (!recorded.includes(`${item.sha256}  ${item.name.toLowerCase()}`)) {
      throw new Error(`SHA256SUMS 与制品不一致: ${item.name}`);
    }
  }
  await writeFile(path.join(runDir, "checks", "release-artifacts.json"), `${JSON.stringify({ packages }, null, 2)}\n`);
  return packages;
}

async function runInternal(stage, logPath) {
  if (stage.internal === "git") {
    await writeFile(logPath, `${JSON.stringify(currentSource, null, 2)}\n`);
    return {
      code: currentSource.dirty ? 1 : 0,
      details: {
        dirty: currentSource.dirty,
        changedFileCount: currentSource.changedFileCount,
        fingerprint: currentSource.fingerprint,
        remediation: currentSource.dirty
          ? "Release Gate 只接受指定 commit 的干净工作树；请提交授权改动并从 fresh clone 重跑。"
          : undefined,
      },
    };
  }
  if (stage.internal === "processes") {
    const command = "$p=@(Get-CimInstance Win32_Process | Where-Object { @('Useful.exe','ffmpeg.exe','ffprobe.exe','mpv.exe') -contains $_.Name }); $p | Select-Object Name,ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Depth 4; if($p.Count -gt 0){exit 1}else{exit 0}";
    const code = await runExternal({ ...psCommand(command) }, logPath);
    return { code };
  }
  if (stage.internal === "evidence") {
    const packages = await collectEvidence();
    await writeFile(logPath, `${JSON.stringify({ packages }, null, 2)}\n`);
    return { code: 0, details: { packages } };
  }
  throw new Error(`未知内部阶段: ${stage.internal}`);
}

await persist();
for (let index = startIndex; index < stages.length; index += 1) {
  const stage = stages[index];
  const startedAt = new Date();
  const logRelative = path.join("logs", `${String(index + 1).padStart(2, "0")}-${stage.id}.log`);
  const logPath = path.join(runDir, logRelative);
  process.stdout.write(`==== [${index + 1}/${stages.length}] ${stage.id}: ${stage.label} ====\n`);
  let code = 1;
  let details;
  try {
    if (stage.internal) ({ code, details } = await runInternal(stage, logPath));
    else code = await runExternal(stage, logPath);
  } catch (error) {
    await writeFile(logPath, `${error.stack ?? error}\n`, { flag: "a" });
    details = { error: String(error) };
  }
  const checkRelative = path.join("checks", `${String(index + 1).padStart(2, "0")}-${stage.id}.json`);
  const stageResult = {
    id: stage.id,
    label: stage.label,
    status: code === 0 ? "passed" : "failed",
    exitCode: code,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    log: logRelative,
    check: checkRelative,
    details,
  };
  await writeFile(path.join(runDir, checkRelative), `${JSON.stringify(stageResult, null, 2)}\n`);
  result.stages.push(stageResult);
  if (code !== 0) {
    result.status = "failed";
    result.failedStage = stage.id;
    result.finishedAt = new Date().toISOString();
    await persist();
    await writeResumeManifest(runDir, result.stages);
    await writeFile(path.join(runDir, "summary.md"), `# Release Gate\n\n- status: FAILED\n- failedStage: ${stage.id}\n- sourceFingerprint: ${currentSource.fingerprint}\n- resume: \\.\\scripts\\useful.ps1 verify:release -ResumeFrom ${stage.id}\n`);
    process.stderr.write(`[FAIL] ${stage.id}，日志: ${logPath}\n`);
    process.exit(1);
  }
  result.status = "running";
  await persist();
  process.stdout.write(`[ OK ] ${stage.id} (${stageResult.durationMs}ms)\n`);
}

result.status = "passed";
result.finishedAt = new Date().toISOString();
result.failedStage = null;
await persist();
await writeResumeManifest(runDir, result.stages);
const packageRows = result.stages.find((item) => item.id === "release-evidence")?.details?.packages ?? [];
const summary = [
  "# Useful Release Candidate Gate",
  "",
  "- status: PASSED",
  `- sourceCommit: ${currentSource.head}`,
  `- sourceFingerprint: ${currentSource.fingerprint}`,
  `- dirtyCandidate: ${currentSource.dirty}`,
  `- stages: ${result.stages.length}/${stages.length}`,
  `- finishedAt: ${result.finishedAt}`,
  "",
  "## Packages",
  "",
  ...packageRows.map((item) => `- ${item.name}: ${item.bytes} bytes, SHA-256 ${item.sha256}`),
  "",
  "All signing in this gate uses NOT-FOR-PRODUCTION test keys.",
  "",
].join("\n");
await writeFile(path.join(runDir, "summary.md"), summary);
process.stdout.write(`[ OK ] verify:release 全部通过，证据: ${runDir}\n`);
