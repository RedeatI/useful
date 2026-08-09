# ADR-010: 客户端更新隔离（Client Update Isolation）

- 状态：Accepted
- 日期：2026-07-30
- 相关：ADR-006, ADR-008；`schemas/{source-definition,app-update-source}.schema.json`

## 背景

若普通工具源能更新 Useful 客户端主程序（Windows 兼容文件名 `Useful.exe`），一个被攻陷或恶意的第三方源即可接管用户机器。
客户端更新与工具更新必须使用完全不同的信任域。

## 决策

- **工具源（ToolSource）**由 `source-definition.schema.json` 定义，`kind ∈ {tool, mirror}`，
  其 `capabilities` 为 `additionalProperties:false` 且不含任何更新能力键 → 结构上不可能声明
  更新客户端。
- **客户端更新源（AppUpdateSource）**由独立的 `app-update-source.schema.json` 定义，
  `kind = const "app-update"`，拥有专用信任根字段 `updateTrustRoot.updateRootKeyFingerprint`，
  与工具源信任根字段刻意不同名，禁止相互赋值。
- 只有 `AppUpdateSource` 可以更新客户端；默认使用官方预置公钥。
- 更换 `AppUpdateSource` 需：单独页面、单独警告、明确导入客户端更新根密钥；不从任何工具源
  自动继承，也不因添加工具源而改变。
- **官方身份的唯一真相是公钥字节**：`AppUpdateSource::validate` 对警告确认门的豁免
  仅基于 `is_official()`（公钥字节匹配预置根），**绝不采信持久化的 `isDefaultOfficial`
  布尔位**（可被本地写入/注入）；且 `isDefaultOfficial=true` 但公钥非官方的配置直接
  拒绝（fail closed）。防止“翻一个布尔位就静默换根”绕过警告门。
- OpenAPI 契约中不存在任何 app-update/client-update/bootstrap 端点（工具源 API 无此能力）。
- 客户端更新的实际应用由独立的 `useful-bootstrap.exe` 执行（Phase 10）：验证客户端专用更新
  签名、确认主程序退出、备份、原子替换、失败回滚、清理过期备份。

## 后果

- 由 `test/validate.test.mjs`（kind 枚举不含 app-update、capabilities 拒绝 appUpdate 键）与
  `test/openapi.test.mjs`（无客户端更新端点）断言此不变量，防止回归。
- 验收：工具源无法更新 `Useful.exe`；客户端更新包签名错误时拒绝；更新失败后旧版本仍可启动。
- **信任边界回归修复（本轮 Loop E 复查发现）**：`validate` 曾用可篡改的 `isDefaultOfficial`
  布尔位豁免警告确认门，使本地写入 `isDefaultOfficial=true` + 攻击者根公钥 + 无确认
  可静默把非官方根装为信任锚。已改为基于 `is_official()` 公钥匹配判定，并新增回归
  测试 `spoofed_default_official_flag_rejected` + property 测试（tests/property_update_config.rs，
  6 项：官方身份不可伪造、警告门不可绕过）。
