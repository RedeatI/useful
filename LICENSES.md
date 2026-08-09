# 许可证映射 (LICENSES)

> 本文件复述根 `LICENSE` 的当前组件映射，**不扩展许可证授予，也不构成法律意见**。未明确列出的
> 路径必须先由项目所有者完成法律复核，不能由目录名或工程脚本推定。

Useful 包含开源客户端、开放协议、可自托管后端，以及规划中的官方订阅源。当前明确映射如下：

| 交付物 | 许可证 (SPDX) | 位置 |
| --- | --- | --- |
| 桌面客户端与客户端原生 Crate | MPL-2.0 | `apps/useful`、`crates/useful-*` |
| 内置 Action、宿主及文档处理实现 | MPL-2.0 | `packages/action-runtime`、`packages/host-actions`、`packages/office-core` |
| 软件源后端、管理后台、共享实现、迁移与部署资产 | AGPL-3.0-or-later | `services/source-server`、`services/source-worker`、`services/internal`、`services/migrations`、`services/Dockerfile`、`services/OPERATIONS.md`、`services/go.mod`、`services/go.sum`、`apps/source-admin`、`deploy/*` |
| 协议、Schema、SDK、CLI 与 Agent 接口 | Apache-2.0 | `packages/protocol`、`packages/action-contract`、`packages/agent-profile`、`packages/agent-integrations`、`packages/computer-use-contract`、`packages/plugin-actions`、`packages/useful-sdk`、`packages/useful-cli`、`packages/useful-mcp`、`packages/useful-runtime` |
| 静态源与示例 | Apache-2.0 | `repositories/*`、`examples/*` |
| 项目文档 | CC-BY-4.0 | `docs/*`、`README.md`、`README.zh-CN.md`、`AGENTS.md`、`CONTRIBUTING.md`、`GOVERNANCE.md`、`SECURITY.md`、`CODE_OF_CONDUCT.md` |
| 其余第一方非独立组件的自动化、配置、构建元数据与测试夹具 | Apache-2.0 | `.github/*`、`scripts/*`、`config/*`、`fixtures/*`、`templates/*`、`binaries/*` 及未被上表覆盖的根构建文件 |

## 说明

- 不修改已有第三方依赖的许可证；第三方组件许可见 `THIRD_PARTY_NOTICES.md`。
- `package.json` 或 `Cargo.toml` 中的 SPDX 字段不能替代根组件映射；两者必须同时一致。
- 后端采用 AGPL-3.0-or-later。修改版若允许用户通过网络与之交互，应依许可证第 13 条向这些用户
  提供该版本的 Corresponding Source；具体义务以许可证正文和精确候选法律复核为准。
- 客户端采用 MPL-2.0（文件级 copyleft），便于与不同许可的插件/宿主集成。
- 新增 package 或 service 根目录不能依赖兜底规则，必须先在本表和发布检查的闭集中显式登记。
- `packages/agent-integrations` 与 `packages/computer-use-contract` 是 Apache-2.0 的协议与 Agent
  集成契约层；后者不声明或提供可执行的 Computer Use 自动化能力。
- `LICENSE`、`LICENSES.md`、`NOTICE`、`THIRD_PARTY_NOTICES.md`、`TRADEMARKS.md` 与
  `licenses/*` 保留各自声明用途和条款，不由上表重新许可。

## Owner 决策状态

上述路径到 SPDX 的组件映射已由 Owner 于 2026-08-09 确认，并同步到根 `LICENSE`、本文件、
`NOTICE` 与 package/Crate 元数据闭集。该决策只关闭“路径未映射”门禁，不代表对某个候选快照完成
法律意见、第三方许可证复核、发布授权、签名或公开仓操作；这些证据仍须针对最终候选单独完成。

## 官方商业服务的开源边界

开源：source-server / source-worker 代码、数据库迁移、协议、SDK、BillingProvider 接口、
参考支付适配器、部署示例、管理后台、静态源生成器。

不进入仓库（不属于开源交付物）：官方 root 私钥、targets 私钥、生产 KMS 凭据、支付密钥、
用户数据、生产数据库、私有工具包、付费制品对象、CDN 凭据、正式风控名单、生产环境配置。

详见根 `LICENSE`、`services/source-server/LICENSE`、`services/source-worker/LICENSE` 与
`TRADEMARKS.md`；不是每个目录都重复放置许可证正文。

## 标准许可证正文

仓库在 `licenses/` 提供完整许可证正文，供对照 SPDX 标识符：

| SPDX | 文件 |
| --- | --- |
| MPL-2.0 | `licenses/MPL-2.0.txt` |
| Apache-2.0 | `licenses/Apache-2.0.txt` |
| AGPL-3.0-or-later | `licenses/AGPL-3.0-or-later.txt` |
| CC-BY-4.0 | `licenses/CC-BY-4.0.txt` |

根 `LICENSE` 是 owner 已提供的版权/映射声明；`licenses/*.txt` 是对应许可证正文，不能替代该声明。
最终公开前仍需针对精确候选快照完成法律与第三方依赖复核。
