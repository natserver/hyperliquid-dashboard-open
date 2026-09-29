/**
 * 端到端自检 —— 打自己的聚合接口，并断言策略读数的内部一致性。
 *
 *   node tools/selftest.js                          # 用 HLP 子金库（持仓多，压力测试）
 *   node tools/selftest.js 0x你的地址
 *   node tools/selftest.js 0x地址 testnet
 *   node tools/selftest.js 0x地址 mainnet 8787
 *
 * 为什么要断言而不只是「跑通」：接口能返回数据，不代表数字是对的。
 * 滚仓量必须逐级递减、触发价必须逐级抬升、止损必须落在正确的一侧 ——
 * 这些不变式一旦破了，界面上看不出异常，但决策会被带偏。
 */

const BASE = `http://127.0.0.1:${process.argv[4] || 8787}`;
const DEFAULT_ADDR = '0x010461c14e146ac35fe42271bdc1134ee31c703a'; // HLP Strategy A，公开协议金库

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`   ✓ ${name}`);
  } else {
    fail += 1;
    failures.push(`${name}${detail ? ' — ' + detail : ''}`);
    console.log(`   ✗ ${name}${detail ? '  → ' + detail : ''}`);
  }
}

const bi = (s) => BigInt(s ?? 0);

async function main() {
  const addr = process.argv[2] || DEFAULT_ADDR;
  const network = process.argv[3] || 'mainnet';

  console.log('='.repeat(78));
  console.log(`端到端自检   ${BASE}   网络=${network}`);
  console.log(`地址         ${addr}`);
  console.log('='.repeat(78));

  // ── 1. 健康检查
  console.log('\n[1] 服务健康');
  const health = await (await fetch(`${BASE}/api/health`)).json();
  check('服务在线', health.ok === true);
  check('声明为只读', health.readOnly === true);
  check('不持有任何密钥', health.holdsKeys === false);
  check('支持主网与测试网', health.networks?.length === 2);

  // ── 2. 聚合快照
  console.log('\n[2] 聚合快照');
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/snapshot?network=${network}&user=${addr}&coin=BTC&phase=ACCUMULATION`);
  const snap = await res.json();
  const ms = Date.now() - t0;
  console.log(`   耗时 ${ms}ms  HTTP ${res.status}`);
  check('快照构建成功', snap.ok === true, snap.error || '');
  if (!snap.ok) {
    console.log('\n阻断性失败，后续断言跳过。warnings:');
    (snap.warnings || []).forEach((w) => console.log('   -', w));
    return finish();
  }

  check('账户权益可解析', typeof snap.account.accountValue === 'string' && snap.account.accountValue !== '');
  check('权益曲线非空', Array.isArray(snap.equityCurve?.equity) && snap.equityCurve.equity.length > 0);
  check('最大回撤已计算', snap.equityCurve?.maxDrawdown != null);
  check('持仓已解析', Array.isArray(snap.positions));
  check('K 线已拉取', Object.keys(snap.candles).length > 0);
  check('绩效已归集', typeof snap.summary?.fills?.count === 'number');
  check(
    '权益曲线做了降采样上限',
    !snap.equityCurve || snap.equityCurve.equity.length <= 401,
    `实际 ${snap.equityCurve?.equity.length}`
  );

  // 回撤口径：必须用盈亏空间算，否则一笔提现会被当成巨额回撤
  const dd = snap.equityCurve?.maxDrawdown;
  check(
    '回撤使用盈亏空间口径（免疫出入金）',
    !dd || dd.method === 'pnl-space' || dd.includesTransfers === true,
    `method=${dd?.method}`
  );
  // 正确的不变式不是「回撤一定 ≤100%」，而是「≤100% 或者被显式标记为不可信」。
  // 权益快照接近 0、或成交落在 HIP-3 子账户上时，分母不是真实资金基数，
  // 百分比可以越过 100%（测试网某账户实测 164%）—— 此时后端必须给 plausible:false。
  // 只要这个标记与数值自洽，就是正确行为；标记缺失才是 bug。
  check(
    '回撤百分比在 [0,1]，或已显式标记不可信',
    !dd || (dd.pct >= 0 && dd.pct <= 1) || dd.plausible === false,
    `实际 ${dd?.pct} plausible=${dd?.plausible}`
  );
  check(
    '回撤标记与数值自洽（>100% 必须 plausible:false，且给出说明）',
    !dd || dd.pct <= 1 || (dd.plausible === false && !!dd.caveat),
    `pct=${dd?.pct} plausible=${dd?.plausible} caveat=${!!dd?.caveat}`
  );
  // 「没有回撤」不等于「分母失真」。若把 0% 也标成不可信，
  // 界面会渲染出「0.00% ⟨分母失真⟩ · 亏 $0.00」这种自相矛盾的噪声。
  check(
    '回撤为 0 时不标记为不可信',
    !dd || dd.pct > 0 || dd.plausible !== false,
    `pct=${dd?.pct} plausible=${dd?.plausible}`
  );

  // 绩效双口径
  const S = snap.summary;
  check('口径A（平仓成交）有样本', S?.closing?.count >= 0);
  check(
    '已实现盈亏 = 毛盈亏 - 手续费',
    bi(S.realizedNet) === bi(S.realizedGross) - bi(S.fees),
    `${S.realizedNet} vs ${S.realizedGross} - ${S.fees}`
  );
  check('口径B 给出了可信度标记', S?.cycles && typeof S.cycles.reliable === 'boolean');
  check(
    '口径B 不可信时必须给出说明',
    S.cycles.reliable === true || typeof S.cycles.note === 'string',
    `reliable=${S.cycles.reliable}`
  );
  check('成交窗口信息完整', S?.fills?.count > 0 && S.fills.spanDays !== null);

  console.log(`\n   账户权益 ${snap.account.accountValue}`);
  console.log(`   持仓 ${snap.positions.length} 个，其中 ${snap.positions.filter((p) => p.levels).length} 个算出策略读数`);
  console.log(
    `   [口径A 窗口无关] 平仓成交 ${S.closing.count} 笔，胜率 ${
      S.closing.winRate === null ? '—' : (S.closing.winRate * 100).toFixed(1) + '%'
    }，已实现净额 ${S.realizedNet}`
  );
  console.log(
    `   [口径B 持仓周期] 完整周期 ${S.cycles.closed} 笔，可信=${S.cycles.reliable}${
      S.cycles.note ? '（' + S.cycles.note.slice(0, 40) + '…）' : ''
    }`
  );
  console.log(`   成交窗口 ${S.fills.count} 笔 / ${S.fills.spanDays?.toFixed(2)} 天 / ${S.fills.coins} 个标的`);
  console.log(`   权益点 ${snap.equityCurve?.equity.length}，最大回撤 ${((dd?.pct || 0) * 100).toFixed(2)}%（口径 ${dd?.method}）`);
  console.log(`   挂单 ${snap.orders.length}，资金费流水 ${snap.funding.length}`);

  // ── 3. 策略读数不变式
  console.log('\n[3] 策略读数不变式');
  const withLevels = snap.positions.filter((p) => p.levels);
  check('至少一个持仓算出了读数', withLevels.length > 0);

  let bandOk = true;
  let stopSideOk = true;
  let rollMonotonic = true;
  let rollDecreasing = true;
  let rMonotonic = true;
  let rollCheckCount = 0;
  const problems = [];

  for (const p of withLevels) {
    const L = p.levels;
    const long = L.isLong;

    // 布林带顺序：上 ≥ 中 ≥ 下（下轨可为 0，那是极端波动下的合法语义）
    if (!(bi(L.bands.upper) >= bi(L.bands.mid) && bi(L.bands.mid) >= bi(L.bands.lower))) {
      bandOk = false;
      problems.push(`${p.coin}: 布林带顺序错误`);
    }

    // 推荐止损不得会被立刻触发（基准是当前标记价，不是开仓价）
    if (L.stop?.recommended) {
      const sp = bi(L.stop.recommended.price);
      const mark = bi(L.mark);
      if (long ? sp >= mark : sp <= mark) {
        stopSideOk = false;
        problems.push(`${p.coin}: 推荐止损会被立刻触发 (止损 ${sp} vs 标记价 ${mark})`);
      }
    }

    // 滚仓阶梯：触发价逐级抬升、加仓量逐级递减
    const ladder = L.roll?.ladder || [];
    for (let i = 1; i < ladder.length; i++) {
      rollCheckCount += 1;
      const prev = ladder[i - 1];
      const cur = ladder[i];
      const prevT = bi(prev.triggerPrice);
      const curT = bi(cur.triggerPrice);
      if (long ? curT <= prevT : curT >= prevT) {
        rollMonotonic = false;
        problems.push(`${p.coin}: 滚仓第${i + 1}级触发价未朝有利方向推进`);
      }
      if (bi(cur.addQty) >= bi(prev.addQty)) {
        rollDecreasing = false;
        problems.push(`${p.coin}: 滚仓第${i + 1}级加仓量未递减`);
      }
    }

    // R 倍数位必须单调
    const rm = L.takeProfit?.rMultiples || [];
    for (let i = 1; i < rm.length; i++) {
      if (long ? bi(rm[i].price) <= bi(rm[i - 1].price) : bi(rm[i].price) >= bi(rm[i - 1].price)) {
        rMonotonic = false;
        problems.push(`${p.coin}: R 倍数位未单调`);
      }
    }
  }

  check('布林带顺序正确（上≥中≥下）', bandOk);
  check('推荐止损不会被立刻触发', stopSideOk);
  check('滚仓触发价逐级推进', rollMonotonic);
  check('滚仓加仓量逐级递减（金字塔）', rollDecreasing);
  check('R 倍数位单调', rMonotonic);
  console.log(`   （共校验 ${withLevels.length} 个标的、${rollCheckCount} 组滚仓相邻级）`);
  if (problems.length) {
    console.log('\n   不变式问题明细：');
    problems.slice(0, 12).forEach((x) => console.log('     -', x));
  }

  // ── 4. 一个样本的完整读数
  const sample = withLevels[0];
  if (sample) {
    const L = sample.levels;
    console.log(`\n[4] 样本读数  ${sample.coin}  ${L.isLong ? '多' : '空'}`);
    console.log(`   数量 ${sample.qty}  开仓价 ${sample.entryPx}  清算价 ${sample.liquidationPx ?? '（接口未返回）'}`);
    console.log(`   趋势 ${L.trend.reason}`);
    console.log(`   布林 上 ${L.bands.upper} / 中 ${L.bands.mid} / 下 ${L.bands.lower}`);
    console.log('   止损候选：');
    for (const c of L.stop?.candidates || []) {
      console.log(
        `     ${c.label.padEnd(14)} ${String(c.price).padStart(24)}  距开仓 ${c.distancePct.toFixed(2)}%` +
          `  距离内 ${c.withinDistance ? '✓' : '✗'}  预算内 ${c.withinBudget === null ? '—' : c.withinBudget ? '✓' : '✗'}` +
          `${c.triggersImmediately ? '  ⚠会被立刻触发' : ''}` +
          `${c.onProfitSide && !c.notAStop ? '  ←已在盈利区' : ''}`
      );
    }
    console.log(`   推荐止损：${L.stop?.recommended ? L.stop.recommended.label + ' @ ' + L.stop.recommended.price : '无（无法满足约束）'}`);
    console.log(`   滚仓阶梯（浮盈 ≥${L.roll.triggerBps / 100}% 触发，当前 ${((L.roll.profitPct || 0) * 100).toFixed(2)}%）`);
    for (const a of L.roll?.ladder || []) {
      console.log(
        `     第${a.index}次  触发 ${String(a.triggerPrice).padStart(24)}  ` +
          `加量 ${String(a.addQty).padStart(18)} (基数 ${(a.sizePctOfBase / 100).toFixed(2)}%)  ` +
          `新止损 ${String(a.newStop).padStart(24)}  最坏亏损 ${String(a.worstCaseLoss).padStart(16)}  ${a.passesBudget ? '✓' : '✗超预算'}`
      );
    }
    console.log('   止盈参考位：');
    for (const r of L.takeProfit?.rMultiples || []) {
      console.log(`     ${r.r}R  ${String(r.price).padStart(24)}  （距入场 ${r.movePct.toFixed(2)}%）`);
    }
    if (L.takeProfit?.measuredMove) {
      const m = L.takeProfit.measuredMove;
      console.log(`     区间等幅投影  ${m.target}  （区间 ${m.low} ~ ${m.high}）`);
    }
    console.log(`   风险：敞口占比 ${((L.risk.exposurePct || 0) * 100).toFixed(1)}%  实际杠杆 ${L.risk.effectiveLeverage}x  距清算 ${L.risk.distToLiqPct == null ? '—' : (L.risk.distToLiqPct * 100).toFixed(2) + '%'}`);
  }

  // ── 5. 告警
  console.log('\n[5] 运行告警');
  if (!snap.warnings?.length) console.log('   （无）');
  else snap.warnings.slice(0, 15).forEach((w) => console.log('   -', w));

  finish();
}

function finish() {
  console.log('\n' + '='.repeat(78));
  console.log(`断言结果：通过 ${pass} 条，失败 ${fail} 条`);
  if (fail) {
    console.log('\n失败项：');
    failures.forEach((f) => console.log('  -', f));
  }
  console.log('='.repeat(78));
  /* 用 exitCode 而不是 process.exit()：本脚本发过几十个 fetch，undici 的连接池
   * 还没排空就强行 exit，会在 handle 仍然打开时终止事件循环 —— libuv 抛断言崩溃，
   * 退出码变成 127（而断言明明 27 条全过），于是 `npm test` 的 && 链断在这里，
   * 看起来像「自检挂了」。让连接自然回收即可。
   * 下面这个兜底 timer 用 unref()：正常情况它不阻止进程退出，只有真有连接
   * 不回收时才会在 5 秒后收场。 */
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 5000).unref();
}

main().catch((e) => {
  console.error('\n自检异常：', e.message);
  // 同上：异常路径也别用 process.exit() 强杀，否则退出码会被 libuv 断言覆盖成 127，
  // 把一次「说清楚了的失败」变成「看起来像崩溃」。
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 5000).unref();
});
