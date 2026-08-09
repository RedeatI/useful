# 插件开发 SDK

本文档介绍如何为 Useful 开发插件。简单的 web 工具**无需编写 Rust**。`useful-cli`、
`@useful/sdk`、`useful.*` schema 和 `.useful` 是保留的兼容开发者接口。

## 插件类型（entry.type）

| 类型 | 说明 |
| --- | --- |
| `web` | 静态 HTML/CSS/JS 页面，加载到独立 origin 的沙箱 iframe。 |
| `launcher` | 由宿主启动一个声明过的本地程序、脚本或网址。 |
| `worker` | 独立原生进程，通过 JSON-RPC over stdin/stdout 通信（默认禁止公开源自动安装）。 |

> 出于安全，禁止第三方 DLL 动态加载到 Useful 主进程。

## 插件包格式（.useful）

`.useful` 本质是规范化 ZIP，根目录必须包含 `manifest.json`。目录布局示例：

```
my-tool.useful
├── manifest.json
├── index.html          # web 入口
├── main.js
└── assets/icon.png
```

### manifest 示例

```json
{
  "schemaVersion": 1,
  "id": "com.example.image-converter",
  "name": "图片转换",
  "version": "1.0.0",
  "description": "批量转换图片格式",
  "icon": "assets/icon.png",
  "entry": { "type": "web", "path": "dist/index.html" },
  "contributes": {
    "sidebar": [
      { "id": "main", "title": "图片转换", "group": "installed", "order": 100 }
    ]
  },
  "permissions": [],
  "platforms": ["windows-x64"],
  "minHostVersion": "0.1.0"
}
```

- `id`：反向域名，至少两段，每段以字母开头。
- `version` / `minHostVersion`：语义化版本（不接受 Alpha/Beta/RC 之外的非法值）。
- `entry.path`（web/worker）必须是相对路径，禁止 `..`、绝对路径与盘符。

manifest 会经过 **JSON Schema + Rust serde 双重校验**。

## 命令行（useful-cli）

```bash
pnpm create useful-tool my-tool   # 生成骨架
pnpm useful dev [dir]             # 本地静态开发服务器
pnpm useful validate [dir]        # 校验 manifest 与 web 入口
pnpm useful pack [dir] [outDir]   # 打包为 <id>-<version>.useful
```

## SDK API（web 工具）

安装 `@useful/sdk`。第三方页面**不能**直接访问 `window.__TAURI__`。首发 web 插件只提供
主题、语言、就绪与进度遥测；文件选择应使用 `<input type="file">` 等沙箱内浏览器 API。

```ts
import { useful } from "@useful/sdk";

const theme = await useful.getTheme();           // 获取主题
const lang = await useful.getLanguage();          // 获取语言
await useful.ready({ version: 1 });               // 报告入口已执行
await useful.reportProgress(50, "处理中");         // 遥测进度，不启动 native 工作
```

## 权限模型

| 权限 | 首发状态 |
| --- | --- |
| `process.launch.declared` | 仅 launcher 类型可声明；敏感能力 |

web/worker 插件必须使用 `permissions: []`。`dialog.open/save`、文件读写、通知、剪贴板、
`openExternal`、`requestPermission` 与 `network.fetch:*` 尚无可证明的取消/截止时间边界，
首发验证器和运行时均拒绝；不能仅在 manifest 中声明后使用。

## 消息协议（不使用 SDK 时）

> **不兼容变更：** window RPC 已删除。旧 SDK 或旧的内联 `postMessage` 请求不会获得权限。
> window 消息只允许一次 bootstrap，换得 port 后所有 RPC 必须走该 `MessagePort`。

bootstrap（iframe → 宿主 window，同时 transferable 携带由插件创建的一个 `MessagePort`）：

```json
{ "__usefulBootstrap": true, "capability": "<URL fragment 中的一次性 256-bit secret>" }
```

宿主不再向可能已导航的 `WindowProxy` 回传 port；它验证 secret 后，只在已收到的 port 上回送握手确认。随后请求仅走 port：

```json
{ "__usefulRpc": true, "id": "<唯一id>", "method": "getTheme", "params": null }
```

SDK 会等待自身文档 `load` 后的下一 task 才发送 bootstrap。宿主在首个真实插件文档的
`load` 回调前只关闭预加载/`about:blank` 提供的 port，随后仅为该 keyed iframe generation
开放一次握手。SDK 收到 port 后会尝试从地址栏移除 secret；若 opaque-origin 沙箱拒绝
History API，它不会为清理 fragment 而触发新导航，而宿主已将 secret 一次性消费。宿主
不会为 reload、外部导航或第二次请求重发 port；后续 load 会关闭旧 port。
由于 sandbox 没有 `allow-same-origin`，不能声称 `event.origin` 可区分插件。真实工作并发限制为
全局 16、每插件 2、交互式 1；响应超时不释放尚未 settle 的底层工作槽。

插件入口可引用本插件目录内的 `main.js`、`styles.css` 和图片。宿主 CSP 使用精确的
`/<plugin-id>/` 路径前缀，不会泛开放共享 `usefulplugin:` scheme，也不能加载另一个插件资源。

## 示例

- `examples/hello-web-tool`：零 native 权限 web 工具，演示 MessageChannel 握手与主题读取。
- `examples/external-launcher-tool`：launcher 工具，声明启动本地程序。
