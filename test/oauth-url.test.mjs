import test from "node:test";
import assert from "node:assert/strict";
import { createOAuthUrl } from "../src/oauth/url.mjs";

test("builds a provider-specific OAuth URL", () => {
  const build = createOAuthUrl({
    getBot: () => ({ appId: "cli_test", platform: "feishu" }),
    getProvider: () => ({ oauthBaseUrl: "https://accounts.feishu.cn", oauthRedirectUri: "https://example.com/callback", oauthScopes: "docs:read" }),
  });
  const url = new URL(build({ state: "state", userId: "user", botId: "bot" }));
  assert.equal(url.hostname, "accounts.feishu.cn");
  assert.equal(url.searchParams.get("app_id"), "cli_test");
  assert.equal(url.searchParams.get("state"), "state");
});
