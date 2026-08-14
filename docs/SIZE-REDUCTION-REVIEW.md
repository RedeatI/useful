# Useful 项目体积缩减评审

更新日期：2026-08-14

> 本页整理当前工作树的工程评估，不是正式发布证据。数值来自本机 `artifacts/size/` 下的忽略文件；
> 报告记录的 HEAD 为 `11be58e0276f28a4bea5150af10fa4e9fa5016cf`，但测量包含未提交改动，不能当作
> clean HEAD 或公开 Release 的可复现结论。

## 一、直接结论

Useful 当前的主要体积问题不是源码仓库或前端资源臃肿，而是 Full edition 内置的
`ffmpeg`、`ffprobe`、`mpv` 媒体运行时：

- Portable Lite 已约 5.62 MiB，明显低于 20 MiB 目标。
- Standard/Core 可执行文件仅相差 480,768 B（3.49%）；把媒体与进程功能编译成 stub 不能形成有意义的
  新公开 edition，因此 Core 继续保持内部评估。
- 把媒体运行时拆成 Preview/Transcode pack 能显著降低首次下载和应用升级重复传输，但不会降低全部安装后
  的总字节数。
- 当前 `full_build` 两个 pack 合计约 218.54 MiB，无法满足 100 MiB 总目标。
- `essentials_build` 缺少原先默认的 `libsvtav1`，但真实 8.1.2 ZIP 已验证包含 `libaom-av1`；当前按需
  安装路径把 AV1 软件回退改为 `libaom-av1 -b:v 0 -cpu-used 6 -crf …`，保留 AV1 功能但编码性能仍需真机验收。

产品已选择：**默认 Lite，导入媒体时明确询问，用户确认后进入 Preview/Transcode 按需安装界面。
Windows x64 按需安装直接使用构建时固定的上游原始 ZIP；内部 Full 和 Useful 自托管 Media Pack 仍在
GPL/发布硬门闭合前 fail closed。**

## 二、测量快照

| 项目 | 当前值 | 目标/门槛 | 结论 |
| --- | ---: | ---: | --- |
| `Useful.exe` Standard | 13,783,552 B | hard 14,680,064 B | 通过 hard，未达到 12.5 MiB target |
| `Useful.exe` Core | 13,302,784 B | 至少节省 1.5 MiB 或 15% | 仅节省 480,768 B / 3.49%，不成立 |
| 前端 dist | 529,997 B | target 629,145 B | 通过；包含按需安装 UI |
| 入口 JS | 246,334 B | hard 256,000 B；target 235,520 B | 通过 hard，距 hard 尚有 9,666 B |
| MediaRuntime 懒加载 JS + CSS | 7,335 B | 独立 chunk | 不进入首屏路由 chunk |
| Agent profile chunk | 23,978 B | target 30,720 B | 通过 |
| Portable Lite ZIP | 5,890,738 B | target 20 MiB | 通过 |
| Preview pack（mpv） | 45,356,407 B | 候选分项 | 约 43.26 MiB |
| Transcode pack（ffmpeg/ffprobe） | 183,797,099 B | 候选分项 | 约 175.28 MiB |
| 上游 Preview 下载（mpv 0.41.0 ZIP） | 77,205,127 B | 当前按需下载 | 约 73.63 MiB |
| 上游 Transcode 下载（FFmpeg 8.1.2 essentials ZIP） | 109,728,040 B | 当前按需下载 | 约 104.64 MiB |
| 全部 `full_build` packs | 229,153,506 B | 100 MiB | 不通过 |
| Essentials Portable Full 估算 | 125,419,271 B | 120 MiB | 字节目标勉强通过，能力矩阵不完整 |

## 三、已实现并验证

1. 体积预算和测量
   - `config/size-budgets.json` 定义 hard limits 与 targets。
   - `measure-size.ps1`、`measure-edition-size.ps1` 将报告隔离在 `artifacts/size/`。
   - 发布 ZIP 使用 Optimal Deflate；Lite ZIP 已从历史约 5.7 MiB 稳定在同一量级。
2. 应用和前端
   - Windows API feature 按 crate 收窄。
   - Standard/Core feature gate 已闭合，Core 的 procmon/media 命令使用显式 stub。
   - Agent profile 浏览器路径移除 Ajv 运行时依赖，Ajv 仅保留为测试对照。
3. 媒体候选
   - v2 lock 把 `mpv` 与 `ffmpeg`/`ffprobe` 分成 Preview/Transcode pack，同时保持正式 v1 lock 不变。
   - 候选 ZIP、closed manifest、detached Ed25519 验签、GPL 对应源码资产绑定和显式离线导入器已实现。
   - 安装器只写版本化目录，完整验证后原子切换 current 指针；连续三代激活测试确认 current/previous
     正确推进且所有版本化目录都保留。
   - 视频导入前会检测 ffmpeg/ffprobe；缺失时询问是否打开媒体解码器页。页面分别展示 Preview 与
     Transcode 的用途、固定上游来源、已验证下载大小和检测状态。
   - Windows x64 应用内安装已改为直接下载 `media-runtimes.upstream.lock.json` 固定的 FFmpeg 官网推荐
     gyan.dev ZIP 与 mpv 项目正式 Release ZIP；支持确认、取消、同任务严格 Range 重试、归档/文件双层
     SHA-256、白名单提取、版本化原子激活、受损停用与重新检测，不再等待 Useful 生产签名源。
4. 证据质量
   - Essentials 能力矩阵要求每个 check ID 非空且唯一，命令执行与输出存在性分别留证。
   - Windows PowerShell 5 可执行脚本文字保持 ASCII，避免候选 JSON 推荐语乱码。

2026-08-14 当前回归：发布合同 70/70（另 1 项因本机无文件 symlink 能力按既有规则跳过）、公共策略
178/178、workflow 5/5、TypeScript/Vue typecheck、MediaRuntime 组件 6/6、`useful-media` 57/57
（另 1 个真实资产测试默认 ignored，但本次显式提供两份锁定 ZIP 后 1/1 通过）、相关 Rust clippy
`-D warnings` 和 `git diff --check` 均通过。真实 Useful GUI 联网安装仍未执行。

## 四、明确不做

- 不把 Core 作为公开 edition；当前收益不足以覆盖测试、文档和支持成本。
- 不把当前 v2 `unsigned-candidate` 上传到公开 Release。
- 不内置、生成或代管 MediaPack 生产私钥。
- 不因 Essentials 硬路径通过就删掉 AV1 软件编码或悄悄修改 UI 能力声明。
- 不用拆包后的首次下载优势冒充全部安装体积达到 100 MiB。
- 不修改正式 `scripts/media-runtimes.lock.json`，直到产品与 GPL Owner Gate 同时闭合。

## 五、剩余硬门

| 硬门 | 当前状态 | 所需决定/证据 |
| --- | --- | --- |
| Useful 自托管 MediaPack 生产信任根 | BLOCKED / NOT USER-BLOCKING | 仅在未来重新分发 Useful Media Pack 时需要；当前上游直连安装不依赖该根 |
| Full/GPL 重新分发对应源码 | BLOCKED | 与精确二进制绑定的源码资产、构建配置、许可证、持续可访问证据；继续阻止 Full 公开资产 |
| Essentials AV1 能力差异 | RESOLVED / PERFORMANCE UNEXECUTED | 使用已验证存在的 `libaom-av1` 保留软件 AV1；仍需真实视频性能与质量验收 |
| 全部 pack ≤100 MiB | FAILED | 需要自定义裁剪 FFmpeg/mpv 或调整产品目标；拆包本身无效 |
| Windows x64 应用内按需下载 | IMPLEMENTED / LOCAL TESTED | 固定上游 ZIP、确认、默认代理发现、同任务三次严格 Range 重试、归档与文件哈希、白名单提取、Portable 写探针、组件健康校验、受损修复、PATH 拒绝、取消、原子安装和重新检测已实现；仍需真实应用联网安装、企业代理/PAC、跨应用重启续传及真实杀毒/只读介质测试 |
| 正式发布 | BLOCKED | 上述硬门闭合后才允许切 production lock 和 Release allowlist |

## 六、后续顺序

1. 用当前固定的两份真实上游 ZIP 完成 Windows x64 原生应用联网安装与视频裁剪回归。
2. 完成企业代理/PAC、跨应用重启续传以及真实杀毒产品/只读介质 native 回归；默认代理发现、同任务
   三次严格 Range 重试、Portable fail-closed 和受损组件降级/修复已有本地合同。
3. 保留内部 `full_build` 能力集合；按需安装路线不以静默删除 AV1 软件编码冒充 Full 能力不变。
4. 只有未来确需公开重新分发 Useful 自托管 Media Pack 或 Full 时，Owner 才闭合独立签名根与 GPL
   对应源码证据；不得用 renderer 参数、运行时环境变量或本地配置替换构建时固定信任。
5. 最后执行一次固定输入、干净工作树的正式体积与发布证据重测。

常用命令：

```powershell
pnpm size:measure
pnpm size:editions
pnpm size:media-essentials
pnpm size:media-packs-evaluate
pnpm release:checks
pnpm workflow:check
pnpm typecheck
```

其中 `size:media-essentials` 在 hard matrix 失败时退出 2、仅 soft codec matrix 失败时退出 3；退出 3 是
候选有缺口的正式结果，不应通过重跑或改样本选择一个“通过”。
