#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFile, lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readMediaRuntimeLock } from "./release-metadata-media.mjs";

export const RELEASE_PUBLISH_GATE_SCHEMA = "useful.release-publish-gate.v2";
export const DEVELOPMENT_UPDATE_ROOT_PUBKEY_HEX =
  "3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29";

const CHANNELS = new Set(["stable", "beta", "nightly"]);
const REQUIRED_FEED_PLACEHOLDERS = ["channel", "platform", "arch"];
const MEDIA_EVIDENCE_FIELDS = ["components", "continuousAccessMethod", "mediaRuntimeLockSha256", "schemaVersion"];
const MEDIA_COMPONENT_FIELDS = ["binaryArchiveSha256", "buildAssets", "completeSourceAssets", "licenseAssets", "name", "version"];
const MEDIA_ASSET_FIELDS = ["path", "releaseAssetName", "sha256", "sizeBytes"];

function parseStrictBoolean(value, name) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`${name} 必须是 true 或 false`);
}
function requireSha256(value, name) {
  if (!/^[0-9a-f]{64}$/i.test(value ?? "") || /^0{64}$/.test(value)) {
    throw new Error(`${name} 必须是非零 SHA-256 hex`);
  }
  return value.toLowerCase();
}

function validateUpdateRoot(value) {
  if (!/^[0-9a-f]{64}$/i.test(value ?? "")) {
    throw new Error("USEFUL_UPDATE_ROOT_PUBKEY_HEX 必须是 32 字节 Ed25519 公钥 hex");
  }
  const normalized = value.toLowerCase();
  if (normalized === DEVELOPMENT_UPDATE_ROOT_PUBKEY_HEX || /^0{64}$/.test(normalized)) {
    throw new Error("正式 Release 拒绝开发占位更新根公钥");
  }
  return normalized;
}

function validateFeedTemplate(value) {
  if (!value) throw new Error("缺少 USEFUL_UPDATE_FEED_URL_TEMPLATE");
  if (/[\r\n]/.test(value)) throw new Error("更新 feed 模板不能包含换行");
  const placeholders = [...value.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]);
  if (value.replaceAll(/\{[^{}]+\}/g, "").includes("{") || value.replaceAll(/\{[^{}]+\}/g, "").includes("}")) {
    throw new Error("更新 feed 模板包含不配对的大括号");
  }
  if (placeholders.some((name) => !REQUIRED_FEED_PLACEHOLDERS.includes(name))) {
    throw new Error("更新 feed 模板包含未知占位符");
  }
  for (const required of REQUIRED_FEED_PLACEHOLDERS) {
    if (!placeholders.includes(required)) throw new Error(`更新 feed 模板缺少 {${required}}`);
  }
  const resolved = value
    .replaceAll("{channel}", "stable")
    .replaceAll("{platform}", "windows")
    .replaceAll("{arch}", "x86_64");
  let url;
  try {
    url = new URL(resolved);
  } catch {
    throw new Error("更新 feed 模板不是有效 URL");
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:") throw new Error("正式更新 feed 必须使用 HTTPS");
  if (url.username || url.password) throw new Error("正式更新 feed 不能包含 URL credentials");
  if (url.hash) throw new Error("正式更新 feed 不能包含 fragment");
  if (
    hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "::1"
    || hostname.endsWith(".example")
    || hostname.endsWith(".invalid")
    || hostname.endsWith(".test")
  ) {
    throw new Error("正式更新 feed 不能使用本地或保留示例域名");
  }
  return value;
}

function parseAllowedActors(value) {
  const actors = [...new Set(String(value ?? "").split(/[\s,]+/).filter(Boolean).map((item) => item.toLowerCase()))];
  if (actors.length === 0) throw new Error("USEFUL_RELEASE_ACTORS 至少需要一个精确账号名");
  return actors;
}

function assertExactFields(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是 object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`${label} 不是闭合 schema`);
}

async function validateRepositoryFile(repoRoot, relativePath, label) {
  if (!relativePath || path.isAbsolute(relativePath)) throw new Error(`${label} 必须是仓库相对路径`);
  const absolute = path.resolve(repoRoot, relativePath);
  const relative = path.relative(repoRoot, absolute).replaceAll("\\", "/");
  if (!relative || relative === ".." || relative.startsWith("../")) throw new Error(`${label} 必须位于仓库内`);
  const rootInfo = await lstat(repoRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error(`${label} repo root 必须是普通目录`);
  const segments = relative.split("/");
  let cursor = repoRoot;
  for (const [index, segment] of segments.entries()) {
    cursor = path.join(cursor, segment);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new Error(`${label} 路径不能包含 symlink/junction: ${segment}`);
    if (index < segments.length - 1 && !info.isDirectory()) throw new Error(`${label} 中间路径必须是目录: ${segment}`);
    if (index === segments.length - 1 && (!info.isFile() || info.size <= 0)) throw new Error(`${label} 必须是非空普通文件`);
  }
  let committedBytes;
  try {
    committedBytes = execFileSync("git", ["-C", repoRoot, "show", `HEAD:${relative}`], { encoding: null, maxBuffer: 256 * 1024 * 1024 });
  } catch {
    throw new Error(`${label} 必须是已提交/已跟踪的仓库文件: ${relative}`);
  }
  const bytes = await readFile(absolute);
  if (!Buffer.from(committedBytes).equals(bytes)) throw new Error(`${label} 必须与 HEAD 中已提交字节完全一致: ${relative}`);
  return {
    path: relative,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.length,
  };
}

function pendingMediaCompliance() {
  return {
    status: "pending",
    distribution: "NOT-FOR-PUBLIC-DISTRIBUTION",
    reason: "media source compliance pending for the exact GPL ffmpeg/ffprobe/mpv binaries",
    requiredActions: [
      "commit complete corresponding source and exact build scripts/configuration",
      "commit the applicable license texts and a continuous-access release-asset mapping",
      "pin USEFUL_MEDIA_SOURCE_EVIDENCE_PATH and USEFUL_MEDIA_SOURCE_EVIDENCE_SHA256",
      "include every evidence/source/build/license asset in RELEASE-ASSETS, SHA256SUMS, and BUILD-PROVENANCE",
    ],
    evidence: null,
    releaseAssets: [],
  };
}

async function validateMediaSourceCompliance({ repoRoot, evidencePath, expectedSha256 }) {
  if (!evidencePath) throw new Error("public publish 缺少 USEFUL_MEDIA_SOURCE_EVIDENCE_PATH; Full is NOT-FOR-PUBLIC-DISTRIBUTION");
  const evidenceFile = await validateRepositoryFile(repoRoot, evidencePath, "media source compliance evidence");
  if (evidenceFile.sha256 !== requireSha256(expectedSha256, "USEFUL_MEDIA_SOURCE_EVIDENCE_SHA256")) {
    throw new Error("media source compliance evidence SHA-256 不匹配");
  }
  const lockPath = path.join(repoRoot, "scripts", "media-runtimes.lock.json");
  const lockFile = await validateRepositoryFile(repoRoot, "scripts/media-runtimes.lock.json", "media runtime lock");
  const lock = await readMediaRuntimeLock(lockPath);
  const evidence = JSON.parse(evidenceFile.bytes.toString("utf8"));
  assertExactFields(evidence, MEDIA_EVIDENCE_FIELDS, "media source compliance evidence");
  if (evidence.schemaVersion !== "useful.media-source-compliance-evidence.v1") throw new Error("media source compliance evidence schemaVersion 不匹配");
  if (evidence.mediaRuntimeLockSha256 !== lockFile.sha256) throw new Error("media source compliance evidence 未绑定精确 media runtime lock");
  if (evidence.continuousAccessMethod !== "github-release-assets") throw new Error("media source compliance evidence 必须使用持续可访问的 github-release-assets");
  if (!Array.isArray(evidence.components) || evidence.components.length !== lock.components.length) {
    throw new Error("media source compliance component cardinality 不匹配");
  }

  const releaseAssets = new Map();
  for (const [index, component] of evidence.components.entries()) {
    const expected = lock.components[index];
    assertExactFields(component, MEDIA_COMPONENT_FIELDS, `media compliance components[${index}]`);
    if (
      component.name !== expected.name
      || component.version !== expected.version
      || component.binaryArchiveSha256 !== expected.archiveSha256
    ) {
      throw new Error(`media source compliance 未绑定精确 binary pin: ${expected.name}`);
    }
    for (const field of ["completeSourceAssets", "buildAssets", "licenseAssets"]) {
      if (!Array.isArray(component[field]) || component[field].length === 0) {
        throw new Error(`media source compliance ${component.name}.${field} 不能为空`);
      }
      for (const [assetIndex, asset] of component[field].entries()) {
        const label = `${component.name}.${field}[${assetIndex}]`;
        assertExactFields(asset, MEDIA_ASSET_FIELDS, label);
        if (!asset.releaseAssetName || asset.releaseAssetName !== path.basename(asset.releaseAssetName) || /[\\/]/.test(asset.releaseAssetName)) {
          throw new Error(`${label}.releaseAssetName 必须是 basename`);
        }
        const file = await validateRepositoryFile(repoRoot, asset.path, label);
        if (file.sha256 !== requireSha256(asset.sha256, `${label}.sha256`) || file.sizeBytes !== asset.sizeBytes) {
          throw new Error(`${label} digest/size 与仓库文件不一致`);
        }
        const descriptor = { category: field, path: file.path, releaseAssetName: asset.releaseAssetName, sha256: file.sha256, sizeBytes: file.sizeBytes };
        const prior = releaseAssets.get(asset.releaseAssetName);
        if (prior && JSON.stringify({ ...prior, category: field }) !== JSON.stringify(descriptor)) {
          throw new Error(`media compliance release asset name 冲突: ${asset.releaseAssetName}`);
        }
        if (!prior) releaseAssets.set(asset.releaseAssetName, descriptor);
      }
    }
  }
  return {
    status: "verified",
    distribution: "PUBLIC-DISTRIBUTION-OWNER-GATE-PASSED",
    reason: null,
    requiredActions: [],
    evidence: {
      path: evidenceFile.path,
      releaseAssetName: path.posix.basename(evidenceFile.path),
      sha256: evidenceFile.sha256,
      sizeBytes: evidenceFile.sizeBytes,
    },
    releaseAssets: [...releaseAssets.values()].sort((a, b) => a.releaseAssetName < b.releaseAssetName ? -1 : a.releaseAssetName > b.releaseAssetName ? 1 : 0),
  };
}

export function validateReleasePublishGate(input) {
  const publish = parseStrictBoolean(input.publish, "publish");
  if (!CHANNELS.has(input.channel)) throw new Error("channel 必须是 stable、beta 或 nightly");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.expectedRepository ?? "")) {
    throw new Error("USEFUL_EXPECTED_REPOSITORY 必须是 owner/repository");
  }
  if (input.repository?.toLowerCase() !== input.expectedRepository.toLowerCase()) {
    throw new Error(`发布仓库身份不匹配：${input.repository} != ${input.expectedRepository}`);
  }
  if (input.visibility !== "public") throw new Error("正式 Useful Release 只允许 public 仓库");
  const allowedActors = parseAllowedActors(input.allowedActors);
  if (!allowedActors.includes(String(input.actor ?? "").toLowerCase())) {
    throw new Error(`GitHub actor 未获发布授权：${input.actor}`);
  }

  const updateRootPublicKey = validateUpdateRoot(input.updateRootPublicKey);
  const updateFeedUrlTemplate = validateFeedTemplate(input.updateFeedUrlTemplate);
  const rootCeremonySha256 = requireSha256(input.rootCeremonySha256, "USEFUL_UPDATE_ROOT_CEREMONY_SHA256");
  return {
    schemaVersion: RELEASE_PUBLISH_GATE_SCHEMA,
    ok: true,
    publish,
    channel: input.channel,
    repository: input.repository,
    visibility: input.visibility,
    actor: input.actor,
    updateRootPublicKey,
    updateRootFingerprint: createHash("sha256").update(Buffer.from(updateRootPublicKey, "hex")).digest("hex"),
    updateFeedUrlTemplate,
    rootCeremonySha256,
  };
}

async function validateStableEvidence({ repoRoot, evidencePath, expectedSha256, tag, rootFingerprint }) {
  if (!evidencePath) throw new Error("stable publish 缺少 USEFUL_STABLE_UPDATE_EVIDENCE_PATH");
  const absolute = path.resolve(repoRoot, evidencePath);
  const relative = path.relative(repoRoot, absolute).replaceAll("\\", "/");
  if (relative.startsWith("../") || relative === ".." || !relative.startsWith("docs/releases/")) {
    throw new Error("stable update evidence 必须是 docs/releases/ 下的仓库文件");
  }
  const committed = await validateRepositoryFile(repoRoot, relative, "stable update evidence");
  const { bytes } = committed;
  const actualSha256 = committed.sha256;
  if (actualSha256 !== requireSha256(expectedSha256, "USEFUL_STABLE_UPDATE_EVIDENCE_SHA256")) {
    throw new Error("stable update evidence SHA-256 不匹配");
  }
  const evidence = JSON.parse(bytes.toString("utf8"));
  if (evidence.schemaVersion !== "useful.stable-update-evidence.v1") throw new Error("stable update evidence schemaVersion 不匹配");
  if (evidence.tag !== tag) throw new Error("stable update evidence tag 不匹配");
  if (evidence.updateRootFingerprint !== rootFingerprint) throw new Error("stable update evidence 根指纹不匹配");
  requireSha256(evidence.updateManifestSha256, "stable evidence updateManifestSha256");
  for (const field of ["updateSignatureVerified", "tamperRejected", "upgradeVerified", "rollbackVerified"]) {
    if (evidence[field] !== true) throw new Error(`stable update evidence 要求 ${field}=true`);
  }
  if (!evidence.approvedBy || Number.isNaN(Date.parse(evidence.approvedAt))) {
    throw new Error("stable update evidence 缺少 approvedBy/approvedAt");
  }
  return { path: relative, sha256: actualSha256 };
}

function parseCliArgs(args) {
  const allowed = new Set([
    "--repository", "--expected-repository", "--visibility", "--actor", "--allowed-actors", "--publish", "--channel",
    "--update-root-pubkey", "--update-feed-template", "--root-ceremony-sha256", "--repo-root",
    "--media-source-evidence-path", "--media-source-evidence-sha256", "--stable-evidence-path", "--stable-evidence-sha256",
    "--tag", "--github-output",
  ]);
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!allowed.has(name)) throw new Error(`未知参数: ${name ?? "<missing>"}`);
    if (values.has(name)) throw new Error(`重复参数: ${name}`);
    if (value === undefined || value.startsWith("--")) throw new Error(`需要 ${name} <value>`);
    values.set(name, value);
  }
  return values;
}

function valueOf(values, name, allowEmpty = false) {
  if (!values.has(name) || (!allowEmpty && values.get(name) === "")) {
    throw new Error(`需要 ${name} <value>`);
  }
  return values.get(name);
}

export async function runCli(args, env = process.env) {
  const values = parseCliArgs(args);
  const gate = validateReleasePublishGate({
    repository: valueOf(values, "--repository"),
    expectedRepository: valueOf(values, "--expected-repository"),
    visibility: valueOf(values, "--visibility"),
    actor: valueOf(values, "--actor"),
    allowedActors: valueOf(values, "--allowed-actors"),
    publish: valueOf(values, "--publish"),
    channel: valueOf(values, "--channel"),
    updateRootPublicKey: valueOf(values, "--update-root-pubkey"),
    updateFeedUrlTemplate: valueOf(values, "--update-feed-template"),
    rootCeremonySha256: valueOf(values, "--root-ceremony-sha256"),
  });
  const repoRoot = path.resolve(valueOf(values, "--repo-root"));
  const mediaEvidencePathRaw = values.has("--media-source-evidence-path")
    ? values.get("--media-source-evidence-path")
    : "";
  const mediaEvidenceShaRaw = values.has("--media-source-evidence-sha256")
    ? values.get("--media-source-evidence-sha256")
    : "";
  const mediaEvidencePath = mediaEvidencePathRaw && mediaEvidencePathRaw !== "-"
    ? mediaEvidencePathRaw
    : "";
  const mediaEvidenceSha = mediaEvidenceShaRaw && mediaEvidenceShaRaw !== "-"
    ? mediaEvidenceShaRaw
    : "";
  // This gate is invoked only for the desktop-full workflow scope, whose
  // closed asset set contains Portable Full alongside the Lite editions.
  // Therefore every public channel must bind the exact committed GPL source
  // evidence before any asset in that scope may be published.
  if (gate.publish && !mediaEvidencePath) {
    throw new Error(
      "public publish 缺少 USEFUL_MEDIA_SOURCE_EVIDENCE_PATH; Full is NOT-FOR-PUBLIC-DISTRIBUTION",
    );
  }
  const mediaSourceCompliance = gate.publish
    ? await validateMediaSourceCompliance({
        repoRoot,
        evidencePath: mediaEvidencePath,
        expectedSha256: mediaEvidenceSha,
      })
    : pendingMediaCompliance();
  let stableEvidence = null;
  if (gate.channel === "stable" && gate.publish) {
    stableEvidence = await validateStableEvidence({
      repoRoot,
      evidencePath: valueOf(values, "--stable-evidence-path", true),
      expectedSha256: valueOf(values, "--stable-evidence-sha256", true),
      tag: valueOf(values, "--tag"),
      rootFingerprint: gate.updateRootFingerprint,
    });
  }
  const result = { ...gate, mediaSourceCompliance, stableEvidence };
  const githubOutput = values.has("--github-output")
    ? valueOf(values, "--github-output")
    : env.GITHUB_OUTPUT;
  if (githubOutput) {
    const lines = [
      `update_root_pubkey=${result.updateRootPublicKey}`,
      `update_root_fingerprint=${result.updateRootFingerprint}`,
      `update_feed_template=${result.updateFeedUrlTemplate}`,
      `root_ceremony_sha256=${result.rootCeremonySha256}`,
      `media_source_compliance_status=${result.mediaSourceCompliance.status}`,
      `media_source_distribution=${result.mediaSourceCompliance.distribution}`,
      `publish_gate_json=${JSON.stringify(result)}`,
    ];
    await appendFile(githubOutput, `${lines.join("\n")}\n`, "utf8");
  }
  return result;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  try {
    process.stdout.write(`${JSON.stringify(await runCli(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
