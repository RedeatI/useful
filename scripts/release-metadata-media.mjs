#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MEDIA_LOCK_SCHEMA = "useful.media-runtimes-lock.v1";
export const MEDIA_LOCK_SCHEMA_V2 = "useful.media-runtimes-lock.v2";
export const MEDIA_RUNTIME_SCHEMA = "useful.media-runtimes.v1";

const LOCK_FIELDS_V1 = ["arch", "archives", "platform", "schemaVersion"];
const LOCK_FIELDS_V2 = ["arch", "archives", "packs", "platform", "schemaVersion"];
const ARCHIVE_FIELDS = ["archiveSha256", "extracts", "id", "license", "name", "sourceUrl", "version"];
const EXTRACT_FIELDS = ["component", "sourcePath", "targetName"];
const EXTRACT_FIELDS_V2 = ["component", "extractedSha256", "sizeBytes", "sourcePath", "targetName"];
const PACK_FIELDS = ["components", "id", "minimumUsefulVersion"];
const RUNTIME_FIELDS = ["arch", "components", "platform", "schemaVersion"];
const RUNTIME_COMPONENT_FIELDS = ["archiveSha256", "extractedFile", "extractedSha256", "license", "name", "sizeBytes", "sourceUrl", "version"];
const EXPECTED_COMPONENTS = ["ffmpeg", "ffprobe", "mpv"];
const EXPECTED_TARGETS = ["ffmpeg.exe", "ffprobe.exe", "mpv.exe"];
const EXPECTED_BINARY_ENTRIES = ["CHECKSUMS.txt", ...EXPECTED_TARGETS].sort();

function ordinalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function lstatOrNull(target) {
  try { return await lstat(target); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function assertPathChain(target, { leafType, allowMissingLeaf = false } = {}) {
  const full = path.resolve(target);
  const parsed = path.parse(full);
  const segments = full.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let cursor = parsed.root;
  const rootInfo = await lstat(cursor);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error(`路径根不是普通目录: ${cursor}`);
  for (const [index, segment] of segments.entries()) {
    cursor = path.join(cursor, segment);
    const info = await lstatOrNull(cursor);
    if (!info) {
      if (allowMissingLeaf && index === segments.length - 1) return null;
      throw new Error(`路径组件不存在: ${cursor}`);
    }
    if (info.isSymbolicLink()) throw new Error(`路径组件不能是 symlink/junction: ${cursor}`);
    const isLeaf = index === segments.length - 1;
    if (!isLeaf && !info.isDirectory()) throw new Error(`中间路径组件不是目录: ${cursor}`);
    if (isLeaf && leafType === "file" && !info.isFile()) throw new Error(`路径必须是普通文件: ${cursor}`);
    if (isLeaf && leafType === "directory" && !info.isDirectory()) throw new Error(`路径必须是普通目录: ${cursor}`);
    if (isLeaf) return info;
  }
  return rootInfo;
}

function assertExactFields(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是 object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`${label} 不是闭合 schema`);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) throw new Error(`${label} 必须是非空规范字符串`);
  return value;
}

function validateSourceUrl(value, label) {
  let url;
  try { url = new URL(requireString(value, label)); } catch { throw new Error(`${label} 不是有效 URL`); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash) {
    throw new Error(`${label} 必须是无凭据、无 fragment 的 HTTPS URL`);
  }
  return value;
}

function requireSha256(value, label) {
  if (!/^[0-9a-f]{64}$/.test(value ?? "")) throw new Error(`${label} 必须是小写 SHA-256`);
  return value;
}

export function validateMediaRuntimeLock(value) {
  const isV1 = value?.schemaVersion === MEDIA_LOCK_SCHEMA;
  const isV2 = value?.schemaVersion === MEDIA_LOCK_SCHEMA_V2;
  if (!isV1 && !isV2) throw new Error("media runtime lock schemaVersion 不匹配");
  assertExactFields(value, isV2 ? LOCK_FIELDS_V2 : LOCK_FIELDS_V1, "media runtime lock");
  if (value.platform !== "windows" || value.arch !== "x64") throw new Error("media runtime lock 仅允许 windows/x64");
  if (!Array.isArray(value.archives) || value.archives.length === 0) throw new Error("media runtime lock archives 不能为空");

  const ids = new Set();
  const targets = new Set();
  const components = [];
  for (const [archiveIndex, archive] of value.archives.entries()) {
    const label = `archives[${archiveIndex}]`;
    assertExactFields(archive, ARCHIVE_FIELDS, label);
    const id = requireString(archive.id, `${label}.id`);
    if (ids.has(id)) throw new Error(`archive id 重复: ${id}`);
    ids.add(id);
    requireString(archive.name, `${label}.name`);
    requireString(archive.version, `${label}.version`);
    requireString(archive.license, `${label}.license`);
    validateSourceUrl(archive.sourceUrl, `${label}.sourceUrl`);
    requireSha256(archive.archiveSha256, `${label}.archiveSha256`);
    if (!Array.isArray(archive.extracts) || archive.extracts.length === 0) throw new Error(`${label}.extracts 不能为空`);
    for (const [extractIndex, extract] of archive.extracts.entries()) {
      const extractLabel = `${label}.extracts[${extractIndex}]`;
      assertExactFields(extract, isV2 ? EXTRACT_FIELDS_V2 : EXTRACT_FIELDS, extractLabel);
      const component = requireString(extract.component, `${extractLabel}.component`);
      const sourcePath = requireString(extract.sourcePath, `${extractLabel}.sourcePath`).replaceAll("\\", "/");
      const targetName = requireString(extract.targetName, `${extractLabel}.targetName`);
      const sourceSegments = sourcePath.split("/");
      if (
        sourcePath.startsWith("/")
        || /^\/\//.test(sourcePath)
        || /^[A-Za-z]:/.test(sourcePath)
        || sourceSegments.some((segment) => segment === "" || segment === "." || segment === "..")
      ) throw new Error(`${extractLabel}.sourcePath 不安全`);
      if (path.basename(targetName) !== targetName || !targetName.endsWith(".exe")) throw new Error(`${extractLabel}.targetName 必须是 exe basename`);
      if (targets.has(targetName)) throw new Error(`媒体目标重复: ${targetName}`);
      const extractedSha256 = isV2 ? requireSha256(extract.extractedSha256, `${extractLabel}.extractedSha256`) : undefined;
      const sizeBytes = isV2 ? extract.sizeBytes : undefined;
      if (isV2 && (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0)) throw new Error(`${extractLabel}.sizeBytes 必须是正整数`);
      targets.add(targetName);
      components.push({
        name: component,
        version: archive.version,
        sourceUrl: archive.sourceUrl,
        archiveSha256: archive.archiveSha256,
        sourcePath,
        targetName,
        license: archive.license,
        ...(isV2 ? { extractedSha256, sizeBytes } : {}),
      });
    }
  }
  const componentNames = components.map(({ name }) => name).sort();
  const targetNames = components.map(({ targetName }) => targetName).sort();
  if (JSON.stringify(componentNames) !== JSON.stringify(EXPECTED_COMPONENTS)) throw new Error("媒体组件集合必须严格为 ffmpeg/ffprobe/mpv");
  if (JSON.stringify(targetNames) !== JSON.stringify(EXPECTED_TARGETS)) throw new Error("媒体目标集合必须严格为 ffmpeg.exe/ffprobe.exe/mpv.exe");

  let packs;
  if (isV2) {
    if (!Array.isArray(value.packs) || value.packs.length === 0) throw new Error("media runtime lock packs 不能为空");
    const packIds = new Set();
    const packedComponents = [];
    packs = value.packs.map((pack, packIndex) => {
      const label = `packs[${packIndex}]`;
      assertExactFields(pack, PACK_FIELDS, label);
      const id = requireString(pack.id, `${label}.id`);
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) throw new Error(`${label}.id 必须是规范 pack id`);
      if (packIds.has(id)) throw new Error(`pack id 重复: ${id}`);
      packIds.add(id);
      const minimumUsefulVersion = requireString(pack.minimumUsefulVersion, `${label}.minimumUsefulVersion`);
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(minimumUsefulVersion)) {
        throw new Error(`${label}.minimumUsefulVersion 必须是 SemVer`);
      }
      if (!Array.isArray(pack.components) || pack.components.length === 0) throw new Error(`${label}.components 不能为空`);
      const packComponents = pack.components.map((component, componentIndex) => {
        const name = requireString(component, `${label}.components[${componentIndex}]`);
        if (!EXPECTED_COMPONENTS.includes(name)) throw new Error(`${label} 包含未知组件: ${name}`);
        if (packedComponents.includes(name)) throw new Error(`媒体组件被多个 pack 重复声明: ${name}`);
        packedComponents.push(name);
        return name;
      });
      const sorted = [...packComponents].sort(ordinalCompare);
      if (JSON.stringify(sorted) !== JSON.stringify(packComponents)) throw new Error(`${label}.components 必须按 ordinal 排序`);
      return { id, minimumUsefulVersion, components: packComponents };
    });
    if (JSON.stringify([...packedComponents].sort(ordinalCompare)) !== JSON.stringify(EXPECTED_COMPONENTS)) {
      throw new Error("media runtime packs 必须恰好覆盖 ffmpeg/ffprobe/mpv");
    }
  }
  return {
    schemaVersion: value.schemaVersion,
    platform: value.platform,
    arch: value.arch,
    archives: value.archives,
    ...(isV2 ? { packs } : {}),
    components: components.sort((a, b) => ordinalCompare(a.name, b.name)),
  };
}

export async function readMediaRuntimeLock(lockPath) {
  const info = await assertPathChain(lockPath, { leafType: "file" });
  if (info.size <= 0) throw new Error("media runtime lock 必须是非空普通文件");
  return validateMediaRuntimeLock(JSON.parse(await readFile(lockPath, "utf8")));
}

function parseChecksums(source) {
  if (!source.endsWith("\n")) throw new Error("binaries/CHECKSUMS.txt 必须以换行结尾");
  const result = new Map();
  for (const line of source.slice(0, -1).split("\n")) {
    const match = /^([0-9a-f]{64})  ([^/\\]+)$/.exec(line);
    if (!match) throw new Error("binaries/CHECKSUMS.txt 格式无效");
    if (result.has(match[2])) throw new Error(`binaries/CHECKSUMS.txt 重复: ${match[2]}`);
    result.set(match[2], match[1]);
  }
  if (JSON.stringify([...result.keys()].sort()) !== JSON.stringify(EXPECTED_TARGETS)) {
    throw new Error("binaries/CHECKSUMS.txt 条目集合不闭合");
  }
  return result;
}

export async function buildMediaRuntimeManifest(lockPath, binariesPath) {
  const lock = await readMediaRuntimeLock(lockPath);
  await assertPathChain(binariesPath, { leafType: "directory" });
  const entries = await readdir(binariesPath, { withFileTypes: true });
  const actualNames = entries.map(({ name }) => name).sort(ordinalCompare);
  const allowedSets = [EXPECTED_BINARY_ENTRIES, ["README.md", ...EXPECTED_BINARY_ENTRIES].sort(ordinalCompare)];
  if (!allowedSets.some((allowed) => JSON.stringify(actualNames) === JSON.stringify(allowed))) {
    throw new Error(`binaries 实际条目集合不闭合: ${JSON.stringify(actualNames)}`);
  }
  for (const entry of entries) {
    const info = await assertPathChain(path.join(binariesPath, entry.name), { leafType: "file" });
    if (info.size <= 0 && entry.name !== "CHECKSUMS.txt") throw new Error(`binaries/${entry.name} 必须非空`);
  }
  const checksumsPath = path.join(binariesPath, "CHECKSUMS.txt");
  const checksumInfo = await assertPathChain(checksumsPath, { leafType: "file" });
  if (checksumInfo.size <= 0) throw new Error("binaries/CHECKSUMS.txt 必须是非空普通文件");
  const checksums = parseChecksums(await readFile(checksumsPath, "utf8"));
  const components = [];
  for (const component of lock.components) {
    const filePath = path.join(binariesPath, component.targetName);
    const info = await assertPathChain(filePath, { leafType: "file" });
    if (info.size <= 0) throw new Error(`${component.targetName} 必须是非空普通文件`);
    const extractedSha256 = createHash("sha256").update(await readFile(filePath)).digest("hex");
    if (checksums.get(component.targetName) !== extractedSha256) throw new Error(`${component.targetName} 与 CHECKSUMS.txt 不一致`);
    if (component.extractedSha256 && component.extractedSha256 !== extractedSha256) {
      throw new Error(`${component.targetName} 与 v2 lock extractedSha256 不一致`);
    }
    if (component.sizeBytes && component.sizeBytes !== info.size) {
      throw new Error(`${component.targetName} 与 v2 lock sizeBytes 不一致`);
    }
    components.push({
      name: component.name,
      version: component.version,
      sourceUrl: component.sourceUrl,
      archiveSha256: component.archiveSha256,
      extractedFile: component.targetName,
      extractedSha256,
      sizeBytes: info.size,
      license: component.license,
    });
  }
  return {
    schemaVersion: MEDIA_RUNTIME_SCHEMA,
    platform: lock.platform,
    arch: lock.arch,
    components,
  };
}

export async function validateMediaRuntimeManifest(manifestPath, lockPath) {
  const info = await assertPathChain(manifestPath, { leafType: "file" });
  if (info.size <= 0) throw new Error("MEDIA-RUNTIMES.json 必须是非空普通文件");
  const value = JSON.parse(await readFile(manifestPath, "utf8"));
  const lock = await readMediaRuntimeLock(lockPath);
  assertExactFields(value, RUNTIME_FIELDS, "MEDIA-RUNTIMES.json");
  if (value.schemaVersion !== MEDIA_RUNTIME_SCHEMA || value.platform !== lock.platform || value.arch !== lock.arch) {
    throw new Error("MEDIA-RUNTIMES.json schema/platform/arch 不匹配");
  }
  if (!Array.isArray(value.components) || value.components.length !== lock.components.length) {
    throw new Error("MEDIA-RUNTIMES.json component cardinality 不匹配");
  }
  for (const [index, component] of value.components.entries()) {
    assertExactFields(component, RUNTIME_COMPONENT_FIELDS, `MEDIA-RUNTIMES.json components[${index}]`);
    const expected = lock.components[index];
    for (const field of ["name", "version", "sourceUrl", "archiveSha256", "license"]) {
      if (component[field] !== expected[field]) throw new Error(`MEDIA-RUNTIMES.json ${expected.name} ${field} 与锁定清单不一致`);
    }
    if (component.extractedFile !== expected.targetName) throw new Error(`MEDIA-RUNTIMES.json ${expected.name} extractedFile 不匹配`);
    requireSha256(component.extractedSha256, `MEDIA-RUNTIMES.json ${expected.name}.extractedSha256`);
    if (!Number.isSafeInteger(component.sizeBytes) || component.sizeBytes <= 0) throw new Error(`MEDIA-RUNTIMES.json ${expected.name}.sizeBytes 无效`);
    if (expected.extractedSha256 && component.extractedSha256 !== expected.extractedSha256) {
      throw new Error(`MEDIA-RUNTIMES.json ${expected.name} extractedSha256 与 v2 lock 不一致`);
    }
    if (expected.sizeBytes && component.sizeBytes !== expected.sizeBytes) {
      throw new Error(`MEDIA-RUNTIMES.json ${expected.name} sizeBytes 与 v2 lock 不一致`);
    }
  }
  return value;
}

function parseArgs(args) {
  const allowed = new Set(["--lock", "--binaries", "--output", "--manifest"]);
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!allowed.has(name)) throw new Error(`未知参数: ${name ?? "<missing>"}`);
    if (values.has(name)) throw new Error(`重复参数: ${name}`);
    if (value === undefined || value.startsWith("--")) throw new Error(`需要 ${name} <value>`);
    values.set(name, value);
  }
  if (!values.has("--lock")) throw new Error("需要 --lock <value>");
  const buildMode = values.has("--binaries") || values.has("--output");
  const validateMode = values.has("--manifest");
  if (buildMode === validateMode) throw new Error("必须且只能选择 --binaries/--output 生成或 --manifest 验证模式");
  if (buildMode && (!values.has("--binaries") || !values.has("--output"))) {
    throw new Error("生成模式必须同时提供 --binaries 和 --output");
  }
  return { values, buildMode };
}

export async function runCli(args) {
  const { values, buildMode } = parseArgs(args);
  const lockPath = path.resolve(values.get("--lock"));
  const outputPath = buildMode ? path.resolve(values.get("--output")) : null;
  if (buildMode) {
    await assertPathChain(path.dirname(outputPath), { leafType: "directory" });
    if (await lstatOrNull(outputPath)) throw new Error("拒绝覆盖已有 --output");
  }
  const result = buildMode
    ? await buildMediaRuntimeManifest(lockPath, path.resolve(values.get("--binaries")))
    : await validateMediaRuntimeManifest(path.resolve(values.get("--manifest")), lockPath);
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
