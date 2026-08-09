# 静态示例源（生成产物）

由 `node scripts/gen-static-example.mjs` 生成：TUF 风格 metadata 真实签名，
可用 `useful source validate` 或 `pnpm --filter @useful/protocol validate -- --source` 验证。

- 私钥在生成后即被丢弃，不在仓库中；重新生成会产生新密钥与新根指纹。
- 作为不可变 fixture，metadata 过期时间设置得很长；真实部署请使用默认短过期窗口。
- 本地预览：`node packages/useful-cli/bin/useful.mjs source serve` 需要源工作目录，
  对纯静态目录可用任意静态 HTTP 服务器（如 `npx serve repositories/static-example`）。
