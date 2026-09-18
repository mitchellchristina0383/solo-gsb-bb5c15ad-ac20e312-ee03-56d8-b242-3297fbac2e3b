/**
 * server.ts —— HTTP Cookie 罐演算 Web 服务
 *
 * 接口：
 *   GET  /                       原生前端页面（public/）
 *   GET  /api/jar                当前内存罐快照
 *   POST /api/store              { url, setCookie } 顺序处理一次 Set-Cookie 写入
 *   POST /api/send               { url, topUrl?, method?, topLevelNav? } 演算请求 Cookie 头（逐项发送/排除原因）
 *   POST /api/reset              清空内存罐
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
  res.json(jar.store(url.trim(), setCookie));
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
  res.json({ ok: true, cookies: jar.list() });
});

app.post('/api/reset', (_req, res) => {
  jar.reset();
  res.json({ ok: true, message: 'Cookie 罐已重置（内存已清空）', cookies: [] });
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
