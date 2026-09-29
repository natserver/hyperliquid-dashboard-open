/**
 * 自动事件源 —— 把「黑天鹅 / 减半 / 美联储决议」从手工录入改成每天自动抓。
 *
 * ── 为什么原来要手工 ────────────────────────────────────────────
 * config/macro-events.json 的表头写着「没有任何免费无密钥的接口能可靠给出」。
 * 那句话在**当时**是对的，但不适用于这三类：
 *
 *   · 减半   —— 根本不是新闻，是**算术**。BTC 每 210000 块减半一次，
 *               拿当前块高就能推到下次减半的块高与大致日期。确定性输入，
 *               不存在「可靠性」问题，也永远不需要人去录。
 *   · 美联储 —— 日程在联储官网公开（FOMC 日历，HTML 但结构稳定）；
 *               结果更简单：FRED 的目标利率序列 DFEDTARU 免费 CSV，
 *               **哪天变的、变了多少 bp** 都在里面。这是数据不是判断。
 *   · 黑天鹅 —— 没有哪个接口会告诉你「这是黑天鹅」。但黑天鹅的判定
 *               本来就该落在价格上（单日暴跌 / 区间回撤），阈值一触发
 *               就记一条，**不触发就不记**。
 *
 * ── 不编造这条线怎么守住 ──────────────────────────────────────
 * 自动写出来的每一条都能指回一个可验证的数（块高 / 联储页面上的日期 /
 * FRED CSV 里某天的数值 / 某根日线收盘价）。抓不到就不写，绝不拿占位符
 * 顶上 —— 手工表当年留白是因为「不知道」，自动表的留白理由完全一样。
 *
 * 自动事件 id 一律带 `auto:` 前缀，落在 `.data/events-auto.json`
 * （bind mount，容器重建不丢）；手工表仍在 config/macro-events.json，
 * 合并在 loadMacroEvents 里做，**手工条目永远优先**。
 */

import { httpGet, lastChange, parseFredCsv } from './macro-sources.js';

const DAY = 86400000;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

/* ════════════════ ① 减半：块高 → 下次减半 ════════════════ */

export const HALVING_INTERVAL = 210000; // 第 n 次减半的块高：210000 × n
/** 平均出块 10 分钟。这是**估算**，note 里会写明，不用它冒充精确时刻。 */
export const BLOCK_MS = 10 * 60 * 1000;

/** blockchain.info 的 /q/getblockcount 返回纯数字（实测 200：`968957`）。 */
export function parseBlockHeight(text) {
  const n = Number(String(text).trim());
  if (!Number.isFinite(n) || n < HALVING_INTERVAL) {
    throw new Error(`块高解析失败：${String(text).slice(0, 40)}`);
  }
  return n;
}

/** 当前块高 → 下次减半的块高与日期（UTC 日）。 */
export function nextHalving(height, now = Date.now()) {
  const nextHeight = Math.floor(height / HALVING_INTERVAL + 1) * HALVING_INTERVAL;
  const etaMs = now + (nextHeight - height) * BLOCK_MS;
  return { nextHeight, date: ymd(etaMs) };
}

/* ════════════════ ② 美联储：FOMC 日历 + 目标利率 ════════════════ */

const MONTHS = {
  January: 1, February: 2, March: 3, April: 4, May: 5, June: 6,
  July: 7, August: 8, September: 9, October: 10, November: 11, December: 12,
};

/**
 * 联储官网 FOMC 日历（HTML）里的会议日期。**两种写法都要认**，这是实测踩出来的：
 *
 *   单日  `September 16, 2026`     —— 往年与已开的会
 *   范围  `January 25-26, 2028`    —— 两日会议，只认单日正则会把未来会议整个漏掉
 *
 * 同理也混着 `April 08, 2026`（补零）与 `February 18, 2026`（不补零）。
 * 只取未来（含今天），范围写法取**起始日**；相隔 ≤4 天的日期并成同一次会议。
 */
export function parseFomcDates(html, now = Date.now()) {
  const re =
    /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:-\d{1,2})?,\s*(20\d\d)/g;
  const seen = new Set();
  let m;
  while ((m = re.exec(html)) !== null) {
    const month = MONTHS[m[1]];
    if (!month) continue;
    const day = Number(m[2]);
    const t = Date.UTC(Number(m[3]), month - 1, day);
    if (Number.isFinite(t) && t >= now - DAY) seen.add(ymd(t)); // 只要未来（含今天）
  }
  const days = [...seen].sort();
  const out = [];
  for (const d of days) {
    const t = Date.parse(`${d}T00:00:00Z`);
    const prev = out.length ? Date.parse(`${out[out.length - 1]}T00:00:00Z`) : null;
    if (prev == null || t - prev > 4 * DAY) out.push(d); // 同一次会议的两天并掉
  }
  return out.slice(0, 4); // 未来 4 次会议够排日程，再多人家还没公布
}

/**
 * FRED 目标利率区间的**最近一次实际变动**（不是「会议日程」，是「真变了」）。
 * 复用 macro-sources 的 lastChange —— 它拿「第一个带新值的观测日」当日期，
 * 所以报出来的 `changedOn` 就是决议生效那天。
 */
export function readRateEvent(rows, { now = Date.now() } = {}) {
  const ch = rows?.length ? lastChange(rows) : null;
  if (!ch || ch.direction === 'FLAT' || !ch.changedOn) return null;
  const t = Date.parse(`${ch.changedOn}T00:00:00Z`);
  if (!Number.isFinite(t) || now - t > 400 * DAY) return null; // 太久远的不重复记
  const weight = ch.direction === 'CUT' ? 0.6 : -0.8; // 与手工表先例同口径
  return {
    date: ch.changedOn,
    weight,
    deltaBp: ch.deltaBp,
    direction: ch.direction,
    latest: ch.latest,
    from: ch.from,
    note:
      ch.direction === 'CUT'
        ? `美联储目标利率区间上限下调 ${ch.deltaBp}bp 至 ${ch.latest}%（FRED DFEDTARU，${ch.changedOn} 生效）。流动性转松。`
        : `美联储目标利率区间上限上调 ${ch.deltaBp}bp 至 ${ch.latest}%（FRED DFEDTARU，${ch.changedOn} 生效）。流动性收紧。`,
  };
}

/* ════════════════ ③ 黑天鹅：价格极端 ════════════════ */

/** Yahoo 日线：`[{date, close}]`，丢掉没有收盘价的空洞。 */
export function parseDailyCloses(text) {
  const j = JSON.parse(text);
  const r = j?.chart?.result?.[0];
  const ts = r?.timestamp || [];
  const close = r?.indicators?.quote?.[0]?.close || [];
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const c = Number(close[i]);
    if (Number.isFinite(c) && c > 0) out.push({ date: ymd(ts[i] * 1000), close: c });
  }
  if (!out.length) throw new Error('日线解析无有效收盘价');
  return out;
}

/**
 * 触发即记、不触发不记 —— 这是「不编造」在黑天鹅这条上的具体形态。
 *
 * 两个触发条件（任一）：
 *   · 最近 `lookbackDays` 天里出现单日跌幅 ≤ -10%      （当日报跌）
 *   · 最近 `lookbackDays` 天里从区间高点回撤 ≤ -25%    （连续阴跌也算）
 *
 * 阈值取 BTC 史上大崩的量级（312 单日近 -50%、LUNA/FTX 连续多日），
 * 比 -5% 严得多 —— 普通回调不该被记成黑天鹅，那会让这个「一票否决」
 * 通道天天触发，最后没人再看它。
 */
export function detectCrash(closes, { now = Date.now(), lookbackDays = 14, crashPct = -10, drawdownPct = -25 } = {}) {
  const since = now - lookbackDays * DAY;
  const rows = closes.filter((r) => Date.parse(`${r.date}T00:00:00Z`) >= since);
  if (rows.length < 2) return null;

  let worst = null;
  for (let i = 1; i < rows.length; i++) {
    const pct = ((rows[i].close - rows[i - 1].close) / rows[i - 1].close) * 100;
    if (!worst || pct < worst.pct) worst = { date: rows[i].date, pct };
  }
  const peak = rows.reduce((a, r) => (r.close > a ? r.close : a), rows[0].close);
  const troughRow = rows.reduce((a, r) => (r.close < a.close ? r : a), rows[0]);
  const dd = ((troughRow.close - peak) / peak) * 100;

  if (worst && worst.pct <= crashPct) {
    return {
      date: worst.date,
      kind: 'shock',
      weight: -2,
      pct: Number(worst.pct.toFixed(2)),
      trigger: 'daily',
      note: `暴跌：BTC 当日收跌 ${worst.pct.toFixed(1)}%（日线，阈值 -10%）。方向层进入 shock 冻结。`,
    };
  }
  if (dd <= drawdownPct) {
    return {
      date: troughRow.date,
      kind: 'shock',
      weight: -2,
      pct: Number(dd.toFixed(2)),
      trigger: 'drawdown',
      note: `深回撤：BTC ${rows[0].date} 起区间回撤 ${dd.toFixed(1)}%（阈值 -25%）。方向层进入 shock 冻结。`,
    };
  }
  return null;
}

/* ════════════════ 采集：四路并取，失败不互相拖累 ════════════════ */

export const EVENTS_SOURCES = {
  halving: 'https://blockchain.info/q/getblockcount',
  fomc: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
  rate: 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFEDTARU',
  crash: 'https://query1.finance.yahoo.com/v8/finance/chart/BTC-USD?range=1mo&interval=1d',
};

/**
 * 单路采集：抓 + 解析成 `detail`。返回 `{key, detail, error}`，error 为 null 表示成功。
 *
 * 失败重试一次：这四路是并行打出去的，偶发 DNS/超时抖动会让整类事件静默缺席 ——
 * 一小时后重跑能补上，但当天的账本里会缺一天。重试 1.5s 后再来一遍比这划算。
 */
async function grab(key, parse, { fetchImpl = fetch, retries = 1 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await httpGet(EVENTS_SOURCES[key], { fetchImpl, timeoutMs: 25000 });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return { key, detail: parse(r.text), error: null };
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise((res) => setTimeout(res, 1500));
    }
  }
  return { key, detail: null, error: String(lastErr?.message || lastErr) };
}

/**
 * 跑一遍，产出写进 `.data/events-auto.json` 的事件数组。
 * 四路**并行**、各自成败互不拖累：抓不到就少一类事件，不因此让整轮失败
 * （与 macro-daily 同口径：昨天的 DXY 比没有 DXY 有用）。
 */
export async function collectAutoEvents({ fetchImpl = fetch, now = Date.now() } = {}) {
  const [h, f, r, c] = await Promise.all([
    grab('halving', (t) => nextHalving(parseBlockHeight(t), now), { fetchImpl }),
    grab('fomc', (t) => parseFomcDates(t, now), { fetchImpl }),
    grab('rate', (t) => readRateEvent(parseFredCsv(t), { now }), { fetchImpl }),
    grab('crash', (t) => detectCrash(parseDailyCloses(t), { now }), { fetchImpl }),
  ]);

  const events = [];

  if (!h.error && h.detail) {
    const { nextHeight, date } = h.detail;
    events.push({
      id: `auto:halving-${date.slice(0, 4)}`,
      date,
      kind: 'halving',
      weight: 0,
      halfLifeDays: 3650,
      source: EVENTS_SOURCES.halving,
      note: `第 ${nextHeight / HALVING_INTERVAL} 次减半（块高 ${nextHeight}）预计 ${date} 前后 —— 按当前块高 × 10 分钟平均出块推算，是估算不是预告。权重记 0：减半已由「减半时钟」完整表达，再计一次是重复计算。`,
    });
  }

  for (const d of f.detail || []) {
    events.push({
      id: `auto:fomc-${d}`,
      date: d,
      kind: 'liquidity',
      weight: 0,
      halfLifeDays: 90,
      source: EVENTS_SOURCES.fomc,
      note: `美联储 FOMC 会议（联储官网日历，${d} 起，决议通常在第二天）。日程型：不计权重，只提示「利率决议临近」。`,
    });
  }

  if (r.detail) {
    events.push({
      id: `auto:rate-${r.detail.date}`,
      date: r.detail.date,
      kind: 'liquidity',
      weight: r.detail.weight,
      halfLifeDays: 365,
      source: EVENTS_SOURCES.rate,
      note: r.detail.note,
    });
  }

  if (c.detail) {
    events.push({
      id: `auto:crash-${c.detail.date}`,
      date: c.detail.date,
      kind: c.detail.kind,
      weight: c.detail.weight,
      halfLifeDays: 60,
      source: EVENTS_SOURCES.crash,
      note: c.detail.note,
    });
  }

  return {
    events,
    sources: [
      { key: 'halving', ok: !h.error, error: h.error, got: h.detail ? 1 : 0 },
      { key: 'fomc', ok: !f.error, error: f.error, got: (f.detail || []).length },
      { key: 'rate', ok: !r.error, error: r.error, got: r.detail ? 1 : 0 },
      { key: 'crash', ok: !c.error, error: c.error, got: c.detail ? 1 : 0 },
    ],
  };
}
