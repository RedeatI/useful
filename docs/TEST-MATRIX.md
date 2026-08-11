# 测试与证据矩阵

本页定义可复现命令、覆盖边界和发布证据要求，不记录脱离精确提交的历史通过数。命令存在、工作流已
配置或合成夹具通过，都不能证明当前候选、远程平台、签名产物或公开发布已经通过。

## 证据记录规则

每次验证记录至少应包含：

- 精确的 Git commit 与 tree；若工作树非干净状态，还要记录状态和差异指纹，并将结果标为非权威；
- 完整命令、执行目录、工具链版本、操作系统、架构、runner 或设备身份；
- 首次执行的退出码和完整结果；任何未执行、跳过或基础设施失败项都要单独列出；
- 对产物检查记录文件名、字节数、SHA-256、签名状态及其所绑定的 commit；
- 对远程检查记录工作流、job、run 与目标 commit，不用本地或静态检查替代远程结果。

测试数量只能从该次完整输出中引用。不得沿用其他 commit 的计数，也不得挑选重跑结果制造通过。

## 核心源码门禁

| 范围 | 命令 | 证明范围 | 不证明 |
| --- | --- | --- | --- |
| Node workspace lint | `pnpm -r lint` | 当前 checkout 的 JavaScript、TypeScript 与 Vue 静态规则 | 类型正确、测试通过或远程 CI |
| Node workspace typecheck | `pnpm -r typecheck` | 当前 checkout 的 workspace 类型契约 | 运行时行为或平台打包 |
| Node workspace tests | `pnpm -r test` | 当前 checkout 实际执行到的 Node/前端/CLI/SDK/runtime/MCP/协议测试 | 未运行测试、原生 GUI 或跨平台安装 |
| Rust format | `cargo fmt --all -- --check` | Rust 格式 | 编译或运行正确性 |
| Rust lint | `cargo clippy --workspace --all-targets -- -D warnings` | 当前工具链与目标集合的 Rust lint | 其他平台编译或原生运行 |
| Rust workspace tests | `cargo test --workspace` | 默认 workspace 测试目标 | `--all-targets`、GUI、安装包或其他系统 |
| Rust 全目标测试 | `cargo test --workspace --all-targets` | 当前平台可构建并执行的全部 workspace 测试目标 | macOS/Linux runner 或发布 bundle |
| bootstrap 聚焦测试 | `cargo test -p useful-bootstrap` | 更新应用、校验与回滚合同 | 生产更新根、正式签名或真实升级部署 |
| Release 合约 | `pnpm release:checks` | metadata、打包闭集、门禁与签名状态的合约测试 | 构建、签名、上传或 GitHub Release |

Go 检查从仓库根执行，并将构建输出放入新的临时目录：

```powershell
$goOut = Join-Path ([IO.Path]::GetTempPath()) ("useful-go-build-{0}" -f [guid]::NewGuid())
New-Item -ItemType Directory -Path $goOut | Out-Null
Push-Location '.\services'
try {
  $unformatted = @(gofmt -l .)
  if ($LASTEXITCODE -ne 0) { throw "gofmt failed with exit code $LASTEXITCODE" }
  if ($unformatted.Count -ne 0) { throw "gofmt reported unformatted files: $($unformatted -join ', ')" }
  go vet ./...
  if ($LASTEXITCODE -ne 0) { throw "go vet failed with exit code $LASTEXITCODE" }
  go test ./...
  if ($LASTEXITCODE -ne 0) { throw "go test failed with exit code $LASTEXITCODE" }
  go build -o (Join-Path $goOut 'useful-source-server.exe') ./source-server/cmd/server
  if ($LASTEXITCODE -ne 0) { throw "server build failed with exit code $LASTEXITCODE" }
  go build -o (Join-Path $goOut 'useful-source-worker.exe') ./source-worker/cmd/worker
  if ($LASTEXITCODE -ne 0) { throw "worker build failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}
```

`gofmt -l .` 只有在标准输出为空时才通过。检查完成后可以删除明确的临时输出目录；不得把生成的二进制
加入提交或公开源码快照。

## Agent 与 Office 专项证据

| 范围 | 命令 | 证明范围 | 不证明 |
| --- | --- | --- | --- |
| Action registry 与 worker | `pnpm --filter @useful/action-runtime test` | 本次实际执行到的 descriptor/schema、36 个默认 handler、搜索/推荐、recipe 验证与执行、错误脱敏、预算、取消，以及 regex/Office worker 合同 | CLI/MCP 进程、原生 host、操作系统 sandbox 或真实 Office 互操作 |
| Office core | `pnpm --filter @useful/office-core test` | 本次实际执行到的 OOXML ZIP 预检、DOCX/PPTX/XLSX/CSV/Markdown 闭集转换、spreadsheet 检查/Markdown 转换与 PDF 检查/页面操作 | Microsoft Office/LibreOffice/Acrobat 的完整渲染保真、OCR、签名或恶意文档净化 |
| 可选 host pack | `pnpm --filter @useful/host-actions test` | 配置闭集、允许目录、固定 argv、输出预算、PID+启动时间身份及 fail-closed overwrite 合同 | 真实 ffmpeg/ffprobe、进程终止、平台权限或取消后的部分文件清理 |
| JSON runtime CLI | `pnpm --filter @useful/runtime-cli test` | 本次实际执行到的 list/search/suggest/describe/run/recipe、过滤排序分页、stdin/`@request.json`、host opt-in/grant/单次确认与稳定错误合同 | 已发布 standalone CLI、GUI、MCP host 或真实原生程序执行 |
| stdio MCP | `pnpm --filter @useful/mcp test` | 本次实际执行到的 registry 映射、40 项默认 `tools/list`、4 个 helper、官方 client stdio call、profile 过滤、取消、host 只读授权/破坏性拒绝和进程清理 | 任一外部 Agent 产品的配置正确、真实原生程序执行、联网服务或 GUI |
| Agent Probe V1 | `pnpm --filter @useful/cli test` | 当前 Useful MCP 的只读 self-probe：v1 文档、40 个默认工具、36 个默认 Action、4 个 helper、本地 MANIFEST hash/size 闭集限定的 `artifactVerified`、目录数量/深度预算、stdio transport close、原始 child stderr 不回显而仅返回 bytes/hash；30 秒硬截止从同步预检后开始，只覆盖 MCP 执行与关闭；ASCII `USEFUL_PROFILE` 校验也必须覆盖 Unicode 拒绝 | 同步路径/MANIFEST 预检的耗时上限、签名、来源、sidecar、发布授权、launcher、宿主配置、Codex/Claude 安装或握手、外部 launcher 网络/副作用、远程发布 |
| Agent Kit 与 Agent 连接导出 | `pnpm --filter @useful/cli test` | 本次实际执行到的 5 bundle 闭集、自包含导入、协议 provenance/schema、逐包第三方许可证、清单/摘要，以及 `agent plan`/只读 `doctor`/secret-free、current-host-only `agent export` 的无 monorepo 运行夹具 | 正式发布、远程 runner、签名、发布授权、任一外部 Agent 宿主配置、跨主机复用、宿主写入、launcher 启动、联网或 MCP handshake；Agent Kit 仍是 internal candidate |
| Host-injected browser adapter | `pnpm --filter @useful/computer-use-browser-adapter test` | 仅证明该 checkout 中 host-injected isolated browser adapter interface 的定向 Node 合同测试；不证明默认 Computer Use provider、浏览器发行物、真实浏览器宿主、GUI、跨平台运行或远程发布 |

默认 Action 数量的静态口径必须从同一 checkout 的源码推导：
`packages/action-runtime/src/semantics.mjs` 中 31 个 `ACTION_IDS`，加上
`packages/action-runtime/src/office-actions.mjs` 中 5 个 `OFFICE_ACTION_IDS`，并确认二者由
`packages/action-runtime/src/builtins.mjs` 的 `BUILTIN_ACTIONS` 组装。MCP 的
`useful.actions.search`/`describe`/`suggest`/`recipe` 是 helper，不计入 36，因此默认 MCP 工具数是 40。
插件 actionId/alias 必须拒绝这 4 个保留名。这个清单口径不是测试通过数；
任何“通过”仍须引用该次命令的完整输出。

Action recipe 自动化证据应覆盖 canonical actionId、当前 profile 过滤、readOnly/non-destructive/idempotent/
closed-world/零权限/零副作用资格、最多 16 步、前向引用拒绝、无插值/脚本、1 MiB 请求、8 MiB 累计中间值、
60 秒整条 recipe 总超时、每步 descriptor timeout、取消传播和逐步脱敏 receipt。推荐证据应覆盖显式输入、
64 KiB 上限、不读剪贴板、不回显样本、profile 过滤及同分按 actionId 确定性排序。

Office 单元测试只证明闭集模型和文件结构合同。若候选要声称与具体桌面软件互操作，还必须用同一候选生成
DOCX、PPTX、XLSX 与 PDF，在目标版本的 Microsoft Office、LibreOffice 或 PDF 阅读器中逐一打开、检查页面/
幻灯片/单元格与警告，并记录应用版本、操作系统、文件字节数、SHA-256、截图及结果。Markdown/CSV 文本检查
不能替代二进制格式的真实打开与渲染。

PDF `sanitize` 的自动化证据应至少确认 trailer `Info`/`ID`、Catalog 和 Page 上的 XMP/主动内容键被移除，
并确认二次页面复制后的输出仍能由解析器打开。它不能证明未知扩展、内容流、渲染器漏洞或敏感信息已经
被通用净化。
PDF `inspect` 的自动化证据还应逐页固定 `pageDetails.index/widthPoints/heightPoints/rotationDegrees`，但这些
结构断言不能替代目标阅读器的真实打开和渲染检查。

## 策略、文档与专项检查

| 范围 | 命令 | 证据边界 |
| --- | --- | --- |
| 版本一致性 | `node scripts/check-version-drift.mjs --json` | 只证明该 checkout 的 package、Tauri 与发布版本一致 |
| 品牌检查 | `node scripts/check-brand.mjs --json` | 只证明该 checker 实际扫描闭集中的旧品牌命中情况 |
| i18n | `node scripts/check-i18n.mjs --json` | 只证明中英文键与引用的一致性 |
| 工作流静态检查 | `node scripts/check-workflows.mjs --json` | 只证明本地配置；`remoteExecutionChecked:false` 时不代表 GitHub 已运行 |
| 策略合成测试 | `pnpm policy:test` | 只证明临时 fixture 中的品牌、工作流、公开快照、收据绑定和 readiness 合同 |
| 文档命令 smoke | `node scripts/doc-smoke.mjs` | 只证明本地 CLI 文档示例实际执行到的路径 |
| Portable 路径合同 | `cargo test -p useful-core paths::tests` | 证明路径选择和写探针合同；不替代真实只读介质启动 |
| MediaPack Rust 安装链 | `cargo test -p useful-media pack::tests` | 证明 catalog、签名、损坏恢复与回滚合同 |
| MediaPack 下载响应合同 | `cargo test -p useful-app commands::media_pack::tests` | 证明 HTTP 响应事实、续传和重试边界 |
| MediaPack catalog 供应链 | `node --test scripts/media-pack-catalog.test.mjs` | 证明离线 lock/manifest/hash/size/statement 合同；不产生生产签名 |
| MediaPack 安装界面 | `pnpm --filter @useful/app test -- MediaRuntimeView.spec.ts` | 证明组件测试覆盖；不替代真实原生界面验收 |
| 网络聚合 smoke | `cargo run --locked --release -p useful-procmon --example network_smoke -- --json` | 只记录本次聚合能力结果；不替代普通用户/管理员 GUI 或逐进程 ETW 验收 |
| 空白检查 | `git diff --check` | 只检查 Git 可见差异中的空白错误和冲突标记 |

## 公开源码证据链

| 阶段 | 命令 | 权威条件 |
| --- | --- | --- |
| 生成器合成测试 | `node --test scripts/public-source-check.test.mjs scripts/prepare-public-source.test.mjs` | 仅为临时 Git fixture 证据，不是产品候选通过 |
| 本地快照生成 | `node scripts/prepare-public-source.mjs --repo-root <CLEAN_REPO> --output <NEW_DIR> --receipt <NEW_JSON> --json` | 来源必须是固定且干净的 `HEAD`；输出、收据和完整事务标记必须一致 |
| 严格公开源码检查 | `node scripts/public-source-check.mjs --repo-root <REVIEWED_PUBLIC_REPO> --json` | 必须针对最终可见、干净的完整 public tree，得到 `authoritative:true` 且无排除或违规 |
| 收据到提交验证 | `node scripts/verify-public-commit.mjs --repo-root <REVIEWED_PUBLIC_REPO> --receipt <RECEIPT_JSON> --transaction-marker <TRANSACTION_JSON> --json` | 路径、Git 模式、blob 长度与 SHA-256 必须和生成收据精确一致 |
| 发布就绪聚合 | `node scripts/release-readiness.mjs --json` | 仅为本地源码 preflight；不能授权发布或证明远端状态 |
| 候选路径清单 | `node scripts/list-public-commit-candidates.mjs --json` | 只分类 dirty tree，不 stage、commit 或发布 |
| 完整路径合成测试 | `pnpm release:path-test` | 只在隔离 fixture 中覆盖 LICENSE→prepare→commit→strict check→receipt 绑定 |

正式 CLI 不提供 relaxed dirty 模式；`--allow-dirty` 是用法错误。任何旧候选、合成测试或本地生成器
成功，都不能代替最终公开 ref 上的新鲜严格检查和收据验证。

## 平台与发布证据

| 平台 | 可在相应 checkout 记录的本地或静态证据 | 正式发布仍需的真实证据 |
| --- | --- | --- |
| Windows x64 | Node/Rust/Go 命令、工作流静态配置、原生 smoke 清单 | 精确候选的 GUI 启动、主题、导航、媒体、进程/网络、安装包运行、签名与原生视觉验收 |
| macOS x64 / Apple silicon | 平台配置、依赖图、平台无关测试 | 真实 runner 编译、DMG 打包、签名、公证、安装、启动与降级行为 |
| Linux x64 | 平台配置、依赖图、平台无关测试 | 真实 runner 编译、AppImage/deb 打包、安装、启动与降级行为 |

工作流文件或 job 存在不表示远程执行成功。平台状态只有在记录精确 commit、run、runner、产物与结果后
才能写为“已验证”；否则只能写“已配置”或“未执行”。

## 发布与供应链门禁

- `pnpm release:checks` 不创建 GitHub Release、不上传资产，也不提供生产签名。
- Lite/Full 的资产名、`SHA256SUMS.txt`、SBOM、provenance 与签名材料必须来自同一获授权候选。
- Portable Full 公开分发还必须满足精确 GPL 对应源码、构建配置、许可证与持续可访问证据的 Owner Gate。
- 正式签名、公证、生产更新根、GitHub 目标和实际远程平台结果必须由各自的当前证据证明。

更多平台和产品边界见 [`KNOWN-LIMITATIONS.md`](KNOWN-LIMITATIONS.md)，发布授权边界见
[`OPEN-SOURCE-RELEASE.md`](OPEN-SOURCE-RELEASE.md)。
