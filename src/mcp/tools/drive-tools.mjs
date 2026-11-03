function register(server, name, config, handler) {
  server.registerTool(name, config, handler);
}

export function registerDriveTools(server, dependencies, { exposeLegacyReadTools = false } = {}) {
  if (!exposeLegacyReadTools) return;
  const { z, resolveConnectionId, listDriveFiles, listAllDriveFiles, readLarkFile, searchDriveFileNames } = dependencies;
  register(server, "list_lark_drive_files", { title: "List Lark Drive files", description: "List files directly under a Lark Drive folder.", inputSchema: { folder_token: z.string().optional(), page_token: z.string().optional(), page_size: z.number().int().min(1).max(200).optional(), connection_id: z.string().min(1).optional() } }, async ({ folder_token, page_token, page_size, connection_id }) => {
    const result = await listDriveFiles(folder_token, page_token, page_size, resolveConnectionId(connection_id));
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  });
  register(server, "list_all_lark_files", { title: "List all accessible Lark Drive files", description: "Recursively scan the Lark Drive root or a specified folder.", inputSchema: { folder_token: z.string().optional(), max_files: z.number().int().min(1).max(10000).optional(), connection_id: z.string().min(1).optional() } }, async ({ folder_token, max_files, connection_id }) => {
    const result = await listAllDriveFiles(folder_token, max_files, resolveConnectionId(connection_id));
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  });
  register(server, "read_lark_file", { title: "Read a Lark file", description: "Download and extract text from a Lark Drive file.", inputSchema: { file_token: z.string().min(1), file_name: z.string().optional(), mime_type: z.string().optional(), source_url: z.string().url().optional(), folder_token: z.string().optional(), folder_path: z.array(z.string()).optional(), modified_time: z.string().optional(), created_time: z.string().optional(), connection_id: z.string().min(1).optional() } }, async ({ file_token, file_name, mime_type, source_url, folder_token, folder_path, modified_time, created_time, connection_id }) => {
    const result = await readLarkFile(file_token, file_name, mime_type, { source_url, folder_token, folder_path, modified_time, created_time }, resolveConnectionId(connection_id));
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  });
  register(server, "search_lark_drive_files", { title: "Search Lark Drive file names", description: "Search file names in the Lark Drive root or one specified folder.", inputSchema: { query: z.string().min(1), folder_token: z.string().optional(), page_size: z.number().int().min(1).max(200).optional(), connection_id: z.string().min(1).optional() } }, async ({ query, folder_token, page_size, connection_id }) => {
    const result = await searchDriveFileNames(query, folder_token, page_size, resolveConnectionId(connection_id));
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  });
}
