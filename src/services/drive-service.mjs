export function createDriveService(dependencies) {
  const { larkGet, larkRequest, getConnectionBot, getConnectionWebBaseUrl, defaultOutputFolderName, metadataSummary } = dependencies;
  async function listDriveFiles(folderToken = "", pageToken = "", pageSize = 50, connectionId = "", identity = "bot") {
  const query = new URLSearchParams({
    page_size: String(Math.min(Math.max(pageSize, 1), 200)),
    order_by: "EditedTime",
    direction: "DESC",
  });
  if (folderToken) query.set("folder_token", folderToken);
  if (pageToken) query.set("page_token", pageToken);
  const body = await larkGet(`/open-apis/drive/v1/files?${query}`, connectionId, identity);
  return body.data;
}

async function ensureDefaultOutputFolder(connectionId = "") {
  const bot = getConnectionBot(connectionId);
  if (bot.outputFolderToken) return bot.outputFolderToken;
  const root = await listDriveFiles("", "", 200, connectionId, "bot");
  const existing = (root.files ?? []).find((file) =>
    file.name === defaultOutputFolderName && (file.type === "folder" || file.file_type === "folder"),
  );
  if (existing?.token) return existing.token;
  const created = await larkRequest(
    "/open-apis/drive/v1/files/create_folder",
    "POST",
    { name: defaultOutputFolderName, folder_token: "" },
    connectionId,
    "bot",
  );
  const data = created.data ?? created;
  if (!data.token) throw new Error(`Unable to create default folder ${defaultOutputFolderName}`);
  return data.token;
}

async function resolveUserFolderToken(folderToken = "", folderName = "", connectionId = "") {
  if (folderToken) return folderToken;
  if (!folderName) throw new Error("storage_target=user_folder requires folder_token or folder_name");
  const root = await listDriveFiles("", "", 200, connectionId, "user");
  const matches = (root.files ?? []).filter((file) =>
    file.name === folderName && (file.type === "folder" || file.file_type === "folder"),
  );
  if (matches.length === 1) return matches[0].token;
  if (matches.length > 1) throw new Error(`当前用户网盘中存在多个名为“${folderName}”的文件夹，请提供 folder_token`);
  throw new Error(`当前用户网盘根目录中找不到文件夹“${folderName}”`);
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
          source_url: `${getConnectionWebBaseUrl(connectionId)}/drive/file/${file.token}`,
          folder_token: current.token || null,
          folder_path: current.path,
          summary: metadataSummary(file),
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

  return { ensureDefaultOutputFolder, listAllDriveFiles, listDriveFiles, resolveUserFolderToken };
}

