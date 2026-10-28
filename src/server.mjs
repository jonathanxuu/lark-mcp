import "dotenv/config";
import crypto from "node:crypto";
import http from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { URL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import mammoth from "mammoth";
import pdfParse from "pdf-parse";
import * as XLSX from "xlsx";

const baseUrl = process.env.LARK_BASE_URL ?? "https://open.larksuite.com";
const port = Number(process.env.PORT ?? 8787);
const publicBaseUrl = (process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, "");
const oauthRedirectUri = process.env.LARK_OAUTH_REDIRECT_URI ?? `${publicBaseUrl}/oauth/lark/callback`;
const oauthScopes = process.env.LARK_OAUTH_SCOPES ?? "docs:document.content:read docx:document:create drive:drive";
const mcpIssuer = process.env.MCP_OAUTH_ISSUER ?? publicBaseUrl;
const mcpResource = process.env.MCP_RESOURCE ?? `${mcpIssuer}/mcp`;

if (!process.env.LARK_APP_ID || !process.env.LARK_APP_SECRET) {
  throw new Error("LARK_APP_ID and LARK_APP_SECRET are required");
}

let tokenCache = { value: null, expiresAt: 0 };
let appAccessTokenCache = { value: null, expiresAt: 0 };
const oauthStates = new Map();
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

async function parseJson(response) {
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Lark returned HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  if (!response.ok || body.code !== 0) {
    throw new Error(`Lark API error ${body.code ?? response.status}: ${body.msg ?? text}`);
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

async function getTenantAccessToken() {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt) return tokenCache.value;

  const response = await fetchLark(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_id: process.env.LARK_APP_ID,
      app_secret: process.env.LARK_APP_SECRET,
    }),
  });
  const body = await parseJson(response);
  tokenCache = {
    value: body.tenant_access_token,
    expiresAt: Date.now() + Math.max(60, body.expire - 300) * 1000,
  };
  return tokenCache.value;
}

async function getAppAccessToken() {
  if (appAccessTokenCache.value && Date.now() < appAccessTokenCache.expiresAt) {
    return appAccessTokenCache.value;
  }

  const response = await fetchLark(`${baseUrl}/open-apis/auth/v3/app_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_id: process.env.LARK_APP_ID,
      app_secret: process.env.LARK_APP_SECRET,
    }),
  });
  const body = await parseJson(response);
  appAccessTokenCache = {
    value: body.app_access_token,
    expiresAt: Date.now() + Math.max(60, body.expire - 300) * 1000,
  };
  return appAccessTokenCache.value;
}

async function exchangeAuthorizationCode(code) {
  const appAccessToken = await getAppAccessToken();
  const response = await fetchLark(`${baseUrl}/open-apis/authen/v1/oidc/access_token`, {
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
  const appAccessToken = await getAppAccessToken();
  const response = await fetchLark(`${baseUrl}/open-apis/authen/v1/oidc/refresh_access_token`, {
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

async function getAccessToken(connectionId = "") {
  if (!connectionId) throw new Error("Lark OAuth connection_id is required; connect Lark before using this tool");
  const connection = userConnections.get(connectionId);
  if (!connection) throw new Error("Lark member OAuth connection not found; connect Lark before using this tool");

  // The member OAuth connection gates access to this MCP connection, while
  // Lark document APIs use the enterprise application's identity, as required
  // by the product workflow. The user's access token is used only to verify
  // the member during OAuth and is never used as a file-access fallback.
  return getTenantAccessToken();
}

function getConnection(connectionId = "") {
  if (!connectionId) throw new Error("Lark OAuth connection_id is required; connect Lark before using this tool");
  const connection = userConnections.get(connectionId);
  if (!connection) throw new Error("Lark member OAuth connection not found; connect Lark before using this tool");
  return connection;
}

async function getLarkUserInfo(accessToken) {
  const response = await fetchLark(`${baseUrl}/open-apis/authen/v1/user_info`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await parseJson(response);
  return body.data ?? body;
}

function createLarkOAuthUrl({ state, userId = "" }) {
  const query = new URLSearchParams({
    app_id: process.env.LARK_APP_ID,
    redirect_uri: oauthRedirectUri,
    state,
    scope: oauthScopes,
  });
  if (userId) query.set("login_hint", userId);
  return `${baseUrl}/open-apis/authen/v1/authorize?${query}`;
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

async function larkGet(path, connectionId = "") {
  const token = await getAccessToken(connectionId);
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJson(response);
}

async function larkRequest(path, method, body, connectionId = "") {
  const token = await getAccessToken(connectionId);
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return parseJson(response);
}

async function larkGetBuffer(path, connectionId = "") {
  const token = await getAccessToken(connectionId);
  const response = await fetch(`${baseUrl}${path}`, {
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
        : `https://${new URL(baseUrl).hostname}/wiki/${node.node_token}`,
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

async function readLarkDocument(input, connectionId = "") {
  const token = docTokenFromInput(input);
  const query = new URLSearchParams({
    doc_token: token,
    doc_type: "docx",
    content_type: "markdown",
    lang: "en",
  });
  const body = await larkGet(`/open-apis/docs/v1/content?${query}`, connectionId);
  return {
    document_token: token,
    document_type: "docx",
    source_url:
      input.startsWith("http://") || input.startsWith("https://")
        ? input
        : `https://${new URL(baseUrl).hostname}/docx/${token}`,
    content: body.data.content,
  };
}

async function listDriveFiles(folderToken = "", pageToken = "", pageSize = 50, connectionId = "") {
  const query = new URLSearchParams({
    page_size: String(Math.min(Math.max(pageSize, 1), 200)),
    order_by: "EditedTime",
    direction: "DESC",
  });
  if (folderToken) query.set("folder_token", folderToken);
  if (pageToken) query.set("page_token", pageToken);
  const body = await larkGet(`/open-apis/drive/v1/files?${query}`, connectionId);
  return body.data;
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
          source_url: `https://${new URL(baseUrl).hostname}/drive/file/${file.token}`,
          folder_token: current.token || null,
          folder_path: current.path,
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
      source_url: metadata.source_url ?? `https://${new URL(baseUrl).hostname}/drive/file/${fileToken}`,
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
      source_url: metadata.source_url ?? `https://${new URL(baseUrl).hostname}/drive/file/${fileToken}`,
      ...metadata,
      content: parsed.value,
    };
  }
  if (["xlsx", "xls", "csv"].includes(extension) || normalizedMime.includes("spreadsheet")) {
    return {
      file_token: fileToken,
      ...parseSpreadsheet(buffer, name),
      source_url: metadata.source_url ?? `https://${new URL(baseUrl).hostname}/drive/file/${fileToken}`,
      ...metadata,
    };
  }
  if (extension === "txt" || extension === "md" || normalizedMime.startsWith("text/")) {
    return {
      file_token: fileToken,
      file_name: name,
      format: extension || "text",
      source_url: metadata.source_url ?? `https://${new URL(baseUrl).hostname}/drive/file/${fileToken}`,
      ...metadata,
      content: buffer.toString("utf8"),
    };
  }

  return {
    file_token: fileToken,
    file_name: name,
    mime_type: mimeType || "unknown",
    format: "unsupported",
    source_url: metadata.source_url ?? `https://${new URL(baseUrl).hostname}/drive/file/${fileToken}`,
    ...metadata,
    content: "该文件已下载，但当前版本暂不支持提取其文本内容。",
  };
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
  const result = await updateLarkDocument(documentToken, { command: "append", content }, connectionId);
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
    mode: command === "overwrite" ? "replace_all" : "replace_block",
    block_id: blockId || null,
    result: body.data ?? body,
    source_url: `https://${new URL(baseUrl).hostname}/docx/${documentToken}`,
  };
}

async function createLarkDocument({ title, content, folderToken = "", sourceUrls = [], connectionId = "" }) {
  const sourceSection = sourceUrls.length > 0 ? `\n\n## 来源\n\n${sourceUrls.map((url) => `- ${url}`).join("\n")}` : "";
  const created = await larkRequest("/open-apis/docs_ai/v1/documents", "POST", {
    format: "markdown",
    content: `<title>${escapeXmlText(title)}</title>\n\n${content}${sourceSection}`,
    extra_param: JSON.stringify({ open_create_async: true }),
    ...(folderToken ? { parent_token: folderToken } : {}),
  }, connectionId);

  let data = created.data ?? created;
  if (!data.document?.document_id && data.task_id) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const task = await larkGet(`/open-apis/docs_ai/v1/async_tasks/${encodeURIComponent(data.task_id)}`, connectionId);
      data = task.data ?? task;
      if (data.document?.document_id || data.status === "failed" || data.status === "error") break;
    }
  }

  const document = data.document;
  if (!document?.document_id) {
    throw new Error(`Lark document creation did not complete: ${JSON.stringify(data).slice(0, 500)}`);
  }

  const result = {
    document_id: document.document_id,
    title: document.title ?? title,
    url: document.url ?? `https://${new URL(baseUrl).hostname}/docx/${document.document_id}`,
    folder_token: folderToken || null,
  };

  try {
    await grantDocumentEditAccess(document.document_id, connectionId);
    result.permission_granted = true;
    result.permission = "当前 OAuth 用户已获得编辑权限";
  } catch (error) {
    result.permission_granted = false;
    result.permission = "文档已创建，但当前 OAuth 用户编辑权限授予失败";
    result.permission_error = error.message;
  }

  try {
    const verification = await readLarkDocument(document.document_id, connectionId);
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
            oauth_redirect_uri: oauthRedirectUri,
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
      description: "List knowledge bases visible to the configured Lark application. This tool is read-only.",
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
      description: "List pages under a Lark knowledge base or parent page. Use has_child to continue traversing. This tool is read-only.",
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
      description: "List files directly under a Lark Drive folder. This tool is read-only.",
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
      description: "Recursively scan the Lark Drive root or a specified folder and return file metadata and source URLs. This tool is read-only and bounded.",
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
    "save_draft_to_lark",
    {
      title: "Save a draft as a new Lark document",
      description:
        "Use only when the user explicitly asks to create a NEW Lark document. After confirmation, create a new document and write the supplied draft into it. Never use this tool to modify an existing document.",
      inputSchema: {
        confirmed: z.boolean(),
        title: z.string().min(1).max(200),
        content: z.string().min(1).max(100000),
        folder_token: z.string().optional(),
        source_urls: z.array(z.string().url()).max(20).optional(),
        connection_id: z.string().min(1).optional(),
      },
    },
    async ({ confirmed, title, content, folder_token, source_urls, connection_id }) => {
      if (!confirmed) {
        return {
          isError: true,
          content: [{ type: "text", text: "未确认写回。请先向用户展示草稿，并在用户明确确认后再次调用 confirmed=true。" }],
        };
      }
      const result = await createLarkDocument({
        title,
        content,
        folderToken: folder_token,
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
    const state = crypto.randomBytes(24).toString("hex");
    oauthStates.set(state, {
      userId: "",
      createdAt: Date.now(),
      mcp: {
        clientId,
        redirectUri,
        codeChallenge,
        state: requestUrl.searchParams.get("state") ?? "",
      },
    });
    redirect(res, createLarkOAuthUrl({ state }));
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

  if (requestUrl.pathname === "/oauth/lark/start") {
    const state = crypto.randomBytes(24).toString("hex");
    oauthStates.set(state, {
      userId: requestUrl.searchParams.get("user_id") ?? "",
      createdAt: Date.now(),
    });
    const location = createLarkOAuthUrl({
      state,
      userId: requestUrl.searchParams.get("user_id") ?? "",
    });
    res.writeHead(302, { Location: location });
    res.end();
    return;
  }

  if (requestUrl.pathname === "/oauth/lark/callback") {
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
      const tokenBody = await exchangeAuthorizationCode(requestUrl.searchParams.get("code") ?? "");
      const token = tokenBody.data ?? tokenBody;
      const connectionId = crypto.randomUUID();
      const user = await getLarkUserInfo(token.access_token);
      userConnections.set(connectionId, {
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: Date.now() + Math.max(60, (token.expires_in ?? 7200) - 300) * 1000,
        refreshExpiresAt: Date.now() + Math.max(60, (token.refresh_expires_in ?? 2592000) - 300) * 1000,
        userId: pending.userId,
        user,
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
          expires_in: token.expires_in,
          message: "Lark 已连接。请将 connection_id 交给 COUNSO 的连接管理层，后续工具调用使用该 connection_id。",
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
