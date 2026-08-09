// Host-side prep for phase 9 e2e: generate Ed25519 publisher key + test packages.
// Output goes to e2e/out/ (gitignored). ASCII output only.
import { generateKeyPairSync } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import { buildPluginExample } from "../../../scripts/build-plugin-example.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const repoRoot = resolve(here, "../../..");

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const jwk = publicKey.export({ format: "jwk" });
const pubHex = Buffer.from(jwk.x, "base64url").toString("hex");
const keyId = `ed25519:${pubHex}`;
writeFileSync(
  join(out, "key.json"),
  JSON.stringify({
    keyId,
    pubHex,
    privPem: privateKey.export({ type: "pkcs8", format: "pem" }),
  }),
);

const realPlugins = [
  { name: "base64", source: "examples/base64-tool" },
  { name: "file-hash", source: "examples/file-hash-tool" },
  { name: "qr-code", source: "examples/qr-code-tool" },
];
const pluginFixtures = [];
for (const plugin of realPlugins) {
  const v1Dir = join(out, "real-build", plugin.name, "1.0.0");
  await buildPluginExample(join(repoRoot, plugin.source), v1Dir);
  const v1ManifestPath = join(v1Dir, "manifest.json");
  const v1Manifest = JSON.parse(readFileSync(v1ManifestPath, "utf8"));
  v1Manifest.version = "1.0.0";
  // Public web plugins have zero native host permissions. Keep the packaged
  // manifest and source-server release request on the same exact contract.
  v1Manifest.permissions = [];
  writeFileSync(v1ManifestPath, `${JSON.stringify(v1Manifest, null, 2)}\n`);
  const v1Path = join(out, `${v1Manifest.id}-1.0.0.useful`);
  const v1Zip = new AdmZip();
  v1Zip.addLocalFolder(v1Dir);
  v1Zip.writeZip(v1Path);

  const v2Dir = join(out, "real-build", plugin.name, "1.1.0");
  cpSync(v1Dir, v2Dir, { recursive: true });
  const v2Manifest = { ...v1Manifest, version: "1.1.0", permissions: [] };
  writeFileSync(join(v2Dir, "manifest.json"), `${JSON.stringify(v2Manifest, null, 2)}\n`);
  const v2Path = join(out, `${v2Manifest.id}-1.1.0.useful`);
  const v2Zip = new AdmZip();
  v2Zip.addLocalFolder(v2Dir);
  v2Zip.writeZip(v2Path);
  pluginFixtures.push({
    id: v1Manifest.id,
    name: v1Manifest.name,
    v1File: `${v1Manifest.id}-1.0.0.useful`,
    v2File: `${v2Manifest.id}-1.1.0.useful`,
  });
}
writeFileSync(join(out, "real-plugins.json"), `${JSON.stringify(pluginFixtures, null, 2)}\n`);

// Minimal zip writer (stored entries, no compression) to avoid backslash
// entry names from Compress-Archive and external deps.
function crc32(buf) {
  let c,
    table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name);
    const body = Buffer.from(data);
    const crc = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const centralStart = offset;
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

const webManifest = (id, v) =>
  JSON.stringify({
    schemaVersion: 1,
    id,
    name: "E2E Tool",
    version: v,
    permissions: [],
    entry: { type: "web", path: "index.html" },
  });
const workerManifest = (id, v) =>
  JSON.stringify({
    schemaVersion: 1,
    id,
    name: "E2E Native",
    version: v,
    permissions: [],
    entry: { type: "worker", path: "tool.exe" },
  });

writeFileSync(
  join(out, "hello.useful"),
  makeZip([
    ["manifest.json", webManifest("com.e2e.hello", "1.0.0")],
    ["index.html", "<html>hello e2e</html>"],
  ]),
);
writeFileSync(
  join(out, "hello2.useful"),
  makeZip([
    ["manifest.json", webManifest("com.e2e.hello", "1.0.1")],
    ["index.html", "<html>hello e2e v2</html>"],
  ]),
);
writeFileSync(
  join(out, "worker.useful"),
  makeZip([
    ["manifest.json", workerManifest("com.e2e.native", "1.0.0")],
    ["tool.exe", "MZ fake native payload"],
  ]),
);
console.log("prepared. keyId=" + keyId);
