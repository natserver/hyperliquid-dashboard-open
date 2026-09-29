/**
 * 三阶段编排（Pipeline）
 * ══════════════════════════════════════════════════════════════════════
 *
 * 整个系统按比特皇自己的框架分成三段：
 *
 *   「如果说基本面可以判断市场行情的大方向，技术面则可以告诉我们行情开启的时间。」
 *                                        —— 《比特皇精华总结》一、确认趋势
 *
 *   ① 基本面   →  往哪个方向        （src/regime.js + src/regime-criteria.js）
 *   ② 技术面   →  什么时候扣扳机    （src/strategy.js 的 analyzeSetup + gate）
 *   ③ 持仓管理 →  进去之后怎么办    （src/levels.js 的 stop / roll / tp / exit）
 *
 * ── 为什么需要这个文件 ──────────────────────────────────────────────
 *
 * 这三段本来就在算，但分散在三个模块里，而且**边界是糊的**：
 *   · 阶段三的代码（computeLevels）不管阶段一放没放行都会把开单计划算出来 ——
 *     字段齐全、价格齐全，只在旁边挂一条 warning。读的人很容易把
 *     「算出来了」当成「可以做了」。
 *   · 阶段二的门禁理由、阶段一的弃权项，散落在 warnings 数组里，
 *     没有「现在卡在哪一段」这个最要紧的结论。
 *
 * 所以这个模块做两件事：
 *   1. 把每一段的**输入契约 / 输出 / 为什么没通过**显式写出来；
 *   2. 给出唯一的关键结论：`bottleneck` —— 现在卡在哪一段，为什么。
 *
 * 阶段性放行的硬约束（这是编排层存在的全部意义）：
 *   阶段一不放行 → 阶段二**不产出可执行计划**（不是"产出了但否决"，
 *                  而是"根本不该算入场点"——方向没定就找入场点是本末倒置）
 *   阶段二不放行 → 阶段三只做风控与离场，不谈加仓
 *
 * 纯函数、无状态：给它同一份输入，永远得到同一份输出。可逐日回放。
 */

import { STAGES, criteriaByStage, DIRECTION_CRITERIA } from './regime-criteria.js';

/** 三段的元信息 —— 界面、文档、测试三处都从这里派生。 */
export const PIPELINE_STAGES = [
  {
    index: 1,
    key: 'FUNDAMENTAL',
    name: '阶段一 · 基本面',
    question: '往哪个方向',
    quote: '如果说基本面可以判断市场行情的大方向……',
    source: '《比特皇精华总结》一、确认趋势',
    consumes: 'BTC 日/周/月线、资金费序列、事件表',
    produces: 'direction（LONG_ONLY / SHORT_ONLY / NEUTRAL）+ 每一段的理由与弃权项',
    blocks: '这一段的输出是下一段的**前提**。方向未定 → 不评估入场点。',
  },
  {
    index: 2,
    key: 'TECHNICAL',
    name: '阶段二 · 技术面',
    question: '什么时候扣扳机',
    quote: '……技术面则可以告诉我们行情开启的时间。',
    source: '《比特皇精华总结》一、确认趋势',
    consumes: '阶段一的 direction（必需）+ 4H K 线',
    produces: 'gate 状态（SIGNAL/ARMED/VETOED/IDLE）+ 入场模式 + 分笔执行计划',
    blocks: '三条件同时成立才放行：3 条独立推进腿、突破前收口、站稳或回踩起势。',
  },
  {
    index: 3,
    key: 'POSITION',
    name: '阶段三 · 持仓管理',
    question: '进去之后怎么办',
    quote: '盈利的时候加仓，亏损的时候及时止损。',
    source: '《交易心得》第三个策略',
    consumes: '现有持仓 + 阶段一的 direction（决定能不能顺势加仓）',
     produces: '止损位（5 个候选）/ 加仓阶梯与时机 / 两条止盈路径 / 四条离场通道与紧急度',
    blocks: '只在有持仓时才有意义。加仓要过两道门：浮盈够格 + 回撤后已起势。',
  },
];

/* ─────────────────────── 阶段一 · 基本面 ─────────────────────── */

/**
 * 阶段一：定方向。
 *
 * 它**不看**入场点、**不看**仓位。输出只有一件事：现在允许往哪边开新仓。
 *
 * 两个诚实要求：
 *   · 弃权必须显形 —— 手工维护的判据（ETF / 链上 / DXY / 美联储 / 机构持仓 / 监管）
 *     没有数据源，它们的缺席必须体现在 abstentions 里，而不是默认"没有异议"。
 *   · 失联必须显形 —— regime 为 null 时状态是 ABSENT（整套流程停摆），
 *     不是 NEUTRAL（方向未定）。这两者对用户的意义完全不同。
 */
export function stage1Fundamental({ regime, cfg = {} } = {}) {
  const meta = PIPELINE_STAGES[0];
  const crit = criteriaByStage()[1] || [];
  const manualIds = crit.filter((c) => c.implemented === false).map((c) => c.id);

  if (!regime) {
    return {
      stage: 1, key: meta.key, name: meta.name, question: meta.question,
      status: 'ABSENT',
      pass: false,
      direction: null, directionLabel: '方向层缺失',
      allows: { long: false, short: false },
      evidence: [],
      abstentions: manualIds,
      manualPending: manualIds,
      macroReadings: [],
      macroSummary: { total: 0, available: 0, abstain: 0 },
      criteriaTotal: crit.length,
      manualCount: manualIds.length,
      summary: '阶段一缺席：没能取到 BTC 的长周期数据，方向无法判定。整套流程在此停摆 —— 方向层缺席时阶段二一律不开仓。',
    };
  }

  // 从判据层读出「哪些基本面判据弃权了」。这一信息以前只散在 reasons 里。
  const rev = regime.reversal || {};
  const abstentions = (rev.evidence || []).filter((e) => !e.available).map((e) => e.layer);
  const evidence = (regime.reasons || []).slice();

  /*
   * M1~M6 宏观与基本面读数。
   *
   * 这 6 条以前是 `implemented:false` —— 走手工事件表，所以在界面上永远是
   * 「6 条待人工」。现在它们由 src/macro-sources.js 自动采集，所以：
   *   · manualPending 自然清空（注册表里已经没有 implemented:false 了）
   *   · 但**取不到数据的源仍然必须是弃权**，不能因为"注册表里已实现"就默认无异议
   * 这就是 macroSummary.abstain 存在的意义。
   */
  const macroReadings = Array.isArray(regime.macro) ? regime.macro : [];
  const macroAvailable = macroReadings.filter((m) => m.available);
  const macroAbstain = macroReadings.filter((m) => !m.available);
  const macroSummary = {
    total: macroReadings.length,
    available: macroAvailable.length,
    abstain: macroAbstain.length,
    voteLong: macroAvailable.filter((m) => m.vote > 0).length,
    voteShort: macroAvailable.filter((m) => m.vote < 0).length,
  };

  // 取到数据的宏观读数进 evidence —— 取不到的进 abstentions（弃权必须显形）
  for (const m of macroAvailable) {
    if (m.vote !== 0 || m.id === 'media-extreme') evidence.push(m.reason);
  }
  for (const m of macroAbstain) abstentions.push(m.id);

  const allows = { long: !!regime.allowLong, short: !!regime.allowShort };
  const pass = regime.bias !== 'NEUTRAL';

  let summary;
  if (regime.bias === 'NEUTRAL') {
    summary =
      `阶段一：${regime.biasLabel} —— 没有任何方向被批准，阶段二不会有可执行计划。` +
      (evidence[0] ? `首要原因：${evidence[0]}` : '');
  } else {
    const side = regime.bias === 'LONG_ONLY' ? '只批准多头' : '只批准空头';
    const gateNote = allows.long || allows.short ? '' : '（但位置/行为闸门当前把新开仓也关上了）';
    summary = `阶段一：${side}，置信度 ${regime.confidence}${gateNote}。`;
  }
  if (macroSummary.available) {
    summary +=
      ` 宏观与基本面读数 M1~M6：${macroSummary.available}/${macroSummary.total} 项取到数据` +
      `（多头侧 ${macroSummary.voteLong}、空头侧 ${macroSummary.voteShort}${macroSummary.abstain ? `、弃权 ${macroSummary.abstain}` : ''}）。`;
  }

  return {
    stage: 1, key: meta.key, name: meta.name, question: meta.question,
    status: pass ? 'DECIDED' : 'NEUTRAL',
    pass,
    direction: regime.bias,
    directionLabel: regime.biasLabel,
    confidence: regime.confidence,
    allows,
    /** 为什么是这个方向 —— 完整理由链，不做摘要 */
    evidence,
    /** 哪些基本面判据当前弃权（必须显形，不能静默当"没异议"） */
    abstentions,
    /** 手工维护、当前无法自动评估的判据 id（接入 macro-sources 后应为空） */
    manualPending: manualIds,
    /** M1~M6 的完整读数（含 provider / asOf / vote），供界面直接渲染 */
    macroReadings,
    /** 一句话概括：多少项取到数据、多少项弃权、票落在哪边 */
    macroSummary,
    criteriaTotal: crit.length,
    manualCount: manualIds.length,
    chaseBlocked: !!regime.chaseBlocked,
    topBrake: !!regime.topBrake,
    clock: regime.clock,
    structure: regime.structure,
    summary,
  };
}

/* ─────────────────────── 阶段二 · 技术面 ─────────────────────── */

/**
 * 阶段二：定时点。
 *
 * 硬约束：**阶段一不放行时，本阶段不产出可执行计划。**
 *
 * 注意「不产出」和「产出但标记为否决」的区别 —— 后者会让读的人
 * 看到一份填满价格的计划表，只是角落里写了 VETOED。人眼会先看到价格。
 * 所以这里直接把 executable 置 false，并且把 tranches 的 active 全部关掉。
 */
export function stage2Technical({ stage1, levels } = {}) {
  const meta = PIPELINE_STAGES[1];
  const gate = levels?.gate || null;
  const trig = levels?.trigger || null;
  const plan = levels?.entryPlan || null;

  if (!levels) {
    return {
      stage: 2, key: meta.key, name: meta.name, question: meta.question,
      status: 'ABSENT', pass: false, executable: false,
      entryMode: null, tranches: [], blockers: ['未计算技术面读数（K 线不足或无该标的永续合约）'],
      summary: '阶段二缺席：K 线不足，无法评估入场时机。',
    };
  }
  if (!stage1 || !stage1.pass) {
    return {
      stage: 2, key: meta.key, name: meta.name, question: meta.question,
      status: 'BLOCKED_BY_STAGE1',
      pass: false,
      executable: false,
      entryMode: trig?.entryMode ?? null,
      // 读数照给 —— 它们是「热度」参考，不是开单依据。
      // 刻意不省略：方向未定时仍然需要知道「市场在酝酿什么」，
      // 只是这份酝酿不构成任何可执行动作。
      hold: trig?.hold ?? null,
      squeeze: trig?.squeeze ?? null,
      pullback: trig?.pullback ?? null,
      legs: trig?.legs?.length ?? 0,
      required: trig?.required ?? null,
      longLegs: trig?.longLegs ?? 0,
      shortLegs: trig?.shortLegs ?? 0,
      triggerReason: trig?.reason ?? null,
      // ⚠️ 关键：tranches 的 active 全部关掉。
      // 「产出但标记为否决」是危险的 —— 人眼会先看到价格，再看角落里的 VETOED。
      tranches: (plan?.tranches || []).map((t) => ({ ...t, active: false })),
      trancheNote: '阶段一未放行，这两笔一律不挂 —— 方向没定之前不评估入场点。',
      blockers: [`阶段一未放行（${stage1 ? stage1.directionLabel : '方向层缺失'}）—— 方向没定之前不评估入场点。`],
      summary: '阶段二被阶段一挡住：方向未定，此时讨论入场时机是本末倒置。推进腿与收口读数仍然会计算并展示（作为"热度"参考），但不构成开单依据。',
    };
  }

  const status = gate ? gate.state : 'IDLE';
  const pass = status === 'SIGNAL';
  const tranches = plan?.tranches || [];

  let summary;
  if (status === 'SIGNAL') {
    const mode = trig?.entryMode === 'PULLBACK' ? '回调入场' : '突破入场';
    if (plan && plan.executable === false) {
      /* 技术上形态成立，但开单计划被可得空间 / 盈亏比等硬门槛卡住。
       * status 保持 SIGNAL（这是「技术侧成立」的事实），cut off 用 executable=false
       * 表达「能看，不能动」—— 两者各说各的真话，别糊成一句。 */
      summary = `阶段二技术形态成立（${mode}），但开单计划被硬门槛卡住：${(plan.blockedBy || []).join('；')} —— 形态对，但空间/盈亏比没有允许现在出手。`;
    } else {
      summary = `阶段二放行（${mode}）：三次推进 + 收口 + ${trig?.entryMode === 'PULLBACK' ? '回踩起势' : '站稳确认'} 全部成立。`;
    }
  } else if (status === 'ARMED') {
    summary = `阶段二挂弦待确认：方向已放行，但${(gate?.blockers || []).join('；') || '条件未齐'}。`;
  } else if (status === 'VETOED') {
    summary = `阶段二被否决：${gate?.reason || ''}`;
  } else {
    summary = `阶段二无动作：${gate?.reason || trig?.reason || '没有触发侧。'}`;
  }

  return {
    stage: 2, key: meta.key, name: meta.name, question: meta.question,
    status, pass,
    executable: !!(plan && plan.executable),
    entryMode: trig?.entryMode ?? null,
    hold: trig?.hold ?? null,
    squeeze: trig?.squeeze ?? null,
    pullback: trig?.pullback ?? null,
    legs: trig?.legs?.length ?? 0,
    required: trig?.required ?? null,
    /** 分两笔的执行计划：头仓（突破 30%）+ 主仓（回调 70%） */
    tranches,
    trancheNote: plan?.trancheNote ?? null,
    blockers: !!(plan && plan.executable === false) && Array.isArray(plan.blockedBy) && plan.blockedBy.length
      ? plan.blockedBy
      : (gate?.blockers?.length ? gate.blockers : (trig?.blockers || [])),
    summary,
  };
}

/* ─────────────────────── 阶段三 · 持仓管理 ─────────────────────── */

/**
 * 阶段三：持仓管理。
 *
 * 只在有持仓时才"适用"。没持仓时这一段的输出是 applicable: false，
 * 而不是一堆空数字 —— 空数字会被误读成"算出来是 0"。
 *
 * @param {object} args
 * @param {object} args.stage1 阶段一的输出（用它判断加仓是否顺势）
 * @param {object} args.levels computeLevels 的输出
 * @param {object|null} args.regime 编排层的原始读数 —— 只用于「一致性护栏」，
 *   不重复实现任何判读逻辑（判读仍在 levels 里，这里只对齐两者的口径）
 */
export function stage3Position({ stage1, levels, regime = null } = {}) {
  const meta = PIPELINE_STAGES[2];
  if (!levels) {
    return {
      stage: 3, key: meta.key, name: meta.name, question: meta.question,
      status: 'ABSENT',
      applicable: false, pass: false, urgency: 'NONE',
      newsStale: false,
      summary: '阶段三缺席：没有持仓读数。',
    };
  }

  const has = !!levels.hasPosition;
  if (!has) {
    return {
      stage: 3, key: meta.key, name: meta.name, question: meta.question,
      status: 'NOT_APPLICABLE',
      applicable: false,
      pass: true,
      urgency: 'NONE',
      newsStale: false,
      isLong: levels.isLong,
      summary: '阶段三不适用（当前无持仓）—— 止损 / 加仓 / 止盈只在有仓位时才有意义。',
    };
  }

  const roll = levels.roll || {};
  const tp = levels.takeProfit || {};
  const ex = levels.exitSignals || {};

  /* 一致性护栏：编排层手里有事件表，而 levels 里的利空通道却报「未接入」——
   * 说明 levels 是在事件表刷新之前算出来的。后果不是"少显示一行"，
   * 而是少了一条离场通道，而这条通道恰恰是唯一能抢在止损位之前的那条。
   * 所以它必须出声。（正常的 server.js 路径里两者同源，不会出现这种情况。） */
  const newsStale = !!(regime && regime.events) && ex.newsExit?.available === false;

  /* 加仓要过**三道**门。前两道在 levels 里（浮盈够格 / 回撤后已起势），
   * 第三道在这里：**方向必须已经放行**。
   *
   * 为什么这一道只能补在编排层：levels 只看得到「有没有仓位」，
   * 它不知道方向定没定。而方向未定时加仓＝在没有任何依据的情况下加大敞口，
   * 比「新开一仓」更激进 —— 连新开仓都不批，就更不该批加仓。
   * 缺这道门时，结论卡会输出「卡在阶段一（不开新仓）」＋「可以加仓」这种
   * 自相矛盾的组合，而两句话各自看都「没错」。 */
  const directionOk = !!(stage1 && stage1.pass);
  const canAdd = directionOk && !!(roll.ladder && roll.ladder.length && roll.ready);
  const addBlockedBy = canAdd ? null : !directionOk ? 'DIRECTION' : 'GATES';

  let summary;
  if (ex.urgency === 'IMMEDIATE') {
    // 两条 IMMEDIATE 通道（重大利空 / 止损击穿）各自的触发原因不同，
    // 硬套 newsExit.reason 会在止损击穿时报出「重大利空」这种错的归因。
    const why = ex.newsExit?.active
      ? ex.newsExit.reason || ''
      : ex.stopBreached?.active
        ? ex.stopBreached.detail || '止损已击穿'
        : '';
    summary = `阶段三：**立即离场** —— ${why}`;
  } else if (ex.urgency === 'ON_CLOSE') {
    summary = `阶段三：收盘离场 —— ${ex.summary || ''}`;
  } else if (canAdd) {
    summary = '阶段三：持有中，且已满足加仓条件（方向已定 + 浮盈够格 + 回撤后已起势）。';
  } else if (addBlockedBy === 'DIRECTION' && roll.ladder?.length) {
    summary = '阶段三：持有中，不加仓 —— 方向未定。这一轮只做风控与离场，不加大敞口。';
  } else if (roll.ladder?.length && !roll.ready) {
    // 两道门分开报 —— 混成一句话会让人去调错参数
    const why = [];
    if (!roll.profitOk) why.push(`浮盈未达 ${(roll.triggerBps ?? 0) / 100}%（当前 ${((roll.profitPct || 0) * 100).toFixed(2)}%）`);
    if (!roll.timingOk) why.push(roll.resume?.reason || '加仓时机未到');
    summary = `阶段三：持有中，暂不加仓 —— ${why.join('；')}。`;
  } else {
    summary = '阶段三：持有中，止损与止盈参考位见下。';
  }

  if (newsStale) {
    summary +=
      '　⚠ 编排层拿到了事件表，但离场通道的读数是「未接入」—— levels 很可能是在事件表刷新之前算出来的，' +
      '此时「重大利空」这条通道处于静默失效状态，请以同一份 regime 重算 levels。';
  }

  return {
    stage: 3, key: meta.key, name: meta.name, question: meta.question,
    status:
      ex.urgency === 'IMMEDIATE' || ex.urgency === 'ON_CLOSE'
        ? 'EXIT'
        : canAdd
          ? 'CAN_ADD'
          : 'HOLD',
    applicable: true,
    pass: true,
    isLong: levels.isLong,
    stop: levels.stop,
    roll,
    canAdd,
    /** 加仓被哪一道门挡住：DIRECTION（方向未定）/ GATES（浮盈或时机未到）/ null（能加） */
    addBlockedBy,
    takeProfit: tp,
    exitSignals: ex,
    urgency: ex.urgency || 'NONE',
    /** 事件层与 levels 的口径不一致（护栏命中）—— 界面应显形提示 */
    newsStale,
    risk: levels.risk,
    summary,
  };
}

/* ─────────────────────── 编排 ─────────────────────── */

/**
 * 跑完整的三阶段，并给出唯一的关键结论：现在卡在哪一段。
 *
 * @param {object} args
 * @param {object|null} args.regime  阶段一的原始读数（computeRegime 的输出）
 * @param {object|null} args.levels  阶段二/三的读数（computeLevels 的输出）
 * @param {object} args.cfg
 */
export function runPipeline({ regime = null, levels = null, cfg = {} } = {}) {
  const s1 = stage1Fundamental({ regime, cfg });
  const s2 = stage2Technical({ stage1: s1, levels });
  const s3 = stage3Position({ stage1: s1, levels, regime });

  /* 瓶颈：整套流程现在停在哪一步。这是编排层最有用的一句话。 */
  let bottleneck;
  if (s1.status === 'ABSENT') {
    bottleneck = { stage: 1, reason: s1.summary, kind: 'DATA_MISSING' };
  } else if (!s1.pass) {
    bottleneck = { stage: 1, reason: s1.summary, kind: 'NO_DIRECTION' };
  } else if (levels?.hasPosition) {
    bottleneck =
      s3.urgency === 'IMMEDIATE' || s3.urgency === 'ON_CLOSE'
        ? { stage: 3, reason: s3.summary, kind: 'EXIT' }
        : s3.canAdd
          ? { stage: 3, reason: s3.summary, kind: 'MANAGE' }
          : { stage: null, reason: '持有中，无待办动作。止损与止盈参考位见阶段三。', kind: 'HOLD' };
  } else if (s2.status === 'SIGNAL') {
    bottleneck = s2.executable
      ? { stage: null, reason: s2.summary, kind: 'READY' }
      : { stage: 2, reason: s2.summary, kind: 'PLAN_BLOCKED' };
  } else if (s2.status === 'ARMED') {
    bottleneck = { stage: 2, reason: s2.summary, kind: 'WAIT_TRIGGER' };
  } else if (s2.status === 'VETOED') {
    bottleneck = { stage: 2, reason: s2.summary, kind: 'VETOED' };
  } else {
    bottleneck = { stage: 2, reason: s2.summary, kind: 'NO_TRIGGER' };
  }

  const multiFail = (regime?.reasons || []).filter((r) => /弃权/.test(r)).length;
  const HEADLINES = {
    READY: '三段全部放行 —— 可以开单',
    HOLD: '持有中，无待办动作',
    EXIT: '持仓 · 触发离场信号',
    MANAGE: '持仓 · 可以加仓',
    DATA_MISSING: '卡在阶段一 —— 方向层数据缺失，全流程停摆',
    NO_DIRECTION: `卡在阶段一 —— ${s1.directionLabel}`,
    WAIT_TRIGGER: '卡在阶段二 —— 方向已放行，等触发确认',
    PLAN_BLOCKED: '卡在开单计划 —— 形态成立，但空间或盈亏比门槛未过',
    VETOED: '卡在阶段二 —— 触发被宏观否决',
    NO_TRIGGER: '卡在阶段二 —— 没有形成触发',
  };
  const headline = HEADLINES[bottleneck.kind] || '状态未知';

  return {
    asOf: regime?.asOf ?? null,
    stages: [s1, s2, s3],
    bottleneck,
    headline,
    /**
     * 三段的元信息（名称 / 问题 / 原话 / 出处）。
     * 刻意放进输出而不是让前端自己抄一份 —— 前端的呈现与这里的定义必须同源，
     * 否则改一处漏一处，「界面说的」和「代码做的」很快就会对不上。
     */
    stagesMeta: PIPELINE_STAGES,
    /** 判据归属统计 —— 让「每一段各有多少条依据」可核对 */
    criteria: {
      total: DIRECTION_CRITERIA.length,
      byStage: Object.fromEntries(
        Object.entries(criteriaByStage()).map(([k, v]) => [k, v.length])
      ),
      manualPending: s1.manualPending,
      abstentions: s1.abstentions,
      multiFail,
      stageMeta: STAGES,
    },
  };
}
