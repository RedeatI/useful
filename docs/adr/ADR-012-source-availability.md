# ADR-012: 真实 sourceAvailable —— 后台可用性检查

- 状态：已接受（2026-07）
- 关联：ADR-006（联邦源）、catalog-entry.schema.json、migrations/0004_availability.sql

## 背景

`catalog` 中的 `review.sourceAvailable` 一直硬编码为 `false`。要么恒假无意义，
要么天真实现会在每次 catalog 查询时同步探测远程地址——引入延迟、请求放大与
SSRF 风险。RC 要求它由"有时间戳的真实状态"推导。

## 决策

1. **独立状态机**：`unknown / healthy / degraded / unavailable`，记录 source_id、
   artifact digest、检查目标、最近成功/失败时间、连续失败次数、错误类别、检查
   时间、结果过期时间（`availability_checks` 表）。
2. **后台任务**：`internal/availability.Checker` 由 worker（生产）与 server 内嵌
   循环（开发内存模式）周期运行，绝不在 catalog 查询路径同步探测。
3. **防 SSRF（结构性）**：检查目标只能是本源自己的内容寻址存储键
   （`storage.PublishedKey(sha)`），永不接受用户输入的任意 URL。动态源检查
   "数据库记录 vs 对象存储对象"一致性（Head 元信息 + 大小比对）。
4. **不下载大文件**：只用 `Store.Head` 获取元信息，不读对象内容。
5. **超时/退避/风暴防护**：每次检查独立超时（默认 10s）；每轮扫描有数量上限
   （默认 200）；`RecheckAfter` 窗口内的新鲜结果跳过——因此海量制品不会造成
   请求风暴，最久未检查的优先。
6. **失败语义**：对象缺失或大小不符是硬错误 → 直接 `unavailable`；瞬时错误
   （超时/存储故障）先 `degraded`，连续失败达阈值（默认 3）才 `unavailable`。
   镜像语义预留：单镜像失败但仍有可用镜像标 `degraded` 而非 `unavailable`。
7. **过期即 unknown**：`AvailabilityCheck.Effective(now)` 在结果过期后返回
   `unknown`，绝不沿用旧的 `healthy`。
8. **catalog 推导**：条目级聚合——全部 healthy → healthy 且 `sourceAvailable=true`；
   任一 unknown（含过期）→ unknown；全部 unavailable → unavailable；其余
   → degraded。`sourceAvailable` 仅在聚合结果为 healthy 时为 true。
9. **UI 数据**：catalog 条目新增可扩展 `availability { status, checkedAt, source }`，
   供 UI 显示"最后检查时间"与"状态来源"。
10. **兼容性**：schema 中 `availability` 为可选；Rust `CatalogEntry`/`ReviewStatus`
    放宽为允许未知字段（条目是可演进数据），但 identity/artifact 摘要等安全锁定
    结构仍 `deny_unknown_fields`。错误类别为固定枚举，不泄漏路径。

## 影响

- 迁移 0004（availability_checks），回滚见迁移文件头。
- 新增 `internal/availability` 包与 8 个故障测试（缺失/超时/大小不符/部分失败/
  全部失败/过期/恢复/无请求风暴/错误类别不泄漏路径）。
- 静态源可用性（元数据 + target 对象可访问）由客户端侧或未来聚合器补充，
  当前动态源实现已覆盖 RC 需求。
