import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { URL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import mammoth from "mammoth";
import pdfParse from "pdf-parse";
import * as XLSX from "xlsx";

const port = Number(process.env.PORT ?? 8787);
const publicBaseUrl = (process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, "");
const defaultOutputFolderName = "Counso Lark Bot";
const mcpIssuer = process.env.MCP_OAUTH_ISSUER ?? publicBaseUrl;
const mcpResource = process.env.MCP_RESOURCE ?? `${mcpIssuer}/mcp`;
const botStorePath = process.env.LARK_BOT_STORE_PATH ?? "./data/lark-bots.enc.json";
const botStoreKey = process.env.LARK_BOT_STORE_KEY ?? "";
const adminToken = process.env.LARK_ADMIN_TOKEN ?? "";

const defaultOAuthScopes = "docs:document.content:read docx:document:create drive:drive";
const providers = {
  lark: {
    id: "lark",
    label: "Lark",
    apiBaseUrl: process.env.LARK_BASE_URL ?? "https://open.larksuite.com",
    oauthBaseUrl: process.env.LARK_OAUTH_BASE_URL ?? "https://accounts.larksuite.com",
    webBaseUrl: process.env.LARK_WEB_BASE_URL ?? "https://www.larksuite.com",
    oauthRedirectUri: process.env.LARK_OAUTH_REDIRECT_URI ?? `${publicBaseUrl}/oauth/lark/callback`,
    oauthScopes: process.env.LARK_OAUTH_SCOPES ?? defaultOAuthScopes,
    defaultOutputFolderToken: process.env.LARK_OUTPUT_FOLDER_TOKEN ?? "",
  },
  feishu: {
    id: "feishu",
    label: "飞书",
    apiBaseUrl: process.env.FEISHU_BASE_URL ?? "https://open.feishu.cn",
    oauthBaseUrl: process.env.FEISHU_OAUTH_BASE_URL ?? "https://accounts.feishu.cn",
    webBaseUrl: process.env.FEISHU_WEB_BASE_URL ?? "https://www.feishu.cn",
    oauthRedirectUri: process.env.FEISHU_OAUTH_REDIRECT_URI ?? `${publicBaseUrl}/oauth/feishu/callback`,
    oauthScopes: process.env.FEISHU_OAUTH_SCOPES ?? defaultOAuthScopes,
    defaultOutputFolderToken: process.env.FEISHU_OUTPUT_FOLDER_TOKEN ?? "",
  },
};

function getProvider(provider = "lark") {
  const resolved = providers[provider];
  if (!resolved) throw new Error(`Unsupported platform: ${provider}`);
  return resolved;
}

function encryptSecret(secret) {
  if (!botStoreKey) throw new Error("LARK_BOT_STORE_KEY is required for encrypted Bot storage");
  const key = crypto.createHash("sha256").update(botStoreKey).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

function decryptSecret(value) {
  if (!botStoreKey) throw new Error("LARK_BOT_STORE_KEY is required for encrypted Bot storage");
  const key = crypto.createHash("sha256").update(botStoreKey).digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function readBotStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(botStorePath, "utf8"));
    return Array.isArray(raw.bots) ? raw.bots : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw new Error(`Cannot read Lark Bot store: ${error.message}`);
  }
}

function writeBotStore(bots) {
  fs.mkdirSync(path.dirname(path.resolve(botStorePath)), { recursive: true });
  const tempPath = `${botStorePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify({ version: 1, bots }, null, 2), { mode: 0o600 });
  fs.renameSync(tempPath, botStorePath);
}

function loadStaticBotRegistry() {
  const configured = process.env.LARK_BOTS_JSON?.trim();
  if (!configured) {
    if (!process.env.LARK_APP_ID || !process.env.LARK_APP_SECRET) return [];
    return [{ id: "default", platform: "lark", name: "COUNSO Lark 助手", appId: process.env.LARK_APP_ID, appSecret: process.env.LARK_APP_SECRET, outputFolderToken: providers.lark.defaultOutputFolderToken, description: "默认 Lark 应用" }];
  }

  let bots;
  try {
    bots = JSON.parse(configured);
  } catch (error) {
    throw new Error(`LARK_BOTS_JSON is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(bots) || bots.length === 0) {
    throw new Error("LARK_BOTS_JSON must be a non-empty array");
  }
  const normalized = bots.map((bot, index) => ({
    id: String(bot.id ?? `bot-${index + 1}`),
    platform: String(bot.platform ?? "lark").toLowerCase(),
    name: String(bot.name ?? bot.id ?? `Lark Bot ${index + 1}`),
    appId: bot.app_id ?? bot.appId,
    appSecret: bot.app_secret ?? bot.appSecret,
    outputFolderToken: bot.output_folder_token ?? bot.outputFolderToken ?? getProvider(String(bot.platform ?? "lark").toLowerCase()).defaultOutputFolderToken,
    description: bot.description ?? "",
  }));
  if (normalized.some((bot) => !bot.appId || !bot.appSecret)) {
    throw new Error("Every LARK_BOTS_JSON entry requires app_id and app_secret");
  }
  if (normalized.some((bot) => !providers[bot.platform])) {
    throw new Error("Every LARK_BOTS_JSON entry requires platform=lark or platform=feishu");
  }
  if (new Set(normalized.map((bot) => bot.id)).size !== normalized.length) {
    throw new Error("LARK_BOTS_JSON bot ids must be unique");
  }
  return normalized;
}

function loadBotRegistry() {
  const staticBots = loadStaticBotRegistry();
  const storedBots = readBotStore().map((bot) => ({
    id: bot.id,
    platform: bot.platform ?? "lark",
    name: bot.name,
    appId: bot.app_id,
    appSecret: decryptSecret(bot.app_secret),
    outputFolderToken: bot.output_folder_token ?? getProvider(bot.platform ?? "lark").defaultOutputFolderToken,
    description: bot.description ?? "",
    organizationId: bot.organization_id ?? "",
    organizationName: bot.organization_name ?? "",
    tenantKey: bot.tenant_key ?? "",
    bootstrap: bot.bootstrap === true,
    source: "store",
  }));
  const merged = new Map(staticBots.map((bot) => [bot.id, { ...bot, source: "env" }]));
  for (const bot of storedBots) merged.set(bot.id, bot);
  return [...merged.values()];
}

let botRegistry = loadBotRegistry();
let botById = new Map(botRegistry.map((bot) => [bot.id, bot]));

function refreshBotRegistry() {
  botRegistry = loadBotRegistry();
  botById = new Map(botRegistry.map((bot) => [bot.id, bot]));
  appAccessTokenCache.clear();
  tenantAccessTokenCache.clear();
}

function saveManagedBot({ id, platform = "lark", name, appId, appSecret, outputFolderToken = "", description = "", organizationId = "", organizationName = "", tenantKey = "", bootstrap = false }) {
  platform = String(platform).toLowerCase();
  getProvider(platform);
  const existing = readBotStore().find((bot) => bot.id === id);
  if (existing && (existing.organization_id !== organizationId || (existing.platform ?? "lark") !== platform)) {
    throw new Error(`Bot id "${id}" is already registered to another organization or platform; use a globally unique Bot id`);
  }
  const bots = readBotStore().filter((bot) => bot.id !== id);
  if (bootstrap) {
    for (const bot of bots) {
      if (bot.organization_id === organizationId && (bot.platform ?? "lark") === platform) bot.bootstrap = false;
    }
  }
  bots.push({
    id,
    name,
    app_id: appId,
    app_secret: encryptSecret(appSecret),
    platform,
    output_folder_token: outputFolderToken || getProvider(platform).defaultOutputFolderToken,
    description,
    organization_id: organizationId,
    organization_name: organizationName,
    tenant_key: tenantKey,
    bootstrap,
  });
  writeBotStore(bots);
  refreshBotRegistry();
  return getBot(id);
}

function removeManagedBot(id) {
  const bots = readBotStore().filter((bot) => bot.id !== id);
  writeBotStore(bots);
  refreshBotRegistry();
}
const appAccessTokenCache = new Map();
const tenantAccessTokenCache = new Map();
const oauthStates = new Map();
const organizationSelectionStates = new Map();
const botSelectionStates = new Map();
const userConnections = new Map();
const mcpClients = new Map();
const mcpAuthorizationCodes = new Map();
const mcpAccessTokens = new Map();
const mcpConnectionContext = new AsyncLocalStorage();

function randomToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function pkceChallenge(verifier) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function resolveConnectionId(connectionId) {
  // When MCP is handling a request, always use the connection bound to the
  // authenticated MCP bearer token. Do not allow tool arguments to select a
  // different member connection.
  return mcpConnectionContext.getStore() || connectionId || "";
}

function publicBot(bot) {
  return {
    id: bot.id,
    platform: bot.platform ?? "lark",
    name: bot.name,
    app_id: bot.appId,
    description: bot.description,
    organization_id: bot.organizationId || null,
    organization_name: bot.organizationName || null,
  };
}

function organizationsFromRegistry() {
  const organizations = new Map();
  for (const bot of botRegistry) {
    if (!bot.organizationId) continue;
    const platform = bot.platform ?? "lark";
    const organizationKey = `${platform}:${bot.organizationId}`;
    const organization = organizations.get(organizationKey) ?? {
      id: bot.organizationId,
      platform,
      platform_label: getProvider(platform).label,
      name: bot.organizationName || bot.organizationId,
      bots: [],
    };
    organization.bots.push(bot);
    organizations.set(organizationKey, organization);
  }
  return [...organizations.values()];
}

function getBot(botId = "") {
  const bot = botById.get(botId || botRegistry[0].id);
  if (!bot) throw new Error(`Lark Bot not found: ${botId}`);
  return bot;
}

function getConnectionBot(connectionId = "") {
  const connection = getConnection(connectionId);
  return getBot(connection.selectedBotId || connection.oauthBotId);
}

function getConnectionProvider(connectionId = "") {
  return getProvider(getConnectionBot(connectionId).platform ?? "lark");
}

function getBotWebBaseUrl(bot) {
  return getProvider(bot.platform ?? "lark").webBaseUrl;
}

function getConnectionWebBaseUrl(connectionId = "") {
  return getBotWebBaseUrl(getConnectionBot(connectionId));
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function mcpOAuthMetadata(issuer = mcpIssuer) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["lark:read", "lark:write"],
  };
}

function mcpIssuerForRequest(requestUrl) {
  return process.env.MCP_OAUTH_ISSUER ?? publicBaseUrl ?? `http://${requestUrl.host}`;
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function parseFormBody(req, body) {
  if ((req.headers["content-type"] ?? "").includes("application/json")) {
    return JSON.parse(body || "{}");
  }
  return Object.fromEntries(new URLSearchParams(body));
}

async function parseJson(response, operation = "Lark API") {
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${operation} returned HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  if (!response.ok || body.code !== 0) {
    throw new Error(`${operation} failed: Lark API error ${body.code ?? response.status}: ${body.msg ?? text}`);
  }
  return body;
}

async function fetchLark(url, options, operation) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetch(url, options);
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
      }
    }
  }
  const cause = lastError.cause?.code ?? lastError.cause?.message ?? lastError.code ?? lastError.message;
  console.error(`[Lark] ${operation} network request failed after retries: ${cause}`);
  throw new Error(`Lark network request failed during ${operation}: ${cause}`);
}

async function getTenantAccessToken(connectionId = "") {
  const connection = getConnection(connectionId);
  const bot = getConnectionBot(connectionId);
  const provider = getProvider(bot.platform ?? "lark");
  const tenantKey = connection.tenantKey || connection.user?.tenant_key || connection.user?.tenantKey || bot.tenantKey || "";
  const cacheKey = `${provider.id}:${bot.id}:${tenantKey || "default"}`;
  const cached = tenantAccessTokenCache.get(cacheKey);
  if (cached?.value && Date.now() < cached.expiresAt) return cached.value;

  // Each registered Bot is a tenant's own custom App. Custom Apps obtain
  // their tenant_access_token directly with app_id/app_secret. The
  // non-internal endpoint is for ISV/store Apps and expects an ISV app
  // access token, which causes error 10013 for these standalone Apps.
  const endpoint = `${provider.apiBaseUrl}/open-apis/auth/v3/tenant_access_token/internal`;
  console.error(`[${provider.label}] requesting tenant_access_token bot=${bot.id} tenant_key=${tenantKey || "(empty)"} endpoint=${endpoint}`);
  const requestBody = { app_id: bot.appId, app_secret: bot.appSecret };
  const response = await fetchLark(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  const body = await parseJson(response, `tenant_access_token for Bot ${bot.id}`);
  const token = body.tenant_access_token;
  tenantAccessTokenCache.set(cacheKey, {
    value: token,
    expiresAt: Date.now() + Math.max(60, body.expire - 300) * 1000,
  });
  return token;
}

async function getAppAccessToken(bot = botRegistry[0]) {
  const provider = getProvider(bot.platform ?? "lark");
  const cacheKey = `${provider.id}:${bot.id}`;
  const cached = appAccessTokenCache.get(cacheKey);
  if (cached?.value && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  console.error(`[${provider.label}] requesting app_access_token bot=${bot.id} app_id=${bot.appId} base_url=${provider.apiBaseUrl}`);
  const response = await fetchLark(`${provider.apiBaseUrl}/open-apis/auth/v3/app_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_id: bot.appId,
      app_secret: bot.appSecret,
    }),
  });
  const body = await parseJson(response, `app_access_token for Bot ${bot.id} (app_id ${bot.appId})`);
  appAccessTokenCache.set(cacheKey, {
    value: body.app_access_token,
    expiresAt: Date.now() + Math.max(60, body.expire - 300) * 1000,
  });
  return body.app_access_token;
}

async function exchangeAuthorizationCode(code, bot = botRegistry[0]) {
  const provider = getProvider(bot.platform ?? "lark");
  const appAccessToken = await getAppAccessToken(bot);
  const response = await fetchLark(`${provider.apiBaseUrl}/open-apis/authen/v1/oidc/access_token`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${appAccessToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
    }),
  });
  return parseJson(response);
}

async function refreshUserAccessToken(connection) {
  const bot = getBot(connection.oauthBotId);
  const provider = getProvider(bot.platform ?? "lark");
  const appAccessToken = await getAppAccessToken(bot);
  const response = await fetchLark(`${provider.apiBaseUrl}/open-apis/authen/v1/oidc/refresh_access_token`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${appAccessToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: connection.refreshToken,
    }),
  });
  const body = await parseJson(response);
  const data = body.data ?? body;
  connection.accessToken = data.access_token;
  connection.refreshToken = data.refresh_token ?? connection.refreshToken;
  connection.expiresAt = Date.now() + Math.max(60, (data.expires_in ?? 7200) - 300) * 1000;
  connection.refreshExpiresAt = Date.now() + Math.max(60, (data.refresh_expires_in ?? 2592000) - 300) * 1000;
  return connection.accessToken;
}

async function getAccessToken(connectionId = "", identity = "bot") {
  if (!connectionId) throw new Error("Lark OAuth connection_id is required; connect Lark before using this tool");
  const connection = userConnections.get(connectionId);
  if (!connection) throw new Error("Lark member OAuth connection not found; connect Lark before using this tool");

  if (identity === "user") return refreshUserAccessTokenIfNeeded(connection);
  return getTenantAccessToken(connectionId);
}

async function refreshUserAccessTokenIfNeeded(connection) {
  if (connection.accessToken && Date.now() < connection.expiresAt) return connection.accessToken;
  if (!connection.refreshToken) throw new Error("Lark user OAuth refresh token is missing");
  return refreshUserAccessToken(connection);
}

function getConnection(connectionId = "") {
  if (!connectionId) throw new Error("Lark OAuth connection_id is required; connect Lark before using this tool");
  const connection = userConnections.get(connectionId);
  if (!connection) throw new Error("Lark member OAuth connection not found; connect Lark before using this tool");
  return connection;
}

async function getLarkUserInfo(accessToken, bot = botRegistry[0]) {
  const provider = getProvider(bot.platform ?? "lark");
  const response = await fetchLark(`${provider.apiBaseUrl}/open-apis/authen/v1/user_info`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await parseJson(response);
  return body.data ?? body;
}

function htmlEscape(value) {
  return String(value ?? "").replace(/[&<>\"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function renderOrganizationSelectionPage(selectionToken, organizations) {
  const availablePlatforms = new Set(organizations.map((organization) => organization.platform));
  const defaultPlatform = availablePlatforms.has("lark") ? "lark" : "feishu";
  const platformTabs = ["lark", "feishu"].map((platform) => `
    <button class="platform-tab${platform === defaultPlatform ? " active" : ""}" type="button" data-platform="${platform}">
      <span class="platform-mark">${platformLogoIcon()}</span>${platform === "lark" ? "Lark" : "飞书"}
    </button>`).join("");
  const rows = organizations.map((organization) => `
    <button class="choice-card" type="submit" name="organization_id" value="${htmlEscape(organization.id)}" data-platform="${htmlEscape(organization.platform)}" data-search="${htmlEscape(organization.name)}">
      <span class="choice-icon">${buildingIcon()}</span>
      <span class="choice-copy"><strong>${htmlEscape(organization.name)}</strong><small>${htmlEscape(organization.platform_label)}</small></span>
      <span class="choice-arrow">${arrowIcon()}</span>
    </button>`).join("\n");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>选择平台和组织</title>
    <style>${oauthPageStyles()}</style></head><body><main class="panel">
      <div class="brand"><span class="brand-mark">${sparkIcon()}</span><span>COUNSO <em>LARK MCP</em></span></div>
      <div class="eyebrow">SECURE CONNECTION</div><h1>选择平台和组织</h1>
      <p class="subtitle">先选择你要连接的平台，再选择对应的组织。</p>
      <div class="platform-tabs" role="tablist">${platformTabs}</div>
      <label class="search"><span>${searchIcon()}</span><input id="search" type="search" placeholder="搜索组织名称" autocomplete="off"></label>
      <form id="organization-form" method="post" action="/oauth/lark/select-organization"><input type="hidden" name="selection_token" value="${htmlEscape(selectionToken)}"><input id="platform" type="hidden" name="platform" value="${htmlEscape(defaultPlatform)}"><div id="choices" class="choices">${rows || '<div class="empty">管理员还没有配置可用组织。</div>'}</div></form>
      <div id="empty-search" class="empty hidden">没有找到匹配的组织</div><footer>Protected by COUNSO Lark MCP</footer>
    </main><script>const input=document.querySelector('#search');const platformInput=document.querySelector('#platform');const cards=[...document.querySelectorAll('.choice-card')];const tabs=[...document.querySelectorAll('.platform-tab')];const empty=document.querySelector('#empty-search');let activePlatform='${defaultPlatform}';function filter(){const q=(input?.value||'').trim().toLowerCase();let visible=0;cards.forEach(c=>{const show=c.dataset.platform===activePlatform&&(!q||c.dataset.search.toLowerCase().includes(q));c.classList.toggle('hidden',!show);if(show)visible++});empty.classList.toggle('hidden',visible!==0)}cards.forEach(card=>card.addEventListener('click',()=>{if(platformInput)platformInput.value=card.dataset.platform}));tabs.forEach(tab=>tab.addEventListener('click',()=>{activePlatform=tab.dataset.platform;tabs.forEach(item=>item.classList.toggle('active',item===tab));if(platformInput)platformInput.value=activePlatform;if(input)input.value='';filter()}));input?.addEventListener('input',filter);filter();</script></body></html>`;
}

function renderBotSelectionPage(selectionToken, organization, bots, authorizedBotId = "") {
  const rows = bots.map((bot) => {
    const sameAuthorization = bot.id === authorizedBotId;
    return `<button class="choice-card" type="submit" name="bot_id" value="${htmlEscape(bot.id)}">
      <span class="choice-icon bot-icon">${botIcon()}</span>
      <span class="choice-copy"><strong>${htmlEscape(bot.name)}</strong><small>${sameAuthorization ? "已完成身份验证，可直接连接" : "授权此 Bot 并添加到 MCP"}</small></span>
      <span class="choice-arrow">${arrowIcon()}</span>
    </button>`;
  }).join("\n");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>选择 Bot</title>
    <style>${oauthPageStyles()}</style></head><body><main class="panel">
      <div class="brand"><span class="brand-mark">${sparkIcon()}</span><span>COUNSO <em>LARK MCP</em></span></div>
      <div class="eyebrow">ORGANIZATION VERIFIED</div><h1>选择要添加到 MCP 的 Bot</h1>
      <p class="subtitle"><span class="org-pill">${buildingIcon()} ${htmlEscape(organization.platform_label)} · ${htmlEscape(organization.name)}</span> 选择一个 Bot 继续。</p>
      <form method="post" action="/oauth/lark/select"><input type="hidden" name="selection_token" value="${htmlEscape(selectionToken)}"><div class="choices">${rows || '<div class="empty">该组织还没有配置 Bot。</div>'}</div></form>
      <footer>Protected by COUNSO Lark MCP</footer>
    </main></body></html>`;
}

function sparkIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l1.7 7.3L21 11l-7.3 1.7L12 20l-1.7-7.3L3 11l7.3-1.7L12 2z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';
}

function platformLogoIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M12.9238 12.8029C12.9427 12.784 12.9616 12.7682 12.9806 12.7493C13.0184 12.7146 13.0563 12.6767 13.091 12.6389L13.1667 12.5631L13.397 12.336L14.7315 11.0173L15.0659 10.686C15.129 10.6229 15.1952 10.563 15.2615 10.5031C15.3845 10.3926 15.5076 10.2854 15.6369 10.1813C15.7536 10.0866 15.8767 9.99514 15.9997 9.9068C16.1732 9.78376 16.3499 9.67019 16.5329 9.55977C16.7127 9.45251 16.8957 9.35471 17.085 9.26322C17.2616 9.17804 17.4415 9.09917 17.6276 9.02661C17.7317 8.9856 17.8326 8.94774 17.9399 8.91304C17.9935 8.89411 18.044 8.87834 18.0977 8.86256C17.6276 7.00439 16.7632 5.3008 15.5991 3.84959C15.3719 3.56566 15.0249 3.40161 14.6589 3.40161H5.0084C4.83489 3.40161 4.76233 3.6256 4.90114 3.72656C8.18528 6.13997 10.9236 9.24114 12.9017 12.825C12.908 12.8187 12.9175 12.8124 12.9238 12.8029Z" fill="#00D6B9"/><path d="M9.09696 21.2986C14.0815 21.2986 18.4225 18.5476 20.6877 14.4843C20.7666 14.3423 20.8454 14.1972 20.918 14.052C20.8044 14.2729 20.6751 14.4811 20.5394 14.6767C20.4889 14.7461 20.4385 14.8155 20.388 14.8818C20.3217 14.9669 20.2555 15.049 20.1861 15.1278C20.1324 15.1909 20.0757 15.2509 20.0189 15.3108C19.9021 15.4307 19.7823 15.5474 19.6561 15.6547C19.5867 15.7146 19.5141 15.7714 19.4415 15.8282C19.3564 15.8944 19.268 15.9575 19.1797 16.0143C19.1229 16.0522 19.0661 16.09 19.0093 16.1247C18.9494 16.1626 18.8895 16.1973 18.8264 16.232C18.7002 16.3014 18.574 16.3645 18.4446 16.4245C18.3311 16.4749 18.2175 16.5223 18.1008 16.5633C17.9746 16.6106 17.8452 16.6516 17.7159 16.6863C17.5234 16.7399 17.3247 16.7809 17.1259 16.8125C16.9808 16.8346 16.8357 16.8504 16.6874 16.863C16.5328 16.8724 16.3751 16.8787 16.2173 16.8756C16.0438 16.8724 15.8703 16.863 15.6936 16.844C15.5643 16.8314 15.435 16.8125 15.3056 16.7873C15.192 16.7683 15.0785 16.7431 14.9649 16.7178C14.9049 16.7021 14.845 16.6895 14.7851 16.6737C14.6179 16.6295 14.4538 16.5822 14.2898 16.5349C14.2077 16.5096 14.1257 16.4875 14.0437 16.4623C13.9206 16.4245 13.7977 16.3897 13.6777 16.3519C13.5768 16.3203 13.479 16.2888 13.378 16.2572C13.2834 16.2257 13.1887 16.1942 13.0941 16.1626C13.031 16.1405 12.9647 16.1184 12.9016 16.0964C12.8228 16.0711 12.7471 16.0427 12.6682 16.0143C12.6114 15.9954 12.5578 15.9765 12.501 15.9544C12.3906 15.9134 12.2802 15.8755 12.1729 15.8345C12.1098 15.8093 12.0467 15.7872 11.9836 15.7619C11.8984 15.7304 11.8132 15.6957 11.7312 15.6641C11.6429 15.6294 11.5514 15.5947 11.4631 15.5569C11.4063 15.5348 11.3463 15.5096 11.2895 15.4875C11.217 15.4591 11.1476 15.4275 11.075 15.3991C11.0214 15.3771 10.9646 15.3518 10.911 15.3297C10.8542 15.3045 10.7974 15.2793 10.7406 15.254C10.6901 15.2319 10.6428 15.2099 10.5923 15.1878C10.5482 15.1688 10.5008 15.1468 10.4567 15.1278C10.4094 15.1057 10.3652 15.0868 10.3179 15.0647C10.2705 15.0427 10.2232 15.0206 10.1759 14.9985C10.116 14.9701 10.056 14.9417 9.99608 14.9165C9.93299 14.8881 9.87304 14.8565 9.80995 14.8281C9.7437 14.7966 9.67745 14.765 9.6112 14.7303C9.55441 14.7019 9.49762 14.6735 9.44084 14.6483C6.45324 13.1592 3.80321 11.1717 1.54438 8.76145C1.43081 8.64157 1.23206 8.72044 1.23206 8.88449L1.23836 18.0933C1.23836 18.494 1.43712 18.8726 1.77153 19.0934C3.86631 20.4878 6.38699 21.2986 9.09696 21.2986Z" fill="#3370FF"/><path d="M23.7322 9.29488C22.7226 8.79642 21.5838 8.5188 20.3818 8.5188C19.6688 8.5188 18.9747 8.6166 18.3217 8.80273C18.246 8.82481 18.1703 8.8469 18.0977 8.86898C18.0441 8.88476 17.9905 8.90368 17.94 8.91946C17.8359 8.95416 17.7318 8.99202 17.6276 9.03303C17.4447 9.10559 17.2617 9.18446 17.085 9.26964C16.8957 9.36113 16.7128 9.45893 16.5329 9.56619C16.35 9.67345 16.1701 9.79018 15.9998 9.91322C15.8767 10.0016 15.7569 10.093 15.637 10.1877C15.5076 10.2918 15.3846 10.3991 15.2616 10.5095C15.1953 10.5694 15.1322 10.6325 15.066 10.6925L14.7315 11.0206L13.3939 12.3424L13.1636 12.5696L13.0879 12.6453C13.05 12.6831 13.0122 12.7178 12.9775 12.7557C12.9586 12.7746 12.9396 12.7904 12.9207 12.8093C12.8923 12.8377 12.8639 12.863 12.8355 12.8882C12.804 12.9166 12.7724 12.9481 12.7409 12.9765C11.9143 13.7368 10.9931 14.3899 9.99304 14.923C10.053 14.9514 10.1129 14.9798 10.1729 15.0051C10.2202 15.0271 10.2675 15.0492 10.3148 15.0713C10.359 15.0934 10.4063 15.1123 10.4536 15.1344C10.4978 15.1533 10.5451 15.1754 10.5893 15.1943C10.6398 15.2164 10.6871 15.2385 10.7376 15.2606C10.7944 15.2858 10.8511 15.3111 10.9079 15.3363C10.9616 15.3584 11.0184 15.3836 11.072 15.4057C11.1445 15.4373 11.2139 15.4657 11.2865 15.4941C11.3433 15.5193 11.4032 15.5414 11.46 15.5635C11.5484 15.5982 11.6367 15.636 11.7282 15.6707C11.8134 15.7023 11.8954 15.737 11.9806 15.7685C12.0437 15.7938 12.1068 15.8158 12.1699 15.8411C12.2803 15.8821 12.3875 15.9231 12.498 15.961C12.5547 15.9799 12.6084 16.002 12.6652 16.0209C12.744 16.0493 12.8197 16.0745 12.8986 16.1029C12.9617 16.125 13.028 16.1471 13.0911 16.1692C13.1857 16.2007 13.2803 16.2323 13.375 16.2638C13.4728 16.2954 13.5737 16.3269 13.6747 16.3585C13.7977 16.3963 13.9176 16.4342 14.0406 16.4689C14.1227 16.4941 14.2047 16.5162 14.2867 16.5414C14.4508 16.5888 14.618 16.6361 14.782 16.6803C14.842 16.696 14.9019 16.7118 14.9618 16.7244C15.0754 16.7528 15.189 16.7749 15.3026 16.7938C15.4319 16.8159 15.5613 16.8348 15.6906 16.8506C15.8673 16.8695 16.0408 16.8822 16.2143 16.8822C16.372 16.8853 16.5298 16.879 16.6844 16.8695C16.8326 16.8601 16.9778 16.8412 17.1229 16.8191C17.3248 16.7875 17.5204 16.7465 17.7128 16.6929C17.8422 16.6582 17.9715 16.6172 18.0977 16.5698C18.2144 16.5257 18.328 16.4815 18.4416 16.4279C18.5709 16.3679 18.7003 16.3048 18.8233 16.2354C18.8833 16.2007 18.9464 16.166 19.0063 16.1282C19.0631 16.0935 19.1199 16.0556 19.1767 16.0178C19.265 15.9578 19.3533 15.8947 19.4385 15.8316C19.5111 15.7748 19.5836 15.718 19.653 15.6581C19.7792 15.5508 19.8991 15.4341 20.0158 15.3142C20.0726 15.2543 20.1294 15.1943 20.183 15.1313C20.2524 15.0524 20.3187 14.9704 20.3849 14.8852C20.4354 14.8189 20.4859 14.7495 20.5364 14.6801C20.672 14.4845 20.7982 14.2763 20.9118 14.0586L21.0411 13.7999L22.2084 11.4748L22.2053 11.4812C22.5807 10.6578 23.1012 9.91953 23.7322 9.29488Z" fill="#133C9A"/></svg>';
}

function buildingIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 21V5l8-3 8 3v16M8 8h1m3 0h1m3 0h1M8 12h1m3 0h1m3 0h1M8 16h1m3 0h1m3 0h1M10 21v-3h4v3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

function botIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="6" width="16" height="13" rx="4" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 3v3M8 12h.01M16 12h.01M9 16h6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
}

function searchIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M16 16l5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
}

function arrowIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

function oauthPageStyles() {
  return `:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#f5f9ff;color:#10233f;font:15px/1.5 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background-image:linear-gradient(rgba(40,112,214,.045) 1px,transparent 1px),linear-gradient(90deg,rgba(40,112,214,.045) 1px,transparent 1px);background-size:32px 32px;display:flex;align-items:center;justify-content:center;padding:28px}.panel{width:min(100%,650px);background:rgba(255,255,255,.94);border:1px solid #dce9f8;border-radius:24px;padding:34px 36px 24px;box-shadow:0 24px 70px rgba(28,82,145,.14)}.brand{display:flex;align-items:center;gap:10px;color:#1264c7;font-size:13px;font-weight:800;letter-spacing:.12em}.brand em{color:#8aa2bf;font-style:normal;font-size:10px;letter-spacing:.1em;margin-left:4px}.brand-mark{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;color:#fff;background:linear-gradient(135deg,#1677e8,#49b7ff);box-shadow:0 7px 18px rgba(24,117,224,.25)}svg{width:20px;height:20px}.brand-mark svg{width:17px}.eyebrow{margin-top:48px;color:#4e91da;font-size:11px;font-weight:800;letter-spacing:.18em}h1{margin:8px 0 10px;font-size:29px;line-height:1.2;letter-spacing:-.03em;color:#102b50}.subtitle{margin:0 0 20px;color:#6d819b}.platform-tabs{display:flex;gap:8px;padding:4px;margin-bottom:16px;border:1px solid #dce9f8;border-radius:14px;background:#f5f9ff}.platform-tab{flex:1;display:flex;align-items:center;justify-content:center;gap:8px;height:42px;border:0;border-radius:10px;background:transparent;color:#7c91aa;font-weight:700;cursor:pointer;transition:.2s}.platform-tab.active{background:#fff;color:#1767c7;box-shadow:0 4px 12px rgba(44,105,175,.12)}.platform-mark{display:grid;place-items:center;width:28px;height:28px;border-radius:8px;background:#fff}.platform-mark svg{width:25px;height:25px}.search{height:48px;display:flex;align-items:center;gap:10px;padding:0 15px;border:1px solid #d6e5f6;border-radius:13px;background:#f8fbff;color:#7aa3cf;transition:.2s}.search:focus-within{border-color:#50a4ef;box-shadow:0 0 0 4px rgba(54,145,232,.1);background:#fff}.search svg{width:19px}.search input{width:100%;border:0;outline:0;background:transparent;color:#193554;font-size:15px}.search input::placeholder{color:#9aafc7}.choices{display:grid;gap:10px;margin-top:16px}.choice-card{width:100%;display:flex;align-items:center;gap:14px;padding:15px 16px;border:1px solid #dfebf8;border-radius:15px;background:#fff;color:#183454;text-align:left;cursor:pointer;transition:transform .18s,box-shadow .18s,border-color .18s}.choice-card:hover{transform:translateY(-2px);border-color:#80b9ed;box-shadow:0 10px 24px rgba(42,112,184,.12)}.choice-icon{flex:0 0 42px;width:42px;height:42px;display:grid;place-items:center;border-radius:12px;color:#1976d2;background:#eaf4ff}.bot-icon{color:#725ce6;background:#f0edff}.choice-copy{min-width:0;display:flex;flex-direction:column;gap:2px}.choice-copy strong{font-size:15px;color:#183454}.choice-copy small{color:#8295ab;font-size:12px}.choice-arrow{margin-left:auto;color:#78a6d2}.choice-arrow svg{width:19px}.org-pill{display:inline-flex;align-items:center;gap:6px;color:#2877c5;background:#eef7ff;border:1px solid #d8ebfc;border-radius:999px;padding:5px 10px;font-size:13px}.org-pill svg{width:16px}.empty{padding:24px;text-align:center;border:1px dashed #cddff2;border-radius:14px;color:#8295ab;background:#fafdff}.hidden{display:none!important}footer{margin-top:28px;color:#a1b2c5;font-size:11px;letter-spacing:.05em;text-align:center}@media(max-width:560px){body{padding:14px}.panel{padding:26px 20px 20px;border-radius:18px}.eyebrow{margin-top:34px}h1{font-size:25px}}`;
}

function createLarkOAuthUrl({ state, userId = "", botId = "" }) {
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
}

function escapeXmlText(value) {
  return value.replace(/[<>&'\"]/g, (character) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    '\"': "&quot;",
  })[character]);
}

async function larkGet(path, connectionId = "", identity = "bot") {
  const token = await getAccessToken(connectionId, identity);
  const provider = getConnectionProvider(connectionId);
  const response = await fetch(`${provider.apiBaseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJson(response);
}

async function larkRequest(path, method, body, connectionId = "", identity = "bot") {
  const token = await getAccessToken(connectionId, identity);
  const provider = getConnectionProvider(connectionId);
  const response = await fetch(`${provider.apiBaseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return parseJson(response);
}

async function larkGetBuffer(path, connectionId = "", identity = "bot") {
  const token = await getAccessToken(connectionId, identity);
  const provider = getConnectionProvider(connectionId);
  const response = await fetch(`${provider.apiBaseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Lark download error ${response.status}: ${text.slice(0, 300)}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function wikiTokenFromInput(input) {
  if (input.startsWith("http://") || input.startsWith("https://")) {
    const url = new URL(input);
    const match = url.pathname.match(/\/wiki\/([^/]+)/);
    if (!match) throw new Error("The URL is not a Lark wiki URL");
    return match[1];
  }
  return input;
}

function docTokenFromInput(input) {
  if (input.startsWith("http://") || input.startsWith("https://")) {
    const url = new URL(input);
    const match = url.pathname.match(/\/(?:docx|docs)\/([^/]+)/);
    if (!match) throw new Error("The URL is not a Lark docx/docs URL");
    return match[1];
  }
  return input;
}

async function readWikiDocument(input, connectionId = "") {
  const nodeToken = wikiTokenFromInput(input);
  const nodeBody = await larkGet(`/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(nodeToken)}`, connectionId);
  const node = nodeBody.data.node;
  if (node.obj_type !== "docx") {
    throw new Error(`This wiki node contains ${node.obj_type}; only docx pages are supported in this first version`);
  }

  const query = new URLSearchParams({
    doc_token: node.obj_token,
    doc_type: node.obj_type,
    content_type: "markdown",
    lang: "en",
  });
  const contentBody = await larkGet(`/open-apis/docs/v1/content?${query}`, connectionId);
  return {
    title: node.title,
    wiki_token: node.node_token,
    document_token: node.obj_token,
    document_type: node.obj_type,
    source_url:
      input.startsWith("http://") || input.startsWith("https://")
        ? input
        : `${getConnectionWebBaseUrl(connectionId)}/wiki/${node.node_token}`,
    content: contentBody.data.content,
    updated_at: node.obj_edit_time,
  };
}

async function listWikiSpaces(pageToken = "", pageSize = 50, connectionId = "") {
  const query = new URLSearchParams({ page_size: String(Math.min(Math.max(pageSize, 1), 50)) });
  if (pageToken) query.set("page_token", pageToken);
  const body = await larkGet(`/open-apis/wiki/v2/spaces?${query}`, connectionId);
  return body.data;
}

async function listWikiNodes(spaceId, parentNodeToken = "", pageToken = "", pageSize = 50, connectionId = "") {
  const query = new URLSearchParams({ page_size: String(Math.min(Math.max(pageSize, 1), 50)) });
  if (parentNodeToken) query.set("parent_node_token", parentNodeToken);
  if (pageToken) query.set("page_token", pageToken);
  const body = await larkGet(`/open-apis/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes?${query}`, connectionId);
  return body.data;
}

async function listAllWikiDocuments(spaces, maxNodes = 200, connectionId = "") {
  const queue = (spaces.items ?? []).map((space) => ({
    space,
    parentNodeToken: "",
    parentPath: [],
  }));
  const visited = new Set();
  const documents = [];

  while (queue.length && documents.length < maxNodes) {
    const current = queue.shift();
    let pageToken = "";
    do {
      const page = await listWikiNodes(current.space.space_id, current.parentNodeToken, pageToken, 50, connectionId);
      for (const node of page.items ?? []) {
        if (documents.length >= maxNodes) break;
        const nodeKey = `${current.space.space_id}:${node.node_token}`;
        if (visited.has(nodeKey)) continue;
        visited.add(nodeKey);
        const item = {
          ...node,
          title: node.title ?? node.obj_title ?? node.node_token,
          document_token: node.obj_token ?? null,
          document_type: node.obj_type ?? null,
          source_url: `${getConnectionWebBaseUrl(connectionId)}/wiki/${node.node_token}`,
          document_origin: "wiki_node",
          belongs_to_wiki: true,
          wiki_space_id: current.space.space_id,
          wiki_space_name: current.space.name ?? current.space.title ?? current.space.space_id,
          parent_node_token: current.parentNodeToken || null,
          parent_path: current.parentPath,
          summary: metadataSummary(node),
        };
        documents.push(item);
        if (node.has_child) {
          queue.push({
            space: current.space,
            parentNodeToken: node.node_token,
            parentPath: [...current.parentPath, item.title],
          });
        }
      }
      pageToken = page.has_more ? page.next_page_token ?? "" : "";
    } while (pageToken && documents.length < maxNodes);
  }

  return {
    documents,
    count: documents.length,
    truncated: documents.length >= maxNodes || queue.length > 0,
    scanned_nodes: visited.size,
  };
}

async function readLarkDocument(input, connectionId = "", identity = "bot") {
  const token = docTokenFromInput(input);
  const query = new URLSearchParams({
    doc_token: token,
    doc_type: "docx",
    content_type: "markdown",
    lang: "en",
  });
  const body = await larkGet(`/open-apis/docs/v1/content?${query}`, connectionId, identity);
  return {
    document_token: token,
    document_type: "docx",
    source_url:
      input.startsWith("http://") || input.startsWith("https://")
        ? input
        : `${getConnectionWebBaseUrl(connectionId)}/docx/${token}`,
    content: body.data.content,
  };
}

async function listDriveFiles(folderToken = "", pageToken = "", pageSize = 50, connectionId = "", identity = "bot") {
  const query = new URLSearchParams({
    page_size: String(Math.min(Math.max(pageSize, 1), 200)),
    order_by: "EditedTime",
    direction: "DESC",
  });
  if (folderToken) query.set("folder_token", folderToken);
  if (pageToken) query.set("page_token", pageToken);
  const body = await larkGet(`/open-apis/drive/v1/files?${query}`, connectionId, identity);
  return body.data;
}

async function ensureDefaultOutputFolder(connectionId = "") {
  const bot = getConnectionBot(connectionId);
  if (bot.outputFolderToken) return bot.outputFolderToken;
  const root = await listDriveFiles("", "", 200, connectionId, "bot");
  const existing = (root.files ?? []).find((file) =>
    file.name === defaultOutputFolderName && (file.type === "folder" || file.file_type === "folder"),
  );
  if (existing?.token) return existing.token;
  const created = await larkRequest(
    "/open-apis/drive/v1/files/create_folder",
    "POST",
    { name: defaultOutputFolderName, folder_token: "" },
    connectionId,
    "bot",
  );
  const data = created.data ?? created;
  if (!data.token) throw new Error(`Unable to create default folder ${defaultOutputFolderName}`);
  return data.token;
}

async function resolveUserFolderToken(folderToken = "", folderName = "", connectionId = "") {
  if (folderToken) return folderToken;
  if (!folderName) throw new Error("storage_target=user_folder requires folder_token or folder_name");
  const root = await listDriveFiles("", "", 200, connectionId, "user");
  const matches = (root.files ?? []).filter((file) =>
    file.name === folderName && (file.type === "folder" || file.file_type === "folder"),
  );
  if (matches.length === 1) return matches[0].token;
  if (matches.length > 1) throw new Error(`当前用户网盘中存在多个名为“${folderName}”的文件夹，请提供 folder_token`);
  throw new Error(`当前用户网盘根目录中找不到文件夹“${folderName}”`);
}

async function listAllDriveFiles(folderToken = "", maxFiles = 2000, connectionId = "") {
  const queue = [{ token: folderToken, path: [] }];
  const visitedFolders = new Set();
  const files = [];

  while (queue.length > 0 && files.length < maxFiles) {
    const current = queue.shift();
    const folderKey = current.token || "__root__";
    if (visitedFolders.has(folderKey)) continue;
    visitedFolders.add(folderKey);

    let pageToken = "";
    do {
      const page = await listDriveFiles(current.token, pageToken, 200, connectionId);
      for (const file of page.files ?? []) {
        const item = {
          ...file,
          source_url: `${getConnectionWebBaseUrl(connectionId)}/drive/file/${file.token}`,
          folder_token: current.token || null,
          folder_path: current.path,
          summary: metadataSummary(file),
        };
        const isFolder = file.type === "folder" || file.file_type === "folder";
        if (isFolder) {
          queue.push({ token: file.token, path: [...current.path, file.name ?? file.token] });
        } else {
          files.push(item);
          if (files.length >= maxFiles) break;
        }
      }
      pageToken = page.has_more ? page.next_page_token ?? "" : "";
    } while (pageToken && files.length < maxFiles);
  }

  return {
    folder_token: folderToken || null,
    files,
    count: files.length,
    truncated: files.length >= maxFiles,
    scanned_folders: visitedFolders.size,
  };
}

function extensionFor(name = "") {
  const match = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] ?? "";
}

function parseSpreadsheet(buffer, fileName) {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheets = workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    return `## ${name}\n\n${XLSX.utils.sheet_to_csv(sheet)}`;
  });
  return { file_name: fileName, format: "spreadsheet", content: sheets.join("\n\n") };
}

async function readLarkFile(fileToken, fileName = "", mimeType = "", metadata = {}, connectionId = "") {
  const buffer = await larkGetBuffer(`/open-apis/drive/v1/files/${encodeURIComponent(fileToken)}/download`, connectionId);
  const name = fileName || fileToken;
  const extension = extensionFor(name);
  const normalizedMime = mimeType.toLowerCase();

  if (buffer.length > 25 * 1024 * 1024) {
    throw new Error("File is larger than the 25 MB text-extraction limit");
  }

  if (extension === "pdf" || normalizedMime.includes("pdf")) {
    const parsed = await pdfParse(buffer);
    return {
      file_token: fileToken,
      file_name: name,
      format: "pdf",
      pages: parsed.numpages,
      source_url: metadata.source_url ?? `${getConnectionWebBaseUrl(connectionId)}/drive/file/${fileToken}`,
      ...metadata,
      content: parsed.text,
    };
  }
  if (["docx", "doc"].includes(extension) || normalizedMime.includes("wordprocessingml")) {
    const parsed = await mammoth.extractRawText({ buffer });
    return {
      file_token: fileToken,
      file_name: name,
      format: extension || "docx",
      source_url: metadata.source_url ?? `${getConnectionWebBaseUrl(connectionId)}/drive/file/${fileToken}`,
      ...metadata,
      content: parsed.value,
    };
  }
  if (["xlsx", "xls", "csv"].includes(extension) || normalizedMime.includes("spreadsheet")) {
    return {
      file_token: fileToken,
      ...parseSpreadsheet(buffer, name),
      source_url: metadata.source_url ?? `${getConnectionWebBaseUrl(connectionId)}/drive/file/${fileToken}`,
      ...metadata,
    };
  }
  if (extension === "txt" || extension === "md" || normalizedMime.startsWith("text/")) {
    return {
      file_token: fileToken,
      file_name: name,
      format: extension || "text",
      source_url: metadata.source_url ?? `${getConnectionWebBaseUrl(connectionId)}/drive/file/${fileToken}`,
      ...metadata,
      content: buffer.toString("utf8"),
    };
  }

  return {
    file_token: fileToken,
    file_name: name,
    mime_type: mimeType || "unknown",
    format: "unsupported",
    source_url: metadata.source_url ?? `${getConnectionWebBaseUrl(connectionId)}/drive/file/${fileToken}`,
    ...metadata,
    content: "该文件已下载，但当前版本暂不支持提取其文本内容。",
  };
}

function summarizeText(value = "", maxLength = 320) {
  const text = String(value)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~\[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength).trimEnd()}…` : text;
}

function metadataSummary(item = {}) {
  return summarizeText(item.summary ?? item.description ?? item.excerpt ?? item.name ?? "");
}

function permissionTypeForDocument(item = {}) {
  const sourceUrl = item.source_url ?? item.url ?? "";
  if (sourceUrl.includes("/wiki/")) return "docx";
  const rawType = item.document_type ?? item.file_type ?? item.type ?? item.format ?? "docx";
  const type = Array.isArray(rawType) ? rawType[0] : rawType;
  if (["doc", "docx", "sheet", "file", "bitable"].includes(type)) return type;
  return "docx";
}

function permissionAllowed(body) {
  const data = body?.data ?? body;
  if (typeof data === "boolean") return data;
  return Boolean(data?.permitted ?? data?.is_permitted ?? data?.allowed);
}

async function checkLarkDocumentPermission(documentToken, documentType, connectionId = "") {
  if (!documentToken) {
    return {
      can_read: null,
      can_edit: null,
      permission_status: "unknown",
      permission_text: "无法确认 Bot 权限：缺少文档 token",
    };
  }

  const result = {
    can_read: null,
    can_edit: null,
    permission_status: "unknown",
    permission_text: "无法确认 Bot 权限",
    permission_type: documentType,
  };
  try {
    const [viewBody, editBody] = await Promise.all([
      larkRequest("/open-apis/drive/permission/member/permitted", "POST", {
        token: documentToken,
        type: documentType,
        perm: "view",
      }, connectionId),
      larkRequest("/open-apis/drive/permission/member/permitted", "POST", {
        token: documentToken,
        type: documentType,
        perm: "edit",
      }, connectionId),
    ]);
    result.can_read = permissionAllowed(viewBody);
    result.can_edit = permissionAllowed(editBody);
    result.permission_status = result.can_edit ? "read_write" : result.can_read ? "read_only" : "no_access";
    result.permission_text = result.can_edit
      ? "Bot 有权限阅读和编辑"
      : result.can_read
        ? "Bot 有权限阅读，但没有编辑权限"
        : "Bot 没有阅读权限，也没有编辑权限";
  } catch (error) {
    result.permission_error = error.message;
  }
  return result;
}

async function enrichDocumentPermissions(items, connectionId = "", maxChecks = 20) {
  const cache = new Map();
  let checked = 0;
  return Promise.all(items.map(async (item) => {
    const token = item.document_token ?? item.token ?? item.file_token;
    if (!token || checked >= maxChecks) return item;
    const type = permissionTypeForDocument(item);
    const cacheKey = `${type}:${token}`;
    if (!cache.has(cacheKey)) {
      checked += 1;
      cache.set(cacheKey, checkLarkDocumentPermission(token, type, connectionId));
    }
    return { ...item, permission: await cache.get(cacheKey) };
  }));
}

async function searchWikiTitles(query, maxResults = 20, maxNodes = 500, connectionId = "") {
  const spaces = await listWikiSpaces("", 50, connectionId);
  const results = [];
  let visited = 0;
  const walk = async (spaceId, parentNodeToken = "") => {
    if (visited >= maxNodes || results.length >= maxResults) return;
    const page = await listWikiNodes(spaceId, parentNodeToken, "", 50, connectionId);
    for (const node of page.items ?? []) {
      visited += 1;
      if ((node.title ?? "").toLowerCase().includes(query.toLowerCase())) results.push(node);
      if (node.has_child) await walk(spaceId, node.node_token);
      if (visited >= maxNodes || results.length >= maxResults) return;
    }
  };
  for (const space of spaces.items ?? []) await walk(space.space_id);
  return { query, results, scanned_nodes: visited, truncated: visited >= maxNodes };
}

async function searchDriveFileNames(query, folderToken = "", pageSize = 200, connectionId = "") {
  const page = await listDriveFiles(folderToken, "", pageSize, connectionId);
  const needle = query.toLowerCase();
  return {
    query,
    folder_token: folderToken || null,
    results: (page.files ?? []).filter((file) => (file.name ?? "").toLowerCase().includes(needle)),
    has_more: page.has_more ?? false,
    next_page_token: page.next_page_token ?? null,
  };
}

function stripHighlightTags(value = "") {
  return value.replace(/<\/?h>/g, "");
}

function tokenFromLarkUrl(value = "") {
  const match = value.match(/\/(?:docx|docs|wiki|sheets|base)\/([^/?#]+)/);
  return match?.[1] ?? null;
}

async function searchLarkDocuments(query = "", pageToken = "", pageSize = 20, connectionId = "") {
  const body = {
    query: query.slice(0, 30),
    page_size: Math.min(Math.max(pageSize, 1), 20),
    doc_filter: {},
    wiki_filter: {},
  };
  if (pageToken) body.page_token = pageToken;

  const response = await larkRequest("/open-apis/search/v2/doc_wiki/search", "POST", body, connectionId);
  const data = response.data ?? response;
  const results = (data.res_units ?? []).map((item) => {
    const metadata = item.result_meta ?? {};
    const sourceUrl = metadata.url ?? item.url ?? null;
    return {
      title: stripHighlightTags(item.title_highlighted ?? item.title ?? ""),
      document_type: metadata.doc_types ?? item.entity_type ?? null,
      document_token: metadata.token ?? item.token ?? (sourceUrl ? tokenFromLarkUrl(sourceUrl) : null),
      source_url: sourceUrl,
      updated_at: metadata.update_time_iso ?? metadata.update_time ?? null,
      summary: stripHighlightTags(item.summary_highlighted ?? item.summary ?? ""),
      raw: item,
    };
  });

  return {
    query: body.query,
    results,
    count: results.length,
    has_more: Boolean(data.has_more),
    next_page_token: data.page_token ?? null,
    total: data.total ?? null,
    identity: "bot_application",
    note: body.query
      ? "结果来自 Bot 可访问的云文档搜索索引；单独分享给 Bot 的个人空间文档可能不会出现在索引中"
      : "空关键词浏览 Bot 可访问的云文档搜索索引；结果可能需要继续翻页，且不保证覆盖所有单独分享的个人空间文档",
  };
}

async function inventoryLarkDocuments({ mode = "preview", query = "", maxItems = 20, maxFiles = 100, maxWikiNodes = 200, connectionId = "" }) {
  const search = await searchLarkDocuments(query, "", Math.min(maxItems, 20), connectionId);
  const wikiSpaces = await listWikiSpaces("", 50, connectionId);
  const bot = getConnectionBot(connectionId);
  const driveSources = [await listAllDriveFiles("", Math.min(maxFiles, 200), connectionId)];
  if (bot.outputFolderToken) {
    const sharedFolder = await listAllDriveFiles(bot.outputFolderToken, Math.min(maxFiles, 200), connectionId);
    sharedFolder.files = (sharedFolder.files ?? []).map((file) => ({
      ...file,
      folder_path: [defaultOutputFolderName, ...(file.folder_path ?? [])],
    }));
    driveSources.push(sharedFolder);
  }
  const drive = {
    files: [...new Map(driveSources.flatMap((source) => source.files ?? []).map((file) => [file.token, file])).values()]
      .slice(0, Math.min(maxFiles, 200)),
    truncated: driveSources.some((source) => source.truncated),
    scanned_folders: [...new Set(driveSources.flatMap((source) => source.scanned_folders ?? []))],
  };
  const wikiInventory = await listAllWikiDocuments(wikiSpaces, Math.min(maxWikiNodes, 500), connectionId);
  let wikiDocuments = wikiInventory.documents;
  let searchResults = search.results.map((item) => ({
    ...item,
    summary: metadataSummary(item),
    document_origin: item.source_url?.includes("/wiki/") ? "wiki_search_index" : "bot_search_index",
    belongs_to_wiki: item.source_url?.includes("/wiki/") ?? false,
  }));
  let driveFiles = drive.files.map((file) => ({
    ...file,
    summary: metadataSummary(file),
    document_origin: "bot_drive",
    belongs_to_wiki: false,
  }));
  searchResults = await enrichDocumentPermissions(searchResults, connectionId, Math.min(maxItems, 20));
  driveFiles = await enrichDocumentPermissions(driveFiles, connectionId, Math.min(maxItems, 20));
  wikiDocuments = await enrichDocumentPermissions(wikiDocuments, connectionId, Math.min(maxWikiNodes, 100));

  if (mode !== "metadata") {
    let readCount = 0;
    for (const item of wikiDocuments) {
      if (item.document_type !== "docx" || !item.document_token || readCount >= Math.min(maxItems, 20)) continue;
      try {
        const document = await readWikiDocument(item.source_url, connectionId);
        item.summary = summarizeText(document.content);
        if (mode === "content") item.content = document.content;
      } catch (error) {
        item.summary_error = error.message;
      }
      readCount += 1;
    }
  }

  const wikiTokens = new Set(wikiDocuments.map((item) => item.document_token).filter(Boolean));
  const botDocuments = [...searchResults, ...driveFiles]
    .filter((item) => !item.document_token || !wikiTokens.has(item.document_token));
  const permissionItems = [...searchResults, ...driveFiles]
    .map((item) => item.permission)
    .concat(wikiDocuments.map((item) => item.permission))
    .filter(Boolean);
  const result = {
    mode,
    identity: "bot_application",
    include_summary: true,
    search_results: searchResults,
    search_has_more: search.has_more,
    search_next_page_token: search.next_page_token,
    bot_documents: botDocuments,
    wiki_documents: wikiDocuments,
    wiki_spaces: (wikiSpaces.items ?? []).map((space) => ({
      ...space,
      summary: metadataSummary(space),
    })),
    drive_files: driveFiles,
    drive_truncated: drive.truncated,
    scanned_folders: drive.scanned_folders,
    wiki_truncated: wikiInventory.truncated,
    permission_summary: {
      checked: permissionItems.length,
      readable: permissionItems.filter((item) => item.can_read === true).length,
      editable: permissionItems.filter((item) => item.can_edit === true).length,
      read_only: permissionItems.filter((item) => item.permission_status === "read_only").length,
      unknown: permissionItems.filter((item) => item.permission_status === "unknown").length,
    },
    note: "这是一次只读聚合检索。搜索索引和 Drive 列表可能遗漏个人空间中单独分享的文档；如用户提供 URL，应直接调用读取工具验证权限。",
  };

  if (mode === "metadata") return result;

  const candidates = searchResults
    .filter((item) => item.source_url && (item.source_url.includes("/wiki/") || item.source_url.includes("/docx/") || item.source_url.includes("/docs/")))
    .slice(0, Math.min(maxItems, 10));
  const contents = [];
  for (const item of candidates) {
    try {
      const document = item.source_url.includes("/wiki/")
        ? await readWikiDocument(item.source_url, connectionId)
        : await readLarkDocument(item.source_url, connectionId);
      contents.push({
        title: document.title ?? item.title,
        source_url: document.source_url ?? item.source_url,
        document_token: document.document_token,
        summary: summarizeText(document.content),
        content: mode === "preview" ? document.content.slice(0, 1000) : document.content,
        truncated: mode === "preview" || document.content.length > 100000,
      });
    } catch (error) {
      contents.push({ title: item.title, source_url: item.source_url, error: error.message });
    }
  }
  if (mode === "preview" || mode === "content") {
    const fileLimit = Math.min(driveFiles.length, Math.min(maxItems, 10));
    for (const file of driveFiles.slice(0, fileLimit)) {
      if (!file.token || file.type === "folder" || file.file_type === "folder") continue;
      try {
        const document = await readLarkFile(file.token, file.name, file.mime_type ?? file.mimeType ?? "", file, connectionId);
        file.summary = summarizeText(document.content);
        if (mode === "content") file.content = document.content;
      } catch (error) {
        file.summary_error = error.message;
      }
    }
  }
  result.contents = contents;
  return result;
}

function driveTokenFromInput(input) {
  if (input.startsWith("http://") || input.startsWith("https://")) {
    const match = new URL(input).pathname.match(/\/drive\/file\/([^/]+)/);
    if (!match) throw new Error("The URL is not a supported Lark Drive file URL");
    return match[1];
  }
  return input;
}

async function readLarkResource(input, mode = "preview", connectionId = "") {
  const value = input.trim();
  let document;
  if (value.includes("/wiki/")) {
    document = await readWikiDocument(value, connectionId);
  } else if (value.includes("/docx/") || value.includes("/docs/")) {
    document = await readLarkDocument(value, connectionId);
  } else {
    const token = driveTokenFromInput(value);
    document = await readLarkFile(token, "", "", { source_url: value }, connectionId);
  }

  const permission = await checkLarkDocumentPermission(
    document.document_token ?? document.file_token,
    permissionTypeForDocument(document),
    connectionId,
  );
  return {
    title: document.title ?? document.file_name ?? null,
    source_url: document.source_url ?? value,
    document_token: document.document_token ?? document.file_token ?? null,
    document_type: document.document_type ?? document.format ?? null,
    permission,
    summary: summarizeText(document.content),
    content: mode === "content" ? document.content : document.content.slice(0, 1000),
    truncated: mode !== "content" && document.content.length > 1000,
  };
}

async function grantDocumentEditAccess(documentToken, connectionId = "") {
  const connection = getConnection(connectionId);
  const openId = connection.user?.open_id;
  if (!openId) throw new Error("The connected Lark user has no open_id; cannot grant document edit access");

  const query = new URLSearchParams({ type: "docx", need_notification: "false" });
  return larkRequest(
    `/open-apis/drive/v1/permissions/${encodeURIComponent(documentToken)}/members?${query}`,
    "POST",
    { member_type: "openid", member_id: openId, perm: "edit" },
    connectionId,
  );
}

async function appendToLarkDocument(documentToken, content, connectionId = "") {
  // The docs_ai API does not accept the CLI's `append` shorthand.  The
  // equivalent API operation is block_insert_after with the -1 sentinel,
  // which means "insert at the end of the document".
  const result = await updateLarkDocument(
    documentToken,
    { command: "block_insert_after", blockId: "-1", content },
    connectionId,
  );
  return { ...result, appended_content: content };
}

async function getDocumentChildren(documentToken, connectionId = "") {
  const query = new URLSearchParams({ page_size: "500" });
  const body = await larkGet(
    `/open-apis/docx/v1/documents/${encodeURIComponent(documentToken)}/blocks/${encodeURIComponent(documentToken)}/children?${query}`,
    connectionId,
  );
  return body.data ?? body;
}

async function updateLarkDocument(documentToken, { command, content, blockId = "" }, connectionId = "") {
  const body = await larkRequest(
    `/open-apis/docs_ai/v1/documents/${encodeURIComponent(documentToken)}`,
    "PUT",
    {
      format: "markdown",
      command,
      content,
      revision_id: -1,
      ...(blockId ? { block_id: blockId } : {}),
    },
    connectionId,
  );
  return {
    document_id: documentToken,
    mode: command === "overwrite"
      ? "replace_all"
      : command === "block_insert_after"
        ? "append"
        : "replace_block",
    command,
    block_id: blockId || null,
    result: body.data ?? body,
    source_url: `${getConnectionWebBaseUrl(connectionId)}/docx/${documentToken}`,
  };
}

async function createLarkDocument({ title, content, folderToken = "", folderName = "", storageTarget = "default_public_folder", sourceUrls = [], connectionId = "" }) {
  const identity = storageTarget === "user_drive" || storageTarget === "user_folder" ? "user" : "bot";
  const effectiveFolderToken = storageTarget === "default_public_folder"
    ? await ensureDefaultOutputFolder(connectionId)
    : storageTarget === "user_folder"
      ? await resolveUserFolderToken(folderToken, folderName, connectionId)
      : "";
  if (storageTarget === "user_folder" && !effectiveFolderToken) {
    throw new Error("storage_target=user_folder requires folder_token");
  }
  const sourceSection = sourceUrls.length > 0 ? `\n\n## 来源\n\n${sourceUrls.map((url) => `- ${url}`).join("\n")}` : "";
  const created = await larkRequest("/open-apis/docs_ai/v1/documents", "POST", {
    format: "markdown",
    content: `<title>${escapeXmlText(title)}</title>\n\n${content}${sourceSection}`,
    extra_param: JSON.stringify({ open_create_async: true }),
    ...(effectiveFolderToken ? { parent_token: effectiveFolderToken } : {}),
  }, connectionId, identity);

  let data = created.data ?? created;
  if (!data.document?.document_id && data.task_id) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const task = await larkGet(`/open-apis/docs_ai/v1/async_tasks/${encodeURIComponent(data.task_id)}`, connectionId, identity);
      data = task.data ?? task;
      if (data.document?.document_id || data.status === "failed" || data.status === "error") break;
    }
  }

  const document = data.document;
  if (!document?.document_id) {
    throw new Error(`Lark document creation did not complete: ${JSON.stringify(data).slice(0, 500)}`);
  }

  const platformLabel = getConnectionProvider(connectionId).label;
  const defaultFolderLabel = `Counso ${platformLabel} Bot 默认共享文件夹`;
  const result = {
    document_id: document.document_id,
    title: document.title ?? title,
    url: document.url ?? `${getConnectionWebBaseUrl(connectionId)}/docx/${document.document_id}`,
    folder_token: effectiveFolderToken || null,
    folder_url: effectiveFolderToken
      ? `${getConnectionWebBaseUrl(connectionId)}/drive/folder/${effectiveFolderToken}`
      : null,
    storage_scope: effectiveFolderToken
      ? storageTarget === "default_public_folder" ? "configured_public_folder" : storageTarget
      : "user_drive_root",
    storage_note: storageTarget === "default_public_folder"
      ? `文档已放入 ${defaultFolderLabel}；文件夹的 ${platformLabel} 共享设置决定哪些用户可以看到。`
      : storageTarget === "user_folder"
        ? "文档已放入当前 OAuth 用户指定的网盘文件夹。"
        : "文档已放入当前 OAuth 用户的网盘根目录。",
    storage_identity: identity,
  };

  if (identity === "user") {
    result.permission_granted = true;
    result.permission = "文档由当前 OAuth 用户创建，当前用户具有编辑权限";
  } else {
    try {
      await grantDocumentEditAccess(document.document_id, connectionId);
      result.permission_granted = true;
      result.permission = "当前 OAuth 用户已获得编辑权限";
    } catch (error) {
      result.permission_granted = false;
      result.permission = "文档已创建，但当前 OAuth 用户编辑权限授予失败";
      result.permission_error = error.message;
    }
  }

  try {
    const verification = await readLarkDocument(document.document_id, connectionId, identity);
    result.verified = verification.content.includes(content);
    result.verification = result.verified ? "已重新读取并核对正文" : "文档已创建，但重新读取的正文与草稿不完全匹配";
  } catch (error) {
    result.verified = false;
    result.verification = "文档已创建，但保存后的读取核对失败";
    result.verification_error = error.message;
  }

  return result;
}

function createServer() {
  const server = new McpServer({ name: "counso-lark", version: "0.2.0" });

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

  // Keep the implementation available for compatibility while exposing one
  // consolidated read tool to MCP clients. This prevents the model from
  // selecting several overlapping list/search/read tools and causing a
  // separate confirmation for each call.
  const exposeLegacyReadTools = false;
  if (exposeLegacyReadTools) {
  server.registerTool(
    "read_lark_wiki",
    {
      title: "Read a Lark wiki page",
      description: "Read the markdown content of a Lark knowledge-base page. This tool is read-only. If a page is not shown by search, the user can paste its Lark Wiki URL here to verify whether the Bot has permission to read it.",
      inputSchema: { wiki_url_or_token: z.string().min(1), connection_id: z.string().min(1).optional() },
    },
    async ({ wiki_url_or_token, connection_id }) => {
      const result = await readWikiDocument(wiki_url_or_token, resolveConnectionId(connection_id));
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "read_lark_document",
    {
      title: "Read a Lark cloud document",
      description: "Read the markdown content of a Lark docx document. This tool is read-only. Search results may omit individually shared documents; if the user pastes a Lark document URL, use it directly to verify whether the Bot can read it.",
      inputSchema: { document_url_or_token: z.string().min(1), connection_id: z.string().min(1).optional() },
    },
    async ({ document_url_or_token, connection_id }) => {
      const result = await readLarkDocument(document_url_or_token, resolveConnectionId(connection_id));
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "list_lark_document_blocks",
    {
      title: "List blocks in a Lark document",
      description: "List the direct blocks in a Lark document, including block IDs and text, so a later precise block edit can target the correct paragraph.",
      inputSchema: {
        document_url_or_token: z.string().min(1),
        connection_id: z.string().min(1).optional(),
      },
    },
    async ({ document_url_or_token, connection_id }) => {
      const documentToken = docTokenFromInput(document_url_or_token);
      const data = await getDocumentChildren(documentToken, resolveConnectionId(connection_id));
      const blocks = (data.items ?? data.blocks ?? []).map((block) => ({
        block_id: block.block_id,
        block_type: block.block_type,
        text: (block.text?.elements ?? [])
          .map((element) => element.text_run?.content ?? "")
          .join(""),
      }));
      const result = {
        document_id: documentToken,
        blocks,
        has_more: Boolean(data.has_more),
        next_page_token: data.next_page_token ?? null,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "health_check",
    {
      title: "Check Lark connection",
      description: "Verify that the configured Lark application credentials are valid.",
      inputSchema: {},
    },
    async () => {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            authentication: "oauth_required",
            oauth_redirect_uris: Object.fromEntries(Object.values(providers).map((provider) => [provider.id, provider.oauthRedirectUri])),
            message: "Lark tools require member OAuth first. After member verification, file APIs use the enterprise application's approved permissions and document access scope.",
          }, null, 2),
        }],
      };
    },
  );

  server.registerTool(
    "list_lark_wiki_spaces",
    {
      title: "List Lark knowledge bases",
      description: "List knowledge bases visible to the configured Lark application. For a broad document inventory, use inventory_lark_documents instead so COUNSO only needs one authorization. This tool is read-only and intended for targeted follow-up pagination.",
      inputSchema: {
        page_token: z.string().optional(),
        page_size: z.number().int().min(1).max(50).optional(),
        connection_id: z.string().min(1).optional(),
      },
    },
    async ({ page_token, page_size, connection_id }) => {
      const result = await listWikiSpaces(page_token, page_size, resolveConnectionId(connection_id));
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "list_lark_wiki_nodes",
    {
      title: "List Lark knowledge-base pages",
      description: "List pages under a Lark knowledge base or parent page. Use has_child to continue traversing. For a broad document inventory, use inventory_lark_documents instead so COUNSO only needs one authorization. This tool is read-only and intended for targeted follow-up traversal.",
      inputSchema: {
        space_id: z.string().min(1),
        parent_node_token: z.string().optional(),
        page_token: z.string().optional(),
        page_size: z.number().int().min(1).max(50).optional(),
        connection_id: z.string().min(1).optional(),
      },
    },
    async ({ space_id, parent_node_token, page_token, page_size, connection_id }) => {
      const result = await listWikiNodes(space_id, parent_node_token, page_token, page_size, resolveConnectionId(connection_id));
      result.items = (result.items ?? []).map((item) => ({ ...item, summary: metadataSummary(item) }));
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "list_lark_drive_files",
    {
      title: "List Lark Drive files",
      description: "List files directly under a Lark Drive folder. For a broad document inventory, use inventory_lark_documents instead so COUNSO only needs one authorization. This tool is read-only and intended for targeted folder pagination.",
      inputSchema: {
        folder_token: z.string().optional(),
        page_token: z.string().optional(),
        page_size: z.number().int().min(1).max(200).optional(),
        connection_id: z.string().min(1).optional(),
      },
    },
    async ({ folder_token, page_token, page_size, connection_id }) => {
      const result = await listDriveFiles(folder_token, page_token, page_size, resolveConnectionId(connection_id));
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "list_all_lark_files",
    {
      title: "List all accessible Lark Drive files",
      description: "Recursively scan the Lark Drive root or a specified folder and return file metadata and source URLs. For a broad document inventory, use inventory_lark_documents instead so COUNSO only needs one authorization. This tool is read-only and bounded.",
      inputSchema: {
        folder_token: z.string().optional(),
        max_files: z.number().int().min(1).max(10000).optional(),
        connection_id: z.string().min(1).optional(),
      },
    },
    async ({ folder_token, max_files, connection_id }) => {
      const result = await listAllDriveFiles(folder_token, max_files, resolveConnectionId(connection_id));
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "read_lark_file",
    {
      title: "Read a Lark file",
      description: "Download and extract text from a Lark Drive PDF, Word, Excel, CSV, Markdown, or text file. This tool is read-only.",
      inputSchema: {
        file_token: z.string().min(1),
        file_name: z.string().optional(),
        mime_type: z.string().optional(),
        source_url: z.string().url().optional(),
        folder_token: z.string().optional(),
        folder_path: z.array(z.string()).optional(),
        modified_time: z.string().optional(),
        created_time: z.string().optional(),
        connection_id: z.string().min(1).optional(),
      },
    },
    async ({ file_token, file_name, mime_type, source_url, folder_token, folder_path, modified_time, created_time, connection_id }) => {
      const result = await readLarkFile(file_token, file_name, mime_type, {
        source_url,
        folder_token,
        folder_path,
        modified_time,
        created_time,
      }, resolveConnectionId(connection_id));
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "search_lark_wiki",
    {
      title: "Search Lark knowledge bases",
      description: "Search accessible knowledge-base page titles. This tool is read-only and scans a bounded number of nodes.",
      inputSchema: {
        query: z.string().min(1),
        max_results: z.number().int().min(1).max(100).optional(),
        max_nodes: z.number().int().min(1).max(5000).optional(),
        connection_id: z.string().min(1).optional(),
      },
    },
    async ({ query, max_results, max_nodes, connection_id }) => {
      const result = await searchWikiTitles(query, max_results, max_nodes, resolveConnectionId(connection_id));
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "search_lark_drive_files",
    {
      title: "Search Lark Drive file names",
      description: "Search file names in the Lark Drive root or one specified folder. This tool is read-only.",
      inputSchema: {
        query: z.string().min(1),
        folder_token: z.string().optional(),
        page_size: z.number().int().min(1).max(200).optional(),
        connection_id: z.string().min(1).optional(),
      },
    },
    async ({ query, folder_token, page_size, connection_id }) => {
      const result = await searchDriveFileNames(query, folder_token, page_size, resolveConnectionId(connection_id));
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "search_lark_documents",
    {
      title: "Search Lark documents visible to the Bot",
      description:
        "Search indexed Lark cloud documents, Wiki pages, and other cloud resources using the Bot/application identity. The query may be empty to browse indexed resources. Results may be incomplete and may omit documents individually shared from another user's personal space. Always tell the user that missing documents can be checked by pasting the Lark document or Wiki URL, then use read_lark_document or read_lark_wiki directly. This tool is read-only and paginated.",
      inputSchema: {
        query: z.string().max(30).optional(),
        page_token: z.string().optional(),
        page_size: z.number().int().min(1).max(20).optional(),
        connection_id: z.string().min(1).optional(),
      },
    },
    async ({ query, page_token, page_size, connection_id }) => {
      const result = await searchLarkDocuments(query ?? "", page_token, page_size, resolveConnectionId(connection_id));
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "inventory_lark_documents",
    {
      title: "Inventory Lark documents in one read-only operation",
      description:
        "Perform one read-only aggregate inventory using the Bot/application identity. Use this tool for broad document-list requests instead of calling the individual list/search tools. It combines indexed document search, Wiki spaces, and Drive metadata in one MCP call and includes a summary field by default. mode=metadata returns metadata summaries; mode=preview additionally reads short content summaries; mode=content reads a bounded number of full document contents. Results may still omit individually shared personal-space documents; if the user provides a URL, verify it directly with the read tools.",
      inputSchema: {
        mode: z.enum(["metadata", "preview", "content"]).optional().default("preview"),
        query: z.string().max(30).optional(),
        max_items: z.number().int().min(1).max(20).optional(),
        max_files: z.number().int().min(1).max(200).optional(),
        connection_id: z.string().min(1).optional(),
      },
    },
    async ({ mode, query, max_items, max_files, connection_id }) => {
      const result = await inventoryLarkDocuments({
        mode: mode ?? "preview",
        query: query ?? "",
        maxItems: max_items ?? 20,
        maxFiles: max_files ?? 100,
        connectionId: resolveConnectionId(connection_id),
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );
  }

  server.registerTool(
    "lark_documents",
    {
      title: "Browse or read Lark documents",
      description:
        "The single read-only entry point for Lark documents. Use action=inventory to return Bot-accessible documents and the documents actually contained in each Wiki space, with separate bot_documents and wiki_documents arrays, summaries, and per-document can_read/can_edit permission results. Use action=read with one or more Lark URLs/tokens to read and check them in one operation. This tool is intentionally consolidated so the client normally asks for Allow only once. Results may omit documents that are not in the Bot's search index; paste a direct Lark URL in action=read to verify access. Never use this tool to create or modify documents.",
      inputSchema: {
        action: z.enum(["inventory", "read"]).optional().default("inventory"),
        mode: z.enum(["preview", "content", "metadata"]).optional().default("preview"),
        query: z.string().max(30).optional(),
        urls: z.array(z.string().min(1)).max(20).optional(),
        max_items: z.number().int().min(1).max(20).optional(),
        max_files: z.number().int().min(1).max(200).optional(),
        max_wiki_nodes: z.number().int().min(1).max(500).optional(),
        connection_id: z.string().min(1).optional(),
      },
    },
    async ({ action, mode, query, urls, max_items, max_files, max_wiki_nodes, connection_id }) => {
      const connectionId = resolveConnectionId(connection_id);
      const selectedAction = action ?? "inventory";
      const selectedMode = mode ?? "preview";

      if (selectedAction === "read") {
        if (!urls?.length) {
          return {
            isError: true,
            content: [{ type: "text", text: "action=read requires at least one Lark document, Wiki, or Drive URL/token in urls." }],
          };
        }
        const documents = [];
        for (const url of urls) {
          try {
            documents.push(await readLarkResource(url, selectedMode === "metadata" ? "preview" : selectedMode, connectionId));
          } catch (error) {
            documents.push({ source_url: url, error: error.message });
          }
        }
        const result = { action: "read", mode: selectedMode, count: documents.length, documents };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      }

      const result = await inventoryLarkDocuments({
        mode: selectedMode,
        query: query ?? "",
        maxItems: max_items ?? 20,
        maxFiles: max_files ?? 100,
        maxWikiNodes: max_wiki_nodes ?? 200,
        connectionId,
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ action: "inventory", ...result }, null, 2) }],
        structuredContent: { action: "inventory", ...result },
      };
    },
  );

  server.registerTool(
    "save_draft_to_lark",
    {
      title: "Save a draft as a new Lark document",
      description:
        "Use only when the user explicitly asks to create a NEW Lark document. Before calling, ask where to store it and require storage_target: default_public_folder (the Counso Lark Bot shared folder), user_drive (the current OAuth user's Drive root), or user_folder (the current OAuth user's specified folder, using folder_token or an exact folder_name). Tell the user the default is the Counso Lark Bot folder. After confirmation, create the document in that location. Never use this tool to modify an existing document.",
      inputSchema: {
        confirmed: z.boolean(),
        title: z.string().min(1).max(200),
        content: z.string().min(1).max(100000),
        storage_target: z.enum(["default_public_folder", "user_drive", "user_folder"]),
        folder_token: z.string().optional(),
        folder_name: z.string().min(1).max(200).optional(),
        source_urls: z.array(z.string().url()).max(20).optional(),
        connection_id: z.string().min(1).optional(),
      },
    },
    async ({ confirmed, title, content, storage_target, folder_token, folder_name, source_urls, connection_id }) => {
      if (!confirmed) {
        return {
          isError: true,
          content: [{ type: "text", text: "未确认写回。请先向用户展示草稿，并在用户明确确认后再次调用 confirmed=true。" }],
        };
      }
      const result = await createLarkDocument({
        title,
        content,
        storageTarget: storage_target,
        folderToken: folder_token,
        folderName: folder_name,
        sourceUrls: source_urls ?? [],
        connectionId: resolveConnectionId(connection_id),
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "append_to_lark_document",
    {
      title: "Append content to an existing Lark document",
      description:
        "After explicit user confirmation, append content to an existing Lark document. It does not replace or delete existing content, so it is safe for incremental updates.",
      inputSchema: {
        confirmed: z.boolean(),
        document_url_or_token: z.string().min(1),
        content: z.string().min(1).max(100000),
        connection_id: z.string().min(1).optional(),
      },
    },
    async ({ confirmed, document_url_or_token, content, connection_id }) => {
      if (!confirmed) {
        return {
          isError: true,
          content: [{ type: "text", text: "未确认修改原文档。请先向用户展示将追加的内容，并在用户明确确认后再次调用 confirmed=true。" }],
        };
      }
      const documentToken = docTokenFromInput(document_url_or_token);
      const result = await appendToLarkDocument(documentToken, content, resolveConnectionId(connection_id));
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "edit_lark_document",
    {
      title: "Edit an existing Lark document precisely",
      description:
        "After explicit user confirmation, update an existing Lark document with the official document update API. mode=replace_all overwrites the document body; mode=replace_block replaces one specified paragraph block. replace_block requires a block_id obtained from list_lark_document_blocks.",
      inputSchema: {
        confirmed: z.boolean(),
        mode: z.enum(["replace_all", "replace_block"]),
        document_url_or_token: z.string().min(1),
        content: z.string().max(100000),
        block_id: z.string().min(1).optional(),
        connection_id: z.string().min(1).optional(),
      },
    },
    async ({ confirmed, mode, document_url_or_token, content, block_id, connection_id }) => {
      if (!confirmed) {
        return {
          isError: true,
          content: [{ type: "text", text: "未确认编辑原文档。请先向用户展示修改内容，并在用户明确确认后再次调用 confirmed=true。" }],
        };
      }
      if (mode === "replace_block" && !block_id) {
        return {
          isError: true,
          content: [{ type: "text", text: "mode=replace_block 时必须提供 block_id。" }],
        };
      }
      const documentToken = docTokenFromInput(document_url_or_token);
      const connectionId = resolveConnectionId(connection_id);
      const result = mode === "replace_all"
        ? await updateLarkDocument(documentToken, { command: "overwrite", content }, connectionId)
        : await updateLarkDocument(documentToken, { command: "block_replace", content, blockId: block_id }, connectionId);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );

  return server;
}

const httpServer = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  console.log(`[HTTP] ${req.method} ${requestUrl.pathname}`);

  if (requestUrl.pathname === "/.well-known/oauth-protected-resource/mcp" ||
      requestUrl.pathname === "/.well-known/oauth-protected-resource") {
    const issuer = mcpIssuerForRequest(requestUrl);
    json(res, 200, {
      resource: `${issuer}/mcp`,
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: ["lark:read", "lark:write"],
    });
    return;
  }

  if (requestUrl.pathname === "/.well-known/oauth-authorization-server") {
    json(res, 200, mcpOAuthMetadata(mcpIssuerForRequest(requestUrl)));
    return;
  }

  if (requestUrl.pathname === "/oauth/register" && req.method === "POST") {
    try {
      const body = parseFormBody(req, await readRequestBody(req));
      const clientId = `lark-mcp-${randomToken()}`;
      mcpClients.set(clientId, {
        clientId,
        redirectUris: Array.isArray(body.redirect_uris) ? body.redirect_uris : [],
        clientName: body.client_name ?? "MCP client",
        createdAt: Date.now(),
      });
      json(res, 201, {
        client_id: clientId,
        client_name: body.client_name ?? "MCP client",
        redirect_uris: body.redirect_uris ?? [],
        token_endpoint_auth_method: "none",
      });
    } catch (error) {
      json(res, 400, { error: "invalid_client_metadata", error_description: error.message });
    }
    return;
  }

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

  if (requestUrl.pathname === "/oauth/lark/select" && req.method === "POST") {
    try {
      const body = parseFormBody(req, await readRequestBody(req));
      const selection = botSelectionStates.get(body.selection_token ?? "");
      const bot = getBot(body.bot_id ?? "");
      if (!selection || selection.expiresAt < Date.now()) throw new Error("Invalid or expired Bot selection");
      if (bot.organizationId !== selection.organization.id || bot.platform !== selection.organization.platform) throw new Error("The selected Bot does not belong to the selected organization or platform");
      botSelectionStates.delete(body.selection_token ?? "");
      if (bot.id === selection.authorizedBotId) {
        const token = selection.bootstrapToken;
        const user = selection.bootstrapUser;
        const connectionId = crypto.randomUUID();
        userConnections.set(connectionId, {
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          expiresAt: token.expiresAt,
          refreshExpiresAt: token.refreshExpiresAt,
          userId: selection.pending.userId,
          user,
          tenantKey: selection.tenantKey || bot.tenantKey || "",
          oauthBotId: bot.id,
          selectedBotId: bot.id,
        });
        if (selection.pending.mcp) {
          const code = randomToken();
          mcpAuthorizationCodes.set(code, {
            connectionId,
            clientId: selection.pending.mcp.clientId,
            redirectUri: selection.pending.mcp.redirectUri,
            codeChallenge: selection.pending.mcp.codeChallenge,
            expiresAt: Date.now() + 5 * 60 * 1000,
          });
          const callback = new URL(selection.pending.mcp.redirectUri);
          callback.searchParams.set("code", code);
          callback.searchParams.set("state", selection.pending.mcp.state);
          redirect(res, callback.toString());
        } else {
          json(res, 200, { ok: true, connection_id: connectionId, selected_bot: publicBot(bot) });
        }
        return;
      }
      const state = crypto.randomBytes(24).toString("hex");
      oauthStates.set(state, {
        ...selection.pending,
        botId: bot.id,
        stage: "bot",
        expectedTenantKey: selection.tenantKey,
        organization: selection.organization,
        createdAt: Date.now(),
      });
      redirect(res, createLarkOAuthUrl({ state, botId: bot.id }));
    } catch (error) {
      json(res, 400, { error: error.message });
    }
    return;
  }

  if (requestUrl.pathname === "/oauth/lark/select-organization" && req.method === "POST") {
    try {
      const body = parseFormBody(req, await readRequestBody(req));
      const selection = organizationSelectionStates.get(body.selection_token ?? "");
      const requestedOrganizationKey = `${String(body.platform ?? "lark").toLowerCase()}:${body.organization_id ?? ""}`;
      if (selection?.redirectLocation &&
          selection.selectedOrganizationId === requestedOrganizationKey &&
          selection.oauthState && oauthStates.has(selection.oauthState)) {
        // Browsers or OAuth clients may retry a form POST after a 302. Reuse
        // the original redirect only when they resubmit the same organization.
        redirect(res, selection.redirectLocation);
        return;
      }
      const platform = String(body.platform ?? "lark").toLowerCase();
      const organization = organizationsFromRegistry().find((item) => item.id === body.organization_id && item.platform === platform);
      if (!selection || selection.expiresAt < Date.now()) throw new Error("Invalid or expired organization selection");
      if (!organization) throw new Error("Organization not found");
      const bootstraps = organization.bots.filter((bot) => bot.bootstrap);
      if (bootstraps.length !== 1) throw new Error("The selected organization must have exactly one bootstrap Bot");
      const bootstrap = bootstraps[0];
      const organizationSelectionKey = `${organization.platform}:${organization.id}`;
      if (selection.oauthState && selection.selectedOrganizationId !== organizationSelectionKey) {
        oauthStates.delete(selection.oauthState);
      }
      const state = crypto.randomBytes(24).toString("hex");
      oauthStates.set(state, {
        ...selection.pending,
        botId: bootstrap.id,
        stage: "organization_bootstrap",
        organization,
        expectedTenantKey: organization.bots.find((bot) => bot.tenantKey)?.tenantKey ?? "",
        createdAt: Date.now(),
      });
      selection.selectedOrganizationId = organizationSelectionKey;
      selection.oauthState = state;
      selection.redirectLocation = createLarkOAuthUrl({ state, botId: bootstrap.id });
      redirect(res, selection.redirectLocation);
    } catch (error) {
      json(res, 400, { error: error.message });
    }
    return;
  }

  if (requestUrl.pathname === "/oauth/authorize") {
    const clientId = requestUrl.searchParams.get("client_id") ?? "";
    const client = mcpClients.get(clientId);
    const redirectUri = requestUrl.searchParams.get("redirect_uri") ?? "";
    const codeChallenge = requestUrl.searchParams.get("code_challenge") ?? "";
    if (!client || !client.redirectUris.includes(redirectUri) ||
        requestUrl.searchParams.get("response_type") !== "code" ||
        requestUrl.searchParams.get("code_challenge_method") !== "S256" || !codeChallenge) {
      json(res, 400, { error: "invalid_request", error_description: "Valid OAuth client and PKCE parameters are required" });
      return;
    }
    const selectionToken = randomToken();
    organizationSelectionStates.set(selectionToken, {
      pending: {
        userId: "",
        mcp: {
          clientId,
          redirectUri,
          codeChallenge,
          state: requestUrl.searchParams.get("state") ?? "",
        },
      },
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderOrganizationSelectionPage(selectionToken, organizationsFromRegistry()));
    return;
  }

  if (requestUrl.pathname === "/oauth/token" && req.method === "POST") {
    try {
      const body = parseFormBody(req, await readRequestBody(req));
      if (body.grant_type === "refresh_token") {
        const refresh = mcpAccessTokens.get(body.refresh_token);
        if (!refresh || refresh.refresh !== true) throw new Error("Invalid refresh token");
        const accessToken = randomToken();
        mcpAccessTokens.set(accessToken, {
          connectionId: refresh.connectionId,
          clientId: refresh.clientId,
          expiresAt: Date.now() + 3600 * 1000,
        });
        json(res, 200, { access_token: accessToken, token_type: "Bearer", expires_in: 3600 });
        return;
      }
      const authorizationCode = mcpAuthorizationCodes.get(body.code);
      if (!authorizationCode || authorizationCode.expiresAt < Date.now() ||
          authorizationCode.clientId !== body.client_id ||
          authorizationCode.redirectUri !== body.redirect_uri ||
          pkceChallenge(body.code_verifier ?? "") !== authorizationCode.codeChallenge) {
        json(res, 400, { error: "invalid_grant", error_description: "Invalid authorization code or PKCE verifier" });
        return;
      }
      mcpAuthorizationCodes.delete(body.code);
      const accessToken = randomToken();
      const refreshToken = randomToken();
      const token = {
        connectionId: authorizationCode.connectionId,
        clientId: authorizationCode.clientId,
        expiresAt: Date.now() + 3600 * 1000,
      };
      mcpAccessTokens.set(accessToken, token);
      mcpAccessTokens.set(refreshToken, { ...token, refresh: true });
      json(res, 200, {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: refreshToken,
      });
    } catch (error) {
      json(res, 400, { error: "invalid_request", error_description: error.message });
    }
    return;
  }

  if (requestUrl.pathname === "/oauth/lark/start" || requestUrl.pathname === "/oauth/feishu/start") {
    let botId;
    try {
      botId = getBot(requestUrl.searchParams.get("bot_id") ?? "").id;
    } catch (error) {
      json(res, 400, { error: "invalid_bot", error_description: error.message });
      return;
    }
    const state = crypto.randomBytes(24).toString("hex");
    oauthStates.set(state, {
      userId: requestUrl.searchParams.get("user_id") ?? "",
      botId,
      stage: "bot",
      createdAt: Date.now(),
    });
    const location = createLarkOAuthUrl({
      state,
      botId,
      userId: requestUrl.searchParams.get("user_id") ?? "",
    });
    res.writeHead(302, { Location: location });
    res.end();
    return;
  }

  if (requestUrl.pathname === "/oauth/lark/callback" || requestUrl.pathname === "/oauth/feishu/callback") {
    const state = requestUrl.searchParams.get("state") ?? "";
    const pending = oauthStates.get(state);
    oauthStates.delete(state);
    if (!pending || Date.now() - pending.createdAt > 10 * 60 * 1000) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "Invalid or expired OAuth state" }));
      return;
    }
    if (requestUrl.searchParams.get("error")) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: requestUrl.searchParams.get("error_description") ?? requestUrl.searchParams.get("error") }));
      return;
    }
    try {
      const oauthBot = getBot(pending.botId ?? "");
      const tokenBody = await exchangeAuthorizationCode(requestUrl.searchParams.get("code") ?? "", oauthBot);
      const token = tokenBody.data ?? tokenBody;
      const user = await getLarkUserInfo(token.access_token, oauthBot);
      const userTenantKey = user.tenant_key ?? user.tenantKey ?? token.tenant_key ?? tokenBody.tenant_key ?? "";
      if (pending.expectedTenantKey && userTenantKey && pending.expectedTenantKey !== userTenantKey) {
        throw new Error("The Lark user is not a member of the selected organization");
      }
      if (pending.stage === "organization_bootstrap") {
        const organization = pending.organization;
        const bots = botRegistry.filter((bot) => bot.organizationId === organization.id && bot.platform === organization.platform);
        if (bots.length === 0) throw new Error("No Bot is configured for the selected organization");
        const selectionToken = randomToken();
        botSelectionStates.set(selectionToken, {
          pending,
          organization,
          bots,
          authorizedBotId: oauthBot.id,
          bootstrapUser: user,
          bootstrapToken: {
            accessToken: token.access_token,
            refreshToken: token.refresh_token,
            expiresAt: Date.now() + Math.max(60, (token.expires_in ?? 7200) - 300) * 1000,
            refreshExpiresAt: Date.now() + Math.max(60, (token.refresh_expires_in ?? 2592000) - 300) * 1000,
          },
          tenantKey: userTenantKey,
          expiresAt: Date.now() + 10 * 60 * 1000,
        });
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderBotSelectionPage(selectionToken, organization, bots, oauthBot.id));
        return;
      }

      const connectionId = crypto.randomUUID();
      userConnections.set(connectionId, {
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: Date.now() + Math.max(60, (token.expires_in ?? 7200) - 300) * 1000,
        refreshExpiresAt: Date.now() + Math.max(60, (token.refresh_expires_in ?? 2592000) - 300) * 1000,
        userId: pending.userId,
        user,
        tenantKey: userTenantKey || pending.expectedTenantKey || oauthBot.tenantKey || "",
        oauthBotId: oauthBot.id,
        selectedBotId: oauthBot.id,
      });
      if (pending.mcp) {
        const code = randomToken();
        mcpAuthorizationCodes.set(code, {
          connectionId,
          clientId: pending.mcp.clientId,
          redirectUri: pending.mcp.redirectUri,
          codeChallenge: pending.mcp.codeChallenge,
          expiresAt: Date.now() + 5 * 60 * 1000,
        });
        const callback = new URL(pending.mcp.redirectUri);
        callback.searchParams.set("code", code);
        callback.searchParams.set("state", pending.mcp.state);
        redirect(res, callback.toString());
      } else {
        json(res, 200, {
          ok: true,
          connection_id: connectionId,
          user: { name: user.name, open_id: user.open_id, user_id: user.user_id },
        selected_bot: publicBot(oauthBot),
          expires_in: token.expires_in,
        message: "Lark 已连接。后续可先列出并选择可用 Bot，再使用文档工具。",
        });
      }
    } catch (error) {
      res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }

  if (requestUrl.pathname === "/oauth/lark/status") {
    const connection = userConnections.get(requestUrl.searchParams.get("connection_id") ?? "");
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      ok: Boolean(connection),
      connected: Boolean(connection),
      user: connection ? { name: connection.user?.name, open_id: connection.user?.open_id, user_id: connection.user?.user_id } : null,
      selected_bot: connection ? publicBot(getConnectionBot(requestUrl.searchParams.get("connection_id") ?? "")) : null,
      available_bots: connection ? botRegistry.map(publicBot) : [],
      expires_at: connection ? new Date(connection.expiresAt).toISOString() : null,
    }));
    return;
  }

  if (requestUrl.pathname !== "/mcp") {
    json(res, requestUrl.pathname === "/health" ? 200 : 404, { ok: requestUrl.pathname === "/health" });
    return;
  }

  const authorization = req.headers.authorization ?? "";
  const accessToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  const token = accessToken ? mcpAccessTokens.get(accessToken) : null;
  if (!token || token.refresh === true || token.expiresAt < Date.now()) {
    const issuer = mcpIssuerForRequest(requestUrl);
    res.writeHead(401, {
      "Content-Type": "application/json; charset=utf-8",
      "WWW-Authenticate": `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp"`,
    });
    res.end(JSON.stringify({ error: "unauthorized", error_description: "Lark member OAuth is required" }));
    return;
  }

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createServer();
  res.on("close", () => transport.close().catch(() => {}));
  await mcpConnectionContext.run(token.connectionId, async () => {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
});

httpServer.listen(port, () => {
  console.log(`COUNSO Lark MCP listening on http://localhost:${port}/mcp`);
});
