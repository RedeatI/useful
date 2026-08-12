# ADR-018：统一 Tool Library 与 Agent Profile v1 安全边界

- 状态：Accepted
- 日期：2026-08-02
- 范围：Useful Phase AI-5

## 当前状态（2026-08-08）

Tool Library、Command Palette 与 Agent profile 编辑器现在使用统一的 36 项内建目录（31 个 utility、5 个
Office family），支持搜索、筛选、稳定排序，以及按 CLI/MCP surface 启用、移除和重排 Action。profile 中的
Action 数组顺序会保留到 CLI list 和 MCP 工具注册；CLI/MCP 的 search/describe 只查询 profile 当前可见集合。
MCP 默认另有 4 个 helper，共 40 项，它们不是 profile Action，插件也不得占用其 actionId/alias 名称。
`suggest` 也先按 profile 过滤再评分，同分按 canonical actionId；`recipe` 只允许当前可见集合中额外满足
只读、非破坏、幂等、closed-world、零权限、零副作用条件的 canonical Action。recipe 最多 16 步，使用
JSON Pointer 引用已完成输出，不支持插值或脚本；请求 1 MiB、中间值 8 MiB、整条 60 秒总超时，每步仍
受 descriptor timeout。

GUI 可配置全部 36 个内建 Action 的 exposure。preset 仍只允许 descriptor schema 中可单独验证、非敏感且不含
路径/命令语义的顶层 primitive；当前 Tauri 持久化层明确实现 JSON、Base64、Hash 三项 defaults 白名单。Office
文件正文等 sensitive 字段不会进入 preset。下面的“三项”表述记录原始切片，不代表当前目录只有三个 Action。

## 背景

旧导航把内置工具、已安装工具、工具铺、源中心、下载和设置平铺；Tool Shop 又管理 legacy catalog 源，
Source Center 只管理 TRP discovery 源。GUI 收藏/最近使用已经稳定，但缺少单独的导航 pin。CLI/MCP 在 AI-4
可以安全加载 signed declarative plugin actions，却没有用户可控、可版本化的暴露 allowlist，也没有安全
参数方案。

## 决策一：Tool Library 是统一发现入口

新增稳定 `/library`，从 utility GUI registry、已安装工具和轻量 `@useful/action-runtime/catalog`
descriptor 元数据 join 出统一 view-model。GUI route/i18n 只提供展示信息；Agent Action 的 surface、
readOnly、permissions、publisher 必须来自共享 descriptor。已安装插件在 GUI 仅标记 GUI +
`runtime-required`，绝不猜测 CLI/MCP。

默认侧栏为：首页、快捷访问、工具库、发现与安装、下载与更新、设置。`navigation_pins` 是独立状态；收藏、
最近使用与 Agent exposure 各自保留原语义。v5→v6 迁移不删除或重写 `favorites`、`recent_tools`、
`action_favorites`、`action_recent`；新 pin 列表默认空，以简短引导替代自动迁移，避免把旧收藏误解释为导航
授权。旧 `/tools/utilities/:id`、`/shop`、`/sources`、`/downloads`、`/settings` 深链继续有效。

Tool Shop 只负责浏览/安装，仍读取 legacy catalog，安装、下载与信任提示不变。Source Center 新增明确的
“兼容索引源”分区，继续调用原 `sourceList/sourceAdd/sourceRefresh/sourceSetEnabled/sourceRemove`；TRP 源在
独立分区使用原 `trpSource*`。因此“源中心统一管理”不会让 legacy 索引源失去可达入口，也不会混合两套信任
契约。

## 决策二：独立 `useful.agent-profile.v1`

profile 是精确键、版本化 JSON，不是 manifest/plugin-set。共享 `@useful/agent-profile` 同时提供 browser-safe
和 Node-safe 入口；直接依赖 Ajv 实际编译 JSON Schema 2020-12，再执行手写的危险键、表达式、碰撞、数量、
bytes、depth/node 和 descriptor 语义校验。共享 vector matrix 分开声明 `schemaValid` 与预期 semantic code，
覆盖 schema-invalid 以及 schema-valid-but-semantic-invalid。

缺省 profile 时 runtime/MCP 行为完全不变。显式 profile 时：

1. 构造内建 registry；若有 plugin-set，先完成 AI-4 archive/signature/publisher + artifact 双 pin/pipeline-v1；
2. 验证 profile 文档；
3. 对 registry 校验 contract/action version/source kind/publisher identity pin；
4. 按 CLI/MCP surface 做 allowlist。

未知、stale、pin mismatch 或 disabled surface 启动/调用即失败，不静默跳过。profile 身份 pin 不重复
`source.digest` 或 artifact SHA-256：artifact SHA-256 已由 AI-4 plugin-set 固定，descriptor digest 由已验证 action
spec 派生；profile 的职责只是“是否暴露此可信身份/版本”。把 digest 再塞入 profile 会混淆 artifact 信任与用户
暴露策略，并造成不必要的第三个 pin。

profile alias 只供 CLI，覆盖而非继承 descriptor aliases，并且只解析到现有 handler。MCP 始终注册 canonical
actionId，避免工具名与冲突集合漂移。MCP preset 虚拟工具不在本阶段实现。

## 决策三：安全 presets

defaults 只能是 descriptor input schema 已知的顶层非敏感字段；每个已存值独立通过 property schema，允许
暂缺 required 字段。运行时浅合并 defaults 与调用 input（调用 input 优先），再交给现有 ActionExecutor 完整
校验 schema、bytes、权限和确认。`sensitive.input` 指向字段的祖先/后代保守阻断；当前 `/text` 永远由每次
调用提供。raw command/flags/argv/env/path/path template/entry.args/launcher target/cwd 以及表达式、插值都被拒绝。
错误、canonical export 和 receipt 不包含 secret/input history/token。

## 决策四：GUI 与持久化边界

SQLite v6 保存 canonical profile 和导航 pin。Tauri IPC 再次执行 deny-unknown、ID、semver、数量、bytes、
危险键、表达式与当前 JSON/Base64/Hash builtin safe defaults 校验；数据库错误仅把 `QueryReturnedNoRows` 解释为未配置，
其他错误向上返回。“保存”把递归键排序后的 canonical JSON 写入 SQLite；只有显式“导出 profile”才用
pretty JSON + LF 原子替换固定应用数据路径 `agent/useful.agent-profile.v1.json`。CLI/MCP 不读取 SQLite，
也不接受任意写路径。

GUI 可编辑全部 36 个内建 Action 的 exposure、顺序与 surface，并为当前持久化白名单内的安全 primitive
defaults 提供 preset 控件；shared browser descriptors 的全零 digest 只是 schema/presentation 模板占位，
不展示、不保存、不作为 provenance 声明。GUI 不扫描 AppData/安装目录来推测 plugin descriptor；未解析 plugin
profile entries 原样只读保留，并标注 runtime 最终验证。GUI 不内置 AI、不调用模型、不自动修改 Codex、Claude
或其他宿主配置。

## 后果与未实现

公共 marketplace 自动发布/门户、账户/付费、standalone Windows runtime、MCP preset 虚拟工具、第三方算法
和任意插件代码执行仍不在范围内。开发者现有 `minimal-action → doctor → validate → pack → publisher
sign/verify → 分享文件` 流程继续可用；“分享”不等于自动发布。

## 为什么这样设计，以及未来 seam

- MCP 官方 Registry 仍处 preview，但 `server.json`、命名空间/版本/安装元数据与 Registry API 聚合方向已经
  给出清晰接缝。当前 signed `.useful`、derived descriptor 与独立 profile 不耦合公共发布；后续可从可信对象导出
  Registry metadata，而不是让 profile 承担发布或安装信任。本阶段没有 Registry publisher/portal/API 集成。
- MCP tools 已支持分页与 list-changed 通知。本阶段在进程启动前一次性验证并冻结 allowlist，更容易同时兼容
  legacy 2025-era 与 2026-07-28，也避免热改已注册 handler。若后续需要动态切 profile，应重新验证完整 registry
  并用 `list_changed` 通知宿主，而不是原地扩大 handler 信任。
- 企业 MCP registry allowlist、按需 tool search/deferred loading 的治理趋势，与当前 profile allowlist + Tool
  Library 搜索一致；本阶段仍是本地静态暴露和前端搜索，不声称已接入任何企业 registry。
- Agent Skills 的开放结构（`SKILL.md` + `scripts/references/assets`、渐进披露）可作为开发者入口与文档包装，
  但 Skill 不是 `.useful` artifact 签名、publisher pin 或 runtime handler 信任。后续可提供可选 Skill 模板，本阶段
  只保留 README/复制提示词/BUILD-A-TOOL 文档入口，不自动发现或执行 Skill。
