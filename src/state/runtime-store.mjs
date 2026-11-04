import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { sessionStoreKey, sessionStorePath } from "../config/index.mjs";
import { createSessionStore } from "../storage/session-store.mjs";

export const appAccessTokenCache = new Map();
export const tenantAccessTokenCache = new Map();
export const oauthStates = new Map();
const sessionStore = createSessionStore({ filePath: sessionStorePath, secret: sessionStoreKey });
export const userConnections = sessionStore.userConnections;
export const mcpClients = sessionStore.mcpClients;
export const mcpAuthorizationCodes = new Map();
export const mcpAccessTokens = sessionStore.mcpAccessTokens;
export const mcpConnectionContext = new AsyncLocalStorage();

export function randomToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function pkceChallenge(verifier) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

export function resolveConnectionId(connectionId = "") {
  return mcpConnectionContext.getStore() || connectionId || "";
}
