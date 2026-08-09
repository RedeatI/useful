import { describe, it, expect } from "vitest";
import { USEFUL_LIMITS as SHARED_USEFUL_LIMITS } from "@useful/plugin-actions";
import { validateManifest, isKnownPermission } from "./validate.mjs";
import { USEFUL_LIMITS as CLI_USEFUL_LIMITS } from "./useful-limits.mjs";

const valid = {
  schemaVersion: 1,
  id: "com.example.tool",
  name: "示例",
  version: "1.0.0",
  icon: "assets/icon.png",
  entry: { type: "web", path: "index.html" },
  permissions: [],
  platforms: ["windows-x64"],
  minHostVersion: "0.1.0",
};

describe("CLI validateManifest", () => {
  it("re-exports the shared authoritative .useful limits", () => {
    expect(CLI_USEFUL_LIMITS).toBe(SHARED_USEFUL_LIMITS);
  });
  it("接受合法 manifest", () => {
    expect(validateManifest(valid).valid).toBe(true);
  });

  it("拒绝非法 id", () => {
    const r = validateManifest({ ...valid, id: "nodots" });
    expect(r.valid).toBe(false);
  });

  it("拒绝路径穿越 entry.path", () => {
    const r = validateManifest({ ...valid, entry: { type: "web", path: "../evil.html" } });
    expect(r.valid).toBe(false);
  });

  it("与 Rust schema 一致地拒绝未知字段和非法 contributes", () => {
    expect(validateManifest({ ...valid, unknown: true }).valid).toBe(false);
    expect(validateManifest({ ...valid, contributes: "bad" }).valid).toBe(false);
    expect(validateManifest({ ...valid, contributes: { unknown: [] } }).valid).toBe(false);
    expect(validateManifest({ ...valid, contributes: { actions: [{ actionId: "com.example.tool.2fa", path: "actions/2fa.json" }] } }).valid).toBe(true);
    expect(validateManifest({ ...valid, contributes: { actions: [{ actionId: "com.example.tool.Bad", path: "actions/bad.json" }] } }).valid).toBe(false);
  });

  it("拒绝非法版本号", () => {
    expect(validateManifest({ ...valid, version: "abc" }).valid).toBe(false);
  });

  it("拒绝未知权限", () => {
    expect(validateManifest({ ...valid, permissions: ["evil.perm"] }).valid).toBe(false);
    expect(validateManifest({ ...valid, permissions: [42] }).valid).toBe(false);
  });

  it("兼容 Rust manifest 的 optional/default 字段", () => {
    const legacy = { ...valid };
    delete legacy.icon;
    delete legacy.permissions;
    delete legacy.platforms;
    delete legacy.minHostVersion;
    expect(validateManifest(legacy)).toEqual({ valid: true, errors: [] });
  });

  it("权限判定", () => {
    expect(isKnownPermission("process.launch.declared")).toBe(true);
    expect(isKnownPermission("dialog.open")).toBe(false);
    expect(isKnownPermission("network.fetch:example.com")).toBe(false);
    expect(isKnownPermission("fs.read.any")).toBe(false);
  });

  it("首发 web 插件拒绝 native 权限", () => {
    expect(validateManifest({ ...valid, permissions: ["dialog.open"] }).valid).toBe(false);
  });

  it("launcher 必须显式声明唯一保留的启动权限", () => {
    const launcher = { ...valid, entry: { type: "launcher", path: "tool.exe" } };
    expect(validateManifest({ ...launcher, permissions: undefined }).valid).toBe(false);
    expect(validateManifest({ ...launcher, permissions: ["process.launch.declared"] }).valid).toBe(true);
  });
});
