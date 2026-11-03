export function createDocumentService({ larkGet, larkRequest, docTokenFromInput, getConnection, getConnectionWebBaseUrl }) {
  async function readDocument(input, connectionId = "", identity = "bot") {
    const token = docTokenFromInput(input);
    const query = new URLSearchParams({ doc_token: token, doc_type: "docx", content_type: "markdown", lang: "en" });
    const body = await larkGet(`/open-apis/docs/v1/content?${query}`, connectionId, identity);
    return {
      document_token: token,
      document_type: "docx",
      source_url: input.startsWith("http://") || input.startsWith("https://") ? input : `${getConnectionWebBaseUrl(connectionId)}/docx/${token}`,
      content: body.data.content,
    };
  }
  async function grantEditAccess(documentToken, connectionId = "") {
    const connection = getConnection(connectionId);
    const openId = connection.user?.open_id;
    if (!openId) throw new Error("The connected Lark user has no open_id; cannot grant document edit access");
    const query = new URLSearchParams({ type: "docx", need_notification: "false" });
    return larkRequest(`/open-apis/drive/v1/permissions/${encodeURIComponent(documentToken)}/members?${query}`, "POST", { member_type: "openid", member_id: openId, perm: "edit" }, connectionId);
  }

  async function updateDocument(documentToken, { command, content, blockId = "" }, connectionId = "") {
    const body = await larkRequest(`/open-apis/docs_ai/v1/documents/${encodeURIComponent(documentToken)}`, "PUT", { format: "markdown", command, content, revision_id: -1, ...(blockId ? { block_id: blockId } : {}) }, connectionId);
    return { document_id: documentToken, mode: command === "overwrite" ? "replace_all" : command === "block_insert_after" ? "append" : "replace_block", command, block_id: blockId || null, result: body.data ?? body, source_url: `${getConnectionWebBaseUrl(connectionId)}/docx/${documentToken}` };
  }

  async function appendDocument(documentToken, content, connectionId = "") {
    const result = await updateDocument(documentToken, { command: "block_insert_after", blockId: "-1", content }, connectionId);
    return { ...result, appended_content: content };
  }

  async function listChildren(documentToken, connectionId = "") {
    const query = new URLSearchParams({ page_size: "500" });
    const body = await larkGet(`/open-apis/docx/v1/documents/${encodeURIComponent(documentToken)}/blocks/${encodeURIComponent(documentToken)}/children?${query}`, connectionId);
    return body.data ?? body;
  }

  return { appendDocument, grantEditAccess, listChildren, readDocument, updateDocument };
}
