# ADR-013: Sigstore 身份签名适配器（可选发布者签名，不替代 TUF）

- 状态：已接受（2026-07）
- 关联：ADR-008（TUF 信任模型）、ADR-011、SECURITY.md、migrations/0005

## 背景

发布者签名此前只支持长期 Ed25519 密钥。Sigstore（keyless / OIDC 身份签名）
可让发布者用工作流身份（如 GitHub Actions OIDC）签名，避免长期私钥管理。
但必须做真实验证——"存在一个有效证书"绝不等于"是这个发布者签的"。

## 决策

统一接口 `PublisherSignatureVerifier`：`VerifyEd25519` 与 `VerifySigstoreBundle`。
Sigstore 与 TUF 完全分离；Ed25519 发布者继续可用。

Sigstore bundle 验证链（全部为真实密码学，缺一即 fail closed）：

1. 从 bundle 解析签名证书（DER）。
2. 用配置的 **Fulcio CA 根**验证证书链，`CurrentTime` = 透明日志 integratedTime，
   要求 CodeSigning ExtKeyUsage → 证书有效期必须覆盖签名时间。
3. 从证书扩展提取 **issuer**（OID 1.3.6.1.4.1.57264.1.1）与 **SAN**（email/URI）。
4. 用证书公钥验证 **messageSignature** 覆盖 artifact 摘要。
5. **绑定**：bundle 的 messageDigest 必须等于当前 artifact 的 SHA-256。
6. **身份策略匹配**：issuer 精确匹配；SAN 精确优先，否则受控模式
   （仅允许单个 `*`，杜绝过宽正则导致身份冒充）。策略绑定到具体 Publisher。
7. **透明日志证明**：用配置的 **Rekor 公钥**验证条目时间戳签名（SET，覆盖
   logIndex + integratedTime + artifact 摘要 + 证书）。在线模式
   （RequireTransparencyLog=true）缺失即拒绝；离线模式通过但结果标注
   `TransparencyLogVerified=false`，二者差异明确。

其他要求：

- **默认 fail closed**：未配置 Sigstore 信任根（`SIGSTORE_TRUST_DIR` 为空）时
  Sigstore 验证一律失败，Ed25519 不受影响。
- **独立状态**：制品记录 `signatureMethod`（ed25519|sigstore）与
  `signatureIdentity`（issuer+subject）。catalog 与 UI 分别展示：
  Ed25519 发布者签名 / Sigstore 身份签名 / 软件源 TUF 签名 / 官方审核——
  四类信号绝不合并。
- **生产信任根属 Owner Gate**：Fulcio/Rekor 公共实例公钥由 TUF 分发并由运维
  预置，不在代码中内置。

## 负向测试（sigstore_test.go / release_sigstore_test.go）

身份冒充、错误 issuer、错误 digest（未绑定）、过期证书、非受信 CA、
缺失透明日志证明、篡改 SET、无信任根 fail closed、过宽模式匹配拒绝、
发布流程中身份不符被拒绝。正向覆盖 Ed25519 与 ECDSA 两种 Rekor 密钥。

## 影响

- 迁移 0005（publisher_keys 身份策略列 + artifacts 签名方式/身份列）。
- 本实现自包含（Go 标准库 crypto/x509），不引入外部 sigstore-go 依赖；
  bundle 字段对齐 Sigstore protobuf bundle 的关键子集。完整 Rekor 包含证明
  （Merkle inclusion proof）与在线 Fulcio 轮换记入 KNOWN-LIMITATIONS，
  当前 SET 证明已满足 RC 的离线可验证要求。
