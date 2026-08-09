// TRP v1 校验 CLI：校验单个 JSON 文档，或校验一个静态源目录。
// 用法：
//   node src/validate-cli.mjs <schema-file> <json-file>
//   node src/validate-cli.mjs --source <static-source-dir>
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildAjv, getValidator } from "./schemas.mjs";

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function validateFile(ajv, schemaFile, jsonFile) {
  const validate = getValidator(ajv, schemaFile);
  const data = JSON.parse(readFileSync(jsonFile, "utf8"));
  if (!validate(data)) {
    console.error(JSON.stringify(validate.errors, null, 2));
    fail(`${jsonFile} 不符合 ${schemaFile}`);
  }
  console.log(`✓ ${jsonFile} 符合 ${schemaFile}`);
}

// 校验一个导出的静态源目录：discovery + catalog snapshot。
function validateSource(ajv, dir) {
  const discovery = join(dir, ".well-known", "useful-repository.json");
  if (!existsSync(discovery)) fail(`缺少 ${discovery}`);
  const dValidate = getValidator(ajv, "repository-discovery.schema.json");
  const d = JSON.parse(readFileSync(discovery, "utf8"));
  if (!dValidate(d)) {
    console.error(JSON.stringify(dValidate.errors, null, 2));
    fail("discovery 校验失败");
  }
  console.log("✓ discovery 有效");

  const catalog = join(dir, "catalog", "snapshot.json");
  if (existsSync(catalog)) {
    const snap = JSON.parse(readFileSync(catalog, "utf8"));
    const entryValidate = getValidator(ajv, "catalog-entry.schema.json");
    const entries = Array.isArray(snap.entries) ? snap.entries : [];
    entries.forEach((entry, i) => {
      if (!entryValidate(entry)) {
        console.error(JSON.stringify(entryValidate.errors, null, 2));
        fail(`catalog entry #${i} 校验失败`);
      }
    });
    console.log(`✓ catalog 有效（${entries.length} 条）`);
  }
  console.log("✓ 静态源目录校验通过");
}

const args = process.argv.slice(2);
const ajv = buildAjv();
if (args[0] === "--source") {
  if (!args[1]) fail("用法：--source <dir>");
  validateSource(ajv, args[1]);
} else if (args.length === 2) {
  validateFile(ajv, args[0], args[1]);
} else {
  fail("用法：<schema-file> <json-file> 或 --source <dir>");
}
