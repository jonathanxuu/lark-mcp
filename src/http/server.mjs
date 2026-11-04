import http from "node:http";
import { URL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { adminToken, port, publicBaseUrl } from "../config/index.mjs";
import { json, parseFormBody, readRequestBody, redirect } from "./response.mjs";
import { mcpOAuthMetadata } from "../oauth/metadata.mjs";
import { handleOAuthStatusRoute } from "./routes/oauth-status-route.mjs";
import { handleConfigRoutes } from "./routes/config-routes.mjs";
import { handleOAuthDiscoveryRoutes } from "./routes/oauth-discovery-routes.mjs";
import { createOAuthRoutes } from "./routes/oauth-routes.mjs";

function issuerForRequest(requestUrl) {
  return process.env.MCP_OAUTH_ISSUER ?? publicBaseUrl ?? `http://${requestUrl.host}`;
}

function platformRoute(requestUrl) {
  for (const platform of ["lark", "feishu"]) {
    const prefix = `/${platform}`;
    if (requestUrl.pathname === prefix || requestUrl.pathname.startsWith(`${prefix}/`)) {
      const routeUrl = new URL(requestUrl);
      routeUrl.pathname = routeUrl.pathname.slice(prefix.length) || "/";
      return { platform, routeUrl, issuer: `${issuerForRequest(requestUrl)}/${platform}`, scoped: true };
    }
  }
  const aliases = [
    ["/.well-known/oauth-authorization-server/lark", "lark", "/.well-known/oauth-authorization-server"],
    ["/.well-known/oauth-authorization-server/feishu", "feishu", "/.well-known/oauth-authorization-server"],
    ["/.well-known/openid-configuration/lark", "lark", "/.well-known/openid-configuration"],
    ["/.well-known/openid-configuration/feishu", "feishu", "/.well-known/openid-configuration"],
    ["/.well-known/oauth-protected-resource/lark/mcp", "lark", "/.well-known/oauth-protected-resource/mcp"],
    ["/.well-known/oauth-protected-resource/feishu/mcp", "feishu", "/.well-known/oauth-protected-resource/mcp"],
    ["/.well-known/oauth-authorization-server", "lark", "/.well-known/oauth-authorization-server"],
    ["/.well-known/openid-configuration", "lark", "/.well-known/openid-configuration"],
    ["/.well-known/oauth-protected-resource", "lark", "/.well-known/oauth-protected-resource"],
    ["/register", "lark", "/oauth/register"],
  ];
  const alias = aliases.find(([pathname]) => requestUrl.pathname === pathname);
  if (alias) {
    const [, platform, pathname] = alias;
    const routeUrl = new URL(requestUrl);
    routeUrl.pathname = pathname;
    return { platform, routeUrl, issuer: `${issuerForRequest(requestUrl)}/${platform}`, scoped: true };
  }
  return { platform: "lark", routeUrl: requestUrl, issuer: issuerForRequest(requestUrl), scoped: false };
}

export function createHttpServer({
  createMcpServer,
  getBotRegistry,
  providers,
  publicBot,
  saveManagedBot,
  removeManagedBot,
  getBot,
  getConnectionBot,
  mcpClients,
  mcpAccessTokens,
  mcpAuthorizationCodes,
  oauthStates,
  userConnections,
  resolveClientConfig,
  createOAuthUrl,
  exchangeAuthorizationCode,
  getLarkUserInfo,
  mcpConnectionContext,
  randomToken,
  pkceChallenge,
  crypto,
  configAccessKey,
  configPublicBaseUrl,
}) {
  return http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const { platform, routeUrl, issuer, scoped } = platformRoute(requestUrl);
    console.log(`[HTTP] ${req.method} ${requestUrl.pathname}`);

    const unscopedMcpRoute = requestUrl.pathname === "/mcp"
      || requestUrl.pathname === "/oauth/authorize"
      || requestUrl.pathname === "/oauth/token"
      || requestUrl.pathname === "/oauth/register"
      || requestUrl.pathname === "/.well-known/oauth-protected-resource/mcp";
    if (!scoped && unscopedMcpRoute) {
      json(res, 400, {
        error: "platform_path_required",
        error_description: "Use /lark/mcp or /feishu/mcp so the MCP server can identify the platform and Bot.",
      });
      return;
    }

    if (await handleOAuthDiscoveryRoutes({ req, res, requestUrl: routeUrl, mcpIssuerForRequest: () => issuer, mcpOAuthMetadata, json, parseFormBody, readRequestBody, randomToken, mcpClients, resolveClientConfig })) return;
    if (await handleConfigRoutes({ req, res, requestUrl, configAccessKey, publicBaseUrl: configPublicBaseUrl, botRegistry: getBotRegistry(), providers, saveManagedBot, removeManagedBot, getBot, json, parseFormBody, readRequestBody, redirect, crypto })) return;
    if (await handleAdminBotRoutes({ req, res, requestUrl: routeUrl, adminToken, botRegistry: getBotRegistry(), providers, publicBot, saveManagedBot, removeManagedBot, getBot, json, parseFormBody, readRequestBody, crypto })) return;
    if (await createOAuthRoutes({
      crypto, req, res, requestUrl: routeUrl, platform, mcpAccessTokens,
      mcpAuthorizationCodes, oauthStates, userConnections, getBot, publicBot, createOAuthUrl,
      resolveClientConfig,
      exchangeAuthorizationCode, getLarkUserInfo, json, parseFormBody, readRequestBody, redirect, randomToken,
      pkceChallenge,
    })()) return;
    if (handleOAuthStatusRoute({ requestUrl: routeUrl, userConnections, getConnectionBot, botRegistry: getBotRegistry(), publicBot, res })) return;

    if (routeUrl.pathname !== "/mcp") {
      json(res, routeUrl.pathname === "/health" ? 200 : 404, { ok: routeUrl.pathname === "/health" });
      return;
    }
    const authorization = req.headers.authorization ?? "";
    const accessToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
    const token = accessToken ? mcpAccessTokens.get(accessToken) : null;
    console.log(`[MCP] bearer_present=${Boolean(accessToken)} token_valid=${Boolean(token && token.refresh !== true && token.expiresAt >= Date.now())} connection=${token?.connectionId ?? ""}`);
    if (!token || token.refresh === true || token.expiresAt < Date.now()) {
      res.writeHead(401, { "Content-Type": "application/json; charset=utf-8", "WWW-Authenticate": `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp"` });
      res.end(JSON.stringify({ error: "unauthorized", error_description: "Lark member OAuth is required" }));
      return;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = createMcpServer();
    res.on("close", () => transport.close().catch(() => {}));
    await mcpConnectionContext.run(token.connectionId, async () => {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    });
  });
}

export function startHttpServer(server) {
  server.listen(port, () => console.log(`COUNSO Lark MCP listening on http://localhost:${port}/mcp`));
}
import { handleAdminBotRoutes } from "./routes/admin-routes.mjs";
