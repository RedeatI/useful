# ADR-015：Action Contract 与共享运行时边界

- 状态：接受；原始 Phase 13 决策已落地并继续演进
- 日期：2026-08-02
- 决策范围：ActionDescriptor、manifest 兼容、执行内核、运行时 CLI、MCP 接口缝

## 当前状态（2026-08-08）

本 ADR 记录的是最初以 JSON、Base64、Hash 打通契约与执行器的架构决策，不是当前功能清单。现在同一
`ActionRegistry` 默认注册 36 个 Action（31 个 utility、5 个 Office family），runtime CLI 已提供
list/search/suggest/describe/run/recipe，stdio MCP 已提供这 36 个可调用工具以及
`useful.actions.search`/`describe`/`suggest`/`recipe` 4 个 helper。显式 Agent profile 会保留其 Action 数组顺序，
CLI search 的显式排序仍独立生效。

可选的 4 个媒体/进程 host Action 只有在 `--host-config` 校验通过后才注册；插件 Action 采用 ADR-017 的
签名声明式 pipeline，而不是本 ADR 早期的 publisher-hash ID 草案。Agent Kit 将 3 个命令入口与 regex/Office
两个 worker 构建成 5 个自包含 bundle，并随包保存 provenance 源码；它仍是 internal candidate。下面涉及
“当前”“未来”的表述应按 2026-08-02 的决策现场理解；后续演进以本节及 ADR-016～018 为准。

## 背景与源码实证

仓库当前存在两个名称相近但职责不同的 manifest：

| 事实源 | 当前消费者 | 版本/Schema | 身份和用途 | Action 现状 |
|---|---|---|---|---|
| `crates/useful-plugin/src/manifest.rs` 与同目录 `manifest.schema.json` | `.useful` 预检、解包、原子安装、Tauri 插件加载 | 数字 `schemaVersion: 1`，Draft-07，Rust 强类型二次校验 | `id` 是本地插件 ID；描述入口、权限、平台、侧栏 | `contributes` 只允许 `sidebar`，`additionalProperties: false` |
| `packages/protocol/schemas/package-manifest.schema.json` | TRP 发布/目录协议与协议测试 | 字符串 `schemaVersion: "1.0"`，2020-12 | 全局身份是 `publisher.keyId + toolId`；还含 build、files、license | 不含 `contributes` 或 action |

两者不是可互换的重复定义：前者是已安装运行包的宿主契约，后者是签名发布供应链的包描述。
当前 `.useful` 创建、安装和服务端测试仍大量生成数字 v1 manifest。用 TRP manifest 直接替换安装 manifest
会破坏既有 `.useful`、签名摘要、原子安装和 portable mode 语义。

当前 `packages/useful-cli/bin/useful.mjs` 是开发/签名/发布 CLI；
`packages/useful-sdk/src/index.ts` 是浏览器 `postMessage` SDK；原始决策现场的 28 个 utility 仅在
`apps/useful/src/lib/tools/registry.ts` 和 Vue 路径注册，当时都不是 headless ActionExecutor。当前 31 个 utility
已按本 ADR 的边界注册共享 descriptor 与 handler；本段保留的是 2026-08-02 的背景。

## 决策

### 1. ActionDescriptor 是单一语义层，不是第三套 package manifest

`packages/action-contract/src/action-descriptor.schema.json` 定义 ActionDescriptor v1，采用 JSON Schema
2020-12。manifest、内置 registry、用户 preset、CLI 和 MCP 只映射到同一个 descriptor；不得复制出
CLI-only 或 MCP-only action 定义。

稳定 identity：

- 内置：`builtin.<tool-scope>.<localActionId>`，例如 `builtin.utilities.json`。
- 签名插件：`publisher.<sha256(publisherKeyId)>.<toolId>.<localActionId>`。source 中仍保留完整、经安装
  来源验证的 publisher ID；不能信任插件自报 publisher。
- 本地未发布工具：`local.<installationUuid>.<localActionId>`；发布后创建新的 publisher identity，
  迁移由显式 alias/preset 迁移记录完成，不能静默冒充。

descriptor 包含版本、来源摘要、输入/输出 schema、examples/test vectors、执行模式与限制、行为注解、
权限/能力、敏感 JSON Pointer 和独立的 presentation hint。Action 语义不得依赖 Vue route。

### 2. manifest 兼容和迁移

1. 数字 v1 `.useful` 保持可安装；不改变既有字段、签名输入、路径检查或安装事务。
2. 后续在安装 manifest 的 `contributes` 中加入可选 `actions`。旧 v1 包继续通过；使用 actions 的新包
   声明更高 `minHostVersion`，旧 host 因未知字段 fail closed 是预期行为。
3. 安装期从 `publisherKeyId + toolId + contributes.actions[].localActionId` 归一化 ActionDescriptor；
   `entry.args` 永远不转换为 action 参数或用户 preset。
4. TRP package manifest 继续负责 publisher/build/files；发布校验额外核对包内 actions 与 catalog identity，
   不在 TRP 中创建第二份 action 业务定义。
5. manifest schema 的实际扩展必须在 Phase 13 所有者变更合并后单独实施，并同时更新 Rust 类型、CLI
   validate/pack、协议/安装负向测试与 minHostVersion；本切片不修改它。

### 3. Headless 执行内核与跨环境语义层

`ActionRegistry` 保存 descriptor 与显式 handler；`ActionExecutor` 是唯一 headless policy/enforcement point：

1. 解析稳定 actionId，拒绝未知或 `ui-only` action。
2. 在 handler 前执行确认、权限、能力、输入字节上限和输入 schema 校验。
3. 只把结构化 JSON 的深拷贝交给 handler；不拼接 shell、argv 或路径。
4. 统一超时/取消；同步 pure handler 还必须受输入上限约束，声明 `supportsCancellation: false`。
5. 在返回前执行输出字节上限和输出 schema 校验。
6. 产生不含输入/输出值的脱敏 receipt：action/contract version、source/publisher/digest、权限、耗时、
   status/error。敏感输入不得进入错误消息或日志。

GUI 不导入 Node-only executor。`packages/action-runtime/src/semantics.mjs` 是 browser-safe 共享语义层：
ActionDescriptor factory、输入/输出 schema、稳定错误码和 test vectors 只有一份；JSON/Base64 只有一个平台
中立 handler，Vue 包装器、文本 Worker 与 Node executor 都消费它。文本 Hash 使用同一 descriptor/test vectors，
但浏览器保留 Web Crypto adapter，Node runtime 保留 `node:crypto` adapter，并逐向量校验 digest 一致。
Node 的 provenance 文件读取只存在于 `builtins.mjs`，不进入 `@useful/action-runtime/browser` bundle。

`pure` action 不得声明权限、open-world、destructive 或 side effects。destructive action 必须确认。
用户 alias、defaults 和 preset 只能是 actionId/presetId 与经 schema 验证的 JSON 数据；任何 raw command、
raw flag、shell fragment 或对 `entry.args` 的覆盖均非法。

未来 worker 只能使用严格 framed JSON-RPC over stdio，固定可执行来源、有限生命周期、输出上限和能力
隔离；不得通过字符串拼接命令行实现。

### 4. 运行时 CLI 命名和协议

现有 `useful` 保持 developer CLI 身份。首切片使用独立包 `@useful/runtime-cli` 和二进制名
`useful-runtime`，避免让 GUI `Useful.exe` 承担 stdout 协议。最终发布名（`useful.exe` 或
`useful-runtime.exe`）在安装布局/升级/冲突审计后再定；在此之前不重命名现有 CLI。

CLI v1：

```text
useful-runtime actions list --json
useful-runtime actions search --query <text> --json
useful-runtime actions suggest --input @sample.txt --limit <n> --json
useful-runtime actions describe <id> --json
useful-runtime actions run <id> [--input @request.json|-] --output json
useful-runtime actions recipe --input @recipe.json [--validate-only] --output json
```

stdout 恰好写一个版本化 JSON 文档；日志只能写 stderr；禁止把 input 回显到错误。稳定退出码：

| code | 含义 |
|---:|---|
| 0 | 成功 |
| 2 | usage、JSON/schema 输入错误，或 handler 输出 schema 错误 |
| 3 | 未知 action |
| 4 | ui-only、权限或确认策略拒绝 |
| 5 | 超时或取消 |
| 6 | 输入/输出大小超限 |
| 70 | 未分类运行时/handler 故障 |

### 5. MCP 是薄适配器

`useful-mcp` 已按这一决策落地：它读取同一个 `ActionRegistry.listAgentEligible()`，把 descriptor 的
input/output schema 和行为注解映射到 SDK 的 tools/list 与 tools/call，然后调用同一个 executor。它不包含
模型、不复制 handler、不手写第二套业务错误模型。当前使用本地 stdio；HTTP、Tasks 和目录热刷新仍未实现。
4 个 helper 只查询或组合当前可见 registry，不是 Action，名称也保留给 Useful，插件 actionId/alias 不得占用。
`suggest` 只处理显式输入的最多 64 KiB 文本，不回显样本；同分按 canonical actionId 排序。
`useful.action-recipe.v1` 最多 16 步，只接受已暴露、canonical、只读、非破坏、幂等、closed-world、零权限、
零副作用 Action，并以 JSON Pointer 引用已完成输出，不提供脚本或插值。请求上限 1 MiB、中间值上限
8 MiB、整条 recipe 总超时 60 秒，每步仍受 descriptor timeout，运行结果包含逐步脱敏 receipt。

## 安全不变量

- 不引入 AI、模型调用、遥测或隐式网络。
- 不改变签名、publisher/source 固定、原子安装或 portable mode。
- schema 未知字段 fail closed；action schema v1 禁止外部 `$ref` 和不受支持关键字。
- Web UI/route 不是 headless handler；没有显式 handler 就不能由 CLI/MCP 运行。
- receipt 和公开错误只含结构化元数据，不含输入、输出、文件内容、Token 或 secret。

## 后果与后续

JSON、Base64、文本 Hash 是最初的窄闭环；现有 36 个默认 Action、Office/regex worker、CLI 查询与 recipe、stdio MCP、
Agent profile 与 GUI Tool Library 都沿用同一 descriptor/executor 边界。浏览器仍不运行 Node executor，
`useful-runtime` 仍是 Node 入口而不是 standalone Windows runtime。插件 `contributes.actions` 的受限签名
声明式实现见 [ADR-017](ADR-017-signed-declarative-plugin-actions.md)，Agent exposure 与 presets 的演进见
[ADR-018](ADR-018-tool-library-and-agent-profile.md)。MCP preset 虚拟工具、HTTP/Tasks 与 standalone EXE
仍需独立设计和验证。
