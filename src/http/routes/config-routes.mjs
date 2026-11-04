const CONFIG_COOKIE = "counso_lark_config";
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const DEFAULT_REDIRECT_URI = "https://app.counso.ai/oauth/mcp_static/finalize";

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie ?? "").split(";").map((item) => item.trim()).filter(Boolean).map((item) => {
    const index = item.indexOf("=");
    return index < 0 ? [item, ""] : [item.slice(0, index), decodeURIComponent(item.slice(index + 1))];
  }));
}

function signSession(payload, crypto, accessKey) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", accessKey).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function isAuthenticated(req, crypto, accessKey) {
  const value = parseCookies(req)[CONFIG_COOKIE] ?? "";
  const [encoded, signature] = value.split(".");
  if (!encoded || !signature) return false;
  const expected = crypto.createHmac("sha256", accessKey).update(encoded).digest("base64url");
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return false;
  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")).exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function publicConfigBot(bot) {
  return {
    id: bot.id,
    platform: bot.platform ?? "lark",
    name: bot.name,
    organization_name: bot.organizationName || "",
    app_id: bot.appId,
    output_folder_token: bot.outputFolderToken || "",
    redirect_uris: bot.redirectUris ?? [],
    bootstrap: bot.bootstrap === true,
    configured_at: bot.configuredAt ?? null,
    updated_at: bot.updatedAt ?? null,
  };
}

function oauthConfig(bot, publicBaseUrl) {
  const issuer = `${publicBaseUrl.replace(/\/+$/, "")}/${bot.platform ?? "lark"}`;
  const platform = bot.platform ?? "lark";
  return {
    client_id: bot.appId,
    client_secret: "",
    token_endpoint: `${issuer}/oauth/token`,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    scopes: `${platform}:read ${platform}:write`,
    resource: `${issuer}/mcp`,
  };
}

function findByAppId(botRegistry, appId) {
  return botRegistry.find((bot) => bot.appId === appId) ?? null;
}

function renderPage(authenticated) {
  const login = `
    <main class="auth-card">
      <div class="brand"><span class="brand-mark">✦</span><span>COUNSO</span><small>LARK MCP</small></div>
      <div class="eyebrow">PRIVATE CONFIGURATION</div>
      <h1>Bot Configuration</h1>
      <p class="muted">请输入配置访问密钥，进入组织 Bot 管理控制台。</p>
      <form id="login-form" class="stack">
        <label>访问密钥<input id="access-key" type="password" autocomplete="current-password" placeholder="输入 10 位访问密钥" required /></label>
        <button class="primary" type="submit">解锁配置中心 <span>→</span></button>
        <p id="login-error" class="error"></p>
      </form>
    </main>`;
  const app = `
    <main class="app-shell">
      <header class="topbar"><div class="brand"><span class="brand-mark">✦</span><span>COUNSO</span><small>LARK MCP</small></div><span class="secure-pill">● SECURE CONFIG</span></header>
      <section class="hero"><div><div class="eyebrow">BOT CONFIGURATION</div><h1>添加组织 Bot</h1><p class="muted">为你的组织接入 Lark 或飞书 Bot，配置完成后即可用于 MCP 连接。</p></div></section>
      <section class="grid">
        <div class="panel form-panel"><div class="panel-title"><span class="icon">＋</span><div><h2>添加 Bot</h2><p>填写完整信息后保存到服务端</p></div></div>
          <form id="bot-form" class="form-grid">
            <label>平台<select id="platform"><option value="lark">Lark</option><option value="feishu">飞书</option></select></label>
            <label>机器人名称<input id="name" required placeholder="例如：Counso Lark 助手" /></label>
            <label class="wide">组织名称<input id="organization-name" required placeholder="例如：Counso" /></label>
            <label class="wide">App ID<input id="app-id" required placeholder="cli_xxx" /></label>
            <label class="wide">App Secret<input id="app-secret" type="password" required placeholder="只在服务端加密保存" /></label>
            <label class="wide">Tenant Key / Tenant ID<input id="tenant-key" required placeholder="不会在查询结果中展示" /></label>
            <label class="wide">默认共享文件夹 Token<input id="output-folder-token" placeholder="可选" /></label>
            <label class="wide">Redirect URI<input id="redirect-uri" value="${DEFAULT_REDIRECT_URI}" /></label>
            <label class="check wide"><input id="bootstrap" type="checkbox" /> 设为该组织的默认 Bot</label>
            <div class="actions wide"><button class="primary" type="submit">确定添加 <span>→</span></button><button class="ghost" type="button" id="reset-form">清空</button></div>
            <p id="form-message" class="message wide"></p>
          </form>
        </div>
        <div class="panel oauth-panel"><div class="panel-title"><span class="icon">↗</span><div><h2>OAuth 参数</h2><p>复制到 Counso 的 MCP 配置页面</p></div></div>
          <form id="oauth-query-form" class="query-row"><input id="oauth-app-id" placeholder="输入 App ID 查询 OAuth 参数" required /><button class="secondary" type="submit">查询</button></form>
          <div id="oauth-result" class="result empty"><div class="empty-icon">⌘</div><p>提交 Bot 后，OAuth 参数会显示在这里</p></div>
        </div>
      </section>
      <footer>Protected by COUNSO Lark MCP · App ID 已注册时请联系管理员处理</footer>
    </main>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>COUNSO Lark MCP · 配置中心</title><style>${styles()}</style></head><body>${authenticated ? app : login}<script>${script(authenticated)}</script></body></html>`;
}

function styles() {
  return `:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#102b52;background:#f4f8ff}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 15% 10%,#e1efff 0,transparent 32%),linear-gradient(135deg,#f8fbff,#edf5ff);background-attachment:fixed}body:before{content:"";position:fixed;inset:0;opacity:.38;pointer-events:none;background-image:linear-gradient(#d9e8fb 1px,transparent 1px),linear-gradient(90deg,#d9e8fb 1px,transparent 1px);background-size:42px 42px}.auth-card,.app-shell{position:relative;max-width:1180px;margin:0 auto;padding:44px 28px}.auth-card{max-width:470px;margin-top:12vh;background:#fff;border:1px solid #d8e8fb;border-radius:28px;box-shadow:0 24px 70px #397acb22}.brand{display:flex;align-items:center;gap:10px;color:#1668d3;font-weight:800;letter-spacing:.16em}.brand small{color:#8aa6c9;font-size:11px;letter-spacing:.13em}.brand-mark{display:grid;place-items:center;width:38px;height:38px;border-radius:12px;color:#fff;background:linear-gradient(145deg,#1d8cff,#2c61d9);box-shadow:0 9px 20px #247be944;font-size:22px}.eyebrow{margin-top:58px;color:#4288db;font-size:12px;font-weight:800;letter-spacing:.2em}h1{margin:12px 0 8px;font-size:38px;letter-spacing:-.04em}h2{margin:0;font-size:18px}.muted{color:#7892b2;line-height:1.7}.stack{display:grid;gap:18px;margin-top:30px}label{display:grid;gap:8px;color:#4a688b;font-size:13px;font-weight:700}input,select{width:100%;border:1px solid #d4e4f7;border-radius:12px;background:#fbfdff;color:#183658;padding:13px 14px;font:inherit;outline:none;transition:.2s}input:focus,select:focus{border-color:#468fe3;box-shadow:0 0 0 4px #468fe31a}.primary,.secondary,.ghost{border:0;border-radius:12px;padding:13px 17px;font:inherit;font-weight:800;cursor:pointer}.primary{color:#fff;background:linear-gradient(100deg,#167bed,#3158d9);box-shadow:0 10px 22px #2876dc35}.primary span{float:right;font-size:18px}.secondary{color:#1768c9;background:#e5f1ff}.ghost{color:#6381a4;background:#eef5fc}.error{color:#d04456;min-height:20px}.topbar{display:flex;justify-content:space-between;align-items:center}.secure-pill{color:#3980cf;font-size:11px;letter-spacing:.12em}.hero{padding:64px 0 35px}.hero h1{font-size:42px}.grid{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,.95fr);gap:22px}.single-panel{grid-template-columns:minmax(0,760px);justify-content:center}.panel{background:#fff;border:1px solid #d8e8fb;border-radius:24px;padding:25px;box-shadow:0 18px 50px #397acb12}.panel-title{display:flex;gap:13px;align-items:center;margin-bottom:23px}.panel-title p{margin:5px 0 0;color:#89a1bd;font-size:12px}.icon{display:grid;place-items:center;width:38px;height:38px;border-radius:12px;color:#187be4;background:#e7f3ff;font-size:22px}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.wide{grid-column:1/-1}.check{display:flex;align-items:center;grid-template-columns:auto 1fr;font-weight:600}.check input{width:17px;height:17px}.actions{display:flex;gap:10px}.message{min-height:20px;color:#2778cc}.oauth-result{padding:16px;background:#f7fbff;border:1px solid #dbeaf9}.oauth-fields{display:grid;gap:13px}.oauth-field{display:grid;gap:6px}.oauth-label{color:#7590ad;font-size:12px;font-weight:800}.oauth-value{display:flex;align-items:center;gap:8px}.oauth-value code{flex:1;min-width:0;overflow-wrap:anywhere;color:#204a79;background:#fff;border:1px solid #dbe8f5;border-radius:9px;padding:10px;font-size:12px}.copy-btn{border:0;border-radius:9px;padding:10px 11px;color:#2475c6;background:#e4f1ff;font-weight:800;cursor:pointer}.copy-all{width:100%;margin-top:17px}footer{text-align:center;color:#9ab0c9;font-size:12px;padding:28px}button:disabled{opacity:.45;cursor:not-allowed}@media(max-width:820px){.grid{grid-template-columns:1fr}.hero{padding-top:40px}}@media(max-width:560px){.app-shell,.auth-card{padding:24px 18px}.form-grid{grid-template-columns:1fr}.wide{grid-column:auto}.hero h1,h1{font-size:32px}.actions{flex-wrap:wrap}}`;
}

function legacyScript(authenticated) {
  if (!authenticated) return `document.querySelector('#login-form').addEventListener('submit',async(e)=>{e.preventDefault();const r=await fetch('/config/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({access_key:document.querySelector('#access-key').value})});if(r.ok)location.reload();else document.querySelector('#login-error').textContent='访问密钥错误，请重试。'});`;
  return `const $=s=>document.querySelector(s);const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));let current=null;const msg=(text,ok=false)=>{const e=$('#form-message');e.textContent=text;e.style.color=ok?'#287bcc':'#c83d52'};function fill(bot){$('#platform').value=bot.platform;$('#name').value=bot.name;$('#organization-name').value=bot.organization_name;$('#app-id').value=bot.app_id;$('#app-secret').value='';$('#app-secret').required=false;$('#app-secret').placeholder='留空表示保持原 Secret';$('#tenant-key').value='';$('#tenant-key').required=false;$('#tenant-key').placeholder='留空表示保持原 Tenant Key';$('#output-folder-token').value=bot.output_folder_token;$('#redirect-uri').value=bot.redirect_uris?.[0]||'${DEFAULT_REDIRECT_URI}';$('#bootstrap').checked=bot.bootstrap;$('#bot-form').dataset.editId=bot.id;$('.form-panel h2').textContent='修改 Bot';$('.form-panel .panel-title p').textContent='Secret 和 Tenant Key 留空表示保持不变';$('.form-panel .primary').innerHTML='保存修改 <span>→</span>'}function reset(){current=null;$('#bot-form').reset();$('#bot-form').dataset.editId='';$('#redirect-uri').value='${DEFAULT_REDIRECT_URI}';$('#app-secret').required=true;$('#app-secret').placeholder='只在服务端加密保存';$('#tenant-key').required=true;$('#tenant-key').placeholder='不会在查询结果中展示';$('.form-panel h2').textContent='添加 Bot';$('.form-panel .panel-title p').textContent='填写完整信息后保存到服务端';$('.form-panel .primary').innerHTML='确定添加 <span>→</span>';msg('')}$('#reset-form').onclick=reset;$('#query-form').onsubmit=async(e)=>{e.preventDefault();const id=$('#query-app-id').value.trim();const r=await fetch('/config/api/bots?app_id='+encodeURIComponent(id));const data=await r.json();if(!r.ok){current=null;$('#result').className='result empty';$('#result').innerHTML='<div class="empty-icon">!</div><p>'+esc(data.error||'未找到配置')+'</p>';return}current=data.bot;$('#result').className='result';$('#result').innerHTML='<div class="bot-card"><div class="bot-head"><div><div class="bot-name">'+esc(current.name)+'</div><div class="muted">'+esc(current.organization_name)+'</div></div><span class="badge">'+esc(current.platform.toUpperCase())+'</span></div><div class="facts"><div>App ID<strong>'+esc(current.app_id)+'</strong></div><div>配置时间<strong>'+(current.configured_at?new Date(current.configured_at).toLocaleString():'—')+'</strong></div><div>最近更新<strong>'+(current.updated_at?new Date(current.updated_at).toLocaleString():'—')+'</strong></div><div>共享文件夹<strong>'+(current.output_folder_token?'已配置':'未配置')+'</strong></div></div><div class="result-actions"><button class="secondary" id="edit-btn">修改</button><button class="ghost danger" id="delete-btn">删除</button></div></div>';$('#edit-btn').onclick=()=>fill(current);$('#delete-btn').onclick=async()=>{if(!confirm('确定删除这个 Bot 配置吗？'))return;const response=await fetch('/config/api/bots/'+encodeURIComponent(current.id)+'?app_id='+encodeURIComponent(current.app_id),{method:'DELETE'});const body=await response.json();if(!response.ok){msg(body.error||'删除失败');return}msg('Bot 已删除',true);$('#result').className='result empty';$('#result').innerHTML='<div class="empty-icon">✓</div><p>配置已删除</p>';current=null;reset()}};$('#bot-form').onsubmit=async(e)=>{e.preventDefault();const editing=$('#bot-form').dataset.editId;const body={platform:$('#platform').value,name:$('#name').value.trim(),organization_name:$('#organization-name').value.trim(),app_id:$('#app-id').value.trim(),app_secret:$('#app-secret').value,tenant_key:$('#tenant-key').value,output_folder_token:$('#output-folder-token').value.trim(),redirect_uris:[$('#redirect-uri').value.trim()].filter(Boolean),bootstrap:$('#bootstrap').checked};const editUrl=editing?'/config/api/bots/'+encodeURIComponent(editing)+'?app_id='+encodeURIComponent(body.app_id):'/config/api/bots';const r=await fetch(editUrl,{method:editing?'PUT':'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const data=await r.json();if(!r.ok){msg(data.error||'保存失败');return}msg(editing?'Bot 修改成功':'Bot 添加成功',true);$('#query-app-id').value=body.app_id;$('#query-form').requestSubmit();if(!editing)reset()};`;
}

function script(authenticated) {
  if (!authenticated) return `document.querySelector('#login-form').addEventListener('submit',async(e)=>{e.preventDefault();const r=await fetch('/config/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({access_key:document.querySelector('#access-key').value})});if(r.ok)location.reload();else document.querySelector('#login-error').textContent='访问密钥错误，请重试。'});`;
  return `const $=s=>document.querySelector(s);const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const msg=(text,ok=false)=>{const e=$('#form-message');e.textContent=text;e.style.color=ok?'#287bcc':'#c83d52'};const showOAuth=(o)=>{const fields=[['OAuth Client ID','client_id',o.client_id],['OAuth Client Secret','client_secret',o.client_secret],['OAuth Token Endpoint','token_endpoint',o.token_endpoint],['OAuth Authorization Endpoint','authorization_endpoint',o.authorization_endpoint],['OAuth Scope(s)','scopes',o.scopes],['OAuth Resource / Audience','resource',o.resource]];$('#oauth-result').className='result oauth-result';$('#oauth-result').innerHTML='<div class="oauth-fields">'+fields.map(([label,key,value])=>'<div class="oauth-field"><div class="oauth-label">'+label+'</div><div class="oauth-value"><code>'+esc(value||'留空')+'</code><button type="button" class="copy-btn" data-copy="'+esc(value)+'">复制</button></div></div>').join('')+'</div><button type="button" class="primary copy-all" id="copy-all">复制全部参数</button>';document.querySelectorAll('[data-copy]').forEach(b=>b.onclick=()=>navigator.clipboard.writeText(b.dataset.copy||'').then(()=>{b.textContent='已复制';setTimeout(()=>b.textContent='复制',1200)}));$('#copy-all').onclick=()=>navigator.clipboard.writeText(fields.map(([label,,value])=>label+':\\n'+(value||'')).join('\\n\\n')).then(()=>{$('#copy-all').textContent='已复制全部参数';setTimeout(()=>$('#copy-all').textContent='复制全部参数',1200)})};$('#reset-form').onclick=()=>{$('#bot-form').reset();$('#redirect-uri').value='${DEFAULT_REDIRECT_URI}';msg('')};$('#bot-form').onsubmit=async(e)=>{e.preventDefault();const body={platform:$('#platform').value,name:$('#name').value.trim(),organization_name:$('#organization-name').value.trim(),app_id:$('#app-id').value.trim(),app_secret:$('#app-secret').value,tenant_key:$('#tenant-key').value,output_folder_token:$('#output-folder-token').value.trim(),redirect_uris:[$('#redirect-uri').value.trim()].filter(Boolean),bootstrap:$('#bootstrap').checked};const r=await fetch('/config/api/bots',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const data=await r.json();if(!r.ok){msg(data.error||'保存失败');return}msg('Bot 添加成功，OAuth 参数已生成',true);showOAuth(data.oauth);$('#oauth-app-id').value=body.app_id;$('#bot-form').reset();$('#redirect-uri').value='${DEFAULT_REDIRECT_URI}'};$('#oauth-query-form').onsubmit=async(e)=>{e.preventDefault();const appId=$('#oauth-app-id').value.trim();const r=await fetch('/config/api/oauth?app_id='+encodeURIComponent(appId));const data=await r.json();if(!r.ok){$('#oauth-result').className='result empty';$('#oauth-result').innerHTML='<div class="empty-icon">!</div><p>'+esc(data.error||'未找到配置')+'</p>';return}showOAuth(data.oauth)};`;
}

export async function handleConfigRoutes({ req, res, requestUrl, configAccessKey, publicBaseUrl, botRegistry, providers, saveManagedBot, removeManagedBot, getBot, json, parseFormBody, readRequestBody, redirect, crypto }) {
  if (requestUrl.pathname === "/config/login" && req.method === "POST") {
    try {
      const body = parseFormBody(req, await readRequestBody(req));
      if (String(body.access_key ?? "") !== configAccessKey) {
        json(res, 401, { error: "invalid_access_key" });
        return true;
      }
      const cookie = signSession({ exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS }, crypto, configAccessKey);
      const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
      json(res, 200, { ok: true }, { "Set-Cookie": `${CONFIG_COOKIE}=${encodeURIComponent(cookie)}; HttpOnly; SameSite=Strict; Path=/config; Max-Age=${SESSION_TTL_SECONDS}${secure}` });
    } catch (error) {
      json(res, 400, { error: error.message });
    }
    return true;
  }
  if (!requestUrl.pathname.startsWith("/config")) return false;
  const authenticated = isAuthenticated(req, crypto, configAccessKey);
  if (requestUrl.pathname === "/config" || requestUrl.pathname === "/config/") {
    if (req.method !== "GET") { json(res, 405, { error: "method_not_allowed" }); return true; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(renderPage(authenticated));
    return true;
  }
  if (!authenticated) { json(res, 401, { error: "config_login_required" }); return true; }
  try {
    if (requestUrl.pathname === "/config/api/bots" && req.method === "GET") {
      const appId = String(requestUrl.searchParams.get("app_id") ?? "").trim();
      if (!appId) { json(res, 400, { error: "app_id is required" }); return true; }
      const bot = findByAppId(botRegistry, appId);
      if (!bot) { json(res, 404, { error: "Bot not found" }); return true; }
      json(res, 200, { bot: publicConfigBot(bot) });
      return true;
    }
    if (requestUrl.pathname === "/config/api/oauth" && req.method === "GET") {
      const appId = String(requestUrl.searchParams.get("app_id") ?? "").trim();
      if (!appId) { json(res, 400, { error: "app_id is required" }); return true; }
      const bot = findByAppId(botRegistry, appId);
      if (!bot) { json(res, 404, { error: "Bot not found" }); return true; }
      json(res, 200, { oauth: oauthConfig(bot, publicBaseUrl) });
      return true;
    }
    if (requestUrl.pathname === "/config/api/bots" && req.method === "POST") {
      const body = parseFormBody(req, await readRequestBody(req));
      const appId = String(body.app_id ?? "").trim();
      const existing = findByAppId(botRegistry, appId);
      if (existing) throw new Error("该 App ID 已注册，请联系管理员修改或删除。");
      if (!String(body.platform ?? "").trim() || !String(body.name ?? "").trim() || !String(body.organization_name ?? "").trim() || !appId || !String(body.app_secret ?? "").trim() || !String(body.tenant_key ?? "").trim()) {
        throw new Error("platform, name, organization_name, app_id, app_secret and tenant_key are required");
      }
      const bot = saveManagedBot({ id: String(body.id ?? "").trim() || crypto.randomBytes(16).toString("hex"), platform: body.platform, name: body.name, appId, appSecret: body.app_secret, outputFolderToken: body.output_folder_token, organizationName: body.organization_name, tenantKey: body.tenant_key, redirectUris: body.redirect_uris, bootstrap: body.bootstrap === true });
      json(res, 201, { bot: publicConfigBot(bot), oauth: oauthConfig(bot, publicBaseUrl) });
      return true;
    }
    const match = requestUrl.pathname.match(/^\/config\/api\/bots\/([^/]+)$/);
    if (match && (req.method === "PUT" || req.method === "DELETE")) {
      const id = decodeURIComponent(match[1]);
      const appId = String(requestUrl.searchParams.get("app_id") ?? "").trim();
      const bot = botRegistry.find((item) => item.id === id && item.appId === appId);
      if (!appId || !bot) throw new Error("Query the Bot by its app_id before modifying or deleting it");
      if (req.method === "DELETE") {
        if (bot.source !== "store") throw new Error("Environment/file-configured Bots cannot be deleted here");
        removeManagedBot(id);
        json(res, 200, { deleted: id });
        return true;
      }
      const body = parseFormBody(req, await readRequestBody(req));
      const updated = saveManagedBot({ id, platform: body.platform ?? bot.platform, name: body.name ?? bot.name, appId, appSecret: body.app_secret || bot.appSecret, outputFolderToken: body.output_folder_token ?? bot.outputFolderToken, organizationName: body.organization_name ?? bot.organizationName, tenantKey: body.tenant_key || bot.tenantKey, redirectUris: body.redirect_uris?.length ? body.redirect_uris : bot.redirectUris, bootstrap: body.bootstrap === true });
      json(res, 200, { bot: publicConfigBot(updated) });
      return true;
    }
    json(res, 404, { error: "not_found" });
  } catch (error) {
    json(res, 400, { error: error.message });
  }
  return true;
}
