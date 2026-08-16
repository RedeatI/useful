# Useful 插件开发者预览

简体中文 · [English](DEVELOPER-PREVIEW.en.md)

外部 Agent 的非交互 `create → doctor → validate → pack → publisher init → publisher sign →
publisher verify` 流程，以 [`agent/BUILD-A-TOOL.md`](agent/BUILD-A-TOOL.md) 为唯一事实源。本页只为
人类开发者补充本地 Preview 入口，不能覆盖、缩短或重新解释 Agent 流程。

`useful` CLI/package、`useful-artifact-v1` 签名域和 `.useful` 扩展名是 Useful 保留的兼容开发者接口，
不会因公开品牌变化而自动改名。

## 选择本地入口

只选择一个已经存在于本机的入口：

- 已解压的 Agent Kit：使用 `<ABS_KIT>\bin\useful.cmd`（Windows）或
  `<ABS_KIT>/bin/useful`（macOS/Linux）。按 [README](../README.md) 与
  [已知限制](KNOWN-LIMITATIONS.md)，当前公开 Release/入口（包括 Agent Kit）为
  [`v0.1.0-beta.11`](https://github.com/RedeatI/useful/releases/tag/v0.1.0-beta.11)。使用该版本时，
  必须从同版本 Release 取得精确 Agent Kit，并核对该 Release 的 `SHA256SUMS.txt` 与来源证据。
  仓库中最后一份精确的跨平台 Agent Kit acceptance 仍只绑定 beta.10；见
  [`0.1.0-beta.10-agent-kit-acceptance.md`](releases/0.1.0-beta.10-agent-kit-acceptance.md)。
- 源码 checkout：使用仓库内 `packages/useful-cli/bin/useful.mjs`，并由本机 Node.js `^20.9.0` 或 `>=22.0.0`
  版本直接运行。下列示例采用这个入口。

不要使用在线 package runner、全局同名命令或任何会在执行时隐式从 registry 解析包的入口。本页不提供
依赖下载命令；源码 checkout 的锁定依赖应由操作者在进入本流程前显式准备完成。launcher 解析失败时
立即停止，不回退到网络下载。本地 Agent Kit 构建仍不授权公开分发；beta.10 的 acceptance 不能套用为
beta.11 的验收或校验记录。

```powershell
$useful = (Resolve-Path '.\packages\useful-cli\bin\useful.mjs').Path
node $useful agent-contract --json
```

每个命令只解析 stdout 的一个 JSON 文档，任一步非零立即停止。目标目录、输出目录和 publisher 目录都
必须尚不存在；不要使用 force，也不要覆盖旧产物。

## 创建并检查本地工具

```powershell
node $useful create '.\my-tool' --id com.example.mytool --name 'My Tool' --template minimal-web --json
node $useful doctor '.\my-tool' --json
node $useful validate '.\my-tool' --json
node $useful pack '.\my-tool' '.\dist-useful' --json
```

`minimal-web` 是默认零权限模板。只有确实需要声明式 `pipeline-v1` Action 时才选择
`minimal-action`；它不提供任意脚本、worker、WASM/WASI、native 或命令执行能力。

## 发布者签名

从成功 pack 结果的 `data.artifactPath` 取得 `<ARTIFACT_PATH>`，不要手写或复用旧路径：

```powershell
node $useful publisher init '.\publisher' --id com.example.preview --name 'Preview Publisher' --json
node $useful publisher sign '<ARTIFACT_PATH>' --key '.\publisher\publisher.private.pem' --json
node $useful publisher verify '<ARTIFACT_PATH>' '<ARTIFACT_PATH>.publisher-signature.json' --json
```

签名域固定为 `useful-artifact-v1`，覆盖 tool ID、版本和 `.useful` SHA-256。私钥只保留在仓库外的
publisher 私有目录；不得提交、复制到诊断包或输出到日志。verify 必须返回 `valid: true`，并与 pack
的 SHA-256 一致。

## 本地静态源预览

以下 `source publish` 只在本地源目录生成签名 metadata；它不会上传网络、创建 GitHub Release 或
授权公开分发。继续使用同一个已解析 launcher，并使用全新的源目录和导出目录：

```powershell
node $useful source init '.\preview-source' --name 'Preview Source' --id com.example.preview-source --json
node $useful source add-package '.\preview-source' '<ARTIFACT_PATH>' --json
node $useful source publish '.\preview-source' --json
node $useful source validate '.\preview-source' --json
node $useful source export-static '.\preview-source' '.\preview-source-dist' --json
```

只有 `export-static` 的公开目录才是可部署输入。部署、远程上传、动态源登记、withdraw 与任何公网
操作都不属于本地 Preview；它们需要操作者对明确目标另行授权。CLI 不会自动发布。

## 示例

- [`base64-tool`](../examples/base64-tool/)：最小无权限 Web 工具。
- [`file-hash-tool`](../examples/file-hash-tool/)：显式文件权限、分块读取、进度与取消。
- [`qr-code-tool`](../examples/qr-code-tool/)：离线静态依赖、CSP 与许可证示例。
- [`json-diff-pro-tool`](../examples/json-diff-pro-tool/)：保留的高级示例，用于较复杂的本地差异流程；
  “Pro” 是示例名称，不表示付费服务、已发布套餐或生产支持承诺。

## 安全边界

- 插件不能直接访问 `window.__TAURI__`；只通过 SDK/宿主桥请求已声明权限。
- 不把任意文件系统、网络或进程能力作为开发便利默认授予。
- 更新必须保持 source、publisher、tool 与 action identity 一致；新增权限必须重新确认。
- 撤回阻止新安装，但不远程删除已安装版本。
- 本地成功打包或签名不等于正式签名、公证、GitHub 发布或公开分发已完成。
