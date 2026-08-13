# 正式发布流程（客户端 + 官方源）

> 每次发布必须完成本清单。构建失败/测试未过不得发布。

## 当前状态边界

- **已实现：** 本仓库包含客户端、更新、官方源和工具制品的本地发布流程配置。
- **已验证：** 只有附带精确命令、commit、平台、产物 hash 和签名证据的当次结果才能列为已验证；
  工作流或脚本存在本身不算通过。
- **未由本文证明：** 远程 CI、macOS/Linux 验证、签名/公证、上传、Release、feed 部署、数据库迁移
  和生产发布必须由各自针对精确候选的执行证据证明。
- **Owner Gates：** 根 `LICENSE` 与显式组件映射已进入本地一致性检查，但精确公开候选仍需最终法律
  复核。任何含非公开开发历史的仓库都不得原地切换可见性；首次公开视图必须只包含经 receipt 绑定的
  单一净化初始 commit。私密报告渠道、发布授权人、保护规则、生产密钥/feed 和生产变更授权都必须在
  相应操作前由 Owner 配置并验证。任一门禁未满足都必须停止。

每次 HANDOFF 必须分别记录上述四类，不得用“流程已配置”替代“当次已验证”。
首次公开还必须把经复核的净化初始历史作为唯一公开入口，不得暴露私有开发历史。严格公共源检查必须
针对最终可见 ref 重跑；由于 GitHub source archive 暴露完整 tag 树，任何公开 ref 中仍存在的非公开路径
都属于失败门禁。

## Release workflow 的闭集 scope

`.github/workflows/release.yml` 的 `scope` 只能是下列三项：

- `source-agent-kit`：非桌面 prerelease，只生成并校验公开源码证据、Agent Kit、CycloneDX SBOM、
  根 legal 闭集、源码 manifest、provenance、`RELEASE-ASSETS.txt` 与 `SHA256SUMS.txt`。它不构建桌面
  程序，不读取桌面签名、更新根/feed 或媒体 Full 门禁，也不得选择 stable 通道。Agent Kit builder 的
  `publicationAuthorized=false` 保持原义；发布授权来自独立 workflow Owner gate，不能改写该字段。
- `desktop-lite`：只公开 Windows x64 Setup Lite、Portable Lite，以及 source/Agent Kit/SBOM/签名状态/
  provenance/legal 证据闭集。它明确排除 Portable Full、媒体运行时、macOS 和 Linux 桌面资产；仍执行
  桌面源码、CI、更新信任、Owner allowlist、精确 tag/commit、签名状态和 environment 门禁。
- `desktop-full`：保留本文其余章节描述的多平台构建、签名/公证、更新信任、媒体合规、验证与发布
  全部门禁；source scope 的存在不构成任何豁免。

`publish` 默认为 `false`。同一 tag、同一 commit 必须先有成功的 `source-agent-kit` dry-run，之后才可
在 `release` environment 审批下以 `publish=true` 创建 source preview。source preview 的 Release 名称
和说明必须明确“不含桌面二进制”，不得宣传为安装包、正式桌面版或受支持平台证明。

## 0. 前置门禁（CI 必须全绿）

- Rust：`cargo fmt --all -- --check`、`cargo clippy --workspace --all-targets -- -D warnings`、
  `cargo test --workspace`
- 前端：`pnpm -r typecheck`、`pnpm -r lint`、`pnpm -r test`
- 公开策略：`pnpm policy:test`、`node scripts/check-brand.mjs --json`、
  `node scripts/check-workflows.mjs --json`
- Go：`gofmt -l .` 为空、`go vet ./...`、`go build ./...`、`go test ./...`（services/）
- 协议：`packages/protocol` node --test 全过（schema 与测试向量）
- compose 端到端：运行 `deploy/docker-compose/e2e` 发布前检查并要求 ALL PASS
- bootstrap 验收：`node scripts/e2e-bootstrap.mjs` ALL PASS

## 1. 客户端便携包

1. 版本号：更新 workspace `version` 与 `tauri.conf.json`；SemVer。
2. 构建：`cargo build --release`（含 `useful-bootstrap.exe`）+ Tauri build。
3. 打包：`scripts/package-release.ps1` 产出便携 ZIP，**必须包含**：
   - `Useful.exe`、`useful-bootstrap.exe`
   - `update/current-version.txt`（写入本次版本号）
   - 不包含：任何私钥、开发配置、`.env`
4. `SHA256SUMS.txt` 覆盖全部产物；SBOM（`scripts/gen-sbom.mjs`）随发布提供。

Portable Full 可以生成内部候选；公开分发 GPL ffmpeg/mpv 前，Owner 必须提供与二进制精确对应且
持续可访问的源码、构建脚本/配置、许可证文本和证据。没有绑定精确候选的完成证据时不得公开发布 Full。

## 1A. Agent Kit 附加资产

1. 预期资产名为 `Useful-<version>-agent-kit.zip`，要求 Node.js 20 或更高版本；它是跨平台附加
   资产，不属于 Windows setup Lite、Portable Lite 或 Portable Full edition。
2. ZIP 必须含闭集 `MANIFEST.json`；独立 receipt 为 `Useful-<version>-agent-kit.zip.sha256`。ZIP 和
   receipt 必须进入显式 asset allowlist 与最终 `SHA256SUMS.txt`，并绑定 build provenance；额外或
   缺失条目均失败。SBOM 继续描述软件组件，不作为 Agent Kit 资产清单。
3. 本地源码入口为 `pnpm --silent agent-kit:build -- --out-dir <fresh>`，且不得覆盖已有目录。根
   `LICENSE` 或其他法务文件缺失时正式构建/发布必须 fail closed。
4. 根 legal 声明闭集为 `LICENSE`、`LICENSES.md`、`NOTICE`、`THIRD_PARTY_NOTICES.md`、
   `TRADEMARKS.md`；ZIP 还必须包含 `licenses/README.md`、四份标准许可证正文、
   `THIRD_PARTY-LICENSES.json` 及该索引逐项指向的实际第三方许可证/NOTICE 文件，任一缺失均失败。
5. 解压包无需 monorepo、GUI 或全局安装。macOS/Linux 在实际 CI 完成前只记录“已配置 / 待远端
   验证”，不得写成已验证或已发布。

## 2. 客户端更新包（AppUpdate 信任域）

1. 用**离线**客户端更新根私钥签名（与工具源/TUF 全部密钥隔离）：
   载荷 `useful-app-update-v1\n<version>\n<sha256(payload.zip)>`，Ed25519。
2. 产出 `update-manifest.json`（schemaVersion/version/sha256/size/signature）
   与 feed JSON（`{schemaVersion:1, manifest, payloadUrl}`）。
3. 发布到更新 CDN；`payloadUrl` 必须 HTTPS。
4. 验证：在干净目录运行 `useful-bootstrap check` + `apply`，确认
   升级成功、备份生成；用篡改包确认拒绝。
5. ⚠️ 首次正式发布前：执行离线密钥仪式。把公钥、真实 HTTPS feed 模板和仪式 receipt SHA-256
   配置为受保护的 GitHub repository variables；Release workflow 通过编译期变量注入公钥和 feed，
   并拒绝 `crates/useful-bootstrap/src/config.rs` 中的开发回退值。私钥不得进入仓库或 CI。
6. stable 发布必须提供 tag 内 `docs/releases/` 证据文件及其 SHA-256，证明更新签名、篡改拒绝、
   升级和回滚均针对本次 tag 验证通过；布尔变量不能替代该证据。

## 3. 官方源（服务端）

1. 数据库迁移演练：在 staging 库执行新迁移（迁移幂等、advisory lock 串行）。
2. 滚动发布 source-server → 验证 `/v1/ready`；再发布 source-worker。
3. TUF metadata 健康：发布后确认 `timestamp.json` 版本推进且未过期。
4. 回滚预案：保留上一镜像 tag；数据库迁移不可逆时（append-only 原则下少见）
   必须先出回滚脚本再上线。

## 4. 工具制品发布（发布者流程）

上传 → 扫描（隔离区，worker）→（原生 worker 必须人工审核）→ 发布 →
TUF 重签 → CDN 失效 `timestamp.json`。撤回用 withdraw 端点（记录保留），
安全问题同时发布 advisory（已装用户可见）。

## 5. 发布公告

- Release Notes：新特性、安全修复（关联 advisory ID）、协议变更（TRP 版本）。
- 校验信息：产物 SHA-256、（后续）签名证书指纹。
- 升级注意事项：数据库迁移、配置项变更、密钥轮换要求。

## 6. 供应链要求（CI）

- GitHub Actions 固定到 commit SHA；
- 依赖漏洞扫描（cargo audit / npm audit / govulncheck）；
- 不从未校验 URL 下载构建工具（`scripts/fetch-binaries.ps1` 校验 SHA-256）；
- `scripts/media-runtimes.lock.json` 是媒体运行时唯一 pin 数据源；fetch、release manifest 与 SBOM
  必须读取同一数据，缺失或不一致即失败；
- `scripts/media-runtimes.v2.candidate.lock.json`、`package-media-packs.ps1` 和显式离线
  `install-media-pack.ps1` 仅用于按需媒体包候选评估；打包输出均标记 `unsigned-candidate`，安装器也
  不内置生产公钥。在独立 MediaPack 签名根和 GPL Owner Gate 闭合前，不得加入公开 Release
  allowlist 或接入应用自动下载（详见 `docs/MEDIA-PACK-V2.md`）；
- 扫描器镜像固定 digest；
- 构建产物哈希写入发布说明。
