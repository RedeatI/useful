# Beta 安装、升级、通道切换与回滚

本页描述 `0.1.0-beta.2` 公开 Beta 候选的预期操作。桌面候选资产尚未上传 GitHub，也没有可填写的下载
URL；只有在所有者完成发布门禁并提供最终资产清单、校验和与签名后，才能把下列步骤当作分发说明。

Useful 的 Windows x64 edition 约定为 setup Lite、Portable Lite 和 Portable Full。Lite 不内置媒体
运行时；Full 计划包含固定版本且经 SHA-256 校验的 `ffmpeg`、`ffprobe`、`mpv`。`Useful.exe` 是
保留的 Windows 兼容主程序文件名，不表示公开产品仍称为 Useful。macOS/Linux 当前不承诺内置媒体
运行时或提供 Full edition。

## 安装候选资产

1. 只使用最终 Release 资产清单中允许的文件，并按同一 Release 提供的 `SHA256SUMS.txt` 校验。
2. Portable Lite 或 Portable Full ZIP 应解压到新的可写空目录；setup Lite 使用安装程序。不要覆盖
   正式用户目录，也不要混用不同候选版本的文件。
   Portable 启动时会对隔离数据树执行写探针；不可写时会在打开数据库前停止并提示，不会静默改用 AppData。
3. Portable 版本应确认 `portable.flag` 与 `update/current-version.txt` 存在。
4. 启动 Useful 的兼容主程序 `Useful.exe`。首次评估建议先从设置页导出一次本地反馈包，并在分享前
   人工预览。

如果正式资产清单、校验和或签名仍缺失，请停止；本地开发构建不能替代公开 Beta 分发资产。

## 切换更新通道

设置 → 客户端更新源 → 更新通道，可选择 stable、beta 或 nightly。通道切换只改变可接收的 manifest
通道，不更换更新服务提供商或根公钥；更换提供商仍需要单独警告与明确确认。

当前没有生产更新根或在线 feed 可供使用。不要把界面中存在通道选择器理解为远程更新已经上线。

## 后续 Beta 升级的预期边界

1. 更新 manifest 必须匹配所选环境与通道，并由该环境当前受信更新根签名。
2. bootstrap 校验签名、摘要、大小、版本和最低兼容版本。
3. 应用前备份旧版本；新版本启动成功后才写入 `current-version.txt`。
4. 签名、摘要或启动失败时返回非零，不更新版本号，并保留失败证据。

这些是升级契约，不是 `beta.2` 已存在或更新链路已在生产环境运行的声明。

## 自动回滚

如果 Useful 的新 `Useful.exe` 无法启动，bootstrap 应恢复旧文件与旧版本号并保留错误证据。不要手工
删除 `backup`、`update/pending` 或日志后再声称升级成功。

## 手工恢复

1. 退出所有 Useful 相关的 `Useful.exe`、mpv、ffmpeg、ffprobe 进程。
2. 保留失败的 `update/pending`、日志和反馈包副本。
3. 将已校验的旧版 ZIP 解压到新的目录，不覆盖失败目录。
4. 启动旧版并检查收藏、最近使用和已安装插件。

公开 Beta 候选不执行生产密钥轮换或生产回滚仪式；正式流程仍需要所有者提供生产签名、更新根与目标
发布环境。
