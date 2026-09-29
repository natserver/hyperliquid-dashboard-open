/**
 * Hyperliquid 只读数据客户端（仅后端使用）。
 *
 * 设计约束：
 *   1. 只用 Node 内置的 fetch，不引入任何 npm 依赖 —— 这个工程会碰你的账户地址，
 *      少一个依赖就少一条供应链风险路径。
 *   2. 带缓存与限流。Hyperliquid 的 info 接口有 IP 级权重限制，界面每秒轮询
 *      会被限死；同时多个面板请求同一份数据也没必要重复打。
 *   3. 全部是只读接口，不需要任何密钥。clearinghouseState 等数据在 Hyperliquid
 *      上本来就是公开的 —— 只要知道地址就能读。
 *
 * ⚠️ 最常见的一个坑：查询账户数据必须传**主账户地址**，
 *    传 API Wallet（agent）地址会返回空结果。
 */

export const NETWORKS = {
  mainnet: {
    key: 'mainnet',
    label: '主网',
    info: 'https://api.hyperliquid.xyz/info',
    ws: 'wss://api.hyperliquid.xyz/ws',
    app: 'https://app.hyperliquid.xyz',
  },
  testnet: {
    key: 'testnet',
    label: '测试网',
    info: 'https://api.hyperliquid-testnet.xyz/info',
    ws: 'wss://api.hyperliquid-testnet.xyz/ws',
    app: 'https://app.hyperliquid-testnet.xyz',
  },
};

export function getNetwork(name) {
  const n = NETWORKS[String(name || 'mainnet').toLowerCase()];
  if (!n) throw new Error(`未知网络: ${name}`);
  return n;
}

/** 地址校验：0x + 40 位十六进制。这一步能挡住绝大多数「填错成 API Wallet」的误用 */
export function isValidAddress(a) {
  return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a.trim());
}

export function normalizeAddress(a) {
  const s = String(a || '').trim().toLowerCase();
  if (!isValidAddress(s)) throw new Error(`地址格式不正确：${a}（应为 0x 开头 42 位十六进制）`);
  return s;
}

/* ───────────────────────── 缓存与限流 ───────────────────────── */

const cache = new Map(); // key -> { exp, value }
let inflight = new Map(); // 同一 key 的并发请求合并，避免同时打两发

/** 各类请求的缓存有效期（毫秒）。行情类短、静态类长。 */
const TTL = {
  meta: 60 * 60 * 1000,
  metaAndAssetCtxs: 5 * 1000,
  allMids: 3 * 1000,
  clearinghouseState: 5 * 1000,
  spotClearinghouseState: 30 * 1000,
  openOrders: 5 * 1000,
  frontendOpenOrders: 5 * 1000,
  userFills: 20 * 1000,
  userFillsByTime: 20 * 1000,
  portfolio: 60 * 1000,
  userFunding: 60 * 1000,
  userNonFundingLedgerUpdates: 5 * 60 * 1000,
  userFees: 5 * 60 * 1000,
  userRole: 30 * 60 * 1000,
  userRateLimit: 60 * 1000,
  candleSnapshot: 30 * 1000,
  l2Book: 2 * 1000,
  fundingHistory: 60 * 1000,
  vaultDetails: 60 * 1000,
};

/**
 * 全局出站闸门：限制并发数与最小间隔，防止面板刷新把自己打到限流。
 * Hyperliquid 的权重限制是按 IP 的，本机所有请求共享同一个额度。
 *
 * 实现用单一 pump 循环：每个 waiter 只有在拿到槽位时才会被 shift 出去，
 * 不会出现「取出后再次失败、又没重新入队」导致的永久挂起。
 */
const MAX_CONCURRENT = 4;
const MIN_GAP_MS = 60;
const gate = { active: 0, lastStart: 0, waiters: [] };

function pump() {
  while (gate.waiters.length > 0 && gate.active < MAX_CONCURRENT) {
    const now = Date.now();
    const wait = Math.max(0, gate.lastStart + MIN_GAP_MS - now);
    if (wait > 0) {
      setTimeout(pump, wait);
      return; // 等到间隔满足再继续，不阻塞事件循环
    }
    gate.active += 1;
    gate.lastStart = now;
    gate.waiters.shift()();
  }
}

function acquire() {
  return new Promise((resolve) => {
    gate.waiters.push(resolve);
    pump();
  });
}

function release() {
  gate.active = Math.max(0, gate.active - 1);
  pump();
}

export function cacheStats() {
  const now = Date.now();
  let live = 0;
  for (const v of cache.values()) if (v.exp > now) live += 1;
  return { entries: cache.size, live, inflight: inflight.size };
}

export function clearCache() {
  cache.clear();
}

/* ───────────────────────── 核心请求 ───────────────────────── */

/**
 * 发一个 info 请求。
 * @param {string} network mainnet | testnet
 * @param {object} body 请求体（必须含 type）
 * @param {object} [opts] { ttl, noCache, timeout }
 */
export async function info(network, body, opts = {}) {
  const net = getNetwork(network);
  const type = body?.type;
  if (!type) throw new Error('请求体缺少 type 字段');

  const key = `${net.key}:${JSON.stringify(body)}`;
  const ttl = opts.ttl ?? TTL[type] ?? 10 * 1000;

  if (!opts.noCache) {
    const hit = cache.get(key);
    if (hit && hit.exp > Date.now()) return hit.value;
    const pending = inflight.get(key);
    if (pending) return pending;
  }

  const task = (async () => {
    await acquire();
    try {
      return await withRetry(async () => {
        const res = await fetch(net.info, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(opts.timeout ?? 15000),
        });
        if (res.status === 429) {
          const e = new Error('触发 Hyperliquid 限流（HTTP 429）');
          e.retryable = true;
          throw e;
        }
        if (res.status >= 500) {
          const e = new Error(`Hyperliquid 服务端错误（HTTP ${res.status}）`);
          e.retryable = true;
          throw e;
        }
        const text = await res.text();
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          throw new Error(`响应不是合法 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
        }
        // 接口对非法请求类型会返回 200 + 错误消息，这里统一转成异常
        if (json && !Array.isArray(json) && typeof json === 'object' && typeof json.error === 'string') {
          const e = new Error(`Hyperliquid 拒绝请求：${json.error}`);
          e.apiError = json.error;
          throw e;
        }
        return json;
      });
    } finally {
      release();
    }
  })();

  if (!opts.noCache) {
    inflight.set(key, task);
    task
      .then((value) => {
        cache.set(key, { exp: Date.now() + ttl, value });
      })
      .catch(() => {})
      .finally(() => inflight.delete(key));
  }
  return task;
}

async function withRetry(fn, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!e.retryable || i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 400 * 2 ** i)); // 指数退避
    }
  }
  throw lastErr;
}

/* ───────────────────────── 便捷方法 ───────────────────────── */

export const meta = (net) => info(net, { type: 'meta' });

/** 返回 [meta, assetCtxs]。assetCtxs[i] 对应 universe[i]。 */
export const metaAndAssetCtxs = (net) => info(net, { type: 'metaAndAssetCtxs' });

export const allMids = (net) => info(net, { type: 'allMids' });

export const clearinghouseState = (net, user, dex) =>
  info(net, { type: 'clearinghouseState', user: normalizeAddress(user), ...(dex ? { dex } : {}) });

export const spotClearinghouseState = (net, user) =>
  info(net, { type: 'spotClearinghouseState', user: normalizeAddress(user) });

export const openOrders = (net, user) => info(net, { type: 'openOrders', user: normalizeAddress(user) });

export const frontendOpenOrders = (net, user) =>
  info(net, { type: 'frontendOpenOrders', user: normalizeAddress(user) });

export const userFills = (net, user) => info(net, { type: 'userFills', user: normalizeAddress(user) });

export const portfolio = (net, user) => info(net, { type: 'portfolio', user: normalizeAddress(user) });

export const userFees = (net, user) => info(net, { type: 'userFees', user: normalizeAddress(user) });

export const userRole = (net, user) => info(net, { type: 'userRole', user: normalizeAddress(user) });

export const userRateLimit = (net, user) => info(net, { type: 'userRateLimit', user: normalizeAddress(user) });

export const userFunding = (net, user, startTime) =>
  info(net, { type: 'userFunding', user: normalizeAddress(user), startTime: startTime ?? Date.now() - 30 * 86400000 });

export const userNonFundingLedgerUpdates = (net, user, startTime) =>
  info(net, {
    type: 'userNonFundingLedgerUpdates',
    user: normalizeAddress(user),
    startTime: startTime ?? Date.now() - 90 * 86400000,
  });

export const candleSnapshot = (net, coin, interval, startTime, endTime) =>
  info(
    net,
    {
      type: 'candleSnapshot',
      req: { coin, interval, startTime: startTime ?? Date.now() - 60 * 86400000, endTime: endTime ?? Date.now() },
    },
    // K 线按 coin+interval 缓存，但需要更短的 TTL 让最新一根能更新
    { ttl: 20 * 1000 }
  );

/** 按 tid 去重，并按时间正序排列。跨页时区间端点是闭区间，必然有重叠。 */
export function dedupeSort(fills) {
  const seen = new Set();
  const out = [];
  for (const f of fills || []) {
    const k = f.tid ?? `${f.hash}:${f.oid}:${f.time}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  out.sort((a, b) => a.time - b.time || (a.tid || 0) - (b.tid || 0));
  return out;
}

/**
 * 最近成交。
 *
 * 用无时间参数的 `userFills`——接口对这个请求的原生语义就是「最新的 2000 笔」，
 * 正好是面板想要的东西。
 *
 * ⚠️ 不要用 `userFillsByTime` + `startTime: 0` 去拿「最近成交」。
 *    那样拿到的是**全历史里最早**的 2000 笔（见下方 fetchFillsRange 的说明）。
 *    这个坑在 v1 版本里真实存在过：面板展示的是账户最旧的成交。
 */
export async function recentFills(net, user) {
  const r = await info(
    net,
    { type: 'userFills', user: normalizeAddress(user) },
    { noCache: true, ttl: 0, timeout: 20000 }
  );
  return dedupeSort(Array.isArray(r) ? r : []);
}

/**
 * 按时间区间拉取成交，自动【向前】翻页。
 *
 * ⚠️ 反直觉的接口语义（实测确认，v1 就是踩了这个坑）：
 *    `userFillsByTime` 返回的是区间内**最早**的 2000 笔，**不是**最新的。
 *    因此翻页必须把 `startTime` 往前推（= 本页最晚 + 1）；
 *    按 `endTime` 往回翻会立刻拿到 0 条，看起来像「数据没了」，其实是翻反了。
 *
 * 另一个实测结论：服务端对成交的保留是按【笔数】封顶，而不是按时间封顶。
 *    做市账户（每小时近万笔）只能取到约 1~2 小时；
 *    几千笔的个人账户能取到 300~1170 天。
 *    所以「给了一年的 startTime」不等于「能拿到一年」——
 *    必须以实际返回的最早时间为准，并在结果里如实反映。
 *
 * @returns {{fills: Array, pages: number, exhausted: boolean, oldest: number|null, newest: number|null}}
 */
export async function fetchFillsRange(net, user, opts = {}) {
  const addr = normalizeAddress(user);
  const { from = 0, to = Date.now(), maxFills = 40000, maxPages = 40, onPage } = opts;

  const all = [];
  let cursor = from;
  let pages = 0;
  let exhausted = false;

  while (pages < maxPages && all.length < maxFills) {
    const batch = await info(
      net,
      { type: 'userFillsByTime', user: addr, startTime: cursor, endTime: to },
      { noCache: true, ttl: 0, timeout: 30000 }
    );
    if (!Array.isArray(batch) || batch.length === 0) {
      exhausted = true;
      break;
    }
    pages += 1;
    all.push(...batch);

    let hi = 0;
    for (const f of batch) if (f.time > hi) hi = f.time;
    if (typeof onPage === 'function') onPage({ page: pages, got: batch.length, total: all.length, hi });

    // 不满页 = 已到数据边界（注意：这里必须向前判，向后判是错的）
    if (batch.length < 2000) {
      exhausted = true;
      break;
    }
    if (hi < cursor) break; // 游标未推进，防死循环
    cursor = hi + 1;
  }

  const fills = dedupeSort(all);
  return {
    fills,
    pages,
    exhausted,
    oldest: fills[0]?.time ?? null,
    newest: fills.at(-1)?.time ?? null,
  };
}

/**
 * 兼容旧调用点。
 *   - 不给 since/from → 取最近成交（面板语义）
 *   - 给了 since/from → 从该时间点向前翻页
 */
export async function fetchFills(net, user, opts = {}) {
  const from = opts.since ?? opts.from;
  if (from == null) return recentFills(net, user);
  const { fills } = await fetchFillsRange(net, user, { ...opts, from });
  return fills;
}

/** 把 meta + assetCtxs 合成一个 name -> 上下文 的映射，避免每次线性查找 */
export function indexMarket(metaRes, ctxRes) {
  const universe = metaRes?.universe || [];
  const ctxs = Array.isArray(ctxRes) ? ctxRes[1] || [] : [];
  const byName = new Map();
  universe.forEach((u, i) => {
    byName.set(u.name, { ...u, index: i, ctx: ctxs[i] || null });
  });
  return byName;
}
