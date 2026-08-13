#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFile, lstat, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RELEASE_SIGNING_STATUS_SCHEMA = "useful.signing-status.v2";

const FULL_PLATFORMS = [
  ["windows", "x64"],
  ["macos", "x64"],
  ["macos", "arm64"],
  ["linux", "x64"],
];
const RELEASE_SCOPES = new Set(["desktop-lite", "desktop-full"]);
const EXACT_FIELDS = ["arch", "platform", "signingStatus", "verification", "version"];
const SUMMARY_FIELDS = ["artifacts", "nonCodeSignedArtifacts", "platforms", "schemaVersion", "scope", "signed", "version"];
const SUMMARY_PLATFORM_FIELDS = [...EXACT_FIELDS, "artifacts"].sort();
const ARTIFACT_FIELDS = ["name", "sha256", "sizeBytes"];

function expectedPlatforms(scope) {
  if (!RELEASE_SCOPES.has(scope)) throw new Error("scope 必须是 desktop-lite 或 desktop-full");
  return scope === "desktop-lite" ? [["windows", "x64"]] : FULL_PLATFORMS;
}

export function expectedReleaseAssets(version, scope = "desktop-full") {
  const windows = [
    `Useful-${version}-windows-x64-setup-lite.exe`,
    `Useful-${version}-windows-x64-portable-lite.zip`,
  ];
  if (scope === "desktop-full") windows.push(
    `Useful-${version}-windows-x64-portable-full.zip`,
    "MEDIA-RUNTIMES.json",
  );
  const entries = [
    ["windows/x64", windows],
    ["macos/x64", [`Useful-${version}-macos-x64.dmg`]],
    ["macos/arm64", [`Useful-${version}-macos-arm64.dmg`]],
    ["linux/x64", [
      `Useful-${version}-linux-x64.AppImage`,
      `Useful-${version}-linux-x64.deb`,
    ]],
    ["agent-kit/n-a", [
      `Useful-${version}-agent-kit.zip`,
      `Useful-${version}-agent-kit.zip.sha256`,
    ]],
  ];
  const platformKeys = new Set(expectedPlatforms(scope).map(([platform, arch]) => `${platform}/${arch}`));
  return new Map(entries.filter(([key]) => key === "agent-kit/n-a" || platformKeys.has(key)));
}

function parseCliArgs(args) {
  const allowed = new Set(["--version", "--scope", "--root", "--status", "--asset-root", "--output", "--github-output"]);
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!allowed.has(name)) throw new Error(`未知参数: ${name ?? "<missing>"}`);
    if (values.has(name)) throw new Error(`重复参数: ${name}`);
    if (!value || value.startsWith("--")) throw new Error(`需要 ${name} <value>`);
    values.set(name, value);
  }
  return values;
}

function valueOf(values, name) {
  if (!values.has(name)) throw new Error(`需要 ${name} <value>`);
  return values.get(name);
}

async function assertExclusiveOutputPath(outputPath) {
  const absolute = path.resolve(outputPath);
  const parsed = path.parse(absolute);
  const segments = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let cursor = parsed.root;
  const rootInfo = await lstat(cursor);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error(`--output 路径根不是普通目录: ${cursor}`);
  for (const [index, segment] of segments.entries()) {
    cursor = path.join(cursor, segment);
    let info;
    try { info = await lstat(cursor); } catch (error) {
      if (error?.code === "ENOENT" && index === segments.length - 1) return absolute;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error(`--output 路径不能包含 symlink/junction: ${cursor}`);
    if (index < segments.length - 1 && !info.isDirectory()) throw new Error(`--output 中间路径不是目录: ${cursor}`);
    if (index === segments.length - 1) throw new Error(`拒绝覆盖已有 --output: ${cursor}`);
  }
  throw new Error("--output 必须包含文件名");
}
function validateEntry(value, expectedVersion, expectedKeys, source) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source}: signing evidence 必须是 JSON object`);
  }
  const fields = Object.keys(value).sort();
  if (fields.length !== EXACT_FIELDS.length || fields.some((field, index) => field !== EXACT_FIELDS[index])) {
    throw new Error(`${source}: signing evidence 字段不符合闭合 schema`);
  }
  const key = `${value.platform}/${value.arch}`;
  if (!expectedKeys.has(key)) throw new Error(`${source}: 当前 scope 不允许发布平台 ${key}`);
  if (value.version !== expectedVersion) throw new Error(`${source}: version 与 Release 不一致`);

  if (value.platform === "linux") {
    if (value.signingStatus !== "not-applicable" || value.verification !== "not-applicable") {
      throw new Error(`${source}: Linux signing evidence 必须明确标记 not-applicable`);
    }
  } else if (value.signingStatus === "verified") {
    const expectedVerification = value.platform === "windows"
      ? "Get-AuthenticodeSignature=Valid"
      : "codesign=valid;notarization-ticket=valid";
    if (value.verification !== expectedVerification) {
      throw new Error(`${source}: verified 状态缺少对应的真实验证收据`);
    }
  } else if (value.signingStatus !== "unsigned" || value.verification !== "not-performed") {
    throw new Error(`${source}: 未签名预览必须明确标记 unsigned/not-performed`);
  }
  return {
    platform: value.platform,
    arch: value.arch,
    version: value.version,
    signingStatus: value.signingStatus,
    verification: value.verification,
  };
}

function assertExactFields(value, expected, source) {
  const fields = Object.keys(value ?? {}).sort();
  if (fields.length !== expected.length || fields.some((field, index) => field !== expected[index])) {
    throw new Error(`${source}: 字段不符合闭合 schema`);
  }
}

function validateVersion(version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("version 格式无效");
  }
  return version;
}

async function collectReleaseAssets(root, version, scope) {
  const expectedByKey = expectedReleaseAssets(version, scope);
  const expectedNames = [...expectedByKey.values()].flat();
  const expectedNameSet = new Set(expectedNames);
  const relativeFiles = (await readdir(root, { recursive: true }))
    .map((file) => String(file).replaceAll("\\", "/"))
    .filter((file) => expectedNameSet.has(path.posix.basename(file)))
    .sort();
  const actualNames = relativeFiles.map((file) => path.posix.basename(file));
  if (
    actualNames.length !== expectedNames.length
    || [...actualNames].sort().some((name, index) => name !== [...expectedNames].sort()[index])
  ) {
    throw new Error(`release asset 集合不符：expected=${JSON.stringify([...expectedNames].sort())}, actual=${JSON.stringify([...actualNames].sort())}`);
  }

  const byName = new Map();
  for (const relative of relativeFiles) {
    const absolute = path.join(root, ...relative.split("/"));
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${relative}: release asset 必须是普通文件`);
    if (info.size <= 0) throw new Error(`${relative}: release asset 不能为空`);
    const name = path.posix.basename(relative);
    if (byName.has(name)) throw new Error(`release asset 文件名重复：${name}`);
    const bytes = await readFile(absolute);
    byName.set(name, {
      name,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length,
    });
  }

  const byKey = new Map();
  for (const [key, names] of expectedByKey) byKey.set(key, names.map((name) => byName.get(name)));
  const agentKitZipName = `Useful-${version}-agent-kit.zip`;
  const agentKitReceiptName = `${agentKitZipName}.sha256`;
  const receiptPath = relativeFiles.find((file) => path.posix.basename(file) === agentKitReceiptName);
  const receiptText = await readFile(path.join(root, ...receiptPath.split("/")), "utf8");
  const receiptMatch = /^([0-9a-f]{64})  ([^/\\\r\n]+)\n$/.exec(receiptText);
  if (!receiptMatch || receiptMatch[2] !== agentKitZipName || receiptMatch[1] !== byName.get(agentKitZipName).sha256) {
    throw new Error("Agent Kit single-asset SHA-256 receipt 不匹配");
  }
  return { byKey, artifacts: expectedNames.map((name) => byName.get(name)) };
}

function nonCodeSignedArtifacts(releaseAssets) {
  return [{
    kind: "agent-kit",
    codeSigning: "not-applicable",
    integrity: "sha256+closed-manifest+build-provenance",
    artifacts: releaseAssets.byKey.get("agent-kit/n-a"),
  }];
}

export async function aggregateSigningStatus(root, version, scope = "desktop-full") {
  validateVersion(version);
  const expected = expectedPlatforms(scope);
  const expectedKeys = new Set(expected.map(([platform, arch]) => `${platform}/${arch}`));
  const expectedReceiptNames = new Set(expected.map(([platform, arch]) => `signing-${platform}-${arch}.json`));
  const relativeFiles = (await readdir(root, { recursive: true }))
    .map(String)
    .filter((file) => scope === "desktop-lite"
      ? expectedReceiptNames.has(path.basename(file))
      : /^signing-.*\.json$/.test(path.basename(file)))
    .sort();
  if (relativeFiles.length !== expected.length) {
    throw new Error(`signing evidence 数量不符：expected=${expected.length}, actual=${relativeFiles.length}`);
  }

  const byKey = new Map();
  for (const relative of relativeFiles) {
    const absolute = path.join(root, relative);
    const info = await lstat(absolute);
    if (!info.isFile()) throw new Error(`${relative}: signing evidence 不是普通文件`);
    const entry = validateEntry(JSON.parse(await readFile(absolute, "utf8")), version, expectedKeys, relative.replaceAll("\\", "/"));
    const key = `${entry.platform}/${entry.arch}`;
    if (byKey.has(key)) throw new Error(`signing evidence 重复：${key}`);
    byKey.set(key, entry);
  }
  for (const key of expectedKeys) {
    if (!byKey.has(key)) throw new Error(`signing evidence 缺失：${key}`);
  }

  const releaseAssets = await collectReleaseAssets(root, version, scope);
  const platforms = expected.map(([platform, arch]) => ({
    ...byKey.get(`${platform}/${arch}`),
    artifacts: releaseAssets.byKey.get(`${platform}/${arch}`),
  }));
  const signed = platforms
    .filter((entry) => entry.platform === "windows" || entry.platform === "macos")
    .every((entry) => entry.signingStatus === "verified");
  return {
    schemaVersion: RELEASE_SIGNING_STATUS_SCHEMA,
    version,
    scope,
    signed,
    platforms,
    nonCodeSignedArtifacts: nonCodeSignedArtifacts(releaseAssets),
    artifacts: releaseAssets.artifacts,
  };
}

export async function validateSigningStatusFile(statusPath, assetRoot, version, scope = "desktop-full") {
  validateVersion(version);
  const expected = expectedPlatforms(scope);
  const expectedKeys = new Set(expected.map(([platform, arch]) => `${platform}/${arch}`));
  const info = await lstat(statusPath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("SIGNING-STATUS 必须是普通文件");
  const value = JSON.parse(await readFile(statusPath, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("SIGNING-STATUS 必须是 JSON object");
  assertExactFields(value, SUMMARY_FIELDS, "SIGNING-STATUS");
  if (value.schemaVersion !== RELEASE_SIGNING_STATUS_SCHEMA) throw new Error("SIGNING-STATUS schemaVersion 不匹配");
  if (value.version !== version) throw new Error("SIGNING-STATUS version 与 Release 不一致");
  if (value.scope !== scope) throw new Error("SIGNING-STATUS scope 与 Release 不一致");
  if (!Array.isArray(value.platforms) || value.platforms.length !== expected.length) {
    throw new Error("SIGNING-STATUS platforms 数量不符");
  }
  if (!Array.isArray(value.artifacts)) throw new Error("SIGNING-STATUS artifacts 必须是 array");
  if (!Array.isArray(value.nonCodeSignedArtifacts) || value.nonCodeSignedArtifacts.length !== 1) {
    throw new Error("SIGNING-STATUS nonCodeSignedArtifacts 数量不符");
  }

  const assets = await collectReleaseAssets(assetRoot, version, scope);
  const validatedPlatforms = value.platforms.map((entry, index) => {
    assertExactFields(entry, SUMMARY_PLATFORM_FIELDS, `SIGNING-STATUS platforms[${index}]`);
    const receipt = validateEntry({
      arch: entry.arch,
      platform: entry.platform,
      signingStatus: entry.signingStatus,
      verification: entry.verification,
      version: entry.version,
    }, version, expectedKeys, `SIGNING-STATUS platforms[${index}]`);
    const [expectedPlatform, expectedArch] = expected[index];
    if (receipt.platform !== expectedPlatform || receipt.arch !== expectedArch) {
      throw new Error(`SIGNING-STATUS platforms[${index}] 顺序或身份不匹配`);
    }
    if (!Array.isArray(entry.artifacts)) throw new Error(`SIGNING-STATUS platforms[${index}] artifacts 必须是 array`);
    for (const [artifactIndex, artifact] of entry.artifacts.entries()) {
      assertExactFields(artifact, ARTIFACT_FIELDS, `SIGNING-STATUS platforms[${index}].artifacts[${artifactIndex}]`);
    }
    const expectedArtifacts = assets.byKey.get(`${receipt.platform}/${receipt.arch}`);
    if (JSON.stringify(entry.artifacts) !== JSON.stringify(expectedArtifacts)) {
      throw new Error(`SIGNING-STATUS ${receipt.platform}/${receipt.arch} artifact digest 不匹配`);
    }
    return { ...receipt, artifacts: expectedArtifacts };
  });
  if (JSON.stringify(value.artifacts) !== JSON.stringify(assets.artifacts)) {
    throw new Error("SIGNING-STATUS 顶层 artifact manifest 不匹配");
  }
  if (JSON.stringify(value.nonCodeSignedArtifacts) !== JSON.stringify(nonCodeSignedArtifacts(assets))) {
    throw new Error("SIGNING-STATUS Agent Kit integrity/codeSigning evidence 不匹配");
  }
  const signed = validatedPlatforms
    .filter((entry) => entry.platform === "windows" || entry.platform === "macos")
    .every((entry) => entry.signingStatus === "verified");
  if (value.signed !== signed) throw new Error("SIGNING-STATUS signed 与平台证据不一致");
  return { ...value, signed, platforms: validatedPlatforms, artifacts: assets.artifacts };
}

export async function runCli(args, env = process.env) {
  const values = parseCliArgs(args);
  const version = valueOf(values, "--version");
  const scope = valueOf(values, "--scope");
  const outputPath = values.has("--output") ? await assertExclusiveOutputPath(valueOf(values, "--output")) : null;
  const aggregateMode = values.has("--root");
  const validateMode = values.has("--status") || values.has("--asset-root");
  if (aggregateMode === validateMode) throw new Error("必须且只能选择 --root 聚合或 --status/--asset-root 验证模式");
  if (validateMode && (!values.has("--status") || !values.has("--asset-root"))) throw new Error("验证模式必须同时提供 --status 和 --asset-root");
  const result = aggregateMode
    ? await aggregateSigningStatus(path.resolve(valueOf(values, "--root")), version, scope)
    : await validateSigningStatusFile(
        path.resolve(valueOf(values, "--status")),
        path.resolve(valueOf(values, "--asset-root")),
        version,
        scope,
      );
  if (outputPath) {
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  }
  const githubOutput = values.has("--github-output")
    ? valueOf(values, "--github-output")
    : env.GITHUB_OUTPUT;
  if (githubOutput) await appendFile(githubOutput, `signed=${result.signed}\n`, "utf8");
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
