# Owner Gates（商业上线必需、不可由代理生成正式值）

以下事项由授权持有人在受控环境完成。每项含：配置入口、安全检查、dry-run、
操作清单、失败回滚、需填入的值。**生产启动时发现占位值必须 fail closed 或
显著拒绝启用相关能力。**

## OG-1 生产官方 TUF Root 密钥
- 配置入口：`useful key init-root --env production`（产出离线仪式清单，不生成真实密钥）
- 安全检查：`useful key verify-ceremony --production` 拒绝 NOT-FOR-PRODUCTION 根
- dry-run：test 环境完整走通 init→sign(阈值)→verify→app-update sign/verify
- 需填入：≥3 名持有人的 HSM/离线介质公钥，阈值 2/3
- 回滚：轮换 `key rotate-root`；旧密钥进 revoked
- fail closed：客户端 `--production` 验证拒绝测试根（已测）

## OG-2 Windows 正式代码签名证书
- 配置入口：`package-release.ps1` 签名步骤（当前用测试/无签名占位）
- 需填入：EV 代码签名证书（HSM/USB token）
- 回滚：撤销证书 + 重新签名新版本
- fail closed：无正式证书时便携包标注"未签名/开发版"，不冒充正式发布

## OG-3 正式域名
- 配置入口：`BASE_URL`（生产必须 HTTPS，已在 config.Validate 强制）
- 需填入：生产域名 + TLS 证书
- fail closed：生产环境 `BASE_URL` 非 https 拒绝启动（已实现）

## OG-4 CDN 与对象存储生产账户
- 配置入口：`STORAGE_DRIVER=s3` + `S3_*`（S3_BUCKET 必填校验已实现）
- 需填入：生产 S3/CDN 凭据
- 回滚：切回 filesystem 或备用桶

## OG-5 OAuth/OIDC 生产客户端
- 配置入口：`OAUTH_SIGNING_SECRET`（启用计费的生产必须提供，已校验）
- 需填入：生产 IdP client_id/回调；运维管理登录的 OIDC（接口已按 scope 抽象）
- fail closed：计费生产缺 OAUTH_SIGNING_SECRET 拒绝启动（已实现）

## OG-6 支付平台正式商户账户
- 配置入口：`BILLING_PROVIDER`（生产禁止 `fake`，已在 config.Validate 拒绝）
- 需填入：正式商户账户 + webhook secret
- fail closed：生产 `BILLING_PROVIDER=fake` 拒绝启动（已实现）

## OG-7 正式价格 / 退款政策 / 税务
- 配置入口：CatalogOffer 的 productId/planIds（商业信息，不进不可变 manifest）
- 需填入：正式价格表、退款政策、税务配置

## OG-8 隐私政策与服务条款法律定稿
- 现状：仓库不宣称已有可供生产托管服务使用的隐私政策或服务条款。
- 需填入：在收集用户数据或开放商业服务前，由 Owner 在确定的规范位置发布经复核的正式文本。

## OG-9 官方商标注册
- 现状：`TRADEMARKS.md` 仅规定名称和官方身份的使用边界，不声明注册状态。
- 需填入：如项目主张已注册商标，由 Owner 提供准确的权利人、司法辖区和注册信息。

## OG-10 私密安全报告渠道与响应范围
- 现状：`SECURITY.md` 指定 GitHub Private Vulnerability Reporting，但远端启用和实测仍是发布门禁。
- 需填入：维护负责人、支持版本、响应与披露范围；若另设安全邮箱，必须由 Owner 确认并实测。

---

## 生产启动占位检测（已实现的 fail-closed 清单）
- `ENVIRONMENT=production` + 静态 `ADMIN_TOKEN` 且非紧急模式 → 拒绝启动
- 生产缺 `DOWNLOAD_TOKEN_SECRET` → 拒绝
- 生产 `AUTO_APPROVE=true` → 拒绝
- 生产 `BILLING_PROVIDER=fake` → 拒绝
- 生产缺 `DATABASE_URL` → 拒绝
- 生产 `BASE_URL` 非 HTTPS → 拒绝
- 客户端更新 `--production` 遇 NOT-FOR-PRODUCTION 根 → 拒绝
- 客户端官方 TUF root 指纹仍为全零占位（OG-1）→ fail closed：任何源都不会被识别为官方；
  `trust::official_root_is_placeholder()` 可检测，诊断摘要（diagnostics.txt）显著呈现“官方徽章已禁用”
