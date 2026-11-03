export function createDocumentService(dependencies) {
  const { ensureDefaultOutputFolder, resolveUserFolderToken, larkRequest, larkGet, escapeXmlText, getConnectionProvider, getConnectionWebBaseUrl, grantDocumentEditAccess, readLarkDocument } = dependencies;
  return async function createDocument({ title, content, folderToken = "", folderName = "", storageTarget = "default_public_folder", sourceUrls = [], connectionId = "" }) {
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
;
}

