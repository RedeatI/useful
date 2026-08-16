# ADR-019：Useful Execution Receipt v2 语义与 surface 边界

- 状态：接受（spike）
- 日期：2026-08-16
- 范围：`packages/action-contract`、`packages/action-runtime`、runtime CLI、`packages/useful-mcp`
- 不在范围：桌面 Run Center UI、SQLite migration、桌面 run history、`apps/useful`、`crates/useful-core/db.rs`

## 背景

现有 Node executor/CLI 返回 metadata-only `receiptVersion: "1.0"` receipt，recipe 保存每步 receipt；普通 MCP
Action 按 ADR-016 只返回业务 output。GUI 当前不使用 Node executor，也没有 run history。因此本 ADR 统一的是
跨 surface 的 receipt 语义，不是让 GUI、CLI、MCP 共享桌面 SQLite 或持久化实现。

隐私边界是协议的一部分。Receipt 不得包含 raw input/output、剪贴板、文件内容、绝对路径、token、stack、
cause，也不得保存敏感输入 digest。允许保存的 digest 只有 descriptor 已验证的 action source digest。

## 决策

### Canonical v2

Canonical receipt 使用 `receiptVersion: "2.0"`，字段闭集如下：

- action identity：`actionId`、`actionVersion`、`contractVersion`；
- provenance：闭合的 `source.kind/toolId/publisher/digest`；
- policy requirements：`permissions.required` 与 `permissions.capabilities`，不保存调用方 token、授权凭据或输入；
- lifecycle：`status`、`createdAt`，并按状态选择 `startedAt`、`completedAt`、`durationMs`；
- failure：仅 `error.code`，不保存 message、issues、stack 或 cause。

状态机字段规则：

| status | 必须字段 | 禁止字段 |
| --- | --- | --- |
| `queued` | `createdAt` | `startedAt`、`completedAt`、`durationMs`、`error` |
| `running` | `createdAt`、`startedAt` | `completedAt`、`durationMs`、`error` |
| `success` | 全部时间字段、`durationMs` | `error` |
| `error` | 全部时间字段、`durationMs`、`error.code` | 任意错误正文 |
| `cancelled` | 全部时间字段、`durationMs`、`error.code=CANCELLED` | 任意错误正文 |

Node executor 当前同步进入执行阶段，因此只产生 terminal v2 receipt；`queued`/`running` 是未来 GUI/长任务 host
可以使用的同一 canonical snapshot 语义，不代表本 spike 已实现队列或桌面持久化。

### v1 读取兼容与失败关闭

`parseExecutionReceipt()` 最多读取 64 KiB。它接受严格 v2，或严格的现有 v1 terminal receipt 并升级为 v2：

- v1 `permissions: string[]` 映射为 v2 `permissions.required`，`capabilities` 为空；
- `createdAt = startedAt`；`completedAt = startedAt + durationMs`；
- identity、source、status 和稳定 error code 保留。

v1 未知字段仍被拒绝，不“修复”缺字段。损坏 JSON、非 JSON、隐私/路径字段、非法状态组合分别统一为安全的
`RECEIPT_INVALID`；超过上限为 `RECEIPT_TOO_LARGE`；任何非 `1.0`/`2.0` 版本为
`RECEIPT_VERSION_UNSUPPORTED`。错误对象不回显原文或 cause。Canonical writer 只写 v2，不继续生成 v1。

### Surface 差异与持久化

- Executor：返回 `{ output, receipt }`，ActionExecutionError 只附 terminal receipt；稳定错误码保持现有集合。超时是
  `status=error/code=TIMEOUT`，取消是 `status=cancelled/code=CANCELLED`，权限拒绝与输出超限分别使用
  `PERMISSION_DENIED`、`OUTPUT_TOO_LARGE`。
- CLI：为兼容现有调用，JSON stdout 继续内联 metadata-only receipt。只有显式 `actions run --receipt-out <file>`
  才落盘；不扫描目录。写入在目标目录创建 mode 0600 临时文件、flush 后以 hard-link 原子发布，目标已存在则
  `RECEIPT_OUTPUT_EXISTS`，永不覆盖。成功与已有 receipt 的执行失败都可显式落盘。
- Recipe：继续在业务编排结果中保存逐步 metadata-only receipt；本 spike 不增加 recipe sidecar。
- MCP：固定 `@modelcontextprotocol/server`/`client`/`core` 2.0.0。普通 Action 的 `structuredContent`、text fallback
  和 `outputSchema` 仍只包含业务 output；canonical receipt 放在结果 `_meta["io.useful/execution-receipt"]`。
  MCP 不隐式写桌面数据库。未知异常仍降级为无 receipt 的 `ACTION_FAILED`。
- GUI：未来可自动持久化 metadata-only canonical receipt，但存储位置、retention、Run Center 与 migration 不由本
  ADR 实现，也不得从 CLI/MCP 推断共享桌面 SQLite。

## MCP 可行性证据与限制

固定发布制品 `@modelcontextprotocol/core@2.0.0` 的 `ResultMetaObjectSchema` 是 loose object，允许 namespaced
implementation key 通过；`CallToolResult` 继承该 result `_meta`。官方 2.0.0 Client、Server 和
`InMemoryTransport` 的真实 request/result 往返验证了 receipt `_meta` 可见，同时 `tools/list` 的普通 Action
`outputSchema` 不含 receipt。

真实 stdio legacy 与 pinned `2026-07-28` 测试代码也固定了相同断言，但本 spike 的受限执行现场禁止 Node 20
测试进程再启动 Node 子进程：原始表现是 `spawnSync ... EPERM`，stdio Client 随后得到 `CONNECTION_CLOSED`/
`ERA_NEGOTIATION_FAILED`。本 ADR 不把该现场限制伪装成已验证；Windows 与真实 Agent host 必须重跑现有 stdio
协议测试。若真实 host 证明任一 era 丢弃 implementation `_meta`，回退方案是新增显式、只读的
`useful.actions.receipt` helper，以调用方提供的短期 opaque execution id 查询同一 canonical receipt；不得把
receipt 加入每个业务 Action 的 outputSchema，也不得隐式写桌面数据库。本 spike 不实现回退 helper。

## 测试合同

实现测试覆盖：JSON Schema 2020-12 严格编译、manual/schema validator 对照、v1 升级、五种状态、未知/损坏/
超限失败关闭、secret sentinel、绝对路径、raw input/output/stack/cause 注入、成功、稳定错误码、超时、取消、
权限拒绝、输出超限、CLI 原子 no-overwrite，以及 MCP 2.0.0 `_meta`/`outputSchema` 隔离。

## 后续未解决项

1. 在 Windows 与真实 Agent host 重跑 CLI 子进程、hard-link 原子发布、stdio legacy 和 pinned
   `2026-07-28`；记录 NTFS、杀进程和取消行为。
2. Office 长任务需要定义 host 生成的 queued/running snapshot、进度关联、跨进程取消与 crash terminalization；
   本 spike 只定义状态合同。
3. GUI descriptor 信任元数据（验证时间、profile/source/publisher pin 的展示与持久化字段）尚未决定，不能用
   receipt source 字段替代完整 trust decision。
4. 市场切片下一步：先把 v2 reader/writer 和显式 CLI sidecar 作为 headless/Agent integration 能力发布验证，
   再以真实 MCP host 的 `_meta` 兼容矩阵决定保留 `_meta` 或启用显式 helper；最后另立 GUI persistence/Run Center
   ADR 和 migration 计划。
