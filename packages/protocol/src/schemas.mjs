// TRP v1 schema loader：把 schemas/ 下所有 JSON Schema 载入一个 ajv 2020 实例，
// 通过各自的 $id 解析跨文件 $ref。供测试与 CLI 校验复用。
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const schemasDir = join(here, "..", "schemas");

/** 读取并解析 schemas/ 下所有 *.schema.json。 */
export function loadSchemaFiles() {
  const files = readdirSync(schemasDir).filter((f) => f.endsWith(".schema.json"));
  return files.map((file) => ({
    file,
    schema: JSON.parse(readFileSync(join(schemasDir, file), "utf8")),
  }));
}

/** 构建并返回一个已注册全部 TRP schema 的 ajv 实例。 */
export function buildAjv() {
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    allowUnionTypes: true,
  });
  addFormats(ajv);
  for (const { schema } of loadSchemaFiles()) {
    ajv.addSchema(schema);
  }
  return ajv;
}

/** 按 schema 文件名取得编译后的校验函数。 */
export function getValidator(ajv, schemaFile) {
  const { schema } = loadSchemaFiles().find((s) => s.file === schemaFile) ?? {};
  if (!schema) throw new Error(`未找到 schema: ${schemaFile}`);
  return ajv.getSchema(schema.$id) ?? ajv.compile(schema);
}
