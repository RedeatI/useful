# Useful 人类维护者与发布者指南

> 本文面向人工维护者和自托管源管理员，包含交互式、本地服务和网络发布命令；不得作为
> Agent 自动化流程输入。任何外部 Agent 构建第三方工具时，必须以
> [`agent/BUILD-A-TOOL.md`](agent/BUILD-A-TOOL.md) 为唯一流程事实源，只运行其中的非交互
> `--json` 命令并在首个非零退出码停止。
>
> 人工维护者可用本文完成 clone → 开发 → 打包 → 建源 → 发布 → 安装 → 更新 → 撤回 →
> 安全公告。命令由 `scripts/doc-smoke.mjs` 与 CI 验证，避免失效。
> 深入细节见：[PLUGIN_SDK](PLUGIN_SDK.md) · [TRP-v1](TRP-v1.md) · [OWNER-GATES](OWNER-GATES.md)。

## 0. Quick Start（Windows 权威入口）

```powershell
git clone <repo> useful; cd useful
.\scripts\useful.ps1 doctor        # 检查工具链（Node/pnpm/Rust/Go/Docker/WebView2）
.\scripts\useful.ps1 bootstrap     # 幂等初始化：依赖/配置/示例源/开发管理员
.\scripts\useful.ps1 verify:all    # 全语言门禁（生成 bench-results/verify-all.json）
```

CLI 入口：`node packages/useful-cli/bin/useful.mjs <command>`（下文简写 `useful`）。
以下命令不会被 Agent 指南继承；网络发布、撤回和生产操作仍需独立明确授权。

## 1. 创建一个 web 工具 → 本地预览 → 校验 manifest

```powershell
# 参考 examples/hello-web-tool。manifest.json 关键字段见 PLUGIN_SDK.md。
useful dev  examples/hello-web-tool          # 本地预览（http://localhost:5178）
useful validate  examples/hello-web-tool     # 校验 manifest + web 入口文件存在
```

## 2. 打包 .useful

```powershell
useful pack  examples/hello-web-tool  ./out  # 产出 <id>-<version>.useful
```

## 3. 创建本地静态源 → 发布工具

静态源无需后端，纯文件托管即可（TUF metadata + 内容寻址 targets）。

```powershell
useful source init  ./mysource --name "My Source" --id com.me.source
useful source add-package  ./mysource  ./out/com.useful.hello-1.0.0.useful
useful source publish  ./mysource                 # 重签 targets/snapshot/timestamp
useful source export-static  ./mysource  ./dist   # 导出可静态托管目录（绝不含私钥）
useful source serve  ./mysource --port 8090       # 本地起静态服务器验证
```

根指纹（`1.root.json` 的 sha256）用于客户端首次添加源时的信任锚确认。

## 4. 在客户端添加源 → 搜索 → 安装

客户端「源中心」→ 添加源 → 输入源地址 → **确认根指纹**（防串源投毒）→ 同步 catalog →
搜索 → 安装免费工具。付费工具走 OAuth 登录 + download-grant。
UI 分别展示四类信号：源签名 / 发布者签名（Ed25519 或 Sigstore）/ 官方审核 / 安全扫描，
外加来源可用性与复现构建状态（绝不合并成单一"安全"布尔）。

## 5. 发布者签名（Ed25519 与 Sigstore 二选一）

- **Ed25519**：发布者用长期私钥对 `useful-artifact-v1\n<toolId>\n<version>\n<sha256>` 签名，
  随 release 请求 `publisherSignature` 提交。详见 [SECURITY-ASSURANCE](SECURITY-ASSURANCE.md)。
- **Sigstore 身份签名**：用工作流 OIDC 身份签名，提交 `sigstoreBundle`；服务端按发布者
  配置的身份策略（issuer 精确 + SAN 精确/受控模式）验证，见 [ADR-013](adr/ADR-013-sigstore-identity.md)。

## 6. 客户端更新密钥与发布（与工具源 TUF 完全隔离）

```powershell
useful key init-root  ./updroot --env test --threshold 2 --roots 3   # 生产为 Owner Gate
useful key sign-root  ./updroot --key ./updroot/keys/root-1.private.pem
useful key sign-root  ./updroot --key ./updroot/keys/root-2.private.pem
useful key verify-ceremony  ./updroot
useful app-update create  ./update.json --product useful-desktop --version 1.2.0 `
  --channel stable --env test --artifact ./Useful.zip
useful app-update sign  ./update.json --root ./updroot --key ./updroot/keys/release.private.pem
useful app-update verify  ./update.json --root ./updroot
```

生产根创建、代码签名证书为 Owner Gate（[OWNER-GATES](OWNER-GATES.md)）；
`--production` 验证拒绝测试根（ADR-014）。

## 7. 发布更新 / 撤回错误版本 / 安全公告

```powershell
# 发布新版本：重复 add-package + publish（静态源）；动态源走 /v1/publisher/releases。
# 撤回：动态源 POST /v1/publisher/releases/{id}/withdraw（记录保留，新用户 grant 403）。
# 安全公告：POST /v1/publisher/advisories（已安装用户经 catalog/advisories 可见）。
```

动态源发布者 API 全部走 RBAC + API Token（`Authorization: Bearer usefuls_…`），
用 `source-server -init-admin` 获取首个管理员 token。见 [ADR-011](adr/ADR-011-api-token-rbac.md)。

## 8. 密钥轮换 / 遗失恢复

- 发布者密钥轮换：新密钥须被旧密钥交叉签名（`POST /v1/publisher/keys/rotate`），
  无法证明连续性则视为新发布者（不继承信誉）。
- 更新根轮换：`useful key rotate-root`（旧密钥进 revoked，版本 +1，需重签阈值）。
- 单密钥撤销：`useful key revoke --keyid <id>`；验证时拒绝已撤销密钥的签名。

## 9. 自托管动态源

```powershell
cd deploy/docker-compose; cp .env.example .env   # 按注释改密钥
docker compose up -d --build                      # server + worker + postgres
# 迁移在 server 启动时自动应用（advisory lock 串行化，幂等；0001-0006）
```
生产配置见 [config/production.example.env](../config/production.example.env) 与 [PRODUCTION](PRODUCTION.md)。

## 10. 调试与常见错误

| 现象 | 原因 | 处理 |
|------|------|------|
| 客户端拒绝添加源 | 根指纹不匹配 | 核对源方公布的 `1.root.json` sha256 |
| 发布 401 | 缺 API Token | `source-server -init-admin` 获取；用 `Bearer usefuls_…` |
| 发布 403 | token scope 不足 | 用对应角色身份签发 token（见 ADR-011 scope 表） |
| 下载 403 | 制品已撤回或需付费授权 | 撤回不可恢复；付费走 OAuth + download-grant |
| Sigstore 验证失败 | 身份/摘要/证书链不符 | 核对发布者身份策略与 bundle 绑定的 artifact |
| 生产启动被拒 | 占位/不安全默认值 | 见 OWNER-GATES 的 fail-closed 清单 |
| Rust 工具链反复下载 | 本机尚未安装仓库固定版本 | 按 rust-toolchain.toml 安装精确工具链 |

## 11. 协议兼容策略

catalog 条目为可演进数据：条目级结构允许未知字段（新源可携带新增可选字段，旧客户端
继续解析）；identity/artifact 摘要等安全锁定结构严格拒绝未知字段。schemaVersion 不匹配拒绝。
详见 [TRP-v1](TRP-v1.md) 与 `packages/protocol`。

## 12. 数据库升级指南

迁移文件 `services/migrations/NNNN_*.sql` 按序应用，每个含 `INSERT INTO migrations` 版本登记
与回滚说明注释。`scripts/check-drift.mjs` 校验序列连续性与回滚说明。升级即新增迁移文件；
不修改已应用的历史迁移。已发布制品记录禁止删除（撤回用 withdrawn 状态）。
