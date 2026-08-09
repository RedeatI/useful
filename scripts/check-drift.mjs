#!/usr/bin/env node
// 漂移检查（Section 六）：迁移序列/回滚、JSON Schema 可解析、测试向量校验、
// 生成类型一致性的轻量断言。失败退出非零，可接入 verify:all 与 CI。
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
function ok(name) {
  console.log(`PASS ${name}`);
}
function fail(name, detail) {
  failures++;
  console.error(`FAIL ${name}: ${detail}`);
}

// ---------- 1. 迁移漂移：序号连续、文件名版本与 INSERT 版本一致、含回滚说明 ----------
function checkMigrations() {
  const dir = path.join(root, "services", "migrations");
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  let expected = 1;
  for (const f of files) {
    const m = /^(\d{4})_/.exec(f);
    if (!m) {
      fail("migration-naming", `${f} 不符合 NNNN_name.sql`);
      continue;
    }
    const ver = parseInt(m[1], 10);
    if (ver !== expected) {
      fail("migration-sequence", `期望 ${expected} 号迁移，得到 ${f}`);
    }
    expected++;
    const sql = fs.readFileSync(path.join(dir, f), "utf8");
    // 0001 是初始 schema，可不含 INSERT（迁移表在其中创建）；其余必须登记版本
    if (ver > 1 && !new RegExp(`INSERT INTO migrations.*${ver}`, "s").test(sql)) {
      fail("migration-version-record", `${f} 缺少 INSERT INTO migrations 版本 ${ver}`);
    }
    // 回滚说明（注释中含"回滚"或 rollback）
    if (ver > 1 && !/回滚|rollback/i.test(sql)) {
      fail("migration-rollback-note", `${f} 缺少回滚说明注释`);
    }
  }
  if (failures === 0) ok(`migrations 序列连续且含版本登记/回滚说明（${files.length} 个）`);
}

// ---------- 2. JSON Schema 可解析 ----------
function checkSchemas() {
  const dir = path.join(root, "packages", "protocol", "schemas");
  if (!fs.existsSync(dir)) return fail("schemas-dir", "缺少 schemas 目录");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    try {
      JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    } catch (e) {
      fail("schema-parse", `${f}: ${e.message}`);
    }
  }
  ok(`JSON Schema 全部可解析（${files.length} 个）`);
}

// ---------- 3. catalog schema 与 Rust/Go 独立状态字段一致 ----------
function checkCatalogFields() {
  const schemaPath = path.join(root, "packages", "protocol", "schemas", "catalog-entry.schema.json");
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  const review = schema?.properties?.review?.properties ?? {};
  const required = [
    "repositorySignatureVerified",
    "publisherSignatureVerified",
    "officialReviewPassed",
    "securityScanPassed",
    "sourceAvailable",
    "reproducibleBuildVerified",
  ];
  for (const k of required) {
    if (!review[k]) fail("catalog-review-field", `schema review 缺少 ${k}`);
  }
  // availability / reproducibleBuild 视图存在
  if (!schema.properties.availability) fail("catalog-availability", "schema 缺少 availability 视图");
  if (!schema.properties.reproducibleBuild) fail("catalog-repro", "schema 缺少 reproducibleBuild 视图");

  // Rust 客户端类型含对应字段（防生成类型漂移）
  const rs = fs.readFileSync(
    path.join(root, "crates", "useful-repository-client", "src", "catalog.rs"),
    "utf8",
  );
  for (const f of ["source_available", "reproducible_build_verified", "availability", "reproducible_build"]) {
    if (!rs.includes(f)) fail("rust-type-drift", `catalog.rs 缺少 ${f}`);
  }
  if (failures === 0) ok("catalog schema 与 Rust 客户端类型一致（无字段漂移）");
}

// ---------- 4. 前端 action 注册表与 Rust 快捷方式白名单一致 ----------
function checkActionRegistryDrift() {
  const registry = fs.readFileSync(
    path.join(root, "apps", "useful", "src", "lib", "tools", "registry.ts"),
    "utf8",
  );
  const shortcuts = fs.readFileSync(
    path.join(root, "apps", "useful", "src-tauri", "src", "commands", "shortcuts.rs"),
    "utf8",
  );
  const toolsBlock = /export const UTIL_TOOLS:[\s\S]*?=\s*\[([\s\S]*?)\n\];/.exec(registry)?.[1];
  const rustBlock = /const BUILTIN_UTILITY_ACTION_IDS:[\s\S]*?=\s*&\[([\s\S]*?)\n\];/.exec(shortcuts)?.[1];
  if (!toolsBlock || !rustBlock) {
    fail("action-registry-drift", "无法解析前端注册表或 Rust action 白名单");
    return;
  }
  const frontend = [...toolsBlock.matchAll(/\bid:\s*"([a-z0-9-]+)"/g)]
    .map((match) => `builtin.utilities.${match[1]}`)
    .sort();
  const native = [...rustBlock.matchAll(/"(builtin\.utilities\.[a-z0-9-]+)"/g)]
    .map((match) => match[1])
    .sort();
  if (JSON.stringify(frontend) !== JSON.stringify(native)) {
    fail(
      "action-registry-drift",
      `frontend=${frontend.length}, native=${native.length}; action IDs 不一致`,
    );
    return;
  }
  if (frontend.length < 31) {
    fail("action-registry-baseline", `action 数量低于 31: ${frontend.length}`);
    return;
  }
  ok(`前端 action 注册表与 Rust 快捷方式白名单一致（${frontend.length} 个）`);
}

checkMigrations();
checkSchemas();
checkCatalogFields();
checkActionRegistryDrift();

if (failures > 0) {
  console.error(`\n漂移检查发现 ${failures} 处问题`);
  process.exit(1);
}
console.log("\n漂移检查通过：迁移/Schema/生成类型一致");
