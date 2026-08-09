# ADR-008: TUF 信任模型（TUF Trust Model）

- 状态：Accepted
- 日期：2026-07-30
- 相关：ADR-006, ADR-007, ADR-010

## 背景

软件源必须抵御元数据篡改、回滚、冻结、密钥泄露等攻击。自行实现签名/元数据格式风险极高。

## 决策

- 采用 **TUF 风格元数据**（profile `tuf-v1`）：`root/targets/snapshot/timestamp` + consistent
  snapshot、过期、防回滚、防冻结、哈希与长度校验、门限签名、root 轮换、委派 targets。
- **禁止自行实现密码学原语**。
  - Rust 客户端：使用维护中、通过 TUF conformance 的 Rust 实现，经 `UsefulTrustBackend`
    trait 隔离具体依赖；锁定精确版本；对所有网络解析错误 fail closed；不因 panic 导致整个
    客户端退出；对元数据大小/嵌套深度/字段数量设限。
  - Go 服务端：使用 go-tuf v2 或等价实现；锁定版本；用官方 conformance/测试向量；root 私钥
    不入数据库、默认离线；timestamp/snapshot 用独立在线密钥；生产允许 KMS signer，开发允许
    文件密钥但显示警告。
- 推荐生产策略：root 2-of-3 离线多签；targets 2-of-3 或按发布者委派；snapshot/timestamp 各
  一个独立在线 KMS 密钥；timestamp 过期时间较短；root/targets 私钥不进普通 CI 日志。

## 官方源识别

`OfficialSource = root key fingerprint matches embedded official root trust`。官方徽章只由
预置根指纹匹配生成，绝不来自 source name/id/url/TLS 名称/favicon/operator。discovery 的
`rootUrl` 仅用于取候选 root，用户确认指纹后才保存信任根。

## 后果

- 新增 crate `useful-trust`（`UsefulTrustBackend` trait）与 `useful-repository-client`（Phase 6B/6C）。
- 发布者签名验证与源 TUF 验证**分离**，状态字段独立（不合并为单一 safe 布尔）。
- 篡改元数据后客户端拒绝安装（Phase 6C 验收）。

## 当前 TRP v1 root 恢复边界

TRP v1 discovery 尚未提供经过认证的“最新 root 版本”提示。客户端因此从钉住的
`1.root.json` 开始逐版本恢复 root 链；仅明确的 HTTP 404（本地源为文件不存在）结束探测，
网络错误、策略拒绝和其他 HTTP 状态均 fail closed。客户端最多接受到 root v32；若 v33
仍存在，则拒绝安装并要求升级支持完整恢复的客户端，绝不静默停在旧 root。每个轮换 root
仍必须通过新旧双门限验证，并保持 `consistent_snapshot: true`。
