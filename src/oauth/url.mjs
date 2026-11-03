export function createOAuthUrl({ getBot, getProvider }) {
  return function buildOAuthUrl({ state, userId = "", botId = "" }) {
    const bot = getBot(botId);
    const provider = getProvider(bot.platform ?? "lark");
    const query = new URLSearchParams({
      app_id: bot.appId,
      redirect_uri: provider.oauthRedirectUri,
      state,
      scope: provider.oauthScopes,
    });
    if (userId) query.set("login_hint", userId);
    return `${provider.oauthBaseUrl}/open-apis/authen/v1/authorize?${query}`;
  };
}
