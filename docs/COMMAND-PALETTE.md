# 命令面板

## 概述

`Ctrl+K` 全局命令面板：搜索工具、导航和操作。

## 搜索能力

### 数据源
1. **Rust 后端注册的顶级工具**（`list_tools` IPC）— video-trim、process-monitor、已安装插件
2. **36 个内置 Action**（统一 Action catalog）— 31 个 utility 与 5 个 Office family
3. **导航操作** — 首页、工具铺、下载、设置

### 搜索维度
- 工具名称（i18n 本地化）
- 关键词（中英文）
- 别名（技术缩写，如 sha→hash、guid→uuid、b64→base64）
- 工具 ID

### 搜索示例

| 搜索词 | 匹配结果 |
|--------|----------|
| `sha` | 哈希计算 |
| `guid` | UUID 生成 |
| `编码` | Base64、URL |
| `银行卡` | Luhn 校验 |
| `jwt` | JWT 解码 |
| `regex` | 正则测试 |
| `b64` | Base64（别名） |
| `epoch` | 时间戳（别名） |
| `yaml` | JSON/YAML 转换 |
| `diff` | 文本差异 |
| `cidr` | IPv4/CIDR |
| `xlsx` | Spreadsheet / CSV / XLSX |
| `pdf` | PDF 页面工具 |

## 键盘导航

| 键 | 行为 |
|----|------|
| `Ctrl+K` | 打开/关闭 |
| `↑` / `↓` | 上下选择 |
| `Enter` | 打开选中项 |
| `Esc` | 关闭 |

## 无结果

显示"没有匹配的结果"提示，不推荐联网搜索。

## 插件集成

插件安装后自动出现在命令面板中（由 Rust 注册表驱动）。
卸载后从命令面板消失。
