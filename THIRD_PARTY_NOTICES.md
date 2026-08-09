# 第三方声明 (Third-Party Notices)

本产品包含或依赖以下第三方组件。二进制运行时（ffmpeg/ffprobe/mpv）不随本仓库源码
提交，而是在构建时由 `scripts/fetch-binaries.ps1` 下载并**校验 SHA-256** 后使用；
校验失败即中止构建，绝不使用来源不明的预编译二进制。

`scripts/media-runtimes.lock.json` 是媒体版本、来源、归档 SHA-256 和许可证元数据的唯一 pin
数据源；fetch、release manifest 与 SBOM 必须读取同一份 lock，缺失或不一致即失败。下表只是该
lock 的人类可读映射，不能覆盖或替代它。

## 随软件分发的二进制运行时（Full 版）

下表为当前锁定的精确版本与来源；SHA-256 为下载压缩包的哈希，均取自官方发布的
校验文件（获取日期 2026-07-30）。解压后单个 exe 的哈希由 `scripts/fetch-binaries.ps1`
在提取时计算并写入 `binaries/CHECKSUMS.txt`。Lite 版不含这些二进制。

| 组件 | 版本 | 来源 | 压缩包 SHA-256 | 许可证 |
| --- | --- | --- | --- | --- |
| ffmpeg.exe / ffprobe.exe | 8.1.2 full_build | gyan.dev（`ffmpeg-8.1.2-full_build.7z`，哈希源：官方 `.sha256` 文件） | `0fff188997a499b5382e0f66e845d4556c48c54f0113ebed4853d556dbdd7059` | GPLv3（full 构建） |
| mpv.exe | 20260610-git-304426c (x86_64) | shinchiro/mpv-winbuild-cmake GitHub Release（哈希源：GitHub asset 官方 sha256 digest） | `facac536baa73c7b925771af5e39a3c9cb16b8d75b59a6e9800de89799dffca7` | GPLv2+ |

维护者更新版本时只修改 `scripts/media-runtimes.lock.json` 的 pin；派生的 fetch 结果、manifest、
SBOM、本表与 `binaries/README.md` 必须保持一致。

Portable Full 可以生成内部构建候选，但当前公开分发门禁未闭合。公开分发 GPL ffmpeg/mpv 前，
Owner 必须提供与二进制精确对应且持续可访问的源码、构建脚本/配置、许可证文本和证据。内部候选
不构成公开发布授权；本文不作法律结论。

## 主要开源依赖

### 前端 / Node

- Vue 3（MIT）、Vue Router（MIT）、Pinia（MIT）
- Vite（MIT）、TypeScript（Apache-2.0）
- Vitest（MIT）、@vue/test-utils（MIT）、ESLint（MIT）
- @tauri-apps/api、@tauri-apps/plugin-dialog（MIT / Apache-2.0）
- adm-zip（MIT）、sharp（Apache-2.0）、png-to-ico（MIT，构建期图标工具）
- fflate 0.8.3（MIT，受限 OOXML ZIP 读写）
- pdf-lib 1.17.1（MIT，本地 PDF 页操作与元数据清理）
- yaml 2.9.0（ISC，本地、受限的 JSON/YAML 转换）

自包含 Agent Kit 会从 esbuild 的实际 bundle input 闭包生成 `THIRD_PARTY-LICENSES.json`，并把每个
被内嵌 Node 包随附的 LICENSE/LICENCE/COPYING 及 NOTICE/COPYRIGHT/PATENTS/AUTHORS/第三方声明
文件一并放入 Kit 的 `third-party/` 目录。
缺少许可证文件、元数据冲突或残留非 Node external import 时构建直接失败；根说明不能替代这些逐包文本。

### Rust / 原生

- tauri, tauri-plugin-dialog, tauri-plugin-single-instance, tauri-plugin-opener（MIT / Apache-2.0）
- serde, serde_json（MIT / Apache-2.0）
- tokio（MIT）
- rusqlite（含 bundled SQLite；SQLite 为 Public Domain，rusqlite 为 MIT）
- zip（MIT）、sha2、hex（MIT / Apache-2.0）
- ed25519-dalek（BSD-3-Clause）
- jsonschema（MIT）、semver（MIT / Apache-2.0）
- sysinfo（MIT）
- windows（microsoft/windows-rs，MIT / Apache-2.0）
- tracing, tracing-subscriber, tracing-appender（MIT）
- dunce（MIT / Apache-2.0）、tempfile（MIT / Apache-2.0）、uuid（MIT / Apache-2.0）

> 完整依赖清单与许可证可用 `cargo tree` 与 `pnpm licenses list` 生成；SBOM 由发布
> 流程输出（见 `docs/` 与发布配置）。

## 许可证合规说明

- 不在许可证不明确的情况下重新分发任何二进制。
- ffmpeg/mpv 若使用 GPL 构建，将保留其许可证文本并遵循相应义务；商用分发前须复核。
- 本仓库自身代码的正式许可由根 `LICENSE` 与 `LICENSES.md` 的最终、经复核版本共同确定；
  在二者与各 package/crate 元数据一致前，不得从历史 `license` 字段推断公开发布许可。
