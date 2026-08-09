# 上线检查清单（Launch Checklist）

> 从 RC 到正式发布的操作清单。标 [Owner Gate] 的项不可由代理完成，见 OWNER-GATES.md。
> 标 [自动] 的项已由 `.\scripts\useful.ps1` 覆盖。

## 阶段 0：环境就绪
- [自动] `.\scripts\useful.ps1 doctor` 通过（Node/pnpm/Rust/Cargo/Go/Docker/WebView2）
- [自动] `.\scripts\useful.ps1 bootstrap` 幂等初始化
- [自动] `.\scripts\useful.ps1 verify:all` 全绿

## 阶段 1：信任与密钥
- [Owner Gate] OG-1 生产 TUF Root 离线密钥仪式（`key init-root --env production` → 仪式清单）
- [Owner Gate] OG-1 阈值签名 + `key verify-ceremony --production` 通过
- [自动] 客户端更新根 dev/prod 隔离验证（`release:dry-run` 中已断言）
- [Owner Gate] OG-2 Windows 代码签名证书接入 `package-release.ps1`

## 阶段 2：基础设施
- [Owner Gate] OG-3 生产域名 + TLS（`BASE_URL` https，config 已强制）
- [Owner Gate] OG-4 生产对象存储/CDN（`STORAGE_DRIVER=s3` + `S3_*`）
- [Owner Gate] OG-5 OAuth/OIDC 生产客户端 + `OAUTH_SIGNING_SECRET`
- [ ] 生产 `DATABASE_URL`（Postgres）+ 迁移应用（启动自动，advisory lock）
- [ ] `DOWNLOAD_TOKEN_SECRET` 生产密钥

## 阶段 3：认证与运维
- [自动] 生产拒绝静态 `ADMIN_TOKEN`（config.Validate 已实现）
- [ ] `source-server -init-admin` 创建首个 instance-admin，安全分发一次性 API Token
- [ ] 为发布者/审核者创建对应角色身份与 scoped token
- [ ] 配置 `/metrics` 抓取 + 最小告警规则（发布/扫描/下载授权/webhook 失败、队列深度、source health）

## 阶段 4：商业
- [Owner Gate] OG-6 支付商户账户 + webhook secret（生产禁 fake，已强制）
- [Owner Gate] OG-7 价格/退款/税务
- [Owner Gate] OG-8 隐私政策 + 服务条款法律定稿
- [Owner Gate] OG-9 商标注册
- [Owner Gate] OG-10 安全联系邮箱 + 漏洞赏金范围

## 阶段 5：发布前验证
- [自动] `release:dry-run` 全绿（构建→SHA256→SBOM→测试签名→验证→生产隔离）
- [自动] `restore:drill` 通过（RPO/RTO 实测，root 私钥不入备份）
- [ ] 干净 clone 在目标环境完整走通（Go 已验证；补 pnpm install + 前端 + Tauri）
- [ ] 大文件下载 + 安装回滚 CI 矩阵（见 KNOWN-LIMITATIONS L4）
- [ ] 原生 Tauri smoke（见 KNOWN-LIMITATIONS L3）

## 阶段 6：发布
- [ ] 用生产 release 密钥签名正式更新 manifest（非测试密钥）
- [ ] 发布 metadata + 制品到生产源
- [ ] 客户端更新灰度（beta channel 先行）
- [ ] 监控告警 24h 观察

## 回滚预案
- 更新失败：manifest rollback.allowed + minVersion 控制；客户端拒绝低于 minCompat
- 制品问题：`useful source` 撤回（记录保留，新用户 grant 403）
- 密钥泄漏：`key revoke` + `key rotate-root` + 重签
- 基础设施：对象存储切备用桶；数据库从备份恢复（restore:drill 已演练流程）
