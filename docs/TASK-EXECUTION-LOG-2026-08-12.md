# 可做任务执行记录（2026-08-12）

## 已完成

| 任务 | 结果 |
| --- | --- |
| portable 冒烟 | 启动成功，`data` 目录在 portable 旁创建 |
| 版本对齐 | monorepo → `0.1.0-beta.4`（`set-version` + drift ok） |
| npm 安全 | `pnpm audit` → No known vulnerabilities found |
| vitest 大输入超时 | Unicode 10MB 测试 timeout 提到 30s |
| PVR | 仓库 private vulnerability reporting 已 enabled |
| Issues | has_issues=true，open=0 |
| 分支保护 | main 已有 protection（linear history、禁 force-push） |
| 宣发口径 | 更新为 beta.4（本地 `宣发/`） |

## 阻塞 / 需 Owner

| 任务 | 原因 |
| --- | --- |
| Windows/Apple 代码签名 | 需购买证书 |
| glib Rust medium 告警 | 经 gtk 0.18 链路依赖 tauri Linux；无法单独升到 0.20，待上游 tauri/gtk 升级 |
| 生产 feed 真实清单 | 需签名 Release 后写入真实 update manifest |
| Portable Full | GPL 对应源码门禁 |

## 检查命令

```text
node scripts/check-version-drift.mjs --json
node scripts/check-owner-signing-gates.mjs --json
pnpm audit
```
