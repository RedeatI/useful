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
- **进程监视器：** 在 Windows 上查看进程的 CPU、内存、磁盘、GPU 和网络活动。结束进程或请求提权
  都需要明确操作。
- **工具库：** 统一搜索、固定和收藏内置工具与已安装工具。
- **第三方扩展：** 校验并打包 `.useful` Web 工具，在受信任安装流程中验证发布者签名，也可以自托管
  兼容的软件源。
- **Agent 调用：** 通过 JSON CLI 或本地 stdio MCP 调用 36 个内置 Action；也可以用 Agent profile
  为特定宿主缩小可见范围。
- **宿主配置计划：** 为 Codex、Claude Code、Claude Desktop 或采用 `mcpServers` JSON 的宿主生成
  无 secret、可审阅的 MCP 配置计划，不修改宿主配置。

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
```

target 闭集为 `codex`、`claude-code`、`claude-desktop`、`mcp-servers-json`。Codex 与 Claude
仍保留各自的审批和沙箱策略；Useful 不生成绕过权限或 always-allow 配置。scope 与 merge 语义见
[AI 接入说明](docs/AI-INTEGRATION.md)。

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
[Computer Use 合同](docs/COMPUTER-USE.md)。它默认禁用，没有可执行 provider，不注册为 Action 或 MCP
工具，也不能控制宿主桌面。

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
