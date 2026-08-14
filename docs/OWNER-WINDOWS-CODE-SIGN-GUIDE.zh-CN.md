# Windows 代码签名证书：你怎么买、怎么交给仓库

更新根仪式和 GitHub 变量已经可以自动化完成。  
**Windows 安装包的 Authenticode 签名证书不能生成假的**，必须向证书颁发机构（CA）购买，并用你的公司/个人身份审核。

本页用中文逐步说明。

## 你现在卡在哪

运行：

```powershell
node scripts/check-owner-signing-gates.mjs --json
```

若看到：

- `updateTrustReady: true` → 更新根已就绪  
- `windowsSigningSecretsReady: false` → **还缺代码签名证书**  
- `signedBetaPublishReady: false` → 还不能跑「签名正式 beta」工作流  

## 需要买什么证书

购买 **代码签名证书（Code Signing）**，不是 SSL 网站证书。

| 类型 | 说明 | 建议 |
| --- | --- | --- |
| OV Code Signing | 验证组织身份 | 个人开发者可用部分 CA 的个人代码签名 |
| EV Code Signing | 扩展验证，SmartScreen 信誉更好 | 公司正式发布更推荐 |

常见购买处（自行比价、选可出 PFX/USB 的）：

- DigiCert  
- Sectigo  
- GlobalSign  
- SSL.com  

审核通常要：

- 身份证明（护照/身份证）或公司营业执照  
- 电话/域名/地址核实  
- 几天到两周  

交付物常见两种：

1. **PFX / P12 文件** + 密码（最适合本仓库 GitHub Actions）  
2. **硬件 USB token**（EV 常见）—— 不能直接塞进 GitHub Secrets，需要自托管 runner 或云 HSM，本仓库默认 workflow **期望 PFX 进 Secrets**

若 CA 只给 token，需要额外改造 CI 或在本地签名后上传，那是另一条路。

## 买到 PFX 之后：上传到 GitHub（推荐脚本）

1. 把 PFX 放到**不在 git 仓库内**的目录，例如：  
   `D:\_agents\secure\useful-codesign.pfx`
2. 在仓库根目录执行：

```powershell
cd <useful-repo>
gh auth status
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\upload-windows-code-sign-secrets.ps1 `
  -PfxPath D:\_agents\secure\useful-codesign.pfx `
  -Repo RedeatI/useful
```

3. 按提示输入 PFX 密码（不会显示）。  
4. 脚本会设置：

- `WINDOWS_CERTIFICATE_BASE64`  
- `WINDOWS_CERTIFICATE_PASSWORD`  

5. 再检查：

```powershell
node scripts/check-owner-signing-gates.mjs --json
```

期望：

```text
windowsSigningSecretsReady: true
signedBetaPublishReady: true   # 在更新根变量也已就绪时
```

## 没有脚本时的手动上传

1. 生成 Base64（PowerShell）：

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("D:\secure\useful-codesign.pfx")) | Set-Clipboard
```

2. 打开：  
   https://github.com/RedeatI/useful/settings/secrets/actions  
3. 新建 Secret：  
   - 名称 `WINDOWS_CERTIFICATE_BASE64`，值粘贴 Base64  
   - 名称 `WINDOWS_CERTIFICATE_PASSWORD`，值填 PFX 密码  

## 还没买证书时：你可以先做什么

已经完成的：

- 生产更新根仪式（私钥在本机安全目录，不在 git）  
- GitHub 变量：`USEFUL_UPDATE_ROOT_PUBKEY_HEX` / feed / ceremony  
- 未签名预览包：[`v0.1.0-beta.11`](https://github.com/RedeatI/useful/releases/tag/v0.1.0-beta.11)

你可以：

1. 继续用未签名 MSI/portable 做功能测试  
2. 去 CA 下单代码签名证书  
3. 证书到手后只跑上面的上传脚本  

**不要**用自签名证书冒充生产签名并设 `USEFUL_SIGNING_READY=true`。

## 证书到手且 secrets 就绪后：怎么发签名 beta

1. 冻结提交并打 tag（版本与 `package.json` 通道规则一致）  
2. GitHub Actions → **Useful Release**  
3. 选择 **tag** 运行  
4. channel = `beta`  
5. publish = `true`  
6. 下载产物里的 `SIGNING-STATUS.json`，确认 Windows 签名为 verified  

详细命令见 [OWNER-SIGNING-GATE-CHECKLIST.md](OWNER-SIGNING-GATE-CHECKLIST.md)。

## 私钥与安全

| 可以放 GitHub | 绝不能放 GitHub |
| --- | --- |
| PFX 的 base64（Actions **Secret**） | 明文贴在 Issue/聊天 |
| 更新根的 **公钥** / 公开 root.json | 更新根 **私钥** `*.private.pem` |
| | 证书密码写进仓库文件 |

更新根私钥当前在本机（若由助手生成本地仪式）：  
`D:\_agents\secure\useful-production-update-root\keys\`  

请你立刻：

1. 备份该目录到加密盘/离线介质  
2. 限制该文件夹 ACL  
3. 不要提交到任何 git remote  

## 需要帮忙时

你可以把 **「我已有 PFX，路径是 …」** 告诉助手（不要发密码）。  
助手可以代跑上传脚本（仍会让你在本机输入密码）。  

没有 PFX 时，助手无法替你完成签名正式版。  
