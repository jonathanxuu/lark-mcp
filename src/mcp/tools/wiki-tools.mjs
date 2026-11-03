function register(server, name, config, handler) {
  server.registerTool(name, config, handler);
}

export function registerWikiTools(server, dependencies, { exposeLegacyReadTools = false } = {}) {
  if (!exposeLegacyReadTools) return;
  const { z, resolveConnectionId, readWikiDocument, readLarkDocument, getDocumentChildren, listWikiSpaces, listWikiNodes, searchWikiTitles, docTokenFromInput, metadataSummary } = dependencies;
  register(server, "read_lark_wiki", { title: "Read a Lark wiki page", description: "Read the markdown content of a Lark knowledge-base page.", inputSchema: { wiki_url_or_token: z.string().min(1), connection_id: z.string().min(1).optional() } }, async ({ wiki_url_or_token, connection_id }) => {
    const result = await readWikiDocument(wiki_url_or_token, resolveConnectionId(connection_id));
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  });
  register(server, "read_lark_document", { title: "Read a Lark cloud document", description: "Read the markdown content of a Lark docx document.", inputSchema: { document_url_or_token: z.string().min(1), connection_id: z.string().min(1).optional() } }, async ({ document_url_or_token, connection_id }) => {
    const result = await readLarkDocument(document_url_or_token, resolveConnectionId(connection_id));
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  });
  register(server, "list_lark_document_blocks", { title: "List blocks in a Lark document", description: "List direct blocks in a Lark document for precise editing.", inputSchema: { document_url_or_token: z.string().min(1), connection_id: z.string().min(1).optional() } }, async ({ document_url_or_token, connection_id }) => {
    const documentToken = docTokenFromInput(document_url_or_token);
    const data = await getDocumentChildren(documentToken, resolveConnectionId(connection_id));
    const blocks = (data.items ?? data.blocks ?? []).map((block) => ({ block_id: block.block_id, block_type: block.block_type, text: (block.text?.elements ?? []).map((element) => element.text_run?.content ?? "").join("") }));
    const result = { document_id: documentToken, blocks, has_more: Boolean(data.has_more), next_page_token: data.next_page_token ?? null };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  });
  register(server, "list_lark_wiki_spaces", { title: "List Lark knowledge bases", description: "List knowledge bases visible to the configured application.", inputSchema: { page_token: z.string().optional(), page_size: z.number().int().min(1).max(50).optional(), connection_id: z.string().min(1).optional() } }, async ({ page_token, page_size, connection_id }) => {
    const result = await listWikiSpaces(page_token, page_size, resolveConnectionId(connection_id));
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  });
  register(server, "list_lark_wiki_nodes", { title: "List Lark knowledge-base pages", description: "List pages under a Lark knowledge base or parent page.", inputSchema: { space_id: z.string().min(1), parent_node_token: z.string().optional(), page_token: z.string().optional(), page_size: z.number().int().min(1).max(50).optional(), connection_id: z.string().min(1).optional() } }, async ({ space_id, parent_node_token, page_token, page_size, connection_id }) => {
    const result = await listWikiNodes(space_id, parent_node_token, page_token, page_size, resolveConnectionId(connection_id));
    result.items = (result.items ?? []).map((item) => ({ ...item, summary: metadataSummary(item) }));
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  });
  register(server, "search_lark_wiki", { title: "Search Lark knowledge bases", description: "Search accessible knowledge-base page titles.", inputSchema: { query: z.string().min(1), max_results: z.number().int().min(1).max(100).optional(), max_nodes: z.number().int().min(1).max(5000).optional(), connection_id: z.string().min(1).optional() } }, async ({ query, max_results, max_nodes, connection_id }) => {
    const result = await searchWikiTitles(query, max_results, max_nodes, resolveConnectionId(connection_id));
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  });
}
