# 工具 Actions

默认内建注册表共有 36 个 AI-callable Action：下面 31 个 Utility Action，加上 5 个 Office action family。
这个数字不包含 MCP 的 4 个 helper，也不包含必须显式加载配置的可选 native host pack。默认 MCP
`tools/list` 因此共有 40 项。

## Action ID 规范

### 格式

```
<parent>.<short_id>
```

### 示例

```
builtin.utilities.base64
builtin.office.docx
builtin.office.spreadsheet
com.example.tool.convert
```

## 31 个 Utility Actions

| Action ID | 短 ID | 路由 | 关键词 | 别名 |
|-----------|-------|------|--------|------|
| builtin.utilities.json | json | /tools/utilities/json | json,格式化,美化 | pretty,beautify,minify |
| builtin.utilities.base64 | base64 | /tools/utilities/base64 | base64,编码,解码 | b64,atob,btoa |
| builtin.utilities.url | url | /tools/utilities/url | url,编码,解码 | - |
| builtin.utilities.hash | hash | /tools/utilities/hash | hash,哈希,sha | sha1,sha384,checksum |
| builtin.utilities.uuid | uuid | /tools/utilities/uuid | uuid,guid | v4,guid |
| builtin.utilities.password | password | /tools/utilities/password | password,密码 | pwd,pass,secret |
| builtin.utilities.timestamp | timestamp | /tools/utilities/timestamp | timestamp,时间戳 | epoch,date |
| builtin.utilities.base-convert | base-convert | /tools/utilities/base-convert | 进制,binary,hex | bin,oct,decimal |
| builtin.utilities.color | color | /tools/utilities/color | color,颜色,hex,rgb | colour,picker |
| builtin.utilities.case | case | /tools/utilities/case | case,命名,驼峰 | - |
| builtin.utilities.regex | regex | /tools/utilities/regex | regex,正则,匹配 | regular expression,pattern |
| builtin.utilities.jwt | jwt | /tools/utilities/jwt | jwt,token,解码 | json web token,bearer |
| builtin.utilities.html | html | /tools/utilities/html | html,实体,转义 | - |
| builtin.utilities.hex-text | hex-text | /tools/utilities/hex-text | hex,十六进制,文本 | - |
| builtin.utilities.morse | morse | /tools/utilities/morse | morse,摩尔斯,电码 | - |
| builtin.utilities.text-stats | text-stats | /tools/utilities/text-stats | 字数,统计,字符 | count,words |
| builtin.utilities.text-lines | text-lines | /tools/utilities/text-lines | 行,排序,去重 | sort,dedupe,lines |
| builtin.utilities.slug | slug | /tools/utilities/slug | slug,url,固定链接 | - |
| builtin.utilities.byte-size | byte-size | /tools/utilities/byte-size | 字节,byte,kb,mb | - |
| builtin.utilities.lorem | lorem | /tools/utilities/lorem | lorem,ipsum,占位 | placeholder |
| builtin.utilities.duration | duration | /tools/utilities/duration | 日期,间隔,duration | - |
| builtin.utilities.byte-unit | byte-unit | /tools/utilities/byte-unit | 单位,换算,长度 | unit,convert |
| builtin.utilities.number-format | number-format | /tools/utilities/number-format | 数字,千分位 | number,format |
| builtin.utilities.unicode | unicode | /tools/utilities/unicode | unicode,转义,码位 | - |
| builtin.utilities.caesar | caesar | /tools/utilities/caesar | 凯撒,caesar,rot13 | cipher |
| builtin.utilities.luhn | luhn | /tools/utilities/luhn | luhn,信用卡,银行卡 | card,credit card |
| builtin.utilities.contrast | contrast | /tools/utilities/contrast | 对比度,wcag | a11y |
| builtin.utilities.random-number | random-number | /tools/utilities/random-number | 随机,random | number |
| builtin.utilities.data-format | data-format | /tools/utilities/data-format | json,yaml,格式,转换 | json yaml,yaml json |
| builtin.utilities.text-diff | text-diff | /tools/utilities/text-diff | diff,文本,比较,差异 | compare,patch |
| builtin.utilities.ipv4 | ipv4 | /tools/utilities/ipv4 | ipv4,cidr,子网,地址 | subnet,network |

## 5 个 Office Actions

Office Action 将一组相关操作放在同一个稳定 ID 下，具体操作由严格校验的 `operation` 字段选择。

| Action ID | 支持的操作 | 主要输出 |
| --- | --- | --- |
| `builtin.office.docx` | `compose`、`extract`、`inspect`、`to-markdown`、`from-markdown` | DOCX Base64、结构化 blocks、Markdown 或摘要 |
| `builtin.office.pptx` | `compose`、`extract`、`inspect`、`to-markdown`、`from-markdown` | PPTX Base64、slides、Markdown 或摘要 |
| `builtin.office.spreadsheet` | `compose`、`extract`、`csv-parse`、`csv-stringify`、`csv-to-xlsx`、`xlsx-to-csv`、`inspect-xlsx`、`inspect-csv`、`to-markdown`、`from-markdown` | XLSX Base64、workbook/rows、CSV、Markdown 或摘要 |
| `builtin.office.pdf` | `merge`、`split`、`reorder`、`rotate`、`sanitize`、`inspect`、`extract-pages`、`delete-pages` | 一个或多个 PDF Base64；`inspect` 的 `pageDetails` 含逐页索引、点尺寸与旋转角度 |
| `builtin.office.markdown` | `parse`、`to-docx`、`to-pptx` | 大纲 blocks 或 DOCX/PPTX Base64 |

文件字节通过有大小上限的 strict canonical Base64 传入，不接受任意文件路径或 URL。Office handler 在
单次、可终止的 worker thread 中运行；二进制输出带 `sizeBytes` 与 SHA-256。OOXML 会先做 ZIP 路径、
重复 entry、数量、展开量、压缩比和单 part 大小预检。宏、公式、嵌入脚本与外部 relationship 不会被执行；
公式只作为数据返回，CSV 默认转义公式型内容。

这些能力面向简单、结构化的本地转换，不承诺 Microsoft Office 的完整排版、动画、图表、批注、修订或
数字签名兼容性。详细文件与隐私限制见 [已知限制](KNOWN-LIMITATIONS.md)。

PDF `sanitize` 会删除完整 trailer `Info`、持久化 `ID`、Catalog/Page 的 XMP `Metadata` 和已知主动内容
入口，然后把清理后的页面图再复制到第二份 PDF，避免第一遍已脱离的对象继续被序列化。它不做内容流
语义审计，因此不能替代恶意文档分析、电子签名验证或敏感信息擦除工具。

PDF `inspect` 的 `pageDetails` 为每页返回零基 `index`、`widthPoints`、`heightPoints` 与
`rotationDegrees`。这些字段描述解析到的页面几何，不证明渲染保真、内容安全或敏感信息已经删除。

## CLI/MCP 发现

源码工作树可直接查询当前 registry/profile 实际暴露的 Action：

```powershell
node packages/useful-runtime/bin/useful-runtime.mjs actions search --query office --category office --json
node packages/useful-runtime/bin/useful-runtime.mjs actions describe builtin.office.pptx --json
```

`actions search` 还支持来源、分类、执行模式、只读/idempotent 过滤，稳定排序与 cursor 分页。没有 profile
时，`actions list` 使用稳定 actionId 顺序；使用 profile 时，CLI list 与 MCP 注册顺序保留 profile 中的 Action
数组顺序。search 的 relevance/actionId/title/category 显式排序独立于 list 顺序。MCP 提供同一
语义的 `useful.actions.search`、`useful.actions.describe`、`useful.actions.suggest` 和
`useful.actions.recipe`；它们只看当前 profile 暴露的集合，不绕过 allowlist。这 4 个 helper 不属于
`BUILTIN_ACTIONS`，因此不计入 36；默认 MCP `tools/list` 共 40 项。

上述 4 个 helper 同时是全局保留名。插件不得把它们声明为 actionId 或 alias，也不能通过 profile 把它们
重定向到插件 handler。

### 智能推荐

`actions suggest --input @file|- --limit <1..20> --json` 对调用方显式提供的文本做本地、确定性的内容识别。
输入最多 64 KiB，只在本地内存中处理；不会自动读取剪贴板、文件或其他应用状态，也不会把样本复制到
结果或错误中。候选集合在评分前就受当前 profile 过滤；同分项按 canonical `actionId` 确定性排序。

### Action recipe

`actions recipe --input @recipe.json [--validate-only] --output json` 接受
`useful.action-recipe.v1`。recipe 最多 16 个有序步骤，只能调用当前 profile 已暴露且同时满足只读、非破坏、
幂等、closed-world、无需确认、零权限、零 capability、零副作用的 canonical Action；alias 和动态 Action ID
都不接受。

步骤输入与最终输出由 JSON 常量和 exact `$ref` 对象组成。引用只允许指向 `/input/...` 或
`/steps/<已完成步骤>/output/...`，因此前向引用、自引用、插值、表达式、脚本、文件、网络和进程入口都会
fail closed。整个 recipe 请求最多 1 MiB，累计中间值最多 8 MiB，整条最多运行 60 秒且每一步仍受自己的
descriptor timeout；实际运行结果保留最终 output 与每一步的脱敏 execution receipt。可复制示例见
[`examples/action-recipes/`](../examples/action-recipes/README.md)。

## 可选 native host pack

`@useful/host-actions` 额外提供 4 个显式选择加入的 Action：

- `builtin.video-trim.probe`
- `builtin.video-trim.export`
- `builtin.process-monitor.snapshot`
- `builtin.process-monitor.terminate`

它们不在默认 36 个 Action 中。源码入口只有收到经过闭集校验的 `useful.host-actions.v1` 文件后才会注册：

```powershell
node packages/useful-runtime/bin/useful-runtime.mjs --host-config C:\ABSOLUTE\host-actions.json actions list --json
node packages/useful-mcp/bin/useful-mcp.mjs --host-config C:\ABSOLUTE\host-actions.json
```

配置格式和允许目录见 [`packages/host-actions/README.md`](../packages/host-actions/README.md)。CLI 只从本次实际
加载的 entry 派生权限/capability，导出与终止还要求当前 `actions run` 带 `--confirm`。MCP 二进制只为已加载且
严格只读、非破坏、无需确认的 entry 派生授权，永不设置 confirmation；因此破坏性 Action 即使被发现也会
fail closed。源码接线不等于已发布二进制、真实 ffmpeg/ffprobe 或跨平台验证。

## 稳定性保证

1. **Action ID 不可随意修改**：修改显示名称不能破坏收藏、最近记录和快捷方式
2. **修改显示名称安全**：收藏和最近使用以 ID 为键，与显示名无关
3. **插件 action 与内置 action 使用同一执行抽象**：公开 AI 契约以 `ActionDescriptor` 为准；GUI 工具元数据
   与它关联，但不是可互换的权限声明
4. **未知 action ID 有安全错误页**：不崩溃，显示提示
