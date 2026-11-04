import "dotenv/config";

export const port = Number(process.env.PORT ?? 8787);
export const publicBaseUrl = (process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, "");
export const mcpIssuer = process.env.MCP_OAUTH_ISSUER ?? publicBaseUrl;
export const mcpResource = process.env.MCP_RESOURCE ?? `${mcpIssuer}/mcp`;
export const botStorePath = process.env.LARK_BOT_STORE_PATH ?? "./data/lark-bots.enc.json";
export const botStoreKey = process.env.LARK_BOT_STORE_KEY ?? "";
export const adminToken = process.env.LARK_ADMIN_TOKEN ?? "";
export const configAccessKey = process.env.LARK_CONFIG_ACCESS_KEY ?? "C0unso7Key";
export const clientBotMapPath = process.env.LARK_CLIENT_BOT_MAP_PATH ?? "./config/lark-client-bot-map.json";
export const staticBotConfigPath = process.env.LARK_BOTS_CONFIG_PATH ?? "./config/lark-bots.json";
export const sessionStorePath = process.env.LARK_SESSION_STORE_PATH ?? "./data/lark-sessions.sqlite";
export const sessionStoreKey = process.env.LARK_SESSION_STORE_KEY ?? botStoreKey;
export const defaultOutputFolderName = "Counso Lark Bot";
export const defaultOAuthScopes = "docs:document.content:read docx:document:create drive:drive";
