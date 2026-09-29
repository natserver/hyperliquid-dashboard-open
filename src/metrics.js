/**
 * 绩效指标 —— 从真实成交与权益曲线里算出可核对的绩效数字。
 *
 * 设计要点：成交归集用 Hyperliquid 提供的 startPosition 字段做「持仓生命周期」切分，
 * 而不是把每笔成交都当成一次独立盈亏。区别很大：一次开仓被 5 笔成交吃满、
 * 平仓又分 3 笔，逐笔统计会得出 8 笔交易和错误的胜率；按生命周期归集才是 1 笔。
 *
 *   startPosition = 该笔成交前的持仓量（有符号）
 *   成交后持仓   = startPosition + (side === 'B' ? +sz : -sz)
 *   从 0 到非 0 = 开仓；从非 0 到 0 = 平仓；符号翻转 = 先平后开（反手）
 */

import { parseWad } from './strategy.js';

/** side: 'B' 买入、'A' 卖出 */
const signedDelta = (fill) => (fill.side === 'B' ? parseWad(fill.sz) : -parseWad(fill.sz));

/**
 * 把逐笔成交归集成「交易」列表。
 * @param {Array} fills 原始 userFills 数组
 * @returns {Array} 交易列表，按平仓时间升序
 */
export function buildTrades(fills) {
  if (!Array.isArray(fills) || fills.length === 0) return [];

  // 按币种分组，组内按时间（同时间用 tid）稳定排序 —— 顺序错了整条持仓链就断了
  const byCoin = new Map();
  for (const f of fills) {
    if (!byCoin.has(f.coin)) byCoin.set(f.coin, []);
    byCoin.get(f.coin).push(f);
  }

  const trades = [];

  for (const [coin, list] of byCoin) {
    list.sort((a, b) => a.time - b.time || (a.tid || 0) - (b.tid || 0));

    // 同一笔成交可能在「反手」时被平仓腿和开仓腿各引用一次。
    // 用两个集合保证 closedPnl 和 fee 各自只被计入一次 —— 否则反手会被重复计账。
    const consumedPnl = new Set();
    const consumedFee = new Set();
    const keyOf = (f) => (f.tid != null ? `tid:${f.tid}` : `${f.hash}:${f.oid}:${f.time}`);
    const takePnl = (f) => {
      const k = keyOf(f);
      if (consumedPnl.has(k)) return 0n;
      consumedPnl.add(k);
      return parsePnl(f);
    };
    const takeFee = (f) => {
      const k = keyOf(f);
      if (consumedFee.has(k)) return 0n;
      consumedFee.add(k);
      return feeOf(f);
    };

    let open = null;

    /** 用一笔成交把新仓立起来。qty 为该笔新增的持仓量（正数）。 */
    const startTrade = (f, qty, isLong) => {
      open = {
        coin,
        isLong,
        openTime: f.time,
        openPrice: parseWad(f.px),
        posNotional: parseWad(f.px) * qty, // 持仓的入场名义价值（用于算均价）
        openQty: qty,
        peakQty: qty,
        closedPnlTotal: takePnl(f),
        fees: takeFee(f),
        fillCount: 1,
        dirLabel: f.dir || '',
      };
    };

    /** 把当前仓平掉并落库。 */
    const closeTrade = (f) => {
      if (!open) return;
      open.closedPnlTotal += takePnl(f);
      open.fees += takeFee(f);
      open.fillCount += 1;
      open.closeTime = f.time;
      open.grossPnl = open.closedPnlTotal;
      open.netPnl = open.closedPnlTotal - open.fees;
      open.win = open.netPnl > 0n;
      open.vwapEntry = open.openQty > 0n ? open.posNotional / open.openQty : 0n;
      trades.push(open);
      open = null;
    };

    for (const f of list) {
      const before = parseWad(f.startPosition);
      const after = before + signedDelta(f);
      const absBefore = before > 0n ? before : -before;
      const absAfter = after > 0n ? after : -after;

      if (before === 0n && after !== 0n) {
        // 从空仓建仓
        startTrade(f, absAfter, after > 0n);
        continue;
      }
      if (before !== 0n && after === 0n) {
        // 平回空仓
        closeTrade(f);
        continue;
      }
      if (before !== 0n && after !== 0n && (before > 0n) !== (after > 0n)) {
        // 反手：同一笔成交先平旧仓、再开新仓
        closeTrade(f);
        startTrade(f, absAfter, after > 0n);
        continue;
      }

      // 持仓方向不变 —— 加减仓
      if (open) {
        open.closedPnlTotal += takePnl(f);
        open.fees += takeFee(f);
        open.fillCount += 1;
        const px = parseWad(f.px);
        if (absAfter > absBefore) {
          // 加仓：按新增量加权
          open.posNotional += px * (absAfter - absBefore);
          open.openQty += absAfter - absBefore;
        } else if (absAfter < absBefore) {
          // 减仓：按减少的比例等比例削减入场名义价值，均价的含义才保持不变
          open.posNotional -= (open.posNotional * (absBefore - absAfter)) / absBefore;
          open.openQty = absAfter;
        }
        if (absAfter > open.peakQty) open.peakQty = absAfter;
      }
    }

    // 仍未平仓的交易挂出来但不计入胜负统计（浮盈不是已实现盈亏）
    if (open) {
      open.stillOpen = true;
      open.grossPnl = open.closedPnlTotal;
      open.netPnl = open.closedPnlTotal - open.fees;
      open.vwapEntry = open.openQty > 0n ? open.posNotional / open.openQty : 0n;
      trades.push(open);
    }
  }

  trades.sort((a, b) => (a.closeTime || a.openTime) - (b.closeTime || b.openTime));
  return trades;
}

/** 平仓盈亏字段：API 给的是字符串，缺失时按 0 处理 */
function parsePnl(f) {
  return parseWad(f.closedPnl ?? 0);
}

/** 手续费：只统计以 USDC 计价的手续费，避免把代币计价的手续费混进来 */
function feeOf(fill) {
  const token = fill.feeToken || 'USDC';
  if (token !== 'USDC') return 0n;
  return parseWad(fill.fee);
}

/**
 * 绩效汇总。
 *
 * ⚠️ 关键设计决策：同时给两套口径，因为它们的适用条件完全不同。
 *
 * 【口径 A：按平仓成交统计】—— 窗口无关，永远成立
 *   每笔带 closedPnl 的成交本身就是一次已实现盈亏。把 closedPnl 求和得到
 *   窗口内的已实现盈亏总额，这个数不受窗口边界影响。
 *   胜率 = closedPnl > 0 的成交笔数占比。
 *   缺点：一笔平仓被拆成多笔成交时会被重复计数（分母偏大），
 *        但它不会给出「0 笔交易、胜率 100%」这种误导性结论。
 *
 * 【口径 B：按持仓周期统计】—— 精确，但依赖窗口完整性
 *   从空仓开仓到回到空仓算一笔。这是最符合直觉的「交易」定义，
 *   但要求成交窗口内出现 startPosition == 0。
 *   高频账户 2000 笔成交可能只覆盖几小时，窗口内一次都没回到空仓 ——
 *   此时口径 B 会得出「0 笔交易」，必须显式告知用户，不能当成
 *   「没亏过钱」来呈现。
 *
 * 所以下面的 `reliable` 字段标明口径 B 是否可信，界面据此决定怎么显示。
 */
export function summarizePerformance({ fills = [], funding = [], trades = [] } = {}) {
  const pnlOf = (f) => parsePnl(f);

  // ── 口径 A：窗口无关
  let realizedGross = 0n;
  let fees = 0n;
  const byCoin = new Map();
  const pnlFills = [];

  for (const f of fills) {
    const p = pnlOf(f);
    const fee = feeOf(f);
    realizedGross += p;
    fees += fee;
    if (p !== 0n) pnlFills.push(f);
    if (!byCoin.has(f.coin)) byCoin.set(f.coin, { coin: f.coin, realizedGross: 0n, fees: 0n, fills: 0, wins: 0, losses: 0 });
    const c = byCoin.get(f.coin);
    c.realizedGross += p;
    c.fees += fee;
    c.fills += 1;
    if (p > 0n) c.wins += 1;
    else if (p < 0n) c.losses += 1;
  }

  const winFills = pnlFills.filter((f) => pnlOf(f) > 0n);
  const lossFills = pnlFills.filter((f) => pnlOf(f) < 0n);
  const sumPnl = (arr) => arr.reduce((a, f) => a + pnlOf(f), 0n);
  const grossWin = sumPnl(winFills);
  const grossLoss = -sumPnl(lossFills); // lossFills 的 PnL 为负，取反成正数
  const avgWin = winFills.length ? grossWin / BigInt(winFills.length) : 0n;
  const avgLoss = lossFills.length ? grossLoss / BigInt(lossFills.length) : 0n;

  // 资金费：持仓期间的资金费收支，是合约交易的真实成本之一
  const fundingNet = (funding || []).reduce((a, d) => a + parseWad(d.usdc ?? 0), 0n);

  const times = fills.map((f) => f.time).filter((t) => Number.isFinite(t));
  const firstTime = times.length ? Math.min(...times) : null;
  const lastTime = times.length ? Math.max(...times) : null;

  // ── 口径 B：完整持仓周期
  const closed = trades.filter((t) => !t.stillOpen);
  const cycleWins = closed.filter((t) => t.win);
  const cycleLosses = closed.filter((t) => !t.win);
  const cycleGrossWin = cycleWins.reduce((a, t) => a + t.netPnl, 0n);
  const cycleGrossLoss = cycleLosses.length ? -cycleLosses.reduce((a, t) => a + t.netPnl, 0n) : 0n;

  // 可信度判据：窗口内是否存在「回到空仓」的时刻。
  // 没有任何一次回到空仓 -> 口径 B 的样本为 0，结论不可用。
  const hasFlatMoment = fills.some((f) => parseWad(f.startPosition ?? 0) === 0n);
  const cycleReliable = closed.length >= 3 && hasFlatMoment;

  return {
    fills: {
      count: fills.length,
      firstTime,
      lastTime,
      spanDays: firstTime && lastTime ? (lastTime - firstTime) / 86400000 : null,
      coins: byCoin.size,
    },

    // 口径 A —— 永远成立
    realizedGross,
    fees,
    fundingNet,
    realizedNet: realizedGross - fees,
    closing: {
      count: pnlFills.length,
      wins: winFills.length,
      losses: lossFills.length,
      winRate: pnlFills.length ? winFills.length / pnlFills.length : null,
      grossWin,
      grossLoss,
      avgWin,
      avgLoss,
      payoffRatio: avgLoss > 0n ? Number(avgWin) / Number(avgLoss) : null,
      profitFactor: grossLoss > 0n ? Number(grossWin) / Number(grossLoss) : null,
      best: winFills.length ? winFills.reduce((a, b) => (pnlOf(b) > pnlOf(a) ? b : a)) : null,
      worst: lossFills.length ? lossFills.reduce((a, b) => (pnlOf(b) < pnlOf(a) ? b : a)) : null,
    },

    // 口径 B —— 精确但依赖窗口
    cycles: {
      reliable: cycleReliable,
      closed: closed.length,
      open: trades.length - closed.length,
      wins: cycleWins.length,
      losses: cycleLosses.length,
      winRate: closed.length ? cycleWins.length / closed.length : null,
      grossWin: cycleGrossWin,
      grossLoss: cycleGrossLoss,
      profitFactor: cycleGrossLoss > 0n ? Number(cycleGrossWin) / Number(cycleGrossLoss) : null,
      avgWin: cycleWins.length ? cycleGrossWin / BigInt(cycleWins.length) : 0n,
      avgLoss: cycleLosses.length ? cycleGrossLoss / BigInt(cycleLosses.length) : 0n,
      longestWinStreak: streak(closed, true),
      longestLossStreak: streak(closed, false),
      note: cycleReliable
        ? null
        : closed.length === 0
        ? `成交窗口内未出现「回到空仓」的时刻（共 ${fills.length} 笔成交，跨越 ${
            firstTime && lastTime ? ((lastTime - firstTime) / 3600000).toFixed(1) : '?'
          } 小时），无法按持仓周期归集交易。请以左侧「按平仓成交」口径为准。`
        : `仅归集到 ${closed.length} 笔完整周期，样本过少，统计不具代表性。`,
    },

    byCoin: [...byCoin.values()]
      .map((c) => ({ ...c, net: c.realizedGross - c.fees }))
      .sort((a, b) => Number(b.net - a.net)),
  };
}

function streak(trades, wantWin) {
  let best = 0;
  let cur = 0;
  for (const t of trades) {
    if (t.win === wantWin) {
      cur += 1;
      if (cur > best) best = cur;
    } else {
      cur = 0;
    }
  }
  return best;
}

/**
 * 从 portfolio 响应里抽权益曲线。
 *
 * ⚠️ 实测发现的关键区别：portfolio 返回 8 个时间尺度，
 * `perpDay/perpWeek/perpMonth/perpAllTime` 才是**合约账户**权益；
 * 不带前缀的 day/week/month/allTime 是「现货 + 合约」总额。
 * 做合约交易看板必须用 perp 前缀的，否则图表里会混进现货余额，看起来像暴涨暴跌。
 */
export function extractEquityCurve(portfolio, prefer = 'perpAllTime') {
  if (!Array.isArray(portfolio)) return null;
  const map = new Map(portfolio.map(([p, d]) => [p, d]));

  const pick = (name) => {
    const d = map.get(name);
    if (!d || !Array.isArray(d.accountValueHistory)) return null;
    return {
      period: name,
      equity: d.accountValueHistory.map(([t, v]) => ({ t, v: parseWad(v) })),
      pnl: Array.isArray(d.pnlHistory) ? d.pnlHistory.map(([t, v]) => ({ t, v: parseWad(v) })) : [],
      volume: parseWad(d.vlm ?? 0),
    };
  };

  const all = {};
  for (const name of ['day', 'week', 'month', 'allTime', 'perpDay', 'perpWeek', 'perpMonth', 'perpAllTime']) {
    const r = pick(name);
    if (r) all[name] = r;
  }
  const primary = all[prefer] || all.perpAllTime || all.allTime || null;
  if (primary) primary.maxDrawdown = maxDrawdown(primary.equity, primary.pnl);
  return { primary, byPeriod: all };
}

/**
 * 最大回撤。
 *
 * ⚠️ 这里有个很容易搞错的地方：Hyperliquid 的 accountValueHistory 是**原始账户价值**，
 * 包含充值和提现。用「权益峰值 → 权益谷值」直接算回撤，会把一笔大额提现算成 98% 的回撤 ——
 * 实测中确实出现过这个失真数字。
 *
 * 正确做法：用 pnlHistory（Hyperliquid 自己的累计盈亏核算，不含资金划转）
 * 在盈亏空间里算回撤，再以「峰值时刻的权益」为分母折算成百分比。
 * 这样出入金被完全排除，回撤只反映真实交易亏损。
 *
 * 拿不到 pnlHistory 时退回原始权益口径，但会明确标注 includesTransfers = true。
 */
export function maxDrawdown(equitySeries, pnlSeries) {
  if (!equitySeries || equitySeries.length < 2) return null;

  const usablePnl = Array.isArray(pnlSeries) && pnlSeries.length === equitySeries.length && pnlSeries.length >= 2;

  if (!usablePnl) {
    // 退化路径：权益峰谷法（受出入金影响）
    let peak = equitySeries[0].v;
    let peakAt = equitySeries[0].t;
    let worst = 0;
    let worstPeakAt = peakAt;
    let worstAt = equitySeries[0].t;
    let unmeasurable = 0;
    for (const p of equitySeries) {
      if (p.v > peak) {
        peak = p.v;
        peakAt = p.t;
      }
      if (peak > 0n) {
        const dd = Number(((peak - p.v) * 10000n) / peak) / 10000;
        if (dd > worst) {
          worst = dd;
          worstPeakAt = peakAt;
          worstAt = p.t;
        }
      } else if (p.v < peak) {
        unmeasurable += 1;
      }
    }
    return {
      pct: worst,
      method: 'equity-peak-to-trough',
      includesTransfers: true,
      peakAt: worstPeakAt,
      at: worstAt,
      drawdownAmount: null,
      // 同首选路径：0% 且没有算不出的样本，就是「确实没有回撤」，不该标成不可信
      plausible: (worst === 0 && unmeasurable === 0) || worst <= 1,
      caveat: '未取到盈亏曲线，此回撤含出入金影响，可能显著偏大',
    };
  }

  // 首选路径：在盈亏空间里算，出入金免疫
  let peakPnl = pnlSeries[0].v;
  let peakEquityAtPeak = equitySeries[0].v;
  let peakAt = pnlSeries[0].t;
  let worst = 0;
  let worstPeakAt = peakAt;
  let worstAt = pnlSeries[0].t;
  let worstPeakPnl = peakPnl;
  let worstPnl = pnlSeries[0].v;
  // 有回撤、但分母不可用的样本数 —— 用来把「真的没有回撤」和
  // 「有回撤但算不出可信百分比」区分开。两者都会让 worst 停在 0。
  let unmeasurable = 0;

  for (let i = 0; i < pnlSeries.length; i++) {
    const pnl = pnlSeries[i].v;
    const eq = equitySeries[i].v;
    if (pnl > peakPnl) {
      peakPnl = pnl;
      peakEquityAtPeak = eq;
      peakAt = pnlSeries[i].t;
    }
    const ddAmount = peakPnl - pnl;
    const base = peakEquityAtPeak > 0n ? peakEquityAtPeak : eq;
    if (ddAmount > 0n) {
      if (base > 0n) {
        const dd = Number((ddAmount * 10000n) / base) / 10000;
        if (dd > worst) {
          worst = dd;
          worstPeakAt = peakAt;
          worstAt = pnlSeries[i].t;
          worstPeakPnl = peakPnl;
          worstPnl = pnl;
        }
      } else {
        unmeasurable += 1;
      }
    }
  }

  // 分母守卫：
  // 权益快照可能接近 0 —— 账户被提空，或者成交其实发生在 HIP-3（builder-deployed）
  // 子账户上（`clearinghouseState` / `portfolio` 默认只返回主合约账户）。
  // 这时「回撤金额 ÷ 权益」会算出荒谬的百分比，实测出现过 732457237%。
  // 权益口径下超过 100% 的回撤不可能成立，说明分母不是真实的资金基数 ——
  // 必须标记出来，让人改看绝对金额，而不是照着一个假数字下结论。
  //
  // ⚠️ 不要把「没有回撤」也算成不可信：worst === 0 有两种来源 ——
  //   (a) 曲线确实一路上行，没出现峰后回落 → 0% 是可信的答案；
  //   (b) 有回撤但分母是 0 → 根本算不出百分比。
  // 只看 `worst > 0` 会把 (a) 一起打成 plausible:false，
  // 界面上就会出现「0.00% ⟨分母失真⟩ · 亏 $0.00」这种自相矛盾的噪声。
  const noDrawdown = worst === 0 && unmeasurable === 0;
  const plausible = noDrawdown || worst <= 1;
  return {
    pct: worst,
    method: 'pnl-space',
    includesTransfers: false,
    peakAt: worstPeakAt,
    at: worstAt,
    drawdownAmount: worstPeakPnl - worstPnl,
    plausible,
    caveat: plausible
      ? undefined
      : '权益快照过小（账户可能已提空，或成交发生在 HIP-3 子账户上），' +
        '回撤百分比的分母不是真实资金基数，请以绝对金额为准',
  };
}

/** 存取款净额（用于把「权益变化」拆成「交易盈亏」与「出入金」两部分） */
export function netDeposits(ledgerDeltas) {
  let deposit = 0n;
  let withdraw = 0n;
  const detail = [];
  for (const d of ledgerDeltas || []) {
    const type = d.type;
    const usdc = parseWad(d.usdc ?? d.usdcValue ?? 0);
    if (type === 'deposit' || type === 'accountClassTransfer' || type === 'internalTransfer') {
      deposit += usdc;
    } else if (type === 'withdraw') {
      withdraw += usdc < 0n ? -usdc : usdc;
    } else if (typeof type === 'string' && usdc !== 0n) {
      deposit += usdc;
    }
    detail.push({ type, usdc, time: d.time });
  }
  return { deposit, withdraw, net: deposit - withdraw, detail };
}
