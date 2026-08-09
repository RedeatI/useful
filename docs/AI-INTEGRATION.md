# 外部 Agent 调用 Useful（GUI profile / 开发态 CLI / MCP）

外部 Agent 可通过 `useful-runtime` JSON CLI 或本地 stdio `useful-mcp` 调用同一个
`ActionRegistry` / `ActionExecutor`。Useful 不包含模型、不读取模型配置、不采样，也不会替 Agent 联网。

无插件配置时，默认 registry 公开 36 个可调用的内建 Action：31 个 `builtin.utilities.*` utility Action，
以及下面 5 个 Office action family：

| Action ID | 操作范围 |
| --- | --- |
| `builtin.office.docx` | `compose`、`extract`、`inspect`、`to-markdown`、`from-markdown` |
| `builtin.office.pptx` | `compose`、`extract`、`inspect`、`to-markdown`、`from-markdown` |
| `builtin.office.spreadsheet` | XLSX/CSV 组合、提取、检查与双向转换，以及简单 Markdown 表格转换 |
| `builtin.office.pdf` | `inspect`、`merge`、`split`、`extract-pages`、`delete-pages`、`reorder`、`rotate`、`sanitize` |
| `builtin.office.markdown` | 解析 Markdown 大纲，或生成简单 DOCX/PPTX |

36 的口径来自 31 个 `ACTION_IDS` 与 5 个 `OFFICE_ACTION_IDS`，二者都组装进默认
`BUILTIN_ACTIONS`。MCP 另有 `useful.actions.search`、`useful.actions.describe`、
`useful.actions.suggest`、`useful.actions.recipe` 4 个 helper，不计入这 36 个 Action；默认
`tools/list` 因此是 40 项。

插件 actionId 和 alias 不能使用上述 4 个 `useful.actions.*` helper 名称。它们由 MCP 接口保留，签名、
publisher pin 或 profile 都不能覆盖这条命名边界。

可选的 `--plugin-config` 只加载签名 `.useful` 中的 `useful.plugin-action.v1` 声明式 pipeline。它不是插件
代码沙箱：runtime/MCP 不 import/eval 插件内容，也不允许插件要求启动 worker/native/script/WASM/WASI；
插件的 web、worker 或 launcher entry 同样不会被读取。内建 Office Action 使用的固定 worker adapter 不会
扩大这条插件边界。

## 显式信任配置

配置必须是 `useful.plugin-set.v1`，所有路径相对配置文件目录解析，并同时 pin publisher key 与 artifact：

```json
{
  "schemaVersion": "useful.plugin-set.v1",
  "plugins": [
    {
      "artifactPath": "artifacts/com.example.tool-1.0.0.useful",
      "signaturePath": "artifacts/com.example.tool-1.0.0.useful.publisher-signature.json",
      "expectedPublisherKeyId": "ed25519:<64-lowercase-hex>",
      "expectedArtifactSha256": "<64-lowercase-hex>"
    }
  ]
}
```

配置不会触发 AppData、数据库、Tool Library 或 marketplace 自动发现。启动会先验证 archive bytes/entries/
entry/展开预算、路径、manifest v1、receipt 域/身份/大小/摘要/Ed25519 签名、双 pin、action spec、pipeline、
descriptor、testVectors，以及全局 actionId/alias 冲突。任一步失败都在暴露任何插件工具前 fail closed；错误
只含稳定 code，不回显配置、sidecar 或 archive 内容。

## 独立 Agent profile

`useful.agent-profile.v1` 不是 manifest，也不承担 artifact 信任。缺省 profile 时，runtime/MCP 的现有
list/search/suggest/describe/run/recipe 与 36 个内建 Action 暴露完全不变；显式 profile 是 allowlist，只保留
surface enabled 且 contract/action version/source kind/publisher identity pin 全匹配的 registry Action。处理顺序固定为：

1. 构造内建 registry；若有 `--plugin-config`，先验证签名 receipt、publisher/artifact 双 pin 与 pipeline-v1；
2. 编译并验证 profile JSON Schema 2020-12、大小/数量/深度/危险键/表达式约束；
3. 对已受信 registry 校验 profile identity/version/publisher pin，再分别过滤 CLI 或 MCP。

未知/stale/pin mismatch 会在启动时失败而非静默跳过。profile 不保存 artifact digest，因为 AI-4 plugin-set
已经 pin 完整 artifact，Action descriptor 的 source digest 也由验证后的 action spec 派生；重复 digest 会混淆
“artifact 可信”与“用户允许暴露”两种职责。
profile 中的 Action 数组顺序会保留到 CLI `actions list` 与 MCP 工具注册顺序；`actions search` 的显式
relevance/actionId/title/category 排序仍以查询参数为准。

```json
{
  "schemaVersion": "useful.agent-profile.v1",
  "profileId": "default",
  "name": "本地 Agent allowlist",
  "actions": [{
    "actionId": "builtin.utilities.base64",
    "expectedContractVersion": "1.0",
    "expectedActionVersion": "1.0.0",
    "expectedSourceKind": "builtin",
    "expectedPublisherId": "useful.project",
    "enabled": { "cli": true, "mcp": true },
    "aliases": ["b64-encode"],
    "presets": [{
      "presetId": "encode",
      "name": "UTF-8 编码",
      "defaults": { "operation": "encode" }
    }]
  }]
}
```

profile exact-key 且有总 action/alias/preset、单项/总 bytes、depth/node 上限。禁止危险键、插值/表达式、raw
command/flags/argv/env/path/entry.args/launcher target/工作目录/路径模板。preset defaults 只允许 input schema
已知的顶层字段，并逐值校验；允许暂缺 required 字段。descriptor `sensitive.input` 指向字段及祖先/后代不能
保存，因此当前 `/text` 每次都必须由调用输入提供。调用输入覆盖 defaults，合并后仍由 ActionExecutor 完整验证。

## Runtime CLI

`--plugin-config` 与 `--agent-profile` 都是可选全局参数，各最多一次、都必须位于 `actions` 之前；两者顺序
可互换，但内部信任顺序仍是 plugin registry 在前、profile 过滤在后：

```powershell
node packages/useful-runtime/bin/useful-runtime.mjs actions list --json
node packages/useful-runtime/bin/useful-runtime.mjs actions search --query office --category office --sort action-id --json
node packages/useful-runtime/bin/useful-runtime.mjs actions suggest --input @sample.txt --limit 5 --json
node packages/useful-runtime/bin/useful-runtime.mjs actions describe builtin.office.docx --json
node packages/useful-runtime/bin/useful-runtime.mjs actions run builtin.office.docx --input @request.json --output json
node packages/useful-runtime/bin/useful-runtime.mjs actions recipe --input @examples/action-recipes/json-base64.json --validate-only --output json
node packages/useful-runtime/bin/useful-runtime.mjs actions recipe --input @examples/action-recipes/json-base64.json --output json
useful-runtime --plugin-config "C:\ABSOLUTE\plugin-set.json" actions list --json
useful-runtime --plugin-config "C:\ABSOLUTE\plugin-set.json" actions describe com.example.tool.base64-sha256 --json
'{"text":"abc"}' | useful-runtime --plugin-config "C:\ABSOLUTE\plugin-set.json" actions run com.example.tool.base64-sha256 --output json
useful-runtime --plugin-config "C:\ABSOLUTE\plugin-set.json" --agent-profile "C:\ABSOLUTE\profile.json" actions list --json
useful-runtime --agent-profile "C:\ABSOLUTE\profile.json" actions describe b64-encode --json
useful-runtime --agent-profile "C:\ABSOLUTE\profile.json" actions run b64-encode --preset encode --input @request.json --output json
```

成功的 run receipt 包含经验证派生的 `source.kind=plugin`、publisher key identity 与 canonical action-spec
digest，但不含输入/输出值。未知配置参数、pin mismatch、签名或 testVector 失败使用稳定 JSON 错误并返回非零。
CLI alias 只来自显式 profile，不继承 descriptor aliases；alias 只解析到已注册 handler。MCP 不接受 alias，
始终以 canonical action identity 注册，避免工具名漂移。本阶段 presets 只在 CLI/GUI 完成，不创建 MCP 虚拟工具。

`actions search` 要求 `--json`，支持 `--query`、source/category/execution/read-only/idempotent 过滤、稳定排序、
`--limit` 与 cursor 分页；查询范围始终是当前 registry/profile 真正暴露的 Action。CLI 的
`--input @request.json` 只负责读取 JSON 请求包，不会把请求包内的 Office 文件路径解释为可访问资源。

`actions suggest` 要求调用方用 `--input @file|-` 显式提供文本，并要求 `--json`。输入最多 64 KiB，只在
本地内存中分析，不会自动读取剪贴板、文件选择器或应用输入历史，也不会在结果或错误中回显样本。
推荐先按当前 profile 过滤，再按内容评分；分数相同则以 canonical `actionId` 确定性排序。

`actions recipe --input @recipe.json [--validate-only] --output json` 读取
`useful.action-recipe.v1`。`--validate-only` 只验证并返回计划；执行结果包含最终 output 与每一步的脱敏 receipt。
完整 recipe 最多运行 60 秒，每一步仍同时受其 Action descriptor timeout 约束。

## MCP 发现工具

MCP 除逐个注册当前 profile 允许的 Action 外，还注册 4 个只读、非破坏 helper：

- `useful.actions.search`：在当前暴露集合中按关键词、来源、分类、执行模式、只读/idempotent 属性查询，
  并提供确定性排序和 cursor 分页；
- `useful.actions.describe`：返回一个当前可见 Action 的完整 descriptor 与输入/输出 schema。
- `useful.actions.suggest`：对调用方显式提供、最多 64 KiB 的文本做本地确定性推荐，不回显样本；
- `useful.actions.recipe`：验证或执行闭集 `useful.action-recipe.v1`，并把 MCP 取消信号传播到整条 recipe。

这些 helper 不会绕过 profile，也不会让被过滤的 Action 重新可见。它们是 MCP 工具，不是 Action registry
成员，因此完整默认 MCP surface 是“36 个 callable Action + 4 个 helper”。

## Recipe 执行边界

- recipe 最多 16 个按序步骤；每一步必须使用当前 profile 可见的 canonical actionId，alias 不接受。
- 可调用 Action 必须同时为 readOnly、non-destructive、idempotent、closed-world、无需确认、零权限、零
  capability、零副作用；host Action 和随机生成类 Action 不会因为可见就自动变成 recipe 候选。
- step input 与最终 output 只允许 JSON 常量或 exact `{ "$ref": "..." }` 对象。Pointer 只能指向
  `/input/...` 或 `/steps/<已完成 id>/output/...`；前向/自引用、字符串插值、表达式和脚本均拒绝。
- recipe JSON 请求最多 1 MiB，单次模板展开最多 1 MiB，累计中间值最多 8 MiB。整条 recipe 总超时
  60 秒，每步还受自己的 descriptor timeout；任一限制、取消或步骤错误都会停止后续步骤。
- receipt 不含输入/输出正文；运行结果只在最终 output 中返回 recipe 明确选择的数据，并为每一步附带
  脱敏 execution receipt。可复制示例见 [`examples/action-recipes/`](../examples/action-recipes/README.md)。

## GUI profile

设置 → “AI 与 Agent”使用 `@useful/action-runtime/browser` 的同一组内建 descriptor/input schema，按 descriptor
生成可编辑的内建 Action 列表。GUI 使用的全零 digest 仅是 browser schema 模板占位，不显示、不持久化、
也不构成 provenance。
插件 descriptor 不会从 AppData/安装目录猜测：已有 plugin profile 条目原样保留为只读“需由 runtime config
验证”。“保存”只把 canonical JSON 写入 SQLite；用户还必须显式点击“导出 profile”，才会原子替换应用数据
目录下固定的 `agent/useful.agent-profile.v1.json`。CLI/MCP 只读取 `--agent-profile` 指向的文件，不会读取
SQLite。GUI 不接受任意写路径，不保存输入历史/token，也不会自动修改任何 Agent 宿主配置。

## Office 执行、文件与隐私边界

- Office Action 只接受闭集 JSON 字段；文件内容必须是 strict canonical Base64，不接受任意文件路径、URL、
  shell 参数或环境变量。单个输入 Base64 字段最多 6,000,000 个字符，Action 输入/输出 JSON 预算分别为
  8 MiB/16 MiB，单个返回二进制最多 8 MiB。
- 每次 Office 调用使用单次 Node worker thread；超时、`AbortSignal` 或结束时会终止 worker。worker 边界只
  返回 schema 输出，二进制输出带 `sizeBytes` 和 SHA-256，失败跨边界只保留稳定错误 code。
- OOXML ZIP 在读取 XML 前检查路径、重复项、entry 数、展开量、压缩比与单 part 大小。代码不执行宏、
  外部 relationship、嵌入对象或脚本；Spreadsheet 公式作为数据返回而不求值，CSV 输出默认转义公式型内容。
- PDF 操作不执行脚本、不做 OCR、也不调用远程服务。`sanitize` 会移除完整 trailer `Info`、持久化 `ID`、
  Catalog/Page 上的 XMP `Metadata` 与已知主动内容入口（包括 OpenAction、AA、Names、AcroForm、Annots、
  嵌入文件关联和页面转场），再把已经清理的页面图复制到第二份文档，避免序列化第一遍脱离的对象。
  这仍不是通用恶意 PDF 净化器、电子签名验证器或敏感信息擦除保证。
- PDF `inspect` 返回 `pageDetails`；每页只含零基 `index`、`widthPoints`、`heightPoints` 和
  `rotationDegrees`。它是结构/页面几何摘要，不是渲染、安全或擦除证明。
- “本地”表示 Useful runtime 不主动上传内容。Base64 正文仍会经过发起调用的 Agent host、stdio/CLI 进程与
  worker 内存；调用方自己的日志、会话保留和备份策略不由 Useful 控制。Office 字段在 descriptor 中标记为
  sensitive 并要求日志脱敏，但不应把本地执行误解为调用方不可见。

媒体探测/导出与进程快照/终止位于单独的可选 native host pack，不属于默认 36 个 Action。源码 CLI/MCP
只有显式提供 `--host-config <useful.host-actions.v1.json>` 才注册其中启用的 entry；profile 仍只是 exposure
allowlist，不会注册缺失 entry、授予权限或生成确认。CLI 只从实际加载的 entry 派生 grants，破坏性调用还要
当前命令显式 `--confirm`。MCP 二进制只为实际加载且严格只读、非破坏、无需确认的 entry 派生 grants，永不
设置 confirmation。详细闭集配置见 [`packages/host-actions/README.md`](../packages/host-actions/README.md)。
这只是源码能力，不表示已经发布独立 CLI/MCP，也不替代真实 ffmpeg/ffprobe 和目标平台验证。

## Agent Kit launcher（可构建的附加资产）

本地构建器可生成 `Useful-<version>-agent-kit.zip`。解压后只需 Node.js 20 或更高版本；无需 monorepo、GUI 或全局
安装。Windows 可运行 `<ABS_KIT>\bin\useful.cmd`、`useful-runtime.cmd`、`useful-mcp.cmd`，POSIX
可运行 `<ABS_KIT>/bin/useful`、`useful-runtime`、`useful-mcp`。CLI/runtime 示例：

```powershell
& "<ABS_KIT>\bin\useful.cmd" agent-contract --json
& "<ABS_KIT>\bin\useful-runtime.cmd" actions list --json
```

```bash
"<ABS_KIT>/bin/useful" agent-contract --json
"<ABS_KIT>/bin/useful-runtime" actions list --json
```

MCP host 推荐绕过 shell launcher，直接配置 `node <ABS_KIT>/lib/useful-mcp.mjs`：

```json
{
  "mcpServers": {
    "useful": {
      "command": "node",
      "args": ["<ABS_KIT>/lib/useful-mcp.mjs"]
    }
  }
}
```

归档包含 5 个自包含 bundle：3 个命令入口 `useful.mjs`、`useful-runtime.mjs`、`useful-mcp.mjs`，以及
`regex-worker-thread.mjs`、`office-worker-thread.mjs` 两个固定 worker。descriptor/source digest 使用
`lib/provenance/action-runtime`、`lib/provenance/office-core` 和 `lib/provenance/host-actions` 中随包保存的
规范化源码字节，不对压缩后的 bundle 自身或本机路径取摘要。构建器还会根据实际 bundle 输入生成
`THIRD_PARTY-LICENSES.json`，并把每个依赖包的许可证/notice 原文放在
`third-party/<package>/<version>/`；缺少包名、版本、license metadata 或许可证文件会 fail closed。

这些说明描述源码构建能力；Agent Kit 仍是 internal candidate，不表示 ZIP 已发布、获准公开分发或完成
目标平台验证；现有显式 trust config、fail-closed 验证和 profile allowlist 边界全部不变。

## Windows 源码工作树 MCP 配置

先在仓库根目录安装锁定依赖：

```powershell
pnpm install --frozen-lockfile
pnpm --filter @useful/mcp test
```

不同 MCP host 的外层字段不相同；stdio 进程的核心参数如下：

```json
{
  "mcpServers": {
    "useful": {
      "command": "C:\\ABSOLUTE\\PATH\\TO\\node.exe",
      "args": [
        "C:\\ABSOLUTE\\PATH\\TO\\tools\\packages\\useful-mcp\\bin\\useful-mcp.mjs",
        "--plugin-config",
        "C:\\ABSOLUTE\\PATH\\TO\\plugin-set.json",
        "--host-config",
        "C:\\ABSOLUTE\\PATH\\TO\\useful.host-actions.v1.json",
        "--agent-profile",
        "C:\\ABSOLUTE\\PATH\\TO\\useful.agent-profile.v1.json"
      ]
    }
  }
}
```

不需要插件时删除对应 `--plugin-config` 两项；不需要原生 host Action 时删除 `--host-config` 两项；不需要
allowlist 时删除 `--agent-profile` 两项。上面结构可用于
Claude Desktop 等接受 `mcpServers` 的宿主。Codex 或其他 Agent 也应配置同一个本地 stdio command/args，
但外层配置键以宿主文档为准；Useful 不自动写入这些文件。可选 `USEFUL_MCP_DIAGNOSTICS=1` 只向 stderr 写固定诊断；MCP stdout
始终只承载协议帧。无效配置在 stdio server 创建前退出，stdout 为空。

## 协议验证与边界

仓库测试入口覆盖中文与空格路径的 create/doctor/validate/pack/publisher sign+verify、双 pin config、runtime
list/search/suggest/describe/run/recipe，并使用官方 MCP client 覆盖 tools/list + call。任何通过结论都必须绑定实际执行的
checkout 与完整输出；建议的聚焦入口是：

```powershell
pnpm --filter @useful/action-runtime test
pnpm --filter @useful/office-core test
pnpm --filter @useful/runtime-cli test
pnpm --filter @useful/mcp test
pnpm --filter @useful/mcp typecheck
```

- tool 输入未知字段、非法操作、超限内容均 fail closed；公开错误不含输入或堆栈。
- MCP handler 将 SDK AbortSignal 传到 executor；plugin pipeline 在步间和每个内建 action 中继续传播。
- plugin action 强制 pure、readOnly、non-destructive、idempotent、closed-world、零权限、无需确认。
- pipeline 仅允许固定 JSON/Base64/Hash allowlist、JSON 常量与对 input/已完成 step output 的 RFC6901 引用；
  禁止表达式、插值、动态 action ID、插件互调、文件/网络/进程/环境变量。
- `useful.action-recipe.v1` 同样不执行脚本或插值，只允许当前 profile 可见的 canonical、只读、非破坏、
  幂等、closed-world、零权限、零副作用 Action；最多 16 步、请求 1 MiB、中间值 8 MiB、总超时 60 秒。
- 当前入口仍需 Node.js，是开发态运行时，不是 standalone Windows EXE；Office worker 是可终止的进程内
  隔离边界，不是操作系统 sandbox。MCP preset 虚拟工具、自动 marketplace 发布/门户、账户/付费、
  HTTP/OAuth/Tasks 均未实现。
