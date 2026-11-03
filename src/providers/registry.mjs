import { defaultOAuthScopes, publicBaseUrl } from "../config/index.mjs";

export const providers = {
  lark: {
    id: "lark",
    label: "Lark",
    apiBaseUrl: process.env.LARK_BASE_URL ?? "https://open.larksuite.com",
    oauthBaseUrl: process.env.LARK_OAUTH_BASE_URL ?? "https://accounts.larksuite.com",
    webBaseUrl: process.env.LARK_WEB_BASE_URL ?? "https://www.larksuite.com",
    oauthRedirectUri: process.env.LARK_OAUTH_REDIRECT_URI ?? `${publicBaseUrl}/oauth/lark/callback`,
    oauthScopes: process.env.LARK_OAUTH_SCOPES ?? defaultOAuthScopes,
    defaultOutputFolderToken: process.env.LARK_OUTPUT_FOLDER_TOKEN ?? "",
  },
  feishu: {
    id: "feishu",
    label: "飞书",
    apiBaseUrl: process.env.FEISHU_BASE_URL ?? "https://open.feishu.cn",
    oauthBaseUrl: process.env.FEISHU_OAUTH_BASE_URL ?? "https://accounts.feishu.cn",
    webBaseUrl: process.env.FEISHU_WEB_BASE_URL ?? "https://www.feishu.cn",
    oauthRedirectUri: process.env.FEISHU_OAUTH_REDIRECT_URI ?? `${publicBaseUrl}/oauth/feishu/callback`,
    oauthScopes: process.env.FEISHU_OAUTH_SCOPES ?? defaultOAuthScopes,
    defaultOutputFolderToken: process.env.FEISHU_OUTPUT_FOLDER_TOKEN ?? "",
  },
};

export function getProvider(platform = "lark") {
  const provider = providers[platform];
  if (!provider) throw new Error(`Unsupported platform: ${platform}`);
  return provider;
}
