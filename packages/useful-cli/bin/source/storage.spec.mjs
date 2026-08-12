// useful source storage: doctor / dry-run / push / verify (fs backend)
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import {
  cmdAddPackage,
  cmdExportStatic,
  cmdInit,
  cmdPublish,
} from "./source.mjs";
import {
  StorageError,
  buildUploadPlan,
  doctorStorage,
  dryRunStorage,
  loadStorageConfig,
  pushStorage,
  verifyStorage,
} from "./storage.mjs";

let tmp;
let srcDir;
let storeRoot;

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
        description: "storage test",
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

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "useful-storage-"));
  srcDir = path.join(tmp, "source");
  storeRoot = path.join(tmp, "object-store");
  cmdInit(srcDir, { id: "com.test.storage-source", name: "Storage Test Source" });
  cmdAddPackage(srcDir, makeUsefulArtifact("com.test.storage-tool", "1.0.0"), {});
  cmdPublish(srcDir);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("loadStorageConfig", () => {
  it("requires USEFUL_STORAGE_ROOT for fs backend", () => {
    expect(() => loadStorageConfig({ USEFUL_STORAGE_BACKEND: "fs" })).toThrow(StorageError);
  });

  it("loads fs config", () => {
    const cfg = loadStorageConfig({
      USEFUL_STORAGE_BACKEND: "fs",
      USEFUL_STORAGE_ROOT: storeRoot,
      USEFUL_STORAGE_PREFIX: "mirror/v1",
    });
    expect(cfg.backend).toBe("fs");
    expect(cfg.prefix).toBe("mirror/v1");
  });
});

describe("fs storage pipeline", () => {
  function env() {
    return {
      USEFUL_STORAGE_BACKEND: "fs",
      USEFUL_STORAGE_ROOT: storeRoot,
      USEFUL_STORAGE_PUBLIC_BASE_URL: "https://packages.example.test",
    };
  }

  it("doctor writes and cleans a probe object", async () => {
    const result = await doctorStorage(env());
    expect(result.ok).toBe(true);
    expect(result.config.backend).toBe("fs");
  });

  it("dry-run lists static export + content-addressed keys", async () => {
    const result = await dryRunStorage(srcDir, {}, env());
    expect(result.ok).toBe(true);
    expect(result.objectCount).toBeGreaterThan(4);
    const keys = result.objects.map((o) => o.key);
    expect(keys.some((k) => k.startsWith(".well-known/"))).toBe(true);
    expect(keys.some((k) => k.startsWith("metadata/"))).toBe(true);
    expect(keys.some((k) => k.startsWith("targets/"))).toBe(true);
    expect(keys.some((k) => k.startsWith("catalog/"))).toBe(true);
    expect(keys.some((k) => k.startsWith("sha256/"))).toBe(true);
    expect(keys.some((k) => k.includes("keys/"))).toBe(false);
  });

  it("push then verify succeeds; second push is unchanged", async () => {
    const pushed = await pushStorage(srcDir, {}, env());
    expect(pushed.ok).toBe(true);
    expect(pushed.written).toBe(pushed.objectCount);
    expect(pushed.unchanged).toBe(0);

    const verified = await verifyStorage(srcDir, {}, env());
    expect(verified.ok).toBe(true);
    expect(verified.failed).toBe(0);

    const again = await pushStorage(srcDir, {}, env());
    expect(again.ok).toBe(true);
    expect(again.written).toBe(0);
    expect(again.unchanged).toBe(again.objectCount);
  });

  it("verify fails when remote object is missing", async () => {
    await pushStorage(srcDir, {}, env());
    // delete one content-addressed object
    const plan = buildUploadPlan(srcDir, {});
    const ca = plan.objects.find((o) => o.kind === "content-addressed");
    expect(ca).toBeTruthy();
    const remote = path.join(storeRoot, ...ca.key.split("/"));
    fs.rmSync(remote, { force: true });
    plan.cleanup();

    const verified = await verifyStorage(srcDir, {}, env());
    expect(verified.ok).toBe(false);
    expect(verified.failed).toBeGreaterThan(0);
    expect(verified.checks.some((c) => c.code === "object_missing")).toBe(true);
  });

  it("refuses overwrite of different bytes at same key", async () => {
    await pushStorage(srcDir, {}, env());
    const plan = buildUploadPlan(srcDir, {});
    const first = plan.objects.find((o) => o.kind === "static-export");
    const remote = path.join(storeRoot, ...first.key.split("/"));
    fs.writeFileSync(remote, Buffer.from("tampered-bytes"));
    plan.cleanup();

    await expect(pushStorage(srcDir, {}, env())).rejects.toMatchObject({
      code: "object_conflict",
    });
  });

  it("can push from export-static output without source keys", async () => {
    const exportDir = path.join(tmp, "dist-source");
    cmdExportStatic(srcDir, exportDir);
    expect(fs.existsSync(path.join(exportDir, "keys"))).toBe(false);

    const pushed = await pushStorage(exportDir, {}, env());
    expect(pushed.ok).toBe(true);
    expect(pushed.objectCount).toBeGreaterThan(0);

    const verified = await verifyStorage(exportDir, {}, env());
    expect(verified.ok).toBe(true);
  });

  it("supports storage prefix", async () => {
    const e = {
      ...env(),
      USEFUL_STORAGE_PREFIX: "tenant-a",
    };
    const dry = await dryRunStorage(srcDir, {}, e);
    expect(dry.objects.every((o) => o.key.startsWith("tenant-a/"))).toBe(true);
    const pushed = await pushStorage(srcDir, {}, e);
    expect(pushed.ok).toBe(true);
    expect(fs.existsSync(path.join(storeRoot, "tenant-a", ".well-known"))).toBe(true);
  });
});
