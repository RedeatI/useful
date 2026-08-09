# 原生测试

## 测试分层

| 层级 | 类型 | 工具 | 环境要求 |
|------|------|------|----------|
| 1 | 单元测试 | vitest / cargo test | 无 |
| 2 | 组件测试 | vitest + @vue/test-utils | 无 |
| 3 | 属性测试 | fast-check | 无 |
| 4 | 网络隔离测试 | vitest mock | 无 |
| 5 | 大输入测试 | vitest | 无 |
| 6 | Benchmark | vitest bench | 无 |
| 7 | 集成测试 | go test -race | 无 |
| 8 | 安全测试 | go test (negatives) | 无 |
| 9 | E2E | Docker Compose | Docker |
| 10 | 原生 Tauri smoke | cargo test (tauri app) | 无 GUI |
| 11 | 原生 GUI smoke | UI Automation | Windows GUI |

## 浏览器测试 vs 原生测试

### 浏览器测试（vitest）
- 纯前端逻辑：transforms.ts、hash.ts、registry.ts
- Vue 组件：ToolShell、CommandPalette
- 属性/往返/网络隔离/大输入
- 不验证 Tauri IPC、Rust 注册表、Windows 原生功能

### 原生测试（cargo test）
- Rust 注册表：builtin_tools()、ToolRegistry
- CLI 参数解析：--open-tool / --open-action
- 数据库迁移：action_favorites / action_recent
- 快捷方式：quote_arg、sanitize_filename、ShortcutSpec
- IPC 命令结构：AppState、CliArgs

### 原生 GUI smoke（Owner Gate）
- 需要带 GUI 的 Windows runner
- 验证 Useful 的真实兼容主程序 `Useful.exe` 启动、IPC、剪贴板、文件选择器
- 不在生产环境留无认证后门
- `platform-matrix.ps1 -Scenario native-tauri-smoke` 提供 harness

## 命令

```powershell
.\scripts\useful.ps1 test          # 全部单元测试
.\scripts\useful.ps1 test:native   # Tauri 原生 smoke（无 GUI 部分）
.\scripts\useful.ps1 test:plugins  # .useful 插件生命周期
.\scripts\useful.ps1 test:security # 安全负向测试
.\scripts\useful.ps1 bench:utilities # 实用工具 benchmark
.\scripts\useful.ps1 verify:all    # 完整门禁
```

## 本机已执行证据

以下结果与[测试矩阵](TEST-MATRIX.md)中的本机执行证据一致。数量是执行结果，不是固定测试目标；
这里不声明当前 commit 收据，也不把子集与其上级总数相加。

| 范围 | 结果 | 边界 |
|------|------|------|
| 全仓 Node 测试 | 385 通过 | 覆盖前端、CLI、SDK、runtime、MCP、协议、Action 与示例包 |
| 前端聚焦测试 | 248 通过 | 是 385 项 Node 测试中的前端子集 |
| Rust workspace | 275 通过 | `cargo test --workspace` 的本机 workspace 测试，不代表 macOS/Linux 原生打包 |
| bootstrap 聚焦测试 | 40 通过 | 是 Rust workspace 的子集，覆盖更新应用与回滚边界 |
| Go 服务测试与构建 | 通过 | `go test ./...` 及 server/worker 本机构建；不代表已部署 |
| Release 合约 | 31/31 通过 | 验证发布合约，不执行发布 |
| 公开源码合成路径 | 16/16 通过 | 仅验证合成场景，不替代最终公开快照的正式检查 |

最终后台门禁还执行了 `cargo test --workspace --all-targets`，共 276 项通过；多出的 1 项是
`network_smoke` 示例的 JSON 投影测试，不能与 275 项 workspace 结果相加。

## 网络聚合 JSON smoke

进程监视器提供一个无 GUI、非交互的聚合诊断入口：

```powershell
cargo run --locked --release -p useful-procmon --example network_smoke -- --json
```

该命令只输出网络速率、接口与连接数量以及能力/降级状态，不输出 PID、进程名、命令行、路径、
接口名、IP 地址、端口或用户名。2026-08-03 的一次 Windows 后台实测完成 3 轮采样，观察到非零
RX/TX，且 `aggregateNetworkAvailable=true`；ETW 每进程字节能力为不可用，但 reason code 与
remediation 均存在。瞬时接口数和连接数只描述该次采样，不是产品保证。

这个 smoke 证明当前会话可以取得聚合网络速率、TCP/UDP 连接计数并给出明确降级原因；它不替代
普通用户与管理员两种权限下的 GUI 验收，也不证明 ETW 每进程字节统计可用。

## 仍待真实环境执行

- Windows GUI runner：真实 `Useful.exe` 的启动、主题、导航、IPC、剪贴板、文件选择器、视频预览、
  进程观测与网络观测。
- macOS x64、Apple silicon 与 Linux x64 runner：真实编译、打包、安装、启动以及平台降级行为。

CI job 或 harness 的存在不等于真实 runner/GUI 已通过；未取得对应执行结果前只能记为待执行。
