# 用 Agent 构建并签名一个 Useful 工具

简体中文 · [English](BUILD-A-TOOL.en.md)

Useful 是公开产品与仓库名称。`useful`、`useful-runtime`、`useful-mcp` 命令和包名、
`useful.*` schema/protocol 标识、`.useful` 扩展名以及兼容占位符
`<USEFUL_REPOSITORY_URL>` 是既有开发者接口；为保持生态兼容，本文命令示例和机器可读标识不改名。

这是 Agent-first 外部开发者流程的唯一事实源。目标是在干净目录中生成可分享的本地
`.useful`、publisher signature sidecar 和 SHA-256；“分享”仅指把这两个文件附加到 GitHub
Release 或交给 Useful source 维护者，绝不代表 CLI 会自动上传或绕过 source/publisher
信任链。

规范源码仓库地址：`https://github.com/RedeatI/useful`。只有该地址实际公开且可访问后，才把它当作
可克隆的发布入口；不要根据文档文字推断远端状态，也不要编造其他远端。

## Agent Kit 入口（已发布预览资产）

当前发布预览是
[`Useful-0.1.0-beta.10-agent-kit.zip`](https://github.com/RedeatI/useful/releases/download/v0.1.0-beta.10/Useful-0.1.0-beta.10-agent-kit.zip)。
解压后只要求 Node.js 20 或更高版本；无需 monorepo、GUI 或全局安装，也不改变本文的非交互 JSON、
非零即停、默认 `minimal-web` 和签名信任链边界。发布后 Windows 验收记录见
[`0.1.0-beta.10-agent-kit-acceptance.md`](../releases/0.1.0-beta.10-agent-kit-acceptance.md)。

后续版本只有在受控工作流把同版本 Kit 附到匹配的 GitHub Release，并提供校验和与来源证据后，才是
已发布资产；本地 Kit 构建仍不授权公开分发。

Windows launcher 示例：

```powershell
& "<ABS_KIT>\bin\useful.cmd" agent-contract --json
& "<ABS_KIT>\bin\useful-runtime.cmd" actions list --json
node "<ABS_KIT>\lib\useful-mcp.mjs"
```

POSIX launcher 示例：

```bash
"<ABS_KIT>/bin/useful" agent-contract --json
"<ABS_KIT>/bin/useful-runtime" actions list --json
node "<ABS_KIT>/lib/useful-mcp.mjs"
```

包内仍提供兼容的 `useful-mcp` launcher；MCP host 配置推荐直接使用
`node <ABS_KIT>/lib/useful-mcp.mjs`，避免依赖 shell 或全局 PATH。

## 前提与硬边界

- Node.js 20 或更高版本，并且只选择一个本地入口：推荐使用已解压 Agent Kit 的 launcher（绝对路径，
  或仅把 `<ABS_KIT>/bin` 加入当前进程 PATH），也可使用源码 checkout 中的锁定入口。不得全局安装，
  不得使用 package runner 或其他网络解析器获取 CLI。
- Agent 必须先读根 [`AGENTS.md`](../../AGENTS.md)，只执行非交互 `--json` 命令。
- 每一步只解析 stdout 的一个 JSON 文档；stderr 应为空；退出码非零就停止，不挑样本重跑。
- 私钥只留在 `<PUBLISHER_DIR>`。不得提交或输出私钥、`.env`、Bearer/admin token。
- `minimal-action` 只生成声明式 `pipeline-v1`；它不是任意 JavaScript、worker、WASM、WASI、native
  或脚本执行入口，也不提供一键网络发布。

下文的 `useful` 均指已经选择并解析到本地文件的兼容 launcher；禁止在执行时回退到网络解析。
先执行 `useful agent-contract --json` 获取当前命令形状、退出码和模板列表。

开发者入口可以是仓库 README、复制提示词，或另行维护的可选 Agent Skill（`SKILL.md` 配合
`references/assets` 做渐进披露）。无论入口是什么，本文件仍是唯一流程事实源；Skill 不构成 `.useful` artifact
签名、publisher pin 或 runtime handler 信任，也不得自动执行上传/发布。本仓库当前不发布或自动安装该 Skill。

## 稳定 JSON 契约

成功：

```json
{"schemaVersion":"useful.cli.result.v1","ok":true,"command":"doctor","data":{}}
```

失败仍只输出一个 JSON 文档：

```json
{"schemaVersion":"useful.cli.result.v1","ok":false,"command":"doctor","error":{"code":"DOCTOR_FAILED","message":"工具目录未通过 doctor 硬检查","details":{}},"data":{}}
```

`error.code`、`message`、`details` 用于 Agent 判定和修复；doctor/validate/pack 的失败可携带
`data.checks`、`summary` 与逐项 `remediation`。JSON 模式不输出彩色提示，也不把人类日志混入
stdout/stderr。

退出码固定为：

| 退出码 | 含义 | Agent 动作 |
| ---: | --- | --- |
| 0 | 成功 | 继续下一步 |
| 2 | 用法或未知选项 | 修正命令，不猜交互提示 |
| 3 | manifest、doctor 或打包前验证失败 | 按 checks/remediation 修复后重新开始受影响步骤 |
| 4 | 安全拒绝或 I/O 失败 | 停止；检查已有目录、秘密、链接、权限或路径 |
| 5 | 内部错误 | 停止并保留完整的脱敏 JSON 结果用于 HANDOFF |

## 模板能力

| 模板 | 默认权限 | 用途 |
| --- | --- | --- |
| `minimal-web` | `[]` | 推荐；最小零权限 Web 工具 |
| `minimal-action` | `[]` | 零权限 Web 外壳 + 可由 runtime/MCP 执行的声明式 Action |
| `starter-web` | 无 | 兼容旧 `create-useful-tool <dir>` 的零 native 权限握手示例 |

`create` 不接受任意 permissions 字符串。权限只能来自所选模板。`minimal-action` 的 action spec 是
`actions/base64-sha256.json`：先调用 `builtin.utilities.base64`，再调用
`builtin.utilities.hash`；插件不提供或执行 handler 代码。

## 权威命令序列

Agent 先把占位符替换为绝对或当前工作目录下的明确路径。所有目录必须尚不存在；不要传
force。逐条执行，解析唯一 JSON，并在任一步非零时立即停止：

```powershell
useful create "<TOOL_DIR>" --id com.example.agent-tool --name "Agent Tool" --template minimal-action --json
useful doctor "<TOOL_DIR>" --json
useful validate "<TOOL_DIR>" --json
useful pack "<TOOL_DIR>" "<OUT_DIR>" --json
useful publisher init "<PUBLISHER_DIR>" --id com.example.agent-publisher --name "Agent Publisher" --json
useful publisher sign "<ARTIFACT_PATH>" --key "<PUBLISHER_DIR>/publisher.private.pem" --json
useful publisher verify "<ARTIFACT_PATH>" "<ARTIFACT_PATH>.publisher-signature.json" --json
```

从 pack 的 `data.artifactPath` 获取 `<ARTIFACT_PATH>`，并保存它返回的 `sha256`、
`sizeBytes`、`entryCount`。sign 默认把 sidecar 写到
`<ARTIFACT_PATH>.publisher-signature.json`；verify 必须返回 `valid: true`，且其
`artifactSha256` 与 pack 一致。

## 显式插件配置与运行

在一个新文件中写入 `useful.plugin-set.v1`。`artifactPath` 和 `signaturePath` 必须是相对配置文件
目录解析的安全相对路径；两个 pin 必须分别来自成功的 verify 与 pack，不能猜测或用旧 receipt：

```json
{
  "schemaVersion": "useful.plugin-set.v1",
  "plugins": [
    {
      "artifactPath": "artifacts/com.example.agent-tool-1.0.0.useful",
      "signaturePath": "artifacts/com.example.agent-tool-1.0.0.useful.publisher-signature.json",
      "expectedPublisherKeyId": "<VERIFY_DATA_PUBLISHER_KEY_ID>",
      "expectedArtifactSha256": "<PACK_DATA_SHA256>"
    }
  ]
}
```

`useful-runtime` 的全局参数只允许出现在 `actions` 之前；未知、重复或错位参数 fail closed：

```powershell
useful-runtime --plugin-config "<PLUGIN_CONFIG>" actions list --json
useful-runtime --plugin-config "<PLUGIN_CONFIG>" actions describe com.example.agent-tool.base64-sha256 --json
useful-runtime --plugin-config "<PLUGIN_CONFIG>" actions run com.example.agent-tool.base64-sha256 --input @request.json --output json
useful-mcp --plugin-config "<PLUGIN_CONFIG>"
```

不带 `--plugin-config` 时，runtime 的默认 registry 加载 36 个内建 Action：31 个
`builtin.utilities.*` 与 5 个 `builtin.office.*` Action family。MCP 除逐个注册这 36 个
Action 外，还固定提供 `useful.actions.search` / `describe` / `suggest` / `recipe` 4 个只读
helper，因此默认 `tools/list` 共 40 项。这 4 个 helper 不是 registry Action，也不是第三方
actionId 或 alias 可使用的命名。

带 `--plugin-config` 时不会扫描 AppData、数据库或 marketplace；启动先验证归档预算、
manifest、签名 receipt、双 pin、action schema、pipeline 与所有 testVectors，任一失败都在
注册/暴露任何第三方 Action 前停止。插件配置只在完成这条签名和双 pin 验证链后扩展
默认 registry，不会替换或降级内建 Action 的契约。

## 可选 Agent allowlist 与 presets

`useful.agent-profile.v1` 是独立于 manifest/plugin-set 的本地配置。它不能替代签名或 artifact/publisher
双 pin；runtime 总是先完成上一节的 AI-4 plugin registry 验证，再用 profile 过滤。profile 缺省时
保留上述 36 个内建 Action 的默认 CLI/MCP registry；显式存在时，未知 action、stale
version/publisher 或 surface disabled 都 fail closed。profile 是 exposure allowlist，不会为 Action 增加
权限、capability 或可信身份。

```json
{
  "schemaVersion": "useful.agent-profile.v1",
  "profileId": "default",
  "name": "本地 Agent allowlist",
  "actions": [
    {
      "actionId": "builtin.utilities.base64",
      "expectedContractVersion": "1.0",
      "expectedActionVersion": "1.0.0",
      "expectedSourceKind": "builtin",
      "expectedPublisherId": "useful.project",
      "enabled": { "cli": true, "mcp": true },
      "aliases": ["b64-encode"],
      "presets": [
        { "presetId": "encode", "name": "UTF-8 编码", "defaults": { "operation": "encode" } }
      ]
    }
  ]
}
```

presets 只允许 descriptor input schema 已知的顶层非敏感字段；可暂缺 required 字段。`text` 必须每次调用
提供。禁止 raw command/flags/argv/env/path/entry.args/launcher target/工作目录/路径模板以及表达式或插值。
调用时浅合并 `defaults + input`（input 覆盖），之后仍由 ActionExecutor 完整校验 schema、字节、权限和确认。

两个全局参数都只能各出现一次且位于 `actions` 前，顺序可互换；`--preset` 只用于显式 profile 的 CLI run。
profile alias 只供 CLI 解析，MCP 永远只注册 canonical actionId，本阶段不生成 MCP preset 虚拟工具：

```powershell
useful-runtime --plugin-config "<PLUGIN_CONFIG>" --agent-profile "<AGENT_PROFILE>" actions list --json
useful-runtime --agent-profile "<AGENT_PROFILE>" actions run builtin.utilities.base64 --preset encode --input @request.json --output json
useful-mcp --plugin-config "<PLUGIN_CONFIG>" --agent-profile "<AGENT_PROFILE>"
```

GUI 的“AI 与 Agent”从统一内建目录中关联 31 个 utility 和 5 个 Office GUI Action 元数据，
以及 `@useful/action-runtime/browser` 的同一组 36 个共享 descriptor/input schema。它可显式添加、
移除、排序和启停 CLI/MCP surface；既有 profile 不会因为新内建 Action 出现而自动扩权。
只有 descriptor input schema 中可单独验证的顶层非敏感字段可进入 preset；文件内容等敏感输入
仍必须每次调用提供。

“保存”只更新 SQLite；必须再显式点击“导出 profile”，才会原子替换固定路径文件。
CLI/MCP 只读取 `--agent-profile` 文件，不读取 SQLite，也不会自动修改 Codex、Claude 或
其他 Agent 配置。GUI 目录和 profile 只是展示/暴露配置，不能为第三方插件派生可信
handler、publisher 或 artifact 身份；plugin profile 条目在 GUI 中只读，最终必须由上述 signed
plugin config 验证。

## `pipeline-v1` 安全边界

- `contributes.actions` 每项只含 `{ actionId, path }`，最多 32 项；actionId 必须位于插件小写命名空间。
- action spec 使用独立 `useful.plugin-action.v1`；作者不能声明 `source`、`version`、`handler`、权限或行为。
- runtime 从已验证 sidecar/manifest 派生 publisher、插件版本、`source.kind=plugin` 与固定 pure/只读行为。
- `source.digest` 是完整作者 action spec 的 canonical JSON SHA-256：对象键递归排序、数组顺序保留、UTF-8
  编码；artifact SHA-256 仍由 sidecar 与 config pin 独立覆盖。
- 默认 registry 的 36 个内建 Action 不会扩大第三方 pipeline 能力；pipeline 最多 16 步，
  仍只能组合固定 JSON/Base64/Hash 三项内建 primitive。模板只支持 JSON 常量与
  `{ "$ref": "/input/..." }` / `{ "$ref": "/steps/<已完成 id>/output/..." }`。
- 不支持表达式、字符串插值、动态 action ID、插件互调、前向/循环引用、文件、网络、进程、环境变量或
  任何插件提供的代码。模板/展开/中间值都有固定 bytes、depth、node 上限并传播取消信号。

## doctor 与打包安全边界

doctor 是只读检查，覆盖 Node/CLI 版本、manifest 解析与 Schema、web/worker entry 及已声明 icon
的根内普通文件约束、launcher 的宿主解析声明及 `process.launch.declared` 权限、权限/平台/
minHostVersion（legacy 缺省值显示为 warning）、symlink/junction、`.git`、`node_modules`、`dist-useful`、
嵌套 `.useful`、`.env`、私钥内容以及 4096 entries、单文件 64 MiB、总展开 256 MiB 预算。
pack 会复用同一硬门，并额外拒绝超过 128 MiB 的压缩产物和覆盖已有产物。源码、README、
LICENSE、`.env.example`、公开证书等正常文件不会因宽泛的文件名字符串规则被误杀。

常见修复：

- `TARGET_EXISTS` / `ARTIFACT_EXISTS`：选用新的空目录或新的输出目录；不要删除证据或 force。
- `INVALID_TOOL_ID`：使用小写反向域名 ID，例如 `com.example.agent-tool`。
- `DOCTOR_FAILED`：逐项读取失败 check 的 `details` 与 `remediation`，移除链接/秘密/禁止目录或修复路径。
- `VALIDATION_FAILED`：修复 manifest 的 ID、semver、权限、平台、minHostVersion、entry/icon。
- `PACK_PREFLIGHT_FAILED`：pack 未写产物；修复全部 doctor 硬失败后再打包。
- `PUBLISHER_IO_OR_SECURITY`：确认 `.useful`、私钥与 sidecar 路径正确；不要在 HANDOFF 中粘贴私钥内容。

## 最终 HANDOFF

Agent 最终只交付：

1. `.useful` 的本地路径、字节数、entry 数和 SHA-256；
2. `.publisher-signature.json` sidecar 的本地路径；
3. verify 的 `valid: true`、tool ID、版本与 publisher key ID；
4. 一段简短 HANDOFF，分为 implemented、verified、unexecuted、blockers、next steps；
5. 明确说明私钥、`.env`、token 未提交，未自动上传或发布。
