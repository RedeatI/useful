# 生产部署与运维手册（source-server / source-worker）

> 适用于自托管与官方部署。开发/演示见 `deploy/docker-compose/README.md`。
> 原则回顾：root 私钥离线；服务器只持有 targets/snapshot/timestamp 在线密钥（生产建议 KMS）；
> 已发布制品不可变、不可删除（撤回用 withdrawn 状态）；审计 append-only。

## 1. CDN 配置

静态内容优先由 CDN 服务，source-server 不代理大文件正文。

| 路径 | 缓存策略 | 说明 |
| --- | --- | --- |
| `/metadata/timestamp.json` | `max-age=60`，必须可快速失效 | TUF 新鲜度锚点，过期窗口短 |
| `/metadata/<v>.snapshot.json`、`<v>.targets.json`、`<v>.root.json` | `max-age=31536000, immutable` | consistent snapshot：带版本前缀的文件不可变 |
| `/targets/<sha256>.<name>` | `max-age=31536000, immutable` | 内容寻址，天然不可变 |
| `/.well-known/useful-repository.json` | `max-age=300` | discovery 不构成信任根，可短缓存 |
| `/v1/*` API | 不缓存（`no-store`） | 授权/账户相关 |

要点：

- 回源只读：CDN 到源站使用只读凭据/路径白名单（`/metadata/*`、`/targets/*`）。
- 下载授权 URL（`/v1/blobs/<token>` 或 S3 预签名）为短期令牌，**禁止**配置 CDN 缓存，
  避免临时 URL 被缓存索引泄漏。
- 客户端最终以 TUF metadata + SHA-256 为准，CDN 篡改会被验证拒绝（完整性不依赖 CDN）。

## 2. 对象存储生命周期

对象键为内容寻址 `artifacts/sha256/ab/cd/<full-sha256>`；staging 与 published 分区。

| 前缀 | 生命周期 |
| --- | --- |
| `staging/` | 7 天后自动删除（上传会话失败/遗弃的隔离区对象） |
| `artifacts/`（published） | 永不自动删除；withdrawn 制品保留（已装用户审计/公告需要） |
| `metadata/` | 保留全部版本（consistent snapshot 回溯与审计） |

S3 示例（生命周期规则）：staging 前缀 Expiration 7 天；artifacts 前缀开启版本控制 +
Object Lock（合规模式可选），防误删除。

## 3. 数据库备份

- **全量**：每日 `pg_dump -Fc`（自定义格式，支持并行恢复），保留 30 天。
- **PITR**：开启 WAL 归档（`archive_mode=on`）+ 每周基础备份，目标 RPO ≤ 5 分钟。
- 备份必须加密存放（与生产网络隔离的存储桶），并**定期演练恢复**（至少每季度）。
- 备份中不含任何私钥（数据库 schema 层面即不存私钥，`publisher_keys` 只有公钥/KMS 引用；
  有结构性测试 `TestRootPrivateKeyNeverInDatabaseSchema` 保证）。

docker-compose 环境最小备份命令：

```
docker compose exec -T postgres pg_dump -U useful -Fc useful_source > backup-$(date +%F).dump
```

## 4. 灾难恢复（DR）

恢复优先级与步骤：

1. **数据库**：从最近全量 + WAL 恢复到新实例；校验 `migrations` 表版本。
2. **对象存储**：`artifacts/` 为内容寻址，可从任何镜像/备份桶按摘要校验后回填。
3. **TUF 在线密钥**（targets/snapshot/timestamp）：从 KMS/密钥备份恢复；
   如疑似泄漏 → 用离线 root 执行密钥轮换（签发新 root 版本，撤销旧在线密钥）。
4. **root 私钥**：离线多签（推荐 2-of-3），分开地理位置保管；root 泄漏是最高级事件，
   需按 TUF root rotation 流程签发 `N+1.root.json` 并公告。
5. **重建验证**：恢复后运行 `GET /v1/ready`、抽样 download-grant 全流程、
   客户端同步一次目录验证 TUF 链。

RTO 目标：API 1 小时内；完整目录+下载 4 小时内。

## 5. 限流与配额

代码内建（`httpapi`）：每 IP 300 请求/10 秒滑动窗口；请求体上限（`MAX_REQUEST_BODY`）；
上传上限（`MAX_UPLOAD_SIZE`）；分页上限（catalog search ≤ 100）。

生产建议在反向代理层追加：

- `POST /v1/download-grants`：每 IP 60/分钟（防授权枚举）。
- `POST /oauth/token`：每 IP 30/分钟（防授权码爆破；码本身短期+一次性）。
- `PUT /v1/publisher/upload-sessions/*/content`：并发连接数限制而非速率限制。
- 全局连接超时：header 10s（代码内建）、上传写超时按包大小放宽。

## 6. 审计

- `audit_logs` append-only（数据库触发器禁止 UPDATE/DELETE，迁移 0001 定义）。
- 已覆盖事件：release.created、artifact.scanned/scan_failed/published/rejected/withdrawn、
  advisory.created、publisher.key_rotated、download.grant、webhook 处理。
- 明确不记录：access/refresh token、authorization code、完整临时下载 URL、
  用户文件路径、OAuth state 原值（e2e 测试断言审计不含 `/v1/blobs/`）。
- 建议：审计流每日导出到 WORM 存储（对象锁定桶），保留 ≥ 1 年。

## 7. SLA 指标（监控基线）

| 指标 | 目标 | 来源 |
| --- | --- | --- |
| API 可用性（月） | ≥ 99.9% | `/v1/health` 外部拨测 |
| download-grant P95 | < 200ms（不含第三方支付） | 结构化日志 durMs |
| timestamp.json 新鲜度 | 始终 < 过期窗口的 50% | 定时器 + 拨测 |
| webhook 处理失败率 | < 0.1%，失败重试成功 | billing_events processed |
| job 队列深度 | < 100（`/v1/ready` 返回 jobQueueDepth） | readiness 探针 |
| 扫描失败率 | 告警阈值 5% | audit artifact.scan_failed |

告警必须包含：metadata publish failure（timestamp 未按期重签）、upload failure 突增、
grant 403/5xx 比率突增、数据库连接池耗尽。

## 8. 密钥清单与轮换周期

| 密钥 | 存放 | 轮换 |
| --- | --- | --- |
| TUF root | 离线（推荐 2-of-3 多签） | 1–2 年或事件驱动 |
| TUF targets/snapshot/timestamp | KMS（生产）/文件（开发，启动有警告） | 90 天 |
| OAUTH_SIGNING_SECRET | 秘密管理器 | 90 天（轮换使旧 token 失效，属预期） |
| DOWNLOAD_TOKEN_SECRET | 秘密管理器 | 90 天 |
| ADMIN_TOKEN | 秘密管理器 | 30 天，将被 source-admin 独立认证取代 |
| 客户端更新根（AppUpdate） | 离线，与上面全部隔离 | 事件驱动；轮换需发布新客户端 |

生产环境禁止 `BILLING_PROVIDER=fake`（启动时拒绝，有测试）；
`ENVIRONMENT=production` 时缺少预置 root 拒绝启动（不自动生成密钥）。
