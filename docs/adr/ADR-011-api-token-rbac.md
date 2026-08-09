# ADR-011: 发布者与管理认证：API Token + RBAC 取代生产 X-Admin-Token

- 状态：已接受（2026-07）
- 关联：ADR-007（源内身份）、SECURITY.md、migrations/0003_identities.sql

## 背景

Phase 8/9 用单一 `X-Admin-Token`（常量比较）保护全部发布者与管理端点。
这在生产环境等价于"一把万能钥匙"：无角色区分、不可撤销、无审计主体、
泄漏后必须重启服务轮换。RC 前必须移除。

## 决策

1. **身份模型**：`identities`（user | service-account）+ 七个角色
   （instance-admin / source-admin / publisher-owner / publisher-maintainer /
   publisher-viewer / reviewer / security-reviewer），角色映射到固定 scope 集合，
   不允许 token scope 超出身份角色允许范围（权限不可提升）。
2. **API Token**：`usefuls_` 前缀 + 32 字节随机数。数据库只存 SHA-256 哈希；
   明文只在创建响应出现一次。有 scopes、过期时间（默认 90 天、上限 366 天）、
   可撤销、记录 last_used_at。轮换 = 新建 + 撤销旧 token。
3. **RBAC 门禁**：所有发布/撤回/公告/密钥轮换/审核/身份管理端点走
   `requireScope(scope)`，401（无凭据）与 403（缺 scope）分离。
4. **X-Admin-Token 只保留两个场景**：
   - `ENVIRONMENT=development`：本地/Compose 的 bootstrap 能力（用来创建首个
     身份与 API Token，之后走 Bearer）；
   - **紧急恢复模式**：`EMERGENCY_ADMIN_MODE=true` + `EMERGENCY_ADMIN_UNTIL`
     （RFC3339，≤ 24 小时）。默认关闭；生效时启动日志高亮；只授予
     `admin:identities` + `admin:tokens` 最小能力；每次访问写审计。
5. **生产 fail closed**：`ENVIRONMENT=production` 且设置了 `ADMIN_TOKEN` 而未显式
   启用紧急恢复模式时，进程拒绝启动（config.Validate）。
6. **初始化**：`source-server -init-admin` 幂等创建 instance-admin 并打印一次性
   API Token（stdout，不进日志）。Compose E2E 通过 dev bootstrap 换取真实
   API Token 后全程走 Bearer。
7. **审计**：撤回、公告、密钥轮换、审核、身份/令牌管理、紧急访问全部写
   append-only 审计日志；审计不记录 token 明文/哈希与完整下载 URL。

## 备选与取舍

- **浏览器会话 + CSRF 的管理后台**：当前仓库没有管理 Web UI，管理操作全部经
  CLI/API（Bearer header，无 cookie），CSRF 不适用。未来引入管理 UI 时必须使用
  HttpOnly/Secure/SameSite 会话 Cookie + CSRF Token，该要求已记入 SECURITY.md。
- **OIDC 登录**：发布者 CLI 已有源内 OAuth（Authorization Code + PKCE）签发的
  bearer 用于终端用户；将 OIDC 用于运维管理属于 Owner Gate（生产 IdP 配置），
  接口层已按 scope 抽象，接入不需改动端点。
- **Device Authorization Flow**：无浏览器环境可用 `-init-admin` + API Token 覆盖，
  Device Flow 作为可选适配器记入 KNOWN-LIMITATIONS，不阻塞 RC。

## 影响

- 迁移 0003（identities / api_tokens），回滚脚本见迁移文件头注释。
- 旧开发流程：`.env` 中 ADMIN_TOKEN 仅对 development 有效；生产部署文档改为
  `-init-admin` 流程。
- 所有 Go E2E 与 Compose E2E 已改走 API Token 真实认证路径，并含负向测试
  （401/403/撤销/过期/伪造/scope 提升）。
