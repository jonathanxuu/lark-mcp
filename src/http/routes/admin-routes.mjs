export async function handleAdminBotRoutes({ req, res, requestUrl, adminToken, botRegistry, providers, publicBot, saveManagedBot, removeManagedBot, getBot, json, parseFormBody, readRequestBody, crypto }) {
  if (!requestUrl.pathname.startsWith("/admin/lark-bots")) return false;
  if (!adminToken || req.headers.authorization !== `Bearer ${adminToken}`) {
    json(res, 401, { error: "unauthorized" });
    return true;
  }
  try {
    if (requestUrl.pathname === "/admin/lark-bots" && req.method === "GET") {
      json(res, 200, { bots: botRegistry.map(publicBot) });
      return true;
    }
    if (requestUrl.pathname === "/admin/lark-bots" && req.method === "POST") {
      const body = parseFormBody(req, await readRequestBody(req));
      const appId = String(body.app_id ?? body.appId ?? "").trim();
      const appSecret = String(body.app_secret ?? body.appSecret ?? "").trim();
      const existingByAppId = appId ? botRegistry.find((bot) => bot.appId === appId) : null;
      const id = String(body.id ?? "").trim() || existingByAppId?.id || crypto.randomBytes(16).toString("hex");
      const platform = String(body.platform ?? "lark").trim().toLowerCase();
      const name = String(body.name ?? appId).trim();
      const organizationId = String(body.organization_id ?? body.organizationId ?? "").trim();
      const organizationName = String(body.organization_name ?? body.organizationName ?? organizationId).trim();
      const tenantKey = String(body.tenant_key ?? body.tenantKey ?? "").trim();
      const redirectUris = Array.isArray(body.redirect_uris)
        ? body.redirect_uris.map((uri) => String(uri)).filter(Boolean)
        : [];
      if (!providers[platform]) throw new Error("platform must be lark or feishu");
      const resolvedAppSecret = appSecret || existingByAppId?.appSecret || "";
      if (!appId || !resolvedAppSecret || !name) throw new Error("name, platform and app_id are required; app_secret is required only when creating a Bot");
      const bot = saveManagedBot({ id, platform, name, appId, appSecret: resolvedAppSecret, outputFolderToken: body.output_folder_token ?? existingByAppId?.outputFolderToken ?? "", description: body.description ?? existingByAppId?.description ?? "", organizationId: organizationId || existingByAppId?.organizationId || "", organizationName: organizationName || existingByAppId?.organizationName || "", tenantKey: tenantKey || existingByAppId?.tenantKey || "", redirectUris: redirectUris.length ? redirectUris : existingByAppId?.redirectUris ?? [], bootstrap: body.bootstrap === true || body.bootstrap === "true" || existingByAppId?.bootstrap === true });
      json(res, 201, { bot: publicBot(bot) });
      return true;
    }
    const match = requestUrl.pathname.match(/^\/admin\/lark-bots\/([^/]+)$/);
    if (match && req.method === "DELETE") {
      const id = decodeURIComponent(match[1]);
      const bot = getBot(id);
      if (bot.source !== "store") throw new Error("Environment/file-configured Bots cannot be deleted through the admin API");
      removeManagedBot(id);
      json(res, 200, { deleted: id });
      return true;
    }
    json(res, 404, { error: "not_found" });
  } catch (error) {
    json(res, 400, { error: error.message });
  }
  return true;
}
