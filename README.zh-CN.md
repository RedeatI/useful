# Useful

简体中文 · [English](README.md)

Useful 是一个本地优先的桌面应用，收拢了那些经常散落在浏览器标签页、命令片段和独立小软件里的
日常任务。当前内置 31 个开发实用工具、一组轻量的本地 Office 文件处理能力，并提供视频裁剪、
Windows 进程观测和第三方工具扩展能力。

项目使用 Vue 3、Tauri 2 与 Rust 开发。除非某项功能明确需要网络，工具输入不会离开本机。Useful
不内置 AI 模型，也不会修改 Codex、Claude 等 Agent 宿主的配置。

> [!IMPORTANT]
> Useful 目前仍是开发者预览版，请从源码构建体验。项目尚未提供官方签名安装包和生产更新源；Windows
> 是主要开发平台，部分原生能力在 macOS 与 Linux 上不可用。具体进度和限制见
> [已知限制](docs/KNOWN-LIMITATIONS.md)。

![Useful 工具库界面](docs/assets/readme/workflow.zh-CN.svg)

## 可以做什么

- **日常工具：** JSON 格式化、Base64/URL 编解码、哈希、UUID、时间戳、正则、JSON/YAML 转换、
  文本差异、IPv4/CIDR、单位换算和颜色处理等 31 项功能，均可离线使用。
- **Office 文件：** 组合、检查和提取 DOCX/PPTX，在 Markdown 与简单文档或幻灯片之间转换，处理
  XLSX/CSV 检查与简单 Markdown 表格转换，以及检查、合并、拆分、提取、删除、重排、旋转 PDF 页面或
  清理 PDF 元数据。这是一套有明确边界的文件工具，不是 Office 编辑器的替代品。
- **视频处理：** 探测媒体信息、尽量无损裁剪、按精确时间段转码、提取音频，并可取消长任务。
- **进程监视器：** 在 Windows 上查看进程的 CPU、内存、磁盘、GPU 和网络活动。首发版本仅支持只读
  观测；结束进程、结束进程树和一键提权均已禁用。需要管理员权限时，请退出 Useful，再从 Windows
  外壳手动选择“以管理员身份运行”。
- **工具库：** 统一搜索、固定和收藏内置工具与已安装工具。
- **第三方扩展：** 校验并打包 `.useful` Web 工具，在受信任安装流程中验证发布者签名，也可以自托管
  兼容的软件源。
- **Agent 调用：** 通过 JSON CLI 或本地 stdio MCP 调用 36 个内置 Action；也可以用 Agent profile
  为特定宿主缩小可见范围。
- **宿主配置计划：** 为 Codex、Claude Code、Claude Desktop 或采用 `mcpServers` JSON 的宿主生成
  无 secret、可审阅的 MCP 配置计划，不修改宿主配置。`agent export` 会把同一条本地 stdio 候选输出为
  `useful.agent-connection.v1` 审阅文档。
- **MCP 自检：** `agent probe --json` 只对当前 Useful MCP 做只读协议自检。不接受 launcher、不写宿主配置，
  也不证明 Codex/Claude 已安装或外部 launcher 没有网络与副作用；结果为 `useful.agent-probe.v1` 文档。
  Agent Kit 的 `artifactVerified` 只表示本地解压目录匹配 MANIFEST 的字节数和哈希闭集，不代表签名、来源、
  sidecar 或发布授权。30 秒硬截止从同步的本地路径/MANIFEST 预检结束后开始，只覆盖 MCP 执行与 transport
  关闭阶段，不限制这段同步预检的耗时。
- **连接绑定验证：** `agent verify --target <target> --launcher <fixed-entry> --json` 要求使用当前安装解析出的
  固定 Useful MCP 入口，重新生成 `useful.agent-connection.v1` 候选，运行本地 probe，并将两者绑定为
  `useful.agent-connection-verification.v1`。其中 `claimScope` 和 `claims` 明确是本次 CLI 自报，且
  `documentAuthenticated: false`：Schema/parser 通过只校验结构与 endpoint 绑定，不认证执行。verifier 不会
  执行生成的宿主 `commandArgv`，也不读写宿主配置；不认证 Codex/Claude 已安装、已配置或会接受候选。
  V1 拒绝 `USEFUL_PROFILE`，也不宣称 profile 绑定、签名、来源、sidecar、发布状态或 launcher 无网络访问。
- **全宿主候选验证：** `agent verify-all --launcher <fixed-entry> --json` 只运行一次 MCP self-probe，并按
  `codex`、`claude-code`、`claude-desktop`、`mcp-servers-json` 固定顺序生成四个 user-scope 候选；要么四项
  全部返回，要么整体失败，不产生部分集合。candidate-ready 与所有值为 true 的 claim 也只是本进程自报，
  Schema/parser 通过不认证执行。verifier 不执行 Codex、Claude、browser 或 input 命令，不读写宿主配置，
  不接受 profile，也不认证外部 Agent 已安装、已配置、已连接或会接受候选。
- **Agent Connections Inspector：** 设置页只接收用户在终端运行
  `useful agent verify-all ... --json` 后显式粘贴的 JSON。浏览器专用 parser 会先执行 1 MiB 输入预算、严格闭集
  shape 与 cross-field 绑定校验，再显示四个 user-scope 候选；复制候选始终需要显式操作。Inspector 没有 IPC、
  子进程、路径选择器、宿主配置读取/写入、自动剪贴板读写，也不执行 `commandArgv`。parser 通过仍是 self-reported，
  且 `documentAuthenticated: false`：不证明 Codex/Claude 已安装、已配置、已连接或会接受候选，也不证明签名、
  来源或发布授权。本机路径可能进入剪贴板。当前没有受信的 Node + Agent Kit 锚点，因此刻意不提供桌面一键运行。
- **离线 Computer Use 能力自检：** `computer-use probe --json` 校验包内 `useful.computer-use.v1`
  合同、固定 9 项动作类型闭集、默认 controller 仍禁用、`host-desktop` 被拒绝，以及宿主注入 browser adapter
  接口存在。`useful.computer-use-probe.v1` 的 claims 只是本机自报，且
  `documentAuthenticated: false`；命令不启动浏览器、不联网、不注入输入、不读写宿主配置、不启用 provider，
  也不注册 Action、MCP 工具或 GUI 功能。当前没有已启用或自包含的 browser/VM provider；包内仅有必须由
  宿主注入的 browser-adapter factory，probe 只检查其接口而不会调用它。

界面支持简体中文和 English (US)，并提供浅色、深色主题。Windows 便携模式只需在 `Useful.exe`
旁创建 `portable.flag`，数据便会写入 `./data`，而不是 `%APPDATA%\Useful`。

## 从源码运行

需要先安装：

- 源码开发与桌面构建需要 Node.js `^20.9.0` 或 `>=22.0.0`
- pnpm 9.15.0
- Rust stable 工具链
- 当前平台对应的 [Tauri 2 系统依赖](https://v2.tauri.app/start/prerequisites/)

净化后的仓库正式公开后，可执行：

```console
git clone https://github.com/RedeatI/useful.git
cd useful
pnpm install --frozen-lockfile
pnpm tauri dev
```

`pnpm dev` 只启动 Web 前端，适合界面开发；媒体、进程和本机状态等功能需要 Tauri 原生后端，在纯
Web 模式下会明确提示不可用。

release profile 缺少生产更新信任配置时会主动拒绝构建。本地 release 风格的验证方式见
[开发者预览说明](docs/DEVELOPER-PREVIEW.md)，由此产生的 QA 制品不能当作官方安装包发布。

## CLI 与 MCP

当前内置 Action 注册表共有 36 个可调用契约：除 [工具 Action](docs/TOOL-ACTIONS.md) 中的 31 个
utility Action 外，还包括下面 5 组 Office Action：

```text
builtin.office.docx
builtin.office.pptx
builtin.office.spreadsheet
builtin.office.pdf
builtin.office.markdown
```

接入时可以直接查询注册表，不必手抄 ID：

```console
node packages/useful-runtime/bin/useful-runtime.mjs actions search --query office --category office --json
node packages/useful-runtime/bin/useful-runtime.mjs actions describe builtin.office.docx --json
node packages/useful-runtime/bin/useful-runtime.mjs actions suggest --input @sample.txt --limit 5 --json
node packages/useful-runtime/bin/useful-runtime.mjs actions recipe --input @examples/action-recipes/json-base64.json --output json
```

查看更完整的机器可读 CLI 契约：

```console
pnpm useful -- agent-contract --json
```

只生成或诊断宿主对应的 stdio 配置，不写入配置文件：

```console
pnpm useful -- agent plan --target codex --launcher C:\ABSOLUTE\useful-mcp.mjs --json
pnpm useful -- agent doctor --target claude-code --launcher C:\ABSOLUTE\useful-mcp.mjs --json
pnpm useful -- agent export --target codex --launcher C:\ABSOLUTE\useful-mcp.mjs --json
pnpm useful -- computer-use probe --json
pnpm useful -- agent probe --json
pnpm useful -- agent verify --target codex --launcher C:\ABSOLUTE\PATH\TO\tools\packages\useful-mcp\bin\useful-mcp.mjs --json
pnpm useful -- agent verify-all --launcher C:\ABSOLUTE\PATH\TO\tools\packages\useful-mcp\bin\useful-mcp.mjs --json
C:\ABSOLUTE\KIT\bin\useful.cmd agent verify-all --launcher C:\ABSOLUTE\KIT\lib\useful-mcp.mjs --json
```

plan/export 的 target 闭集为 `codex`、`claude-code`、`claude-desktop`、`mcp-servers-json`。导出仅写 stdout、
不含 secret、只供当前主机人工复核：它不写入宿主配置、不启动 launcher、不联网，也不证明 MCP handshake。Claude Desktop
输出是本机合并片段；远程服务请使用其官方 Connectors。Codex 与 Claude 仍保留各自的审批和沙箱策略；Useful
不生成绕过权限或 always-allow 配置。scope 与 merge 语义见
[AI 接入说明](docs/AI-INTEGRATION.md)。
`agent verify` 要求 `--launcher` 解析为固定的源码或 Agent Kit MCP 入口；传入其他 launcher 会 fail closed。
它内嵌的 probe 必须报告完整默认面：40 个工具 = 36 个 Action + 4 个 helper，工具名 SHA-256 也必须匹配
`2740f646530580de5ad2079f3290c01517e8b37f58c6d624293ae74e665c6f17`。这个 JSON 可以复制和解析，但
parser 通过也不认证任何自报的本地执行，
也不会让 current-host 路径变得可移植。endpoint 只绑定 node/launcher 路径和安装身份，不绑定 env/cwd，
也不会执行或应用候选。
`agent verify-all` 只接受固定 launcher 与 `--json`，没有 target、scope、project、env、profile、config、apply 或
install 参数。它只运行一次 MCP self-probe，再把上述固定顺序的四项 user-scope 验证作为一个 all-or-nothing
`useful.agent-connection-verification-set.v1` 文档输出。40/36/4 数量与工具名哈希和 `agent verify` 使用同一闭集；
所有 claims（包括值为 true 的 claims）都只是 self-reported。

`packages/useful-runtime` 提供 JSON 运行时，`packages/useful-mcp` 通过 stdio 暴露同一份 Action
注册表。两者目前都属于需要 Node.js 的开发入口，尚未作为独立二进制发布。MCP 另外保留
`useful.actions.search`、`useful.actions.describe`、`useful.actions.suggest` 与
`useful.actions.recipe` 四个 helper；它们不计入 36 个 Action，所以默认 `tools/list` 共 40 项。

智能推荐只检查调用方显式提供的文本，在本地内存中处理，最多 64 KiB；它不会自动读取剪贴板，也不会在
结果中回显样本。recipe 使用闭集 `useful.action-recipe.v1`：最多 16 个有序步骤，只能用精确 JSON Pointer
引用 recipe 输入或已完成步骤的输出，并且只能调用当前 profile 暴露的只读、非破坏、幂等、closed-world、
无需确认、零权限、零 capability、零副作用 Action。整条 recipe 最多运行 60 秒，每一步仍受 descriptor
timeout。可直接复制运行的文件见
[Action recipe 示例](examples/action-recipes/README.md)。

Office Action 只在有大小上限的 JSON 中传递 canonical Base64 文件内容，并在可终止的本地 worker
中运行。Action 本身不接受任意文件路径，也不联网；文档处理代码不会执行宏、表格公式、嵌入脚本或
外部关系，CSV 中类似公式的单元格默认会转义。二进制结果同时返回字节数与 SHA-256，便于调用方核对。

无论从界面、CLI 还是 MCP 发起调用，Useful 都使用同一套策略。Agent profile 只是允许列表，不会
提升权限；网络访问、进程控制、安装和破坏性操作仍要满足应用定义的能力声明与确认要求。

媒体与进程 Action 位于单独的可选 host pack，永远不计入默认 36 个 Action。源码工作树可通过
`--host-config` 显式加载；CLI 的破坏性调用还要求本次 `--confirm`，MCP 二进制只授权配置中已加载的
只读 Action，绝不会代替用户确认。该 pack 仍需真实平台与精确发布候选验证。

仓库还包含供未来隔离浏览器/隔离 VM adapter 使用的 provider-neutral
[Computer Use 合同](docs/COMPUTER-USE.md)。它默认禁用，没有已启用或自包含的 browser/VM provider；仅包含
必须由宿主注入且 probe 不会调用的 browser-adapter factory。它不注册为 Action 或 MCP 工具，也不能控制
宿主桌面。离线能力自检会报告动作类型闭集 SHA-256
`a9bce07e51d533f830833d94ddc5fd53ae7f0b837da31edc8b68f64394a10cf7`；parser 或 probe
通过不认证文档，也不证明真实隔离、网络强制、外部模型集成或平台执行。默认 MCP 面仍保持
40 个工具 = 36 个 Action + 4 个 helper。

Agent Kit 构建器只会生成带 `publicationAuthorized: false` 的本地候选，构建本身不授予发布权；仅当
受控发布工作流把它附加到匹配的 GitHub Release 时，才属于官方可用资产，且源码/Agent Kit Release
不代表桌面平台已经验证。开发第三方工具请从
[Agent 工具构建指南](docs/agent/BUILD-A-TOOL.md) 开始。需要管理软件源、签名、
更新或自托管服务的人工维护者，可继续阅读 [开发者指南](docs/DEVELOPER-GUIDE.md)。

## 仓库结构

```text
apps/useful/              Vue 前端与 Tauri 桌面宿主
crates/useful-*/          Rust 核心、媒体、进程与信任组件
packages/useful-sdk/      Web 工具 SDK
packages/useful-cli/      工具创建、校验、打包与软件源 CLI
packages/agent-integrations/  Codex/Claude/MCP 配置计划与只读 doctor
packages/computer-use-contract/  默认禁用的隔离 Computer Use 合同
packages/action-runtime/  共享 Action 注册表、契约与本地 handler
packages/useful-runtime/  确定性 JSON Action 运行时
packages/useful-mcp/      本地 stdio MCP 服务
packages/office-core/     有边界的 DOCX、PPTX、XLSX/CSV、Markdown 与 PDF 核心
packages/host-actions/    可选原生 host 契约；不在默认注册表中
services/                 可自托管的软件源服务
repositories/             静态源示例与测试夹具
examples/                 第三方工具示例
docs/                     架构、接入、安全与发布文档
```

桌面端、扩展包格式、Action 运行时和软件源服务共享协议，因此保存在同一仓库。按修改范围可从
[实用工具架构](docs/UTILITIES-ARCHITECTURE.md)、[工具 Action](docs/TOOL-ACTIONS.md) 或
[插件 SDK](docs/PLUGIN_SDK.md) 开始阅读。

## 参与开发

常用检查命令均从仓库根目录运行：

```console
pnpm lint
pnpm typecheck
pnpm test
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm workflow:check
pnpm release:checks
```

修改代码或公开协议前，请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [AGENTS.md](AGENTS.md)。
负责版本发布的维护者还应按 [开源发布清单](docs/OPEN-SOURCE-RELEASE.md) 执行本地准备检查。

## 安全与许可证

安全问题请按 [SECURITY.md](SECURITY.md) 中的方式报告。扩展包和 Action 的信任边界见
[安全保证](docs/SECURITY-ASSURANCE.md)。

本仓库包含多种许可证。根 [LICENSE](LICENSE) 与 [LICENSES.md](LICENSES.md) 记录 Owner 已确认的
组件映射；第三方组件继续适用其原许可证，每个公开候选仍须单独完成法律与依赖复核。另见
[第三方声明](THIRD_PARTY_NOTICES.md) 与 [商标政策](TRADEMARKS.md)。
