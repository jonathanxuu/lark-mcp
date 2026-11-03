export function handleOAuthStatusRoute({ requestUrl, userConnections, getConnectionBot, botRegistry, publicBot, res }) {
  if (requestUrl.pathname !== "/oauth/lark/status") return false;
  const connectionId = requestUrl.searchParams.get("connection_id") ?? "";
  const connection = userConnections.get(connectionId);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({
    ok: Boolean(connection),
    connected: Boolean(connection),
    user: connection ? { name: connection.user?.name, open_id: connection.user?.open_id, user_id: connection.user?.user_id } : null,
    selected_bot: connection ? publicBot(getConnectionBot(connectionId)) : null,
    available_bots: connection ? botRegistry.map(publicBot) : [],
    expires_at: connection ? new Date(connection.expiresAt).toISOString() : null,
  }));
  return true;
}
