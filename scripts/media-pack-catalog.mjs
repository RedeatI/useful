#!/usr/bin/env node

import { createHash, verify as verifySignature } from "node:crypto";
import { lstat, open, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ed25519PublicKeyFromRawHex,
  verifyMediaPackSigningStatement,
} from "./media-pack-signing.mjs";
import { validateLockedMediaPackManifest } from "./media-pack-v2.mjs";

export const MEDIA_PACK_CATALOG_PLAN_SCHEMA = "useful.media-pack-catalog-plan.v1";
export const MEDIA_PACK_CATALOG_SCHEMA = "useful.media-pack-catalog.v1";
export const MEDIA_PACK_CATALOG_SIGNATURE_DOMAIN = "useful-media-pack-catalog-v1";

const MAX_PLAN_BYTES = 1024 * 1024;
const MAX_CATALOG_BYTES = 512 * 1024;
const MAX_SMALL_ASSET_BYTES = 1024 * 1024;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_CATALOG_VALIDITY_SECONDS = 31 * 24 * 60 * 60;
const PACK_IDS = ["preview", "transcode"];
const PLAN_FIELDS = ["expiresAtUnix", "lockPath", "packs", "schemaVersion"];
const PLAN_PACK_FIELDS = [
  "archive",
  "correspondingSource",
  "id",
  "manifest",
  "statement",
  "statementSignatureHex",
];
const PLAN_ASSET_FIELDS = ["localPath", "url"];
const CATALOG_FIELDS = ["expiresAtUnix", "packs", "schemaVersion", "signatureDomain"];
const CATALOG_PACK_FIELDS = [
  "archive",
  "correspondingSource",
  "id",
  "manifest",
  "statement",
  "statementSignatureHex",
];
const CATALOG_ASSET_FIELDS = ["fileName", "sha256", "sizeBytes", "url"];

async function lstatOrNull(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function assertSafePath(target, label, expectedLeaf) {
  const full = path.resolve(target);
  const parsed = path.parse(full);
  const segments = full.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let cursor = parsed.root;
  for (const [index, segment] of segments.entries()) {
    cursor = path.join(cursor, segment);
    const info = await lstatOrNull(cursor);
    if (!info) throw new Error(`${label} 路径组件不存在: ${cursor}`);
    if (info.isSymbolicLink()) throw new Error(`${label} 路径不能包含 symlink/junction: ${cursor}`);
    const leaf = index === segments.length - 1;
    if (!leaf && !info.isDirectory()) throw new Error(`${label} 中间路径组件不是目录: ${cursor}`);
    if (leaf && expectedLeaf === "file" && (!info.isFile() || info.size <= 0)) {
      throw new Error(`${label} 必须是非空普通文件`);
    }
    if (leaf && expectedLeaf === "directory" && !info.isDirectory()) {
      throw new Error(`${label} 必须是普通目录`);
    }
  }
  return full;
}

async function readOrdinaryBytes(target, label, maximum) {
  const full = await assertSafePath(target, label, "file");
  const handle = await open(full, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size <= 0 || info.size > maximum) {
      throw new Error(`${label} 超出大小限制`);
    }
    const bytes = await handle.readFile();
    if (bytes.length !== info.size) throw new Error(`${label} 读取期间发生变化`);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function inspectOrdinaryAsset(target, label, maximum) {
  const full = await assertSafePath(target, label, "file");
  const handle = await open(full, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size <= 0 || info.size > maximum) {
      throw new Error(`${label} 超出大小限制`);
    }
    const digest = createHash("sha256");
    let sizeBytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      sizeBytes += chunk.length;
      if (sizeBytes > maximum) throw new Error(`${label} 读取超出大小限制`);
      digest.update(chunk);
    }
    if (sizeBytes !== info.size) throw new Error(`${label} 读取期间发生变化`);
    return { sha256: digest.digest("hex"), sizeBytes };
  } finally {
    await handle.close();
  }
}

function assertExactFields(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是 object`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} 不是闭合 schema`);
  }
}

function requireLowerHex(value, length, label) {
  if (typeof value !== "string" || value.length !== length || !/^[0-9a-f]+$/.test(value)) {
    throw new Error(`${label} 必须是 ${length / 2} 字节小写 hex`);
  }
  return value;
}

function requireSafeBasename(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value)) {
    throw new Error(`${label} 必须是安全 basename`);
  }
  return value;
}

function validateHttpsUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} 无效`);
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash) {
    throw new Error(`${label} 必须是无凭据、无 fragment 的 HTTPS URL`);
  }
  const fileName = url.pathname.split("/").at(-1);
  requireSafeBasename(fileName, `${label} basename`);
  return { url: url.href, fileName };
}

function validateRelativeAssetPath(value, expectedBasename, label) {
  if (typeof value !== "string" || value.includes("\\") || path.posix.isAbsolute(value)) {
    throw new Error(`${label} localPath 必须是 portable 相对路径`);
  }
  const segments = value.split("/");
  if (
    segments.length === 0
    || segments.some((segment) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(segment))
  ) {
    throw new Error(`${label} localPath 必须仅包含 portable 安全路径段`);
  }
  if (segments.at(-1) !== expectedBasename) throw new Error(`${label} localPath basename 与 URL 不一致`);
  return segments;
}

function validateCatalogAsset(asset, label) {
  assertExactFields(asset, CATALOG_ASSET_FIELDS, label);
  const url = validateHttpsUrl(asset.url, `${label} URL`);
  if (asset.fileName !== url.fileName) throw new Error(`${label} fileName 与 URL 不一致`);
  requireLowerHex(asset.sha256, 64, `${label} SHA-256`);
  if (!Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes <= 0) throw new Error(`${label} sizeBytes 无效`);
  return asset;
}

function normalizeCatalog(catalog, nowUnix) {
  assertExactFields(catalog, CATALOG_FIELDS, "MediaPack catalog");
  if (catalog.schemaVersion !== MEDIA_PACK_CATALOG_SCHEMA) throw new Error("MediaPack catalog schemaVersion 不匹配");
  if (catalog.signatureDomain !== MEDIA_PACK_CATALOG_SIGNATURE_DOMAIN) throw new Error("MediaPack catalog signatureDomain 不匹配");
  if (
    !Number.isSafeInteger(catalog.expiresAtUnix)
    || catalog.expiresAtUnix <= nowUnix
    || catalog.expiresAtUnix > nowUnix + MAX_CATALOG_VALIDITY_SECONDS
  ) {
    throw new Error("MediaPack catalog 已过期或超出 31 天有效期");
  }
  if (!Array.isArray(catalog.packs) || catalog.packs.length !== PACK_IDS.length) {
    throw new Error("MediaPack catalog 必须恰好包含 preview/transcode");
  }
  const packsById = new Map();
  for (const pack of catalog.packs) {
    assertExactFields(pack, CATALOG_PACK_FIELDS, "MediaPack catalog pack");
    if (!PACK_IDS.includes(pack.id) || packsById.has(pack.id)) throw new Error("MediaPack catalog pack id 闭集无效");
    validateCatalogAsset(pack.archive, `${pack.id} archive`);
    validateCatalogAsset(pack.manifest, `${pack.id} manifest`);
    validateCatalogAsset(pack.statement, `${pack.id} statement`);
    validateCatalogAsset(pack.correspondingSource, `${pack.id} corresponding source`);
    if (pack.archive.sizeBytes > MAX_ARCHIVE_BYTES) throw new Error(`${pack.id} archive 超出大小限制`);
    if (pack.manifest.sizeBytes > MAX_SMALL_ASSET_BYTES || pack.statement.sizeBytes > MAX_SMALL_ASSET_BYTES) {
      throw new Error(`${pack.id} metadata 超出大小限制`);
    }
    requireLowerHex(pack.statementSignatureHex, 128, `${pack.id} statement signature`);
    packsById.set(pack.id, pack);
  }
  return {
    schemaVersion: MEDIA_PACK_CATALOG_SCHEMA,
    signatureDomain: MEDIA_PACK_CATALOG_SIGNATURE_DOMAIN,
    expiresAtUnix: catalog.expiresAtUnix,
    packs: PACK_IDS.map((id) => {
      const pack = packsById.get(id);
      const asset = (value) => ({
        url: value.url,
        fileName: value.fileName,
        sha256: value.sha256,
        sizeBytes: value.sizeBytes,
      });
      return {
        id,
        archive: asset(pack.archive),
        manifest: asset(pack.manifest),
        statement: asset(pack.statement),
        statementSignatureHex: pack.statementSignatureHex,
        correspondingSource: asset(pack.correspondingSource),
      };
    }),
  };
}

export function serializeMediaPackCatalog(catalog, nowUnix = Math.floor(Date.now() / 1000)) {
  return Buffer.from(`${JSON.stringify(normalizeCatalog(catalog, nowUnix), null, 2)}\n`, "utf8");
}

async function catalogAssetFromPlan(planDirectory, value, label, maximum) {
  assertExactFields(value, PLAN_ASSET_FIELDS, `${label} plan asset`);
  const { url, fileName } = validateHttpsUrl(value.url, `${label} URL`);
  const segments = validateRelativeAssetPath(value.localPath, fileName, label);
  const facts = await inspectOrdinaryAsset(path.join(planDirectory, ...segments), label, maximum);
  return { url, fileName, ...facts };
}

export async function buildMediaPackCatalog(planPath, publicKeyHex, nowUnix = Math.floor(Date.now() / 1000)) {
  requireLowerHex(publicKeyHex, 64, "MediaPack public key");
  if (/^0+$/.test(publicKeyHex)) throw new Error("MediaPack public key 不能全为 0");
  const fullPlanPath = path.resolve(planPath);
  const planBytes = await readOrdinaryBytes(fullPlanPath, "MediaPack catalog plan", MAX_PLAN_BYTES);
  const plan = JSON.parse(planBytes.toString("utf8"));
  assertExactFields(plan, PLAN_FIELDS, "MediaPack catalog plan");
  if (plan.schemaVersion !== MEDIA_PACK_CATALOG_PLAN_SCHEMA) throw new Error("MediaPack catalog plan schemaVersion 不匹配");
  if (
    !Number.isSafeInteger(plan.expiresAtUnix)
    || plan.expiresAtUnix <= nowUnix
    || plan.expiresAtUnix > nowUnix + MAX_CATALOG_VALIDITY_SECONDS
  ) {
    throw new Error("MediaPack catalog plan 已过期或超出 31 天有效期");
  }
  if (!Array.isArray(plan.packs) || plan.packs.length !== PACK_IDS.length) {
    throw new Error("MediaPack catalog plan 必须恰好包含 preview/transcode");
  }

  const planDirectory = path.dirname(fullPlanPath);
  const lockName = typeof plan.lockPath === "string" ? path.posix.basename(plan.lockPath) : "";
  requireSafeBasename(lockName, "MediaPack v2 lock basename");
  const lockSegments = validateRelativeAssetPath(plan.lockPath, lockName, "MediaPack v2 lock");
  const lockPath = path.join(planDirectory, ...lockSegments);
  await assertSafePath(lockPath, "MediaPack v2 lock", "file");
  const packsById = new Map();
  for (const pack of plan.packs) {
    assertExactFields(pack, PLAN_PACK_FIELDS, "MediaPack catalog plan pack");
    if (!PACK_IDS.includes(pack.id) || packsById.has(pack.id)) throw new Error("MediaPack catalog plan pack id 闭集无效");
    requireLowerHex(pack.statementSignatureHex, 128, `${pack.id} statement signature`);
    const archive = await catalogAssetFromPlan(planDirectory, pack.archive, `${pack.id} archive`, MAX_ARCHIVE_BYTES);
    const manifest = await catalogAssetFromPlan(planDirectory, pack.manifest, `${pack.id} manifest`, MAX_SMALL_ASSET_BYTES);
    const statement = await catalogAssetFromPlan(planDirectory, pack.statement, `${pack.id} statement`, MAX_SMALL_ASSET_BYTES);
    const correspondingSource = await catalogAssetFromPlan(
      planDirectory,
      pack.correspondingSource,
      `${pack.id} corresponding source`,
      Number.MAX_SAFE_INTEGER,
    );
    const statementPath = path.join(
      planDirectory,
      ...validateRelativeAssetPath(pack.statement.localPath, statement.fileName, `${pack.id} statement`),
    );
    const manifestPath = path.join(
      planDirectory,
      ...validateRelativeAssetPath(pack.manifest.localPath, manifest.fileName, `${pack.id} manifest`),
    );
    await validateLockedMediaPackManifest(manifestPath, lockPath, pack.id);
    const signed = await verifyMediaPackSigningStatement(statementPath, pack.statementSignatureHex, publicKeyHex);
    if (
      signed.packId !== pack.id
      || signed.manifestSha256 !== manifest.sha256
      || signed.archiveFile !== archive.fileName
      || signed.archiveSha256 !== archive.sha256
      || signed.archiveSizeBytes !== archive.sizeBytes
      || signed.correspondingSourceAssetId !== correspondingSource.fileName
      || signed.correspondingSourceAssetSha256 !== correspondingSource.sha256
      || signed.correspondingSourceAssetSizeBytes !== correspondingSource.sizeBytes
    ) {
      throw new Error(`${pack.id} 签名声明与 catalog 本地资产不一致`);
    }
    packsById.set(pack.id, {
      id: pack.id,
      archive,
      manifest,
      statement,
      statementSignatureHex: pack.statementSignatureHex,
      correspondingSource,
    });
  }
  return normalizeCatalog({
    schemaVersion: MEDIA_PACK_CATALOG_SCHEMA,
    signatureDomain: MEDIA_PACK_CATALOG_SIGNATURE_DOMAIN,
    expiresAtUnix: plan.expiresAtUnix,
    packs: PACK_IDS.map((id) => packsById.get(id)),
  }, nowUnix);
}

export async function verifyMediaPackCatalog(
  catalogPath,
  signatureHex,
  publicKeyHex,
  nowUnix = Math.floor(Date.now() / 1000),
) {
  requireLowerHex(publicKeyHex, 64, "MediaPack public key");
  if (/^0+$/.test(publicKeyHex)) throw new Error("MediaPack public key 不能全为 0");
  requireLowerHex(signatureHex, 128, "MediaPack catalog signature");
  const bytes = await readOrdinaryBytes(catalogPath, "MediaPack catalog", MAX_CATALOG_BYTES);
  const catalog = JSON.parse(bytes.toString("utf8"));
  const canonical = serializeMediaPackCatalog(catalog, nowUnix);
  if (!bytes.equals(canonical)) throw new Error("MediaPack catalog 不是规范 JSON 字节");
  const valid = verifySignature(
    null,
    bytes,
    ed25519PublicKeyFromRawHex(publicKeyHex),
    Buffer.from(signatureHex, "hex"),
  );
  if (!valid) throw new Error("MediaPack catalog Ed25519 签名验证失败");
  return normalizeCatalog(catalog, nowUnix);
}

function parseArgs(args) {
  const allowed = new Set(["--plan", "--catalog", "--signature-hex", "--public-key-hex", "--output"]);
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!allowed.has(name)) throw new Error(`未知参数: ${name ?? "<missing>"}`);
    if (values.has(name)) throw new Error(`重复参数: ${name}`);
    if (value === undefined || value.startsWith("--")) throw new Error(`需要 ${name} <value>`);
    values.set(name, value);
  }
  const build = values.has("--plan") || values.has("--output");
  const verify = values.has("--catalog") || values.has("--signature-hex");
  if (build === verify) throw new Error("必须且只能选择构建 catalog 或验签模式");
  const required = build
    ? ["--plan", "--public-key-hex", "--output"]
    : ["--catalog", "--signature-hex", "--public-key-hex"];
  for (const name of required) if (!values.has(name)) throw new Error(`需要 ${name} <value>`);
  if (values.size !== required.length) throw new Error("当前模式包含不兼容参数");
  return { values, build };
}

export async function runCli(args) {
  const { values, build } = parseArgs(args);
  if (!build) {
    return verifyMediaPackCatalog(
      path.resolve(values.get("--catalog")),
      values.get("--signature-hex"),
      values.get("--public-key-hex"),
    );
  }
  const outputPath = path.resolve(values.get("--output"));
  await assertSafePath(path.dirname(outputPath), "--output 父目录", "directory");
  if (await lstatOrNull(outputPath)) throw new Error("拒绝覆盖已有 MediaPack catalog");
  const catalog = await buildMediaPackCatalog(
    path.resolve(values.get("--plan")),
    values.get("--public-key-hex"),
  );
  await writeFile(outputPath, serializeMediaPackCatalog(catalog), { flag: "wx" });
  return catalog;
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
