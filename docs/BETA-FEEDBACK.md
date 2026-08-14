# Beta 反馈与诊断

设置页的“Beta 反馈与诊断”用于先在本地预览、再由用户决定是否分享诊断信息。当前公开版本是
[`v0.1.0-beta.10`](https://github.com/RedeatI/useful/releases/tag/v0.1.0-beta.10)，客户端不会自动上传
反馈或诊断包。

1. 点击“预览诊断包内容”，逐项检查将要导出的文件与摘要。
2. 将 `useful-beta-feedback.zip` 导出到用户选择的本地路径。
3. 填写包内 `beta-feedback-template.md`，删除与问题无关的内容。
4. 提交前再次人工预览压缩包，确认不包含个人文件、凭据或不希望公开的信息。
5. 只有在下述渠道由所有者完成配置后，才把反馈包交给相应接收方。

## 反馈渠道

- **不含敏感信息：** 使用 [`RedeatI/useful` issue tracker](https://github.com/RedeatI/useful/issues)。
  公开 issue 会被所有人看到；请只提供复现所需的最少信息。
- **可能含敏感信息或安全问题：** 使用 [`SECURITY.md`](../SECURITY.md) 指定的
  [GitHub Private Vulnerability Reporting](https://github.com/RedeatI/useful/security/advisories/new)。
  不要把敏感诊断包附到公开 issue、讨论区或其他公共位置。

诊断包默认只保存到本地，不自动上传。它可以包含运行摘要、脱敏日志和反馈模板，但不应包含用户文件
内容、Token、JWT、密码、私钥或签名秘密。自动脱敏不能代替提交前的人工检查。
