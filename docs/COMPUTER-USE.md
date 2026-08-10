# Computer Use 安全合同 V1

Useful 的 Computer Use 合同是 provider-neutral 的安全边界，不是桌面自动化实现。它的 schema identity 固定为 `useful.computer-use.v1`，默认 provider 永久关闭并返回稳定错误 `COMPUTER_USE_DISABLED`。本包不会生成 ActionDescriptor、注册 MCP 工具、连接模型 API，或控制用户的鼠标、键盘和桌面。

## 信任边界

- 仅允许 `isolated-browser` 和 `isolated-vm`。`host-desktop` 会被明确拒绝，不能通过配置降级开启。
- 默认 allowlist 为空，此时合同处于离线模式并拒绝任何 network evidence。启用网络后，provider 每次 observe/commit 都必须报告 `complete: true` 的完整 hop chain；每跳包含无凭据 HTTP(S) URL 和实际解析 IP。所有 hop 域名、IP 与 redirect 数分别校验。
- localhost、单标签主机、IPv4-mapped IPv6、unspecified、loopback、私网、链路本地、multicast、保留/文档网段与常见 metadata 可达地址默认拒绝。只有同时设置 `developmentMode: true` 与 `allowPrivateDomains: true` 的显式开发配置才可使用，生产默认绝不会开启。
- session 受 `maxSteps`、单步 deadline、总 deadline、截图字节上限和最大重定向数约束，所有 provider 调用均接收 `AbortSignal`。

## 两阶段执行

provider 必须实现 `createSession`、`observe`、`execute`、`close`。`execute` 是强制的两阶段协议：

1. `prepare` 必须无副作用，返回 opaque `preparedActionId`、provider safety checks 和风险标记。
2. 合同合并模型提交的 safety checks、provider safety checks，以及合同为高影响动作生成的检查。
3. 每条检查必须单独通过显式 approval callback。审批请求绑定 `preparedActionId`、step、observation digest、规范化 action digest，并带完整冻结 action；因此人工审批界面能看到准确的输入文本、按键或坐标。没有 callback、拒绝、无有效 approval ID 都会 fail closed。
4. 只有全部确认后才调用 `commit`。provider 不得在 `prepare`、`observe` 或 `createSession` 中执行用户动作。

`click`、`double-click`、`drag`、`type`、`key` 始终作为高影响动作确认；provider 可以把其他动作升级为高影响，但不能降级合同的固定分类。

每个 session 只有一个 operation slot；observe、execute 与 close 严格串行。每次动作必须携带严格单调的 `step` 和最新 observation 的 SHA-256 digest。合同会拒绝缺少 observation、旧 digest、重放 step、跳步和并发动作。动作一旦进入执行路径，该 step 即被消费，latest digest 立即清除；无论成功或失败都必须重新 observe 并使用下一 step，不能重放。close 会增加 session generation、取消当前内部 signal，并等待 operation slot 结算；迟到的 observation/prepare/approval 会在 generation fence 被拒绝，不能返回给调用者或继续 commit。

所有 deadline、外部 cancel 和 close 都会 abort 传给 provider/approval 的内部 signal，并在每个 await 之后重新检查 signal 与 session generation。若 commit 尚未开始，迟到任务无法进入 commit。若 commit 已开始而 provider 忽略 abort，合同无法撤销隔离层中已经发生或正在发生的输入；此时结果视为未知，session 会 poison 并进入 close。adapter 必须在 isolated browser/VM 层实现可强制终止的执行与幂等 close，不能把 JavaScript `AbortSignal` 当成进程或网络防火墙。

close 的并发/重复调用共享同一 promise；provider 成功关闭后永远不会再次调用。若 provider close 明确失败或超时，合同保留 poisoned tombstone，不会假装删除 session；后续 close/reap 可以重试，因此 adapter 的 close 本身也必须幂等。reap 只统计 provider 已确认关闭的 session。

V1 的动作 closed set 是：`screenshot`、`click`、`double-click`、`drag`、`move`、`scroll`、`type`、`key`、`wait`。未知动作和未知字段均拒绝。

## 审计与隐私

审计事件只包含合同/事件/session/prepared/approval ID、时间、动作类型、允许域、坐标、observation/action digest、截图大小、safety check ID 和结果码；所有外部 ID/结果码必须满足 `SAFE_ID`。它绝不包含截图字节、输入文本、按键内容、provider handle、approval 描述、token 或 secret。

在 commit 前，合同先写入 metadata-only `authorization` 审计；该 sink 失败时绝不会调用 commit。commit 完成后的 `action` 审计若失败，动作已经不可撤销：调用会返回 `AUDIT_FAILED`，session 随即 poison/close，不能伪报成“动作未发生”。

Network evidence 是 provider 报告的合同证据，不是防火墙，也无法证明真实 DNS、socket 或 redirect 行为。trusted sandbox adapter/network layer 必须独立对实际 DNS 结果、每次连接及每个 redirect 强制执行同一 allowlist/IP 策略；不得仅依赖 provider 自报字段。

## Adapter 边界

OpenAI Responses/Computer Use adapter 与 Anthropic Computer Use adapter 必须后续在独立包实现。两家的宿主消息、tool schema、循环控制、模型标识和 API 凭据不得进入本合同；adapter 只能把各自协议转换成这里的 session、observation、prepare/approval/commit 状态机。Codex、Claude、MCP、CLI 与 GUI 的注册和配置也由上层集成负责。

`@useful/computer-use-browser-adapter` 只提供 owner-approved、宿主注入的
isolated browser adapter interface；它不是默认 provider、浏览器发行物、
Playwright 封装、防火墙或完整 Computer Use 产品，也不会注册 Action/MCP 或控制
host desktop。它只接受 `isolated-browser`，并要求宿主网络 guard 在创建真实
browser context 前授权固定且规范化的 `startUrl`。guard 必须声明并实际强制：
逐 request、DNS 全部地址、每个 redirect hop 和明确的 effective port；证据必须
来自 guard，不采信 page/driver 自报。

宿主 context 是窄化的 trusted enforcement interface，只暴露 observe、九个固定
动作 primitive 和幂等 close；没有任意导航、eval/JavaScript、文件/下载、剪贴板、
扩展、raw browser/page 或桌面 handle。observe 返回由宿主隔离层签发的
`documentToken`，每次 commit 都把该 token 传回 primitive；宿主必须在顶层文档
变化后轮换 token，并在 token stale 时先于输入 fail closed。adapter 自己还会把
prepared record 绑定到 session identity、generation、observation generation、
document token、step、observation digest 和 canonical action digest，一次消费，
拒绝 stale/replay/concurrent。这里的接口声明是集成方必须实现的信任边界，并不表示
adapter 能从 driver capability 字段运行时自证这些隔离属性。

所有外部对象采用 closed-world own-data-property 校验；截图复制进 adapter 自有
`ArrayBuffer`，拒绝 SharedArrayBuffer/超限数据。若 commit 已开始后 abort、deadline
或 guard evidence 失败，结果按未知处理并触发 context+guard quarantine/close。
close 只有在两者都确认释放后才成功；失败保留可重试状态，不能伪报关闭。adapter
不记录 screenshot、输入文本、按键或宿主错误原文。

adapter 的首次 close 会永久关闭该 session 的 observe/prepare/commit admission；即使
close 失败，之后也只允许 close 重试。释放顺序固定为先 context、确认成功后再 guard；
context close 失败时绝不释放 guard。invalid、partial 或 abort-late acquisition 若未能
确认释放，会被强引用保存在内部 quarantine registry。宿主集成可以显式调用窄化、幂等、
可取消的 `provider.reapQuarantine({ signal })`，它只返回 remaining/closed 计数并保留
失败项供以后重试；默认 controller 不接线、不暴露这个维护接口，也不会因此注册 Action
或 MCP。

quarantine 与正常 handle 使用同一套 raw identity resource lease：每个 raw 只有一个
close state，每次 acquisition 分别持有 driver/guard claim。guard pending claim 必须在
`createContext` 前登记；closing、closed 或 close-failed identity 不再接受新 claim。
只有全部 claim 请求关闭且每个 guard 的 driver dependency 已确认 closed，才允许安装
唯一共享 close promise 并调用 raw close。共享 identity、跨角色引用环和并发 reap 因此
只能保留/推进 tombstone，不能绕过 driver→guard 顺序提前释放。

```js
import { createComputerUseController } from "@useful/computer-use-contract";

const controller = createComputerUseController({
  provider, // isolated provider; prepare must be side-effect-free
  policy: {
    allowDomains: ["example.com"], // enables network evidence requirements
    maxRedirects: 2,
  },
  approval: async ({ safetyCheck }) => presentApprovalToHuman(safetyCheck),
  audit: async (event) => appendMetadataOnlyAudit(event),
});
```

默认构造不传 provider 时不会执行任何动作，只会返回 `COMPUTER_USE_DISABLED`。
