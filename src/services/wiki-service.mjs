export function createWikiService(dependencies) {
  const { larkGet, getConnectionWebBaseUrl, metadataSummary } = dependencies;
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
  
  return { listAllWikiDocuments, listWikiNodes, listWikiSpaces, readWikiDocument };
}

