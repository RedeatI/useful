# ADR-009: 无运行期 DRM 的订阅（Subscription without Runtime DRM）

- 状态：Accepted
- 日期：2026-07-30
- 相关：ADR-006；`schemas/{entitlement,download-grant,catalog-entry}.schema.json`

## 背景

官方源提供本地高级工具的付费订阅。但产品原则要求：订阅控制官方下载与更新，不控制已下载
版本的启动；取消订阅后已安装版本继续运行；不实现远程删除、远程锁机或破坏本地数据的 DRM。

## 决策

- 权益属于特定源（`SourceEntitlement`，含 `source_id/subject_id/entitlement_id/product_id/
  plan_id/tool_scope/version_scope/channel_scope/status/starts_at/expires_at/grace_until/updated_at`）。
- 客户端可缓存权益**仅用于 UI**；实际付费下载必须向所属源申请 `DownloadGrant`，不得仅凭
  本地缓存授权新的付费下载。
- 本地工具行为按 `status`：`active` 允许下载/更新；`grace` 按服务端策略继续；`canceled`/
  `expired` 已安装版本继续运行、不允许新付费下载；`revoked` 停止未来下载、**不删除**本地工具。
- 云服务型工具的可用性由云端 API 单独决定，与本地启动解耦。
- 商业信息只在可变的 `CatalogOffer`（`accessMode`），**绝不**写入不可变 package manifest。

## 后果

- Phase 8 的 entitlement 计算与 download-grant 授权在服务端实现；`FakeBillingProvider` 演示
  完整付费权益流程。
- 验收：取消订阅后已安装本地工具仍能启动；取消后不能取得新的付费 download grant。
- 明确不做：远程删除工具、远程锁机、破坏本地数据。
