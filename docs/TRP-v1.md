# Useful Repository Protocol (TRP) v1

> 历史协议标识仍可写作 Useful Repository Protocol；公开产品名为 Useful。客户端与软件源之间的联邦协议代号保持 TRP v1。

状态：Draft v1 · 许可证：Apache-2.0 · 时间：RFC3339 UTC · 版本：SemVer · 摘要：SHA-256

TRP v1 定义 Useful 客户端与「软件源」之间的联邦协议。任何人都可以运行一个符合本
协议的软件源；官方源只是默认预置源，在协议层不享有不可替代的特殊权力。

## 1. 设计目标

- 支持静态源、动态源、匿名免费源、需登录源、需订阅源、私有团队源、镜像源。
- 每个源拥有独立的信任根、账户、权限、订阅与下载策略。
- 官方身份通过**客户端预置根公钥指纹**确认，绝不通过服务器自报的名称/ID/URL/favicon 确认。
- 普通工具源**不能**更新 Useful 客户端主程序（Windows 兼容文件名仍为 `Useful.exe`）；客户端更新与工具更新使用不同信任域。
- 商业信息（价格、订阅）不进入不可变的 package manifest，只存在于可变的 CatalogOffer。

## 2. 权威工件

| 工件 | 位置 |
| --- | --- |
| JSON Schema（10 个） | `packages/protocol/schemas/*.schema.json` |
| OpenAPI 3.1 契约 | `packages/protocol/openapi/repository-v1.yaml` |
| 测试向量 | `packages/protocol/test-vectors/` |
| 一致性测试 | `packages/protocol/test/*.test.mjs`（`pnpm --filter @useful/protocol test`） |

OpenAPI 3.1 是唯一公共 API 契约；TS/Rust/Go 类型由它生成，不得包含业务逻辑。

## 3. 通用约束

- 所有时间：RFC3339 UTC。所有版本：SemVer 2.0.0。所有许可证：SPDX License Expression。
- 所有摘要首版：SHA-256（小写 64 位十六进制）。所有 ID：小写规范格式（反向域名式）。
- 所有外部输入设长度与数量上限（见各 schema 的 `maxLength`/`maxItems`）。

## 4. 软件源发现

`GET /.well-known/useful-repository.json` → `repository-discovery.schema.json`。

安全约束（强制）：

- discovery 文件本身**不构成信任根**；`source.id` **不构成官方身份**。
- `rootUrl` 只能用于获取**候选** root metadata；用户确认根密钥指纹后才保存信任根。
- 禁止 HTTPS 降级到 HTTP（schema 的 `httpsUrl` 用 `^https://` 强制）。
- 限制 discovery 大小、限制重定向次数、禁止无限重定向（客户端实现约束）。
- `localhost`/`file` 源必须显式标记为本地/开发源（`source-definition.schema.json` 的 `local`）。
- `capabilities` 为 `additionalProperties:false`，**结构性禁止**出现任何客户端更新能力键。

## 5. 身份模型

- `ToolIdentity = PublisherKeyId + ToolId`（`common.schema.json#/$defs/toolIdentity`）。
  禁止仅用 ToolId 作为全局身份；同名不同发布者**不得合并**。
- `InstalledOrigin = SourceId + PublisherKeyId + ToolId`（`installed-origin.schema.json`）。
  客户端记录 `installedVersion / artifactSha256 / channel / manifestDigest / installedAt / lastCheckedAt`。
- 更新默认只接受：相同 source_id、相同 publisher_key_id、相同 tool_id、合法 SemVer 升级、
  相同或用户明确切换的 channel、权限未新增或已确认、artifact digest 与 TUF metadata 一致、
  发布者签名有效。来源迁移必须是明确操作，展示新旧源/指纹/版本/权限/摘要差异。

## 6. 信任域隔离（关键不变量）

TRP 在**类型层面**保证普通工具源无法更新客户端：

- `source-definition.schema.json` 的 `kind` 枚举仅 `["tool","mirror"]`，不存在 `app-update`。
- 工具源 `capabilities` 复用 discovery 定义，`additionalProperties:false`，无任何更新能力键。
- 客户端更新由独立的 `app-update-source.schema.json` 承载：`kind` 固定 `const:"app-update"`，
  拥有专用字段 `updateTrustRoot.updateRootKeyFingerprint`，与工具源信任根字段刻意不同名。
- OpenAPI 契约中**不存在**任何 app-update/client-update/bootstrap 端点。

上述不变量由 `test/validate.test.mjs` 与 `test/openapi.test.mjs` 断言。

## 7. TUF 软件源安全（profile: tuf-v1）

元数据集合：`root / targets / snapshot / timestamp` + consistent snapshot、过期、防回滚、
防冻结、哈希与长度校验、门限签名、root 轮换、委派 targets。客户端与服务端均**禁止自行
实现密码学原语**，使用维护中的 TUF 实现（Rust 侧经 `UsefulTrustBackend` trait 隔离，
Go 侧用 go-tuf v2 或等价实现）。详见 ADR-008。

## 8. 商业与权益

- `CatalogOffer.accessMode ∈ {free, entitlement, external-purchase, private, unavailable}`。
- `SourceEntitlement` 属于特定源；客户端可缓存用于 UI，但新的付费下载必须向所属源申请
  `DownloadGrant`，不得仅凭本地缓存授权。取消/过期后已安装本地版本继续运行（无运行期 DRM）。
  详见 ADR-009。
- `DownloadGrant` 短期有效，URL 绑定 artifact digest 但不作为身份；客户端以 TUF metadata 与
  SHA-256 为最终依据。

## 9. 版本

TRP v1 冻结 `schemaVersion: "1.0"`。向后兼容的新增字段走小版本；破坏性变更走 TRP v2。
