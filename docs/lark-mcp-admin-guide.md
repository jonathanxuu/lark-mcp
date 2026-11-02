# Lark / 飞书 MCP 管理员指南

## 工作方式

用户在 Counso 中添加公开 MCP 时，不需要知道任何 `app_id` 或 `app_secret`。

连接流程如下：

1. MCP 先让用户选择平台：Lark 或飞书，再展示该平台的组织列表。
2. 用户选择组织并开始该组织的身份验证。
3. MCP 使用该组织的 bootstrap Bot 发起对应平台的 OAuth。
4. 回调后读取 `user_info.tenant_key`，确认用户确实属于所选组织。
5. 用户选择该组织的目标 Bot。
6. 如果目标 Bot 不是 bootstrap Bot，MCP 再发起一次 OAuth。
7. OAuth 完成后，MCP 连接绑定到这个 Bot。

一个组织可以登记多个 Bot。例如：

```text
公司 A
├── 财务 Bot（bootstrap）
├── 人事 Bot
└── 项目 Bot
```

用户第一次选择公司 A 时，先使用“财务 Bot”完成组织确认。随后页面会展示财务、人事、项目三个 Bot：

- 选择财务 Bot：直接复用刚完成的 OAuth；
- 选择人事或项目 Bot：针对对应的独立 App 再完成一次 OAuth。

每个组织必须配置且只能配置一个 `bootstrap: true` 的 Bot。重新登记另一个 Bot 为 bootstrap 时，服务会自动取消该组织原来的 bootstrap 标记。

Lark/飞书应用的 `app_secret` 永远不会返回给用户，也不会返回给 MCP 客户端。

## 首次部署配置

`.env` 至少需要配置：

```env
# Optional legacy single-Bot fallback. Not needed when all Bots are managed below.
# LARK_APP_ID=cli_legacy_default_app_id
# LARK_APP_SECRET=legacy_default_app_secret
LARK_BOT_STORE_PATH=./data/lark-bots.enc.json
LARK_BOT_STORE_KEY=一段长期保存的随机密钥
LARK_ADMIN_TOKEN=管理员接口令牌
```

`LARK_APP_ID` 和 `LARK_APP_SECRET` 仅用于兼容旧的单 Bot 配置。多组织部署可以完全不设置它们；所有 Bot 通过下面的管理接口登记。每个组织至少登记一个 Bot，并将其中一个标记为 `bootstrap: true`。

`LARK_BOT_STORE_KEY` 是 Bot Secret 的加密主密钥。它不是某个 Bot 的凭证，但必须在部署升级和重启时保持不变。生产环境建议放在 Secret Manager 或 KMS 中，不要提交到 Git。

## 登记一个 Bot

组织管理员先在 Lark 或飞书开放平台准备好 Bot 的 `app_id` 和 `app_secret`，然后由 MCP 管理员调用：

```bash
curl -X POST http://localhost:4020/admin/lark-bots \
  -H 'Authorization: Bearer <LARK_ADMIN_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "finance-bot",
    "platform": "lark",
    "name": "财务 Bot",
    "organization_id": "company-a",
    "organization_name": "公司 A",
    "tenant_key": "tenant_xxx",
    "bootstrap": true,
    "app_id": "cli_finance_xxx",
    "app_secret": "finance_app_secret",
    "description": "财务文档助手"
  }'
```

成功后，服务会把 Secret 加密写入 `LARK_BOT_STORE_PATH`，并立即刷新运行中的 Bot 注册表，不需要重启 MCP。

查看已经登记的 Bot：

```bash
curl http://localhost:4020/admin/lark-bots \
  -H 'Authorization: Bearer <LARK_ADMIN_TOKEN>'
```

响应只包含 Bot 名称、ID、平台和 App ID，不包含 App Secret。

## 删除一个动态 Bot

```bash
curl -X DELETE http://localhost:4020/admin/lark-bots/finance-bot \
  -H 'Authorization: Bearer <LARK_ADMIN_TOKEN>'
```

环境变量中配置的旧版 Bot 不能通过管理 API 删除；需要修改环境配置后重启。建议新 Bot 全部使用管理 API 登记。

## 用户看不到某个组织或 Bot 时检查什么

用户选择页面展示的是 MCP 管理员登记的组织和 Bot 列表。请检查：

1. 组织是否登记了至少一个 Bot；
2. 是否有一个 Bot 设置为 `bootstrap: true`；
3. `tenant_key` 是否填写正确；
4. Bot App 是否已经安装到对应组织；
5. 当前用户是否在该 App 的可用范围内；
6. Bot App 的 OAuth 回调地址是否与 MCP 的回调地址一致；
7. Bot App 是否已经发布并启用所需权限。

如果 OAuth 后提示组织不匹配，通常是 `tenant_key` 登记错误，或用户不属于所选组织。

## Secret 轮换

重新调用同一个 `id` 的 POST 接口即可覆盖旧 Secret：

```bash
curl -X POST http://localhost:4020/admin/lark-bots \
  -H 'Authorization: Bearer <LARK_ADMIN_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "finance-bot",
    "name": "财务 Bot",
    "organization_id": "company-a",
    "organization_name": "公司 A",
    "tenant_key": "tenant_xxx",
    "bootstrap": true,
    "app_id": "cli_finance_xxx",
    "app_secret": "new_finance_app_secret"
  }'
```

新请求会使用新 Secret；已经签发的 Lark token 会在过期或刷新失败后重新获取。

## 安全注意事项

- `/admin/lark-bots` 必须只通过 HTTPS 和受控网络访问。
- `LARK_ADMIN_TOKEN` 不要与 `LARK_BOT_STORE_KEY` 使用同一个值。
- `data/lark-bots.enc.json` 需要限制为服务进程可读写，并加入备份策略。
- 不要把请求体、App Secret、refresh token 写入日志。
- 当前连接和 OAuth 状态仍是进程内存数据；如果需要生产级重启恢复，应继续把这些数据迁移到加密数据库或 Redis。
