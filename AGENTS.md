# Useful 外部开发者 Agent 指引

本仓库欢迎任何厂商的开发 Agent。构建第三方 Useful 工具（兼容 useful CLI / .useful）时，以
[`docs/agent/BUILD-A-TOOL.md`](docs/agent/BUILD-A-TOOL.md) 为唯一流程事实源。

- 只使用文档中的非交互命令和 `--json` 结果；任一步非零立即停止。
- 默认选择零权限 `minimal-web`，仅在功能确实需要且模板明确允许时增加能力。
- 不跟随或打包 symlink/junction，不提交私钥、`.env`、token、签名秘密或生成产物。
- 不覆盖已有目录或产物，不使用隐式 force，不自动上传、发布或绕过 source/publisher 信任链。
- 修改必须限于任务授权范围；提交前运行相关测试、lint、typecheck 和 `git diff --check`。
- 未获明确授权时，不推送、不创建远端 Release、不运行网络发布命令、不修改生产服务。
