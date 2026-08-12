# 实用工具架构

简体中文 · [English](UTILITIES-ARCHITECTURE.en.md)

## 两级工具模型

Useful 当前的两级工具模型源自 Phase 12：

```
ToolDefinition (一级：工具包)
  └─ ToolActionDefinition[] (二级：工具 actions)
```

### 一级：Rust 后端注册表

`crates/useful-core/src/registry.rs` 中的 `builtin_tools()` 声明 3 个顶级工具：

| ID | 路由 | 说明 |
|----|------|------|
| `builtin.utilities` | `/tools/utilities` | 实用工具（31 个子工具） |
| `builtin.video-trim` | `/tools/video-trim` | 视频裁剪 |
| `builtin.process-monitor` | `/tools/process-monitor` | 进程监视器 |

### 二级：前端 Action 注册表

`apps/useful/src/lib/tools/registry.ts` 中的 `UTIL_ACTIONS` 从 `UTIL_TOOLS` 派生 31 个 action：

```
builtin.utilities.base64
builtin.utilities.url
builtin.utilities.hash
builtin.utilities.uuid
builtin.utilities.json
builtin.utilities.password
builtin.utilities.data-format
builtin.utilities.text-diff
builtin.utilities.ipv4
...
```

每个 action 拥有：
- **稳定 ID**：`builtin.utilities.<short_id>`，不可随意修改
- **深链接**：`/tools/utilities/<short_id>`
- **关键词**：中英文搜索词
- **别名**：技术缩写和常见替代名
- **能力声明**：`supportsShortcut`、`supportsFavorite`、`supportsRecent`

这 31 个 utility 也都有共享 `ActionDescriptor` 与 headless handler，并进入默认 AI-callable registry。
`data-format` 只做有界 JSON↔YAML，`text-diff` 生成确定性的行差异，`ipv4` 只做离线 IPv4/CIDR 检查；
它们不读取文件、剪贴板或网络。5 个 Office family 由独立 Office registry 提供，不计入这 31 个 utility。

## 统一数据流

```
registry.ts (权威来源)
  ├─ UtilitiesView.vue (工具网格 + 详情)
  ├─ CommandPalette.vue (Ctrl+K 搜索)
  ├─ HomeView.vue (首页收藏 + 最近)
  ├─ AppSidebar.vue (侧边栏)
  └─ stores/app.ts (收藏 + 最近使用状态)
```

## 命令行直达

```powershell
# `Useful.exe` 是 Useful 在 Windows 上保留的兼容主程序文件名。
# 顶级工具
Useful.exe --open-tool builtin.video-trim

# Action 级直达
Useful.exe --open-action builtin.utilities.base64
Useful.exe --open-action=builtin.utilities.json
```

单实例运行：第二个实例把参数发给第一个实例，激活窗口并切换工具。

## 数据库迁移

Phase 12 新增迁移 v5 (`action_level_state`)：
- `action_favorites` 表：action 级收藏
- `action_recent` 表：action 级最近使用（含使用次数）

与顶级 `favorites`/`recent_tools` 表并存，不相互干扰。

## 敏感工具标记

`ToolActionDefinition.sensitiveInput` 标记的工具：
- **密码生成器**：不保存结果，离开页面清除
- **JWT 解码器**：不进入最近输入，离开页面清除，显示清除按钮

## 深链接行为

| 场景 | 行为 |
|------|------|
| `/tools/utilities/base64` | 打开 Base64 工具 |
| `/tools/utilities` | 打开最近使用的工具，或网格首页 |
| `/tools/utilities/invalid-id` | 安全错误页，不崩溃 |
| URL 刷新 | 正常重新加载 |
| 浏览器前进后退 | 正常导航 |
