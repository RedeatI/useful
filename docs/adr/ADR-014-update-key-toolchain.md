# ADR-014: 客户端更新密钥工具链与开发/生产强隔离

- 状态：已接受（2026-07）
- 关联：ADR-008（TUF 信任模型）、ADR-010（客户端更新隔离）、scripts/useful.ps1

## 背景

Phase 10 的官方客户端更新根一直是开发占位，无法构成生产闭环。RC 要求完整
但不生成真实生产密钥的密钥工具链，且开发更新根与生产更新根必须强隔离，
生产配置无法静默使用测试密钥。

## 决策

`useful key` / `useful app-update` 子命令族（`packages/useful-cli/bin/appupdate`）：

- `key init-root / generate-role / sign-root / rotate-root / revoke / inspect /
  verify-ceremony`
- `app-update create / sign / verify`

关键机制：

1. **四环境分离**：development / test / staging / production。更新 manifest 的
   签名域 = `useful-app-update-v1\n<env>`，签名覆盖内容绑定环境；测试域签名
   在密码学上无法通过生产域验证。
2. **测试密钥标识**：非生产密钥落盘时同时写 `*.NOT-FOR-PRODUCTION` 标注文件；
   root.json 带 `notForProduction: true`。
3. **生产 fail closed**：`key verify-ceremony --production` 与
   `app-update verify --production` 遇到 `notForProduction` 根或非生产环境
   manifest 一律拒绝（退出码 1）。
4. **生产根是 Owner Gate**：`key init-root --env production` 不生成真实密钥，
   而是产出 `PRODUCTION-KEY-CEREMONY.md` 离线仪式清单；只有在隔离主机上、
   持有人到场、显式 `--owner-gate-acknowledged` 才继续。CI 只能用测试密钥。
5. **离线 root 签名 + threshold**：root.json 记录 `roles.root.threshold`；
   `sign-root` 由各持有人离线累积签名到阈值；`verify-ceremony` 校验阈值可满足
   且已累积签名有效。
6. **轮换与遗失恢复**：`rotate-root` 生成新密钥集、旧密钥进入 `revoked`、版本 +1、
   清空签名要求重签；`revoke` 撤销单个密钥。验证时拒绝已撤销密钥的签名。
7. **私钥卫生**：私钥绝不写日志（测试断言 console 输出不含 `PRIVATE KEY`/`BEGIN`）；
   落盘设 0600 并做权限检查（非 Windows）。
8. **更新 manifest 字段**：version / channel / artifactSha256 / length /
   minimumCompatVersion / publishedAt / signingDomain / rollback（allowed+minVersion）。

## 一键入口

`scripts/useful.ps1` 作为 Windows 权威入口，`release:dry-run` 全程用测试密钥
执行「干净构建 → SHA-256 → SBOM → 密钥仪式 → 签名 → 验证 → 生产隔离验证」，
并断言测试根被 `--production` 验证拒绝。其余脚本为薄封装。

## 影响

- 新增 `bin/appupdate/appupdate.mjs` + 11 个 spec 测试（全绿）。
- 新增 `rust-toolchain.toml` 固定 Rust 版本；`packageManager` 与 go.mod 已固定。
- 真实生产 TUF Root 创建、Windows 代码签名证书记入 docs/OWNER-GATES.md。
- 完整 Rekor 在线包含证明、HSM 集成记入 KNOWN-LIMITATIONS，不阻塞 RC。
