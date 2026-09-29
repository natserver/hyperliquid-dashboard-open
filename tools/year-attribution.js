/**
 * 一年真实成交 · 比特皇规则归因分析
 *
 * 目的：不评价你赚了多少，而是回答一个更具体的问题 ——
 *       「比特皇那几条开单规则，在你的真实成交上到底放行了什么、拦下了什么？」
 *
 * 做法：
 *   1. 向前翻页取回区间内全部成交（带磁盘缓存，重复跑不重打接口）
 *   2. 按持仓链归集成「交易」（复用 src/metrics.js 的 buildTrades）
 *   3. 对每笔交易的**开仓时刻**，用当时已收盘的 K 线重放规则：
 *        · 趋势门槛 —— 三次有效突破 + 站稳中轨，方向是否与实际开仓一致
 *        · 空间门槛 —— 区间等幅投影是否够本相位的地板
 *        · 仓位门槛 —— 规则建议的止损距离与风险预算
 *   4. 按「规则放行 / 规则会拦截」分桶，对比真实盈亏
 *   5. 反事实：只做规则完全放行的交易，权益曲线会是什么样
 *
 * ⚠️ 无前视：重放只用 openTime 之前**已收盘**的 K 线。
 *
 * 用法：
 *   node tools/year-attribution.js <地址> [--days=365] [--interval=4h] [--coins=10]
 *   node tools/year-attribution.js --demo        # 从排行榜自动挑一个长历史地址
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  NETWORKS,
  fetchFillsRange,
  getNetwork,
  info,
  metaAndAssetCtxs,
  normalizeAddress,
  portfolio,
} from '../src/hl.js';
import { buildTrades, extractEquityCurve, netDeposits, summarizePerformance } from '../src/metrics.js';
import { closesOf, computeLevels } from '../src/levels.js';
import {
  BPS,
  CYCLE_PHASES,
  EXPECTED_MOVE_HARD_FLOOR_BPS,
  PHASE_LABELS,
  WAD,
  defaultConfig,
  defaultTiers,
  fmtBps,
  fmtUsd,
  parseWad,
  phaseFloorBps,
  wadToNumber,
} from '../src/strategy.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const CACHE = path.join(ROOT, '.cache');
const OUTDIR = path.join(ROOT, 'report');

const DAY = 86400000;
const INTERVAL_MS = { '1h': 3600000, '4h': 14400000, '1d': DAY };

/**
 * 「距布林中轨的原始距离」超过这个值就认为是数据缺陷，不当成一个止损距离来看。
 *
 * 100% 是个物理上就很松的界：止损距离到了价格的一倍，这个「止损」没有任何意义
 * （价格不可能跌 100% 还在场内）。真正的推荐止损有 12% 硬上限约束，
 * 所以任何超过 100% 的值都说明参考位离价格极远 —— 要么 K 线脏，要么取错了字段。
 */
const RAW_STOP_SANE_BPS = 10000;

/**
 * 「可得空间」（区间等幅量出投影）的两个警戒线。
 *
 * 100%（10000 bps）就已经很松了 —— 相位地板最严的一档才 35%，所以 100% 意味着
 * 门槛在它面前没有约束力。1000% 基本可以确定是回看窗口里塞进了一段新上币的极端行情：
 * 区间幅度被撑开，投影自然跟着放大。这类样本必须点名，否则「门槛筛掉了坏的」这种
 * 结论会有一部分是假象 —— 实际是「门槛根本没筛」。
 */
const RAW_MOVE_WARN_BPS = 10000;
const RAW_MOVE_ABSURD_BPS = 100000;

/**
 * 「结论闸门」的门槛。命中任意一条就不允许输出「规则有效」的正向判定。
 *
 * 这里的原则是：**结论的可信度不能高于得出它的数据**。
 * 报告开头已经把「周期错配」「数据缺陷」写成了前置 caveat，
 * 如果结尾还喊「规则有效」，报告就自相矛盾了 —— 读者会只记住最后那句。
 * 所以把削弱结论的条件全部收集起来，逐条列出来，让读者自己判断。
 *
 * · MIN_KEPT_FOR_VERDICT：放行组样本下限。盈亏是重尾分布，30 笔上算出来的
 *   均值换个样本就可能翻符号（本账户就是：均值几乎由 1~2 笔巨亏决定）。
 *   50 笔不是统计学的严格门槛，只是一个「至少别用个位数样本下结论」的底线。
 * · MIN_COVERAGE_FOR_VERDICT：规则重放覆盖率下限。覆盖率低意味着结论只代表
 *   一部分标的（且缺失的往往正是新上市、数据最脏的那批），不能推广到全部成交。
 */
const MIN_KEPT_FOR_VERDICT = 50;
const MIN_COVERAGE_FOR_VERDICT = 0.7;

/* ───────────────────────── 小工具 ───────────────────────── */

const ts = (t) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 16) : '—');
const day = (t) => (t ? new Date(t).toISOString().slice(0, 10) : '—');
const pct = (x, dp = 2) => `${(x * 100).toFixed(dp)}%`;
const bpsToPct = (b) => `${(Number(b) / 100).toFixed(2)}%`;
const usd = (wad) => fmtUsd(wad);
const num = (wad) => wadToNumber(wad);

function percentile(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
}

function stats(xs) {
  if (!xs.length) return { n: 0 };
  const sum = xs.reduce((a, b) => a + b, 0);
  return {
    n: xs.length,
    sum,
    mean: sum / xs.length,
    median: percentile(xs, 0.5),
    p25: percentile(xs, 0.25),
    p75: percentile(xs, 0.75),
    min: Math.min(...xs),
    max: Math.max(...xs),
  };
}

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  if (process.argv.includes(`--${name}`)) return true;
  return dflt;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureDir(d) {
  await fsp.mkdir(d, { recursive: true });
}

/* ───────────────────────── 带磁盘缓存的取数 ───────────────────────── */

/**
 * 缓存文件名安全化。
 *
 * ⚠️ 踩过的坑：Hyperliquid 有带冒号的标的（`xyz:XYZ100`、`flx:OIL`）。
 *    直接把标的塞进文件名，在 Windows 上 `:` 是非法字符 —— 文件会变成一个
 *    被截断的 0 字节文件，缓存静默失效（甚至写到 NTFS 备用数据流里）。
 */
const safeKey = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');

/**
 * 带磁盘缓存。重复跑同一地址不会重打接口。
 *
 * ⚠️ 另一个必须防住的坑：空结果不能落盘。取数失败（网络抖动、地址选错、区间选错）
 *    也会产生「空数组」，一旦写进缓存，后续每次运行都会读到这个空结果，
 *    表现为「这个账户没成交」——而实际上只是第一次取失败了。所以：
 *      · 读缓存时，空结果视为未命中
 *      · 写缓存时，空结果不落盘
 */
async function cached(key, fn, opts = {}) {
  await ensureDir(CACHE);
  const f = path.join(CACHE, `${safeKey(key)}.json`);
  const isEmpty = opts.isEmpty || ((v) => v == null);
  if (fs.existsSync(f)) {
    try {
      const j = JSON.parse(await fsp.readFile(f, 'utf8'));
      if (!isEmpty(j.value)) return { ...j.value, _cached: true, _at: j.at };
      await fsp.unlink(f); // 缓存里是空结果，丢掉重取
    } catch {
      /* 缓存损坏则重取 */
    }
  }
  const value = await fn();
  if (isEmpty(value)) return { ...value, _cached: false, _at: Date.now() };
  await fsp.writeFile(f, JSON.stringify({ at: Date.now(), value }), 'utf8');
  return { ...value, _cached: false, _at: Date.now() };
}

/** 缓存里全是 BigInt，JSON.stringify 默认会抛错 */
const jsonSafe = (_k, v) => (typeof v === 'bigint' ? v.toString() : v);

/**
 * funding / ledger 都是「返回区间内最早的 N 条」（实测：funding 每页 500）。
 * 所以同样要向前翻页。
 *
 * ⚠️ 去重键不能用 `hash`：实测 funding 记录的 `hash` **全部是 0x0000…0000**，
 *    用它去重会把 61 条真实记录折叠成 1 条（这个坑真的踩到了，表现是
 *    「一年只有 1 条资金费」）。必须用 时间 + 类型 + 标的 + 金额 组合去重。
 */
async function pagedByTime(net, user, type, from, to, pageSize = 500, maxPages = 60) {
  const all = [];
  let cursor = from;
  for (let p = 0; p < maxPages; p++) {
    const batch = await info(
      net,
      { type, user, startTime: cursor },
      { noCache: true, ttl: 0, timeout: 30000 }
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    const hi = Math.max(...batch.map((x) => x.time));
    if (batch.length < pageSize) break;
    if (hi < cursor) break;
    cursor = hi + 1;
  }
  const seen = new Set();
  const out = [];
  for (const x of all) {
    const k = [
      x.time,
      x.delta?.type || '',
      x.delta?.coin || '',
      x.delta?.usdc || x.delta?.amount || '',
      x.delta?.nSamples ?? '',
    ].join('|');
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  out.sort((a, b) => a.time - b.time);
  return out.filter((x) => x.time >= from && x.time <= to);
}

/**
 * 按时间取「当时的账户权益」。
 *
 * ⚠️ 历史归因不能用**今天的权益**去算仓位 —— 账户可能已经提空（实测某账户
 *    当前权益为 0，直接导致所有 R 倍数算不出来）。也不该直接取曲线在 t 时刻的值，
 *    因为权益曲线里夹杂大量 0 值快照（实测 95 个点里 43 个非零）。
 *    正确做法：取 t 之前**最近的非零**权益；找不到就用最早的非零点。
 */
function buildEquityLookup(curve) {
  const pts = curve?.primary?.equity;
  if (!Array.isArray(pts) || !pts.length) return null;
  const nonZero = [...pts].sort((a, b) => a.t - b.t).filter((p) => p.v > 0n);
  if (!nonZero.length) return null;
  return (t) => {
    let best = null;
    for (const p of nonZero) {
      if (p.t <= t) best = p;
      else break;
    }
    return best ?? nonZero[0];
  };
}

/** K 线：单次最多 5000 根，超了就分段拉 */
async function fetchCandles(net, coin, interval, from, to) {
  const iv = INTERVAL_MS[interval] ?? INTERVAL_MS['4h'];
  const maxBars = 4800;
  const span = maxBars * iv;
  const out = [];
  let cursor = from;
  while (cursor < to) {
    const end = Math.min(cursor + span, to);
    const batch = await info(
      net,
      { type: 'candleSnapshot', req: { coin, interval, startTime: cursor, endTime: end } },
      { noCache: true, ttl: 0, timeout: 30000 }
    );
    if (Array.isArray(batch) && batch.length) out.push(...batch);
    cursor = end + 1;
    if (out.length > 20000) break;
  }
  const seen = new Set();
  const dedup = [];
  for (const c of out) {
    const k = c.t ?? c.T;
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(c);
  }
  dedup.sort((a, b) => (a.t ?? a.T) - (b.t ?? b.T));
  return dedup;
}

/* ───────────────────────── 趋势/门槛重放 ───────────────────────── */

/** 只取 openTime 之前**已收盘**的 K 线，避免前视 */
function closesBefore(candles, t, intervalMs) {
  const n = candles.length;
  let end = -1;
  for (let i = 0; i < n; i++) {
    const open = candles[i].t ?? candles[i].T;
    if (open + intervalMs <= t) end = i;
    else break;
  }
  if (end < 0) return [];
  const from = Math.max(0, end - 400); // 400 根足够了（趋势回看 48 根 + 布林 20）
  return closesOf(candles.slice(from, end + 1));
}

/**
 * 开仓时刻**之前已收盘**的 K 线对象（不只是收盘价）。
 *
 * ⚠️ 为什么必须有这个函数，而不是图省事把整段 candles 传进 computeLevels：
 *
 * 这是一次实测踩出来的。早期版本把「完整一年」的 K 线直接喂给 computeLevels，
 * 于是布林带、趋势读数、入场计划全部用上了**开仓之后**的数据，
 * 而报告头部却写着「无前视」。代价很具体 —— 同一笔 XPL 交易：
 *
 *   传全量（2352 根，到今天）：中轨 0.0831 · 止损距离 1444% · 趋势「连续 3 次突破站稳」
 *   只传已收盘（207 根）：      中轨 0.8005 · 止损距离 60%   · 趋势「未确认」
 *
 * 结果就是：一笔当时**趋势根本没确认**的交易，被算成「规则放行」，
 * 进了「趋势同向」那个桶。整个反事实结论建立在这种错分之上，等于无效。
 *
 * 无前视在这里是硬要求：重放的意义就是「只用当时能看到的信息」。
 * 放宽一格（哪怕只多一根未收盘的 bar）都会让规则显得比实际更强。
 */
function barsBefore(candles, t, intervalMs) {
  const n = candles.length;
  let end = -1;
  for (let i = 0; i < n; i++) {
    const open = candles[i].t ?? candles[i].T;
    if (open + intervalMs <= t) end = i;
    else break;
  }
  if (end < 0) return [];
  const from = Math.max(0, end - 400);
  return candles.slice(from, end + 1);
}

/** 持仓期间的极值（用于 MAE / MFE） */
function excursions(candles, from, to, isLong, entryPx) {
  let mfe = null;
  let mae = null;
  let hiPx = null;
  let loPx = null;
  for (const c of candles) {
    const open = c.t ?? c.T;
    if (open + INTERVAL_MS['4h'] < from || open > to) continue;
    const hi = parseWad(c.h);
    const lo = parseWad(c.l);
    if (hiPx === null || hi > hiPx) hiPx = hi;
    if (loPx === null || lo < loPx) loPx = lo;
  }
  if (hiPx === null || entryPx === null || entryPx === 0n) return { mfe: null, mae: null, hiPx, loPx };
  const favPx = isLong ? hiPx : loPx;
  const advPx = isLong ? loPx : hiPx;
  const dBps = (a, b) => Number(((a > b ? a - b : b - a) * BPS) / (b === 0n ? 1n : b));
  mfe = dBps(favPx, entryPx);
  mae = dBps(advPx, entryPx);
  return { mfe, mae, hiPx, loPx };
}

/* ───────────────────────── HTML 报告 ───────────────────────── */

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 反事实累计盈亏曲线（手绘 SVG，与本项目其他图表同一风格） */
function curveSvg(series, opts = {}) {
  const w = opts.w ?? 920;
  const h = opts.h ?? 340;
  const pad = { l: 72, r: 24, t: 16, b: 36 };
  const all = series.flatMap((s) => s.pts);
  if (!all.length) return '<p class="muted">无可绘制的交易。</p>';

  const t0 = Math.min(...all.map((p) => p.t));
  const t1 = Math.max(...all.map((p) => p.t));
  let v0 = Math.min(0, ...all.map((p) => p.cum));
  let v1 = Math.max(0, ...all.map((p) => p.cum));
  if (v1 === v0) v1 = v0 + 1;

  const X = (t) => pad.l + ((t - t0) / (t1 - t0 || 1)) * (w - pad.l - pad.r);
  const Y = (v) => pad.t + (1 - (v - v0) / (v1 - v0)) * (h - pad.t - pad.b);

  // y 轴刻度
  const ticks = 5;
  let grid = '';
  for (let i = 0; i <= ticks; i++) {
    const v = v0 + ((v1 - v0) * i) / ticks;
    const y = Y(v);
    const isZero = Math.abs(v) < (v1 - v0) / (ticks * 2.2);
    grid += `<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${w - pad.r}" y2="${y.toFixed(1)}" stroke="${isZero ? '#B4B2A9' : '#EAE8E1'}" stroke-width="${isZero ? 1 : 0.5}"/>`;
    grid += `<text x="${pad.l - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" font-size="11" fill="#5F5E5A">${v.toFixed(0)}</text>`;
  }

  // x 轴日期
  let xlabels = '';
  for (let i = 0; i <= 4; i++) {
    const t = t0 + ((t1 - t0) * i) / 4;
    xlabels += `<text x="${X(t).toFixed(1)}" y="${h - 12}" text-anchor="middle" font-size="11" fill="#5F5E5A">${new Date(t).toISOString().slice(0, 7)}</text>`;
  }

  const lines = series
    .map((s) => {
      if (!s.pts.length) return '';
      const d = s.pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)} ${Y(p.cum).toFixed(1)}`).join(' ');
      return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="1.8" stroke-linejoin="round"/>`;
    })
    .join('');

  const legend = series
    .map(
      (s, i) =>
        `<g transform="translate(${pad.l + i * 210},${h - 2})">` +
        `<line x1="0" y1="-4" x2="18" y2="-4" stroke="${s.color}" stroke-width="2.5"/>` +
        `<text x="24" y="0" font-size="11" fill="#2C2C2A">${esc(s.label)}（${s.n} 笔）</text></g>`
    )
    .join('');

  return `<svg viewBox="0 0 ${w} ${h + 26}" width="100%" role="img">
<title>反事实累计盈亏对比</title>
<rect x="0" y="0" width="${w}" height="${h + 26}" fill="#FFFFFF"/>
${grid}${xlabels}${lines}${legend}
</svg>`;
}

function renderHtml(ctx) {
  const { addr, netKey, days, reachedDays, realOldest, fills, tradesAll, closed, rows, coins, coverage,
    buckets, gateRows, stopDiscipline, scenarios, perf, equityNow, interval, span,
    fundingFlat, deposits, replayedNet, ledgerCount, ddNote, verdict } = ctx;

  const nm = (x) => `${x < 0 ? '−' : ''}${Math.abs(x).toFixed(0)}`;
  // 结论闸门的结果由 main 算好（唯一的判定来源），这里只负责渲染。
  const vr = verdict ?? { ok: true, blockers: [] };
  // 闸门里的理由是用 Markdown 写的（MD 与 HTML 共用同一份文本），
  // 渲染成 HTML 时把 **粗体** 转成 <b>，其余按文本转义。
  const mdInline = (s) => esc(String(s)).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  // 「已实现净额」不含资金费，而资金费那一格就排在旁边 —— 两个口径都显示，避免读者自己加错。
  const netIncl = ctx.netInclFunding ?? (num(perf.realizedNet) + num(perf.fundingNet));
  const c0 = scenarios[0];
  const c2 = scenarios.find((s) => s.key === 'trendHard');
  const dNet = c2.net - c0.net;
  const keptMedian = c2.median;
  const dropMedian = c2.dropMedian;
  const dropMeanExWorst = c2.dropMeanExWorst;
  const edgeSurvivesOutlier = c2.edgeSurvivesOutlier;
  const worstNet = c0.list.reduce((m, r) => Math.min(m, r.pnlNum), 0);
  // 「选择效应 vs 敞口效应」的拆分在 scenarios 构建时算好，这里只取用（见那边的注释）
  const keptMean = c2.mean;
  const dropN = c2.dropN;
  const dropMean = c2.dropMean;
  const hasSelectionEdge = c2.hasSelectionEdge;
  const bucketRows = ['all', 'aligned', 'against', 'unconfirmed']
    .map((k) => {
      const b = buckets[k];
      const pf = b.profitFactor === Infinity ? '∞' : b.profitFactor.toFixed(2);
      const cls = b.net > 0 ? 'up' : b.net < 0 ? 'down' : '';
      return `<tr><td>${esc(b.label)}</td><td class="n">${b.n}</td><td class="n ${cls}">${nm(b.net)}</td>` +
        `<td class="n">${(b.winRate * 100).toFixed(1)}%</td><td class="n">${pf}</td><td class="n">${nm(b.avg)}</td>` +
        `<td class="n">${b.rMean == null ? '—' : b.rMean.toFixed(2)}</td></tr>`;
    })
    .join('');

  const gateRowsHtml = gateRows
    .map(
      (g) =>
        `<tr><td>${esc(g.label)}</td><td class="n">${g.floorPct.toFixed(0)}%</td>` +
        `<td class="n">${g.fullPassCount} / ${rows.length}</td><td class="n">${(g.passRate * 100).toFixed(1)}%</td>` +
        `<td class="n ${g.fullPassPnl > 0 ? 'up' : g.fullPassPnl < 0 ? 'down' : ''}">${nm(g.fullPassPnl)}</td>` +
        `<td class="n ${g.blockedPnl > 0 ? 'up' : g.blockedPnl < 0 ? 'down' : ''}">${nm(g.blockedPnl)}</td></tr>`
    )
    .join('');

  const scenRows = scenarios
    .map(
      (s) =>
        `<tr><td><span class="dot" style="background:${s.color}"></span>${esc(s.label)}</td>` +
        `<td class="n">${s.n}</td><td class="n ${s.net > 0 ? 'up' : s.net < 0 ? 'down' : ''}">${nm(s.net)}</td>` +
        `<td class="n">${nm(s.avg)}</td><td class="n">${(s.winRate * 100).toFixed(1)}%</td><td class="n">${s.maxDd.toFixed(0)}</td></tr>`
    )
    .join('');

  const topRows = [...rows]
    .sort((a, b) => Math.abs(b.pnlNum) - Math.abs(a.pnlNum))
    .slice(0, 60)
    .map((r) => {
      const trendTxt = r.trendDirection === 1 ? '多' : r.trendDirection === -1 ? '空' : '未确认';
      const match = r.trendConfirmed ? (r.directionMatch ? '✓' : '✗') : '—';
      return `<tr><td>${esc(r.coin)}</td><td>${r.isLong ? '多' : '空'}</td>` +
        `<td>${day(r.openTime)}</td><td>${day(r.closeTime)}</td><td class="n">${(r.holdMs / 3600000).toFixed(1)}</td>` +
        `<td class="n ${r.pnlNum > 0 ? 'up' : r.pnlNum < 0 ? 'down' : ''}">${r.pnlNum.toFixed(1)}</td>` +
        `<td>${trendTxt}</td><td style="text-align:center">${match}</td>` +
        `<td class="n">${(r.projectedMoveBps / 100).toFixed(1)}%</td>` +
        `<td class="n">${r.stopDistanceBps == null ? '—' : (r.stopDistanceBps / 100).toFixed(2) + '%'}</td>` +
        `<td class="n">${r.maeBps == null ? '—' : (r.maeBps / 100).toFixed(2) + '%'}</td>` +
        `<td class="n">${r.rMultiple == null ? '—' : r.rMultiple.toFixed(2)}</td></tr>`;
    })
    .join('');

  const warn = reachedDays < days - 3
    ? `<div class="warn"><b>未取满 ${days} 天。</b>服务端对成交历史的保留按<b>笔数</b>封顶而非按时间封顶
       （实测：几千笔的个人账户可回溯 300~1170 天，每小时近万笔的做市账户只能回溯 1~2 小时）。
       该账户可回溯深度已到边界，本报告基于实际取到的 <b>${reachedDays.toFixed(1)} 天</b>。</div>`
    : '';

  // 结论闸门没通过时，在**正文最前面**就把这件事说出来。
  // 只放在结尾等于没说 —— 读者会先看完所有数字、并被「+1386 USDC」抓住，
  // 再看到结论就来不及了。
  const gateWarn = vr.ok
    ? ''
    : `<div class="warn"><b>⚠️ 本报告的结论未通过实证闸门 —— 读下面的数字前请先看这里。</b>
       命中 ${vr.blockers.length} 条削弱条件（详见结尾「结论」）：
       <ol style="margin:7px 0 0 20px;padding:0">${vr.blockers
         .map((b) => `<li style="margin-bottom:4px">${mdInline(b)}</li>`)
         .join('')}</ol>
       <div style="margin-top:8px">所以下面所有「改善 / 贡献」的数字，只能当<b>数据探索</b>，不能当规则有效性的证据。</div></div>`;

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>比特皇规则归因 · ${addr.slice(0, 10)}…</title>
<style>
:root{--bg:#FBFAF7;--card:#FFF;--line:#E5E2DA;--txt:#1F1E1C;--sub:#6B6862;--up:#C0392B;--down:#1E8449}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.65 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.wrap{max-width:1080px;margin:0 auto;padding:32px 24px 72px}
h1{font-size:23px;font-weight:600;margin:0 0 6px}
h2{font-size:17px;font-weight:600;margin:38px 0 10px;padding-bottom:7px;border-bottom:1px solid var(--line)}
h3{font-size:14px;font-weight:600;margin:22px 0 8px}
.meta{color:var(--sub);font-size:13px;line-height:1.9}
.meta code{background:#F1EFE8;padding:1px 6px;border-radius:4px;font-size:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin:14px 0}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:16px 0}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:13px 15px}
.kpi .k{color:var(--sub);font-size:12px;margin-bottom:5px}
.kpi .v{font-size:19px;font-weight:600;font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse;font-size:13px;margin:8px 0}
th,td{padding:7px 9px;border-bottom:1px solid var(--line);text-align:left}
th{color:var(--sub);font-weight:600;font-size:12px;background:#F7F5F1}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.up{color:var(--up)}.down{color:var(--down)}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px;vertical-align:middle}
.warn{background:#FAEEDA;border:1px solid #EF9F27;border-radius:10px;padding:13px 16px;margin:14px 0;font-size:13px;line-height:1.75}
.note{color:var(--sub);font-size:12.5px;line-height:1.8;margin:8px 0 0}
.verdict{background:#EEEDFE;border:1px solid #7F77DD;border-radius:10px;padding:16px 18px;margin:14px 0}
.verdict b{font-size:15px}
.muted{color:var(--sub)}
.scroll{overflow-x:auto}
</style></head><body><div class="wrap">

<h1>比特皇规则归因 · 一年真实成交</h1>
<div class="meta">
地址 <code>${esc(addr)}</code>　·　${esc(netKey)}<br>
分析区间 ${day(span.from)} → ${day(span.to)}（目标 ${days} 天）　·　
<b>实际覆盖 ${day(realOldest)} → ${day(span.to)} = ${reachedDays.toFixed(1)} 天</b><br>
K 线周期 ${esc(interval)}　·　重放标的 ${coins.length} 个（占成交 ${(coverage * 100).toFixed(1)}%）
　·　<b>实际可重放 ${rows.length} / ${tradesAll.length} 笔（${((rows.length / (tradesAll.length || 1)) * 100).toFixed(1)}%）</b>
　·　生成于 ${new Date().toISOString().replace('T', ' ').slice(0, 19)}
</div>
${warn}
${gateWarn}

<h2>账户总览</h2>
<p class="note">这里有两把<b>不同</b>的尺子：<b>口径A</b>（全账户·按平仓成交归集，永远成立但会把一次持仓的加减仓拆开）
与<b>口径B</b>（被重放子集·按完整持仓周期归集，更贴近直觉但只覆盖重放到的标的）。
下面的反事实对比用的是口径B，基线 ${replayedNet.toFixed(0)} USDC。</p>
<div class="kpis">
<div class="kpi"><div class="k">成交笔数</div><div class="v">${fills.length}</div></div>
<div class="kpi"><div class="k">交易笔数</div><div class="v">${tradesAll.length}</div></div>
<div class="kpi"><div class="k">已实现净额<br><span class="muted" style="font-size:11px">不含资金费（口径A）</span></div><div class="v ${perf.realizedNet > 0 ? 'up' : 'down'}">${num(perf.realizedNet).toFixed(0)}</div></div>
<div class="kpi"><div class="k">含资金费总净额<br><span class="muted" style="font-size:11px">另加资金费 ${nm(num(perf.fundingNet))}</span></div><div class="v ${netIncl > 0 ? 'up' : 'down'}">${nm(netIncl)}</div></div>
<div class="kpi"><div class="k">手续费</div><div class="v down">−${num(perf.fees).toFixed(0)}</div></div>
<div class="kpi"><div class="k">资金费净额<br><span class="muted" style="font-size:11px">${fundingFlat.length} 条</span></div><div class="v ${perf.fundingNet > 0 ? 'up' : 'down'}">${num(perf.fundingNet).toFixed(0)}</div></div>
<div class="kpi"><div class="k">出入金净额<br><span class="muted" style="font-size:11px">${ledgerCount} 条</span></div><div class="v">${num(deposits.net).toFixed(0)}</div></div>
<div class="kpi"><div class="k">平仓胜率（A）</div><div class="v">${((perf.closing?.winRate ?? 0) * 100).toFixed(1)}%</div></div>
<div class="kpi"><div class="k">重放子集净额（B）</div><div class="v ${replayedNet > 0 ? 'up' : 'down'}">${replayedNet.toFixed(0)}</div></div>
</div>
${ddNote ? `<p class="note">${esc(ddNote)}</p>` : ''}

<h2>反事实对比 —— 只做规则放行的交易会怎样</h2>
<div class="card">${curveSvg(scenarios)}</div>
<div class="scroll"><table>
<thead><tr><th>组合</th><th class="n">笔数</th><th class="n">净盈亏</th><th class="n">每笔均值</th><th class="n">胜率</th><th class="n">累计盈亏最大回撤</th></tr></thead>
<tbody>${scenRows}</tbody></table></div>
<div class="verdict">
<b>${vr.ok
      ? (hasSelectionEdge ? '规则净贡献' : '净额差（但未见选择效应）')
      : '⚠️ 结论未通过实证闸门'}：${dNet >= 0 ? '+' : '−'}${Math.abs(dNet).toFixed(0)} USDC</b><br>
<span style="font-size:13px">同一年的成交，把规则会放行的挑出来、剔除其余，
累计盈亏 ${c0.net.toFixed(0)} → ${c2.net.toFixed(0)}；最大回撤 ${c0.maxDd.toFixed(0)} → ${c2.maxDd.toFixed(0)}。</span><br><br>
<table style="margin:0;font-size:13px"><thead><tr><th>组合</th><th class="n">笔数</th><th class="n">净盈亏</th><th class="n">每笔均值</th><th class="n">每笔中位</th></tr></thead>
<tbody>
<tr><td>规则放行（留下）</td><td class="n">${c2.n}</td><td class="n">${c2.net.toFixed(0)}</td><td class="n">${keptMean.toFixed(2)}</td><td class="n">${keptMedian.toFixed(2)}</td></tr>
<tr><td>规则拦截（剔除）</td><td class="n">${dropN}</td><td class="n">${(c0.net - c2.net).toFixed(0)}</td><td class="n">${dropMean.toFixed(2)}</td><td class="n">${dropMedian.toFixed(2)}</td></tr>
</tbody></table>
<span style="font-size:13px"><b>离群点敏感性</b>：被剔除组去掉最惨的一笔（${worstNet.toFixed(0)} USDC）后，
每笔均值 ${dropMean.toFixed(2)} → ${dropMeanExWorst.toFixed(2)}；
放行组（${keptMean.toFixed(2)}）到这一步${edgeSurvivesOutlier ? '<b>仍然占优</b>' : '<b>已经不占优</b>'}。
这一步问的是：这个「优势」是真选出了好交易，还是仅仅少踩了一个坑。</span><br><br>
<span style="font-size:13px">${
    hasSelectionEdge
      ? '放行组每笔均值优于被剔除组 → 存在<b>选择效应</b>（选得准），不只是做得少。'
      : '⚠️ 放行组每笔均值<b>并不优于</b>被剔除组 → 改善只来自<b>敞口效应</b>（做得少），' +
        '任何减少笔数的筛子都能做到，<b>不能</b>据此说规则有效。'
  }</span>
${vr.ok
      ? ''
      : `<div style="margin-top:14px;border-top:1px dashed #7F77DD;padding-top:12px">
<b>判定：规则在这个样本上没有被证明有效。</b>
<div class="note" style="margin-top:6px">命中 ${vr.blockers.length} 条削弱条件：</div>
<ol style="margin:6px 0 0 20px;padding:0;font-size:13px;line-height:1.75">
${vr.blockers.map((b) => `<li style="margin-bottom:5px">${mdInline(b)}</li>`).join('')}
</ol>
<div class="note" style="margin-top:9px">⚠️ 这不等于「规则是错的」，只说明这一年、这个账户、这批数据不足以证明它对。
要让判定有意义，需要换一个<b>持仓周期与规则口径匹配</b>的账户（持仓数天而不是十几分钟）来做同样的重放。</div>
</div>`}
</div>
<p class="note">⚠️ 反事实只做<b>盈亏线性累加</b>，没有重算复利与保证金约束 ——
它衡量的是这批交易的盈亏质量，不是精确的组合收益。</p>

<h2>趋势门槛归因</h2>
<p class="note">按「开仓时刻」的 K 线状态分桶（只用已收盘 K 线重放，无前视）。
比特皇的开单条件：连续三次有效突破轨道 <b>且</b> 站稳中轨。</p>
<div class="scroll"><table>
<thead><tr><th>分桶</th><th class="n">笔数</th><th class="n">净盈亏</th><th class="n">胜率</th><th class="n">盈亏比</th><th class="n">均值</th><th class="n">平均 R</th></tr></thead>
<tbody>${bucketRows}</tbody></table></div>

<h2>空间门槛归因</h2>
<p class="note">门槛判的是「K 线自己量出的区间等幅投影」，不是外部声明的目标价
（这条在链上合约里修过一个漏洞：keeper 把目标价填成入场价 10 倍即可绕过）。
历史各时点的周期相位无法精确还原，故给出四档相位下的反事实。</p>
<div class="scroll"><table>
<thead><tr><th>相位</th><th class="n">地板</th><th class="n">完全放行</th><th class="n">放行率</th><th class="n">放行组净盈亏</th><th class="n">被拦组净盈亏</th></tr></thead>
<tbody>${gateRowsHtml}</tbody></table></div>

<h2>止损纪律</h2>
<div class="kpis">
<div class="kpi"><div class="k">可评估</div><div class="v">${stopDiscipline.n}</div></div>
<div class="kpi"><div class="k">推荐止损距（中位）</div><div class="v">${((stopDiscipline.stopMed ?? 0) / 100).toFixed(2)}%</div></div>
<div class="kpi"><div class="k">实际最大不利偏移（中位）</div><div class="v">${((stopDiscipline.maeMed ?? 0) / 100).toFixed(2)}%</div></div>
<div class="kpi"><div class="k">超出规则止损位</div><div class="v">${stopDiscipline.overCount}（${(stopDiscipline.overRate * 100).toFixed(1)}%）</div></div>
<div class="kpi"><div class="k">超出部分合计</div><div class="v down">${nm(stopDiscipline.overPnl)}</div></div>
</div>
<p class="note">「最大不利偏移」取持仓期间 K 线的极端价 —— 它衡量的是<b>有没有让亏损跑过头</b>，
与最终盈亏无关。超出比例高，说明止损执行与规则脱节，这是纪律问题而非策略问题。</p>

<h2>逐笔明细（按盈亏绝对值排序，前 ${Math.min(60, rows.length)} 笔）</h2>
<div class="scroll"><table>
<thead><tr><th>标的</th><th>方向</th><th>开仓</th><th>平仓</th><th class="n">持仓h</th><th class="n">净盈亏</th>
<th>开仓时趋势</th><th style="text-align:center">同向</th><th class="n">投影空间</th><th class="n">推荐止损距</th><th class="n">MAE</th><th class="n">R</th></tr></thead>
<tbody>${topRows}</tbody></table></div>

<p class="note" style="margin-top:34px">
本报告只读生成，全程不涉及任何下单或密钥。规则重放使用与链上合约同源的 BigInt 策略数学。<br>
盈亏颜色遵循中国习惯：<span class="up">红=盈利</span>、<span class="down">绿=亏损</span>。
</p>
</div></body></html>`;
}

/**
 * 从排行榜挑一个适合做演示的地址。
 *
 * 踩过的坑：只检查「startTime=0 有没有成交」会挑到**已经停止交易的老账户** ——
 * 它们的历史很深，但近一年没有任何成交，报告会是空的。
 * 所以必须同时满足：近期还在交易 + 一年窗口内样本量够。
 */
async function pickDemoAddress(days) {
  const url = 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard';
  const r = await fetch(url, { signal: AbortSignal.timeout(45000) });
  const j = await r.json();
  const rows = j?.leaderboardRows || j?.rows || (Array.isArray(j) ? j : []);
  const addrs = rows
    .map((x) => (x.ethAddress || x.address || '').toLowerCase())
    .filter((a) => /^0x[0-9a-f]{40}$/.test(a));

  const now = Date.now();
  const windowFrom = now - days * DAY;
  // 从中后段起找：成交量小的账户历史保留得更深
  const cands = addrs.slice(Math.floor(addrs.length * 0.5));
  let best = null;

  for (const a of cands.slice(0, 80)) {
    try {
      // ① 必须近期还活跃（userFills 给的是最新成交）
      const recent = await info('mainnet', { type: 'userFills', user: a }, { noCache: true });
      if (!Array.isArray(recent) || recent.length < 50) { await sleep(90); continue; }
      const newest = Math.max(...recent.map((f) => f.time));
      if (now - newest > 45 * DAY) { await sleep(90); continue; } // 停更超过 45 天，跳过

      // ② 目标窗口内样本量要够
      const yr = await info(
        'mainnet',
        { type: 'userFillsByTime', user: a, startTime: windowFrom, endTime: now },
        { noCache: true }
      );
      const n = Array.isArray(yr) ? yr.length : 0;
      if (n >= 200 && (!best || n > best.n)) {
        best = { addr: a, n };
        if (n >= 1500) break; // 够用了，不用继续扫
      }
    } catch {
      /* 换下一个候选 */
    }
    await sleep(90);
  }
  if (!best) throw new Error('没能从排行榜找到「近期活跃 + 样本充足」的地址');
  console.log(`[demo] 候选在目标窗口内成交 ${best.n} 笔`);
  return best.addr;
}

async function main() {
  const argvAddr = process.argv[2];
  const useDemo = arg('demo', false) === true || argvAddr === '--demo';
  const days = Number(arg('days', 365));
  const interval = String(arg('interval', '4h'));
  const maxCoins = Number(arg('coins', 15));
  const netKey = String(arg('network', 'mainnet'));

  let addr;
  if (useDemo) {
    console.log('[demo] 正在从排行榜挑选一个长历史地址…');
    addr = await pickDemoAddress(days);
    console.log('[demo] 选中 ' + addr);
  } else {
    addr = normalizeAddress(argvAddr);
  }

  const net = getNetwork(netKey);
  const ivMs = INTERVAL_MS[interval] ?? INTERVAL_MS['4h'];
  const now = Date.now();
  const from = now - days * DAY;

  console.log('='.repeat(78));
  console.log(`比特皇规则归因 · 一年真实成交`);
  console.log(`地址 ${addr}`);
  console.log(`网络 ${net.label}   区间 ${day(from)} → ${day(now)}（${days} 天）   K 线 ${interval}`);
  console.log('='.repeat(78));

  /* ── 1. 取数 ── */
  console.log('\n[1] 取数');

  const t0 = Date.now();
  const fillsRes = await cached(
    `fills-${netKey}-${addr}-${days}d`,
    async () => {
      const r = await fetchFillsRange(netKey, addr, { from, to: now, maxFills: 60000, maxPages: 40 });
      return { fills: r.fills, pages: r.pages, exhausted: r.exhausted, oldest: r.oldest, newest: r.newest };
    },
    { isEmpty: (v) => !v?.fills?.length }
  );
  const fills = fillsRes.fills || [];
  const realOldest = fills.length ? fills[0].time : null;
  const reachedDays = realOldest ? (now - realOldest) / DAY : 0;

  console.log(
    `  成交 ${fills.length} 笔（${fillsRes._cached ? '缓存' : '新取'}，翻页 ${fillsRes.pages ?? '—'} 次）` +
    `  实际覆盖 ${day(realOldest)} → ${day(fills.length ? fills.at(-1).time : now)} = ${reachedDays.toFixed(1)} 天`
  );
  if (reachedDays < days - 3) {
    console.log(
      `  ⚠️ 未取满 ${days} 天：服务端对成交的保留是按【笔数】封顶的，` +
      `\n     该账户能回溯的深度已到边界（这是接口限制，不是取数失败）。`
    );
  }

  const tradesAll = buildTrades(fills);
  const closed = tradesAll.filter((t) => !t.stillOpen);
  console.log(`  归集成交易 ${tradesAll.length} 笔（已平仓 ${closed.length}，未平仓 ${tradesAll.length - closed.length}）`);

  const coinsTraded = new Map();
  for (const t of tradesAll) coinsTraded.set(t.coin, (coinsTraded.get(t.coin) || 0) + 1);
  const ranked = [...coinsTraded.entries()].sort((a, b) => b[1] - a[1]);

  // 按成交笔数降序取标的，累计覆盖到 95% 就停 —— 固定取前 N 个会让长尾标的
  // 白白丢掉（实测：只取前 10 个时，164/444 笔被跳过，覆盖率不到 65%）。
  const coins = [];
  let covered = 0;
  for (const [c, n] of ranked) {
    if (coins.length >= maxCoins) break;
    coins.push(c);
    covered += n;
    if (covered >= 0.95 * tradesAll.length && coins.length >= 3) break;
  }
  const coverage = tradesAll.length ? covered / tradesAll.length : 0;
  const missed = ranked.slice(coins.length);
  console.log(
    `  涉及标的 ${ranked.length} 个，重放 ${coins.length} 个 → 覆盖 ${covered}/${tradesAll.length} 笔（${pct(coverage, 1)}）`
  );
  if (missed.length) {
    console.log(`  （未覆盖：${missed.map(([c, n]) => `${c}×${n}`).join(', ')}）`);
  }

  const funding = await cached(
    `funding-${netKey}-${addr}-${days}d`,
    async () => ({ list: await pagedByTime(netKey, addr, 'userFunding', from, now) }),
    { isEmpty: (v) => !v?.list?.length }
  );
  const ledger = await cached(
    `ledger-${netKey}-${addr}-${days}d`,
    async () => ({ list: await pagedByTime(netKey, addr, 'userNonFundingLedgerUpdates', from, now) }),
    { isEmpty: (v) => !v?.list?.length }
  );
  const port = await cached(
    `portfolio-${netKey}-${addr}`,
    async () => ({ raw: await portfolio(netKey, addr) }),
    { isEmpty: (v) => !Array.isArray(v?.raw) || v.raw.length === 0 }
  );

  console.log(`  资金费 ${funding.list?.length ?? 0} 条，出入金 ${ledger.list?.length ?? 0} 条，权益曲线已取`);
  console.log(`  取数耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  /* ── 2. K 线（为规则重放准备） ── */
  console.log('\n[2] 拉取 K 线');
  const candlesByCoin = new Map();
  for (const coin of coins) {
    const c = await cached(
      `candles-${netKey}-${coin}-${interval}-${days}d`,
      async () => ({ list: await fetchCandles(netKey, coin, interval, from - 60 * DAY, now) }),
      { isEmpty: (v) => !v?.list?.length }
    );
    candlesByCoin.set(coin, c.list || []);
    console.log(`  ${coin.padEnd(10)} ${(c.list || []).length} 根${c._cached ? '（缓存）' : ''}`);
    if (!c._cached) await sleep(120);
  }

  /* ── 3. 逐笔重放规则 ── */
  console.log('\n[3] 逐笔重放规则（无前视）');
  const tiers = defaultTiers();
  // portfolio 返回的是 [[periodName, data], ...]，用现成的抽取函数拿合约账户权益
  const eq = extractEquityCurve(port.raw);
  const equityAt = buildEquityLookup(eq);
  const equityNow = eq?.primary?.equity?.at(-1)?.v ?? 0n;
  if (!equityAt) {
    console.log('  ⚠️ 权益曲线不可用，仓位门槛按 0 计（趋势/空间门槛的重放不受影响）');
  } else if (equityNow === 0n) {
    console.log('  ℹ️ 当前权益为 0（账户可能已提空），改用**各笔开仓时刻**的权益计算仓位');
  }

  const rows = [];
  let skipNoCoin = 0;
  let skipNoBars = 0;
  let skipNoLevels = 0;

  for (const t of closed) {
    if (!candlesByCoin.has(t.coin)) { skipNoCoin += 1; continue; }
    // allBars 用于 MAE/MFE（持仓期在开仓之后，本来就需要未来数据）；
    // candles 是**开仓时刻之前已收盘**的窗口，只给它喂策略读数 —— 无前视（见 barsBefore 注释）
    const allBars = candlesByCoin.get(t.coin);
    const candles = barsBefore(allBars, t.openTime, ivMs);
    // 新上市标的（ASTER / XPL / 0G 等）在分析窗口早期根本没有 40 根已收盘 K 线，
    // 这类无法重放是数据本身的限制，必须与「标的没覆盖」分开计数
    if (candles.length < 40) { skipNoBars += 1; continue; }

    const entryPx = t.vwapEntry > 0n ? t.vwapEntry : t.openPrice;
    // 用「开仓时刻的权益」而不是今天的权益 —— 账户可能已经提空，
    // 而且仓位本来就该按当时的账户规模来定
    const equityWad = equityAt ? equityAt(t.openTime).v : equityNow;
    let lv = null;
    for (const phase of CYCLE_PHASES) {
      const cfg = defaultConfig(phase);
      cfg.cyclePhase = phase;
      cfg.risk.minExpectedMoveBps = phaseFloorBps(phase);
      try {
        const r = computeLevels({
          coin: t.coin,
          candles: candles,
          markWad: entryPx,
          position: null,
          equityWad,
          config: cfg,
          tiers,
        });
        if (phase === 'ACCUMULATION') lv = r;
        if (!t._byPhase) t._byPhase = {};
        t._byPhase[phase] = {
          projectedMoveBps: r.entryPlan?.projectedMoveBps ?? 0,
          pass: !!r.entryPlan?.passMoveGate,
          floor: phaseFloorBps(phase),
        };
      } catch {
        /* 单笔算不动不影响整体 */
      }
    }
    if (!lv) { skipNoLevels += 1; continue; }

    const trend = lv.trend;
    const dir = t.isLong ? 1 : -1;
    const ex = excursions(allBars, t.openTime, t.closeTime ?? now, t.isLong, entryPx);
    const pnl = t.netPnl;
    const riskWad = lv.entryPlan?.lossAtStop ?? 0n;

    rows.push({
      coin: t.coin,
      isLong: t.isLong,
      openTime: t.openTime,
      closeTime: t.closeTime ?? null,
      holdMs: (t.closeTime ?? now) - t.openTime,
      entryPx,
      pnl,
      pnlNum: num(pnl),
      fees: t.fees,
      fillCount: t.fillCount,
      trendDirection: trend.direction,
      trendReason: trend.reason,
      longBreaks: trend.longBreaks,
      shortBreaks: trend.shortBreaks,
      holding: trend.holding,
      directionMatch: trend.direction === dir,
      trendConfirmed: trend.direction !== 0,
      projectedMoveBps: lv.entryPlan?.projectedMoveBps ?? 0,
      // 「推荐止损距离」= stop.recommended 的距离。它必须通过 12% 距离硬上限校验，
      // 这才是策略真正建议落单的位置。
      //
      // ⚠️ 早期版本取的是 entryPlan.stopDistanceBps —— 那是「距布林中轨的原始距离」，
      // 完全不受上限约束。加上 distanceBps 的分母取两者中较小者，参考位离价格越远，
      // 距离就被放大得越离谱：实测 178 个样本里 161 个（90.4%）超过策略自己的 12% 上限、
      // 92 个超过 100%、最大 42705%。那份「止损纪律」结论（10.1% 超出止损位）
      // 就是拿这个量算的，因此不可用。
      //
      // 原始值不丢，单独留一个字段，方便审计时对照。
      stopDistanceBps: lv.stop?.recommended?.distanceBps ?? null,
      stopRawMidBps: lv.entryPlan?.stopDistanceBps ?? null,
      riskWad,
      rMultiple: riskWad > 0n ? num(pnl) / num(riskWad) : null,
      mfeBps: ex.mfe,
      maeBps: ex.mae,
      byPhase: t._byPhase,
    });
  }

  console.log(
    `  可重放 ${rows.length} 笔｜跳过：标的未覆盖 ${skipNoCoin}、K 线不足 40 根 ${skipNoBars}、读数算不出 ${skipNoLevels}`
  );

  /* ── 4. 分桶归因 ── */
  console.log('\n[4] 归因');

  const bucket = (pred) => rows.filter(pred);
  const summarizeBucket = (label, list) => {
    const pnls = list.map((r) => r.pnlNum);
    const s = stats(pnls);
    const wins = pnls.filter((x) => x > 0).length;
    const gp = pnls.filter((x) => x > 0).reduce((a, b) => a + b, 0);
    const gl = Math.abs(pnls.filter((x) => x < 0).reduce((a, b) => a + b, 0));
    const rs = list.map((r) => r.rMultiple).filter((x) => x !== null);
    return {
      label,
      n: list.length,
      net: s.sum ?? 0,
      winRate: list.length ? wins / list.length : 0,
      profitFactor: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0,
      avg: s.mean ?? 0,
      median: s.median ?? 0,
      rMean: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
      rMedian: percentile(rs, 0.5),
    };
  };

  const trendAligned = bucket((r) => r.trendConfirmed && r.directionMatch);
  const trendAgainst = bucket((r) => r.trendConfirmed && !r.directionMatch);
  const trendUnconfirmed = bucket((r) => !r.trendConfirmed);

  const buckets = {
    all: summarizeBucket('全部成交', rows),
    aligned: summarizeBucket('趋势同向（规则放行趋势门槛）', trendAligned),
    against: summarizeBucket('趋势反向（规则会拦截）', trendAgainst),
    unconfirmed: summarizeBucket('趋势未确认（规则会拦截）', trendUnconfirmed),
  };

  // 空间门槛：按各相位地板给出拦截率与反事实盈亏
  const gateRows = CYCLE_PHASES.map((phase) => {
    const floor = phaseFloorBps(phase);
    const pass = rows.filter((r) => r.byPhase?.[phase]?.pass);
    const blocked = rows.filter((r) => !r.byPhase?.[phase]?.pass);
    const full = rows.filter((r) => r.trendConfirmed && r.directionMatch && r.byPhase?.[phase]?.pass);
    return {
      phase,
      label: PHASE_LABELS[phase],
      floorBps: floor,
      floorPct: floor / 100,
      passCount: pass.length,
      blockedCount: blocked.length,
      blockedPnl: blocked.reduce((a, r) => a + r.pnlNum, 0),
      fullPassCount: full.length,
      fullPassPnl: full.reduce((a, r) => a + r.pnlNum, 0),
      passRate: rows.length ? full.length / rows.length : 0,
    };
  });

  // 止损纪律：实际最大不利偏移 vs 规则建议止损距离
  const withStop = rows.filter((r) => r.stopDistanceBps != null);
  const overStop = withStop.filter((r) => r.maeBps != null && r.maeBps > r.stopDistanceBps);
  const stopDiscipline = {
    n: withStop.length,
    overCount: overStop.length,
    overRate: withStop.length ? overStop.length / withStop.length : 0,
    overPnl: overStop.reduce((a, r) => a + r.pnlNum, 0),
    inCount: withStop.length - overStop.length,
    inPnl: withStop.filter((r) => !(r.maeBps != null && r.maeBps > r.stopDistanceBps)).reduce((a, r) => a + r.pnlNum, 0),
    maeMed: percentile(withStop.map((r) => r.maeBps).filter((x) => x != null), 0.5),
    stopMed: percentile(withStop.map((r) => r.stopDistanceBps), 0.5),
  };

  // 持仓时长
  const holdHours = rows.map((r) => r.holdMs / 3600000);

  /* ── 反事实：只做规则放行的交易，一年下来会怎样 ── */

  const curveOf = (list) => {
    const sorted = [...list].sort(
      (a, b) => (a.closeTime ?? a.openTime) - (b.closeTime ?? b.openTime)
    );
    let cum = 0;
    let peak = 0;
    let maxDd = 0;
    const pts = [];
    for (const r of sorted) {
      cum += r.pnlNum;
      if (cum > peak) peak = cum;
      const dd = peak - cum;
      if (dd > maxDd) maxDd = dd;
      pts.push({ t: r.closeTime ?? r.openTime, cum, coin: r.coin });
    }
    const wins = sorted.filter((r) => r.pnlNum > 0).length;
    return {
      n: sorted.length,
      net: cum,
      maxDd,
      winRate: sorted.length ? wins / sorted.length : 0,
      avg: sorted.length ? cum / sorted.length : 0,
      pts,
    };
  };

  const HARD = EXPECTED_MOVE_HARD_FLOOR_BPS; // 12%
  const ACC = phaseFloorBps('ACCUMULATION'); // 16%

  const scenarios = [
    { key: 'actual', label: 'C0 实际（全部交易）', color: '#888780', list: rows },
    {
      key: 'trend',
      label: 'C1 只做趋势同向',
      color: '#185FA5',
      list: rows.filter((r) => r.trendConfirmed && r.directionMatch),
    },
    {
      key: 'trendHard',
      label: `C2 趋势同向 + 空间 ≥ ${(HARD / 100).toFixed(0)}%`,
      color: '#0F6E56',
      list: rows.filter((r) => r.trendConfirmed && r.directionMatch && r.projectedMoveBps >= HARD),
    },
    {
      key: 'trendAcc',
      label: `C3 趋势同向 + 空间 ≥ ${(ACC / 100).toFixed(0)}%`,
      color: '#854F0B',
      list: rows.filter((r) => r.trendConfirmed && r.directionMatch && r.projectedMoveBps >= ACC),
    },
  ].map((s) => {
    const c = curveOf(s.list);
    return {
      ...s,
      ...c,
      // 每笔均值。只看总额会误读：留下来的那批每笔可能**更差**，
      // 改善只是来自「做得少」。所以均值必须和总额一起看。
      mean: c.n ? c.net / c.n : 0,
    };
  });

  // 「选择效应 vs 敞口效应」的拆分 —— 在这里算一次，MD 与 HTML 两个渲染器共用。
  //
  //   · 选择效应（selection edge）：放行组**每笔**优于被剔除组 → 规则选得准
  //   · 敞口效应（exposure effect）：放行组每笔并不更优，只是笔数少 → 只是做得少
  //
  // 只有前者说明规则有信息量。后者任何减少交易的筛子都能做到。
  const c0ForSplit = scenarios.find((s) => s.key === 'actual');
  // 全部交易里**最惨的那一笔**。用于「离群点敏感性」检验：
  // 如果被剔除组去掉这笔之后再比，放行组的优势就没了 ——
  // 那所谓「改善」只是「少踩了一个坑」，不是筛子有信息量。
  const allNets = c0ForSplit.list.map((r) => r.pnlNum);
  const worstNet = allNets.length ? Math.min(...allNets) : 0;
  for (const s of scenarios) {
    s.dropN = c0ForSplit.n - s.n;
    s.dropNet = c0ForSplit.net - s.net;
    s.dropMean = s.dropN ? s.dropNet / s.dropN : 0;
    s.hasSelectionEdge = s.mean > s.dropMean;
    // 均值会被尾部单笔带跑，中位数不会。两个一起看才知道「优势」是不是真的。
    s.median = percentile(s.list.map((r) => r.pnlNum), 0.5) ?? 0;
    const keptSet = new Set(s.list);
    s.dropMedian = percentile(
      c0ForSplit.list.filter((r) => !keptSet.has(r)).map((r) => r.pnlNum),
      0.5
    ) ?? 0;
    s.dropMeanExWorst = s.dropN > 1 ? (s.dropNet - worstNet) / (s.dropN - 1) : 0;
    s.edgeSurvivesOutlier = s.dropN > 1 ? s.mean > s.dropMeanExWorst : true;
  }

  /* ── 资金费与费用 ── */
  // ⚠️ summarizePerformance 读的是**扁平**的资金费结构（直接取 d.usdc），
  //    而接口给的是 { time, hash, delta:{...} }。不做这一步映射，资金费会静默算成 0
  //    （表现是「61 条资金费记录，净额却是 $0.00」）。服务端也是这么映射的。
  const fundingFlat = (funding.list || []).map((f) => f.delta).filter(Boolean);
  const perf = summarizePerformance({ fills, funding: fundingFlat, trades: tradesAll });
  // ⚠️ `perf.realizedNet` 只减了手续费，**不含资金费**（这是有意的口径，selftest 也在断言它）。
  //    但报告里「资金费净额」那一行就排在「已实现净额」上面，读者会自然地把三行加起来 ——
  //    得到的数与印出来的净额对不上（这个账户是 +9.58 vs -65.51，**符号都反了**）。
  //    所以两个口径都印，且把口径写进标签。
  const netInclFunding = num(perf.realizedNet) + num(perf.fundingNet);
  // 出入金：time 在外层包装上，拍平进去才带得上时间戳
  const deposits = netDeposits(
    (ledger.list || []).map((l) => (l.delta ? { ...l.delta, time: l.time } : null)).filter(Boolean)
  );
  // 重放子集的生命周期净额（口径B）—— 与账户级口径A 是两把尺子，必须分开标
  const replayedNet = rows.reduce((a, r) => a + r.pnlNum, 0);

  /* ── 5. 输出报告 ── */
  await ensureDir(OUTDIR);
  const stamp = new Date().toISOString().slice(0, 10);
  const tag = addr.slice(0, 8);
  const base = path.join(OUTDIR, `attribution-${tag}-${stamp}`);

  const L = [];
  const P = (s = '') => L.push(s);

  P(`# 比特皇规则归因 · 一年真实成交`);
  P();
  P(`- 地址：\`${addr}\``);
  P(`- 网络：${net.label}`);
  P(`- 分析区间：${day(from)} → ${day(now)}（目标 ${days} 天）`);
  P(`- **实际覆盖：${day(realOldest)} → ${day(fills.length ? fills.at(-1).time : now)}　共 ${reachedDays.toFixed(1)} 天**`);
  P(`- K 线周期：${interval}　重放标的：${coins.length} 个（${coins.join(', ')}）`);
  P(`- **规则重放覆盖：${rows.length} / ${tradesAll.length} 笔（${pct(tradesAll.length ? rows.length / tradesAll.length : 0, 1)}）**`);
  P(`  跳过明细：标的未覆盖 ${skipNoCoin} 笔、K 线不足 40 根 ${skipNoBars} 笔、读数算不出 ${skipNoLevels} 笔。`);
  P(`  （K 线不足的多为新上市标的在窗口早期的交易，属数据本身的限制）`);
  P(`- 未覆盖标的：${missed.length ? missed.map(([c, n]) => `${c}×${n}`).join(', ') : '无'}`);
  P(`- 生成时间：${new Date().toISOString().replace('T', ' ').slice(0, 19)}`);
  P();

  /* ── 报告可信度：在读任何结论之前先过这一块 ──
     这三条都是「不改数字、但改变数字怎么读」的限定条件。放在最前面，
     是因为它们一旦成立，后面所有分桶对比的性质就变了。 */

  const ivForCheck = INTERVAL_MS[interval] ?? INTERVAL_MS['4h'];
  const hsForCheck = stats(holdHours);
  const medHoldH = hsForCheck.median ?? 0;
  const medHoldMs = medHoldH * 3600000;
  // 持仓时长中位远小于 K 线周期 → 重放的「趋势」与这笔交易的实际存续时间不在一个尺度
  const cycleMismatch = medHoldMs > 0 && medHoldMs < ivForCheck * 0.25;
  const projBig = rows.filter((r) => r.projectedMoveBps > RAW_MOVE_WARN_BPS);
  const projHuge = rows.filter((r) => r.projectedMoveBps > RAW_MOVE_ABSURD_BPS);
  const stopBad = rows.filter((r) => r.stopRawMidBps != null && r.stopRawMidBps > RAW_STOP_SANE_BPS);

  if (cycleMismatch || projBig.length || stopBad.length) {
    P(`## ⚠️ 读这份报告前必须知道的几件事`);
    P();
    if (cycleMismatch) {
      P(`**1. 周期错配。** 这个账户的持仓时长中位是 **${medHoldH.toFixed(2)} 小时**（${(medHoldMs / 60000).toFixed(0)} 分钟），`);
      P(`   而规则读数的口径是 **${interval}**（${ivForCheck / 3600000} 小时）。`);
      P(`   一笔十几分钟就平掉的交易，盈亏更多取决于分钟级噪声，而不是 4H 趋势是否成立 ——`);
      P(`   两者不在一个时间尺度上。所以下面的分桶对比**可以当数据探索，不能当规则有效性的证据**。`);
      P();
    }
    if (projBig.length) {
      P(`**${cycleMismatch ? 2 : 1}. 「可得空间」有 ${projBig.length} 笔超过 ${RAW_MOVE_WARN_BPS / 100}%${projHuge.length ? `、其中 ${projHuge.length} 笔超过 ${RAW_MOVE_ABSURD_BPS / 100}%` : ''}**`);
      P(`   （最大 ${(Math.max(...rows.map((r) => r.projectedMoveBps)) / 100).toFixed(0)}%）。`);
      P(`   这个值是「区间等幅量出投影」，理论上可以很大；但超过一个数量级就说明`);
      P(`   回看窗口里有一段极端行情（新上币早期）把区间撑开了。`);
      P(`   后果是**空间门槛在这些样本上形同虚设** —— 无论地板设多高都会放行。`);
      P(`   所以第 3 节里 C1→C2 的改善，有一部分来自「门槛没起作用」，而不是「门槛选对了」。`);
      P();
    }
    if (stopBad.length) {
      P(`**${cycleMismatch || projBig.length ? 3 : 1}. 「距布林中轨原始距离」有 ${stopBad.length} 笔超过 ${RAW_STOP_SANE_BPS / 100}%**`);
      P(`   （最大 ${(Math.max(...stopBad.map((r) => r.stopRawMidBps)) / 100).toFixed(0)}%）。`);
      P(`   止损距离不可能是价格的好几倍 —— 这类值是「参考位离价格极远」或「该标的 K 线脏」的产物，`);
      P(`   不是可用的风控位置。正文一律只印**推荐止损距**（受 ${12}% 上限约束），原始值不进表。`);
      P();
    }
  }

  if (reachedDays < days - 3) {
    P(`> ⚠️ **未取满 ${days} 天。** 服务端对成交历史的保留是按【笔数】封顶，`);
    P(`> 而非按时间封顶（实测：几千笔的个人账户可回溯 300~1170 天，`);
    P(`> 每小时近万笔的做市账户只能回溯 1~2 小时）。`);
    P(`> 该账户的可回溯深度已到边界，报告基于实际取到的 **${reachedDays.toFixed(1)} 天**。`);
    P();
  }

  /* ── 结论闸门：把「会削弱结论」的条件收集起来 ──
     第 8 节的判定由这里决定，MD 与 HTML 两个渲染器共用同一个 verdict 对象，
     避免两个渲染器各写一套判定、各自漂移（上一版就是这么出现「caveat 说不能当证据、
     结论却说规则有效」的自相矛盾的）。 */
  const coverageRatio = tradesAll.length ? rows.length / tradesAll.length : 0;
  const c2v = scenarios.find((s) => s.key === 'trendHard');
  // 趋势门槛单独使用时是反向的吗？——它放行的「同向组」比它要拦的「反向组」还差。
  const trendGateInverted = buckets.against.n > 0 && buckets.aligned.avg < buckets.against.avg;

  const verdictBlockers = [];
  if (c2v.n < MIN_KEPT_FOR_VERDICT) {
    verdictBlockers.push(
      `**放行样本只有 ${c2v.n} 笔**（判定门槛 ${MIN_KEPT_FOR_VERDICT} 笔）。` +
        `盈亏是重尾分布，这个量级下均值由少数几笔尾部交易决定 —— 换一段样本就可能翻符号。`
    );
  }
  if (!c2v.hasSelectionEdge) {
    verdictBlockers.push(
      `放行组每笔均值（${c2v.mean.toFixed(2)}）**并不优于**被剔除组（${c2v.dropMean.toFixed(2)}）` +
        ` —— 改善来自「做得少」，不是「选得准」。`
    );
  }
  if (!c2v.edgeSurvivesOutlier) {
    verdictBlockers.push(
      `**离群点敏感性**：被剔除组去掉「最惨的一笔」（${worstNet.toFixed(0)} USDC）后，` +
        `每笔均值变成 ${c2v.dropMeanExWorst.toFixed(2)}，放行组（${c2v.mean.toFixed(2)}）的优势就消失了` +
        ` —— 改善来自「少踩了一个坑」，不是筛子有信息量。`
    );
  }
  if (c2v.median <= c2v.dropMedian) {
    verdictBlockers.push(
      `**中位数也不占优**：放行组中位 ${c2v.median.toFixed(2)} vs 被剔除组 ${c2v.dropMedian.toFixed(2)}` +
        ` —— 均值上的优势是尾部拉出来的，典型一笔并没有更好。`
    );
  }
  if (cycleMismatch) {
    verdictBlockers.push(
      `**周期错配**：持仓时长中位 ${medHoldH.toFixed(2)}h，而规则读数口径是 ${interval}` +
        ` —— 两者不在一个时间尺度，分桶对比只能当数据探索，不能当有效性证据。`
    );
  }
  if (coverageRatio < MIN_COVERAGE_FOR_VERDICT) {
    verdictBlockers.push(
      `规则重放覆盖率仅 ${pct(coverageRatio, 1)}（门槛 ${pct(MIN_COVERAGE_FOR_VERDICT, 0)}）` +
        ` —— 结论只代表被重放的那批标的，而缺失的往往正是数据最脏的新上币。`
    );
  }
  if (c2v.net <= 0) {
    verdictBlockers.push(
      `**放行组合本身仍是亏损**（${c2v.net.toFixed(0)} USDC）。` +
        `规则即使真的在筛，也只是「少亏」，不是「能赚」。`
    );
  }
  if (trendGateInverted) {
    verdictBlockers.push(
      `**趋势门槛单独看是反向的**：它放行的同向组每笔 ${buckets.aligned.avg.toFixed(0)}，` +
        `反而差于它会拦下的反向组 ${buckets.against.avg.toFixed(0)}。` +
        `所以 C2 的改善不能归给趋势门槛。`
    );
  }
  const verdictOk = verdictBlockers.length === 0;
  const verdict = {
    ok: verdictOk,
    blockers: verdictBlockers,
    keptN: c2v.n,
    keptMean: c2v.mean,
    dropN: c2v.dropN,
    dropMean: c2v.dropMean,
    keptMedian: c2v.median,
    dropMedian: c2v.dropMedian,
    dropMeanExWorst: c2v.dropMeanExWorst,
    worstNet,
    hasSelectionEdge: c2v.hasSelectionEdge,
    trendGateInverted,
  };

  P(`## 1. 账户总览`);
  P();
  P(`⚠️ 这里有两把**不同**的尺子，不要混读：`);
  P();
  P(`- **口径A（全账户 · 按平仓成交归集）**：每一笔带 closedPnl 的成交单独计一次。`);
  P(`  永远成立、窗口无关，但同一笔持仓的多次加减仓会被拆成多条。`);
  P(`- **口径B（子集 · 按完整持仓周期归集）**：一次开仓到回到空仓算一笔。`);
  P(`  更贴近人的直觉，但只覆盖被重放的标的。`);
  P();
  P(`### 口径A · 全账户`);
  P();
  P(`| 指标 | 数值 |`);
  P(`|---|---|`);
  P(`| 成交笔数 | ${fills.length} |`);
  P(`| 归集交易 | ${tradesAll.length}（已平仓 ${closed.length}） |`);
  P(`| 涉及标的 | ${ranked.length} |`);
  P(`| 已实现毛盈亏 | ${usd(perf.realizedGross)} |`);
  P(`| 手续费 | −${usd(perf.fees)} |`);
  P(`| **已实现净额（毛盈亏 − 手续费，不含资金费）** | **${usd(perf.realizedNet)}** |`);
  P(`| 资金费净额（${fundingFlat.length} 条） | ${usd(perf.fundingNet)}（**另计**，不含在上一行内） |`);
  P(`| **含资金费的总净额** | **${netInclFunding >= 0 ? '+' : '−'}${Math.abs(netInclFunding).toFixed(2)} USDC** |`);
  P(`| 平仓成交胜率 | ${pct(perf.closing?.winRate ?? 0, 1)}（${perf.closing?.count ?? 0} 笔） |`);
  P(`| 出入金净额（${(ledger.list || []).length} 条） | ${usd(deposits.net)}（充值 ${usd(deposits.deposit)} / 提取 ${usd(deposits.withdraw)}） |`);
  P(`| 当前账户权益 | ${usd(equityNow)} |`);
  P();
  P(`### 口径B · 被重放的子集`);
  P();
  P(`| 指标 | 数值 |`);
  P(`|---|---|`);
  P(`| 可重放交易 | ${rows.length} / ${tradesAll.length} 笔 |`);
  P(`| **生命周期净额** | **${replayedNet >= 0 ? '' : '−'}${Math.abs(replayedNet).toFixed(2)} USDC** |`);
  P();
  P(`> 第 3 节的反事实对比用的是**口径B**，基线就是这 ${replayedNet.toFixed(0)} USDC，`);
  P(`> 而不是口径A 的 ${usd(perf.realizedNet)} —— 两者覆盖的标的与归集方式都不同，不可直接比较。`);
  P();
  let ddNote = '';
  if (eq?.primary?.maxDrawdown) {
    const dd = eq.primary.maxDrawdown;
    if (dd.plausible === false) {
      // 权益快照接近 0 时，百分比的分母不是真实资金基数 —— 照抄这个数字会误导
      P(`最大回撤：**百分比不可信**（算出 ${pct(dd.pct, 2)} —— 权益口径下不可能超过 100%）。`);
      if (dd.drawdownAmount != null) {
        P(`绝对金额为 **${usd(dd.drawdownAmount)}**，请以此为准。`);
      }
      P(`原因：${dd.caveat}`);
      ddNote =
        `最大回撤百分比不可信（算出 ${pct(dd.pct, 2)}）` +
        (dd.drawdownAmount != null ? `，绝对金额 ${usd(dd.drawdownAmount)}` : '') +
        `。${dd.caveat}`;
    } else {
      P(`最大回撤：**${pct(dd.pct, 2)}**（口径 ${dd.method}${dd.includesTransfers ? '，含出入金' : '，已免疫出入金'}）`);
      ddNote = `最大回撤 ${pct(dd.pct, 2)}（${dd.method}${dd.includesTransfers ? '，含出入金' : ''}）`;
    }
    P();
  }

  P(`## 2. 趋势门槛归因 —— 规则放行的 vs 会拦截的`);
  P();
  P(`比特皇的开单门槛之一：连续三次有效突破轨道**且**站稳中轨。下表把每笔交易按`);
  P(`「开仓时刻的 K 线状态」分桶（用开仓前已收盘的 K 线重放，无前视）。`);
  P();
  P(`| 分桶 | 笔数 | 净盈亏 | 胜率 | 盈亏比 | 均值 | 中位 | 平均 R |`);
  P(`|---|---:|---:|---:|---:|---:|---:|---:|`);
  for (const k of ['all', 'aligned', 'against', 'unconfirmed']) {
    const b = buckets[k];
    const pf = b.profitFactor === Infinity ? '∞' : b.profitFactor.toFixed(2);
    P(
      `| ${b.label} | ${b.n} | ${b.net >= 0 ? '' : '−'}${Math.abs(b.net).toFixed(0)} | ${pct(b.winRate, 1)} | ${pf} | ` +
      `${b.avg >= 0 ? '' : '−'}${Math.abs(b.avg).toFixed(0)} | ${b.median >= 0 ? '' : '−'}${Math.abs(b.median).toFixed(0)} | ` +
      `${b.rMean == null ? '—' : b.rMean.toFixed(2)} |`
    );
  }
  P();
  const alignedEdge = buckets.aligned.avg - buckets.against.avg;
  P(`**读法**：趋势同向组的均值 ${buckets.aligned.avg.toFixed(0)}，趋势反向组 ${buckets.against.avg.toFixed(0)}，`);
  P(`差 **${alignedEdge >= 0 ? '+' : '−'}${Math.abs(alignedEdge).toFixed(0)} USDC/笔**。`);
  if (buckets.against.n > 0 && buckets.against.net < 0) {
    P(`趋势反向组累计 ${buckets.against.net.toFixed(0)} USDC —— 这部分是趋势门槛本来会拦下的。`);
  }
  // ⚠️ 差值为负 = 门槛放行的组反而更差。这是「门槛反向」的直接证据，
  //    不能只印数字让读者自己发现 —— 正负号很容易被忽略。
  if (alignedEdge < 0) {
    P();
    P(`⚠️ **注意方向：这个差是负的。** 趋势门槛放行的「同向组」，每笔表现**差于**它本来要拦下的「反向组」——`);
    P(`也就是说，**趋势门槛在这批数据上单独使用时是反向有效的**（选出来的那一组更差）。`);
    P(`所以第 3 节 C1→C2 的改善，不能记在趋势门槛头上，要记在空间门槛上。`);
  }
  P();

  /* ── 反事实对比 ── */
  P(`## 3. 反事实对比 —— 只做规则放行的交易会怎样`);
  P();
  P(`把同一年的成交按「规则是否会放行」筛掉一部分，各自累加盈亏。`);
  P(`这是本报告最直接的一张表：**规则的贡献 = 筛后组合 − 实际组合**。`);
  P();
  P(`基线 = 被重放的 ${rows.length} 笔交易的生命周期净额 **${replayedNet.toFixed(0)} USDC**（口径B）。`);
  P();
  P(`| 组合 | 笔数 | 净盈亏 | 每笔均值 | 胜率 | 累计盈亏最大回撤 |`);
  P(`|---|---:|---:|---:|---:|---:|`);
  for (const s of scenarios) {
    const f = (x) => `${x < 0 ? '−' : ''}${Math.abs(x).toFixed(0)}`;
    P(
      `| ${s.label} | ${s.n} | ${f(s.net)} | ${f(s.avg)} | ${pct(s.winRate, 1)} | ${s.maxDd.toFixed(0)} |`
    );
  }
  P();
  const c0 = scenarios[0];
  const c2 = scenarios.find((s) => s.key === 'trendHard');
  const c3 = scenarios.find((s) => s.key === 'trendAcc');
  P(
    `对比 C0（实际）与 C2：净盈亏 ${c0.net.toFixed(0)} → ${c2.net.toFixed(0)}，` +
    `差 **${(c2.net - c0.net) >= 0 ? '+' : '−'}${Math.abs(c2.net - c0.net).toFixed(0)} USDC**；` +
    `最大回撤 ${c0.maxDd.toFixed(0)} → ${c2.maxDd.toFixed(0)}。`
  );
  P(
    `对比 C0 与 C3：净盈亏 ${c3.net.toFixed(0)}，差 ` +
    `**${(c3.net - c0.net) >= 0 ? '+' : '−'}${Math.abs(c3.net - c0.net).toFixed(0)} USDC**。`
  );
  P();
  P(`> 读这张表要看**两个方向**：净盈亏提高了多少，以及回撤降低/提高了多少。`);
  P(`> 只提高盈亏但回撤同步放大，说明只是把杠杆加上去了，不是规则的功劳。`);
  P();
  P(`> ⚠️ 反事实的局限：筛掉交易会同时改变后续的可用保证金与仓位规模，`);
  P(`> 而这里只做**盈亏线性累加**，没有重算复利与保证金约束。`);
  P(`> 因此它衡量的是「这些交易的盈亏质量」，不是精确的组合收益。`);
  P();

  P(`## 4. 空间门槛归因 —— 各相位地板下的反事实`);
  P();
  P(`空间门槛判的是「K 线自己量出的区间等幅投影」，不是外部声明的目标（这条规则在`);
  P(`链上合约里修过一个漏洞：keeper 把目标价填成入场价 10 倍即可绕过）。`);
  P();
  P(`| 相位 | 地板 | 完全放行笔数 | 放行率 | 放行组净盈亏 | 被拦组净盈亏 |`);
  P(`|---|---:|---:|---:|---:|---:|`);
  for (const g of gateRows) {
    P(
      `| ${g.label} | ${g.floorPct.toFixed(0)}% | ${g.fullPassCount} / ${rows.length} | ${pct(g.passRate, 1)} | ` +
      `${g.fullPassPnl >= 0 ? '' : '−'}${Math.abs(g.fullPassPnl).toFixed(0)} | ` +
      `${g.blockedPnl >= 0 ? '' : '−'}${Math.abs(g.blockedPnl).toFixed(0)} |`
    );
  }
  P();
  P(`> 注意：历史各时点的周期相位无法精确还原（相位是全局市场状态，需要完整重算），`);
  P(`> 所以这里给出**四档相位下的反事实**，而不是断言「当时的相位是哪一个」。`);
  P();

  P(`## 5. 止损纪律 —— 亏损有没有真的控制在规则位`);
  P();
  P(`| 指标 | 数值 |`);
  P(`|---|---|`);
  P(`| 可评估交易 | ${stopDiscipline.n} |`);
  P(`| 规则推荐止损距离（中位） | ${bpsToPct(stopDiscipline.stopMed ?? 0)} |`);
  P(`| 实际最大不利偏移（中位） | ${bpsToPct(stopDiscipline.maeMed ?? 0)} |`);
  P(`| 亏损**超出**规则止损位 | ${stopDiscipline.overCount} 笔（${pct(stopDiscipline.overRate, 1)}），合计 ${stopDiscipline.overPnl.toFixed(0)} USDC |`);
  P(`| 亏损**在**规则止损位内 | ${stopDiscipline.inCount} 笔，合计 ${stopDiscipline.inPnl.toFixed(0)} USDC |`);
  P();
  P(`「最大不利偏移」用的是持仓期间 K 线的极端价 —— 它衡量的是**你有没有让亏损跑过头**，`);
  P(`而不是最终盈亏。超出比例高，说明止损执行（或仓位管理）与规则脱节。`);
  P();

  P(`## 6. 持仓时长分布`);
  P();
  const hs = stats(holdHours);
  P(`| 分位 | 小时 | 天 |`);
  P(`|---|---:|---:|`);
  for (const [k, lbl] of [['p25', '25%'], ['median', '中位'], ['p75', '75%']]) {
    P(`| ${lbl} | ${(hs[k] ?? 0).toFixed(1)} | ${((hs[k] ?? 0) / 24).toFixed(2)} |`);
  }
  P(`| 最短 | ${(hs.min ?? 0).toFixed(2)} | ${((hs.min ?? 0) / 24).toFixed(3)} |`);
  P(`| 最长 | ${(hs.max ?? 0).toFixed(1)} | ${((hs.max ?? 0) / 24).toFixed(2)} |`);
  P();

  P(`## 7. 逐笔明细（前 40 笔，按盈亏绝对值排序）`);
  P();
  const badStop = rows.filter((r) => r.stopRawMidBps != null && r.stopRawMidBps > RAW_STOP_SANE_BPS);
  if (badStop.length) {
    P(`> ⚠️ **数据缺陷提示**：有 ${badStop.length} 笔的「距布林中轨原始距离」超过 ${RAW_STOP_SANE_BPS / 100}%`);
    P(`> （最大 ${(Math.max(...badStop.map((r) => r.stopRawMidBps)) / 100).toFixed(0)}%）。`);
    P(`> 这类值只可能来自两点：参考位离价格极远，或该标的 K 线本身脏（新上币早期低流动性插针）。`);
    P(`> 因此下表印的是**推荐止损距**（受 12% 上限约束），不是那个原始距离。`);
    P();
  }
  P(`| 标的 | 方向 | 开仓 | 平仓 | 持仓h | 净盈亏 | 趋势 | 同向 | 投影空间 | 推荐止损距 | MAE | R |`);
  P(`|---|---|---|---|---:|---:|---|---|---:|---:|---:|---:|`);
  const top = [...rows].sort((a, b) => Math.abs(b.pnlNum) - Math.abs(a.pnlNum)).slice(0, 40);
  for (const r of top) {
    const dirTxt = r.isLong ? '多' : '空';
    const trendTxt = r.trendDirection === 1 ? '多' : r.trendDirection === -1 ? '空' : '未确认';
    P(
      `| ${r.coin} | ${dirTxt} | ${day(r.openTime)} | ${day(r.closeTime)} | ${(r.holdMs / 3600000).toFixed(1)} | ` +
      `${r.pnlNum >= 0 ? '' : '−'}${Math.abs(r.pnlNum).toFixed(1)} | ${trendTxt} | ` +
      `${r.trendConfirmed ? (r.directionMatch ? '✓' : '✗') : '—'} | ` +
      `${(r.projectedMoveBps / 100).toFixed(1)}% | ${r.stopDistanceBps == null ? '—' : (r.stopDistanceBps / 100).toFixed(2) + '%'} | ` +
      `${r.maeBps == null ? '—' : (r.maeBps / 100).toFixed(2) + '%'} | ${r.rMultiple == null ? '—' : r.rMultiple.toFixed(2)} |`
    );
  }
  P();

  P(`## 8. 结论`);
  P();
  // 「改善」必须拆成两个来源，否则结论会骗人：
  //   · 选择效应（selection edge）：留下来的那批**每笔**比被剔掉的那批更好
  //   · 敞口效应（exposure effect）：留下的那批每笔并不更好，只是笔数少了
  //
  // 只有前者说明规则有信息量。后者任何「减少交易」的筛子都能做到 ——
  // 随机剔除、或者干脆把仓位砍半 —— 与规则本身无关。
  //
  // 拆分在 scenarios 构建时算好（见 s.mean / s.dropMean / s.hasSelectionEdge），
  // 这里只取用，避免两个渲染器各算一遍。
  const dNet = c2.net - c0.net;
  const dDd = c2.maxDd - c0.maxDd;
  const keptMean = c2.mean;
  const dropN = c2.dropN;
  const dropMean = c2.dropMean;
  const hasSelectionEdge = c2.hasSelectionEdge;

  P(`**规则在你这一年成交上的净贡献：${dNet >= 0 ? '+' : '−'}${Math.abs(dNet).toFixed(0)} USDC**`);
  P(`（把 ${c2.n} 笔规则放行的交易挑出来、剔除其余 ${c0.n - c2.n} 笔，累计盈亏 ${c0.net.toFixed(0)} → ${c2.net.toFixed(0)}）`);
  P();
  P(`**这个改善要拆成两个来源看，否则会读错** —— 是「选得准」还是只是「做得少」：`);
  P();
  P(`| | 笔数 | 净盈亏 | 每笔均值 | 每笔中位 |`);
  P(`|---|---:|---:|---:|---:|`);
  P(`| 规则放行（留下） | ${c2.n} | ${c2.net.toFixed(0)} | ${keptMean.toFixed(2)} | ${c2.median.toFixed(2)} |`);
  P(`| 规则拦截（剔除） | ${dropN} | ${(c0.net - c2.net).toFixed(0)} | ${dropMean.toFixed(2)} | ${c2.dropMedian.toFixed(2)} |`);
  P();
  P(`再加一道**离群点敏感性**检验：把被剔除组里最惨的那一笔（${worstNet.toFixed(0)} USDC）也拿掉，`);
  P(`被剔除组的每笔均值从 ${dropMean.toFixed(2)} 变成 ${c2.dropMeanExWorst.toFixed(2)}；`);
  P(`放行组（${keptMean.toFixed(2)}）到这一步${c2.edgeSurvivesOutlier ? '**仍然占优**' : '**已经不占优**'}。`);
  P(`这一步问的是：这个「优势」是真选出了好交易，还是仅仅少踩了一个坑。`);
  P();
  if (!hasSelectionEdge) {
    P(`⚠️ **放行组的每笔均值（${keptMean.toFixed(2)}）并不优于被剔除组（${dropMean.toFixed(2)}）。**`);
    P(`也就是说，规则**没有选出更好的交易**，它实际做的是**让你少交易**。`);
    P(`所以上面的「改善」是**敞口效应**（做得少），不是**选择效应**（选得准）——`);
    P(`任何能减少笔数的筛子（随机剔除、或直接降低仓位）都会产生同样效果，`);
    P(`因此它**不能**用来证明这套规则有信息量。`);
    P();
  }
  // 判定由「结论闸门」（见报告开头之前的 verdictBlockers）决定 ——
  // 只要有一条削弱条件成立，就不允许输出正向判定，改为逐条列理由。
  if (!verdictOk) {
    P(`**判定：规则在这个样本上没有被证明有效。**`);
    P();
    P(`命中 ${verdictBlockers.length} 条削弱条件：`);
    P();
    verdictBlockers.forEach((b, i) => P(`${i + 1}. ${b}`));
    P();
    P(`⚠️ 这不等于「规则是错的」。它只说明**这一年、这个账户、这批数据不足以证明它对**。`);
    P(`要让这个判定有意义，需要换一个**持仓周期与规则口径匹配**的账户来做同样的重放`);
    P(`（持仓数天、而不是十几分钟），否则测的始终是规则口径之外的东西。`);
  } else if (dNet > 0 && dDd <= 0) {
    P(`**判定：规则有效。** 盈亏改善的同时累计回撤也下降了（${c0.maxDd.toFixed(0)} → ${c2.maxDd.toFixed(0)}），`);
    P(`说明筛掉的是「又亏又拖回撤」的交易 —— 这是规则真正在起作用的形态。`);
  } else if (dNet > 0 && dDd > 0) {
    P(`**判定：规则提高了盈亏，但代价是更大的回撤**（${c0.maxDd.toFixed(0)} → ${c2.maxDd.toFixed(0)}）。`);
    P(`这更像是「集中到了波动更大的机会上」，而不是风险被控制住了。需要看更长的样本再下结论。`);
  } else if (dNet <= 0 && dDd < 0) {
    P(`**判定：规则降低了回撤但牺牲了盈亏**（盈亏差 ${dNet.toFixed(0)}，回撤 ${c0.maxDd.toFixed(0)} → ${c2.maxDd.toFixed(0)}）。`);
    P(`这是典型的「用收益换稳定」。是否值得取决于你对回撤的容忍度。`);
  } else {
    P(`**判定：规则在这个样本上没有体现出正贡献**（盈亏差 ${dNet.toFixed(0)}，回撤 ${c0.maxDd.toFixed(0)} → ${c2.maxDd.toFixed(0)}）。`);
    P(`可能的原因：① 这个账户本身已经在按接近规则的方式交易，规则没有额外信息量；`);
    P(`② 样本量不足；③ 规则与这个账户的标的/周期不匹配。`);
  }
  P();
  P(`三条支撑读数：`);
  P();
  P(`1. **趋势门槛**：同向组与反向组的均值差 ${alignedEdge >= 0 ? '+' : '−'}${Math.abs(alignedEdge).toFixed(0)} USDC/笔，`);
  P(`   样本 ${buckets.aligned.n} vs ${buckets.against.n} 笔。样本量决定这条结论的硬度。`);
  if (trendGateInverted) {
    P(`   ⚠️ **方向是反的**：门槛放行的同向组每笔 ${buckets.aligned.avg.toFixed(0)}，`);
    P(`   比它会拦下的反向组（每笔 ${buckets.against.avg.toFixed(0)}）还差 ——`);
    P(`   趋势门槛在这批数据上单独使用是**负贡献**的，C2 的改善要归给空间门槛，不是它。`);
  }
  P(`2. **空间门槛**：完全放行比例在「筑底 16%」档是 ${pct(gateRows.find((g) => g.phase === 'ACCUMULATION')?.passRate ?? 0, 1)}。`);
  P(`   如果这个比例极低、但放行组盈亏并不更好，说明门槛在这批数据上收益有限。`);
  P(`3. **止损纪律**：${pct(stopDiscipline.overRate, 1)} 的交易亏损超出了规则止损位，`);
  P(`   这部分合计 ${stopDiscipline.overPnl.toFixed(0)} USDC —— 这是**执行层**的问题，不是规则的问题。`);
  P();
  P(`**可以立刻改进的一点**：上面第 3 条与规则无关，是纪律问题。`);
  P(`把止损位落到交易所的实际挂单上，比继续调策略参数更值钱。`);
  P();
  P(`---`);
  P();
  P(`*本报告只读生成，不涉及任何下单或密钥。规则重放使用与链上合约同源的 BigInt 策略数学。*`);

  const md = L.join('\n');
  await fsp.writeFile(base + '.md', md, 'utf8');
  await fsp.writeFile(
    base + '.json',
    JSON.stringify(
      {
        address: addr,
        network: netKey,
        window: { from, to: now, requestedDays: days, reachedDays },
        counts: { fills: fills.length, trades: tradesAll.length, closed: closed.length, replayed: rows.length },
        buckets,
        gateRows,
        stopDiscipline,
        holdHours: hs,
        performance: perf,
        equityNow,
        fundingNet: perf.fundingNet,
        netInclFunding,
        deposits: { deposit: deposits.deposit, withdraw: deposits.withdraw, net: deposits.net },
        replayedNet,
        scenarios: scenarios.map((s) => ({
          key: s.key, label: s.label, n: s.n, net: s.net, maxDd: s.maxDd, avg: s.avg, winRate: s.winRate,
          mean: s.mean, median: s.median,
          dropN: s.dropN, dropMean: s.dropMean, dropMedian: s.dropMedian,
          dropMeanExWorst: s.dropMeanExWorst,
          hasSelectionEdge: s.hasSelectionEdge, edgeSurvivesOutlier: s.edgeSurvivesOutlier,
        })),
        verdict,
        rows,
      },
      jsonSafe,
      2
    ),
    'utf8'
  );

  const html = renderHtml({
    addr, netKey, days, reachedDays, realOldest, fills, tradesAll, closed, rows, coins, coverage,
    buckets, gateRows, stopDiscipline, scenarios, perf, equityNow, interval,
    span: { from, to: now },
    fundingFlat, deposits, replayedNet, ledgerCount: (ledger.list || []).length, ddNote, verdict,
    netInclFunding,
  });
  await fsp.writeFile(base + '.html', html, 'utf8');

  console.log('\n[5] 输出');
  console.log('  ' + base + '.html');
  console.log('  ' + base + '.md');
  console.log('  ' + base + '.json');
  console.log('\n' + '─'.repeat(78));
  console.log('要点：');
  console.log(
    `  反事实净贡献 ${dNet >= 0 ? '+' : ''}${dNet.toFixed(0)} USDC  ` +
    `（实际 ${c0.net.toFixed(0)} → 规则放行 ${c2.net.toFixed(0)}，${c0.n} → ${c2.n} 笔）`
  );
  console.log(
    `  回撤 ${c0.maxDd.toFixed(0)} → ${c2.maxDd.toFixed(0)}`
  );
  console.log(
    `  趋势同向 ${buckets.aligned.n} 笔 净 ${buckets.aligned.net.toFixed(0)} / ` +
    `反向 ${buckets.against.n} 笔 净 ${buckets.against.net.toFixed(0)} / ` +
    `未确认 ${buckets.unconfirmed.n} 笔 净 ${buckets.unconfirmed.net.toFixed(0)}`
  );
  console.log(`  均值差 ${alignedEdge >= 0 ? '+' : ''}${alignedEdge.toFixed(0)} USDC/笔`);
  console.log(`  超止损 ${stopDiscipline.overCount} 笔（${pct(stopDiscipline.overRate, 1)}）`);
  console.log(
    `  放行组每笔 ${c2.mean.toFixed(2)}（中位 ${c2.median.toFixed(2)}）/ ` +
    `剔除组每笔 ${c2.dropMean.toFixed(2)}（中位 ${c2.dropMedian.toFixed(2)}）`
  );
  console.log(
    `  口径A 净额 ${num(perf.realizedNet).toFixed(2)}（不含资金费）` +
    ` → ${netInclFunding.toFixed(2)}（含资金费 ${num(perf.fundingNet).toFixed(2)}）`
  );
  console.log(
    verdictOk
      ? '  判定闸门：通过 —— 无削弱条件命中'
      : `  判定闸门：未通过（命中 ${verdictBlockers.length} 条）→ 结论为「未被证明有效」`
  );
  for (const b of verdictBlockers) console.log('    · ' + b.replace(/\*\*/g, ''));
  console.log('─'.repeat(78));
}

main().catch((e) => {
  console.error('\n分析失败:', e);
  process.exit(1);
});
