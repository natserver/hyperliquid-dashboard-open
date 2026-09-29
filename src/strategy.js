/**
 * 比特皇策略数学 —— 从 bithuang-onchain 里已验证的 Solidity 实现逐行移植。
 *
 * 为什么用 BigInt：链上合约用的是整数运算（WAD 定标 + 整数开方），浮点数会有
 * 舍入差异。界面显示的数字必须和链上风控算出来的完全一致，否则"界面说能开、
 * 链上拒绝"这种事就会反复发生。
 *
 * 本文件同时被后端和前端 import —— 只有一份实现，不会漂移。
 *
 * 对应的 Solidity 源码：
 *   src/libraries/BollingerLib.sol   -> isqrt / bandsAt
 *   src/libraries/TrendLib.sol       -> analyzeTrend
 *   src/libraries/RiskLib.sol        -> initialSize / pyramidAddQty / 相位门槛
 *   src/BithuangStrategyEngine.sol   -> planOpen / planAdd 的校验顺序
 */

export const WAD = 10n ** 18n;
export const BPS = 10000n;

/* ────────────────────────────── 数值转换 ────────────────────────────── */

/**
 * 把 API 返回的十进制字符串精确解析成 WAD。
 * Hyperliquid 的价格/数量都是字符串（"77407.0"、"0.49252"），
 * 直接 parseFloat 再乘 1e18 会丢精度，所以走字符串切分。
 */
export function parseWad(input) {
  if (typeof input === 'bigint') return input;
  if (input === null || input === undefined) return 0n;
  const s = String(input).trim();
  if (s === '' || s === 'null') return 0n;
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  // 兼容科学计数法（极少数接口会返回，例如 1e-8）
  if (/[eE]/.test(body)) {
    const n = Number(body);
    if (!Number.isFinite(n)) return 0n;
    return wadFromNumber(n);
  }
  const dot = body.indexOf('.');
  const intPart = dot === -1 ? body : body.slice(0, dot);
  const fracRaw = dot === -1 ? '' : body.slice(dot + 1);
  const frac = (fracRaw + '0'.repeat(18)).slice(0, 18);
  let v = BigInt(intPart || '0') * WAD + BigInt(frac || '0');
  if (neg) v = -v;
  return v;
}

/** 由 JS 数字构造 WAD（只用于配置常量等已知精度安全的场景） */
export function wadFromNumber(v) {
  if (!Number.isFinite(v)) return 0n;
  return BigInt(Math.round(v * 1e6)) * 10n ** 12n;
}

/** 兼容入口：字符串或数字都能转 */
export const toWad = (x) => (typeof x === 'string' ? parseWad(x) : wadFromNumber(x));

/**
 * 把「WAD 语义」的入参归一成 BigInt。所有 WAD 消费型函数都应在入口调它。
 *
 * 为什么必须有这一层：快照经过 JSON 序列化后，BigInt 会变成**字符串**。
 * 前端若把原始字符串直接传给 fmtWad / fmtPrice，函数内部的 `v < 0n` 与 `abs / WAD`
 * 会抛 "Cannot mix BigInt and other types"。
 * 而这个异常发生在**渲染中途** —— 顺序执行的 renderAll 会就此中断，
 * 该面板之后的整块界面（含 K 线图）全部不渲染，且被外层 catch 吞成一条横幅。
 * 曾在持仓表里踩到：fmtWad(p.qty) 一处就让「持仓风控」以下 12 个面板全空。
 *
 * 语义：纯整数字符串按 WAD 解读（后端 BigInt 的序列化形态）；
 *      带小数点或指数的按十进制解读；数字按十进制解读。
 */
export function asWad(v) {
  if (typeof v === 'bigint') return v;
  if (v === null || v === undefined) return 0n;
  if (typeof v === 'number') return wadFromNumber(v);
  const s = String(v).trim();
  if (s === '') return 0n;
  return /^-?\d+$/.test(s) ? BigInt(s) : parseWad(s);
}

/** WAD -> 十进制字符串，保留 dp 位小数（截断而非四舍五入，避免显示值大于实际值） */
export function fmtWad(input, dp = 2) {
  if (input === null || input === undefined) return '—';
  const v = asWad(input);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / WAD;
  const fracFull = (abs % WAD).toString().padStart(18, '0');
  const frac = dp > 0 ? fracFull.slice(0, dp) : '';
  const sign = neg ? '-' : '';
  if (dp === 0) return sign + whole.toString();
  return `${sign}${whole}.${frac}`;
}

/** WAD -> Number（仅用于画图坐标等对精度不敏感的场景） */
export const wadToNumber = (v) => Number(asWad(v)) / 1e18;

/** 金额格式化：自动加千分位，超大便用 K/M 缩写 */
export function fmtUsd(v, dp = 2) {
  const n = wadToNumber(v);
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${sign}$${(abs / 1e3).toFixed(2)}K`;
  return `${sign}$${abs.toFixed(dp)}`;
}

/** bps（万分比）-> 百分数字符串。注意 Hyperliquid 用小数比率，比特皇参数用 bps。 */
export const fmtBps = (bps, dp = 2) => `${(Number(bps) / 100).toFixed(dp)}%`;

/** 价格格式化：大数少留小数位，小数币多留 */
export function fmtPrice(v, dp) {
  const n = wadToNumber(v);
  if (!Number.isFinite(n) || n === 0) return '—';
  const a = Math.abs(n);
  const d = dp !== undefined ? dp : a >= 10000 ? 1 : a >= 100 ? 2 : a >= 1 ? 4 : 6;
  return n.toFixed(d);
}

/* ────────────────────── 布林带（整数实现） ────────────────────── */

/** 整数平方根（牛顿迭代）。Solidity 用同一个算法，结果必然一致。 */
export function isqrt(n) {
  if (n < 0n) throw new Error('isqrt: 负数');
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/**
 * 计算截止 endIndex（含）的布林带。
 *
 * ⚠️ 关键语义：下轨被截断到 0 是有意义的。当 mid - kσ ≤ 0（剧烈下跌后的极端波动）时，
 * 返回 lower = 0，含义是「任何正价格都在下轨下方」。早期版本要求 lower > 0，
 * 导致做空信号永不触发 —— 这是链上代码修掉的一个真实缺陷，这里保持修复后的语义。
 *
 * @param {bigint[]} closes 收盘价序列（WAD）
 * @param {number} endIndex 末根索引（含）
 * @param {number} period BOLL 周期，默认 20
 * @param {number} sdMultBps σ 倍数（bps），20000 == 2σ
 */
export function bandsAt(closes, endIndex, period = 20, sdMultBps = 20000) {
  const start = endIndex + 1 - period;
  if (start < 0 || endIndex >= closes.length) return null;
  const P = BigInt(period);
  const M = BigInt(sdMultBps);
  let sum = 0n;
  let sumSq = 0n;
  for (let i = start; i <= endIndex; i++) {
    const p = closes[i];
    sum += p;
    sumSq += p * p;
  }
  const mean = sum / P;
  // 总体方差（除以 P 而非 P-1），与合约一致
  const variance = (P * sumSq - sum * sum) / (P * P);
  const sd = isqrt(variance);
  const offset = (sd * M) / BPS;
  return {
    mid: mean,
    upper: mean + offset,
    lower: mean > offset ? mean - offset : 0n,
    sd,
    period,
    endIndex,
  };
}

/** higher 相对 reference 的超出幅度是否 ≥ bps（严格大于，相等不算突破） */
function penetrates(higher, reference, bps) {
  if (reference === 0n || higher <= reference) return false;
  return (higher - reference) * BPS >= reference * bps;
}

/** 收盘是否有效跌破下轨。下轨为 0 视为必破（见 bandsAt 的语义说明）。 */
function breaksLower(close, lower, bps) {
  if (close === 0n) return false;
  if (lower === 0n) return true;
  return penetrates(lower, close, bps);
}

/* ────────────────────── 趋势确认（比特皇核心开单条件） ────────────────────── */

/**
 * ⚠️ 已降级为「触发层的旧口径」，**不得再用来决定方向**。
 *
 * 它把「方向」和「触发」焊在了一起 —— longBreaks >= 3 就 direction = 1。
 * 这是错的：三次突破只证明有推进力，不证明往哪边。熊市反弹同样能连续
 * 三次突破上轨。方向必须来自 src/regime.js 的宏观方向层。
 *
 * 保留它的唯一原因是向后兼容（老调用方、老测试、trendStillValid 的加仓校验）。
 * 新代码请用：
 *   · analyzeSetup()  取触发状态（不声称方向）
 *   · gate()          把 regime 与 setup 接起来才知道能不能开单
 * 其中 ③「站稳 = 末根收盘在中轨之上」这一条口径也偏松 ——
 * 中轨只是均线，价格在中轨上方说明不了"站住了突破位"。新口径见 analyzeSetup 的 H0/H1/H2。
 *
 * 三重要求（旧口径）：
 *   1. 连续三次 —— 中间任何一次收盘跌破中轨，计数清零；
 *   2. 有效突破 —— 超出上轨幅度 ≥ minPenetrationBps（默认 0.10%）；
 *   3. 站稳 —— 末根收盘仍在中轨上方（做多）/ 下方（做空）。
 *
 * @deprecated 方向用途请改用 computeRegime + gate。本函数仅可用于取 bands / marks。
 * @param {bigint[]} closes 收盘价序列（WAD），最后一根为最新
 * @param {object} cfg 趋势配置
 * @returns {{direction:number, longBreaks:number, shortBreaks:number, required:number,
 *            holding:boolean, bands:object, marks:Array, closesLen:number}}
 */
export function analyzeTrend(closes, cfg = {}) {
  const period = cfg.trendPeriod ?? 20;
  const sdMultBps = cfg.trendStdMultBps ?? 20000;
  const required = cfg.trendRequiredBreaks ?? 3;
  const lookback = cfg.trendLookbackBars ?? 48;
  const minPen = BigInt(cfg.trendMinPenetrationBps ?? 10);
  const minGap = BigInt(cfg.trendMinGapBars ?? 1);

  const empty = {
    direction: 0,
    longBreaks: 0,
    shortBreaks: 0,
    required,
    holding: false,
    bands: null,
    marks: [],
    closesLen: closes.length,
    reason: 'K 线不足',
  };
  if (!closes || closes.length < period) return empty;

  const endIndex = closes.length - 1;
  let scanFrom = endIndex >= lookback ? endIndex - lookback + 1 : 0;
  if (scanFrom < period - 1) scanFrom = period - 1;

  let lastLong = null;
  let lastShort = null;
  let longBreaks = 0;
  let shortBreaks = 0;
  let bands = null;
  const marks = [];

  for (let i = scanFrom; i <= endIndex; i++) {
    const b = bandsAt(closes, i, period, sdMultBps);
    if (!b) continue;
    const close = closes[i];

    if (penetrates(close, b.upper, minPen)) {
      if (lastLong === null || i - lastLong >= Number(minGap)) {
        lastLong = i;
        longBreaks++;
        marks.push({ index: i, side: 1, close, band: b.upper });
      }
    } else if (close < b.mid) {
      longBreaks = 0;
      lastLong = null;
    }

    if (breaksLower(close, b.lower, minPen)) {
      if (lastShort === null || i - lastShort >= Number(minGap)) {
        lastShort = i;
        shortBreaks++;
        marks.push({ index: i, side: -1, close, band: b.lower });
      }
    } else if (close > b.mid) {
      shortBreaks = 0;
      lastShort = null;
    }

    bands = b;
  }

  const lastClose = closes[endIndex];
  const holdingLong = bands ? lastClose >= bands.mid : false;
  const holdingShort = bands ? lastClose <= bands.mid : false;

  let direction = 0;
  let reason = '未确认';
  if (longBreaks >= required && holdingLong) {
    direction = 1;
    reason = `连续 ${longBreaks} 次有效突破上轨且站稳中轨`;
  } else if (shortBreaks >= required && holdingShort) {
    direction = -1;
    reason = `连续 ${shortBreaks} 次有效跌破下轨且站稳中轨下方`;
  } else if (longBreaks > 0 && longBreaks < required) {
    reason = `向上突破 ${longBreaks}/${required} 次，尚未确认`;
  } else if (shortBreaks > 0 && shortBreaks < required) {
    reason = `向下突破 ${shortBreaks}/${required} 次，尚未确认`;
  }

  return {
    direction,
    longBreaks,
    shortBreaks,
    required,
    holding: direction === 1 ? holdingLong : direction === -1 ? holdingShort : false,
    bands,
    marks,
    closesLen: closes.length,
    reason,
  };
}

/**
 * 加仓前的「趋势仍成立」校验，对应合约的 trendStillValid。
 * 比特皇只做顺势加仓 —— 趋势一散就不许再加。
 */
export function trendStillValid(closes, isLong, cfg = {}) {
  const t = analyzeTrend(closes, cfg);
  if (t.direction === 0) return false;
  return isLong ? t.direction === 1 : t.direction === -1;
}

/* ══════════════════ 系统二 · 战术触发层（Setup Layer） ══════════════════
 *
 * 与上面 analyzeTrend 的根本区别：
 *
 *   analyzeTrend 把「方向」和「触发」焊在一起 —— longBreaks >= 3 就 direction = 1。
 *   那是错的。三次突破只证明「有推进力」，不证明「往哪边」：
 *   熊市反弹同样能连续三次突破上轨，而那是历史上最贵的做多信号之一。
 *
 *   analyzeSetup 只讲触发，**不声称方向**。它输出的字段叫 side（正在酝酿哪一侧），
 *   不叫 direction。它必须经由 gate() 与系统一（宏观方向层）比对之后，
 *   才能变成可执行的信号。
 *
 * 同时修正两处语义：
 *
 *   ① 「三次突破」→「三条独立推进腿」
 *      旧实现 minGapBars = 1，于是连续 3 根收在轨外就凑够 3 次 ——
 *      那只是**一根长阳**，不是三次冲击。
 *      新实现按「腿」计数：一条腿 = 一段连续收在轨外的区间；
 *      两条腿之间必须至少有一根收盘回到轨内。三次冲击 = 三段独立推进。
 *      这才是「反复试、每次都没被打回来」的形态。
 *
 *   ② 「站稳」→ 分级
 *      旧实现 holding = 末根收盘 ≥ 中轨。中轨只是均线，
 *      价格在中轨上方根本不能说明"站住了突破位"。
 *      新实现分三级，只有 H2 才允许开单：
 *        H0 未站稳 —— 末根收盘已回到轨内
 *        H1 初步   —— 末根仍在轨外，但持续根数不够
 *        H2 确认   —— 末根在轨外，且已持续 ≥ setupHoldBars 根
 */

/**
 * 布林带宽（(上轨−下轨)/中轨）的百分位。
 * 收口判定必须**前置**：收口是突破的因，不是突破的果。
 * 突破发生后带宽必然拉大，此时再要求"当前带宽处于低位"，
 * 会把所有真实突破全部拒掉 —— 这是最容易写错的一步。
 */
function bandwidthPct(bwSeries, idx, lookback) {
  const from = Math.max(0, idx - lookback + 1);
  const win = bwSeries.slice(from, idx + 1).filter((v) => Number.isFinite(v) && v > 0);
  const cur = bwSeries[idx];
  if (!Number.isFinite(cur) || cur <= 0 || win.length < 20) return null;
  let below = 0;
  for (const v of win) if (v <= cur) below++;
  return (below / win.length) * 100;
}

/**
 * 系统二主函数：在给定 K 线上求「触发状态」。
 *
 * @param {bigint[]} closes 收盘价序列（WAD），最后一根为最新
 * @param {object} cfg 配置（trend* / setup* / squeeze* 字段）
 * @returns {object} 见函数末尾的 return
 */
export function analyzeSetup(closes, cfg = {}) {
  const period = cfg.trendPeriod ?? 20;
  const sdMultBps = cfg.trendStdMultBps ?? 20000;
  const required = cfg.trendRequiredBreaks ?? 3;
  const lookback = cfg.trendLookbackBars ?? 48;
  const minPen = BigInt(cfg.trendMinPenetrationBps ?? 10);
  const minLegBars = cfg.setupMinLegBars ?? 1;
  const minInsideBars = cfg.setupMinInsideBars ?? 1;
  const holdBars = cfg.setupHoldBars ?? 2;
  const squeezeLookback = cfg.squeezeLookbackBars ?? 100;
  const squeezeMaxPct = cfg.squeezeMaxPercentile ?? 25;

  const empty = {
    side: 0,
    longLegs: 0,
    shortLegs: 0,
    required,
    hold: { level: 'H0', bars: 0, refPrice: null, detail: 'K 线不足' },
    squeeze: { ok: false, percentile: null, detail: 'K 线不足' },
    pullback: {
      available: false, atMid: false, touchIndex: null, bounced: false,
      entryPrice: null, stopRef: null, distToMidBps: null,
      reason: 'K 线不足',
    },
    entryMode: null,
    breakoutOk: false,
    pullbackOk: false,
    bands: null,
    marks: [],
    legs: [],
    closesLen: closes ? closes.length : 0,
    blockers: [],
    reason: 'K 线不足',
  };
  if (!closes || closes.length < period + 1) return empty;

  const endIndex = closes.length - 1;
  // 需要多取 squeezeLookback 根来算带宽百分位（否则窗口不足会一直弃权）
  let scanFrom = endIndex >= lookback ? endIndex - lookback + 1 : 0;
  if (scanFrom < period - 1) scanFrom = period - 1;
  const warmFrom = Math.max(period - 1, scanFrom - squeezeLookback);

  // 先把布林序列整段算出来（带宽百分位需要连续窗口）
  const bw = new Array(closes.length).fill(NaN);
  let bands = null;
  for (let i = warmFrom; i <= endIndex; i++) {
    const b = bandsAt(closes, i, period, sdMultBps);
    if (!b) continue;
    if (b.mid > 0n) bw[i] = Number(b.upper - b.lower) / Number(b.mid);
    if (i >= scanFrom) bands = b;
  }
  if (!bands) return { ...empty, closesLen: closes.length };

  /** 单侧的腿检测状态机 */
  const makeSide = () => ({
    legs: [],          // 已完成的腿（含正在进行中的那条，ongoing 标记）
    run: null,         // 当前正在轨外的区间
    insideRun: 0,      // 已连续收在轨内的根数
    invalidatedAt: null,
  });

  const detect = (side, i, close, b) => {
    const st = side === 1 ? longSt : shortSt;
    const isBreak = side === 1 ? penetrates(close, b.upper, minPen) : breaksLower(close, b.lower, minPen);
    const refBand = side === 1 ? b.upper : b.lower;

    const extend = (run) => {
      run.bars++;
      run.refBandLast = refBand;
      if (side === 1 ? close > run.peak : close < run.peak) run.peak = close;
    };

    if (isBreak) {
      if (st.run) {
        extend(st.run); // 同一条腿还没结束
      } else if (st.legs.length === 0 || st.insideRun >= minInsideBars) {
        // 上一条腿之后已经收回轨内至少 minInsideBars 根 —— 这是一条**新的独立推进**。
        // 「三次突破」数的就是这个：三段独立推进，而不是连续三根收在轨外。
        st.run = { side, startIndex: i, bars: 1, refBand, refBandLast: refBand, peak: close, ongoing: true };
        st.legs.push(st.run);
      } else {
        // 间隔不足 minInsideBars：不算新腿，接回上一条腿继续算（避免把一次持续冲高切成三段）
        st.run = st.legs[st.legs.length - 1];
        st.run.ongoing = true;
        extend(st.run);
      }
      st.insideRun = 0;
    } else {
      if (st.run) {
        st.run.ongoing = false;
        // 太短的腿不算一条独立推进。默认 minLegBars = 1，
        // 也就是「一根收盘冲出轨道又被收回」仍然算一次冲击 —— 那正是"试盘"的形态。
        if (st.run.bars < minLegBars) st.legs.pop();
        st.run = null;
      }
      st.insideRun++;
    }

    // 失效：收盘越过中轨到了另一侧 —— 整套计数清零，重新开始数
    const crossed = side === 1 ? close < b.mid : close > b.mid;
    if (crossed) {
      st.legs.length = 0;
      st.run = null;
      st.insideRun = 0;
      st.invalidatedAt = i;
    }

    return isBreak;
  };

  const longSt = makeSide();
  const shortSt = makeSide();
  const marks = [];
  let lastLongBreakIndex = null;
  let lastShortBreakIndex = null;

  for (let i = warmFrom; i <= endIndex; i++) {
    const b = bandsAt(closes, i, period, sdMultBps);
    if (!b) continue;
    const close = closes[i];
    const isLong = detect(1, i, close, b);
    const isShort = detect(-1, i, close, b);
    if (i >= scanFrom && isLong && lastLongBreakIndex !== i) {
      lastLongBreakIndex = i;
      marks.push({ index: i, side: 1, close, band: b.upper });
    }
    if (i >= scanFrom && isShort && lastShortBreakIndex !== i) {
      lastShortBreakIndex = i;
      marks.push({ index: i, side: -1, close, band: b.lower });
    }
  }

  const lastClose = closes[endIndex];

  /** 由某一侧的腿状态得出 hold 等级与 setup 是否成立 */
  const evalSide = (st, b, refBandField) => {
    const legs = st.legs;
    const last = legs.length ? legs[legs.length - 1] : null;
    let hold = { level: 'H0', bars: 0, refPrice: null, detail: '尚未出现在轨外的收盘' };
    if (last) {
      const refPrice = last.refBand;
      if (last.ongoing) {
        if (last.bars >= holdBars) {
          hold = {
            level: 'H2', bars: last.bars, refPrice,
            detail: `末根收在轨外，已连续 ${last.bars} 根（要求 ${holdBars} 根）—— 站稳确认。`,
          };
        } else {
          hold = {
            level: 'H1', bars: last.bars, refPrice,
            detail: `末根收在轨外，但只持续 ${last.bars} 根（要求 ${holdBars} 根）—— 待确认，别抢跑。`,
          };
        }
      } else {
        hold = {
          level: 'H0', bars: 0, refPrice,
          detail: `最近一条腿已收回轨内（腿长 ${last.bars} 根）—— 突破未守住，计数仍保留但不算站稳。`,
        };
      }
    }
    const side = legs.length ? legs[legs.length - 1].side : 0;
    return { side, legs, last, hold };
  };

  const longEval = evalSide(longSt, bands);
  const shortEval = evalSide(shortSt, bands);

  // 取「更像信号」的一侧：先比腿数，再比 hold 等级
  const levelRank = { H0: 0, H1: 1, H2: 2 };
  let pick = null;
  if (longEval.legs.length && shortEval.legs.length) {
    pick =
      longEval.legs.length !== shortEval.legs.length
        ? longEval.legs.length > shortEval.legs.length
          ? longEval
          : shortEval
        : levelRank[longEval.hold.level] >= levelRank[shortEval.hold.level]
          ? longEval
          : shortEval;
  } else if (longEval.legs.length) pick = longEval;
  else if (shortEval.legs.length) pick = shortEval;

  // 收口判定：在**第一条腿之前**的那根上量带宽百分位
  let squeeze = { ok: false, percentile: null, atIndex: null, detail: '本窗口内没有可评估的突破腿，无法判断突破前是否收口。' };
  if (pick && pick.legs.length) {
    const first = pick.legs[0];
    const at = Math.max(0, first.startIndex - 1);
    const p = bandwidthPct(bw, at, squeezeLookback);
    const nowP = bandwidthPct(bw, endIndex, squeezeLookback);
    if (p === null) {
      squeeze = {
        ok: false, percentile: null, atIndex: at, nowPercentile: nowP,
        detail: `突破前那根（第 ${at} 根）的带宽百分位算不出来 —— 历史长度不足以构成 ${squeezeLookback} 根的回看窗口，收口条件弃权（弃权按不通过处理，宁可漏做不可乱做）。`,
      };
    } else {
      squeeze = {
        ok: p <= squeezeMaxPct,
        percentile: Math.round(p * 10) / 10,
        atIndex: at,
        nowPercentile: nowP === null ? null : Math.round(nowP * 10) / 10,
        detail:
          p <= squeezeMaxPct
            ? `突破前（第 ${at} 根）带宽处于近 ${squeezeLookback} 根的 ${p.toFixed(1)} 分位，≤ ${squeezeMaxPct} —— 确实是「收口后扩张」，是启动不是追单。`
            : `突破前（第 ${at} 根）带宽处于近 ${squeezeLookback} 根的 ${p.toFixed(1)} 分位，> ${squeezeMaxPct} —— 带宽早就拉开，这是趋势中段的追单，不是启动形态。`,
      };
    }
  }

  const side = pick ? pick.side : 0;
  const legs = pick ? pick.legs.length : 0;
  const hold = pick ? pick.hold : { level: 'H0', bars: 0, refPrice: null, detail: '无候选腿' };

  /* ── 入场模式：突破入场 vs 回调入场 ──
   *
   * 比特皇原话（《比特皇精华总结》入场位置）：
   *   「多头趋势：4H BOLL 中轨支撑回调入场；空头趋势：上轨/中轨压力入场。
   *     强势不回调时分批建仓：突破时买 30%，回调时买 70%。」
   *
   * 所以「三次突破站稳」只解决了**一半**的入场问题 —— 它只说"有推进力"。
   * 另一半是"接下来怎么进"：
   *   · 突破就追（BREAKOUT）→ 头仓，30%，止损锚在突破参考位外侧
   *   · 等回踩中轨不破再进（PULLBACK）→ 主仓，70%，止损锚在中轨外侧
   *
   * 为什么必须分开：这两种入场的最优止损位**不一样**。
   * 用突破位止损去管回调仓，止损会比结构位远一大截；
   * 用中轨止损去管突破仓，又会被一次正常回踩洗出去。
   * 把两者混成一个数字，是「方向对但位置错」这类亏损的来源。
   */
  const touchTolBps = BigInt(cfg.pullbackTouchTolBps ?? 120); // 回踩到中轨 ±1.2% 算「触及」
  const pbLookback = cfg.pullbackLookbackBars ?? 12; // 在最近多少根里找这次回踩
  const pbMinReboundBps = BigInt(cfg.pullbackMinReboundBps ?? 0); // 重新起势的最小幅度

  /** 识别一次「回踩中轨后重新起势」。side: 1 多 / -1 空 */
  const pullbackRead = (st, b, sd) => {
    const mid = b ? b.mid : 0n;
    if (!st.legs.length) {
      return {
        available: false, atMid: false, touchIndex: null, bounced: false,
        entryPrice: null, stopRef: null, distToMidBps: null,
        reason: `${sd === 1 ? '多' : '空'}头侧尚无推进腿 —— 没有推进力可回踩，回调入场不适用。`,
      };
    }
    if (mid === 0n) {
      return {
        available: false, atMid: false, touchIndex: null, bounced: false,
        entryPrice: null, stopRef: null, distToMidBps: null,
        reason: '中轨为 0，无法定位回踩位。',
      };
    }

    const from = Math.max(period - 1, endIndex - pbLookback + 1);
    const tolUp = mid + (mid * touchTolBps) / BPS; // 做多：价格下探到 mid 附近的上沿
    const tolDn = mid - (mid * touchTolBps) / BPS; // 做多：跌破这个就算「回踩破位」

    let touchIndex = null; // 最近一次触及中轨的根
    let touchClose = null;
    for (let i = from; i <= endIndex; i++) {
      const c = closes[i];
      const near = sd === 1 ? c <= tolUp && c >= tolDn : c >= tolDn && c <= tolUp;
      if (near) {
        touchIndex = i;
        touchClose = c;
      }
    }

    const lastClose = closes[endIndex];
    // 破位：收盘跑到中轨的另一侧 —— 回调变成了反转，入场理由消失
    const broken = sd === 1 ? lastClose < tolDn : lastClose > tolUp;
    // 重新起势：当前收盘回到「触及那根」的有利一侧，且幅度超过门槛
    const reboundOk =
      touchIndex === null
        ? false
        : sd === 1
          ? lastClose > touchClose + (touchClose * pbMinReboundBps) / BPS
          : lastClose < touchClose - (touchClose * pbMinReboundBps) / BPS;
    const atMid = touchIndex !== null && touchIndex >= endIndex - 2;
    const distToMidBps = Number((((lastClose > mid ? lastClose - mid : mid - lastClose) * BPS) / mid));

    const available = touchIndex !== null && !broken && reboundOk;

    // 回调入场的止损锚：中轨外侧。这不是"更紧的止损"，而是**另一个结构位** ——
    // 回调仓的逻辑是「中轨撑住」，中轨破了逻辑就没了，与突破位无关。
    const stopRef = mid;

    let reason;
    if (touchIndex === null) {
      reason = `最近 ${pbLookback} 根内没有回踩到中轨（±${Number(touchTolBps) / 100}%）—— 强势不回调，此时只能按突破批次入场，等不到 70% 那一笔。`;
    } else if (broken) {
      reason = `价格已跌破中轨（回调变反转）—— 回调入场的条件被破坏，这一笔作废。`;
    } else if (!reboundOk) {
      reason = `第 ${touchIndex} 根回踩到中轨，但之后没有重新起势 —— 「调整后没有反弹」，不进。`;
    } else {
      reason = `第 ${touchIndex} 根回踩中轨（现价距中轨 ${(distToMidBps / 100).toFixed(2)}%）后重新起势 —— 回调入场成立，止损锚在中轨外侧。`;
    }

    return { available, atMid, touchIndex, touchClose, bounced: reboundOk, entryPrice: lastClose, stopRef, distToMidBps, reason };
  };

  const longPb = pullbackRead(longSt, bands, 1);
  const shortPb = pullbackRead(shortSt, bands, -1);
  const pullback = side === 1 ? longPb : side === -1 ? shortPb : {
    available: false, atMid: false, touchIndex: null, bounced: false,
    entryPrice: null, stopRef: null, distToMidBps: null,
    reason: '没有候选方向，回调入场无从谈起。',
  };

  /** 当前该按哪种方式入场。两者互斥不了 —— 但它们对应不同的仓位批次。 */
  const entryMode = hold.level === 'H2' ? 'BREAKOUT' : pullback.available ? 'PULLBACK' : null;

  /* ── 触发成立的两条通路 ──
   *
   * 突破路（BREAKOUT）：三次推进 + 收口 + 站稳 H2 → 追进去（头仓 30%）
   * 回调路（PULLBACK）：三次推进 + 收口 + 回踩中轨不破后重新起势 → 等回踩进（主仓 70%）
   *
   * ⚠️ 关键设计：两条路**共用前两个条件**（腿数、收口），只在第三个条件上分岔。
   * 原因：腿数和收口说明的是「有没有一段像样的推进」，这是两条路的共同前提；
   * 而"站稳没站稳"和"有没有回踩"是**互斥的时点** —— 价格不可能同时
   * 既创出新高站稳、又回踩到中轨。把这两件事当成同一个门槛，
   * 结果是永远只能在"追高"和"等不到"之间二选一，正好丢掉比特皇那 70%。
   */
  const routeGaps = (extra) => {
    const g = [];
    if (legs < required) g.push(`独立推进腿只有 ${legs} 条，要求 ${required} 条`);
    if (!squeeze.ok) {
      g.push(
        squeeze.percentile === null
          ? '收口条件弃权（历史不足）'
          : `突破前带宽处于 ${squeeze.percentile} 分位，未收口`
      );
    }
    return g.concat(extra);
  };

  const breakoutGaps = side === 0 ? [] : routeGaps(hold.level !== 'H2' ? [`站稳等级 ${hold.level}，需要 H2`] : []);
  const pullbackGaps = side === 0 ? [] : routeGaps(pullback.available ? [] : [`回调入场不成立（${pullback.reason}）`]);

  const breakoutOk = side !== 0 && breakoutGaps.length === 0;
  const pullbackOk = side !== 0 && pullbackGaps.length === 0;

  // blockers = 还剩几个条件没满足。只要有一条通路打通就是空数组。
  // 两条都不通时，报**缺口更少**的那条 —— 那才是「最接近成立」的路，
  // 报另一条会让读的人以为要等的是别的东西。
  const blockers =
    side === 0 || breakoutOk || pullbackOk
      ? []
      : breakoutGaps.length <= pullbackGaps.length
        ? breakoutGaps
        : pullbackGaps;

  let reason;
  if (side === 0) reason = '窗口内没有出现有效突破腿，无触发。';
  else if (breakoutOk)
    reason = `第 ${legs} 条推进腿成立且已站稳（${hold.bars} 根），收口条件满足 —— 突破入场成立（头仓），等待方向层放行。`;
  else if (pullbackOk)
    reason = `第 ${legs} 条推进腿成立、收口满足，且已回踩中轨不破后重新起势 —— 回调入场成立（主仓），等待方向层放行。`;
  else reason = `正在酝酿（${side === 1 ? '向上' : '向下'}）：${blockers.join('；')}。`;

  return {
    side,
    longLegs: longEval.legs.length,
    shortLegs: shortEval.legs.length,
    required,
    hold,
    squeeze,
    /** 回调入场读数（比特皇那 70% 的仓位挂在哪） */
    pullback,
    /** 当前该按哪种方式入场：BREAKOUT 追突破 / PULLBACK 等回踩 / null 都不成立 */
    entryMode,
    /** 两条通路各自的成立标记 —— 用于解释「是哪条路通了」 */
    breakoutOk,
    pullbackOk,
    bands,
    marks: marks.sort((a, b) => a.index - b.index),
    legs: pick
      ? pick.legs.map((l) => ({ startIndex: l.startIndex, bars: l.bars, refBand: l.refBand, refBandLast: l.refBandLast, peak: l.peak, ongoing: l.ongoing }))
      : [],
    closesLen: closes.length,
    blockers,
    reason,
    // 兼容字段：若调用方还想要旧版的「裸方向」，用这个 —— 但它**不是方向**，
    // 只是触发侧面。真正能不能开单必须过 gate()。
    setupSide: side,
  };
}

/* ══════════════════ 门禁：把两套系统接起来 ══════════════════ */

/**
 * gate —— 系统一与系统二的唯一交汇点。
 *
 * 四种输出状态：
 *   SIGNAL  方向放行 + 触发成立 → 可开单
 *   ARMED   方向放行但触发未完成 → 挂在弦上，等确认
 *   VETOED  触发的方向与宏观方向相反 → 逆势信号被挡（这个计数本身是重要读数：
 *           它衡量「宏观在压着微观」的力度）
 *   IDLE    无触发，或宏观方向未定
 *
 * @param {object} args { regime, setup, cfg, markWad }
 */
export function gate({ regime, setup, cfg = {}, markWad = null } = {}) {
  const base = {
    state: 'IDLE',
    side: 0,
    entry: markWad,
    stopRef: null,
    stopDistanceBps: null,
    rUnit: null,
    blockers: [],
    reason: '',
    macroBias: regime ? regime.bias : null,
  };

  if (!setup || setup.side === 0) {
    return { ...base, reason: setup ? setup.reason : '未计算触发层。' };
  }
  if (!regime) {
    return { ...base, side: setup.side, reason: '未接入宏观方向层 —— 无法判定该方向是否被允许，按不开仓处理。' };
  }

  const want = setup.side; // 1 多 / -1 空
  const directionAllowed = want === 1 ? regime.allowLong : regime.allowShort;

  // 追高否决：**独立检查**，不依赖调用方把 allowLong 提前置 false。
  // 早先这里是嵌在「方向不允许」分支里的，于是只要调用方传了 allowLong=true，
  // 追高这道闸就会被整个跳过 —— 测试抓到过这个缺陷。闸门就该自己判自己的条件。
  const chaseBlocked = want === 1 && regime.bias === 'LONG_ONLY' && regime.chaseBlocked;
  if (chaseBlocked) {
    const ext = regime.structure?.extensionVs200d;
    return {
      ...base,
      state: 'VETOED',
      side: want,
      reason:
        `追高否决：方向是多的、触发也成立，但价格已高于 200 日均线 ${Number.isFinite(ext) ? (ext * 100).toFixed(1) + '%' : '很多'}，` +
        `超过追高上限。方向对、位置错 —— 过热位置进场，赔率不成立。`,
    };
  }

  // 顶部刹车否决：同样**独立检查**（教训见上）。
  // 与追高否决看的东西正交 —— 追高看**位置**（离 200 日均线多远），
  // 顶部刹车看**行为**（量能派发 + 消息反应 + 拥挤度，见 src/regime-criteria.js）。
  // 一个位置不热、但市场已经开始派发的顶，只有这道闸能挡住。
  const topBrake = want === 1 && regime.bias === 'LONG_ONLY' && regime.topBrake;
  if (topBrake) {
    const rv = regime.reversal || {};
    return {
      ...base,
      state: 'VETOED',
      side: want,
      reason:
        `顶部刹车否决：方向是多的、触发也成立，但比特皇判据层有 ${rv.topVotes ?? '多'} 项指向见顶（量能派发 / 利多不涨 / 多头拥挤），要求 ≥ ${rv.minVotes ?? 2} 项。` +
        `这一条走的是「顶部是过程不是瞬间」—— 不反手做空，但也不在这里加多。` +
        (rv.evidence ? ` 证据：${rv.evidence.filter((x) => x.dir < 0).map((x) => `${x.layer}=${x.text}`).join('；')}。` : ''),
    };
  }

  // 逆势否决：宏观方向明确且与触发相反
  if (!directionAllowed) {
    const macroOpposite =
      (want === 1 && regime.bias === 'SHORT_ONLY') || (want === -1 && regime.bias === 'LONG_ONLY');
    if (macroOpposite) {
      return {
        ...base,
        state: 'VETOED',
        side: want,
        reason:
          `逆势否决：触发层看到${want === 1 ? '向上' : '向下'}的三次推进，` +
          `但宏观方向层要求「${regime.biasLabel}」。历史顶部与底部都是靠这种逆势信号骗人的，已挡下。`,
      };
    }
    return {
      ...base,
      side: want,
      state: 'IDLE',
      reason: `宏观方向「${regime.biasLabel}」不批准任何新开仓。${(regime.reasons || [])[0] || ''}`,
    };
  }

  // 方向放行：看触发是否完成
  if (setup.blockers.length) {
    return {
      ...base,
      state: 'ARMED',
      side: want,
      blockers: setup.blockers,
      reason:
        `方向层已放行（${regime.biasLabel}），触发层还差：${setup.blockers.join('；')}。` +
        `挂在弦上等确认 —— 这时候动手就是抢跑。`,
    };
  }

  // 触发完成：给入场与止损锚
  const stopBuffer = BigInt(cfg.risk?.stopBufferBps ?? 30);
  const ref = setup.hold.refPrice;
  let stopRef = null;
  let stopDistanceBps = null;
  if (ref && ref > 0n && markWad) {
    stopRef =
      want === 1
        ? ref - (ref * stopBuffer) / 10000n
        : ref + (ref * stopBuffer) / 10000n;
    const dist = markWad > stopRef ? markWad - stopRef : stopRef - markWad;
    stopDistanceBps = Number((dist * 10000n) / markWad);
  }

  const maxDist = cfg.risk?.maxStopDistanceBps ?? 1200;
  const tooFar = stopDistanceBps !== null && stopDistanceBps > maxDist;

  return {
    ...base,
    state: tooFar ? 'ARMED' : 'SIGNAL',
    side: want,
    stopRef,
    stopDistanceBps,
    blockers: tooFar ? [`止损距离 ${(stopDistanceBps / 100).toFixed(2)}% 超过上限 ${(maxDist / 100).toFixed(2)}%`] : [],
    reason: tooFar
      ? `触发与方向都成立，但按突破参考位止损的距离是 ${(stopDistanceBps / 100).toFixed(2)}%，超过 ${(maxDist / 100).toFixed(2)}% 上限 —— 这一笔的赔率不成立，放弃。`
      : `方向「${regime.biasLabel}」+ ${setup.legs.length} 条独立推进腿 + 收口后扩张 + 站稳确认 —— 三项全中，可以开单。` +
        (stopDistanceBps !== null ? `止损锚在突破参考位 ${ref} 外侧 ${(cfg.risk?.stopBufferBps ?? 30) / 100}%，距入场 ${(stopDistanceBps / 100).toFixed(2)}%。` : ''),
  };
}

/* ────────────────────── 周期相位与门槛 ────────────────────── */

/**
 * 减半周期相位。数值与合约 RiskLib.CyclePhase 的枚举顺序严格一致 ——
 * 顺序写错会让门槛整体错档，所以不要重排。
 */
export const CYCLE_PHASES = ['ACCUMULATION', 'EXPANSION', 'BLOWOFF', 'DECLINE'];

/**
 * 「相位由减半时钟推算」的哨兵值。
 *
 * 为什么需要它：在它出现之前，`phase` 的默认值是硬编码的 `ACCUMULATION`。
 * 而**方向层是直接读减半时钟的、根本不看 `phase`** —— 于是默认状态下
 * 系统会用「时钟推算是 DECLINE」去定方向，却用「手填的 ACCUMULATION」
 * 去定波动门槛。方向说只许做空、门槛却按熊末筑底的 16% 收，两边不同步。
 *
 * 这个哨兵不是「第四个相位」，也不是「忽略用户输入」：它是界面上的一个
 * 显式选项，用户选它 = 「别拿手填值当周期位置，按时钟算」。
 * 它**不能**传进 `phaseFloorBps`（那里任何非四相位值都会落到 DECLINE 档 20%，
 * 巧合正确但语义错位），必须在配置构建之前就被 `derivePhase` 解析成具体相位。
 */
export const PHASE_AUTO = 'AUTO';

/** 界面相位下拉的取值域：自动 + 四个具体相位 */
export const PHASE_CHOICES = [PHASE_AUTO, ...CYCLE_PHASES];

export const PHASE_LABELS = {
  ACCUMULATION: '筑底（熊末）',
  EXPANSION: '扩张（减半后 6~18 个月）',
  BLOWOFF: '冲顶（加速）',
  DECLINE: '单边下跌',
};

/** 与合约 RiskLib.phaseFloorBps 完全一致。
 *  ⚠ 传入非四相位值（含 PHASE_AUTO）会静默落到 DECLINE 档 —— 调用方必须
 *  先用 `derivePhase` 把 PHASE_AUTO 解析掉。 */
export function phaseFloorBps(phase) {
  if (phase === 'ACCUMULATION') return 1600; // 16%
  if (phase === 'EXPANSION') return 2500; // 25%
  if (phase === 'BLOWOFF') return 3500; // 35%
  return 2000; // DECLINE 20%
}

/** 任何相位都不得跌破的绝对下限 */
export const EXPECTED_MOVE_HARD_FLOOR_BPS = 1200;

/** 硬约束常量，与利链上 RiskLib 一致 */
export const RISK_PER_TRADE_HARD_CAP_BPS = 500; // 单笔止损 ≤ 权益 5%
export const LEVERAGE_HARD_CAP = 20;
export const MAX_STOP_DISTANCE_HARD_CAP_BPS = 5000;
/** 伪造护栏：序列内单根偏离中位超过此值视为异常数据 */
export const MAX_SERIES_DEVIATION_BPS = 8000;

/* ────────────────────── 参数与默认配置 ────────────────────── */

/** 逐条对应《比特皇精华总结》的默认参数（与 script/deploy.js 一致） */
export function defaultParams(phase = 'ACCUMULATION') {
  return {
    riskPerTradeBps: 500, // 每次止损 ≤ 总资金 5%（硬上限，不可提高）
    breakBatchBps: 3000, // 突破批次 30%
    pullbackBatchBps: 7000, // 回调批次 70%
    stopBufferBps: 30, // 结构位外留 0.30% 缓冲
    pyramidMaxAdds: 2, // 浮盈加仓最多 2 次
    pyramidRatioBps: 5000, // 首次加仓 = 初始量 50%，之后逐次减半
    pyramidTriggerBps: 500, // 浮盈 ≥5% 才允许加仓
    minExpectedMoveBps: Math.max(phaseFloorBps(phase), 1800), // 按相位取
    maxStopDistanceBps: 1200, // 止损距离上限 12%
  };
}

export function defaultConfig(phase = 'ACCUMULATION') {
  return {
    risk: defaultParams(phase),
    cyclePhase: phase,
    trendPeriod: 20,
    trendStdMultBps: 20000, // BOLL(20, 2σ)
    trendRequiredBreaks: 3,
    trendLookbackBars: 48,
    trendMinPenetrationBps: 10,
    trendMinGapBars: 1,

    /* ── 系统二：战术触发层的语义参数 ──
     * 这几个是「三次突破站稳」这句话到底怎么落实的地方，改它们等于改形态定义。 */
    setupMinLegBars: 1, // 一条推进腿至少要几根收在轨外才作数
    setupMinInsideBars: 1, // 两条腿之间至少要几根收回轨内（>=1 才能保证是"三段独立推进"）
    setupHoldBars: 2, // 站稳确认：末条腿要持续几根（H2 门槛）
    squeezeLookbackBars: 100, // 带宽百分位的回看窗口
    squeezeMaxPercentile: 25, // 突破**前**带宽处于该分位以内才算"收口后扩张"

    /* ── 回调入场（比特皇那 70% 的仓位）──
     * 原话：「多头趋势：4H BOLL 中轨支撑回调入场 …… 强势不回调时分批建仓：
     *        突破时买 30%，回调时买 70%」 */
    pullbackTouchTolBps: 120, // 收盘落在中轨 ±1.2% 内算「触及中轨」
    pullbackLookbackBars: 12, // 在最近多少根里找这次回踩
    pullbackMinReboundBps: 0, // 重新起势的最小幅度（0 = 只要站回触及那根的有利一侧即可）

    /* ── 系统一：宏观方向层的迟滞参数 ── */
    regimeConfirmDays: 5, // 方向翻转需要连续成立几天才生效
    regimeMinHoldDays: 20, // 生效后最短持有几天
    shockWindowDays: 30, // 黑天鹅发生后多少天内继续冻结新开仓
    shockCooldownDays: 7, // 黑天鹅发生后多少天内不再被同一条事件重复触发（冷却）
    /* 追高禁令阈值：价格高于 200 日均线的幅度上限。
     * 注意判据是「离长期均线多远」而不是「离历史最高多近」——
     * 牛市里价格本来就该贴着最高点走，用回撤判追高会把整段主升浪封死。 */
    chaseMaxExtensionPct: 0.5,

    /* ── 比特皇判据层（A4~A7，src/regime-criteria.js）──
     * 这几组参数对应《比特皇精华总结 / 语录 / 交易心得》里的原话。
     * 每一条都写了它对应哪句话，改参数之前请先看那句话。 */
    // A4 技术面补充
    ma120Window: 120, // 比特皇点名的 120 日线
    bearDrawdownPct: 0.25, // 牛转熊：距历史最高回撤门槛
    bearStaleMonths: 3, // 牛转熊：连续几个月未创新高
    bearGateMonths: 15, // 牛转熊只在减半后第几个月起才计票（否则周期起点必然误报）
    // A5 情绪拥挤度（资金费率的自身分位）
    fundingLookback: 90, // 分位窗口
    fundingExtremePercentile: 15, // 低于该分位 = 空头拥挤，高于 100-该值 = 多头拥挤
    sentimentHoldBars: 10, // 判断价格是否止跌/滞涨的窗口
    // A6 量能形态
    volumeLookback: 90, // 量能分位窗口
    volumeLegBars: 20, // 一条"腿"的根数
    volumeSpikePercentile: 90, // 暴量门槛
    volumeDryRatio: 0.8, // 均量萎缩到前段的百分之多少算"枯竭"
    legFlatPct: 0.03, // 涨跌幅小于该值算横盘
    // A7 事件反应检验
    reactionMinWeight: 0.3, // 只看权重显著的条目
    reactionDays: 14, // 事件后观察多少天
    reactionFlatPct: 0.02, // 「没动」的容差
    reactionMaxItems: 6, // 最多检验最近几条
    // 反转合成
    reversalMinVotes: 2, // 见底/见顶各需几票才能成立

    leverageCap: 10, // 配置层上限（硬上限 20）
    breakevenBufferBps: 30,
    minRewardRiskBps: 10000, // 盈亏比 ≥1
    maxAddsRiskBps: 50, // 加仓后最坏亏损 ≤ 权益 0.5%
    takeProfitBps: 0, // 不设固定止盈

    /* ── 阶段三：持仓管理的三条比特皇原话 ──
     * ①「浮盈加仓，是回撤在起势的时候加仓，让起势飞一会不要怕加晚」 */
    addLookbackBars: 40, // 找「最近一次回撤」的回看窗口
    addPullbackMinPct: 0.03, // 回撤多深才算「经历了一次回撤」
    addResumeReboundRatio: 0.5, // 要收复多少回撤幅度才算「重新起势」
    addResumeMinBars: 2, // 低点之后至少过几根才算「飞了一会」
    /* ②「永远不要在最高点卖出，而是等到价格调整后没有反弹再卖出」 */
    exitLookbackBars: 40,
    exitMinDrawdownPct: 0.08, // 回撤多深才值得谈离场（滤掉日内噪音）
    exitMaxReboundRatio: 0.5, // 反弹收复超过这个比例 → 反弹有效，不走
    exitConfirmBars: 6, // 低点之后给多少根机会反弹
    /* ③「下跌趋势下，有一个重大利空新闻马上平仓」 */
    exitNewsMinWeight: 1.0, // 多重要的负面事件才够「重大」
    exitNewsWindowDays: 10, // 事件发生多少天内仍然算数
  };
}

/** 权益 -> 杠杆档位。按顺序取第一个 maxEquityWad ≥ equity 的行。 */
export function defaultTiers() {
  return [
    { maxEquityWad: toWad(10000), leverage: 10 },
    { maxEquityWad: toWad(100000), leverage: 10 },
    { maxEquityWad: toWad(3000000), leverage: 5 },
    { maxEquityWad: 2n ** 255n, leverage: 3 },
  ];
}

export function leverageFor(equityWad, tiers, cap) {
  for (const t of tiers) {
    if (equityWad <= t.maxEquityWad) return Math.min(t.leverage, cap ?? LEVERAGE_HARD_CAP);
  }
  return 1;
}

/**
 * 参数校验：与合约 RiskLib.validateParams 同序同规则。
 * 这里在「写入配置」阶段就拦住 —— 界面只允许比相位下限更严，不能更松。
 */
export function validateParams(p, phase = 'ACCUMULATION') {
  const err = (m) => {
    throw new Error(`参数非法：${m}`);
  };
  if (!Number.isInteger(p.riskPerTradeBps) || p.riskPerTradeBps <= 0) err('riskPerTradeBps 必须为正整数');
  if (p.riskPerTradeBps > RISK_PER_TRADE_HARD_CAP_BPS) err(`riskPerTradeBps 不得超过 5%（硬上限）`);
  if (p.breakBatchBps + p.pullbackBatchBps !== 10000) err('分批比例之和必须为 100%');
  if (p.stopBufferBps > 1000) err('stopBufferBps 不得超过 10%');
  if (p.maxStopDistanceBps <= 0 || p.maxStopDistanceBps > MAX_STOP_DISTANCE_HARD_CAP_BPS)
    err('maxStopDistanceBps 必须在 0~50% 之间');
  if (p.pyramidRatioBps > 10000) err('pyramidRatioBps 不得超过 100%');
  if (p.pyramidMaxAdds > 8) err('pyramidMaxAdds 不得超过 8');
  if (p.minExpectedMoveBps <= 0 || p.minExpectedMoveBps > 10000) err('minExpectedMoveBps 必须在 0~100% 之间');
  if (p.minExpectedMoveBps < EXPECTED_MOVE_HARD_FLOOR_BPS)
    err(`minExpectedMoveBps 不得低于绝对地板 ${EXPECTED_MOVE_HARD_FLOOR_BPS / 100}%`);
  const floor = phaseFloorBps(phase);
  if (p.minExpectedMoveBps < floor)
    err(
      `minExpectedMoveBps(${p.minExpectedMoveBps / 100}%) 低于「${PHASE_LABELS[phase] || phase}」` +
        `相位的下限 ${floor / 100}% —— 只能更严，不能更松`
    );
  return true;
}

/* ────────────────────── 资金管理数学 ────────────────────── */

const mulDiv = (a, b, c) => (a * b) / c;

/**
 * 由「单笔风险预算」反推仓位。
 *   风险预算 = 权益 × riskPerTradeBps
 *   数量     = 风险预算 ÷ 止损距离
 * 再套一层杠杆约束：名义价值不得超过 权益 × 杠杆 × 90%。
 */
export function initialSize(equityWad, entryWad, stopWad, leverage, params) {
  const riskBudget = mulDiv(equityWad, BigInt(params.riskPerTradeBps), BPS);
  const stopDist = entryWad > stopWad ? entryWad - stopWad : stopWad - entryWad;
  if (stopDist === 0n) {
    return { qty: 0n, stopDist: 0n, riskBudget, lossAtStop: 0n, notional: 0n, cappedByLeverage: false };
  }
  let qty = mulDiv(riskBudget, WAD, stopDist);
  let cappedByLeverage = false;
  const maxNotional = mulDiv(mulDiv(equityWad, BigInt(leverage), 1n), 9000n, BPS);
  if (mulDiv(qty, entryWad, WAD) > maxNotional) {
    qty = mulDiv(maxNotional, WAD, entryWad);
    cappedByLeverage = true;
  }
  return {
    qty,
    stopDist,
    riskBudget,
    lossAtStop: mulDiv(qty, stopDist, WAD),
    notional: mulDiv(qty, entryWad, WAD),
    cappedByLeverage,
  };
}

/**
 * 金字塔递减加仓量：initialQty × ratioBps / BPS >> addIndex
 * addIndex=0 -> 50%，1 -> 25%，2 -> 12.5% …
 */
export function pyramidAddQty(initialQtyWad, addIndex, params) {
  if (addIndex < 0 || addIndex >= 64) return 0n;
  return mulDiv(initialQtyWad, BigInt(params.pyramidRatioBps), BPS) >> BigInt(addIndex);
}

/** 浮盈是否已达到允许加仓的阈值（以混合成本为基准） */
export function canPyramid(avgEntryWad, markWad, isLong, params) {
  const profit = isLong ? markWad - avgEntryWad : avgEntryWad - markWad;
  if (profit <= 0n) return false;
  return profit * BPS >= avgEntryWad * BigInt(params.pyramidTriggerBps);
}

/* ══════════════ 阶段三：比特皇的持仓管理判据 ══════════════
 *
 * 这三个函数回答的三个问题，全部来自比特皇原话，且在引入之前系统里**完全没有**：
 *   ① 什么时候加仓  —— 「浮盈加仓，是回撤在起势的时候加仓，让起势飞一会不要怕加晚」
 *   ② 什么时候止盈  —— 「永远不要在最高点卖出，而是等到价格调整后没有反弹再卖出」
 *   ③ 什么时候立刻走 —— 「下跌趋势下，有一个重大利空新闻马上平仓，防止回撤利润」
 *
 * 为什么它们必须是独立函数而不是塞进 canPyramid：
 *   只判「浮盈 ≥ 5%」会把**追高**也算成合法加仓点 —— 涨得越多越加，
 *   这恰恰是比特皇在《最愚蠢的行为》里骂的那种做法。加仓点要的是「起势」，
 *   不是「涨了很多」，这两件事的差别只有在 K 线序列上才能算出来。
 */

/**
 * ① 回撤后是否重新起势 —— 决定这一档加仓能不能加。
 *
 * 判定分三种情形，刻意区分「没回撤过」与「回撤了但没起来」：
 *   · 直线拉升（窗口内当前就是极值）→ straightRun，不拦（但界面会标注这是次优加仓点）
 *   · 回撤过、且已收复 ≥ 指定比例 → resumed = true，这是比特皇说的那个点
 *   · 回撤过、但还没收起来     → resumed = false，**这是主要拦截面**：
 *     回撤还没起势就加仓，等于在下跌途中往下摊平，是「拉均价」的变种
 *
 * @param {bigint[]} closes 收盘序列（WAD）
 * @param {boolean} isLong 持仓方向
 * @param {object} cfg 配置（addLookbackBars / addPullbackMinPct / addResumeReboundRatio / addResumeMinBars）
 */
export function pullbackResumeRead(closes, isLong, cfg = {}) {
  const empty = {
    available: false, pulledBack: false, straightRun: false,
    peakIndex: null, troughIndex: null, peak: null, trough: null,
    depthPct: 0, reboundRatio: 0, barsSinceTrough: 0,
    resumed: false, reason: 'K 线不足，无法判断回撤是否已重新起势。',
  };
  if (!closes || closes.length < 4) return empty;

  const end = closes.length - 1;
  const lookback = cfg.addLookbackBars ?? 40;
  const from = Math.max(0, end - lookback + 1);
  const minDepth = cfg.addPullbackMinPct ?? 0.03;
  const minRebound = cfg.addResumeReboundRatio ?? 0.5;
  const minBars = cfg.addResumeMinBars ?? 2;
  const requirePullback = cfg.addRequirePullback === true; // 默认 false：见下文「直线行情」处理

  const better = (a, b) => (isLong ? a > b : a < b); // a 比 b 更有利
  const relDrop = (hi, lo) => (hi === 0n ? 0 : Number((((hi > lo ? hi - lo : lo - hi) * BPS) / hi)) / 10000);

  /* 找「最后一次显著回撤」——必须扫描，不能只看窗口极值是不是当前根。
   *
   * 为什么：只看极值会把「涨 → 回撤 13% → 再创新高」误判成"直线拉升"，
   * 而这恰恰是最典型、最该加仓的一种行情。回撤是**过程**，不是**终点**，
   * 用终点反推过程，必然把"已经收复的回撤"抹掉。 */
  let pbPeakIndex = null;
  let pbTroughIndex = null;
  let run = closes[from];
  let runIndex = from;

  for (let i = from + 1; i <= end; i++) {
    const c = closes[i];
    if (better(c, run)) {
      run = c;
      runIndex = i;
      continue;
    }
    if (relDrop(run, c) < minDepth) continue; // 还没回撤够深，不算一次回撤
    if (pbPeakIndex !== runIndex) {
      // 从 runIndex 起算的**新的**一次回撤
      pbPeakIndex = runIndex;
      pbTroughIndex = i;
    } else if (isLong ? c < closes[pbTroughIndex] : c > closes[pbTroughIndex]) {
      // 同一次回撤里继续走低，把低点往后挪
      pbTroughIndex = i;
    }
  }

  // 窗口内一次像样的回撤都没有 → 直线行情
  if (pbPeakIndex === null) {
    const resumed = !requirePullback;
    return {
      ...empty,
      available: true,
      straightRun: true,
      pulledBack: false,
      peak: run, peakIndex: runIndex,
      resumed,
      reason: resumed
        ? `近 ${end - from + 1} 根内没有出现 ≥ ${(minDepth * 100).toFixed(1)}% 的回撤 —— 属于直线${isLong ? '拉升' : '下跌'}中加仓。比特皇的加仓点在「回撤后起势」处，这里是**次优**位置（已放开，但别把它当成首选加仓点）。`
        : `近 ${end - from + 1} 根内没有出现 ≥ ${(minDepth * 100).toFixed(1)}% 的回撤 —— 属于直线${isLong ? '拉升' : '下跌'}。配置要求必须有回撤才加仓，故不放行。`,
    };
  }

  const peak = closes[pbPeakIndex];
  const trough = closes[pbTroughIndex];
  const span = peak > trough ? peak - trough : trough - peak;
  const depthPct = relDrop(peak, trough);
  const last = closes[end];
  const offTrough = last > trough ? last - trough : trough - last;
  // 收复比例可能 > 100%（已经创新高），夹到 1 —— 创新高就是最彻底的「起势」
  const reboundRatio = span === 0n ? 1 : Math.min(1, Number((offTrough * BPS) / span) / 10000);
  const barsSinceTrough = end - pbTroughIndex;
  const resumed = reboundRatio >= minRebound && barsSinceTrough >= minBars;

  let reason;
  if (barsSinceTrough < minBars) {
    reason =
      pbTroughIndex === end
        ? `回撤 ${(depthPct * 100).toFixed(2)}%，且**最新一根就是最低点** —— 回撤还在进行中，谈"起势"为时过早。比特皇：「让起势飞一会不要怕加晚」。`
        : `低点（第 ${pbTroughIndex} 根）刚过 ${barsSinceTrough} 根，少于要求的 ${minBars} 根 —— 让它再飞一会。`;
  } else if (reboundRatio < minRebound) {
    reason = `回撤 ${(depthPct * 100).toFixed(2)}% 后只收复了 ${(reboundRatio * 100).toFixed(0)}%（要求 ≥ ${(minRebound * 100).toFixed(0)}%）—— 还没重新起势就加仓，等于在下跌途中往下摊平，这正是比特皇说的「最愚蠢的行为」。`;
  } else {
    reason = `回撤 ${(depthPct * 100).toFixed(2)}% 后已收复 ${(reboundRatio * 100).toFixed(0)}%，低点已过 ${barsSinceTrough} 根 —— 回撤后重新起势，这是比特皇说的那个加仓点。`;
  }

  return {
    available: true, pulledBack: true, straightRun: false,
    peakIndex: pbPeakIndex, troughIndex: pbTroughIndex, peak, trough,
    depthPct, reboundRatio, barsSinceTrough,
    resumed, reason,
  };
}

/**
 * ② 是否「调整后没有反弹」—— 决定要不要离场。
 *
 * 比特皇反对"猜最高点"：「永远不要在最高点卖出，而是等到价格调整后没有反弹再卖出」。
 * 这句话反过来读就是判据：不要求卖在顶上，只要求在**调整之后确认没反弹**时卖出。
 *
 * 三个条件同时成立才算：
 *   1. 从近期极值已回撤 ≥ exitMinDrawdownPct（够深，不是日内噪音）
 *   2. 反弹只收复了 ≤ exitMaxReboundRatio（没抬起来）
 *   3. 距低点已过 ≥ exitConfirmBars 根（给了它反弹的机会，它没抓住）
 * 第 3 条是关键：刚跌下去就喊"没反弹"会把每一次正常回踩都变成离场信号。
 *
 * @param {bigint[]} closes 收盘序列（WAD）
 * @param {boolean} isLong 持仓方向
 * @param {object} cfg 配置
 */
export function failedBounceRead(closes, isLong, cfg = {}) {
  const empty = {
    available: false, failedBounce: false,
    peakIndex: null, troughIndex: null, peak: null, trough: null,
    depthPct: 0, reboundRatio: 0, barsSinceTrough: 0,
    reason: 'K 线不足，无法判断调整后是否反弹。',
  };
  if (!closes || closes.length < 4) return empty;

  const end = closes.length - 1;
  const lookback = cfg.exitLookbackBars ?? 40;
  const from = Math.max(0, end - lookback + 1);
  const minDepth = cfg.exitMinDrawdownPct ?? 0.08;
  const maxRebound = cfg.exitMaxReboundRatio ?? 0.5;
  const confirmBars = cfg.exitConfirmBars ?? 6;

  const better = (a, b) => (isLong ? a > b : a < b);
  let peak = closes[from];
  let peakIndex = from;
  for (let i = from; i <= end; i++) {
    if (better(closes[i], peak)) {
      peak = closes[i];
      peakIndex = i;
    }
  }

  let trough = closes[peakIndex];
  let troughIndex = peakIndex;
  for (let i = peakIndex; i <= end; i++) {
    if (isLong ? closes[i] < trough : closes[i] > trough) {
      trough = closes[i];
      troughIndex = i;
    }
  }

  const span = peak > trough ? peak - trough : trough - peak;
  const depthPct = peak === 0n ? 0 : Number((span * BPS) / peak) / 10000;
  const last = closes[end];
  const offTrough = last > trough ? last - trough : trough - last;
  const reboundRatio = span === 0n ? 0 : Number((offTrough * BPS) / span) / 10000;
  const barsSinceTrough = end - troughIndex;

  const deepEnough = depthPct >= minDepth;
  const notRebounded = reboundRatio <= maxRebound;
  const confirmed = barsSinceTrough >= confirmBars;
  const failedBounce = deepEnough && notRebounded && confirmed;

  let reason;
  if (!deepEnough) {
    reason = `距近期${isLong ? '高' : '低'}点只回撤 ${(depthPct * 100).toFixed(2)}%，未达 ${(minDepth * 100).toFixed(1)}% —— 属于正常波动，不构成离场信号。`;
  } else if (!confirmed) {
    reason = `已回撤 ${(depthPct * 100).toFixed(2)}%，但才过了 ${barsSinceTrough} 根（要求 ≥ ${confirmBars} 根）—— 要给它反弹的机会，现在喊"没反弹"太早。`;
  } else if (!notRebounded) {
    reason = `回撤 ${(depthPct * 100).toFixed(2)}% 后已反弹收复 ${(reboundRatio * 100).toFixed(0)}% —— 反弹是有效的，继续持有。`;
  } else {
    reason = `回撤 ${(depthPct * 100).toFixed(2)}% 后 ${barsSinceTrough} 根内只收复 ${(reboundRatio * 100).toFixed(0)}% —— 「价格调整后没有反弹」，按原话该走了。不要等到跌回成本才动。`;
  }

  return {
    available: true, failedBounce,
    peakIndex, troughIndex, peak, trough,
    depthPct, reboundRatio, barsSinceTrough,
    reason,
  };
}

/**
 * ③ 是否出现「重大利空，马上平仓」。
 *
 * 原话：「下跌趋势下，有一个重大利空新闻马上平仓，防止回撤利润。」
 *
 * 这是整个系统里**唯一允许抢在技术止损位之前离场**的通道。
 * 为什么只给它这个特权：技术位是滞后的（要等收盘、要等回撤幅度），
 * 而利空是即时的。等价格跌破中轨时，回撤的利润已经回撤完了。
 *
 * 怎么判"重大"：事件表里 ageDays 在窗口内、有效权重与持仓方向**相反**、
 * 且 |有效权重| 超过阈值。半衰期衰减已在事件层算过，这里直接用 effective。
 *
 * @param {object} args { regime, isLong, cfg }
 */
export function adverseNewsExit({ regime, isLong, cfg = {} } = {}) {
  const ev = regime && regime.events;
  if (!ev) {
    return { available: false, active: false, items: [], reason: '未接入事件层 —— 无法判定是否有重大利空，本通道弃权（不静默按"没有"处理）。' };
  }
  const minAbs = cfg.exitNewsMinWeight ?? 1.0;
  const windowDays = cfg.exitNewsWindowDays ?? 10;

  const adverse = (ev.items || []).filter(
    (x) =>
      !x.pending &&
      Number.isFinite(x.ageDays) &&
      x.ageDays >= 0 &&
      x.ageDays <= windowDays &&
      (isLong ? x.effective < 0 : x.effective > 0) &&
      Math.abs(x.effective) >= minAbs
  );

  // 黑天鹅：事件层里 effective ≤ -1 的重事件，永远与多头相反。
  // 事件层自己的说法是「只管理既有仓位」—— 那么持有逆势仓位时它就是平仓信号。
  const shockActive = !!(ev.shock && ev.shock.active) && isLong;

  const active = adverse.length > 0 || shockActive;
  let reason;
  if (active) {
    reason =
      (shockActive ? `黑天鹅事件仍在冷却窗口内；` : '') +
      `事件层出现 ${adverse.length} 条与持仓方向相反的显著事件 —— ` +
      `按原话「有一个重大利空新闻马上平仓，防止回撤利润」，不等技术位，立即离场。`;
  } else {
    reason = `窗口（${windowDays} 天）内没有与持仓方向相反的显著事件（阈值 |权重| ≥ ${minAbs}）—— 本通道无信号。`;
  }

  return {
    available: true,
    active,
    items: adverse.map((x) => ({ id: x.id, date: x.date, note: x.note, effective: x.effective, ageDays: x.ageDays })),
    shockActive,
    reason,
  };
}

/** 加权平均开仓价 */
export function blendedEntry(q1, e1, q2, e2) {
  const denom = q1 + q2;
  if (denom === 0n) return 0n;
  return mulDiv(mulDiv(q1, e1, WAD) + mulDiv(q2, e2, WAD), WAD, denom);
}

/** 保本止损位 —— 加仓后止损上移到「保本或更好」，最坏情况是接近 0 的擦伤而非真实亏损。
 * buffer 站在成本的外侧，与 bithuang-onchain RiskLib.breakevenStop 以及 ai-trader
 * trail_stop_to_entry（long 0.997 / short 1.003）三处口径一致：
 *   多头挂在成本下方一点、空头挂在成本上方一点，既不会贴着成本线上下扫损，
 *   也不会把止损抬进盈利区提前把正常回撤扫出去。 */
export function breakevenStop(avgEntryWad, isLong, bufferBps) {
  const off = mulDiv(avgEntryWad, BigInt(bufferBps), BPS);
  return isLong ? avgEntryWad - off : avgEntryWad + off;
}

/** 价格跌/涨到 price 时的亏损额（只返回正数；盈利返回 0） */
export function lossAtPrice(qtyWad, avgWad, priceWad, isLong) {
  const d = isLong ? priceWad - avgWad : avgWad - priceWad;
  const p = (qtyWad * d) / WAD;
  return p < 0n ? -p : 0n;
}

/** 未实现盈亏 */
export function unrealizedPnl(qtyWad, avgWad, priceWad, isLong) {
  const d = isLong ? priceWad - avgWad : avgWad - priceWad;
  return (qtyWad * d) / WAD;
}

/** 结构止损位：参考位外侧留 buffer */
export function stopFromReference(refWad, isLong, bufferBps) {
  const off = mulDiv(refWad, BigInt(bufferBps), BPS);
  return isLong ? refWad - off : refWad + off;
}

/** 两个价格之间的相对距离（bps） */
export function distanceBps(a, b) {
  if (a === 0n || b === 0n) return 0;
  const diff = a > b ? a - b : b - a;
  return Number((diff * BPS) / (a > b ? b : a));
}
