/**
 * cookieJar.ts
 *
 * 内存 Cookie 罐的全部演算逻辑，规则对齐 RFC 6265（HTTP State Management Mechanism）：
 *
 *  写入（Set-Cookie）：
 *   - Domain 不匹配响应主机（不是主机本身、也不是其上级域）时拒绝；
 *   - 省略 Domain 时为 host-only cookie；带 Domain 时去掉前导点且为 Domain cookie；
 *   - Path 缺省取「响应 URL 路径最后一个斜杠之前的目录」（RFC 5.1.4 default-path）；
 *   - Max-Age <= 0（含 0、负数）删除同名 (name, domain, path) 项；
 *   - Max-Age 非法值时忽略（按会话 cookie 处理并给出提示）；
 *   - Secure cookie 在明文 http 响应里写入会给出提示（真实浏览器通常拒绝）；
 *   - SameSite 解析 Strict/Lax/None（大小写不敏感）；未声明或非法值记为默认 Lax；
 *     SameSite=None 未同时声明 Secure 时拒绝入罐。
 *   - Priority（RFC 6265bis）解析 Low/Medium/High（大小写不敏感）；缺省或非法值按 Medium 并提示。
 *
 *  容量压力模拟（入罐沿用上述全部校验通过后执行）：
 *   - 容量按「条目条数」计，可分别为每个可注册域（eTLD+1；IP/localhost 按完整主机）
 *     与全局设置上限，未设置表示不限；
 *   - 入罐（含覆盖更新）成功后依次执行「域级 → 全局」淘汰；修改容量设置时立即执行一次；
 *   - 仅当范围内条数超过上限才触发：先物理清理范围内已过期项，若仍超限，再按
 *     Priority 从低到高（Low→Medium→High）、最近访问时间从早到晚、创建序号从小到大
 *     依次淘汰，直到回到上限以内；
 *   - 被请求成功发送的条目更新最近访问时间（lastAccessedAt）。
 *
 *  发送（请求 URL + 顶层页面 URL + 方法 + 是否顶层导航）：
 *   - 已过期的不发送；
 *   - host-only 仅精确匹配原主机；Domain cookie 匹配该域及其子域；IP 主机不做子域匹配；
 *   - Path 须相等，或以 cookie-path 开头且下一个字符是 "/"（path-match）；
 *   - Secure cookie 只通过 https: 请求发送；
 *   - SameSite 站点演算（same-site = scheme + 可注册域，公共后缀由 tldts/PSL 判定；
 *     IP 与 localhost 等无可注册域的主机按完整主机比较）：
 *       · Strict：仅同站发送；
 *       · 显式 Lax：同站，或跨站顶层导航的安全方法（GET/HEAD/OPTIONS/TRACE）；
 *       · 默认 Lax（未声明或非法值）：同上，另允许创建不超过 120 秒的跨站顶层 POST；
 *       · None：跨站照常发送（入罐时已强制要求 Secure）；
 *   - 排序：Path 长度降序；相同长度按首次创建顺序（creation index）升序。
 */
import { getDomain } from 'tldts';

/** SameSite 模式（存储时统一为小写） */
export type SameSiteMode = 'strict' | 'lax' | 'none';

/** Cookie Priority（RFC 6265bis，存储时统一为小写；缺省/非法一律 medium） */
export type CookiePriority = 'low' | 'medium' | 'high';

/** 罐中的单条 cookie（存储模型） */
export interface StoredCookie {
  name: string;
  value: string;
  /** 规范化为小写后的域。host-only 时为原主机；Domain cookie 时为属性域（无前导点） */
  domain: string;
  path: string;
  /** true = 仅精确匹配 domain 主机；false = 匹配 domain 及其子域 */
  hostOnly: boolean;
  secure: boolean;
  httpOnly: boolean;
  /** SameSite 模式；未声明或非法值一律记为 lax */
  sameSite: SameSiteMode;
  /** true = SameSite 为默认值（未声明或非法值）；默认 Lax 才享受 120 秒跨站顶层 POST 宽限 */
  sameSiteDefault: boolean;
  /** Cookie 优先级（容量淘汰依据）；缺省/非法一律 medium */
  priority: CookiePriority;
  /** true = Priority 为默认值（未声明或非法值） */
  priorityDefault: boolean;
  /** 过期绝对时间戳（ms）；undefined 表示会话 cookie（本工具中永不过期，重启清空） */
  expiresAt?: number;
  /** 首次创建序号，从 1 开始；更新同名项时沿用，保证排序稳定 */
  creationIndex: number;
  /** 首次创建时间戳；更新同名项时保留（120 秒 Lax+POST 宽限也按它计算） */
  createdAt: number;
  /** 最近一次写入（创建或更新）的时间戳 */
  updatedAt: number;
  /** 最近一次访问时间戳：创建/更新时写入，发送成功时刷新（容量淘汰 LRA 依据） */
  lastAccessedAt: number;
}

/** 解析后的 Set-Cookie（单条） */
export interface ParsedSetCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  maxAge?: number;
  /** 原始 Max-Age 是否非法（非法时忽略，按会话 cookie 处理） */
  maxAgeInvalid: boolean;
  secure: boolean;
  httpOnly: boolean;
  sameSite: SameSiteMode;
  /** true = 未声明 SameSite 或值非法，按浏览器默认记为 Lax */
  sameSiteDefault: boolean;
  /** 原始 SameSite 值是否非法（非法时按默认 Lax 处理并给出提示） */
  sameSiteInvalid: boolean;
  priority: CookiePriority;
  /** true = 未声明 Priority 或值非法，按默认 Medium 处理 */
  priorityDefault: boolean;
  /** 原始 Priority 值是否非法（缺省不算非法，非法值才提示） */
  priorityInvalid: boolean;
}

/** 前端表格 / API 共用的展示视图 */
export interface CookieView {
  index: number;
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  scope: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: SameSiteMode;
  sameSiteDefault: boolean;
  /** 展示用标签，例如 Strict / Lax（默认）/ None */
  sameSiteLabel: string;
  priority: CookiePriority;
  priorityDefault: boolean;
  /** 展示用标签：High / Medium（默认）/ Low */
  priorityLabel: string;
  persistent: boolean;
  expiresAt: string | null;
  remaining: string | null;
  expired: boolean;
  createdAt: string;
  updatedAt: string;
  /** 最近访问时间（容量淘汰 LRA 依据）的可读描述 */
  lastAccessedAt: string;
}

export type StoreAction = 'stored' | 'updated' | 'deleted' | 'rejected';
export type ItemVerdict = 'send' | 'exclude';
export type EvictionScope = 'domain' | 'global';

/** 淘汰清单中的单条（过期清理与优先级淘汰共用） */
export interface EvictedCookie {
  index: number;
  name: string;
  value: string;
  cookie: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  priority: CookiePriority;
  priorityLabel: string;
  expired: boolean;
  /** 淘汰时的最近访问时间（可读） */
  lastAccessedAt: string;
  /** 淘汰原因：expired（过期清理）/ evicted（容量淘汰） */
  reason: 'expired' | 'evicted';
  /** 容量淘汰时命中的排序依据描述 */
  basis: string;
}

/** 单级淘汰（域级或全局）的完整报告 */
export interface EvictionStage {
  scope: EvictionScope;
  /** 域级淘汰时为该可注册域（IP/localhost 为完整主机）；全局为 null */
  domain: string | null;
  limit: number;
  /** 入罐前范围内条数 */
  beforeCount: number;
  /** 过期清理条数 */
  expiredRemoved: number;
  /** 按优先级淘汰条数 */
  evictedCount: number;
  /** 淘汰后范围内条数 */
  afterCount: number;
  /** 是否真正触发（清理或淘汰了任意条目） */
  triggered: boolean;
  removed: EvictedCookie[];
}

/** 一次压力淘汰（域级 + 全局）的汇总报告 */
export interface EvictionReport {
  /** 排序依据（人类可读，界面原样展示） */
  basis: string;
  /** 是否有任意一级触发 */
  triggered: boolean;
  stages: EvictionStage[];
  /** 全部被移除条目（先域级后全局，按实际淘汰顺序） */
  removed: EvictedCookie[];
}

/** 容量设置快照 + 每个可注册域的用量（供界面配置与展示） */
export interface CapacityView {
  globalLimit: number | null;
  domainLimits: Array<{ domain: string; limit: number }>;
  totalCount: number;
  usage: Array<{
    domain: string;
    count: number;
    /** 该域配置的上限；null = 未设置（不限） */
    limit: number | null;
  }>;
}

export interface StoreResult {
  ok: boolean;
  action: StoreAction;
  reason: string;
  /** 被更新时沿用的首次创建序号 */
  inheritedIndex?: number;
  /** 非致命的提示信息（例如明文 http 写入 Secure） */
  notices: string[];
  cookie: CookieView | null;
  jar: CookieView[];
  /** 本次入罐触发的容量压力淘汰报告（无任何上限时为 null） */
  eviction: EvictionReport | null;
}

export interface RequestItem {
  index: number;
  cookie: string;
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  sameSite: SameSiteMode;
  sameSiteLabel: string;
  verdict: ItemVerdict;
  /** 发送：命中的匹配点；排除：排除原因 */
  detail: string;
  expired: boolean;
}

/** 发送演算的附加上下文（SameSite 判定所需） */
export interface SendOptions {
  /** 顶层页面 URL（决定 same-site 上下文）；缺省视为与请求 URL 相同，即同站 */
  topUrl?: string;
  /** 请求方法（大小写不敏感），缺省 GET */
  method?: string;
  /** 是否顶层导航，缺省 true */
  topLevelNav?: boolean;
}

export interface SendResult {
  ok: boolean;
  error?: string;
  requestUrl: string;
  host: string;
  path: string;
  secureRequest: boolean;
  /** 实际采用的顶层页面 URL（缺省时回显请求 URL） */
  topUrl: string;
  /** 规范化后的请求方法（大写） */
  method: string;
  topLevelNav: boolean;
  /** 请求站 / 顶层站（scheme + 可注册域；IP、localhost 按完整主机） */
  requestSite: string;
  topSite: string;
  /** 请求站与顶层站是否同站 */
  sameSiteContext: boolean;
  cookieHeader: string;
  sent: RequestItem[];
  excluded: RequestItem[];
}

/** 年份过大会让 Date 抛异常，这里钳制到一个安全的绝对上限（约公元 275760 年） */
const MAX_SAFE_EXPIRES = 8_640_000_000_000_000;

/** 默认 Lax 的跨站顶层 POST 宽限：创建不超过 120 秒（对齐 Chrome 的 Lax+POST 缓解） */
export const LAX_POST_GRACE_MS = 120_000;

/** RFC 7231 安全方法：跨站顶层导航时显式 Lax 允许发送 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

/** 容量淘汰的优先级权重：越小越先被淘汰 */
const PRIORITY_RANK: Record<CookiePriority, number> = { low: 0, medium: 1, high: 2 };

/** 容量淘汰排序依据（界面展示） */
export const EVICTION_BASIS = '优先级从低到高（Low → Medium → High），同级按最近访问时间从早到晚，再同则按创建序号从小到大';

/** cookie-name 允许的可见 ASCII（RFC 6265 token，排除分隔符与空白） */
const VALID_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const pad = (n: number): string => String(n).padStart(2, '0');

/** 本地时区的可读时间，例如 2026-09-18 14:03:07 */
export function formatTime(ts: number): string {
  const d = new Date(ts);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** 剩余有效期的人类可读描述 */
export function formatRemaining(expiresAt: number, now: number): string {
  let ms = expiresAt - now;
  if (ms <= 0) return '已过期';
  const sec = Math.floor(ms / 1000);
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const secs = sec % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} 天`);
  if (hours > 0) parts.push(`${hours} 小时`);
  if (mins > 0) parts.push(`${mins} 分`);
  parts.push(`${secs} 秒`);
  return parts.join(' ');
}

/**
 * 解析单条 Set-Cookie 头（不含 "Set-Cookie:" 前缀）。
 * 第一个 "=" 之前为 name、其后到第一个 ";" 之前为 value；其余为属性。
 */
export function parseSetCookie(raw: string): ParsedSetCookie {
  const header = raw.trim();
  if (header.length === 0) {
    throw new Error('Set-Cookie 内容为空');
  }

  const segments = header.split(';').map((s) => s.trim());
  const first = segments[0];
  const eq = first.indexOf('=');
  if (eq <= 0) {
    throw new Error('缺少有效的 cookie-name（需要 "名称=值" 形式）');
  }

  const name = first.slice(0, eq).trim();
  let value = first.slice(eq + 1).trim();
  if (name.length === 0 || !VALID_NAME_RE.test(name)) {
    throw new Error(`cookie-name 非法："${name}"`);
  }
  // 值允许为空字符串；去掉成对的双引号（cookie-value 的 quoted-string 形式）
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
  }

  const parsed: ParsedSetCookie = {
    name,
    value,
    maxAgeInvalid: false,
    secure: false,
    httpOnly: false,
    sameSite: 'lax',
    sameSiteDefault: true,
    sameSiteInvalid: false,
    priority: 'medium',
    priorityDefault: true,
    priorityInvalid: false,
  };

  for (let i = 1; i < segments.length; i += 1) {
    const seg = segments[i];
    if (seg.length === 0) continue;
    const semi = seg.indexOf('=');
    const attrName = (semi === -1 ? seg : seg.slice(0, semi)).trim().toLowerCase();
    const attrValue = semi === -1 ? '' : seg.slice(semi + 1).trim();

    switch (attrName) {
      case 'domain':
        if (attrValue.length > 0) parsed.domain = attrValue;
        break;
      case 'path':
        if (attrValue.length > 0) parsed.path = attrValue;
        break;
      case 'max-age': {
        if (!/^-?\d+$/.test(attrValue)) {
          parsed.maxAgeInvalid = true;
        } else {
          const n = Number(attrValue);
          parsed.maxAge = Number.isFinite(n) ? n : undefined;
          if (!Number.isFinite(n)) parsed.maxAgeInvalid = true;
        }
        break;
      }
      case 'secure':
        parsed.secure = true;
        break;
      case 'httponly':
        parsed.httpOnly = true;
        break;
      case 'samesite': {
        // Strict / Lax / None，大小写不敏感；未声明或非法值一律记为默认 Lax
        const v = attrValue.toLowerCase();
        if (v === 'strict' || v === 'lax' || v === 'none') {
          parsed.sameSite = v;
          parsed.sameSiteDefault = false;
        } else {
          parsed.sameSite = 'lax';
          parsed.sameSiteDefault = true;
          parsed.sameSiteInvalid = true;
        }
        break;
      }
      case 'priority': {
        // Low / Medium / High，大小写不敏感；缺省或非法值一律记为默认 Medium
        const v = attrValue.toLowerCase();
        if (v === 'low' || v === 'medium' || v === 'high') {
          parsed.priority = v;
          parsed.priorityDefault = false;
        } else {
          parsed.priority = 'medium';
          parsed.priorityDefault = true;
          parsed.priorityInvalid = true;
        }
        break;
      }
      // Expires / 未知属性：本演算不参与，直接忽略
      default:
        break;
    }
  }

  return parsed;
}

/** 域规范化：小写并去掉最多一个前导点（RFC 5.3.6） */
export function canonicalizeDomain(domain: string): string {
  let d = domain.trim().toLowerCase();
  if (d.startsWith('.')) d = d.slice(1);
  // IPv6/IPvFuture 可能被方括号包裹，去掉外壳
  if (d.startsWith('[') && d.endsWith(']')) d = d.slice(1, -1);
  return d;
}

/** 从绝对 URL 中取出主机（小写、无方括号、无端口）；非法 http(s) URL 返回 null */
export function hostFromUrl(rawUrl: string): { host: string; protocol: string; path: string } | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return null;
  }
  if (!u.hostname) return null;
  let host = u.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return { host, protocol: u.protocol, path: u.pathname || '/' };
}

/** 粗略识别 IPv4 / IPv6（含 zone id）主机；IP 主机不参与域/子域匹配 */
export function isIpAddress(host: string): boolean {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    return host.split('.').every((p) => Number(p) <= 255);
  }
  // 至少包含一个冒号即按 IPv6 处理（URL 解析后不含方括号；zone id 的 % 也允许）
  return host.includes(':') && /^[0-9a-f:%]+$/i.test(host);
}

/**
 * 计算「站点」（site，schemeful same-site）：scheme + 可注册域（eTLD+1）。
 * 可注册域由 tldts（内置公共后缀列表 PSL，含私有域段）判定；
 * IP 地址、localhost 等无可注册域的主机按完整主机比较。
 */
export function siteOf(host: string, protocol: string): string {
  const domain = isIpAddress(host) ? null : getDomain(host, { allowPrivateDomains: true });
  return `${protocol}//${domain ?? host}`;
}

/**
 * 取「可注册域」（eTLD+1）作为容量统计 / 域级淘汰的分桶键：
 * 由 tldts（PSL，含私有域段）判定；IP、localhost 等无可注册域的主机按完整主机。
 */
export function registrableDomain(host: string): string {
  const domain = isIpAddress(host) ? null : getDomain(host, { allowPrivateDomains: true });
  return domain ?? host;
}

/** SameSite 展示标签：Strict / Lax / Lax（默认）/ None */
export function sameSiteLabel(sameSite: SameSiteMode, sameSiteDefault: boolean): string {
  const base = sameSite === 'strict' ? 'Strict' : sameSite === 'none' ? 'None' : 'Lax';
  return sameSiteDefault ? `${base}（默认）` : base;
}

/** Priority 展示标签：Low / Medium（默认）/ High */
export function priorityLabel(priority: CookiePriority, priorityDefault: boolean): string {
  const base = priority === 'low' ? 'Low' : priority === 'high' ? 'High' : 'Medium';
  return priorityDefault ? `${base}（默认）` : base;
}

/**
 * domain-match（RFC 5.1.3）：
 *  host-only cookie 要求 host 与 domain 完全相等；
 *  Domain cookie 要求 host == domain，或 host 以 "." + domain 结尾。
 */
export function domainMatch(host: string, cookie: StoredCookie): boolean {
  if (cookie.hostOnly) return host === cookie.domain;
  if (host === cookie.domain) return true;
  return host.endsWith(`.${cookie.domain}`);
}

/**
 * default-path（RFC 5.1.4）：
 *  - 路径为空或不以 "/" 开头：默认 "/"
 *  - 只有一个斜杠：默认 "/"
 *  - 否则取最后一个斜杠之前的部分（不含最后斜杠后的任何字符）
 */
export function defaultPath(requestPath: string): string {
  const p = requestPath || '/';
  if (!p.startsWith('/')) return '/';
  const lastSlash = p.lastIndexOf('/');
  if (lastSlash <= 0) return '/';
  return p.slice(0, lastSlash);
}

/**
 * path-match（RFC 5.1.4）：
 *  - request-path 与 cookie-path 相等；或
 *  - request-path 以 cookie-path 开头，且 cookie-path 以 "/" 结尾；或
 *  - request-path 以 cookie-path 开头，且紧随其后的字符是 "/"
 */
export function pathMatch(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  if (cookiePath.endsWith('/')) return true;
  return requestPath.charAt(cookiePath.length) === '/';
}

/** 内存 Cookie 罐 */
export class CookieJar {
  private cookies: StoredCookie[] = [];
  private nextIndex = 1;
  /** 全局容量上限（条目数）；null = 不限 */
  private globalLimit: number | null = null;
  /** 每个可注册域的容量上限；未列出表示不限 */
  private domainLimits = new Map<string, number>();

  /**
   * 按顺序处理一次「响应 URL + 单条 Set-Cookie」写入。
   * 返回动作（入罐 / 更新 / 删除 / 拒绝）及原因。
   */
  store(responseUrl: string, setCookieHeader: string, now: number = Date.now()): StoreResult {
    const urlInfo = hostFromUrl(responseUrl);
    if (!urlInfo) {
      return this.result(false, 'rejected', `响应 URL 非法或非 http(s)：${responseUrl}`, []);
    }

    let parsed: ParsedSetCookie;
    try {
      parsed = parseSetCookie(setCookieHeader);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.result(false, 'rejected', `Set-Cookie 解析失败：${message}`, []);
    }

    const { host } = urlInfo;
    const notices: string[] = [];

    // ---- 1. Domain 处理：规范化 + 与响应主机校验 ----
    let domain: string;
    let hostOnly: boolean;
    if (parsed.domain === undefined) {
      // 省略 Domain：host-only，域就是原主机
      domain = host;
      hostOnly = true;
    } else {
      domain = canonicalizeDomain(parsed.domain);
      if (domain.length === 0) {
        return this.result(false, 'rejected', 'Domain 属性为空，无法入罐', notices, parsed);
      }
      if (isIpAddress(host) || isIpAddress(domain)) {
        // RFC 6265：IP 主机忽略 Domain 属性，按 host-only 处理
        if (host !== domain) {
          return this.result(
            false,
            'rejected',
            `响应主机 ${host} 是 IP 地址，Domain=${domain} 与其不一致；IP 不允许域/子域匹配，拒绝入罐`,
            notices,
            parsed,
          );
        }
        domain = host;
        hostOnly = true;
        notices.push(`主机为 IP 地址，忽略 Domain 属性，按 host-only 记录`);
      } else if (host === domain) {
        hostOnly = false;
      } else if (host.endsWith(`.${domain}`)) {
        hostOnly = false;
      } else {
        return this.result(
          false,
          'rejected',
          `Domain=${domain} 不匹配响应主机 ${host}（既不是主机本身，也不是其上级域），拒绝入罐`,
          notices,
          parsed,
        );
      }
    }

    // ---- 2. Path 处理：缺省取 default-path ----
    let cookiePath: string;
    if (parsed.path === undefined || !parsed.path.startsWith('/')) {
      cookiePath = defaultPath(urlInfo.path);
      if (parsed.path !== undefined) {
        notices.push(`Path="${parsed.path}" 不是绝对路径，忽略并使用默认 Path=${cookiePath}`);
      } else {
        notices.push(`Path 属性缺省，取默认路径（响应 URL 最后一个斜杠前的目录）：${cookiePath}`);
      }
    } else {
      cookiePath = parsed.path;
    }

    // ---- 3. Secure 提示：明文 http 响应写入 Secure ----
    if (parsed.secure && urlInfo.protocol === 'http:') {
      notices.push('响应来自明文 http:// 却带 Secure 属性：真实浏览器通常会拒绝该 cookie；本罐仍记录，但它永远不会经 http 请求发送');
    }
    if (parsed.maxAgeInvalid) {
      notices.push('Max-Age 值非法（非整数），已忽略该属性，按会话 cookie 处理（Expires 同样不参与本演算）');
    }

    // ---- 3.5 SameSite=None 必须带 Secure，否则拒绝入罐 ----
    if (parsed.sameSite === 'none' && !parsed.secure) {
      return this.result(
        false,
        'rejected',
        'SameSite=None 必须同时声明 Secure（现代浏览器强制要求，防止明文传输跨站 cookie），拒绝入罐',
        notices,
        parsed,
      );
    }
    if (parsed.sameSiteInvalid) {
      notices.push('SameSite 值非法（仅识别 Strict / Lax / None，大小写不敏感），已按默认 Lax 处理');
    }
    if (parsed.priorityInvalid) {
      notices.push('Priority 值非法（仅识别 Low / Medium / High，大小写不敏感），已按默认 Medium 处理');
    } else if (parsed.priorityDefault) {
      notices.push('Priority 属性缺省，已按默认 Medium 参与容量淘汰');
    }

    const existing = this.findCookie(parsed.name, domain, cookiePath);

    // ---- 4. Max-Age <= 0：删除同名 (name, domain, path) 项 ----
    if (parsed.maxAge !== undefined && parsed.maxAge <= 0) {
      if (existing) {
        this.cookies = this.cookies.filter((c) => c !== existing);
        return this.result(
          true,
          'deleted',
          `Max-Age=${parsed.maxAge}（≤0），已删除同名同域同路径项 ${parsed.name}=…（#${existing.creationIndex}，domain=${domain}，path=${cookiePath}）`,
          notices,
        );
      }
      return this.result(
        true,
        'deleted',
        `Max-Age=${parsed.maxAge}（≤0）要求删除 ${parsed.name}，但罐中不存在 domain=${domain}、path=${cookiePath} 的同名项，无可删除`,
        notices,
      );
    }

    // ---- 5. 计算过期时间（合法的正 Max-Age）----
    let expiresAt: number | undefined;
    if (parsed.maxAge !== undefined && parsed.maxAge > 0) {
      expiresAt = Math.min(now + parsed.maxAge * 1000, MAX_SAFE_EXPIRES);
    }

    // ---- 6. 入罐或更新（同名同域同路径覆盖，沿用首次创建序号）----
    if (existing) {
      existing.value = parsed.value;
      existing.hostOnly = hostOnly;
      existing.secure = parsed.secure;
      existing.httpOnly = parsed.httpOnly;
      existing.sameSite = parsed.sameSite;
      existing.sameSiteDefault = parsed.sameSiteDefault;
      existing.priority = parsed.priority;
      existing.priorityDefault = parsed.priorityDefault;
      existing.expiresAt = expiresAt;
      existing.updatedAt = now;
      // 覆盖更新视为一次访问（RFC 6265bis creation/access-time 语义）
      existing.lastAccessedAt = now;

      // ---- 7. 容量压力：依次执行域级、全局淘汰 ----
      const eviction = this.enforceAfterStore(existing, now);
      this.appendEvictionNotices(notices, eviction);

      return {
        ok: true,
        action: 'updated',
        reason: `同名同域同路径的 ${parsed.name} 已存在（#${existing.creationIndex}），覆盖更新（value/属性以新 Set-Cookie 为准，创建顺序沿用）；Priority=${priorityLabel(parsed.priority, parsed.priorityDefault)}`,
        inheritedIndex: existing.creationIndex,
        notices,
        cookie: this.toView(existing, now),
        jar: this.views(now),
        eviction,
      };
    }

    const stored: StoredCookie = {
      name: parsed.name,
      value: parsed.value,
      domain,
      path: cookiePath,
      hostOnly,
      secure: parsed.secure,
      httpOnly: parsed.httpOnly,
      sameSite: parsed.sameSite,
      sameSiteDefault: parsed.sameSiteDefault,
      priority: parsed.priority,
      priorityDefault: parsed.priorityDefault,
      expiresAt,
      creationIndex: this.nextIndex,
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
    };
    this.nextIndex += 1;
    this.cookies.push(stored);

    // ---- 7. 容量压力：依次执行域级、全局淘汰 ----
    const eviction = this.enforceAfterStore(stored, now);
    this.appendEvictionNotices(notices, eviction);
    const survived = !eviction || !eviction.removed.some((r) => r.index === stored.creationIndex);

    const scopeText = hostOnly
      ? `host-only：仅向主机 ${domain} 发送`
      : `domain：向 ${domain} 及其所有子域（例如 a.${domain}）发送`;
    const lifeText =
      expiresAt === undefined
        ? '会话 cookie（本工具中不过期，重置即清空）'
        : `Max-Age=${parsed.maxAge}s，将于 ${formatTime(expiresAt)} 过期`;
    const sameSiteText = `SameSite=${sameSiteLabel(parsed.sameSite, parsed.sameSiteDefault)}`;
    const priorityText = `Priority=${priorityLabel(parsed.priority, parsed.priorityDefault)}`;
    return this.result(
      true,
      'stored',
      `已入罐：${parsed.name}=${parsed.value}；${scopeText}；Path=${cookiePath}；${sameSiteText}；${priorityText}；${lifeText}` +
        (survived ? '' : '（随后即因容量压力被淘汰，详见淘汰清单）'),
      notices,
      parsed,
      survived ? stored : undefined,
      eviction,
      now,
    );
  }

  /**
   * 对请求演算 Cookie 头。
   * 除请求 URL 外还需 SameSite 上下文：顶层页面 URL、请求方法、是否顶层导航
   * （缺省：顶层页 = 请求 URL、GET、顶层导航，即同站安全方法，全部 SameSite 模式放行）。
   * 逐项给出 send / exclude 及原因；发送项按 Path 长度降序、首次创建顺序升序排列。
   */
  send(requestUrl: string, options: SendOptions = {}, now: number = Date.now()): SendResult {
    const urlInfo = hostFromUrl(requestUrl);
    if (!urlInfo) {
      return this.sendError(`请求 URL 非法或非 http(s)：${requestUrl}`, requestUrl);
    }

    // 顶层页面 URL：缺省视为与请求 URL 相同（同站上下文）
    const topRaw = typeof options.topUrl === 'string' ? options.topUrl.trim() : '';
    let topInfo = urlInfo;
    let topUrl = requestUrl;
    if (topRaw !== '') {
      const parsedTop = hostFromUrl(topRaw);
      if (!parsedTop) {
        return this.sendError(`顶层页面 URL 非法或非 http(s)：${topRaw}`, requestUrl);
      }
      topInfo = parsedTop;
      topUrl = topRaw;
    }

    const method = (options.method ?? 'GET').trim().toUpperCase() || 'GET';
    const topLevelNav = options.topLevelNav ?? true;

    const { host, protocol, path } = urlInfo;
    const secureRequest = protocol === 'https:';

    // same-site = scheme + 可注册域（IP / localhost 按完整主机）
    const requestSite = siteOf(host, protocol);
    const topSite = siteOf(topInfo.host, topInfo.protocol);
    const sameSiteContext = requestSite === topSite;
    const safeMethod = SAFE_METHODS.has(method);
    const siteCompare = `请求站 ${requestSite} ${sameSiteContext ? '=' : '≠'} 顶层站 ${topSite}`;

    const sent: RequestItem[] = [];
    const excluded: RequestItem[] = [];

    for (const c of this.cookies) {
      const expired = c.expiresAt !== undefined && c.expiresAt <= now;
      const label = sameSiteLabel(c.sameSite, c.sameSiteDefault);
      const base: RequestItem = {
        index: c.creationIndex,
        cookie: `${c.name}=${c.value}`,
        name: c.name,
        value: c.value,
        domain: c.domain,
        hostOnly: c.hostOnly,
        path: c.path,
        secure: c.secure,
        sameSite: c.sameSite,
        sameSiteLabel: label,
        verdict: 'exclude',
        detail: '',
        expired,
      };

      // 按 RFC 6265 的顺序逐项检查
      if (expired) {
        base.detail = `已过期（${formatTime(c.expiresAt as number)}），不发送`;
        excluded.push(base);
        continue;
      }
      if (!domainMatch(host, c)) {
        base.detail = c.hostOnly
          ? `host-only cookie 仅匹配原主机 ${c.domain}，请求主机 ${host} 不相等`
          : `Domain cookie 匹配域 ${c.domain} 及其子域，请求主机 ${host} 不属于该范围`;
        excluded.push(base);
        continue;
      }
      if (!pathMatch(path, c.path)) {
        base.detail = `Path 不匹配：cookie-path="${c.path}"，request-path="${path}"（需相等，或以其开头且边界为 "/"）`;
        excluded.push(base);
        continue;
      }
      if (c.secure && !secureRequest) {
        base.detail = `Secure cookie 仅经 https 发送，请求为明文 ${protocol}//`;
        excluded.push(base);
        continue;
      }

      // ---- SameSite 站点演算 ----
      const ssVerdict = this.sameSiteVerdict(c, label, {
        sameSiteContext,
        siteCompare,
        topLevelNav,
        safeMethod,
        method,
        now,
      });
      if (ssVerdict.excludeReason !== null) {
        base.detail = ssVerdict.excludeReason;
        excluded.push(base);
        continue;
      }

      base.verdict = 'send';
      const hostWay = c.hostOnly ? '主机精确相等' : `主机 ${host} 命中域 ${c.domain}`;
      base.detail = `匹配通过：${hostWay}；request-path "${path}" 命中 cookie-path "${c.path}"` +
        (c.secure ? '；https 满足 Secure' : '') +
        `；${ssVerdict.note}`;
      // 发送成功即「访问」：刷新最近访问时间（容量淘汰 LRA 依据）
      c.lastAccessedAt = now;
      sent.push(base);
    }

    // 排序：Path 长度降序；相等时首次创建顺序升序
    sent.sort((a, b) => {
      if (b.path.length !== a.path.length) return b.path.length - a.path.length;
      return a.index - b.index;
    });

    const cookieHeader = sent.map((i) => i.cookie).join('; ');

    // 排除列表保持创建顺序，便于对照
    excluded.sort((a, b) => a.index - b.index);

    return {
      ok: true,
      requestUrl,
      host,
      path,
      secureRequest,
      topUrl,
      method,
      topLevelNav,
      requestSite,
      topSite,
      sameSiteContext,
      cookieHeader,
      sent,
      excluded,
    };
  }

  /** 当前罐内容（会话/未过期状态如实展示，不过滤过期项） */
  list(now: number = Date.now()): CookieView[] {
    return this.views(now);
  }

  /** 容量设置快照与各可注册域用量 */
  capacity(): CapacityView {
    return this.capacityView();
  }

  /**
   * 更新容量设置（全局 + 各可注册域上限，单位：条目数；null/缺省表示不限），
   * 替换式更新，并对所有已配置上限的级别立即执行一次压力淘汰。
   */
  setCapacity(config: { globalLimit?: number | null; domainLimits?: Record<string, number> }, now: number = Date.now()): {
    capacity: CapacityView;
    eviction: EvictionReport;
  } {
    this.globalLimit = config.globalLimit ?? null;
    this.domainLimits = new Map<string, number>();
    if (config.domainLimits) {
      for (const [rawKey, limit] of Object.entries(config.domainLimits)) {
        const key = canonicalizeDomain(rawKey);
        if (key.length > 0 && Number.isInteger(limit) && limit >= 0) {
          this.domainLimits.set(key, limit);
        }
      }
    }
    // 设置变更后立即按新上限执行一次：依次域级（每个已配置的域）、全局
    const stages: EvictionStage[] = [];
    for (const key of this.domainLimits.keys()) {
      stages.push(this.runStage(key, this.domainLimits.get(key) as number, now));
    }
    if (this.globalLimit !== null) {
      stages.push(this.runStage(null, this.globalLimit, now));
    }
    const eviction = this.assembleReport(stages);
    return { capacity: this.capacityView(), eviction };
  }

  reset(): void {
    this.cookies = [];
    this.nextIndex = 1;
    // 容量设置属于模拟参数，重置罐内容时保留，便于重复演算
  }

  // ---------------- 内部辅助 ----------------

  private findCookie(name: string, domain: string, path: string): StoredCookie | undefined {
    return this.cookies.find((c) => c.name === name && c.domain === domain && c.path === path);
  }

  /**
   * SameSite 单项演算：返回 null 排除原因表示放行，并附带一句站点说明（用于发送项详情）。
   *  - Strict：仅同站；
   *  - 显式 Lax：同站，或跨站顶层导航的安全方法；
   *  - 默认 Lax：同上，另允许创建不超过 120 秒的跨站顶层 POST；
   *  - None：不限制站点（入罐时已强制 Secure）。
   */
  private sameSiteVerdict(
    c: StoredCookie,
    label: string,
    ctx: {
      sameSiteContext: boolean;
      siteCompare: string;
      topLevelNav: boolean;
      safeMethod: boolean;
      method: string;
      now: number;
    },
  ): { excludeReason: string | null; note: string } {
    const { sameSiteContext, siteCompare, topLevelNav, safeMethod, method, now } = ctx;

    if (sameSiteContext) {
      return { excludeReason: null, note: `SameSite=${label}：同站请求（${siteCompare}）` };
    }
    if (c.sameSite === 'none') {
      return { excludeReason: null, note: `SameSite=None：跨站照常发送（${siteCompare}，已强制 Secure）` };
    }
    if (c.sameSite === 'strict') {
      return {
        excludeReason: `SameSite=Strict：仅同站请求发送；当前跨站（${siteCompare}），不发送`,
        note: '',
      };
    }

    // 以下为跨站 Lax
    const modeText = c.sameSiteDefault ? 'Lax（默认）' : 'Lax（显式）';
    if (topLevelNav && safeMethod) {
      return {
        excludeReason: null,
        note: `SameSite=${modeText}：跨站放行——顶层导航的安全方法 ${method}（${siteCompare}）`,
      };
    }
    if (c.sameSiteDefault && topLevelNav && method === 'POST') {
      const ageMs = now - c.createdAt;
      if (ageMs <= LAX_POST_GRACE_MS) {
        const ageSec = Math.floor(ageMs / 1000);
        return {
          excludeReason: null,
          note: `SameSite=Lax（默认）：跨站放行——创建 ${ageSec} 秒 ≤ 120 秒宽限的顶层 POST（${siteCompare}）`,
        };
      }
      const ageSec = Math.floor(ageMs / 1000);
      return {
        excludeReason:
          `SameSite=Lax（默认）：跨站顶层 POST 的 120 秒宽限已过（已创建 ${ageSec} 秒），` +
          `且 POST 不是安全方法，不发送（${siteCompare}）`,
        note: '',
      };
    }
    if (!topLevelNav) {
      const allow = c.sameSiteDefault ? '顶层导航的安全方法或 120 秒内的顶层 POST' : '顶层导航的安全方法';
      return {
        excludeReason: `SameSite=${modeText}：跨站仅允许${allow}，当前为非顶层导航（子资源/iframe 等），不发送（${siteCompare}）`,
        note: '',
      };
    }
    // 顶层导航但方法不安全（显式 Lax 的任意方法，或默认 Lax 的非 POST 方法）
    const grace = c.sameSiteDefault ? '；120 秒宽限仅限 POST' : '';
    return {
      excludeReason:
        `SameSite=${modeText}：跨站顶层导航仅安全方法（GET/HEAD/OPTIONS/TRACE）可发，` +
        `当前方法 ${method}${grace}，不发送（${siteCompare}）`,
      note: '',
    };
  }

  private sendError(error: string, requestUrl: string): SendResult {
    return {
      ok: false,
      error,
      requestUrl,
      host: '',
      path: '',
      secureRequest: false,
      topUrl: '',
      method: '',
      topLevelNav: false,
      requestSite: '',
      topSite: '',
      sameSiteContext: false,
      cookieHeader: '',
      sent: [],
      excluded: [],
    };
  }

  private toView(c: StoredCookie, now: number): CookieView {
    const expired = c.expiresAt !== undefined && c.expiresAt <= now;
    return {
      index: c.creationIndex,
      name: c.name,
      value: c.value,
      domain: c.domain,
      hostOnly: c.hostOnly,
      scope: c.hostOnly ? 'host-only' : `domain（含 *.${c.domain}）`,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      sameSiteDefault: c.sameSiteDefault,
      sameSiteLabel: sameSiteLabel(c.sameSite, c.sameSiteDefault),
      priority: c.priority,
      priorityDefault: c.priorityDefault,
      priorityLabel: priorityLabel(c.priority, c.priorityDefault),
      persistent: c.expiresAt !== undefined,
      expiresAt: c.expiresAt === undefined ? null : formatTime(c.expiresAt),
      remaining: c.expiresAt === undefined ? null : expired ? '已过期' : formatRemaining(c.expiresAt, now),
      expired,
      createdAt: formatTime(c.createdAt),
      updatedAt: formatTime(c.updatedAt),
      lastAccessedAt: formatTime(c.lastAccessedAt),
    };
  }

  private views(now: number): CookieView[] {
    return [...this.cookies]
      .sort((a, b) => a.creationIndex - b.creationIndex)
      .map((c) => this.toView(c, now));
  }

  private result(
    ok: boolean,
    action: StoreAction,
    reason: string,
    notices: string[],
    _parsed?: ParsedSetCookie,
    stored?: StoredCookie,
    eviction: EvictionReport | null = null,
    now: number = Date.now(),
  ): StoreResult {
    return {
      ok,
      action,
      reason,
      notices,
      cookie: stored ? this.toView(stored, now) : null,
      jar: this.views(now),
      eviction,
    };
  }

  // ---------------- 容量压力淘汰 ----------------

  /** 入罐后执行压力淘汰：域级（仅新条目所属可注册域，若设了上限）→ 全局（若设了上限） */
  private enforceAfterStore(stored: StoredCookie, now: number): EvictionReport | null {
    const stages: EvictionStage[] = [];
    const regDomain = registrableDomain(stored.domain);
    const domainLimit = this.domainLimits.get(regDomain);
    if (domainLimit !== undefined) {
      stages.push(this.runStage(regDomain, domainLimit, now));
    }
    if (this.globalLimit !== null) {
      stages.push(this.runStage(null, this.globalLimit, now));
    }
    return stages.length ? this.assembleReport(stages) : null;
  }

  /** 组装汇总报告（removed 保持各阶段内的实际移除顺序） */
  private assembleReport(stages: EvictionStage[]): EvictionReport {
    const removed = stages.flatMap((s) => s.removed);
    return {
      basis: EVICTION_BASIS,
      triggered: removed.length > 0,
      stages,
      removed,
    };
  }

  /**
   * 执行一个级别的压力淘汰：
   *  domain === null 表示全局；否则只看 cookie 的可注册域 === domain 的条目。
   * 条数不超限时完全不动（不预清过期项）；超限时先清理过期项，再按
   * Priority 低→高、最近访问早→晚、创建序号小→大淘汰，直到回到上限。
   */
  private runStage(domain: string | null, limit: number, now: number): EvictionStage {
    const scopeName = domain === null ? '全局' : `域 ${domain}`;
    const inScope = (c: StoredCookie): boolean =>
      domain === null || registrableDomain(c.domain) === domain;
    const scoped = this.cookies.filter(inScope);
    const beforeCount = scoped.length;

    const stage: EvictionStage = {
      scope: domain === null ? 'global' : 'domain',
      domain,
      limit,
      beforeCount,
      expiredRemoved: 0,
      evictedCount: 0,
      afterCount: beforeCount,
      triggered: false,
      removed: [],
    };

    if (beforeCount <= limit) {
      return stage;
    }

    // 1) 先物理清理范围内已过期项
    const expiredCookies = scoped.filter(
      (c) => c.expiresAt !== undefined && c.expiresAt <= now,
    );
    for (const c of expiredCookies) {
      stage.removed.push(this.toEvicted(c, now, 'expired', `已过期（${formatTime(c.expiresAt as number)}），先于容量淘汰被清理（${scopeName}）`));
    }
    if (expiredCookies.length) {
      const expiredSet = new Set(expiredCookies);
      this.cookies = this.cookies.filter((c) => !expiredSet.has(c));
      stage.expiredRemoved = expiredCookies.length;
    }

    // 2) 仍超限时，按优先级 → 最近访问 → 创建序号 淘汰
    let remaining = this.cookies.filter(inScope);
    const overflow = remaining.length - limit;
    if (overflow > 0) {
      const victims = [...remaining].sort(this.compareEviction).slice(0, overflow);
      const victimSet = new Set(victims);
      for (const c of victims) {
        stage.removed.push(
          this.toEvicted(
            c,
            now,
            'evicted',
            `容量淘汰（${scopeName}，上限 ${limit}）：Priority=${priorityLabel(c.priority, c.priorityDefault)}，` +
            `最近访问 ${formatTime(c.lastAccessedAt)}，创建序号 #${c.creationIndex}，在「${EVICTION_BASIS}」中排最前`,
          ),
        );
      }
      this.cookies = this.cookies.filter((c) => !victimSet.has(c));
      stage.evictedCount = victims.length;
      remaining = this.cookies.filter(inScope);
    }

    stage.afterCount = remaining.length;
    stage.triggered = stage.removed.length > 0;
    return stage;
  }

  /** 淘汰排序：优先级低 → 高；同级最近访问早 → 晚；再同则创建序号小 → 大 */
  private compareEviction(a: StoredCookie, b: StoredCookie): number {
    const pr = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (pr !== 0) return pr;
    if (a.lastAccessedAt !== b.lastAccessedAt) return a.lastAccessedAt - b.lastAccessedAt;
    return a.creationIndex - b.creationIndex;
  }

  private toEvicted(
    c: StoredCookie,
    now: number,
    reason: 'expired' | 'evicted',
    basis: string,
  ): EvictedCookie {
    const expired = c.expiresAt !== undefined && c.expiresAt <= now;
    return {
      index: c.creationIndex,
      name: c.name,
      value: c.value,
      cookie: `${c.name}=${c.value}`,
      domain: c.domain,
      hostOnly: c.hostOnly,
      path: c.path,
      priority: c.priority,
      priorityLabel: priorityLabel(c.priority, c.priorityDefault),
      expired,
      lastAccessedAt: formatTime(c.lastAccessedAt),
      reason,
      basis,
    };
  }

  /** 把淘汰汇总追加为入罐提示（界面 notices 与淘汰清单都会显示） */
  private appendEvictionNotices(notices: string[], report: EvictionReport | null): void {
    if (!report) return;
    for (const stage of report.stages) {
      if (!stage.triggered) continue;
      const where = stage.scope === 'global' ? '全局' : `可注册域 ${stage.domain ?? ''}`;
      if (stage.expiredRemoved > 0) {
        notices.push(`${where}容量检查：超限（${stage.beforeCount} > ${stage.limit}），先清理 ${stage.expiredRemoved} 条已过期项`);
      }
      if (stage.evictedCount > 0) {
        notices.push(`${where}容量淘汰：${stage.evictedCount} 条被逐出（${EVICTION_BASIS}），剩余 ${stage.afterCount}/${stage.limit}`);
      }
    }
  }

  /** 容量快照：全局上限 + 各域上限，及按可注册域聚合的当前用量 */
  private capacityView(): CapacityView {
    const counts = new Map<string, number>();
    for (const c of this.cookies) {
      const key = registrableDomain(c.domain);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const keys = new Set<string>([...counts.keys(), ...this.domainLimits.keys()]);
    const usage = [...keys]
      .sort()
      .map((domain) => ({
        domain,
        count: counts.get(domain) ?? 0,
        limit: this.domainLimits.has(domain) ? (this.domainLimits.get(domain) as number) : null,
      }));
    return {
      globalLimit: this.globalLimit,
      domainLimits: [...this.domainLimits.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([domain, limit]) => ({ domain, limit })),
      totalCount: this.cookies.length,
      usage,
    };
  }
}
