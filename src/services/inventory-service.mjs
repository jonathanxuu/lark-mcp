export function createInventoryService(dependencies) {
  const { searchLarkDocuments, listWikiSpaces, listAllWikiDocuments, listAllDriveFiles, enrichDocumentPermissions, readLarkDocument, readLarkFile, getConnectionWebBaseUrl } = dependencies;
  async function inventoryLarkDocuments({ mode = "preview", query = "", maxItems = 20, maxFiles = 100, maxWikiNodes = 200, connectionId = "" }) {
  const search = await searchLarkDocuments(query, "", Math.min(maxItems, 20), connectionId);
  const wikiSpaces = await listWikiSpaces("", 50, connectionId);
  const bot = getConnectionBot(connectionId);
  const driveSources = [await listAllDriveFiles("", Math.min(maxFiles, 200), connectionId)];
  if (bot.outputFolderToken) {
    const sharedFolder = await listAllDriveFiles(bot.outputFolderToken, Math.min(maxFiles, 200), connectionId);
    sharedFolder.files = (sharedFolder.files ?? []).map((file) => ({
      ...file,
      folder_path: [defaultOutputFolderName, ...(file.folder_path ?? [])],
    }));
    driveSources.push(sharedFolder);
  }
  const drive = {
    files: [...new Map(driveSources.flatMap((source) => source.files ?? []).map((file) => [file.token, file])).values()]
      .slice(0, Math.min(maxFiles, 200)),
    truncated: driveSources.some((source) => source.truncated),
    scanned_folders: [...new Set(driveSources.flatMap((source) => source.scanned_folders ?? []))],
  };
  const wikiInventory = await listAllWikiDocuments(wikiSpaces, Math.min(maxWikiNodes, 500), connectionId);
  let wikiDocuments = wikiInventory.documents;
  let searchResults = search.results.map((item) => ({
    ...item,
    summary: metadataSummary(item),
    document_origin: item.source_url?.includes("/wiki/") ? "wiki_search_index" : "bot_search_index",
    belongs_to_wiki: item.source_url?.includes("/wiki/") ?? false,
  }));
  let driveFiles = drive.files.map((file) => ({
    ...file,
    summary: metadataSummary(file),
    document_origin: "bot_drive",
    belongs_to_wiki: false,
  }));
  searchResults = await enrichDocumentPermissions(searchResults, connectionId, Math.min(maxItems, 20));
  driveFiles = await enrichDocumentPermissions(driveFiles, connectionId, Math.min(maxItems, 20));
  wikiDocuments = await enrichDocumentPermissions(wikiDocuments, connectionId, Math.min(maxWikiNodes, 100));

  if (mode !== "metadata") {
    let readCount = 0;
    for (const item of wikiDocuments) {
      if (item.document_type !== "docx" || !item.document_token || readCount >= Math.min(maxItems, 20)) continue;
      try {
        const document = await readWikiDocument(item.source_url, connectionId);
        item.summary = summarizeText(document.content);
        if (mode === "content") item.content = document.content;
      } catch (error) {
        item.summary_error = error.message;
      }
      readCount += 1;
    }
  }

  const wikiTokens = new Set(wikiDocuments.map((item) => item.document_token).filter(Boolean));
  const botDocuments = [...searchResults, ...driveFiles]
    .filter((item) => !item.document_token || !wikiTokens.has(item.document_token));
  const permissionItems = [...searchResults, ...driveFiles]
    .map((item) => item.permission)
    .concat(wikiDocuments.map((item) => item.permission))
    .filter(Boolean);
  const result = {
    mode,
    identity: "bot_application",
    include_summary: true,
    search_results: searchResults,
    search_has_more: search.has_more,
    search_next_page_token: search.next_page_token,
    bot_documents: botDocuments,
    wiki_documents: wikiDocuments,
    wiki_spaces: (wikiSpaces.items ?? []).map((space) => ({
      ...space,
      summary: metadataSummary(space),
    })),
    drive_files: driveFiles,
    drive_truncated: drive.truncated,
    scanned_folders: drive.scanned_folders,
    wiki_truncated: wikiInventory.truncated,
    permission_summary: {
      checked: permissionItems.length,
      readable: permissionItems.filter((item) => item.can_read === true).length,
      editable: permissionItems.filter((item) => item.can_edit === true).length,
      read_only: permissionItems.filter((item) => item.permission_status === "read_only").length,
      unknown: permissionItems.filter((item) => item.permission_status === "unknown").length,
    },
    note: "这是一次只读聚合检索。搜索索引和 Drive 列表可能遗漏个人空间中单独分享的文档；如用户提供 URL，应直接调用读取工具验证权限。",
  };

  if (mode === "metadata") return result;

  const candidates = searchResults
    .filter((item) => item.source_url && (item.source_url.includes("/wiki/") || item.source_url.includes("/docx/") || item.source_url.includes("/docs/")))
    .slice(0, Math.min(maxItems, 10));
  const contents = [];
  for (const item of candidates) {
    try {
      const document = item.source_url.includes("/wiki/")
        ? await readWikiDocument(item.source_url, connectionId)
        : await readLarkDocument(item.source_url, connectionId);
      contents.push({
        title: document.title ?? item.title,
        source_url: document.source_url ?? item.source_url,
        document_token: document.document_token,
        summary: summarizeText(document.content),
        content: mode === "preview" ? document.content.slice(0, 1000) : document.content,
        truncated: mode === "preview" || document.content.length > 100000,
      });
    } catch (error) {
      contents.push({ title: item.title, source_url: item.source_url, error: error.message });
    }
  }
  if (mode === "preview" || mode === "content") {
    const fileLimit = Math.min(driveFiles.length, Math.min(maxItems, 10));
    for (const file of driveFiles.slice(0, fileLimit)) {
      if (!file.token || file.type === "folder" || file.file_type === "folder") continue;
      try {
        const document = await readLarkFile(file.token, file.name, file.mime_type ?? file.mimeType ?? "", file, connectionId);
        file.summary = summarizeText(document.content);
        if (mode === "content") file.content = document.content;
      } catch (error) {
        file.summary_error = error.message;
      }
    }
  }
  result.contents = contents;
  return result;
}

  return { inventoryLarkDocuments };
}

