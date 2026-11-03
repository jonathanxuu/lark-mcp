export function createContentUtils({ mammoth, pdfParse, XLSX }) {
  function extensionFor(name = "") {
    return name.toLowerCase().split(".").pop();
  }

  async function parseSpreadsheet(buffer, fileName) {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheets = workbook.SheetNames.map((name) => `## ${name}\n\n${XLSX.utils.sheet_to_csv(workbook.Sheets[name])}`);
    return { file_name: fileName, format: "spreadsheet", content: sheets.join("\n\n") };
  }

  async function extractFileText(buffer, fileName, mimeType = "") {
    const extension = extensionFor(fileName);
    if (extension === "pdf" || mimeType.includes("pdf")) return (await pdfParse(buffer)).text;
    if (["doc", "docx"].includes(extension) || mimeType.includes("word")) return (await mammoth.extractRawText({ buffer })).value;
    if (["xlsx", "xls", "csv"].includes(extension) || mimeType.includes("spreadsheet") || mimeType.includes("csv")) return parseSpreadsheet(buffer, fileName);
    return buffer.toString("utf8");
  }

  return { extensionFor, extractFileText, parseSpreadsheet };
}

export function escapeXmlText(value) {
  return value.replace(/[<>&'\"]/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[character]);
}
