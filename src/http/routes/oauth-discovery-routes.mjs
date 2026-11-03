export async function handleOAuthDiscoveryRoutes({ req, res, requestUrl, mcpIssuerForRequest, mcpOAuthMetadata, json, parseFormBody, readRequestBody, randomToken, mcpClients }) {
  if (requestUrl.pathname === "/.well-known/oauth-protected-resource/mcp" || requestUrl.pathname === "/.well-known/oauth-protected-resource") {
    const issuer = mcpIssuerForRequest(requestUrl);
    json(res, 200, { resource: `${issuer}/mcp`, authorization_servers: [issuer], bearer_methods_supported: ["header"], scopes_supported: ["lark:read", "lark:write"] });
    return true;
  }
  if (requestUrl.pathname === "/.well-known/oauth-authorization-server") {
    json(res, 200, mcpOAuthMetadata(mcpIssuerForRequest(requestUrl)));
    return true;
  }
  if (requestUrl.pathname === "/oauth/register" && req.method === "POST") {
    try {
      const body = parseFormBody(req, await readRequestBody(req));
      const clientId = `lark-mcp-${randomToken()}`;
      mcpClients.set(clientId, { clientId, redirectUris: Array.isArray(body.redirect_uris) ? body.redirect_uris : [], clientName: body.client_name ?? "MCP client", createdAt: Date.now() });
      json(res, 201, { client_id: clientId, client_name: body.client_name ?? "MCP client", redirect_uris: body.redirect_uris ?? [], token_endpoint_auth_method: "none" });
    } catch (error) {
      json(res, 400, { error: "invalid_client_metadata", error_description: error.message });
    }
    return true;
  }
  return false;
}
