# 自托管动态软件源（docker compose）

```
cd deploy/docker-compose
cp .env.example .env    # 修改 ADMIN_TOKEN / DOWNLOAD_TOKEN_SECRET
docker compose up -d
```

启动后：

1. **初始化源**：开发环境首次启动自动生成 TUF root 与在线密钥（keys 存 `/data/tuf-keys` 卷；
   生产环境必须离线生成 root 并预置 `metadata/1.root.json`，服务器拒绝代持 root 私钥）。
2. **创建发布者**（管理令牌）：当前用 SQL 或后续 source-admin 界面；最小命令示例：
   `docker compose exec postgres psql -U useful -d useful_source -c "INSERT INTO publishers (id, display_name) VALUES ('pub1','Me'); INSERT INTO publisher_keys (key_id, publisher_id, public_key) VALUES ('ed25519:<你的公钥hex>','pub1','<你的公钥hex>');"`
3. **上传工具**（三步，全部带 `X-Admin-Token`）：
   - `POST /v1/publisher/upload-sessions` `{publisherKeyId, sha256, size}`
   - `PUT  /v1/publisher/upload-sessions/{id}/content`（原始字节流，支持大文件流式）
   - `POST /v1/publisher/releases` `{uploadSessionId, toolId, name, version, channel, platform, arch, accessMode}`
4. **审核发布**：worker 扫描后 `POST /v1/publisher/releases/{id}/review {"decision":"approved"}`
   （开发默认 `AUTO_APPROVE=true` 自动完成）。
5. **在客户端添加源**：Useful「源中心」→ 开发者模式 → 添加
   `http://127.0.0.1:8080/.well-known/useful-repository.json` → 核对根指纹。

## 无支付 / 测试支付

- `BILLING_PROVIDER=disabled`（默认）：paidDownloads=false，不显示结账，免费源全部正常。
- `BILLING_PROVIDER=fake`：演示付费权益流程（webhook 签名 = HMAC-SHA256）。
  生产环境启用 fake 会在启动时被拒绝。

## S3 / MinIO

首版 compose 默认 filesystem 卷。接 S3 兼容存储时设：
`STORAGE_DRIVER=s3`、`S3_ENDPOINT/S3_REGION/S3_BUCKET/S3_ACCESS_KEY/S3_SECRET_KEY`
（S3 适配器代码位于 `services/internal/storage/`，MinIO 服务可自行加入 compose）。

## 反向代理示例（Caddy）

```
source.example.com {
    reverse_proxy source-server:8080
}
```

生产：`ENVIRONMENT=production` + HTTPS `BASE_URL` + 强随机令牌 + 离线 root。
