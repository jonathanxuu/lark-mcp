export async function handleAdminBotRoutes({ req, res, requestUrl, adminToken, botRegistry, providers, publicBot, saveManagedBot, removeManagedBot, getBot, json, parseFormBody, readRequestBody, crypto }) {
  if (requestUrl.pathname.startsWith("/admin/lark-bots")) {
    if (!adminToken || req.headers.authorization !== `Bearer ${adminToken}`) {
      json(res, 401, { error: "unauthorized" });
      return;
    }
    try {
      if (requestUrl.pathname === "/admin/lark-bots" && req.method === "GET") {
        json(res, 200, { bots: botRegistry.map(publicBot) });
        return;
      }
      if (requestUrl.pathname === "/admin/lark-bots" && req.method === "POST") {
        const body = parseFormBody(req, await readRequestBody(req));
        const id = String(body.id ?? crypto.randomUUID());
        const appId = String(body.app_id ?? body.appId ?? "").trim();
        const appSecret = String(body.app_secret ?? body.appSecret ?? "").trim();
        const platform = String(body.platform ?? "lark").trim().toLowerCase();
        const name = String(body.name ?? appId).trim();
        const organizationId = String(body.organization_id ?? body.organizationId ?? "").trim();
        const organizationName = String(body.organization_name ?? body.organizationName ?? organizationId).trim();
        const tenantKey = String(body.tenant_key ?? body.tenantKey ?? "").trim();
        if (!providers[platform]) throw new Error("platform must be lark or feishu");
        if (!appId || !appSecret || !name || !organizationId || !tenantKey) throw new Error("id, name, platform, organization_id, tenant_key, app_id and app_secret are required");
        const bot = saveManagedBot({
          id,
          platform,
          name,
          appId,
          appSecret,
          outputFolderToken: body.output_folder_token ?? "",
          description: body.description ?? "",
          organizationId,
          organizationName,
          tenantKey,
          bootstrap: body.bootstrap === true || body.bootstrap === "true",
        });
        json(res, 201, { bot: publicBot(bot) });
        return;
      }
      const match = requestUrl.pathname.match(/^\/admin\/lark-bots\/([^/]+)$/);
      if (match && req.method === "DELETE") {
        const id = decodeURIComponent(match[1]);
        const bot = getBot(id);
        if (bot.source !== "store") throw new Error("Environment-configured Bots cannot be deleted through the admin API");
        removeManagedBot(id);
        json(res, 200, { deleted: id });
        return;
      }
      json(res, 404, { error: "not_found" });
    } catch (error) {
      json(res, 400, { error: error.message });
    }
    return;
  }

}

