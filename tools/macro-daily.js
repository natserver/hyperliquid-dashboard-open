#!/usr/bin/env node
/**
 * 每日采集任务 —— 把 M1~M6 的宏观读数固定进历史库，并顺带记下当时的方向判断。
 *
 * ── 这个脚本存在的理由 ────────────────────────────────────────────────
 *
 * 看板本身在每次「看快照」时也会落库（只要有人打开页面就有记录）。但看板可能
 * 一连几天没被打开，那几天的恐慌贪婪指数、ETF 流量就**永久缺失** ——
 * 这些源只提供「当前值 + 近期窗口」，没有「某天的历史值」可回补。
 *
 * 所以需要一个不依赖人是否在看页面的定时任务。每天跑一次，把当天的读数钉住。
 *
 * ── 为什么还要算一遍方向 ──────────────────────────────────────────────
 *
 * 只存六条读数，回答不了「那天这个读数意味着什么」。把当时的 bias /
 * confidence / 周期相位一起存下来，历史才可复盘：
 * 「上个月恐慌贪婪 78 时方向是 NEUTRAL，这个月 78 时方向变成了 SHORT_ONLY，
 *   差别在哪」—— 这种问题只有把两边都存在一起才答得了。
 *
 * 方向的计算复用 `src/regime-inputs.js`，与看板**同一份实现**，
 * 不存在「任务算的和看板显示的不一样」。
 *
 * ── 用法 ──────────────────────────────────────────────────────────
 *
 *   node tools/macro-daily.js                 采集 + 落库（定时任务的默认调用）
 *   node tools/macro-daily.js --view          回看历史账本（不联网，断网可用）
 *   node tools/macro-daily.js --view --days 7 回看最近 7 天
 *   node tools/macro-daily.js --dry-run       只采集，不写库
 *   node tools/macro-daily.js --no-regime     跳过方向层（省 3 次接口请求）
 *   node tools/macro-daily.js --phase DECLINE 指定周期相位（默认 AUTO = 按减半时钟推算，与看板默认一致）
 *   node tools/macro-daily.js --keep 400      落库后裁剪，只留最近 N 天（默认 800）
 *   node tools/macro-daily.js --json          以 JSON 输出结果（给自动化读）
 *   node tools/macro-daily.js --quiet         只打一行摘要（给 cron 日志）
 *
 * 为什么 `--view` 必须**不联网**：看板关着、网也断了的时候，最需要回答的恰恰是
 * 「昨天到底读到了什么」。如果回看也要先拉一遍源，那它在最需要它的场景里不可用。
 */

import { collectMacroSources, evaluateMacroCriteria, MACRO_SOURCES } from '../src/macro-sources.js';
import { buildRegime, fetchRegimeInputs, lastClose, loadMacroEvents } from '../src/regime-inputs.js';
import { CRITERIA_ORDER, dayOf, openMacroStore, recordMacro, storeSummary } from '../src/macro-store.js';
import { historyViewData, renderHistoryView } from '../src/macro-view.js';
import { derivePhase } from '../src/regime.js';
import { PHASE_AUTO, defaultConfig, phaseFloorBps, validateParams } from '../src/strategy.js';

/* ───────────────────────── 参数 ───────────────────────── */

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const DRY = has('--dry-run');
const NO_REGIME = has('--no-regime');
const JSON_OUT = has('--json');
const QUIET = has('--quiet');
const VIEW = has('--view');
const PHASE_ARG = String(val('--phase', PHASE_AUTO)).toUpperCase();
/* 相位在**这里**就解析成具体值，绝不把 PHASE_AUTO 往下传。
 * 理由与 server.js 同：`phaseFloorBps` 收到非四相位值会静默落到 DECLINE 档，
 * 看似没问题，实际是"巧合正确"。而且落库的 `cycle_phase` 必须是具体相位，
 * 否则历史表里会出现一个叫 AUTO 的字段值，三个月后无法解释。 */
const PHASE_RESOLVED = derivePhase(Date.now(), PHASE_ARG);
const PHASE = PHASE_RESOLVED.phase;
if (PHASE_RESOLVED.unknown) {
  console.warn(`⚠ --phase ${PHASE_ARG} 不是已知相位，已改用减半时钟推算的 ${PHASE}`);
}
const KEEP_DAYS = Math.max(30, Number(val('--keep', 800)) || 800);
const VIEW_DAYS = Math.min(3650, Math.max(1, Math.floor(Number(val('--days', 30))) || 30));

const log = (...a) => {
  if (!QUIET) console.log(...a);
};

/* ═════════════════════ --view：回看历史账本（不联网） ═════════════════════
 *
 * 渲染逻辑在 `src/macro-view.js`（纯函数、可测）；这里只做参数解析与打印。
 * 这个分支在**任何取数之前**结束，一个 HTTP 请求都不发 ——
 * 看板可能没开着、网也可能断着，而「昨天到底读到了什么」恰恰最需要在这种时候回答。
 */
if (VIEW) {
  let store = null;
  try {
    store = openMacroStore();
  } catch {
    store = null;
  }
  if (!store) {
    console.error('✗ 打不开历史库（.data/）—— 检查目录权限或磁盘空间');
    process.exit(2);
  }

  const data = historyViewData({
    store,
    order: CRITERIA_ORDER,
    days: VIEW_DAYS,
    now: Date.now(),
    dayOf,
    summary: storeSummary(store),
  });

  if (JSON_OUT) {
    console.log(JSON.stringify({ ok: true, view: 'history', ...data }, null, 2));
  } else {
    console.log(renderHistoryView(data));
  }
  store.close();
  process.exit(0);
}

/* ───────────────────────── 策略配置 ─────────────────────────
 * 与 server.js 里「策略配置」那一段保持一致：defaultConfig + 相位相关的下限调整。
 * 唯一的区别是这里没有预警配置可注入，所以用纯默认值 —— 而宏观求值只需要
 * 其中几个阈值字段，方向层需要的都从 defaultConfig 来。
 */
const cfg = defaultConfig(PHASE);
cfg.cyclePhase = PHASE;
cfg.risk.minExpectedMoveBps = Math.max(phaseFloorBps(cfg.cyclePhase), 1800);
let cfgWarning = null;
try {
  validateParams(cfg.risk, cfg.cyclePhase);
} catch (e) {
  cfgWarning = e.message;
}

const t0 = Date.now();

/* ───────────────────────── ① 采集 M1~M6 ───────────────────────── */

log(`▶ 采集 M1~M6（${MACRO_SOURCES.length} 个免费源，无密钥）…`);
const src = await collectMacroSources({});
const errors = src.errors || [];
log(`  源状态：${Object.values(src.sources || {}).filter((s) => s && s.status === 'ok').length} ok / ${Object.values(src.sources || {}).filter((s) => s && s.status === 'stale').length} stale / ${errors.length} 失败`);

/* ───────────────────────── ② 方向层（可选） ─────────────────────────
 * 顺序上与看板一致：先拿 K 线得到 spotPrice，才能求值 `etf-netflow` 的
 * 「价格突破 10.3 万」那一半条件；再拿 macroReadings 去算方向。
 */
let inputs = null;
let readings = null;
let regime = null;
let spotPrice = null;

if (NO_REGIME) {
  // 不拉 K 线时 spotPrice 缺失 —— 那 M2 就只剩「ETF 流量」一半条件，
  // 求值函数会把它标成弃权而不是误判为「不成立」。这是刻意的诚实体面。
  readings = evaluateMacroCriteria(src, { price: null, config: { ...cfg } });
} else {
  try {
    inputs = await fetchRegimeInputs('mainnet', { nowMs: t0 });
    spotPrice = lastClose(inputs.daily);
    readings = evaluateMacroCriteria(src, { price: spotPrice, config: { ...cfg } });
    const events = loadMacroEvents();
    regime = buildRegime({ inputs, cfg, events, macro: readings, nowMs: t0 });
  } catch (e) {
    log(`  ⚠ 方向层失败（仍会落库读数，只是 bias 记 null）：${e.message}`);
    readings = readings || evaluateMacroCriteria(src, { price: null, config: { ...cfg } });
  }
}

const available = readings.filter((r) => r.available).length;
const voteLong = readings.filter((r) => r.available && r.vote > 0).length;
const voteShort = readings.filter((r) => r.available && r.vote < 0).length;

log(`  读数：${available}/${readings.length} 取到 · 多 ${voteLong} / 空 ${voteShort} / 弃权 ${readings.length - available}`);
if (spotPrice !== null) log(`  BTC 现价：$${Math.round(spotPrice).toLocaleString('en-US')}`);
if (regime) log(`  方向：${regime.biasLabel || regime.bias}（${regime.confidence || '—'}）· 相位 ${PHASE}`);

/* ───────────────────────── ③ 落库 ───────────────────────── */

let stored = null;
let pruneResult = null;
let summary = null;

if (DRY) {
  log('（--dry-run：不写库）');
} else {
  const store = openMacroStore();
  if (!store) {
    console.error('✗ 打不开历史库（.data/）—— 检查目录权限或磁盘空间');
    process.exit(2);
  }
  summary = storeSummary(store);

  stored = recordMacro(store, { readings, errors, fetchedAt: src.fetchedAt, spotPrice }, {
    now: t0,
    bias: regime ? regime.bias : null,
    biasLabel: regime ? regime.biasLabel : null,
    confidence: regime ? regime.confidence : null,
    cyclePhase: PHASE,
  });

  if (!stored) {
    console.error('✗ 写入历史库失败');
    store.close();
    process.exit(3);
  }

  pruneResult = store.prune(KEEP_DAYS);
  summary = storeSummary(store);
  store.close();

  log(`  ✔ 已落库：${stored.day} · ${stored.rows} 行 · 后端 ${summary.backend}`);
  log(`    库内共 ${summary.days} 天 / ${summary.rows} 行（${summary.firstDay} ~ ${summary.lastDay}）`);
  if (pruneResult.removedDays > 0) {
    log(`    裁剪：移除 ${pruneResult.removedDays} 天 / ${pruneResult.removedRows} 行（保留期 ${KEEP_DAYS} 天）`);
  }

  /* 一个必须显形的诚实检查：六个源全挂时，我们刚刚往账本里写了一天的
   * 「全部弃权」。这跟「今天真的六条都不成立」在库里长得一模一样 ——
   * 必须在控制台大声说出来，否则这个库会悄悄积累一批无意义的空记录。 */
  if (available === 0) {
    console.error('⚠ 六个源全部取数为空 —— 这一天的记录是「取不到」而不是「判据不成立」，复盘时请剔除。');
  }
}

if (cfgWarning) log(`  ⚠ 配置校验：${cfgWarning}`);

/* ───────────────────────── 输出 ───────────────────────── */

const result = {
  ok: available > 0,
  day: stored ? stored.day : null,
  fetchedAt: src.fetchedAt,
  spotPrice,
  phase: PHASE,
  available,
  total: readings.length,
  voteLong,
  voteShort,
  bias: regime ? regime.bias : null,
  biasLabel: regime ? regime.biasLabel : null,
  confidence: regime ? regime.confidence : null,
  readings: readings.map((r) => ({
    id: r.id,
    layer: r.layer,
    available: !!r.available,
    vote: r.vote ?? null,
    value: r.value ?? null,
    asOf: r.asOf ?? null,
    status: r.ttl ?? null,
    reason: r.reason,
  })),
  errors,
  stored,
  prune: pruneResult,
  store: summary,
  elapsedMs: Date.now() - t0,
};

if (JSON_OUT) {
  console.log(JSON.stringify(result, null, 2));
} else if (QUIET) {
  console.log(
    `[macro-daily] ${stored ? stored.day : 'dry-run'} 取到 ${available}/${readings.length} · 多${voteLong}/空${voteShort}` +
      ` · 方向 ${result.bias || '—'} · 失败 ${errors.length} · ${result.elapsedMs}ms`
  );
}

/* 退出码：全挂才算失败。部分源挂掉仍然算成功 —— 
 * 昨天的 DXY 比没有 DXY 有用，不该让 cron 报警掩盖「其实还有 5 条数据」这件事。 */
process.exit(available > 0 ? 0 : 1);
