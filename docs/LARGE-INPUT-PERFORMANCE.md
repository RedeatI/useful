# 大输入性能

## 性能策略

| 输入大小 | 策略 | 阈值 |
|----------|------|------|
| 小输入 (< 100KB) | 主线程同步 | 阻塞 < 50ms |
| 中型输入 (100KB-1MB) | 主线程同步 | 阻塞 < 200ms |
| 大型输入 (1MB-10MB) | 可用 Worker | 阻塞 < 500ms |
| 超大输入 (> 10MB) | 提示使用文件模式 | 不加载到内存 |

## Worker 架构

### 正则测试器 Worker
- 文件：`src/lib/tools/regexWorker.ts`
- 超时：可配置（默认 3000ms）
- 取消：`cancel()` 终止 Worker
- 重建：超时后自动重建新 Worker
- 限制：5MB 文本、10K 正则、100K 匹配数

### 文件哈希 Worker
- 文件：`src/lib/tools/fileHashWorker.ts`
- 分块：4MB 读取
- 进度：实时报告
- 取消：`Worker.terminate()`
- 限制：500MB 上限

### 通用文本 Worker
- 文件：`src/lib/tools/textWorker.ts`
- 支持：base64/url/json 操作
- 用于 1MB+ 输入场景

## 测试覆盖

### 大输入测试 (`src/lib/tools/large-input.spec.ts`)
- 1MB Base64 编解码
- 1MB URL 编解码
- 1MB JSON 格式化
- 1MB SHA-256 哈希
- 10MB Base64 编解码往返
- 10MB URL 编解码往返
- 10MB SHA-256 哈希
- 10MB Unicode 处理
- 空输入不崩溃

### Benchmark (`bench/large-input.perf.spec.ts`)
- 1KB/1MB 输入性能基准
- Base64/URL/SHA-256/JSON 操作

## 工具切换时取消

工具组件 `onUnmounted` 中：
- 正则 Worker：`cancel()` 终止
- 文件哈希 Worker：`terminate()` 终止
- 密码生成器：清除结果
- JWT 解码器：清除 token

## 防止内存增长

- 输出过大时使用分页或文件保存
- 防止重复复制超大字符串
- 不因输入错误造成无限循环或内存持续增长
