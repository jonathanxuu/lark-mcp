export function createSearchService(dependencies) {
  const { listWikiSpaces, listWikiNodes, listDriveFiles, larkGet, getConnectionWebBaseUrl } = dependencies;
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

  return { searchDriveFileNames, searchLarkDocuments, searchWikiTitles };
}

