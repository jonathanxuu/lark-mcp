# Counso Client ID → Lark Bot 映射

MCP 客户端的 `client_id` 直接使用 Lark/飞书的 `app_id`。服务端会结合 MCP URL 的平台路径查找对应 Bot：

```text
https://your-domain.example/lark/mcp    → platform=lark
https://your-domain.example/feishu/mcp  → platform=feishu
```

## 配置

通常不需要额外的 Client 映射文件。只要 `config/lark-bots.json` 中的 `app_id` 与 Counso 里填写的 OAuth Client ID 相同即可。

如果必须兼容旧的随机 Client ID 映射，可以复制 `config/lark-client-bot-map.example.json` 为服务器上的：

```text
config/lark-client-bot-map.json
```

填写旧 Client ID、Bot ID 和允许的回调地址：

```json
{
  "clients": {
    "counso-client-id": {
      "bot_id": "lark-bot",
      "redirect_uris": [
        "https://counso.example/oauth/callback"
      ]
    }
  }
}
```

Bot 的 `app_id`、`app_secret`、`tenant_key`、`output_folder_token` 和其他参数可以保存在服务器上的 `config/lark-bots.json`。`id` 和 `organization_id` 都不是必填项；通过管理接口添加 Bot 时，缺少 `id` 会自动生成随机十六进制 ID。可以复制 `config/lark-bots.example.json` 后修改，并将文件权限设为 `600`。Secret 不会返回给 MCP 客户端。

如果映射文件不在默认位置，可以设置：

```ini
LARK_CLIENT_BOT_MAP_PATH=/opt/lark-mcp/config/lark-client-bot-map.json
```

配置生效后，OAuth 请求会直接跳转到对应平台和 App ID 的 Lark/飞书 OAuth 页面；无法匹配的 Client ID 会直接返回 `invalid_client`，不会再展示组织或 Bot 选择页。
