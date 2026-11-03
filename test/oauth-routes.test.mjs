import test from "node:test";
import assert from "node:assert/strict";
import { createOAuthRoutes } from "../src/http/routes/oauth-routes.mjs";

test("OAuth authorize route creates an organization selection page", async () => {
  const organizationSelectionStates = new Map();
  const mcpClients = new Map([["client-1", { redirectUris: ["https://client.example/callback"] }]]);
  const response = {
    statusCode: 0,
    headers: {},
    body: "",
    writeHead(statusCode, headers) { this.statusCode = statusCode; this.headers = headers; },
    end(body = "") { this.body = body; },
  };
  const requestUrl = new URL("https://mcp.example/oauth/authorize?client_id=client-1&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback&response_type=code&code_challenge=abc&code_challenge_method=S256&state=state-1");
  const route = createOAuthRoutes({
    crypto: { randomUUID: () => "connection-1", randomBytes: () => ({ toString: () => "oauth-state" }) },
    req: { method: "GET" },
    res: response,
    requestUrl,
    getBotRegistry: () => [],
    botSelectionStates: new Map(),
    mcpAccessTokens: new Map(),
    mcpAuthorizationCodes: new Map(),
    mcpClients,
    oauthStates: new Map(),
    organizationSelectionStates,
    userConnections: new Map(),
    getBot() { throw new Error("not used"); },
    publicBot() {},
    organizationsFromRegistry: () => [{ id: "org-1", platform: "lark", platform_label: "Lark", name: "Example", bots: [] }],
    createOAuthUrl: () => "https://lark.example/oauth",
    exchangeAuthorizationCode: async () => ({}),
    getLarkUserInfo: async () => ({}),
    renderOrganizationSelectionPage: (token, organizations) => `${token}:${organizations[0].name}`,
    renderBotSelectionPage: () => "",
    json: (res, status, payload) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(payload)); },
    parseFormBody: () => ({}),
    readRequestBody: async () => "",
    redirect: () => {},
    randomToken: () => "selection-1",
    pkceChallenge: () => "abc",
  });

  assert.equal(await route(), true);
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /selection-1:Example/);
  assert.equal(organizationSelectionStates.size, 1);
});
