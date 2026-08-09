# 插件自证 (.useful Dogfooding)

## 目标

用现有工具反向验证插件生态：将内置工具转换为真实 `.useful` 示例插件，验证完整生命周期。

## 代表性工具

| 工具 | 测试目标 |
|------|----------|
| Base64 | 纯 Web 工具（HTML+JS+CSS） |
| 文件哈希 | 文件权限和流式处理 |
| 正则测试器 | Worker 资源和 CSP |

## .useful 生命周期验证流程

```
useful create
→ 本地开发
→ dev host
→ manifest 校验
→ 打包 .useful
→ 生成发布者签名
→ 发布到静态源
→ 客户端添加源
→ 同步目录
→ 查看权限
→ 下载
→ TUF 验证
→ 发布者签名验证
→ SHA-256 验证
→ 安装
→ 运行
→ 创建快捷方式
→ 发布新版本
→ 更新
→ 回滚
→ 撤回
→ 卸载
```

## 当前状态

- `.useful` 打包/解包/manifest 校验：✅ Rust 测试覆盖
- 静态源示例：✅ `repositories/static-example/`
- 插件 SDK：✅ `packages/useful-sdk/`
- 插件 manifest：✅ `crates/useful-plugin/src/manifest.rs`
- 权限差异对话框：✅ `PermissionDiffDialog.vue`
- 插件桥接：✅ `pluginBridge.ts`
- 插件安装后自动进入命令面板和搜索：✅ (Rust 注册表 → 前端)
- 卸载后索引、收藏和快捷方式状态：✅ (失效记录保留)

## 待完成

- 将 Base64 工具打包为 `.useful` 示例插件并完整运行生命周期
- 需要 Docker 环境运行完整 E2E

## 权限要求

- 插件不能直接访问 `window.__TAURI__`
- 文件哈希插件只能访问用户主动选择的文件
- 权限新增时必须重新确认
- 撤回版本不允许新安装
- 已安装用户看到安全公告
