// useful-bootstrap.exe end-to-end acceptance (host, Windows).
// Scenarios:
//  1) bad signature   -> apply refused, files untouched
//  2) valid signature + broken new exe -> apply, launch fails, rollback restores old
//  3) valid signature + runnable exe   -> update applied, version bumped
// ASCII output only.
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const bootstrapExe = join(root, "target", "release", "useful-bootstrap.exe");
const evidenceDir = process.env.USEFUL_BOOTSTRAP_EVIDENCE_DIR;
const work = evidenceDir ? join(evidenceDir, "work") : join(root, "target", "bootstrap-e2e");
const fromVersion = process.env.USEFUL_FROM_VERSION ?? "0.1.0";
const toVersion = process.env.USEFUL_TO_VERSION ?? "0.2.0";

function crc32(buf) {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function makeZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name);
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const crc = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24); central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pubHex = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("hex");

function signManifest(version, payload) {
  const sha = createHash("sha256").update(payload).digest("hex");
  const sig = sign(null, Buffer.from(`useful-app-update-v1\n${version}\n${sha}`), privateKey);
  return { schemaVersion: 1, version, sha256: sha, size: payload.length, signature: sig.toString("hex") };
}

function setupAppDir(name) {
  const dir = join(work, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "update", "pending"), { recursive: true });
  writeFileSync(join(dir, "Useful.exe"), "OLD-EXE-v1 (not runnable)");
  writeFileSync(join(dir, "update", "current-version.txt"), fromVersion);
  writeFileSync(
    join(dir, "update", "app-update-source.json"),
    JSON.stringify({
      kind: "app-update",
      updateFeedUrl: "https://update.example/feed.json",
      updateRootPublicKey: pubHex,
      isDefaultOfficial: false,
      warningAcknowledgedAt: "2026-07-30T00:00:00Z",
    }),
  );
  copyFileSync(bootstrapExe, join(dir, "useful-bootstrap.exe"));
  return dir;
}

function runApply(dir) {
  try {
    const out = execFileSync(join(dir, "useful-bootstrap.exe"), ["apply"], {
      cwd: dir, encoding: "buffer", timeout: 60_000,
    });
    return { code: 0, out: out.toString() };
  } catch (e) {
    return { code: e.status ?? -1, out: String(e.stdout ?? "") + String(e.stderr ?? "") };
  }
}

let failures = 0;
const checks = [];
function ok(name, cond) {
  checks.push({ name, passed: Boolean(cond) });
  if (cond) console.log(`PASS ${name}`);
  else { failures++; console.log(`FAIL ${name}`); }
}

// Scenario 1: bad signature -> refused, nothing changed
{
  const dir = setupAppDir("s1-bad-signature");
  const payload = makeZip([["Useful.exe", "EVIL-NEW-EXE"]]);
  const m = signManifest(toVersion, payload);
  m.signature = "ab".repeat(64); // tamper
  writeFileSync(join(dir, "update", "pending", "update-manifest.json"), JSON.stringify(m));
  writeFileSync(join(dir, "update", "pending", "payload.zip"), payload);
  const r = runApply(dir);
  ok("s1 bad signature -> nonzero exit", r.code !== 0);
  ok("s1 old exe untouched", readFileSync(join(dir, "Useful.exe"), "utf8").startsWith("OLD-EXE-v1"));
}

// Scenario 2: valid signature but new exe cannot launch -> rollback, old restored
{
  const dir = setupAppDir("s2-launch-fail-rollback");
  const payload = makeZip([["Useful.exe", "NEW-EXE-v2 (not a real PE, launch fails)"]]);
  const m = signManifest(toVersion, payload);
  writeFileSync(join(dir, "update", "pending", "update-manifest.json"), JSON.stringify(m));
  writeFileSync(join(dir, "update", "pending", "payload.zip"), payload);
  const r = runApply(dir);
  ok("s2 launch failure -> nonzero exit", r.code !== 0);
  ok("s2 rollback restored old exe", readFileSync(join(dir, "Useful.exe"), "utf8").startsWith("OLD-EXE-v1"));
  ok("s2 version not bumped", readFileSync(join(dir, "update", "current-version.txt"), "utf8").trim() === fromVersion);
}

// Scenario 3: valid signature + runnable exe -> applied, version bumped, backup kept
{
  const dir = setupAppDir("s3-success");
  const runnable = readFileSync("C:\\Windows\\System32\\whoami.exe");
  const payload = makeZip([["Useful.exe", runnable]]);
  const m = signManifest(toVersion, payload);
  writeFileSync(join(dir, "update", "pending", "update-manifest.json"), JSON.stringify(m));
  writeFileSync(join(dir, "update", "pending", "payload.zip"), payload);
  const r = runApply(dir);
  ok("s3 apply succeeded (exit 0)", r.code === 0);
  ok("s3 new exe in place", readFileSync(join(dir, "Useful.exe")).equals(runnable));
  ok("s3 version bumped", readFileSync(join(dir, "update", "current-version.txt"), "utf8").trim() === toVersion);
  ok("s3 pending cleaned", !existsSync(join(dir, "update", "pending")));
  ok("s3 backup exists for rollback", existsSync(join(dir, "backup")));
}

console.log(failures === 0 ? "BOOTSTRAP E2E: ALL PASS" : `BOOTSTRAP E2E: ${failures} FAILURES`);
if (evidenceDir) {
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(
    join(evidenceDir, "result.json"),
    `${JSON.stringify({
      scenario: "bootstrap-install-upgrade-rollback",
      generatedAt: new Date().toISOString(),
      fromVersion,
      toVersion,
      total: checks.length,
      passed: checks.filter((check) => check.passed).length,
      failed: failures,
      checks,
    }, null, 2)}\n`,
  );
}
process.exit(failures === 0 ? 0 : 1);
