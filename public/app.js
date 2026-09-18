/* Cookie Jar Lab —— 原生前端（无框架、无构建） */
'use strict';

const $ = (sel) => document.querySelector(sel);

const els = {
  storeUrl: $('#store-url'),
  storeCookie: $('#store-cookie'),
  storeBtn: $('#store-btn'),
  fillDemo: $('#fill-demo'),
  storeResult: $('#store-result'),

  sendUrl: $('#send-url'),
  sendTopUrl: $('#send-top-url'),
  sendMethod: $('#send-method'),
  sendTopnav: $('#send-topnav'),
  sendBtn: $('#send-btn'),
  sendResult: $('#send-result'),

  resetBtn: $('#reset-btn'),
  jarCount: $('#jar-count-num'),
  jarWrap: $('#jar-table-wrap'),
  jarEmpty: $('#jar-empty'),

  limitGlobal: $('#limit-global'),
  limitGlobalUsage: $('#limit-global-usage'),
  addDomainLimit: $('#add-domain-limit'),
  domainLimitsList: $('#domain-limits-list'),
  limitsUsage: $('#limits-usage'),
  toast: null,
};

/* ---------- 容量设置编辑器状态 ---------- */

/* 域名行：[{ domain: string, value: string }]；value 为空串表示该域不限 */
let domainRows = [];

function parseLimitValue(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return { ok: true, value: null };
  if (!/^\d+$/.test(s)) return { ok: false, value: null };
  const n = Number(s);
  if (n < 1) return { ok: false, value: null };
  return { ok: true, value: n };
}

/** 从编辑器收集容量配置；任一输入非法时返回 errors */
function collectLimits() {
  const errors = [];
  const g = parseLimitValue(els.limitGlobal.value);
  if (!g.ok) errors.push('全局容量必须是 ≥1 的整数（留空表示不限）');

  const perDomain = {};
  const seen = new Set();
  for (const row of domainRows) {
    const domain = (row.domain || '').trim().toLowerCase();
    const v = parseLimitValue(row.value);
    if (!v.ok) { errors.push(`域 ${domain || '（空）'} 的容量必须是 ≥1 的整数`); continue; }
    if (domain === '') continue;
    if (seen.has(domain)) { errors.push(`域 ${domain} 的容量重复设置`); continue; }
    seen.add(domain);
    if (v.value !== null) perDomain[domain] = v.value;
  }
  return { globalLimit: g.value, domainLimits: perDomain, errors };
}

function renderDomainRows() {
  if (!domainRows.length) {
    els.domainLimitsList.innerHTML =
      '<p class="empty-hint small-hint">暂无域级容量，点「+ 添加域」按可注册域（如 example.com、example.co.uk）设置。</p>';
    return;
  }
  els.domainLimitsList.innerHTML = domainRows.map((row, i) => `
    <div class="domain-limit-row" data-i="${i}">
      <input class="dl-domain" type="text" spellcheck="false" autocomplete="off"
        placeholder="可注册域，如 example.com" value="${escapeHtml(row.domain)}" />
      <input class="dl-value" type="number" min="1" step="1" placeholder="不限" value="${escapeHtml(row.value)}" />
      <button class="dl-del btn ghost small" type="button" title="删除该行">×</button>
    </div>`).join('');

  els.domainLimitsList.querySelectorAll('.domain-limit-row').forEach((rowEl) => {
    const i = Number(rowEl.dataset.i);
    rowEl.querySelector('.dl-domain').addEventListener('input', (e) => {
      domainRows[i].domain = e.target.value;
      scheduleApplyLimits();
    });
    rowEl.querySelector('.dl-value').addEventListener('input', (e) => {
      domainRows[i].value = e.target.value;
      scheduleApplyLimits();
    });
    rowEl.querySelector('.dl-del').addEventListener('click', () => {
      domainRows.splice(i, 1);
      renderDomainRows();
      scheduleApplyLimits();
    });
  });
}

/** 与 /api/jar 回传的用量合并：罐中新出现的可注册域自动补成一行（不覆盖已有输入） */
function syncDomainRows(usage) {
  const known = new Set(domainRows.map((r) => (r.domain || '').trim().toLowerCase()));
  const extras = [];
  for (const d of usage.domains || []) {
    if (!known.has(d.bucket)) {
      extras.push({ domain: d.bucket, value: '' });
      known.add(d.bucket);
    }
  }
  if (extras.length) {
    domainRows = domainRows.concat(extras.sort((a, b) => a.domain.localeCompare(b.domain)));
    renderDomainRows();
  }
}

function renderLimitsUsage(usage) {
  if (!usage) return;
  const gText = usage.globalLimit === null
    ? `${usage.globalCount} 条 · 不限`
    : `${usage.globalCount} / ${usage.globalLimit} 条`;
  els.limitGlobalUsage.innerHTML =
    `<span class="usage-pill ${usage.globalOver ? 'over' : ''}">全局：${escapeHtml(gText)}</span>`;

  if (!usage.domains || !usage.domains.length) {
    els.limitsUsage.innerHTML = '<p class="dim small-hint">罐中还没有条目；入罐后这里展示各可注册域的用量。</p>';
    return;
  }
  els.limitsUsage.innerHTML =
    '<div class="field-label">实时用量（过期项也计入，入罐超限时才清理）</div>' +
    '<div class="usage-pills">' +
    usage.domains.map((d) => {
      const text = d.limit === null ? `${d.bucket}：${d.count} · 不限` : `${d.bucket}：${d.count} / ${d.limit}`;
      return `<span class="usage-pill ${d.over ? 'over' : 'dim-pill'}" title="可注册域容量桶">${escapeHtml(text)}</span>`;
    }).join('') +
    '</div>';
}

let applyTimer = null;
function scheduleApplyLimits() {
  clearTimeout(applyTimer);
  applyTimer = setTimeout(async () => {
    const collected = collectLimits();
    if (collected.errors.length) { toast(collected.errors[0]); return; }
    try {
      await postJSON('/api/limits', {
        globalLimit: collected.globalLimit,
        domainLimits: collected.domainLimits,
      });
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  }, 350);
}

els.limitGlobal.addEventListener('input', scheduleApplyLimits);
els.addDomainLimit.addEventListener('click', () => {
  domainRows.push({ domain: '', value: '' });
  renderDomainRows();
  const inputs = els.domainLimitsList.querySelectorAll('.dl-domain');
  inputs[inputs.length - 1].focus();
});

/* ---------- 工具 ---------- */

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

async function postJSON(url, body) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data;
  try {
    data = await resp.json();
  } catch {
    throw new Error(`服务端返回异常（HTTP ${resp.status}）`);
  }
  if (!resp.ok && data && data.error) throw new Error(data.error);
  return data;
}

let toastTimer = null;
function toast(message) {
  if (!els.toast) {
    els.toast = document.createElement('div');
    els.toast.className = 'toast';
    document.body.appendChild(els.toast);
  }
  els.toast.textContent = message;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2200);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('已复制到剪贴板'); }
    catch { toast('复制失败，请手动选择'); }
    document.body.removeChild(ta);
  }
}

/* ---------- Cookie 罐表格 ---------- */

function sameSiteBadge(c) {
  const cls = c.sameSite === 'strict' ? 'ss-strict' : c.sameSite === 'none' ? 'ss-none' : 'ss-lax';
  return `<span class="badge ${cls}">SameSite=${escapeHtml(c.sameSiteLabel)}</span>`;
}

function priorityBadge(c) {
  const cls = c.priority === 'high' ? 'pr-high' : c.priority === 'low' ? 'pr-low' : 'pr-medium';
  return `<span class="badge ${cls}">Priority=${escapeHtml(c.priorityLabel)}</span>`;
}

function renderJar(cookies) {
  els.jarCount.textContent = String(cookies.length);

  if (!cookies.length) {
    els.jarWrap.innerHTML =
      '<p class="empty-hint">罐子是空的，先在左侧写入一条 Set-Cookie。</p>';
    return;
  }

  const rows = cookies.map((c) => {
    const scopeBadge = c.hostOnly
      ? '<span class="badge host">host-only</span>'
      : '<span class="badge domain">domain</span>';
    const secureBadge = c.secure
      ? '<span class="badge secure">Secure</span>'
      : '';
    const httpBadge = c.httpOnly
      ? '<span class="badge http">HttpOnly</span>'
      : '';
    const lifeBadge = c.persistent
      ? `<span class="badge ${c.expired ? 'expired-b' : 'persist'}">` +
        `${c.expired ? '已过期' : '有效期 ' + c.remaining}</span>`
      : '<span class="badge session">会话</span>';
    const expiresLine = c.persistent
      ? `<div class="dim">过期：${escapeHtml(c.expiresAt)}</div>`
      : '<div class="dim">浏览器关闭即失效（本工具不自动清）</div>';

    return `
      <tr class="${c.expired ? 'expired' : ''}">
        <td class="dim">#${c.index}</td>
        <td class="mono">
          <span class="cookie-name">${escapeHtml(c.name)}</span>=<span class="cookie-value">${escapeHtml(c.value)}</span>
        </td>
        <td>
          ${scopeBadge}
          <div class="domain-val">${escapeHtml(c.domain)}</div>
          <div class="dim">${escapeHtml(c.scope)}</div>
          <div class="dim">容量桶：${escapeHtml(c.bucket)}</div>
        </td>
        <td class="mono">${escapeHtml(c.path)}</td>
        <td>
          ${priorityBadge(c)}${secureBadge}${httpBadge}${sameSiteBadge(c)}${lifeBadge}
          ${expiresLine}
          <div class="dim">创建：${escapeHtml(c.createdAt)}</div>
          <div class="dim">最近访问：${escapeHtml(c.lastAccessAt)}</div>
        </td>
      </tr>`;
  }).join('');

  els.jarWrap.innerHTML = `
    <table class="jar-table">
      <thead>
        <tr>
          <th>#</th><th>Cookie</th><th>域 / 作用域</th><th>Path</th><th>属性 / 有效期 / 访问</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

async function refreshJar() {
  const resp = await fetch('/api/jar');
  const data = await resp.json();
  renderJar(data.cookies || []);
  if (data.limits) {
    syncDomainRows(data.limits);
    renderLimitsUsage(data.limits);
  }
}

/* ---------- 写入结果 + 容量淘汰清单 ---------- */

const STORE_BANNER = {
  stored:   { cls: 'ok',     title: '✅ 入罐成功' },
  updated:  { cls: 'update', title: '🔄 覆盖更新' },
  deleted:  { cls: 'delete', title: '🗑 执行删除' },
  rejected: { cls: 'bad',    title: '⛔ 拒绝入罐' },
};

function noticesHtml(notices) {
  if (!notices || !notices.length) return '';
  return `<ul class="notices">${notices
    .map((n) => `<li>⚠️ ${escapeHtml(n)}</li>`)
    .join('')}</ul>`;
}

function evictionEntryHtml(e) {
  const tagCls = e.status === 'expired' ? 'tag-expired' : e.status === 'evicted' ? 'tag-evicted' : 'tag-kept';
  const tagText = e.status === 'expired' ? '过期清理' : e.status === 'evicted' ? '淘汰' : '保留';
  const prCls = e.priority === 'high' ? 'pr-high' : e.priority === 'low' ? 'pr-low' : 'pr-medium';
  return `
    <div class="evict-item evict-${e.status}">
      <div class="evict-top">
        <span class="item-idx">#${e.index}</span>
        <span class="tag ${tagCls}">${tagText}</span>
        <span class="item-cookie">${escapeHtml(e.name)}=${escapeHtml(e.value)}</span>
        <span class="badge ${prCls}">Priority=${escapeHtml(e.priorityLabel)}</span>
      </div>
      <div class="item-detail">${escapeHtml(e.detail)}</div>
      <div class="dim">domain=${escapeHtml(e.domain)}；path=${escapeHtml(e.path)}；创建 ${escapeHtml(e.createdAt)}；最近访问 ${escapeHtml(e.lastAccessAt)}</div>
    </div>`;
}

function evictionStageHtml(stage) {
  const title = stage.scope === 'domain'
    ? `域级淘汰 · 可注册域 ${stage.bucket}`
    : '全局淘汰';
  const limitBadge = stage.limited
    ? `<span class="usage-pill ${stage.afterCount > (stage.limit ?? 0) ? 'over' : 'dim-pill'}">上限 ${stage.limit} 条 · ${stage.beforeCount} → ${stage.afterCount}</span>`
    : '<span class="usage-pill dim-pill">未设置上限</span>';

  const expiredHtml = stage.expired.length
    ? `<div class="group-title">🧹 先清理已过期项（${stage.expired.length}）</div>
       <div class="item-list">${stage.expired.map(evictionEntryHtml).join('')}</div>`
    : '';
  const evictedHtml = stage.evicted.length
    ? `<div class="group-title">⛔ 按序淘汰（${stage.evicted.length}）</div>
       <div class="item-list">${stage.evicted.map(evictionEntryHtml).join('')}</div>`
    : '';

  const orderHtml = stage.order.length
    ? `<details class="evict-order">
         <summary>淘汰候选排序（${stage.order.length}，含保留项；展开核对顺序）</summary>
         <div class="order-basis">排序依据：${escapeHtml(stage.orderBasis)}</div>
         <div class="item-list">${stage.order.map(evictionEntryHtml).join('')}</div>
       </details>`
    : '';

  return `
    <div class="evict-stage ${stage.triggered ? 'triggered' : ''}">
      <div class="evict-stage-head">
        <strong>${title}</strong>${limitBadge}
      </div>
      <div class="evict-summary">${escapeHtml(stage.summary)}</div>
      ${expiredHtml}
      ${evictedHtml}
      ${orderHtml}
    </div>`;
}

function evictionHtml(eviction) {
  if (!eviction) return '';
  const selfWarn = eviction.storedCookieEvicted
    ? '<div class="banner bad" style="margin-top:8px"><span class="banner-title">🔥 本次新条目被立即淘汰</span>' +
      '刚写入的条目自身也命中了淘汰规则，罐中已不存在该条目</div>'
    : '';
  const anyRemoved = eviction.stages.some((s) => s.triggered);
  const head = anyRemoved
    ? '<div class="group-title evict-head">🔥 容量淘汰清单（先域级、后全局）</div>'
    : '<div class="group-title evict-head">📦 容量压力检查（先域级、后全局；均未触发淘汰）</div>';
  return `
    <div class="eviction-box">
      ${head}
      ${eviction.stages.map(evictionStageHtml).join('')}
      ${selfWarn}
    </div>`;
}

function renderStoreResult(data) {
  const meta = STORE_BANNER[data.action] || STORE_BANNER.rejected;
  els.storeResult.classList.remove('hidden');
  els.storeResult.innerHTML = `
    <div class="banner ${meta.cls}">
      <span class="banner-title">${meta.title}</span>${escapeHtml(data.reason)}
    </div>
    ${noticesHtml(data.notices)}
    ${evictionHtml(data.eviction)}`;
  if (data.jar) renderJar(data.jar);
  // 淘汰后刷新用量面板，并为新出现的可注册域补容量输入行
  refreshJar().catch((err) => console.error(err));
}

/* ---------- 发送结果 ---------- */

function itemHtml(item) {
  const sent = item.verdict === 'send';
  const ssCls = item.sameSite === 'strict' ? 'ss-strict' : item.sameSite === 'none' ? 'ss-none' : 'ss-lax';
  return `
    <div class="item ${sent ? 'sent' : 'excluded'}">
      <div class="item-top">
        <span class="item-idx">#${item.index}</span>
        <span class="tag ${sent ? 'send' : 'exclude'}">${sent ? '发送' : '排除'}</span>
        <span class="item-cookie">${escapeHtml(item.cookie)}</span>
        <span class="badge ${ssCls}">SameSite=${escapeHtml(item.sameSiteLabel)}</span>
      </div>
      <div class="item-detail">${escapeHtml(item.detail)}</div>
    </div>`;
}

function renderSendResult(data) {
  els.sendResult.classList.remove('hidden');

  if (!data.ok) {
    els.sendResult.innerHTML = `
      <div class="banner bad">
        <span class="banner-title">⛔ 无法演算</span>${escapeHtml(data.error || '请求 URL 非法')}
      </div>`;
    return;
  }

  const headerVal = data.cookieHeader
    ? escapeHtml(data.cookieHeader)
    : '<span class="dim">（空：没有任何可发送的 cookie）</span>';

  const sentHtml = data.sent.length
    ? `<div class="group-title">📤 发送项（${data.sent.length}，已按 Path 长度降序 / 创建顺序升序排列；已刷新其最近访问时间）</div>
       <div class="item-list">${data.sent.map(itemHtml).join('')}</div>`
    : '<div class="group-title">📤 发送项<span class="count">（0）</span></div>';

  const excludedHtml = data.excluded.length
    ? `<div class="group-title">🚫 排除项（${data.excluded.length}）</div>
       <div class="item-list">${data.excluded.map(itemHtml).join('')}</div>`
    : '';

  const siteBadge = data.sameSiteContext
    ? '<span class="badge ss-same">同站</span>'
    : '<span class="badge ss-cross">跨站</span>';
  const navText = data.topLevelNav ? '顶层导航' : '非顶层导航';

  els.sendResult.innerHTML = `
    <div class="meta-line">
      请求主机 <code>${escapeHtml(data.host)}</code> ·
      路径 <code>${escapeHtml(data.path)}</code> ·
      协议 <strong>${data.secureRequest ? 'https（可发 Secure）' : 'http（不发 Secure）'}</strong>
    </div>
    <div class="meta-line">
      请求站 <code>${escapeHtml(data.requestSite)}</code> vs 顶层站 <code>${escapeHtml(data.topSite)}</code>
      ${siteBadge} · 方法 <code>${escapeHtml(data.method)}</code> · ${navText}
    </div>
    <div class="header-block">
      <div class="header-line ${data.cookieHeader ? '' : 'empty'}">
        <span class="hname">Cookie:</span>
        <span class="hval" id="header-val">${headerVal}</span>
        ${data.cookieHeader ? '<button class="copy-btn" id="copy-header" type="button">复制</button>' : ''}
      </div>
    </div>
    ${sentHtml}
    ${excludedHtml}`;

  const copyBtn = $('#copy-header');
  if (copyBtn) copyBtn.addEventListener('click', () => copyText(data.cookieHeader));

  // 发送成功的条目最近访问时间已在服务端更新，刷新右侧表格
  refreshJar().catch((err) => console.error(err));
}

/* ---------- 事件 ---------- */

els.storeBtn.addEventListener('click', async () => {
  const url = els.storeUrl.value.trim();
  const setCookie = els.storeCookie.value.trim();
  if (!url || !setCookie) {
    renderStoreResult({
      ok: false, action: 'rejected',
      reason: !url ? '请先填写响应 URL' : '请先填写单条 Set-Cookie',
      notices: [], eviction: null,
    });
    return;
  }

  // 入罐前应用当前容量设置（随请求一起提交，服务端先 setLimits 再入罐+淘汰）
  const collected = collectLimits();
  if (collected.errors.length) {
    toast('容量设置有误：' + collected.errors[0]);
    return;
  }

  els.storeBtn.disabled = true;
  try {
    const data = await postJSON('/api/store', {
      url,
      setCookie,
      globalLimit: collected.globalLimit,
      domainLimits: collected.domainLimits,
    });
    renderStoreResult(data);
  } catch (err) {
    renderStoreResult({
      ok: false, action: 'rejected',
      reason: err instanceof Error ? err.message : String(err),
      notices: [], eviction: null,
    });
  } finally {
    els.storeBtn.disabled = false;
  }
});

els.sendBtn.addEventListener('click', async () => {
  const url = els.sendUrl.value.trim();
  if (!url) {
    els.sendResult.classList.remove('hidden');
    els.sendResult.innerHTML = `
      <div class="banner bad"><span class="banner-title">⛔</span>请先填写请求 URL</div>`;
    return;
  }
  els.sendBtn.disabled = true;
  try {
    const data = await postJSON('/api/send', {
      url,
      topUrl: els.sendTopUrl.value.trim(),
      method: els.sendMethod.value,
      topLevelNav: els.sendTopnav.checked,
    });
    renderSendResult(data);
  } catch (err) {
    renderSendResult({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    els.sendBtn.disabled = false;
  }
});

els.resetBtn.addEventListener('click', async () => {
  try {
    const data = await postJSON('/api/reset', {});
    renderJar([]);
    if (data.limits) renderLimitsUsage(data.limits);
    els.storeResult.classList.add('hidden');
    els.sendResult.classList.add('hidden');
    els.storeCookie.value = '';
    toast('Cookie 罐已重置（容量配置保留）');
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err));
  }
});

els.fillDemo.addEventListener('click', () => {
  els.storeUrl.value = 'https://shop.example.com/admin/dashboard?tab=1';
  els.storeCookie.value = 'session=abc123; Domain=example.com; Path=/; Max-Age=3600; Secure; SameSite=Lax; Priority=High';
  els.sendUrl.value = 'https://api.shop.example.com/orders/123/detail';
  els.sendTopUrl.value = 'https://shop.example.com/cart';
  els.sendMethod.value = 'GET';
  els.sendTopnav.checked = true;
});

/* 回车快捷提交 */
els.storeCookie.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') els.storeBtn.click();
});
els.storeUrl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') els.storeBtn.click();
});
els.sendUrl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') els.sendBtn.click();
});
els.sendTopUrl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') els.sendBtn.click();
});

/* 初始加载：罐子 + 容量配置（回显已配置的可注册域行，含罐中暂无条目的域） */
(async function init() {
  try {
    const [jarResp, limResp] = await Promise.all([
      fetch('/api/jar'),
      fetch('/api/limits'),
    ]);
    const jarData = await jarResp.json();
    const limData = await limResp.json();

    const usage = (limData && limData.usage) || (jarData && jarData.limits) || null;
    if (usage) {
      els.limitGlobal.value = usage.globalLimit === null ? '' : String(usage.globalLimit);
      // 合并「已配置上限的域」（含罐中暂无条目的）与「当前有用量的域」
      const perDomain = (limData && limData.limits && limData.limits.perDomain) || {};
      const byDomain = new Map();
      for (const d of usage.domains || []) {
        byDomain.set(d.bucket, d.limit === null ? '' : String(d.limit));
      }
      for (const [domain, limit] of Object.entries(perDomain)) {
        if (!byDomain.has(domain)) byDomain.set(domain, String(limit));
      }
      domainRows = [...byDomain.entries()]
        .map(([domain, value]) => ({ domain, value }))
        .sort((a, b) => a.domain.localeCompare(b.domain));
      renderDomainRows();
      renderLimitsUsage(usage);
    }
    renderJar((jarData && jarData.cookies) || []);
  } catch (err) {
    console.error(err);
  }
})();
