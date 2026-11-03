export function registerDocumentTools(server, dependencies) {
  const { z, resolveConnectionId, readLarkResource, inventoryLarkDocuments, createLarkDocument, appendToLarkDocument, updateLarkDocument, docTokenFromInput } = dependencies;
  server.registerTool(
    "lark_documents",
    {
      title: "Browse or read Lark documents",
      description:
        "The single read-only entry point for Lark documents. Use action=inventory to return Bot-accessible documents and the documents actually contained in each Wiki space, with separate bot_documents and wiki_documents arrays, summaries, and per-document can_read/can_edit permission results. Use action=read with one or more Lark URLs/tokens to read and check them in one operation. This tool is intentionally consolidated so the client normally asks for Allow only once. Results may omit documents that are not in the Bot's search index; paste a direct Lark URL in action=read to verify access. Never use this tool to create or modify documents.",
      inputSchema: {
        action: z.enum(["inventory", "read"]).optional().default("inventory"),
        mode: z.enum(["preview", "content", "metadata"]).optional().default("preview"),
        query: z.string().max(30).optional(),
        urls: z.array(z.string().min(1)).max(20).optional(),
        max_items: z.number().int().min(1).max(20).optional(),
        max_files: z.number().int().min(1).max(200).optional(),
        max_wiki_nodes: z.number().int().min(1).max(500).optional(),
        connection_id: z.string().min(1).optional(),
      },
    },
    async ({ action, mode, query, urls, max_items, max_files, max_wiki_nodes, connection_id }) => {
      const connectionId = resolveConnectionId(connection_id);
      const selectedAction = action ?? "inventory";
      const selectedMode = mode ?? "preview";

      if (selectedAction === "read") {
        if (!urls?.length) {
          return {
            isError: true,
            content: [{ type: "text", text: "action=read requires at least one Lark document, Wiki, or Drive URL/token in urls." }],
          };
        }
        const documents = [];
        for (const url of urls) {
          try {
            documents.push(await readLarkResource(url, selectedMode === "metadata" ? "preview" : selectedMode, connectionId));
          } catch (error) {
            documents.push({ source_url: url, error: error.message });
          }
        }
        const result = { action: "read", mode: selectedMode, count: documents.length, documents };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      }

      const result = await inventoryLarkDocuments({
        mode: selectedMode,
        query: query ?? "",
        maxItems: max_items ?? 20,
        maxFiles: max_files ?? 100,
        maxWikiNodes: max_wiki_nodes ?? 200,
        connectionId,
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ action: "inventory", ...result }, null, 2) }],
        structuredContent: { action: "inventory", ...result },
      };
    },
  );

  server.registerTool(
    "save_draft_to_lark",
    {
      title: "Save a draft as a new Lark document",
      description:
        "Use only when the user explicitly asks to create a NEW Lark document. Before calling, ask where to store it and require storage_target: default_public_folder (the Counso Lark Bot shared folder), user_drive (the current OAuth user's Drive root), or user_folder (the current OAuth user's specified folder, using folder_token or an exact folder_name). Tell the user the default is the Counso Lark Bot folder. After confirmation, create the document in that location. Never use this tool to modify an existing document.",
      inputSchema: {
        confirmed: z.boolean(),
        title: z.string().min(1).max(200),
        content: z.string().min(1).max(100000),
        storage_target: z.enum(["default_public_folder", "user_drive", "user_folder"]),
        folder_token: z.string().optional(),
        folder_name: z.string().min(1).max(200).optional(),
        source_urls: z.array(z.string().url()).max(20).optional(),
        connection_id: z.string().min(1).optional(),
      },
    },
    async ({ confirmed, title, content, storage_target, folder_token, folder_name, source_urls, connection_id }) => {
      if (!confirmed) {
        return {
          isError: true,
          content: [{ type: "text", text: "未确认写回。请先向用户展示草稿，并在用户明确确认后再次调用 confirmed=true。" }],
        };
      }
      const result = await createLarkDocument({
        title,
        content,
        storageTarget: storage_target,
        folderToken: folder_token,
        folderName: folder_name,
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

}

