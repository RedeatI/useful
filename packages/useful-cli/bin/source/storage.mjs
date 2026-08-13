// useful source storage — content-addressed package/object storage for static sources.
// See docs/CLOUD-PACKAGE-STORAGE.md.
//
// Backends:
//   fs  — local directory mirror (tests / air-gapped staging)
//   s3  — S3-compatible API (R2 / MinIO / AWS) via SigV4 + fetch
//
// Keys uploaded:
//   1) export-static relative paths (.well-known/, metadata/, targets/, catalog/)
//   2) sha256/{digest} content-addressed copies of each .useful target artifact
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cmdExportStatic } from "./source.mjs";

const SCHEMA = "useful.source-storage.v1";
const EXPORT_DIRS = [".well-known", "metadata", "targets", "catalog"];
const SHA256_RE = /^[a-f0-9]{64}$/;

export class StorageError extends Error {
  constructor(message, code = "storage_error") {
    super(message);
    this.name = "StorageError";
    this.code = code;
  }
}

// ---------- config ----------

export function loadStorageConfig(env = process.env) {
  const backend = String(env.USEFUL_STORAGE_BACKEND ?? "fs").trim().toLowerCase();
  if (backend === "fs" || backend === "filesystem") {
    const root = env.USEFUL_STORAGE_ROOT?.trim();
    if (!root) {
      throw new StorageError(
        "USEFUL_STORAGE_ROOT is required when USEFUL_STORAGE_BACKEND=fs",
        "config_missing",
      );
    }
    const publicBase =
      env.USEFUL_STORAGE_PUBLIC_BASE_URL?.trim()?.replace(/\/+$/, "") ??
      `file://${path.resolve(root).replace(/\\/g, "/")}`;
    return {
      backend: "fs",
      root: path.resolve(root),
      publicBaseUrl: publicBase,
      prefix: normalizePrefix(env.USEFUL_STORAGE_PREFIX),
    };
  }
  if (backend === "s3" || backend === "s3-compatible") {
    const endpoint = env.USEFUL_STORAGE_ENDPOINT?.trim();
    const bucket = env.USEFUL_STORAGE_BUCKET?.trim();
    const accessKey = env.USEFUL_STORAGE_ACCESS_KEY?.trim();
    const secretKey = env.USEFUL_STORAGE_SECRET_KEY?.trim();
    const region = env.USEFUL_STORAGE_REGION?.trim() || "auto";
    const publicBase = env.USEFUL_STORAGE_PUBLIC_BASE_URL?.trim()?.replace(/\/+$/, "");
    const missing = [];
    if (!endpoint) missing.push("USEFUL_STORAGE_ENDPOINT");
    if (!bucket) missing.push("USEFUL_STORAGE_BUCKET");
    if (!accessKey) missing.push("USEFUL_STORAGE_ACCESS_KEY");
    if (!secretKey) missing.push("USEFUL_STORAGE_SECRET_KEY");
    if (!publicBase) missing.push("USEFUL_STORAGE_PUBLIC_BASE_URL");
    if (missing.length) {
      throw new StorageError(
        `S3 storage config missing: ${missing.join(", ")}`,
        "config_missing",
      );
    }
    return {
      backend: "s3",
      endpoint: endpoint.replace(/\/+$/, ""),
      bucket,
      region,
      accessKey,
      secretKey,
      publicBaseUrl: publicBase,
      prefix: normalizePrefix(env.USEFUL_STORAGE_PREFIX),
      forcePathStyle: String(env.USEFUL_STORAGE_FORCE_PATH_STYLE ?? "1") !== "0",
    };
  }
  throw new StorageError(
    `Unknown USEFUL_STORAGE_BACKEND: ${backend} (use fs or s3)`,
    "config_invalid",
  );
}

function normalizePrefix(raw) {
  if (!raw || !String(raw).trim()) return "";
  return String(raw)
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\\/g, "/");
}

function withPrefix(prefix, key) {
  const k = key.replace(/^\/+/, "");
  return prefix ? `${prefix}/${k}` : k;
}

// ---------- drivers ----------

export function createStorageDriver(config) {
  if (config.backend === "fs") return new FsStorageDriver(config);
  if (config.backend === "s3") return new S3StorageDriver(config);
  throw new StorageError(`unsupported backend: ${config.backend}`, "config_invalid");
}

export class FsStorageDriver {
  constructor(config) {
    this.config = config;
  }

  resolve(key) {
    const full = path.resolve(this.config.root, key.split("/").join(path.sep));
    const root = this.config.root.endsWith(path.sep)
      ? this.config.root
      : this.config.root + path.sep;
    if (full !== this.config.root && !full.startsWith(root)) {
      throw new StorageError(`path escapes storage root: ${key}`, "path_escape");
    }
    return full;
  }

  async put(key, bytes, contentType = "application/octet-stream") {
    const full = this.resolve(key);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    // Idempotent: identical bytes OK; conflict if different.
    if (fs.existsSync(full)) {
      const existing = fs.readFileSync(full);
      if (existing.equals(bytes)) {
        return { key, bytes: bytes.length, contentType, status: "unchanged" };
      }
      throw new StorageError(
        `refusing to overwrite different bytes at ${key}`,
        "object_conflict",
      );
    }
    fs.writeFileSync(full, bytes);
    return { key, bytes: bytes.length, contentType, status: "written" };
  }

  async head(key) {
    const full = this.resolve(key);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      return null;
    }
    const st = fs.statSync(full);
    return { key, bytes: st.size };
  }

  async doctor() {
    fs.mkdirSync(this.config.root, { recursive: true });
    const probeKey = withPrefix(this.config.prefix, `_useful-storage-doctor/${Date.now()}.txt`);
    const payload = Buffer.from(`useful-storage-doctor ${new Date().toISOString()}\n`, "utf8");
    await this.put(probeKey, payload, "text/plain; charset=utf-8");
    const h = await this.head(probeKey);
    if (!h || h.bytes !== payload.length) {
      throw new StorageError("fs doctor head mismatch", "doctor_failed");
    }
    // clean probe
    try {
      fs.rmSync(this.resolve(probeKey), { force: true });
    } catch {
      /* ignore */
    }
    return { ok: true, backend: "fs", root: this.config.root };
  }
}

export class S3StorageDriver {
  constructor(config) {
    this.config = config;
  }

  objectUrl(key) {
    const { endpoint, bucket, forcePathStyle } = this.config;
    const encodedKey = key
      .split("/")
      .map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, escape))
      .join("/");
    if (forcePathStyle) {
      return `${endpoint}/${bucket}/${encodedKey}`;
    }
    // virtual-hosted-style: https://bucket.endpoint/key
    const u = new URL(endpoint);
    return `${u.protocol}//${bucket}.${u.host}/${encodedKey}`;
  }

  async put(key, bytes, contentType = "application/octet-stream") {
    const existing = await this.head(key);
    if (existing) {
      if (existing.bytes === bytes.length) {
        // Cheap size match — still re-put for correctness only when sizes differ.
        // For true idempotency without GET, size match is accepted as unchanged.
        return { key, bytes: bytes.length, contentType, status: "unchanged" };
      }
      throw new StorageError(
        `refusing to overwrite different size at ${key} (remote=${existing.bytes}, local=${bytes.length})`,
        "object_conflict",
      );
    }
    const res = await this.signedRequest("PUT", key, bytes, contentType);
    if (res.status < 200 || res.status >= 300) {
      const body = await res.text().catch(() => "");
      throw new StorageError(
        `S3 PutObject failed ${res.status} for ${key}: ${body.slice(0, 200)}`,
        "put_failed",
      );
    }
    return { key, bytes: bytes.length, contentType, status: "written" };
  }

  async head(key) {
    const res = await this.signedRequest("HEAD", key);
    if (res.status === 404) return null;
    if (res.status < 200 || res.status >= 300) {
      const body = await res.text().catch(() => "");
      throw new StorageError(
        `S3 HeadObject failed ${res.status} for ${key}: ${body.slice(0, 200)}`,
        "head_failed",
      );
    }
    const len = res.headers.get("content-length");
    return { key, bytes: len ? Number(len) : 0 };
  }

  async doctor() {
    const probeKey = withPrefix(
      this.config.prefix,
      `_useful-storage-doctor/${Date.now()}.txt`,
    );
    const payload = Buffer.from(`useful-storage-doctor ${new Date().toISOString()}\n`, "utf8");
    await this.put(probeKey, payload, "text/plain; charset=utf-8");
    const h = await this.head(probeKey);
    if (!h || h.bytes !== payload.length) {
      throw new StorageError("s3 doctor head mismatch", "doctor_failed");
    }
    return {
      ok: true,
      backend: "s3",
      endpoint: this.config.endpoint,
      bucket: this.config.bucket,
    };
  }

  async signedRequest(method, key, body, contentType) {
    const { accessKey, secretKey, region } = this.config;
    const url = this.objectUrl(key);
    const parsed = new URL(url);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const service = "s3";
    const payloadHash = crypto
      .createHash("sha256")
      .update(body ?? Buffer.alloc(0))
      .digest("hex");

    const headers = {
      host: parsed.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };
    if (body !== undefined && body !== null) {
      headers["content-type"] = contentType || "application/octet-stream";
      headers["content-length"] = String(body.length);
    }

    const signedHeaderNames = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaderNames
      .map((name) => `${name}:${String(headers[name]).trim().replace(/\s+/g, " ")}\n`)
      .join("");
    const signedHeaders = signedHeaderNames.join(";");
    const canonicalRequest = [
      method,
      parsed.pathname,
      "", // no query
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");

    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      crypto.createHash("sha256").update(canonicalRequest).digest("hex"),
    ].join("\n");

    const signingKey = getSignatureKey(secretKey, dateStamp, region, service);
    const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");
    const authorization =
      `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return fetch(url, {
      method,
      headers: {
        ...headers,
        authorization,
      },
      body: method === "PUT" || method === "POST" ? body : undefined,
    });
  }
}

function getSignatureKey(key, dateStamp, regionName, serviceName) {
  const kDate = crypto.createHmac("sha256", `AWS4${key}`).update(dateStamp).digest();
  const kRegion = crypto.createHmac("sha256", kDate).update(regionName).digest();
  const kService = crypto.createHmac("sha256", kRegion).update(serviceName).digest();
  return crypto.createHmac("sha256", kService).update("aws4_request").digest();
}

// ---------- plan / upload ----------

function listFilesRecursive(root) {
  const out = [];
  function walk(dir, relBase = "") {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) out.push({ rel: rel.replace(/\\/g, "/"), full });
    }
  }
  walk(root);
  return out;
}

function contentTypeFor(rel) {
  if (rel.endsWith(".json")) return "application/json; charset=utf-8";
  if (rel.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (rel.endsWith(".useful")) return "application/octet-stream";
  return "application/octet-stream";
}

/**
 * Build upload plan from a published source directory (or a prior export-static tree).
 * Always materializes export-static layout first when given a worktree with keys/.
 */
export function buildUploadPlan(sourceDir, options = {}) {
  const abs = path.resolve(sourceDir);
  const discovery = path.join(abs, ".well-known", "useful-repository.json");
  const isExportedTree = fs.existsSync(discovery) && !fs.existsSync(path.join(abs, "keys"));

  let exportRoot = options.exportDir ? path.resolve(options.exportDir) : null;
  let tempExport = null;

  if (exportRoot) {
    // caller-provided export
  } else if (isExportedTree) {
    exportRoot = abs;
  } else {
    // full source worktree — export to temp
    if (!fs.existsSync(path.join(abs, "source-config.yaml"))) {
      throw new StorageError(
        `not a source directory or static export: ${abs}`,
        "invalid_source",
      );
    }
    if (!fs.existsSync(discovery)) {
      throw new StorageError("source not published (run useful source publish first)", "not_published");
    }
    tempExport = fs.mkdtempSync(path.join(os.tmpdir(), "useful-storage-export-"));
    cmdExportStatic(abs, tempExport);
    exportRoot = tempExport;
  }

  if (!fs.existsSync(path.join(exportRoot, ".well-known", "useful-repository.json"))) {
    if (tempExport) fs.rmSync(tempExport, { recursive: true, force: true });
    throw new StorageError("export missing .well-known/useful-repository.json", "invalid_export");
  }

  const objects = [];
  const seenKeys = new Set();

  function addObject(key, full, kind, digest = null) {
    if (seenKeys.has(key)) return;
    const bytes = fs.readFileSync(full);
    const sha = crypto.createHash("sha256").update(bytes).digest("hex");
    objects.push({
      key,
      localPath: full,
      bytes: bytes.length,
      sha256: sha,
      contentType: contentTypeFor(key),
      kind,
      digest,
    });
    seenKeys.add(key);
  }

  for (const top of EXPORT_DIRS) {
    const dir = path.join(exportRoot, top);
    if (!fs.existsSync(dir)) continue;
    for (const file of listFilesRecursive(dir)) {
      const rel = `${top}/${file.rel}`;
      addObject(rel, file.full, "static-export");
      // targets/<sha256>.<name> → also sha256/<sha256>
      if (top === "targets") {
        const base = path.basename(file.rel);
        const m = base.match(/^([a-f0-9]{64})\./);
        if (m && SHA256_RE.test(m[1])) {
          const digest = m[1];
          const body = fs.readFileSync(file.full);
          const actual = crypto.createHash("sha256").update(body).digest("hex");
          if (actual !== digest) {
            if (tempExport) fs.rmSync(tempExport, { recursive: true, force: true });
            throw new StorageError(
              `target filename digest mismatch: ${base}`,
              "digest_mismatch",
            );
          }
          addObject(`sha256/${digest}`, file.full, "content-addressed", digest);
        }
      }
    }
  }

  // Never include keys or repository worktree paths (export-static already excludes them;
  // belt-and-suspenders for exported tree callers).
  for (const obj of objects) {
    if (obj.key.startsWith("keys/") || obj.key.includes("/keys/")) {
      if (tempExport) fs.rmSync(tempExport, { recursive: true, force: true });
      throw new StorageError("refusing to upload keys/", "keys_leak");
    }
  }

  return {
    sourceDir: abs,
    exportRoot,
    tempExport,
    objects,
    cleanup() {
      if (tempExport && fs.existsSync(tempExport)) {
        fs.rmSync(tempExport, { recursive: true, force: true });
      }
    },
  };
}

export async function doctorStorage(env = process.env) {
  const config = loadStorageConfig(env);
  const driver = createStorageDriver(config);
  const result = await driver.doctor();
  return {
    schemaVersion: SCHEMA,
    ok: true,
    config: publicConfigView(config),
    doctor: result,
  };
}

export async function dryRunStorage(sourceDir, options = {}, env = process.env) {
  const config = loadStorageConfig(env);
  const plan = buildUploadPlan(sourceDir, options);
  try {
    const objects = plan.objects.map((o) => ({
      key: withPrefix(config.prefix, o.key),
      bytes: o.bytes,
      sha256: o.sha256,
      kind: o.kind,
      contentType: o.contentType,
      digest: o.digest,
    }));
    return {
      schemaVersion: SCHEMA,
      ok: true,
      mode: "dry-run",
      config: publicConfigView(config),
      objectCount: objects.length,
      totalBytes: objects.reduce((n, o) => n + o.bytes, 0),
      objects,
    };
  } finally {
    plan.cleanup();
  }
}

export async function pushStorage(sourceDir, options = {}, env = process.env) {
  const config = loadStorageConfig(env);
  const driver = createStorageDriver(config);
  const plan = buildUploadPlan(sourceDir, options);
  const results = [];
  try {
    for (const obj of plan.objects) {
      const key = withPrefix(config.prefix, obj.key);
      const bytes = fs.readFileSync(obj.localPath);
      const put = await driver.put(key, bytes, obj.contentType);
      results.push({
        key,
        bytes: obj.bytes,
        sha256: obj.sha256,
        kind: obj.kind,
        status: put.status,
        digest: obj.digest,
      });
    }
    return {
      schemaVersion: SCHEMA,
      ok: true,
      mode: "push",
      config: publicConfigView(config),
      objectCount: results.length,
      written: results.filter((r) => r.status === "written").length,
      unchanged: results.filter((r) => r.status === "unchanged").length,
      totalBytes: results.reduce((n, r) => n + r.bytes, 0),
      objects: results,
    };
  } finally {
    plan.cleanup();
  }
}

export async function verifyStorage(sourceDir, options = {}, env = process.env) {
  const config = loadStorageConfig(env);
  const driver = createStorageDriver(config);
  const plan = buildUploadPlan(sourceDir, options);
  const checks = [];
  let failed = 0;
  try {
    for (const obj of plan.objects) {
      const key = withPrefix(config.prefix, obj.key);
      const head = await driver.head(key);
      if (!head) {
        checks.push({
          key,
          ok: false,
          code: "object_missing",
          localBytes: obj.bytes,
        });
        failed += 1;
        continue;
      }
      if (head.bytes !== obj.bytes) {
        checks.push({
          key,
          ok: false,
          code: "size_mismatch",
          localBytes: obj.bytes,
          remoteBytes: head.bytes,
        });
        failed += 1;
        continue;
      }
      checks.push({
        key,
        ok: true,
        code: "ok",
        localBytes: obj.bytes,
        remoteBytes: head.bytes,
        kind: obj.kind,
      });
    }
    return {
      schemaVersion: SCHEMA,
      ok: failed === 0,
      mode: "verify",
      config: publicConfigView(config),
      objectCount: checks.length,
      failed,
      checks,
    };
  } finally {
    plan.cleanup();
  }
}

function publicConfigView(config) {
  if (config.backend === "fs") {
    return {
      backend: "fs",
      root: config.root,
      publicBaseUrl: config.publicBaseUrl,
      prefix: config.prefix || null,
    };
  }
  return {
    backend: "s3",
    endpoint: config.endpoint,
    bucket: config.bucket,
    region: config.region,
    publicBaseUrl: config.publicBaseUrl,
    prefix: config.prefix || null,
    forcePathStyle: config.forcePathStyle,
  };
}

export function printHuman(result) {
  if (result.mode === "dry-run" || result.mode === "push") {
    console.log(
      `✓ storage ${result.mode}: ${result.objectCount} objects, ${result.totalBytes} bytes` +
        (result.mode === "push"
          ? ` (written=${result.written}, unchanged=${result.unchanged})`
          : ""),
    );
    console.log(`  backend: ${result.config.backend}`);
    if (result.config.publicBaseUrl) console.log(`  public: ${result.config.publicBaseUrl}`);
    for (const o of result.objects.slice(0, 20)) {
      const st = o.status ? ` [${o.status}]` : "";
      console.log(`  - ${o.key} (${o.bytes} B, ${o.kind})${st}`);
    }
    if (result.objects.length > 20) {
      console.log(`  … ${result.objects.length - 20} more`);
    }
    return;
  }
  if (result.mode === "verify") {
    console.log(
      result.ok
        ? `✓ storage verify: ${result.objectCount} objects match`
        : `✗ storage verify: ${result.failed}/${result.objectCount} failed`,
    );
    for (const c of result.checks.filter((x) => !x.ok)) {
      console.log(`  - ${c.key}: ${c.code}`);
    }
    return;
  }
  // doctor
  console.log(`✓ storage doctor ok (${result.config.backend})`);
  if (result.config.root) console.log(`  root: ${result.config.root}`);
  if (result.config.bucket) console.log(`  bucket: ${result.config.bucket}`);
  if (result.config.publicBaseUrl) console.log(`  public: ${result.config.publicBaseUrl}`);
}
