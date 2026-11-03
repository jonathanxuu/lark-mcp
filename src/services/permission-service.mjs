export function createPermissionService(dependencies) {
  const { larkGet, getConnectionProvider } = dependencies;
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

  return { checkLarkDocumentPermission, enrichDocumentPermissions, metadataSummary, permissionAllowed, permissionTypeForDocument, summarizeText };
}

