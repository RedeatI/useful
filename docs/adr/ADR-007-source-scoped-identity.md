# ADR-007: 源域身份（Source-Scoped Identity）

- 状态：Accepted
- 日期：2026-07-30
- 相关：ADR-006, ADR-008；`schemas/{common,catalog-entry,installed-origin,publisher}.schema.json`

## 背景

联邦模型下，同一个 `toolId` 可能出现在多个源、由不同发布者签名。仅用 `toolId` 作为全局
身份会导致同名工具互相覆盖、来源被静默切换、伪装发布者继承信誉。

## 决策

- 工具全局身份为 `ToolIdentity = PublisherKeyId + ToolId`；禁止仅用 ToolId。
- 安装来源为 `InstalledOrigin = SourceId + PublisherKeyId + ToolId`，客户端持久化并用于
  **来源固定**与**发布者固定**。
- 更新只在相同 `(source_id, publisher_key_id, tool_id)` 且合法 SemVer 升级、channel 匹配、
  权限未新增或已确认、digest 与 TUF 一致、发布者签名有效时进行。
- 禁止：跨源自动选最高版本、因第三方源版本更高而切换来源、同名自动覆盖、发布者密钥变化
  后静默更新、版本号相同但摘要不同的静默替换。
- 官方性**不由**名称/ID/URL/TLS 名称/favicon/operator 文本决定；仅由根公钥指纹匹配客户端
  预置官方根确认（实现见 ADR-008）。第三方源可显示「发布者已验证/源签名有效/社区推荐」，
  但不得显示「Useful 官方源」或冒充官方。
- 同名不同发布者不得合并；同发布者、同摘要、不同镜像源可折叠并显示可用镜像。

## 后果

- catalog 合并键为 `ToolIdentity`；数据库版本唯一约束含 `publisher_key_id + tool_id + version + platform + arch`。
- 来源迁移是明确用户操作，展示旧/新源、旧/新发布者指纹、版本/权限/摘要差异、是否同镜像。
- 由 `test/validate.test.mjs` 断言 `toolIdentity` 必须含 `publisherKeyId`、discovery 不能自报官方。
