import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function encryptSecret(secret, botStoreKey) {
  if (!botStoreKey) throw new Error("LARK_BOT_STORE_KEY is required for encrypted Bot storage");
  const key = crypto.createHash("sha256").update(botStoreKey).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

export function decryptSecret(value, botStoreKey) {
  if (!botStoreKey) throw new Error("LARK_BOT_STORE_KEY is required for encrypted Bot storage");
  const key = crypto.createHash("sha256").update(botStoreKey).digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function readBotStore(botStorePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(botStorePath, "utf8"));
    return Array.isArray(raw.bots) ? raw.bots : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw new Error(`Cannot read Lark Bot store: ${error.message}`);
  }
}

export function writeBotStore(botStorePath, bots) {
  fs.mkdirSync(path.dirname(path.resolve(botStorePath)), { recursive: true });
  const tempPath = `${botStorePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify({ version: 1, bots }, null, 2), { mode: 0o600 });
  fs.renameSync(tempPath, botStorePath);
}

export function loadStaticBotRegistry({ providers, getProvider }) {
  const configured = process.env.LARK_BOTS_JSON?.trim();
  if (!configured) {
    if (!process.env.LARK_APP_ID || !process.env.LARK_APP_SECRET) return [];
    return [{ id: "default", platform: "lark", name: "COUNSO Lark 助手", appId: process.env.LARK_APP_ID, appSecret: process.env.LARK_APP_SECRET, outputFolderToken: providers.lark.defaultOutputFolderToken, description: "默认 Lark 应用" }];
  }

  let bots;
  try {
    bots = JSON.parse(configured);
  } catch (error) {
    throw new Error(`LARK_BOTS_JSON is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(bots) || bots.length === 0) throw new Error("LARK_BOTS_JSON must be a non-empty array");
  const normalized = bots.map((bot, index) => {
    const platform = String(bot.platform ?? "lark").toLowerCase();
    return {
      id: String(bot.id ?? `bot-${index + 1}`),
      platform,
      name: String(bot.name ?? bot.id ?? `Lark Bot ${index + 1}`),
      appId: bot.app_id ?? bot.appId,
      appSecret: bot.app_secret ?? bot.appSecret,
      outputFolderToken: bot.output_folder_token ?? bot.outputFolderToken ?? getProvider(platform).defaultOutputFolderToken,
      description: bot.description ?? "",
    };
  });
  if (normalized.some((bot) => !bot.appId || !bot.appSecret)) throw new Error("Every LARK_BOTS_JSON entry requires app_id and app_secret");
  if (normalized.some((bot) => !providers[bot.platform])) throw new Error("Every LARK_BOTS_JSON entry requires platform=lark or platform=feishu");
  if (new Set(normalized.map((bot) => bot.id)).size !== normalized.length) throw new Error("LARK_BOTS_JSON bot ids must be unique");
  return normalized;
}

export function loadBotRegistry({ botStorePath, botStoreKey, providers, getProvider }) {
  const staticBots = loadStaticBotRegistry({ providers, getProvider });
  const storedBots = readBotStore(botStorePath).map((bot) => ({
    id: bot.id,
    platform: bot.platform ?? "lark",
    name: bot.name,
    appId: bot.app_id,
    appSecret: decryptSecret(bot.app_secret, botStoreKey),
    outputFolderToken: bot.output_folder_token ?? getProvider(bot.platform ?? "lark").defaultOutputFolderToken,
    description: bot.description ?? "",
    organizationId: bot.organization_id ?? "",
    organizationName: bot.organization_name ?? "",
    tenantKey: bot.tenant_key ?? "",
    bootstrap: bot.bootstrap === true,
    source: "store",
  }));
  const merged = new Map(staticBots.map((bot) => [bot.id, { ...bot, source: "env" }]));
  for (const bot of storedBots) merged.set(bot.id, bot);
  return [...merged.values()];
}
