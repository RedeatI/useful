// 重新生成 repositories/static-example：用 useful source CLI 真实签名。
// 私钥在临时目录中生成并用后即弃——绝不提交进仓库（示例是不可变 fixture，
// 重新生成会产生新密钥与新指纹）。
// 用法：node scripts/gen-static-example.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import YAML from "yaml";
import {
  cmdAddPackage,
  cmdExportStatic,
  cmdInit,
  cmdPublish,
  cmdValidate,
} from "../packages/useful-cli/bin/source/source.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(repoRoot, "repositories", "static-example");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "useful-static-example-"));
const srcDir = path.join(tmp, "source");

try {
  // 1) 初始化并调整配置（示例 fixture 使用长过期时间，真实部署请用默认短窗口）
  cmdInit(srcDir, {
    id: "com.example.static",
    name: "Useful 静态示例源",
    operator: "Example Community",
    baseUrl: "https://static.example.com",
  });
  const cfgPath = path.join(srcDir, "source-config.yaml");
  const cfg = YAML.parse(fs.readFileSync(cfgPath, "utf8"));
  cfg.description = "可由任意静态 HTTP 服务器托管的示例软件源。";
  cfg.expires = { root: 3650, targets: 3650, snapshot: 3650, timestamp: 3650 };
  fs.writeFileSync(cfgPath, YAML.stringify(cfg));

  // 2) 打包 examples/hello-web-tool 为 .useful 并入库
  const toolDir = path.join(repoRoot, "examples", "hello-web-tool");
  const manifest = JSON.parse(fs.readFileSync(path.join(toolDir, "manifest.json"), "utf8"));
  const zip = new AdmZip();
  zip.addLocalFolder(toolDir);
  const usefulPath = path.join(tmp, `${manifest.id}-${manifest.version}.useful`);
  zip.writeZip(usefulPath);
  cmdAddPackage(srcDir, usefulPath, { channel: "stable" });

  // 3) 发布 + 校验 + 导出
  cmdPublish(srcDir);
  await cmdValidate(srcDir);
  fs.rmSync(outDir, { recursive: true, force: true });
  cmdExportStatic(srcDir, outDir);

  // 4) 示例说明（覆盖导出的通用 README）
  fs.writeFileSync(
    path.join(outDir, "README.md"),
    `# 静态示例源（生成产物）

由 \`node scripts/gen-static-example.mjs\` 生成：TUF 风格 metadata 真实签名，
可用 \`useful source validate\` 或 \`pnpm --filter @useful/protocol validate -- --source\` 验证。

- 私钥在生成后即被丢弃，不在仓库中；重新生成会产生新密钥与新根指纹。
- 作为不可变 fixture，metadata 过期时间设置得很长；真实部署请使用默认短过期窗口。
- 本地预览：\`node packages/useful-cli/bin/useful.mjs source serve\` 需要源工作目录，
  对纯静态目录可用任意静态 HTTP 服务器（如 \`npx serve repositories/static-example\`）。
`,
  );
  console.log(`✓ 已重建 ${outDir}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
