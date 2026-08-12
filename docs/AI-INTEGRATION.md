# 外部 Agent 调用 Useful（GUI profile / 开发态 CLI / MCP）

简体中文 · [English](AI-INTEGRATION.en.md)

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
& "<ABS_KIT>\bin\useful.cmd" computer-use probe --json
& "<ABS_KIT>\bin\useful.cmd" agent verify --target codex --launcher "<ABS_KIT>\lib\useful-mcp.mjs" --json
& "<ABS_KIT>\bin\useful.cmd" agent verify-all --launcher "<ABS_KIT>\lib\useful-mcp.mjs" --json
```

```bash
"<ABS_KIT>/bin/useful" agent-contract --json
"<ABS_KIT>/bin/useful-runtime" actions list --json
"<ABS_KIT>/bin/useful" computer-use probe --json
"<ABS_KIT>/bin/useful" agent verify --target codex --launcher "<ABS_KIT>/lib/useful-mcp.mjs" --json
"<ABS_KIT>/bin/useful" agent verify-all --launcher "<ABS_KIT>/lib/useful-mcp.mjs" --json
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
`regex-worker-thread.mjs`、`office-worker-thread.mjs` 两个固定 worker。Action descriptor/source digest 仍只使用
`lib/provenance/action-runtime`、`lib/provenance/office-core` 与 `lib/provenance/host-actions` 中随包保存的
规范化源码字节，不对压缩后的 bundle 自身或本机路径取摘要。Computer Use contract、browser-adapter 与
protocol probe provenance 则只作为 MANIFEST 闭集文件保存，并逐项绑定 size/SHA-256；它们不参与
descriptor/source digest。构建器还会根据实际 bundle 输入生成
`THIRD_PARTY-LICENSES.json`，并把每个依赖包的许可证/notice 原文放在
`third-party/<package>/<version>/`；缺少包名、版本、license metadata 或许可证文件会 fail closed。

这些说明描述源码构建能力。构建结果中的 `publicationAuthorized: false` 表示构建器本身不授予发布权；
只有受控发布工作流附加到匹配 GitHub Release 的 ZIP 才是官方可用资产。源码/Agent Kit Release 仍不
表示桌面平台已验证；现有显式 trust config、fail-closed 验证和 profile allowlist 边界全部不变。

## 跨 Agent 连接描述 V1（只生成，不写入）

`useful agent export` 只向 stdout 生成 `useful.agent-connection.v1` 的人工复核连接描述。它是
manual-review-only、no-secrets、current-host-only 的候选配置，不是安装器、授权文件、远程连接凭据或 MCP 握手结果。导出物不包含
token、密码、私钥、输入历史、会话内容或宿主现有配置；构建/导出过程不写入宿主配置、不启动 launcher、不联网，
也不会验证 MCP handshake、工具发现或工具调用。调用方必须在对应 Agent 的官方设置界面或命令行中复核并手动应用。

`useful agent plan` 仍生成内部 `useful.agent-integration.v1` 配置计划；`useful agent export` 将该计划及其唯一
审阅渲染封装为 `useful.agent-connection.v1`。两者都为 Codex、Claude Code、Claude Desktop 与通用 MCP 宿主生成
本地 stdio 候选：target 固定集合为 `codex`、`claude-code`、`claude-desktop`、`mcp-servers-json`，transport 固定为
本地 `stdio`，并且只能在生成它的当前主机上人工复核；不会启动 launcher、主动联网、安装依赖、
读取宿主配置或向宿主写入配置。`--launcher` 必须是实际 MCP stdio 启动脚本的本地绝对路径，例如 Agent Kit 中的
`lib/useful-mcp.mjs`。计划的 `nodePath` 固定为启动当前 CLI 的 `process.execPath`，并记录 launcher、固定 server
name `useful`、空的 V1 扩展 args、安全闭集 env 与 scope。严格 JSON Schema 位于
`packages/protocol/schemas/agent-integration.schema.json`；导出的外层连接描述使用
`packages/protocol/schemas/agent-connection.schema.json`。

这里的 Claude Desktop 输出只适用于本机 `mcpServers` 合并片段。它不代表 Claude Desktop 的远程/托管
连接配置，也不把本地 JSON 当作远程传输协议；远程场景必须使用 Claude Desktop 的官方 Connectors 或其他
官方支持的连接方式，Useful 当前不
生成远程 URL、OAuth、账户或凭据配置。

```powershell
& "<ABS_KIT>\bin\useful.cmd" agent plan `
  --target claude-desktop `
  --launcher "<ABS_KIT>\lib\useful-mcp.mjs" `
  --scope user `
  --env NO_COLOR=1 `
  --json

& "<ABS_KIT>\bin\useful.cmd" agent export `
  --target codex `
  --launcher "<ABS_KIT>\lib\useful-mcp.mjs" `
  --json

& "<ABS_KIT>\bin\useful.cmd" agent doctor `
  --target codex `
  --launcher "<ABS_KIT>\lib\useful-mcp.mjs" `
  --scope project `
  --project-dir "C:\ABSOLUTE\PROJECT" `
  --json

& "<ABS_KIT>\bin\useful.cmd" agent probe --json
& "<ABS_KIT>\bin\useful.cmd" agent verify --target codex --launcher "<ABS_KIT>\lib\useful-mcp.mjs" --json
```

`commandArgv` 是命令型输出的唯一规范表示。Codex user scope 的顺序固定为
`codex mcp add useful [--env K=V ...] -- <node> <launcher>`，没有 `--scope`；Codex project scope 只返回目标
`.codex/config.toml` 的 TOML merge fragment，不提供写入命令。Claude Code 的顺序固定为
`claude mcp add [--env K=V ...] --transport stdio --scope <user|project> useful -- <node> <launcher>`，Useful 的
`user`/`project` 原样映射到 Claude Code 的 `user`/`project`。项目 scope 必须显式提供已存在且无链接路径组件的
`--project-dir`；Claude Code 输出同时返回 `requiredWorkingDirectory`，调用方必须在该目录执行。

`powershellCommand` 只是 `commandArgv` 的显示派生：以 `&` 开头、每个参数独立单引号并把内部 `'` 写成 `''`；
它不是跨 shell 的通用命令字符串。Claude Desktop 和 `mcp-servers-json` 仅支持 user scope，只返回常见但非 MCP
协议标准本身的 `mcpServers` JSON merge fragment。每个
生成项均带 `writesHostConfigWhenExecuted`：宿主写入命令为 `true`，纯 merge fragment 为 `false`。JSON 片段只能
与既有 `mcpServers` 合并，不能替换无关服务器。V1 不提供 `--apply` 或 `--install`；传入任一选项立即失败。

`doctor` 只做路径与结构预检：逐级 `lstat` launcher/node/project directory，拒绝 symlink、junction、reparse
point，要求 node/launcher 为常规文件、当前 Node 为 20 或更高版本，并检查生成物结构。它不执行 launcher、
不主动联网，也不证明 MCP handshake、工具发现或调用已经成功。相对路径、UNC 路径、未知 target/scope、
秘密型环境变量和未列入安全闭集的 env 都会失败。
唯一允许的可选 env 是 `NO_COLOR=1`、`USEFUL_LOG_LEVEL=error|warn|info`，或受限格式的 `USEFUL_PROFILE`；
密钥、token、密码、PATH 和任意自定义环境变量均不接受。

## Computer Use 离线能力自检（Computer Use Probe V1）

源码入口：

```powershell
pnpm useful -- computer-use probe --json
```

Agent Kit 入口见上文的 `bin/useful` / `bin\useful.cmd` 示例。该命令的能力检查只针对当前安装中固定的
Computer Use contract、host-injected browser adapter 接口与协议 parser，并返回严格的
`useful.computer-use-probe.v1`。`useful agent-contract --json` 的
`commands.computerUseProbe` 与 `commandSequence` 同时公布固定命令
`useful computer-use probe --json`。Schema 与 parser 位于
`packages/protocol/schemas/computer-use-probe.schema.json` 和
`packages/protocol/src/computer-use-probe.mjs`。

probe 固定检查 `useful.computer-use.v1`、`isolated-browser`/`isolated-vm`、9 项动作类型及
SHA-256 `a9bce07e51d533f830833d94ddc5fd53ae7f0b837da31edc8b68f64394a10cf7`、默认空域名
allowlist、默认 controller 返回 `COMPUTER_USE_DISABLED`，以及 `host-desktop` 被拒绝。它只确认
browser adapter factory 接口存在；该 factory 必须由宿主注入，probe 绝不调用。能力字段明确报告：CLI 只有
probe、没有执行能力；默认 provider 未启用，不提供自包含 browser/VM provider；isolated-VM adapter、模型
adapter、Action/MCP/GUI 注册均不存在。运行前后默认 provider 仍为 disabled，默认 Action/MCP
闭集仍是 36/40，不增加第 37 个 Action、第 41 个 MCP tool 或新的 Agent Kit bundle。

结果的 `claimScope` 固定为 local self-reported，`claims.documentAuthenticated` 为 `false`。
Schema/parser 通过不认证执行；`artifactVerified` 在 source 为 `false`，在 Agent Kit 为 `true` 时也只表示本地
MANIFEST 字节数/哈希闭集，不表示签名、来源、sidecar 或发布授权。命令不接受 provider、URL、launcher、
module、profile、env、action、apply、config 或 output 覆盖，不启动浏览器、不联网、不注入输入、不读写宿主
配置、不启用默认 provider，也不调用唯一的宿主注入 adapter factory；它不注册 Action、MCP 工具或 GUI，
也不证明真实 browser/VM 隔离、网络
强制、外部模型/Agent 集成或操作系统级阻断；这些仍需要精确 provider、sandbox、网络层与目标平台证据。

## 当前 MCP 自检（Agent Probe V1）

`useful agent probe --json` 是当前机器上 Useful MCP 的只读自检。它启动并关闭一个临时的
stdio MCP client/server，验证固定的协议版本、工具发现与可调用工具数量，并把结果写为一个
`useful.agent-probe.v1` 文档。自检只验证当前 Useful checkout 或 Agent Kit 的 MCP 面；它不是
launcher 试运行，不接收 `--launcher`，不写 Codex/Claude 或其他宿主配置，也不证明 Codex/Claude
已经安装、已连接或会接受该配置。自检不证明 launcher、宿主或外部 MCP server 没有网络访问和副作用；
它只报告 Useful 自己的本地协议边界。

30 秒硬截止从同步路径/MANIFEST 预检完成、进入 MCP 执行后开始，覆盖 initialize、工具查询/调用与
transport 关闭阶段；它不限制此前同步预检的耗时。

source 模式固定报告 `artifactVerified: false`。Agent Kit 模式只有在本地解压目录与 `MANIFEST.json`
形成闭集、每个登记文件的字节数和 SHA-256 都匹配且固定 CLI/MCP 入口也在闭集内时，才报告
`artifactVerified: true`。这个字段只表示本地 MANIFEST 闭集校验，不代表签名、发布者身份、来源可信、
ZIP/sidecar 校验或发布授权，也不能据此把本地候选称为 GitHub Release 资产。

JSON 模式的 stdout 恰好输出一个成功或失败 envelope；child MCP 的原始 stderr 永不回显到该文档。
成功记录只包含 `process.stderrBytes`、`process.stderrSha256` 与 transport close 状态，调用方不能从摘要
还原原文。退出码 `0` 表示完整 self-probe 成功；`2` 表示命令用法错误，`3` 表示协议或探测验证失败，
`4` 表示本地路径、MANIFEST、I/O 或安全边界失败，`5` 保留给意外内部错误。任一非零退出码都必须停止，
不能把 failure envelope 当作部分通过。

## 连接候选验证（Agent Connection Verification V1）

源码入口可运行：

```powershell
pnpm useful -- agent verify --target codex `
  --launcher "C:\ABSOLUTE\PATH\TO\tools\packages\useful-mcp\bin\useful-mcp.mjs" `
  --json
```

Agent Kit 入口见上文的 `bin/useful` / `bin\useful.cmd` 示例。`agent verify` 要求 `--launcher` 解析为当前
source checkout 或 Agent Kit 的固定 Useful MCP 入口；不同入口会 fail closed。命令在本进程重新生成
`useful.agent-connection.v1` 候选，
运行同一次 `useful.agent-probe.v1`，再把二者封装为严格的
`useful.agent-connection-verification.v1` 文档。`endpoint` 逐字绑定 `connection.plan.server` 与
`probe.installation` 中对应的 node/launcher 路径与安装身份；它不绑定 connection 的 env 或 cwd。嵌入的默认
probe 必须报告 40 个工具 = 36 个 Action + 4 个 helper，并匹配固定工具名 SHA-256
`2740f646530580de5ad2079f3290c01517e8b37f58c6d624293ae74e665c6f17`。严格 Schema 位于
`packages/protocol/schemas/agent-connection-verification.schema.json`，但不可信 JSON 在 Schema 通过后仍须通过
协议 parser。

V1 的 `claimScope` 固定带 `self-reported`，`claims` 是本次 CLI 自报而不是认证 proof，其中
`documentAuthenticated: false`。即使 JSON 被复制到另一台机器并通过 Schema/parser，也只说明文档结构、内部
connection/probe/endpoint 绑定和固定工具闭集有效；不认证所述执行实际发生，也不会让 current-host 路径
变得可移植。命令绝不执行 `connection.output.commandArgv` 或应用 merge fragment；claims 还明确自报 verifier
未读取或写入宿主配置。它不认证 Codex、Claude 或其他宿主已经安装、配置完成、连通或会接受候选；不认证
签名、发布者、来源、sidecar 或发布授权；固定 launcher 匹配也不等于“launcher 无网络访问”。V1 拒绝
`--env USEFUL_PROFILE=...`，也不读取 `--agent-profile`，因此不产生 profile-bound 证明。宿主仍必须按官方
流程人工复核和应用候选。

## 四宿主候选集合验证（Agent Connection Verification Set V1）

源码入口：

```powershell
pnpm useful -- agent verify-all `
  --launcher "C:\ABSOLUTE\PATH\TO\tools\packages\useful-mcp\bin\useful-mcp.mjs" `
  --json
```

`agent verify-all` 只接受 `--launcher` 和 `--json`；没有 `--target`、`--scope`、`--project-dir`、`--env`、
profile、node/argv/cwd/output、config、apply、install 等覆盖。launcher 必须是当前 source checkout 或 Agent Kit
解析出的固定 Useful MCP 入口。命令只运行一次 MCP self-probe，再按 `codex`、`claude-code`、
`claude-desktop`、`mcp-servers-json` 固定顺序生成四个 user-scope connection verification。四项的 endpoint 与
同一个 probe 必须一致，并分别保持 40 个工具 = 36 个 Action + 4 个 helper 及固定工具名 SHA-256
`2740f646530580de5ad2079f3290c01517e8b37f58c6d624293ae74e665c6f17`。任何一项生成、绑定或验证失败都会使
整个命令失败，不输出可当作成功使用的部分集合；成功文档为
`useful.agent-connection-verification-set.v1`，Schema 位于
`packages/protocol/schemas/agent-connection-verification-set.schema.json`。

集合的 `claimScope` 固定为 `useful-mcp-local-stdio-connection-candidates-self-reported`。candidate-ready 状态、
`singleProbeUsedForAllCandidatesInCurrentProcess: true` 及其他值为 true 的 claims 都只是本次 CLI 的
self-reported 陈述；Schema/parser 通过或复制 JSON 不会认证执行。命令不执行任何生成的 Codex/Claude
`commandArgv`，不查找或启动 Codex、Claude、browser、input 命令，不读写宿主配置，也不证明外部 Agent 已安装、
已配置、已连接或会接受候选。V1 不支持 profile，`artifactVerified` 即使在 Agent Kit 中为 `true`，也仍只证明
本地 `MANIFEST.json` 的文件字节数/哈希闭集，不证明签名、来源、sidecar、发布授权或 launcher 无网络访问。

### 设置页 Agent Connections Inspector

设置 → Agent Connections 提供一个仅用于人工检查和复制的 Inspector。先在终端显式运行上述
`useful agent verify-all ... --json`，再由用户把完整 JSON 粘贴进文本框并点击检查；界面不会自行运行 CLI、
读取剪贴板或查找 launcher。浏览器专用 parser 对不可信文本执行 1 MiB UTF-8/code-unit 输入预算、深度与节点
预算、危险键拒绝、exact-key/闭集枚举以及 connection/probe/endpoint/output 的 cross-field 绑定校验。只有完整
集合通过后，界面才按固定顺序显示 `codex`、`claude-code`、`claude-desktop`、`mcp-servers-json` 四个
`scope: user`、空 `env` 候选。

Inspector 在 mount、输入和检查阶段都保持零宿主副作用：没有 Tauri IPC、子进程、路径选择器、宿主配置读取或
写入，也不会执行候选的 `commandArgv` 或应用 merge fragment。它不自动读取或写入剪贴板；只有用户点击“复制”
时，才把规范化集合 JSON 或所选连接输出写入剪贴板。输出包含本机 `nodePath`、`launcherPath` 或宿主命令，因此
复制前应视为本机路径信息，粘贴到聊天、工单或远程系统前必须复核。输入在上次成功检查后发生变化时，旧结果
只标记为 stale，不会被当作新输入的结果或自动重新解析。

浏览器 parser 通过只证明该文本满足闭集结构与内部绑定；结果仍是 self-reported，且
`documentAuthenticated: false`。它不证明 CLI 所述执行实际发生，不证明 Codex/Claude 已安装、已配置、已连接
或会接受候选，也不证明签名、来源、sidecar 或发布授权。当前桌面应用没有可受信地绑定当前安装的 Node 与
Agent Kit launcher 的锚点，所以刻意不提供“一键运行验证”；未来若增加该能力，必须先建立独立的受信安装身份
和原生可达性证据，不能由粘贴 JSON 或 parser 成功推导。

MCP 是 Useful 对外的公共执行面，而不是宿主权限的替代者。Codex、Claude 和其他宿主各自决定审批、沙箱、
日志、配置位置与配置变更确认；Useful 只提供本地 stdio server 及其已有的 action/profile 信任边界。始终先审阅
生成物，再按对应宿主的官方文档手动合并或运行命令。

本轮分发面是自包含 Agent Kit；仓库中的 `@useful/cli` 标记为 private workspace package，不承诺 npm 发布或
全局 npm 安装路径。

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
