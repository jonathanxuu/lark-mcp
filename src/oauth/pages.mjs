export function createOAuthPageRenderers({ htmlEscape, icons, styles }) {
  const { arrowIcon, botIcon, buildingIcon, platformLogoIcon, searchIcon, sparkIcon } = icons;

  function renderOrganizationSelectionPage(selectionToken, organizations) {
    const availablePlatforms = new Set(organizations.map((organization) => organization.platform));
    const defaultPlatform = availablePlatforms.has("lark") ? "lark" : "feishu";
    const platformTabs = ["lark", "feishu"].map((platform) => `
    <button class="platform-tab${platform === defaultPlatform ? " active" : ""}" type="button" data-platform="${platform}">
      <span class="platform-mark">${platformLogoIcon()}</span>${platform === "lark" ? "Lark" : "飞书"}
    </button>`).join("");
    const rows = organizations.map((organization) => `
    <button class="choice-card" type="submit" name="organization_id" value="${htmlEscape(organization.id)}" data-platform="${htmlEscape(organization.platform)}" data-search="${htmlEscape(organization.name)}">
      <span class="choice-icon">${buildingIcon()}</span>
      <span class="choice-copy"><strong>${htmlEscape(organization.name)}</strong><small>${htmlEscape(organization.platform_label)}</small></span>
      <span class="choice-arrow">${arrowIcon()}</span>
    </button>`).join("\n");
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>选择平台和组织</title>
    <style>${styles()}</style></head><body><main class="panel">
      <div class="brand"><span class="brand-mark">${sparkIcon()}</span><span>COUNSO <em>LARK MCP</em></span></div>
      <div class="eyebrow">SECURE CONNECTION</div><h1>选择平台和组织</h1>
      <p class="subtitle">先选择你要连接的平台，再选择对应的组织。</p>
      <div class="platform-tabs" role="tablist">${platformTabs}</div>
      <label class="search"><span>${searchIcon()}</span><input id="search" type="search" placeholder="搜索组织名称" autocomplete="off"></label>
      <form id="organization-form" method="post" action="/oauth/lark/select-organization"><input type="hidden" name="selection_token" value="${htmlEscape(selectionToken)}"><input id="platform" type="hidden" name="platform" value="${htmlEscape(defaultPlatform)}"><div id="choices" class="choices">${rows || '<div class="empty">管理员还没有配置可用组织。</div>'}</div></form>
      <div id="empty-search" class="empty hidden">没有找到匹配的组织</div><footer>Protected by COUNSO Lark MCP</footer>
    </main><script>const input=document.querySelector('#search');const platformInput=document.querySelector('#platform');const cards=[...document.querySelectorAll('.choice-card')];const tabs=[...document.querySelectorAll('.platform-tab')];const empty=document.querySelector('#empty-search');let activePlatform='${defaultPlatform}';function filter(){const q=(input?.value||'').trim().toLowerCase();let visible=0;cards.forEach(c=>{const show=c.dataset.platform===activePlatform&&(!q||c.dataset.search.toLowerCase().includes(q));c.classList.toggle('hidden',!show);if(show)visible++});empty.classList.toggle('hidden',visible!==0)}cards.forEach(card=>card.addEventListener('click',()=>{if(platformInput)platformInput.value=card.dataset.platform}));tabs.forEach(tab=>tab.addEventListener('click',()=>{activePlatform=tab.dataset.platform;tabs.forEach(item=>item.classList.toggle('active',item===tab));if(platformInput)platformInput.value=activePlatform;if(input)input.value='';filter()}));input?.addEventListener('input',filter);filter();</script></body></html>`;
  }

  function renderBotSelectionPage(selectionToken, organization, bots, authorizedBotId = "") {
    const rows = bots.map((bot) => {
      const sameAuthorization = bot.id === authorizedBotId;
      return `<button class="choice-card" type="submit" name="bot_id" value="${htmlEscape(bot.id)}">
      <span class="choice-icon bot-icon">${botIcon()}</span>
      <span class="choice-copy"><strong>${htmlEscape(bot.name)}</strong><small>${sameAuthorization ? "已完成身份验证，可直接连接" : "授权此 Bot 并添加到 MCP"}</small></span>
      <span class="choice-arrow">${arrowIcon()}</span>
    </button>`;
    }).join("\n");
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>选择 Bot</title>
    <style>${styles()}</style></head><body><main class="panel">
      <div class="brand"><span class="brand-mark">${sparkIcon()}</span><span>COUNSO <em>LARK MCP</em></span></div>
      <div class="eyebrow">ORGANIZATION VERIFIED</div><h1>选择要添加到 MCP 的 Bot</h1>
      <p class="subtitle"><span class="org-pill">${buildingIcon()} ${htmlEscape(organization.platform_label)} · ${htmlEscape(organization.name)}</span> 选择一个 Bot 继续。</p>
      <form method="post" action="/oauth/lark/select"><input type="hidden" name="selection_token" value="${htmlEscape(selectionToken)}"><div class="choices">${rows || '<div class="empty">该组织还没有配置 Bot。</div>'}</div></form>
      <footer>Protected by COUNSO Lark MCP</footer>
    </main></body></html>`;
  }

  return { renderOrganizationSelectionPage, renderBotSelectionPage };
}
