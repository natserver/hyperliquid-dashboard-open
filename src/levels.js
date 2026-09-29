/**
 * 策略读数 —— 把比特皇的规则落到「当前持仓 + 当前 K 线」上，算出三个关键位：
 *
 *   1. 止损点  stop      —— 结构位（布林中轨/轨道极值）± buffer，再受 12% 距离上限
 *                          和 5% 权益亏损预算双重约束
 *   2. 滚仓点  roll      —— 浮盈加仓的触发价阶梯（金字塔递减 50%→25%→…），
 *                          以及每次加仓后止损要上移到哪（保本位）
 *   3. 止盈点  takeProfit —— 区间等幅量出投影 + R 倍数位（1R/2R/3R）+ 轨道动态位
 *
 * 三个位全部由 K 线自己算出来，不接受外部传入的目标价 —— 这是链上合约修掉
 * 「keeper 虚报远端目标绕过门槛」那个漏洞后的做法，这里保持一致。
 *
 * 所有价格均为 WAD bigint。所有 bps 均为 Number。
 */

import {
  BPS,
  WAD,
  adverseNewsExit,
  analyzeSetup,
  analyzeTrend,
  blendedEntry,
  breakevenStop,
  canPyramid,
  distanceBps,
  failedBounceRead,
  fmtBps,
  fmtPrice,
  gate,
  initialSize,
  leverageFor,
  lossAtPrice,
  parseWad,
  phaseFloorBps,
  PHASE_LABELS,
  pullbackResumeRead,
  pyramidAddQty,
  stopFromReference,
  unrealizedPnl,
} from './strategy.js';

/** 从原始 K 线数组取出 BigInt 收盘序列 */
export function closesOf(candles) {
  return candles.map((c) => parseWad(c.c));
}

/**
 * 区间等幅量出投影 —— 合约里 _projectedMoveBps 的同类逻辑。
 *
 * 定义：在回看窗口内取 (最高收盘 - 最低收盘) 作为「区间幅度」，
 * 从突破位（窗口内第一次有效突破时的轨道值）向前等幅投影。
 * 经典技术分析里的 measured move：突破后的目标 ≈ 突破位 + 整理区间幅度。
 *
 * 这一步是「合约自己从 K 线量出的可得空间」，而不是 keeper 声明的目标 ——
 * 因为它无法被单个参数放大。
 */
function measuredMove(closes, trend, isLong, lookback) {
  const end = closes.length - 1;
  const from = Math.max(0, end - lookback + 1);
  let hi = null;
  let lo = null;
  for (let i = from; i <= end; i++) {
    const c = closes[i];
    if (hi === null || c > hi) hi = c;
    if (lo === null || c < lo) lo = c;
  }
  if (hi === null || lo === null || hi === lo) return null;
  const range = hi - lo;

  // 突破位：取窗口内第一次有效突破时的轨道值；没有突破记录则退回当前轨道
  let pivot = null;
  if (trend.marks && trend.marks.length) {
    const first = trend.marks.find((m) => m.side === (isLong ? 1 : -1));
    if (first) pivot = first.band;
  }
  if (pivot === null) pivot = isLong ? trend.bands?.upper : trend.bands?.lower;
  if (!pivot || pivot === 0n) return null;

  const target = isLong ? pivot + range : pivot - range;
  return { low: lo, high: hi, range, pivot, target };
}

/**
 * 滚仓阶梯（浮盈加仓）。
 *
 * 逐级前推模拟：每一级的触发价 = 该级的混合成本 × (1 + pyramidTriggerBps)，
 * 加仓后止损上移到新成本的保本位（只允许朝有利方向移动），
 * 并检查「加仓后最坏亏损 ≤ 权益 × maxAddsRiskBps」。
 *
 * 关键：基数用 baseQty（初始量），加仓量逐级减半。这就是比特皇
 * 「浮盈加仓、越加越少」的数学形态 —— 加得越晚，风险敞口增得越少。
 */
function rollLadder({ baseQty, startQty, startAvg, startStop, isLong, mark, equityWad, cfg }) {
  const out = [];
  let curQty = startQty;
  let curAvg = startAvg;
  let curStop = startStop;
  const budget = (equityWad * BigInt(cfg.maxAddsRiskBps)) / BPS;
  const trigger = BigInt(cfg.risk.pyramidTriggerBps);

  for (let i = 0; i < cfg.risk.pyramidMaxAdds; i++) {
    const off = (curAvg * trigger) / BPS;
    const triggerPrice = isLong ? curAvg + off : curAvg - off;
    const addQty = pyramidAddQty(baseQty, i, cfg.risk);
    if (addQty === 0n) break;

    const newQty = curQty + addQty;
    const newAvg = blendedEntry(curQty, curAvg, addQty, triggerPrice);
    let newStop = breakevenStop(newAvg, isLong, cfg.breakevenBufferBps);
    // 止损只允许朝有利方向移动
    if (isLong ? newStop < curStop : newStop > curStop) newStop = curStop;

    const worstCaseLoss = lossAtPrice(newQty, newAvg, newStop, isLong);
    const addNotional = (addQty * triggerPrice) / WAD;
    const totalNotional = (newQty * newAvg) / WAD;

    out.push({
      index: i + 1,
      triggerPrice,
      reached: isLong ? mark >= triggerPrice : mark <= triggerPrice,
      addQty,
      addNotional,
      sizePctOfBase: Number((addQty * BPS) / (baseQty === 0n ? 1n : baseQty)),
      newQty,
      newAvg,
      newStop,
      stopMovePct: distanceBps(newStop, startStop),
      worstCaseLoss,
      budget,
      passesBudget: worstCaseLoss <= budget,
      totalNotional,
      leverageAfter: equityWad === 0n ? 0 : Number((totalNotional * 100n) / equityWad) / 100,
    });

    curQty = newQty;
    curAvg = newAvg;
    curStop = newStop;
  }
  return out;
}

/**
 * 主入口：算出某个标的三位（止损/滚仓/止盈）的完整读数。
 *
 * @param {object} args
 * @param {string} args.coin 标的
 * @param {Array}  args.candles 4H K 线（原始 API 结构，OHLC 为字符串）
 * @param {bigint} args.markWad 当前标记价
 * @param {object|null} args.position 解析后的持仓（见 parsePosition）
 * @param {bigint} args.equityWad 账户权益
 * @param {object} args.config 策略配置
 * @param {Array}  [args.tiers] 杠杆档位
 */
export function computeLevels({ coin, candles, markWad, position, equityWad, config, tiers, regime = null, setup = null }) {
  const cfg = config;
  const closes = closesOf(candles);
  // trend 现在**只用于取 bands 与 marks** —— 它的 direction 字段已被降级，
  // 因为「三次突破 = 方向」是错的（见 strategy.js 的 @deprecated 说明）。
  const trend = analyzeTrend(closes, cfg);
  // 系统二：触发状态（不声称方向）
  const trig = setup || analyzeSetup(closes, cfg);
  const hasPosition = Boolean(position && position.qty !== 0n);
  const warnings = [];

  /* ─────────── 方向求解 ───────────
   * 旧代码是 `isLong = hasPosition ? position.isLong : trend.direction === 1`，
   * 这有一个很贵的缺陷：无持仓且 trend.direction === 0（"还没确认"）时，
   * `0 === 1` 为 false → **静默默认做空**。牛市里没信号的时候，
   * 整套止损/止盈/滚仓读数全是空头的，而且界面上看不出这件事。
   *
   * 新链条按「信息质量」逐级下降，每一级都记下来源，任何降级都会出声：
   *   1. 有持仓          —— 用持仓方向，这是事实
   *   2. regime.bias 明确 —— 用宏观方向层，这是设计上唯一的方向来源
   *   3. regime.intent    —— 方向层未表态但周期相位有许可，临时借用并标记「未定」
   *   4. trig.side        —— 只有触发侧（市场事实，不是方向主张），标记「未定」
   *   5. 全都没有         —— 兜底做多，但明确标记「未定」+ 出警告
   */
  let dir = 0;
  let dirSource = 'undefined';
  let dirUndecided = false;
  if (hasPosition) {
    dir = position.isLong ? 1 : -1;
    dirSource = 'position';
  } else if (regime && regime.bias === 'LONG_ONLY') {
    dir = 1;
    dirSource = 'regime';
  } else if (regime && regime.bias === 'SHORT_ONLY') {
    dir = -1;
    dirSource = 'regime';
  } else if (regime && regime.intent === 'LONG_ONLY') {
    dir = 1;
    dirSource = 'regime-intent';
    dirUndecided = true;
  } else if (regime && regime.intent === 'SHORT_ONLY') {
    dir = -1;
    dirSource = 'regime-intent';
    dirUndecided = true;
  } else if (!regime) {
    // 老调用方（没传 regime）：严格复刻改动前的行为，保证向后兼容。
    // 旧式 `isLong = trend.direction === 1` 在 direction 为 0 或 -1 时都是 false，
    // 所以这里映射成 dir = -1 才是**逐位等价**的。旧口径的问题照旧存在，
    // 但由 dirSource='legacy-trend' 标出来，且服务器端永远会传 regime。
    dir = trend.direction === 1 ? 1 : -1;
    dirSource = 'legacy-trend';
    dirUndecided = false;
  } else if (trig.side !== 0) {
    dir = trig.side;
    dirSource = 'setup-side';
    dirUndecided = true;
  } else {
    dir = 1;
    dirSource = 'default';
    dirUndecided = true;
  }
  const isLong = dir === 1;

  if (dirUndecided) {
    warnings.push(
      `方向未定：宏观方向层${regime ? `输出「${regime.biasLabel}」` : '未接入'}，` +
        `当前读数借用「${dirSource === 'regime-intent' ? '周期相位许可' : dirSource === 'setup-side' ? '触发的市场侧面' : '兜底值'}」按${
          isLong ? '多头' : '空头'
        }方向呈现。这套止损 / 止盈 / 滚仓数字是**占位读数**，不代表任何方向判断 —— 方向确认前不要据此开单。`
    );
  }
  if (regime && regime.chaseBlocked) {
    const ext = regime.structure.extensionVs200d;
    warnings.push(
      `价格已高于 200 日均线 ${(ext * 100).toFixed(1)}%，超过追高上限 ${(regime.structure.chaseMaxExtensionPct * 100).toFixed(0)}%，按规则禁止在该位置追多（方向仍是多的，只是位置过热）。`
    );
  }

  if (!trend.bands) {
    return {
      coin,
      mark: markWad,
      hasPosition,
      isLong,
      dirSource,
      dirUndecided,
      trend,
      trigger: trig,
      regime,
      bands: null,
      stop: null,
      roll: null,
      takeProfit: null,
      risk: null,
      entryPlan: null,
      warnings: ['K 线数量不足，无法计算布林带与策略读数'],
    };
  }
  const bands = trend.bands;
  const buffer = BigInt(cfg.risk.stopBufferBps);

  /* ─────────────── 止损点 ─────────────── */

  // 结构止损候选：回调入场看中轨，突破入场看轨道极值
  const stopMid = stopFromReference(bands.mid, isLong, cfg.risk.stopBufferBps);
  const stopBand = isLong
    ? stopFromReference(bands.upper, isLong, cfg.risk.stopBufferBps)
    : stopFromReference(bands.lower, isLong, cfg.risk.stopBufferBps);

  // 12% 距离硬上限：从入场价（无持仓则用当前标记价）倒推
  const anchor = hasPosition ? position.entryPx : markWad;
  const maxDistOff = (anchor * BigInt(cfg.risk.maxStopDistanceBps)) / BPS;
  const stopHardCap = isLong ? anchor - maxDistOff : anchor + maxDistOff;

  // 5% 权益亏损预算倒推的价格：这是「仓位大小」与「止损距离」的交叉约束
  const riskBudget = (equityWad * BigInt(cfg.risk.riskPerTradeBps)) / BPS;
  const qtyForCheck = hasPosition ? position.qty : 0n;
  let stopBudget = null;
  if (qtyForCheck > 0n) {
    const maxLossDist = (riskBudget * WAD) / qtyForCheck; // 价格能走多远，亏损才到 5%
    stopBudget = isLong ? anchor - maxLossDist : anchor + maxLossDist;
  }

  const candidates = [];
  const push = (label, price, note, opts = {}) => {
    if (price === null || price === undefined || price <= 0n) return;
    const distBps = distanceBps(anchor, price);
    const loss = qtyForCheck > 0n ? lossAtPrice(qtyForCheck, anchor, price, isLong) : null;
    // 有效性判据用「是否会被立刻触发」，基准是当前标记价而非开仓价。
    // 这一点很关键：滚仓后止损上移到成本上方（保本 + 缓冲）是**正确**状态，
    // 若拿开仓价做基准会把它误判成方向错。
    const triggersImmediately = isLong ? price >= markWad : price <= markWad;
    candidates.push({
      label,
      price,
      note,
      notAStop: Boolean(opts.notAStop),
      distanceBps: distBps,
      distancePct: distBps / 100,
      withinDistance: distBps <= cfg.risk.maxStopDistanceBps,
      loss,
      lossPctEquity: loss !== null && equityWad > 0n ? Number((loss * 10000n) / equityWad) / 10000 : null,
      withinBudget: loss !== null ? loss <= riskBudget : null,
      triggersImmediately,
      // 止损已进入盈利区（滚仓后的理想状态）
      onProfitSide: isLong ? price > anchor : price < anchor,
      distanceToMarkBps: distanceBps(markWad, price),
    });
  };

  push('结构止损·中轨', stopMid, '回调入场用中轨做参考，跌破中轨代表回调逻辑失效');
  push(
    isLong ? '结构止损·上轨' : '结构止损·下轨',
    stopBand,
    isLong ? '突破入场用上轨做参考' : '跌破入场用下轨做参考'
  );
  if (hasPosition) {
    push(
      '保本止损',
      breakevenStop(position.entryPx, isLong, cfg.breakevenBufferBps),
      '成本价外侧留缓冲，滚仓后应移动到这里'
    );
  }
  push('距离上限止损', stopHardCap, `距离入场 ${fmtBps(cfg.risk.maxStopDistanceBps)} 的硬上限`);
  if (stopBudget !== null) {
    push('风险预算止损', stopBudget, `亏损达到权益 ${fmtBps(cfg.risk.riskPerTradeBps)} 的位置（风险边界，非结构位）`, {
      notAStop: true,
    });
  }

  // 推荐止损 = 能通过全部约束、且最贴近结构的那一个。
  // 「风险预算止损」是预算边界而非结构位，不参与竞争。
  //
  // 「不许立刻触发」这条过滤是**有意的**：推荐位是「此刻还能设的前向止损」，
  // 拿一个已经被击穿的价位当推荐位没有意义（tools/selftest.js 有硬断言钉着这条）。
  // 也正因为这条过滤，**推荐位永远不可能处于击穿状态** —— 所以下面的 breached
  // 绝不能拿 recommended 来算（旧代码就是这么写的，两个布尔表达式是同一个东西，
  // 于是 breached 恒为 false）。击穿与否只能由结构位自己回答。
  const valid = candidates.filter(
    (c) => !c.triggersImmediately && !c.notAStop && c.withinDistance && c.withinBudget !== false
  );
  const recommended =
    valid.find((c) => c.label === '结构止损·中轨') ||
    valid.find((c) => c.label.startsWith('结构止损·')) ||
    valid[0] ||
    null;

  // 结构位参考：与 recommended 同一偏好顺序，但取自**未过滤**的候选。
  // 它回答的是「价格有没有跌破结构位」，与「此刻还能设哪个止损」是两个问题。
  const structuralAll = candidates.filter((c) => !c.notAStop);
  const structural =
    structuralAll.find((c) => c.label === '结构止损·中轨') ||
    structuralAll.find((c) => c.label.startsWith('结构止损·')) ||
    null;
  const breached = !!(hasPosition && structural && structural.triggersImmediately);

  // 仓位过大检测：止损距离在 12% 以内，亏损却已经超过 5% 预算
  if (hasPosition && candidates.length) {
    const midCand = candidates.find((c) => c.label.startsWith('结构止损·中轨'));
    if (midCand && midCand.withinDistance && midCand.withinBudget === false) {
      warnings.push(
        `仓位过大：按中轨止损（距入场 ${midCand.distancePct.toFixed(2)}%）计算，亏损已达权益的 ` +
          `${(midCand.lossPctEquity * 100).toFixed(2)}%，超过 ${fmtBps(cfg.risk.riskPerTradeBps)} 预算。` +
          `应对应减仓，而不是收紧止损`
      );
    }
  }
  if (hasPosition && position.liquidationPx === null) {
    warnings.push('接口未返回清算价（全仓保证金且保证金充足时属于正常），清算风险请以维持保证金率自行判断');
  }

  /* ─────────────── 滚仓点 ─────────────── */

  // 基数：有持仓用当前数量作为「初始量」的代理值（合约里存在 position.initialQty，
  // 只读视角拿不到，用当前数量得到的是同比例的阶梯，方向与量级都正确）
  const baseQty = hasPosition ? position.qty : 0n;
  const startAvg = hasPosition ? position.entryPx : markWad;
  const startStop = recommended ? recommended.price : stopMid;
  const roll = {
    ladder: [],
    ready: false,
    triggerBps: cfg.risk.pyramidTriggerBps,
    maxAdds: cfg.risk.pyramidMaxAdds,
    ratioBps: cfg.risk.pyramidRatioBps,
    breakevenNow: hasPosition ? breakevenStop(startAvg, isLong, cfg.breakevenBufferBps) : null,
  };
  if (hasPosition && baseQty > 0n) {
    roll.ladder = rollLadder({
      baseQty,
      startQty: baseQty,
      startAvg,
      startStop,
      isLong,
      mark: markWad,
      equityWad,
      cfg,
    });
    roll.ready = canPyramid(startAvg, markWad, isLong, cfg.risk);

    /* 加仓的第二道门：回撤后有没有重新起势。
     *
     * 比特皇原话「浮盈加仓，是回撤在起势的时候加仓，让起势飞一会不要怕加晚」。
     * 只判「浮盈 ≥ 5%」是不够的 —— 那会把追高也算成合法加仓点，
     * 而「回撤还没收起来就往里加」更是「拉均价」的变种，正是他说的最愚蠢的行为。
     * 所以浮盈达标记为「够格」，起势判定记为「到点」，两者都成立才 `ready`。 */
    roll.resume = pullbackResumeRead(closes, isLong, cfg);
    roll.profitOk = roll.ready;
    roll.timingOk = roll.resume.resumed;
    roll.ready = roll.profitOk && roll.timingOk;
    // 浮盈百分比 = PnL / 名义价值 = (mark - avg) / avg，与合约 canPyramid 的判定口径一致
    const profit = unrealizedPnl(baseQty, startAvg, markWad, isLong);
    const notional = (baseQty * startAvg) / WAD;
    roll.profitWad = profit;
    roll.profitPct = notional > 0n ? Number((profit * 10000n) / notional) / 10000 : 0;
    roll.notionalNow = notional;
    if (!roll.ready) {
      // 分开报 —— 「浮盈不够」和「时候不到」是两个完全不同的原因，
      // 混成一句话会让人去调错参数。
      if (!roll.profitOk) {
        warnings.push(
          `浮盈未达 ${fmtBps(cfg.risk.pyramidTriggerBps)}，滚仓点未触发（当前 ` +
            `${(roll.profitPct * 100).toFixed(2)}%）：比特皇的加仓只加在盈利仓位上`
        );
      }
      if (!roll.timingOk) {
        warnings.push(`加仓时机未到（浮盈已够格）：${roll.resume.reason}`);
      }
    }
    // 滚仓是「顺势加仓」，所以判据必须来自**方向层**，而不是触发层 ——
    // 触发层只说明"现在有没有推进力"，不说明"这个方向还算不算数"。
    const rollAllowed = regime
      ? isLong
        ? regime.allowLong
        : regime.allowShort
      : isLong
        ? trig.side === 1
        : trig.side === -1;
    if (!rollAllowed) {
      warnings.push(
        regime
          ? `宏观方向「${regime.biasLabel}」不支持当前持仓方向，按规则此时不允许滚仓（只做顺势加仓）。`
          : `触发层当前没有与持仓同向的推进腿，按规则此时不允许滚仓（只做顺势加仓）。`
      );
    }

    /* 加仓同时降杠杆 —— 比特皇原话「加仓同时降低杠杆，资金量越大杠杆越低」。
     *
     * 这一条容易被忽略，因为它不是"能不能加"，而是"加完之后要不要动杠杆"。
     * 加仓本身就会推高实际杠杆（名义价值涨了、权益没涨），所以每一级加仓后
     * 都要重新对照档位表 —— 如果加完超了档位建议值，正确动作是减仓或降倍数，
     * 而不是"反正浮盈在，扛得住"。 */
    const tierLev = leverageFor(equityWad, tiers || [], cfg.leverageCap);
    const worstAfter = roll.ladder.reduce(
      (mx, l) => (mx === null || l.leverageAfter > mx.leverageAfter ? l : mx),
      null
    );
    roll.leverageTrim = {
      tierLeverage: tierLev,
      nowLeverage: equityWad > 0n ? Number((position.positionValue * 10000n) / equityWad) / 10000 : 0,
      afterLastAdd: worstAfter ? worstAfter.leverageAfter : null,
      /** 加完最后一级后是否需要降杠杆（或减仓） */
      needsTrim: !!(worstAfter && worstAfter.leverageAfter > tierLev),
      detail: worstAfter
        ? worstAfter.leverageAfter > tierLev
          ? `加完第 ${worstAfter.index} 级后实际杠杆升到 ${worstAfter.leverageAfter.toFixed(2)}x，高于当前权益档位建议的上限 ${tierLev}x —— ` +
            `按「加仓同时降低杠杆」，此时应减仓或调低倍数，而不是继续加。`
          : `加完最后一级后实际杠杆 ${worstAfter.leverageAfter.toFixed(2)}x，仍在档位建议的 ${tierLev}x 以内 —— 杠杆纪律未被破坏。`
        : '没有加仓阶梯可算（持仓量为 0）。',
    };
    if (roll.leverageTrim.needsTrim) warnings.push(`杠杆纪律：${roll.leverageTrim.detail}`);

    /* 加仓预算：任何一级加仓后，若最坏亏损（止损已上移到保本，所以这通常是
     * 缓冲量级的擦伤）超过了权益预算，必须出声 —— 正确的动作是减仓或降杠杆，
     * 而不是硬加。此前保本止损站在盈利侧，最坏亏损恒为 0，这条检查从不触发。 */
    const overBudget = roll.ladder.filter((l) => !l.passesBudget);
    if (overBudget.length) {
      warnings.push(
        `加仓预算不合格：第 ${overBudget.map((l) => l.index).join('、')} 级加仓后最坏亏损` +
          overBudget
            .map((l) => {
              const pct = equityWad > 0n && l.worstCaseLoss !== null ? Number((l.worstCaseLoss * 10000n) / equityWad) / 10000 : 0;
              return ` ${(pct * 100).toFixed(2)}%`;
            })
            .join('、') +
          ` 权益，超过上限 ${fmtBps(cfg.maxAddsRiskBps)} —— 这一级对应减仓或降杠杆，而不是硬加。`
      );
    }
  }

  /* ─────────────── 止盈点 ─────────────── */

  const mm = measuredMove(closes, trend, isLong, cfg.trendLookbackBars);
  const entryForR = hasPosition ? position.entryPx : markWad;
  const rRef = recommended ? recommended.price : stopMid;
  const rUnit = entryForR > rRef ? entryForR - rRef : rRef - entryForR;
  const rMultiples = [1, 2, 3].map((r) => {
    const price = isLong ? entryForR + rUnit * BigInt(r) : entryForR - rUnit * BigInt(r);
    const moveBps = entryForR > 0n ? Number(((price > entryForR ? price - entryForR : entryForR - price) * BPS) / entryForR) : 0;
    return { r, price, moveBps, movePct: moveBps / 100 };
  });

  /* 第二条离场路径：「价格调整后没有反弹」。
   *
   * 比特皇原话：「永远不要在最高点卖出，而是等到价格调整后没有反弹再卖出。」
   * 这一条替代的正是「手动猜顶」—— 顶猜不准，但「调整之后有没有反弹」是可观测的。
   * 只有持仓时才评估：没有仓位就没有『卖出』这回事。 */
  const failedBounce = hasPosition
    ? failedBounceRead(closes, isLong, cfg)
    : { ...failedBounceRead([], isLong, cfg), reason: '当前无持仓，离场信号不适用。' };

  const takeProfit = {
    measuredMove: mm,
    rMultiples,
    entryForR,
    rUnit,
    bandTrail: {
      upper: bands.upper,
      lower: bands.lower,
      // 轨道作为动态离场参考：多头跌破中轨即视为趋势破坏
      exitTrigger: bands.mid,
    },
    failedBounce,
    takeProfitBps: cfg.takeProfitBps,
    note:
      cfg.takeProfitBps > 0
        ? `已配置固定止盈 ${fmtBps(cfg.takeProfitBps)}`
        : '比特皇不设固定止盈 —— 主张「持仓到趋势结束」「利润不要吃顶部和底部」。给出的是参考位，真正离场看两条：收盘跌破中轨（趋势破坏）或「调整后没有反弹」。',
  };

  /* ─────────────── 离场信号汇总（阶段三的出口） ───────────────
   *
   * 四条离场路径，紧急度不同 —— 分清这一点很重要，因为它们的执行方式不一样：
   *   IMMEDIATE  止损击穿：用**标记价**实时判，市价走。
   *              这是「开单后亏损应该恐惧立马止损」的落点，也是最容易被漏掉的一条 ——
   *              它不在 exitSignals 里时，价格真打穿止损、编排层却仍报「持有中，无待办动作」。
   *   IMMEDIATE  重大利空：不等技术位，市价走。抢在技术位之前。
   *   ON_CLOSE   收盘跌破中轨：趋势破坏，收盘确认后走。
   *   WATCH      调整后没有反弹：进入观察，触发了才走。
   *
   * 止损击穿与 bandBroken 判据不同（标记价 vs 最新收盘），不能互相顶替。
   * 把它们混成一句「该走了」会丢掉紧急度这个信息 —— 而紧急度决定了
   * 是市价单还是收盘价单，这两者在跳空行情里差很多。
   */
  const lastClose = closes.length ? closes[closes.length - 1] : null;
  const bandBroken =
    hasPosition && lastClose !== null && bands.mid > 0n
      ? isLong
        ? lastClose < bands.mid
        : lastClose > bands.mid
      : false;
  const newsExit = hasPosition
    ? adverseNewsExit({ regime, isLong, cfg })
    : { available: !!regime, active: false, items: [], shockActive: false, reason: '当前无持仓，离场通道不适用。' };

  const exitSignals = {
    applicable: hasPosition,
    /* 第一条离场通道：止损被击穿。
     *
     * 它和 bandBroken 不是一回事，也**不能**被 bandBroken 顶替：
     *   · stopBreached 用**标记价**（盘中实时），紧急度 IMMEDIATE ——
     *     对应「开单后亏损应该恐惧立马止损」，走市价单；
     *   · bandBroken 用**最新收盘**，紧急度 ON_CLOSE —— 等收盘确认趋势破坏。
     * 此前这条根本不在 exitSignals 里，于是价格真打穿止损时编排层仍然是
     * bottleneck=HOLD、「持有中，无待办动作」，而预警那边已经在喊「按规则应离场」。
     * 更糟的是当时 breached 恒为 false，连「已击穿」这个徽标都点不亮。 */
    stopBreached: {
      active: !!(hasPosition && breached),
      trigger: structural ? structural.price : null,
      label: structural ? structural.label : null,
      detail:
        structural
          ? breached
            ? `标记价已${isLong ? '跌破' : '涨破'}${structural.label} ${fmtPrice(structural.price)} —— 按规则立马止损，不要把止损往${isLong ? '下' : '上'}挪。`
            : `标记价仍在${structural.label} ${fmtPrice(structural.price)} 的安全侧，止损未击穿。`
          : '缺少结构位止损，无法判断击穿。',
    },
    bandBroken: {
      active: bandBroken,
      trigger: bands.mid,
      detail: bandBroken
        ? `最新收盘 ${fmtPrice(lastClose)} 已${isLong ? '跌破' : '涨破'}中轨 ${fmtPrice(bands.mid)} —— 趋势被破坏，收盘确认后离场。`
        : `最新收盘仍在中轨${isLong ? '上方' : '下方'}（${fmtPrice(bands.mid)}），趋势尚未破坏。`,
    },
    failedBounce,
    newsExit,
    active: hasPosition
      ? !!(breached || bandBroken || failedBounce.failedBounce || newsExit.active)
      : false,
  };

  exitSignals.urgency = !hasPosition
    ? 'NONE'
    : newsExit.active
      ? 'IMMEDIATE'
      : breached
        ? 'IMMEDIATE'
        : bandBroken || failedBounce.failedBounce
          ? 'ON_CLOSE'
          : 'WATCH';

  if (hasPosition) {
    if (exitSignals.urgency === 'IMMEDIATE') {
      // 两条 IMMEDIATE 通道必须分开报 —— 混成一句会让人以为是消息面触发的
      exitSignals.summary = newsExit.active
        ? `立即离场：${newsExit.reason}`
        : exitSignals.stopBreached.detail;
    } else if (exitSignals.urgency === 'ON_CLOSE') {
      exitSignals.summary = bandBroken
        ? `收盘离场：${exitSignals.bandBroken.detail}`
        : `收盘离场：${failedBounce.reason}`;
    } else {
      exitSignals.summary = '暂不离场：趋势未破坏、消息面无反向重事件、调整后也有反弹。';
    }
  } else {
    exitSignals.summary = '无持仓 —— 阶段三的离场通道不适用。';
  }

  /* ─────────────── 风险敞口 ─────────────── */

  const risk = {
    equity: equityWad,
    riskBudget,
    exposure: hasPosition ? position.positionValue : 0n,
    exposurePct: equityWad > 0n && hasPosition ? Number((position.positionValue * 10000n) / equityWad) / 10000 : 0,
    effectiveLeverage:
      equityWad > 0n && hasPosition ? Number((position.positionValue * 10000n) / equityWad) / 10000 : 0,
    liqPrice: hasPosition ? position.liquidationPx : null,
    distToLiqPct: null,
    marginUsed: hasPosition ? position.marginUsed : 0n,
    riskAtStop: hasPosition && recommended ? lossAtPrice(position.qty, position.entryPx, recommended.price, isLong) : null,
  };
  if (risk.riskAtStop !== null && equityWad > 0n) {
    risk.riskAtStopPct = Number((risk.riskAtStop * 10000n) / equityWad) / 10000;
  }
  if (hasPosition && position.liquidationPx && markWad > 0n) {
    const d = isLong ? markWad - position.liquidationPx : position.liquidationPx - markWad;
    risk.distToLiqPct = Number((d * 10000n) / markWad) / 10000;
  }
  if (risk.effectiveLeverage > cfg.leverageCap) {
    warnings.push(
      `实际杠杆 ${risk.effectiveLeverage.toFixed(2)}x 超过配置上限 ${cfg.leverageCap}x`
    );
  }

  /* ─────────────── 开单计划（无持仓时给出） ─────────────── */

  let entryPlan = null;
  // 开单计划的存在条件：
  //   · 接了宏观层（regime 非空）→ 方向必须明确（dirDecided）且有推进腿，
  //     并且最终由 gate() 决定放不放行 —— 这正是两套系统的交汇点；
  //   · 没接宏观层（老的调用方 / 老的测试）→ 沿用旧口径，保持向后兼容。
  //     ⚠️ 这条兼容分支走的是"三次突破即方向"的老逻辑，只有老调用方会命中。
  const dirDecided = dirSource === 'position' || dirSource === 'regime';
  const gateResult = regime ? gate({ regime, setup: trig, cfg, markWad }) : null;
  const canPlan = regime ? dirDecided && trig.side !== 0 : trend.direction !== 0;

  if (!hasPosition && canPlan) {
    const lev = leverageFor(equityWad, tiers || [], cfg.leverageCap);
    const size = initialSize(equityWad, markWad, stopMid, lev, cfg.risk);
    const breakQty = (size.qty * BigInt(cfg.risk.breakBatchBps)) / BPS;
    const pullbackQty = size.qty - breakQty;
    const targetPrice = mm ? mm.target : null;
    const projectedMoveBps =
      targetPrice && markWad > 0n
        ? Number((((targetPrice > markWad ? targetPrice - markWad : markWad - targetPrice) * BPS) / markWad))
        : 0;
    const reward = targetPrice ? (targetPrice > markWad ? targetPrice - markWad : markWad - targetPrice) : 0n;
    const rz = markWad > stopMid ? markWad - stopMid : stopMid - markWad;
    const floor = phaseFloorBps(cfg.cyclePhase);
    entryPlan = {
      isLong,
      leverage: lev,
      entryPrice: markWad,
      stopPrice: stopMid,
      stopDistanceBps: distanceBps(markWad, stopMid),
      totalQty: size.qty,
      breakQty,
      pullbackQty,
      notional: size.notional,
      lossAtStop: size.lossAtStop,
      lossPctEquity: equityWad > 0n ? Number((size.lossAtStop * 10000n) / equityWad) / 10000 : 0,
      cappedByLeverage: size.cappedByLeverage,
      targetPrice,
      projectedMoveBps,
      projectedMovePct: projectedMoveBps / 100,
      requiredMoveBps: cfg.risk.minExpectedMoveBps,
      passMoveGate: projectedMoveBps >= cfg.risk.minExpectedMoveBps,
      rewardRiskBps: rz === 0n ? 0 : Number((reward * BPS) / rz),
      phaseFloorBps: floor,
      phase: cfg.cyclePhase,
      phaseLabel: PHASE_LABELS[cfg.cyclePhase] || cfg.cyclePhase,
    };
    entryPlan.trigger = trig;
    entryPlan.gate = gateResult;

    /* 这套计划到不到"能下单"的程度。
     *
     * ⚠️ 为什么必须显式标出来：上面的 canPlan 只要求「方向已定 + 有推进腿」，
     * 并不要求门禁放行。也就是说 regime 说 NEUTRAL 时，entryPlan 照样会被算出来 ——
     * 字段齐全、价格齐全，只是旁边挂了一条 warning。
     * 读的人（和界面上的人）很容易把"算出来了"当成"可以做了"。
     * 所以这里给一个明确的开关，并且下面每一笔的 active 都受它约束。 */
    /* 可执行 = 三道硬门槛全部通过：
     *   ① 门禁放行（方向层 × 触发层）—— 唯一一个以前真拦过 executable 的；
     *   ② 可得空间 ≥ 相位门槛（passMoveGate）；
     *   ③ 盈亏比 ≥ minRewardRiskBps（passRewardGate）。
     * 后两道以前只算出来、只喊了句"拒绝开仓"的警告，从没接到 executable 上 ——
     * 等于警告白喊。这里补齐，并用 blockedBy 数组把每一道没过门槛的原因都列出来。 */
    const gateOk = gateResult ? gateResult.state === 'SIGNAL' : true;
    const rewardRiskOk = entryPlan.rewardRiskBps >= (cfg.minRewardRiskBps ?? 10000);
    const executable = gateOk && entryPlan.passMoveGate && rewardRiskOk;
    entryPlan.executable = executable;
    entryPlan.passRewardGate = rewardRiskOk;
    const reasons = [];
    if (!gateOk) {
      reasons.push(`门禁未放行（${gateResult.state}）：${gateResult.reason}`);
    }
    if (!entryPlan.passMoveGate) {
      reasons.push(
        `可得空间不足：量出的区间投影只有 ${entryPlan.projectedMovePct.toFixed(2)}%，` +
          `低于「${entryPlan.phaseLabel}」相位的门槛 ${fmtBps(cfg.risk.minExpectedMoveBps)}`
      );
    }
    if (!rewardRiskOk) {
      reasons.push(
        `盈亏比不足：${(entryPlan.rewardRiskBps / 10000).toFixed(2)} : 1，` +
          `低于要求 ≥ ${((cfg.minRewardRiskBps ?? 10000) / 10000).toFixed(2)} : 1`
      );
    }
    entryPlan.blockedBy = executable ? null : reasons;

    /* ── 分两笔执行（比特皇原话：「突破时买 30%，回调时买 70%」）──
     *
     * 为什么必须分成两笔、而且两笔的止损**不一样**：
     *   头仓走突破位止损 —— 突破失败就立刻走，这正是「突破后回撤回去立马止损」。
     *   主仓走中轨止损 —— 它的入场理由是"中轨撑住了"，中轨破了理由就没了。
     * 用同一个止损管两笔，会同时犯两个错：头仓的止损太远（亏损被放大），
     * 主仓的止损太近（一次正常回踩就被洗出去）。
     *
     * 「头仓试错」的含义也在这里：头仓小（30%）、先上、错了立刻止损。
     * 头仓止损 = 这批形态作废，但推进腿计数保留 —— 「再次突破再次开单」。
     */
    const pbStopRef = trig.pullback?.stopRef ?? bands.mid;
    const stopBuf = BigInt(cfg.risk.stopBufferBps);
    const pbLimit =
      isLong
        ? bands.mid + (bands.mid * stopBuf) / BPS // 做多：挂在略高于中轨处等回踩
        : bands.mid - (bands.mid * stopBuf) / BPS;
    const pbStop = stopFromReference(pbStopRef, isLong, cfg.risk.stopBufferBps);

    entryPlan.tranches = [
      {
        index: 1,
        name: '头仓（突破批次）',
        side: 'BREAKOUT',
        ratioBps: cfg.risk.breakBatchBps,
        qty: breakQty,
        // 头仓的触发条件是「突破成立」——已经到了，所以就是现价
        triggerPrice: markWad,
        triggerKind: 'MARKET',
        stopPrice: gateResult?.stopRef ?? stopFromReference(trig.hold?.refPrice ?? stopMid, isLong, cfg.risk.stopBufferBps),
        stopAnchor: '突破参考位外侧',
        active: entryPlan.executable && trig.breakoutOk === true,
        reachable: true,
        detail: trig.breakoutOk
          ? '突破 + 站稳已成立，按现价入头仓。止损锚在突破位外侧 —— 收回轨内就走。'
          : `突破条件尚未成立（${(trig.blockers || []).join('；') || '见 blocker'}），头仓先不挂。`,
      },
      {
        index: 2,
        name: '主仓（回调批次）',
        side: 'PULLBACK',
        ratioBps: cfg.risk.pullbackBatchBps,
        qty: pullbackQty,
        // 主仓挂在略高于中轨处等回踩，不是现价追
        triggerPrice: pbLimit,
        triggerKind: 'LIMIT',
        stopPrice: pbStop,
        stopAnchor: '中轨外侧',
        active: entryPlan.executable && trig.pullback?.available === true,
        reachable: trig.pullback?.available === true,
        detail: trig.pullback?.available
          ? `已回踩中轨不破并重新起势 —— 主仓可以挂在中轨外侧 ${fmtBps(cfg.risk.stopBufferBps)} 的 ${fmtPrice(pbLimit)} 上等回踩。`
          : `回调入场未成立：${trig.pullback?.reason || '无回踩读数'}。强势不回调时这一笔可能一直挂不上 —— 比特皇的原话是「不踏空也不追高满仓」，挂不上就不成交，不改成追高。`,
      },
    ];
    entryPlan.trancheNote =
      '「突破买 30%、回调买 70%」按两笔执行，各自独立止损。头仓止损即本批形态作废，' +
      '但推进腿计数保留 —— 比特皇：「突破后回撤回去立马止损。再次突破再次开单」。';

    if (!entryPlan.passMoveGate) {
      warnings.push(
        `可得空间不足：K 线量出的区间投影只有 ${entryPlan.projectedMovePct.toFixed(2)}%，` +
          `低于「${entryPlan.phaseLabel}」相位的门槛 ${fmtBps(cfg.risk.minExpectedMoveBps)} —— 拒绝开仓`
      );
    }
    if (!entryPlan.passRewardGate) {
      warnings.push(
        `盈亏比不足：${(entryPlan.rewardRiskBps / 10000).toFixed(2)} : 1，` +
          `低于要求 ≥ ${((cfg.minRewardRiskBps ?? 10000) / 10000).toFixed(2)} : 1 —— 拒绝开仓`
      );
    }
    if (gateResult && gateResult.state !== 'SIGNAL') {
      warnings.push(`门禁未放行（${gateResult.state}）：${gateResult.reason}`);
    }
  } else if (!hasPosition) {
    if (regime && !dirDecided) {
      warnings.push(
        `方向未定（宏观层输出「${regime.biasLabel}」），不出开单计划 —— 方向没确认之前就不该有仓位。` +
          (regime.reasons?.[0] ? `原因：${regime.reasons[0]}` : '')
      );
    } else if (trig.side === 0) {
      warnings.push(`触发层没有推进腿（${trig.reason}），当前不开仓`);
    }
  }

  return {
    coin,
    mark: markWad,
    hasPosition,
    isLong,
    dirSource,
    dirUndecided,
    trend,
    /** 系统二：触发状态（推进腿 / 收口 / 站稳等级），不声称方向 */
    trigger: trig,
    /** 系统一：宏观方向层读数（可能为 null —— 老调用方不传） */
    regime,
    /** 两套系统的交汇结论：SIGNAL / ARMED / VETOED / IDLE */
    gate: gateResult,
    bands,
    stop: {
      candidates,
      recommended,
      /** 结构位参考（中轨优先）。breached 由它判定，不由 recommended 判定 */
      structural,
      breached,
      anchor,
      riskBudget,
      stopHardCap,
      stopBudget,
    },
    roll,
    takeProfit,
     /** 阶段三的出口：四条离场通道 + 紧急度 */
    exitSignals,
    risk,
    entryPlan,
    warnings,
  };
}

/**
 * 把 Hyperliquid 的 assetPositions 元素解析成内部结构。
 *
 * ⚠️ 实测确认的坑：
 *   * szi 是有符号的 —— 负数代表空头；
 *   * liquidationPx 可能是 null（全仓保证金且保证金充足时接口不给），
 *     直接当数字用会到处出现 NaN；
 *   * leverage.type 说明是全仓还是逐仓，值就是杠杆倍数。
 */
export function parsePosition(assetPosition) {
  if (!assetPosition || !assetPosition.position) return null;
  const p = assetPosition.position;
  const szi = parseWad(p.szi);
  if (szi === 0n) return null;
  return {
    coin: p.coin,
    raw: p,
    szi,
    qty: szi < 0n ? -szi : szi,
    isLong: szi > 0n,
    entryPx: parseWad(p.entryPx),
    positionValue: parseWad(p.positionValue),
    unrealizedPnl: parseWad(p.unrealizedPnl),
    returnOnEquity: p.returnOnEquity ? Number(p.returnOnEquity) : null,
    liquidationPx: p.liquidationPx === null || p.liquidationPx === undefined ? null : parseWad(p.liquidationPx),
    marginUsed: parseWad(p.marginUsed),
    maxLeverage: p.maxLeverage ?? null,
    leverage: p.leverage || null,
    cumFunding: p.cumFunding
      ? {
          allTime: parseWad(p.cumFunding.allTime),
          sinceOpen: parseWad(p.cumFunding.sinceOpen),
          sinceChange: parseWad(p.cumFunding.sinceChange),
        }
      : null,
    marginMode: p.leverage?.type || null,
  };
}
