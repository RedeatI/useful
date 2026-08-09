# Useful 项目体积缩减评审

更新日期：2026-08-07

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
- `essentials_build` 可把估算 Portable Full 降到约 119.61 MiB，刚好落在 120 MiB 产品目标以内，但缺少
  `libsvtav1` 软件编码能力，不能未经产品决定切换。

产品已选择：**默认 Lite，导入媒体时明确询问，用户确认后进入 Preview/Transcode 按需安装界面；正式
Full/MediaPack 在信任与 GPL 硬门闭合前继续 fail closed。**

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
     Transcode 的用途、已验证下载大小和检测状态。应用内已接通签名 catalog、可取消 `.part` 下载、
     Rust 验签/闭集安装、重新检测与上一版回滚；当前构建没有生产信任输入，因此按钮仍 fail closed。
4. 证据质量
   - Essentials 能力矩阵要求每个 check ID 非空且唯一，命令执行与输出存在性分别留证。
   - Windows PowerShell 5 可执行脚本文字保持 ASCII，避免候选 JSON 推荐语乱码。

当前回归基线：发布合同 48/48、workflow 5/5、TypeScript/Vue typecheck、Standard/Core Rust 编译、
`useful-media` 44/44 和 `git diff --check` 均通过。

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
| MediaPack 生产信任根 | BLOCKED | Owner 建立隔离 Ed25519 根并批准公钥；私钥不得进入仓库/CI |
| GPL 对应源码 | BLOCKED | 与精确二进制绑定的源码资产、构建配置、许可证、持续可访问证据 |
| Essentials 能力差异 | PRODUCT_DECISION | 是否接受移除 `libsvtav1` 软件编码及相应 UI/合同降级 |
| 全部 pack ≤100 MiB | FAILED | 需要自定义裁剪 FFmpeg/mpv 或调整产品目标；拆包本身无效 |
| 应用内按需下载 | EXECUTION_IMPLEMENTED / PRODUCTION_TRUST_BLOCKED | 确认、签名 catalog、默认代理发现、同任务三次严格 Range 重试、Portable 写探针、组件健康校验、受损包可信修复/回滚、PATH 拒绝、可取消下载、验签、原子安装和重新检测已实现；仍需 Owner 生产根/catalog、企业代理/PAC、跨应用重启续传及真实杀毒/只读介质测试 |
| 正式发布 | BLOCKED | 上述硬门闭合后才允许切 production lock 和 Release allowlist |

## 六、后续顺序

1. 保留 `full_build` 能力集合；按需安装路线不以静默删除 AV1 软件编码换取首包体积。
2. Owner 闭合独立签名根与 GPL 对应源码证据，并提供可信 MediaPack catalog/资产闭集。
3. Owner 提供的 catalog 先经过离线签名与 GPL 证据审核，再作为编译期固定输入进入候选构建；不得用
   renderer 参数、运行时环境变量或本地配置替换生产公钥。
4. 完成企业代理/PAC、跨应用重启续传以及真实杀毒产品/只读介质 native 回归后，才允许在生产候选中注入
   信任输入；默认代理发现、同任务三次严格 Range 重试、Portable fail-closed 和受损组件降级/修复已有本地合同。
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
