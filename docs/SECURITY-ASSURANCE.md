# 安全保证（Security Assurance）

简体中文 · [English](SECURITY-ASSURANCE.en.md)

> 从攻击者与运维视角记录已实现的防御与对应证据。配合 SECURITY.md 与 ADR-008/011/012/013/014。

## 信任链分层（绝不合并为单一 safe 布尔）
1. **软件源 TUF 签名**：root（离线，阈值）→ targets/snapshot/timestamp（在线密钥）。
   保证"这个源确实发布了这些字节"。metadata 过期/回滚/篡改在客户端拒绝（Rust tuf 测试）。
2. **发布者签名（当前首发/安装能力）**：仅接受独立可验证的 Ed25519 proof，覆盖
   (toolId, version, sha256)，保证"这个制品确实由某发布者产出"。与 TUF 分离。
   Sigstore 仍是隔离验证与未来接入方向；当前首发、TUF、下载授权和安装路径均拒绝
   Sigstore。legacy 或空 proof 同样 fail closed，必须显式重新发布（或待建成的审计复验），
   不会自动迁移。
3. **官方审核 / 安全扫描 / 复现构建 / 源可用性**：各自独立状态字段，UI 分别展示。

## 认证与授权（ADR-011）
- API Token：`usefuls_` + 32 字节随机；**数据库只存 SHA-256**，明文只返回一次；
  常量时间比较；有 scopes/过期/撤销/last_used。
- RBAC：七角色 → scope 集合；token scope 不得超出身份角色（**权限不可提升**，已测）。
- 401（无凭据）与 403（缺 scope）分离；匿名访问发布端点被拒。
- 生产 fail closed：静态 `ADMIN_TOKEN` 拒绝启动，除非紧急恢复模式（≤24h、审计、
  仅身份/令牌管理最小能力）。
- 敏感操作（撤回/公告/密钥轮换/审核/身份令牌管理/紧急访问）写 append-only 审计；
  审计**不记录 token 明文/哈希、完整下载 URL、用户文件路径**。

## Sigstore 身份验证（ADR-013，隔离验证/未来方向；非当前首发能力）—— 攻击者视角
- 身份冒充（合法 CA 但错误 SAN）→ 拒绝
- 错误 issuer → 拒绝；错误/未绑定 digest → 拒绝
- 过期证书（签名时间不在有效期）→ 拒绝
- 非受信 CA → 链验证失败拒绝
- 缺失透明日志证明（在线模式）→ 拒绝；篡改 SET → 拒绝
- 过宽 SAN 模式（多个 `*`）→ 拒绝（受控匹配）
- 无信任根 → fail closed
- 畸形 bundle（fuzz）→ 不 panic、不误判通过

## 复现构建（ADR-013 相关）—— 防伪造
- 仅作者声明（manifest reproducible=true）→ 状态 `claimed`，**绝不** verified
- 双构建：两次摘要不一致/与制品不绑定/同一构建器 → failed
- provenance：签名无效/错误 builder/摘要不绑定/参数不符 → failed
- catalog `reproducibleBuildVerified` 仅在真实 verified 时为 true

## 源可用性（ADR-012）—— 防 SSRF/请求风暴
- 检查目标只能是本源内容寻址存储键，**永不接受用户输入 URL**（结构性防 SSRF）
- HEAD-only（不下载大文件）；每轮限额 + 新鲜跳过（防风暴）
- 过期结果显示 unknown，不沿用旧 healthy；错误类别不泄漏路径

## 更新密钥隔离（ADR-014）
- 四环境签名域分离；测试域签名在密码学上无法通过生产验证（已测）
- 生产验证拒绝 NOT-FOR-PRODUCTION 根；生产根创建是 Owner Gate
- 离线阈值签名；撤销密钥的签名被拒；私钥不落日志、落盘 0600

## 传输与输入
- 每 IP 限流；请求体上限；problem+json 统一错误（不泄内部细节）
- panic recover → 500；metadata 名/target 路径严格白名单校验（防路径穿越）
- 付费下载 subject 只来自校验过的 bearer，绝不信任请求体
- Windows 一键提权默认并明确禁用（`canRequest=false`）：便携版和用户可写安装无法证明
  延迟重启期间镜像身份不被替换。需要 ETW/受保护进程权限时，用户必须退出后从 Windows
  外壳手动选择“以管理员身份运行”；应用不会调用 PowerShell 或可替换的同目录 helper。

## 供应链
- Go 原生 fuzz（域校验器、Sigstore bundle）数百万 execs 无崩溃，无 crash corpus
- SBOM 生成（scripts/gen-sbom.mjs → dist-sbom/sbom.cdx.json）
- 迁移用 advisory lock 串行化（防并发建表冲突）
- 依赖固定：packageManager（pnpm@9.15.0）、rust-toolchain.toml（1.97.1）、go.mod

## 待加固（不阻塞 RC，见 KNOWN-LIMITATIONS）
- 完整 Rekor Merkle inclusion proof、在线 Fulcio 轮换
- GitHub Actions 固定到 commit SHA、容器镜像漏洞扫描、cargo audit/deny 全接入 CI
