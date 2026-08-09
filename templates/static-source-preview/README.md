# Useful 静态源模板（Developer Preview）

本目录不包含任何密钥。请在一个新的私有工作目录执行：

```powershell
useful source init . --id com.example.my-source --name "My Source" --operator "My Team"
useful source add-package . ..\my-tool\dist-useful\com.example.my-tool-1.0.0.useful
useful source publish .
useful source validate .
useful source export-static . .\public
useful source serve .\public --port 8787
```

只部署 `public/`；不要部署 `keys/`、`repository/` 或 `source-config.yaml`。公开导出目录可以独立
validate/serve。生产源必须使用 HTTPS、离线备份 root 私钥，并将在线 targets/snapshot/timestamp
密钥与 root 分离。
