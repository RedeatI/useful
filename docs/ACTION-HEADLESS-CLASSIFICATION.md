# 内置 Action 的 headless 分类（AI-0 审计）

## 判定口径

“可 pure headless”表示核心语义可由结构化 JSON 输入在本地完成，不需要窗口、文件选择器、宿主 IPC、
进程、网络或任意命令。当前 31 个 utility 都已注册共享 descriptor 与 headless handler；GUI metadata 仍由
前端 registry 管理，但不会代替 Action contract。5 个 Office family 使用固定、可终止的本地 worker，仍不
接受任意路径或 URL。

## 31 个 utility

| 目标执行分类 | Actions | 约束 | 当前 headless 状态 |
|---|---|---|---|
| `pure`、确定且可幂等 | json、base64、url、hash、timestamp、base-convert、color、case、jwt（仅离线 decode）、html、hex-text、morse、text-stats、text-lines、slug、byte-size、lorem、duration、byte-unit、number-format、unicode、caesar、luhn、contrast、data-format、text-diff、ipv4 | JWT/正文输入标敏感；locale/rounding/Unicode 版本进入契约；timestamp 只转换显式值；data-format 禁止 YAML alias/custom tag；ipv4 不查网络 | 已注册 GUI/runtime 共享语义与 test vectors |
| `pure`、本地非确定/非幂等 | uuid、password、random-number | 使用 CSPRNG；`idempotent=false`；receipt 不记录生成值；不得提供隐式 seed | 已注册；不符合 recipe 资格 |
| `worker`，不是 `pure` | regex | 用户正则可能灾难性回溯；固定 worker、硬超时、输入/输出上限与取消，不能在共享 event loop 当 pure action | 已注册固定 worker handler |

结论：31 个 utility 当前均进入默认 AI-callable registry；不能仅凭 Vue 页面或显示 metadata 推断执行资格。
`useful.action-recipe.v1` 还会在 profile 过滤后逐项检查 canonical ID、readOnly、non-destructive、idempotent、
closed-world、零权限、零 capability、零副作用与无需确认，因此“可被 CLI/MCP 调用”不等于“可进入 recipe”。

## 其他现有入口

| 能力/入口 | 目标分类 | 原因 |
|---|---|---|
| process-monitor | `host` | 读取操作系统进程身份与采样，需要宿主能力和资源/隐私策略 |
| video-trim | `host` + 受控 worker | 用户选定文件、ffprobe/ffmpeg、目标写入和取消；不是 pure，也不能拼 raw args |
| Web 插件顶层 entry | `ui-only`（默认） | `entry.path`/route 只证明可显示页面，没有 headless handler |
| launcher entry | `ui-only`（默认） | 现有 `entry.args` 是静态启动模板，不是类型化 action 参数；禁止映射为 CLI/MCP |
| worker entry | `ui-only`（默认） | 在 framed RPC、能力隔离、来源固定和生命周期协议完成前不能 headless 暴露 |
| Settings、Sources、Downloads、Installed 等管理页面 | `ui-only` | 它们是导航/管理流程，不是 ActionDescriptor；未来管理 action 需独立权限与确认模型 |

## GUI 迁移规则

GUI 复用不能复制 handler。browser-safe pure action 消费共享语义层；不能把含 Node provenance、文件 I/O
或进程时钟的 executor 导入浏览器。31 个 utility 的 descriptor/test vectors 共享，JSON/Base64 等使用平台
中立 handler，文本 Hash 的 Web Crypto 与 Node crypto adapter 保持同一契约。文件 Hash 仍是独立
Worker/文件路径，不因文本 Hash 闭环而降级。host action 的 GUI、CLI、MCP 都应进入同一宿主 executor；
UI 只额外提供确认和文件选择交互。
