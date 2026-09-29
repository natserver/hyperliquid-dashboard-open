/**
 * 字段形态审计 —— 前端 W()/W2() 混用的根因排查工具。
 *
 * 背景：快照里存在**两种**数字字段形态，长得几乎一样但量纲差 1e18：
 *   (A) WAD 纯数字串   如 "76612900000000000000000"  → 后端 BigInt 序列化的结果，代表 76612.9
 *   (B) 十进制串/数字  如 "77442.0" / 0.0000125      → 信息接口原样透传，已经是对人可读的值
 *
 * 对 (A) 要 BigInt(v)，对 (B) 要 parseWad(v)。前端两者都用 parseWad，
 * 于是所有 (A) 被二次放大 1e18 —— 表现为 "7.76375e+22" 和空白的 K 线图。
 *
 * 本工具遍历整份快照，把每个字段判定为 A/B/其它，并列出前端误用清单。
 */
import { readFileSync } from 'node:fs';

const A = process.argv[2] || '0x010461c14e146ac35fe42271bdc1134ee31c703a';
const snap = await (await fetch(`http://127.0.0.1:8787/api/snapshot?network=mainnet&user=${A}&coin=BTC`)).json();
if (!snap.ok) { console.log('快照失败', snap.error); process.exit(1); }

/** 判定形态 */
function shape(v) {
  if (v === null) return 'null';
  if (typeof v === 'number') return 'num';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'bigint') return 'BIGINT!';
  if (typeof v !== 'string') return typeof v;
  if (/^-?\d+$/.test(v)) return 'WAD';       // 纯整数串 → 后端 BigInt 序列化
  if (/^-?\d*\.\d+(e[+-]?\d+)?$/i.test(v)) return 'DEC'; // 带小数点 → 原样透传
  if (/^-?\d+e[+-]?\d+$/i.test(v)) return 'DEC';
  return 'STR';
}

/** 该形态是否「按 WAD 解读」才能得到合理量级 */
function wadValue(v) {
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return Number(BigInt(v)) / 1e18;
  return null;
}

const findings = [];
const walk = (obj, path, depth = 0) => {
  if (depth > 6 || obj === null || obj === undefined) return;
  if (Array.isArray(obj)) {
    if (obj.length) walk(obj[0], path + '[]', depth + 1);
    return;
  }
  if (typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    const p = path ? path + '.' + k : k;
    const s = shape(v);
    if (s === 'WAD' || s === 'DEC') {
      findings.push({ path: p, kind: s, value: v, wad: wadValue(v) });
    } else if (v && typeof v === 'object') {
      walk(v, p, depth + 1);
    }
  }
};

// 逐块走，路径前缀让定位更容易
for (const key of ['account', 'summary', 'equityCurve', 'positions', 'orders', 'trades', 'funding', 'deposits', 'markets', 'levelsByCoin']) {
  if (snap[key] !== undefined) walk(snap[key], key);
}

const wads = findings.filter((f) => f.kind === 'WAD');
const decs = findings.filter((f) => f.kind === 'DEC');

console.log('═'.repeat(78));
console.log('快照字段形态分布');
console.log('═'.repeat(78));
console.log(`  WAD 纯数字串（要 BigInt(v)）：${wads.length} 个`);
console.log(`  十进制串/数（要 parseWad(v)）：${decs.length} 个`);

console.log('\n── WAD 形态字段（前端若用 W()/parseWad 就是错的）──');
const uniqWadPaths = [...new Set(wads.map((f) => f.path.replace(/\[\]/g, '')))];
for (const p of uniqWadPaths.slice(0, 60)) {
  const f = wads.find((x) => x.path.replace(/\[\]/g, '') === p);
  const shown = f.value.length > 26 ? f.value.slice(0, 12) + '…' + f.value.slice(-6) : f.value;
  console.log('  ' + p.padEnd(48) + ' BigInt/1e18 = ' + (f.wad === null ? '—' : f.wad.toPrecision(10)));
}
if (uniqWadPaths.length > 60) console.log(`  …还有 ${uniqWadPaths.length - 60} 个`);

console.log('\n── DEC 形态字段（前端若用 W()/parseWad 才正确）──');
const uniqDecPaths = [...new Set(decs.map((f) => f.path.replace(/\[\]/g, '')))];
for (const p of uniqDecPaths.slice(0, 40)) {
  const f = decs.find((x) => x.path.replace(/\[\]/g, '') === p);
  console.log('  ' + p.padEnd(48) + ' = ' + f.value);
}

/* ── 关键判定：哪些字段「看起来像 WAD 但前端当 DEC 处理了」 ── */
console.log('\n' + '═'.repeat(78));
console.log('前端 app.js 的 W()/W2() 调用点审计');
console.log('═'.repeat(78));

const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const lines = src.split('\n');
const callRe = /\b(W2?|parseWad)\(\s*([A-Za-z_$][\w.$]*(?:\[[^\]]*\])?(?:\??\.[\w]+)*)/g;

/** 从字段路径猜形态：跟快照比对 */
const shapeOf = (expr) => {
  for (const f of findings) {
    const norm = f.path.replace(/\[\]/g, '');
    // 用字段名尾部匹配（p.entryPx → entryPx / positions[].entryPx）
    const tail = expr.split('.').pop().replace(/\?$/, '');
    if (norm.endsWith('.' + tail) || norm === tail) return { kind: f.kind, sample: f.value };
  }
  return null;
};

const wrong = [];
const okOnes = [];
for (let i = 0; i < lines.length; i++) {
  callRe.lastIndex = 0;
  let m;
  while ((m = callRe.exec(lines[i]))) {
    const fn = m[1];
    const expr = m[2];
    // 跳过明显是构造器的场景
    if (expr === 'v' && fn === 'parseP') continue;
    const sh = shapeOf(expr);
    if (!sh) continue;
    const usesWadFn = fn === 'W' || fn === 'W2' || fn === 'parseWad';
    const isWrong = usesWadFn && sh.kind === 'WAD';
    const rec = { line: i + 1, fn, expr, kind: sh.kind, sample: sh.sample, text: lines[i].trim().slice(0, 96) };
    (isWrong ? wrong : okOnes).push(rec);
  }
}

console.log(`\n  ✗ 误用（对 WAD 字段调 parseWad，被放大 1e18）：${wrong.length} 处`);
const seen = new Set();
for (const w of wrong) {
  const key = w.line + '|' + w.expr;
  if (seen.has(key)) continue;
  seen.add(key);
  console.log(`     L${String(w.line).padStart(4)}  ${w.fn}(${w.expr})`.padEnd(52) + ' ← ' + w.kind + ' 样例 ' + String(w.sample).slice(0, 24));
}

console.log(`\n  ✓ 正确（对 DEC 字段调 parseWad）：${okOnes.length} 处`);
const seen2 = new Set();
for (const o of okOnes.slice(0, 20)) {
  const key = o.line + '|' + o.expr;
  if (seen2.has(key)) continue;
  seen2.add(key);
  console.log(`     L${String(o.line).padStart(4)}  ${o.fn}(${o.expr})`.padEnd(52) + ' ← ' + o.kind + ' 样例 ' + String(o.sample).slice(0, 24));
}

console.log('\n' + '═'.repeat(78));
console.log(`结论：${wrong.length} 处调用把已经是 WAD 的字段又乘了 1e18。`);
console.log('这些字段分布在 标记价/开仓价/清算价/止损/滚仓/止盈/KPI/持仓明细 各处。');
console.log('═'.repeat(78));
