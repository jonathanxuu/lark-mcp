import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function deriveKey(secret) {
  return crypto.createHash("sha256").update(String(secret ?? "")).digest();
}

function encryptValue(value, secret) {
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  if (!secret) return `plain:${plaintext.toString("base64url")}`;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
}

function decryptValue(serialized, secret) {
  if (serialized.startsWith("plain:")) {
    return JSON.parse(Buffer.from(serialized.slice("plain:".length), "base64url").toString("utf8"));
  }
  const [version, ivText, tagText, ciphertextText] = serialized.split(":");
  if (version !== "v1" || !ivText || !tagText || !ciphertextText) throw new Error("Invalid session store value");
  if (!secret) throw new Error("LARK_BOT_STORE_KEY is required to decrypt the session store");
  const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(secret), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, "base64url")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}

class PersistentMap {
  constructor(database, namespace, secret) {
    this.database = database;
    this.namespace = namespace;
    this.secret = secret;
    this.getStatement = database.prepare("SELECT value, expires_at FROM runtime_state WHERE namespace = ? AND state_key = ?");
    this.setStatement = database.prepare("INSERT INTO runtime_state (namespace, state_key, value, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(namespace, state_key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at");
    this.deleteStatement = database.prepare("DELETE FROM runtime_state WHERE namespace = ? AND state_key = ?");
    this.clearStatement = database.prepare("DELETE FROM runtime_state WHERE namespace = ?");
  }

  get(key) {
    const row = this.getStatement.get(this.namespace, String(key));
    if (!row) return undefined;
    if (row.expires_at !== null && row.expires_at !== undefined && row.expires_at < Date.now()) {
      this.delete(key);
      return undefined;
    }
    return decryptValue(row.value, this.secret);
  }

  set(key, value, expiresAt = null) {
    this.setStatement.run(this.namespace, String(key), encryptValue(value, this.secret), expiresAt);
    return this;
  }

  delete(key) {
    return this.deleteStatement.run(this.namespace, String(key)).changes > 0;
  }

  clear() {
    this.clearStatement.run(this.namespace);
  }
}

export function createSessionStore({ filePath, secret = "" }) {
  if (filePath !== ":memory:") fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const database = new DatabaseSync(filePath);
  database.exec(`
    CREATE TABLE IF NOT EXISTS runtime_state (
      namespace TEXT NOT NULL,
      state_key TEXT NOT NULL,
      value TEXT NOT NULL,
      expires_at INTEGER,
      PRIMARY KEY (namespace, state_key)
    )
  `);
  return {
    userConnections: new PersistentMap(database, "user_connections", secret),
    mcpAccessTokens: new PersistentMap(database, "mcp_access_tokens", secret),
    mcpClients: new PersistentMap(database, "mcp_clients", secret),
    close: () => database.close(),
  };
}
