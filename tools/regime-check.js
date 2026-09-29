#!/usr/bin/env node
/**
 * 两套系统的验收工具
 * ══════════════════════════════════════════════════════════════════════
 *
 *   node tools/regime-check.js             纯合成数据的单元断言（不联网，快）
 *   node tools/regime-check.js --backtest  追加真实 BTC 历史的逐 bar 回算
 *
 * 它要证明的核心命题只有一句：
 *   **「三次突破」不能决定方向；它只能决定「在已定方向上什么时候扣扳机」。**
 *
 * 因此本工具最重要的一节是 D —— 它把同一段 K 线同时喂给新旧两个口径，
 * 然后指出旧口径把「连续 3 根收在轨外」数成了「3 次突破」，而新口径数出 1 条腿。
 * 这不是吹毛求疵：真实 4H 数据上旧口径给出的 longBreaks 一度到 5。
 */

import { readFileSync } from 'node:fs';

// 方向层的输入装配（2026-09 从 server.js 抽出来，让每日采集任务与看板共用）。
// 下面 E3.1c 要验「配置里写了的字段真的生效」，而透传点现在住在这个文件里。
import { regimeConfig } from '../src/regime-inputs.js';

// A3 节要验「宏观源失败只降级面板」：判定求值的容错粒度 + 降级读数与正常读数同构。
import { degradedMacro, evaluateMacroCriteria } from '../src/macro-sources.js';

import {
  BIAS,
  HALVINGS,
  PHASE_WINDOWS,
  barsOf,
  computeRegime,
  derivePhase,
  halvingClock,
  regimeAt,
  scoreEvents,
  structureRead,
} from '../src/regime.js';

import {
  PHASE_AUTO,
  adverseNewsExit,
  analyzeSetup,
  analyzeTrend,
  bandsAt,
  defaultConfig,
  defaultTiers,
  failedBounceRead,
  gate,
  phaseFloorBps,
  pullbackResumeRead,
} from '../src/strategy.js';

import { computeLevels } from '../src/levels.js';

import {
  PIPELINE_STAGES,
  runPipeline,
  stage1Fundamental,
  stage2Technical,
  stage3Position,
} from '../src/pipeline.js';

import {
  DIRECTION_CRITERIA,
  STAGES,
  criteriaByLayer,
  criteriaByStage,
  eventReactionRead,
  sentimentRead,
  synthesizeReversal,
  technicalsRead,
  volumeRead,
} from '../src/regime-criteria.js';

/* ─────────────────────── 断言脚手架 ─────────────────────── */

let pass = 0;
const fails = [];

function ok(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? `  ${extra}` : ''}`);
  } else {
    fails.push(name + (extra ? `  ${extra}` : ''));
    console.log(`  ✗ ${name}${extra ? `  ${extra}` : ''}`);
  }
}

function section(t) {
  console.log(`\n${t}`);
}

/** 合成价格序列转 WAD：x * 1e9 * 1e9 = x * 1e18 */
const w = (x) => BigInt(Math.round(x * 1e9)) * 10n ** 9n;
const seq = (xs) => xs.map(w);

/**
 * 生成 n 根 K 线，收盘从 from 几何增长到 to，最后一根落在 tEnd，间隔 dtms。
 * 用于构造"数据充足"的结构层测试数据 —— 关键是要凑够 200 根周线 / 220 根日线，
 * 否则分量会弃权，测出来的就不是结构层的行为。
 */
function geom(n, from, to, tEnd, dtms) {
  const r = (to / from) ** (1 / (n - 1));
  const out = [];
  let p = from;
  for (let i = 0; i < n; i++) {
    const t = tEnd - (n - 1 - i) * dtms;
    out.push({ t, o: p, h: p * 1.03, l: p * 0.97, c: p, v: 1 });
    p *= r;
  }
  return out;
}

/** 月线：按真实月份起点排，最后一根是 lastMonthStart 那个月 */
function monthBars(n, from, to, lastMonthStart) {
  const r = (to / from) ** (1 / (n - 1));
  const out = [];
  let p = from;
  for (let i = 0; i < n; i++) {
    const d = new Date(lastMonthStart);
    d.setUTCMonth(d.getUTCMonth() - (n - 1 - i));
    out.push({ t: d.getTime(), o: p, h: p * 1.05, l: p * 0.95, c: p, v: 1 });
    p *= r;
  }
  return out;
}

/**
 * 收口基准：振幅逐根递减 → 带宽持续收缩，这才是真实的"收口"。
 * （如果用等幅正弦，带宽恒定，百分位会算成 100%，收口条件永远不通过 ——
 *   这不是代码 bug，是测试数据不真实。第一版就踩了这个。）
 */
const PAD_N = 130;
const PAD = (() => {
  const out = [];
  for (let i = 0; i < PAD_N; i++) {
    const amp = 400 * (1 - i / PAD_N) + 10;
    out.push(50000 + amp * Math.sin(i * 1.7));
  }
  return out;
})();

/**
 * 用**真实轨道**决定下一根收盘放哪，而不是硬编码价格。
 * 硬编码价格在轨道随行情上移之后就不再是"突破/回踩"了 —— 形态会悄悄变味。
 */
function nextClose(arr, mode) {
  const closes = seq(arr);
  const b = bandsAt(closes, closes.length - 1, 20, 20000);
  const upper = Number(b.upper) / 1e18;
  const mid = Number(b.mid) / 1e18;
  if (mode === 'thrust') return upper * 1.02; // 明确冲出上轨
  if (mode === 'inside-above-mid') return (upper + mid) / 2; // 收回轨内但不破中轨
  if (mode === 'below-mid') return mid * 0.98; // 击穿中轨（用于失效测试）
  throw new Error('unknown mode ' + mode);
}

const CFG = defaultConfig('DECLINE');

/* ═══════════════════════ A. 减半时钟 ═══════════════════════ */

section('A. 减半时钟（确定性，零自由度）');

const clockOn = (d) => halvingClock(Date.parse(`${d}T00:00:00Z`));

{
  const c = clockOn('2024-08-01');
  ok('减半后 3.4 个月 → ACCUMULATION / 只许做多', c.phase === 'ACCUMULATION' && c.intent === BIAS.LONG_ONLY, `实际 ${c.phase}/${c.intent}`);

  const c2 = clockOn('2025-03-01');
  ok('减半后 10.4 个月 → EXPANSION / 只许做多', c2.phase === 'EXPANSION' && c2.intent === BIAS.LONG_ONLY, `实际 ${c2.phase}/${c2.intent}`);

  const c3 = clockOn('2025-10-06');
  ok(`2025-10-06（本轮历史高点当天，${c3.monthsSince} 个月）→ BLOWOFF / 双向不批准`, c3.phase === 'BLOWOFF' && c3.intent === BIAS.NEUTRAL, `实际 ${c3.phase}/${c3.intent}`);

  const c4 = clockOn('2026-09-21');
  ok('减半后 29.0 个月 → DECLINE / 只许做空', c4.phase === 'DECLINE' && c4.intent === BIAS.SHORT_ONLY, `实际 ${c4.phase}/${c4.intent}，${c4.monthsSince} 个月`);

  // 相位窗口必须覆盖 0~48 个月无缝、不重叠，否则周期末端会出现"无相位"空档
  let contiguous = PHASE_WINDOWS[0].from === 0;
  for (let i = 1; i < PHASE_WINDOWS.length; i++) {
    if (PHASE_WINDOWS[i].from !== PHASE_WINDOWS[i - 1].to) contiguous = false;
  }
  ok('相位窗口首尾相接、无空档无重叠', contiguous, PHASE_WINDOWS.map((x) => `${x.from}~${x.to}`).join(' '));

  // 历史顶部必须落在 BLOWOFF 里 —— 这是窗口边界的设定依据，不是拍脑袋
  const tops = ['2013-12-04', '2017-12-17', '2021-11-10', '2025-10-06'];
  const topMonths = tops.map((t) => {
    // 每个顶对应的减半
    const ms = Date.parse(`${t}T00:00:00Z`);
    let last = null;
    for (const h of HALVINGS) if (Date.parse(`${h.date}T00:00:00Z`) <= ms) last = h;
    return (ms - Date.parse(`${last.date}T00:00:00Z`)) / 86400000 / 30.44;
  });
  const blow = PHASE_WINDOWS.find((x) => x.phase === 'BLOWOFF');
  const sorted = topMonths.slice().sort((a, b) => a - b);
  const median = (sorted[1] + sorted[2]) / 2;
  const inBlow = topMonths.filter((m) => m >= blow.from && m < blow.to).length;

  ok(
    `历史四个顶部中位数 ${median.toFixed(1)} 个月落在 BLOWOFF 窗口内`,
    median >= blow.from && median < blow.to,
    `四个顶部分别在 ${topMonths.map((m) => m.toFixed(1)).join(' / ')} 个月；BLOWOFF = ${blow.from}~${blow.to}`
  );
  ok(
    `4 个顶部中有 ${inBlow} 个落在 BLOWOFF 内`,
    inBlow >= 3,
    '2013 年那个（12.2 个月）是已知离群值：当时没有衍生品、流动性极小，节奏比成熟市场快得多。不为了迁就它把窗口边界拉到 12 —— 那会让"加速冲顶"段覆盖掉整段主升'
  );
  ok(
    '所有顶部都落在减半后 12~24 个月之间（窗口边界的硬约束）',
    topMonths.every((m) => m >= 12 && m < 24),
    `最早 ${Math.min(...topMonths).toFixed(1)}、最晚 ${Math.max(...topMonths).toFixed(1)} 个月`
  );
  ok('BLOWOFF 相位不批准任何方向（既不追高也不反手做空）', blow.intent === BIAS.NEUTRAL);
}

/* ═══════════════════════ A2. 相位解析（人工 vs 自动） ═══════════════════════ */

section('A2. 相位解析 —— 「自动」必须真的自动，未知值必须显形');

{
  /* 这一节守的是一个**跨层的不同步**，不是单个函数的行为：
   * 方向层（computeRegime）直接读减半时钟，而波动门槛读 cfg.cyclePhase。
   * 只要 cfg.cyclePhase 的默认值跟时钟推出来的不一致，系统就会
   * 「方向按出清段算、门槛按筑底算」—— 两个字段各自都"对"，合起来是错的。
   */
  const now = Date.parse('2026-09-23T03:00:00Z');
  const clock = halvingClock(now);

  ok('此刻减半时钟推算是 DECLINE（本节所有断言的前提）', clock.phase === 'DECLINE', `实际 ${clock.phase}`);

  // ---- 自动：缺省 / 空 / AUTO（大小写、空白都要宽容）----
  const autos = [undefined, null, '', PHASE_AUTO, 'auto', ' auto ', 'AuTo'];
  for (const m of autos) {
    const r = derivePhase(now, m);
    const tag = m === undefined ? '缺省' : JSON.stringify(m);
    ok(`相位 ${tag} → 取时钟值 ${clock.phase}`, r.phase === clock.phase, `实际 ${r.phase}`);
    ok(`相位 ${tag} → 标为自动且不算漂移`, r.auto === true && r.stale === false && r.manual === null, `auto=${r.auto} stale=${r.stale}`);
    ok(`相位 ${tag} → 不误报为未知值`, r.unknown === false, `unknown=${r.unknown}`);
    ok(`相位 ${tag} → 带出具体相位的中文名（界面要显示）`, r.derivedLabel === '出清下跌（减半后 24~48 个月）', String(r.derivedLabel));
  }

  // ---- 人工指定具体相位：值优先，但漂移必须显形 ----
  const rDecline = derivePhase(now, 'DECLINE');
  ok('人工指定 DECLINE 与推算一致 → 不报漂移', rDecline.phase === 'DECLINE' && rDecline.stale === false && rDecline.auto === false);

  const rAcc = derivePhase(now, 'ACCUMULATION');
  ok(
    '人工指定 ACCUMULATION → 人工值优先，但 stale=true 且给出差额说明',
    rAcc.phase === 'ACCUMULATION' && rAcc.stale === true && /29\.1/.test(rAcc.detail),
    rAcc.detail
  );
  ok('stale 时同时给出人工值与推算值（界面要对照显示）', rAcc.manual === 'ACCUMULATION' && rAcc.derived === 'DECLINE');

  // 小写相位名也要认 —— 与 AUTO 同一套归一化，否则 ?phase=decline 会被当成拼错
  const rLower = derivePhase(now, 'decline');
  ok('人工指定小写 decline → 归一化为 DECLINE，不算未知值', rLower.phase === 'DECLINE' && rLower.unknown === false && rLower.stale === false, `phase=${rLower.phase} unknown=${rLower.unknown}`);

  // ---- 未知值：兜底到自动，但**必须**标出来 ----
  const rTypo = derivePhase(now, 'TYPO');
  ok('未知相位 → 兜底取时钟值', rTypo.phase === clock.phase, `实际 ${rTypo.phase}`);
  ok('未知相位 → unknown=true 且带出原始输入（不能静默降级）', rTypo.unknown === true && rTypo.requested === 'TYPO', `unknown=${rTypo.unknown} requested=${rTypo.requested}`);

  // ---- 门槛必须与方向层同源 ----
  const cfgAuto = defaultConfig(derivePhase(now, PHASE_AUTO).phase);
  ok('自动模式下门槛取下限为 DECLINE 的 20%', cfgAuto.risk.minExpectedMoveBps === 2000, `实际 ${cfgAuto.risk.minExpectedMoveBps}`);
  ok('phaseFloorBps 收到四相位之外的任何值都会落到 DECLINE 档（所以必须先解析）', phaseFloorBps('AUTO') === 2000 && phaseFloorBps('NONSENSE') === 2000);

  /* 这条是本次改动的**核心不变式**：把「自动」解析出来的相位喂给 cfg，
   * 必须与方向层自己读时钟得到的相位一致。以前默认 ACCUMULATION 时
   * 这一条是**假**的，而没有任何测试发现它。 */
  ok(
    '自动模式下 cfg.cyclePhase 与方向层读到的时钟相位一致（不得再出现两处不同源）',
    cfgAuto.cyclePhase === halvingClock(now).phase,
    `cfg=${cfgAuto.cyclePhase} clock=${halvingClock(now).phase}`
  );
}

/* ═════════ A3. 宏观源失败只降级面板，不连坐方向层 ═════════ */

section('A3. 宏观源失败只降级面板 —— 确定性结论不许跟着消失');

{
  const now = Date.parse('2026-09-23T03:00:00Z');

  /* 背景：M1~M6 是「加分项与刹车项」，它们**采集失败**不该让减半时钟、
   * 结构层这些完全确定性的读数一起消失。早期版本把采集与方向层包在同一个
   * try 里，源一抖动 regime 就整个变成 null —— 界面上看起来像系统坏了。
   *
   * 这一节钉两件事：① 降级读数与正常读数**同构**（都是六条，只是全弃权）；
   * ② 容错粒度是**每一条判据**，不是一个源坏了就全批降级。
   */

  // ---- ① 降级读数必须与正常读数同构（是六条，不是空数组） ----
  const deg = degradedMacro({ price: 86538, config: {}, reason: '演练：全部源不可用' });
  ok('降级读数仍是完整六条（不是空数组）', deg.readings.length === 6, `实际 ${deg.readings.length} 条`);
  ok(
    '降级读数每条 available:false 且 vote:0',
    deg.readings.every((r) => r.available === false && r.vote === 0)
  );
  ok(
    '降级读数保留 M1~M6 的层号 —— 界面才显示得出「这次少了哪六条」',
    deg.readings.map((r) => r.layer).join(',') === 'M1,M2,M3,M4,M5,M6',
    deg.readings.map((r) => r.layer).join(',')
  );
  ok('降级源带 degraded 原因，供界面显形', !!deg.src.degraded && deg.src.degraded.includes('演练'), String(deg.src.degraded));

  // ---- ② 逐条容错：一条源形状异常不许带走另外五条 ----
  /* 实测：源的 `status` 说 ok，字段却可能不全（上游改名、返回半截对象、
   * 子请求超时后只填了一半）—— 六种缺字段形状里有四种会让求值抛 TypeError。
   * 所以容错必须在**每条判据**这一层，不能只在最外层兜住。 */
  const probe = (src) => {
    try {
      const rs = evaluateMacroCriteria(src, { price: 86538, config: {} });
      return { ok: true, n: rs.length, broken: rs.filter((r) => r.broken).length, rs };
    } catch (e) {
      return { ok: false, err: e.message };
    }
  };
  const shapes = [
    ['etfFlow 缺 lastDays', { sources: { etfFlow: { status: 'ok', latestUsd: 1e8, thresholdUsd: 5e7, allAboveThreshold: true, consecutiveDaysAbove: 3 } } }],
    ['onchain 缺 avg7', { sources: { onchain: { status: 'ok', wowPct: 9 } } }],
    ['institutional 缺 ibitBtc/supplyBtc', { sources: { institutional: { status: 'ok', sharePct: 3.9, targetPct: 3.5 } } }],
    ['regulatory 缺 official 数组', { sources: { regulatory: { status: 'ok', officialPositive: 1, officialNegative: 0 } } }],
  ];
  for (const [name, s] of shapes) {
    const p = probe(s);
    ok(`源形状异常（${name}）不抛错、仍是六条`, p.ok && p.n === 6, p.ok ? `${p.n} 条` : `抛错：${p.err}`);
    ok(
      `源形状异常（${name}）只降级那一条，其余判据照常参与`,
      p.ok && p.broken === 1,
      p.ok ? `broken=${p.broken}` : `抛错：${p.err}`
    );
  }

  // ---- ③ 最强证据：同一批数据里，坏的那条不妨碍好的那条 ----
  const mixed = probe({
    sources: {
      fearGreed: { status: 'ok', latest: 78, latestLabel: '极端贪婪', avg14: 55 },
      onchain: { status: 'ok', wowPct: 9 }, // 缺 avg7 / avgPrev7 → 形状异常
    },
  });
  const m1 = mixed.ok ? mixed.rs.find((r) => r.id === 'media-extreme') : null;
  const m3 = mixed.ok ? mixed.rs.find((r) => r.id === 'onchain-activity') : null;
  ok(
    '同一批数据里 onchain 形状异常时，M1 恐慌贪婪的读数仍照常产出（互不连坐）',
    !!m1 && m1.available === true && !!m3 && m3.available === false && m3.broken === true,
    m1 && m3 ? `M1.available=${m1.available} M3.available=${m3.available} M3.broken=${m3.broken}` : '求值抛错'
  );

  // ---- ④ 降级读数喂给方向层：确定性部分必须一模一样 ----
  const sixOk = [
    { id: 'media-extreme', layer: 'M1', name: '媒体情绪', available: true, vote: -1, reason: '极端贪婪' },
    { id: 'etf-netflow', layer: 'M2', name: 'ETF 净流入', available: true, vote: 1, reason: '连续净流入' },
    { id: 'onchain-activity', layer: 'M3', name: '链上活跃', available: true, vote: 1, reason: '周环比达标' },
    { id: 'liquidity-macro', layer: 'M4', name: '流动性与利率', available: true, vote: 0, reason: '条件未齐' },
    { id: 'institutional-holding', layer: 'M5', name: '机构持仓', available: true, vote: 1, reason: '超门槛' },
    { id: 'regulation-policy', layer: 'M6', name: '监管政策', available: true, vote: 1, reason: '官方净偏多' },
  ];
  const base = { daily: [], weekly: [], monthly: [], asOfMs: now, cfg: {} };
  const rNone = regimeAt({ ...base, macro: [] }); // 旧做法：宏观整块不传
  const rDeg = regimeAt({ ...base, macro: deg.readings }); // 现在的降级：六条全弃权
  const rOk = regimeAt({ ...base, macro: sixOk }); // 正常

  ok('降级读数下方向层照常返回结论（不抛、不为 null）', !!rDeg && typeof rDeg.bias === 'string', `bias=${rDeg?.bias}`);
  ok(
    '降级前后确定性的减半时钟完全一致（「不连坐」最硬的证据）',
    rDeg.clock.phase === rOk.clock.phase &&
      rDeg.clock.monthsSince === rOk.clock.monthsSince &&
      rDeg.clock.phase === rNone.clock.phase,
    `${rNone.clock.phase}/${rDeg.clock.phase}/${rOk.clock.phase}`
  );
  ok(
    '降级读数下方向层明说「六项取不到」而不是当成没有异议',
    rDeg.reasons.some((x) => /6 项取不到数据/.test(x)),
    (rDeg.reasons.find((x) => x.includes('取不到数据')) || '(未找到弃权汇总)').slice(0, 70)
  );
  const degEvidence = rDeg.reversal.evidence.filter((x) => x.layer.startsWith('M'));
  ok(
    '六条宏观判据全部以「弃权」身份进入证据链（而不是整体消失）',
    degEvidence.length === 6 && degEvidence.every((x) => !x.available),
    `${degEvidence.length} 条`
  );
  ok(
    '把空数组当宏观读数会**少**六条证据 —— 这正是降级不能传空数组的理由',
    rDeg.reversal.evidence.length > rNone.reversal.evidence.length,
    `降级 ${rDeg.reversal.evidence.length} 条 vs 空数组 ${rNone.reversal.evidence.length} 条`
  );

  // ---- ⑤ 结构守卫：server.js 的几段必须各在自己的 try 里 ----
  const serverSrc = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  ok('server.js 里方向层有自己的失败告警（说明它与采集不共用 try）', /方向层计算失败（方向未定/.test(serverSrc));
  ok(
    'server.js 的宏观采集失败走 degradedMacro 降级（复用同一条求值代码，形状同构）',
    /degradedMacro\(/.test(serverSrc)
  );
  ok('server.js 把降级状态透出给界面（macro.degraded）', /degraded:/.test(serverSrc));
  ok('server.js 提供 --macro-offline 演练开关（「六个源全挂」可复现、可验收）', /--macro-offline/.test(serverSrc));
}

/* ═══════════════════════ B. 长周期结构 ═══════════════════════ */

section('B. 长周期结构（周/月线，四分量投票）');

{
  const asOf = Date.parse('2026-09-21T00:00:00Z');
  const DAY = 86400000;
  // 最后一根**已收**月线落在 2026-08；当月 2026-09 正在进行，必须被排除
  const lastClosedMonth = Date.parse('2026-08-01T00:00:00Z');

  const bull = {
    daily: geom(300, 50, 400, asOf - DAY, DAY), // 300 根 → 200 日均线与斜率都算得出
    weekly: geom(250, 50, 400, asOf - 3 * DAY, 7 * DAY), // 250 根 → 够 200 周均线
    monthly: monthBars(40, 50, 400, lastClosedMonth),
  };
  const su = structureRead({ ...bull, asOfMs: asOf });
  ok(
    '单调上涨 → 四个分量全投多头，归一化 +1',
    su.score === 5.5 && su.verdict === 'BULL' && su.usable === 4,
    `score=${su.score} ${su.verdict} usable=${su.usable}（分量权重 2.0+1.0+1.0+1.5=5.5）`
  );

  const bear = {
    daily: geom(300, 400, 50, asOf - DAY, DAY),
    weekly: geom(250, 400, 50, asOf - 3 * DAY, 7 * DAY),
    monthly: monthBars(40, 400, 50, lastClosedMonth),
  };
  const sb = structureRead({ ...bear, asOfMs: asOf });
  ok('单调下跌 → 四个分量全投空头，归一化 −1', sb.score === -5.5 && sb.verdict === 'BEAR' && sb.usable === 4, `score=${sb.score} ${sb.verdict} usable=${sb.usable}`);

  // 数据不足时必须"弃权"（vote=0），而不是当成中性或硬猜
  const thin = structureRead({ daily: geom(210, 50, 100, asOf - DAY, DAY), weekly: [], monthly: [], asOfMs: asOf });
  ok(
    '周线/月线不足、日线不足 220 根时，三个分量全部弃权',
    thin.usable === 1 && thin.components.filter((c) => c.vote === 0).length === 3,
    `usable=${thin.usable}，弃权 ${thin.components.filter((c) => c.vote === 0).length} 项 —— 只有「价格 vs 200 日均线」可算`
  );

  // 追高判据：**离 200 日均线多远**，而不是离历史最高多近。
  // （最初写成"距最高回撤 < 20% 即禁多"，回测发现那会在牛市里把整段趋势封死。）
  const nearAth = structureRead({ daily: geom(300, 40, 100, asOf - DAY, DAY), weekly: [], monthly: [], asOfMs: asOf, cfg: { chaseMaxExtensionPct: 0.5 } });
  ok(
    `贴着历史最高、但只高于 200 日均线 ${(nearAth.extensionVs200d * 100).toFixed(0)}% → 不禁多（"在顶部区" ≠ "追高"）`,
    nearAth.drawdownZone === 'NEAR_ATH' && nearAth.chaseForbidden === false,
    `回撤 ${(nearAth.drawdownPct * 100).toFixed(1)}%、离 200 日均线 +${(nearAth.extensionVs200d * 100).toFixed(1)}%`
  );
  const overext = structureRead({ daily: geom(300, 40, 200, asOf - DAY, DAY), weekly: [], monthly: [], asOfMs: asOf, cfg: { chaseMaxExtensionPct: 0.5 } });
  ok(
    `短期暴涨把价格拉到高于 200 日均线 ${(overext.extensionVs200d * 100).toFixed(0)}% → 禁多（这才是追高）`,
    overext.chaseForbidden === true,
    `离 200 日均线 +${(overext.extensionVs200d * 100).toFixed(1)}%`
  );

  // 前视偏差防护：正在形成的当月不得参与月线结构判定
  {
    const t = Date.parse('2026-09-15T00:00:00Z'); // 9 月月中
    const months = [
      { t: Date.parse('2026-06-01T00:00:00Z'), o: 100, h: 110, l: 90, c: 105, v: 1 },
      { t: Date.parse('2026-07-01T00:00:00Z'), o: 100, h: 90, l: 80, c: 85, v: 1 }, // 高点降低、低点降低
      { t: Date.parse('2026-08-01T00:00:00Z'), o: 100, h: 80, l: 70, c: 75, v: 1 }, // 继续降低
      { t: Date.parse('2026-09-01T00:00:00Z'), o: 100, h: 999, l: 60, c: 900, v: 1 }, // 当月：跳空高开
    ];
    const daily = [];
    for (let i = 0; i < 260; i++) daily.push({ t: t - (260 - i) * 86400000, o: 80, h: 85, l: 75, c: 80, v: 1 });
    const r = structureRead({ daily, weekly: [], monthly: months, asOfMs: t });
    const ms = r.monthlyStructure;
    ok(
      '月线结构只用**已收盘**月线：当月的 999 高点不参与判定',
      ms && ms.last.t === months[2].t && ms.higherHigh === false && ms.higherLow === false,
      ms ? `比的是 ${new Date(ms.prev.t).toISOString().slice(0, 7)} → ${new Date(ms.last.t).toISOString().slice(0, 7)}，判定空头` : '未算出'
    );
  }
}

/* ═══════════════════════ C. 事件层衰减与黑天鹅 ═══════════════════════ */

section('C. 大事件层（半衰期衰减 + 黑天鹅否决）');

{
  const now = Date.parse('2026-09-21T00:00:00Z');
  const day = 86400000;

  const r1 = scoreEvents([{ id: 'x', date: '2026-06-13', kind: 'etf', weight: 1, halfLifeDays: 100 }], now);
  ok('半衰期 100 天、恰好 100 天前的事件 → 有效权重 0.5', Math.abs(r1.items[0].effective - 0.5) < 0.005, `实际 ${r1.items[0].effective}`);

  const r2 = scoreEvents([{ id: 'y', date: '2028-04-15', kind: 'halving', weight: 5, halfLifeDays: 365 }], now);
  ok('未来事件标记 pending 且有效权重记 0（禁止前视）', r2.items[0].pending === true && r2.items[0].effective === 0 && r2.net === 0, `pending=${r2.items[0].pending} effective=${r2.items[0].effective}`);

  const r3 = scoreEvents([{ id: 'z', date: '2026-09-16', kind: 'shock', weight: -2, halfLifeDays: 60 }], now, { shockWindowDays: 30 });
  ok('5 天前的黑天鹅 → 触发否决（active）', r3.shock.active === true, r3.shock.detail?.slice(0, 60));

  const r4 = scoreEvents([{ id: 'z2', date: '2026-06-01', kind: 'shock', weight: -2, halfLifeDays: 60 }], now, { shockWindowDays: 30 });
  ok('112 天前的黑天鹅 → 超出冷却窗口，不再否决', r4.shock.active === false, `ageDays=${r4.items[0].ageDays}`);

  const r5 = scoreEvents([{ id: 'z3', date: '2026-09-16', kind: 'shock', weight: -2, halfLifeDays: 60 }], now);
  const reg = regimeAt({
    daily: [], weekly: [], monthly: [], events: [{ id: 'z3', date: '2026-09-16', kind: 'shock', weight: -2, halfLifeDays: 60 }],
    asOfMs: now, cfg: { shockWindowDays: 30 },
  });
  ok('黑天鹅期间 regime 被强制 NEUTRAL', reg.bias === BIAS.NEUTRAL && reg.reasons.some((x) => x.includes('黑天鹅')), `bias=${reg.bias}`);
}

/* ═══════════════════ D. 核心回归：三次突破 vs 三条腿 ═══════════════════ */

section('D. 核心回归 —— 「三次突破」到底该怎么数（本工具存在的理由）');

{
  // S1：连续 4 根冲出上轨 —— 这是**一根长阳**，不是四次突破
  const arr = [...PAD];
  for (let i = 0; i < 4; i++) arr.push(nextClose(arr, 'thrust'));
  const s1 = seq(arr);
  const newWay = analyzeSetup(s1, CFG);
  const oldWay = analyzeTrend(s1, CFG);

  ok(
    `S1 连续 4 根收在上轨外 → 新口径数出 1 条推进腿（实际 ${newWay.longLegs}）`,
    newWay.longLegs === 1,
    '这是本次修正的核心：一条腿 = 一段连续收在轨外的区间'
  );
  ok(
    `S1 同一段 K 线，旧口径数出 ${oldWay.longBreaks} 次「有效突破」并据此宣布 direction=${oldWay.direction}`,
    oldWay.longBreaks >= 3 && oldWay.direction === 1,
    '旧口径把连续 4 根算成 4 次突破 —— 于是一根长阳就跨过了「三次突破」的门槛'
  );
  ok('S1 新口径的腿数 < 3，触发不成立（blockers 里必须出现腿数不足）', newWay.blockers.some((b) => b.includes('推进腿')), JSON.stringify(newWay.blockers));
}

{
  // S2：三条**独立**推进腿 —— 每次冲高后都收回轨内，且不破中轨
  const arr = [...PAD];
  for (let leg = 0; leg < 3; leg++) {
    arr.push(nextClose(arr, 'thrust')); // 冲高
    if (leg < 2) arr.push(nextClose(arr, 'inside-above-mid')); // 回踩但不破中轨
  }
  arr.push(nextClose(arr, 'thrust')); // 末条腿持续 ≥ holdBars
  arr.push(nextClose(arr, 'thrust'));

  const r = analyzeSetup(seq(arr), CFG);
  ok(`S2 三段独立推进（每段之间收回轨内）→ 数出 3 条腿（实际 ${r.longLegs}）`, r.longLegs === 3, r.legs.map((l) => `${l.bars}根`).join(' + '));
  ok(`S2 末条腿持续 ${r.hold.bars} 根 ≥ setupHoldBars(${CFG.setupHoldBars}) → 站稳 H2`, r.hold.level === 'H2', `实际 ${r.hold.level}`);
  ok(
    `S2 收口成立（PAD 的振幅逐根递减，突破前带宽处于 ${r.squeeze.percentile} 分位）`,
    r.squeeze.ok,
    r.squeeze.percentile === null ? '算不出来' : `门槛 ≤ ${CFG.squeezeMaxPercentile} 分位`
  );
  ok('S2 三条腿 + H2 + 收口 → 触发条件本身全部成立（blockers 应为空）', r.blockers.length === 0, JSON.stringify(r.blockers));
  ok(
    'S2 收口判定发生在**第一条腿之前**，而不是当前这根（当前带宽必然已被突破拉大）',
    r.squeeze.atIndex !== null && r.squeeze.atIndex < r.legs[0].startIndex,
    `量的是第 ${r.squeeze.atIndex} 根，第一条腿在第 ${r.legs[0].startIndex} 根`
  );
}

{
  // S3：H0 / H1 / H2 三级站稳
  const arr3 = [...PAD];
  for (let i = 0; i < 3; i++) arr3.push(nextClose(arr3, 'thrust'));

  const h0 = analyzeSetup(seq([...arr3, nextClose(arr3, 'inside-above-mid')]), CFG);
  ok(`S3 末根收回轨内 → H0（实际 ${h0.hold.level}）`, h0.hold.level === 'H0', h0.hold.detail?.slice(0, 36));

  const h1 = analyzeSetup(seq([...PAD, nextClose(PAD, 'thrust')]), { ...CFG, setupHoldBars: 3 });
  ok(`S3 末根在轨外但持续仅 1 根 < 3 → H1（实际 ${h1.hold.level}）`, h1.hold.level === 'H1', h1.hold.detail?.slice(0, 36));

  const h2 = analyzeSetup(seq(arr3), { ...CFG, setupHoldBars: 3 });
  ok(`S3 连续 3 根在轨外 → H2（实际 ${h2.hold.level}）`, h2.hold.level === 'H2');
}

{
  // S4：中轨被反向击穿 → 计数清零
  const arr = [...PAD];
  arr.push(nextClose(arr, 'thrust'));
  arr.push(nextClose(arr, 'inside-above-mid'));
  arr.push(nextClose(arr, 'thrust'));
  arr.push(nextClose(arr, 'below-mid')); // 击穿中轨
  const r = analyzeSetup(seq(arr), CFG);
  ok('S4 收盘击穿中轨到另一侧 → 推进腿计数清零', r.longLegs === 0, `实际 ${r.longLegs}`);
}

/* ═══════════════════════ E. 门禁 ═══════════════════════ */

section('E. 门禁 gate —— 两套系统的唯一交汇点');

{
  const setupReady = { side: 1, blockers: [], legs: [1, 2, 3], longLegs: 3, hold: { level: 'H2', bars: 3, refPrice: w(50800) }, squeeze: { ok: true }, reason: '可开单' };
  const setupShadow = { ...setupReady, side: -1 };

  const longReg = { bias: BIAS.LONG_ONLY, biasLabel: '只许做多', allowLong: true, allowShort: false, chaseBlocked: false, reasons: [] };
  const shortReg = { bias: BIAS.SHORT_ONLY, biasLabel: '只许做空', allowLong: false, allowShort: true, chaseBlocked: false, reasons: [] };
  const neutralReg = { bias: BIAS.NEUTRAL, biasLabel: '方向未定（不开新仓）', allowLong: false, allowShort: false, chaseBlocked: false, reasons: ['逆周期'] };

  const g1 = gate({ regime: longReg, setup: setupReady, cfg: CFG, markWad: w(51000) });
  ok('方向放行 + 触发成立 → SIGNAL', g1.state === 'SIGNAL', `state=${g1.state} 止损锚=${g1.stopRef ? '有' : '无'}`);

  const g2 = gate({ regime: shortReg, setup: setupReady, cfg: CFG, markWad: w(51000) });
  ok('**宏观只许做空、触发却向上 → VETOED**（这就是熊市反弹被挡下来的地方）', g2.state === 'VETOED', g2.reason.slice(0, 56));

  const g3 = gate({ regime: longReg, setup: setupShadow, cfg: CFG, markWad: w(51000) });
  ok('宏观只许做多、触发向下 → VETOED', g3.state === 'VETOED');

  const g4 = gate({ regime: neutralReg, setup: setupReady, cfg: CFG, markWad: w(51000) });
  ok('宏观方向未定 → IDLE（不开新仓）', g4.state === 'IDLE', g4.reason.slice(0, 40));

  const g5 = gate({ regime: longReg, setup: { ...setupReady, blockers: ['独立推进腿只有 2 条，要求 3 条'] }, cfg: CFG, markWad: w(51000) });
  ok('方向放行但触发未完成 → ARMED（挂弦等确认，不是开单）', g5.state === 'ARMED');

  const g6 = gate({ regime: null, setup: setupReady, cfg: CFG, markWad: w(51000) });
  ok('没接方向层 → 一律不开仓（宁可漏做不可乱做）', g6.state === 'IDLE');

  // 追高否决 —— 注意这里 allowLong 仍然是 true，闸门必须自己判自己的条件
  const chaseReg = { ...longReg, chaseBlocked: true, structure: { extensionVs200d: 0.62 } };
  const g7 = gate({ regime: chaseReg, setup: setupReady, cfg: CFG, markWad: w(51000) });
  ok(
    '方向对、allowLong=true，但过热 → 仍被追高否决（闸门不依赖调用方提前置 false）',
    g7.state === 'VETOED' && g7.reason.includes('追高'),
    g7.reason.slice(0, 52)
  );
}

/* ═══════════ E2. 比特皇判据层（A4~A7）—— 「全部提取过来」的验收 ═══════════ */

section('E2. 比特皇判据层 —— A4 技术面 / A5 情绪拥挤度 / A6 量能 / A7 事件反应');

{
  /* 判据注册表的一致性：注册表是「已提取全部判据」的唯一凭据，
   * 所以它自己必须自洽 —— 否则「全部提取」这句话就没有可验证的依据。 */
  const crit = DIRECTION_CRITERIA;
  ok('判据注册表非空且每条都有出处与原话', crit.length >= 15 && crit.every((c) => c.id && c.quote && c.source && c.rule), `${crit.length} 条`);
  ok(
    '每条判据的 implemented 取值都合法（true / partial / false）',
    crit.every((c) => c.implemented === true || c.implemented === 'partial' || c.implemented === false)
  );
  const manualNotMarked = crit.filter((c) => c.implemented === false && !c.manual);
  ok('标为「未实现」的判据必须同时标 manual（说明走人工维护）', manualNotMarked.length === 0, manualNotMarked.map((c) => c.id).join(','));
  ok(
    '判据没有重复 id',
    new Set(crit.map((c) => c.id)).size === crit.length,
    `${new Set(crit.map((c) => c.id)).size}/${crit.length}`
  );
  ok(
    '每条判据都能归到已知的层（A1~A7 或明确标注为「—」/系统二）',
    crit.every((c) => /^(A[1-7]|—|系统二|全部|A1\+A2|A5\+A6)$/.test(c.layer)),
    [...new Set(crit.map((c) => c.layer))].join(' ')
  );
  ok(
    'criteriaByLayer 分组数与注册表条数一致（界面按层展示时不会漏条）',
    Object.values(criteriaByLayer()).reduce((a, b) => a + b.length, 0) === crit.length
  );

  /* ── A4 技术面补充 ── */
  const asOf = Date.parse('2026-09-21T00:00:00Z');

  // ① 价格站上 120 日均线
  const upDaily = geom(400, 20000, 120000, asOf, 86400000);
  const tUp = technicalsRead({ daily: upDaily, asOfMs: asOf, cfg: CFG });
  ok('A4 单调上涨 → 站上 120 日均线，投多', tUp.available && tUp.vote120 === 1 && tUp.verdict === 'ABOVE_MA120', `ma120=${tUp.ma120}`);

  const downDaily = geom(400, 120000, 20000, asOf, 86400000);
  const tDown = technicalsRead({ daily: downDaily, asOfMs: asOf, cfg: CFG });
  ok(
    'A4 大幅下跌 → 牛转熊判定优先于「跌破 120 日线」（verdict=BEAR_CONFIRMED，但 vote120 仍是 −1）',
    tDown.vote120 === -1 && tDown.verdict === 'BEAR_CONFIRMED' && tDown.vote === -1,
    `verdict=${tDown.verdict} vote120=${tDown.vote120}`
  );
  ok('A4 单调下跌本身就构成「牛转熊」（回撤深 + 久未创新高）', tDown.bearSignal === true, `回撤 ${(tDown.drawdownPct * 100).toFixed(1)}% / ${tDown.monthsSinceNewHigh} 个月未创新高`);

  // 温和下跌（回撤不足牛转熊门槛）→ 只报「跌破 120 日线」，不报牛转熊
  const mildDown = geom(400, 100000, 88000, asOf, 86400000); // −12%
  const tMild = technicalsRead({ daily: mildDown, asOfMs: asOf, cfg: CFG });
  ok(
    'A4 温和下跌（回撤 −12% < 门槛 −25%）→ 只判「跌破 120 日线」，不误报牛转熊',
    tMild.verdict === 'BELOW_MA120' && tMild.bearSignal === false,
    `verdict=${tMild.verdict} 回撤 ${(tMild.drawdownPct * 100).toFixed(1)}%`
  );

  // ② 最关键的门控：周期起点「久未创新高」是必然的，不能计入牛转熊
  const tGated = technicalsRead({
    daily: downDaily, asOfMs: asOf,
    cfg: { ...CFG, monthsSinceHalving: 3 }, // 减半后 3 个月 < bearGateMonths(15)
  });
  ok(
    'A4 关键门控：减半后 3 个月时「久未创新高」不计入牛转熊（否则每轮周期起点必然误报）',
    tGated.bearSignal === false && tGated.bearPending === true,
    `bearSignal=${tGated.bearSignal} 门控=${tGated.bearGateMonths} 个月`
  );
  const tGatedOn = technicalsRead({ daily: downDaily, asOfMs: asOf, cfg: { ...CFG, monthsSinceHalving: 20 } });
  ok('A4 同一份数据放到减半后 20 个月，牛转熊就成立了（门控只在早期生效）', tGatedOn.bearSignal === true);

  ok('A4 日线不足 120 根时明确弃权并给出原因', (() => {
    const t = technicalsRead({ daily: geom(50, 100, 200, asOf, 86400000), asOfMs: asOf, cfg: CFG });
    return t.available === false && t.notes.some((x) => x.includes('弃权'));
  })());

  /* ── A5 情绪拥挤度（资金费率） ── */
  // 构造：费率长期在 0 附近，最近一段深度为负 → 空头拥挤
  const mkFunding = (n, tail) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const t = asOf - (n - 1 - i) * 3600000;
      const rate = i >= n - tail ? -0.0004 : (i % 7) * 0.00002 - 0.00005;
      out.push({ t, rate });
    }
    return out;
  };

  // 价格路径构造器：按给定的逐根涨跌幅走。用于造出「下跌→筑底→小幅回升」这种
  // geom() 造不出来的形态（geom 是单调的，而「止跌」恰恰不是单调）。
  const pathFrom = (steps, start) => {
    const out = [];
    let p = start;
    for (const s of steps) {
      out.push(p);
      p = p * (1 + s);
    }
    out.push(p);
    return out;
  };
  const barsFrom = (closes) =>
    closes.map((c, i) => ({
      t: asOf - (closes.length - 1 - i) * 86400000,
      o: c, h: c * 1.005, l: c * 0.995, c, v: 100,
    }));

  // 「先跌、后止跌微升」—— 这才是比特皇说的「价格不再创造新低」
  const bottomedCloses = pathFrom([
    ...Array(80).fill(-0.006), // 前 80 根下跌
    ...Array(39).fill(0.0008), // 之后 39 根微升
  ], 90000);
  const bottomedDaily = barsFrom(bottomedCloses);

  const sSqueeze = sentimentRead({ fundingSeries: mkFunding(200, 5), daily: bottomedDaily, asOfMs: asOf, cfg: CFG });
  ok(
    'A5 资金费率极端低位 + 价格已止跌（不再创新低）→ 挤空反弹，投多',
    sSqueeze.vote === 1 && sSqueeze.signal === 'SQUEEZE_UP',
    `费率 ${sSqueeze.percentile} 分位 / priceHolding=${sSqueeze.priceHolding}`
  );

  // 同样的极端费率，但价格仍在创新低 → 是下跌初段，不构成反向机会
  const fallingDaily = geom(120, 90000, 50000, asOf, 86400000);
  const sFalling = sentimentRead({ fundingSeries: mkFunding(200, 5), daily: fallingDaily, asOfMs: asOf, cfg: CFG });
  ok(
    'A5 同样的极端费率、但价格仍在创新低 → 不投多（下跌初段追空才对，这是最容易被误用的一格）',
    sFalling.vote === 0 && sFalling.crowding === 'SHORT_CROWDED' && sFalling.priceHolding === 'STILL_FALLING',
    `crowding=${sFalling.crowding} priceHolding=${sFalling.priceHolding}`
  );

  // 正费率极端 + 价格滞涨 → 多头拥挤
  const mkFundingHot = (n) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push({ t: asOf - (n - 1 - i) * 3600000, rate: i >= n - 5 ? 0.0006 : 0.00002 });
    return out;
  };
  const sHot = sentimentRead({ fundingSeries: mkFundingHot(200), daily: bottomedDaily, asOfMs: asOf, cfg: CFG });
  ok('A5 资金费率极端高位 + 价格滞涨 → 多头清算风险，投空', sHot.vote === -1 && sHot.signal === 'SQUEEZE_DOWN', `费率 ${sHot.percentile} 分位`);

  ok('A5 资金费样本不足时明确弃权（不是静默记 0 分）', (() => {
    const s = sentimentRead({ fundingSeries: mkFunding(5, 1), daily: bottomedDaily, asOfMs: asOf, cfg: CFG });
    return s.available === false && s.vote === 0 && s.reason.includes('弃权');
  })());

  /* ── A6 量能形态 ── */
  // 构造带成交量的日线：价格路径 + 最后一根暴量
  const mkDaily = (n, from, to, volFn) => {
    const bars = geom(n, from, to, asOf, 86400000);
    return bars.map((b, i) => ({ ...b, v: volFn(i) }));
  };

  // ① 下跌段暴量 = 投降式放量
  const capDaily = mkDaily(150, 90000, 50000, (i) => (i === 149 ? 5000 : 100));
  const vCap = volumeRead({ daily: capDaily, asOfMs: asOf, cfg: CFG });
  ok('A6 下跌段 + 成交量暴增 → 投降式放量，投多', vCap.vote === 1 && vCap.pattern === 'CAPITULATION_VOLUME', `量 ${vCap.volPercentile} 分位 / 腿 ${vCap.leg}`);

  // ② 上涨段暴量 = 顶部派发
  const blowDaily = mkDaily(150, 40000, 100000, (i) => (i === 149 ? 5000 : 100));
  const vBlow = volumeRead({ daily: blowDaily, asOfMs: asOf, cfg: CFG });
  ok('A6 上涨段 + 成交量暴增 → 顶部派发，投空', vBlow.vote === -1 && vBlow.pattern === 'BLOWOFF_VOLUME', `量 ${vBlow.volPercentile} 分位 / 腿 ${vBlow.leg}`);

  // ③ 量价双降 + 跌速放缓 = 筑底形态（弱信号）
  // 三段式：快跌(-0.8%/根) → 中跌(-0.4%/根) → 慢跌(-0.2%/根)。
  // 必须造出「后段跌幅 < 前段跌幅」，否则 decelerating 不成立、筑底判据测不出来。
  const decelCloses = pathFrom(
    [...Array(100).fill(-0.008), ...Array(30).fill(-0.004), ...Array(20).fill(-0.002)],
    90000
  );
  const dryDaily = decelCloses.map((c, i) => ({
    t: asOf - (decelCloses.length - 1 - i) * 86400000,
    o: c, h: c * 1.004, l: c * 0.996, c,
    // 成交量也要分段：最后 20 根（avgNow 窗口）远低于前 20 根（avgPrev 窗口）
    v: i < decelCloses.length - 20 ? 1000 : 300,
  }));
  const vDry = volumeRead({ daily: dryDaily, asOfMs: asOf, cfg: CFG });
  ok(
    'A6 下跌 + 跌速放缓 + 均量递减 → 筑底形态，投多（弱信号，票权 0.5）',
    vDry.pattern === 'DRY_BOTTOM' && vDry.vote === 1 && vDry.strength === 0.5,
    `量比 ${vDry.volRatio} 跌速放缓=${vDry.decelerating} 腿=${vDry.leg} 强度=${vDry.strength}`
  );

  ok('A6 无成交量字段（全为 0）时明确弃权', (() => {
    const noVol = geom(200, 100, 200, asOf, 86400000).map((b) => ({ ...b, v: 0 }));
    const v = volumeRead({ daily: noVol, asOfMs: asOf, cfg: CFG });
    return v.available === false && v.reason.includes('弃权');
  })());
  ok('A6 日线不足时明确弃权', volumeRead({ daily: geom(20, 100, 200, asOf, 86400000), asOfMs: asOf, cfg: CFG }).available === false);

  /* ── A7 事件反应检验 ── */
  // 构造：一个「利空」事件后价格没跌 → 利空不跌 = 见底
  const mkReactionDaily = (n, before, after, shockIdx) => {
    const bars = [];
    for (let i = 0; i < n; i++) {
      const t = asOf - (n - 1 - i) * 86400000;
      const c = i < shockIdx ? before : after;
      bars.push({ t, o: c, h: c * 1.01, l: c * 0.99, c, v: 100 });
    }
    return bars;
  };

  // 稳步上涨的长序列：事件后的 14 天里价格涨了 ~2.5%
  const reactionDaily = geom(400, 30000, 60000, asOf, 86400000);
  const evDate = new Date(asOf - 60 * 86400000).toISOString().slice(0, 10);

  {
    // 同一条价格路径（事件后涨 2.5%）、只改事件的符号：
    //   利空 → 「该跌没跌」成立  → 见底证据
    //   利多 → 「该涨却涨了」不成立 → 不该投空
    // 这一对断言才是这条判据的要害：它测的是**市场对消息的反应**，
    // 不是消息本身。如果两个符号都投同一侧的票，那判据就是坏的。
    const evBear = { id: 'test-bearish', date: evDate, kind: 'shock', weight: -1, note: '测试利空' };
    const r1 = eventReactionRead({ events: [evBear], daily: reactionDaily, asOfMs: asOf, cfg: CFG });
    ok(
      'A7 利空事件后价格反而涨了 2.5%（该跌没跌）→ 判定「利空不跌」，投多',
      r1.vote === 1 && r1.pattern === 'BEARISH_NOT_FALLING' && r1.bearishNotFalling === 1,
      `${r1.items[0].date} 后 ${r1.items[0].reactionDays} 天 ${(r1.items[0].reactionPct * 100).toFixed(1)}%`
    );

    const evBull = { id: 'test-bullish', date: evDate, kind: 'liquidity', weight: +1, note: '测试利多' };
    const r2 = eventReactionRead({ events: [evBull], daily: reactionDaily, asOfMs: asOf, cfg: CFG });
    ok(
      'A7 同一路径换成利多事件 → **不**投空（利多之后确实涨了，不是利多不涨）',
      r2.vote === 0 && r2.bullishNotRising === 0 && r2.available === true,
      `反应 ${(r2.items[0].reactionPct * 100).toFixed(1)}% ≥ 容差 ${(CFG.reactionFlatPct * 100).toFixed(0)}%`
    );

    // 真正的「利多不涨」：事件后价格趴在原地
    const flatCloses = pathFrom([...Array(150).fill(0)], 60000); // 完全横盘
    const flatBars = barsFrom(flatCloses).map((b) => ({ ...b, t: asOf - (flatCloses.length - 1 - flatCloses.indexOf(b.c)) * 86400000 }));
    const flatDaily2 = flatBars.map((b, i) => ({ ...b, t: asOf - (flatBars.length - 1 - i) * 86400000 }));
    const r2b = eventReactionRead({ events: [evBull], daily: flatDaily2, asOfMs: asOf, cfg: CFG });
    ok(
      'A7 利多事件后价格原地不动（0% < 容差）→ 判定「利多不涨」，投空',
      r2b.vote === -1 && r2b.pattern === 'BULLISH_NOT_RISING',
      `反应 ${(r2b.items[0].reactionPct * 100).toFixed(1)}%`
    );

    // 事件太新 → 反应窗口没走完，不许下结论（前视偏差防护）
    const evNew = { id: 'test-new', date: new Date(asOf - 5 * 86400000).toISOString().slice(0, 10), kind: 'shock', weight: -1 };
    const r3 = eventReactionRead({ events: [evNew], daily: reactionDaily, asOfMs: asOf, cfg: CFG });
    ok(
      'A7 前视偏差防护：事件才过去 5 天 < 观察窗口 14 天 → 不参与判定',
      r3.available === false && r3.items.length === 0,
      `total=${r3.total}`
    );

    // 权重太小的不参与
    const evSmall = { id: 'test-small', date: evDate, weight: -0.05 };
    ok('A7 权重低于 reactionMinWeight 的事件不参与判定', eventReactionRead({ events: [evSmall], daily: reactionDaily, asOfMs: asOf, cfg: CFG }).available === false);

    ok('A7 无可用事件时明确弃权并说明原因', (() => {
      const r = eventReactionRead({ events: [], daily: reactionDaily, asOfMs: asOf, cfg: CFG });
      return r.available === false && r.vote === 0 && r.detail.includes('事件表');
    })());
  }

  /* ── 反转合成 ── */
  const clockLong = { intent: BIAS.LONG_ONLY, phase: 'EXPANSION', label: '主升扩张（减半后 6~15 个月）' };
  const clockNeutral = { intent: BIAS.NEUTRAL, phase: 'BLOWOFF', label: '加速冲顶／顶部构筑（减半后 15~24 个月）' };

  // 顶部：量能暴量（上涨段）+ 利多不涨 = 2 票 → topBrake
  const syn1 = synthesizeReversal({
    clock: clockLong,
    technicals: { bearSignal: false },
    sentiment: { available: true, vote: 0, detail: '无拥挤' },
    volume: { available: true, vote: -1, pattern: 'BLOWOFF_VOLUME', volPercentile: 97, strength: 1 },
    reaction: { available: true, vote: -1, pattern: 'BULLISH_NOT_RISING', bullishNotRising: 2 },
    cfg: CFG,
  });
  ok('合成 顶部刹车：2 项见顶证据 + 周期许可做多 → topBrake 生效（不反手，但停止加多）', syn1.topSignal && syn1.topBrake, `topVotes=${syn1.topVotes}/${syn1.minVotes}`);

  ok('合成 顶部刹车必须进 gate 才有效 —— 门禁独立检查 regime.topBrake', (() => {
    const e2Reg = { bias: BIAS.LONG_ONLY, biasLabel: '只许做多', allowLong: true, allowShort: false, chaseBlocked: false, topBrake: true, reversal: syn1, reasons: [] };
    const e2Setup = { side: 1, blockers: [], legs: [1, 2, 3], longLegs: 3, hold: { level: 'H2', bars: 3, refPrice: w(50800) }, squeeze: { ok: true }, reason: '可开单' };
    const g = gate({ regime: e2Reg, setup: e2Setup, cfg: CFG, markWad: w(51000) });
    return g.state === 'VETOED' && g.reason.includes('顶部刹车');
  })());

  // 底部：投降式放量 + 利空不跌 = 2 票 → bottomConfirm，但不翻转 NEUTRAL
  const syn2 = synthesizeReversal({
    clock: clockLong,
    technicals: { bearSignal: false },
    sentiment: { available: true, vote: 1, signal: 'SQUEEZE_UP', percentile: 3 },
    volume: { available: true, vote: 1, pattern: 'CAPITULATION_VOLUME', volPercentile: 98, strength: 1 },
    reaction: { available: true, vote: 1, pattern: 'BEARISH_NOT_FALLING', bearishNotFalling: 2 },
    cfg: CFG,
  });
  ok('合成 底部确认：3 项见底证据 + 周期许可做多 → bottomConfirm（抬高置信度）', syn2.bottomSignal && syn2.bottomConfirm, `bottomVotes=${syn2.bottomVotes}`);

  const syn3 = synthesizeReversal({
    clock: clockNeutral,
    technicals: { bearSignal: false },
    sentiment: { available: true, vote: 1, signal: 'SQUEEZE_UP', percentile: 3 },
    volume: { available: true, vote: 1, pattern: 'CAPITULATION_VOLUME', volPercentile: 98, strength: 1 },
    reaction: { available: true, vote: 1, pattern: 'BEARISH_NOT_FALLING', bearishNotFalling: 2 },
    cfg: CFG,
  });
  ok(
    '合成 关键约束：见底证据充分，但周期不批准 → **不翻转成做多**（比特皇原话有「减半大前提」这半句）',
    syn3.bottomSignal && syn3.bottomConfirm === false && syn3.notes.some((x) => x.includes('不据此翻转')),
    `bias 不受影响`
  );

  ok('合成 弃权必须显形：三层数据全缺时 evidence 里三条都是 available=false', (() => {
    const s = synthesizeReversal({
      clock: clockLong, technicals: { bearSignal: false },
      sentiment: { available: false, reason: '无资金费', vote: 0 },
      volume: { available: false, reason: '无成交量', vote: 0 },
      reaction: { available: false, reason: '无事件', vote: 0 },
      cfg: CFG,
    });
    return s.evidence.filter((x) => !x.available).length === 3 && s.bottomVotes === 0 && s.topVotes === 0;
  })());

  // 端到端：三项判据全弃权时 regimeAt 仍能跑（弃权路径不能抛错，也不能静默变成"通过"）
  ok('端到端 判据层部分弃权时 regimeAt 仍可求值且不抛错，弃权项如实标出', (() => {
    // 带成交量的日线（让 A6 可用），但不给资金费、不给事件（让 A5 / A7 弃权）
    const d = geom(300, 30000, 60000, asOf, 86400000).map((b, i) => ({ ...b, v: 100 + (i % 5) }));
    const wk = geom(210, 20000, 60000, asOf, 7 * 86400000);
    const mo = geom(40, 2000, 60000, asOf, 30.44 * 86400000);
    const reg = regimeAt({ daily: d, weekly: wk, monthly: mo, asOfMs: asOf, cfg: CFG });
    return (
      reg.volume.available === true &&
      reg.sentiment.available === false &&
      reg.reaction.available === false &&
      reg.technicals.available === true &&
      reg.reversal.evidence.filter((x) => !x.available).length === 2
    );
  })());
}

/* ═══════════════════════ F. 真实数据回测 ═══════════════════════ */

const doBacktest = process.argv.includes('--backtest');

if (!doBacktest) {
  console.log('\n（加 --backtest 可追加真实 BTC 历史的逐 bar 回算）');
}

if (doBacktest) {
  section('F. 真实 BTC 历史回测 —— 旧口径会在熊市反弹里宣布多少次「方向=多」');

  const HL = 'https://api.hyperliquid.xyz/info';
  const post = async (body) => {
    const r = await fetch(HL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 120)}`);
    return r.json();
  };
  const grab = async (iv, days) => {
    const now = Date.now();
    return barsOf(await post({ type: 'candleSnapshot', req: { coin: 'BTC', interval: iv, startTime: now - days * 86400000, endTime: now } }));
  };

  const [daily, weekly, monthly, h4raw] = await Promise.all([grab('1d', 2300), grab('1w', 2900), grab('1M', 2900), grab('4h', 730)]);
  console.log(`  数据：日线 ${daily.length} / 周线 ${weekly.length} / 月线 ${monthly.length} / 4H ${h4raw.length} 根`);

  let events = [];
  try {
    events = JSON.parse(readFileSync(new URL('../config/macro-events.json', import.meta.url), 'utf8')).events || [];
  } catch {
    console.log('  （事件表读取失败，本轮回测按无事件处理）');
  }

  const h4 = h4raw.map((k) => w(k.c));
  const histLen = 200; // 预热：前 200 根不评估
  const regimeCache = new Map();

  /**
   * 先做一遍采样，把每根 bar 的**各项闸门通过情况**都记下来。
   *
   * 为什么要这样：一次 analyzeSetup 已经算出了「腿数 / 站稳等级 / 收口分位」，
   * 而 requiredLegs 与 squeezeMaxPercentile 只是拿去和这些值比较。
   * 所以一遍采样就能推出所有参数组合的结果 —— 8 种组合不需要跑 8 遍回测。
   */
  const samples = [];

  for (let i = histLen; i < h4.length; i++) {
    const closes = h4.slice(0, i + 1);
    const asOf = h4raw[i].t;

    // regime 只在日界变化，按天缓存（回测里 4H 一天 6 根，能省 5/6 的算力）
    const dayKey = Math.floor(asOf / 86400000);
    let reg = regimeCache.get(dayKey);
    if (!reg) {
      reg = regimeAt({ daily, weekly, monthly, events, asOfMs: asOf, cfg: { shockWindowDays: 30 } });
      regimeCache.set(dayKey, reg);
    }

    const cur = analyzeSetup(closes, CFG);
    const g = gate({ regime: reg, setup: cur, cfg: CFG, markWad: closes[closes.length - 1] });
    const nowDir = analyzeTrend(closes, CFG).direction;
    const prevDir = i > histLen ? analyzeTrend(h4.slice(0, i), CFG).direction : 0;

    const side = cur.side;
    // 拦住它的到底是哪一道闸 —— 必须分开数，因为三种性质完全不同：
    //   方向未定：宏观不表态，不是逆势
    //   逆势否决：形态方向与宏观方向相反
    //   追高否决：方向一致，但位置过热
    let blockKind = null;
    if (g.state !== 'SIGNAL' && g.state !== 'ARMED') {
      if (reg.bias === BIAS.NEUTRAL) blockKind = '方向未定';
      else if (side === 1 && reg.bias === 'SHORT_ONLY') blockKind = '逆势否决';
      else if (side === -1 && reg.bias === 'LONG_ONLY') blockKind = '逆势否决';
      else if (reg.chaseBlocked) blockKind = '追高否决';
    }

    samples.push({
      t: asOf,
      price: Number(h4raw[i].c),
      side,
      legs: side === 1 ? cur.longLegs : side === -1 ? cur.shortLegs : 0,
      holdLevel: cur.hold.level,
      sqPct: cur.squeeze.percentile,
      bias: reg.bias,
      allowed: g.state === 'SIGNAL' || g.state === 'ARMED',
      extVs200d: reg.structure.extensionVs200d,
      blockKind,
      macroOpposite: (side === 1 && reg.bias === 'SHORT_ONLY') || (side === -1 && reg.bias === 'LONG_ONLY'),
      oldLongNow: nowDir === 1,
      oldLongNew: nowDir === 1 && prevDir !== 1,
    });
  }

  const biasHist = {};
  for (const s of samples) biasHist[s.bias] = (biasHist[s.bias] || 0) + 1;

  const oldLongSignals = samples.filter((s) => s.oldLongNew).length;
  const oldLongBars = samples.filter((s) => s.oldLongNow).length;
  const oldSignalList = samples.filter((s) => s.oldLongNew).slice(0, 12);

  // ── 闸门漏斗：看形态到底死在哪一道闸 ──
  const funnel = {
    bars: samples.length,
    有触发侧: samples.filter((s) => s.side !== 0).length,
    [`腿数≥${CFG.trendRequiredBreaks}`]: samples.filter((s) => s.side !== 0 && s.legs >= CFG.trendRequiredBreaks).length,
    '且站稳 H2': samples.filter((s) => s.side !== 0 && s.legs >= CFG.trendRequiredBreaks && s.holdLevel === 'H2').length,
    [`且收口≤${CFG.squeezeMaxPercentile}分位`]: samples.filter(
      (s) => s.side !== 0 && s.legs >= CFG.trendRequiredBreaks && s.holdLevel === 'H2' && s.sqPct !== null && s.sqPct <= CFG.squeezeMaxPercentile
    ).length,
  };
  const fullSetups = samples.filter(
    (s) => s.side !== 0 && s.legs >= CFG.trendRequiredBreaks && s.holdLevel === 'H2' && s.sqPct !== null && s.sqPct <= CFG.squeezeMaxPercentile
  );
  const allowedList = fullSetups.filter((s) => s.allowed);
  // 把"被挡"按**真实原因**拆开 —— 三种性质完全不同，混在一起数会得出错误结论
  const blockedNeutral = fullSetups.filter((s) => s.blockKind === '方向未定');
  const blockedOpposite = fullSetups.filter((s) => s.blockKind === '逆势否决');
  const blockedChase = fullSetups.filter((s) => s.blockKind === '追高否决');
  const vetoedWeak = samples.filter((s) => s.macroOpposite).length;

  // ── 代价曲线：放松参数会多出多少机会（形态数 / 其中宏观放行数）──
  const sweep = [];
  for (const reqLegs of [2, 3, 4]) {
    for (const sqPct of [25, 50, 75, 100]) {
      const hit = samples.filter((s) => s.side !== 0 && s.legs >= reqLegs && s.holdLevel === 'H2' && s.sqPct !== null && s.sqPct <= sqPct);
      sweep.push({ reqLegs, sqPct, setups: hit.length, allowed: hit.filter((s) => s.allowed).length });
    }
  }
  // "最松" = 腿数门槛最低 + 收口门槛最宽
  const loosest = sweep.find((s) => s.reqLegs === 2 && s.sqPct === 100);

  const d10 = (t) => new Date(t).toISOString().slice(0, 10);
  console.log('');
  console.log(`  评估区间：${d10(samples[0].t)} ~ ${d10(samples[samples.length - 1].t)}，共 ${samples.length} 根 4H`);
  console.log(`  宏观方向分布：${Object.entries(biasHist).map(([k, v]) => `${k} ${((v / samples.length) * 100).toFixed(0)}%`).join('  ')}`);
  console.log('');
  console.log('  ── 旧口径（三次突破即方向）──');
  console.log(`    宣布「方向=做多」新信号 ${oldLongSignals} 次（占 ${((oldLongBars / samples.length) * 100).toFixed(0)}% 的 bar 一直是"方向=多"）`);
  console.log('');
  console.log('  ── 闸门漏斗（每一行是「再满足一个条件」之后还剩多少根 bar）──');
  for (const [k, v] of Object.entries(funnel)) {
    if (k === 'bars') continue;
    console.log(`    ${k.padEnd(18)} ${String(v).padStart(5)} 根`);
  }
  console.log(`    ${'其中宏观放行'.padEnd(16)} ${String(allowedList.length).padStart(5)} 根  ← 这就是 SIGNAL / ARMED`);
  console.log(`    ${'其中方向未定'.padEnd(16)} ${String(blockedNeutral.length).padStart(5)} 根  ← 宏观不表态，不开新仓（不是逆势）`);
  console.log(`    ${'其中逆势否决'.padEnd(16)} ${String(blockedOpposite.length).padStart(5)} 根  ← 形态方向与宏观方向相反，真正的"宏观压住微观"`);
  console.log(`    ${'其中追高否决'.padEnd(16)} ${String(blockedChase.length).padStart(5)} 根  ← 方向一致，但价格过热（高于 200 日均线过多）`);
  console.log(`    （另有 ${vetoedWeak} 根只是"触发侧与宏观相反"，形态并不完整 —— 不计入否决统计）`);
  console.log('');
  console.log('  ── 代价曲线：形态数（其中宏观放行数）──');
  console.log('    要求腿数 \\ 收口分位      25         50         75        100');
  for (const reqLegs of [2, 3, 4]) {
    const cells = [25, 50, 75, 100].map((q) => {
      const s = sweep.find((x) => x.reqLegs === reqLegs && x.sqPct === q);
      return `${s.setups}(${s.allowed})`.padStart(10);
    });
    console.log(`    ${String(reqLegs).padEnd(20)}${cells.join('')}`);
  }
  console.log(`    当前配置在最严的一格：腿数≥${CFG.trendRequiredBreaks}、收口≤${CFG.squeezeMaxPercentile} 分位`);
  console.log(`    即便放到最松（腿数≥2、收口≤100 分位）也只有 ${loosest.setups} 个形态、其中 ${loosest.allowed} 个被宏观放行`);
  console.log('');
  const showBlocked = blockedOpposite.concat(blockedChase);
  if (showBlocked.length) {
    console.log(`  ${showBlocked.length} 个「形态完整但被宏观拦下」的形态出现在：`);
    for (const s of showBlocked.slice(0, 12)) {
      console.log(
        `    ${d10(s.t)}  价 ${s.price.toFixed(0)}  触发侧 ${s.side === 1 ? '向上' : '向下'}  腿数 ${s.legs}  宏观 ${s.bias}` +
          `  高于200日线 ${Number.isFinite(s.extVs200d) ? (s.extVs200d * 100).toFixed(0) + '%' : '—'}  → ${s.blockKind}`
      );
    }
  }
  console.log('');
  console.log('  旧口径宣布过的部分做多信号（前 12 个）：');
  for (const s of oldSignalList) {
    console.log(`    ${d10(s.t)}  价 ${s.price.toFixed(0)}  宏观 ${s.bias}${s.bias === BIAS.SHORT_ONLY ? '  ← 宏观否决' : ''}`);
  }

  ok(
    '回测中确实存在「旧口径宣布做多、而宏观要求做空」的逆势信号',
    samples.filter((s) => s.oldLongNew && s.bias === BIAS.SHORT_ONLY).length > 0,
    `${samples.filter((s) => s.oldLongNew && s.bias === BIAS.SHORT_ONLY).length} 次 —— 新架构通过 gate 的 VETOED 把它们全部挡下`
  );
  ok(
    '闸门漏斗逐级收窄（每加一道条件，剩下的 bar 不会变多）',
    Object.entries(funnel)
      .filter(([k]) => k !== 'bars')
      .map(([, v]) => v)
      .every((v, i, a) => i === 0 || v <= a[i - 1])
  );
  ok(
    '新架构的可开单次数少于旧口径的方向宣告次数（触发门槛真的在起作用）',
    allowedList.length < oldLongSignals || oldLongSignals === 0,
    `新 ${allowedList.length} 次 vs 旧 ${oldLongSignals} 次`
  );
  ok('宏观方向在回测区间内发生过切换（不是一直单边，说明它真的在跟随周期）', Object.values(biasHist).filter((v) => v > 0).length >= 2, Object.entries(biasHist).map(([k, v]) => `${k}:${v}`).join(' '));
  ok(
    '代价曲线覆盖 3×4 种参数组合，可用于选参数',
    sweep.length === 12,
    `最松（腿数≥2、收口≤100 分位）给出 ${loosest.setups} 个形态；当前配置 ${funnel[`腿数≥${CFG.trendRequiredBreaks}`]} 根有腿数、最后只剩 ${fullSetups.length} 个完整形态`
  );
  ok(
    '「完整形态被拦」的四档被如实统计（放行 / 方向未定 / 逆势否决 / 追高否决，互不重叠且全覆盖）',
    fullSetups.length === allowedList.length + blockedNeutral.length + blockedOpposite.length + blockedChase.length,
    `放行 ${allowedList.length} + 方向未定 ${blockedNeutral.length} + 逆势否决 ${blockedOpposite.length} + 追高否决 ${blockedChase.length} = ${fullSetups.length}`
  );
}

/* ═══════════ E3. 三阶段编排 —— 基本面 → 技术面 → 持仓管理 ═══════════
 *
 * 需求是「系统分三个部分，完全按比特皇的思路」。这句话的验收标准**不是**
 * "有三个模块"，而是三条更硬的东西：
 *   ① 每一段有唯一的问题、唯一的输出；
 *   ② 段与段之间是**单向依赖** —— 阶段一不放行，阶段二不得产出可执行计划；
 *   ③ 整套流程给出唯一的关键结论：现在卡在哪一段。
 * 第 ② 条最容易写错、代价也最高（方向没定却给出漂亮的价格表，
 * 人眼会先看到价格），所以它单独占一节。
 */

section('E3. 三阶段编排 —— 阶段一不放行时阶段二不得产出可执行计划');

{
  /* ── E3.1 判据分段：每条判据必须能归到唯一的阶段，且标清来源 ── */

  const crit = DIRECTION_CRITERIA;
  const badStage = crit.filter((c) => ![0, 1, 2, 3].includes(c.stage)).map((c) => c.id);
  ok('每条判据都有合法 stage（0 全局约束 / 1 基本面 / 2 技术面 / 3 持仓管理）', badStage.length === 0, badStage.join(',') || `4 段全覆盖`);

  const badOrigin = crit.filter((c) => c.origin !== 'bithuang' && c.origin !== 'system').map((c) => c.id);
  ok('每条判据都标了 origin（bithuang = 出自原话 / system = 本系统补的）', badOrigin.length === 0, badOrigin.join(','));

  const sysOnly = crit.filter((c) => c.origin === 'system');
  ok(
    '「系统自补」的判据被单独标出而不是混进比特皇原话里',
    sysOnly.every((c) => c.rule && c.source),
    `共 ${sysOnly.length} 条：${sysOnly.map((c) => c.id).join(',')}`
  );

  const byStage = criteriaByStage();
  const sumStage = Object.values(byStage).reduce((a, b) => a + b.length, 0);
  ok('criteriaByStage 分组计数与注册表条数一致（分段展示不会漏条）', sumStage === crit.length, `${sumStage}/${crit.length}`);
  ok(
    '分段键与 STAGES 的键一一对应（界面按 STAGES 取名字时不会取空）',
    Object.keys(byStage).every((k) => STAGES[k]) && Object.keys(STAGES).length === Object.keys(byStage).length,
    `STAGES=${Object.keys(STAGES).join(',')} 分组=${Object.keys(byStage).join(',')}`
  );
  ok(
    '阶段一（基本面）条数足够 —— 否则「按比特皇基本面给方向」名不副实',
    byStage[1].length >= 15,
    `${byStage[1].length} 条`
  );
  ok(
    '阶段二 / 阶段三各有实质内容（不是空壳）',
    byStage[2].length >= 5 && byStage[3].length >= 5,
    `技术面 ${byStage[2].length} 条 · 持仓管理 ${byStage[3].length} 条`
  );
  ok(
    'PIPELINE_STAGES 恰好三段，且每段都带问题 / 原话 / 出处（界面直接展示，不另抄一份）',
    PIPELINE_STAGES.length === 3 &&
      PIPELINE_STAGES.every((s) => s.index && s.key && s.name && s.question && s.quote && s.source),
    PIPELINE_STAGES.map((s) => s.key).join(' → ')
  );

  /* ── E3.1b 人工判据 ↔ 事件表的 kind 词汇表必须对得上 ──
   *
   * 背景：界面结论卡上的「N 项待人工确认」= implemented:false 的 stage=1 判据。
   * 这 6 条没有自动数据源，唯一的录入位置是 config/macro-events.json，靠 kind 归类。
   * 如果判据 rule 里写的 kind 没被 config 的 kindVocabulary 收录，维护者打开配置文件
   * 会发现词汇表根本覆盖不了他要填的那一条 —— 本断言就是防这个漂移。
   *
   * 注意 kind 是自由字符串（引擎只对 'shock' 分支），所以**没有**类型系统能挡住拼错。
   * 「配置里写了但没人读」和「读了但配置里没写」两种错都要在这里显形。
   */
  {
    const macroRaw = JSON.parse(readFileSync(new URL('../config/macro-events.json', import.meta.url), 'utf8'));
    const vocab = Object.keys(macroRaw.kindVocabulary || {});
    const usedKinds = [...new Set((macroRaw.events || []).map((e) => e.kind))];
    const referenced = [
      ...new Set(
        crit.flatMap((c) => [...String(c.rule || '').matchAll(/kind=([a-z][a-z0-9-]*)/g)].map((m) => m[1]))
      ),
    ];

    ok(
      'config 声明了 kindVocabulary（人工录入的取值表，维护者据此填 kind）',
      vocab.length > 0,
      vocab.join(' | ')
    );
    ok(
      '判据 rule 里引用的每个 kind=xxx 都在 kindVocabulary 里',
      referenced.every((k) => vocab.includes(k)),
      `引用 ${referenced.length} 个：${referenced.filter((k) => !vocab.includes(k)).join(',') || '全部命中'}`
    );
    ok(
      'events 里实际用到的每个 kind 都在 kindVocabulary 里（没有野生取值）',
      usedKinds.every((k) => vocab.includes(k)),
      `在用 ${usedKinds.length} 个：${usedKinds.filter((k) => !vocab.includes(k)).join(',') || '全部命中'}`
    );

    const manual = crit.filter((c) => c.implemented === false);
    /*
     * 2026-09 起这 6 条不再走人工维护 —— 它们全部接上了免费无密钥数据源
     * （src/macro-sources.js）。所以这里断言的是「**没有**人工维护条目」，
     * 而不是原来的「每条人工条目都要指明 kind」。
     *
     * 为什么不是把旧断言删掉：旧断言的意图是「不许存在无法自动求值的判据
     * 而不告诉维护者怎么补」。意图仍然成立，只是触发条件变了 —— 现在应当
     * **一条都不存在**；一旦哪天又出现，说明有数据源退回了手工维护，那件事
     * 必须被看见（所以下面那条 dataSource 断言就是新的抓手）。
     */
    ok(
      '阶段一没有人工维护判据（原来的 6 条已全部接入 src/macro-sources.js）',
      manual.length === 0,
      manual.length ? `仍有人工条目：${manual.map((c) => c.id).join(',')}` : '0 条，与 macro-sources 的 6 个源一一对应'
    );
    const macroCrit = crit.filter((c) => c.dataSource === 'src/macro-sources.js');
    ok(
      'M1~M6 六条判据都标注了数据源模块（界面据此显示"自动采集"而不是"人工维护"）',
      macroCrit.length === 6,
      `${macroCrit.length} 条：${macroCrit.map((c) => c.id).join(',')}`
    );
    ok(
      'M1~M6 的 rule 文本里不再声称"没有免费无密钥接口"（那句话已被实测证伪）',
      macroCrit.every((c) => !/没有免费|无免费无密钥|需付费数据源|需人工分类/.test(String(c.rule || ''))),
      macroCrit.filter((c) => /没有免费|无免费无密钥|需付费数据源|需人工分类/.test(String(c.rule || ''))).map((c) => c.id).join(',') || '全部已改写'
    );
    ok(
      '这些 kind 全部落在 kindVocabulary 内（否则维护者在配置文件里找不到入手点）',
      manual
        .map((c) => [...String(c.rule || '').matchAll(/kind=([a-z][a-z0-9-]*)/g)].map((m) => m[1])[0])
        .every((k) => vocab.includes(k)),
      manual
        .map((c) => `${c.id}→${(String(c.rule || '').match(/kind=([a-z][a-z0-9-]*)/) || [])[1] || '缺'}`)
        .join(' · ')
    );
    ok(
      '人工判据里没有一条是 shock —— shock 是一票否决通道，人工条目不该悄悄拿到否决权',
      manual.every((c) => !/kind=shock/.test(String(c.rule || ''))),
      '全部为普通修正项'
    );
  }

  /* ── E3.1c 配置里写了的字段必须真的生效 ──
   * scoreEvents 读 cfg.shockCooldownDays，但它一开始既不在 defaultConfig、
   * 也没被 server.js 透传 —— 配置里写了 7，实际生效的是库里的 ?? 7。数值巧合相等，
   * 所以任何测试都发现不了；一旦用户把配置改成 3，界面不会有任何变化。
   */
  {
    ok(
      'defaultConfig 声明了 shockCooldownDays（不是靠库里的 ?? 兜底）',
      Number.isFinite(defaultConfig().shockCooldownDays),
      `= ${defaultConfig().shockCooldownDays}`
    );

    const shockEvent = [{ id: 'x', date: '2024-01-01', kind: 'shock', weight: -2, halfLifeDays: 3650 }];
    const cd7 = scoreEvents(shockEvent, Date.parse('2024-01-10T00:00:00Z'), { shockWindowDays: 30, shockCooldownDays: 7 });
    const cd3 = scoreEvents(shockEvent, Date.parse('2024-01-10T00:00:00Z'), { shockWindowDays: 30, shockCooldownDays: 3 });
    ok(
      'scoreEvents 确实按 cfg.shockCooldownDays 算 cooldownUntil（传 3 和传 7 结果不同）',
      cd7.shock.active &&
        cd3.shock.active &&
        cd7.shock.cooldownUntil !== cd3.shock.cooldownUntil,
      `7天→${cd7.shock.cooldownUntil} / 3天→${cd3.shock.cooldownUntil}`
    );

    const srv = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
    const ri = readFileSync(new URL('../src/regime-inputs.js', import.meta.url), 'utf8');

    /* 透传点 2026-09 从 server.js 搬到了 src/regime-inputs.js（与每日采集任务共用）。
     * 所以这里改成两层：
     *   ① 行为级 —— 真正关心的是"事件表的值有没有覆盖到 cfg 上"，不关心它写在哪个文件
     *   ② 源码级 —— 守住那条 `?? cfg.…` 兜底链还在，防的是"有人重构成
     *      `events.shockCooldownDays` 直接覆盖、把默认值丢掉"这类静默断线
     */
    const cfgWithEv = regimeConfig({ ...defaultConfig(), shockCooldownDays: 7 }, { shockCooldownDays: 3 });
    ok(
      '事件表的 shockCooldownDays 覆盖策略配置（行为级：传 3 就得到 3）',
      cfgWithEv.shockCooldownDays === 3,
      `预期 3，实际 ${cfgWithEv.shockCooldownDays}`
    );
    const cfgNoEv = regimeConfig({ ...defaultConfig(), shockCooldownDays: 7 }, {});
    ok(
      '事件表没写时回落到策略配置（不丢默认值）',
      cfgNoEv.shockCooldownDays === 7,
      `预期 7，实际 ${cfgNoEv.shockCooldownDays}`
    );
    ok(
      'src/regime-inputs.js 保留了 `events.… ?? cfg.…` 兜底链（源码级防断线）',
      /shockCooldownDays:\s*events\.shockCooldownDays\s*\?\?\s*cfg\.shockCooldownDays/.test(ri),
      'events.shockCooldownDays ?? cfg.shockCooldownDays'
    );
    /* server.js 不许再自己调 computeRegime —— 否则方向层又变成两份实现，
     * 而 daily 任务算出来的方向会和看板不一致。 */
    ok(
      'server.js 走共享装配（不再自己调 computeRegime，防两份实现漂移）',
      !/\bcomputeRegime\s*\(/.test(srv) && /\bbuildRegime\s*\(/.test(srv),
      'buildRegime(...) 已接管'
    );
  }

  /* ── 夹具：手搓 regime / levels，专测「编排契约」而不是「读数准不准」── */

  const fakeRegime = (bias, extra = {}) => ({
    bias,
    biasLabel: bias === 'LONG_ONLY' ? '只许做多' : bias === 'SHORT_ONLY' ? '只许做空' : '方向未定',
    allowLong: bias === 'LONG_ONLY',
    allowShort: bias === 'SHORT_ONLY',
    confidence: 'HIGH',
    reasons: ['合成读数：周期相位要求只许做空，结构已转多头 → 输出 NEUTRAL'],
    // 一条弃权证据 + 一条有效证据：弃权必须能传导到阶段一的 abstentions
    reversal: {
      evidence: [
        { layer: 'A5 情绪拥挤度', available: true, dir: 1, text: '合成' },
        { layer: 'A6 量能形态', available: false, dir: 0, text: '日线不足 20 根' },
      ],
      topVotes: 0, bottomVotes: 0, minVotes: 2,
      topBrake: false, bottomConfirm: false,
    },
    structure: { extensionVs200d: 0.1, chaseMaxExtensionPct: 0.4 },
    ...extra,
  });

  const mkLevels = (over = {}) => ({
    hasPosition: false,
    isLong: true,
    mark: w(100),
    gate: { state: 'IDLE', reason: '合成门禁', blockers: [] },
    trigger: {
      side: 1, hold: { level: 'H1', bars: 1 }, squeeze: { ok: false }, pullback: { available: false, reason: '无回踩读数' },
      legs: [1], longLegs: 1, shortLegs: 0, required: 3, entryMode: null, reason: '合成触发',
    },
    entryPlan: {
      executable: true,
      tranches: [
        { index: 1, name: '头仓（突破批次）', side: 'BREAKOUT', ratioBps: 3000, qty: w(1), triggerPrice: w(100), triggerKind: 'MARKET', stopPrice: w(95), stopAnchor: '突破参考位外侧', active: true },
        { index: 2, name: '主仓（回调批次）', side: 'PULLBACK', ratioBps: 7000, qty: w(2), triggerPrice: w(98), triggerKind: 'LIMIT', stopPrice: w(90), stopAnchor: '中轨外侧', active: true },
      ],
      trancheNote: '合成两笔计划',
    },
    stop: {}, roll: {}, takeProfit: {},
    exitSignals: { urgency: 'NONE', summary: '合成', bandBroken: {}, failedBounce: {}, newsExit: {} },
    risk: {},
    ...over,
  });

  /* ── E3.2 阶段一：定方向。三个状态必须能区分「没数据」「没方向」── */

  const s1Absent = stage1Fundamental({ regime: null, cfg: CFG });
  ok('阶段一 regime 缺失 → ABSENT（整套流程停摆），而不是 NEUTRAL（方向未定）', s1Absent.status === 'ABSENT' && s1Absent.pass === false);
  ok(
    '阶段一 ABSENT 时仍带 manualPending 数组（曾经漏了这个字段，让编排层读 length 时抛错）',
    // 只断言「是数组」，不断言「非空」—— 接入 macro-sources 后它正常就是空的，
    // 当初那个 bug 是字段整个缺失（undefined），不是空数组。
    Array.isArray(s1Absent.manualPending),
    `${s1Absent.manualPending?.length} 条待人工`
  );
  ok(
    '阶段一 ABSENT 时也带 macroReadings / macroSummary（否则界面上「宏观 M1~M6」角标会凭空消失）',
    Array.isArray(s1Absent.macroReadings) && typeof s1Absent.macroSummary === 'object',
    `readings ${s1Absent.macroReadings?.length} / summary ${JSON.stringify(s1Absent.macroSummary)}`
  );

  const s1Neutral = stage1Fundamental({ regime: fakeRegime('NEUTRAL'), cfg: CFG });
  ok('阶段一 NEUTRAL → pass=false，且两个方向都不批准（不是"随便选一个"）', s1Neutral.status === 'NEUTRAL' && !s1Neutral.allows.long && !s1Neutral.allows.short);
  ok('阶段一的弃权判据会传导到 abstentions，不静默当"没异议"', (s1Neutral.abstentions || []).includes('A6 量能形态'), (s1Neutral.abstentions || []).join(','));

  const s1Long = stage1Fundamental({ regime: fakeRegime('LONG_ONLY'), cfg: CFG });
  ok('阶段一 LONG_ONLY → DECIDED、pass=true、只批多头', s1Long.status === 'DECIDED' && s1Long.pass === true && s1Long.allows.long === true && s1Long.allows.short === false);
  ok(
    '阶段一输出里带上「这一段有多少条判据、其中几条要人工」',
    // manualCount 现在正常是 0，所以断言的是「字段存在且自洽」，不是「必须大于 0」
    s1Long.criteriaTotal >= 15 && s1Long.manualCount === (s1Long.manualPending || []).length,
    `${s1Long.criteriaTotal} 条 / 人工 ${s1Long.manualCount} 条`
  );

  /* ── E3.2b 宏观读数接入（M1~M6）─────────────────────────────────────
   *
   * 这是 2026-09 新增的一整条数据通路，四个环节各断言一次：
   *   regime.macro → synthesizeReversal 计票 → stage1 汇总 → 界面能读到
   * 只测其中一环的话，"接了但没投票"这种半成品会通过。
   */

  const mkMacro = (vote, available = true) => ({
    id: 'media-extreme', layer: 'M1', name: '媒体情绪', available, vote,
    reason: '测试用读数',
  });

  const mrTop = synthesizeReversal({ clock: { intent: 'SHORT_ONLY', label: '出清下跌', phase: 'DECLINE' }, macro: [mkMacro(-1)], cfg: CFG });
  const mrBottom = synthesizeReversal({ clock: { intent: 'SHORT_ONLY', label: '出清下跌', phase: 'DECLINE' }, macro: [mkMacro(1)], cfg: CFG });
  const mrZero = synthesizeReversal({ clock: { intent: 'SHORT_ONLY', label: '出清下跌', phase: 'DECLINE' }, macro: [], cfg: CFG });
  ok(
    '宏观读数 vote=-1 会计入见顶票（topVotes 比无宏观时多 1）',
    mrTop.topVotes === mrZero.topVotes + 1,
    `${mrZero.topVotes} → ${mrTop.topVotes}`
  );
  ok(
    '宏观读数 vote=+1 会计入见底票',
    mrBottom.bottomVotes === mrZero.bottomVotes + 1,
    `${mrZero.bottomVotes} → ${mrBottom.bottomVotes}`
  );
  ok(
    '宏观读数 vote=0 只进证据链、不凑票（"知道且中性"与"不知道"必须区分开）',
    mrTop.macroVotes.top === 1 && mrTop.macroVotes.bottom === 0 && mrTop.macroVotes.abstain === 0
  );
  ok(
    '取不到数据的宏观读数计为弃权，并进 evidence 且 available=false（不能静默当"没异议"）',
    (() => {
      const r = synthesizeReversal({ clock: { intent: 'NEUTRAL', label: 'x' }, macro: [mkMacro(0, false)], cfg: CFG });
      const e = r.evidence.find((x) => String(x.layer).includes('M1'));
      return r.macroVotes.abstain === 1 && r.topVotes === mrZero.topVotes && !!e && e.available === false;
    })()
  );
  ok(
    'synthesizeReversal 在没有任何宏观读数时行为不变（向后兼容：不传 macro 等于全部弃权）',
    mrZero.macroVotes.top === 0 && mrZero.macroVotes.bottom === 0 && mrZero.macroVotes.abstain === 0
  );

  const s1WithMacro = stage1Fundamental({
    regime: { ...fakeRegime('NEUTRAL'), macro: [mkMacro(-1), mkMacro(0, false)] },
    cfg: CFG,
  });
  ok(
    '阶段一把宏观读数汇总成 macroSummary（几项有数据 / 几项弃权 / 票落哪边）',
    s1WithMacro.macroSummary.total === 2 && s1WithMacro.macroSummary.available === 1 && s1WithMacro.macroSummary.abstain === 1 && s1WithMacro.macroSummary.voteShort === 1,
    JSON.stringify(s1WithMacro.macroSummary)
  );
  ok(
    '取不到数据的宏观判据进 abstentions —— 与 A4~A7 的弃权口径一致',
    (s1WithMacro.abstentions || []).includes('media-extreme'),
    (s1WithMacro.abstentions || []).join(',')
  );

  /* ── E3.3 阶段二闸门：本文件最重要的一组断言 ──
   *
   * 「产出但标记为否决」和「根本不产出」在用户眼里是完全不同的两件事。
   * 前者会得到一份填满价格的计划表，角落里写着 VETOED；人眼先看到价格。
   * 所以这里断言：阶段一不放行时，每一条 tranche 的 active 都必须被关掉。 */

  const blocked = stage2Technical({ stage1: s1Neutral, levels: mkLevels({ entryPlan: { ...mkLevels().entryPlan, executable: true } }) });
  ok('阶段一未放行 → 阶段二状态为 BLOCKED_BY_STAGE1', blocked.status === 'BLOCKED_BY_STAGE1', blocked.status);
  ok('阶段一未放行 → 阶段二 executable=false（不是"算出来了但否决"）', blocked.executable === false);
  ok(
    '阶段一未放行 → 两条分笔计划的 active 全被关掉（防止人眼先看到价格）',
    blocked.tranches.length === 2 && blocked.tranches.every((t) => t.active === false),
    `active=${blocked.tranches.map((t) => t.active).join(',')}`
  );
  ok('阶段一未放行 → 腿数 / 收口仍作为「热度」展示（不省略，但不构成开单依据）', blocked.hold !== undefined && blocked.squeeze !== undefined && blocked.legs === 1, `腿 ${blocked.legs} 条 · 收口 ${blocked.squeeze?.ok}`);

  const passed = stage2Technical({ stage1: s1Long, levels: mkLevels({ gate: { state: 'SIGNAL', reason: '合成放行', blockers: [] }, trigger: { ...mkLevels().trigger, entryMode: 'PULLBACK' } }) });
  ok('阶段一放行 + 门禁 SIGNAL → 阶段二 pass=true 且 executable=true', passed.pass === true && passed.executable === true && passed.status === 'SIGNAL');
  ok('阶段二把入场模式（突破 / 回调）单独暴露出来，供界面与策略卡共用', passed.entryMode === 'PULLBACK', String(passed.entryMode));

  const noLevels = stage2Technical({ stage1: s1Long, levels: null });
  ok('没有技术面读数 → 阶段二 ABSENT（与「被阶段一挡住」区分开）', noLevels.status === 'ABSENT' && noLevels.executable === false);

  /* ── E3.4 阶段三：只在有持仓时才"适用"，没持仓时给「不适用」而不是空数字 ── */

  const s3NoPos = stage3Position({ stage1: s1Long, levels: mkLevels({ hasPosition: false }) });
  ok('无持仓 → 阶段三 NOT_APPLICABLE、applicable=false（不是一堆 0）', s3NoPos.status === 'NOT_APPLICABLE' && s3NoPos.applicable === false);
  ok('无持仓时阶段三仍然 pass=true —— 它不该把整条流水线判为失败', s3NoPos.pass === true);
  ok('阶段三 levels 缺失 → ABSENT', stage3Position({ stage1: s1Long, levels: null }).status === 'ABSENT');

  const s3Exit = stage3Position({
    stage1: s1Long,
    levels: mkLevels({ hasPosition: true, stop: { recommended: { label: '中轨止损', price: w(95) } }, exitSignals: { urgency: 'IMMEDIATE', summary: '合成', newsExit: { active: true, reason: '重大利空' }, bandBroken: {}, failedBounce: {} } }),
  });
  ok('阶段三 有持仓 + 立即离场 → status=EXIT、urgency=IMMEDIATE', s3Exit.status === 'EXIT' && s3Exit.urgency === 'IMMEDIATE');

  const s3Hold = stage3Position({
    stage1: s1Long,
    levels: mkLevels({
      hasPosition: true, stop: { recommended: { label: '中轨止损', price: w(95) } },
      roll: { ladder: [{ index: 1 }], ready: false, profitOk: false, timingOk: false, triggerBps: 500, profitPct: 0.01, resume: { reason: '回撤后尚未重新起势' } },
      exitSignals: { urgency: 'WATCH', summary: '暂不离场', bandBroken: {}, failedBounce: {}, newsExit: {} },
    }),
  });
  ok('阶段三 有持仓但两道门未过 → status=HOLD、canAdd=false', s3Hold.status === 'HOLD' && s3Hold.canAdd === false);
  ok(
    '阶段三把加仓的两道门分开报（浮盈 / 时机），而不是混成一句 —— 混起来会让人去调错参数',
    s3Hold.roll && 'profitOk' in s3Hold.roll && 'timingOk' in s3Hold.roll
  );

  /* ── E3.4b 加仓的第三道门：方向 ──
   *
   * 前两道门在 levels 里（浮盈 / 时机），它只看得到「有没有仓位」。
   * 于是会出现这种组合：阶段一判 NEUTRAL（不开新仓），而阶段三报 canAdd=true
   * （因为浮盈和时机恰好都过）。两句话各自看都对，摆在同一张结论卡上就是自相矛盾 ——
   * 而且它会把仓位推向「在没有任何方向依据时加大敞口」，比新开一仓更激进。 */

  const mkRollReady = () => ({
    ladder: [{ index: 1, triggerPrice: w(98) }],
    ready: true, profitOk: true, timingOk: true, triggerBps: 500, profitPct: 0.06,
    resume: { reason: '回撤后已重新起势' },
  });
  const mkLevelsForAdd = () =>
    mkLevels({
      hasPosition: true, stop: { recommended: { label: '中轨止损', price: w(95) } },
      roll: mkRollReady(),
      exitSignals: { urgency: 'WATCH', summary: '暂不离场', bandBroken: {}, failedBounce: {}, newsExit: {} },
    });

  const s3DirBlocked = stage3Position({ stage1: s1Neutral, levels: mkLevelsForAdd() });
  ok(
    '阶段一未放行时，即使浮盈与时机这两道门都过，也不允许加仓（第三道门：方向）',
    s3DirBlocked.canAdd === false,
    `canAdd=${s3DirBlocked.canAdd} · blockedBy=${s3DirBlocked.addBlockedBy}`
  );
  ok(
    '加仓被挡时说明是「方向」挡的，而不是笼统的「条件不满足」—— 三道门的修法完全不同',
    s3DirBlocked.addBlockedBy === 'DIRECTION',
    String(s3DirBlocked.addBlockedBy)
  );
  ok(
    '方向未定的加仓摘要只谈风控与离场，不报浮盈读数（报了就暗示「浮盈够了就能加」）',
    /方向未定/.test(s3DirBlocked.summary) && !/浮盈/.test(s3DirBlocked.summary),
    s3DirBlocked.summary
  );

  const s3BothOk = stage3Position({ stage1: s1Long, levels: mkLevelsForAdd() });
  ok(
    '方向放行 + 两道门都过 → canAdd=true、addBlockedBy=null、status=CAN_ADD（三路都要验，只验挡不验放等于没验）',
    s3BothOk.canAdd === true && s3BothOk.addBlockedBy === null && s3BothOk.status === 'CAN_ADD',
    `canAdd=${s3BothOk.canAdd} · blockedBy=${s3BothOk.addBlockedBy} · ${s3BothOk.status}`
  );

  const s3GatesBlocked = stage3Position({
    stage1: s1Long,
    levels: mkLevels({
      hasPosition: true, stop: { recommended: { label: '中轨止损', price: w(95) } },
      roll: { ...mkRollReady(), ready: false, timingOk: false },
      exitSignals: { urgency: 'WATCH', summary: '暂不离场', bandBroken: {}, failedBounce: {}, newsExit: {} },
    }),
  });
  ok(
    '方向已放行但浮盈/时机没过 → addBlockedBy=GATES（与 DIRECTION 区分开）',
    s3GatesBlocked.canAdd === false && s3GatesBlocked.addBlockedBy === 'GATES',
    String(s3GatesBlocked.addBlockedBy)
  );

  /* ── E3.5 编排输出：唯一的关键结论 + 判据归属统计 ── */

  const P = runPipeline({ regime: fakeRegime('NEUTRAL'), levels: mkLevels(), cfg: CFG });
  ok('方向未定 → 卡点落在阶段一，kind=NO_DIRECTION', P.bottleneck.stage === 1 && P.bottleneck.kind === 'NO_DIRECTION', JSON.stringify(P.bottleneck.kind));
  ok('headline 有真实映射（不是兜底的"状态未知"）', typeof P.headline === 'string' && P.headline !== '状态未知' && P.headline.includes('阶段一'), P.headline);
  ok('编排输出恰好三段，且与 PIPELINE_STAGES 顺序一致', P.stages.length === 3 && P.stages.every((s, i) => s.stage === i + 1));
  ok('编排输出带上 stagesMeta，避免前端另抄一份（改一处漏一处的根源）', Array.isArray(P.stagesMeta) && P.stagesMeta.length === 3 && P.stagesMeta[0].quote);
  ok('判据统计：总数与注册表一致', P.criteria.total === crit.length, `${P.criteria.total}/${crit.length}`);
  ok(
    '判据统计：按阶段分组计数之和等于总数',
    Object.values(P.criteria.byStage).reduce((a, b) => a + b, 0) === crit.length,
    JSON.stringify(P.criteria.byStage)
  );
  ok('编排输出把「待人工确认的判据」与「本轮弃权判据」一并带出', Array.isArray(P.criteria.manualPending) && Array.isArray(P.criteria.abstentions) && P.criteria.abstentions.length === 1, `弃权 ${P.criteria.abstentions.length} 项`);

  const PDir = runPipeline({ regime: fakeRegime('LONG_ONLY'), levels: mkLevels({ gate: { state: 'SIGNAL', reason: '合成', blockers: [] } }), cfg: CFG });
  ok('方向已放行 + 门禁 SIGNAL + 无持仓 → 三段全通，kind=READY', PDir.bottleneck.kind === 'READY', PDir.headline);

  /* ── E3.6 真实读数打通：用 computeLevels 跑一遍，验证分笔计划、离场通道与格式 ── */

  const lin = (a, b, n) => Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));

  /* 必须用「真的有三条推进腿」的序列 —— 随便造一条单调上升的价格拿不到触发侧，
   * entryPlan 根本不会被创建（levels.js 的 canPlan 要求方向已定 + 有推进腿）。
   * 所以这里复用 D 段的构造器：PAD 打底 + nextClose 走真实轨道。 */
  const legArr = [...PAD];
  for (let leg = 0; leg < 3; leg++) {
    legArr.push(nextClose(legArr, 'thrust'));
    if (leg < 2) legArr.push(nextClose(legArr, 'inside-above-mid'));
  }
  legArr.push(nextClose(legArr, 'thrust'));
  legArr.push(nextClose(legArr, 'thrust'));

  const candles = legArr.map((x, i) => ({
    t: Date.parse('2026-06-01T00:00:00Z') + i * 14400000,
    o: w(x), h: w(x * 1.01), l: w(x * 0.99), c: w(x), v: w(1),
  }));
  const mark = w(legArr[legArr.length - 1]);

  const LCFG = defaultConfig('EXPANSION');
  LCFG.cyclePhase = 'EXPANSION';

  const lv = computeLevels({
    coin: 'BTC', candles, markWad: mark, position: null,
    equityWad: 100000n * 10n ** 18n, config: LCFG, tiers: defaultTiers(),
    regime: fakeRegime('LONG_ONLY'),
  });

  ok('computeLevels 在「方向已定 + 有推进腿」时产出分笔执行计划（头仓 + 主仓共两笔）', Array.isArray(lv.entryPlan?.tranches) && lv.entryPlan.tranches.length === 2, `${lv.entryPlan?.tranches?.length} 笔`);
  ok(
    '两笔的止损锚不同（头仓锚突破位 / 主仓锚中轨）—— 共用一个止损是错的',
    lv.entryPlan?.tranches?.length === 2 && lv.entryPlan.tranches[0].stopAnchor !== lv.entryPlan.tranches[1].stopAnchor,
    lv.entryPlan?.tranches?.map((t) => t.stopAnchor).join(' vs ')
  );
  ok(
    '每笔都带 active 开关，且受 entryPlan.executable 约束（未放行时不得挂单）',
    lv.entryPlan.tranches.every((t) => typeof t.active === 'boolean') &&
      (lv.entryPlan.executable === true || lv.entryPlan.tranches.every((t) => t.active === false)),
    `executable=${lv.entryPlan.executable} active=${lv.entryPlan.tranches.map((t) => t.active).join(',')}`
  );
  ok('computeLevels 产出离场通道汇总，且 urgency 取值合法', lv.exitSignals && ['NONE', 'WATCH', 'ON_CLOSE', 'IMMEDIATE'].includes(lv.exitSignals.urgency), String(lv.exitSignals?.urgency));
  ok('无持仓时四条离场通道一律不适用', lv.exitSignals?.active === false && lv.exitSignals?.applicable === false);

  /* 格式回归：WAD 是 18 位整数，任何一句给用户看的文案里都不该出现它。
   * 这是实测踩过的坑 —— 阶段三摘要曾经直接插值 bigint，界面上出现
   * 「最新收盘 81700000000000000000000」，用户完全无法读数。 */
  const userFacingStrings = [
    lv.entryPlan?.trancheNote,
    lv.exitSignals?.summary,
    lv.exitSignals?.bandBroken?.detail,
    lv.exitSignals?.failedBounce?.reason,
    ...(lv.warnings || []),
    ...(lv.entryPlan?.tranches || []).map((t) => t.detail),
  ].filter((x) => typeof x === 'string');
  const leaked = userFacingStrings.filter((x) => /\d{15,}/.test(x));
  ok('给用户看的文案里没有裸露的 18 位 WAD 整数（价格一律经 fmtPrice）', leaked.length === 0, leaked.length ? leaked[0].slice(0, 80) : `已扫描 ${userFacingStrings.length} 条`);

  const entryPx = (mark * 9n) / 10n; // 成本低于现价 → 有浮盈，第一道门才可判
  const lvPos = computeLevels({
    coin: 'BTC', candles, markWad: mark,
    position: { qty: w(1), isLong: true, entryPx, positionValue: mark, liquidationPx: (mark * 5n) / 10n, marginUsed: (mark * 10n) / 100n },
    equityWad: 100000n * 10n ** 18n, config: LCFG, tiers: defaultTiers(),
    regime: fakeRegime('LONG_ONLY'),
  });
  const s3Real = stage3Position({ stage1: s1Long, levels: lvPos, regime: fakeRegime('LONG_ONLY') });
  ok('有持仓时阶段三适用，且给出止损 / 加仓两道门 / 四条离场通道', s3Real.applicable === true && !!s3Real.stop && !!s3Real.roll && !!s3Real.exitSignals);
  ok('有持仓时浮盈为正 → 第一道门（浮盈）读得到实际值', typeof lvPos.roll?.profitOk === 'boolean' && lvPos.roll.profitPct > 0, `浮盈 ${(lvPos.roll?.profitPct * 100).toFixed(2)}% · profitOk=${lvPos.roll?.profitOk}`);
  ok('口径一致时不误报「事件层与读数不一致」', s3Real.newsStale === false);

  /* ── E3.7 三条新读数的数学正确性（合成序列，逐场景核对）── */

  const pullUp = pullbackResumeRead(seq([...lin(100, 120, 20), ...lin(120, 126, 10)]), true, CFG);
  ok('加仓时机 · 直线拉升（无 ≥3% 回撤）→ 标 straightRun，且默认放行为「次优位置」', pullUp.straightRun === true && pullUp.pulledBack === false && pullUp.resumed === true);

  const pullBackThenHigh = pullbackResumeRead(seq([...lin(100, 120, 20), ...lin(120, 104, 6), ...lin(104, 126, 8)]), true, CFG);
  ok(
    '加仓时机 · 涨 20% → 回撤 13% → 再创新高：必须判成「回撤后已起势」（这是最典型的加仓点）',
    pullBackThenHigh.pulledBack === true && pullBackThenHigh.resumed === true && pullBackThenHigh.reboundRatio >= 0.99,
    `深度 ${(pullBackThenHigh.depthPct * 100).toFixed(1)}% · 反弹比 ${(pullBackThenHigh.reboundRatio * 100).toFixed(0)}%`
  );

  const pullAtTrough = pullbackResumeRead(seq([...lin(100, 120, 20), ...lin(120, 100, 10)]), true, CFG);
  ok('加仓时机 · 最后一根就是最低点 → 不算起势（回撤还在进行中）', pullAtTrough.pulledBack === true && pullAtTrough.resumed === false && pullAtTrough.barsSinceTrough === 0);

  const pullWeak = pullbackResumeRead(seq([...lin(100, 120, 20), ...lin(120, 96, 8), ...lin(96, 99, 8)]), true, CFG);
  ok('加仓时机 · 回撤 20% 后只收复 12.5% → 不放行（在下跌途中往下摊平是最贵的行为）', pullWeak.resumed === false && pullWeak.reboundRatio < 0.2, `反弹比 ${(pullWeak.reboundRatio * 100).toFixed(1)}%`);

  const pullShort = pullbackResumeRead(seq([...lin(120, 100, 20), ...lin(100, 116, 6), ...lin(116, 94, 8)]), false, CFG);
  ok('加仓时机 · 空头镜像（下跌 → 反弹 → 继续新低）成立', pullShort.pulledBack === true && pullShort.resumed === true);

  const fbTrue = failedBounceRead(seq([...lin(100, 120, 20), ...lin(120, 102, 10), ...lin(102, 103, 6)]), true, CFG);
  ok('离场通道 · 回撤 15% + 只收复 5.6% + 已过 6 根 → 「调整后没有反弹」成立', fbTrue.failedBounce === true, `深度 ${(fbTrue.depthPct * 100).toFixed(1)}% 反弹 ${(fbTrue.reboundRatio * 100).toFixed(0)}%`);

  const fbRebounded = failedBounceRead(seq([...lin(100, 120, 20), ...lin(120, 102, 10), ...lin(102, 116, 6)]), true, CFG);
  ok('离场通道 · 回撤后已收复 78% → 反弹有效，继续持有', fbRebounded.failedBounce === false);

  const fbShallow = failedBounceRead(seq([...lin(100, 120, 20), ...lin(120, 117, 10)]), true, CFG);
  ok('离场通道 · 只回撤 2.5% → 属正常波动，不构成离场信号', fbShallow.failedBounce === false);

  const fbTooEarly = failedBounceRead(seq([...lin(100, 120, 20), ...lin(120, 102, 3)]), true, CFG);
  ok('离场通道 · 刚跌下去就喊"没反弹"是错的 → 根数不足时不触发', fbTooEarly.failedBounce === false && fbTooEarly.barsSinceTrough < 6);

  const newsNoLayer = adverseNewsExit({ regime: fakeRegime('LONG_ONLY'), isLong: true, cfg: CFG });
  ok('利空通道 · 未接入事件层 → available=false（弃权，不静默按"没有利空"处理）', newsNoLayer.available === false && newsNoLayer.active === false);

  const evWith = (items, shock) => fakeRegime('LONG_ONLY', { events: { items, shock } });
  const newsOn = adverseNewsExit({ regime: evWith([{ id: 'x', date: '2026-09-18', note: '监管重击', effective: -2, ageDays: 3 }]), isLong: true, cfg: CFG });
  ok('利空通道 · 持仓为多 + 窗口内反向重事件 → 立即离场', newsOn.active === true && newsOn.items.length === 1);

  const newsWrongSide = adverseNewsExit({ regime: evWith([{ id: 'x', date: '2026-09-18', note: '利好', effective: 2, ageDays: 3 }]), isLong: true, cfg: CFG });
  ok('利空通道 · 同向事件不触发（只认与持仓方向相反的）', newsWrongSide.active === false);

  const newsStale = adverseNewsExit({ regime: evWith([{ id: 'x', date: '2026-08-01', note: '旧利空', effective: -2, ageDays: 30 }]), isLong: true, cfg: CFG });
  ok('利空通道 · 超出窗口（10 天）的旧事件不触发', newsStale.active === false);

  const newsShock = adverseNewsExit({ regime: evWith([], { active: true, detail: '黑天鹅' }), isLong: true, cfg: CFG });
  ok('利空通道 · 黑天鹅冷却期内持多仓 → 触发（事件层自己说它只管理既有仓位）', newsShock.active === true && newsShock.shockActive === true);

  /* 端到端（输入口径一致，与 server.js 的调用顺序相同）：
   * 方向已定 + 有持仓 + 事件表里有一条窗口内的反向重事件 → 三段应串成一条 EXIT 结论。 */
  const newsRegime = evWith([{ id: 'x', date: '2026-09-18', note: '监管重击', effective: -2, ageDays: 3 }], null);
  const lvPosNews = computeLevels({
    coin: 'BTC', candles, markWad: mark,
    position: { qty: w(1), isLong: true, entryPx, positionValue: mark, liquidationPx: (mark * 5n) / 10n, marginUsed: (mark * 10n) / 100n },
    equityWad: 100000n * 10n ** 18n, config: LCFG, tiers: defaultTiers(), regime: newsRegime,
  });
  ok(
    '利空事件真的被 computeLevels 接上（否则下面那条端到端断言是假的）',
    lvPosNews.exitSignals?.newsExit?.available === true && lvPosNews.exitSignals?.urgency === 'IMMEDIATE',
    `urgency=${lvPosNews.exitSignals?.urgency}`
  );

  const pExit = runPipeline({ regime: newsRegime, levels: lvPosNews, cfg: CFG });
  ok(
    '端到端 · 持仓遇到反向重事件 → 卡点落在阶段三、kind=EXIT（而不是还在阶段二谈入场）',
    pExit.bottleneck.kind === 'EXIT' && pExit.bottleneck.stage === 3,
    `${pExit.bottleneck.kind} · ${pExit.headline}`
  );

  /* 一致性护栏：编排层手里有事件表，但 levels 是用「没有事件表」的那份 regime 算的。
   * 这时「重大利空」这条通道会静默失效 —— 而它恰恰是唯一能抢在止损位之前的那条，
   * 所以必须出声，不能静默当成"没有利空"。 */
  const pStale = runPipeline({ regime: newsRegime, levels: lvPos, cfg: CFG });
  ok(
    '一致性护栏 · 事件表与 levels 口径不一致时必须出声（否则会静默少掉一条离场通道）',
    pStale.stages[2].newsStale === true && /未接入/.test(pStale.stages[2].summary),
    pStale.stages[2].newsStale ? '已标记 newsStale 并在摘要里说明' : '未标记'
  );
}

/* ═══════════════════════ 结论 ═══════════════════════ */

console.log('\n' + '═'.repeat(78));
if (fails.length === 0) {
  console.log(`结论：全部通过 —— ${pass} 项断言。`);
  console.log('  ① 减半时钟给出「许可方向集」，与价格无关，不可调参');
  console.log('  ② 结构层给出「是否批准」，四分量加权，含前视偏差防护');
  console.log('  ③ 事件层按半衰期衰减，黑天鹅走一票否决通道');
  console.log('  ④ 「三次突破」数的是三条独立推进腿，不是连续三根 K 线');
  console.log('  ⑤ 「站稳」分 H0/H1/H2，只有 H2 允许开单');
  console.log('  ⑥ 门禁把两套系统接起来：SIGNAL / ARMED / VETOED / IDLE');
  console.log('  ⑦ 三段单向依赖：阶段一不放行 → 阶段二不产出可执行计划 → 阶段三只做风控');
  console.log('  ⑧ 加仓要过两道门（浮盈够格 + 回撤后已起势），离场分四条通道（利空 / 止损击穿 / 破中轨 / 不反弹）');
  console.log('═'.repeat(78));
} else {
  console.log(`结论：${pass} 项通过，${fails.length} 项失败：`);
  for (const f of fails) console.log('  ✗ ' + f);
  console.log('═'.repeat(78));
  process.exitCode = 1;
}
