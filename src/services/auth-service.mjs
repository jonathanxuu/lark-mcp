export function createAuthService({ botRegistry, getBot, getConnectionBot, getProvider, userConnections, appAccessTokenCache, tenantAccessTokenCache, fetchWithRetry, parseJson }) {
  function getConnection(connectionId = "") {
    if (!connectionId) throw new Error("Lark OAuth connection_id is required; connect Lark before using this tool");
    const connection = userConnections.get(connectionId);
    if (!connection) throw new Error("Lark member OAuth connection not found; connect Lark before using this tool");
    return connection;
  }
  async function getAppAccessToken(bot = botRegistry[0]) {
    const provider = getProvider(bot.platform ?? "lark");
    const key = `${provider.id}:${bot.id}`;
    const cached = appAccessTokenCache.get(key);
    if (cached?.value && Date.now() < cached.expiresAt) return cached.value;
    const response = await fetchWithRetry(`${provider.apiBaseUrl}/open-apis/auth/v3/app_access_token/internal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ app_id: bot.appId, app_secret: bot.appSecret }) }, `${provider.label} app_access_token`);
    const body = await parseJson(response, `app_access_token for Bot ${bot.id} (app_id ${bot.appId})`);
    appAccessTokenCache.set(key, { value: body.app_access_token, expiresAt: Date.now() + Math.max(60, body.expire - 300) * 1000 });
    return body.app_access_token;
  }
  async function getTenantAccessToken(connectionId = "") {
    const connection = getConnection(connectionId);
    const bot = getConnectionBot(connectionId);
    const provider = getProvider(bot.platform ?? "lark");
    const tenantKey = connection.tenantKey || connection.user?.tenant_key || connection.user?.tenantKey || bot.tenantKey || "";
    const key = `${provider.id}:${bot.id}:${tenantKey || "default"}`;
    const cached = tenantAccessTokenCache.get(key);
    if (cached?.value && Date.now() < cached.expiresAt) return cached.value;
    const response = await fetchWithRetry(`${provider.apiBaseUrl}/open-apis/auth/v3/tenant_access_token/internal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ app_id: bot.appId, app_secret: bot.appSecret }) }, `${provider.label} tenant_access_token`);
    const body = await parseJson(response, `tenant_access_token for Bot ${bot.id}`);
    tenantAccessTokenCache.set(key, { value: body.tenant_access_token, expiresAt: Date.now() + Math.max(60, body.expire - 300) * 1000 });
    return body.tenant_access_token;
  }
  async function exchangeAuthorizationCode(code, bot = botRegistry[0]) {
    const provider = getProvider(bot.platform ?? "lark");
    const token = await getAppAccessToken(bot);
    const response = await fetchWithRetry(`${provider.apiBaseUrl}/open-apis/authen/v1/oidc/access_token`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify({ grant_type: "authorization_code", code }) }, `${provider.label} authorization code exchange`);
    return parseJson(response);
  }
  async function refreshUserAccessToken(connection) {
    const bot = getBot(connection.oauthBotId);
    const provider = getProvider(bot.platform ?? "lark");
    const token = await getAppAccessToken(bot);
    const response = await fetchWithRetry(`${provider.apiBaseUrl}/open-apis/authen/v1/oidc/refresh_access_token`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify({ grant_type: "refresh_token", refresh_token: connection.refreshToken }) }, `${provider.label} refresh access token`);
    const body = await parseJson(response); const data = body.data ?? body;
    connection.accessToken = data.access_token; connection.refreshToken = data.refresh_token ?? connection.refreshToken;
    connection.expiresAt = Date.now() + Math.max(60, (data.expires_in ?? 7200) - 300) * 1000;
    connection.refreshExpiresAt = Date.now() + Math.max(60, (data.refresh_expires_in ?? 2592000) - 300) * 1000;
    return connection.accessToken;
  }
  async function getAccessToken(connectionId = "", identity = "bot") {
    const connection = getConnection(connectionId);
    if (identity === "user") {
      if (connection.accessToken && Date.now() < connection.expiresAt) return connection.accessToken;
      if (!connection.refreshToken) throw new Error("Lark user OAuth refresh token is missing");
      const accessToken = await refreshUserAccessToken(connection);
      userConnections.set(connectionId, connection);
      return accessToken;
    }
    return getTenantAccessToken(connectionId);
  }
  async function getLarkUserInfo(accessToken, bot = botRegistry[0]) {
    const provider = getProvider(bot.platform ?? "lark");
    const response = await fetchWithRetry(`${provider.apiBaseUrl}/open-apis/authen/v1/user_info`, { headers: { Authorization: `Bearer ${accessToken}` } }, `${provider.label} user info`);
    const body = await parseJson(response); return body.data ?? body;
  }
  return { exchangeAuthorizationCode, getAccessToken, getAppAccessToken, getConnection, getLarkUserInfo, getTenantAccessToken, refreshUserAccessToken };
}
