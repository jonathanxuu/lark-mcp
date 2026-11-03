import test from "node:test";
import assert from "node:assert/strict";
import { escapeXmlText, createContentUtils } from "../src/services/content-utils.mjs";

test("escapes XML text", () => {
  assert.equal(escapeXmlText(`<title>Tom & Jerry</title>`), "&lt;title&gt;Tom &amp; Jerry&lt;/title&gt;");
});

test("parses spreadsheet content through the service boundary", async () => {
  const utils = createContentUtils({
    mammoth: {},
    pdfParse: async () => ({ text: "" }),
    XLSX: { read: () => ({ SheetNames: ["Sheet1"], Sheets: { Sheet1: {} } }), utils: { sheet_to_csv: () => "a,b" } },
  });
  assert.deepEqual(await utils.parseSpreadsheet(Buffer.from(""), "test.xlsx"), { file_name: "test.xlsx", format: "spreadsheet", content: "## Sheet1\n\na,b" });
});
