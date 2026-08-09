# ADR-017：签名声明式插件 Action pipeline-v1

- 状态：接受；Phase AI-4 已实现
- 日期：2026-08-02
- 决策范围：`contributes.actions`、action spec、签名 bundle、显式配置、runtime CLI 与 MCP
- 取代范围：ADR-015 中“插件 actions 留待后续”及 publisher-hash actionId 草案；其余 ActionExecutor
  安全边界继续有效

## 当前状态（2026-08-08）

签名声明式插件链继续使用本 ADR 的三项 primitive allowlist（JSON、Base64、Hash）；“三项”只描述插件
pipeline 可以组合的固定积木，不是当前默认 Action 数量。默认 registry 现在有 36 个内建 Action，MCP 另有
`search`、`describe`、`suggest`、`recipe` 4 个 helper。对应的 4 个 `useful.actions.*` 名称都是保留名，
插件不能把任一名称用作 actionId 或 alias。Agent profile、Tool Library 和 presets 的后续边界见 ADR-018。

## 背景

现有 worker manifest/安装策略不是任意第三方代码的安全执行沙箱。Node `import`/`eval`/`vm`、
`child_process`、worker_threads、native EXE、script、WASM/WASI 都不能把未受信任插件代码变成安全 Action。
本阶段因此只允许插件用受限 JSON pipeline 组合已有、Agent-eligible、pure、零权限、closed-world 内建 Action。

## 决策

### 1. Legacy manifest 做 additive 扩展

数字 `schemaVersion: 1` 不变。`contributes.actions` 可选，最多 32 项，每项 exact shape：

```json
{ "actionId": "com.example.tool.base64-sha256", "path": "actions/base64-sha256.json" }
```

`path` 必须是包内唯一安全相对路径和普通 JSON 文件；`actionId` 使用 ActionDescriptor v1 语法并位于
`${manifest.id}.` 小写命名空间。旧 manifest、示例、安装和 CLI 默认模板继续通过。Rust/Node 共用
`fixtures/action-id-vectors.json`，明确后续 segment 可由数字开头（`.2fa`），任意大小写 actionId 非法。

### 2. 作者契约与可信派生分离

独立 schema 是 `useful.plugin-action.v1`，由共享包直接依赖的 Ajv 2020 编译并进入实际 validator；同一组
JSON 正/负向量同时经过 Ajv 与手写安全语义层，防止 schema 退化为文档或两层漂移。作者只声明
title/description/keywords/aliases、input/output schema、examples/testVectors、execution limits、presentation
与 pipeline。作者不能声明下列可信字段：

- `contractVersion="1.0"`；
- `version=manifest.version`；
- `source.kind="plugin"`、`source.toolId=manifest.id`；
- `source.publisher.id=已验证 sidecar publisherKeyId`；
- `execution.mode="pure"`、`handler="useful.pipeline-v1"`；
- 固定只读、non-destructive、idempotent、closed-world、无副作用、无需确认、零权限行为。

派生 descriptor 最后必须通过现有 ActionDescriptor v1 validator。`source.digest` 是完整作者 action spec
的 canonical JSON SHA-256：对象键递归排序、数组顺序保留、JSON primitive 按标准序列化，最终 UTF-8
hashing。artifact SHA-256 由签名 receipt 与 config pin 独立覆盖，避免循环摘要。

### 3. Pipeline 是 closed-world 数据求值，不是代码执行

- 最多 16 个按序步骤，step id 唯一。
- `actionId` 固定 allowlist：`builtin.utilities.json/base64/hash`。
- step input 与最终 output 只允许 JSON 常量，或 exact ref object
  `{ "$ref": "/input/..." }` / `{ "$ref": "/steps/<已完成 id>/output/..." }`。
- 引用采用受限 RFC6901；拒绝缺失、前向/自引用、循环、危险 pointer segment。
- 禁止动态 action ID、插件互调、表达式、字符串插值、`__proto__`/`constructor`/`prototype`、文件、
  网络、进程、环境变量和递归 pipeline。
- 作者声明的 actionId 和 alias 都不得占用 `useful.actions.search`、`useful.actions.describe`、
  `useful.actions.suggest` 或 `useful.actions.recipe`；签名和 publisher pin 不会把 helper 保留名变成可授权命名空间。
- 固定预算：template depth 32、nodes 4096、单模板 256 KiB、单次展开 1 MiB、累计中间值 4 MiB；
  action spec/descriptor 的 input/output/timeout 还有独立上限。
- evaluator 把 AbortSignal 传播给每个内建 ActionExecutor；输入和输出仍由内建与外层 descriptor schema 双检。
- 每个 action 至少一个 testVector；doctor、pack preflight 与签名 loader 都用同一 evaluator 实际运行，
  expectedOutput/expectedErrorCode 不匹配即不注册。

### 4. 共享归档/签名验证边界

`@useful/plugin-actions` 是 Node 共享边界；runtime/MCP 不 deep-import CLI bin 私有模块。它是 `.useful` limits、
安全 entry 读取、publisher signature payload/verify、manifest/action validation、pipeline evaluator 与配置 loader
的单一事实源。CLI `safe-zip`、publisher verify 和兼容的 `useful-limits.mjs` 都 re-export/消费该边界。

启动校验 archive 128 MiB、4096 entries、单 entry 64 MiB、总展开 256 MiB、manifest/action/sidecar/config
独立上限、路径与重复 entry；随后验证完整 legacy manifest v1、receipt domain/toolId/version/bytes/hash、
Ed25519 签名与两个显式 pin。只读取 manifest 和贡献的 action JSON，不提取或执行 web/worker/launcher。

### 5. 只接受显式配置

`useful.plugin-set.v1` 中每个 entry 必须包含安全相对 `artifactPath`/`signaturePath`、
`expectedPublisherKeyId`、`expectedArtifactSha256`。路径从配置文件目录解析；不扫描 AppData、数据库、
安装目录或 marketplace，不联网。所有 actionId 与 alias 对内建及所有插件做全局冲突检查，任一冲突使启动失败。

CLI 的唯一位置是：

```text
useful-runtime --plugin-config <file> actions <list|describe|run> ...
```

MCP 使用 `useful-mcp --plugin-config <file>`。不带配置时默认 36 个内建 Action 和现有 JSON/stdio 双 era
行为不变；MCP 还固定注册 4 个 helper，它们不属于插件 registry。
无效配置时 runtime 返回稳定 JSON code；MCP 在 server/工具注册前退出、stdout 为空、stderr 只含固定 JSON code。

## 安全后果

- publisher 身份、插件版本、provenance digest 与行为不能由作者伪造。
- 签名只说明 artifact 来自某 key；显式 publisher/hash 双 pin 才授予本次本地加载信任。
- testVectors 是加载门，不是抽样建议；失败不能选择性忽略或换样本。
- 错误与 receipt 不记录输入、输出、sidecar、config 或 archive 内容。
- 这是三项 utility primitive 的组合能力，不是任意第三方算法、代码 sandbox、native worker、GUI handler、
  自动 marketplace discovery 或 standalone runtime。

MCP/CLI 的 `useful.action-recipe.v1` 是用户侧临时编排，不是签名插件 pipeline：它可使用当前 profile 暴露且
满足 readOnly/non-destructive/idempotent/closed-world/零权限/零副作用条件的 canonical Action，最多 16 步，
请求 1 MiB、中间值 8 MiB、整条 60 秒总超时，每步仍受 descriptor timeout。两种格式都只允许 JSON Pointer
引用已完成步骤，不提供脚本或插值，但 recipe 不改变插件 artifact、publisher pin 或注册信任。

## 验证

权威 E2E 使用中文与空格临时路径，通过真实 CLI 创建/doctor/validate/pack/init/sign/verify，写双 pin config，
再由真实 runtime list/describe/run 与官方 MCP client legacy/`2026-07-28` tools/list+call 验证 output 与 provenance。
负向覆盖 artifact/sidecar/pin 篡改、archive traversal/entry/展开/entry-count budgets、malformed signed manifest、
action path/namespace/ID/alias、未知 builtin、forward/cycle、危险键、template/展开/中间预算、testVector/output
schema mismatch 与未知参数，全部 fail closed。

## 后续演进

GUI Tool Library 与独立 Agent profile/presets 已按 ADR-018 实现；未解析的插件 profile 条目仍只读保留，最终
信任和 handler 注册仍由显式 plugin-set 在 runtime/MCP 启动时验证。native worker sandbox、任意第三方算法、
自动 marketplace discovery 和 standalone EXE 仍需新的架构与安全门，不得从本 ADR 推断为已实现。
