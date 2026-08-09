// TRP v1 协议一致性测试（node:test）。
// 覆盖：全部 schema 可编译；每个有效向量通过；恶意/非法输入被拒绝；
// 并以断言编码 Phase 6A 的关键验收：普通工具源不能更新客户端、源不能自报官方、
// HTTPS 不能降级、包内不得含商业信息、路径穿越被拒。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAjv, getValidator, loadSchemaFiles } from "../src/schemas.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const vectorsDir = join(here, "..", "test-vectors");

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

test("所有 schema 均可被 ajv 2020 编译", () => {
  const ajv = buildAjv();
  for (const { file, schema } of loadSchemaFiles()) {
    assert.ok(ajv.getSchema(schema.$id), `schema 未注册: ${file}`);
  }
});

test("全部有效测试向量通过对应 schema", () => {
  const ajv = buildAjv();
  const index = readJson(join(vectorsDir, "index.json"));
  for (const { file, schema } of index.valid) {
    const validate = getValidator(ajv, schema);
    const data = readJson(join(vectorsDir, "valid", file));
    const ok = validate(data);
    assert.ok(ok, `期望通过但失败: ${file}\n${JSON.stringify(validate.errors, null, 2)}`);
  }
});

// ---- 非法输入必须被拒绝（内联，逐条声明理由与目标 schema）----
const invalidCases = [
  {
    name: "discovery 不能声明客户端更新能力（appUpdate）",
    schema: "repository-discovery.schema.json",
    mutate: (d) => {
      d.capabilities.appUpdate = true;
      return d;
    },
  },
  {
    name: "discovery 不能自报 official 字段",
    schema: "repository-discovery.schema.json",
    mutate: (d) => {
      d.official = true;
      return d;
    },
  },
  {
    name: "discovery rootUrl 不能是 HTTP（禁止降级）",
    schema: "repository-discovery.schema.json",
    mutate: (d) => {
      d.repository.rootUrl = "http://source.example/metadata/1.root.json";
      return d;
    },
  },
  {
    name: "SourceDefinition.kind 不能为 app-update（工具源不能更新客户端）",
    schema: "source-definition.schema.json",
    base: "source-definition.json",
    mutate: (d) => {
      d.kind = "app-update";
      return d;
    },
  },
  {
    name: "SourceDefinition.capabilities 不能出现 appUpdate 键",
    schema: "source-definition.schema.json",
    base: "source-definition.json",
    mutate: (d) => {
      d.capabilities.appUpdate = true;
      return d;
    },
  },
  {
    name: "package manifest 不能包含商业信息（price）",
    schema: "package-manifest.schema.json",
    base: "package-manifest.json",
    mutate: (d) => {
      d.price = 9.99;
      return d;
    },
  },
  {
    name: "package manifest entry.path 不能路径穿越",
    schema: "package-manifest.schema.json",
    base: "package-manifest.json",
    mutate: (d) => {
      d.entry.path = "../../evil.html";
      return d;
    },
  },
  {
    name: "package manifest 文件路径不能为绝对路径",
    schema: "package-manifest.schema.json",
    base: "package-manifest.json",
    mutate: (d) => {
      d.files[0].path = "C:/windows/system32/evil.dll";
      return d;
    },
  },
  {
    name: "toolIdentity 不能只有 toolId（必须含 publisherKeyId）",
    schema: "catalog-entry.schema.json",
    base: "catalog-entry.free.json",
    mutate: (d) => {
      delete d.identity.publisherKeyId;
      return d;
    },
  },
  {
    name: "entitlement.status 不能是未知值",
    schema: "entitlement.schema.json",
    base: "entitlement.json",
    mutate: (d) => {
      d.status = "super-active";
      return d;
    },
  },
  {
    name: "download-grant.artifactSha256 必须是 64 位十六进制",
    schema: "download-grant.schema.json",
    base: "download-grant.json",
    mutate: (d) => {
      d.artifactSha256 = "not-a-hash";
      return d;
    },
  },
  {
    name: "app-update-source.kind 只能是 app-update（不能混入 tool）",
    schema: "app-update-source.schema.json",
    base: "app-update-source.json",
    mutate: (d) => {
      d.kind = "tool";
      return d;
    },
  },
];

const baseForSchema = {
  "repository-discovery.schema.json": "repository-discovery.official.json",
};

for (const c of invalidCases) {
  test(`拒绝非法输入：${c.name}`, () => {
    const ajv = buildAjv();
    const validate = getValidator(ajv, c.schema);
    const baseFile = c.base ?? baseForSchema[c.schema];
    const data = c.mutate(readJson(join(vectorsDir, "valid", baseFile)));
    const ok = validate(data);
    assert.equal(ok, false, `期望被拒绝但通过了：${c.name}`);
  });
}

test("官方身份不可由 discovery 自报：schema 中不存在任何 official/trusted 字段", () => {
  const { schema } = loadSchemaFiles().find(
    (s) => s.file === "repository-discovery.schema.json",
  );
  const props = Object.keys(schema.properties);
  assert.ok(!props.includes("official"), "discovery 顶层不得有 official 字段");
  const capProps = Object.keys(schema.properties.capabilities.properties);
  for (const forbidden of ["appUpdate", "clientUpdate", "official"]) {
    assert.ok(!capProps.includes(forbidden), `capabilities 不得含 ${forbidden}`);
  }
  assert.equal(
    schema.properties.capabilities.additionalProperties,
    false,
    "capabilities 必须 additionalProperties=false 以结构性禁止客户端更新能力",
  );
});

test("SourceDefinition.kind 枚举不含 app-update（普通源无法更新客户端）", () => {
  const { schema } = loadSchemaFiles().find(
    (s) => s.file === "source-definition.schema.json",
  );
  const kinds = schema.properties.kind.enum;
  assert.deepEqual(kinds, ["tool", "mirror"]);
  assert.ok(!kinds.includes("app-update"));
});
