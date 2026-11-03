import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

export const appAccessTokenCache = new Map();
export const tenantAccessTokenCache = new Map();
export const oauthStates = new Map();
export const organizationSelectionStates = new Map();
export const botSelectionStates = new Map();
export const userConnections = new Map();
export const mcpClients = new Map();
export const mcpAuthorizationCodes = new Map();
export const mcpAccessTokens = new Map();
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
