#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MEDIA_LOCK_SCHEMA_V2,
  readMediaRuntimeLock,
  validateMediaRuntimeManifest,
} from "./release-metadata-media.mjs";

export const MEDIA_PACK_SCHEMA = "useful.media-pack.v1";
export const MEDIA_PACK_SIGNATURE_DOMAIN = "useful-media-pack-v1";

const MANIFEST_FIELDS = [
  "arch",
  "components",
  "correspondingSourceRequired",
  "distributionStatus",
  "minimumUsefulVersion",
  "packId",
  "platform",
  "runtimeLockSha256",
  "schemaVersion",
  "signatureDomain",
];
const COMPONENT_FIELDS = [
  "archiveSha256", "extractedFile", "extractedSha256", "license",
  "name", "sizeBytes", "sourceUrl", "version",
];

async function lstatOrNull(target) {
  try { return await lstat(target); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function assertOrdinaryFile(target, { allowMissing = false } = {}) {
  const full = path.resolve(target);
  const parsed = path.parse(full);
  const segments = full.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let cursor = parsed.root;
  for (const [index, segment] of segments.entries()) {
    cursor = path.join(cursor, segment);
    const info = await lstatOrNull(cursor);
    if (!info) {
      if (allowMissing && index === segments.length - 1) return null;
      throw new Error(`路径组件不存在: ${cursor}`);
    }
    if (info.isSymbolicLink()) throw new Error(`路径组件不能是 symlink/junction: ${cursor}`);
    const leaf = index === segments.length - 1;
    if (!leaf && !info.isDirectory()) throw new Error(`中间路径组件不是目录: ${cursor}`);
    if (leaf && (!info.isFile() || info.size <= 0)) throw new Error(`路径必须是非空普通文件: ${cursor}`);
  }
}

function assertExactFields(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是 object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`${label} 不是闭合 schema`);
}

function selectPack(lock, packId) {
  if (lock.schemaVersion !== MEDIA_LOCK_SCHEMA_V2) throw new Error("media pack 只接受 v2 candidate lock");
  const pack = lock.packs.find(({ id }) => id === packId);
  if (!pack) throw new Error(`未知 media pack: ${packId}`);
  return pack;
}

export async function buildMediaPackManifest(lockPath, runtimeManifestPath, packId) {
  const [lock, runtimeManifest, lockBytes] = await Promise.all([
    readMediaRuntimeLock(lockPath),
    validateMediaRuntimeManifest(runtimeManifestPath, lockPath),
    readFile(lockPath),
  ]);
  const pack = selectPack(lock, packId);
  const byName = new Map(runtimeManifest.components.map((component) => [component.name, component]));
  const components = pack.components.map((name) => {
    const component = byName.get(name);
    if (!component) throw new Error(`MEDIA-RUNTIMES.json 缺少 pack 组件: ${name}`);
    return component;
  });
  return {
    schemaVersion: MEDIA_PACK_SCHEMA,
    distributionStatus: "unsigned-candidate",
    signatureDomain: MEDIA_PACK_SIGNATURE_DOMAIN,
    packId: pack.id,
    platform: lock.platform,
    arch: lock.arch,
    runtimeLockSha256: createHash("sha256").update(lockBytes).digest("hex"),
    minimumUsefulVersion: pack.minimumUsefulVersion,
    correspondingSourceRequired: true,
    components,
  };
}

export async function validateMediaPackManifest(manifestPath, lockPath, runtimeManifestPath, packId) {
  await assertOrdinaryFile(manifestPath);
  const actual = JSON.parse(await readFile(manifestPath, "utf8"));
  assertExactFields(actual, MANIFEST_FIELDS, "MEDIA-PACK.json");
  const expected = await buildMediaPackManifest(lockPath, runtimeManifestPath, packId);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("MEDIA-PACK.json 与 v2 lock/runtime manifest 不一致");
  }
  return actual;
}

export async function validateLockedMediaPackManifest(manifestPath, lockPath, packId) {
  await assertOrdinaryFile(manifestPath);
  const [actual, lock, lockBytes] = await Promise.all([
    readFile(manifestPath, "utf8").then(JSON.parse),
    readMediaRuntimeLock(lockPath),
    readFile(lockPath),
  ]);
  assertExactFields(actual, MANIFEST_FIELDS, "MEDIA-PACK.json");
  const pack = selectPack(lock, packId);
  const componentByName = new Map(lock.components.map((component) => [component.name, component]));
  const components = pack.components.map((name) => {
    const component = componentByName.get(name);
    if (!component?.extractedSha256 || !component?.sizeBytes) {
      throw new Error(`v2 lock 缺少 ${name} 的 extractedSha256/sizeBytes`);
    }
    return {
      name: component.name,
      version: component.version,
      sourceUrl: component.sourceUrl,
      archiveSha256: component.archiveSha256,
      extractedFile: component.targetName,
      extractedSha256: component.extractedSha256,
      sizeBytes: component.sizeBytes,
      license: component.license,
    };
  });
  for (const [index, component] of (actual.components ?? []).entries()) {
    assertExactFields(component, COMPONENT_FIELDS, `MEDIA-PACK.json components[${index}]`);
  }
  const expected = {
    schemaVersion: MEDIA_PACK_SCHEMA,
    distributionStatus: "unsigned-candidate",
    signatureDomain: MEDIA_PACK_SIGNATURE_DOMAIN,
    packId: pack.id,
    platform: lock.platform,
    arch: lock.arch,
    runtimeLockSha256: createHash("sha256").update(lockBytes).digest("hex"),
    minimumUsefulVersion: pack.minimumUsefulVersion,
    correspondingSourceRequired: true,
    components,
  };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("MEDIA-PACK.json 与 v2 lock 固定组件事实不一致");
  }
  return actual;
}

function parseArgs(args) {
  const allowed = new Set(["--lock", "--runtime-manifest", "--pack", "--output", "--manifest", "--locked-manifest"]);
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!allowed.has(name)) throw new Error(`未知参数: ${name ?? "<missing>"}`);
    if (values.has(name)) throw new Error(`重复参数: ${name}`);
    if (value === undefined || value.startsWith("--")) throw new Error(`需要 ${name} <value>`);
    values.set(name, value);
  }
  for (const required of ["--lock", "--pack"]) {
    if (!values.has(required)) throw new Error(`需要 ${required} <value>`);
  }
  const buildMode = values.has("--output");
  const validateRuntimeMode = values.has("--manifest");
  const validateLockedMode = values.has("--locked-manifest");
  if ([buildMode, validateRuntimeMode, validateLockedMode].filter(Boolean).length !== 1) {
    throw new Error("必须且只能选择 --output、--manifest 或 --locked-manifest 模式");
  }
  if ((buildMode || validateRuntimeMode) && !values.has("--runtime-manifest")) {
    throw new Error("生成或 runtime 验证模式需要 --runtime-manifest <value>");
  }
  if (validateLockedMode && values.has("--runtime-manifest")) {
    throw new Error("--locked-manifest 模式不接受 --runtime-manifest");
  }
  return { values, buildMode, validateRuntimeMode, validateLockedMode };
}

export async function runCli(args) {
  const { values, buildMode, validateRuntimeMode } = parseArgs(args);
  const lockPath = path.resolve(values.get("--lock"));
  const runtimeManifestPath = values.has("--runtime-manifest") ? path.resolve(values.get("--runtime-manifest")) : null;
  const packId = values.get("--pack");
  const outputPath = buildMode ? path.resolve(values.get("--output")) : null;
  if (buildMode) {
    const parent = path.dirname(outputPath);
    const parentInfo = await lstatOrNull(parent);
    if (!parentInfo?.isDirectory() || parentInfo.isSymbolicLink()) throw new Error("--output 父目录必须是普通目录");
    if (await lstatOrNull(outputPath)) throw new Error("拒绝覆盖已有 --output");
  }
  const result = buildMode
    ? await buildMediaPackManifest(lockPath, runtimeManifestPath, packId)
    : validateRuntimeMode
      ? await validateMediaPackManifest(path.resolve(values.get("--manifest")), lockPath, runtimeManifestPath, packId)
      : await validateLockedMediaPackManifest(path.resolve(values.get("--locked-manifest")), lockPath, packId);
  if (buildMode) {
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  }
  return result;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    process.stdout.write(`${JSON.stringify(await runCli(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
