# ADR-016：官方 MCP v2 本地 stdio 薄适配器

- 状态：接受
- 日期：2026-08-02
- 范围：`packages/useful-mcp`、官方 SDK 版本、stdio 协议 era 与 Action runtime 映射

## 当前状态（2026-08-08）

本 ADR 的 stdio 薄适配器已经落地并沿同一边界扩展。默认 `tools/list` 现在返回 40 项：36 个 registry Action
（31 个 utility、5 个 Office family）以及 `useful.actions.search`、`useful.actions.describe`、
`useful.actions.suggest`、`useful.actions.recipe` 4 个只读、非破坏 helper。helper 只查询或编排当前 profile
可见集合，不进入 `BUILTIN_ACTIONS`；它们的名称也是插件 actionId/alias 的保留名。

显式 `--plugin-config`、`--agent-profile` 和 `--host-config` 都在 server 建立前完成校验。profile Action 数组顺序
会保留为 MCP 注册顺序。host pack 共 4 个可选 Action，但 MCP 只为实际加载且只读、非破坏、无需确认的
entry 授权，永不代替用户确认。Office/regex 使用固定可终止 worker，业务 handler 仍不复制进 MCP 包。
`suggest` 只分析调用方显式提供的最多 64 KiB 文本，不读剪贴板或回显样本；`recipe` 只接受最多 16 步的
`useful.action-recipe.v1`，整条 60 秒总超时，每步另受 descriptor timeout，并传播 MCP 取消信号。

## 现场复核

2026-08-02 复核了官方 TypeScript SDK 的
[2.0.0 releases](https://github.com/modelcontextprotocol/typescript-sdk/releases)、
[server guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md)、
[2026-07-28 migration guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md)
和 [`serveStdio` API](https://ts.sdk.modelcontextprotocol.io/v2/api/%40modelcontextprotocol/server/server/serveStdio.html)，
并下载、检查 npm 发布 tarball 的 exports、`.d.mts` 与运行时行为。

确认事实：

1. `@modelcontextprotocol/server@2.0.0`、`client@2.0.0` 已发布，两者均精确依赖
   `@modelcontextprotocol/core@2.0.0`。
2. 直接 `McpServer.connect(new StdioServerTransport())` 只服务 2025-era；同一入口兼容 2025-era 与
   `2026-07-28` 必须使用 `serveStdio(() => buildServer())`，且不得设置 `legacy: "reject"`。
3. `ToolCallback` 的 `ServerContext.mcpReq.signal` 是公开类型，因此可真实传给 `ActionExecutor.execute()`。
4. 官方迁移材料中关于 raw JSON Schema 的包归属与 `2.0.0` 发布制品不完全一致：发布制品从
   `@modelcontextprotocol/server` 导出 `fromJsonSchema`，从
   `@modelcontextprotocol/server/validators/ajv` 导出 `AjvJsonSchemaValidator`；
   `@modelcontextprotocol/core@2.0.0` 的 exports 只有根与 `./internal`，没有这两个公开导出。

第 4 点按发布制品的公开 exports 实现，不从 `core/internal` 导入，也不猜测未发布 API。

## 决策

- runtime 精确锁定 `@modelcontextprotocol/server: 2.0.0`，协议测试精确锁定
  `@modelcontextprotocol/client: 2.0.0`；二者把 `core: 2.0.0` 精确锁入 lockfile。
- 使用官方 `McpServer`、`fromJsonSchema`、`AjvJsonSchemaValidator` 与 `serveStdio`；不手写 wire protocol，
  不引入第三方 MCP server 框架。
- `buildServer()` 只遍历 `ActionRegistry.listAgentEligible()`；tool name 直接使用合法、稳定且已由 registry
  保证唯一的 `actionId`。title、description、input/output schema 与四个 hint 全部从 descriptor 映射。
- 普通 Action handler 只调用 `ActionExecutor.execute(actionId, input, { signal })`。Action handler、schema、错误码、limits
  和 test vector 不在 MCP 包复制。
- 成功只返回与 output schema 一致的 `structuredContent`，以及其 JSON 序列化 text fallback；不返回 receipt。
- `ActionExecutionError` 只返回 `isError: true` 与既有安全 code/message。未知异常统一降级为既有
  `ACTION_FAILED`；不返回输入、cause、path、stack 或 receipt。
- Ajv schema 预验证的细节由安全 wrapper 收敛为共享的 `INPUT_INVALID`/`OUTPUT_INVALID` code，避免 SDK
  的详细 validator 文本进入公开结果；最终安全门仍是 executor。
- 默认 `serveStdio` 同时接受 legacy 与 modern opening；stdio stdout 只承载协议帧。可选诊断只写 stderr。

4 个 helper 的 schema 与 handler 仍位于薄适配层：search/describe 只读取 profile-filtered registry；suggest
对显式样本执行本地确定性评分；recipe 调用共享 validator/runner 与同一 executor。recipe 只允许当前可见的
canonical、readOnly、non-destructive、idempotent、closed-world、零权限、零副作用 Action，以 JSON Pointer
引用已完成步骤，不允许脚本或插值；请求 1 MiB、中间值 8 MiB，结果返回逐步脱敏 receipt。

## 协议与错误面

官方高层 server 对未知 tool 返回协议级 `-32602`，而已经找到 tool 后的 executor 错误返回
`tools/call` 的 `isError: true`。测试分别固定这两个官方错误面，不能把未知 tool 伪装成业务执行错误。

官方 v2 client 的默认连接仍是 legacy。测试另外使用
`versionNegotiation: { mode: { pin: "2026-07-28" } }` 驱动同一真实 stdio 入口，因此不是手写握手或
仅检查源码字符串。

## 原始切片边界与后续演进

2026-08-02 的原始切片不包含插件 `contributes.actions`、worker RPC 或 Agent profile；这些部分后来分别按
ADR-017、ADR-018 和固定内建 worker 边界实现。Tasks、MCP Apps、HTTP、OAuth、prompts、resources、任意文件
访问、模型配置、AI/采样、standalone Windows runtime、Docker/Tauri 交付和发布授权仍不由本 ADR 实现。
