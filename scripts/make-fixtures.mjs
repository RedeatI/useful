// 生成测试夹具与示例图标。
//   - 用 sharp 渲染示例插件 assets/icon.png
//   - 生成 fixtures/normal.useful（正常）、fixtures/malicious-path.useful（ZIP Slip）、fixtures/corrupt.useful（损坏）
// 运行: node scripts/make-fixtures.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const examplesDir = path.join(root, "examples");
const fixturesDir = path.join(root, "fixtures");
const iconSvg = path.join(root, "apps", "useful", "src-tauri", "icons", "icon.svg");

async function renderExampleIcons() {
  const svg = fs.readFileSync(iconSvg);
  for (const ex of ["hello-web-tool", "external-launcher-tool"]) {
    const assets = path.join(examplesDir, ex, "assets");
    fs.mkdirSync(assets, { recursive: true });
    await sharp(svg, { density: 256 })
      .resize(128, 128, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(path.join(assets, "icon.png"));
    console.log(`✓ ${ex}/assets/icon.png`);
  }
}

function packNormal() {
  // 用示例 hello-web-tool 打一个正常 .useful
  const src = path.join(examplesDir, "hello-web-tool");
  const zip = new AdmZip();
  zip.addLocalFile(path.join(src, "manifest.json"));
  zip.addLocalFile(path.join(src, "index.html"));
  zip.addLocalFile(path.join(src, "main.js"));
  const iconPath = path.join(src, "assets", "icon.png");
  if (fs.existsSync(iconPath)) zip.addLocalFile(iconPath, "assets");
  zip.writeZip(path.join(fixturesDir, "normal.useful"));
  console.log("✓ fixtures/normal.useful");
}

function packMaliciousPath() {
  // adm-zip 会规范化 ../ 条目名，因此手工构造一个 store 方式（不压缩）的 ZIP，
  // 保留字面量的 ../../escape.txt 条目名，用于真实测试 ZIP Slip 防护。
  const manifest = Buffer.from(
    JSON.stringify(
      {
        schemaVersion: 1,
        id: "com.evil.pathtraversal",
        name: "恶意路径插件",
        version: "1.0.0",
        entry: { type: "web", path: "index.html" },
        platforms: ["windows-x64"],
        minHostVersion: "0.1.0",
      },
      null,
      2,
    ),
  );
  const entries = [
    { name: "manifest.json", data: manifest },
    { name: "index.html", data: Buffer.from("<html></html>") },
    // ZIP Slip：字面量路径穿越
    { name: "../../escape.txt", data: Buffer.from("pwned") },
  ];
  fs.writeFileSync(path.join(fixturesDir, "malicious-path.useful"), buildRawZip(entries));
  console.log("✓ fixtures/malicious-path.useful（含字面量 ../ 条目）");
}

// CRC32 表
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// 构造 store 方式（compression=0）的最小 ZIP，保留原始条目名（不做规范化）。
function buildRawZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf-8");
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method = store
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, e.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(e.data.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + e.data.length;
  }
  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralPart.length, 12);
  end.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, end]);
}

function packCorrupt() {
  // 损坏 ZIP：写入随机字节，非法 zip 头
  const buf = Buffer.from("PK\x03\x04 this is not a valid zip file at all!!");
  fs.writeFileSync(path.join(fixturesDir, "corrupt.useful"), buf);
  console.log("✓ fixtures/corrupt.useful");
}

async function main() {
  fs.mkdirSync(fixturesDir, { recursive: true });
  await renderExampleIcons();
  packNormal();
  packMaliciousPath();
  packCorrupt();
  console.log("测试夹具生成完成:", fixturesDir);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
