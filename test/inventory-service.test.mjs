import test from "node:test";
import assert from "node:assert/strict";
import { createInventoryService } from "../src/services/inventory-service.mjs";

test("inventory service resolves the selected connection bot and shared folder", async () => {
  const service = createInventoryService({
    searchLarkDocuments: async () => ({ results: [], has_more: false, next_page_token: "" }),
    listWikiSpaces: async () => ({ items: [] }),
    listAllWikiDocuments: async () => ({ documents: [], truncated: false }),
    listAllDriveFiles: async (folderToken) => ({
      files: folderToken ? [{ token: "shared-file", name: "Shared file" }] : [],
      scanned_folders: folderToken ? [folderToken] : [],
      truncated: false,
    }),
    enrichDocumentPermissions: async (items) => items,
    readLarkDocument: async () => ({ content: "" }),
    readLarkFile: async () => ({ content: "" }),
    getConnectionBot: () => ({ outputFolderToken: "folder-1" }),
    getConnectionWebBaseUrl: () => "https://example.larksuite.com",
    defaultOutputFolderName: "Counso Lark Bot 默认共享文件夹",
    metadataSummary: () => "",
    summarizeText: (text) => text,
  });

  const result = await service.inventoryLarkDocuments({ mode: "metadata", connectionId: "connection-1" });

  assert.deepEqual(result.drive_files, [
    {
      token: "shared-file",
      name: "Shared file",
      folder_path: ["Counso Lark Bot 默认共享文件夹"],
      summary: "",
      document_origin: "bot_drive",
      belongs_to_wiki: false,
    },
  ]);
  assert.deepEqual(result.scanned_folders, ["folder-1"]);
});
