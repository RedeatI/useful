// useful source 子命令：init / add-package / remove-package / publish /
// rotate-root / export-static / validate / serve。
// 静态源目录布局（可被任意静态 HTTP 服务器托管的部分 = export-static 的输出）：
//   source-config.yaml   源配置（sourceId/名称/baseUrl/过期策略）
//   keys/                私钥（开发文件密钥；绝不导出、绝不公开）
//   repository/packages/ 已添加的 .useful 原始包
//   source-state.json    包登记与 TUF 版本计数
//   .well-known/ metadata/ targets/ catalog/   ← 发布产物（导出这些）
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import YAML from "yaml";
import { validateManifest } from "../validate.mjs";
import { readUsefulManifest } from "../safe-zip.mjs";
import { generateKey, keyFromPrivatePem, sha256Hex, signBytes, verifyBytes } from "./keys.mjs";
import {
  buildRootSigned,
  buildSnapshotSigned,
  buildTargetsSigned,
  buildTimestampSigned,
  expiresIn,
  metaEntryOf,
  metadataBytes,
  verifyRepository,
  wrapAndSign,
} from "./tuf.mjs";

const ROLE_KEYS = ["root", "targets", "snapshot", "timestamp"];
const PUBLISHER_PAYLOAD_VERSION = "useful-artifact-v1";

function publisherPayload(toolId, version, sha256) {
  return Buffer.from(`${PUBLISHER_PAYLOAD_VERSION}\n${toolId}\n${version}\n${sha256.toLowerCase()}`, "utf8");
}

function targetNameOf(p) {
  return `${p.toolId}-${p.version}-${p.channel}-${p.platform}-${p.arch}.useful`.replace(
    /[^a-zA-Z0-9._-]/g,
    "_",
  );
}

function verifyPublisherCustom(custom) {
  if (!custom || custom.publisherSignatureVerified !== true) return false;
  if (custom.publisherSignatureMethod !== "ed25519") return false;
  if (custom.publisherSignaturePayloadVersion !== PUBLISHER_PAYLOAD_VERSION) return false;
  if (custom.signatureIdentity !== custom.publisherKeyId) return false;
  if (!/^ed25519:[a-f0-9]{64}$/.test(custom.publisherKeyId ?? "")) return false;
  if (!/^[a-f0-9]{64}$/.test(custom.artifactSha256 ?? "")) return false;
  for (const field of ["toolId", "version", "channel", "platform", "arch"]) {
    if (typeof custom[field] !== "string" || custom[field].length === 0) return false;
  }
  return verifyBytes(
    custom.publisherKeyId.slice("ed25519:".length),
    publisherPayload(custom.toolId, custom.version, custom.artifactSha256),
    custom.publisherSignature,
  );
}

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeFileEnsured(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
}

function writeFileAtomicEnsured(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const temp = `${p}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let fd;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, p);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
  }
}

function copyDirectorySync(src, out) {
  fs.mkdirSync(out, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const sourcePath = path.join(src, entry.name);
    const outputPath = path.join(out, entry.name);
    if (entry.isDirectory()) {
      copyDirectorySync(sourcePath, outputPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(sourcePath, outputPath);
    } else {
      throw new Error(`Unsupported entry in static source export: ${sourcePath}`);
    }
  }
}

function loadConfig(dir) {
  const p = path.join(dir, "source-config.yaml");
  if (!fs.existsSync(p)) die(`不是源目录（缺少 source-config.yaml）: ${dir}`);
  return YAML.parse(fs.readFileSync(p, "utf8"));
}

function loadState(dir) {
  const p = path.join(dir, "source-state.json");
  return fs.existsSync(p)
    ? readJson(p)
    : { tufVersion: { targets: 0, snapshot: 0, timestamp: 0 }, packages: [] };
}

function saveState(dir, state) {
  writeFileAtomicEnsured(path.join(dir, "source-state.json"), `${JSON.stringify(state, null, 2)}\n`);
}

function withSourcePublishLock(dir, action) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    die(`源目录不存在: ${dir}`);
  }
  const lockPath = path.join(dir, ".useful-source-publish.lock");
  let fd;
  try {
    fd = fs.openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      die("源正由另一个 publish 进程处理；若上次进程崩溃，请确认其已退出后删除 .useful-source-publish.lock");
    }
    throw error;
  }
  const cleanup = () => {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // The descriptor may already have been closed by a prior cleanup.
      }
      fd = undefined;
    }
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {
      // A failed cleanup intentionally leaves a fail-closed process lock.
    }
  };
  process.once("exit", cleanup);
  try {
    return action();
  } finally {
    process.removeListener("exit", cleanup);
    cleanup();
  }
}

function loadRoleKey(dir, role) {
  const p = path.join(dir, "keys", `${role}.pem`);
  if (!fs.existsSync(p)) die(`缺少私钥 keys/${role}.pem（开发文件密钥）`);
  return keyFromPrivatePem(fs.readFileSync(p, "utf8"));
}

/** 平台映射：插件 manifest 的 windows-x64 → TRP platform/arch。 */
function mapPlatform(p) {
  const table = {
    "windows-x64": { platform: "windows", arch: "x86_64" },
    "windows-arm64": { platform: "windows", arch: "aarch64" },
  };
  return table[p] ?? null;
}

// ---------- init ----------

export function cmdInit(dir, opts = {}) {
  if (fs.existsSync(path.join(dir, "source-config.yaml"))) {
    die(`目录已经是一个源: ${dir}`);
  }
  const sourceId = opts.id ?? "com.example.my-source";
  fs.mkdirSync(dir, { recursive: true });
  for (const sub of ["keys", "repository/packages", "metadata", "targets", "catalog"]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }

  console.log("⚠ 开发环境文件密钥：私钥保存在 keys/ 下。生产环境请离线保管 root 私钥，");
  console.log("  并使用独立在线密钥承担 snapshot/timestamp（见 README「根密钥备份」）。");

  const keys = {};
  for (const role of ROLE_KEYS) {
    keys[role] = generateKey();
    writeFileEnsured(path.join(dir, "keys", `${role}.pem`), keys[role].privatePem);
  }
  // 发布者密钥（工具签名身份，与源信任域分离）
  const publisher = generateKey();
  writeFileEnsured(path.join(dir, "keys", "publisher.pem"), publisher.privatePem);
  writeFileEnsured(
    path.join(dir, "keys", ".gitignore"),
    "*.pem\n*.bak\n", // 私钥绝不入库
  );

  const config = {
    sourceId,
    name: opts.name ?? "My Useful Source",
    operator: opts.operator ?? "Self-hosted",
    description: "",
    // 本地预览默认地址；正式静态托管时改为 https:// 后重新 publish
    baseUrl: opts.baseUrl ?? "http://127.0.0.1:8787",
    publisherKeyId: `ed25519:${publisher.publicHex}`,
    expires: { root: 3650, targets: 365, snapshot: 30, timestamp: 7 },
  };
  writeFileEnsured(path.join(dir, "source-config.yaml"), YAML.stringify(config));

  // 1.root.json（信任锚）
  const rootSigned = buildRootSigned({
    version: 1,
    expires: expiresIn(config.expires.root),
    roles: {
      root: [keys.root],
      targets: [keys.targets],
      snapshot: [keys.snapshot],
      timestamp: [keys.timestamp],
    },
  });
  const rootDoc = wrapAndSign(rootSigned, [keys.root]);
  writeFileEnsured(path.join(dir, "metadata", "1.root.json"), metadataBytes(rootDoc));

  saveState(dir, { tufVersion: { targets: 0, snapshot: 0, timestamp: 0 }, packages: [] });
  writeFileEnsured(path.join(dir, "README.md"), sourceReadme(config));

  console.log(`✓ 已初始化源: ${sourceId}`);
  console.log(`  根指纹（1.root.json sha256）: ${sha256Hex(metadataBytes(rootDoc))}`);
  console.log("  下一步: useful source add-package <dir> <tool.useful> && useful source publish <dir>");
}

// ---------- add-package / remove-package ----------

export function cmdAddPackage(dir, usefulPath, opts = {}) {
  const config = loadConfig(dir);
  const state = loadState(dir);
  if (!fs.existsSync(usefulPath)) die(`包不存在: ${usefulPath}`);
  const { bytes, manifest, manifestBytes } = readUsefulManifest(usefulPath);
  const { valid, errors } = validateManifest(manifest);
  if (!valid) die(`manifest 校验失败:\n  - ${errors.join("\n  - ")}`);

  const channel = opts.channel ?? "stable";
  if (!["stable", "beta", "nightly"].includes(channel)) die(`非法频道: ${channel}`);
  const platforms = (manifest.platforms ?? ["windows-x64"])
    .map(mapPlatform)
    .filter(Boolean);
  if (platforms.length === 0) die("manifest.platforms 无可映射平台");

  const fileName = `${manifest.id}-${manifest.version}.useful`;
  writeFileEnsured(path.join(dir, "repository", "packages", fileName), bytes);

  for (const { platform, arch } of platforms) {
    // 同 (toolId, version, platform, arch, channel) 重复添加 = 替换
    state.packages = state.packages.filter(
      (p) =>
        !(
          p.toolId === manifest.id &&
          p.version === manifest.version &&
          p.platform === platform &&
          p.arch === arch &&
          p.channel === channel
        ),
    );
    state.packages.push({
      toolId: manifest.id.toLowerCase(),
      name: manifest.name,
      summary: manifest.description ?? "",
      license: manifest.license ?? "Apache-2.0",
      version: manifest.version,
      channel,
      platform,
      arch,
      permissions: manifest.permissions ?? [],
      fileName,
      sha256: sha256Hex(bytes),
      size: bytes.length,
      manifestDigest: sha256Hex(manifestBytes),
      publisherKeyId: config.publisherKeyId,
      addedAt: `${new Date().toISOString().slice(0, 19)}Z`,
    });
  }
  saveState(dir, state);
  console.log(`✓ 已添加: ${manifest.id}@${manifest.version} (${channel})，记得 publish`);
}

export function cmdRemovePackage(dir, toolId, version) {
  const state = loadState(dir);
  const before = state.packages.length;
  state.packages = state.packages.filter(
    (p) => !(p.toolId === toolId && (version === undefined || p.version === version)),
  );
  if (state.packages.length === before) die(`未找到包: ${toolId}${version ? `@${version}` : ""}`);
  saveState(dir, state);
  console.log(`✓ 已移除 ${before - state.packages.length} 条，记得 publish`);
}

// ---------- publish ----------

export function cmdPublish(dir) {
  return withSourcePublishLock(dir, () => publishLocked(dir));
}

function publishLocked(dir) {
  const config = loadConfig(dir);
  const state = loadState(dir);
  const targetsKey = loadRoleKey(dir, "targets");
  const snapshotKey = loadRoleKey(dir, "snapshot");
  const timestampKey = loadRoleKey(dir, "timestamp");
  const publisher = keyFromPrivatePem(fs.readFileSync(path.join(dir, "keys", "publisher.pem"), "utf8"));
  const publisherKeyId = `ed25519:${publisher.publicHex}`;
  if (publisherKeyId !== config.publisherKeyId) {
    die("keys/publisher.pem 与 source-config.yaml publisherKeyId 不匹配");
  }

  // Reserve all three online metadata versions durably before producing any
  // output. A crash may leave a gap, but a reserved version is never reused.
  const reserved = {};
  for (const role of ["targets", "snapshot", "timestamp"]) {
    const current = state.tufVersion?.[role];
    if (!Number.isSafeInteger(current) || current < 0 || current === Number.MAX_SAFE_INTEGER) {
      die(`source-state.json 的 ${role} 版本非法或已溢出`);
    }
    reserved[role] = current + 1;
  }
  state.tufVersion = reserved;
  saveState(dir, state);

  // 1) targets：包文件复制为 consistent 路径 targets/<sha256>.<file>
  const targetsMap = {};
  for (const p of state.packages) {
    const src = path.join(dir, "repository", "packages", p.fileName);
    if (!fs.existsSync(src)) die(`包文件缺失: ${p.fileName}（先 add-package）`);
    const bytes = fs.readFileSync(src);
    const hash = sha256Hex(bytes);
    if (hash !== p.sha256) die(`包文件被改动，摘要不符: ${p.fileName}`);
    if (p.publisherKeyId !== publisherKeyId) die(`包发布者密钥与 keys/publisher.pem 不匹配: ${p.fileName}`);
    const targetName = targetNameOf(p);
    if (Object.hasOwn(targetsMap, targetName)) {
      die(`target 路径冲突，制品身份必须唯一: ${targetName}`);
    }
    const signature = signBytes(publisher.privatePem, publisherPayload(p.toolId, p.version, hash));
    writeFileAtomicEnsured(path.join(dir, "targets", `${hash}.${targetName}`), bytes);
    targetsMap[targetName] = {
      length: bytes.length,
      hashes: { sha256: hash },
      custom: {
        publisherKeyId,
        toolId: p.toolId,
        version: p.version,
        channel: p.channel,
        platform: p.platform,
        arch: p.arch,
        artifactSha256: hash,
        publisherSignatureVerified: true,
        publisherSignatureMethod: "ed25519",
        publisherSignaturePayloadVersion: PUBLISHER_PAYLOAD_VERSION,
        publisherSignature: signature,
        signatureIdentity: publisherKeyId,
      },
    };
    p.publisherSignatureVerified = true;
    p.signatureMethod = "ed25519";
    p.signatureIdentity = publisherKeyId;
  }

  // 2) TUF metadata（版本单调递增 + consistent snapshot 文件名）
  const tv = reserved;
  const targetsSigned = buildTargetsSigned({
    version: tv.targets,
    expires: expiresIn(config.expires.targets),
    targets: targetsMap,
  });
  const targetsDoc = metadataBytes(wrapAndSign(targetsSigned, [targetsKey]));
  const snapshotSigned = buildSnapshotSigned({
    version: tv.snapshot,
    expires: expiresIn(config.expires.snapshot),
    targetsMeta: metaEntryOf(targetsDoc, tv.targets),
  });
  const snapshotDoc = metadataBytes(wrapAndSign(snapshotSigned, [snapshotKey]));
  const timestampSigned = buildTimestampSigned({
    version: tv.timestamp,
    expires: expiresIn(config.expires.timestamp),
    snapshotMeta: metaEntryOf(snapshotDoc, tv.snapshot),
  });
  const timestampDoc = metadataBytes(wrapAndSign(timestampSigned, [timestampKey]));

  writeFileAtomicEnsured(path.join(dir, "metadata", `${tv.targets}.targets.json`), targetsDoc);
  writeFileAtomicEnsured(path.join(dir, "metadata", `${tv.snapshot}.snapshot.json`), snapshotDoc);

  // 3) catalog snapshot（商业信息只在 offer；6C 静态源全部 free）
  const catalog = buildCatalog(config, state);
  writeFileAtomicEnsured(
    path.join(dir, "catalog", "snapshot.json"),
    `${JSON.stringify(catalog, null, 2)}\n`,
  );

  // 4) discovery（rootSha256 = 1.root.json 的摘要 = 客户端钉住的信任根指纹）
  const rootBytes = fs.readFileSync(path.join(dir, "metadata", "1.root.json"));
  const discovery = buildDiscovery(config, sha256Hex(rootBytes));
  writeFileAtomicEnsured(
    path.join(dir, ".well-known", "useful-repository.json"),
    `${JSON.stringify(discovery, null, 2)}\n`,
  );

  saveState(dir, state);
  // timestamp is the repository publication commit point and must be the last
  // published path replaced. Readers either see the prior graph or this one.
  writeFileAtomicEnsured(path.join(dir, "metadata", "timestamp.json"), timestampDoc);
  console.log(
    `✓ 已发布: targets v${state.tufVersion.targets} · ${Object.keys(targetsMap).length} 个制品 · ${catalog.entries.length} 条目录`,
  );
}

function buildCatalog(config, state) {
  const byTool = new Map();
  for (const p of state.packages) {
    const key = `${p.publisherKeyId}\u0000${p.toolId}`;
    if (!byTool.has(key)) byTool.set(key, []);
    byTool.get(key).push(p);
  }
  const entries = [];
  for (const rows of byTool.values()) {
    const first = rows[0];
    const channels = [...new Set(rows.map((r) => r.channel))].sort();
    const latest = {};
    for (const ch of channels) {
      const vers = rows.filter((r) => r.channel === ch).map((r) => r.version);
      latest[ch] = vers.sort(compareSemverDesc)[0];
    }
    entries.push({
      identity: { publisherKeyId: first.publisherKeyId, toolId: first.toolId },
      name: first.name,
      summary: first.summary,
      license: first.license,
      channels,
      latest,
      artifacts: rows.map((r) => ({
        version: r.version,
        channel: r.channel,
        platform: r.platform,
        arch: r.arch,
        artifactSha256: r.sha256,
        manifestDigest: r.manifestDigest,
        size: r.size,
        permissions: r.permissions,
        publishedAt: r.addedAt,
        withdrawn: false,
        publisherSignatureVerified: r.publisherSignatureVerified === true,
        ...(r.signatureMethod ? { signatureMethod: r.signatureMethod } : {}),
        ...(r.signatureIdentity ? { signatureIdentity: r.signatureIdentity } : {}),
      })),
      offer: { accessMode: "free", productId: null, planIds: [], purchaseUrl: null },
      review: {
        repositorySignatureVerified: true,
        publisherSignatureVerified: rows.every((r) => r.publisherSignatureVerified === true),
        officialReviewPassed: false,
        securityScanPassed: false,
        sourceAvailable: false,
        reproducibleBuildVerified: false,
      },
      isNativeWorker: false,
      updatedAt: `${new Date().toISOString().slice(0, 19)}Z`,
    });
  }
  entries.sort((a, b) => a.identity.toolId.localeCompare(b.identity.toolId));
  return {
    schemaVersion: "1.0",
    sourceId: config.sourceId,
    generatedAt: `${new Date().toISOString().slice(0, 19)}Z`,
    entries,
  };
}

function compareSemverDesc(a, b) {
  const pa = a.split(/[.+-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = b.split(/[.+-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pb[i] - pa[i];
  }
  return 0;
}

function buildDiscovery(config, rootSha256) {
  const base = config.baseUrl.replace(/\/+$/, "");
  return {
    schemaVersion: "1.0",
    source: {
      id: config.sourceId,
      name: config.name,
      description: config.description ?? "",
      operator: config.operator,
    },
    repository: {
      profile: "tuf-v1",
      metadataBaseUrl: `${base}/metadata/`,
      targetsBaseUrl: `${base}/targets/`,
      rootUrl: `${base}/metadata/1.root.json`,
      rootSha256,
    },
    capabilities: { catalog: true, staticMirror: true, nativeWorkers: false },
  };
}

// ---------- rotate-root ----------

export function cmdRotateRoot(dir) {
  const config = loadConfig(dir);
  const oldRoot = loadRoleKey(dir, "root");
  // 当前最高版本 root
  const versions = fs
    .readdirSync(path.join(dir, "metadata"))
    .map((f) => /^(\d+)\.root\.json$/.exec(f))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => b - a);
  if (versions.length === 0) die("缺少 root metadata");
  const cur = readJson(path.join(dir, "metadata", `${versions[0]}.root.json`));

  const newRoot = generateKey();
  // 其余角色沿用当前 root 声明的密钥
  const rolesOf = (name) => {
    const def = cur.signed.roles[name];
    return def.keyids.map((kid) => ({ keyid: kid, publicHex: cur.signed.keys[kid].keyval.public }));
  };
  const newSigned = buildRootSigned({
    version: cur.signed.version + 1,
    expires: expiresIn(config.expires?.root ?? 3650),
    roles: {
      root: [newRoot],
      targets: rolesOf("targets"),
      snapshot: rolesOf("snapshot"),
      timestamp: rolesOf("timestamp"),
    },
  });
  // 交叉签名：旧 root + 新 root 同时签署（客户端旧信任链才能接受新 root）
  const doc = wrapAndSign(newSigned, [oldRoot, newRoot]);
  writeFileEnsured(
    path.join(dir, "metadata", `${cur.signed.version + 1}.root.json`),
    metadataBytes(doc),
  );
  // 旧私钥备份，新私钥就位
  fs.renameSync(
    path.join(dir, "keys", "root.pem"),
    path.join(dir, "keys", `root.v${cur.signed.version}.pem.bak`),
  );
  writeFileEnsured(path.join(dir, "keys", "root.pem"), newRoot.privatePem);
  console.log(`✓ root 已轮换到 v${cur.signed.version + 1}（旧钥已备份为 .bak，请离线保管后删除）`);
}

// ---------- export-static / validate / serve ----------

const EXPORT_DIRS = [".well-known", "metadata", "targets", "catalog"];

export function cmdExportStatic(dir, out) {
  loadConfig(dir); // 确认是源目录
  if (!fs.existsSync(path.join(dir, ".well-known", "useful-repository.json"))) {
    die("尚未发布（先 useful source publish）");
  }
  fs.mkdirSync(out, { recursive: true });
  for (const sub of EXPORT_DIRS) {
    const src = path.join(dir, sub);
    if (fs.existsSync(src)) {
      copyDirectorySync(src, path.join(out, sub));
    }
  }
  // 绝不导出 keys/ 与 repository/（私钥与工作区不属于静态站点）
  writeFileEnsured(
    path.join(out, "README.md"),
    "# 静态源导出\n\n本目录可由任意静态 HTTP 服务器托管（保留目录结构即可）。\n私钥不在此目录中，也绝不应该出现在此目录中。\n",
  );
  console.log(`✓ 已导出静态源到: ${out}`);
}

export async function cmdValidate(dir) {
  const exportedDiscovery = path.join(dir, ".well-known", "useful-repository.json");
  if (!fs.existsSync(exportedDiscovery)) loadConfig(dir);
  // 1) TUF 链验证（签名/阈值/过期/hash/length/回滚/consistent snapshot）
  const { rootSigned, targetFiles } = verifyRepository(dir);
  console.log(`✓ TUF 链验证通过（root v${rootSigned.version}，${targetFiles.length} 个 target）`);

  // 2) catalog 与 TUF targets 交叉核对：目录里的每个制品摘要必须由 TUF 声明
  const catalogPath = path.join(dir, "catalog", "snapshot.json");
  if (!fs.existsSync(catalogPath)) die("缺少 catalog/snapshot.json（先 publish）");
  const catalog = readJson(catalogPath);
  for (const target of targetFiles) {
    if (!verifyPublisherCustom(target.custom)) {
      die(`TUF target 发布者证明无效: ${target.name}`);
    }
  }
  const catalogBoundTargets = new Set();
  for (const entry of catalog.entries) {
    for (const a of entry.artifacts) {
      const matches = targetFiles.filter((candidate) => {
        const custom = candidate.custom;
        return candidate.sha256 === a.artifactSha256
          && custom?.publisherKeyId === entry.identity.publisherKeyId
          && custom?.toolId === entry.identity.toolId
          && custom?.version === a.version
          && custom?.channel === a.channel
          && custom?.platform === a.platform
          && custom?.arch === a.arch
          && custom?.artifactSha256 === a.artifactSha256
          && a.signatureMethod === custom?.publisherSignatureMethod
          && a.signatureIdentity === custom?.signatureIdentity;
      });
      if (matches.length !== 1 || !verifyPublisherCustom(matches[0].custom)) {
        die(`目录制品未被精确绑定的 TUF target 声明: ${entry.identity.toolId}@${a.version}/${a.platform}/${a.arch}`);
      }
      if (catalogBoundTargets.has(matches[0].name)) {
        die(`多个目录制品重复绑定同一 TUF target: ${matches[0].name}`);
      }
      catalogBoundTargets.add(matches[0].name);
    }
  }
  if (catalogBoundTargets.size !== targetFiles.length) {
    die("存在未被 catalog 唯一绑定的 TUF target");
  }
  console.log(`✓ catalog 与 TUF targets 一致（${catalog.entries.length} 条目）`);

  // 3) schema 校验（复用 @useful/protocol）
  const { buildAjv, getValidator } = await import("@useful/protocol/src/schemas.mjs");
  const ajv = buildAjv();
  const entryValidate = getValidator(ajv, "catalog-entry.schema.json");
  catalog.entries.forEach((entry, i) => {
    if (!entryValidate(entry)) {
      console.error(JSON.stringify(entryValidate.errors, null, 2));
      die(`catalog entry #${i} 不符合 schema`);
    }
  });
  const discovery = readJson(path.join(dir, ".well-known", "useful-repository.json"));
  if (discovery.repository.metadataBaseUrl.startsWith("https://")) {
    const dValidate = getValidator(ajv, "repository-discovery.schema.json");
    if (!dValidate(discovery)) {
      console.error(JSON.stringify(dValidate.errors, null, 2));
      die("discovery 不符合 schema");
    }
    console.log("✓ discovery 符合 schema");
  } else {
    console.log("• 本地/开发 baseUrl（非 HTTPS）：跳过 discovery HTTPS schema 校验");
  }
  console.log("✓ 源校验全部通过");
}

export function cmdServe(dir, port = 8787) {
  const exportedDiscovery = path.join(dir, ".well-known", "useful-repository.json");
  if (!fs.existsSync(exportedDiscovery)) loadConfig(dir);
  const roots = EXPORT_DIRS;
  const server = createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const rel = path.normalize(urlPath).replace(/^([/\\]|\.\.[/\\]?)+/, "");
    const top = rel.split(/[/\\]/)[0];
    if (!roots.includes(top)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const filePath = path.join(dir, rel);
    if (!filePath.startsWith(path.join(dir, top))) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      res.writeHead(200, {
        "content-type": filePath.endsWith(".json")
          ? "application/json; charset=utf-8"
          : "application/octet-stream",
      });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`✓ 本地静态源: http://127.0.0.1:${port}/.well-known/useful-repository.json`);
    console.log("  在客户端「源中心」以开发者模式添加该地址。按 Ctrl+C 停止。");
  });
  return server;
}

// ---------- README 模板 ----------

function sourceReadme(config) {
  return `# ${config.name}

由 \`useful source init\` 生成的 Useful 软件源（TRP v1，TUF 风格 metadata）。

## 本地预览

\`\`\`
useful source serve .        # http://127.0.0.1:8787
\`\`\`

在 Useful 客户端「源中心」开启开发者模式后添加
\`http://127.0.0.1:8787/.well-known/useful-repository.json\`。

## 静态托管

1. 把 \`source-config.yaml\` 的 \`baseUrl\` 改为正式 HTTPS 地址；
2. \`useful source publish .\`；
3. \`useful source export-static . ./dist-source\`；
4. 把 \`dist-source/\` 上传到任意静态 HTTP 服务器 / 对象存储 / CDN。

## 发布工具

\`\`\`
useful source add-package . ./my-tool-1.0.0.useful --channel stable
useful source publish .
useful source validate .
\`\`\`

## 镜像已有合法包

把获得授权分发的 .useful 用 add-package 添加即可；目录条目会保留原 publisherKeyId
（同发布者、同摘要的镜像在客户端会被折叠展示）。仅镜像你有权分发的内容。

## 根密钥备份

- \`keys/root.pem\` 是本源的信任根。丢失 = 无法轮换；泄露 = 源可被冒充。
- 生产环境：root 私钥离线保管（推荐多份异地备份 + 阈值多签）；
  snapshot/timestamp 使用独立在线密钥。
- 开发文件密钥仅限本地测试。

## 密钥轮换

\`\`\`
useful source rotate-root .
useful source publish .
\`\`\`

新 root 由旧 root 与新 root 交叉签名，已添加此源的客户端沿 TUF 链自动接受；
初始根指纹（1.root.json 的 sha256）不变。

## 添加到客户端

源中心 → 添加源 → 输入 discovery 地址 → 核对根密钥指纹 → 确认。
指纹请通过独立渠道（官网/公告）公布，供用户比对。

## 不要公开私钥

\`keys/\` 目录已被 .gitignore 排除，且 export-static 永不导出它。
不要把 keys/ 目录提交进版本库、打包进静态站点或分享给他人。
`;
}
