/**
 * 归因报告的数值审计 —— 专抓「报告里印出来的数字本身不成立」。
 *
 * 起因：`report/attribution-*.md` 的「建议止损距」列出现了 1444%、42704% 这种值。
 * 止损距离不可能是价格的好几倍，所以要么列取错了字段，要么底层 K 线数据有问题。
 *
 * 本脚本做两件事，都不依赖网络：
 *   1. 统计报告里 stopDistanceBps 的分布 —— 有多少笔超过了策略的 12% 距离硬上限。
 *      如果这个数是 0，说明用的是推荐止损；大于 0，说明用的是一个不受上限约束的量。
 *   2. 对出现离群值的标的，回看它的 K 线缓存：收盘价量级、以及「交易时刻的
 *      布林中轨」到底落在哪里 —— 用来区分「字段取错」与「K 线数据本身是脏的」。
 *
 * 用法：
 *   node tools/audit-attribution.js                    # 审最新一份 report/*.json
 *   node tools/audit-attribution.js report/xxx.json    # 指定报告
 *   node tools/audit-attribution.js report/xxx.json --coin XPL --at 1758835732315
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_DIR = path.join(ROOT, 'report');
const CACHE_DIR = path.join(ROOT, '.cache');

const argv = process.argv.slice(2);
const argOf = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

/** 策略的距离硬上限（bps）。levels.js: maxStopDistanceBps */
const CAP_BPS = 1200;

function pickReport() {
  const explicit = argv.find((a) => a.endsWith('.json'));
  if (explicit) return path.isAbsolute(explicit) ? explicit : path.join(ROOT, explicit);
  const files = fs
    .readdirSync(REPORT_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ f, at: fs.statSync(path.join(REPORT_DIR, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  if (!files.length) throw new Error(`report/ 下没有 json：${REPORT_DIR}`);
  return path.join(REPORT_DIR, files[0].f);
}

// ⚠️ 中位数必须与 year-attribution.js 的 percentile(arr, 0.5) 用**同一种插值口径**。
//    之前这里用的是「取中间那位」（nearest-rank），报告用的是线性插值 ——
//    同一个量在报告里印 8.16%、在审计里印 8.28%，会被当成 bug 追半天。
const med = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * 0.5;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
};
const pct = (v) => (v === null || v === undefined ? '—' : `${(v / 100).toFixed(2)}%`);
const pctBig = (v) => (v === null || v === undefined ? '—' : `${(v / 100).toFixed(0)}%`);
const ts = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

/* ─────────────── 1. 报告里 stopDistanceBps 的分布 ─────────────── */

const reportPath = pickReport();
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

// 报告结构：{ counts, buckets, stopDiscipline, scenarios, rows: [...] }。逐笔明细在 rows。
const rows = report.rows || report.trades || report.fills || [];
if (!rows.length) {
  console.log(`\n报告 ${path.basename(reportPath)} 里没有可审计的逐笔明细（trades 为空）。`);
  console.log('（这通常意味着该账户在窗口内没有成交 —— 报告本身是空态，不是缺陷。）\n');
  process.exit(0);
}

const withStop = rows.filter((r) => r.stopDistanceBps !== null && r.stopDistanceBps !== undefined);
const overCap = withStop.filter((r) => r.stopDistanceBps > CAP_BPS);
const absurd = withStop.filter((r) => r.stopDistanceBps > 10000); // >100%

console.log('');
console.log('  归因报告数值审计');
console.log('  ─────────────────────────────────────────────────────────────');
console.log(`  报告          : ${path.relative(ROOT, reportPath)}`);
console.log(`  逐笔明细      : ${rows.length} 笔`);
console.log(`  有止损距离    : ${withStop.length} 笔`);
console.log('');
console.log(`  距离硬上限    : ${pct(CAP_BPS)}（levels.js: maxStopDistanceBps）`);
console.log(`  超出上限      : ${overCap.length} 笔（${((overCap.length / withStop.length) * 100).toFixed(1)}%）`);
console.log(`  超过 100%     : ${absurd.length} 笔  ← 止损距离不可能是价格的好几倍`);
console.log(`  中位数        : ${pct(med(withStop.map((r) => r.stopDistanceBps)))}`);
console.log(`  最大值        : ${pctBig(Math.max(...withStop.map((r) => r.stopDistanceBps)))}`);
console.log('');

console.log('  按标的看中位/最大止损距离（只列超出上限的）：');
console.log('  ┌────────────┬───────┬────────────┬────────────┐');
console.log('  │ 标的       │  笔数 │   中位     │    最大    │');
console.log('  ├────────────┼───────┼────────────┼────────────┤');
const byCoin = new Map();
for (const r of withStop) {
  if (!byCoin.has(r.coin)) byCoin.set(r.coin, []);
  byCoin.get(r.coin).push(r.stopDistanceBps);
}
const badCoins = [...byCoin.entries()]
  .map(([coin, v]) => ({ coin, n: v.length, med: med(v), max: Math.max(...v) }))
  .filter((x) => x.med > CAP_BPS)
  .sort((a, b) => b.med - a.med);
for (const x of badCoins) {
  console.log(
    `  │ ${x.coin.padEnd(10)} │ ${String(x.n).padStart(5)} │ ${pct(x.med).padStart(10)} │ ${pctBig(x.max).padStart(10)} │`
  );
}
console.log('  └────────────┴───────┴────────────┴────────────┘');
console.log('');

if (overCap.length) {
  console.log('  判定：报告用的不是「推荐止损」。');
  console.log('        推荐止损必须过 withinDistance 校验（≤12%），带 cap 的量不可能超上限。');
  console.log('        实际取的是 entryPlan.stopDistanceBps = 距【布林中轨】的原始距离，无上限。');
  console.log('        因此该列的标题「建议止损距」是错的，且不能用来判「止损纪律」。');
  console.log('');
}

/* ─────────────── 2. 离群标的的 K 线回看 ─────────────── */

const wantCoin = argOf('coin') || (badCoins[0] && badCoins[0].coin);
const wantAt = Number(argOf('at')) || (rows.find((r) => r.coin === wantCoin)?.openTime ?? null);

if (wantCoin) {
  console.log(`  ── K 线回看：${wantCoin}${wantAt ? ` @ ${ts(wantAt)}` : ''} ──`);
  const cacheFile = fs
    .readdirSync(CACHE_DIR)
    .find((f) => f.startsWith(`candles-mainnet-${wantCoin}-`) && f.endsWith('.json'));
  if (!cacheFile) {
    console.log(`  未找到 ${wantCoin} 的 K 线缓存（.cache/candles-mainnet-${wantCoin}-*.json）。`);
  } else {
    const raw = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, cacheFile), 'utf8'));
    const list = raw.value?.list || raw.list || [];
    const closes = list.map((b) => Number(b.c)).filter((x) => Number.isFinite(x));
    console.log(`  缓存文件      : ${cacheFile}`);
    console.log(`  K 线条数      : ${list.length}`);
    if (list.length) {
      console.log(`  时间范围      : ${ts(list[0].t)} → ${ts(list[list.length - 1].t)}`);
      console.log(`  收盘价范围    : ${Math.min(...closes)} ~ ${Math.max(...closes)}`);
      console.log(`  收盘价中位    : ${med(closes)}`);
    }

    if (wantAt) {
      // 找到该时刻之前已收盘的那些 bar，复算中轨，看是不是真的离价格很远
      const before = list.filter((b) => b.t + 4 * 3600 * 1000 <= wantAt);
      const entry = rows.find((r) => r.coin === wantCoin && r.openTime === wantAt);
      const entryPx = entry ? Number(BigInt(entry.entryPx)) / 1e18 : null;
      console.log(`  该时刻已收盘  : ${before.length} 根`);
      if (entryPx !== null) console.log(`  这笔入场价    : ${entryPx}`);
      for (const n of [20, 50, 100]) {
        const win = before.slice(-n).map((b) => Number(b.c));
        if (win.length < n) continue;
        const mid = win.reduce((a, b) => a + b, 0) / win.length;
        const dist = entryPx ? Math.abs(entryPx - mid) / entryPx : null;
        console.log(
          `  SMA${String(n).padEnd(3)} 中轨      : ${mid.toFixed(6)}　→ 距入场 ${
            dist === null ? '—' : `${(dist * 100).toFixed(1)}%`
          }`
        );
      }
      const lastWin = before.slice(-20).map((b) => Number(b.c));
      if (lastWin.length) {
        console.log(`  最近 20 根收盘: ${lastWin.map((c) => c.toFixed(4)).join(', ')}`);
      }
    }
  }
  console.log('');
}

console.log('  结论：');
console.log('   · 若「超出上限」不为 0 → 报告列取错字段，需改用 stop.recommended.price 的距离。');
console.log('   · 若某标的中轨本就远在价格数倍之外 → K 线数据脏（新上币早期低流动性插针），');
console.log('     这类标的的重放结论不可用，应在报告里剔除而不是印出一个大数字。');
console.log('');
