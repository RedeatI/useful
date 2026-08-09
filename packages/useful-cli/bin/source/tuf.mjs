// TUF 风格 metadata 构建与验证链（root / targets / snapshot / timestamp）。
// 支持：consistent snapshot、过期时间、版本回滚防护、hash+length 校验、
// 阈值签名、root 轮换交叉签名。签名/验签全部走 node:crypto Ed25519（keys.mjs）。
import fs from "node:fs";
import path from "node:path";
import { canonicalJson } from "./cjson.mjs";
import { sha256Hex, signCanonical, tufKeyObject, verifyCanonical } from "./keys.mjs";

export const SPEC_VERSION = "1.0.0";
/** 单个 metadata 文件大小上限（防炸弹）。 */
export const MAX_METADATA_SIZE = 8 * 1024 * 1024;

/** RFC3339 UTC（秒精度），now + days 天。 */
export function expiresIn(days, from = new Date()) {
  const d = new Date(from.getTime() + days * 86400_000);
  return `${d.toISOString().slice(0, 19)}Z`;
}

function isExpired(expires, now = new Date()) {
  return new Date(expires).getTime() <= now.getTime();
}

/** 组装 root.signed。roles: { root|targets|snapshot|timestamp: [{keyid, publicHex}] }。 */
export function buildRootSigned({ version, expires, roles, threshold = {} }) {
  const keys = {};
  const roleDefs = {};
  for (const [role, keyList] of Object.entries(roles)) {
    for (const k of keyList) keys[k.keyid] = tufKeyObject(k.publicHex);
    roleDefs[role] = {
      keyids: keyList.map((k) => k.keyid).sort(),
      threshold: threshold[role] ?? 1,
    };
  }
  return {
    _type: "root",
    spec_version: SPEC_VERSION,
    consistent_snapshot: true,
    version,
    expires,
    keys,
    roles: roleDefs,
  };
}

export function buildTargetsSigned({ version, expires, targets }) {
  return { _type: "targets", spec_version: SPEC_VERSION, version, expires, targets };
}

export function buildSnapshotSigned({ version, expires, targetsMeta }) {
  return {
    _type: "snapshot",
    spec_version: SPEC_VERSION,
    version,
    expires,
    meta: { "targets.json": targetsMeta },
  };
}

export function buildTimestampSigned({ version, expires, snapshotMeta }) {
  return {
    _type: "timestamp",
    spec_version: SPEC_VERSION,
    version,
    expires,
    meta: { "snapshot.json": snapshotMeta },
  };
}

/** 对 signed 部分签名并包装。signers: [{keyid, privatePem}]。 */
export function wrapAndSign(signed, signers) {
  return {
    signatures: signers.map((s) => ({
      keyid: s.keyid,
      sig: signCanonical(s.privatePem, signed),
    })),
    signed,
  };
}

/** meta 条目（snapshot/timestamp 引用下级 metadata）。 */
export function metaEntryOf(bytes, version) {
  return { version, length: bytes.length, hashes: { sha256: sha256Hex(bytes) } };
}

/**
 * 验证单个角色文档：签名阈值（去重 keyid）、类型、过期。
 * rootKeys: { keyid: publicHex }；roleDef: { keyids, threshold }。
 */
export function verifyRoleDoc(doc, rootKeys, roleDef, expectedType, { now = new Date() } = {}) {
  if (!doc || typeof doc !== "object" || !doc.signed || !Array.isArray(doc.signatures)) {
    throw new Error(`${expectedType}: 结构非法`);
  }
  const signed = doc.signed;
  if (signed._type !== expectedType) {
    throw new Error(`${expectedType}: _type 不符（${signed._type}）`);
  }
  if (signed.spec_version !== SPEC_VERSION) {
    throw new Error(`${expectedType}: spec_version 不支持`);
  }
  const seen = new Set();
  let valid = 0;
  for (const s of doc.signatures) {
    if (!roleDef.keyids.includes(s.keyid) || seen.has(s.keyid)) continue;
    const publicHex = rootKeys[s.keyid];
    if (!publicHex) continue;
    let ok = false;
    try {
      ok = verifyCanonical(publicHex, signed, s.sig);
    } catch {
      ok = false;
    }
    if (ok) {
      seen.add(s.keyid);
      valid += 1;
    }
  }
  if (valid < roleDef.threshold) {
    throw new Error(`${expectedType}: 签名不足（${valid}/${roleDef.threshold}）——拒绝`);
  }
  if (isExpired(signed.expires, now)) {
    throw new Error(`${expectedType}: metadata 已过期（${signed.expires}）——拒绝（防冻结攻击）`);
  }
  return signed;
}

function keysOfRoot(rootSigned) {
  const out = {};
  for (const [keyid, k] of Object.entries(rootSigned.keys)) {
    out[keyid] = k.keyval.public;
  }
  return out;
}

function readMeta(metadataDir, name) {
  const p = path.join(metadataDir, name);
  if (!fs.existsSync(p)) return null;
  const bytes = fs.readFileSync(p);
  if (bytes.length > MAX_METADATA_SIZE) throw new Error(`${name}: 超过大小上限`);
  return { bytes, doc: JSON.parse(bytes.toString("utf8")) };
}

function checkMetaEntry(name, bytes, entry) {
  if (bytes.length !== entry.length) throw new Error(`${name}: length 不符——拒绝`);
  if (sha256Hex(bytes) !== entry.hashes.sha256) throw new Error(`${name}: sha256 不符——拒绝`);
}

/**
 * 完整仓库验证链（fail closed）：
 * 1.root.json（信任锚，可用 trustedRootBytes 覆盖）→ root 轮换链（新旧双阈值、版本+1）
 * → timestamp → snapshot（hash/length/版本回滚防护）→ targets → 每个 target 文件。
 * 返回 { rootSigned, targetsSigned, targetFiles }。
 */
export function verifyRepository(dir, { now = new Date(), trustedRootBytes = null } = {}) {
  const metadataDir = path.join(dir, "metadata");
  // 1) 信任锚
  const anchorBytes = trustedRootBytes ?? readMeta(metadataDir, "1.root.json")?.bytes;
  if (!anchorBytes) throw new Error("缺少 1.root.json 信任锚");
  let rootDoc = JSON.parse(anchorBytes.toString("utf8"));
  let rootSigned = verifyRoleDoc(
    rootDoc,
    keysOfRoot(rootDoc.signed),
    rootDoc.signed.roles.root,
    "root",
    { now },
  );
  if (rootSigned.consistent_snapshot !== true) {
    throw new Error("root: 必须启用 consistent_snapshot");
  }

  // 2) root 轮换链：N+1.root.json 必须同时满足旧 root 与新 root 的阈值
  for (let v = rootSigned.version + 1; ; v += 1) {
    const next = readMeta(metadataDir, `${v}.root.json`);
    if (!next) break;
    if (next.doc.signed.version !== v) throw new Error(`root v${v}: 版本号不符——拒绝`);
    // 旧 root 阈值
    verifyRoleDoc(next.doc, keysOfRoot(rootSigned), rootSigned.roles.root, "root", { now });
    // 新 root 自身阈值
    rootSigned = verifyRoleDoc(
      next.doc,
      keysOfRoot(next.doc.signed),
      next.doc.signed.roles.root,
      "root",
      { now },
    );
  }
  const rootKeys = keysOfRoot(rootSigned);

  // 3) timestamp
  const ts = readMeta(metadataDir, "timestamp.json");
  if (!ts) throw new Error("缺少 timestamp.json");
  const tsSigned = verifyRoleDoc(ts.doc, rootKeys, rootSigned.roles.timestamp, "timestamp", {
    now,
  });

  // 4) snapshot（consistent snapshot 文件名 + hash/length + 版本一致）
  const snapEntry = tsSigned.meta["snapshot.json"];
  const snap = readMeta(metadataDir, `${snapEntry.version}.snapshot.json`);
  if (!snap) throw new Error(`缺少 ${snapEntry.version}.snapshot.json`);
  checkMetaEntry("snapshot", snap.bytes, snapEntry);
  const snapSigned = verifyRoleDoc(snap.doc, rootKeys, rootSigned.roles.snapshot, "snapshot", {
    now,
  });
  if (snapSigned.version !== snapEntry.version) {
    throw new Error("snapshot: 版本与 timestamp 声明不符——拒绝（防回滚）");
  }

  // 5) targets
  const tgtEntry = snapSigned.meta["targets.json"];
  const tgt = readMeta(metadataDir, `${tgtEntry.version}.targets.json`);
  if (!tgt) throw new Error(`缺少 ${tgtEntry.version}.targets.json`);
  checkMetaEntry("targets", tgt.bytes, tgtEntry);
  const tgtSigned = verifyRoleDoc(tgt.doc, rootKeys, rootSigned.roles.targets, "targets", { now });
  if (tgtSigned.version !== tgtEntry.version) {
    throw new Error("targets: 版本与 snapshot 声明不符——拒绝（防回滚）");
  }

  // 6) 每个 target 文件（consistent 路径 <sha256>.<name>）
  const targetFiles = [];
  for (const [name, info] of Object.entries(tgtSigned.targets)) {
    const hash = info.hashes.sha256;
    const p = path.join(dir, "targets", `${hash}.${name}`);
    if (!fs.existsSync(p)) throw new Error(`target 缺失: ${name}`);
    const bytes = fs.readFileSync(p);
    if (bytes.length !== info.length) throw new Error(`target ${name}: length 不符——拒绝`);
    if (sha256Hex(bytes) !== hash) throw new Error(`target ${name}: sha256 不符——拒绝`);
    targetFiles.push({ name, path: p, length: info.length, sha256: hash, custom: info.custom });
  }

  return { rootSigned, targetsSigned: tgtSigned, targetFiles };
}

/** 序列化 metadata 文档（稳定格式：canonical 排序 + 2 空格缩进便于阅读与 diff）。 */
export function metadataBytes(doc) {
  // 先 canonical 确认可序列化（无浮点等），再输出可读 JSON
  canonicalJson(doc.signed);
  return Buffer.from(`${JSON.stringify(doc, null, 2)}\n`, "utf8");
}
