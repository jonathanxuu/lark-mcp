export function createOAuthRoutes({
  crypto,
  req,
  res,
  requestUrl,
  mcpAccessTokens,
  mcpAuthorizationCodes,
  oauthStates,
  userConnections,
  getBot,
  publicBot,
  resolveClientConfig,
  platform = "",
  createOAuthUrl,
  exchangeAuthorizationCode,
  getLarkUserInfo,
  json,
  parseFormBody,
  readRequestBody,
  redirect,
  randomToken,
  pkceChallenge,
}) {
  return async function handleOAuthRoutes() {

    if (requestUrl.pathname === "/oauth/authorize") {
      const clientId = requestUrl.searchParams.get("client_id") ?? "";
      const mappedClient = resolveClientConfig(clientId, platform);
      const redirectUri = requestUrl.searchParams.get("redirect_uri") ?? "";
      const codeChallenge = requestUrl.searchParams.get("code_challenge") ?? "";
      const registeredRedirectUris = mappedClient?.redirectUris ?? [];
      const redirectAllowed = registeredRedirectUris.includes(redirectUri) || (mappedClient && registeredRedirectUris.length === 0);
      console.log(`[OAuth] authorize platform=${platform} client_id=${clientId} mapped=${Boolean(mappedClient)} redirect_allowed=${Boolean(redirectAllowed)}`);
      if (!mappedClient || !redirectAllowed || requestUrl.searchParams.get("response_type") !== "code" || requestUrl.searchParams.get("code_challenge_method") !== "S256" || !codeChallenge) {
        json(res, 400, { error: "invalid_client", error_description: "Client ID must match a configured Lark or Feishu Bot app_id and use an allowed redirect URI" });
        return true;
      }
      const mappedBot = getBot(mappedClient.botId);
      if (platform && (mappedBot.platform ?? "lark") !== platform) {
        json(res, 400, { error: "invalid_client", error_description: "Client ID does not belong to this MCP platform" });
        return true;
      }
      const state = crypto.randomBytes(24).toString("hex");
      oauthStates.set(state, {
        userId: "",
        mcp: { clientId, redirectUri, codeChallenge, state: requestUrl.searchParams.get("state") ?? "" },
        botId: mappedBot.id,
        stage: "bot",
        expectedTenantKey: mappedBot.tenantKey || "",
        createdAt: Date.now(),
      });
      redirect(res, createOAuthUrl({ state, botId: mappedBot.id }));
      return true;
    }

    if (requestUrl.pathname === "/oauth/token" && req.method === "POST") {
      try {
        const body = parseFormBody(req, await readRequestBody(req));
        console.log(`[OAuth] token grant=${body.grant_type ?? "authorization_code"} client_id=${body.client_id ?? ""}`);
        if (body.grant_type === "refresh_token") {
          const refresh = mcpAccessTokens.get(body.refresh_token);
          if (!refresh || refresh.refresh !== true) throw new Error("Invalid refresh token");
          const accessToken = randomToken();
          mcpAccessTokens.set(accessToken, { connectionId: refresh.connectionId, clientId: refresh.clientId, expiresAt: Date.now() + 3600 * 1000 });
          json(res, 200, { access_token: accessToken, token_type: "Bearer", expires_in: 3600 });
          return true;
        }
        const authorizationCode = mcpAuthorizationCodes.get(body.code);
        if (!authorizationCode || authorizationCode.expiresAt < Date.now() || authorizationCode.clientId !== body.client_id || authorizationCode.redirectUri !== body.redirect_uri || pkceChallenge(body.code_verifier ?? "") !== authorizationCode.codeChallenge) {
          json(res, 400, { error: "invalid_grant", error_description: "Invalid authorization code or PKCE verifier" });
          return true;
        }
        mcpAuthorizationCodes.delete(body.code);
        const accessToken = randomToken();
        const refreshToken = randomToken();
        const token = { connectionId: authorizationCode.connectionId, clientId: authorizationCode.clientId, expiresAt: Date.now() + 3600 * 1000 };
        mcpAccessTokens.set(accessToken, token);
        mcpAccessTokens.set(refreshToken, { ...token, refresh: true });
        json(res, 200, { access_token: accessToken, token_type: "Bearer", expires_in: 3600, refresh_token: refreshToken });
      } catch (error) {
        json(res, 400, { error: "invalid_request", error_description: error.message });
      }
      return true;
    }


    if (requestUrl.pathname === "/oauth/lark/callback" || requestUrl.pathname === "/oauth/feishu/callback") {
      const state = requestUrl.searchParams.get("state") ?? "";
      const pending = oauthStates.get(state);
      oauthStates.delete(state);
      if (!pending || Date.now() - pending.createdAt > 10 * 60 * 1000) {
        json(res, 400, { ok: false, error: "Invalid or expired OAuth state" });
        return true;
      }
      if (requestUrl.searchParams.get("error")) {
        json(res, 400, { ok: false, error: requestUrl.searchParams.get("error_description") ?? requestUrl.searchParams.get("error") });
        return true;
      }
      try {
        const oauthBot = getBot(pending.botId ?? "");
        const tokenBody = await exchangeAuthorizationCode(requestUrl.searchParams.get("code") ?? "", oauthBot);
        const token = tokenBody.data ?? tokenBody;
        const user = await getLarkUserInfo(token.access_token, oauthBot);
        const userTenantKey = user.tenant_key ?? user.tenantKey ?? token.tenant_key ?? tokenBody.tenant_key ?? "";
        if (pending.expectedTenantKey && userTenantKey && pending.expectedTenantKey !== userTenantKey) throw new Error("The Lark user is not a member of the selected organization");
        const connectionId = crypto.randomUUID();
        userConnections.set(connectionId, {
          accessToken: token.access_token,
          refreshToken: token.refresh_token,
          expiresAt: Date.now() + Math.max(60, (token.expires_in ?? 7200) - 300) * 1000,
          refreshExpiresAt: Date.now() + Math.max(60, (token.refresh_expires_in ?? 2592000) - 300) * 1000,
          userId: pending.userId,
          user,
          tenantKey: userTenantKey || pending.expectedTenantKey || oauthBot.tenantKey || "",
          oauthBotId: oauthBot.id,
          selectedBotId: oauthBot.id,
        });
        console.log(`[OAuth] connection created bot=${oauthBot.id} connection=${connectionId}`);
        if (pending.mcp) {
          const code = randomToken();
          mcpAuthorizationCodes.set(code, { connectionId, clientId: pending.mcp.clientId, redirectUri: pending.mcp.redirectUri, codeChallenge: pending.mcp.codeChallenge, expiresAt: Date.now() + 5 * 60 * 1000 });
          const callback = new URL(pending.mcp.redirectUri);
          callback.searchParams.set("code", code);
          callback.searchParams.set("state", pending.mcp.state);
          redirect(res, callback.toString());
        } else {
          json(res, 200, { ok: true, connection_id: connectionId, user: { name: user.name, open_id: user.open_id, user_id: user.user_id }, selected_bot: publicBot(oauthBot), expires_in: token.expires_in, message: "Lark 已连接。后续可先列出并选择可用 Bot，再使用文档工具。" });
        }
      } catch (error) {
        json(res, 502, { ok: false, error: error.message });
      }
      return true;
    }

    return false;
  };
}
