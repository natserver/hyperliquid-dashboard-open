/**
 * 数据契约检查 —— 验证前端读取的每个字段，在真实快照里确实存在且类型正确。
 *
 *   node tools/contract-check.js
 *   node tools/contract-check.js 0x地址 mainnet 8787
 *
 * 为什么需要这个：前端最容易出的 bug 不是崩溃，而是**字段名写错导致渲染出 undefined**
 * 或 NaN。页面照样能打开、不报错，但数字是错的 —— 这类问题肉眼极难发现。
 *
 * 本工具做两件事：
 *   1. 从 public/app.js 里正则抽出所有 `s.xxx` 形式的快照字段引用，逐条解析；
 *   2. 再对照一份人工维护的深层路径清单（positions[].levels.stop... 这类），
 *      覆盖嵌套结构 —— 正则抽不到这些。
 *
 * 路径语法：`a.b.c` 取值；`[*]` 表示「遍历数组的每个元素」；`<coin>` 表示动态键名。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BASE = `http://127.0.0.1:${process.argv[4] || 8787}`;
const ADDR = process.argv[2] || '0x010461c14e146ac35fe42271bdc1134ee31c703a';
const NET = process.argv[3] || 'mainnet';

/**
 * 深层路径清单。每一项：[路径, 该字段在界面上的用途]
 * 路径里 `[*]` = 数组每个元素；`<>` 包裹的片段表示同名对象，如 `levels`。
 */
const DEEP_PATHS = [
  // ── 持仓
  ['positions[*].coin', '持仓表标的'],
  ['positions[*].qty', '持仓数量'],
  ['positions[*].isLong', '多空方向'],
  ['positions[*].entryPx', '开仓价'],
  ['positions[*].markPx', '标记价'],
  ['positions[*].liquidationPx', '清算价（可为 null）'],
  ['positions[*].leverage.value', '杠杆倍数'],
  ['positions[*].leverage.type', '全仓/逐仓'],
  ['positions[*].unrealizedPnl', '未实现盈亏'],
  ['positions[*].positionValue', '名义价值'],
  ['positions[*].marginUsed', '占用保证金'],
  ['positions[*].returnOnEquity', 'ROE'],
  ['positions[*].cumFunding.sinceOpen', '自开仓资金费'],
  ['positions[*].cumFunding.allTime', '历史累计资金费'],
  ['positions[*].levels', '策略读数（无此字段则持仓行不可展开）'],

  // ── 策略读数：趋势
  ['levels.trend.direction', '趋势方向（0 未确认）'],
  ['levels.trend.longBreaks', '向上突破计数'],
  ['levels.trend.shortBreaks', '向下突破计数'],
  ['levels.trend.required', '所需突破次数'],
  ['levels.trend.reason', '趋势状态文案'],
  ['levels.trend.marks[*].index', 'K 线上的突破标记位置'],
  ['levels.trend.marks[*].side', '突破标记方向'],
  ['levels.bands.upper', '布林上轨'],
  ['levels.bands.mid', '布林中轨'],
  ['levels.bands.lower', '布林下轨'],
  ['levels.mark', '标记价'],
  ['levels.isLong', '持仓/候选方向'],
  ['levels.hasPosition', '是否有持仓'],

  // ── 策略读数：止损
  ['levels.stop.anchor', '止损计算基准价'],
  ['levels.stop.riskBudget', '单笔风险预算'],
  ['levels.stop.breached', '止损是否已击穿'],
  ['levels.stop.recommended.label', '推荐止损的依据名'],
  ['levels.stop.recommended.price', '推荐止损价'],
  ['levels.stop.recommended.distancePct', '推荐止损距开仓百分比'],
  ['levels.stop.recommended.loss', '推荐止损触发时的亏损额'],
  ['levels.stop.recommended.lossPctEquity', '亏损占权益比例'],
  ['levels.stop.candidates[*].label', '止损候选依据'],
  ['levels.stop.candidates[*].price', '止损候选价'],
  ['levels.stop.candidates[*].distancePct', '距开仓百分比'],
  ['levels.stop.candidates[*].loss', '触发亏损'],
  ['levels.stop.candidates[*].lossPctEquity', '占权益比例'],
  ['levels.stop.candidates[*].withinDistance', '是否在 12% 距离内'],
  ['levels.stop.candidates[*].withinBudget', '是否在 5% 预算内'],
  ['levels.stop.candidates[*].triggersImmediately', '是否会被立刻触发'],
  ['levels.stop.candidates[*].notAStop', '是否仅为风险边界而非结构位'],
  ['levels.stop.candidates[*].onProfitSide', '是否已在盈利区'],

  // ── 策略读数：滚仓
  ['levels.roll.ready', '是否已达加仓阈值'],
  ['levels.roll.triggerBps', '加仓触发阈值'],
  ['levels.roll.ratioBps', '首档加仓比例'],
  ['levels.roll.maxAdds', '最大加仓次数'],
  ['levels.roll.profitPct', '当前浮盈百分比'],
  ['levels.roll.notionalNow', '当前名义价值'],
  ['levels.roll.ladder[*].index', '档位序号'],
  ['levels.roll.ladder[*].triggerPrice', '该档触发价'],
  ['levels.roll.ladder[*].reached', '是否已触发'],
  ['levels.roll.ladder[*].addQty', '该档加仓量'],
  ['levels.roll.ladder[*].sizePctOfBase', '占初始量的比例'],
  ['levels.roll.ladder[*].newAvg', '加仓后均价'],
  ['levels.roll.ladder[*].newStop', '加仓后止损位'],
  ['levels.roll.ladder[*].worstCaseLoss', '加仓后最坏亏损'],
  ['levels.roll.ladder[*].passesBudget', '是否通过预算校验'],

  // ── 策略读数：止盈
  ['levels.takeProfit.note', '止盈口径说明'],
  ['levels.takeProfit.rMultiples[*].r', 'R 倍数'],
  ['levels.takeProfit.rMultiples[*].price', 'R 倍数对应价格'],
  ['levels.takeProfit.rMultiples[*].movePct', '距入场百分比'],
  ['levels.takeProfit.measuredMove.target', '区间等幅投影目标'],
  ['levels.takeProfit.measuredMove.low', '回看窗口最低点'],
  ['levels.takeProfit.measuredMove.high', '回看窗口最高点'],
  ['levels.takeProfit.bandTrail.exitTrigger', '动态离场触发位（中轨）'],

  // ── 策略读数：风险
  ['levels.risk.exposure', '名义敞口'],
  ['levels.risk.exposurePct', '敞口占权益'],
  ['levels.risk.effectiveLeverage', '实际杠杆'],
  ['levels.risk.distToLiqPct', '距清算百分比（可为 null）'],
  ['levels.risk.riskAtStop', '止损触发亏损'],
  ['levels.risk.riskAtStopPct', '止损亏损占权益'],
  ['levels.risk.marginUsed', '占用保证金'],

  // ── 开单计划
  ['levels.entryPlan.isLong', '计划方向'],
  ['levels.entryPlan.leverage', '计划杠杆'],
  ['levels.entryPlan.entryPrice', '入场参考价'],
  ['levels.entryPlan.stopPrice', '计划止损位'],
  ['levels.entryPlan.stopDistanceBps', '止损距离'],
  ['levels.entryPlan.totalQty', '计划总量'],
  ['levels.entryPlan.breakQty', '突破批次量'],
  ['levels.entryPlan.pullbackQty', '回调批次量'],
  ['levels.entryPlan.lossAtStop', '止损全额亏损'],
  ['levels.entryPlan.lossPctEquity', '占权益比例'],
  ['levels.entryPlan.projectedMovePct', '可得空间百分比'],
  ['levels.entryPlan.requiredMoveBps', '相位门槛'],
  ['levels.entryPlan.passMoveGate', '是否通过可得空间门槛'],
  ['levels.entryPlan.passRewardGate', '是否通过盈亏比门槛'],
  ['levels.entryPlan.rewardRiskBps', '盈亏比'],
  ['levels.entryPlan.phaseLabel', '相位名称'],
  ['levels.entryPlan.phaseFloorBps', '相位下限'],

  // ── 账户与配置
  ['account.accountValue', '账户权益'],
  ['account.withdrawable', '可提现'],
  ['account.marginUsed', '保证金占用'],
  ['account.maintenanceMargin', '维持保证金'],
  ['account.marginRatio', '保证金使用率'],
  ['account.userVlm14d', '近 14 日成交量'],
  ['account.feeRates.cross', '吃单费率'],
  ['account.feeRates.add', '挂单费率'],
  ['config.risk.riskPerTradeBps', '单笔风险预算'],
  ['config.risk.stopBufferBps', '止损缓冲'],
  ['config.risk.breakBatchBps', '突破批次比例'],
  ['config.risk.pullbackBatchBps', '回调批次比例'],
  ['config.risk.pyramidTriggerBps', '加仓触发阈值'],
  ['config.risk.minExpectedMoveBps', '最小可得空间门槛'],
  ['config.risk.maxStopDistanceBps', '止损距离上限'],
  ['config.leverageCap', '杠杆上限'],
  ['config.minRewardRiskBps', '盈亏比要求'],
  ['config.maxAddsRiskBps', '加仓风险预算'],
  ['config.takeProfitBps', '固定止盈配置'],
  ['config.phaseLabel', '当前相位名称'],
  ['config.phaseFloorBps', '当前相位下限'],
  ['config.availablePhases[*].key', '可选相位'],
  ['config.availablePhases[*].label', '相位显示名'],
  ['config.availablePhases[*].floorBps', '相位门槛'],

  /* ── 周期相位对账
   * 前端 ⑦ 段据此决定显示「自动（按时钟推算）」还是「对账不一致」。
   * 这些字段写在 `pc.xxx` 上，而上面那个自动扫 `s.xxx` 的抽取器看不见 `pc.` ——
   * 所以必须在这里显式登记，否则哪天服务端把 phaseCheck 改个形状，
   * 前端会安静地退化成"什么都不显示"，而契约测试还是绿的。
   * manual / requested 在自动模式下是 null（null 是合法值，不算缺失）。 */
  ['phaseCheck.phase', '实际生效的相位'],
  ['phaseCheck.derived', '减半时钟推算的相位'],
  ['phaseCheck.derivedLabel', '推算相位的中文名'],
  ['phaseCheck.auto', '是否自动（按减半时钟）'],
  ['phaseCheck.stale', '人工与推算是否不一致'],
  ['phaseCheck.manual', '人工指定值（自动模式下为 null）'],
  ['phaseCheck.requested', '原始输入（自动模式下为 null）'],
  ['phaseCheck.unknown', '是否传入了不认识的相位'],
  ['phaseCheck.monthsSince', '距上次减半的月数'],

  // ── 权益曲线与绩效
  ['equityCurve.equity[*].t', '权益曲线时间戳'],
  ['equityCurve.equity[*].v', '权益曲线数值'],
  ['equityCurve.maxDrawdown.pct', '最大回撤'],
  ['equityCurve.maxDrawdown.method', '回撤计算口径'],
  ['summary.realizedGross', '毛已实现盈亏'],
  ['summary.fees', '手续费合计'],
  ['summary.fundingNet', '资金费净额'],
  ['summary.realizedNet', '已实现净额'],
  ['summary.closing.count', '平仓成交笔数'],
  ['summary.closing.wins', '盈利笔数'],
  ['summary.closing.losses', '亏损笔数'],
  ['summary.closing.winRate', '平仓胜率'],
  ['summary.closing.grossWin', '盈利总额'],
  ['summary.closing.grossLoss', '亏损总额'],
  ['summary.closing.avgWin', '平均盈利'],
  ['summary.closing.avgLoss', '平均亏损'],
  ['summary.closing.payoffRatio', '盈亏比'],
  ['summary.closing.profitFactor', '利润因子'],
  ['summary.cycles.reliable', '周期口径可信度'],
  ['summary.cycles.closed', '完整周期数'],
  ['summary.cycles.open', '未平仓数'],
  ['summary.cycles.winRate', '周期胜率'],
  ['summary.cycles.longestWinStreak', '最长连胜'],
  ['summary.cycles.longestLossStreak', '最长连亏'],
  ['summary.cycles.note', '不可信时的说明'],
  ['summary.fills.count', '成交笔数'],
  ['summary.fills.spanDays', '成交窗口天数'],
  ['summary.fills.coins', '涉及标的数'],
  ['summary.fills.firstTime', '最早成交时间'],
  ['summary.fills.lastTime', '最近成交时间'],
  ['summary.byCoin[*].coin', '分组标的'],
  ['summary.byCoin[*].fills', '分组成交数'],
  ['summary.byCoin[*].wins', '分组盈利数'],
  ['summary.byCoin[*].losses', '分组亏损数'],
  ['summary.byCoin[*].net', '分组净额'],

  // ── 成交 / 挂单 / 资金费 / 出入金
  ['trades[*].coin', '成交标的'],
  ['trades[*].isLong', '成交方向'],
  ['trades[*].closeTime', '平仓时间'],
  ['trades[*].openTime', '开仓时间'],
  ['trades[*].fillCount', '该周期成交笔数'],
  ['trades[*].netPnl', '该周期净盈亏'],
  ['trades[*].stillOpen', '是否仍持仓'],
  ['trades[*].win', '是否盈利'],
  ['orders[*].coin', '挂单标的'],
  ['orders[*].side', '买卖方向'],
  ['orders[*].limitPx', '挂单价'],
  ['orders[*].sz', '挂单量'],
  ['orders[*].orderType', '订单类型'],
  ['orders[*].tif', '有效期策略'],
  ['orders[*].isTrigger', '是否条件单'],
  ['orders[*].triggerCondition', '触发条件'],
  ['funding[*].coin', '资金费标的'],
  ['funding[*].time', '资金费时间'],
  ['funding[*].usdc', '资金费金额'],
  ['funding[*].fundingRate', '资金费率'],
  ['deposits.deposit', '累计转入'],
  ['deposits.withdraw', '累计转出'],
  ['deposits.net', '净出入金'],
  ['deposits.detail[*].type', '流水类型'],
  ['deposits.detail[*].usdc', '流水金额'],
  ['deposits.detail[*].time', '流水时间'],

  // ── 顶层元信息
  ['user', '查询地址'],
  ['networkLabel', '网络名称'],
  ['fetchedAt', '快照时间'],
  ['levelCoins', '已计算读数的标的列表'],
  ['timings', '各接口耗时'],
];

/* ───────────────── 解析与检查 ───────────────── */

const isWild = (s) => s === '[*]';

/** 解析一个路径模板，返回 {ok, value, kind} */
function resolve(root, template) {
  const segs = template.split('.');
  let cur = [root];
  let nullish = false;

  for (const seg of segs) {
    const wild = seg.endsWith('[*]');
    /* 精确下标 `stages[0]` 与通配 `stages[*]` 的区别在异构数组上是实质性的：
     * pipeline.stages 的三个元素字段集不同（阶段一有 direction、阶段二有 tranches），
     * 用通配去查 stages[*].direction 会拿阶段二去取 direction，得到「字段缺失」的假警报。
     * 所以下标必须能指定具体那一个。 */
    const idxMatch = /^([A-Za-z_$][\w$]*)?\[(\d+)\]$/.exec(seg);
    const idx = idxMatch ? Number(idxMatch[2]) : null;
    const key = wild ? seg.slice(0, -3) : idxMatch ? idxMatch[1] || '' : seg;
    const next = [];
    for (const node of cur) {
      let v = node;
      if (key !== '') {
        if (v === null || v === undefined || typeof v !== 'object') {
          nullish = true;
          continue;
        }
        v = v[key];
      }
      if (idx !== null) {
        if (!Array.isArray(v) || idx >= v.length) return { ok: false, kind: 'MISSING' };
        v = v[idx];
      }
      if (v === undefined) {
        return { ok: false, kind: 'MISSING' };
      }
      if (v === null) {
        // null 是合法值（例如 cross 保证金下 liquidationPx 为 null），标记但不算缺失
        nullish = true;
        continue;
      }
      if (wild) {
        if (!Array.isArray(v)) return { ok: false, kind: 'NOT_ARRAY' };
        next.push(...v);
      } else {
        next.push(v);
      }
    }
    cur = next;
    if (cur.length === 0 && !wild) {
      // 全是 null 或空
      if (nullish) return { ok: true, kind: 'NULL' };
      return { ok: true, kind: 'EMPTY' };
    }
    if (cur.length === 0 && wild) return { ok: true, kind: 'EMPTY_ARRAY' };
  }

  if (nullish && cur.length === 0) return { ok: true, kind: 'NULL' };
  if (cur.some((v) => v === undefined)) return { ok: false, kind: 'MISSING' };
  return { ok: true, kind: 'OK', value: cur[0] };
}

/** 从 app.js 抽 `s.xxx` 形式的字段引用，作为人工清单的补充 */
function extractSnapshotPaths() {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const found = new Set();
  const re = /(?<![\w.$])s\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g;
  let m;
  while ((m = re.exec(src))) {
    const p = m[1];
    // 过滤掉明显不是快照字段的（可选链后的方法、局部变量名等）
    // pipeline / regime 是页面最上面两张卡的入口字段 —— 漏掉它们，
    // 卡片的整块数据来源就没人守了。null 是合法值（方向层缺数据时就是 null）。
    if (/^(summary|positions|account|config|trades|orders|funding|deposits|equityCurve|candles|pipeline|regime)/.test(p)) {
      found.add(p);
    }
  }

  /* ── 别名展开 ──
   *
   * 结论卡读的是 `P.stages[0].status` 这种形式，而 P 来自 `const P = s.pipeline`。
   * 上面那条正则只认 `s.`，所以这一整块字段访问它一条都抓不到 ——
   * 于是「结论卡的字段有没有人守」的答案会变成「没有」，而工具还显示 0 缺失。
   * 静默的假通过比报错难发现得多，所以这里必须展开。
   *
   * 展开范围刻意只限 pipeline：
   *   · 它是页面最上面的结论来源，字段最多、最需要守；
   *   · 别的别名（如 `const L = s.levelsByCoin?.[coin]`）指向的是**字典**，
   *     展开后会把 `levelsByCoin.markWad` 当成字段路径，制造一批假缺失。
   * ------------------------------------------------------------------ */

  // ① 指向 s.pipeline 的别名
  const aliasBase = new Map();
  const reAssign = /const\s+([A-Za-z_$][\w$]*)\s*=\s*s\.pipeline\b/g;
  while ((m = reAssign.exec(src))) aliasBase.set(m[1], 'pipeline');

  // ② 从这些别名上解构出来的阶段对象 —— 下标必须精确到 0/1/2
  const reDestr = /const\s*\[([^\]]+)\]\s*=\s*([A-Za-z_$][\w$]*)\.stages\b/g;
  while ((m = reDestr.exec(src))) {
    const base = aliasBase.get(m[2]);
    if (!base) continue;
    m[1].split(',').forEach((raw, i) => {
      const name = raw.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) aliasBase.set(name, `pipeline.stages[${i}]`);
    });
  }

  // ③ 抽这些别名下的访问路径
  for (const [alias, base] of aliasBase) {
    const reAlias = new RegExp(`(?<![\\w.$])${alias}\\.([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*)`, 'g');
    while ((m = reAlias.exec(src))) found.add(`${base}.${m[1]}`);
  }
  return [...found].sort();
}

async function main() {
  console.log('='.repeat(78));
  console.log(`数据契约检查   ${BASE}   网络=${NET}`);
  console.log(`地址           ${ADDR}`);
  console.log('='.repeat(78));

  const res = await fetch(`${BASE}/api/snapshot?network=${NET}&user=${ADDR}&coin=BTC&phase=ACCUMULATION`);
  const snap = await res.json();
  if (!snap.ok) {
    console.error(`\n快照获取失败：${snap.error}`);
    process.exit(1);
  }

  let missing = 0;
  let nullCount = 0;
  let emptyArr = 0;
  let ok = 0;
  const problems = [];

  console.log('\n[1] 深层路径清单（人工维护，覆盖嵌套结构）');

  // `levels.*` 模板需要落到某个具体标的的读数上。
  // 取第一个「有持仓」的标的作为样本 —— 只有持仓标的才会填满滚仓阶梯、风险敞口等字段。
  const levelKeys = Object.keys(snap.levelsByCoin || {});
  const heldCoin = (snap.positions || []).find((p) => p.levels)?.coin;
  const levelsRootKey = heldCoin || levelKeys[0];
  const levelsRoot = levelsRootKey ? snap.levelsByCoin[levelsRootKey] : null;
  console.log(`   样本标的：${levelsRootKey || '（无）'}${heldCoin ? '（有持仓）' : '（无持仓）'}`);
  if (!levelsRoot) {
    console.log('   ⚠ 没有任何标的算出策略读数，levels.* 相关检查无法进行');
  }

  for (const [p, note] of DEEP_PATHS) {
    const r = p.startsWith('levels.')
      ? levelsRoot
        ? resolve(levelsRoot, p.slice('levels.'.length))
        : { ok: true, kind: 'SKIP' }
      : resolve(snap, p);
    if (r.kind === 'SKIP') continue;
    if (!r.ok) {
      missing += 1;
      problems.push(`${p}  ← ${note}  (${r.kind})`);
      console.log(`   ✗ ${p.padEnd(52)} ${r.kind}   ← ${note}`);
    } else if (r.kind === 'NULL') {
      nullCount += 1;
    } else if (r.kind === 'EMPTY_ARRAY' || r.kind === 'EMPTY') {
      emptyArr += 1;
    } else {
      ok += 1;
    }
  }
  console.log(`   可取值 ${ok} 条 · 合法为 null ${nullCount} 条 · 空数组/空对象 ${emptyArr} 条 · 缺失 ${missing} 条`);

  console.log('\n[2] app.js 中的快照字段引用（正则抽取）');
  const extracted = extractSnapshotPaths();
  let exMissing = 0;
  for (const p of extracted) {
    const r = resolve(snap, p);
    const mark = r.ok ? (r.kind === 'OK' ? '✓' : '○') : '✗';
    if (!r.ok) {
      exMissing += 1;
      problems.push(`s.${p}  ← app.js 引用  (${r.kind})`);
    }
    if (!r.ok) console.log(`   ${mark} s.${p.padEnd(44)} ${r.kind}`);
  }
  console.log(`   引用 ${extracted.length} 条 · 解析失败 ${exMissing} 条（未列出的即为正常）`);

  console.log('\n[3] 顶层结构完整性');
  const top = [
    ['account', 'object'],
    ['positions', 'object'],
    ['summary', 'object'],
    ['config', 'object'],
    ['trades', 'object'],
    ['orders', 'object'],
    ['funding', 'object'],
    ['deposits', 'object'],
    ['levelsByCoin', 'object'],
    ['levelCoins', 'object'],
    ['candles', 'object'],
    ['timings', 'object'],
  ];
  let topBad = 0;
  for (const [k, t] of top) {
    const v = snap[k];
    const actual = Array.isArray(v) ? 'array' : typeof v;
    const good = v !== undefined && v !== null;
    if (!good) topBad += 1;
    console.log(`   ${good ? '✓' : '✗'} ${k.padEnd(16)} ${actual}`);
  }

  console.log('\n' + '='.repeat(78));
  const total = missing + exMissing + topBad;
  if (total === 0) {
    console.log('结论：数据契约完整 —— 前端读取的每个字段都能在真实快照中取到。');
  } else {
    console.log(`结论：发现 ${total} 处契约问题（前端会渲染出 undefined 或直接报错）：`);
    problems.slice(0, 40).forEach((p) => console.log('  -', p));
  }
  console.log('='.repeat(78));
  process.exit(total ? 1 : 0);
}

main().catch((e) => {
  console.error('契约检查异常：', e);
  process.exit(1);
});
