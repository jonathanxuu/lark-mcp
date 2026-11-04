import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSessionStore } from "../src/storage/session-store.mjs";

test("session store restores encrypted connections and MCP tokens after reopening", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "counso-lark-session-"));
  const filePath = path.join(directory, "sessions.sqlite");
  const first = createSessionStore({ filePath, secret: "stable-test-secret" });
  first.userConnections.set("connection-1", { user: { open_id: "ou-test" }, refreshToken: "refresh-secret" });
  first.mcpAccessTokens.set("access-1", { connectionId: "connection-1", expiresAt: Date.now() + 60_000 });
  first.close();

  const second = createSessionStore({ filePath, secret: "stable-test-secret" });
  assert.deepEqual(second.userConnections.get("connection-1"), { user: { open_id: "ou-test" }, refreshToken: "refresh-secret" });
  assert.deepEqual(second.mcpAccessTokens.get("access-1"), { connectionId: "connection-1", expiresAt: second.mcpAccessTokens.get("access-1").expiresAt });
  second.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
