export function createOAuthRoutes({
  crypto,
  req,
  res,
  requestUrl,
  getBotRegistry,
  botSelectionStates,
  mcpAccessTokens,
  mcpAuthorizationCodes,
  mcpClients,
  oauthStates,
  organizationSelectionStates,
  userConnections,
  getBot,
  publicBot,
  organizationsFromRegistry,
  createOAuthUrl,
  exchangeAuthorizationCode,
  getLarkUserInfo,
  renderOrganizationSelectionPage,
  renderBotSelectionPage,
  json,
  parseFormBody,
  readRequestBody,
  redirect,
  randomToken,
  pkceChallenge,
}) {
  return async function handleOAuthRoutes() {
    if (requestUrl.pathname === "/oauth/lark/select" && req.method === "POST") {
      try {
        const body = parseFormBody(req, await readRequestBody(req));
        const selection = botSelectionStates.get(body.selection_token ?? "");
        const bot = getBot(body.bot_id ?? "");
        if (!selection || selection.expiresAt < Date.now()) throw new Error("Invalid or expired Bot selection");
        if (bot.organizationId !== selection.organization.id || bot.platform !== selection.organization.platform) {
          throw new Error("The selected Bot does not belong to the selected organization or platform");
        }
        botSelectionStates.delete(body.selection_token ?? "");
        if (bot.id === selection.authorizedBotId) {
          const token = selection.bootstrapToken;
          const connectionId = crypto.randomUUID();
          userConnections.set(connectionId, {
            accessToken: token.accessToken,
            refreshToken: token.refreshToken,
            expiresAt: token.expiresAt,
            refreshExpiresAt: token.refreshExpiresAt,
            userId: selection.pending.userId,
            user: selection.bootstrapUser,
            tenantKey: selection.tenantKey || bot.tenantKey || "",
            oauthBotId: bot.id,
            selectedBotId: bot.id,
          });
          if (selection.pending.mcp) {
            const code = randomToken();
            mcpAuthorizationCodes.set(code, {
              connectionId,
              clientId: selection.pending.mcp.clientId,
              redirectUri: selection.pending.mcp.redirectUri,
              codeChallenge: selection.pending.mcp.codeChallenge,
              expiresAt: Date.now() + 5 * 60 * 1000,
            });
            const callback = new URL(selection.pending.mcp.redirectUri);
            callback.searchParams.set("code", code);
            callback.searchParams.set("state", selection.pending.mcp.state);
            redirect(res, callback.toString());
          } else {
            json(res, 200, { ok: true, connection_id: connectionId, selected_bot: publicBot(bot) });
          }
          return true;
        }
        const state = crypto.randomBytes(24).toString("hex");
        oauthStates.set(state, {
          ...selection.pending,
          botId: bot.id,
          stage: "bot",
          expectedTenantKey: selection.tenantKey,
          organization: selection.organization,
          createdAt: Date.now(),
        });
        redirect(res, createOAuthUrl({ state, botId: bot.id }));
      } catch (error) {
        json(res, 400, { error: error.message });
      }
      return true;
    }

    if (requestUrl.pathname === "/oauth/lark/select-organization" && req.method === "POST") {
      try {
        const body = parseFormBody(req, await readRequestBody(req));
        const selection = organizationSelectionStates.get(body.selection_token ?? "");
        const requestedOrganizationKey = `${String(body.platform ?? "lark").toLowerCase()}:${body.organization_id ?? ""}`;
        if (selection?.redirectLocation && selection.selectedOrganizationId === requestedOrganizationKey && selection.oauthState && oauthStates.has(selection.oauthState)) {
          redirect(res, selection.redirectLocation);
          return true;
        }
        const platform = String(body.platform ?? "lark").toLowerCase();
        const organization = organizationsFromRegistry().find((item) => item.id === body.organization_id && item.platform === platform);
        if (!selection || selection.expiresAt < Date.now()) throw new Error("Invalid or expired organization selection");
        if (!organization) throw new Error("Organization not found");
        const bootstraps = organization.bots.filter((bot) => bot.bootstrap);
        if (bootstraps.length !== 1) throw new Error("The selected organization must have exactly one bootstrap Bot");
        const bootstrap = bootstraps[0];
        const organizationSelectionKey = `${organization.platform}:${organization.id}`;
        if (selection.oauthState && selection.selectedOrganizationId !== organizationSelectionKey) oauthStates.delete(selection.oauthState);
        const state = crypto.randomBytes(24).toString("hex");
        oauthStates.set(state, {
          ...selection.pending,
          botId: bootstrap.id,
          stage: "organization_bootstrap",
          organization,
          expectedTenantKey: organization.bots.find((bot) => bot.tenantKey)?.tenantKey ?? "",
          createdAt: Date.now(),
        });
        selection.selectedOrganizationId = organizationSelectionKey;
        selection.oauthState = state;
        selection.redirectLocation = createOAuthUrl({ state, botId: bootstrap.id });
        redirect(res, selection.redirectLocation);
      } catch (error) {
        json(res, 400, { error: error.message });
      }
      return true;
    }

    if (requestUrl.pathname === "/oauth/authorize") {
      const clientId = requestUrl.searchParams.get("client_id") ?? "";
      const client = mcpClients.get(clientId);
      const redirectUri = requestUrl.searchParams.get("redirect_uri") ?? "";
      const codeChallenge = requestUrl.searchParams.get("code_challenge") ?? "";
      if (!client || !client.redirectUris.includes(redirectUri) || requestUrl.searchParams.get("response_type") !== "code" || requestUrl.searchParams.get("code_challenge_method") !== "S256" || !codeChallenge) {
        json(res, 400, { error: "invalid_request", error_description: "Valid OAuth client and PKCE parameters are required" });
        return true;
      }
      const selectionToken = randomToken();
      organizationSelectionStates.set(selectionToken, {
        pending: { userId: "", mcp: { clientId, redirectUri, codeChallenge, state: requestUrl.searchParams.get("state") ?? "" } },
        expiresAt: Date.now() + 10 * 60 * 1000,
      });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderOrganizationSelectionPage(selectionToken, organizationsFromRegistry()));
      return true;
    }

    if (requestUrl.pathname === "/oauth/token" && req.method === "POST") {
      try {
        const body = parseFormBody(req, await readRequestBody(req));
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

    if (requestUrl.pathname === "/oauth/lark/start" || requestUrl.pathname === "/oauth/feishu/start") {
      let botId;
      try {
        botId = getBot(requestUrl.searchParams.get("bot_id") ?? "").id;
      } catch (error) {
        json(res, 400, { error: "invalid_bot", error_description: error.message });
        return true;
      }
      const state = crypto.randomBytes(24).toString("hex");
      const userId = requestUrl.searchParams.get("user_id") ?? "";
      oauthStates.set(state, { userId, botId, stage: "bot", createdAt: Date.now() });
      redirect(res, createOAuthUrl({ state, botId, userId }));
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
        if (pending.stage === "organization_bootstrap") {
          const organization = pending.organization;
          const bots = getBotRegistry().filter((bot) => bot.organizationId === organization.id && bot.platform === organization.platform);
          if (bots.length === 0) throw new Error("No Bot is configured for the selected organization");
          const selectionToken = randomToken();
          botSelectionStates.set(selectionToken, {
            pending,
            organization,
            bots,
            authorizedBotId: oauthBot.id,
            bootstrapUser: user,
            bootstrapToken: { accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: Date.now() + Math.max(60, (token.expires_in ?? 7200) - 300) * 1000, refreshExpiresAt: Date.now() + Math.max(60, (token.refresh_expires_in ?? 2592000) - 300) * 1000 },
            tenantKey: userTenantKey,
            expiresAt: Date.now() + 10 * 60 * 1000,
          });
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderBotSelectionPage(selectionToken, organization, bots, oauthBot.id));
          return true;
        }
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
