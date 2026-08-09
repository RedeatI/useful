#!/usr/bin/env node

import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MEDIA_PACK_SCHEMA, MEDIA_PACK_SIGNATURE_DOMAIN } from "./media-pack-v2.mjs";

export const MEDIA_PACK_SIGNING_STATEMENT_SCHEMA = "useful.media-pack-signing-statement.v1";

const STATEMENT_FIELDS = [
  "arch",
  "archiveFile",
  "archiveSha256",
  "archiveSizeBytes",
  "correspondingSourceAssetId",
  "correspondingSourceAssetSha256",
  "correspondingSourceAssetSizeBytes",
  "manifestSha256",
  "minimumUsefulVersion",
  "packId",
  "platform",
  "runtimeLockSha256",
  "schemaVersion",
  "signatureDomain",
];
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

async function lstatOrNull(target) {
  try { return await lstat(target); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readOrdinaryFile(target, label) {
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
    if (leaf && (!info.isFile() || info.size <= 0)) throw new Error(`${label} 必须是非空普通文件`);
  }
  return readFile(full);
}

function assertExactFields(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是 object`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} 不是闭合 schema`);
  }
}

function requireSha256(value, label) {
  if (!/^[0-9a-f]{64}$/.test(value ?? "")) throw new Error(`${label} 必须是小写 SHA-256`);
  return value;
}

function requireAssetId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value)) {
    throw new Error("corresponding source asset id 必须是安全 basename");
  }
  if (value === "." || value === ".." || path.basename(value) !== value) {
    throw new Error("corresponding source asset id 不能包含路径");
  }
  return value;
}

export function serializeMediaPackSigningStatement(statement) {
  validateStatementShape(statement);
  return Buffer.from(`${JSON.stringify(statement, null, 2)}\n`, "utf8");
}

function validateStatementShape(statement) {
  assertExactFields(statement, STATEMENT_FIELDS, "media pack signing statement");
  if (statement.schemaVersion !== MEDIA_PACK_SIGNING_STATEMENT_SCHEMA) throw new Error("签名声明 schemaVersion 不匹配");
  if (statement.signatureDomain !== MEDIA_PACK_SIGNATURE_DOMAIN) throw new Error("签名声明 domain 不匹配");
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(statement.packId ?? "")) throw new Error("签名声明 packId 无效");
  if (statement.platform !== "windows" || statement.arch !== "x64") throw new Error("签名声明 platform/arch 无效");
  requireSha256(statement.runtimeLockSha256, "runtimeLockSha256");
  requireSha256(statement.manifestSha256, "manifestSha256");
  requireSha256(statement.archiveSha256, "archiveSha256");
  if (!Number.isSafeInteger(statement.archiveSizeBytes) || statement.archiveSizeBytes <= 0) throw new Error("archiveSizeBytes 无效");
  if (typeof statement.minimumUsefulVersion !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(statement.minimumUsefulVersion)) {
    throw new Error("minimumUsefulVersion 必须是 SemVer");
  }
  requireAssetId(statement.archiveFile);
  requireAssetId(statement.correspondingSourceAssetId);
  requireSha256(statement.correspondingSourceAssetSha256, "correspondingSourceAssetSha256");
  if (!Number.isSafeInteger(statement.correspondingSourceAssetSizeBytes) || statement.correspondingSourceAssetSizeBytes <= 0) {
    throw new Error("correspondingSourceAssetSizeBytes 无效");
  }
  return statement;
}

export async function buildMediaPackSigningStatement(manifestPath, archivePath, correspondingSourceAssetPath) {
  const [manifestBytes, archiveBytes, sourceAssetBytes] = await Promise.all([
    readOrdinaryFile(manifestPath, "MEDIA-PACK.json"),
    readOrdinaryFile(archivePath, "media pack archive"),
    readOrdinaryFile(correspondingSourceAssetPath, "corresponding source asset"),
  ]);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.schemaVersion !== MEDIA_PACK_SCHEMA || manifest.signatureDomain !== MEDIA_PACK_SIGNATURE_DOMAIN) {
    throw new Error("MEDIA-PACK.json schema/signature domain 不匹配");
  }
  if (manifest.distributionStatus !== "unsigned-candidate") throw new Error("只允许从 unsigned-candidate manifest 构建待签名声明");
  const statement = {
    schemaVersion: MEDIA_PACK_SIGNING_STATEMENT_SCHEMA,
    signatureDomain: MEDIA_PACK_SIGNATURE_DOMAIN,
    packId: manifest.packId,
    platform: manifest.platform,
    arch: manifest.arch,
    runtimeLockSha256: manifest.runtimeLockSha256,
    minimumUsefulVersion: manifest.minimumUsefulVersion,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    archiveFile: path.basename(archivePath),
    archiveSha256: createHash("sha256").update(archiveBytes).digest("hex"),
    archiveSizeBytes: archiveBytes.length,
    correspondingSourceAssetId: requireAssetId(path.basename(correspondingSourceAssetPath)),
    correspondingSourceAssetSha256: createHash("sha256").update(sourceAssetBytes).digest("hex"),
    correspondingSourceAssetSizeBytes: sourceAssetBytes.length,
  };
  return validateStatementShape(statement);
}

export function ed25519PublicKeyFromRawHex(publicKeyHex) {
  if (!/^[0-9a-f]{64}$/.test(publicKeyHex ?? "")) throw new Error("MediaPack public key 必须是 32 字节小写 hex");
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]),
    format: "der",
    type: "spki",
  });
}

export async function verifyMediaPackSigningStatement(statementPath, signatureHex, publicKeyHex) {
  const bytes = await readOrdinaryFile(statementPath, "media pack signing statement");
  const statement = JSON.parse(bytes.toString("utf8"));
  const canonical = serializeMediaPackSigningStatement(statement);
  if (!bytes.equals(canonical)) throw new Error("签名声明不是规范 JSON 字节");
  if (!/^[0-9a-f]{128}$/.test(signatureHex ?? "")) throw new Error("MediaPack 签名必须是 64 字节小写 hex");
  const valid = verifySignature(null, bytes, ed25519PublicKeyFromRawHex(publicKeyHex), Buffer.from(signatureHex, "hex"));
  if (!valid) throw new Error("MediaPack Ed25519 签名验证失败");
  return statement;
}

function parseArgs(args) {
  const allowed = new Set([
    "--manifest", "--archive", "--source-asset", "--output",
    "--statement", "--signature-hex", "--public-key-hex",
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
  const build = values.has("--manifest") || values.has("--archive") || values.has("--source-asset") || values.has("--output");
  const verify = values.has("--statement") || values.has("--signature-hex") || values.has("--public-key-hex");
  if (build === verify) throw new Error("必须且只能选择构建声明或验签模式");
  const required = build
    ? ["--manifest", "--archive", "--source-asset", "--output"]
    : ["--statement", "--signature-hex", "--public-key-hex"];
  for (const name of required) if (!values.has(name)) throw new Error(`需要 ${name} <value>`);
  return { values, build };
}

export async function runCli(args) {
  const { values, build } = parseArgs(args);
  if (!build) {
    return verifyMediaPackSigningStatement(
      path.resolve(values.get("--statement")),
      values.get("--signature-hex"),
      values.get("--public-key-hex"),
    );
  }
  const outputPath = path.resolve(values.get("--output"));
  const parent = await lstatOrNull(path.dirname(outputPath));
  if (!parent?.isDirectory() || parent.isSymbolicLink()) throw new Error("--output 父目录必须是普通目录");
  if (await lstatOrNull(outputPath)) throw new Error("拒绝覆盖已有签名声明");
  const statement = await buildMediaPackSigningStatement(
    path.resolve(values.get("--manifest")),
    path.resolve(values.get("--archive")),
    path.resolve(values.get("--source-asset")),
  );
  await writeFile(outputPath, serializeMediaPackSigningStatement(statement), { flag: "wx" });
  return statement;
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
