/**
 * 系统一 · 宏观方向层（Regime Layer）
 * ══════════════════════════════════════════════════════════════════════
 *
 * 职责边界（这是本文件存在的全部理由）：
 *   它只回答一个问题 ——「现在只允许往哪个方向开新仓？」
 *   它**不**输出价格、**不**输出入场点、**不**输出止损、**不**关心布林带。
 *   那些全是系统二（src/strategy.js 的 analyzeSetup）的事。
 *
 * 为什么必须分开：
 *   布林带三次突破只能证明「有推进力」，不能证明「往哪边」。
 *   熊市反弹同样能连续三次突破上轨 —— 那是历史上最贵的做多信号之一。
 *   方向必须来自慢变量（减半周期 / 长周期结构 / 大事件），
 *   快变量只能决定「在既定方向上，什么时候扣扳机」。
 *
 * 三个输入源，各自投票，但**不是加权平均**：
 *   A1 减半时钟  —— 确定性、零自由度、不可调参。它给出「许可方向集」。
 *   A2 长周期结构 —— 周线/月线级别的客观状态。它决定「是否批准」。
 *   A3 大事件     —— 修正项与黑天鹅否决。
 *
 * 合成顺序是**两级**的，不是一次求和的：
 *   第一步  intent  = 减半时钟的许可方向（LONG_ONLY / NEUTRAL / SHORT_ONLY）
 *   第二步  bias    = 结构是否批准这个许可
 *
 * 关键设计判断：结构反向时输出 **NEUTRAL**，而不是反向。
 *   理由：减半周期是「4 年才验证 4 次」的低样本规律，但它的失败模式是
 *   **时限偏移**（顶到底差 3~6 个月），不是**方向反转**。逆着它做空，
 *   在 P1/P2（减半后 0~15 个月）是历史上代价最高的错误。
 *   NEUTRAL（不开新仓，只管理既有仓位）是风险最小的表达。
 *
 * 无状态设计：
 *   本模块不持有任何可变状态。任一历史日期的 regime 都能由
 *   「K 线数组 + 事件表 + asOfMs」纯函数求出，因此：
 *     · 可以逐日回测（tools/regime-check.js 就是这么验的）
 *     · 不需要状态文件，不会因为重启而丢失或漂移
 *   迟滞（hysteresis）通过**回看确认天数**实现，而不是靠记忆上一次的输出。
 */

/* ─────────────────────── 依赖：A4~A7 比特皇判据层 ─────────────────────── */

/**
 * A4 技术面补充 / A5 情绪拥挤度 / A6 量能形态 / A7 事件反应检验 在
 * regime-criteria.js 里。它们的共同点是「都需要额外的数据源」
 * （成交量、资金费历史、事件反应窗口），因此和只吃 K 线的 A1/A2 分开：
 * 数据缺失时那一层会明确弃权，而不是假装成 0 分。
 *
 * 合成函数 synthesizeReversal 只产出两个**动作**，不产出新方向：
 *   topBrake      —— 顶部刹车，禁止顺势做多（与追高禁令并列的第二道闸）
 *   bottomConfirm —— 底部确认，抬高置信度（不能把 NEUTRAL 变成 LONG_ONLY）
 */
import {
  technicalsRead,
  sentimentRead,
  volumeRead,
  eventReactionRead,
  synthesizeReversal,
} from './regime-criteria.js';
import { PHASE_AUTO } from './strategy.js';

/* ─────────────────────── 常量：减半表 ─────────────────────── */

/**
 * BTC 历次减半。date 为 UTC 日期，block 为减半高度。
 * 2028 一笔是按 21 万块的 4 年节奏外推的（已标注 estimated），
 * 它只影响「距下次减半」的显示，不影响任何判定 —— 判定只用到「距上次减半」。
 */
export const HALVINGS = [
  { date: '2012-11-28', block: 210000 },
  { date: '2016-07-09', block: 420000 },
  { date: '2020-05-11', block: 630000 },
  { date: '2024-04-20', block: 840000 },
  { date: '2028-04-15', block: 1050000, estimated: true },
];

/** 一个月的平均天数（用于把日期差换算成"月"）。取 30.44 而不是 30，长期不累积偏移。 */
const DAYS_PER_MONTH = 30.44;

/* ─────────────────────── 常量：周期相位窗口 ─────────────────────── */

/**
 * 相位窗口 —— 这是「减半时钟」的唯一权威定义，其它地方（含界面标签）都必须从它派生。
 *
 * 边界怎么定的：看历史上三个周期的顶落在减半后第几个月。
 *   2013-12-04 顶  距 2012-11-28 减半 = 12.2 个月
 *   2017-12-17 顶  距 2016-07-09 减半 = 17.3 个月
 *   2021-11-10 顶  距 2020-05-11 减半 = 18.0 个月
 *   2025-10-06 顶  距 2024-04-20 减半 = 18.5 个月
 * 中位数 17.6 个月。所以：
 *   · 6~15 个月 是主升段（趋势最干净、回撤最浅）
 *   · 15~24 个月 覆盖了「加速冲顶 + 顶后第一波下跌」——
 *     这一段顶部中位数落在其中，且顶部**是过程不是瞬间**，
 *     前后各留了余量。所以 intent = NEUTRAL：既不许追高，也不许反手做空。
 *   · 24 个月之后进入出清段。
 *
 * intent 是「许可方向集」，不是最终方向：
 *   LONG_ONLY  —— 只批准做多信号
 *   SHORT_ONLY —— 只批准做空信号
 *   NEUTRAL    —— 双向都不批准新开仓（只管理既有仓位）
 */
export const PHASE_WINDOWS = [
  {
    phase: 'ACCUMULATION', from: 0, to: 6, intent: 'LONG_ONLY', strength: 0.5,
    label: '筑底蓄势（减半后 0~6 个月）',
    note: '供给冲击尚未显现，历史上多为横盘吸筹。方向偏多但强度低，别指望立刻走出单边。',
  },
  {
    phase: 'EXPANSION', from: 6, to: 15, intent: 'LONG_ONLY', strength: 1.0,
    label: '主升扩张（减半后 6~15 个月）',
    note: '历史上最干净的一段。回撤浅、趋势连续，是顺势做多的主战场。',
  },
  {
    phase: 'BLOWOFF', from: 15, to: 24, intent: 'NEUTRAL', strength: 0.6,
    label: '加速冲顶／顶部构筑（减半后 15~24 个月）',
    note: '历史顶部中位数落在减半后 17.6 个月，就在这一段里。顶部是过程不是瞬间：既不许追高，也不许反手做空 —— 双向都容易被两头打。',
  },
  {
    phase: 'DECLINE', from: 24, to: 48, intent: 'SHORT_ONLY', strength: 1.0,
    label: '出清下跌（减半后 24~48 个月）',
    note: '顶后一年半以上的出清段。反弹很猛但很少创新高，做多的胜率明显低于做空。',
  },
];

/** 方向枚举。这是系统一的**唯一**输出取值域。 */
export const BIAS = {
  LONG_ONLY: 'LONG_ONLY',
  SHORT_ONLY: 'SHORT_ONLY',
  NEUTRAL: 'NEUTRAL',
};

export const BIAS_LABELS = {
  LONG_ONLY: '只许做多',
  SHORT_ONLY: '只许做空',
  NEUTRAL: '方向未定（不开新仓）',
};

/** 结构层各分量的权重。合计 5.5，用于把原始分归一化到 −1~+1。 */
export const STRUCTURE_WEIGHTS = {
  above200w: 2.0,
  priceVs200d: 1.0,
  ma200dSlope: 1.0,
  monthlyStructure: 1.5,
};

const STRUCTURE_WEIGHT_SUM = Object.values(STRUCTURE_WEIGHTS).reduce((a, b) => a + b, 0);

/* ─────────────────────── 工具 ─────────────────────── */

const MS_PER_DAY = 86400000;

/** 把 API 原始 K 线转成宏观层用的数字形态 [{t,o,h,l,c,v}]。 */
export function barsOf(raw) {
  return (raw || []).map((k) => ({
    t: Number(k.t),
    o: Number(k.o),
    h: Number(k.h),
    l: Number(k.l),
    c: Number(k.c),
    v: Number(k.v ?? 0),
  }));
}

/** 只留 t <= asOfMs 的 K 线 —— 回测的生命线：绝不许看到未来。 */
function upto(bars, asOfMs) {
  if (!bars) return [];
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t <= asOfMs) lo = mid + 1;
    else hi = mid;
  }
  return bars.slice(0, lo);
}

function mean(arr) {
  if (!arr.length) return null;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

function lastN(arr, n) {
  return arr.length <= n ? arr.slice() : arr.slice(arr.length - n);
}

/* ─────────────────────── A1 减半时钟 ─────────────────────── */

/**
 * 减半时钟 —— 确定性推算，零自由度、不可调参。
 *
 * 这是整个方向层里**唯一**一个不依赖任何市场数据、也无法被"调参调出来"的输入。
 * 价格涨得再猛，相位也不会动。它的作用就是给方向提供一个与价格无关的锚。
 *
 * @param {number} nowMs 求值时刻（毫秒）
 * @returns {object} { last, next, monthsSince, monthsToNext, phase, label, intent, strength, note, progress }
 */
export function halvingClock(nowMs) {
  const ts = HALVINGS.map((h) => ({ ...h, ms: Date.parse(h.date + 'T00:00:00Z') }));

  let last = null;
  let next = null;
  for (const h of ts) {
    if (h.ms <= nowMs) last = h;
    else if (next === null) next = h;
  }
  if (!last) {
    // 2012 年之前：没有可用的历史锚，明确说"无锚"而不是硬套一个相位
    return {
      last: null, next: ts[0], monthsSince: null, monthsToNext: null,
      phase: null, label: '减半前（无周期锚）', intent: BIAS.NEUTRAL, strength: 0,
      note: '当前时刻早于首次减半，没有可用的周期锚，方向层不表态。',
      progress: 0,
    };
  }

  const monthsSince = (nowMs - last.ms) / MS_PER_DAY / DAYS_PER_MONTH;
  const monthsToNext = next ? (next.ms - nowMs) / MS_PER_DAY / DAYS_PER_MONTH : null;

  // 落入哪个窗口；超出最后一个窗口的 to 时按最后一个窗口处理（不返回 null，
  // 否则周期末端会出现"无相位"的空档，方向层直接哑掉）
  let win = PHASE_WINDOWS[PHASE_WINDOWS.length - 1];
  for (const w of PHASE_WINDOWS) {
    if (monthsSince >= w.from && monthsSince < w.to) {
      win = w;
      break;
    }
  }

  return {
    last: { date: last.date, block: last.block },
    next: next ? { date: next.date, block: next.block, estimated: Boolean(next.estimated) } : null,
    monthsSince: round(monthsSince, 1),
    monthsToNext: monthsToNext === null ? null : round(monthsToNext, 1),
    phase: win.phase,
    label: win.label,
    intent: win.intent,
    strength: win.strength,
    note: win.note,
    progress: round((monthsSince - win.from) / (win.to - win.from), 3),
  };
}

function round(v, d) {
  if (!Number.isFinite(v)) return null;
  const p = 10 ** d;
  return Math.round(v * p) / p;
}

/* ─────────────────────── A2 长周期结构 ─────────────────────── */

/**
 * 长周期结构 —— 周线/月线级别的客观状态。
 *
 * 四个分量，各有权重（见 STRUCTURE_WEIGHTS）：
 *   1. 价格 vs 200 周均线 —— 周期地板，权重最高（2.0）。历史上跌破并站不回来
 *      基本就是熊市确认，所以给它最大的话语权。
 *   2. 价格 vs 200 日均线 —— 中期多空，权重 1.0。
 *   3. 200 日均线斜率（对 20 日前）—— 趋势的方向而不只是位置，权重 1.0。
 *   4. 月线结构（最近两根已收月线的高低点）—— 权重 1.5。
 *
 * 注意「已收月线」：正在形成的那根月线必须排除，否则一根跳空高开的月初
 * 就能把月线结构判成多头 —— 那是典型的前视偏差。
 *
 * @param {object} args { daily, weekly, monthly, asOfMs, cfg }
 * @returns {object} { score, normalized, verdict, ma200w, above200w, ma200d,
 *                     priceVs200d, ma200dSlopePct, monthlyStructure, drawdownPct,
 *                     drawdownZone, extensionVs200d, chaseMaxExtensionPct,
 *                     chaseForbidden, components, usable, barsUsed }
 */
export function structureRead({ daily = [], weekly = [], monthly = [], asOfMs = Date.now(), cfg = {} }) {
  const d = upto(daily, asOfMs);
  const w = upto(weekly, asOfMs);
  const m = upto(monthly, asOfMs);

  const price = d.length ? d[d.length - 1].c : null;
  const components = [];
  let score = 0;

  // ① 价格 vs 200 周均线
  const wCloses = w.map((x) => x.c);
  let ma200w = null;
  let above200w = null;
  if (wCloses.length >= 200) {
    ma200w = mean(lastN(wCloses, 200));
    above200w = price !== null && ma200w !== null ? price > ma200w : null;
    if (above200w !== null) {
      const vote = above200w ? 1 : -1;
      score += STRUCTURE_WEIGHTS.above200w * vote;
      components.push({
        key: 'above200w', label: '价格 vs 200 周均线', weight: STRUCTURE_WEIGHTS.above200w, vote,
        value: ma200w,
        detail: `200 周均线 ${fmt(ma200w)}，价格在其${above200w ? '上' : '下'}方 ${pct(price / ma200w - 1)}。这是周期地板，跌破且站不回来通常意味着熊市确认。`,
      });
    } else {
      components.push({ key: 'above200w', label: '价格 vs 200 周均线', weight: STRUCTURE_WEIGHTS.above200w, vote: 0, value: ma200w, detail: '价格缺失，无法判断。' });
    }
  } else {
    components.push({
      key: 'above200w', label: '价格 vs 200 周均线', weight: STRUCTURE_WEIGHTS.above200w, vote: 0, value: null,
      detail: `周线只有 ${wCloses.length} 根，不足 200 根，本分量弃权（不猜、不按 0 处理成中性以外的东西）。`,
    });
  }

  // ② 价格 vs 200 日均线
  const dCloses = d.map((x) => x.c);
  let ma200d = null;
  let priceVs200d = null;
  if (dCloses.length >= 200) {
    ma200d = mean(lastN(dCloses, 200));
    priceVs200d = price > ma200d;
    const vote = priceVs200d ? 1 : -1;
    score += STRUCTURE_WEIGHTS.priceVs200d * vote;
    components.push({
      key: 'priceVs200d', label: '价格 vs 200 日均线', weight: STRUCTURE_WEIGHTS.priceVs200d, vote,
      value: ma200d,
      detail: `200 日均线 ${fmt(ma200d)}，价格在其${priceVs200d ? '上' : '下'}方 ${pct(price / ma200d - 1)}。`,
    });
  } else {
    components.push({ key: 'priceVs200d', label: '价格 vs 200 日均线', weight: STRUCTURE_WEIGHTS.priceVs200d, vote: 0, value: null, detail: `日线只有 ${dCloses.length} 根，不足 200 根，弃权。` });
  }

  // ③ 200 日均线斜率（对 20 个交易日前）
  let ma200dSlopePct = null;
  let slopeVote = 0;
  if (dCloses.length >= 220) {
    const nowMA = mean(lastN(dCloses, 200));
    const prevMA = mean(dCloses.slice(dCloses.length - 220, dCloses.length - 20));
    ma200dSlopePct = nowMA / prevMA - 1;
    slopeVote = ma200dSlopePct > 0 ? 1 : -1;
    score += STRUCTURE_WEIGHTS.ma200dSlope * slopeVote;
    components.push({
      key: 'ma200dSlope', label: '200 日均线斜率（20 日前）', weight: STRUCTURE_WEIGHTS.ma200dSlope, vote: slopeVote,
      value: ma200dSlopePct,
      detail: `20 日内 200 日均线变化 ${pct(ma200dSlopePct)}，${slopeVote > 0 ? '向上' : '向下'}。位置决定多空，斜率决定趋势是否还在延续。`,
    });
  } else {
    components.push({ key: 'ma200dSlope', label: '200 日均线斜率（20 日前）', weight: STRUCTURE_WEIGHTS.ma200dSlope, vote: 0, value: null, detail: '日线不足 220 根，弃权。' });
  }

  // ④ 月线结构 —— 只用**已收盘**的月线
  const startOfMonth = (t) => {
    const x = new Date(t);
    return Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), 1);
  };
  const currentMonthKey = d.length ? startOfMonth(asOfMs) : null;
  const closedMonths = m.filter((x) => startOfMonth(x.t) < currentMonthKey);
  let monthlyStructure = null;
  let monthlyVote = 0;
  if (closedMonths.length >= 2) {
    const a = closedMonths[closedMonths.length - 2];
    const b = closedMonths[closedMonths.length - 1];
    const hh = b.h > a.h;
    const hl = b.l > a.l;
    const lh = b.h < a.h;
    const ll = b.l < a.l;
    if (hh && hl) monthlyVote = 1;
    else if (lh && ll) monthlyVote = -1;
    else monthlyVote = 0;
    monthlyStructure = { prev: { t: a.t, h: a.h, l: a.l }, last: { t: b.t, h: b.h, l: b.l }, higherHigh: hh, higherLow: hl };
    score += STRUCTURE_WEIGHTS.monthlyStructure * monthlyVote;
    components.push({
      key: 'monthlyStructure', label: '月线结构（最近两根已收月线）', weight: STRUCTURE_WEIGHTS.monthlyStructure, vote: monthlyVote,
      value: monthlyVote,
      detail: `${ym(a.t)} → ${ym(b.t)}：高点 ${hh ? '抬高' : '降低'}、低点 ${hl ? '抬高' : '降低'}，判定${
        monthlyVote > 0 ? '多头结构' : monthlyVote < 0 ? '空头结构' : '结构不明（高低点未同向）'
      }。正在形成的当月不参与判定，避免月初跳空直接扭转月线结论。`,
    });
  } else {
    components.push({ key: 'monthlyStructure', label: '月线结构（最近两根已收月线）', weight: STRUCTURE_WEIGHTS.monthlyStructure, vote: 0, value: null, detail: '已收月线不足 2 根，弃权。' });
  }

  // 回撤位置 —— 不作为方向投票，只作为**信息**展示（离历史最高多远）。
  let peak = null;
  for (const x of d) if (peak === null || x.c > peak) peak = x.c;
  const drawdownPct = price !== null && peak ? price / peak - 1 : null;
  let drawdownZone = null;
  if (drawdownPct !== null) {
    if (drawdownPct > -0.2) drawdownZone = 'NEAR_ATH';
    else if (drawdownPct > -0.45) drawdownZone = 'CORRECTION';
    else drawdownZone = 'DEEP';
  }

  // 追高禁令 —— 判据是"价格高于 200 日均线的幅度"，而不是"离历史最高多近"。
  //
  // 为什么必须换掉旧判据：
  //   牛市里价格天然长期贴着历史最高点（浅回撤是牛市的定义之一），
  //   用 drawdownPct > -20% 作禁令，等于整段主升浪都禁止开多 —— 把趋势策略最该
  //   赚的那段行情直接封死。回测里 15 个完整形态有 11 个栽在这条规则上。
  //   改为看"偏离均值多远"：偏离过大才说明短期过热、追进去赔率差。
  //
  // 注意：这条禁令只对"顺势做多"生效，且必须在 gate 里独立检查 ——
  //   不能依赖调用方先把 allowLong 置 false，否则闸门会被整道跳过。
  const chaseMaxExtensionPct = cfg.chaseMaxExtensionPct ?? 0.5;
  const extensionVs200d = ma200d !== null && price !== null ? price / ma200d - 1 : null;
  const chaseForbidden = extensionVs200d !== null && extensionVs200d > chaseMaxExtensionPct;

  const normalized = STRUCTURE_WEIGHT_SUM > 0 ? score / STRUCTURE_WEIGHT_SUM : 0;
  const usable = components.filter((c) => c.vote !== 0).length;

  return {
    score: round(score, 2),
    normalized: round(normalized, 3),
    verdict: normalized >= 0.2 ? 'BULL' : normalized <= -0.2 ? 'BEAR' : 'MIXED',
    ma200w: ma200w === null ? null : round(ma200w, 2),
    above200w,
    ma200d: ma200d === null ? null : round(ma200d, 2),
    priceVs200d,
    ma200dSlopePct: ma200dSlopePct === null ? null : round(ma200dSlopePct, 5),
    monthlyStructure,
    drawdownPct: drawdownPct === null ? null : round(drawdownPct, 4),
    drawdownZone,
    /** 价格高于 200 日均线的幅度。追高禁令的判据就是它 */
    extensionVs200d: extensionVs200d === null ? null : round(extensionVs200d, 4),
    chaseMaxExtensionPct,
    chaseForbidden,
    components,
    usable,
    barsUsed: { daily: d.length, weekly: w.length, monthly: closedMonths.length },
  };
}

/* ─────────────────────── A3 大事件与流动性 ─────────────────────── */

/**
 * 事件打分 —— 维护型事件表 + 时间衰减。
 *
 * 每条事件 { id, date, kind, weight, halfLifeDays, note }：
 *   有效权重 = weight × 0.5 ^ (距今天数 / halfLifeDays)
 *
 * 为什么用半衰期而不是"过期作废"：市场对一件事的定价是逐渐消化的。
 * ETF 通过的第一周和第一百周，影响完全不同 —— 但它们都"还没过期"。
 * 半衰期让这件事连续、可解释、可回测。
 *
 * 未来事件（date > now）：有效权重记 0，但**列出来**并标记 pending，
 * 因为它们是已知的日程（下次减半、议息），用户需要看到。
 * 把未来事件按已实现计入权重是典型的前视偏差，这里明确禁止。
 *
 * @param {Array} events 事件表
 * @param {number} nowMs
 * @param {object} cfg { shockWindowDays, shockCooldownDays }
 */
export function scoreEvents(events = [], nowMs = Date.now(), cfg = {}) {
  const shockWindowDays = cfg.shockWindowDays ?? 30;
  const cooldownDays = cfg.shockCooldownDays ?? 7;

  const items = [];
  let net = 0;
  const shocks = [];

  for (const e of events) {
    if (!e || !e.date) continue;
    const ms = Date.parse(e.date + 'T00:00:00Z');
    if (!Number.isFinite(ms)) continue;

    const ageDays = (nowMs - ms) / MS_PER_DAY;
    const halfLife = Number(e.halfLifeDays ?? 180);
    const weight = Number(e.weight ?? 0);

    let effective = 0;
    let pending = false;
    if (ageDays < 0) {
      pending = true; // 未来事件：只看不做数
    } else if (ageDays === 0) {
      effective = weight;
    } else {
      effective = weight * 0.5 ** (ageDays / halfLife);
    }

    net += effective;

    const item = {
      id: e.id,
      date: e.date,
      kind: e.kind ?? 'other',
      weight,
      halfLifeDays: halfLife,
      ageDays: round(ageDays, 1),
      effective: round(effective, 4),
      pending,
      note: e.note ?? '',
    };
    items.push(item);

    // 黑天鹅：负向且仍然"活着"的重事件
    if (e.kind === 'shock' && effective <= -1 && ageDays >= 0) {
      shocks.push({ ...item, cooldownUntil: new Date(ms + (cooldownDays + 0) * MS_PER_DAY).toISOString().slice(0, 10), activeDays: Math.floor(ageDays) });
    }
  }

  // 冷却窗口内（事件发生后的 shockWindowDays 天内）才继续压制新开仓
  const activeShock = shocks
    .filter((s) => s.ageDays <= shockWindowDays)
    .sort((a, b) => a.ageDays - b.ageDays)[0] || null;

  return {
    items: items.sort((a, b) => (a.date < b.date ? 1 : -1)),
    net: round(net, 4),
    shock: activeShock
      ? {
          active: true,
          id: activeShock.id,
          date: activeShock.date,
          ageDays: activeShock.ageDays,
          note: activeShock.note,
          /* cooldownUntil 原先只算不返回 —— 于是 config 里的 shockCooldownDays
           * 是一个「写了但谁都不读」的字段。这里把它带出来，配置才有意义。 */
          cooldownUntil: activeShock.cooldownUntil,
          detail: `黑天鹅冷却中（事件发生在 ${activeShock.ageDays} 天前，窗口 ${shockWindowDays} 天）—— 方向层强制 NEUTRAL，只管理既有仓位。`,
        }
      : { active: false },
    shockWindowDays,
  };
}

/* ─────────────────────── 单日求值 ─────────────────────── */

/**
 * 求某一时刻的"原始" regime —— 不含迟滞，纯合成。
 * 迟滞在 computeRegime 里通过回看实现。
 *
 * 合成顺序（三级，不是一次加权求和）：
 *   ① intent  —— 减半时钟的许可方向集（与价格无关）
 *   ② bias    —— 结构层是否批准这个许可；不批准 → NEUTRAL（不反向）
 *   ③ 闸门    —— 追高禁令（位置） + 顶部刹车（行为）
 * A4~A7 的判据层不参与①②，它们只影响③与置信度 —— 详见 synthesizeReversal。
 *
 * @param {object} args { daily, weekly, monthly, events, fundingSeries, asOfMs, cfg }
 */
export function regimeAt({
  daily = [],
  weekly = [],
  monthly = [],
  events = [],
  fundingSeries = [],
  /**
   * M1~M6 的宏观读数（由 src/macro-sources.js 采集、evaluateMacroCriteria 求值）。
   * 默认空数组 —— 取不到就是"全部弃权"，与以前的 `implemented:false` 行为一致，
   * 所以这个参数是向后兼容的：不传它，结果和接数据之前完全一样。
   */
  macro = [],
  asOfMs = Date.now(),
  cfg = {},
}) {
  const clock = halvingClock(asOfMs);
  const structure = structureRead({ daily, weekly, monthly, asOfMs, cfg });
  const ev = scoreEvents(events, asOfMs, cfg);

  // A4~A7：比特皇判据层。每一项都能独立弃权，弃权原因会一路带到界面上。
  const technicals = technicalsRead({ daily, asOfMs, cfg, monthsSinceHalving: clock.monthsSince });
  const sentiment = sentimentRead({ fundingSeries, daily, asOfMs, cfg });
  const volume = volumeRead({ daily, asOfMs, cfg });
  const reaction = eventReactionRead({ events, daily, asOfMs, cfg });

  const reasons = [];
  let bias = BIAS.NEUTRAL;
  let approved = false;

  // 第一步：许可方向集
  const intent = clock.intent;

  // 第二步：结构批准
  if (ev.shock.active) {
    bias = BIAS.NEUTRAL;
    reasons.push(ev.shock.detail);
  } else if (intent === BIAS.NEUTRAL) {
    bias = BIAS.NEUTRAL;
    reasons.push(`周期相位「${clock.label}」双向都不批准新开仓。${clock.note}`);
  } else {
    const wantLong = intent === BIAS.LONG_ONLY;
    const aligned = wantLong ? structure.verdict === 'BULL' : structure.verdict === 'BEAR';
    const opposed = wantLong ? structure.verdict === 'BEAR' : structure.verdict === 'BULL';
    const mixed = structure.verdict === 'MIXED';

    if (aligned) {
      bias = intent;
      approved = true;
      reasons.push(`结构读数「${wantLong ? '多头' : '空头'}」（归一化 ${structure.normalized}）与周期相位一致，批准 ${BIAS_LABELS[intent]}。`);
    } else if (opposed) {
      bias = BIAS.NEUTRAL;
      reasons.push(
        `**逆周期**：周期相位要求 ${BIAS_LABELS[intent]}，但结构读数已转为「${wantLong ? '空头' : '多头'}」（归一化 ${structure.normalized}）。` +
          `历史上这种组合的失败模式是"时限偏移"而不是"方向反转"，所以输出 NEUTRAL（不开新仓）而不是反向 —— 逆着周期做是代价最高的错误。`
      );
    } else {
      bias = intent;
      reasons.push(`结构读数不明（归一化 ${structure.normalized}），既不支持也不反对。按周期相位给 ${BIAS_LABELS[intent]}，但置信度降级。`);
    }
  }

  // 第三步 · 闸门 A：追高禁令（看**位置** —— 价格离长期均线多远）
  let chaseBlocked = false;
  if (bias === BIAS.LONG_ONLY && structure.chaseForbidden) {
    chaseBlocked = true;
    reasons.push(
      `价格高于 200 日均线 ${pct(structure.extensionVs200d)}，超过追高上限 ${pct(structure.chaseMaxExtensionPct)} —— 方向仍是多的，但已经过热，` +
        `不在这里进场。注意判据是「离长期均线多远」而不是「离历史最高多近」：牛市里价格本来就该贴着最高点走，那不是风险。`
    );
  }

  // 第三步 · 闸门 B：顶部刹车（看**行为** —— 量能派发 + 消息反应 + 拥挤度）
  // 与追高禁令是姊妹规则，看的东西完全不同：一个位置不热但市场已经开始派发的顶，
  // 只有这道闸能挡住。合成逻辑在 regime-criteria.js 的 synthesizeReversal 里。
  const reversal = synthesizeReversal({ clock, technicals, sentiment, volume, reaction, macro, cfg });
  const topBrake = reversal.topBrake;
  if (topBrake) {
    reasons.push(
      `**顶部刹车**：量能/事件反应/拥挤度中 ${reversal.topVotes} 项指向见顶 —— ` +
        reversal.evidence
          .filter((x) => x.dir < 0)
          .map((x) => `${x.layer}：${x.text}`)
          .join('；') +
        `。方向层仍许可做多，但市场行为显示派发，不在这里开新多。`
    );
  }
  if (reversal.notes.length) reasons.push(...reversal.notes);

  // A4 技术面的牛转熊是趋势类判据，独立于反转类证据，单独提示
  if (technicals.bearSignal) {
    reasons.push(`**牛转熊确认**（A4）：${technicals.detail}`);
  } else if (technicals.bearPending) {
    reasons.push(`牛转熊**待确认**（A4）：${technicals.notes.join(' ')}`);
  }

  // 置信度
  let confidence = 'LOW';
  if (approved && structure.usable >= 3) confidence = 'HIGH';
  else if (approved || structure.usable >= 2) confidence = 'MEDIUM';
  if (ev.shock.active || intent === BIAS.NEUTRAL) confidence = 'LOW';

  // 比特皇判据层的置信度修正 —— 只有「同向强化」和「反向刹车」，没有「提升方向」。
  if (reversal.bottomConfirm && confidence === 'MEDIUM') confidence = 'HIGH';
  if (reversal.bottomConfirm) {
    reasons.push(
      `A4~A7 判据层给出 ${reversal.bottomVotes} 项见底证据，与方向层许可一致 → 置信度${reversal.bottomConfirm && confidence === 'HIGH' ? '上调至 HIGH' : '维持'}。`
    );
  }
  if (topBrake) confidence = 'LOW';

  // 判据层的可用性汇总 —— 弃权必须显形。用户有权知道哪几条判据这次根本没跑。
  const unavailable = reversal.evidence.filter((x) => !x.available);
  if (unavailable.length) {
    reasons.push(
      `本次有 ${unavailable.length} 条判据**弃权**（不是通过）：${unavailable.map((x) => `${x.layer}`).join('、')}。` +
        `弃权意味着该判据的数据源这次不可用，它既没有支持也没有反对当前方向 —— 别把「没报错」当成「看过了」。`
    );
  }

  const scoreEventsContribution = ev.net;
  if (Math.abs(scoreEventsContribution) >= 0.5) {
    reasons.push(
      `事件层净权重 ${scoreEventsContribution > 0 ? '+' : ''}${scoreEventsContribution}（${ev.items.filter((i) => Math.abs(i.effective) >= 0.1).length} 条仍在起作用）${
        scoreEventsContribution > 0 ? '，偏多' : '，偏空'
      }。目前事件层只作为修正项与黑天鹅闸门，不单独决定方向。`
    );
  }

  return {
    asOf: new Date(asOfMs).toISOString(),
    bias,
    biasLabel: BIAS_LABELS[bias],
    confidence,
    intent,
    intentLabel: BIAS_LABELS[intent],
    approved,
    chaseBlocked,
    // 比特皇判据层（A4~A7）的完整明细 + 合成结果
    technicals,
    sentiment,
    volume,
    reaction,
    reversal,
    topBrake,
    clock,
    structure,
    events: ev,
    /**
     * M1~M6 的宏观读数（原样带出，含弃权项）。
     * 注意：这是**当日快照**，无法回溯 —— 见 computeRegime 里的防前视说明。
     */
    macro: macro || [],
    reasons,
    // 给系统二的门禁用的方向常数：0 = 不许开新仓
    //
    // allowLong 必须**同时**过两道闸：
    //   · !chaseBlocked —— 位置闸：价格不能离 200 日均线太远（追高）
    //   · !topBrake     —— 行为闸：量能/消息反应/拥挤度不能指向派发
    // 这两道闸看的东西正交，任何一道单独成立都不该开新多。
    // allowShort 没有对应闸门 —— 做空的两类风险（轧空、政策底）都不在这套
    // 判据的射程内，与其加一道没有依据的闸，不如明确说这里没做。
    allowLong: bias === BIAS.LONG_ONLY && !chaseBlocked && !topBrake,
    allowShort: bias === BIAS.SHORT_ONLY,
  };
}

/* ─────────────────────── 带迟滞的求值 ─────────────────────── */

/**
 * 完整的 regime —— 在 regimeAt 之上加**迟滞**（hysteresis）。
 *
 * 为什么需要迟滞：方向层若每天都可能翻转，它就不再是"慢变量"，
 * 而变成一个更迟钝的噪音源。真实市场上"结构读数"会在临界值附近来回抖，
 * 于是每天一个新的 bias，系统二的门禁跟着抖 —— 比没有方向层更糟。
 *
 * 实现方式：**回看确认天数**，而不是记忆上一次输出。
 *   · 只有当新 bias 在最近 confirmDays 天内**每一天都成立**，才接受翻转。
 *   · 一旦接受，minHoldDays 天内不再接受下一次翻转。
 * 这样做的好处：整个函数保持纯函数、无状态、可回测、可重放。
 *
 * 代价（必须说清楚）：回看天数意味着 regime 的反应会延迟 confirmDays 天，
 * 而且每次调用要做 confirmDays+1 次全量求值。由于都是数组切片 + 一次
 * 遍历，"贵"的量级是毫秒，换来的是可回测性 —— 值。
 *
 * @param {object} args { daily, weekly, monthly, events, fundingSeries, nowMs, cfg }
 */
export function computeRegime({
  daily = [],
  weekly = [],
  monthly = [],
  events = [],
  fundingSeries = [],
  macro = [],
  nowMs = Date.now(),
  cfg = {},
}) {
  const confirmDays = cfg.confirmDays ?? 5;
  const minHoldDays = cfg.minHoldDays ?? 20;

  /*
   * ⚠ 宏观读数只喂给**今天**，绝不喂给回看的历史日。
   *
   * 为什么：M1~M6 的读数（恐慌贪婪、ETF 流量、DXY…）拿到的都是"现在"的值，
   * 没有可回溯的历史。如果把这**同一个当前值**也传给 `nowMs - k*天` 的历史求值，
   * 等于假设"5 天前的人也知道今天的恐慌贪婪指数" —— 这是典型的前视偏差，
   * 会让迟滞确认看上去比实际更稳。宁可让历史日全部按弃权处理。
   *
   * 代价（说清楚）：宏观票只影响今天的 topVotes/bottomVotes，
   * 因此它对 `stableDays` 不产生贡献 —— 也就是宏观读数无法独自促成一次方向翻转。
   * 这与它们的定位一致：加分项与刹车项，不是方向开关。
   */
  const today = regimeAt({ daily, weekly, monthly, events, fundingSeries, macro, asOfMs: nowMs, cfg });
  const rawBias = today.bias;

  // 回看 confirmDays 天：每天一个求值（**不带 macro** —— 见上面的防前视说明）
  const series = [];
  for (let k = 0; k <= confirmDays; k++) {
    const at = nowMs - k * MS_PER_DAY;
    const r = regimeAt({ daily, weekly, monthly, events, fundingSeries, asOfMs: at, cfg });
    series.push({ at: new Date(at).toISOString().slice(0, 10), bias: r.bias, confidence: r.confidence });
  }
  series.reverse(); // 时间正序

  // 稳定天数：从今天往回数，连续等于 rawBias 的天数
  let stableDays = 0;
  for (let k = 0; k < series.length; k++) {
    if (series[series.length - 1 - k].bias === rawBias) stableDays++;
    else break;
  }

  // 上一次翻转发生在多少天前 —— 往回找第一个与 rawBias 不同的点
  let holdDays = stableDays;
  for (let k = 0; k < series.length; k++) {
    if (series[series.length - 1 - k].bias !== rawBias) break;
    holdDays = k + 1;
  }

  const confirmed = rawBias === BIAS.NEUTRAL || stableDays >= confirmDays;
  const heldLongEnough = stableDays >= Math.min(minHoldDays, series.length);

  // 生效的 bias：
  //   · NEUTRAL 立刻生效（收起仓位是最安全的动作，不需要确认）
  //   · 非 NEUTRAL 需要 confirmDays 天确认
  const effective = rawBias === BIAS.NEUTRAL ? BIAS.NEUTRAL : confirmed ? rawBias : BIAS.NEUTRAL;

  const pendingFlip = rawBias !== BIAS.NEUTRAL && !confirmed;

  const notes = [];
  if (pendingFlip) {
    notes.push(`方向层正在由「${BIAS_LABELS[effective]}」切换为「${BIAS_LABELS[rawBias]}」，已连续 ${stableDays}/${confirmDays} 天成立，还差 ${confirmDays - stableDays} 天确认。确认期内不批准新开仓 —— 避免方向层自己在临界值附近抖。`);
  }
  if (confirmed && !heldLongEnough) {
    notes.push(`本次方向已成立 ${stableDays} 天，未满最短持有 ${minHoldDays} 天。`);
  }
  if (effective !== rawBias) {
    notes.push(`原始读数 ${BIAS_LABELS[rawBias]} 尚未通过 ${confirmDays} 天确认，对外输出的方向仍按 NEUTRAL 处理。`);
  }

  return {
    ...today,
    bias: effective,
    biasLabel: BIAS_LABELS[effective],
    rawBias,
    rawBiasLabel: BIAS_LABELS[rawBias],
    pendingFlip,
    stableDays,
    confirmDays,
    minHoldDays,
    confidence: pendingFlip ? 'LOW' : today.confidence,
    hysteresisNotes: notes,
    trail: series,
    // 迟滞后的方向要重算门禁常数 —— 不能直接沿用 today 的。
    // 否则会出现「bias 已被迟滞降成 NEUTRAL，但 allowLong 还是 true」的矛盾状态，
    // 而系统二的门禁读的是 allowLong。方向层自己说「不开新仓」、门禁却放行，
    // 这是最难排查的一类 bug：两个字段各自都"对"，只是不同步。
    allowLong: effective === BIAS.LONG_ONLY && !today.chaseBlocked && !today.topBrake,
    allowShort: effective === BIAS.SHORT_ONLY,
  };
}

/* ─────────────────────── 周期相位与门槛的桥接 ─────────────────────── */

/**
 * 由减半时钟推出现役配置用的 cyclePhase。
 *
 * 现役系统里 cyclePhase 是一个查询参数（`?phase=ACCUMULATION`），
 * 用来决定 minExpectedMoveBps（预期波动门槛）的下限。问题是：
 * 手填值与真实周期位置没有任何约束关系，默认值 ACCUMULATION 会让门槛
 * 一直停在 16%，而周期可能早已走到需要 20% 门槛的阶段。
 *
 * 更隐蔽的是**分叉**：方向层（`computeRegime`）是直接读 `halvingClock` 的，
 * 完全不看这个手填值。所以默认状态下会出现「方向按 DECLINE 算（只许做空）、
 * 门槛按 ACCUMULATION 算（16%）」—— 两个字段各自都"对"，只是不同步，
 * 而这类不同步最难排查。
 *
 * 现在的语义：
 *   · `manual` 缺省 / 空 / `PHASE_AUTO`  → 按时钟推算，`auto: true`、`stale: false`
 *   · `manual` 是四个具体相位之一        → 人工值优先，与推算值不一致时 `stale: true`
 *   · `manual` 是其他任意字符串          → 当作没填（与缺省同），并如实标出来
 *
 * @param {number} nowMs
 * @param {string} [manual] 人工设定的相位，或 PHASE_AUTO
 */
export function derivePhase(nowMs, manual) {
  const clock = halvingClock(nowMs);
  const derived = clock.phase;
  const derivedLabel = PHASE_WINDOWS.find((w) => w.phase === derived)?.label || derived;

  /* 归一化：去空白 + 转大写。
   * 三个入口的宽容度必须一致 —— 前端和每日任务都会先 toUpperCase()，
   * 而 HTTP 的 `?phase=auto` 是原始字符串。不在这里统一的话，
   * `?phase=auto`（小写）会被判成"未知值并已改用推算值"，
   * 而它实际表达的正是"用推算值"—— 报了警却什么也没发生，最消耗信任。 */
  const raw = typeof manual === 'string' ? manual.trim() : manual;
  const norm = typeof raw === 'string' && raw !== '' ? raw.toUpperCase() : raw;
  const isKnownPhase = PHASE_WINDOWS.some((w) => w.phase === norm);

  if (!isKnownPhase) {
    /* 自动模式（也是未知值的兜底）。刻意**不**把它做成"静默降级"：
     * 传了一个拼错的值，用户以为自己指定了相位，实际用的是时钟值 ——
     * 这必须能被看出来，所以把 `requested` 一起带出去。 */
    const requested = norm == null || norm === '' ? null : String(raw);
    const unknown = requested !== null && norm !== PHASE_AUTO;
    return {
      phase: derived,
      derived,
      derivedLabel,
      manual: null,
      auto: true,
      requested,
      unknown,
      stale: false,
      monthsSince: clock.monthsSince,
      label: clock.label,
      detail: unknown
        ? `相位参数「${requested}」不是已知相位，已改用减半时钟推算的「${derived}」（距上次减半 ${clock.monthsSince} 个月）。`
        : `相位由减半时钟推算：距上次减半 ${clock.monthsSince} 个月，落在「${derivedLabel}」，波动门槛按此取。`,
    };
  }

  return {
    phase: norm,
    derived,
    derivedLabel,
    manual: norm,
    auto: false,
    requested: String(raw),
    unknown: false,
    stale: norm !== derived,
    monthsSince: clock.monthsSince,
    label: clock.label,
    detail:
      norm !== derived
        ? `人工设定相位「${norm}」与减半时钟推算的「${derived}」（距上次减半 ${clock.monthsSince} 个月）不一致。人工值优先，但这意味着波动门槛可能偏离周期位置。`
        : '人工设定与减半时钟推算一致。',
  };
}

/* ─────────────────────── 展示用格式化 ─────────────────────── */

function fmt(v) {
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function pct(v) {
  if (!Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`;
}

function ym(t) {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
