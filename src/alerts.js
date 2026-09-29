/**
 * 预警规则引擎 —— 纯函数、无副作用、无 IO。后端 watcher 与前端看板共用同一份实现，
 * 所以「推送给你的」和「屏幕上看到的」不会漂移。
 *
 * 三类预警：
 *   1. 仓位风险（risk）    —— 逼近清算、逼近/击穿止损、4H 收盘破坏趋势、超风险预算、杠杆超限
 *   2. 资金费异常（funding）—— 当前资金费率的**不利**方向年化成本异常偏离该标的自身基准
 *   3. 滚仓条件（roll）    —— 浮盈达到加仓阈值、滚仓阶梯某档被触及、趋势已不支撑（禁止加仓）
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 设计要点（每一条都是「做错了就会把预警功能做废」的地方）
 *
 * · **边沿触发 + 迟滞**。价格在阈值附近抖动时，逐轮轮询会在几分钟内产生几十条重复推送，
 *   用户会直接关掉预警。所以「触发线」与「恢复线」分开：必须退到更宽松的 clear 才算解除。
 *
 * · **持续恶化按冷却重发**。严重度不变时按 cooldownMs 重发一次提醒；严重度升级立即发。
 *
 * · **数据缺失绝不清空活动集**。快照拉失败时原样保留上一次的状态 —— 否则交易所抖一下，
 *   界面就会刷出一堆「已恢复」，把真正的风险淹没掉。
 *
 * · **首次运行只发 critical**。否则启动瞬间会推送十几条历史既存状态。默认策略可在配置里改。
 *
 * · **收盘口径**。趋势破坏用「最后一根**已收盘** K 线」，不用未收盘那根的实时价 ——
 *   否则盘中一根插针就能把「趋势结束」推出去。这条规则的刷新频率天然就是 4 小时一次。
 *
 * · **不利方向**。资金费与趋势破坏都只看「对我方不利」的那一侧：反向收资金费不是风险，
 *   是补贴，不该告警。
 */

import { BPS, asWad, parseWad, wadToNumber } from './strategy.js';

/** 资金费按小时结算，年化系数 */
export const HOURS_PER_YEAR = 8760;

export const SEVERITY_RANK = { info: 0, warn: 1, critical: 2 };

export const FAMILY_LABELS = Object.freeze({
  risk: '仓位风险',
  funding: '资金费',
  roll: '滚仓',
});

export const RULE_LABELS = Object.freeze({
  'liq-approach': '逼近清算',
  'stop-approach': '逼近止损',
  'stop-breached': '击穿止损',
  'trend-exit': '趋势破坏',
  'over-budget': '超风险预算',
  'leverage-cap': '杠杆超限',
  'funding-cost': '资金费异常',
  'roll-ready': '滚仓条件达成',
  'roll-step': '滚仓档位触发',
  'roll-blocked': '滚仓被趋势否决',
});

export const SEVERITY_LABELS = Object.freeze({
  info: '提示',
  warn: '警告',
  critical: '严重',
});

/**
 * 默认阈值。所有「比例」都是小数（0.15 = 15%），所有「bps」都是万分比整数。
 * 单位混淆是这类系统最常见的一类错，所以每个字段都写明单位。
 */
export const ALERT_DEFAULTS = Object.freeze({
  enabled: true,
  /** 首次运行（无历史状态）时的推送策略：critical | all | silent */
  priming: 'critical',
  /** 同一告警在严重度不变时的重复提醒间隔 */
  cooldownMs: 30 * 60 * 1000,
  /** 恢复时是否也推一条 */
  notifyRecovery: true,
  risk: {
    /** 标记价距清算价的比例距离（比例） */
    liq: { warn: 0.15, critical: 0.06, clear: 0.2 },
    /** 标记价距推荐止损的比例距离（比例） */
    stopApproach: { warn: 0.02, critical: 0.005, clear: 0.035 },
    /** 击穿止损后，要退回止损的安全侧多少比例才算恢复 */
    stopBreached: { clear: 0.005 },
    /** 4H 收盘越过中轨后，要退回多少比例才算恢复 */
    trendExit: { clear: 0.005 },
    /** 止损触发亏损占权益（比例）。warn 线对齐策略的 5% 单笔风险预算 */
    overBudget: { warn: 0.05, critical: 0.08, clear: 0.04 },
    /** 实际杠杆 ÷ 配置上限（倍数） */
    leverageCap: { warn: 1.0, critical: 1.5, clear: 0.9 },
  },
  funding: {
    /** 不利方向年化费率（比例，0.25 = 25%/年） */
    adverseApr: { warn: 0.25, critical: 0.75, clear: 0.18 },
    /** 不利方向年化费率 ÷ 该标的自身基准（倍数） */
    vsBaseline: { warn: 2.5, critical: 4, clear: 1.8 },
    /** 年化不利资金费占权益比（比例） */
    costPctEquity: { warn: 0.03, critical: 0.1, clear: 0.015 },
  },
  roll: {
    /** 滚仓阶梯触发的迟滞宽度（bps） */
    stepHysteresisBps: 10,
    /** 浮盈达阈值的恢复系数：恢复线 = 触发阈值 × 该系数 */
    readyClearRatio: 0.8,
  },
});

/** 深合并用户配置（只覆盖认识的字段，未知字段忽略 —— 配置写错不该让引擎崩） */
export function resolveConfig(user) {
  const d = ALERT_DEFAULTS;
  const u = user || {};
  const pick = (a, b) => ({ ...a, ...(b && typeof b === 'object' ? b : {}) });
  return {
    enabled: u.enabled ?? d.enabled,
    priming: u.priming ?? d.priming,
    cooldownMs: Number.isFinite(u.cooldownMs) ? u.cooldownMs : d.cooldownMs,
    notifyRecovery: u.notifyRecovery ?? d.notifyRecovery,
    risk: {
      liq: pick(d.risk.liq, u.risk?.liq),
      stopApproach: pick(d.risk.stopApproach, u.risk?.stopApproach),
      stopBreached: pick(d.risk.stopBreached, u.risk?.stopBreached),
      trendExit: pick(d.risk.trendExit, u.risk?.trendExit),
      overBudget: pick(d.risk.overBudget, u.risk?.overBudget),
      leverageCap: pick(d.risk.leverageCap, u.risk?.leverageCap),
    },
    funding: {
      adverseApr: pick(d.funding.adverseApr, u.funding?.adverseApr),
      vsBaseline: pick(d.funding.vsBaseline, u.funding?.vsBaseline),
      costPctEquity: pick(d.funding.costPctEquity, u.funding?.costPctEquity),
    },
    roll: {
      stepHysteresisBps: Number.isFinite(u.roll?.stepHysteresisBps)
        ? u.roll.stepHysteresisBps
        : d.roll.stepHysteresisBps,
      readyClearRatio: Number.isFinite(u.roll?.readyClearRatio) ? u.roll.readyClearRatio : d.roll.readyClearRatio,
    },
  };
}

/* ─────────────────────────── 数值小工具 ─────────────────────────── */

/** (value - base) / base，单位 bps，带符号 */
function relBps(baseWad, valueWad) {
  if (baseWad <= 0n) return 0;
  return Number(((valueWad - baseWad) * BPS) / baseWad);
}

/** aWad 与 bWad 的相对距离（比例，恒为正）。基准取 aWad。 */
function relDist(aWad, bWad) {
  if (aWad <= 0n) return null;
  const d = aWad > bWad ? aWad - bWad : bWad - aWad;
  return Number((d * 10000n) / aWad) / 10000;
}

/**
 * 价格朝**不利方向**越过某个位走了多少 bps（正数 = 已越过）。
 *
 * 一个公式覆盖「跌破止损」（多头）与「涨破止损」（空头）两种方向，
 * 避免在每处都写一遍方向判断 —— 方向写反是这类规则最隐蔽的 bug。
 */
function adverseBreak(refWad, markWad, isLong) {
  if (refWad <= 0n || markWad <= 0n) return null;
  return (isLong ? -1 : 1) * relBps(refWad, markWad);
}

function worstSev(...list) {
  let best = null;
  for (const s of list) {
    if (!s) continue;
    if (best === null || SEVERITY_RANK[s] > SEVERITY_RANK[best]) best = s;
  }
  return best;
}

/**
 * 带迟滞的严重度判定 —— 整个预警系统里最关键的一段。
 *
 * 语义：
 *   · 未激活：越过 warn / critical 线才激活；
 *   · 已激活：只要没退到 clear 线之外，就维持（sticky 规则维持原severity，其余退回 warn）。
 *
 * 返回 null 表示「不成立」。用 null 而不是 'ok' 是为了让调用方无法把「不成立」
 * 和「成立且严重度为 ok」混起来 —— 后者不存在。
 *
 * @param {object} o
 * @param {boolean} o.active 上一轮该 key 是否已激活（迟滞的判据）
 * @param {string}  [o.prevSev] 上一轮的严重度（sticky 时用来维持）
 * @param {number}  o.value 指标当前值。null/NaN 直接判不成立
 * @param {number}  [o.warn] 警告线
 * @param {number}  [o.critical] 严重线
 * @param {number}  [o.clear] 恢复线（必须比触发线宽松）
 * @param {boolean} o.worseIsHigher true = 值越大越糟；false = 值越小越糟
 * @param {boolean} [o.sticky] 已激活时维持原严重度，而不是降级成 warn
 */
export function sevWithHysteresis({ active, prevSev, value, warn = null, critical = null, clear = null, worseIsHigher, sticky = false }) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const hold = active ? (sticky && prevSev ? prevSev : 'warn') : null;
  if (worseIsHigher) {
    if (critical !== null && value >= critical) return 'critical';
    if (warn !== null && value >= warn) return 'warn';
    return active && clear !== null && value > clear ? hold : null;
  }
  if (critical !== null && value <= critical) return 'critical';
  if (warn !== null && value <= warn) return 'warn';
  return active && clear !== null && value < clear ? hold : null;
}

/* ─────────────────────────── 资金费基准 ─────────────────────────── */

/**
 * 把 fundingHistory 的原始行统计成基准。用于「异常」判定 ——
 * 没有基准就只能拍一个绝对阈值，而 BTC 的「正常」和某个小山寨币的「正常」
 * 差一个数量级，绝对阈值必然要么太松要么太紧。
 *
 * 取 |rate| 的中位数作为典型量级（不带方向），因为关心的是「成本规模」。
 *
 * @param {Array<{fundingRate:string|number}>} rows
 */
export function summarizeFundingHistory(rows) {
  const rs = [];
  for (const r of rows || []) {
    const v = Number(r?.fundingRate ?? r?.rate);
    if (Number.isFinite(v)) rs.push(Math.abs(v));
  }
  if (!rs.length) return null;
  rs.sort((a, b) => a - b);
  const at = (q) => rs[Math.min(rs.length - 1, Math.max(0, Math.floor(rs.length * q)))];
  const medianAbs = at(0.5);
  const p90Abs = at(0.9);
  return {
    samples: rs.length,
    medianAbs,
    p90Abs,
    /** 年化后的中位量级 —— 直接可与当前年化费率比倍数 */
    aprMedian: medianAbs * HOURS_PER_YEAR,
    aprP90: p90Abs * HOURS_PER_YEAR,
  };
}

/* ─────────────────────────── 引擎主体 ─────────────────────────── */

/** 从持仓/实时中间价取标记价（WAD）。中间价是接口透传十进制，快照 markPx 是 WAD，asWad 两者都吃。 */
function markOf(p, mids) {
  const m = mids?.[p.coin];
  if (m !== undefined && m !== null && m !== '') {
    const v = asWad(m);
    if (v > 0n) return v;
  }
  if (p.markPx !== null && p.markPx !== undefined) {
    const v = asWad(p.markPx);
    if (v > 0n) return v;
  }
  return null;
}

/** 快照 K 线固定 4H（server.js 的 CHART_BARS 口径） */
const SNAPSHOT_INTERVAL_MS = 4 * 3600 * 1000;

/**
 * 最后一根**已收盘** K 线的收盘价（WAD）。
 *
 * 为什么不用未收盘那根：盘中一根插针就能把「趋势结束」推出去，
 * 而策略的真实信号是「收盘跌破中轨」。代价是这条规则每 4 小时才更新一次 —— 这正是它该有的样子。
 */
function lastClosedClose(candles, now) {
  if (!Array.isArray(candles) || !candles.length) return null;
  const last = candles[candles.length - 1];
  if (!last || typeof last.t !== 'number') return null;
  const closed = now >= last.t + SNAPSHOT_INTERVAL_MS;
  const bar = closed ? last : candles[candles.length - 2];
  if (!bar) return null;
  const v = parseWad(bar.c);
  return v > 0n ? v : null;
}

/**
 * 评估一轮预警。
 *
 * @param {object} o
 * @param {object} o.snapshot  `/api/snapshot` 的返回（BigInt 已被序列化成字符串）
 * @param {object} [o.mids]    WebSocket allMids 的原始值（十进制串）。前端传它即可让预警跟实时价走
 * @param {object|null} [o.prev] 上一轮返回的 state。null = 首次运行
 * @param {number} [o.now]
 * @param {object} [o.config]  用户阈值覆盖
 * @returns {{ok:boolean, at:number, list:Array, active:object, events:Array, changes:object,
 *            summary:object, uncovered:Array, stale:boolean, state:object}}
 */
export function evaluateAlerts(o = {}) {
  const { snapshot, mids = {}, prev = null, now = Date.now(), config } = o;
  const cfg = resolveConfig(config);
  const S = (prev && typeof prev === 'object' && prev.active) || {};
  const primed = Boolean(prev);
  const was = (k) => Boolean(S[k]);

  const empty = {
    ok: true,
    at: now,
    list: [],
    active: {},
    events: [],
    changes: { fired: 0, escalated: 0, recovered: 0, reminder: 0 },
    summary: { total: 0, critical: 0, warn: 0, byFamily: { risk: 0, funding: 0, roll: 0 } },
    uncovered: [],
    stale: false,
    state: { v: 1, at: now, active: {} },
  };

  if (!cfg.enabled) return { ...empty, ok: false, disabled: true };

  // 数据不可用时**原样保留**上一次的活动集：不清空、不产生 recovered、不发任何事件。
  // 把 prev 原样当作新 state 返回，时间戳不动，这样限流/断网期间不会误报「已恢复」。
  if (!snapshot || snapshot.ok === false) {
    return { ...empty, stale: true, active: { ...S }, state: { v: 1, at: prev?.at ?? now, active: { ...S } } };
  }

  const active = {};
  const uncovered = [];

  const add = (key, family, rule, coin, severity, title, detail, metrics) => {
    const p = S[key];
    active[key] = {
      key,
      family,
      rule,
      coin,
      severity,
      title,
      detail,
      metrics: metrics || {},
      since: p?.since ?? now,
      lastNotifyAt: p?.lastNotifyAt ?? 0,
    };
  };

  const positions = Array.isArray(snapshot.positions) ? snapshot.positions : [];
  const equityWad = asWad(snapshot.account?.accountValue ?? 0);
  const equityNum = wadToNumber(equityWad);
  const levCap = Number(snapshot.config?.leverageCap) || 10;
  const baselineMap = snapshot.fundingBaseline || {};

  for (const p of positions) {
    const coin = p.coin;
    const isLong = Boolean(p.isLong);
    const mark = markOf(p, mids);
    const L = p.levels || null;

    /* ───────── 1. 距清算 ───────── */

    if (p.liquidationPx !== null && p.liquidationPx !== undefined && mark) {
      const liq = asWad(p.liquidationPx);
      if (liq > 0n) {
        // 越过清算价时该值为负 —— 仍然是一个合法取值（更糟），不需要特判
        const value = Number(((isLong ? mark - liq : liq - mark) * 10000n) / mark) / 10000;
        const k = `risk:${coin}:liq-approach`;
        const sev = sevWithHysteresis({
          active: was(k),
          prevSev: S[k]?.severity,
          value,
          ...cfg.risk.liq,
          worseIsHigher: false,
        });
        if (sev) {
          add(
            k,
            'risk',
            'liq-approach',
            coin,
            sev,
            `距清算 ${(value * 100).toFixed(2)}%`,
            `标记价 ${fmtPriceSafe(mark)} · 清算价 ${fmtPriceSafe(liq)} · 触发线 ${(cfg.risk.liq.warn * 100).toFixed(0)}%`,
            { value, warn: cfg.risk.liq.warn, critical: cfg.risk.liq.critical, unit: 'ratio' }
          );
        }
      }
    }

    /* ───────── 2. 止损：击穿 / 逼近 ─────────
     *
     * 两个判据**必须分开取**，这是本块的核心：
     *   · 击穿用 levels.stop.structural（结构位，不过滤「会不会立刻触发」）；
     *   · 逼近用 levels.stop.recommended（此刻还能设的前向止损）。
     * 旧代码两者都用 recommended —— 而 recommended 已被「不许立刻触发」过滤，
     * 拿它判击穿在数学上恒为 false。于是深亏时：结构位全被击穿 → recommended
     * 变 null → 整个分支走不进去 → 恢复逻辑把上一轮的「已击穿止损」判成
     * 「已恢复」推给你。危险还在，收到的却是好消息。 */

    // 结构位缺位时回落到 recommended —— 合成快照与旧数据没有 structural，
    // 此时行为退化为改动之前的样子，而不是整个分支静默失效。
    const structStop = L?.stop?.structural?.price ?? L?.stop?.recommended?.price;
    const recStop = L?.stop?.recommended?.price;
    const structWad = structStop !== null && structStop !== undefined ? asWad(structStop) : 0n;
    if (structWad > 0n && mark) {
      const stopWad = structWad;
      const broken = adverseBreak(stopWad, mark, isLong);
      const kBreach = `risk:${coin}:stop-breached`;
      const kApproach = `risk:${coin}:stop-approach`;

      // 击穿用 sticky —— 一旦跌破止损，收回一点点不应把「严重」降级成「警告」，
      // 必须真的退回安全侧 (clear) 才算解除。
      const breachSev = sevWithHysteresis({
        active: was(kBreach),
        prevSev: S[kBreach]?.severity,
        value: broken,
        warn: null,
        critical: 0,
        clear: -cfg.risk.stopBreached.clear * Number(BPS),
        worseIsHigher: true,
        sticky: true,
      });
      if (breachSev) {
        add(
          kBreach,
          'risk',
          'stop-breached',
          coin,
          breachSev,
          `已击穿止损 ${fmtPriceSafe(stopWad)}`,
          `标记价 ${fmtPriceSafe(mark)}，已越过止损 ${(broken ?? 0).toFixed(1)} bps。按规则应离场，不要向下挪止损`,
          { value: broken, clear: -cfg.risk.stopBreached.clear * Number(BPS), unit: 'bps' }
        );
      } else {
        // 逼近：距离止损还有多远。已在击穿状态时不重复报「逼近」。
        const fwdStop =
          recStop !== null && recStop !== undefined && asWad(recStop) > 0n ? asWad(recStop) : stopWad;
        const dist = relDist(mark, fwdStop);
        const approachSev = sevWithHysteresis({
          active: was(kApproach),
          prevSev: S[kApproach]?.severity,
          value: dist,
          ...cfg.risk.stopApproach,
          worseIsHigher: false,
        });
        if (approachSev) {
          add(
            kApproach,
            'risk',
            'stop-approach',
            coin,
            approachSev,
            `逼近止损，仅剩 ${(dist * 100).toFixed(2)}%`,
            `标记价 ${fmtPriceSafe(mark)} → 止损 ${fmtPriceSafe(fwdStop)} · 触发线 ${(cfg.risk.stopApproach.warn * 100).toFixed(1)}%`,
            { value: dist, warn: cfg.risk.stopApproach.warn, critical: cfg.risk.stopApproach.critical, unit: 'ratio' }
          );
        }
      }
    }

    /* ───────── 3. 趋势破坏（4H 收盘口径） ───────── */

    const mid = L?.bands?.mid;
    if (mid !== null && mid !== undefined) {
      const midWad = asWad(mid);
      const close = lastClosedClose(snapshot.candles?.[coin], now);
      const broken = close && midWad > 0n ? adverseBreak(midWad, close, isLong) : null;
      const k = `risk:${coin}:trend-exit`;
      const sev = sevWithHysteresis({
        active: was(k),
        prevSev: S[k]?.severity,
        value: broken,
        warn: null,
        critical: 0,
        clear: -cfg.risk.trendExit.clear * Number(BPS),
        worseIsHigher: true,
        sticky: true,
      });
      if (sev) {
        add(
          k,
          'risk',
          'trend-exit',
          coin,
          sev,
          isLong ? '4H 收盘跌破中轨，趋势破坏' : '4H 收盘升破中轨，趋势破坏',
          `已收盘价 ${fmtPriceSafe(close)}，中轨 ${fmtPriceSafe(midWad)}（越过 ${(broken ?? 0).toFixed(1)} bps）。` +
            `比特皇的离场信号是「收盘跌破中轨」—— 这是趋势结束，不是回调`,
          { value: broken, mid: midWad, close, unit: 'bps' }
        );
      }
    }

    /* ───────── 4. 风险预算 / 杠杆 ───────── */

    const riskAtStopPct = L?.risk?.riskAtStopPct;
    if (Number.isFinite(riskAtStopPct)) {
      const k = `risk:${coin}:over-budget`;
      const sev = sevWithHysteresis({
        active: was(k),
        prevSev: S[k]?.severity,
        value: riskAtStopPct,
        ...cfg.risk.overBudget,
        worseIsHigher: true,
      });
      if (sev) {
        add(
          k,
          'risk',
          'over-budget',
          coin,
          sev,
          `止损触发亏损占权益 ${(riskAtStopPct * 100).toFixed(2)}%`,
          `预算 ${((cfg.risk.overBudget.warn || 0) * 100).toFixed(1)}%。仓位过大时应对应减仓，而不是把止损收得更紧`,
          { value: riskAtStopPct, warn: cfg.risk.overBudget.warn, critical: cfg.risk.overBudget.critical, unit: 'ratio' }
        );
      }
    }

    const effLev = L?.risk?.effectiveLeverage;
    if (Number.isFinite(effLev) && levCap > 0) {
      const k = `risk:${coin}:leverage-cap`;
      const ratio = effLev / levCap;
      const sev = sevWithHysteresis({
        active: was(k),
        prevSev: S[k]?.severity,
        value: ratio,
        ...cfg.risk.leverageCap,
        worseIsHigher: true,
      });
      if (sev) {
        add(
          k,
          'risk',
          'leverage-cap',
          coin,
          sev,
          `实际杠杆 ${effLev.toFixed(2)}x 超配置上限 ${levCap}x`,
          `名义敞口 ${fmtUsdSafe(L?.risk?.exposure)} · 倍数 ${ratio.toFixed(2)}×上限`,
          { value: ratio, warn: cfg.risk.leverageCap.warn, critical: cfg.risk.leverageCap.critical, unit: 'multiple' }
        );
      }
    }

    /* ───────── 5. 资金费异常 ───────── */

    const rawRate = snapshot.markets?.[coin]?.funding;
    const r = Number(rawRate);
    if (Number.isFinite(r) && r !== 0) {
      const adverseRate = isLong ? r : -r; // 正数 = 我在付钱
      const adverseApr = adverseRate * HOURS_PER_YEAR;
      const base = baselineMap[coin]?.aprMedian ?? null;
      const notional = wadToNumber(asWad(p.positionValue ?? 0));
      const costPctEquity = equityNum > 0 ? (adverseApr * notional) / equityNum : 0;
      const k = `funding:${coin}:funding-cost`;

      const aprSev = sevWithHysteresis({
        active: was(k),
        prevSev: S[k]?.severity,
        value: adverseApr,
        ...cfg.funding.adverseApr,
        worseIsHigher: true,
      });
      let mult = null;
      let multSev = null;
      if (base !== null && base > 1e-6) {
        mult = adverseApr / base;
        multSev = sevWithHysteresis({
          active: was(k),
          prevSev: S[k]?.severity,
          value: mult,
          ...cfg.funding.vsBaseline,
          worseIsHigher: true,
        });
      }
      const costSev = sevWithHysteresis({
        active: was(k),
        prevSev: S[k]?.severity,
        value: costPctEquity,
        ...cfg.funding.costPctEquity,
        worseIsHigher: true,
      });
      const sev = worstSev(aprSev, multSev, costSev);
      if (sev && adverseRate > 0) {
        const parts = [`当前年化 ${(adverseApr * 100).toFixed(1)}%`];
        if (mult !== null) parts.push(`该标的基准 ${(base * 100).toFixed(1)}%（${mult.toFixed(2)}×）`);
        parts.push(`折合权益 ${(costPctEquity * 100).toFixed(2)}%/年`);
        add(
          k,
          'funding',
          'funding-cost',
          coin,
          sev,
          `资金费不利：年化 ${(adverseApr * 100).toFixed(1)}%`,
          `${parts.join(' · ')}。持仓方向在持续付费，费率级不降的话值得考虑减仓或换月`,
          {
            apr: adverseApr,
            aprMedian: base,
            mult,
            costPctEquity,
            warnApr: cfg.funding.adverseApr.warn,
            unit: 'ratio',
          }
        );
      }
    }

    /* ───────── 6. 滚仓条件 ───────── */

    const roll = L?.roll;
    if (roll && Number.isFinite(roll.profitPct) && roll.triggerBps > 0) {
      const trig = roll.triggerBps / 10000;
      const k = `roll:${coin}:roll-ready`;
      const readySev = sevWithHysteresis({
        active: was(k),
        prevSev: S[k]?.severity,
        value: roll.profitPct,
        warn: trig,
        critical: null,
        clear: trig * cfg.roll.readyClearRatio,
        worseIsHigher: true,
      });
      // 顺势校验必须来自方向层（与 levels.js 的 rollAllowed 同源）。
      // L.trend.direction 是已降级的旧口径（三次突破=方向），不得再用于方向判断；
      // 仅在 regime 缺席的老调用路径下回落到它，保证向后兼容。
      const reg = L?.regime || snapshot.regime || null;
      const trendOk = reg
        ? isLong
          ? !!reg.allowLong
          : !!reg.allowShort
        : isLong
          ? L.trend?.direction === 1
          : L.trend?.direction === -1;

      // 趋势不支撑时，加仓是被规则明确否决的 —— 这时「可加仓」的提示必须变成严重告警。
      if (readySev) {
        const kBlocked = `roll:${coin}:roll-blocked`;
        if (!trendOk) {
          add(
            kBlocked,
            'roll',
            'roll-blocked',
            coin,
            'critical',
            '浮盈已够，但趋势不支撑 —— 禁止加仓',
            `浮盈 ${(roll.profitPct * 100).toFixed(2)}% 已达阈值 +${(trig * 100).toFixed(2)}%，` +
              `但趋势读数显示方向已不成立。比特皇只做顺势加仓，此时加仓等于逆势摊平`,
            { profitPct: roll.profitPct, triggerBps: roll.triggerBps, unit: 'ratio' }
          );
        } else {
          add(
            k,
            'roll',
            'roll-ready',
            coin,
            readySev,
            `滚仓条件达成：浮盈 ${(roll.profitPct * 100).toFixed(2)}%`,
            `已超过加仓阈值 +${(trig * 100).toFixed(2)}%，趋势仍支撑。下一档触发价 ` +
              `${fmtPriceSafe(nextStepPrice(roll, true))}，加仓后止损上移至 ${fmtPriceSafe(nextStepStop(roll, true))}`,
            { profitPct: roll.profitPct, triggerBps: roll.triggerBps, unit: 'ratio' }
          );
        }
      }
      if (trendOk && was(`roll:${coin}:roll-blocked`)) {
        // 趋势恢复 → 上面不会 add，这个 key 自然从活动集消失，产生「已恢复」事件
      }
    }

    // 滚仓阶梯：每一档独立一个 key，触发了就进入活动集；回落到迟滞线以下才解除
    if (roll && Array.isArray(roll.ladder) && mark) {
      for (const step of roll.ladder) {
        const tp = asWad(step.triggerPrice);
        if (tp <= 0n) continue;
        const over = adverseBreak(tp, mark, isLong) * -1; // 越过触发价 = 有利方向
        const k = `roll:${coin}:step${step.index}`;
        const sev = sevWithHysteresis({
          active: was(k),
          prevSev: S[k]?.severity,
          value: over,
          warn: 0,
          critical: null,
          clear: -cfg.roll.stepHysteresisBps,
          worseIsHigher: true,
          sticky: true,
        });
        if (sev) {
          add(
            k,
            'roll',
            'roll-step',
            coin,
            sev,
            `滚仓第 ${step.index} 档触发价已到 ${fmtPriceSafe(tp)}`,
            `标记价 ${fmtPriceSafe(mark)}（越过 ${over.toFixed(1)} bps）。` +
              `该档加仓量 ${fmtQtySafe(step.addQty)}，加仓后均价 ${fmtPriceSafe(step.newAvg)}、` +
              `止损移至 ${fmtPriceSafe(step.newStop)}，最坏亏损 ${fmtUsdSafe(step.worstCaseLoss)}` +
              `${step.passesBudget === false ? ' —— 已超加仓风险预算，不建议执行' : ''}`,
            { trigger: tp, over, addQty: step.addQty, passesBudget: step.passesBudget, unit: 'bps' }
          );
        }
      }
    }

    if (!L) {
      uncovered.push({
        coin,
        reason: '该标的未计算策略读数（超出服务端算力上限或 K 线不足），本次只做清算距离检查',
      });
    }
  }

  /* ─────────── 与上一轮对比，产出事件 ─────────── */

  const events = [];
  const mkEvent = (kind, a) => ({ kind, at: now, ...a });

  for (const [k, a] of Object.entries(active)) {
    const p = S[k];
    if (!p) {
      // 首次运行（无 prev）时按 priming 策略决定是否推送
      const allow = primed || cfg.priming === 'all' || (cfg.priming === 'critical' && a.severity === 'critical');
      if (allow) events.push(mkEvent('fired', a));
    } else if (SEVERITY_RANK[a.severity] > SEVERITY_RANK[p.severity]) {
      events.push(mkEvent('escalated', a));
    } else if (now - (p.lastNotifyAt || 0) >= cfg.cooldownMs) {
      events.push(mkEvent('reminder', a));
    }
  }

  if (cfg.notifyRecovery) {
    for (const [k, p] of Object.entries(S)) {
      if (active[k]) continue;
      events.push(
        mkEvent('recovered', {
          ...p,
          severity: 'info',
          title: `已恢复：${p.title}`,
          detail: `条件已解除（持续 ${fmtDuration(now - (p.since || now))}）`,
        })
      );
    }
  }

  // 只有真的产生推送的那些 key 才刷新 lastNotifyAt，否则「冷却」会被静默重置
  for (const e of events) {
    if (active[e.key] && (e.kind === 'fired' || e.kind === 'escalated' || e.kind === 'reminder')) {
      active[e.key].lastNotifyAt = now;
    }
  }

  const list = Object.values(active).sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      (a.family === b.family ? 0 : a.family < b.family ? -1 : 1) ||
      String(a.coin).localeCompare(String(b.coin)) ||
      String(a.rule).localeCompare(String(b.rule))
  );

  const summary = {
    total: list.length,
    critical: list.filter((a) => a.severity === 'critical').length,
    warn: list.filter((a) => a.severity === 'warn').length,
    byFamily: {
      risk: list.filter((a) => a.family === 'risk').length,
      funding: list.filter((a) => a.family === 'funding').length,
      roll: list.filter((a) => a.family === 'roll').length,
    },
  };

  return {
    ok: true,
    at: now,
    list,
    active,
    events,
    changes: {
      fired: events.filter((e) => e.kind === 'fired').length,
      escalated: events.filter((e) => e.kind === 'escalated').length,
      recovered: events.filter((e) => e.kind === 'recovered').length,
      reminder: events.filter((e) => e.kind === 'reminder').length,
    },
    summary,
    uncovered,
    stale: false,
    state: { v: 1, at: now, active },
  };
}

/* ─────────────────────────── 展示辅助（前后端共用，保证文案一致） ─────────────────────────── */

function nextStepPrice(roll) {
  const s = (roll.ladder || []).find((x) => !x.reached);
  return s ? s.triggerPrice : null;
}
function nextStepStop(roll) {
  const s = (roll.ladder || []).find((x) => !x.reached);
  return s ? s.newStop : null;
}

function fmtPriceSafe(v) {
  if (v === null || v === undefined) return '—';
  const n = wadToNumber(v);
  if (!Number.isFinite(n) || n === 0) return '—';
  const a = Math.abs(n);
  const d = a >= 10000 ? 1 : a >= 100 ? 2 : a >= 1 ? 4 : 6;
  return n.toFixed(d);
}
function fmtUsdSafe(v) {
  if (v === null || v === undefined) return '—';
  const n = wadToNumber(v);
  if (!Number.isFinite(n)) return '—';
  const s = n < 0 ? '-' : '';
  const a = Math.abs(n);
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${s}$${(a / 1e3).toFixed(2)}K`;
  return `${s}$${a.toFixed(2)}`;
}
function fmtQtySafe(v) {
  if (v === null || v === undefined) return '—';
  const n = wadToNumber(v);
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(Math.abs(n) >= 1 ? 4 : 6);
}

export function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时 ${m % 60} 分`;
  return `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
}

/** 一条告警的单行文本（推送与 UI 共用） */
export function alertLine(a) {
  const tag = SEVERITY_LABELS[a.severity] || a.severity;
  const fam = FAMILY_LABELS[a.family] || a.family;
  return `[${tag}] ${fam} · ${a.coin} —— ${a.title}`;
}

/**
 * 生成推送正文。
 *
 * 为什么要「新事件」与「当前活动集」分开：
 * 推送要的是**变化**（否则每次都是同一份清单，等于没有信息），
 * 但人在手机上看一条消息时又需要知道「现在总共几条」。所以正文 = 变化 + 汇总一行。
 */
export function formatPush(events, result, meta = {}) {
  const sevIcon = { critical: '🔴', warn: '🟠', info: '🟢' };
  const kindLabel = { fired: '新增', escalated: '升级', recovered: '恢复', reminder: '持续' };
  const head = events.filter((e) => e.kind !== 'recovered');
  const rec = events.filter((e) => e.kind === 'recovered');
  const lines = [];
  lines.push(`## ${events.some((e) => e.severity === 'critical') ? '🔴' : '🟠'} 比特皇看板 · ${events.length} 条预警变化`);
  const ctx = [meta.networkLabel, meta.userShort, new Date(result.at).toLocaleString('zh-CN', { hour12: false })]
    .filter(Boolean)
    .join(' · ');
  if (ctx) lines.push(`> ${ctx}`);
  for (const e of [...head, ...rec]) {
    lines.push('');
    lines.push(
      `**${kindLabel[e.kind] || e.kind} · ${sevIcon[e.severity] || ''} ${FAMILY_LABELS[e.family] || e.family} · ${e.coin}**`
    );
    lines.push(`${e.title}`);
    if (e.detail) lines.push(`<font color="comment">${e.detail}</font>`);
  }
  const s = result.summary || {};
  lines.push('');
  lines.push(
    `当前活动预警 ${s.total} 条（严重 ${s.critical} / 警告 ${s.warn}）· 仓位风险 ${s.byFamily?.risk ?? 0} · 资金费 ${
      s.byFamily?.funding ?? 0
    } · 滚仓 ${s.byFamily?.roll ?? 0}`
  );
  return lines.join('\n');
}

/** 纯文本版（给不支持 markdown 的通道） */
export function formatPushText(events, result, meta = {}) {
  const body = formatPush(events, result, meta)
    .replace(/^##+\s*/gm, '')
    .replace(/\*\*/g, '')
    .replace(/<font[^>]*>|<\/font>/g, '')
    .replace(/^>\s*/gm, '');
  return body;
}
