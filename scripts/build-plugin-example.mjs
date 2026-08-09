import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

export async function buildPluginExample(source, output) {
  const sourceDir = path.resolve(source);
  const outputDir = path.resolve(output);
  if (!fs.existsSync(path.join(sourceDir, "manifest.json"))) {
    throw new Error(`插件示例目录缺少 manifest.json: ${sourceDir}`);
  }

  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.cpSync(path.join(sourceDir, "public"), outputDir, { recursive: true });
  fs.copyFileSync(path.join(sourceDir, "manifest.json"), path.join(outputDir, "manifest.json"));
  for (const optional of ["assets", "THIRD_PARTY_LICENSES.md"]) {
    const optionalSource = path.join(sourceDir, optional);
    if (fs.existsSync(optionalSource)) {
      fs.cpSync(optionalSource, path.join(outputDir, optional), { recursive: true });
    }
  }

  await build({
    entryPoints: [path.join(sourceDir, "src", "main.ts")],
    outfile: path.join(outputDir, "main.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    legalComments: "none",
  });

  const htmlPath = path.join(outputDir, "index.html");
  const scriptPath = path.join(outputDir, "main.js");
  const stylePath = path.join(outputDir, "styles.css");
  let html = fs.readFileSync(htmlPath, "utf8");
  const script = fs.readFileSync(scriptPath, "utf8").replace(/<\/script/gi, "<\\/script");
  if (!html.includes('<script src="main.js"></script>')) {
    throw new Error("插件入口缺少固定 main.js 脚本标记");
  }
  html = html.replace('<script src="main.js"></script>', `<script>${script}</script>`);
  if (fs.existsSync(stylePath)) {
    const style = fs.readFileSync(stylePath, "utf8").replace(/<\/style/gi, "<\\/style");
    if (!html.includes('<link rel="stylesheet" href="styles.css" />')) {
      throw new Error("插件入口缺少固定 styles.css 样式标记");
    }
    html = html.replace('<link rel="stylesheet" href="styles.css" />', `<style>${style}</style>`);
    fs.rmSync(stylePath);
  }
  fs.writeFileSync(htmlPath, html);
  fs.rmSync(scriptPath);

  console.log(`✓ 插件示例已构建: ${outputDir}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2] || !process.argv[3]) {
    throw new Error("用法: node scripts/build-plugin-example.mjs <示例目录> <输出目录>");
  }
  await buildPluginExample(process.argv[2], process.argv[3]);
}
