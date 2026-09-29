/**
 * 把**真实快照**喂给**真实 renderMacro**，渲染出一份自包含 HTML，供肉眼验收
 * 「比特皇判据层」到底长什么样。
 *
 * 为什么不用浏览器截图：这份工具链走的是源码级复用 —— 直接把 public/app.js 里的
 * renderMacro 连同它的辅助函数一起摘出来跑，样式用 public/styles.css 原文内联。
 * 好处是测试工具和线上渲染不可能分叉：renderMacro 改了，这里立刻跟着变。
 *
 * 用法：
 *   node tools/macro-shot.mjs                                  # 默认地址 + BTC
 *   node tools/macro-shot.mjs <地址> <币种>
 *   node tools/macro-shot.mjs <地址> <币种> out.html
 *
 * 产物默认写到 tools/macro-shot-out/macro.html，与 tools/chart-shot.js 的约定一致
 * （不放 .cache —— .cache 是可以随时清掉的中间产物目录，验收件不该混在里面）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIRECTION_CRITERIA } from '../src/regime-criteria.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const BASE = process.env.HL_BASE || 'http://127.0.0.1:8787';
const USER = process.argv[2] || '0x010461c14e146ac35fe42271bdc1134ee31c703a';
const COIN = process.argv[3] || 'BTC';
const OUT = process.argv[4] || path.join(ROOT, 'tools', 'macro-shot-out', 'macro.html');

/* ── 1. 真实快照 ── */
let snap;
try {
  const res = await fetch(`${BASE}/api/snapshot?network=mainnet&user=${USER}&coin=${COIN}`);
  snap = await res.json();
} catch (e) {
  console.error(`无法连接看板 ${BASE} —— 先启动它（node server.js）再跑本工具。`);
  process.exit(1);
}
if (!snap.ok) {
  console.error('快照失败：' + snap.error);
  process.exit(1);
}
if (!snap.regime) {
  console.error('快照里没有 regime —— 方向层缺席，无法验收判据层。');
  process.exit(1);
}

/* ── 2. 从 app.js 摘出真实渲染函数 ──
 *
 * 这几个标记刻意用**代码**而不是注释 —— 注释会被改写，代码不会。
 * 与 tools/macro-render-smoke.mjs 用的是同一组标记，改一处两边一起动。 */
const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
function slice(from, to) {
  const a = src.indexOf(from);
  if (a < 0) throw new Error(`找不到起点标记：${from}`);
  const b = src.indexOf(to, a);
  if (b < 0) throw new Error(`找不到终点标记：${to}`);
  return src.slice(a, b);
}
const trendPips = slice('function trendPips(L) {', '\n/* 系统二的进度条');
const metaBlocks = slice('const HOLD_META = {', '\nfunction setupPips');
const setupPips = slice('function setupPips(L) {', '\nconst BIAS_META = {');
const renderMacro = slice('const BIAS_META = {', '\nfunction renderStrategy(s) {');

const el = { innerHTML: '' };
const $ = (id) => (id === 'macro' ? el : null);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (x, dp = 2) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(dp));
const pct = (x, dp = 2) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(dp)}%`);

/* renderMacro 在清单未就绪时会去 fetch；离线产出快照时不能依赖它，
 * 所以直接预置 CRITERIA_CACHE（走 __setCriteria，保证写的是同一个闭包变量）。 */
const setter = '\nfunction __setCriteria(v) { CRITERIA_CACHE = v; }\n';
const factory = new Function(
  '$', 'esc', 'num', 'pct',
  `${metaBlocks}\n${trendPips}\n${setupPips}\n${renderMacro}\n${setter}\nreturn { renderMacro, __setCriteria, BIAS_META };`
);
const api = factory($, esc, num, pct);
api.__setCriteria({
  ok: true,
  total: DIRECTION_CRITERIA.length,
  implemented: DIRECTION_CRITERIA.filter((c) => c.implemented === true).length,
  partial: DIRECTION_CRITERIA.filter((c) => c.implemented === 'partial').length,
  manual: DIRECTION_CRITERIA.filter((c) => c.implemented === false).length,
  criteria: DIRECTION_CRITERIA,
});

api.renderMacro(snap);
const cardHtml = el.innerHTML;

/* ── 3. 组装自包含 HTML，样式用 styles.css 原文 ── */
const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
const r = snap.regime;

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<title>比特皇判据层验收 · ${esc(COIN)}</title>
<style>
${css}
body { background: #f4f6f9; margin: 0; padding: 18px; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
.wrap { max-width: 1180px; margin: 0 auto; }
.lede { background:#fff; border:1px solid #e3e8ef; border-radius:10px; padding:14px 16px; margin-bottom:16px; }
.lede h1 { margin:0 0 6px; font-size:17px; }
.lede p { margin:4px 0; font-size:13px; color:#4a5568; line-height:1.65; }
.lede code { background:#f1f4f8; padding:1px 5px; border-radius:4px; font-size:12px; }
.card { background:#fff; border:1px solid #e3e8ef; border-radius:10px; overflow:hidden; }
</style></head>
<body><div class="wrap">
  <div class="lede">
    <h1>比特皇「判断大方向」的判据 —— 实际渲染验收</h1>
    <p>这是 <strong>真实的 renderMacro</strong>（直接取自 <code>public/app.js</code>）配上
       <strong>真实快照</strong>（<code>${esc(BASE)}</code>，地址 <code>${esc(USER.slice(0, 10))}…</code>，标的 ${esc(COIN)}）
       渲染出来的宏观方向卡，不是示意图。</p>
    <p>快照时间 ${esc(snap.fetchedAt || '—')} · 方向 bias = <b>${esc(r.bias)}</b> ·
       顶部刹车 ${r.topBrake ? '<b>生效</b>' : '未生效'} ·
       底部确认 ${r.reversal?.bottomConfirm ? '<b>成立</b>' : '未成立'}。</p>
  </div>
  <div class="card macro">${cardHtml}</div>
</div></body></html>
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html, 'utf8');

const bytes = Buffer.byteLength(html, 'utf8');
console.log(`已生成：${OUT}`);
console.log(`  ${(bytes / 1024).toFixed(1)} KB · 判据 ${DIRECTION_CRITERIA.length} 条（已实现 ${DIRECTION_CRITERIA.filter((c) => c.implemented === true).length} / 部分 ${DIRECTION_CRITERIA.filter((c) => c.implemented === 'partial').length} / 人工 ${DIRECTION_CRITERIA.filter((c) => c.implemented === false).length}）`);
console.log(`  bias=${r.bias} topBrake=${r.topBrake} bottomConfirm=${!!r.reversal?.bottomConfirm}`);
