/**
 * 测试网端到端走查 —— 用真实前端代码跑一遍测试网数据。
 *
 * 与 render-dom-smoke.js 的区别：
 *   · 那个跑主网，验证 bug ① ② 的修复；
 *   · 这个跑**测试网**，验证「切到测试网」这条路径本身没坏 ——
 *     请求是否带对了 network、WS 是否连到 testnet、标签/空态是否正确，
 *     以及测试网的标的命名（1000xxx / kPEPE / #102170 这类）会不会把界面搞坏。
 *
 * 用法：node tools/testnet-e2e.js <地址> [empty]
 *   empty = 期望这是一个空账户，此时按「优雅空态」的预期断言。
 */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'public', 'app.js');
const HTML = path.join(ROOT, 'public', 'index.html');
const ORIGIN = 'http://127.0.0.1:8787';

const ADDR = process.argv[2];
const EXPECT_EMPTY = process.argv.includes('empty');
if (!ADDR) { console.log('用法：node tools/testnet-e2e.js <测试网地址> [empty]'); process.exit(1); }

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fails.push(name + (detail ? '  —— ' + detail : '')); console.log('  ✗ ' + name + (detail ? '  —— ' + detail : '')); }
};
const section = (t) => console.log('\n' + '─'.repeat(78) + '\n' + t);

console.log(`测试网端到端走查   地址 ${ADDR}${EXPECT_EMPTY ? '（期望空账户）' : ''}`);

/* ═══════════════ 1. DOM 垫片（带分段控件子节点，用于断言 active） ═══════════════ */

section('1. 搭建 DOM 垫片');

const html = readFileSync(HTML, 'utf8');
const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);

function makeEl(id) {
  const el = {
    id, tagName: 'DIV', _html: '', textContent: '', value: '', checked: false,
    className: '', disabled: false, style: {}, dataset: {}, options: [], children: [], title: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, closest: () => null,
    querySelector: () => makeEl(id + ':sub'), querySelectorAll: () => [],
  };
  Object.defineProperty(el, 'innerHTML', { get: () => el._html, set: (v) => { el._html = String(v); } });
  return el;
}

const els = new Map();
for (const id of ids) els.set(id, makeEl(id));

/** 记下分段控件里哪个按钮被标成 active —— 这是「切到测试网」的可见证据 */
function segBtn(network, isActive) {
  const active = new Set(isActive ? ['active'] : []);
  return {
    dataset: { network },
    classList: {
      add: (c) => active.add(c),
      remove: (c) => active.delete(c),
      toggle: (c, on) => { if (on === undefined) { active.has(c) ? active.delete(c) : active.add(c); } else if (on) active.add(c); else active.delete(c); },
      contains: (c) => active.has(c),
    },
    _active: () => [...active],
  };
}
const segChildren = [segBtn('mainnet', true), segBtn('testnet', false)];
els.get('network-seg').children = segChildren;

const missingIds = new Set();
const touchedIds = new Set();
const documentShim = {
  getElementById(id) {
    touchedIds.add(id);
    if (!els.has(id)) { missingIds.add(id); return null; }
    return els.get(id);
  },
  querySelector: () => makeEl('doc'), querySelectorAll: () => [],
  createElement: (t) => makeEl('created:' + t), addEventListener() {}, body: makeEl('body'),
};

const store = new Map();
store.set('bithuang-hl-dashboard/v1', JSON.stringify({
  network: 'testnet', address: ADDR, coin: 'BTC', interval: '4h', phase: 'ACCUMULATION',
}));
const localStorageShim = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const sockets = [];
class WebSocketShim {
  static OPEN = 1;
  constructor(url) { this.url = url; this.readyState = 1; this.sent = []; sockets.push(this); }
  send(d) { this.sent.push(d); }
  close() { this.readyState = 3; }
}

const realSetTimeout = globalThis.setTimeout;
const realFetch = globalThis.fetch;
const requestLog = [];
globalThis.fetch = (url, opts) => {
  const u = String(url).startsWith('http') ? String(url) : ORIGIN + url;
  const entry = { url: u, body: opts?.body ? String(opts.body) : null };
  requestLog.push(entry);
  return realFetch(u, opts);
};

const consoleErrors = [];
const realConsoleError = console.error;
console.error = (...a) => consoleErrors.push(a.map(String).join(' '));

globalThis.document = documentShim;
globalThis.localStorage = localStorageShim;
globalThis.WebSocket = WebSocketShim;
ok(`DOM 垫片就绪（${ids.length} 个元素桩）`, ids.length > 20);

/* ═══════════════ 2. 执行 app.js ═══════════════ */

section('2. import 并执行 public/app.js（network=testnet）');

const src = readFileSync(APP, 'utf8');
const rewritten = src
  .replace(/from '\/src\/([^']+)'/g, (_m, f) => `from '${pathToFileURL(path.join(ROOT, 'src', f)).href}'`)
  .replace(/from '\.\/([^']+)'/g, (_m, f) => `from '${pathToFileURL(path.join(ROOT, 'public', f)).href}'`);
const tmp = path.join(ROOT, 'public', '__testnet_e2e_app.mjs');
writeFileSync(tmp, rewritten, 'utf8');

let importErr = null;
try { await import(pathToFileURL(tmp).href); } catch (e) { importErr = e; }
ok('app.js 能被 import 且顶层不抛错', !importErr, importErr ? importErr.constructor.name + ': ' + importErr.message : '');

if (importErr) {
  realConsoleError(importErr);
  try { unlinkSync(tmp); } catch {}
  console.log('\nimport 阶段失败，后续断言跳过。');
  process.exit(1);
}

await new Promise((r) => realSetTimeout(r, 12000));

/* ═══════════════ 3. 网络路由断言 ═══════════════ */

section('3. 网络路由 —— 请求有没有真的打到测试网');

const snapReq = requestLog.filter((r) => r.url.includes('/api/snapshot'));
ok('发出了快照请求', snapReq.length > 0, `请求数 ${requestLog.length}`);
ok('快照请求带 network=testnet', snapReq.every((r) => r.url.includes('network=testnet')), snapReq.map((r) => r.url).join(' | '));
ok('快照请求带对了地址', snapReq.every((r) => r.url.includes('user=' + ADDR)));

const proxyReq = requestLog.filter((r) => r.url.includes('/api/proxy'));
ok('发出了 K 线代理请求', proxyReq.length > 0);
ok('K 线代理请求体里 network=testnet', proxyReq.every((r) => (r.body || '').includes('"network":"testnet"')), proxyReq.map((r) => r.body).join(' | '));

ok('app.js 打开了 WebSocket', sockets.length > 0, `实例数 ${sockets.length}`);
if (sockets.length) {
  ok('WebSocket 连到测试网地址', /api\.hyperliquid-testnet\.xyz\/ws/.test(sockets[0].url), sockets[0].url);
  sockets[0].onopen?.();
  ok('连接后订阅 allMids', sockets[0].sent.some((s) => s.includes('allMids')), JSON.stringify(sockets[0].sent));
}

/* ═══════════════ 4. 渲染断言 ═══════════════ */

section('4. 渲染结果断言');

ok('app.js 没有访问 index.html 里不存在的 id', missingIds.size === 0, [...missingIds].join(', '));

const panels = ['kpis', 'strategy', 'positions', 'equity', 'performance', 'bycoin', 'fills', 'orders', 'funding', 'deposits', 'warnings', 'chart', 'chart-legend', 'equity-legend'];
const emptyPanels = [];
for (const p of panels) {
  const el = els.get(p);
  if (!el || !el._html || el._html.length < 20) emptyPanels.push(`${p}(${el?._html?.length ?? 0})`);
}
ok(`${panels.length} 个面板都渲染出了内容`, emptyPanels.length === 0, emptyPanels.join(', '));

const BAD = ['undefined', 'NaN', '[object Object]', 'Infinity'];
const badHits = {};
for (const p of panels) {
  const h = els.get(p)?._html || '';
  for (const b of BAD) {
    const n = (h.match(new RegExp(b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    if (n) badHits[`${p}:${b}`] = n;
  }
}
ok('面板 HTML 里没有 undefined / NaN / [object Object] / Infinity', Object.keys(badHits).length === 0, JSON.stringify(badHits));

const sciHits = {};
for (const p of panels) {
  const m = (els.get(p)?._html || '').match(/\d\.\d{2,}e\+\d{2,}/g);
  if (m) sciHits[p] = m.slice(0, 3).join(', ');
}
ok('面板 HTML 里没有科学计数法数字', Object.keys(sciHits).length === 0, JSON.stringify(sciHits));
ok('渲染过程没有 console.error', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

// 测试网标识必须在界面上出现
const foot = els.get('foot-status')?.textContent || '';
ok('页脚标注了测试网与地址', foot.includes('测试网') && foot.includes(ADDR), foot.slice(0, 160));
const kpiHtml = els.get('kpis')._html;
ok('KPI 里标注了测试网', kpiHtml.includes('测试网'), kpiHtml.slice(0, 200).replace(/\n/g, ' '));
ok('分段控件的 active 落在「测试网」按钮上', segChildren[1].classList.contains('active') && !segChildren[0].classList.contains('active'),
  `mainnet=${segChildren[0]._active()} testnet=${segChildren[1]._active()}`);

// 最大回撤的可信度标记 —— 自适应断言：
// 拿后端原始快照看它有没有标 plausible:false，然后要求界面与之一致。
// 测试网这个场景真的会触发（某账户算出 164%，越过 100% 的物理上界）。
{
  const probe = await (await realFetch(`${ORIGIN}/api/snapshot?network=testnet&user=${ADDR}&coin=BTC&phase=ACCUMULATION`)).json();
  const ddRaw = probe.equityCurve?.maxDrawdown;
  const doubtful = !!ddRaw && (ddRaw.plausible === false || ddRaw.pct > 1);
  const equityLegend = els.get('equity-legend')?._html || '';
  if (doubtful) {
    ok(`回撤 ${(ddRaw.pct * 100).toFixed(2)}% 已越过 100% 上界`, ddRaw.pct > 1);
    ok('KPI 上标注了「分母失真」而不是裸着显示数字', kpiHtml.includes('分母失真'), kpiHtml.slice(0, 220).replace(/\n/g, ' '));
    ok('KPI 同时给出了绝对亏损金额', /亏 \$[\d,]+/.test(kpiHtml), (kpiHtml.match(/亏 \$[\d,]+/) || [])[0]);
    ok('权益图例里也带了同样的限定', equityLegend.includes('分母失真'), equityLegend.slice(0, 200));
  } else {
    ok(`回撤可信（${ddRaw ? (ddRaw.pct * 100).toFixed(2) + '%' : '无'}），界面不应出现失真角标`, !kpiHtml.includes('分母失真'), kpiHtml.slice(0, 220).replace(/\n/g, ' '));
  }
}

// K 线：测试网也必须画出来（candleSnapshot 在测试网是通的）
const chartHtml = els.get('chart')._html;
const nRect = (chartHtml.match(/<rect/g) || []).length;
ok('K 线面板生成了 <svg>', chartHtml.includes('<svg'), chartHtml.slice(0, 120));
ok('K 线有实体柱子（<rect> > 100）', nRect > 100, `rect=${nRect}`);
ok('K 线含布林带折线（<polyline>）', chartHtml.includes('<polyline'));
ok('K 线标题是测试网的 BTC 4H', /BTC\s*4H/.test(els.get('chart-title')?.textContent || ''), els.get('chart-title')?.textContent);
ok('K 线图例正常（含 BOLL、不是 [object Object]）', (els.get('chart-legend')._html || '').includes('BOLL') && !(els.get('chart-legend')._html || '').includes('[object Object]'));

if (EXPECT_EMPTY) {
  const posHtml = els.get('positions')._html;
  ok('空账户：持仓面板给出空态提示而不是崩掉', /暂无|没有|空/.test(posHtml) || /tbl-empty/.test(posHtml), posHtml.slice(0, 200).replace(/\n/g, ' '));
  ok('空账户：权益显示 $0.00', /\$0\.00/.test(kpiHtml), kpiHtml.slice(0, 200).replace(/\n/g, ' '));
  ok('空账户：K 线仍然照常渲染（行情类面板与账户无关）', nRect > 100, `rect=${nRect}`);
} else {
  const posHtml = els.get('positions')._html;
  const rowCount = (posHtml.match(/<tr/g) || []).length;
  ok('持仓表渲染出了数据行', rowCount > 1, `tr=${rowCount}`);
  ok('KPI 权益非 0', !/>\s*\$0\.00/.test(kpiHtml), kpiHtml.slice(0, 200).replace(/\n/g, ' '));
  const strat = els.get('strategy')._html;
  const markMatch = strat.match(/标记价\s*([\d.]+)/);
  ok('策略读数里有标记价', !!markMatch, markMatch ? '' : strat.slice(0, 160));
  if (markMatch) {
    const v = Number(markMatch[1]);
    ok(`标记价 ${markMatch[1]} 量级合理（100~1e7）`, v > 100 && v < 1e7, `实际 ${v}`);
  }
}

/* ═══════════════ 5. 测试网实时链路 ═══════════════ */

section('5. 测试网实时链路 —— 模拟 testnet allMids 推送');

if (sockets.length) {
  const ws = sockets[0];
  const before = els.get('chart')._html;
  // 用测试网真实 BTC 价位附近的值推送，顺带覆盖「1000xxx 这类测试网标的命名」
  const pushed = { BTC: '113250.0', ETH: '4251.5', kPEPE: '0.0131', HYPE: '47.25' };
  ws.onmessage?.({ data: JSON.stringify({ channel: 'allMids', data: { mids: pushed } }) });
  console.log('  已推送 testnet allMids，等待 1200ms 渲染防抖…');
  await new Promise((r) => realSetTimeout(r, 4000));

  const title = els.get('chart-title')?.textContent || '';
  const after = els.get('chart')._html;
  ok('标题出现实时现价', /现价\s*\d/.test(title), title);
  ok('实时价与推送值一致（113250）', title.includes('113250'), title);
  ok('图表出现「现价」参考线', after.includes('现价'));
  ok('推送后图表确实重绘', after !== before && after.length > 1000, `before=${before.length} after=${after.length}`);
  ok('实时渲染后仍无科学计数法', !/\d\.\d{2,}e\+\d{2,}/.test(after + title));
  ok('实时渲染未引入 console.error', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
}

/* ═══════════════ 结论 ═══════════════ */

try { unlinkSync(tmp); } catch {}
console.error = realConsoleError;

console.log('\n' + '═'.repeat(78));
if (fails.length === 0) {
  console.log(`结论：全部通过 —— ${pass} 项断言（测试网，${EXPECT_EMPTY ? '空账户' : '有仓位账户'}）。`);
  console.log('═'.repeat(78));
  process.exit(0);
} else {
  console.log(`结论：${pass} 项通过，${fails.length} 项失败：`);
  for (const f of fails) console.log('  ✗ ' + f);
  console.log('═'.repeat(78));
  process.exit(1);
}
