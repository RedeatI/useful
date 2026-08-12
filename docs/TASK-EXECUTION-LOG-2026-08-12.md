# 任务执行记录（2026-08-12）

## 已完成

| 事项 | 结果 |
| --- | --- |
| portable 冒烟 | 进程可启动；`data` 目录由 portable 自带生成 |
| 版本对齐 | monorepo → `0.1.0-beta.4`（`set-version` + drift ok） |
| npm 安全 | `pnpm audit` → No known vulnerabilities found |
| vitest 大输入超时 | Unicode 10MB 用例 timeout 提到 30s |
| PVR | 仓库 private vulnerability reporting 已 enabled |
| Issues | `has_issues=true`，open=0 |
| 分支保护 | main 存在 protection（linear history，禁 force-push，conversation resolution） |
| 宣发口径 | 本地 `宣发/` 已对齐 beta.4（X / 小红书 / 事实清单 / README） |
| Release 资产 | `v0.1.0-beta.4`：portable、msi、setup、bundle、Agent Kit、SHA256SUMS |
| Agent Kit | `Useful-0.1.0-beta.4-agent-kit.zip`（sha256 `ddb1d471…`，对齐 public main） |
| 签名门禁脚本 | `identityReady` / `updateTrustReady` true；`signedBetaPublishReady` false |
| 密钥扫描 | secret scanning + push protection enabled；non-provider patterns API 未能打开（仍 disabled） |

## 阻塞 / 归 Owner

| 事项 | 原因 |
| --- | --- |
| Windows/Apple 代码签名 | 需购买证书并上传 Actions secrets |
| glib Rust medium 告警 | 经 gtk 0.18 链路依赖 tauri Linux；无法单独升到 0.20，待上游 tauri/gtk 升级 |
| 更新 feed 真实清单 | 需签名 Release 后写真实 update manifest |
| Portable Full | GPL 对应源码 Owner 门 |
| CoC 执行联系人 | 政策要求命名 enforcement channel 后再广泛邀请贡献 |
| 提高 PR 必需 review 数 | 当前 `required_approving_review_count=0`（单人维护可选） |

## 校验命令

```text
node scripts/check-version-drift.mjs --json
node scripts/check-owner-signing-gates.mjs --json
pnpm audit
gh release view v0.1.0-beta.4 --repo RedeatI/useful
```
