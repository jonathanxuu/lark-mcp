export function registerBotTools(server, dependencies) {
  const { z, resolveConnectionId, getConnection, getBot, botRegistry, publicBot, getProvider } = dependencies;
  server.registerTool(
    "lark_list_bots",
    {
      title: "List available Lark Bots",
      description: "List the Lark Bots configured by the service. Secrets are never returned. Use this after OAuth so the user can choose which configured Bot should be used for subsequent Lark operations.",
      inputSchema: { connection_id: z.string().min(1).optional() },
    },
    async ({ connection_id }) => {
      const resolvedConnectionId = resolveConnectionId(connection_id);
      const connection = getConnection(resolvedConnectionId);
      const bots = botRegistry.map(publicBot);
      return {
        content: [{ type: "text", text: JSON.stringify({
          selected_bot_id: connection.selectedBotId ?? connection.oauthBotId,
          bots,
          note: "不同 app_id 的 Bot 需要重新完成一次 OAuth；MCP 连接会绑定当前已授权的 Bot。",
        }, null, 2) }],
        structuredContent: {
          selected_bot_id: connection.selectedBotId ?? connection.oauthBotId,
          bots,
        },
      };
    },
  );

  server.registerTool(
    "lark_select_bot",
    {
      title: "Select a Lark Bot",
      description: "Select one configured Lark Bot for the current OAuth connection. A Bot with a different app_id requires a new OAuth authorization through the browser flow.",
      inputSchema: {
        bot_id: z.string().min(1),
        connection_id: z.string().min(1).optional(),
      },
    },
    async ({ bot_id, connection_id }) => {
      const resolvedConnectionId = resolveConnectionId(connection_id);
      const connection = getConnection(resolvedConnectionId);
      const bot = getBot(bot_id);
      const authorizedBot = getBot(connection.oauthBotId);
      if (bot.platform !== authorizedBot.platform || bot.appId !== authorizedBot.appId) {
        return {
          isError: true,
          content: [{ type: "text", text: "该 Bot 属于另一个平台或 OAuth 应用，请使用 bot_id 重新发起 OAuth 授权后再选择。" }],
        };
      }
      connection.selectedBotId = bot.id;
      return {
        content: [{ type: "text", text: JSON.stringify({ selected_bot: publicBot(bot), message: `已选择 ${getProvider(bot.platform).label} Bot：${bot.name}` }, null, 2) }],
        structuredContent: { selected_bot: publicBot(bot) },
      };
    },
  );

}

