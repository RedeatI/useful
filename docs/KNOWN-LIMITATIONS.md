# 已知限制

简体中文 · [English](KNOWN-LIMITATIONS.en.md)

本文件描述 Useful 源码候选适用的功能和验证边界。它不表示任一候选已经上传 GitHub、完成正式签名
或公证，也不表示已经通过目标平台的真实 runner 与原生验收。

## 平台验证边界

| 范围 | 已实现或可检查的范围 | 精确候选仍需验证 |
| --- | --- | --- |
| Windows | 后台构建、自动化测试和原生验收入口已实现；证据要求见 [测试矩阵](TEST-MATRIX.md) | GUI 启动、主题、导航、视频预览、进程与网络能力、安装包运行及签名必须绑定精确候选、设备和结果 |
| macOS | 工作流、平台配置与依赖图可静态检查 | 真实 macOS runner 上的编译、DMG 打包、签名、公证、安装与启动 |
| Linux | 工作流、平台配置与依赖图可静态检查 | 真实 Linux runner 上的编译、AppImage/deb 打包、安装与启动 |

CI 或工作流文件存在只证明构建路径已配置，不证明远程任务运行过、目标平台产物可用或安装包已经发布。
本地后台测试不能替代绑定同一候选的用户可见原生验收。

## 功能与验证限制

### 原生桌面体验需按候选复核

- GUI 启动、浅色/深色主题、主导航、设置页与中英文切换必须在精确候选上进行屏幕检查。
- 视频预览需要真实媒体、`ffprobe` 与预览后端共同验证；支持的扩展名不等于每个文件都能播放。
- 进程与网络视图依赖平台能力与权限；采样、刷新、空状态、失败提示及破坏性操作确认需要原生运行验收。
- 在这些检查完成前，不应把源码构建描述为已完成视觉验收或可供正式生产使用。

### 跨平台能力并不对等

嵌入式 mpv 预览、ETW/网络/GPU 采集、Job Objects 与 `.lnk` 快捷方式属于 Windows 专属或以
Windows 为主要验证目标的能力。macOS/Linux 应明确降级或报告不可用，不能用静态配置检查推断行为等价。

### 大文件与扩展故障矩阵尚未完成

常规下载、摘要校验、安装回滚与资源预算有自动化覆盖，但 1 GiB/10 GiB 长时运行、磁盘耗尽、对象存储
短暂不可用、metadata 写入中断和系统断电级模拟仍属于后续矩阵。没有这些结果时，不应声称极端环境已被
完整验证。

### Agent 与 Office 文件边界

- 默认 AI-callable registry 目前是 36 个内建 Action（31 个 utility + 5 个 Office action family）。默认 MCP
  还注册 `useful.actions.search`、`useful.actions.describe`、`useful.actions.suggest` 与
  `useful.actions.recipe`，所以 `tools/list` 共 40 项；这 4 个 helper 不是 Action。CLI 与 MCP 仍是需要
  Node.js 的源码入口，不是已签名的独立发行物。
- DOCX/PPTX/XLSX/CSV/Markdown 能力针对简单结构的组合、提取与转换，不是 Word、PowerPoint 或 Excel 的
  完整兼容编辑器。复杂样式、图片重排、主题/母版、动画、图表、批注、修订、受密码保护文件与数字签名
  可能被拒绝、忽略或无法保真；必须用目标应用针对精确候选另做互操作验收。
- PDF 只提供结构检查、页面合并/拆分/提取/删除/重排/旋转与有限清理，不包含 OCR、内容编辑、电子签名
  验证或完整的敏感信息擦除。`sanitize` 删除 trailer `Info`/`ID`、Catalog/Page 的 XMP `Metadata` 和已知主动内容入口，并用
  二次页面图复制避免保留第一遍已脱离对象；它不分析内容流或覆盖未知 PDF 扩展，不能当作通用恶意 PDF
  净化或审计工具。`inspect.pageDetails` 的 `index`、`widthPoints`、`heightPoints`、`rotationDegrees` 只描述
  解析到的逐页几何，不证明渲染正确、内容安全或已经完成敏感信息擦除。
- Office Action 不接受任意文件路径或 URL，只接受闭集 JSON 与 strict canonical Base64。单个输入 Base64 字段
  上限为 6,000,000 字符，Action 输入/输出 JSON 预算为 8 MiB/16 MiB，单个返回二进制上限为 8 MiB；
  超限、加密、畸形或 ZIP 预检失败的文件会 fail closed。
- worker 隔离可在取消或超时时终止，但不是操作系统 sandbox。处理代码不执行宏、公式、嵌入脚本、外部
  relationship 或网络请求；这表示“不执行”，不表示任意输入中的主动内容已被完整删除或证明安全。
- “本地处理”不等于内容只对最终用户可见：Base64 正文会经过调用它的 Agent host、stdio/CLI 进程和 worker
  内存。Useful 将 Office 输入/输出标记为 sensitive 并要求日志脱敏，但宿主自身的会话、日志、备份和上传
  策略仍需由使用者单独核对。
- 智能推荐只分析调用方显式提供、最多 64 KiB 的文本。它不会自动读剪贴板，也不会在结果中回显样本；
  但样本仍会经过发起调用的 Agent host 和 CLI/stdio 进程。推荐只覆盖当前 profile 可见 Action，同分项按
  canonical actionId 稳定排序；它是内容启发式，不保证给出唯一或最适合的操作。
- `useful.action-recipe.v1` 最多 16 步，只能调用当前 profile 暴露的 canonical、只读、非破坏、幂等、
  closed-world、零权限、零副作用 Action。它不支持插值、表达式、脚本、文件、网络或进程入口；只接受对
  recipe 输入和已完成步骤输出的 JSON Pointer。请求上限 1 MiB，累计中间值上限 8 MiB，整条 recipe 总超时
  60 秒且每步另受 descriptor timeout。逐步 receipt 已脱敏，但最终 output 仍可能包含 recipe 明确选取的内容。
- 视频/进程 host action 是显式 `--host-config` 才注册的可选 pack，不在默认 36 个 Action 中。源码 CLI 已按
  实际加载 entry 派生权限并对破坏性调用要求本次 `--confirm`；源码 MCP 只授权已加载的只读 entry，永不
  代替用户确认。它们仍不是已发布的独立 CLI/MCP，真实 ffmpeg/ffprobe、进程终止、取消后的部分输出以及
  Windows/macOS/Linux 行为必须绑定精确候选另行验收。
- Agent Kit 构建器会产生 3 个命令 bundle 和 2 个固定 worker bundle，并保存 descriptor provenance 源码与
  实际打包依赖的逐包许可证文件。它仍是 internal candidate；这只证明归档合同已实现，在精确 ZIP、
  SHA-256、清单、许可证闭集和目标平台执行结果未验证前，不能称为已发布或跨平台验收通过。

### Sigstore/Rekor 验证范围

当前实现可验证既有签名材料、证书身份策略与制品摘要，并在必要材料缺失时 fail closed；完整在线 Rekor
一致性查询与 Merkle inclusion proof 仍不是已完成的生产保证。

## 分发与许可硬门

- Windows x64 edition 约定为 setup Lite、Portable Lite 和 Portable Full；channel
  （stable/beta/nightly）与 edition 是独立轴。
- Full 计划包含固定版本且经 SHA-256 校验的 `ffmpeg`、`ffprobe`、`mpv`；Lite 不内置这些媒体
  运行时。macOS/Linux 的发布合同不承诺 Full edition 或内置媒体运行时。
- 应用内 MediaPack 下载、验签、版本化安装和回滚链已实现；生产 catalog 与公钥必须在精确候选中注入
  并验证，缺失时安装保持 fail closed。已保留 `reqwest` 默认代理发现，并支持同一安装任务内最多三次
  严格 Range 断点重试；跨应用重启续传及需交互认证的企业代理/PAC 尚未闭合。Portable 已增加逐目录
  写探针，不可写时在数据库打开
  前明确停止且不回退 AppData；受损 MediaPack 会停止使用、拒绝 PATH 回退，并可从可信资产修复或回滚。
  这些是本地合同，不等同于已在主流企业杀毒产品和真实只读介质上完成兼容认证。
- **Full 公开分发受 GPL 对应源码与许可证证据硬门约束。** 在对应源码包、精确版本映射、许可证与
  notice、校验和及可复现分发证据齐备并经所有者复核前，不得公开发布 Full 资产。
- 规范公开仓库已为 `https://github.com/RedeatI/useful`。生产代码签名身份、生产更新根、macOS
  签名/公证材料与正式安装包发布仍须由 Owner 配置并针对精确候选验证。
- 根许可证与第三方许可证闭集必须以当前公开快照为准；本文件不能代替法律审查或许可证确认。

## 已公开与仍缺项

### 已完成

- 公开仓库：`https://github.com/RedeatI/useful`
- 源码与 Agent Kit 预览 Release（例如 `v0.1.0-beta.3`）
- 双语 README 与英文入口文档

### 仍需 Owner / 平台证据

- Windows/macOS 正式代码签名身份与 macOS 公证凭据
- 生产更新根与 HTTPS 更新 feed
- Full edition 的 GPL 对应源码和许可证证据
- [`SECURITY.md`](../SECURITY.md) 中已启用并实测的 Private Vulnerability Reporting
- 精确候选的真实 macOS/Linux runner 执行，以及绑定候选的 Windows 原生视觉与运行验收
- 社区投稿入口（Issues / PR intake）在私报通道与 CoC 执法路径就绪前保持关闭
