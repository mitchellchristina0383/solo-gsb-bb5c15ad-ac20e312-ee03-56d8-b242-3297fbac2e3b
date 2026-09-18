/**
 * server.ts —— HTTP Cookie 罐演算 Web 服务
 *
 * 接口：
 *   GET  /                       原生前端页面（public/）
 *   GET  /api/jar                当前内存罐快照（含容量配置与各可注册域用量）
 *   POST /api/store              { url, setCookie, globalLimit?, domainLimits? }
 *                                顺序处理一次 Set-Cookie 写入；入罐校验后依次执行域级、全局容量淘汰
 *   POST /api/send               { url, topUrl?, method?, topLevelNav? } 演算请求 Cookie 头（逐项发送/排除原因）
 *   GET  /api/limits             当前容量配置
 *   POST /api/limits             { globalLimit?, domainLimits? } 设置容量（null/缺省 = 不限）
 *   POST /api/reset              清空内存罐（容量配置保留）
 *
 * Cookie 状态全部保存在进程内存中，重启 / 重置即清空（容量配置随重置保留）。
 */
import express from 'express';
import path from 'path';
import { CookieJar, Limits } from './cookieJar';

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// 全局唯一的内存 Cookie 罐（演示用，单实例即可）
const jar = new CookieJar();

/**
 * 解析容量上限入参：null/undefined → 不限；否则必须是 ≥1 的整数。
 * 非法时把中文错误信息 push 到 errors。
 */
function parseLimit(value: unknown, field: string, errors: string[]): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    errors.push(`${field} 必须是 ≥1 的整数（留空或传 null 表示不限）`);
    return undefined;
  }
  return value;
}

/** 解析整份容量配置；errors 非空时不得应用 */
function parseLimitsBody(body: Record<string, unknown>): { limits: Limits; errors: string[] } {
  const errors: string[] = [];
  const limits: Limits = {};

  limits.global = parseLimit(body.globalLimit, '全局容量（globalLimit）', errors);

  const rawDomains = body.domainLimits;
  if (rawDomains !== undefined && rawDomains !== null) {
    if (typeof rawDomains !== 'object' || Array.isArray(rawDomains)) {
      errors.push('domainLimits 必须是 { "可注册域": 上限整数 } 的对象');
    } else {
      limits.perDomain = {};
      for (const [rawKey, rawVal] of Object.entries(rawDomains as Record<string, unknown>)) {
        const key = rawKey.trim().toLowerCase();
        if (key === '') {
          errors.push('domainLimits 中存在空的域名键');
          continue;
        }
        const value = parseLimit(rawVal, `域 ${key} 的容量`, errors);
        if (value !== undefined) limits.perDomain[key] = value;
      }
      if (Object.keys(limits.perDomain).length === 0) limits.perDomain = undefined;
    }
  }

  return { limits, errors };
}

interface StoreBody {
  url?: unknown;
  setCookie?: unknown;
  globalLimit?: unknown;
  domainLimits?: unknown;
}

app.post('/api/store', (req, res) => {
  const body = (req.body ?? {}) as StoreBody;
  if (typeof body.url !== 'string' || body.url.trim() === '') {
    res.status(400).json({ ok: false, error: '缺少响应 URL（字段 url）' });
    return;
  }
  if (typeof body.setCookie !== 'string' || body.setCookie.trim() === '') {
    res.status(400).json({ ok: false, error: '缺少单条 Set-Cookie（字段 setCookie），一次只能提交一条' });
    return;
  }

  // 可选：入罐时顺带调整容量配置（前端把当前容量设置随每次入罐一起提交，保证单请求语义可复现）
  if (body.globalLimit !== undefined || body.domainLimits !== undefined) {
    const { limits, errors } = parseLimitsBody(body as unknown as Record<string, unknown>);
    if (errors.length > 0) {
      res.status(400).json({ ok: false, error: errors.join('；') });
      return;
    }
    jar.setLimits(limits);
  }

  res.json(jar.store(body.url.trim(), body.setCookie));
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
  res.json(
    jar.send(url.trim(), {
      topUrl: typeof topUrl === 'string' && topUrl.trim() !== '' ? topUrl.trim() : undefined,
      method: typeof method === 'string' && method.trim() !== '' ? method.trim() : undefined,
      topLevelNav,
    }),
  );
});

app.get('/api/jar', (_req, res) => {
  res.json({ ok: true, cookies: jar.list(), limits: jar.limitsView() });
});

app.get('/api/limits', (_req, res) => {
  res.json({ ok: true, limits: jar.getLimits(), usage: jar.limitsView() });
});

app.post('/api/limits', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { limits, errors } = parseLimitsBody(body);
  if (errors.length > 0) {
    res.status(400).json({ ok: false, error: errors.join('；') });
    return;
  }
  jar.setLimits(limits);
  res.json({ ok: true, message: '容量配置已更新（仅在后续入罐超限时触发淘汰）', limits: jar.getLimits(), usage: jar.limitsView() });
});

app.post('/api/reset', (_req, res) => {
  jar.reset();
  res.json({ ok: true, message: 'Cookie 罐已重置（内存已清空，容量配置保留）', cookies: [], limits: jar.limitsView() });
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
