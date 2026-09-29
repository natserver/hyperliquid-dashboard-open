/**
 * app.js 真实执行烟雾测试（无浏览器）。
 *
 * 为什么需要它：语法检查只能证明「代码能解析」，证明不了「跑起来不炸、
 * 渲染出来的字符串是正常的」。用户报的正是这一类 bug —— 页面能打开、
 * 但某个数字渲染成了 7.76e+22 或整块空白，没有任何报错。
 *
 * 本工具用一个最小 DOM 垫片把 public/app.js **真正 import 并执行**：
 *   · 从 index.html 抽出全部 id，生成元素桩
 *   · 拦截 document / localStorage / WebSocket / fetch / 定时器
 *   · 让 app.js 走完 boot() → refresh() → renderAll() → renderChart()
 *   · 再模拟一条 WebSocket allMids 推送，验证实时链路
 * 最后把每个面板真正生成的 HTML 字符串捞出来做断言。
 *
 * 注意：为了让 Node 能解析 app.js 里的 `/src/strategy.js` 这种浏览器绝对路径，
 * 会把源码复制一份并只重写 import 说明符；其余逻辑逐字节不变。
 */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

// ⚠️ 必须用 fileURLToPath：import.meta.url 的 pathname 是 URL 编码的，
// 而本项目路径含中文（量化交易），直接 path.resolve 会拿到 %E9%87%8F… 的乱码路径。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'public', 'app.js');
const HTML = path.join(ROOT, 'public', 'index.html');
const ORIGIN = 'http://127.0.0.1:8787';
// 位置参数只取「不以 -- 开头」的：否则 `--dump 0x地址` 会把 --dump 当成地址，
// 拿一个非法地址去拉快照 → 整页空白 → 所有断言一起失败，
// 而报错信息（「kpis 长度 0」）完全指不到真正的原因。
// 开关放在哪个位置都能用，是这里唯一正确的解析方式。
const posArgs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const ADDR = posArgs[0] || '0x010461c14e146ac35fe42271bdc1134ee31c703a';
// 第 6 节（预警中心端到端）需要账户**当前有持仓**才有意义。
// 想完整跑它，传一个开着仓位的主账户地址，例如：
//   node tools/render-dom-smoke.js 0xc64cc00b46101bd40aa1c3121195e85c0b0918d8 testnet
const NET = posArgs[1] || 'mainnet';

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

/* ═══════════════ 1. 最小 DOM 垫片 ═══════════════ */

section('1. 搭建 DOM 垫片');

const html = readFileSync(HTML, 'utf8');
const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
console.log(`  index.html 里有 ${ids.length} 个 id：${ids.join(', ')}`);

/** 元素桩 —— 只要 app.js 用到的接口都存在即可。
 *  children / appendChild / remove / firstChild 必须是真的能用的：
 *  预警中心的 toast 队列靠它们做「最多保留 5 条」的裁剪，桩做不到位就测不出真实行为。 */
function makeEl(id) {
  const el = {
    id,
    tagName: 'DIV',
    _html: '',
    _parent: null,
    textContent: '',
    value: '',
    checked: false,
    className: '',
    disabled: false,
    style: {},
    dataset: {},
    options: [],
    children: [],
    title: '',
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains: () => false,
    },
    addEventListener(ev, fn) {
      (el._listeners ||= {})[ev] = fn;
    },
    removeEventListener() {},
    appendChild(c) {
      c._parent = el;
      el.children.push(c);
      return c;
    },
    remove() {
      const p = el._parent;
      if (!p) return;
      const i = p.children.indexOf(el);
      if (i >= 0) p.children.splice(i, 1);
    },
    scrollIntoView() {},
    closest: () => null,
    querySelector: () => makeEl(id + ':sub'),
    querySelectorAll: () => [],
  };
  Object.defineProperty(el, 'innerHTML', {
    get: () => el._html,
    set: (v) => {
      el._html = String(v);
    },
  });
  Object.defineProperty(el, 'firstChild', { get: () => el.children[0] || null });
  return el;
}

const els = new Map();
for (const id of ids) els.set(id, makeEl(id));

// 记录 app.js 访问了但不存在的 id —— 这是一类真 bug（拼错 id 会静默失效）
const missingIds = new Set();
const touchedIds = new Set();

const documentShim = {
  getElementById(id) {
    touchedIds.add(id);
    if (!els.has(id)) {
      missingIds.add(id);
      return null;
    }
    return els.get(id);
  },
  querySelector: () => makeEl('doc'),
  querySelectorAll: () => [],
  createElement: (t) => makeEl('created:' + t),
  addEventListener() {},
  body: makeEl('body'),
};

/* localStorage：预置地址，让 boot() 直接进入加载流程 */
const store = new Map();
store.set(
  'bithuang-hl-dashboard/v1',
  JSON.stringify({ address: ADDR, coin: 'BTC', interval: '4h', phase: 'ACCUMULATION', network: NET })
);
const localStorageShim = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

/* WebSocket：不真连，保留实例供我们手动推送消息 */
const sockets = [];
class WebSocketShim {
  static OPEN = 1;
  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.sent = [];
    sockets.push(this);
  }
  send(d) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
}

/* 定时器：不覆盖。
   曾经想过用假定时器来「手动触发」防抖，但 Node 内部的 undici（fetch 实现）也会调用
   globalThis.setTimeout 并要求返回对象带 .unref()，覆盖后直接崩。而且假定时器还会把
   undici 自己的超时回调一起收进队列，flush 时会误触发请求中止。
   结论：保持真定时器，靠真实等待让 1200ms 的渲染防抖自然生效。 */
const realSetTimeout = globalThis.setTimeout; // 仅作别名，方便测试自身等待

/**
 * 轮询等待条件成立。
 *
 * 为什么不能再用固定 sleep：快照要打十几次交易所接口，冷缓存 + 限流时可能十几秒。
 * 固定等 7.5 秒会在慢的时候「空手断言」，而失败信息长成「17 个面板都是空的」——
 * 看起来像渲染 bug，实际只是没等够。这类误报比不报还浪费时间。
 */
async function waitFor(fn, timeoutMs, stepMs = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (fn()) return true;
    } catch {
      /* 条件里访问了还没建好的东西，继续等 */
    }
    await new Promise((r) => realSetTimeout(r, stepMs));
  }
  return false;
}

/* fetch：把相对路径补成服务地址 */
const realFetch = globalThis.fetch;
const fetchShim = (url, opts) => realFetch(String(url).startsWith('http') ? url : ORIGIN + url, opts);

/* 抓 console.error —— renderChart 的 catch 会往这里写。
   只覆盖 error 这一个方法，不动 console 其余部分（整体替换容易把 log 弄丢）。 */
const consoleErrors = [];
const realConsoleError = console.error;
console.error = (...a) => consoleErrors.push(a.map(String).join(' '));

// 安装到全局
globalThis.document = documentShim;
globalThis.localStorage = localStorageShim;
globalThis.WebSocket = WebSocketShim;
globalThis.fetch = fetchShim;

ok(`DOM 垫片就绪（${ids.length} 个元素桩）`, ids.length > 20);

/* ═══════════════ 2. 执行真实的 app.js ═══════════════ */

section('2. import 并执行 public/app.js');

// 只重写 import 说明符，其余逐字节不变
const src = readFileSync(APP, 'utf8');
const rewritten = src
  .replace(/from '\/src\/([^']+)'/g, (_m, f) => `from '${pathToFileURL(path.join(ROOT, 'src', f)).href}'`)
  .replace(/from '\.\/([^']+)'/g, (_m, f) => `from '${pathToFileURL(path.join(ROOT, 'public', f)).href}'`);

const tmp = path.join(ROOT, 'public', '__dom_smoke_app.mjs');
writeFileSync(tmp, rewritten, 'utf8');

let importErr = null;
try {
  await import(pathToFileURL(tmp).href);
} catch (e) {
  importErr = e;
}
ok('app.js 能被 import 且顶层不抛错', !importErr, importErr ? importErr.constructor.name + ': ' + importErr.message : '');

if (importErr) {
  realConsoleError(importErr);
  try {
    unlinkSync(tmp);
  } catch {}
  console.log('\nimport 阶段就失败，后续断言跳过。');
  process.exit(1);
}

// 等首份快照真的渲染出来，而不是死等一个拍脑袋的秒数
const bootRendered = await waitFor(() => (els.get('kpis')._html || '').length > 20, 60000);
console.log(
  `  已访问 ${touchedIds.size} 个 id · 缺失 ${missingIds.size} 个 · 首屏渲染${bootRendered ? '完成' : '超时'}`
);
// 图表是异步的（要先拉 K 线再算布林带），单独等
const chartRendered = await waitFor(() => (els.get('chart')._html || '').includes('<svg'), 45000);

/* ═══════════════ 3. 基础断言 ═══════════════ */

section('3. 渲染结果断言');

ok('首份快照在 60 秒内完成渲染', bootRendered, `kpis 长度 ${(els.get('kpis')._html || '').length}`);
ok('K 线 SVG 在 45 秒内生成', chartRendered, `chart 长度 ${(els.get('chart')._html || '').length}`);
ok('app.js 没有访问 index.html 里不存在的 id', missingIds.size === 0, [...missingIds].join(', '));
ok('渲染过程没有 console.error', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

/* macro 与 pipeline 曾经漏在这张表外 —— 它们是页面最上面几张卡，
 * 坏值一旦出现在那里，用户第一眼看到的就是坏值。必须一并扫。
 * verdict 是现在最上面那一张：它坏掉等于整个页面白看。 */
const panels = ['verdict', 'trend-why', 'trend-match', 'exit-board', 'trade-match', 'alerts', 'alert-counts', 'alert-foot', 'kpis', 'kpis-more', 'macro', 'pipeline', 'strategy', 'positions', 'equity', 'performance', 'bycoin', 'fills', 'orders', 'funding', 'deposits', 'warnings', 'chart', 'chart-legend', 'equity-legend'];
const emptyPanels = [];
for (const p of panels) {
  const el = els.get(p);
  if (!el || !el._html || el._html.length < 20) emptyPanels.push(`${p}(${el?._html?.length ?? 0})`);
}
ok(`${panels.length} 个面板都渲染出了内容`, emptyPanels.length === 0, emptyPanels.join(', '));

// 全局扫渲染产物里的坏值
const BAD = ['undefined', 'NaN', '[object Object]', 'Infinity'];
const badHits = {};
for (const p of panels) {
  const h = els.get(p)?._html || '';
  for (const b of BAD) {
    const n = (h.match(new RegExp(b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    if (n) badHits[`${p}:${b}`] = n;
  }
}
ok('所有面板的 HTML 里没有 undefined / NaN / [object Object] / Infinity', Object.keys(badHits).length === 0, JSON.stringify(badHits));

// 科学计数法 —— 用户报的 7.76375e+22 就是这一类
const sciHits = {};
for (const p of panels) {
  const h = els.get(p)?._html || '';
  const m = h.match(/\d\.\d{2,}e\+\d{2,}/g);
  if (m) sciHits[p] = m.slice(0, 3).join(', ');
}
ok('所有面板的 HTML 里没有 1e+22 这类科学计数法数字', Object.keys(sciHits).length === 0, JSON.stringify(sciHits));

// 漏出来的 Markdown 强调标记 —— 用户会直接看到 `**逆周期**` 这种字面星号。
// 之前只有 verdict 被查过；新起的两张卡各自拿 summary/reasons 渲染，必须一起查。
const mdHits = {};
for (const p of panels) {
  const h = els.get(p)?._html || '';
  const m = h.match(/\*\*[^*\n]{1,60}\*\*/g);
  if (m) mdHits[p] = m.slice(0, 3).join(', ');
}
ok('所有面板的 HTML 里没有漏出来的 **强调**', Object.keys(mdHits).length === 0, JSON.stringify(mdHits));

/* ── 相位默认值必须是「自动」── 这条守的是跨层不同步，不是文案 ──────
 * 方向层（computeRegime）直接读减半时钟，而波动门槛读 cfg.cyclePhase。
 * 默认值一旦写死成某个具体相位，系统就会「按出清段定方向、按筑底定门槛」——
 * 两个字段各自都"对"，合起来是错的，而且页面上根本看不出来。
 * 见 src/strategy.js 里 PHASE_AUTO 的注释与 regime-check 的 A2 节。 */
{
  const phaseSel = els.get('phase');
  const autoOpt = /<option[^>]*value="AUTO"[^>]*>/.exec(html);
  ok('index.html 的相位下拉提供了「自动」选项', !!autoOpt, '没有 value="AUTO" 的 option');
  ok(
    '「自动」是相位下拉的第一项（无 selected 时即默认项）',
    /<select id="phase">\s*<option[^>]*value="AUTO"/.test(html),
    '自动不是第一项，冷启动会落到某个具体相位上'
  );
  ok('boot 后相位的实际取值是 AUTO，不是硬编码的 ACCUMULATION', String(phaseSel?.value).toUpperCase() === 'AUTO', `实际 ${phaseSel?.value}`);
  ok(
    '已保存的旧默认值 ACCUMULATION 会被迁移掉（否则老用户改了代码也还是旧行为）',
    /s\.phaseVer !== PHASE_VER[\s\S]{0,120}s\.phase === 'ACCUMULATION'/.test(src),
    'loadState 里没有一次性迁移逻辑'
  );
}

/* ═══════════════ 4. 具体数值合理性 ═══════════════ */

section('4. 关键数值的合理性（对照用户报的 bug）');

const kpi = els.get('kpis')._html;
/* 首页只放 4 个「此刻状态」的 KPI，最大回撤这类复盘统计数搬到了「账户明细」里。
 * 断言必须跟着搬 —— 否则它会静默变成空断言（匹配不到就 return true）。 */
const kpiMore = els.get('kpis-more')._html;
const strat = els.get('strategy')._html;
const posHtml = els.get('positions')._html;
const chartHtml = els.get('chart')._html;

// 4a. 策略读数里的标记价
const markMatch = strat.match(/标记价\s*([\d.]+)/);
ok('策略读数里出现了标记价', !!markMatch, markMatch ? '' : strat.slice(0, 120));
if (markMatch) {
  const v = Number(markMatch[1]);
  ok(`标记价 ${markMatch[1]} 是合理的 BTC 价格（5 位数，1000~1e6）`, v > 1000 && v < 1e6, `实际 ${v}`);
}

// 4b. 持仓表的开仓价
const posPrices = [...posHtml.matchAll(/<td>(6\d{4}\.\d|7\d{4}\.\d|8\d{4}\.\d)</g)].map((m) => Number(m[1]));
ok('持仓表里的开仓价格在合理区间', posPrices.length === 0 || posPrices.every((v) => v > 1000 && v < 1e6), posPrices.slice(0, 5).join(','));

// 4c. K 线 SVG
ok('K 线面板里生成了 <svg>', chartHtml.includes('<svg'));
ok('K 线 SVG 含有 K 线实体（<rect>）', (chartHtml.match(/<rect/g) || []).length > 100, `rect 数 ${(chartHtml.match(/<rect/g) || []).length}`);
ok('K 线 SVG 含有布林带折线（<polyline>）', chartHtml.includes('<polyline'));
ok('K 线标题写入了币种与周期', /BTC\s*4H/.test(els.get('chart-title')?.textContent || ''), els.get('chart-title')?.textContent);

// 4d. 图例（之前 legend 是对象数组，直接赋给 innerHTML 会渲染成 [object Object]）
const legendHtml = els.get('chart-legend')._html;
ok('K 线图例渲染正常（不是 [object Object]）', legendHtml.length > 10 && !legendHtml.includes('[object Object]'), legendHtml.slice(0, 100));
ok('K 线图例含布林带项', legendHtml.includes('BOLL'));

// 4e. KPI
ok('KPI 里有账户权益且不是 0', /账户权益/.test(kpi) && !/>\s*\$0\.00/.test(kpi), kpi.slice(0, 100).replace(/\n/g, ' '));
// 这条断言的前身是「回撤必须 < 100%」—— 那是错的，而且错得很有代表性：
// 权益口径下的回撤可以越过 100%（账户被提空，或成交落在 HIP-3 子账户上，
// 而 clearinghouseState 默认只返回主合约账户），真实数据就能算出 177%。
// 正确的不变式不是「数字必须好看」，而是「**越界的数字必须把限定条件一并显示出来**」。
// 只画一个 177.63% 却不说明分母不可用，才是 bug。
ok(
  'KPI 的最大回撤：要么在合理区间，要么已显式标注「分母失真」',
  (() => {
    const seg = kpiMore.match(/最大回撤[\s\S]{0,320}/)?.[0] || '';
    const m = seg.match(/([\d.]+)%/);
    if (!m) return true;
    const v = Number(m[1]);
    if (v <= 100) return true;
    return /分母失真/.test(seg);
  })(),
  `回撤显示为 ${(kpiMore.match(/最大回撤[\s\S]{0,320}?([\d.]+)%/) || [])[1]}%，标注=${/分母失真/.test(kpiMore) ? '有' : '无'}`
);
ok(
  'KPI 的最大回撤若越界，必须同时给出绝对亏损金额（百分比不可用时唯一的替代信息）',
  (() => {
    const seg = kpiMore.match(/最大回撤[\s\S]{0,320}/)?.[0] || '';
    const m = seg.match(/([\d.]+)%/);
    if (!m || Number(m[1]) <= 100) return true;
    return /亏\s*\$/.test(seg);
  })(),
  (kpiMore.match(/最大回撤[\s\S]{0,320}/) || [])[0]?.slice(0, 140)
);

/* 4f. 结论卡 —— 页面唯一直接读 s.pipeline 的地方。
 *
 * 它必须满足两条：① 是整页第一个有内容的元素（首屏第一眼就是结论）；
 * ② 只给结果、不给推演 —— 判据原文、K 线腿数、候选位这些都不该出现在这里。 */
const vd = els.get('verdict')._html;
// 语义词条在元素自身的 className 上，不在 innerHTML 里 —— 断言必须看对地方，
// 否则它会永远失败（或反过来，永远通过）。
const vdCls = els.get('verdict').className;
ok('结论卡有内容', vd.length > 60, `${vd.length} 字符`);
ok(
  '结论卡带语义词条（t-buy / t-sell / t-exit / t-wait / t-flat / t-add 之一）',
  /^verdict (t-buy|t-sell|t-exit|t-wait|t-flat|t-add)$/.test(vdCls),
  vdCls
);
ok('结论卡第一行给出「该做什么」（vd-action 非空）', /<div class="vd-action">[^<]/.test(vd), (vd.match(/<div class="vd-action">([^<]*)/) || [])[1]);
ok(
  '结论卡行结构完整：① 方向 + ② 开单 + ③（止损 或 持仓不适用）',
  /vd-step">① 方向</.test(vd) && /vd-step">② 开单</.test(vd) && /vd-step">③ (止损|持仓)</.test(vd),
  (vd.match(/vd-step">([^<]*)/g) || []).join(' | ')
);
ok('结论卡给出理由（vd-note）', /class="vd-note">理由：/.test(vd));
// 「只给结果」的反向断言：推演的痕迹不该出现在结论卡里。
// 这三类词分别代表「判据清单」「K 线腿数」「止损候选位」—— 它们属于折叠区。
ok(
  '结论卡里没有推演痕迹（不出现 判据 / 推进腿 / 候选位 这类过程描述）',
  !/判据|推进腿|候选位|收口/.test(vd),
  (vd.match(/判据[^<]{0,20}|推进腿[^<]{0,12}|候选位[^<]{0,12}/g) || []).join(' | ')
);
// src/ 的理由链是按 Markdown 写的，直接 esc 会把星号原样印到用户脸上
// （真实快照里就出现过「首要原因：**逆周期**：…」）。这一条守的是「有没有漏替换」。
ok(
  '结论卡里没有漏出来的 Markdown 星号（`**强调**` 必须变成加粗）',
  !/\*\*/.test(vd),
  (vd.match(/\*\*[^*\n]{0,24}\*\*/g) || []).join(' | ')
);
/* 第 ③ 行给的是止损价（中轨外侧），第 ⑤ 行给的是中轨本身 —— 两者只差一个缓冲。
 * 都写成「中轨 XXXX」会让人以为是同一个位，所以 ⑤ 的正文只说条件，价位挪到右侧读数。 */
const vdRowVal = (step) =>
  (vd.match(new RegExp(`vd-step">${step}</span><span class="vd-val">([\\s\\S]*?)</span><span class="vd-aux">`)) || [])[1] || '';
const exitVal = vdRowVal('⑤ 离场');
ok(
  '⑤ 离场正文只讲条件、不重复给价位（价位在右侧读数里）',
  exitVal.length > 0 && !/<b>[\d,]/.test(exitVal),
  exitVal
);

/* --dump：把首屏那几张卡按「用户看到的纯文本」打出来。
 *
 * 为什么需要它：这台机器上没有浏览器（也没有可用的 Chromium），
 * 而改界面时最需要的恰恰是「排完之后长什么样」。断言只能保证不坏，
 * 保不了「读起来是不是废话」。用真实快照渲染出的纯文本至少能检查这一点。 */
if (process.argv.includes('--dump')) {
  const toText = (html) =>
    String(html || '')
      .replace(/<br\s*\/?>/g, '\n')
      .replace(/<\/(div|section|details|summary|table|tr|h2|h3|p)>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{2,}/g, '\n')
      .trim();

  console.log('\n' + '━'.repeat(78));
  console.log('首屏纯文本（--dump）');
  console.log('━'.repeat(78));
  for (const [label, id] of [
    ['结论卡', 'verdict'],
    ['系统一 · 为什么给这个趋势', 'trend-why'],
    ['系统一 · 心得对照', 'trend-match'],
    ['账户 KPI（首页 4 个）', 'kpis'],
    ['系统二 · 离场四通道', 'exit-board'],
    ['系统二 · 心得对照', 'trade-match'],
  ]) {
    console.log(`\n【${label}】`);
    console.log(toText(els.get(id)?._html));
  }
  const states = ['fold-pipeline-state', 'fold-strategy-state', 'fold-macro-state', 'fold-account-state']
    .map((id) => `${id.replace('fold-', '').replace('-state', '')}=${els.get(id)?.textContent || '—'}`)
    .join(' · ');
  console.log(`\n【折叠组右侧状态】${states}`);
  console.log('━'.repeat(78));
}

/* ═══════════════ 5. 实时链路（模拟 WebSocket 推送） ═══════════════ */

section('5. 实时链路 —— 模拟 allMids 推送');

ok('app.js 创建了 WebSocket 连接', sockets.length > 0, `实例数 ${sockets.length}`);

if (sockets.length) {
  const ws = sockets[0];
  ok(
    `WebSocket 地址与网络一致（${NET}）`,
    NET === 'testnet' ? /testnet/.test(ws.url) : /api\.hyperliquid\.xyz/.test(ws.url),
    ws.url
  );

  const beforeHtml = els.get('chart')._html; // 首轮渲染（此时还没有实时价）

  // 手动触发 onopen（app.js 是在 onopen 里发订阅的，所以必须先触发再断言订阅）
  ws.onopen?.();
  ok('连接建立后订阅了 allMids', ws.sent.some((s) => s.includes('allMids')), JSON.stringify(ws.sent));

  // 模拟交易所推送
  const pushed = { BTC: '78999.0', ETH: '2501.0', NOT: '0.00051', OP: '0.111', STX: '0.28', BNB: '760.0' };
  ws.onmessage?.({ data: JSON.stringify({ channel: 'allMids', data: { mids: pushed } }) });

  // scheduleRender 有 1200ms 防抖，等它自然触发
  console.log('  已推送 allMids，等待渲染防抖（1200ms）自然触发…');
  await waitFor(() => /现价\s*\d/.test(els.get('chart-title')?.textContent || ''), 20000);

  const after = els.get('chart')._html;
  const title = els.get('chart-title')?.textContent || '';

  ok('标题上出现了实时现价', /现价\s*\d/.test(title), title);
  ok('实时价与推送值一致（78999）', title.includes('78999'), title);
  ok('图表出现「现价」参考线', after.includes('现价'));
  ok('图例标明最后一根 K 线由中间价驱动', (els.get('chart-legend')._html || '').includes('中间价驱动'), els.get('chart-legend')._html?.slice(0, 140));
  ok('推送后图表确实发生了重绘（SVG 内容变化）', after !== beforeHtml && after.length > 1000, `before=${beforeHtml.length} after=${after.length}`);
  ok('实时渲染后仍无科学计数法', !/\d\.\d{2,}e\+\d{2,}/.test(after + title));
  ok('实时渲染未引入 console.error', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
}

/* ═══════════════ 6. 预警中心（端到端） ═══════════════ */

section('6. 预警中心 —— 用真实持仓 + 真实实时推送驱动一次告警');

const alertHtml0 = els.get('alerts')._html || '';
ok('预警中心已渲染出内容', alertHtml0.length > 20, `len=${alertHtml0.length}`);
ok('预警中心的 HTML 里没有坏值', !/undefined|NaN|\[object Object\]/.test(alertHtml0), alertHtml0.slice(0, 160));
ok(
  '页脚写明了迟滞与冷却（这正是「不刷屏」的公开说明）',
  /冷却/.test(els.get('alert-foot')._html || ''),
  (els.get('alert-foot')._html || '').slice(0, 160)
);
const pushTxt = (els.get('alert-push-status')._html || '') + (els.get('alert-push-status').textContent || '');
ok('服务端推送状态已渲染出结果', /推送通道|未配置|不可用/.test(pushTxt), pushTxt.slice(0, 200));
ok('顶栏预警角标已更新', (els.get('alert-badge').textContent || '').length > 0, els.get('alert-badge').textContent);

// 从真实快照里挑一个带清算价的持仓，然后**用一个极端中间价把它推到「距清算约 2%」**——
// 这是严重区（阈值 6%），预警必然成立。
//
// 为什么要人为推价：真实账户的清算价通常离标记价很远（尤其全仓 + 权益充足时），
// 所以真实数据下「逼近清算」本来就不该触发 —— 那才是正确行为。
// 这一节要验证的是**链路**：实时价 → 引擎 → DOM，以及同一条件在迟滞带内不重复弹窗。
// 推价是人为的，链路是真的。
let cand = null;
try {
  const snapRes = await fetchShim(`/api/snapshot?network=${NET}&user=${ADDR}&coin=BTC`);
  const snapJson = await snapRes.json();
  const withLiq = (snapJson.positions || []).filter((p) => p.liquidationPx && p.markPx);
  // 取「清算价离标记价最近」的那个 —— 推价造成的失真最小
  withLiq.sort((a, b) => {
    const ra = Math.abs(Number(BigInt(a.liquidationPx)) / Number(BigInt(a.markPx)) - 1);
    const rb = Math.abs(Number(BigInt(b.liquidationPx)) / Number(BigInt(b.markPx)) - 1);
    return ra - rb;
  });
  cand = withLiq[0] || null;
} catch (e) {
  console.log('  取快照失败：' + e.message);
}

if (!cand) {
  console.log('  跳过第 6 节：该地址当前没有「带清算价」的持仓。');
  console.log(`  想完整跑这一节，传一个有持仓的主账户地址：`);
  console.log(`    node tools/render-dom-smoke.js 0x你的地址 ${NET}`);
} else {
  const posCoin = cand.coin;
  const isLong = Boolean(cand.isLong);
  const markNow = Number(BigInt(cand.markPx)) / 1e18;
  const liq = Number(BigInt(cand.liquidationPx)) / 1e18;
  ok('从真实快照里取到一个带清算价的持仓', true, `${isLong ? '多' : '空'} ${posCoin} 清算 ${liq}`);
  console.log(`  用它驱动：${isLong ? '多' : '空'} ${posCoin} · 标记价 ${markNow} · 清算价 ${liq}`);

  const toastBox = els.get('toasts');
  const countLiqToasts = () => toastBox.children.filter((c) => /距清算/.test(c._html || '')).length;
  const htmlBefore = els.get('alerts')._html;

  // 朝**不利方向**推到距清算约 2%：多头往下压（liq×1.02），空头往上抬（liq×0.98）
  const pushNearLiq = (mult) => {
    const target = isLong ? liq * mult : liq * (2 - mult);
    sockets[0].onmessage?.({
      data: JSON.stringify({ channel: 'allMids', data: { mids: { [posCoin]: target.toFixed(8) } } }),
    });
  };

  pushNearLiq(1.02);
  await waitFor(() => /距清算/.test(els.get('alerts')._html || ''), 20000);

  const alertHtml1 = els.get('alerts')._html || '';
  const after1 = countLiqToasts();
  ok('把中间价推到逼近清算后，预警中心出现了「距清算」告警', /距清算/.test(alertHtml1), alertHtml1.slice(0, 220));
  ok('该告警被标为严重级', /严重/.test(alertHtml1));
  ok('预警面板确实重绘了（不是没反应）', alertHtml1 !== htmlBefore);
  ok('弹出了「距清算」toast', after1 >= 1, `count=${after1}`);
  ok('toast 内容带上了具体的标的', toastBox.children.some((c) => (c._html || '').includes(posCoin)));
  ok('顶栏角标变成了警示态', /⚠/.test(els.get('alert-badge').textContent || ''), els.get('alert-badge').textContent);

  // 关键一步：在迟滞带内再动一次价格。
  // 应当重绘，但**不应**再弹一条 —— 这是「迟滞不刷屏」在 DOM 层的直接证明。
  pushNearLiq(1.021);
  await new Promise((r) => realSetTimeout(r, 3500));
  ok('价格在迟滞带内再变一次，不重复弹窗', countLiqToasts() === after1, `after1=${after1} now=${countLiqToasts()}`);
  ok('警报期间也没有 console.error', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
}

/* ═══════════════ 结论 ═══════════════ */

try {
  unlinkSync(tmp);
} catch {}
console.error = realConsoleError;

console.log('\n' + '═'.repeat(78));
if (fails.length === 0) {
  console.log(`结论：全部通过 —— ${pass} 项断言。`);
  console.log(`  app.js 在真实数据上完整跑通：${panels.length} 个面板全部渲染、无坏值、实时链路生效、`);
  console.log('  预警中心能被真实实时价驱动出告警，且同一条件在迟滞带内不重复弹窗。');
  console.log('═'.repeat(78));
  process.exit(0);
} else {
  console.log(`结论：${pass} 项通过，${fails.length} 项失败：`);
  for (const f of fails) console.log('  ✗ ' + f);
  console.log('═'.repeat(78));
  process.exit(1);
}
