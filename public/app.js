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
  toast: null,
};

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
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 1800);
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
        </td>
        <td class="mono">${escapeHtml(c.path)}</td>
        <td>
          ${secureBadge}${httpBadge}${sameSiteBadge(c)}${lifeBadge}
          ${expiresLine}
          <div class="dim">创建：${escapeHtml(c.createdAt)}</div>
        </td>
      </tr>`;
  }).join('');

  els.jarWrap.innerHTML = `
    <table class="jar-table">
      <thead>
        <tr>
          <th>#</th><th>Cookie</th><th>域 / 作用域</th><th>Path</th><th>属性 / 有效期</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

async function refreshJar() {
  const resp = await fetch('/api/jar');
  const data = await resp.json();
  renderJar(data.cookies || []);
}

/* ---------- 写入结果 ---------- */

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

function renderStoreResult(data) {
  const meta = STORE_BANNER[data.action] || STORE_BANNER.rejected;
  els.storeResult.classList.remove('hidden');
  els.storeResult.innerHTML = `
    <div class="banner ${meta.cls}">
      <span class="banner-title">${meta.title}</span>${escapeHtml(data.reason)}
    </div>
    ${noticesHtml(data.notices)}`;
  if (data.jar) renderJar(data.jar);
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
    ? `<div class="group-title">📤 发送项（${data.sent.length}，已按 Path 长度降序 / 创建顺序升序排列）</div>
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
}

/* ---------- 事件 ---------- */

els.storeBtn.addEventListener('click', async () => {
  const url = els.storeUrl.value.trim();
  const setCookie = els.storeCookie.value.trim();
  if (!url || !setCookie) {
    renderStoreResult({
      ok: false, action: 'rejected',
      reason: !url ? '请先填写响应 URL' : '请先填写单条 Set-Cookie',
      notices: [],
    });
    return;
  }
  els.storeBtn.disabled = true;
  try {
    const data = await postJSON('/api/store', { url, setCookie });
    renderStoreResult(data);
  } catch (err) {
    renderStoreResult({
      ok: false, action: 'rejected',
      reason: err instanceof Error ? err.message : String(err),
      notices: [],
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
    await postJSON('/api/reset', {});
    renderJar([]);
    els.storeResult.classList.add('hidden');
    els.sendResult.classList.add('hidden');
    els.storeCookie.value = '';
    toast('Cookie 罐已重置');
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err));
  }
});

els.fillDemo.addEventListener('click', () => {
  els.storeUrl.value = 'https://shop.example.com/admin/dashboard?tab=1';
  els.storeCookie.value = 'session=abc123; Domain=example.com; Path=/; Max-Age=3600; Secure; SameSite=Lax';
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

/* 初始加载 */
refreshJar().catch((err) => console.error(err));
