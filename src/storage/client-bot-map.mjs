import fs from "node:fs";

function normalizeEntry(value) {
  if (typeof value === "string") return { botId: value, redirectUris: [] };
  if (!value || typeof value !== "object") return null;
  const botId = String(value.bot_id ?? value.botId ?? "").trim();
  if (!botId) return null;
  const redirectUris = Array.isArray(value.redirect_uris)
    ? value.redirect_uris.map((uri) => String(uri)).filter(Boolean)
    : [];
  return { botId, redirectUris };
}

export function loadClientBotMap(pathname) {
  try {
    const raw = JSON.parse(fs.readFileSync(pathname, "utf8"));
    const entries = raw?.clients && typeof raw.clients === "object" ? raw.clients : raw;
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw new Error("must be an object");
    return new Map(Object.entries(entries).map(([clientId, value]) => [String(clientId), normalizeEntry(value)]).filter(([, value]) => value));
  } catch (error) {
    if (error.code === "ENOENT") return new Map();
    throw new Error(`Cannot read Lark client mapping: ${error.message}`);
  }
}
