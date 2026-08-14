# 第三方二进制运行时（ffmpeg / ffprobe / mpv）

本目录用于放置随软件分发的媒体二进制。**二进制不提交到仓库**，由构建脚本下载并
校验 SHA-256 后写入本目录（见 `.gitignore`）。

应用内按需安装不写入本目录，也不等待 Useful 自签名包。Windows x64 用户确认后，应用直接下载
`scripts/media-runtimes.upstream.lock.json` 固定的 FFmpeg/mpv 上游原始 ZIP，只把经过大小与
SHA-256 校验的白名单文件原子激活到应用数据目录。下面的 v1 lock 和 Full 说明仅适用于内部 Full 候选。

## 原则

- 记录精确版本、来源 URL、SHA-256、许可证（见 `../THIRD_PARTY_NOTICES.md`）。
- 只从官方或可信构建下载；下载后**必须校验哈希**，失败即中止。
- 不下载来源不明的预编译二进制，不在许可证不明确时重新分发。

## 使用

`scripts/media-runtimes.lock.json` 是精确版本、来源、压缩包 SHA-256 和许可证元数据的唯一 pin
数据源。`scripts/fetch-binaries.ps1`、release manifest 与 SBOM 必须读取同一份 lock；缺失、未知字段
或结果不一致时立即停止。`../THIRD_PARTY_NOTICES.md` 表格仅为人类可读映射：

- ffmpeg/ffprobe：gyan.dev `ffmpeg-8.1.2-full_build.7z`（GPLv3）
- mpv：shinchiro GitHub Release `mpv-x86_64-20260610-git-304426c.7z`（GPLv2+）

运行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/fetch-binaries.ps1
```

脚本会下载压缩包到临时文件、校验压缩包 SHA-256、用系统自带 `tar`（bsdtar，支持 7z）
解压提取 exe，并把每个 exe 的 SHA-256 写入 `binaries/CHECKSUMS.txt`。任一校验失败即中止。

## Lite 版 vs Full 版

- **Lite**：不含媒体二进制，使用系统 WebView2，启动时检测；视频功能在缺失运行时时
  给出明确提示。
- **Full**：包含 ffmpeg/ffprobe/mpv；是否附带固定 WebView2 由独立构建配置决定。

Full 可以生成内部构建候选，但当前不得公开发布。公开分发 GPL ffmpeg/mpv 前，Owner 必须闭合与
二进制精确对应的源码、构建脚本/配置、许可证文本和持续可访问证据；本文件不作法律结论。
