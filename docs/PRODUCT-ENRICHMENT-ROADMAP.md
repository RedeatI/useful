# Useful 产品丰富方向与优先级（v1）

Date: 2026-08-12  
Baseline: public `RedeatI/useful` @ `0.1.0-beta.4`  
Reference: 50 个“网站就能免费搞定”的互联网工具样本（TinyWow / Photopea / CyberChef 等）

本文是**产品方向决策**，不是功能全开清单，也不是发布授权。

---

## 1. 一句话定位

**Useful = 本地优先的工具运行时 + 可签名包分发通道 +（可选）云端包存储。**

不是：

- 50 个网站的收藏夹 / 内嵌浏览器门户
- 云端 SaaS 工具站（把用户文件默认上传处理）
- 通用 AI 自动操作电脑

互联网上那些“免费网站”证明的是**需求真实**；Useful 要吸收的是它们的**任务（job）**，不是页面本身。

---

## 2. 评估口径（综合判定）

每个方向按 4 维打分（1–5），再乘以**产品对齐权重**：

| 维度 | 含义 | 权重 |
| --- | --- | --- |
| **需求** | 用户是否高频、是否痛、是否愿意反复打开 | 30% |
| **可复用** | 能否变成 Action / 组件 / 包格式，被 GUI+CLI+MCP 共用 | 25% |
| **可扩展** | 能否通过插件/源/模板长出生态，而不是硬编码 50 个功能 | 25% |
| **低成本** | 本地算力可完成？无重依赖？无高额云账单？无签名/法务阻塞？ | 20% |

**一票否决（暂不做）：**

- 默认把用户文件送上第三方云处理（与 local-first 冲突）
- 需要持续付费模型 API 才能 baseline 工作
- 完整替代 Photoshop / Word / 浏览器（边界已写死）
- 依赖未签名生产自动更新或未完成 Owner 门禁的“官方已签名”宣称

---

## 3. 从 50 站抽象出的 8 条能力带

| 能力带 | 样本站 | 与 Useful 现状 | 策略 |
| --- | --- | --- | --- |
| A. 万能小工具箱 | TinyWow, CyberChef, Transform.tools | 已有 31 utility + 网格 | **深耕本地**，按缺口补 Action |
| B. 文件/格式转换 | CloudConvert, PDF24, Squoosh, SVGOMG | 已有 Office/PDF/媒体边界 | **本地有界转换**；禁止默认上传 |
| C. 隐私与临时通信 | Temp-Mail, Privnote | 弱 | 仅做**本地**阅后即焚/一次笔记；不做邮箱服务 |
| D. 跨设备传文件 | LocalSend, PairDrop | 无 | 可选 P2；优先本地局域网，不做中心化中转 |
| E. 互联网侦察 | BuiltWith, URLScan, VirusTotal… | 无 | **不做内嵌爬虫门户**；可做“打开外链+粘贴结果”工作流 |
| F. 学习科研 | Connected Papers, Elicit… | 无 | **不做学术搜索引擎**；可做本地 PDF/引用整理插件 |
| G. 创作与截图美化 | Carbon, Ray.so, Excalidraw, Coolors | 弱（有颜色/对比度） | 低成本本地工具可补；手绘白板等可插件化 |
| H. 开发者工具 | Regex101, JSON Crack, Hoppscotch, Crontab Guru… | 部分已有（regex/json） | **P1 高复用补齐**（可视化 JSON、cron、shell explain 本地版） |

结论：**主航道 = A + B + H + 包分发（含云端存储）**；E/F 只做“辅助工作流”，不把 Useful 变成搜索门户。

---

## 4. 优先级总表

### P0 — 现在就定，近期必须推进（含云端包存储开工）

| ID | 方向 | 需求 | 复用 | 扩展 | 低成本 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| **P0-1** | **云端包存储（Object store for `.useful`）** | 5 | 5 | 5 | 4 | 见 §5；复用现有 TRP/签名/源模型 |
| **P0-2** | 官方/自建 **Source 可用性与制品校验** 产品化 | 4 | 5 | 5 | 4 | ADR-012 已有后端语义；客户端 Source Center 可见 |
| **P0-3** | Portable / 预览发布路径稳定（版本徽章、校验和、下载文案） | 5 | 3 | 3 | 5 | 已部分完成；保持不回退 |
| **P0-4** | Action 合同闭环：新工具默认 **GUI + CLI + MCP 三面** | 5 | 5 | 5 | 4 | 任何“丰富功能”的准入门槛 |

### P1 — 下一阶段默认工具丰富（本地、高复用）

| ID | 方向 | 样本启发 | 说明 |
| --- | --- | --- | --- |
| P1-1 | **图片本地管线**：压缩/格式/尺寸/EXIF 清理 | Squoosh | Worker 内处理；不上传 |
| P1-2 | **PDF 边界能力加强**：合并/拆分/压缩/元数据 | PDF24 | 已有 PDF Action 基础；补齐高频子集 |
| P1-3 | **JSON 可视化 / 路径查询** | JSON Crack | 纯本地；强 Agent 价值 |
| P1-4 | **Cron / Shell 解释器（本地）** | Crontab Guru, ExplainShell | 规则/模板，无网络 |
| P1-5 | **哈希/编码“流水线”**（多步配方） | CyberChef | 可复用现有 pure Action 组合 |
| P1-6 | **颜色/配色/对比度套件** | Coolors | 已有 color/contrast；扩展导出 |
| P1-7 | 插件模板与 BUILD-A-TOOL 体验 | — | 降低第三方补全成本 |

### P2 — 值得做，但可插件化或延后

| ID | 方向 | 样本启发 | 说明 |
| --- | --- | --- | --- |
| P2-1 | 局域网跨设备传文件 | LocalSend / PairDrop | 成本在权限与 UX；中心化中转不做 |
| P2-2 | 本地阅后即焚笔记 | Privnote | 仅本地密钥；无云邮箱 |
| P2-3 | 代码截图生成 | Carbon / Ray.so | 可插件；非核心 |
| P2-4 | SVG 优化 | SVGOMG | 插件或 media pack |
| P2-5 | 白板/手绘 | Excalidraw | 插件，不进默认 36 Action |
| P2-6 | 网页快照“打开外链”助手 | Archive.today / Wayback | **只做链接构造与剪贴板**，不做镜像站 |

### P3 — 明确延后 / 不做主产品

| 方向 | 原因 |
| --- | --- |
| 在线 Photopea 级修图 | 体积与维护爆炸；边界冲突 |
| 临时邮箱 / 邮箱服务 | 运营与滥用成本 |
| VirusTotal / 全网扫描内嵌 | 隐私与 ToS；改为外链 |
| 学术论文搜索引擎 | 数据与合规；非本地优先 |
| 影视聚合 JustWatch | 与工具库身份无关 |
| 全球广播 Radio Garden | 娱乐属性 |

---

## 5. 云端包存储（P0-1）— 开工准备规格

### 5.1 目标

让 **`.useful` 制品 + publisher 签名 + 源元数据** 能放进**低成本对象存储**，被 Source Center / 下载器 / Agent Kit 路径消费，且**不削弱现有信任边界**。

### 5.2 非目标（首期）

- 不做“用户随便上传任意文件的网盘”
- 不做未签名包的默认可安装通道
- 不做按流量计费的复杂多租户计费（可后接 FREE-AND-PRO 的官方源策略）
- 不在客户端内嵌密钥上传到第三方

### 5.3 已有资产（必须复用）

| 层 | 已有 |
| --- | --- |
| 制品 | `.useful` + `publisher-signature.json` |
| CLI | `pack` / `publisher sign|verify` / `source init|add-package|publish|export-static` |
| 信任 | publisher pin、artifact SHA-256、plugin-set 双 pin |
| 源 | TRP / 静态源导出；Source Center UI |
| 后端语义 | ADR-012 `storage.PublishedKey(sha)`、availability Head 检查 |

### 5.4 推荐架构（低成本）

```text
Author machine
  useful pack → sign → source add-package → publish
        │
        ▼
Object store (R2 / S3 / MinIO / 自建)
  keys:  sha256/<artifactSha>          # 内容寻址，禁止用户任意 URL
         meta/<sourceId>/catalog.json  # 或现有 static export 布局
        │
        ▼
Client Source Center / downloader
  HTTPS GET by content-addressed key
  verify signature + digest before install
  availability = Head(size)  [ADR-012]
```

**成本策略（由低到高）：**

1. **P0 默认**：GitHub Release / 静态 HTTPS 目录（`export-static`）— 接近免费  
2. **P0 可选**：Cloudflare R2 / 兼容 S3（无出站费友好）  
3. **P1**：自建 MinIO / 官方动态源 API（已有 server 雏形时再接）

### 5.5 分阶段交付

#### P0-1a — 规格与契约（文档 + schema，可 1 次 PR）

- [ ] `docs/CLOUD-PACKAGE-STORAGE.md`：对象键规范、URL 模板、权限、失败码  
- [ ] 固定 key 规则：`sha256/{lowercaseHex}`，禁止开放重定向  
- [ ] 明确：客户端只接受 **源配置里的 origin + 内容寻址路径**，拒绝任意粘贴 URL 安装  
- [ ] 与 `export-static` 布局对照表（静态源 = 零服务器云存储）

#### P0-1b — CLI 上传/同步（作者路径）— **已实现**

- [x] `useful source storage doctor|dry-run|push|verify`
- [x] 凭据仅环境变量（`USEFUL_STORAGE_*`），不进 git  
- [x] dry-run + verify（remote Head size == local）  
- [x] 输出可机读 JSON（`--json`）  
- [x] fs 后端单测；s3 兼容 SigV4 实现（live MinIO 可选）

#### P0-1c — 客户端消费

- [ ] Source Center：显示源类型 `static-https` / `s3-compatible` / `dynamic`  
- [ ] 下载走现有 downloads 队列 + digest 校验  
- [ ] 失败分类：missing / size-mismatch / sig-fail / network（对齐 ADR-012）

#### P1-1d — 官方镜像与 Pro 门（可选）

- [ ] 官方源 CDN 镜像  
- [ ] FREE-AND-PRO：免费工具本地永久；云下载额度可后接  
- [ ] availability 聚合展示“源健康”

### 5.6 安全底线（写死）

1. **签名先于存储**：云上只是字节；不可信直到 publisher verify  
2. **内容寻址**：同一 digest 全局同一对象；禁止“同名覆盖改内容”  
3. **无 SSRF**：检查/下载目标只能是源自己的 key 空间  
4. **本地优先安装结果**：取消订阅/断网后，已装包仍可按现有策略运行  
5. **日志脱敏**：不写密钥、不写完整用户路径

### 5.7 验收（P0 完成定义）

1. 作者在干净机器：`pack → sign → publish → sync-storage` 成功  
2. 另一台机器：只配置源 origin + 公钥 pin，能发现、下载、验签、安装  
3. 篡改对象字节 → 安装失败  
4. 对象缺失 → availability `unavailable`，UI 可理解  
5. 全程无需 Authenticode；与代码签名门禁解耦

---

## 6. 工具丰富（P1）与 50 站的映射原则

**做本地对等物，不做 iframe 套壳。**

| 用户任务 | 网站做法 | Useful 做法 |
| --- | --- | --- |
| 压图 / 转图 | Squoosh 上传 | 本地 Worker / 可选 WASM |
| PDF 合并拆分 | PDF24 上传 | 本地 PDF Action 扩展 |
| 正则调试 | Regex101 | 已有；补解释与用例库 |
| JSON 看结构 | JSON Crack | 新本地可视化工具 |
| 多步编码 | CyberChef | Action 流水线 / 配方 |
| 找替代软件 | AlternativeTo | **外链即可**，不进核心 |
| 查站技术栈 | BuiltWith | 外链或插件，不爬站 |

新增默认工具准入清单：

1. 能写成 pure/worker Action 吗？  
2. GUI/CLI/MCP 是否同一合同？  
3. 是否默认离线？  
4. 依赖是否可进 Lite portable（无 GPL 阻塞）？  
5. 是否可用插件代替内置？能插件则优先插件（控体积）

---

## 7. 建议执行顺序（90 天视角）

| 阶段 | 主题 | 产出 |
| --- | --- | --- |
| **W1–W2** | 云端包存储规格 P0-1a | 契约文档 + key 规范 + 威胁模型半页 |
| **W3–W5** | CLI sync-storage P0-1b | 可对 R2/S3/MinIO dry-run/push |
| **W4–W6** | 客户端消费 P0-1c | Source Center 可装云源包 |
| **并行 P1** | JSON 可视化 / 图片压缩 / PDF 子集 | 2–3 个高复用本地工具 |
| **持续** | 插件模板与示例包上云 | 验证“生态靠包，不靠硬编码” |

证书签名、macOS/Linux runner **不阻塞**本路线（包存储与预览桌面解耦）。

---

## 8. 明确不做什么（防止范围爆炸）

- 不把 50 站做成内置导航首页  
- 不默认云端处理用户 Office/PDF/图片内容  
- 不在未完成验签前“一键安装网络包”  
- 不用云存储代替 portable 本地分发（两者并存）  
- 不为了功能列表牺牲 Lite 体积与启动体验  

---

## 9. 决策记录

| 决策 | 选择 |
| --- | --- |
| 产品主轴 | 本地工具运行时 + 签名包生态 |
| 云的位置 | **包与元数据**存储/分发，不是默认文件处理后端 |
| 丰富方式 | 内置只留高复用；长尾插件化 |
| 50 站角色 | 需求地图与验收灵感，不是功能照抄清单 |
| 第一开工项 | **云端包存储 P0-1a → 1b → 1c** |

---

## 相关

- [FREE-AND-PRO-TOOLS.md](FREE-AND-PRO-TOOLS.md) — 免费/专业边界  
- [adr/ADR-012-source-availability.md](adr/ADR-012-source-availability.md) — 源可用性与对象 Head  
- [adr/ADR-006-federated-repositories.md](adr/ADR-006-federated-repositories.md) — 联邦源  
- [agent/BUILD-A-TOOL.md](agent/BUILD-A-TOOL.md) — 第三方包生产路径  
- [OPEN-SOURCE-REMAINING-GATES.md](OPEN-SOURCE-REMAINING-GATES.md) — 发布门禁（与云包存储解耦）  
