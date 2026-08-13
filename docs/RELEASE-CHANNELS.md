# Useful 发布通道与 GitHub Release 门禁

## 当前状态边界

- **已实现：** 本文描述的通道校验、候选产物汇总和 fail-closed 发布门禁已有本地配置。
- **已验证：** 只有最终公开 commit 同时通过 strict 公共源检查和 receipt verifier，才构成公开源码
  候选证据；“工作流文件存在”不等于远程 CI、跨平台安装包、签名、公证或发布成功。
- **未由本文证明：** 远程工作流、制品上传、GitHub Release、更新源部署和生产服务变更都必须由各自
  针对精确候选的执行证据证明。
- **Owner Gates：** 任何含非公开开发历史的仓库都不得原地公开；公开视图必须只包含经收据绑定的净化
  初始历史。仓库 Owner、保护规则、release actor allowlist、environment 审批者、生产更新根/feed、
  签名凭据和最终法律复核必须在发布前配置并验证。门禁解决前，下述工作流只能视为配置。

最终公开视图必须从经复核的净化初始历史开始，不得暴露或镜像私有开发历史。GitHub 的 source archive
会暴露 tag 的完整树，因此公共源检查默认必须严格失败：内部报告、handoff、legacy phase 脚本等任何
非公开路径仍在候选树中时都不能发布；仅生成“排除清单”不构成发布证据。

`.github/workflows/release.yml` 是 Useful 唯一的 Release 编排。它只接受手动 `workflow_dispatch`；
选择已有 tag ref 后，操作者必须明确选择 `source-agent-kit`、`desktop-lite` 或 `desktop-full` scope，并选择
`stable`、`beta` 或 `nightly` 通道。推送 tag 本身不会触发构建或发布。

`source-agent-kit` 是非桌面 source preview，只允许 beta/nightly：资产闭集为公开源码证据、Agent Kit、
SBOM、legal 文件、源码 manifest、provenance、Owner gate、资产清单和校验和。它不运行或削弱桌面
build/signing/update/media Full 门禁，不包含任何桌面二进制，也不作签名、公证、安装或平台支持声明。
Agent Kit builder 的 `publicationAuthorized=false` 不会被 workflow 改写；独立 Owner gate 只授权该次
source preview 发布。`desktop-lite` 只允许 Windows Setup Lite、Portable Lite 和相应证据闭集进入 Release，
明确排除 Full 媒体运行时与 macOS/Linux 桌面资产；`desktop-full` 继续执行本文描述的全部严格门禁。

## 版本、tag 与通道

工作流从根 `package.json` 读取版本，并先运行 `scripts/check-version-drift.mjs --json`。随后
`scripts/release-metadata.mjs` 对下列规则 fail closed：

| 通道 | 版本格式 | 唯一合法 tag | GitHub Release |
| --- | --- | --- | --- |
| stable | `X.Y.Z` | `vX.Y.Z` | 非 prerelease，可设 latest |
| beta | `X.Y.Z-beta.N` | `vX.Y.Z-beta.N` | prerelease |
| nightly | `X.Y.Z-nightly.YYYYMMDD.RUN` | `vX.Y.Z-nightly.YYYYMMDD.RUN` | prerelease |

版本、tag 或用户选择的通道有任何漂移都会在构建前停止。版本变更仍使用现有
`scripts/set-version.mjs`，不要直接只改某一个清单。

## 仓库身份与更新信任前置变量

Release workflow 只允许在唯一、公开的规范仓库中运行。`scripts/release-publish-gate.mjs`
会在构建前逐项 fail closed；变量缺失、占位值、身份不匹配或 actor 未精确列入 allowlist 都会停止：

- `USEFUL_EXPECTED_REPOSITORY`：精确的 `owner/repository`；
- `USEFUL_RELEASE_ACTORS`：逗号或空白分隔的 GitHub 账号精确名单；
- `USEFUL_UPDATE_ROOT_PUBKEY_HEX`：离线仪式产生的 32 字节 Ed25519 公钥，不得等于开发占位值；
- `USEFUL_UPDATE_FEED_URL_TEMPLATE`：真实 HTTPS 地址，必须同时含 `{channel}`、`{platform}`、
  `{arch}`，拒绝 localhost 与 `.example/.test/.invalid`；
- `USEFUL_UPDATE_ROOT_CEREMONY_SHA256`：受审阅的离线根仪式 receipt SHA-256。

公钥和 feed 模板通过编译期环境注入 `useful-bootstrap`；私钥不进入仓库、Actions variables、
secrets 或 runner。stable 正式发布还必须在 tag 中包含 `docs/releases/` 下的
`useful.stable-update-evidence.v1` 证据文件，并配置其路径和 SHA-256。该文件必须绑定 tag 与
更新根指纹，并明确证明签名验证、篡改拒绝、升级和回滚均通过。

## 构建产物

构建矩阵与发布 job 分离。构建前会在 tag 的干净 checkout 上重跑公开源码清单、版本/工作流/i18n、
Node/CLI/MCP/前端、Rust、Go 与 Compose 门禁。`publish=true` 还要求同一 commit 的常规 CI 和三项
平台受限矩阵 check 均为 success，避免手动 dispatch 绕过 CI。构建 job 只有 `contents: read`，
输出先进入 GitHub Actions artifact；assemble job 汇总后生成 `SHA256SUMS.txt`、CycloneDX SBOM、
`SIGNING-STATUS.json`、`RELEASE-METADATA.json`、`PUBLISH-GATE.json`、源码清单与构建 provenance。

channel 与 edition 是两条独立轴：channel 决定 stable/beta/nightly 更新流；edition 决定同一版本的
打包内容。Windows x64 edition 语义为 setup Lite、Portable Lite、Portable Full。Full 内含固定版本且
经 SHA-256 校验的 ffmpeg、ffprobe、mpv，Lite 不内置这些媒体运行时。精确资产文件名和闭集正在由
Release allowlist 收敛。`desktop-lite` 的公开闭集只取 Windows Setup Lite 与 Portable Lite；构建矩阵产生的
其他内部候选不会进入其 candidate、签名清单、校验和或 GitHub Release。本文不猜测下载地址或声称候选
产物已经发布。

| 平台 | 架构 | edition / 包边界 |
| --- | --- | --- |
| Windows | x64 | setup Lite、Portable Lite、Portable Full |
| macOS | x64 | DMG 发布合同不包含媒体运行时或 Full edition 承诺 |
| macOS | arm64 | DMG 发布合同不包含媒体运行时或 Full edition 承诺 |
| Linux | x64 | AppImage/deb 发布合同不包含媒体运行时或 Full edition 承诺 |

对外文件和产品名统一为 Useful。Windows 的 Portable Lite/Full ZIP 使用 `Useful.exe`、
`useful-bootstrap.exe`、`portable.flag` 和 `update/current-version.txt`，并由发布门禁检查这些名称与
实际构建产物一致。

Release asset 清单是显式闭集，不使用目录 glob。除平台产物外还包括根 `LICENSE`、`LICENSES.md`、
`NOTICE`、`THIRD_PARTY_NOTICES.md`、`TRADEMARKS.md`、SBOM、源码 manifest、构建 provenance、
签名/门禁元数据和 `SHA256SUMS.txt`；任何额外或缺失文件都会使 assemble 失败。

预期的 `Useful-<version>-agent-kit.zip` 是跨平台附加资产，不是 Windows 的 Lite/Full edition。
它必须进入显式 asset allowlist，ZIP 内含闭集 `MANIFEST.json`，ZIP 外提供
`Useful-<version>-agent-kit.zip.sha256`，并纳入最终 `SHA256SUMS.txt` 和构建 provenance。包内 legal
文件闭集为 `LICENSE`、`LICENSES.md`、`NOTICE`、`THIRD_PARTY_NOTICES.md`、`TRADEMARKS.md`；根
`LICENSE` 缺失即失败。macOS/Linux 路径在实际远程 CI 完成前只能标记为“已配置 / 待远端验证”，
不能据此声称已验证或已发布。

Portable Full 可以生成内部构建候选，但公开分发 GPL ffmpeg/mpv 前，Owner 必须为精确二进制闭合
对应源码、构建脚本/配置、许可证文本和持续可访问证据。没有绑定候选的完成证据时不得公开发布 Full；
内部候选不构成法律结论或公开分发授权。

## 签名和公证

仓库不包含证书、私钥或密码。Windows 构建仅在下列两个 secret 都存在时导入临时 PFX、让 Tauri
bundler 签名，并以 `Get-AuthenticodeSignature` 验证二进制和 NSIS 安装器：

- `WINDOWS_CERTIFICATE_BASE64`
- `WINDOWS_CERTIFICATE_PASSWORD`

macOS 构建仅在下列 secret 全部存在时让 Tauri 执行签名和 Apple 公证，并验证 app 的 codesign 与
DMG 的 stapled ticket；`APPLE_SIGNING_IDENTITY` 可在证书包含多个 identity 时显式指定：

- `APPLE_CERTIFICATE`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_ID`
- `APPLE_PASSWORD`
- `APPLE_TEAM_ID`
- `APPLE_SIGNING_IDENTITY`（可选）

`stable` 同时要求 repository variable `USEFUL_SIGNING_READY=true`，并要求所选 scope 内全部可签名平台
证据成功：`desktop-lite` 要求 Windows；`desktop-full` 要求 Windows、macOS x64 与 macOS arm64。
变量只是治理开关，不能替代实际验证；适用于所选 scope 的任一 secret 缺失或验证失败都会阻断 stable。

beta/nightly 可以在未配置签名 secret 时构建，但最终元数据、发布说明和 Release 名称都会明确包含
`UNSIGNED PREVIEW`，不能被误认为已签名正式版本。

## 唯一发布入口

只有两个隔离的 publish job 拥有 `contents: write`。`publish` 仅服务 `desktop-lite` 或 `desktop-full`，并且必须同时满足：

1. 事件是 `workflow_dispatch`；
2. 当前 ref 是与版本严格一致的已有 tag；
3. dispatch 输入 `publish=true`；
4. build、SBOM、签名状态、metadata 与 SHA-256 门禁全部通过；
5. 规范仓库、public visibility、actor allowlist、生产更新根/feed/仪式 receipt 均验证通过；
6. stable 的 tag 内更新签名/篡改/升级/回滚证据验证通过；
7. GitHub `release` environment 已批准。

发布使用 runner 自带 `gh release create --verify-tag`，不会覆盖同名现有 Release。未选择
`publish=true` 时只留下有保留期限的 Actions candidate artifact，不创建 Release、不上传到其他服务。

`publish-source-agent-kit` 仅服务 `source-agent-kit`，固定创建 prerelease，且必须在同一 tag 和 commit 上
先有一次成功的 `publish=false` dry-run；它同样受公开规范仓库、精确 actor allowlist 和 `release`
environment 审批约束。其 Release 标题与 notes 固定声明不含桌面二进制，显式资产数组来自闭集
`RELEASE-ASSETS.txt`，禁止目录 glob。
