# 实用工具安全

## 敏感工具安全策略

### 密码生成器

| 要求 | 状态 | 实现 |
|------|------|------|
| 使用 CSPRNG | ✅ | `crypto.getRandomValues()` |
| 禁止 `Math.random()` | ✅ | 全局搜索确认无 |
| 支持字符类别 | ✅ | lower/upper/digits/symbols |
| 排除易混淆字符 | ✅ | `excludeAmbiguous` 选项 |
| 长度限制 | ✅ | 4-256 |
| 显示近似熵 | ✅ | `estimateEntropy()` |
| 不宣称绝对安全 | ✅ | "熵值为近似估算，不代表绝对安全" |
| 不保存生成结果 | ✅ | 不写入数据库 |
| 不进入最近输入 | ✅ | `sensitiveInput: true` 标记 |
| 不写日志 | ✅ | 无 console/日志调用 |
| 不进入崩溃报告 | ✅ | 无外发 |
| 离开页面清除 | ✅ | `onUnmounted(() => password.value = "")` |

### JWT 解码器

| 要求 | 状态 | 实现 |
|------|------|------|
| 显著非验证警告 | ✅ | 红色边框警告框 |
| 仅解析 Header/Payload | ✅ | `jwtDecode()` 只解码 |
| 不执行内容 | ✅ | 纯 JSON.parse，无 eval |
| 不使用 v-html | ✅ | 纯 `<pre>` 文本渲染 |
| 防止非法 Base64URL | ✅ | try/catch |
| 防止超大 Token | ✅ | 100KB 上限 |
| 不进入日志/遥测 | ✅ | `sensitiveInput: true` |
| 不自动发请求 | ✅ | 无 fetch/XHR |
| 过期时间仅解释 | ✅ | "仅字段解释，非验证结果" |
| 清除敏感按钮 | ✅ | "清除敏感内容" 按钮 |
| 离开页面清除 | ✅ | `onUnmounted` |

### 正则测试器（ReDoS 防护）

| 要求 | 状态 | 实现 |
|------|------|------|
| 正则执行移入 Worker | ✅ | `regexWorker.ts` |
| 可配置超时 | ✅ | 默认 3000ms，可调 500-30000 |
| 支持取消 | ✅ | `cancel()` 终止 Worker |
| 输入大小限制 | ✅ | 5MB 文本，10K 正则 |
| 超时提示 ReDoS | ✅ | "可能存在高复杂度表达式" |
| Worker 超时终止 | ✅ | `self.close()` |
| 不创建无限 Worker | ✅ | 复用 + 终止后重建 |
| 主线程保持响应 | ✅ | Worker 隔离 |

### 哈希工具

| 要求 | 状态 | 实现 |
|------|------|------|
| 区分文本/文件哈希 | ✅ | 双模式切换 |
| 流式文件读取 | ✅ | 4MB 分块读取 |
| 不加载完整大文件到内存 | ⚠️ | 当前有 500MB 上限 |
| 支持进度 | ✅ | 进度条 |
| 支持取消 | ✅ | Worker.terminate() |
| 拖入多个文件 | ✅ | drag-and-drop |
| SHA-1 安全标注 | ✅ | "不适用于安全用途" |
| 文件内容不离开本机 | ✅ | 纯 Web Crypto |
| 摘要校验 | ✅ | 比对功能 |

## 网络隔离测试

`src/lib/tools/network-isolation.spec.ts` 验证：
- Base64/URL/JSON/Hash/Password/JWT/Case/BaseConvert 操作不触发 fetch/XHR
- 密码生成器不写入 console

## CSP 与隐私

- 所有实用工具纯前端运行
- 无第三方脚本加载
- 无远程字体或追踪像素
- 用户输入不发送到网络
- UI 显示"本工具在本地处理数据，不会上传输入内容"
