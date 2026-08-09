// useful source 静态源生成器测试：init → add-package → publish → validate 全流程、
// metadata 篡改拒绝、回滚拒绝、过期拒绝、root 轮换、export-static 不泄露私钥。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import {
  cmdAddPackage,
  cmdExportStatic,
  cmdInit,
  cmdPublish,
  cmdRemovePackage,
  cmdRotateRoot,
  cmdValidate,
} from "./source.mjs";
import { verifyRepository } from "./tuf.mjs";
import { canonicalJson } from "./cjson.mjs";
import {
  generateKey,
  keyFromPrivatePem,
  signCanonical,
  verifyCanonical,
  sha256Hex,
} from "./keys.mjs";

let tmp;
let srcDir;

function makeUsefulArtifact(id, version, platforms = ["windows-x64"]) {
  const zip = new AdmZip();
  zip.addFile(
    "manifest.json",
    Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        id,
        name: `Tool ${id}`,
        version,
        description: "测试工具",
        entry: { type: "web", path: "index.html" },
        permissions: [],
        platforms,
        minHostVersion: "0.1.0",
      }),
    ),
  );
  zip.addFile("index.html", Buffer.from("<!doctype html><title>t</title>"));
  const p = path.join(tmp, `${id}-${version}.useful`);
  zip.writeZip(p);
  return p;
}

function rewriteAndResign(role, fileName, mutate) {
  const metadataPath = path.join(srcDir, "metadata", fileName);
  const doc = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  mutate(doc.signed);
  const key = keyFromPrivatePem(
    fs.readFileSync(path.join(srcDir, "keys", `${role}.pem`), "utf8"),
  );
  doc.signatures = [{ keyid: key.keyid, sig: signCanonical(key.privatePem, doc.signed) }];
  const bytes = Buffer.from(`${JSON.stringify(doc)}\n`);
  fs.writeFileSync(metadataPath, bytes);
  return bytes;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "useful-source-"));
  srcDir = path.join(tmp, "外部 开发者-source");
  cmdInit(srcDir, { id: "com.test.source", name: "测试源", operator: "Tester" });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("init", () => {
  it("生成配置、密钥、1.root.json 与 README（keys 被 gitignore）", () => {
    expect(fs.existsSync(path.join(srcDir, "source-config.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(srcDir, "metadata", "1.root.json"))).toBe(true);
    expect(fs.existsSync(path.join(srcDir, "keys", "root.pem"))).toBe(true);
    expect(fs.readFileSync(path.join(srcDir, "keys", ".gitignore"), "utf8")).toContain("*.pem");
    const readme = fs.readFileSync(path.join(srcDir, "README.md"), "utf8");
    for (const section of ["本地预览", "静态托管", "根密钥备份", "密钥轮换", "不要公开私钥"]) {
      expect(readme).toContain(section);
    }
  });

  it("uses Useful in the default source name and generated README", () => {
    const defaultDir = path.join(tmp, "default-source");
    cmdInit(defaultDir, { id: "com.test.default-source" });
    expect(fs.readFileSync(path.join(defaultDir, "source-config.yaml"), "utf8")).toContain("name: My Useful Source");
    const readme = fs.readFileSync(path.join(defaultDir, "README.md"), "utf8");
    expect(readme).toContain("Useful 软件源");
    expect(readme).toContain("Useful 客户端");
  });
});

describe("publish + TUF 验证链", () => {
  it("add-package → publish → verifyRepository 通过", () => {
    cmdAddPackage(srcDir, makeUsefulArtifact("com.test.hello", "1.0.0"), {});
    cmdPublish(srcDir);
    const { rootSigned, targetFiles } = verifyRepository(srcDir);
    expect(rootSigned.version).toBe(1);
    expect(targetFiles.length).toBe(1);
    expect(targetFiles[0].custom.toolId).toBe("com.test.hello");
    expect(targetFiles[0].custom).toMatchObject({
      publisherSignatureVerified: true,
      publisherSignatureMethod: "ed25519",
      publisherSignaturePayloadVersion: "useful-artifact-v1",
      platform: "windows",
      arch: "x86_64",
      artifactSha256: targetFiles[0].sha256,
    });
    expect(targetFiles[0].custom.publisherSignature).toMatch(/^[a-f0-9]{128}$/);
    expect(Object.keys(targetFiles[0].custom).sort()).toEqual([
      "arch",
      "artifactSha256",
      "channel",
      "platform",
      "publisherKeyId",
      "publisherSignature",
      "publisherSignatureMethod",
      "publisherSignaturePayloadVersion",
      "publisherSignatureVerified",
      "signatureIdentity",
      "toolId",
      "version",
    ]);
    expect(targetFiles[0].custom.signatureIdentity).toBe(
      targetFiles[0].custom.publisherKeyId,
    );
    // catalog 与 discovery 生成
    const cat = JSON.parse(fs.readFileSync(path.join(srcDir, "catalog", "snapshot.json"), "utf8"));
    expect(cat.sourceId).toBe("com.test.source");
    expect(cat.entries[0].offer.accessMode).toBe("free");
    const disc = JSON.parse(
      fs.readFileSync(path.join(srcDir, ".well-known", "useful-repository.json"), "utf8"),
    );
    expect(disc.repository.rootSha256).toBe(
      sha256Hex(fs.readFileSync(path.join(srcDir, "metadata", "1.root.json"))),
    );
  });

  it("同一包的双平台生成两个精确绑定 target，且完整 validate 通过", async () => {
    cmdAddPackage(
      srcDir,
      makeUsefulArtifact("com.test.multi", "1.0.0", ["windows-x64", "windows-arm64"]),
      {},
    );
    cmdPublish(srcDir);
    const { targetFiles } = verifyRepository(srcDir);
    expect(targetFiles).toHaveLength(2);
    expect(new Set(targetFiles.map((target) => target.name)).size).toBe(2);
    expect(new Set(targetFiles.map((target) => target.custom.arch))).toEqual(
      new Set(["x86_64", "aarch64"]),
    );
    await expect(cmdValidate(srcDir)).resolves.toBeUndefined();
  });

  it("publisher.pem 与配置身份不一致时 publish fail closed", () => {
    cmdAddPackage(srcDir, makeUsefulArtifact("com.test.hello", "1.0.0"), {});
    const other = generateKey();
    fs.writeFileSync(path.join(srcDir, "keys", "publisher.pem"), other.privatePem);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("EXPECTED_EXIT");
    });
    expect(() => cmdPublish(srcDir)).toThrow("EXPECTED_EXIT");
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("publisherKeyId 不匹配"));
    exit.mockRestore();
    logged.mockRestore();
  });

  it("重复 publish 版本单调递增（防回滚基础）", () => {
    cmdAddPackage(srcDir, makeUsefulArtifact("com.test.hello", "1.0.0"), {});
    cmdPublish(srcDir);
    cmdAddPackage(srcDir, makeUsefulArtifact("com.test.hello", "1.1.0"), {});
    cmdPublish(srcDir);
    const { targetsSigned } = verifyRepository(srcDir);
    expect(targetsSigned.version).toBe(2);
    expect(Object.keys(targetsSigned.targets).length).toBe(2);
  });

  it("publish 失败仍保留原子版本 reservation，后续发布不复用该版本", () => {
    const artifact = makeUsefulArtifact("com.test.gap", "1.0.0");
    cmdAddPackage(srcDir, artifact, {});
    const statePath = path.join(srcDir, "source-state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    fs.appendFileSync(
      path.join(srcDir, "repository", "packages", state.packages[0].fileName),
      "tampered",
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("EXPECTED_EXIT");
    });
    expect(() => cmdPublish(srcDir)).toThrow("EXPECTED_EXIT");
    expect(JSON.parse(fs.readFileSync(statePath, "utf8")).tufVersion).toEqual({
      targets: 1,
      snapshot: 1,
      timestamp: 1,
    });
    expect(fs.existsSync(path.join(srcDir, ".useful-source-publish.lock"))).toBe(false);
    exit.mockRestore();
    logged.mockRestore();

    cmdAddPackage(srcDir, artifact, {});
    cmdPublish(srcDir);
    const { targetsSigned } = verifyRepository(srcDir);
    expect(targetsSigned.version).toBe(2);
  });

  it("remove-package 后 publish 移除目标", () => {
    cmdAddPackage(srcDir, makeUsefulArtifact("com.test.hello", "1.0.0"), {});
    cmdAddPackage(srcDir, makeUsefulArtifact("com.test.bye", "1.0.0"), {});
    cmdPublish(srcDir);
    cmdRemovePackage(srcDir, "com.test.bye");
    cmdPublish(srcDir);
    const { targetsSigned } = verifyRepository(srcDir);
    expect(Object.keys(targetsSigned.targets)).toEqual([
      "com.test.hello-1.0.0-stable-windows-x86_64.useful",
    ]);
  });
});

describe("篡改拒绝（fail closed）", () => {
  beforeEach(() => {
    cmdAddPackage(srcDir, makeUsefulArtifact("com.test.hello", "1.0.0"), {});
    cmdPublish(srcDir);
  });

  it("target 内容被篡改 → 拒绝", () => {
    const targets = fs.readdirSync(path.join(srcDir, "targets"));
    fs.appendFileSync(path.join(srcDir, "targets", targets[0]), "MALICIOUS");
    expect(() => verifyRepository(srcDir)).toThrow(/length 不符|sha256 不符/);
  });

  it("targets metadata 被篡改（未重签）→ 拒绝", () => {
    const p = path.join(srcDir, "metadata", "1.targets.json");
    const doc = JSON.parse(fs.readFileSync(p, "utf8"));
    const name = Object.keys(doc.signed.targets)[0];
    doc.signed.targets[name].hashes.sha256 = "ff".repeat(32);
    fs.writeFileSync(p, JSON.stringify(doc));
    // 篡改后字节变化，会被 snapshot 的 hash/length 钉住或签名验证拦截——两者都是正确拒绝
    expect(() => verifyRepository(srcDir)).toThrow(/不符|签名不足/);
  });

  it("软件源重签伪造 publisherSignature 后完整 validate 仍拒绝", async () => {
    const targetsBytes = rewriteAndResign("targets", "1.targets.json", (signed) => {
      const name = Object.keys(signed.targets)[0];
      signed.targets[name].custom.publisherSignature = "00".repeat(64);
    });
    const snapshotBytes = rewriteAndResign("snapshot", "1.snapshot.json", (signed) => {
      signed.meta["targets.json"].length = targetsBytes.length;
      signed.meta["targets.json"].hashes.sha256 = sha256Hex(targetsBytes);
    });
    rewriteAndResign("timestamp", "timestamp.json", (signed) => {
      signed.meta["snapshot.json"].length = snapshotBytes.length;
      signed.meta["snapshot.json"].hashes.sha256 = sha256Hex(snapshotBytes);
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("EXPECTED_EXIT");
    });
    await expect(cmdValidate(srcDir)).rejects.toThrow("EXPECTED_EXIT");
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("发布者证明无效"));
    exit.mockRestore();
    logged.mockRestore();
  });

  it("catalog 的 signatureMethod 与 TUF custom 不一致时拒绝", async () => {
    const catalogPath = path.join(srcDir, "catalog", "snapshot.json");
    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    catalog.entries[0].artifacts[0].signatureMethod = "sigstore";
    fs.writeFileSync(catalogPath, JSON.stringify(catalog));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("EXPECTED_EXIT");
    });
    await expect(cmdValidate(srcDir)).rejects.toThrow("EXPECTED_EXIT");
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("未被精确绑定"));
    exit.mockRestore();
    logged.mockRestore();
  });

  it("catalog artifact 匹配两个 TUF targets 时拒绝，而不是 first-row 胜出", async () => {
    const targetsBytes = rewriteAndResign("targets", "1.targets.json", (signed) => {
      const [name] = Object.keys(signed.targets);
      const duplicateName = `duplicate-${name}`;
      signed.targets[duplicateName] = structuredClone(signed.targets[name]);
      const digest = signed.targets[name].hashes.sha256;
      fs.copyFileSync(
        path.join(srcDir, "targets", `${digest}.${name}`),
        path.join(srcDir, "targets", `${digest}.${duplicateName}`),
      );
    });
    const snapshotBytes = rewriteAndResign("snapshot", "1.snapshot.json", (signed) => {
      signed.meta["targets.json"].length = targetsBytes.length;
      signed.meta["targets.json"].hashes.sha256 = sha256Hex(targetsBytes);
    });
    rewriteAndResign("timestamp", "timestamp.json", (signed) => {
      signed.meta["snapshot.json"].length = snapshotBytes.length;
      signed.meta["snapshot.json"].hashes.sha256 = sha256Hex(snapshotBytes);
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("EXPECTED_EXIT");
    });
    await expect(cmdValidate(srcDir)).rejects.toThrow("EXPECTED_EXIT");
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("未被精确绑定"));
    exit.mockRestore();
    logged.mockRestore();
  });

  it("snapshot 版本回滚 → 拒绝", () => {
    // 二次发布后，把 timestamp 指回 v1 snapshot（模拟回滚攻击但无法重签 timestamp）
    cmdAddPackage(srcDir, makeUsefulArtifact("com.test.hello", "1.1.0"), {});
    cmdPublish(srcDir);
    const tsPath = path.join(srcDir, "metadata", "timestamp.json");
    const ts = JSON.parse(fs.readFileSync(tsPath, "utf8"));
    ts.signed.meta["snapshot.json"].version = 1; // 未重签
    fs.writeFileSync(tsPath, JSON.stringify(ts));
    expect(() => verifyRepository(srcDir)).toThrow(/签名不足/);
  });

  it("metadata 过期 → 拒绝（防冻结攻击）", () => {
    const future = new Date(Date.now() + 400 * 86400_000); // 超过 timestamp 7 天有效期
    expect(() => verifyRepository(srcDir, { now: future })).toThrow(/已过期/);
  });

  it("非源密钥签名 → 拒绝", () => {
    // 攻击者用自己的密钥重签 targets
    const p = path.join(srcDir, "metadata", "1.targets.json");
    const doc = JSON.parse(fs.readFileSync(p, "utf8"));
    doc.signed.targets["evil.useful"] = {
      length: 4,
      hashes: { sha256: sha256Hex(Buffer.from("evil")) },
    };
    const attacker = generateKey();
    doc.signatures = [
      { keyid: doc.signatures[0].keyid, sig: signCanonical(attacker.privatePem, doc.signed) },
    ];
    fs.writeFileSync(p, JSON.stringify(doc));
    fs.writeFileSync(
      path.join(srcDir, "targets", `${sha256Hex(Buffer.from("evil"))}.evil.useful`),
      "evil",
    );
    // 重签后的 metadata 字节与 snapshot 声明不符（hash/length 钉住），或签名验证失败
    expect(() => verifyRepository(srcDir)).toThrow(/不符|签名不足/);
  });
});

describe("root 轮换", () => {
  it("旧+新交叉签名，验证链沿 1.root.json 信任锚接受新 root", () => {
    cmdAddPackage(srcDir, makeUsefulArtifact("com.test.hello", "1.0.0"), {});
    cmdPublish(srcDir);
    const rootV1 = fs.readFileSync(path.join(srcDir, "metadata", "1.root.json"));
    cmdRotateRoot(srcDir);
    cmdPublish(srcDir); // 轮换后 timestamp/snapshot/targets 由原角色密钥继续签
    const { rootSigned } = verifyRepository(srcDir, { trustedRootBytes: rootV1 });
    expect(rootSigned.version).toBe(2);
    // 初始根指纹（1.root.json）不变
    expect(sha256Hex(fs.readFileSync(path.join(srcDir, "metadata", "1.root.json")))).toBe(
      sha256Hex(rootV1),
    );
  });

  it("伪造的 2.root.json（无旧 root 签名）→ 拒绝", () => {
    cmdAddPackage(srcDir, makeUsefulArtifact("com.test.hello", "1.0.0"), {});
    cmdPublish(srcDir);
    // 攻击者自造 root v2
    const attacker = generateKey();
    const cur = JSON.parse(
      fs.readFileSync(path.join(srcDir, "metadata", "1.root.json"), "utf8"),
    );
    const fake = {
      signatures: [],
      signed: { ...cur.signed, version: 2, keys: cur.signed.keys, roles: cur.signed.roles },
    };
    fake.signatures = [
      { keyid: attacker.keyid, sig: signCanonical(attacker.privatePem, fake.signed) },
    ];
    fs.writeFileSync(path.join(srcDir, "metadata", "2.root.json"), JSON.stringify(fake));
    expect(() => verifyRepository(srcDir)).toThrow(/签名不足/);
  });
});

describe("export-static", () => {
  it("导出可静态托管目录且绝不包含私钥", () => {
    cmdAddPackage(srcDir, makeUsefulArtifact("com.test.hello", "1.0.0"), {});
    cmdPublish(srcDir);
    const out = path.join(tmp, "dist-source");
    cmdExportStatic(srcDir, out);
    expect(fs.existsSync(path.join(out, ".well-known", "useful-repository.json"))).toBe(true);
    expect(fs.existsSync(path.join(out, "metadata", "1.root.json"))).toBe(true);
    expect(fs.existsSync(path.join(out, "keys"))).toBe(false);
    expect(fs.existsSync(path.join(out, "repository"))).toBe(false);
    // 导出目录内不存在任何 .pem
    const all = fs.readdirSync(out, { recursive: true });
    expect(all.some((f) => String(f).endsWith(".pem"))).toBe(false);
    // 导出目录可独立通过 TUF 验证
    expect(() => verifyRepository(out)).not.toThrow();
  });

  it("导出目录无需私有 source-config 也可独立 validate", async () => {
    cmdAddPackage(srcDir, makeUsefulArtifact("com.test.hello", "1.0.0"), {});
    cmdPublish(srcDir);
    const out = path.join(tmp, "dist-source-validate");
    cmdExportStatic(srcDir, out);
    expect(fs.existsSync(path.join(out, "source-config.yaml"))).toBe(false);
    await expect(cmdValidate(out)).resolves.toBeUndefined();
  });
});

describe("canonical JSON 与签名", () => {
  it("canonical 序列化键排序稳定", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "x"] })).toBe('{"a":[true,null,"x"],"b":1}');
  });
  it("签名可被对应公钥验证、错误公钥拒绝", () => {
    const k1 = generateKey();
    const k2 = generateKey();
    const signed = { hello: "world", n: 1 };
    const sig = signCanonical(k1.privatePem, signed);
    expect(verifyCanonical(k1.publicHex, signed, sig)).toBe(true);
    expect(verifyCanonical(k2.publicHex, signed, sig)).toBe(false);
  });
});
