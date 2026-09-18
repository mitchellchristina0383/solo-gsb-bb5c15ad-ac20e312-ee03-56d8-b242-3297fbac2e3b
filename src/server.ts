/**
 * server.ts —— HTTP Cookie 罐演算 Web 服务
 *
 * 接口：
 *   GET  /                       原生前端页面（public/）
 *   GET  /api/jar                当前内存罐快照（含容量设置与各可注册域用量）
 *   POST /api/store              { url, setCookie } 顺序处理一次 Set-Cookie 写入（含容量压力淘汰）
 *   POST /api/send               { url, topUrl?, method?, topLevelNav? } 演算请求 Cookie 头
 *   POST /api/capacity           { globalLimit?, domainLimits? } 设置全局/每可注册域容量并立即执行淘汰
 *   POST /api/reset              清空内存罐（容量设置保留）
 *
 * Cookie 状态全部保存在进程内存中，重启 / 重置即清空。
 */
import express from 'express';
import path from 'path';
import { CookieJar } from './cookieJar';

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// 全局唯一的内存 Cookie 罐（演示用，单实例即可）
const jar = new CookieJar();

interface StoreBody {
  url?: unknown;
  setCookie?: unknown;
}

app.post('/api/store', (req, res) => {
  const { url, setCookie } = (req.body ?? {}) as StoreBody;
  if (typeof url !== 'string' || url.trim() === '') {
    res.status(400).json({ ok: false, error: '缺少响应 URL（字段 url）' });
    return;
  }
  if (typeof setCookie !== 'string' || setCookie.trim() === '') {
    res.status(400).json({ ok: false, error: '缺少单条 Set-Cookie（字段 setCookie），一次只能提交一条' });
    return;
  }
  const result = jar.store(url.trim(), setCookie);
  res.json({ ...result, capacity: jar.capacity() });
});

interface SendBody {
  url?: unknown;
  topUrl?: unknown;
  method?: unknown;
  topLevelNav?: unknown;
}

app.post('/api/send', (req, res) => {
  const { url, topUrl, method, topLevelNav } = (req.body ?? {}) as SendBody;
  if (typeof url !== 'string' || url.trim() === '') {
    res.status(400).json({ ok: false, error: '缺少请求 URL（字段 url）' });
    return;
  }
  if (topUrl !== undefined && typeof topUrl !== 'string') {
    res.status(400).json({ ok: false, error: '顶层页面 URL（字段 topUrl）必须是字符串' });
    return;
  }
  if (method !== undefined && typeof method !== 'string') {
    res.status(400).json({ ok: false, error: '请求方法（字段 method）必须是字符串' });
    return;
  }
  if (topLevelNav !== undefined && typeof topLevelNav !== 'boolean') {
    res.status(400).json({ ok: false, error: '是否顶层导航（字段 topLevelNav）必须是布尔值' });
    return;
  }
  const result = jar.send(url.trim(), {
    topUrl: typeof topUrl === 'string' && topUrl.trim() !== '' ? topUrl.trim() : undefined,
    method: typeof method === 'string' && method.trim() !== '' ? method.trim() : undefined,
    topLevelNav,
  });
  // 发送成功的条目会刷新最近访问时间，故把最新罐内容与用量一并返回
  res.json({ ...result, capacity: jar.capacity(), cookies: jar.list() });
});

interface CapacityBody {
  globalLimit?: unknown;
  domainLimits?: unknown;
}

/** 容量上限值校验：正整数（>=1）才合法；null/缺省表示不限 */
function parseLimit(value: unknown, field: string): number | null {
  if (value === null || value === undefined || value === '') return null;
  // JSON 里数字或数字字符串都接受
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
    throw new Error(`${field} 必须是不小于 1 的正整数（留空表示不限制）`);
  }
  return n;
}

app.post('/api/capacity', (req, res) => {
  const { globalLimit, domainLimits } = (req.body ?? {}) as CapacityBody;

  let global: number | null;
  try {
    global = parseLimit(globalLimit, '全局容量');
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
    return;
  }

  if (domainLimits !== undefined && (typeof domainLimits !== 'object' || domainLimits === null || Array.isArray(domainLimits))) {
    res.status(400).json({ ok: false, error: '域级容量（字段 domainLimits）必须是 { "可注册域": 上限 } 的对象' });
    return;
  }

  const limits: Record<string, number> = {};
  const entries = (domainLimits ?? {}) as Record<string, unknown>;
  for (const [rawDomain, rawLimit] of Object.entries(entries)) {
    const domain = rawDomain.trim().toLowerCase().replace(/^\./, '');
    if (domain === '') {
      res.status(400).json({ ok: false, error: '域级容量存在空的域名，请填写可注册域（例如 example.com）或删除该行' });
      return;
    }
    try {
      const limit = parseLimit(rawLimit, `域 ${domain} 的容量`);
      if (limit !== null) limits[domain] = limit;
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
      return;
    }
  }

  const result = jar.setCapacity({ globalLimit: global, domainLimits: limits });
  res.json({ ok: true, ...result, cookies: jar.list() });
});

app.get('/api/jar', (_req, res) => {
  res.json({ ok: true, cookies: jar.list(), capacity: jar.capacity() });
});

app.post('/api/reset', (_req, res) => {
  jar.reset();
  res.json({ ok: true, message: 'Cookie 罐已重置（内存已清空；容量设置保留）', cookies: [], capacity: jar.capacity() });
});

// 兜底：未匹配的 /api 路径返回 JSON 404，其它路径交回前端首页
app.use('/api', (_req, res) => {
  res.status(404).json({ ok: false, error: '接口不存在' });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🍪 Cookie Jar Lab 已启动：http://localhost:${PORT}`);
});
