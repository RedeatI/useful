#!/usr/bin/env node
// 文档命令冒烟（Section 十二）：执行 DEVELOPER-GUIDE 的核心 Quick Start 命令，
// 证明文档命令未失效。失败退出非零，接入 CI 的 protocol-and-cli 作业。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "packages", "useful-cli", "bin", "useful.mjs");
const tool = path.join(root, "examples", "hello-web-tool");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "useful-docsmoke-"));

let failures = 0;
function run(desc, args, opts = {}) {
  try {
    const out = execFileSync("node", [cli, ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...opts,
    });
    console.log(`PASS ${desc}`);
    return out;
  } catch (e) {
    failures++;
    console.error(`FAIL ${desc}: ${e.message?.split("\n")[0]}`);
    return "";
  }
}

// 1. validate 示例 web 工具（文档 §1）
run("validate hello-web-tool", ["validate", tool]);

// 2. pack .useful（文档 §2）
run("pack hello-web-tool", ["pack", tool, work]);
const useful = fs.readdirSync(work).find((f) => f.endsWith(".useful"));
if (!useful) {
  failures++;
  console.error("FAIL pack 未产出 .useful");
} else {
  console.log(`PASS 产出 ${useful}`);
}

// 3. 静态源 init → add-package → publish → export-static（文档 §3）
const src = path.join(work, "mysource");
run("source init", ["source", "init", src, "--name", "Doc Source", "--id", "com.doc.source"]);
if (useful) {
  run("source add-package", ["source", "add-package", src, path.join(work, useful)]);
  run("source publish", ["source", "publish", src]);
  const dist = path.join(work, "dist");
  run("source export-static", ["source", "export-static", src, dist]);
  // 断言导出目录不含私钥（安全不变量）
  if (fs.existsSync(dist)) {
    const leaked = walk(dist).filter((f) => /\.pem$|private/i.test(f));
    if (leaked.length) {
      failures++;
      console.error(`FAIL export-static 泄漏私钥: ${leaked.join(", ")}`);
    } else {
      console.log("PASS export-static 不含私钥");
    }
    // 断言含 TUF metadata 与 well-known 发现文件
    const all = walk(dist).map((f) => path.relative(dist, f).replace(/\\/g, "/"));
    for (const need of ["metadata/1.root.json", ".well-known/useful-repository.json"]) {
      if (!all.some((f) => f.endsWith(need))) {
        failures++;
        console.error(`FAIL export-static 缺少 ${need}`);
      }
    }
    if (failures === 0) console.log("PASS export-static 含 TUF metadata 与 discovery");
  }
}

// 4. 更新密钥仪式（文档 §6）
const updroot = path.join(work, "updroot");
run("key init-root (test)", ["key", "init-root", updroot, "--env", "test", "--threshold", "2", "--roots", "3"]);
run("key sign-root #1", ["key", "sign-root", updroot, "--key", path.join(updroot, "keys", "root-1.private.pem")]);
run("key sign-root #2", ["key", "sign-root", updroot, "--key", path.join(updroot, "keys", "root-2.private.pem")]);
run("key verify-ceremony", ["key", "verify-ceremony", updroot]);

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

fs.rmSync(work, { recursive: true, force: true });
if (failures > 0) {
  console.error(`\n文档命令冒烟发现 ${failures} 处失败`);
  process.exit(1);
}
console.log("\n文档命令冒烟通过：DEVELOPER-GUIDE Quick Start 命令全部可执行");
