export async function handleOAuthDiscoveryRoutes({ req, res, requestUrl, mcpIssuerForRequest, mcpOAuthMetadata, json, parseFormBody, readRequestBody, randomToken, mcpClients, resolveClientConfig }) {
  if (requestUrl.pathname === "/.well-known/oauth-protected-resource/mcp" || requestUrl.pathname === "/.well-known/oauth-protected-resource") {
    const issuer = mcpIssuerForRequest(requestUrl);
    json(res, 200, { resource: `${issuer}/mcp`, authorization_servers: [issuer], bearer_methods_supported: ["header"], scopes_supported: ["lark:read", "lark:write"] });
    return true;
  }
  if (requestUrl.pathname === "/.well-known/oauth-authorization-server" || requestUrl.pathname === "/.well-known/openid-configuration") {
    json(res, 200, mcpOAuthMetadata(mcpIssuerForRequest(requestUrl)));
    return true;
  }
  if (requestUrl.pathname === "/oauth/register" && req.method === "POST") {
    try {
      const body = parseFormBody(req, await readRequestBody(req));
      const requestedClientId = String(body.client_id ?? "").trim();
      const mappedClient = requestedClientId ? resolveClientConfig(requestedClientId) : null;
      const clientId = mappedClient ? requestedClientId : `lark-mcp-${randomToken()}`;
      const redirectUris = Array.isArray(body.redirect_uris) && body.redirect_uris.length
        ? body.redirect_uris
        : mappedClient?.redirectUris ?? [];
      mcpClients.set(clientId, { clientId, redirectUris, clientName: body.client_name ?? "MCP client", createdAt: Date.now() });
      json(res, 201, { client_id: clientId, client_name: body.client_name ?? "MCP client", redirect_uris: redirectUris, token_endpoint_auth_method: "none" });
    } catch (error) {
      json(res, 400, { error: "invalid_client_metadata", error_description: error.message });
    }
    return true;
  }
  return false;
}
