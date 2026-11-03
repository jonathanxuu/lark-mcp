import "dotenv/config";

export const port = Number(process.env.PORT ?? 8787);
export const publicBaseUrl = (process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, "");
export const mcpIssuer = process.env.MCP_OAUTH_ISSUER ?? publicBaseUrl;
export const mcpResource = process.env.MCP_RESOURCE ?? `${mcpIssuer}/mcp`;
export const botStorePath = process.env.LARK_BOT_STORE_PATH ?? "./data/lark-bots.enc.json";
export const botStoreKey = process.env.LARK_BOT_STORE_KEY ?? "";
export const adminToken = process.env.LARK_ADMIN_TOKEN ?? "";
export const defaultOutputFolderName = "Counso Lark Bot";
export const defaultOAuthScopes = "docs:document.content:read docx:document:create drive:drive";
