// 从 src-tauri/icons/icon.svg 生成 Windows ICO 与各 PNG 尺寸。
// 依赖 sharp（SVG 光栅化）与 png-to-ico。运行: node scripts/gen-icons.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import pngToIco from "png-to-ico";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const iconsDir = path.join(root, "apps", "useful", "src-tauri", "icons");
const svgPath = path.join(iconsDir, "icon.svg");

// Tauri 需要的 PNG 尺寸集合
const pngTargets = [
  { name: "32x32.png", size: 32 },
  { name: "128x128.png", size: 128 },
  { name: "128x128@2x.png", size: 256 },
  { name: "icon.png", size: 512 },
  { name: "Square30x30Logo.png", size: 30 },
  { name: "Square44x44Logo.png", size: 44 },
  { name: "Square71x71Logo.png", size: 71 },
  { name: "Square89x89Logo.png", size: 89 },
  { name: "Square107x107Logo.png", size: 107 },
  { name: "Square142x142Logo.png", size: 142 },
  { name: "Square150x150Logo.png", size: 150 },
  { name: "Square284x284Logo.png", size: 284 },
  { name: "Square310x310Logo.png", size: 310 },
  { name: "StoreLogo.png", size: 50 },
];

// ICO 内含尺寸
const icoSizes = [16, 24, 32, 48, 64, 128, 256];

async function main() {
  if (!fs.existsSync(svgPath)) {
    console.error(`未找到 SVG: ${svgPath}`);
    process.exit(1);
  }
  const svg = fs.readFileSync(svgPath);

  for (const { name, size } of pngTargets) {
    await sharp(svg, { density: 384 })
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(path.join(iconsDir, name));
    console.log(`✓ ${name} (${size}x${size})`);
  }

  // 生成 ICO：先渲染各尺寸 PNG buffer，再合成
  const buffers = [];
  for (const size of icoSizes) {
    buffers.push(
      await sharp(svg, { density: 384 })
        .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer(),
    );
  }
  const ico = await pngToIco(buffers);
  fs.writeFileSync(path.join(iconsDir, "icon.ico"), ico);
  console.log(`✓ icon.ico (${icoSizes.join(",")})`);
  console.log("图标生成完成。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
