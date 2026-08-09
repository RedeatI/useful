// OpenAPI 3.1 契约的结构性校验（node:test + yaml 解析）。
// 校验：可解析、openapi 版本为 3.1.x、§16 全部端点存在、每个操作有 responses、
// 存在 problem+json 错误结构、且不存在任何客户端更新端点（普通源不能更新客户端）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const openapiPath = join(here, "..", "openapi", "repository-v1.yaml");

function loadSpec() {
  return parse(readFileSync(openapiPath, "utf8"));
}

const REQUIRED_PATHS = [
  "/.well-known/useful-repository.json",
  "/v1/source",
  "/v1/catalog/snapshot",
  "/v1/catalog/search",
  "/v1/tools/{publisherId}/{toolId}",
  "/v1/tools/{publisherId}/{toolId}/versions",
  "/v1/me",
  "/v1/me/entitlements",
  "/v1/download-grants",
  "/v1/download-grants/{grantId}",
  "/v1/publisher/upload-sessions",
  "/v1/publisher/releases",
  "/v1/publisher/releases/{releaseId}",
  "/v1/billing/checkout-sessions",
  "/v1/billing/customer-portal",
  "/v1/billing/webhooks/{provider}",
  "/v1/health",
  "/v1/ready",
];

test("OpenAPI 可解析且为 3.1.x", () => {
  const spec = loadSpec();
  assert.match(spec.openapi, /^3\.1\.\d+$/);
  assert.ok(spec.info?.title);
  assert.ok(spec.paths && typeof spec.paths === "object");
});

test("§16 全部端点存在", () => {
  const spec = loadSpec();
  for (const p of REQUIRED_PATHS) {
    assert.ok(spec.paths[p], `缺少端点: ${p}`);
  }
});

test("每个操作都有 responses 与 operationId", () => {
  const spec = loadSpec();
  const methods = ["get", "post", "put", "patch", "delete"];
  for (const [p, item] of Object.entries(spec.paths)) {
    for (const m of methods) {
      if (item[m]) {
        assert.ok(item[m].responses, `${m.toUpperCase()} ${p} 缺少 responses`);
        assert.ok(item[m].operationId, `${m.toUpperCase()} ${p} 缺少 operationId`);
      }
    }
  }
});

test("存在 problem+json 错误结构与 OAuth PKCE 安全方案", () => {
  const spec = loadSpec();
  assert.ok(spec.components?.schemas?.Problem, "缺少 Problem schema");
  const oauth = spec.components?.securitySchemes?.oauth2;
  assert.equal(oauth?.type, "oauth2");
  assert.ok(oauth?.flows?.authorizationCode, "必须使用 authorization code flow");
  assert.ok(!oauth?.flows?.implicit, "禁止 implicit flow");
  assert.ok(!oauth?.flows?.password, "禁止 password flow");
});

test("不存在任何客户端更新端点（普通工具源不能更新客户端）", () => {
  const spec = loadSpec();
  for (const p of Object.keys(spec.paths)) {
    assert.ok(
      !/app-?update|client-?update|bootstrap/i.test(p),
      `工具源 API 不得暴露客户端更新端点: ${p}`,
    );
  }
  // discovery capabilities 结构性禁止客户端更新能力
  const caps = spec.components.schemas.RepositoryDiscovery.properties.capabilities;
  assert.equal(caps.additionalProperties, false);
  for (const k of Object.keys(caps.properties)) {
    assert.ok(!/appUpdate|clientUpdate/i.test(k), `capabilities 不得含 ${k}`);
  }
});
