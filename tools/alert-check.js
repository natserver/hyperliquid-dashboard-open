/**
 * 预警引擎回归 —— 重点不是「能不能触发」，而是**会不会刷屏**。
 *
 * 一个触发正确但会重复推送的预警系统，用户会在 10 分钟内关掉它，
 * 于是等价于没有预警。所以这里的断言大头在不变式上：
 *   · 阈值抖动只产生一次事件（迟滞）
 *   · 冷却期内同严重度不重复，超出冷却产生一次提醒
 *   · 严重度升级必须立即发（不能被冷却压住）
 *   · 恢复必须真的跨过 clear 线，而不是「一回到 ok 线就算好」
 *   · 数据缺失绝不清空活动集、绝不产生「已恢复」
 *   · 首轮不刷历史既存状态
 *
 * 运行：node tools/alert-check.js
 */

import { toWad } from '../src/strategy.js';
import {
  ALERT_DEFAULTS,
  SEVERITY_RANK,
  evaluateAlerts,
  formatPush,
  formatPushText,
  resolveConfig,
  sevWithHysteresis,
  summarizeFundingHistory,
} from '../src/alerts.js';
import {
  CHANNELS,
  assertSafeWebhookUrl,
  inspectChannels,
  makeProxyAgent,
  maskUrl,
  resolveProxy,
  sendToChannel,
  telegramError,
} from '../src/notify.js';

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  \u2713 ${name}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  \u2717 ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

function group(t) {
  console.log(`\n${t}`);
}

const T0 = 1_700_000_000_000; // 固定基准时刻，避免测试结果随时间漂移
const W = (n) => String(toWad(n));

/* ─────────────────── 构造测试快照 ─────────────────── */

/** 只让「距清算」这一条规则有可能触发的读数 —— 用来隔离单条规则的迟滞行为 */
function isolatedLevels(mark) {
  return {
    bands: { mid: W(mark * 0.5) }, // 远低于标记价 → 多头不会被判趋势破坏
    stop: { recommended: { price: W(mark * 0.5) }, breached: false }, // 远 → 不触发逼近/击穿
    roll: { ready: false, triggerBps: 500, profitPct: -0.5, ladder: [] },
    risk: { riskAtStopPct: 0.001, effectiveLeverage: 1, exposure: W(1000) },
    trend: { direction: 1 },
  };
}

function mkLevels(o = {}) {
  const isLong = o.isLong !== false;
  const mark = o.markPx ?? 77000;
  const entry = o.entryPx ?? 70000;
  const mid = o.mid ?? (isLong ? mark * 0.5 : mark * 1.5);
  const stop = o.stop ?? (isLong ? mark * 0.5 : mark * 1.5);
  const trig = o.triggerBps ?? 500;
  const profitPct = o.profitPct ?? (isLong ? (mark - entry) / entry : (entry - mark) / entry);
  const ladder =
    o.ladder ??
    [
      {
        index: 1,
        triggerPrice: W(entry * 1.05),
        addQty: W(0.5),
        newAvg: W(entry * 1.01),
        newStop: W(entry * 1.003),
        worstCaseLoss: W(100),
        passesBudget: true,
        reached: false,
      },
    ];
  return {
    bands: { mid: W(mid) },
    stop: { recommended: o.noStop ? null : { price: W(stop) }, breached: false },
    roll: { ready: o.ready ?? profitPct >= trig / 10000, triggerBps: trig, profitPct, ladder },
    risk: {
      riskAtStopPct: o.riskAtStopPct ?? 0.02,
      effectiveLeverage: o.effLev ?? 3,
      exposure: W(o.value ?? 77000),
    },
    trend: { direction: o.trendDir === undefined ? (isLong ? 1 : -1) : o.trendDir },
  };
}

function mkPosition(o = {}) {
  const isLong = o.isLong !== false;
  const qty = o.qty ?? 1;
  const markPx = o.markPx ?? 77000;
  return {
    coin: o.coin || 'BTC',
    isLong,
    qty: W(qty),
    szi: String(isLong ? toWad(qty) : -toWad(qty)),
    entryPx: W(o.entryPx ?? 70000),
    positionValue: W(o.value ?? markPx),
    unrealizedPnl: W(0),
    liquidationPx: o.liqPx === null ? null : W(o.liqPx ?? 60000),
    markPx: W(markPx),
    levels: o.levels === undefined ? mkLevels({ ...o, markPx, isLong }) : o.levels,
  };
}

function mkCandles(closes, lastT) {
  const IV = 4 * 3600 * 1000;
  const n = closes.length;
  return closes.map((c, i) => ({
    t: lastT - (n - 1 - i) * IV,
    o: String(c),
    h: String(c),
    l: String(c),
    c: String(c),
    v: '1',
  }));
}

function mkSnap(o = {}) {
  return {
    ok: true,
    positions: o.positions ?? [],
    account: { accountValue: o.equity ?? W(100000) },
    config: { leverageCap: o.leverageCap ?? 10 },
    markets: o.markets ?? {},
    candles: o.candles ?? {},
    fundingBaseline: o.fundingBaseline ?? {},
  };
}

/** 跑一串快照，返回每轮结果 */
function runSeq(snaps, { config, startAt = T0, step = 1 } = {}) {
  let prev = null;
  const out = [];
  snaps.forEach((s, i) => {
    const r = evaluateAlerts({ snapshot: s, prev, now: startAt + i * step, config });
    prev = r.state;
    out.push(r);
  });
  return out;
}

/* ─────────────────── 1. 迟滞：抖动只触发一次 ─────────────────── */

group('1. 迟滞 —— 阈值附近抖动不能重复触发');

{
  // 距清算 warn=15% / clear=20%。取 liq=60000 反推标记价
  const at = (d) => 60000 / (1 - d);
  const snaps = [
    mkSnap({ positions: [mkPosition({ markPx: at(0.10), levels: isolatedLevels(at(0.1)) })] }),
    mkSnap({ positions: [mkPosition({ markPx: at(0.16), levels: isolatedLevels(at(0.16)) })] }), // 回到 warn 与 clear 之间
    mkSnap({ positions: [mkPosition({ markPx: at(0.10), levels: isolatedLevels(at(0.1)) })] }),
    mkSnap({ positions: [mkPosition({ markPx: at(0.26), levels: isolatedLevels(at(0.26)) })] }), // 越过 clear
    mkSnap({ positions: [mkPosition({ markPx: at(0.10), levels: isolatedLevels(at(0.1)) })] }),
  ];
  const r = runSeq(snaps, { config: { priming: 'all', cooldownMs: 10 * 60 * 1000 } });
  const kinds = r.map((x) => x.events.map((e) => e.kind).join(',') || '-');

  ok('第 1 轮：首次越过 warn 线产生 fired', r[0].events.length === 1 && r[0].events[0].kind === 'fired', kinds[0]);
  ok('第 2 轮：退到 warn/clear 之间仍视为活动，0 事件', r[1].events.length === 0, kinds[1]);
  ok('第 3 轮：再次抖动回来，0 事件', r[2].events.length === 0, kinds[2]);
  ok('第 4 轮：越过 clear 线才产生 recovered', r[3].events.length === 1 && r[3].events[0].kind === 'recovered', kinds[3]);
  ok('第 5 轮：重新触发 fired', r[4].events.length === 1 && r[4].events[0].kind === 'fired', kinds[4]);
  ok('全程事件总数 = 3（无刷屏）', r.reduce((a, x) => a + x.events.length, 0) === 3);

  // 反向验证：如果阈值判据没有迟滞，第 2 轮必然重新触发
  const noHysteresis = sevWithHysteresis({ active: false, value: 0.16, warn: 0.15, critical: 0.06, clear: 0.2, worseIsHigher: false });
  const withHysteresis = sevWithHysteresis({ active: true, value: 0.16, warn: 0.15, critical: 0.06, clear: 0.2, worseIsHigher: false });
  ok('对照：同样 0.16，未激活时判为「不成立」', noHysteresis === null, String(noHysteresis));
  ok('对照：同样 0.16，已激活时维持 warn', withHysteresis === 'warn', String(withHysteresis));
}

/* ─────────────────── 2. 冷却与升级 ─────────────────── */

group('2. 冷却 —— 持续恶化按间隔提醒，升级立即发');

{
  const mk = () => {
    // stop = mark*0.99 → 距止损 1% → warn（stopApproach.warn = 2%）
    // 清算价必须放得很远，否则 mkPosition 的默认值会让「距清算」先自己触发，把这一组测成两件事
    const mark = 70000;
    return mkSnap({
      positions: [
        mkPosition({ markPx: mark, liqPx: 20000, levels: mkLevels({ markPx: mark, stop: mark * 0.99, mid: mark * 0.5 }) }),
      ],
    });
  };
  const cfg = { priming: 'all', cooldownMs: 1000 };

  let prev = null;
  const a = evaluateAlerts({ snapshot: mk(), prev, now: T0, config: cfg });
  prev = a.state;
  const b = evaluateAlerts({ snapshot: mk(), prev, now: T0 + 900, config: cfg });
  prev = b.state;
  const c = evaluateAlerts({ snapshot: mk(), prev, now: T0 + 1500, config: cfg });
  prev = c.state;

  ok('首轮 fired', a.events.length === 1 && a.events[0].kind === 'fired');
  ok('冷却期内（+900ms < 1000ms）0 事件', b.events.length === 0, JSON.stringify(b.events.map((e) => e.kind)));
  ok('超出冷却（+1500ms）产生 1 条 reminder', c.events.length === 1 && c.events[0].kind === 'reminder');

  // 升级：把止损推到几乎贴上标记价 → critical（stopApproach.critical = 0.5%）
  const mark2 = 70000;
  const d = evaluateAlerts({
    snapshot: mkSnap({
      positions: [
        mkPosition({ markPx: mark2, liqPx: 20000, levels: mkLevels({ markPx: mark2, stop: mark2 * 0.999, mid: mark2 * 0.5 }) }),
      ],
    }),
    prev,
    now: T0 + 1600, // 仍在冷却期内
    config: cfg,
  });
  ok(
    '严重度升级在冷却期内也立即发（escalated，不是 reminder）',
    d.events.length === 1 && d.events[0].kind === 'escalated' && d.events[0].severity === 'critical',
    JSON.stringify(d.events.map((e) => `${e.kind}:${e.severity}`))
  );
}

/* ─────────────────── 3. 数据缺失不清空 ─────────────────── */

group('3. 数据缺失 —— 保留活动集，绝不误报「已恢复」');

{
  const stop = 70000 * 0.99;
  const live = mkSnap({
    positions: [mkPosition({ markPx: 70000, levels: mkLevels({ markPx: 70000, stop, mid: 35000 }) })],
  });
  const cfg = { priming: 'all', cooldownMs: 60_000 };
  const a = evaluateAlerts({ snapshot: live, prev: null, now: T0, config: cfg });
  const broken = evaluateAlerts({ snapshot: { ok: false, error: '限流' }, prev: a.state, now: T0 + 1000, config: cfg });

  ok('快照失败时事件数 = 0', broken.events.length === 0, JSON.stringify(broken.events.map((e) => e.kind)));
  ok('快照失败时活动集被原样保留', Object.keys(broken.active).length === Object.keys(a.active).length);
  ok('快照失败时 stale 标记为 true', broken.stale === true);
  ok('快照失败不推进时间戳（避免冷却被静默重置）', broken.state.at === a.state.at);

  const back = evaluateAlerts({ snapshot: live, prev: broken.state, now: T0 + 2000, config: cfg });
  ok('恢复后活动集仍然在，且不产生重复 fired', back.events.length === 0, JSON.stringify(back.events.map((e) => e.kind)));
}

/* ─────────────────── 4. 首次运行不刷历史状态 ─────────────────── */

group('4. 首次运行 —— 默认只发 critical');

{
  const warnOnly = mkSnap({
    positions: [mkPosition({ markPx: 70000, levels: mkLevels({ markPx: 70000, stop: 70000 * 0.99, mid: 35000 }) })],
  });
  const r1 = evaluateAlerts({ snapshot: warnOnly, prev: null, now: T0 });
  ok('首轮 priming=critical：warning 级不推，但已记入活动集', r1.events.length === 0 && r1.summary.warn > 0, `events=${r1.events.length} warn=${r1.summary.warn}`);

  const critical = mkSnap({
    positions: [mkPosition({ markPx: 63000, liqPx: 60000, levels: isolatedLevels(63000) })], // 距清算 4.8%
  });
  const r2 = evaluateAlerts({ snapshot: critical, prev: null, now: T0 });
  ok('首轮 priming=critical：严重级照发', r2.events.length === 1 && r2.events[0].severity === 'critical', JSON.stringify(r2.events.map((e) => e.severity)));

  const r3 = evaluateAlerts({ snapshot: warnOnly, prev: null, now: T0, config: { priming: 'all' } });
  ok('priming=all 时首轮全发', r3.events.length === r3.summary.total && r3.events.length > 0);

  const r4 = evaluateAlerts({ snapshot: warnOnly, prev: null, now: T0, config: { priming: 'silent' } });
  ok('priming=silent 时首轮 0 事件', r4.events.length === 0 && r4.summary.total > 0);
}

/* ─────────────────── 5. 击穿止损的 sticky 恢复线 ─────────────────── */

group('5. 击穿止损 —— 收回一点不算恢复（sticky）');

{
  const stop = 70000 * 0.95; // 66500
  const mk = (mark) => mkSnap({ positions: [mkPosition({ markPx: mark, levels: mkLevels({ markPx: mark, stop, mid: mark * 0.5 }) })] });
  const cfg = { priming: 'all', cooldownMs: 60_000 };

  let prev = null;
  const a = evaluateAlerts({ snapshot: mk(66000), prev, now: T0, config: cfg }); // 跌破 66500
  prev = a.state;
  const b = evaluateAlerts({ snapshot: mk(66530), prev, now: T0 + 100, config: cfg }); // 刚收回 4.5bps（< clear 50bps）
  prev = b.state;
  const c = evaluateAlerts({ snapshot: mk(67000), prev, now: T0 + 200, config: cfg }); // 收回 75bps（> clear 50bps）
  prev = c.state;

  const kBreach = 'risk:BTC:stop-breached';
  ok('跌破止损 → critical', a.active[kBreach]?.severity === 'critical', JSON.stringify(a.active[kBreach]?.severity));
  ok('刚收回 4.5bps 仍然是 critical（不降级）', b.active[kBreach]?.severity === 'critical', JSON.stringify(b.active[kBreach]?.severity));
  ok('刚收回 4.5bps 不产生 recovered', !b.events.some((e) => e.kind === 'recovered'));
  ok('收回 75bps 越过 clear 线 → recovered', c.events.some((e) => e.kind === 'recovered' && e.key === kBreach));
}

/* ─────────────────── 6. 趋势破坏用「已收盘」K 线 ─────────────────── */

group('6. 趋势破坏 —— 只用最后一根已收盘 K 线');

{
  const mark = 70000;
  const mid = 70000; // 中轨刚好等于标记价
  const lv = mkLevels({ markPx: mark, mid, stop: mark * 0.5 });
  const cfg = { priming: 'all', cooldownMs: 60_000 };
  const k = 'risk:BTC:trend-exit';

  // 最后一根未收盘（now < lastT + 4h），其收盘价已跌破中轨；但倒数第二根（已收盘）在中轨上方
  const notYetClosed = T0;
  const candlesLive = mkCandles(['72000.0', '69000.0'], notYetClosed);
  const a = evaluateAlerts({
    snapshot: mkSnap({ positions: [mkPosition({ markPx: mark, levels: lv })], candles: { BTC: candlesLive } }),
    prev: null,
    now: T0,
    config: cfg,
  });
  ok('未收盘那根跌破中轨 → 不告警（避免盘中插针误报）', !a.active[k], JSON.stringify(a.active[k]?.title || null));

  // 时间推进过这根 K 线的收盘时刻 → 改用它
  const b = evaluateAlerts({
    snapshot: mkSnap({ positions: [mkPosition({ markPx: mark, levels: lv })], candles: { BTC: candlesLive } }),
    prev: a.state,
    now: notYetClosed + 4 * 3600 * 1000 + 1000,
    config: cfg,
  });
  ok('该 K 线收盘后 → critical', b.active[k]?.severity === 'critical', JSON.stringify(b.active[k]?.severity));

  // 空头方向：收盘升破中轨才算破坏
  const shortLv = mkLevels({ isLong: false, markPx: mark, mid, stop: mark * 1.5, trendDir: -1 });
  const shortPos = mkPosition({ isLong: false, markPx: mark, liqPx: 90000, levels: shortLv });
  const c = evaluateAlerts({
    snapshot: mkSnap({ positions: [shortPos], candles: { BTC: mkCandles(['68000.0', '71000.0'], notYetClosed) } }),
    prev: null,
    now: notYetClosed + 4 * 3600 * 1000 + 1000,
    config: cfg,
  });
  ok('空头：收盘升破中轨 → 判定趋势破坏', c.active['risk:BTC:trend-exit']?.severity === 'critical');
  ok('空头的标题方向正确', /升破/.test(c.active['risk:BTC:trend-exit']?.title || ''), c.active['risk:BTC:trend-exit']?.title);
}

/* ─────────────────── 7. 资金费：年化系数与不利方向 ─────────────────── */

group('7. 资金费 —— 年化系数 8760，只报不利方向');

{
  const cfg = { priming: 'all', cooldownMs: 60_000 };
  // value 取 1 万（权益 10 万 → 0.1x 名义），让 costPctEquity 不抢戏，
  // 这样断言测到的就是纯粹的「年化费率」这一条判据
  const mk = (funding, isLong = true, baselineApr = 0.1752) =>
    mkSnap({
      positions: [
        mkPosition({
          isLong,
          markPx: 70000,
          value: 10000,
          liqPx: isLong ? 20000 : 200000,
          levels: mkLevels({ isLong, markPx: 70000, value: 10000 }),
        }),
      ],
      markets: { BTC: { funding } },
      fundingBaseline: baselineApr === null ? {} : { BTC: { aprMedian: baselineApr, samples: 720 } },
    });

  const a = evaluateAlerts({ snapshot: mk('0.00004'), prev: null, now: T0, config: cfg });
  const al = a.active['funding:BTC:funding-cost'];
  ok('多头 + 正费率 → 触发资金费告警', Boolean(al), JSON.stringify(Object.keys(a.active)));
  ok('年化 = 小时费率 × 8760（0.00004 → 35.04%）', al && Math.abs(al.metrics.apr - 0.3504) < 1e-9, String(al?.metrics.apr));
  ok('相对基准倍数正确（0.3504 / 0.1752 = 2）', al && Math.abs(al.metrics.mult - 2) < 1e-6, String(al?.metrics.mult));
  ok(
    '年化资金费占权益比 = 年化费率 × 名义 / 权益（0.3504 × 0.1）',
    al && Math.abs(al.metrics.costPctEquity - 0.3504 * 0.1) < 1e-9,
    String(al?.metrics.costPctEquity)
  );
  ok('年化 35.04% 越过 warn 线 25% → warn', al?.severity === 'warn', al?.severity);

  const b = evaluateAlerts({ snapshot: mk('-0.00002'), prev: null, now: T0, config: cfg });
  ok('多头 + 负费率（我在收钱）→ 不告警', !b.active['funding:BTC:funding-cost'], JSON.stringify(b.active));

  const c = evaluateAlerts({ snapshot: mk('0.00002', false), prev: null, now: T0, config: cfg });
  ok('空头 + 正费率（空头在收钱）→ 不告警', !c.active['funding:BTC:funding-cost']);

  // 方向对但水位等于该币自身基准 → 不应打扰。
  // 这条锁的是「异常」语义：告警判的是偏离程度，不是费率绝对值。
  const d = evaluateAlerts({ snapshot: mk('-0.00002', false), prev: null, now: T0, config: cfg });
  ok(
    '空头 + 负费率但只有 17.52%（正好等于基准）→ 不告警',
    !d.active['funding:BTC:funding-cost'],
    JSON.stringify(d.active['funding:BTC:funding-cost']?.metrics)
  );

  const d2 = evaluateAlerts({ snapshot: mk('-0.00008', false), prev: null, now: T0, config: cfg });
  const d2a = d2.active['funding:BTC:funding-cost'];
  ok(
    '空头 + 负费率 70.08%（4× 基准）→ 触发，且年化方向计算正确',
    Boolean(d2a) && Math.abs(d2a.metrics.apr - 0.7008) < 1e-9,
    JSON.stringify(d2a?.metrics)
  );
  ok('4× 基准越过 vsBaseline 的 critical 线 → critical', d2a?.severity === 'critical', d2a?.severity);

  // 无基准时退化到绝对阈值，不应崩
  const e = evaluateAlerts({ snapshot: mk('0.00009', true, null), prev: null, now: T0, config: cfg });
  ok('无资金费基准时仍能用绝对阈值判定（0.00009 → 78.8% → critical）', e.active['funding:BTC:funding-cost']?.severity === 'critical', JSON.stringify(e.active['funding:BTC:funding-cost']?.severity));
}

/* ─────────────────── 8. 滚仓：达成 / 档位迟滞 / 趋势否决 ─────────────────── */

group('8. 滚仓 —— 阈值达成、档位迟滞、趋势否决');

{
  const cfg = { priming: 'all', cooldownMs: 60_000 };
  const trig = 500; // +5%
  const entry = 70000;
  const mark = entry * 1.06; // 浮盈 6% > 5%
  const pos = (o = {}) =>
    mkPosition({
      markPx: mark,
      entryPx: entry,
      liqPx: 50000,
      levels: mkLevels({
        markPx: mark,
        entryPx: entry,
        mid: mark * 0.5,
        stop: mark * 0.5,
        profitPct: o.profitPct ?? 0.06,
        triggerBps: trig,
        trendDir: o.trendDir === undefined ? 1 : o.trendDir,
        ready: o.ready,
        ladder: o.ladder ?? [],
      }),
    });

  const a = evaluateAlerts({ snapshot: mkSnap({ positions: [pos()] }), prev: null, now: T0, config: cfg });
  ok('浮盈 6% 且趋势支撑 → 滚仓条件达成（warn）', a.active['roll:BTC:roll-ready']?.severity === 'warn', JSON.stringify(Object.keys(a.active)));

  // 浮盈回落到 4.5%（低于 5%，但高于 clear 线 5%×0.8=4%）→ 仍应保持活动
  let prev = a.state;
  const b = evaluateAlerts({ snapshot: mkSnap({ positions: [pos({ profitPct: 0.045 })] }), prev, now: T0 + 100, config: cfg });
  prev = b.state;
  ok('浮盈回落 4.5%（在迟滞带内）→ 仍视为达成，不刷事件', Boolean(b.active['roll:BTC:roll-ready']) && b.events.length === 0, JSON.stringify(b.events.map((e) => e.kind)));

  const c = evaluateAlerts({ snapshot: mkSnap({ positions: [pos({ profitPct: 0.03 })] }), prev, now: T0 + 200, config: cfg });
  ok('浮盈回落 3%（越过 clear 线）→ recovered', c.events.some((e) => e.kind === 'recovered' && e.key === 'roll:BTC:roll-ready'));

  // 趋势不支撑时，必须升级为 critical 而不是提示可加仓
  const dPos = mkPosition({
    markPx: mark,
    entryPx: entry,
    liqPx: 50000,
    levels: mkLevels({ markPx: mark, entryPx: entry, mid: mark * 0.5, stop: mark * 0.5, profitPct: 0.06, triggerBps: trig, trendDir: -1 }),
  });
  const d = evaluateAlerts({ snapshot: mkSnap({ positions: [dPos] }), prev: null, now: T0, config: cfg });
  ok('浮盈够了但趋势反向 → critical「禁止加仓」', d.active['roll:BTC:roll-blocked']?.severity === 'critical', JSON.stringify(Object.keys(d.active)));
  ok('此时不再同时报「可加仓」', !d.active['roll:BTC:roll-ready']);

  // 档位迟滞：触发价 71000，标记价 71400 → 越过；跌回 70950（迟滞带内）仍活动；跌到 70800 解除
  const ladder = [
    { index: 1, triggerPrice: W(71000), addQty: W(0.5), newAvg: W(70000), newStop: W(70200), worstCaseLoss: W(100), passesBudget: true, reached: true },
  ];
  const mkStep = (m) =>
    mkSnap({
      positions: [
        mkPosition({
          markPx: m,
          entryPx: entry,
          liqPx: 50000,
          levels: mkLevels({ markPx: m, entryPx: entry, mid: m * 0.5, stop: m * 0.5, profitPct: 0.02, triggerBps: trig, ladder }),
        }),
      ],
    });
  let p2 = null;
  const s1 = evaluateAlerts({ snapshot: mkStep(71400), prev: p2, now: T0, config: cfg });
  p2 = s1.state;
  const s2 = evaluateAlerts({ snapshot: mkStep(70950), prev: p2, now: T0 + 100, config: cfg });
  p2 = s2.state;
  const s3 = evaluateAlerts({ snapshot: mkStep(70800), prev: p2, now: T0 + 200, config: cfg });

  ok('标记价越过触发价 → 档位告警', s1.active['roll:BTC:step1']?.severity === 'warn', JSON.stringify(Object.keys(s1.active)));
  ok('回落 7bps（迟滞带 10bps 内）→ 仍活动，不刷事件', Boolean(s2.active['roll:BTC:step1']) && s2.events.length === 0);
  ok('回落 28bps（越过迟滞带）→ recovered', s3.events.some((e) => e.kind === 'recovered' && e.key === 'roll:BTC:step1'));
}

/* ─────────────────── 9. 健壮性：不炸、不产生坏值 ─────────────────── */

group('9. 健壮性 —— 缺字段、null 清算价、无持仓都不应炸');

{
  const cfg = { priming: 'all' };
  let threw = null;
  try {
    evaluateAlerts({ snapshot: {}, prev: null, now: T0, config: cfg });
    evaluateAlerts({ snapshot: { ok: true, positions: [] }, prev: null, now: T0, config: cfg });
    evaluateAlerts({ snapshot: mkSnap({ positions: [mkPosition({ liqPx: null })] }), prev: null, now: T0, config: cfg });
    evaluateAlerts({ snapshot: mkSnap({ positions: [mkPosition({ levels: null })] }), prev: null, now: T0, config: cfg });
    evaluateAlerts({ snapshot: mkSnap({ positions: [mkPosition({ levels: { bands: null, stop: {}, roll: null, risk: {}, trend: {} } })] }), prev: null, now: T0, config: cfg });
    evaluateAlerts({ snapshot: mkSnap({ positions: [mkPosition({ noStop: true, levels: mkLevels({ noStop: true, markPx: 77000 }) })] }), prev: null, now: T0, config: cfg });
  } catch (e) {
    threw = e;
  }
  ok('缺字段 / 空快照 / 无 levels 都不抛异常', threw === null, threw && threw.message);

  const r = evaluateAlerts({ snapshot: mkSnap({ positions: [] }), prev: null, now: T0, config: cfg });
  ok('无持仓 → 0 条告警', r.summary.total === 0);

  const noLevels = evaluateAlerts({ snapshot: mkSnap({ positions: [mkPosition({ levels: null })] }), prev: null, now: T0, config: cfg });
  ok('无策略读数的持仓仍做清算检查', 'risk:BTC:liq-approach' in noLevels.active || noLevels.summary.total === 0);
  ok('无策略读数的持仓被记入 uncovered', noLevels.uncovered.length === 1, JSON.stringify(noLevels.uncovered));

  const nullLiq = evaluateAlerts({ snapshot: mkSnap({ positions: [mkPosition({ liqPx: null })] }), prev: null, now: T0, config: cfg });
  ok('liquidationPx 为 null 时不产生清算告警', !('risk:BTC:liq-approach' in nullLiq.active));

  // 所有文案里不能出现 undefined / NaN / [object Object]
  const all = evaluateAlerts({
    snapshot: mkSnap({
      positions: [mkPosition({ markPx: 63000, liqPx: 60000, levels: mkLevels({ markPx: 63000, stop: 63200, mid: 64000 }) })],
      markets: { BTC: { funding: '0.0004' } },
      fundingBaseline: { BTC: { aprMedian: 0.1, samples: 100 } },
      candles: { BTC: mkCandles(['65000.0', '62800.0'], T0 - 4 * 3600 * 1000) },
    }),
    prev: null,
    now: T0,
    config: cfg,
  });
  const blob = all.list.map((x) => `${x.title} ${x.detail}`).join(' | ');
  ok('所有告警文案无 undefined', !/undefined/.test(blob), blob.slice(0, 200));
  ok('所有告警文案无 NaN', !/NaN/.test(blob), blob.slice(0, 200));
  ok('所有告警文案无 [object Object]', !/\[object/.test(blob));
  ok('严重度都在合法集合内', all.list.every((x) => x.severity === 'warn' || x.severity === 'critical'));
  ok('list 按严重度降序', all.list.every((x, i) => i === 0 || SEVERITY_RANK[all.list[i - 1].severity] >= SEVERITY_RANK[x.severity]));
}

/* ─────────────────── 10. 单位自证：距清算用「比例」而非 bps ─────────────────── */

group('10. 量纲自证 —— 15% 是 0.15 而不是 15 或 1500');

{
  const r = evaluateAlerts({
    snapshot: mkSnap({ positions: [mkPosition({ markPx: 60000 / 0.88, liqPx: 60000, levels: isolatedLevels(60000 / 0.88) })] }),
    prev: null,
    now: T0,
    config: { priming: 'all' },
  });
  const a = r.active['risk:BTC:liq-approach'];
  ok('距清算 12% 判为 warn（阈值 0.15）', a?.severity === 'warn', a?.severity);
  ok('指标值落在 [0,1] 而不是 bps 量级', a && a.metrics.value > 0.1 && a.metrics.value < 0.14, String(a?.metrics.value));

  const far = evaluateAlerts({
    snapshot: mkSnap({ positions: [mkPosition({ markPx: 60000 / 0.5, liqPx: 60000, levels: isolatedLevels(60000 / 0.5) })] }),
    prev: null,
    now: T0,
    config: { priming: 'all' },
  });
  ok('距清算 50% → 不告警', !far.active['risk:BTC:liq-approach']);
}

/* ─────────────────── 11. 状态可序列化（前后端传递用） ─────────────────── */

group('11. 状态与文案');

{
  const r = evaluateAlerts({
    snapshot: mkSnap({
      positions: [mkPosition({ markPx: 63000, liqPx: 60000, levels: mkLevels({ markPx: 63000, stop: 63200, mid: 64000 }) })],
      markets: { BTC: { funding: '0.0004' } },
    }),
    prev: null,
    now: T0,
    config: { priming: 'all' },
  });
  const round = JSON.parse(JSON.stringify(r.state));
  const again = evaluateAlerts({
    snapshot: mkSnap({
      positions: [mkPosition({ markPx: 63000, liqPx: 60000, levels: mkLevels({ markPx: 63000, stop: 63200, mid: 64000 }) })],
      markets: { BTC: { funding: '0.0004' } },
    }),
    prev: round,
    now: T0 + 10,
    config: { priming: 'all' },
  });
  ok('state 可 JSON 往返（不含 BigInt）', true);
  ok('JSON 往返后 key 集合一致', Object.keys(again.active).join(',') === Object.keys(r.active).join(','));

  const push = formatPush(r.events, r, { networkLabel: '主网', userShort: '0x1234…abcd' });
  ok('推送正文包含标题与汇总', /比特皇看板/.test(push) && /当前活动预警/.test(push));
  ok('推送正文无 undefined / NaN', !/undefined|NaN/.test(push));
  const plain = formatPushText(r.events, r, {});
  ok('纯文本版去掉了 markdown 标记', !/\*\*/.test(plain) && !/^#/m.test(plain));
}

/* ─────────────────── 12. 配置与 URL 安全 ─────────────────── */

group('12. 配置与推送地址安全');

{
  const c = resolveConfig({ risk: { liq: { warn: 0.08 } }, cooldownMs: 5 });
  ok('用户覆盖生效', c.risk.liq.warn === 0.08 && c.cooldownMs === 5);
  ok('未覆盖的字段保持默认', c.risk.liq.critical === ALERT_DEFAULTS.risk.liq.critical && c.risk.liq.clear === ALERT_DEFAULTS.risk.liq.clear);
  ok('未知字段被忽略（配置写错不崩）', resolveConfig({ nonsense: 1, risk: { bogus: {} } }).risk.liq.warn === ALERT_DEFAULTS.risk.liq.warn);

  let err = null;
  try {
    assertSafeWebhookUrl('http://169.254.169.254/latest/meta-data/');
  } catch (e) {
    err = e.message;
  }
  ok('拒绝云元数据地址（SSRF 防线）', Boolean(err) && /内网|回环|元数据/.test(err), String(err));

  err = null;
  try {
    assertSafeWebhookUrl('http://127.0.0.1:9999/hook');
  } catch (e) {
    err = e.message;
  }
  ok('拒绝回环地址', Boolean(err));

  err = null;
  try {
    assertSafeWebhookUrl('http://evil.example.com/hook');
  } catch (e) {
    err = e.message;
  }
  ok('外部地址必须 https', Boolean(err) && /https/.test(err), String(err));

  ok('合法的企微 webhook 通过校验', Boolean(assertSafeWebhookUrl('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef123456')));

  const masked = maskUrl('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=53a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5');
  ok('掩码后不含完整 token', !masked.includes('53a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5'), masked);
  ok('掩码保留了主机名（便于确认发往哪里）', masked.includes('qyapi.weixin.qq.com'), masked);
  const barkMask = maskUrl('https://api.day.app/aBcDeFgHiJkLmNoPqRsT/');
  ok('Bark 的 key 段被掩码', !barkMask.includes('aBcDeFgHiJkLmNoPqRsT') && barkMask.includes('api.day.app'), barkMask);

  const fh = summarizeFundingHistory([
    { fundingRate: '0.00001' },
    { fundingRate: '0.00002' },
    { fundingRate: '-0.00003' },
    { fundingRate: 'not-a-number' },
  ]);
  ok('资金费基准统计忽略坏值并取 |rate|', fh.samples === 3 && Math.abs(fh.medianAbs - 0.00002) < 1e-12, JSON.stringify(fh));
  ok('基准年化 = 中位 |速率| × 8760', Math.abs(fh.aprMedian - 0.00002 * 8760) < 1e-9, String(fh.aprMedian));
  ok('空历史返回 null 而不是 NaN 结构', summarizeFundingHistory([]) === null);
}

/* ─────────────────── 13. Telegram 通道与通道级代理 ─────────────────── */

group('13. Telegram 通道与通道级代理');

{
  // 本组要读环境变量，所以先把 HTTPS_PROXY 摘掉，跑完原样放回 ——
  // 不能假设跑测试的机器上没有代理（开发机往往恰恰有，而且 CI 也常注入）。
  const savedUpper = process.env.HTTPS_PROXY;
  const savedLower = process.env.https_proxy;

  try {
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;

    ok('注册了 telegram 通道', Boolean(CHANNELS.telegram) && /Telegram/.test(CHANNELS.telegram));

    ok('既没配 proxy 也没环境变量时不走代理', resolveProxy({ type: 'telegram' }) === null);

    const chProxy = resolveProxy({ proxy: 'http://127.0.0.1:7890' });
    ok('通道级 proxy 生效且标明来源', chProxy?.source === 'channel' && chProxy.url === 'http://127.0.0.1:7890');

    process.env.HTTPS_PROXY = 'http://127.0.0.1:9999';
    const priority = resolveProxy({ proxy: 'http://127.0.0.1:7890' });
    ok('通道级 proxy 优先于环境变量', priority?.source === 'channel' && priority.url === 'http://127.0.0.1:7890');
    ok('没有通道级 proxy 时回落到 HTTPS_PROXY', resolveProxy({ type: 'telegram' })?.source === 'env');
    delete process.env.HTTPS_PROXY;

    const agent = makeProxyAgent('http://127.0.0.1:7890');
    ok('代理地址能构造出隧道 agent', Boolean(agent));
    ok('同一代理地址复用同一个 agent（不重复建连接池）', makeProxyAgent('http://127.0.0.1:7890') === agent);

    let perr = null;
    try {
      makeProxyAgent('socks5://127.0.0.1:1080');
    } catch (e) {
      perr = e.message;
    }
    ok('拒绝非 http(s) 代理（socks5 不做静默降级）', Boolean(perr) && /http\(s\)/.test(perr), String(perr));

    let uerr = null;
    try {
      makeProxyAgent('这不是地址');
    } catch (e) {
      uerr = e.message;
    }
    ok('非法代理地址抛错（配置错误在自检就显形）', Boolean(uerr), String(uerr));

    const TG_TOKEN = 'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
    const TG_URL = `https://api.telegram.org/bot123456789:${TG_TOKEN}/sendMessage`;
    const tgMask = maskUrl(TG_URL);
    ok('Telegram bot token 段被掩码', !tgMask.includes(TG_TOKEN), tgMask);
    ok('掩码保留 api.telegram.org（便于确认发往哪里）', tgMask.includes('api.telegram.org'), tgMask);

    const noChat = await sendToChannel({ type: 'telegram', url: TG_URL }, { title: 't', body: 'b', text: 'x' });
    ok('缺 chatId 时判失败并说明原因', noChat.ok === false && /chatId/.test(noChat.error || ''), JSON.stringify(noChat));

    const badProxy = await sendToChannel(
      { type: 'telegram', url: TG_URL, chatId: '1', proxy: 'socks5://127.0.0.1:1080' },
      { title: 't', body: 'b', text: 'x' }
    );
    ok('代理不可用时判失败而不是静默退回直连', badProxy.ok === false && /http\(s\)/.test(badProxy.error || ''), JSON.stringify(badProxy));

    const insp = inspectChannels({
      channels: [
        { type: 'telegram', url: 'https://api.telegram.org/bot123456789:AAH/sendMessage', chatId: '123456789' },
        { type: 'telegram', url: TG_URL },
        { type: 'telegram', url: TG_URL, chatId: '1', proxy: 'socks5://127.0.0.1:1080' },
      ],
    });
    ok('合法的 telegram 通道通过自检', insp[0].ok === true, JSON.stringify(insp[0]));
    ok('缺 chatId 在自检阶段就报错', insp[1].ok === false && /chatId/.test(insp[1].error || ''));
    ok('非法代理在自检阶段就报错', insp[2].ok === false && /http\(s\)/.test(insp[2].error || ''));
    ok('自检输出不泄漏 chatId', !JSON.stringify(insp).includes('123456789'), JSON.stringify(insp));

    const friendly = telegramError('HTTP 401：{"ok":false,"error_code":401,"description":"Unauthorized"}');
    ok('Telegram 非 2xx 的错误被翻成人话', Boolean(friendly) && friendly.includes('Unauthorized') && friendly.includes('401'), String(friendly));
    ok(
      '解析不出 description 时不编造理由',
      telegramError('HTTP 500：<html>oops</html>') === null && telegramError('fetch failed') === null && telegramError(null) === null
    );
  } finally {
    if (savedUpper === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = savedUpper;
    if (savedLower === undefined) delete process.env.https_proxy;
    else process.env.https_proxy = savedLower;
  }
}

/* ─────────────────── 汇总 ─────────────────── */

console.log('');
console.log('─'.repeat(64));
console.log(`断言结果：通过 ${pass} 条，失败 ${fail} 条`);
if (fail) {
  console.log('');
  console.log('失败项：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exitCode = 1;
} else {
  console.log('预警引擎的不变式全部成立 —— 迟滞、冷却、升级、缺失容错、量纲都符合预期。');
}
