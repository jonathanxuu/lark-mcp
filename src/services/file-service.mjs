export function createFileService(dependencies) {
  const { larkGetBuffer, extensionFor, parseSpreadsheet, mammoth, pdfParse, getConnectionWebBaseUrl } = dependencies;
  async function readLarkFile(fileToken, fileName = "", mimeType = "", metadata = {}, connectionId = "") {
  const buffer = await larkGetBuffer(`/open-apis/drive/v1/files/${encodeURIComponent(fileToken)}/download`, connectionId);
  const name = fileName || fileToken;
  const extension = extensionFor(name);
  const normalizedMime = mimeType.toLowerCase();

  if (buffer.length > 25 * 1024 * 1024) {
    throw new Error("File is larger than the 25 MB text-extraction limit");
  }

  if (extension === "pdf" || normalizedMime.includes("pdf")) {
    const parsed = await pdfParse(buffer);
    return {
      file_token: fileToken,
      file_name: name,
      format: "pdf",
      pages: parsed.numpages,
      source_url: metadata.source_url ?? `${getConnectionWebBaseUrl(connectionId)}/drive/file/${fileToken}`,
      ...metadata,
      content: parsed.text,
    };
  }
  if (["docx", "doc"].includes(extension) || normalizedMime.includes("wordprocessingml")) {
    const parsed = await mammoth.extractRawText({ buffer });
    return {
      file_token: fileToken,
      file_name: name,
      format: extension || "docx",
      source_url: metadata.source_url ?? `${getConnectionWebBaseUrl(connectionId)}/drive/file/${fileToken}`,
      ...metadata,
      content: parsed.value,
    };
  }
  if (["xlsx", "xls", "csv"].includes(extension) || normalizedMime.includes("spreadsheet")) {
    return {
      file_token: fileToken,
      ...parseSpreadsheet(buffer, name),
      source_url: metadata.source_url ?? `${getConnectionWebBaseUrl(connectionId)}/drive/file/${fileToken}`,
      ...metadata,
    };
  }
  if (extension === "txt" || extension === "md" || normalizedMime.startsWith("text/")) {
    return {
      file_token: fileToken,
      file_name: name,
      format: extension || "text",
      source_url: metadata.source_url ?? `${getConnectionWebBaseUrl(connectionId)}/drive/file/${fileToken}`,
      ...metadata,
      content: buffer.toString("utf8"),
    };
  }

  return {
    file_token: fileToken,
    file_name: name,
    mime_type: mimeType || "unknown",
    format: "unsupported",
    source_url: metadata.source_url ?? `${getConnectionWebBaseUrl(connectionId)}/drive/file/${fileToken}`,
    ...metadata,
    content: "该文件已下载，但当前版本暂不支持提取其文本内容。",
  };
}
  return { readLarkFile };
}

