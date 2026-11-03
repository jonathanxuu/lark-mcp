import test from "node:test";
import assert from "node:assert/strict";
import { createOAuthRoutes } from "../src/http/routes/oauth-routes.mjs";

test("configured app_id redirects directly to its Lark Bot OAuth", async () => {
  const response = {
    statusCode: 0,
    headers: {},
    writeHead(statusCode, headers) { this.statusCode = statusCode; this.headers = headers; },
    end() {},
  };
  const bot = { id: "lark-bot", platform: "lark", tenantKey: "tenant-1" };
  const route = createOAuthRoutes({
    crypto: { randomBytes: () => ({ toString: () => "oauth-state" }) },
    req: { method: "GET" },
    res: response,
    requestUrl: new URL("https://mcp.example/oauth/authorize?client_id=cli_lark&redirect_uri=https%3A%2F%2Fcounso.example%2Fcallback&response_type=code&code_challenge=abc&code_challenge_method=S256"),
    platform: "lark",
    getBotRegistry: () => [bot],
    botSelectionStates: new Map(),
    mcpAccessTokens: new Map(),
    mcpAuthorizationCodes: new Map(),
    mcpClients: new Map(),
    oauthStates: new Map(),
    organizationSelectionStates: new Map(),
    userConnections: new Map(),
    getBot: () => bot,
    publicBot: () => ({}),
    organizationsFromRegistry: () => [],
    resolveClientConfig: (clientId, platform) => clientId === "cli_lark" && platform === "lark"
      ? { botId: "lark-bot", redirectUris: ["https://counso.example/callback"] }
      : null,
    createOAuthUrl: ({ state, botId }) => `https://lark.example/oauth?state=${state}&bot_id=${botId}`,
    exchangeAuthorizationCode: async () => ({}),
    getLarkUserInfo: async () => ({}),
    renderOrganizationSelectionPage: () => "",
    renderBotSelectionPage: () => "",
    json: () => {},
    parseFormBody: () => ({}),
    readRequestBody: async () => "",
    redirect: (res, location) => { res.writeHead(302, { Location: location }); res.end(); },
    randomToken: () => "selection-1",
    pkceChallenge: () => "abc",
  });

  assert.equal(await route(), true);
  assert.equal(response.statusCode, 302);
  assert.match(response.headers.Location, /bot_id=lark-bot/);
});
