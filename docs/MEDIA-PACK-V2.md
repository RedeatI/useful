# Media Pack v2（候选基础设施）

Media Pack v2 把 Windows 媒体运行时拆成两个独立下载单元：

| pack | 组件 | 用途 |
| --- | --- | --- |
| `preview` | `mpv` | 视频预览 |
| `transcode` | `ffmpeg`、`ffprobe` | 探测、裁剪、转码、缩略图 |

目标是让 setup Lite 和 Portable Lite 保持当前小体积，只有实际使用媒体功能的用户才下载相应
pack。安装全部 pack 后的磁盘占用不会凭空减少；主要收益是首包、按需下载和应用升级不重复携带
未变化的媒体运行时。

## 当前状态

本阶段落地了可审计的候选合同、独立打包工具、显式离线导入器，以及应用内 fail-closed 执行链：

- 正式 `scripts/media-runtimes.lock.json` 仍是 v1 `full_build`，没有改变 Full 能力或公开发布流程。
- `scripts/media-runtimes.v2.candidate.lock.json` 使用相同的正式 archive pin，只增加 pack 分组。
- `scripts/release-metadata-media.mjs` 可兼容读取 v1 和 v2；既有 Full manifest 语义不变。
- `scripts/media-pack-v2.mjs` 生成与 v2 lock、`MEDIA-RUNTIMES.json` 和实际组件字节绑定的
  `MEDIA-PACK.json`。
- `scripts/package-media-packs.ps1` 生成确定性 Optimal ZIP，但文件名和包内标记都明确为
  `unsigned-candidate`。
- `scripts/media-pack-signing.mjs` 可生成规范化的待签名声明，并用独立 Ed25519 公钥验签。声明绑定
  pack archive/manifest SHA-256、长度、pack id、平台/架构、lock digest、最低 Useful 版本，以及 GPL
  对应源码资产的文件名、SHA-256 和长度；工具不接受私钥，也不提供仓库内签名命令。
- `scripts/install-media-pack.ps1` 要求调用者同时提供 archive、外置 manifest、规范签名声明、detached
  signature、独立公钥和 GPL 对应源码资产。它先验证签名及闭合字节事实，再检查 ZIP 条目闭集和解压后
  组件 hash/size，最后安装到版本化目录并原子切换 `current-<pack>.json`。已有版本不会被覆盖或删除。
- `scripts/media-pack-catalog.mjs` 从闭合 plan 中逐项读取本地 archive、manifest、签名声明和
  GPL 对应源码资产；它重新计算每个 hash/size，用 v2 lock 验证 manifest，并在生成 catalog
  前验证每个 statement detached signature。工具只接受公钥，不存在私钥或签名入口。
- `useful-media::pack` 在 Rust 内验证 detached Ed25519 catalog/statement、HTTPS 资产闭集、外置
  manifest、archive hash/size、ZIP 条目闭集和解压后组件 hash/size，并维护版本化 current/previous
  指针。回滚只重新激活已验证版本，不删除任何版本目录。
- Tauri 只接受 `preview` 或 `transcode` pack id；renderer 不能传入 URL、公钥、签名或安装路径。下载先
  写独立 `.part`，支持取消，完成哈希校验后才进入安装器，成功后重新解析 sidecar current 指针。

未签名候选**不得上传到公开 Release，也永远不能由应用安装**。离线导入器与 Rust 安装器均已用隔离
夹具验证；应用会在视频导入前明确询问，并提供 Preview/Transcode 独立安装、进度、取消与回滚界面。
仓库仍没有生产 MediaPack 公钥或可信下载源，因此当前构建返回
`production-trust-not-configured`，安装按钮保持禁用。这是执行能力就绪，不是生产安装授权。

## 应用内可信执行链

正式构建必须同时提供三个编译期输入，缺一或含全零/非法值都会 fail closed：

```text
USEFUL_MEDIA_PACK_CATALOG_URL
USEFUL_MEDIA_PACK_CATALOG_SIGNATURE_URL
USEFUL_MEDIA_PACK_PUBLIC_KEY_HEX
```

它们只通过 Rust `option_env!` 固定进构建；应用不读取同名运行时环境变量，也不接受 renderer 或用户输入
替换公钥。两个 URL 必须是无凭据、无 fragment 的 HTTPS URL。catalog 使用
`useful.media-pack-catalog.v1` / `useful-media-pack-catalog-v1`，必须恰好包含 `preview` 和
`transcode`，并为每个 pack 闭合声明：

- archive、manifest、签名声明和 GPL 对应源码资产的 HTTPS URL、安全 basename、SHA-256 与长度；
- MediaPack 签名声明的 detached Ed25519 signature；
- catalog 自身的失效时间；生成时与应用验证时都限制最长 31 天有效期，降低旧 catalog 重放窗口。

客户端先验证 catalog 原始字节的 detached signature 和失效时间，再按 catalog 精确下载 archive、
manifest 与签名声明。GPL 对应源码 URL/hash/size 被 catalog 和签名声明双重绑定，但对应源码资产不作为
运行时组件下载；其持续可访问性仍由发布 Owner Gate 和发布证据闭合。HTTP redirect、压缩传输、超出
声明长度、hash 漂移、重复/额外 ZIP 条目、symlink 条目、版本不兼容或签名失败都会在激活前拒绝。

应用保留 `reqwest` 的默认代理发现，不允许 renderer 注入代理地址、认证信息或下载 URL。每个资产在同一
安装任务内最多请求 3 次：流中断后以现有 `.part` 长度发送 `Range`，有强 ETag 或 Last-Modified 时同时
发送 `If-Range`；只接受与 catalog 总长度、起止偏移完全一致的 `206 Content-Range`。服务器忽略 Range
并返回完整 `200` 时，会在同一已打开文件句柄上清零并重新校验完整 SHA-256，不拼接新旧响应。该能力不
等同于跨应用重启续传，也不承诺需交互认证的企业代理或 PAC 场景已经完成验证。

进度阶段为 `downloading -> verifying -> installing -> redetecting`。取消只影响当前任务并清理专属临时
目录；当前指针保持不变。安装成功后，Sidecar 解析顺序为显式环境覆盖、已验证 MediaPack current 指针、
应用旁 `binaries`、应用旁文件；默认不搜索系统 PATH。当前构建没有生产编译期输入，所以不会发起 catalog
请求。

每次重新检测都会校验已安装 manifest/receipt 绑定以及组件文件大小和 SHA-256。组件被删除、替换或隔离时，
该 pack 标记为“需要修复”并立即停止使用；有健康 previous 时可回滚，否则只有可信 catalog 可用时才能重新
下载修复。修复先完整验证新 payload，再把受损目录原子改名保留，绝不覆盖或执行受损组件。

### 降级与恢复矩阵

| 条件 | 应用行为 | 自动化证据边界 |
| --- | --- | --- |
| catalog 暂时不可用，已安装 pack 健康 | 已有预览/转码继续可用；新安装与修复禁用 | 本地状态与 UI 合同；不代表生产 CDN 可用性 |
| mpv 缺失或哈希不符 | 直接预览不可用；ffmpeg/ffprobe 转码能力保持独立 | Rust 组件健康检查与 UI damaged 状态 |
| ffmpeg 或 ffprobe 缺失/哈希不符 | 缩略图、探测、导出保持禁用；mpv 预览能力保持独立 | Rust 闭集健康检查与既有 VideoTrim 降级 |
| current 受损且 previous 健康 | 允许回滚到 previous；受损版本目录不删除 | Rust 安装/回滚测试 |
| current 受损且无健康 previous | 仅允许从构建固定公钥的可信 catalog 修复；受损目录改名保留 | Rust 重装修复测试与 renderer 边界检查 |
| 只有系统 PATH 存在同名程序 | 默认视为不可用，不静默执行 PATH 程序 | Rust resolver 与静态合同 |
| Portable 数据树不可写 | 数据库打开前停止并显示明确错误；不回退 AppData | 路径写探针单测与静态启动合同；真实只读介质仍需 native smoke |

### 离线 catalog 生成与验证

catalog plan 使用 `useful.media-pack-catalog-plan.v1`，包含未过期的 `expiresAtUnix`、相对 plan 目录的
`lockPath`，以及恰好 `preview` / `transcode` 两个 pack。每个 pack 只能声明以下字段：

```json
{
  "id": "preview",
  "archive": { "localPath": "preview/Useful-Media-Pack-preview-windows-x64.zip", "url": "https://media.example.invalid/Useful-Media-Pack-preview-windows-x64.zip" },
  "manifest": { "localPath": "preview/MEDIA-PACK-preview.json", "url": "https://media.example.invalid/MEDIA-PACK-preview.json" },
  "statement": { "localPath": "preview/MEDIA-PACK-SIGNING-preview.json", "url": "https://media.example.invalid/MEDIA-PACK-SIGNING-preview.json" },
  "statementSignatureHex": "<128 lowercase hex>",
  "correspondingSource": { "localPath": "preview/Useful-Media-Sources-preview.zip", "url": "https://source.example.invalid/Useful-Media-Sources-preview.zip" }
}
```

`localPath` 必须是不含 `..`、反斜杠或链接路径组件的 portable 相对路径，其 basename 必须与 HTTPS URL
一致。生成器不下载任何内容，只接受已完成证据审核的本地闭合资产：

```powershell
node scripts/media-pack-catalog.mjs --plan <catalog.plan.json> --public-key-hex <64-lowercase-hex> --output <MEDIA-PACK-CATALOG.json>
```

对 `MEDIA-PACK-CATALOG.json` **原始字节**的 Ed25519 签名必须由仓库/CI 之外的 Owner 管理系统完成；
不得把私钥路径、私钥内容或签名命令加入此工具。外部签名后用同一公钥离线复核：

```powershell
node scripts/media-pack-catalog.mjs --catalog <MEDIA-PACK-CATALOG.json> --signature-hex <128-lowercase-hex> --public-key-hex <64-lowercase-hex>
```

复核会拒绝过期 catalog、非规范 JSON 字节、字段/pack 闭集漂移和错误 detached signature。这两条命令
不代表 Owner 已批准公钥、资产 URL、GPL 证据或应用编译期注入。

## 本地候选打包

先准备经过现有 lock 下载并校验的 `binaries/ffmpeg.exe`、`ffprobe.exe`、`mpv.exe` 和
`CHECKSUMS.txt`，再运行：

```powershell
pnpm size:media-packs-candidate
```

默认输出到 `artifacts/size/media-packs-candidate/`：

```text
MEDIA-PACK-preview.unsigned-candidate.json
MEDIA-PACK-transcode.unsigned-candidate.json
Useful-Media-Pack-preview-windows-x64-unsigned-candidate.zip
Useful-Media-Pack-transcode-windows-x64-unsigned-candidate.zip
MEDIA-PACKS-CANDIDATE-SHA256SUMS.txt
```

脚本拒绝覆盖已有输出，拒绝 symlink/junction/reparse point，并使用固定 commit 时间、ordinal 路径
排序和 Optimal Deflate。中途进入交付阶段后会保留 incomplete marker，避免把半交付目录误当完成品。

## 离线导入验证

只有拿到 Owner 批准的独立公钥和同一候选证据闭集后，才可显式运行：

```powershell
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File scripts/install-media-pack.ps1 `
  -ArchivePath <pack.zip> `
  -ManifestPath <MEDIA-PACK.json> `
  -StatementPath <MEDIA-PACK-SIGNING.json> `
  -SignatureHex <detached-signature-hex> `
  -PublicKeyHex <owner-approved-ed25519-public-key-hex> `
  -SourceAssetPath <gpl-corresponding-source.zip>
```

默认安装根是 `%LOCALAPPDATA%\Useful\runtimes\media`，实际目标为
`<lock-digest>\<pack-id>`。导入器拒绝覆盖版本化目标；若 current 指针已存在，会通过同卷原子替换并
保留 `current-<pack>.previous.json`。自动化测试已覆盖连续三代 pack 激活：current 始终指向最新一代，
previous 始终指向上一代，三代版本化目录都保留。本阶段没有对用户真实 `%LOCALAPPDATA%` 执行安装，
仅在隔离临时目录完成验证。

## 上线前硬门

以下事项未完成前，状态保持 `CANDIDATE_ONLY`：

1. Owner 建立与 AppUpdate、插件/源根隔离的 MediaPack Ed25519 根，并批准生产公钥；仓库只存公钥，
   不存私钥。签名声明、验签和显式离线导入合同已实现，但当前没有生产根，因此应用集成继续 fail closed。
2. 离线签名流程必须使用 `media-pack-signing.mjs` 生成的规范字节，并把 detached signature 与声明
   作为同一候选证据闭集；不得在 CI 或仓库内导入私钥。
3. 下载/离线导入都执行签名、哈希、大小和闭集 basename 校验；应用下载额外拒绝 redirect 与压缩传输，
   Rust 安装器拒绝额外/重复/链接 ZIP 条目，并只原子激活版本化目录。
4. 安装到 `%LOCALAPPDATA%\Useful\runtimes\media\<lock-digest>\`；不得动态写入
   `Program Files`，也不得删除 `%APPDATA%\Useful`。
5. 临时目录完整验证后再原子切换 current manifest；失败保留旧版本，半下载目录不可激活。
6. 应用默认不得静默搜索或执行 PATH 中的同名媒体程序。
7. Preview/Transcode pack 体积预算、企业代理/PAC、跨应用重启续传、真实企业杀毒产品和真实只读介质 native
   回归全部通过。默认代理发现、同任务三次严格 Range 重试、Portable 写探针、组件健康校验、受损包可信修复/
   回滚、应用降级、导入前确认、可取消下载、验证安装与重新检测已有本地合同；生产信任输入缺失时动作继续禁用。
8. 即使改为按需下载，GPL 对应源码和许可证 Owner Gate 仍必须闭合。

## Essentials 的关系

当前 v2 候选继续使用 `full_build`，因此不改变 AV1 软件编码能力，也不会降低“安装全部 pack”后的
总体积。上一轮 essentials 评估约可把 Full ZIP 从 224 MB 降到 120 MB，但缺少 `libsvtav1`。
只有产品明确接受 AV1 软件编码降级且 GPL Owner Gate 闭合后，才能把 v2 archive pin 切换到
essentials；pack 化本身不能替代这项产品决策。
