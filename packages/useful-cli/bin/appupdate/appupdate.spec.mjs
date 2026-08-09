// 客户端更新密钥工具链测试：dev/prod 强隔离、阈值签名、轮换、撤销、
// 更新 manifest 签名/验证、生产拒绝测试根、私钥不落日志、Owner Gate。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appUpdateCreate,
  appUpdateSign,
  appUpdateVerify,
  keyInitRoot,
  keyRevoke,
  keyRotateRoot,
  keySignRoot,
  keyVerifyCeremony,
} from "./appupdate.mjs";

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "useful-key-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function keyPath(dir, name) {
  return path.join(dir, "keys", `${name}.private.pem`);
}

function initTestRoot(dir) {
  const logs = captureLogs();
  keyInitRoot(dir, { env: "test", threshold: "2", roots: "3" });
  logs.restore();
  // 达到阈值
  keySignRoot(dir, { key: keyPath(dir, "root-1") });
  keySignRoot(dir, { key: keyPath(dir, "root-2") });
  return logs.lines;
}

// 捕获 console 输出，验证私钥绝不落日志。
function captureLogs() {
  const lines = [];
  const l = vi.spyOn(console, "log").mockImplementation((...a) => lines.push(a.join(" ")));
  const e = vi.spyOn(console, "error").mockImplementation((...a) => lines.push(a.join(" ")));
  return {
    lines,
    restore: () => {
      l.mockRestore();
      e.mockRestore();
    },
  };
}

describe("update key toolchain", () => {
  it("test 根带 NOT-FOR-PRODUCTION 标识且私钥不落日志", () => {
    const logs = captureLogs();
    keyInitRoot(tmp, { env: "test", threshold: "2", roots: "3" });
    logs.restore();
    const root = JSON.parse(fs.readFileSync(path.join(tmp, "root.json"), "utf8"));
    expect(root.notForProduction).toBe(true);
    expect(root.environment).toBe("test");
    // 私钥旁标注文件存在
    expect(fs.existsSync(path.join(tmp, "keys", `root-1.NOT-FOR-PRODUCTION`))).toBe(true);
    // 日志绝不含 PRIVATE KEY
    const joined = logs.lines.join("\n");
    expect(joined).not.toContain("PRIVATE KEY");
    expect(joined).not.toContain("BEGIN");
  });

  it("阈值签名：达到阈值后 verify-ceremony 通过", () => {
    initTestRoot(tmp);
    const code = keyVerifyCeremony(tmp, {});
    expect(code).toBe(0);
  });

  it("未达阈值时 verify-ceremony 失败", () => {
    keyInitRoot(tmp, { env: "test", threshold: "2", roots: "3" });
    keySignRoot(tmp, { key: keyPath(tmp, "root-1") }); // 只签 1/2
    const logs = captureLogs();
    const code = keyVerifyCeremony(tmp, {});
    logs.restore();
    expect(code).toBe(1);
  });

  it("生产 init-root 是 Owner Gate：不生成真实根，输出仪式清单", () => {
    const logs = captureLogs();
    const res = keyInitRoot(tmp, { env: "production" });
    logs.restore();
    expect(res.ownerGate).toBe(true);
    expect(fs.existsSync(path.join(tmp, "root.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, "PRODUCTION-KEY-CEREMONY.md"))).toBe(true);
  });

  it("生产 verify-ceremony 拒绝 NOT-FOR-PRODUCTION 根", () => {
    initTestRoot(tmp);
    const logs = captureLogs();
    const code = keyVerifyCeremony(tmp, { production: true });
    logs.restore();
    expect(code).toBe(1);
  });

  it("轮换后旧密钥进入 revoked 且需重签", () => {
    initTestRoot(tmp);
    keyRotateRoot(tmp);
    const root = JSON.parse(fs.readFileSync(path.join(tmp, "root.json"), "utf8"));
    expect(root.version).toBe(2);
    expect(root.revoked.length).toBe(3);
    expect(root.signatures.length).toBe(0); // 轮换清空签名
  });

  it("撤销密钥后从角色移除", () => {
    initTestRoot(tmp);
    const root = JSON.parse(fs.readFileSync(path.join(tmp, "root.json"), "utf8"));
    const victim = root.roles.root.keyids[0];
    keyRevoke(tmp, { keyid: victim });
    const after = JSON.parse(fs.readFileSync(path.join(tmp, "root.json"), "utf8"));
    expect(after.revoked).toContain(victim);
    expect(after.roles.root.keyids).not.toContain(victim);
  });
});

describe("app-update manifest", () => {
  function makeArtifact() {
    const f = path.join(tmp, "app.bin");
    fs.writeFileSync(f, Buffer.from("app-artifact-bytes-xyz"));
    return f;
  }

  it("create 生成含全部必需字段的 manifest", () => {
    const logs = captureLogs();
    const mf = path.join(tmp, "update.json");
    appUpdateCreate(mf, {
      product: "useful-desktop", version: "1.2.0", channel: "stable",
      env: "test", artifact: makeArtifact(), minCompat: "1.0.0",
    });
    logs.restore();
    const m = JSON.parse(fs.readFileSync(mf, "utf8"));
    for (const k of ["artifactSha256", "length", "minimumCompatVersion", "publishedAt", "signingDomain", "rollback"]) {
      expect(m[k]).toBeDefined();
    }
    expect(m.channel).toBe("stable");
  });

  it("签名后同环境验证通过；生产验证拒绝测试根", () => {
    initTestRoot(tmp);
    const mf = path.join(tmp, "update.json");
    const logs = captureLogs();
    appUpdateCreate(mf, { product: "p", version: "1.0.0", channel: "stable", env: "test", artifact: makeArtifact() });
    appUpdateSign(mf, { root: tmp, key: keyPath(tmp, "release") });
    const okCode = appUpdateVerify(mf, { root: tmp });
    const prodCode = appUpdateVerify(mf, { root: tmp, production: true });
    logs.restore();
    expect(okCode).toBe(0);
    expect(prodCode).toBe(1); // 生产拒绝测试根
  });

  it("篡改 artifact 摘要后验证失败", () => {
    initTestRoot(tmp);
    const mf = path.join(tmp, "update.json");
    const logs = captureLogs();
    appUpdateCreate(mf, { product: "p", version: "1.0.0", channel: "stable", env: "test", artifact: makeArtifact() });
    appUpdateSign(mf, { root: tmp, key: keyPath(tmp, "release") });
    // 篡改签名覆盖内容
    const m = JSON.parse(fs.readFileSync(mf, "utf8"));
    m.artifactSha256 = "0".repeat(64);
    fs.writeFileSync(mf, JSON.stringify(m));
    const code = appUpdateVerify(mf, { root: tmp });
    logs.restore();
    expect(code).toBe(1);
  });

  it("使用已撤销的 release 密钥签名的更新被拒绝", () => {
    initTestRoot(tmp);
    const mf = path.join(tmp, "update.json");
    const logs = captureLogs();
    appUpdateCreate(mf, { product: "p", version: "1.0.0", channel: "stable", env: "test", artifact: makeArtifact() });
    appUpdateSign(mf, { root: tmp, key: keyPath(tmp, "release") });
    // 撤销 release 密钥
    const root = JSON.parse(fs.readFileSync(path.join(tmp, "root.json"), "utf8"));
    const releaseId = root.roles.release.keyids[0];
    keyRevoke(tmp, { keyid: releaseId });
    const code = appUpdateVerify(mf, { root: tmp });
    logs.restore();
    expect(code).toBe(1);
  });
});
