import crypto from "node:crypto";
import { URL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import mammoth from "mammoth";
import pdfParse from "pdf-parse";
import * as XLSX from "xlsx";
import { adminToken, botStoreKey, botStorePath, clientBotMapPath, defaultOutputFolderName, staticBotConfigPath } from "./config/index.mjs";
import { getProvider, providers } from "./providers/registry.mjs";
import { createApiClient } from "./providers/api-client.mjs";
import { encryptSecret, loadBotRegistry, readBotStore, writeBotStore } from "./storage/bot-store.mjs";
import { loadClientBotMap } from "./storage/client-bot-map.mjs";
import { fetchWithRetry, parseJson } from "./utils/http-client.mjs";
import { createOAuthUrl } from "./oauth/url.mjs";
import { createAuthService } from "./services/auth-service.mjs";
import { createContentUtils, escapeXmlText } from "./services/content-utils.mjs";
import { createDocumentService } from "./services/document-service.mjs";
import { createDocumentService as createDocumentCreationService } from "./services/document-creation.mjs";
import { createWikiService } from "./services/wiki-service.mjs";
import { createDriveService } from "./services/drive-service.mjs";
import { createPermissionService } from "./services/permission-service.mjs";
import { createFileService } from "./services/file-service.mjs";
import { createSearchService } from "./services/search-service.mjs";
import { createInventoryService } from "./services/inventory-service.mjs";
import { registerBotTools } from "./mcp/tools/bot-tools.mjs";
import { registerDocumentTools } from "./mcp/tools/document-tools.mjs";
import { registerContentTools } from "./mcp/tools/content-tools.mjs";
import { createHttpServer, startHttpServer } from "./http/server.mjs";
import {
  appAccessTokenCache,
  mcpAccessTokens,
  mcpAuthorizationCodes,
  mcpClients,
  mcpConnectionContext,
  oauthStates,
  pkceChallenge,
  randomToken,
  resolveConnectionId,
  tenantAccessTokenCache,
  userConnections,
} from "./state/runtime-store.mjs";

let botRegistry = loadBotRegistry({ botStorePath, botStoreKey, providers, getProvider, staticBotConfigPath });
let botById = new Map(botRegistry.map((bot) => [bot.id, bot]));
const clientBotMap = loadClientBotMap(clientBotMapPath);

function resolveClientConfig(clientId, platform = "") {
  const mapped = clientBotMap.get(clientId);
  if (mapped) return mapped;
  const bot = botRegistry.find((item) => item.appId === clientId && (!platform || (item.platform ?? "lark") === platform));
  return bot ? { botId: bot.id, redirectUris: bot.redirectUris ?? [] } : null;
}

function refreshBotRegistry() {
  botRegistry = loadBotRegistry({ botStorePath, botStoreKey, providers, getProvider, staticBotConfigPath });
  botById = new Map(botRegistry.map((bot) => [bot.id, bot]));
  appAccessTokenCache.clear();
  tenantAccessTokenCache.clear();
}

function saveManagedBot({ id, platform = "lark", name, appId, appSecret, outputFolderToken = "", description = "", organizationId = "", organizationName = "", tenantKey = "", bootstrap = false, redirectUris = [] }) {
  platform = String(platform).toLowerCase();
  getProvider(platform);
  const existing = readBotStore(botStorePath).find((bot) => bot.id === id);
  if (existing && ((organizationId && existing.organization_id !== organizationId) || (existing.platform ?? "lark") !== platform)) {
    throw new Error(`Bot id "${id}" is already registered to another organization or platform`);
  }
  const bots = readBotStore(botStorePath).filter((bot) => bot.id !== id);
  if (bootstrap) {
    for (const bot of bots) {
      if (bot.organization_id === organizationId && (bot.platform ?? "lark") === platform) bot.bootstrap = false;
    }
  }
  bots.push({
    id,
    name,
    app_id: appId,
    app_secret: encryptSecret(appSecret, botStoreKey),
    platform,
    output_folder_token: outputFolderToken || getProvider(platform).defaultOutputFolderToken,
    description,
    organization_id: organizationId,
    organization_name: organizationName,
    tenant_key: tenantKey,
    redirect_uris: redirectUris,
    bootstrap,
  });
  writeBotStore(botStorePath, bots);
  refreshBotRegistry();
  return getBot(id);
}

function removeManagedBot(id) {
  const bots = readBotStore(botStorePath).filter((bot) => bot.id !== id);
  writeBotStore(botStorePath, bots);
  refreshBotRegistry();
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

const createLarkOAuthUrl = createOAuthUrl({ getBot, getProvider });

const { exchangeAuthorizationCode, getAccessToken, getAppAccessToken, getConnection, getLarkUserInfo, getTenantAccessToken, refreshUserAccessToken } = createAuthService({
  botRegistry,
  getBot,
  getConnectionBot,
  getProvider,
  userConnections,
  appAccessTokenCache,
  tenantAccessTokenCache,
  fetchWithRetry,
  parseJson,
});

const { extensionFor, parseSpreadsheet } = createContentUtils({ mammoth, pdfParse, XLSX });

const { get: larkGet, request: larkRequest, getBuffer: larkGetBuffer } = createApiClient({
  getAccessToken,
  getConnectionProvider,
  parseJson,
  fetchWithRetry,
});

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

const { checkLarkDocumentPermission, enrichDocumentPermissions, metadataSummary, permissionAllowed, permissionTypeForDocument, summarizeText } = createPermissionService({ larkGet, getConnectionProvider });
const { listAllWikiDocuments, listWikiNodes, listWikiSpaces, readWikiDocument } = createWikiService({ larkGet, getConnectionWebBaseUrl, metadataSummary });
const { appendDocument: appendToLarkDocument, grantEditAccess: grantDocumentEditAccess, listChildren: getDocumentChildren, readDocument: readLarkDocument, updateDocument: updateLarkDocument } = createDocumentService({ larkGet, larkRequest, docTokenFromInput, getConnection, getConnectionWebBaseUrl });

const { ensureDefaultOutputFolder, listAllDriveFiles, listDriveFiles, resolveUserFolderToken } = createDriveService({ larkGet, larkRequest, getConnectionBot, getConnectionWebBaseUrl, defaultOutputFolderName, metadataSummary });
const { readLarkFile } = createFileService({ larkGetBuffer, extensionFor, parseSpreadsheet, mammoth, pdfParse, getConnectionWebBaseUrl });

const { searchDriveFileNames, searchLarkDocuments, searchWikiTitles } = createSearchService({ listWikiSpaces, listWikiNodes, listDriveFiles, larkRequest, getConnectionWebBaseUrl });
const { inventoryLarkDocuments } = createInventoryService({ searchLarkDocuments, listWikiSpaces, listAllWikiDocuments, listAllDriveFiles, enrichDocumentPermissions, readLarkDocument, readLarkFile, getConnectionWebBaseUrl });
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

const createLarkDocument = createDocumentCreationService({
  ensureDefaultOutputFolder,
  resolveUserFolderToken,
  larkRequest,
  larkGet,
  escapeXmlText,
  getConnectionProvider,
  getConnectionWebBaseUrl,
  grantDocumentEditAccess,
  readLarkDocument,
});
function createServer() {
  const server = new McpServer({ name: "counso-lark", version: "0.2.0" });

  registerBotTools(server, { z, resolveConnectionId, getConnection, getBot, botRegistry, publicBot, getProvider });
  registerContentTools(server, { z, resolveConnectionId, readWikiDocument, readLarkDocument, getDocumentChildren, listWikiSpaces, listWikiNodes, listDriveFiles, listAllDriveFiles, readLarkFile, searchWikiTitles, searchDriveFileNames, docTokenFromInput, metadataSummary });
  registerDocumentTools(server, { z, resolveConnectionId, readLarkResource, inventoryLarkDocuments, createLarkDocument, appendToLarkDocument, updateLarkDocument, docTokenFromInput });
  return server;
}

const httpServer = createHttpServer({
  createMcpServer: createServer,
  getBotRegistry: () => botRegistry,
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
  createOAuthUrl: createLarkOAuthUrl,
  exchangeAuthorizationCode,
  getLarkUserInfo,
  mcpConnectionContext,
  randomToken,
  pkceChallenge,
  crypto,
});
startHttpServer(httpServer);

export { createServer };
