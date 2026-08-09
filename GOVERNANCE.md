# 项目治理 (GOVERNANCE)

> 草案，随社区成长调整。不构成正式法律意见。

## 范围

本治理文档覆盖开源部分：桌面客户端、内置基础工具、协议（TRP）、SDK、CLI、软件源后端
（source-server / source-worker）、管理后台与部署示例。官方运营资产（密钥、生产配置、
付费制品、用户数据）不在开源治理范围内（见 `TRADEMARKS.md`、`LICENSES.md`）。

## 决策与变更

- 架构级决策以 ADR 记录于 `docs/adr/`。破坏协议兼容性的变更需新的 ADR 与
  TRP 大版本（TRP v2）。
- 协议变更必须同时更新 `packages/protocol` 的 schema、OpenAPI、测试向量与一致性测试，且
  `pnpm --filter @useful/protocol test` 通过。

## 信任与安全治理

- 官方根信任由官方根公钥指纹确定，不由名称/域名确定（ADR-007/008）。
- 安全问题请按 `SECURITY.md` 私下报告，不在公开渠道披露未修复漏洞。
- 客户端更新信任域与工具源信任域严格分离（ADR-010），任何 PR 不得引入普通工具源更新客户端
  的能力；相关不变量由协议测试守护。

## 公开 ADR 索引

- [ADR-006: Federated repositories](docs/adr/ADR-006-federated-repositories.md)
- [ADR-007: Source-scoped identity](docs/adr/ADR-007-source-scoped-identity.md)
- [ADR-008: TUF trust model](docs/adr/ADR-008-tuf-trust-model.md)
- [ADR-009: Subscription without runtime DRM](docs/adr/ADR-009-subscription-without-runtime-drm.md)
- [ADR-010: Client update isolation](docs/adr/ADR-010-client-update-isolation.md)
- [ADR-011: API token RBAC](docs/adr/ADR-011-api-token-rbac.md)
- [ADR-012: Source availability](docs/adr/ADR-012-source-availability.md)
- [ADR-013: Sigstore identity](docs/adr/ADR-013-sigstore-identity.md)
- [ADR-014: Update key toolchain](docs/adr/ADR-014-update-key-toolchain.md)
- [ADR-015: Action contract and runtime boundary](docs/adr/ADR-015-action-contract-and-runtime-boundary.md)
- [ADR-016: Official MCP v2 stdio adapter](docs/adr/ADR-016-official-mcp-v2-stdio-adapter.md)
- [ADR-017: Signed declarative plugin actions](docs/adr/ADR-017-signed-declarative-plugin-actions.md)
- [ADR-018: Tool Library and Agent profile](docs/adr/ADR-018-tool-library-and-agent-profile.md)

## 贡献流程

见 `CONTRIBUTING.md`。开放贡献入口前，Owner 必须启用经过审核的 PR 工作流和分支规则；开放后，
PR 需通过 `.github/workflows/ci.yml` 规定的客户端、服务端与供应链检查。工作流文件存在本身不代表
远端检查已经启用或受保护。
