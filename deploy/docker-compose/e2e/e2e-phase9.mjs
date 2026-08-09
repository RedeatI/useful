// Phase 9 e2e (runs INSIDE compose network via node:20-alpine).
// Flow: health -> upload+sign -> release(verified) -> bad-signature rejected
// -> worker scan+auto-approve -> catalog review fields -> native worker gate
// -> withdraw -> grant 403 -> advisory -> catalog/advisories visible.
// ASCII-only output (PowerShell 5.1 GBK console safety).
import { createPrivateKey, sign, createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const BASE = process.env.BASE_URL || "http://source-server:8080";
const ADMIN = process.env.ADMIN_TOKEN || "change-me-admin-token";
// In-compose runner mounts fixtures at /e2e/out; local (no-Docker) runs can
// point E2E_OUT at deploy/docker-compose/e2e/out after running prepare.mjs.
const dir = process.env.E2E_OUT || "/e2e/out";

// RBAC: dev bootstrap (X-Admin-Token) is used ONCE to mint a real API token;
// every subsequent admin call goes through Bearer usefuls_ (production auth path).
let API_TOKEN = "";

async function bootstrapApiToken() {
  const h = { "X-Admin-Token": ADMIN, "Content-Type": "application/json" };
  const idResp = await fetch(BASE + "/v1/admin/identities", {
    method: "POST", headers: h,
    body: JSON.stringify({ id: "e2e-admin", displayName: "E2E Admin", roles: ["instance-admin"] }),
  });
  if (idResp.status !== 201 && idResp.status !== 409) {
    throw new Error(`bootstrap identity failed: ${idResp.status}`);
  }
  const tokResp = await fetch(BASE + "/v1/admin/api-tokens", {
    method: "POST", headers: h,
    body: JSON.stringify({ identityId: "e2e-admin", ttlSeconds: 3600 }),
  });
  if (tokResp.status !== 201) throw new Error(`bootstrap token failed: ${tokResp.status}`);
  API_TOKEN = (await tokResp.json()).token;
}

const key = JSON.parse(readFileSync(`${dir}/key.json`, "utf8"));
const privKey = createPrivateKey(key.privPem);
const keyId = key.keyId;
const realPlugins = JSON.parse(readFileSync(`${dir}/real-plugins.json`, "utf8"));

let failures = 0;
function ok(name, cond, extra) {
  if (cond) console.log(`PASS ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name} ${extra ?? ""}`);
  }
}

async function req(method, path, { body, admin, raw } = {}) {
  const headers = {};
  if (admin) headers["Authorization"] = `Bearer ${API_TOKEN}`;
  let payload;
  if (raw) payload = raw;
  else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const resp = await fetch(BASE + path, { method, headers, body: payload });
  let json = null;
  try {
    json = await resp.clone().json();
  } catch {
    /* non-json */
  }
  return { status: resp.status, json };
}

function sha256hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function signArtifact(toolId, version, sha) {
  const payload = Buffer.from(`useful-artifact-v1\n${toolId}\n${version}\n${sha}`);
  return sign(null, payload, privKey).toString("hex");
}

async function waitHealth() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + "/v1/health");
      if (r.ok) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function uploadAndRelease(usefulPath, toolId, version, extra = {}) {
  const useful = readFileSync(usefulPath);
  const sha = sha256hex(useful);
  const created = await req("POST", "/v1/publisher/upload-sessions", {
    admin: true,
    body: { publisherKeyId: keyId, sha256: sha, size: useful.length },
  });
  if (created.status !== 201) throw new Error(`upload session ${created.status}`);
  const up = await fetch(BASE + created.json.uploadUrl, {
    method: "PUT",
    headers: { "X-Admin-Token": ADMIN },
    body: useful,
  });
  if (up.status !== 200) throw new Error(`upload content ${up.status}`);
  const rel = await req("POST", "/v1/publisher/releases", {
    admin: true,
    body: {
      uploadSessionId: created.json.uploadSessionId,
      toolId,
      name: extra.name || "E2E Tool",
      summary: "phase9 e2e",
      license: "Apache-2.0",
      version,
      channel: "stable",
      platform: "windows",
      arch: "x86_64",
      accessMode: "free",
      permissions: [],
      ...extra,
    },
  });
  return { rel, sha };
}

async function waitStatus(artifactId, want, timeoutSec = 60) {
  for (let i = 0; i < timeoutSec; i++) {
    const r = await req("GET", `/v1/publisher/releases/${artifactId}`, { admin: true });
    if (r.json && r.json.status === want) return r.json;
    await new Promise((r2) => setTimeout(r2, 1000));
  }
  return null;
}

async function waitCatalogLatest(toolId, version, timeoutSec = 30) {
  for (let i = 0; i < timeoutSec; i++) {
    const catalog = await req("GET", "/v1/catalog/snapshot");
    const entry = catalog.json?.entries?.find((item) => item.identity.toolId === toolId);
    if (entry?.latest?.stable === version) return entry;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return null;
}

const healthy = await waitHealth();
ok("server healthy", healthy);
if (!healthy) process.exit(1);

await bootstrapApiToken();
ok("rbac api token minted", API_TOKEN.startsWith("usefuls_"));

// register publisher key (admin RBAC path) before any upload session
{
  const reg = await req("POST", "/v1/admin/publishers", {
    admin: true,
    body: { id: "pub-e2e", displayName: "E2E Publisher", keyId },
  });
  ok("publisher registered (201)", reg.status === 201, `got ${reg.status}`);
  // negative: unregistered publisher key must be rejected on upload session
  const bad = await req("POST", "/v1/publisher/upload-sessions", {
    admin: true,
    body: { publisherKeyId: "ed25519:" + "11".repeat(32), sha256: "22".repeat(32), size: 10 },
  });
  ok("unregistered publisher rejected (403)", bad.status === 403, `got ${bad.status}`);
}

// observability: /metrics exposes Prometheus counters/gauges
{
  const m = await fetch(BASE + "/metrics");
  const body = await m.text();
  ok("metrics endpoint 200", m.status === 200, `status=${m.status}`);
  ok("metrics exposes job queue depth", body.includes("useful_job_queue_depth"));
  ok("metrics exposes source health", body.includes("useful_source_artifacts_healthy"));
}

// negative: admin endpoint without credentials must be 401
{
  const anon = await fetch(BASE + "/v1/admin/identities");
  ok("admin endpoint anonymous rejected", anon.status === 401, `status=${anon.status}`);
}

// 1) signed release -> publisherSignatureVerified=true
const useful = readFileSync(`${dir}/hello.useful`);
const helloSha = sha256hex(useful);
const { rel: goodRel } = await uploadAndRelease(
  `${dir}/hello.useful`,
  "com.e2e.hello",
  "1.0.0",
  { publisherSignature: signArtifact("com.e2e.hello", "1.0.0", helloSha) },
);
ok("signed release accepted (201)", goodRel.status === 201, `got ${goodRel.status}`);
ok(
  "publisherSignatureVerified=true on artifact",
  goodRel.json?.publisherSignatureVerified === true,
);
const helloId = goodRel.json?.id;

// 2) bad signature rejected (Phase 9 acceptance: key mismatch -> reject)
const { rel: badRel } = await uploadAndRelease(`${dir}/hello2.useful`, "com.e2e.hello", "1.0.1", {
  publisherSignature: "ab".repeat(64),
});
ok("mismatched signature rejected (400)", badRel.status === 400, `got ${badRel.status}`);

// 3) worker scans + auto-approve publishes the non-native tool
const published = await waitStatus(helloId, "published", 90);
ok("worker scanned and auto-published web tool", published !== null);
ok("securityScanPassed persisted", published?.securityScanPassed === true);
ok("officialReviewPassed persisted", published?.officialReviewPassed === true);

// 4) catalog review reflects real fields
let snap = await req("GET", "/v1/catalog/snapshot");
let entry = snap.json?.entries?.find((e) => e.identity.toolId === "com.e2e.hello");
ok("catalog entry exists", !!entry);
ok("catalog review.publisherSignatureVerified", entry?.review?.publisherSignatureVerified === true);
ok("catalog review.securityScanPassed", entry?.review?.securityScanPassed === true);
ok(
  "catalog artifact publisherSignatureVerified",
  entry?.artifacts?.[0]?.publisherSignatureVerified === true,
);

// 5) native worker gate: stays scanned even with AUTO_APPROVE=true
const workerSha = sha256hex(readFileSync(`${dir}/worker.useful`));
const { rel: wRel } = await uploadAndRelease(`${dir}/worker.useful`, "com.e2e.native", "1.0.0", {
  name: "E2E Native",
  publisherSignature: signArtifact("com.e2e.native", "1.0.0", workerSha),
});
ok("native worker release accepted", wRel.status === 201, `got ${wRel.status}`);
const scanned = await waitStatus(wRel.json?.id, "scanned", 90);
ok("native worker stays scanned (not auto-published)", scanned !== null);
ok("native worker flag detected", scanned?.isNativeWorker === true);
// manual approve then published
const approve = await req("POST", `/v1/publisher/releases/${wRel.json?.id}/review`, {
  admin: true,
  body: { decision: "approved" },
});
ok("manual approve ok", approve.status === 200, `got ${approve.status}`);

// 5b) source availability: background checker marks published artifact healthy.
// Poll catalog until availability view appears (checker sweeps every ~1min in
// dev, faster on first run). Assert derived sourceAvailable, never a placeholder.
let availOk = false;
for (let i = 0; i < 90; i++) {
  const s = await req("GET", "/v1/catalog/snapshot");
  const en = s.json?.entries?.find((e) => e.identity.toolId === "com.e2e.hello");
  if (en?.availability && en.availability.status !== "unknown") {
    availOk = en.availability.status === "healthy" &&
      en.availability.source === "background-check" &&
      !!en.availability.checkedAt && en.review?.sourceAvailable === true;
    break;
  }
  await new Promise((r2) => setTimeout(r2, 1000));
}
ok("source availability derived from real background check", availOk);

// 5c) Three real .useful plugins: signed v1/v2 publish, download, zero native web permissions,
// withdrawal denial, and installed-user advisory data.
for (const plugin of realPlugins) {
  const v1Bytes = readFileSync(`${dir}/${plugin.v1File}`);
  const v1Sha = sha256hex(v1Bytes);
  const { rel: v1Release } = await uploadAndRelease(
    `${dir}/${plugin.v1File}`,
    plugin.id,
    "1.0.0",
    {
      name: plugin.name,
      permissions: [],
      publisherSignature: signArtifact(plugin.id, "1.0.0", v1Sha),
    },
  );
  ok(`${plugin.id} signed v1 accepted`, v1Release.status === 201, `got ${v1Release.status}`);
  const v1Published = await waitStatus(v1Release.json?.id, "published", 90);
  ok(`${plugin.id} v1 published`, v1Published !== null);

  const v2Bytes = readFileSync(`${dir}/${plugin.v2File}`);
  const v2Sha = sha256hex(v2Bytes);
  const v2Permissions = [];
  const { rel: v2Release } = await uploadAndRelease(
    `${dir}/${plugin.v2File}`,
    plugin.id,
    "1.1.0",
    {
      name: plugin.name,
      permissions: v2Permissions,
      publisherSignature: signArtifact(plugin.id, "1.1.0", v2Sha),
    },
  );
  ok(`${plugin.id} signed v2 accepted`, v2Release.status === 201, `got ${v2Release.status}`);
  const v2Published = await waitStatus(v2Release.json?.id, "published", 90);
  ok(`${plugin.id} v2 published`, v2Published !== null);

  const pluginEntry = await waitCatalogLatest(plugin.id, "1.1.0");
  ok(`${plugin.id} catalog latest=1.1.0`, pluginEntry !== null);
  const catalogV2 = pluginEntry?.artifacts?.find((artifact) => artifact.version === "1.1.0");
  ok(
    `${plugin.id} catalog keeps zero native web permissions`,
    JSON.stringify([...(catalogV2?.permissions ?? [])].sort()) === JSON.stringify([...v2Permissions].sort()),
  );

  const goodGrant = await req("POST", "/v1/download-grants", {
    body: {
      toolId: plugin.id,
      publisherKeyId: keyId,
      version: "1.1.0",
      platform: "windows",
      arch: "x86_64",
      channel: "stable",
    },
  });
  ok(`${plugin.id} v2 download grant`, goodGrant.status === 201, `got ${goodGrant.status}`);
  if (goodGrant.status === 201) {
    const grantUrl = new URL(goodGrant.json.downloadUrl);
    const download = await fetch(BASE + grantUrl.pathname + grantUrl.search);
    const downloaded = Buffer.from(await download.arrayBuffer());
    ok(`${plugin.id} v2 download status`, download.status === 200, `got ${download.status}`);
    ok(`${plugin.id} v2 download sha256`, sha256hex(downloaded) === v2Sha);
  }

  const withdrawn = await req("POST", `/v1/publisher/releases/${v1Release.json?.id}/withdraw`, {
    admin: true,
    body: { reason: "phase12 lifecycle withdrawal" },
  });
  ok(`${plugin.id} v1 withdrawn`, withdrawn.status === 200, `got ${withdrawn.status}`);
  const deniedGrant = await req("POST", "/v1/download-grants", {
    body: {
      toolId: plugin.id,
      publisherKeyId: keyId,
      version: "1.0.0",
      platform: "windows",
      arch: "x86_64",
      channel: "stable",
    },
  });
  ok(`${plugin.id} withdrawn v1 denied`, deniedGrant.status === 403, `got ${deniedGrant.status}`);

  const advisory = await req("POST", "/v1/publisher/advisories", {
    admin: true,
    body: {
      publisherKeyId: keyId,
      toolId: plugin.id,
      severity: "high",
      summary: `${plugin.name} 1.0.0 security advisory`,
      affectedVersions: ["1.0.0"],
    },
  });
  ok(`${plugin.id} advisory created`, advisory.status === 201, `got ${advisory.status}`);
  const advisoryList = await req("GET", `/v1/tools/${keyId}/${plugin.id}/advisories`);
  ok(`${plugin.id} advisory visible`, advisoryList.json?.advisories?.length === 1);
}

// 6) withdraw hello -> new download grant rejected 403
const wd = await req("POST", `/v1/publisher/releases/${helloId}/withdraw`, {
  admin: true,
  body: { reason: "e2e security issue" },
});
ok("withdraw endpoint ok", wd.status === 200, `got ${wd.status}`);
const grant = await req("POST", "/v1/download-grants", {
  body: {
    toolId: "com.e2e.hello",
    publisherKeyId: keyId,
    version: "1.0.0",
    platform: "windows",
    arch: "x86_64",
    channel: "stable",
  },
});
ok("withdrawn artifact grant rejected (403)", grant.status === 403, `got ${grant.status}`);

// 7) advisory -> visible via endpoint and catalog
const adv = await req("POST", "/v1/publisher/advisories", {
  admin: true,
  body: {
    publisherKeyId: keyId,
    toolId: "com.e2e.hello",
    severity: "high",
    summary: "e2e advisory: stop using 1.0.0",
    affectedVersions: ["1.0.0"],
  },
});
ok("advisory created (201)", adv.status === 201, `got ${adv.status}`);
const advList = await req("GET", `/v1/tools/${keyId}/com.e2e.hello/advisories`);
ok("advisories endpoint returns 1", advList.json?.advisories?.length === 1);
snap = await req("GET", "/v1/catalog/snapshot");
entry = snap.json?.entries?.find((e) => e.identity.toolId === "com.e2e.hello");
ok("catalog entry kept for withdrawn tool with advisory", !!entry);
ok("catalog entry carries advisory", entry?.advisories?.length === 1);
ok("catalog artifact marked withdrawn", entry?.artifacts?.some((a) => a.withdrawn === true));

console.log(failures === 0 ? "E2E RESULT: ALL PASS" : `E2E RESULT: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
