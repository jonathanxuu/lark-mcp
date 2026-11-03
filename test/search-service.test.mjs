import test from "node:test";
import assert from "node:assert/strict";
import { createSearchService } from "../src/services/search-service.mjs";

test("search service uses the request client for document search", async () => {
  let called = false;
  const service = createSearchService({
    listWikiSpaces: async () => ({ items: [] }),
    listWikiNodes: async () => ({ items: [] }),
    listDriveFiles: async () => ({ files: [] }),
    larkRequest: async (path, method, body, connectionId) => {
      called = true;
      assert.equal(path, "/open-apis/search/v2/doc_wiki/search");
      assert.equal(method, "POST");
      assert.equal(body.query, "Homepage");
      assert.equal(connectionId, "connection-1");
      return { data: { res_units: [{ title: "Homepage", result_meta: { token: "doc-1", url: "https://example.larksuite.com/docx/doc-1" } }] } };
    },
    getConnectionWebBaseUrl: () => "https://example.larksuite.com",
  });

  const result = await service.searchLarkDocuments("Homepage", "", 20, "connection-1");
  assert.equal(called, true);
  assert.equal(result.results[0].document_token, "doc-1");
});
