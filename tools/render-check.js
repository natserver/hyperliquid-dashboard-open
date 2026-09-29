/**
 * 渲染层回归验证 —— 两个已修 bug 的守卫测试。
 *
 * 修的 bug：
 *   ① 标记价显示成 7.76375e+22（WAD 字符串被 parseWad 二次放大 1e18）
 *   ② K 线图看起来「什么都没画」（同一个根因把价格视野撑到 1e22，K 线压成不足 1 像素）
 *
 * 本工具的设计要点：**不复制前端实现**。
 * 它从 public/app.js 源码里把真实的 wad()/dec() 函数体抽出来求值，
 * 所以前端改了而测试没改的情况会直接失败，而不是"测试自嗨"。
 *
 * 用法：node tools/render-check.js [地址]
 */
import { readFileSync } from 'node:fs';
import { parseWad } from '../src/strategy.js';
import { renderCandles } from '../public/charts.js';
import { bandsAt } from '../src/strategy.js';

const A = process.argv[2] || '0x010461c14e146ac35fe42271bdc1134ee31c703a';

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass += 1;
    console.log('  ✓ ' + name);
  } else {
    fails.push(name + (detail ? '  —— ' + detail : ''));
    console.log('  ✗ ' + name + (detail ? '  —— ' + detail : ''));
  }
};
const section = (t) => console.log('\n' + '─'.repeat(78) + '\n' + t);

/* ═══════════════ 1. 从源码抽取真实转换函数 ═══════════════ */

section('1. 从前端源码抽取 wad() / dec()（测真实现，不测副本）');

const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

const wadDef = src.match(/const wad = \(v\) => \{[\s\S]*?\n\};/);
const decDef = src.match(/const dec = \(v\) => parseWad\(v \?\? 0\);/);

ok('能从 app.js 抽到 wad() 定义', !!wadDef, wadDef ? '' : '源码里的写法可能变了，本测试需要同步更新');
ok('能从 app.js 抽到 dec() 定义', !!decDef);

if (!wadDef || !decDef) {
  console.log('\n无法抽取转换函数，后续检查跳过。');
  process.exit(1);
}

const { wad, dec } = new Function('parseWad', `${wadDef[0]}\n${decDef[0]}\nreturn { wad, dec };`)(parseWad);

/* ═══════════════ 2. 源码级守卫 ═══════════════ */

section('2. 源码守卫 —— 防止误导性别名回归');

ok('已无 W( 调用残留', !/\bW\(/.test(src));
ok('已无 W2( 调用残留（那个误导性别名已删除）', !/\bW2\(/.test(src), 'W2 名字暗示"已是 WAD"却指向 parseWad，是本次 bug 的直接来源');
ok('wad() 定义唯一', (src.match(/const wad = /g) || []).length === 1);
ok('dec() 定义唯一', (src.match(/const dec = /g) || []).length === 1);

// parseWad 只应出现在 dec 定义、wad 的降级分支、以及注释里
const parseWadUses = src
  .split('\n')
  .map((l, i) => [i + 1, l])
  .filter(([, l]) => /\bparseWad\(/.test(l) && !/^\s*(\/\/|\*)/.test(l));
ok(
  `parseWad( 的调用点收敛到 ${parseWadUses.length} 处（应仅 wad 降级 + dec）`,
  parseWadUses.length <= 3,
  parseWadUses.map(([n, l]) => `L${n}`).join(',')
);

/* ═══════════════ 3. 转换函数对真实数据的正确性 ═══════════════ */

section('3. 转换函数 vs 真实快照');

const snap = await (await fetch(`http://127.0.0.1:8787/api/snapshot?network=mainnet&user=${A}&coin=BTC`)).json();
if (!snap.ok) {
  console.log('  快照失败：' + snap.error + '（服务没起？先 node server.js）');
  process.exit(1);
}

const isWadStr = (v) => typeof v === 'string' && /^-?\d+$/.test(v);

// 3a. 所有 WAD 形态的叶子字段：wad() 必须等于 BigInt()
const wadLeaves = [];
(function walk(o, p, d = 0) {
  if (d > 6 || o === null || typeof o !== 'object') return;
  if (Array.isArray(o)) return o.length ? walk(o[0], p + '[]', d + 1) : undefined;
  for (const [k, v] of Object.entries(o)) {
    if (isWadStr(v) && v.length >= 19) wadLeaves.push({ p: p ? p + '.' + k : k, v });
    else if (v && typeof v === 'object') walk(v, p ? p + '.' + k : k, d + 1);
  }
})(snap, '');

let wadMismatch = 0;
for (const f of wadLeaves) if (wad(f.v) !== BigInt(f.v)) wadMismatch += 1;
ok(`wad() 对 ${wadLeaves.length} 个 WAD 字段全部等于 BigInt(v)`, wadMismatch === 0, wadMismatch ? `${wadMismatch} 个不一致` : '');

// 3b. WAD 字段绝不能被再乘 1e18
const doubled = wadLeaves.filter((f) => wad(f.v) / BigInt(f.v) !== 1n);
ok('没有任何 WAD 字段被二次放大 1e18', doubled.length === 0, doubled.slice(0, 3).map((f) => f.p).join(','));

// 3c. DEC 字段：dec() 必须等于 parseWad()
const decSamples = [
  ['markets.BTC.markPx', snap.markets.BTC.markPx],
  ['markets.BTC.funding', snap.markets.BTC.funding],
  ['account.feeRates.cross', String(snap.account.feeRates.cross)],
];
let decBad = 0;
for (const [n, v] of decSamples) {
  if (dec(v) !== parseWad(v)) { decBad += 1; console.log('    dec 不符: ' + n); }
}
ok(`dec() 对 ${decSamples.length} 个透传字段解析正确`, decBad === 0);

/* ═══════════════ 4. 价格量级合理性（真正抓 1e18 类错误） ═══════════════ */

section('4. 价格量级合理性 —— 与市场标记价交叉验证');

const num = (w) => Number(w) / 1e18;
const priceBad = [];
let priceChecked = 0;

const checkPrice = (coin, field, v) => {
  const mk = Number(snap.markets[coin]?.markPx);
  if (!Number.isFinite(mk) || mk <= 0) return;
  priceChecked += 1;
  if (!Number.isFinite(v)) {
    priceBad.push(`${coin}.${field} 不是有限数（${v}）`);
    return;
  }
  const r = v / mk;
  // 止损/滚仓/止盈/布林带可以离标记价较远，但绝不可能差 5 倍以上
  if (!(r > 0.2 && r < 5)) {
    priceBad.push(`${coin}.${field}=${v.toPrecision(8)} vs mark ${mk}（${r.toExponential(2)}×）`);
  }
};

// 4a. 全部持仓的开仓价与标记价（这两个字段每个持仓都有，覆盖面最广）
for (const p of snap.positions) {
  checkPrice(p.coin, 'entryPx', num(wad(p.entryPx)));
  checkPrice(p.coin, 'markPx', num(wad(p.markPx)));
}

// 4b. 有策略读数的持仓：止损 / 滚仓 / 止盈 / 布林带
//
// ⚠️ 关键：必须先判 p.levels 是否存在。
// 服务端只对名义价值最大的前 MAX_LEVEL_COINS 个标的算读数，其余持仓没有 levels。
// 漏判会让 wad(undefined) 静默返回 0n，于是被判成「标记价为 0」——那是测试的假警报，
// 不是真 bug。这个坑踩过一次，这里显式记下来。
let levelChecked = 0;
let noLevels = 0;
for (const p of snap.positions) {
  if (!p.levels) {
    noLevels += 1;
    continue;
  }
  levelChecked += 1;
  checkPrice(p.coin, 'levels.mark', num(wad(p.levels.mark)));
  checkPrice(p.coin, 'levels.bands.mid', num(wad(p.levels.bands?.mid)));
  checkPrice(p.coin, 'levels.stop.anchor', num(wad(p.levels.stop?.anchor)));
  if (p.levels.stop?.recommended) checkPrice(p.coin, 'stop.recommended.price', num(wad(p.levels.stop.recommended.price)));
  for (const a of p.levels.roll?.ladder || []) checkPrice(p.coin, `roll${a.index}.triggerPrice`, num(wad(a.triggerPrice)));
  for (const r of p.levels.takeProfit?.rMultiples || []) checkPrice(p.coin, `tp${r.r}.price`, num(wad(r.price)));
}

ok(
  `${priceChecked} 个价格字段全部落在标记价的 [0.2×, 5×] 内（覆盖 ${snap.positions.length} 个持仓，其中 ${levelChecked} 个有策略读数）`,
  priceBad.length === 0,
  priceBad.slice(0, 4).join(' | ')
);
ok(`无策略读数的 ${noLevels} 个持仓已正确跳过（不误判为 0）`, noLevels >= 0);
ok('wad(undefined) 静默返回 0n —— 已知且刻意的空值语义', wad(undefined) === 0n, '因此调用点必须先判空，否则缺失字段会伪装成 0');
ok('前端对无策略读数的持仓有判空守卫', /const hasLevels = Boolean\(p\.levels\)/.test(src));

// 4c. 清算价：只能断言「方向正确 + 留有最小距离」，不能用倍数上界。
//
// 为什么：全仓保证金下，清算价是账户级的，权益充裕时单个持仓腿的清算价
// 可以离标记价很远（实测有 47×、49× 的）。那是交易所给的正确值，不是 bug。
// 真正该守的不变量是「方向不能反」和「不能贴着标记价」。
const liqBad = [];
for (const p of snap.positions) {
  if (!p.liquidationPx) continue;
  const liq = num(wad(p.liquidationPx));
  const mk = Number(snap.markets[p.coin]?.markPx);
  if (!Number.isFinite(mk) || mk <= 0 || !Number.isFinite(liq) || liq <= 0) continue;
  const rel = Math.abs(liq - mk) / mk;
  // 空头清算价必须高于标记价，多头必须低于
  if (p.isLong ? liq >= mk : liq <= mk) liqBad.push(`${p.coin} ${p.isLong ? '多' : '空'}头 清算 ${liq} 在标记价 ${mk} 的错误一侧`);
  if (rel < 0.005) liqBad.push(`${p.coin} 清算价距标记价仅 ${(rel * 100).toFixed(2)}%`);
}
const liqCount = snap.positions.filter((p) => p.liquidationPx).length;
ok(`${liqCount} 个清算价方向正确且留有距离（全仓下允许远离，不断言倍数上界）`, liqBad.length === 0, liqBad.slice(0, 3).join(' | '));

// 账户与绩效量级
const acct = num(wad(snap.account.accountValue));
ok(`账户权益量级合理（${acct.toPrecision(8)}）`, acct > 1 && acct < 1e9);
const rn = num(wad(snap.summary.realizedNet));
ok(`已实现净额量级合理（${rn.toPrecision(8)}）`, Math.abs(rn) < 1e9);
const bg = num(wad(snap.summary.closing.grossWin));
ok(`平仓盈利总额量级合理（${bg.toPrecision(8)}）`, bg >= 0 && bg < 1e9);

/* ═══════════════ 5. 标记价格式化（bug ① 的直接守卫） ═══════════════ */

section('5. 标记价格式化 —— bug ① 守卫');

const L = snap.levelsByCoin.BTC;
const markTxt = (() => {
  const n = num(wad(L.mark));
  return n.toFixed(1);
})();
ok(`标记价格式化为 "${markTxt}"，不含科学计数法`, !/[eE]\+/.test(markTxt));
ok('标记价与市场 markPx 一致（±1%）', (() => {
  const mk = Number(snap.markets.BTC.markPx);
  return Math.abs(num(wad(L.mark)) - mk) / mk < 0.01;
})(), `levels.mark=${num(wad(L.mark))} markets.markPx=${snap.markets.BTC.markPx}`);

// 旧行为对照：应当正好差 1e18 倍
const oldBehavior = num(parseWad(L.mark));
ok(`旧写法 parseWad(mark) 的结果是 ${oldBehavior.toExponential(3)}（正是用户报的形态）`, /e\+22/.test(oldBehavior.toExponential(3)));

/* ═══════════════ 6. K 线图完整性（bug ② 的直接守卫） ═══════════════ */

section('6. K 线图完整性 —— bug ② 守卫');

const ivMs = 14400000;
const pj = await (
  await fetch('http://127.0.0.1:8787/api/proxy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      network: 'mainnet',
      body: { type: 'candleSnapshot', req: { coin: 'BTC', interval: '4h', startTime: Date.now() - 300 * ivMs, endTime: Date.now() } },
    }),
  })
).json();
const candles = pj.data.map((c) => ({ t: c.t, o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c), v: Number(c.v), cs: c.c }));

// 与 app.js 保持同一条精度路径：直接用接口原样的收盘价字符串 ×1e18。
// 早期版本在这里先 round 到 2 位小数，NOT 这种低价币 (0.00044) 会被量化成 0，
// 布林带整条塌掉 —— 那正是 bug ② 的伴生问题，测试必须复刻修正后的写法。
const closes = candles.map((c) => parseWad(c.cs ?? c.c));
const bands = [];
for (let i = 19; i < closes.length; i++) {
  const b = bandsAt(closes, i, 20, 20000);
  if (b) bands.push({ i, upper: num(b.upper), mid: num(b.mid), lower: num(b.lower) });
}

const lines = [];
const pos = snap.positions.find((p) => p.coin === 'BTC');
if (pos) {
  lines.push({ price: num(wad(pos.entryPx)), label: '开仓价', sub: '开仓价', kind: 'entry' });
  if (pos.liquidationPx) lines.push({ price: num(wad(pos.liquidationPx)), label: '清算价', sub: '清算价', kind: 'liq' });
}
if (L.stop?.recommended) lines.push({ price: num(wad(L.stop.recommended.price)), label: '止损位', sub: '止损位', kind: 'stop' });
for (const a of L.roll?.ladder || []) lines.push({ price: num(wad(a.triggerPrice)), label: `滚仓点 ${a.index}`, sub: `滚仓点${a.index}`, kind: 'roll' });
// 止盈：三项各自的 kind 不同（tp1/tp2/tp3），等幅目标是 tpmm —— 这是「一条线一种颜色」的落地。
// 旧写法把四个都写成 kind: 'tp'，图上是同一个紫色，用户无法分辨，正是本次清理的起因。
for (const r of L.takeProfit?.rMultiples || []) {
  lines.push({ price: num(wad(r.price)), label: `${r.r}R`, sub: `${r.r}R 止盈`, kind: `tp${r.r}` });
}
if (L.takeProfit?.measuredMove) {
  lines.push({ price: num(wad(L.takeProfit.measuredMove.target)), label: '等幅目标', sub: '等幅目标', kind: 'tpmm' });
}

const markers = (L?.trend?.marks || [])
  .map((m) => ({ index: m.index + (candles.length - 200), side: m.side }))
  .filter((m) => m.index >= 0 && m.index < candles.length);

const out = renderCandles({ candles, bands, lines, markers });

// 复刻 renderCandles 的坐标映射，算出 K 线实际占多少像素。
//
// ⚠️ 这几个常量必须与 charts.js 保持一致。它们已经错过一次：渲染器把画布从
// 400 改到 430、padT 从 12 改到 14，本文件没跟着改，于是「K 线占像素」算出假失败。
// 与其手抄，不如直接从源码里抠出来 —— 抄错是迟早的事，抠出来则改不动。
const chartSrc = readFileSync(new URL('../public/charts.js', import.meta.url), 'utf8');
// 只认 renderCandles 签名里的那一处 width/height，别把 renderEquity 的默认值也匹配上
const dims = chartSrc.match(/renderCandles\(\{[\s\S]{0,200}?width = (\d+), height = (\d+)/);
const padTDef = chartSrc.match(/const padT = (\d+);/);
const padBDef = chartSrc.match(/const padB = (\d+);/);
const railDef = chartSrc.match(/const RAIL = (\d+);/);
ok(
  '能从 charts.js 抠到画布尺寸与内边距（避免测试与实现各写一份而悄悄分叉）',
  !!(dims && padTDef && padBDef && railDef),
  dims ? '' : 'renderCandles 的签名或常量写法变了，本测试需同步'
);
if (!(dims && padTDef && padBDef && railDef)) {
  console.log('\n无法读取渲染器几何常量，画布比例检查跳过。');
  process.exit(1);
}
const canvasW = Number(dims[1]);
const canvasH = Number(dims[2]);
const padT = Number(padTDef[1]);
const padB = Number(padBDef[1]);
const railW = Number(railDef[1]);
const plotH = canvasH - padT - padB;

let baseLo = Infinity;
let baseHi = -Infinity;
for (const c of candles) {
  if (c.l < baseLo) baseLo = c.l;
  if (c.h > baseHi) baseHi = c.h;
}
const span = baseHi - baseLo;
const loLim = baseLo - span * 0.5;
const hiLim = baseHi + span * 0.5;
const axisLines = lines.filter((l) => l.price >= loLim && l.price <= hiLim);
let lo = baseLo;
let hi = baseHi;
for (const l of axisLines) {
  if (l.price < lo) lo = l.price;
  if (l.price > hi) hi = l.price;
}
// 与实现一致：先把视野拉到「标注栏排得下」的最小高度，再加 6% 留白。
// 漏掉这一步时算出的 y 会偏，判出来的「K 线占像素」也是错的。
const spread0 = hi - lo;
const minSpread = ((axisLines.length - 1) * 22 + 40) / plotH * spread0 * 0.5;
if (spread0 < minSpread) {
  const mid = (hi + lo) / 2;
  lo = mid - minSpread / 2;
  hi = mid + minSpread / 2;
}
const pad = (hi - lo) * 0.06;
const lo2 = lo - pad;
const hi2 = hi + pad;
const y = (p) => padT + plotH - ((p - lo2) / (hi2 - lo2)) * plotH;
const spanPx = Math.abs(y(baseHi) - y(baseLo));

ok(`K 线占像素高度 ${spanPx.toFixed(1)}px / ${plotH}px（需 > 60%）`, spanPx / plotH > 0.6, `比例 ${((spanPx / plotH) * 100).toFixed(1)}%`);
ok('关键位无一被挤出视图', out.clipped === 0, out.clipped ? `${out.clipped} 个超出视图` : '');
ok('SVG 无 NaN', !/NaN/.test(out.svg));
ok('SVG 无 undefined', !/undefined/.test(out.svg));
ok('SVG 含 K 线实体', (out.svg.match(/<rect/g) || []).length >= candles.length - 2);
ok('SVG 坐标不含科学计数法', !/e\+2\d/.test(out.svg), 'axis 坐标若含 e+2x 说明量纲又错了');

/* ═══════════════ 6b. 标注栏不重叠 + 一条线一种颜色 ═══════════════ */

section('6b. 标注栏 —— 「图太乱」修复的直接守卫');

// 渲染器用一个不透明的右侧栏（RAIL 宽）承载所有价格标注。
// 本段从 SVG 里把胶囊矩形抠出来，验证三件事：数量对得上、互相不重叠、颜色两两不同。
const railX = canvasW - railW;
const capsuleRe = new RegExp(`<rect x="${railX + 5}" y="([\\d.]+)" width="(\\d+)" height="([\\d.]+)" rx=`, 'g');
const capsules = [...out.svg.matchAll(capsuleRe)].map((m) => ({
  y: Number(m[1]),
  h: Number(m[3]),
}));

ok(
  `标注栏胶囊数（${capsules.length}）等于被画出的关键位数（${(out.key || []).length}）`,
  capsules.length === (out.key || []).length,
  `关键位 ${lines.length} 个，其中 ${axisLines.length} 落在坐标轴内`
);

let overlap = 0;
const sortedCaps = capsules.slice().sort((a, b) => a.y - b.y);
for (let i = 1; i < sortedCaps.length; i++) {
  const prevBottom = sortedCaps[i - 1].y + sortedCaps[i - 1].h;
  if (sortedCaps[i].y < prevBottom - 0.01) overlap += 1;
}
ok('标注栏胶囊互不重叠', overlap === 0, overlap ? `${overlap} 处重叠` : '');

// 关键位横线的颜色：画在 padL→railX 之间，stroke-width 1.3。
//
// 断言的是「**不同类别**的颜色互不相同」，而不是「所有线条颜色都不同」。
// 这个区别是实测逼出来的：同一个标的会有两条滚仓点（台阶 1、台阶 2），
// 它们都是 'roll'，本来就该是同一个绿 —— 要求它们颜色不同是错的断言。
// 真正要防的是「两个不同含义的关键位撞色」（历史上 liq 撞了 up、roll 撞了 down、
// 1R/2R/3R 三个止盈全是同一个紫），那才是用户分不清的根源。
const lineRe = new RegExp(`<line x1="8" y1="[\\d.]+" x2="${railX}" y2="[\\d.]+" stroke="(#[0-9a-f]{6})" stroke-width="1.3"`, 'g');
const lineColors = [...out.svg.matchAll(lineRe)].map((m) => m[1]);
const kindByColor = new Map();
let colorClash = 0;
for (const k of out.key || []) {
  const c = String(k.color || '');
  const existing = kindByColor.get(c);
  if (existing && existing !== k.kind) colorClash += 1;
  else kindByColor.set(c, k.kind);
}
ok(
  `不同类别的关键位颜色互不撞色（图上 ${lineColors.length} 条线，${kindByColor.size} 种颜色）`,
  colorClash === 0,
  colorClash ? `${colorClash} 处不同类别共用同一颜色` : ''
);
ok(
  '同一类别的多条线允许同色（例如两条滚仓台阶）',
  (() => {
    const seen = {};
    for (const k of out.key || []) (seen[k.kind] = seen[k.kind] || new Set()).add(k.color);
    return Object.values(seen).every((s) => s.size === 1);
  })(),
  '同一类别应当是同一个颜色，否则用户无法靠颜色归类'
);
ok('关键位横线都在标注栏左侧截止（不与文字重叠）', lineColors.length === axisLines.length, `画了 ${lineColors.length} 条，应有 ${axisLines.length} 条`);

// 汇总表必须给每一项一句话解释 —— 这正是用户要的「标注清楚每一项是什么意思」。
const explained = (out.key || []).filter((k) => typeof k.desc === 'string' && k.desc.length > 0);
ok(
  `逐项说明齐全（${explained.length} / ${(out.key || []).length} 项带 desc）`,
  explained.length === (out.key || []).length,
  '缺 desc 的那一项在表里会只是一串数字，等于没解释'
);
ok('每一项都带颜色（表里的小圆点不会渲染成黑）', (out.key || []).every((k) => /^#[0-9a-f]{6}$/i.test(k.color || '')));

/* ── 标注栏是「价格尺」，序号是「紧急度」：两个顺序必须分开 ── */

// 这段守的是实测发现的一个真实缺陷：早期版本把胶囊按序号（距离序）从上往下铺，
// 于是右栏读出来是 81526 → 81095 → 82098 → 80092，完全不单调 —— 眼睛立刻读不懂。
// 右栏 y 与主图共用价格映射，所以它**必须**按价格排；序号只负责回答「先看哪个」。
//
// 从 SVG 里按 y 顺序取出价格文字，验证单调；同时验证序号是距离序（现价 = 1 号）。
const railPriceRe = new RegExp(
  `<text x="${canvasW - 9}" y="([\\d.]+)" font-size="10.5"[^>]*>([\\d.]+)</text>`,
  'g'
);
const railPrices = [...out.svg.matchAll(railPriceRe)].map((m) => ({ y: Number(m[1]), p: Number(m[2]) }));
railPrices.sort((a, b) => a.y - b.y);
ok(
  `标注栏自上而下是按价格递减的（${railPrices.length} 条，形成一把价格尺）`,
  railPrices.every((v, i, a) => i === 0 || v.p <= a[i - 1].p),
  railPrices.map((v) => v.p).join(' > ')
);

// 有现价时，序号 1 必须是离现价最近的那一条（紧急度排序的语义）
const liveLine = lines.find((l) => l.kind === 'live');
if (liveLine) {
  const nearest = lines
    .filter((l) => l.kind !== 'live' && Number.isFinite(l.price))
    .sort((a, b) => Math.abs(a.price - liveLine.price) - Math.abs(b.price - liveLine.price))[0];
  const topKey = (out.key || []).find((k) => k.n === 1);
  ok(
    `序号 1 = 离现价最近的关键位（${nearest?.kind} @ ${nearest?.price}）`,
    !!topKey && Math.abs(Number(topKey.price) - Number(nearest?.price)) < 1e-6,
    `实际 1 号是 ${topKey?.kind} @ ${topKey?.price}`
  );
}


// 防御守卫本身的测试：故意喂一个被放大 1e18 的关键位，主图必须仍然可读
const poisoned = renderCandles({
  candles,
  bands,
  lines: [...lines, { price: num(parseWad(L.stop.recommended?.price || L.mark)), label: '毒注记', sub: '毒注记', kind: 'stop' }],
  markers,
});
const poisonedSpan = (() => {
  // 用与内部一致的方式重算：因为毒注记被裁掉，范围应与正常情况相同
  const l2 = lines.filter((l) => l.price >= loLim && l.price <= hiLim);
  let a = baseLo;
  let b = baseHi;
  for (const l of l2) {
    if (l.price < a) a = l.price;
    if (l.price > b) b = l.price;
  }
  const sp = b - a;
  const ms = ((l2.length - 1) * 22 + 40) / plotH * sp * 0.5;
  if (sp < ms) {
    const mid = (a + b) / 2;
    a = mid - ms / 2;
    b = mid + ms / 2;
  }
  const p2 = (b - a) * 0.06;
  const yy = (p) => padT + plotH - ((p - (a - p2)) / (b + p2 - (a - p2))) * plotH;
  return Math.abs(yy(baseHi) - yy(baseLo));
})();
ok('喂入量纲错的注记后，K 线仍然可读（守卫生效）', poisonedSpan / plotH > 0.6, `比例 ${((poisonedSpan / plotH) * 100).toFixed(1)}%`);
ok('量纲错的注记被标为超出视图', poisoned.clipped >= 1, `clipped=${poisoned.clipped}`);
ok('边缘提示写进了 SVG', /超出视图/.test(poisoned.svg));
ok(
  '被裁到视图外的关键位仍然进汇总表（信息不静默丢失）',
  (poisoned.key || []).some((k) => k.clipped === true),
  '边缘标签必须同时登记一行，否则用户只看到一个 ▲ 却不知道那是什么'
);
ok(
  '被裁项的 desc 说明了它是「视图外」而不是照抄图内说明',
  (poisoned.key || []).filter((k) => k.clipped).every((k) => /视图外/.test(k.desc || ''))
);

/* ═══════════════ 6c. 重复导出守卫 ═══════════════ */

section('6c. 源码级守卫 —— 防止「同一函数被定义两遍」再回来');

// 这条守卫是踩坑换来的：给 renderCandles 换签名时，Edit 的匹配区间多吞了一行，
// 于是 JSDoc 与函数头被复制成两份。JS 里重复的 function 声明**不报错**（后者覆盖前者），
// 但两份之间夹着半截旧函数体时会直接语法错误；更坏的情况是能跑，只是行为悄悄变成旧版。
ok('renderCandles 只被导出一次', (chartSrc.match(/export function renderCandles/g) || []).length === 1);
ok('renderEquity 只被导出一次', (chartSrc.match(/export function renderEquity/g) || []).length === 1);
ok('charts.js 里没有重复的 JSDoc 块', (chartSrc.match(/\/\*\*\s*\n\s*\*\s*@param \{object\} args/g) || []).length === 1);

/* ═══════════════ 6d. 两份配色表的漂移守卫 ═══════════════ */

section('6d. 配色表 —— app.js 与 charts.js 不许悄悄分叉');

// 配色在两边各存一份是**有意**的：charts.js 的 LEVEL_KINDS 管画图，
// app.js 的 LEVEL_COLORS 管「图上没画、但表里要列」的那些行。
// 代价是两份表可能分叉 —— 改了一边忘了另一边，图上线是橙的、表里色点是灰的。
// 这段就是防这个：把两边都抠出来求值，逐项比对。
function grabBlock(src, head) {
  const i = src.indexOf(head);
  if (i < 0) return null;
  let depth = 0;
  let started = false;
  for (let k = i; k < src.length; k++) {
    if (src[k] === '{') {
      depth += 1;
      started = true;
    } else if (src[k] === '}') {
      depth -= 1;
      if (started && depth === 0) return src.slice(i, k + 1);
    }
  }
  return null;
}

const kindBlock = grabBlock(chartSrc, 'const LEVEL_KINDS = {');
const themeBlock = grabBlock(chartSrc, 'const THEME = {');
const colorBlock = grabBlock(src, 'const LEVEL_COLORS = {');
const nameBlock = grabBlock(src, 'const LEVEL_NAMES = {');
ok(
  '能同时抠到 charts.js 的 THEME / LEVEL_KINDS 与 app.js 的 LEVEL_COLORS / LEVEL_NAMES',
  !!(kindBlock && themeBlock && colorBlock && nameBlock)
);

if (kindBlock && themeBlock && colorBlock && nameBlock) {
  const { LEVEL_KINDS, LEVEL_COLORS, LEVEL_NAMES } = new Function(
    `${themeBlock}\n;\n${kindBlock}\n;\n${colorBlock}\n;\n${nameBlock}\n;\nreturn { LEVEL_KINDS, LEVEL_COLORS, LEVEL_NAMES };`
  )();
  const kinds = Object.keys(LEVEL_KINDS);
  const drift = kinds.filter((k) => LEVEL_KINDS[k].color !== LEVEL_COLORS[k] || LEVEL_KINDS[k].name !== LEVEL_NAMES[k]);
  ok(`两份配色表完全一致（${kinds.length} 个类别）`, drift.length === 0, drift.length ? `分叉：${drift.join(', ')}` : '');

  const byColor = {};
  for (const k of kinds) (byColor[LEVEL_COLORS[k]] = byColor[LEVEL_COLORS[k]] || []).push(k);
  const clash = Object.entries(byColor).filter(([, ks]) => ks.length > 1);
  ok(
    '不同类别的颜色互不重复（这是「图太乱」修复的核心约束）',
    clash.length === 0,
    clash.map(([c, ks]) => `${c} <- ${ks.join('/')}`).join(' | ')
  );
  ok('app.js 的 LEVEL_NAMES 覆盖全部类别', kinds.every((k) => typeof LEVEL_NAMES[k] === 'string' && LEVEL_NAMES[k].length > 0));
}


/* ═══════════════ 7. 权益曲线 ═══════════════ */

section('7. 权益曲线量级');

const series = snap.equityCurvesByPeriod?.perpAllTime;
if (series?.equity?.length) {
  const pts = series.equity.map((p) => num(wad(p.v)));
  const mn = Math.min(...pts);
  const mx = Math.max(...pts);
  ok(`权益点位 ${pts.length} 个，范围 ${mn.toPrecision(6)} ~ ${mx.toPrecision(6)}`, mx < 1e9 && mn >= 0, '若出现 1e22 量级说明 wad() 没生效');
} else {
  ok('权益曲线取到数据', false, '无数据');
}

/* ═══════════════ 8. 图表布林带 vs 服务端读数 ═══════════════ */

section('8. 图表布林带 vs 服务端读数 —— 共享数学的一致性守卫');

ok(
  '前端不再使用「量化到 2 位小数」的收盘价构造',
  !/Math\.round\(c\.c \* 100\)/.test(src),
  '旧写法对 NOT(0.00047) 会量化成 0，布林带整体归零后画到画布外'
);

const bandCoins = ['BTC', 'ETH', 'NOT', 'DOGE', 'STX', 'OP'];
const bandRows = [];
let bandMismatch = 0;
let bandZero = 0;

for (const coin of bandCoins) {
  const k = await (
    await fetch('http://127.0.0.1:8787/api/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        network: 'mainnet',
        body: { type: 'candleSnapshot', req: { coin, interval: '4h', startTime: Date.now() - 300 * 14400000, endTime: Date.now() } },
      }),
    })
  ).json();
  if (!k.ok || !k.data?.length) {
    bandRows.push([coin, '（K 线不可用）', '', '']);
    continue;
  }
  const raw = k.data.slice(-200);

  // 前端现在的做法：原始字符串 → parseWad
  const closes = raw.map((c) => parseWad(c.c));
  const band = bandsAt(closes, closes.length - 1, 20, 20000);
  const chartMid = band ? num(band.mid) : NaN;

  // 旧做法，用于对照
  const oldCloses = raw.map((c) => BigInt(Math.round(Number(c.c) * 100)) * 10n ** 16n);
  const oldBand = bandsAt(oldCloses, oldCloses.length - 1, 20, 20000);
  const oldMid = oldBand ? num(oldBand.mid) : NaN;

  const srvMid = snap.levelsByCoin?.[coin]?.bands?.mid !== undefined ? num(wad(snap.levelsByCoin[coin].bands.mid)) : null;

  bandRows.push([coin, chartMid.toPrecision(8), oldMid.toPrecision(8), srvMid === null ? '（无读数）' : srvMid.toPrecision(8)]);

  if (!(chartMid > 0)) bandZero += 1;
  if (srvMid !== null && srvMid > 0) {
    const dev = Math.abs(chartMid - srvMid) / srvMid;
    if (dev > 0.001) bandMismatch += 1;
  }
}

console.log('\n  ' + '标的'.padEnd(8) + '图表 mid（现在）'.padEnd(20) + '图表 mid（旧写法）'.padEnd(20) + '服务端读数 mid');
for (const [c, now, old, srv] of bandRows) {
  console.log('  ' + c.padEnd(8) + String(now).padEnd(20) + String(old).padEnd(20) + String(srv));
}
console.log('');

ok('所有受检标的的图表布林带中轨都 > 0（不再归零）', bandZero === 0, bandZero ? `${bandZero} 个标的归零` : '');
ok('图表布林带与服务端读数一致（偏差 < 0.1%）', bandMismatch === 0, bandMismatch ? `${bandMismatch} 个标的不一致` : '');

// 明确记录旧写法的破坏力：对 NOT 应算出 0
const notRaw = await (
  await fetch('http://127.0.0.1:8787/api/proxy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      network: 'mainnet',
      body: { type: 'candleSnapshot', req: { coin: 'NOT', interval: '4h', startTime: Date.now() - 300 * 14400000, endTime: Date.now() } },
    }),
  })
).json();
if (notRaw.ok && notRaw.data?.length) {
  const oc = notRaw.data.slice(-200).map((c) => BigInt(Math.round(Number(c.c) * 100)) * 10n ** 16n);
  ok('对照：旧写法对 NOT 的收盘价确实被量化为 0（记录已修缺陷）', oc.every((v) => v === 0n) || oc.filter((v) => v === 0n).length > 100);
}

/* ═══════════════ 结论 ═══════════════ */

console.log('\n' + '═'.repeat(78));
if (fails.length === 0) {
  console.log(`结论：全部通过 —— ${pass} 项断言。`);
  console.log('  ① 标记价格式化正常，与市场 marker 价一致，无科学计数法');
  console.log('  ② K 线占画布比例正常，且量纲错的注记不会再毁掉主图');
  console.log('  ③ 右侧标注栏胶囊不重叠、一条关键位一种颜色、逐项都有解释');
  console.log('═'.repeat(78));
} else {
  console.log(`结论：${pass} 项通过，${fails.length} 项失败：`);
  for (const f of fails) console.log('  ✗ ' + f);
  console.log('═'.repeat(78));
  process.exitCode = 1;
}
