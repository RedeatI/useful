// 客户端更新密钥与更新 manifest 工具链（Phase 10 生产闭环）。
//
// 强隔离设计（ADR-014）：
//   - 环境四分：development / test / staging / production，签名域分离，
//     测试签名永远无法被当作生产签名验证；
//   - 测试密钥产物强制包含 NOT-FOR-PRODUCTION 标识；
//   - 生产模式拒绝内置测试根；真实生产根创建为 Owner Gate（本工具只产出演练清单）；
//   - 支持离线 root 签名、threshold 签名、密钥轮换与遗失恢复演练；
//   - 私钥绝不写日志；私钥文件落盘即设最小权限并做校验。
import fs from "node:fs";
import path from "node:path";
import { generateKey, keyFromPrivatePem, signCanonical, verifyCanonical, sha256Hex } from "../source/keys.mjs";

const SCHEMA = "useful-update-root-v1";
const UPDATE_SCHEMA = "useful-app-update-v1";
const ENVIRONMENTS = ["development", "test", "staging", "production"];
const NOT_FOR_PROD = "NOT-FOR-PRODUCTION";

/** 签名域分离：测试域签名永远不能验证为生产。 */
function signingDomain(env, payloadObj) {
  return { __domain: `${UPDATE_SCHEMA}\n${env}`, payload: payloadObj };
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

/** 写私钥文件并设置最小权限（0600）；返回路径。绝不打印私钥内容。 */
function writePrivateKey(dir, name, pem, env) {
  ensureDir(dir);
  const file = path.join(dir, `${name}.private.pem`);
  fs.writeFileSync(file, pem, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows ACL 由文件系统处理 */
  }
  if (env !== "production") {
    // 测试/开发私钥旁标注，防误用
    fs.writeFileSync(path.join(dir, `${name}.${NOT_FOR_PROD}`), `${env} key; ${NOT_FOR_PROD}\n`);
  }
  return file;
}

/** 校验私钥文件权限（非 Windows 检查 0600；Windows 仅提示）。 */
export function checkKeyPermissions(file) {
  const st = fs.statSync(file);
  if (process.platform !== "win32") {
    const mode = st.mode & 0o777;
    if (mode !== 0o600) {
      return { ok: false, reason: `私钥权限应为 600，实际 ${mode.toString(8)}` };
    }
  }
  return { ok: true };
}

function assertEnv(env) {
  if (!ENVIRONMENTS.includes(env)) {
    throw new Error(`环境必须是 ${ENVIRONMENTS.join("|")}，得到: ${env}`);
  }
}

// ---------- key init-root ----------
// 生产环境不自动生成真实根（Owner Gate）；输出离线密钥仪式清单。
export function keyInitRoot(dir, opts) {
  const env = opts.env ?? "development";
  assertEnv(env);
  const threshold = Number(opts.threshold ?? 2);
  const rootCount = Number(opts.roots ?? 3);
  if (threshold < 1 || threshold > rootCount) {
    throw new Error(`threshold(${threshold}) 必须在 1..rootCount(${rootCount}) 之间`);
  }

  const ownerGateAcknowledged =
    opts.ownerGateAcknowledged === true
    || opts.ownerGateAcknowledged === "true"
    || opts["owner-gate-acknowledged"] === true
    || opts["owner-gate-acknowledged"] === "true";
  if (env === "production" && !ownerGateAcknowledged) {
    // Owner Gate：拒绝自动生成生产根，产出离线仪式清单
    const checklist = productionCeremonyChecklist(threshold, rootCount);
    ensureDir(dir);
    fs.writeFileSync(path.join(dir, "PRODUCTION-KEY-CEREMONY.md"), checklist);
    console.log("⚠ 生产根为 Owner Gate：未生成真实密钥。");
    console.log(`  已输出离线密钥仪式清单: ${path.join(dir, "PRODUCTION-KEY-CEREMONY.md")}`);
    console.log("  完成离线仪式后，用 --owner-gate-acknowledged 且在隔离主机上执行。");
    return { ownerGate: true };
  }

  ensureDir(dir);
  const keysDir = path.join(dir, "keys");
  const rootKeys = [];
  for (let i = 0; i < rootCount; i += 1) {
    const k = generateKey();
    writePrivateKey(keysDir, `root-${i + 1}`, k.privatePem, env);
    rootKeys.push({ keyid: k.keyid, publicHex: k.publicHex, role: "root" });
  }
  // release 角色（签更新 manifest）
  const releaseKey = generateKey();
  writePrivateKey(keysDir, "release", releaseKey.privatePem, env);

  const root = {
    schemaVersion: SCHEMA,
    environment: env,
    notForProduction: env !== "production",
    version: 1,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 365 * 864e5).toISOString(),
    roles: {
      root: { threshold, keyids: rootKeys.map((k) => k.keyid) },
      release: { threshold: 1, keyids: [releaseKey.keyid] },
    },
    keys: Object.fromEntries(
      [...rootKeys, { keyid: releaseKey.keyid, publicHex: releaseKey.publicHex, role: "release" }].map((k) => [
        k.keyid,
        { keytype: "ed25519", scheme: "ed25519", role: k.role, keyval: { public: k.publicHex } },
      ]),
    ),
    revoked: [],
    signatures: [],
  };
  fs.writeFileSync(path.join(dir, "root.json"), JSON.stringify(root, null, 2));
  console.log(`✓ 已初始化 ${env} 更新根（${env !== "production" ? NOT_FOR_PROD : "PRODUCTION"}）`);
  console.log(`  root 阈值: ${threshold}/${rootCount}  release keyid: ${releaseKey.keyid.slice(0, 16)}…`);
  console.log(`  私钥目录: ${keysDir}（权限 600；绝不提交仓库）`);
  console.log(`  下一步: useful key sign-root ${dir} --key <root-N.private.pem>（离线，累积到阈值）`);
  return { root };
}

function productionCeremonyChecklist(threshold, rootCount) {
  return `# 生产更新根离线密钥仪式清单（Owner Gate）

本文件由 \`useful key init-root --env production\` 生成。真实生产根密钥
绝不能由自动化代理生成，必须由授权持有人在隔离环境完成离线仪式。

## 前置
- [ ] 隔离、离线的密钥仪式主机（air-gapped）
- [ ] ${rootCount} 名 root 密钥持有人到场，阈值 ${threshold}/${rootCount}
- [ ] 硬件安全模块（HSM）或加密离线介质
- [ ] 见证人与录像（合规要求时）

## 步骤
1. [ ] 每位持有人在各自 HSM/离线介质生成 root 私钥，导出公钥
2. [ ] 汇总公钥，构造 root.json（threshold=${threshold}）
3. [ ] 每位持有人离线对 root.json 签名，累积至阈值
4. [ ] 生成 release 角色在线密钥（可轮换）
5. [ ] 用 \`useful key verify-ceremony\` 校验根一致性与阈值可满足
6. [ ] 将 root.json（仅公钥与签名）纳入 TUF 分发与客户端内置信任锚
7. [ ] 私钥归档到 HSM/离线介质，登记保管链

## 严禁
- 禁止将生产私钥写入仓库、CI、日志或任何联网主机
- 禁止用测试根冒充生产根（客户端 --production 会拒绝 NOT-FOR-PRODUCTION 根）
`;
}

// ---------- key generate-role ----------
export function keyGenerateRole(dir, opts) {
  const root = readRoot(dir);
  const role = opts.role ?? "release";
  const k = generateKey();
  writePrivateKey(path.join(dir, "keys"), `${role}-${k.keyid.slice(0, 8)}`, k.privatePem, root.environment);
  root.keys[k.keyid] = { keytype: "ed25519", scheme: "ed25519", role, keyval: { public: k.publicHex } };
  if (!root.roles[role]) root.roles[role] = { threshold: 1, keyids: [] };
  root.roles[role].keyids.push(k.keyid);
  root.signatures = []; // 角色变更使旧根签名失效，需重签
  fs.writeFileSync(path.join(dir, "root.json"), JSON.stringify(root, null, 2));
  console.log(`✓ 已生成 ${role} 角色密钥 ${k.keyid.slice(0, 16)}…（根签名已清空，需重新 sign-root）`);
}

// ---------- key sign-root（离线，阈值累积） ----------
export function keySignRoot(dir, opts) {
  const root = readRoot(dir);
  if (!opts.key) throw new Error("需要 --key <root 私钥 PEM 路径>");
  const perm = checkKeyPermissions(opts.key);
  if (!perm.ok) console.error(`⚠ ${perm.reason}`);
  const pem = fs.readFileSync(opts.key, "utf8");
  const { keyid } = keyFromPrivatePem(pem);
  if (!root.roles.root.keyids.includes(keyid)) {
    throw new Error("该私钥不是 root 角色密钥");
  }
  const signed = rootSignedPortion(root);
  const sig = signCanonical(pem, signed);
  root.signatures = (root.signatures ?? []).filter((s) => s.keyid !== keyid);
  root.signatures.push({ keyid, sig });
  fs.writeFileSync(path.join(dir, "root.json"), JSON.stringify(root, null, 2));
  const have = root.signatures.length;
  const need = root.roles.root.threshold;
  console.log(`✓ 已用 root 密钥 ${keyid.slice(0, 16)}… 签名（${have}/${need}）`);
  if (have >= need) console.log("  阈值已满足，根可信。");
  else console.log(`  仍需 ${need - have} 个 root 签名（其他持有人离线执行）。`);
}

function rootSignedPortion(root) {
  const { signatures, ...rest } = root;
  void signatures;
  return rest;
}

// ---------- key rotate-root ----------
export function keyRotateRoot(dir) {
  const root = readRoot(dir);
  const oldVersion = root.version;
  // 生成新 root 密钥集，旧密钥进入 revoked（轮换连续性由版本 + 旧根重签保证）
  const keysDir = path.join(dir, "keys");
  const newKeyids = [];
  const count = root.roles.root.keyids.length;
  for (let i = 0; i < count; i += 1) {
    const k = generateKey();
    writePrivateKey(keysDir, `root-v${oldVersion + 1}-${i + 1}`, k.privatePem, root.environment);
    root.keys[k.keyid] = { keytype: "ed25519", scheme: "ed25519", role: "root", keyval: { public: k.publicHex } };
    newKeyids.push(k.keyid);
  }
  root.revoked = [...(root.revoked ?? []), ...root.roles.root.keyids];
  root.roles.root.keyids = newKeyids;
  root.version = oldVersion + 1;
  root.rotatedFromVersion = oldVersion;
  root.signatures = [];
  fs.writeFileSync(path.join(dir, "root.json"), JSON.stringify(root, null, 2));
  console.log(`✓ 根已轮换 v${oldVersion} → v${root.version}（旧密钥进入 revoked）`);
  console.log("  需用新 root 密钥重新签名至阈值（sign-root）。");
}

// ---------- key revoke ----------
export function keyRevoke(dir, opts) {
  const root = readRoot(dir);
  if (!opts.keyid) throw new Error("需要 --keyid");
  root.revoked = [...new Set([...(root.revoked ?? []), opts.keyid])];
  for (const role of Object.values(root.roles)) {
    role.keyids = role.keyids.filter((k) => k !== opts.keyid);
  }
  root.signatures = [];
  fs.writeFileSync(path.join(dir, "root.json"), JSON.stringify(root, null, 2));
  console.log(`✓ 已撤销 ${opts.keyid.slice(0, 16)}…（需重签根）`);
}

// ---------- key inspect（绝不打印私钥） ----------
export function keyInspect(dir) {
  const root = readRoot(dir);
  console.log(`更新根: ${root.environment}${root.notForProduction ? ` (${NOT_FOR_PROD})` : ""}`);
  console.log(`  版本: ${root.version}  过期: ${root.expiresAt}`);
  for (const [role, def] of Object.entries(root.roles)) {
    console.log(`  角色 ${role}: 阈值 ${def.threshold}/${def.keyids.length}`);
    for (const kid of def.keyids) console.log(`    - ${kid.slice(0, 32)}…`);
  }
  console.log(`  已撤销: ${(root.revoked ?? []).length} 个`);
  console.log(`  根签名: ${(root.signatures ?? []).length}/${root.roles.root.threshold}`);
}

// ---------- key verify-ceremony（dry-run 一致性校验） ----------
export function keyVerifyCeremony(dir, opts) {
  const root = readRoot(dir);
  const problems = [];
  // 生产模式拒绝内置测试根
  if (opts.production && root.notForProduction) {
    problems.push(`生产模式拒绝 ${NOT_FOR_PROD} 根（环境=${root.environment}）`);
  }
  // 阈值可满足性
  if (root.roles.root.keyids.length < root.roles.root.threshold) {
    problems.push("root 密钥数少于阈值，不可满足");
  }
  // 验证已累积的根签名
  const signed = rootSignedPortion(root);
  let valid = 0;
  for (const s of root.signatures ?? []) {
    const key = root.keys[s.keyid];
    if (key && verifyCanonical(key.keyval.public, signed, s.sig)) valid += 1;
    else problems.push(`根签名无效: ${s.keyid.slice(0, 16)}…`);
  }
  const thresholdMet = valid >= root.roles.root.threshold;
  if (!thresholdMet) problems.push(`根签名 ${valid}/${root.roles.root.threshold} 未达阈值`);

  if (problems.length === 0) {
    console.log(`✓ 密钥仪式校验通过（${root.environment}，根签名 ${valid}/${root.roles.root.threshold}）`);
    return 0;
  }
  console.error("✗ 密钥仪式校验失败:");
  for (const p of problems) console.error(`  - ${p}`);
  return 1;
}

// ---------- app-update create / sign / verify ----------
export function appUpdateCreate(file, opts) {
  for (const req of ["product", "version", "channel", "artifact"]) {
    if (!opts[req]) throw new Error(`需要 --${req}`);
  }
  if (!fs.existsSync(opts.artifact)) throw new Error(`artifact 不存在: ${opts.artifact}`);
  const buf = fs.readFileSync(opts.artifact);
  const manifest = {
    schemaVersion: UPDATE_SCHEMA,
    product: opts.product,
    version: opts.version,
    channel: opts.channel, // stable|beta
    environment: opts.env ?? "development",
    artifactSha256: sha256Hex(buf),
    length: buf.length,
    minimumCompatVersion: opts.minCompat ?? "0.0.0",
    publishedAt: new Date().toISOString(),
    signingDomain: `${UPDATE_SCHEMA}\n${opts.env ?? "development"}`,
    rollback: {
      allowed: opts.rollbackAllowed !== "false",
      minVersion: opts.rollbackMin ?? "0.0.0",
    },
    signatures: [],
  };
  assertEnv(manifest.environment);
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
  console.log(`✓ 已创建更新 manifest: ${file}`);
  console.log(`  ${manifest.product} ${manifest.version} (${manifest.channel}/${manifest.environment})`);
  console.log(`  digest: ${manifest.artifactSha256.slice(0, 16)}…  length: ${manifest.length}`);
}

export function appUpdateSign(file, opts) {
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!opts.key) throw new Error("需要 --key <release 私钥 PEM>");
  if (!opts.root) throw new Error("需要 --root <更新根目录>");
  const root = readRoot(opts.root);
  // 签名域必须与根环境一致：测试根不能签生产域
  if (root.environment !== manifest.environment) {
    throw new Error(`签名域不匹配：根环境 ${root.environment} vs manifest ${manifest.environment}`);
  }
  const perm = checkKeyPermissions(opts.key);
  if (!perm.ok) console.error(`⚠ ${perm.reason}`);
  const pem = fs.readFileSync(opts.key, "utf8");
  const { keyid } = keyFromPrivatePem(pem);
  if (!root.roles.release.keyids.includes(keyid)) {
    throw new Error("该私钥不是该根的 release 角色密钥");
  }
  const payload = signingDomain(manifest.environment, updateSignedPortion(manifest));
  const sig = signCanonical(pem, payload);
  manifest.signatures = (manifest.signatures ?? []).filter((s) => s.keyid !== keyid);
  manifest.signatures.push({ keyid, sig });
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
  console.log(`✓ 已签名更新 manifest（release ${keyid.slice(0, 16)}…）`);
}

function updateSignedPortion(m) {
  const { signatures, ...rest } = m;
  void signatures;
  return rest;
}

export function appUpdateVerify(file, opts) {
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  const root = readRoot(opts.root);
  const problems = [];
  // 生产验证拒绝测试根 / 测试域
  if (opts.production) {
    if (root.notForProduction || root.environment !== "production") {
      problems.push(`生产验证拒绝非生产根（环境=${root.environment}）`);
    }
    if (manifest.environment !== "production") {
      problems.push(`生产验证拒绝非生产 manifest（环境=${manifest.environment}）`);
    }
  }
  // 签名域绑定
  if (manifest.signingDomain !== `${UPDATE_SCHEMA}\n${manifest.environment}`) {
    problems.push("signingDomain 与环境不一致");
  }
  const payload = signingDomain(manifest.environment, updateSignedPortion(manifest));
  let valid = 0;
  for (const s of manifest.signatures ?? []) {
    if ((root.revoked ?? []).includes(s.keyid)) {
      problems.push(`签名使用已撤销密钥: ${s.keyid.slice(0, 16)}…`);
      continue;
    }
    const key = root.keys[s.keyid];
    if (key && key.role === "release" && verifyCanonical(key.keyval.public, payload, s.sig)) valid += 1;
    else problems.push(`签名无效或非 release 角色: ${s.keyid.slice(0, 16)}…`);
  }
  const need = root.roles.release.threshold;
  if (valid < need) problems.push(`release 签名 ${valid}/${need} 未达阈值`);

  if (problems.length === 0) {
    console.log(`✓ 更新 manifest 验证通过（${manifest.environment}，release ${valid}/${need}）`);
    return 0;
  }
  console.error("✗ 更新 manifest 验证失败:");
  for (const p of problems) console.error(`  - ${p}`);
  return 1;
}

function readRoot(dir) {
  const p = path.join(dir, "root.json");
  if (!fs.existsSync(p)) throw new Error(`未找到更新根: ${p}（先 useful key init-root）`);
  const root = JSON.parse(fs.readFileSync(p, "utf8"));
  if (root.schemaVersion !== SCHEMA) throw new Error(`不支持的根 schema: ${root.schemaVersion}`);
  return root;
}
