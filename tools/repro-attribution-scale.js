/**
 * 复现 year-attribution.js 的重放路径 —— 钉死「建议止损距 1444%」这类值的来源。
 *
 * 怀疑对象（按可疑度排序）：
 *   1. tools/year-attribution.js:727 把**完整一年**的 candles 传进 computeLevels，
 *      而算好的 closesBefore() 截断窗口只用来数根数 → 布林带/趋势含前视。
 *   2. entryPlan.stopDistanceBps 取的是「距布林中轨的原始距离」，不受 12% 上限约束。
 *
 * 做法：同一笔交易，跑两遍 —— 一遍传全量 candles（现状），一遍传截断到开仓时刻的
 * candles（应有的做法），对比 stopDistanceBps / projectedMoveBps / 趋势方向。
 *
 * 用法：node tools/repro-attribution-scale.js [--coin XPL] [--at 1758835732315]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeLevels, closesOf } from '../src/levels.js';
import { CYCLE_PHASES, defaultConfig, defaultTiers, phaseFloorBps, wadToNumber } from '../src/strategy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache');
const INTERVAL_MS = { '1h': 3600000, '4h': 14400000, '1d': 86400000 };

const argv = process.argv.slice(2);
const argOf = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const COIN = argOf('coin') || 'XPL';
const AT = Number(argOf('at')) || 1758835732315;
const IV = '4h';

function loadCandles(coin) {
  const f = fs
    .readdirSync(CACHE)
    .find((x) => x.startsWith(`candles-mainnet-${coin}-`) && x.endsWith('.json'));
  if (!f) throw new Error(`没有 ${coin} 的 K 线缓存`);
  const raw = JSON.parse(fs.readFileSync(path.join(CACHE, f), 'utf8'));
  return raw.value?.list || raw.list || [];
}

/** 只留开仓时刻**之前已收盘**的 K 线（无前视） */
function closedBefore(list, at, ivMs) {
  return list.filter((b) => b.t + ivMs <= at);
}

const pct = (bps) => (bps === null || bps === undefined ? '—' : `${(bps / 100).toFixed(2)}%`);

function run(label, candles, entryPxWad, phase) {
  const cfg = defaultConfig(phase);
  cfg.cyclePhase = phase;
  cfg.risk.minExpectedMoveBps = phaseFloorBps(phase);
  const r = computeLevels({
    coin: COIN,
    candles,
    markWad: entryPxWad,
    position: null,
    equityWad: 100000n * 10n ** 18n,
    config: cfg,
    tiers: defaultTiers(),
  });
  const ep = r.entryPlan;
  const mid = r.bands ? wadToNumber(r.bands.mid) : null;
  const rec = r.stop && r.stop.recommended;
  console.log(`  【${label}】`);
  console.log(`    K 线条数        : ${candles.length}`);
  console.log(`    布林中轨        : ${mid === null ? '—' : mid}`);
  console.log(`    entryPlan.stopPrice     : ${ep ? wadToNumber(ep.stopPrice) : '—'}`);
  console.log(`    entryPlan.stopDistance  : ${ep ? pct(ep.stopDistanceBps) : '—'}`);
  console.log(`    entryPlan.projectedMove : ${ep ? pct(ep.projectedMoveBps) : '—'}`);
  console.log(`    趋势方向        : ${r.trend?.direction} (${r.trend?.reason || '—'})`);
  console.log(
    `    推荐止损        : ${rec ? wadToNumber(rec.price) + ` （距离 ${rec.distancePct.toFixed(2)}%，withinDistance=${rec.withinDistance}）` : '无（没有候选通过全部约束）'}`
  );
  console.log('');
  return r;
}

const list = loadCandles(COIN);
const ivMs = INTERVAL_MS[IV];
const trunc = closedBefore(list, AT, ivMs);
const entryPxWad = 1280000000000000000n; // XPL 这笔的入场价 1.28

console.log('');
console.log('  重放路径复现');
console.log('  ─────────────────────────────────────────────────────────────');
console.log(`  标的          : ${COIN}`);
console.log(`  开仓时刻      : ${new Date(AT).toISOString().replace('T', ' ').slice(0, 19)}`);
console.log(`  入场价        : ${wadToNumber(entryPxWad)}`);
console.log(`  全量 K 线     : ${list.length} 根（→ ${new Date(list[list.length - 1].t).toISOString().slice(0, 10)}）`);
console.log(`  截断后 K 线   : ${trunc.length} 根（→ ${new Date(trunc[trunc.length - 1].t).toISOString().slice(0, 10)}）`);
console.log('');

run('现状：传全量 candles（year-attribution.js:727）', list, entryPxWad, 'ACCUMULATION');
run('应有：只传开仓前已收盘', trunc, entryPxWad, 'ACCUMULATION');

/* 直接验证「止损距离是否受 12% 上限约束」 */
console.log('  上限校验：');
const r = run('参考', trunc, entryPxWad, 'ACCUMULATION');
if (r.stop && r.stop.recommended) {
  const rec = r.stop.recommended;
  console.log(
    `    推荐止损距离 ${rec.distancePct.toFixed(2)}% ≤ 12% → ${rec.distancePct <= 12 ? '✓ 受约束' : '✗ 越界'}`
  );
  console.log(
    `    而报告印出的 stopDistanceBps 取的是 entryPlan.stopDistanceBps（距中轨、无上限）。`
  );
}
console.log('');
