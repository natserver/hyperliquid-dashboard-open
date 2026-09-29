// 诊断：权益曲线各周期的取值分布，确认是否存在坏的极值点
import { parseWad, wadToNumber } from '../src/strategy.js';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';

/** 与 app.js 的 wad() 完全同构 */
const wad = (v) => {
  if (typeof v === 'bigint') return v;
  const s = String(v ?? '0');
  return /^-?\d+$/.test(s) ? BigInt(s) : parseWad(s);
};

const A = process.env.USER_ADDR || '0x010461c14e146ac35fe42271bdc1134ee31c703a';
const res = await fetch(`${BASE}/api/snapshot?network=mainnet&user=${A}&coin=BTC`);
const s = await res.json();

console.log('账户权益(原始):', s.account?.accountValue);
console.log('账户权益(换算):', wadToNumber(wad(s.account?.accountValue)).toFixed(2));
console.log('');

const curves = s.equityCurvesByPeriod || {};
for (const [period, series] of Object.entries(curves)) {
  const arr = series?.equity || [];
  if (!arr.length) { console.log(`${period.padEnd(14)} 空`); continue; }
  const vals = arr.map((p) => wadToNumber(wad(p.v)));
  const finite = vals.filter((x) => Number.isFinite(x));
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const sorted = [...finite].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  // 嫌疑点：明显偏离中位数的
  const outliers = arr
    .map((p, i) => ({ t: p.t, raw: p.v, val: vals[i] }))
    .filter((x) => Number.isFinite(x.val) && (x.val > median * 5 || x.val < median / 5));
  console.log(
    `${period.padEnd(14)} n=${String(arr.length).padStart(4)}  min=${min.toFixed(2)}  p50=${median.toFixed(2)}  max=${max.toFixed(2)}  离群点=${outliers.length}`
  );
  for (const o of outliers.slice(0, 6)) {
    console.log(`    · t=${o.t} raw=${JSON.stringify(o.raw)} → ${o.val}`);
  }
}
