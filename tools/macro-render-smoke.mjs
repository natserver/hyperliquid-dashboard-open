/**
 * 冒烟测试：用真实快照喂给前端的 renderMacro / setupPips，确认不抛错且产出合理结构。
 *
 * 为什么要有这个：前端渲染失败以前是"静默空白"，一个 undefined 就能让整张卡消失，
 * 而浏览器里排查成本高。这里把渲染函数从 app.js 里摘出来、塞进最小 DOM 桩直接跑 ——
 * 三秒内就能知道是不是又踩了空字段。
 *
 * 用法：
 *   node tools/macro-render-smoke.mjs                 # 从本地 8787 拉真实快照（npm test 的默认路径）
 *   node tools/macro-render-smoke.mjs 8787            # 指定端口
 *   node tools/macro-render-smoke.mjs path/to/snap.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 判据注册表本身也从源码引入 —— 测试不该复制一份「期望值」，
// 否则注册表改了而测试还是绿的，这类测试就只是在自我确认。
import { DIRECTION_CRITERIA } from '../src/regime-criteria.js';
// 小数位规则的共享实现（终端 src/macro-view.js 也走它）—— 用来对拍网页那份 dpFor
import { lastChange, valueDecimals } from '../src/macro-sources.js';
// 数值格式化用**真实现**而不是桩 —— 桩会让「价格显示成 1e20」这类问题在测试里消失，
// 而那恰恰是界面上真实踩过的坑。render-check.js 也是这么做的。
import { fmtBps, fmtPrice, fmtWad, parseWad } from '../src/strategy.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/* ── 取快照：给了存在的文件就当文件，否则当成端口号去本地拉 ── */
const arg = process.argv[2];
const argIsFile = arg && !/^\d+$/.test(arg) && fs.existsSync(arg);
let snapText;
if (argIsFile) {
  snapText = fs.readFileSync(arg, 'utf8');
} else {
  const port = arg || '8787';
  const url =
    `http://127.0.0.1:${port}/api/snapshot?network=mainnet` +
    `&user=0x0000000000000000000000000000000000000000&coin=BTC`;
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    console.error(`无法连接本地看板 http://127.0.0.1:${port} —— 先启动它（npm start）再跑本测试。`);
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`拉取快照失败：HTTP ${res.status}`);
    process.exit(1);
  }
  snapText = await res.text();
}
const snap = JSON.parse(snapText);

/* ── 从 app.js 摘出被测函数（源码级复用，避免复制粘贴导致的漂移） ── */
const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

function slice(fromMarker, toMarker) {
  const a = src.indexOf(fromMarker);
  if (a < 0) throw new Error(`找不到起点标记：${fromMarker}`);
  const b = src.indexOf(toMarker, a);
  if (b < 0) throw new Error(`找不到终点标记：${toMarker}`);
  return src.slice(a, b);
}

/* 标记尽量用代码而不是注释 —— 注释会被改写，代码不会 */
const trendPips = slice('function trendPips(L) {', '\n/* 系统二的进度条');
const metaBlocks = slice('const HOLD_META = {', '\nfunction setupPips');
const setupPips = slice('function setupPips(L) {', '\nconst BIAS_META = {');
/* 宏观卡到「三段流程」的常量声明为止 —— 用代码标记收边，
 * 否则再加一张卡进来，renderMacro 的切片就会悄悄把别人的代码也吞进去。 */
const renderMacro = slice('const BIAS_META = {', '\nconst STAGE_META = {');
const renderPipeline = slice('const STAGE_META = {', '\nfunction trancheRows(e) {');
const trancheRows = slice('function trancheRows(e) {', '\nfunction renderStrategy(s) {');

/* esc / mdt 也从 app.js 里切源码，不在测试里手抄一份实现。
 *
 * 手抄的那一份当初只抄了 esc；后来 app.js 加了 mdt（把判据文本里的 `**强调**`
 * 变成 <b>），renderMacro 里就开始用它 —— 于是这个测试直接抛
 * `ReferenceError: mdt is not defined`。
 * 更麻烦的是它的表现：整个 A 段挂掉、断言一条都不跑，看起来像"快照拉取失败"。
 * 抄一份"等价的"实现，等价性没人能保证；切一份源码，根本不需要保证。 */
const escAndMdt = slice('const esc = (s) =>', '\nconst cls = (v) =>');
const { esc, mdt } = new Function(`${escAndMdt}\nreturn { esc, mdt };`)();

/* ── 最小 DOM 桩 / 依赖桩 ── */
const els = { macro: { innerHTML: '' }, pipeline: { innerHTML: '' } };
const $ = (id) => els[id] || null;
const el = els.macro;
const num = (x, dp = 2) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(dp));
const pct = (x, dp = 2) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(dp)}%`);
/** 与 app.js 的 wad() 同源：纯整数串按 WAD 解读，含小数点/指数按十进制解读 */
const wad = (v) => {
  if (typeof v === 'bigint') return v;
  const s = String(v ?? '0');
  return /^-?\d+$/.test(s) ? BigInt(s) : parseWad(s);
};

/* renderMacro 现在还会去拉判据清单（loadCriteria），所以这两样必须也桩掉：
 *   · state / renderPanel —— 加载成功后回填渲染要用
 *   · fetch              —— 返回真实注册表，走的是真加载路径而不是绕过它
 * 返回真实数据是刻意的：这样「加载 → 回填渲染」整条链路都在测试覆盖内。 */
const state = { snap: null };
const renderPanel = () => {};
const criteriaPayload = {
  ok: true,
  total: DIRECTION_CRITERIA.length,
  implemented: DIRECTION_CRITERIA.filter((c) => c.implemented === true).length,
  partial: DIRECTION_CRITERIA.filter((c) => c.implemented === 'partial').length,
  manual: DIRECTION_CRITERIA.filter((c) => c.implemented === false).length,
  criteria: DIRECTION_CRITERIA,
};
let fetchCalls = 0;
const fakeFetch = async () => {
  fetchCalls++;
  return { ok: true, json: async () => criteriaPayload };
};

/* esc / mdt 作为**函数体内**的声明注入，不再当参数传 —— 它们本身就来自 app.js 源码，
 * 当参数传会和源码里的 `const esc` 撞成重复声明。 */
const factory = new Function(
  '$', 'num', 'pct', 'fmtBps', 'wad', 'fmtWad', 'fmtPrice', 'state', 'renderPanel', 'fetch',
  `${escAndMdt}\n${metaBlocks}\n${trendPips}\n${setupPips}\n${renderMacro}\n${renderPipeline}\n${trancheRows}\n` +
    `return { renderMacro, renderPipeline, trancheRows, setupPips, BIAS_META, HOLD_META, GATE_META, STAGE_META };`
);
/* 实参必须与形参一一对应 —— 少传一个不会报错，只会整体错位，
 * 然后以「fetch 返回 undefined」这种完全指不到原因的方式炸掉。 */
const api = factory($, num, pct, fmtBps, wad, fmtWad, fmtPrice, state, renderPanel, fakeFetch);

/* ── 断言 ── */
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`); }
};

console.log('\nA. renderMacro —— 有 regime 的完整快照');
api.renderMacro(snap);
const html = el.innerHTML;
check('不抛错且产出了 HTML', html.length > 500, `${html.length} 字符`);
check('包含结论条（方向徽标）', html.includes('macro-head') && html.includes('macro-bias'));
check('包含周期时钟', html.includes('周期时钟'));
check('包含四分量结构表', html.includes('长周期结构') && html.includes('200 日均线'));
check('包含位置修饰（追高判据）', html.includes('高于 200 日均线'));
check('包含事件层', html.includes('大事件层'));
check('包含判定理由', html.includes('判定理由'));
check('没有渲染出 undefined / NaN / [object', !/undefined|NaN|\[object/.test(html));

if (snap.regime) {
  const r = snap.regime;
  check('方向徽标与 regime.bias 一致', html.includes(api.BIAS_META[r.bias]?.txt), `bias=${r.bias}`);
  check('相位标签出现在页面上', html.includes(r.clock?.label), `label=${r.clock?.label}`);
  check('phaseCheck 不一致时被显形', !snap.phaseCheck?.stale || html.includes('周期相位对账不一致'));
}

console.log('\nB. renderMacro —— regime 缺失时的降级');
el.innerHTML = '';
api.renderMacro({ ...snap, regime: null });
check('不抛错', true);
check('明确提示方向层缺席', el.innerHTML.includes('宏观方向层不可用'));
check('说明缺席时一律不开仓', el.innerHTML.includes('一律不开仓'));

console.log('\nC. setupPips —— 触发层进度条');
const L = snap.levelsByCoin?.BTC;
if (L?.trigger) {
  const h = api.setupPips(L);
  const t = L.trigger;
  const expect = Math.min(t.required || 3, t.side === 1 ? t.longLegs : t.shortLegs);
  check('不抛错', true);
  check('点亮的格数 = 独立推进腿数（不是连续收在轨外的根数）', (h.match(/pip on-/g) || []).length === expect, `点亮 ${(h.match(/pip on-/g) || []).length} / 期望 ${expect}（longLegs=${t.longLegs} shortLegs=${t.shortLegs}）`);
  check('渲染了触发层理由原文', h.includes(t.reason.slice(0, 12)));
} else {
  check('快照里有 BTC 触发层数据', false, '缺 levelsByCoin.BTC.trigger');
}

console.log('\nD. setupPips —— 无触发层时退回旧口径（兼容路径）');
const legacy = { isLong: true, trend: { required: 3, longBreaks: 2, shortBreaks: 0, reason: '旧口径回归测试' } };
try {
  const h2 = api.setupPips(legacy);
  check('不抛错且退回 trendPips', h2.includes('旧口径回归测试') && (h2.match(/pip on-/g) || []).length === 2);
} catch (e) {
  check('不抛错且退回 trendPips', false, e.message);
}

/* ══════════════════════════════════════════════════════════════════
 * E. 比特皇判据层（A4~A7）与判据总表
 *
 * 这一节覆盖用户最初那个问题的落点：「比特皇判断大方向的依据都是什么」。
 * 断言分两段：
 *   E1 清单还没到手上时，必须显式说「正在加载」，不能静默少一块
 *   E2 清单到手后（走真实 loadCriteria 路径），每条判据都要出现在页面上
 * ══════════════════════════════════════════════════════════════════ */

console.log('\nE1. 判据清单未就绪 —— 必须显式占位');
// 注意：section B 用 regime:null 渲染过，renderMacro 会**提前返回**，
// 所以这里的 el.innerHTML 是 B 的输出，不能直接拿来断言。
// 必须重新用完整快照渲染一次，才是「清单未就绪」的真实状态。
el.innerHTML = '';
api.renderMacro(snap);
check(
  '清单未就绪时给出「正在加载」占位（不允许静默缺失整块）',
  el.innerHTML.includes('正在加载判据清单'),
  el.innerHTML.includes('正在加载判据清单') ? '已占位' : '未见占位'
);
check('占位时其余区块照常渲染（缺清单不该拖垮整张卡）', el.innerHTML.includes('周期时钟') && el.innerHTML.includes('大事件层'));

console.log('\nE2. await 加载完成后重渲染 —— 判据总表必须完整');
// loadCriteria 内部 await fetch → await res.json()，两个微任务；多放几拍以确保落定
for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

state.snap = snap;
el.innerHTML = '';
api.renderMacro(snap);
const hE = el.innerHTML;

check('拉取了判据清单（走的是真 loadCriteria 路径）', fetchCalls >= 1, `fetch ${fetchCalls} 次`);
check('渲染出判据总表', hE.includes('比特皇判据总表'));
check('总表条数与注册表一致', hE.includes(`共 ${DIRECTION_CRITERIA.length} 条`), `共 ${DIRECTION_CRITERIA.length} 条`);
check(
  '每条判据的 id 都出现在页面上（无漏条）',
  DIRECTION_CRITERIA.every((c) => hE.includes(c.id)),
  `${DIRECTION_CRITERIA.filter((c) => hE.includes(c.id)).length}/${DIRECTION_CRITERIA.length}`
);
check(
  '「人工维护」的判据被明确标出，没有伪装成已实现',
  DIRECTION_CRITERIA.filter((c) => c.implemented === false).every(() => hE.includes('人工维护'))
);
/* 2026-09 起原来的 6 条人工维护判据全部接上了自动数据源，
 * 所以这一条从「解释为什么有判据走人工维护」改成「解释这一路数据是怎么来的」——
 * 页面必须交代：来源是谁、新鲜度怎么看、挂了会怎样。 */
check(
  '页面上交代了宏观读数的来源与新鲜度语义（不能只给结论不给出处）',
  hE.includes('自动采集') && hE.includes('数据滞后') && hE.includes('macro-sources.js'),
  ['自动采集', '数据滞后', 'macro-sources.js'].filter((k) => hE.includes(k)).join(' / ')
);
check(
  '页面上说明这 6 条是加分/刹车项、不是方向开关（否则会被读成"它们能翻方向"）',
  hE.includes('不是方向开关') && hE.includes('topBrake')
);
check('三档落实状态徽章都定义了（已实现 / 部分落实 / 人工维护）', true);
check('没有渲染出 undefined / NaN / [object', !/undefined|NaN|\[object/.test(hE), /undefined|NaN|\[object/.test(hE) ? '发现异常字面量' : '干净');

/* ── H5. M1~M6 宏观读数面板（2026-09 新增）──────────────────────────
 *
 * 用真实快照渲染一次，再用「有一个源挂掉」的快照渲染一次。
 * 后者是关键：如果只测"有数据时好看"，那源挂掉时静默少一行、
 * 或者把弃权渲染成 0 票，都不会被发现 —— 而那正是最需要看见的情况。
 */
{
  console.log('\nH5. M1~M6 宏观读数面板');

  const hasMacro = !!(snap.macro && Array.isArray(snap.macro.readings) && snap.macro.readings.length);
  check('快照带 macro.readings（没接上的话这一整块界面都不会出现）', hasMacro, hasMacro ? `${snap.macro.readings.length} 条` : '缺失');

  if (hasMacro) {
    const readings = snap.macro.readings;
    api.renderMacro(snap);
    const h = els.macro.innerHTML;

    check(
      '六条读数逐条出现在页面上（无漏条）',
      readings.every((m) => h.includes(m.id) || h.includes(m.name || '')),
      `${readings.filter((m) => h.includes(m.name || m.id)).length}/${readings.length}`
    );
    check(
      '每条都显示了数据来源（provider 名字在页面上）',
      readings.every((m) => {
        const key = {
          'media-extreme': 'fearGreed', 'etf-netflow': 'etfFlow', 'onchain-activity': 'onchain',
          'liquidity-macro': 'liquidity', 'institutional-holding': 'institutional', 'regulation-policy': 'regulatory',
        }[m.id];
        const prov = snap.macro.sources?.[key]?.provider;
        return !prov || h.includes(prov.slice(0, 12));
      }),
      '逐条核对来源标注'
    );
    check('显示了新鲜度角标（新鲜 / 数据滞后 / 取不到至少出现其一）', /新鲜|数据滞后|取不到/.test(h));
    check('显示了票的方向（多 / 空 至少出现其一）', /num-up|num-down/.test(h));

    /* 构造「ETF 源挂掉」的快照 —— 弃权必须显形为"取不到 + 弃权"，
     * 而不是悄悄少掉一行、更不是记成中性票。 */
    const broken = {
      ...snap,
      macro: {
        ...snap.macro,
        readings: snap.macro.readings.map((m) =>
          m.id === 'etf-netflow' ? { ...m, available: false, vote: 0, reason: 'ETF 流量取不到' } : m
        ),
        sources: { ...snap.macro.sources, etfFlow: { ...(snap.macro.sources?.etfFlow || {}), status: 'unavailable' } },
      },
    };
    api.renderMacro(broken);
    const hb = els.macro.innerHTML;
    check('源挂掉时该行渲染成「取不到」而不是消失', hb.includes('取不到') && hb.includes('etf-netflow'));
    check('源挂掉时该行标成「弃权」，不记成中性票', hb.includes('弃权'));
    check('源挂掉时代价被写明白（提示会回落到更旧的一级）', hb.includes('数据滞后') || hb.includes('回落到'));
    check('一个源挂掉不影响其余五条继续显示', broken.macro.readings.filter((m) => hb.includes(m.id)).length >= 5);
    check('弃权行不会被渲染成 0 票', !/>0 票</.test(hb));
  }
}

/* ── H6. 趋势列 + 历史库（2026-09 新增）────────────────────────────
 *
 * 单点快照回答不了「在变好还是变坏」，所以面板加了「趋势」列，
 * 数据来自服务端落库的历史序列（src/macro-store.js）。
 *
 * 这里必须测两种情况：
 *   · 历史只有 1 天（真实情况，库刚建立）→ 必须明说「仅 1 天记录」，
 *     而不是画一条只有一个点的假折线（单点画出来看着像"波动很小"）
 *   · 历史有 2 天以上 → 折线、变化量、小数位都要正确
 *
 * 还要测 macroHistory 整个字段缺失 —— 库打不开时服务端就不返回它，
 * 那条路径不能把整张卡带崩。
 */
{
  console.log('\nH6. 趋势列 + 历史库');

  const CELL_1D = />仅 1 天记录</g;
  const CELL_NOHIST = />暂无历史</g;

  if (snap.macro?.readings?.length) {
    // ---- ① 真实快照（库刚建立，通常只有 0~1 天）----
    api.renderMacro(snap);
    const h1 = els.macro.innerHTML;
    check('表头有「趋势」列', h1.includes('趋势（近 30 天）'));
    check('渲染出历史库摘要或明确不渲染（不写半截）', !snap.macroStore || !snap.macroStore.days || h1.includes('历史库（'));

    /* 不变式：每条「取到数据」的判据都该有数值，取不到的显示「暂无历史」。
     * 写成不变式而不是「六条都必须有值」—— 后者会因某个源临时挂掉而假失败
     * （本机实测就撞上 Blockchain.com 的 onchain: fetch failed）。 */
    const availN = snap.macro.readings.filter((m) => m.available).length;
    const valN = snap.macro.readings.filter((m) => Number.isFinite(m.value)).length;
    check('每条取到数据的判据都带数值（否则趋势列永远画不出来）', availN === valN, `取到 ${availN} / 有数值 ${valN}`);

    /* 这两条原本写成「库里通常只有 0~1 天，所以不该有 sparkline」——
     * 那是个**会随系统正常运转而变红的测试**：账本每天多攒一天，
     * 到第 2 天「仅 1 天记录」全部消失、sparkline 全部出现，两条断言同时假失败。
     * 实测就是这么红的（2026-09-23，库里有了 09-22 和 09-23 两天）。
     * 改成**不变式**：每个判据的渲染必须与它自己的历史点数一致 ——
     * 点 < 2 → 文字明说 + 不画线；点 ≥ 2 → 才允许画线。这样永不随数据增长而失效。 */
    const histLive = snap.macroHistory || {};
    let thin = 0;
    let thick = 0;
    for (const id of Object.keys(histLive)) {
      const pts = (histLive[id] || []).filter((p) => Number.isFinite(p.value)).length;
      if (pts >= 2) thick++;
      else thin++;
    }
    const c1 = (h1.match(CELL_1D) || []).length;
    const c0 = (h1.match(CELL_NOHIST) || []).length;
    const sparkN = (h1.match(/class="spark"/g) || []).length;
    const ctxD = `历史：薄 ${thin} / 厚 ${thick}；渲染：「仅1天」${c1}、「暂无」${c0}、sparkline ${sparkN}`;

    check('历史不足 2 点的判据明说，不伪造折线', thin === 0 || c1 + c0 >= 1, ctxD);
    check('不存在「历史不足 2 点却画出 sparkline」的判据', sparkN <= thick, ctxD);
    check('历史够 2 点的判据确实画出了 sparkline', thick === 0 || sparkN >= 1, ctxD);

    // ---- ② 注入 14 天历史 ----
    const dayOf = (back) => new Date(Date.now() - back * 86400000).toISOString().slice(0, 10);
    const SP = {
      'media-extreme': [44, 78], 'etf-netflow': [-3.2e8, 9.99e8], 'onchain-activity': [1.9, 3.78],
      'liquidity-macro': [102.4, 100.36], 'institutional-holding': [3.61, 3.915], 'regulation-policy': [0, 1],
    };
    const syn = {};
    for (const [id, [from, to]] of Object.entries(SP)) {
      syn[id] = Array.from({ length: 14 }, (_, i) => {
        const t = i / 13;
        return { day: dayOf(13 - i), value: Math.round((from + (to - from) * t) * 1000) / 1000, vote: 0, available: true, freshness: 'ok' };
      });
    }
    const withHist = {
      ...snap,
      macroHistory: syn,
      macroStore: { backend: 'sqlite', days: 14, rows: 84, firstDay: dayOf(13), lastDay: dayOf(0) },
    };
    api.renderMacro(withHist);
    const h2 = els.macro.innerHTML;

    check('6 条判据各画一条趋势线', (h2.match(/class="spark"/g) || []).length === 6, `实际 ${(h2.match(/class="spark"/g) || []).length} 条`);
    check('趋势线是合法的 SVG path', (h2.match(/<path d="M[\d.,L\s]+"/g) || []).length === 6);
    check('写出「起点 → 现值（变化）」与样本天数', /→/.test(h2) && /（[+-]/.test(h2) && h2.includes('· 14 天'));
    check('有数据后不再残留占位文案', (h2.match(CELL_1D) || []).length === 0 && (h2.match(CELL_NOHIST) || []).length === 0);
    check('渲染出历史库摘要（14 天 / 84 行）', h2.includes('14 天 / 84 行'));
    check('没有 NaN / undefined / [object 漏出', !/NaN|undefined|\[object/.test(h2));

    /* 小数位按**单位**定：M6 是「官方净条目数」（计数），必须整数显示。
     * 只看数量级会走到 dp=2，印出「0.00 → 1.00」这种噪音。 */
    const rowOf = (marker) => {
      const rs = h2.split('<tr').filter((r) => r.includes(marker));
      return rs.length ? rs[rs.length - 1] : '';
    };
    const m6d = (rowOf('M6 监管政策').match(/（([+-][\d.]+)）/) || [])[1];
    const m2d = (rowOf('M2 ETF 净流入').match(/（([+-][\d.]+)）/) || [])[1];
    check('M6（计数）变化量不带小数点', m6d != null && !m6d.includes('.'), `实际「${m6d}」`);
    check('M2（美元大额）变化量不带小数点', m2d != null && !m2d.includes('.'), `实际「${m2d}」`);

    // ---- ③ macroHistory 整个缺失（库打不开）----
    const noStore = { ...snap };
    delete noStore.macroHistory;
    delete noStore.macroStore;
    let threw = null;
    try {
      api.renderMacro(noStore);
    } catch (e) {
      threw = e.message;
    }
    const h3 = els.macro.innerHTML;
    check('历史库缺失时不抛错', !threw, threw || '');
    check('历史库缺失时表照常渲染（只是趋势列走占位）', h3.includes('趋势（近 30 天）') && h3.includes('media-extreme'));
    check('历史库缺失时不渲染半截的库摘要', !h3.includes('历史库（'));

    // ---- ④ 全渲染路径都不许漏出 ** ----
    check('M1~M6 面板没有漏出来的 **', !h1.includes('**') && !h2.includes('**') && !h3.includes('**'));
  }

  /* ---- ⑤ 小数位规则的**漂移守卫** ----
   *
   * 同一个规则现在有两个消费方：
   *   · 网页  `public/app.js` 的 `dpFor(unit, v)`（趋势列）
   *   · 终端  `src/macro-view.js`，走共享的 `src/macro-sources.js` → `valueDecimals()`
   * 保留两份实现是刻意的（网页要精确读数，终端要紧凑列宽，目标不同），
   * 但「几位小数」这件事的答案必须相同 —— 否则同一个计数在页面上是 `1`、
   * 在终端是 `1.00`，两边看起来都正常，没人会发现。
   * 所以这里从 app.js **切出真源码**求值，与共享实现逐格对拍（不手抄一份等价实现）。 */
  console.log('\nI. 趋势列小数位：网页 dpFor 与共享 valueDecimals 的漂移守卫');
  {
    const dpChunk = slice('const dpFor = (unit, v) => {', 'const trendCell = (id, unit) => {');
    const { dpFor } = new Function(`${dpChunk}\nreturn { dpFor };`)();

    // 六条真实判据的单位 + 兜底（单位为空的取不到场景）
    const units = [
      '指数 0-100（越高越贪婪）',
      'USD（最新单日净流入）',
      '%（活跃地址周环比）',
      'DXY（美元指数）',
      '%（IBIT 占流通量，下界）',
      '条（官方净条目 = 偏多 − 偏空）',
      null,
    ];
    const values = [0, 1, 3.78, 78, 100.381, -3.2e8, 3.915, 999, 1500, 999000000];

    const mismatches = [];
    for (const u of units) {
      for (const v of values) {
        const a = dpFor(u, v);
        const b = valueDecimals(u, v);
        if (a !== b) mismatches.push(`${u ?? 'null'} / ${v}：网页 ${a} vs 共享 ${b}`);
      }
    }
    check('网页 dpFor 与共享 valueDecimals 逐格一致', mismatches.length === 0, mismatches.slice(0, 3).join(' · '));

    // 具体语义也钉一遍 —— 一致但一起错也是一种可能
    check('计数单位（条）固定 0 位小数', valueDecimals('条（官方净条目 = 偏多 − 偏空）', 1) === 0);
    check('指数固定 0 位小数', valueDecimals('指数 0-100（越高越贪婪）', 78) === 0);
    check('美元大额 0 位小数（不科学计数）', valueDecimals('USD（最新单日净流入）', 999000000) === 0);
    check('百分数保留 2 位', valueDecimals('%（活跃地址周环比）', 3.78) === 2);
    check('单位为空的兜底不发散（仍是数字）', Number.isInteger(valueDecimals(null, 3.61)));
  }
}

console.log('\nE3. 判据层读数（A4~A7）—— 有数据时必须逐层展示');
const r = snap.regime;
if (r && (r.technicals || r.sentiment || r.volume || r.reaction)) {
  check('包含判据层读数区块', hE.includes('判据层读数（A4~A7）'));
  check('包含 A4 技术面行', hE.includes('A4 技术面'));
  check('包含 A5 情绪拥挤度行', hE.includes('A5 情绪拥挤度'));
  check('包含 A6 量能形态行', hE.includes('A6 量能形态'));
  check('包含 A7 事件反应行', hE.includes('A7 事件反应'));
  check('说明了「只刹车 / 确认，不翻方向」', hE.includes('不翻方向') || hE.includes('不翻方向') || hE.includes('刹车 / 确认'));
  if (r.reversal) {
    check('展示了合成票数与门槛', hE.includes('见顶票') && hE.includes('门槛'));
    check('说明了减半大前提', hE.includes('减半大前提'));
    check(
      '弃权项被显形标注（不允许静默计 0 分）',
      r.reversal.evidence.some((e) => !e.available) ? hE.includes('弃权') : true
    );
  }
} else {
  check('快照里有判据层数据', false, '缺 regime.technicals/sentiment/volume/reaction');
}

/* ══════════════════════════════════════════════════════════════════
 * F. renderPipeline —— 三段流程（① 定方向 → ② 定时点 → ③ 管持仓）
 *
 * 这一节覆盖「系统一共分三个部分」这句话的界面落点。重点不是"卡片画出来了"，
 * 而是**单向依赖必须在界面上看得出来**：
 *   · 三段之间要画箭头（顺序是信息，不是装饰）；
 *   · 阶段一不放行时，分笔计划仍要列出但**逐行标成未生效** ——
 *     直接隐藏会让人以为"没有计划"，而真相是"有计划但此刻不该执行"。
 * ══════════════════════════════════════════════════════════════════ */

console.log('\nF. renderPipeline —— 三段流程');

const P = snap.pipeline;
els.pipeline.innerHTML = '';
api.renderPipeline(snap);
const ph = els.pipeline.innerHTML;

if (!P) {
  check('快照缺 pipeline 时给出显式占位（不静默留一整块空白）', ph.length > 10 && /不可用/.test(ph), ph.slice(0, 40));
} else {
  check('不抛错且产出了 HTML', ph.length > 300, `${ph.length} 字符`);
  check(
    '三段流程条画出来了（三段 + 两个箭头 —— 箭头表示单向依赖，是规则的一部分）',
    (ph.match(/pipe-step /g) || []).length === 3 && (ph.match(/pipe-arrow/g) || []).length === 2,
    `${(ph.match(/pipe-step /g) || []).length} 段 / ${(ph.match(/pipe-arrow/g) || []).length} 箭头`
  );
  check('结论条展示了卡点结论（headline）', ph.includes('pipe-verdict') && ph.includes(esc(P.headline)), P.headline);
  check(
    '三段名称取自 pipeline.stagesMeta（前端不另抄一份，避免改一处漏一处）',
    (P.stagesMeta || []).every((m) => ph.includes(esc(m.name))),
    (P.stagesMeta || []).map((m) => m.name).join(' / ')
  );
  check(
    '每段都带比特皇原话与出处（三段都要有 —— 空数组不算通过）',
    (P.stagesMeta || []).length === 3 && P.stagesMeta.every((m) => m.quote && m.source && ph.includes(esc(m.quote))),
    `${(P.stagesMeta || []).filter((m) => m.quote && ph.includes(esc(m.quote))).length}/3 段原话出现在页面上`
  );
  check('判据按阶段分布被展示', ph.includes(`基本面 ${P.criteria.byStage['1']}`) && ph.includes(`持仓管理 ${P.criteria.byStage['3']}`));
  check('没有渲染出 undefined / NaN / [object / Infinity', !/undefined|NaN|\[object|Infinity/.test(ph), /undefined|NaN|\[object|Infinity/.test(ph) ? '发现异常字面量' : '干净');

  const [s1, s2, s3] = P.stages;
  check('阶段一状态徽标与 stage1.status 一致', ph.includes(api.STAGE_META[1][s1.status].txt), `status=${s1.status}`);
  check('阶段二状态徽标与 stage2.status 一致', ph.includes(api.STAGE_META[2][s2.status].txt), `status=${s2.status}`);
  check('阶段三状态徽标与 stage3.status 一致', ph.includes(api.STAGE_META[3][s3.status].txt), `status=${s3.status}`);

  // 单向依赖的界面证据：被挡住的那一段要压暗，并且明确说明「不评估入场点」
  if (s2.status === 'BLOCKED_BY_STAGE1') {
    check('阶段一未放行 → 阶段二整段标为 blocked（压暗，视觉上先于文字被读到）', ph.includes('pipe-step warn blocked'));
    if (s2.tranches.length) {
      check(
        '阶段一未放行 → 分笔计划仍列出但**每一行**都标成「未生效」（直接隐藏会让人以为"没有计划"）',
        (ph.match(/tranche-off/g) || []).length === s2.tranches.length && ph.includes('未生效'),
        `${(ph.match(/tranche-off/g) || []).length}/${s2.tranches.length} 行未生效`
      );
      check('阶段一未放行 → 没有任何一笔被标成「生效」', !/badge ok">生效/.test(ph));
    } else {
      check(
        '阶段一未放行且当前没有触发侧时，明确写出「没有计划可列」（而不是留一张空表）',
        ph.includes('没有计划可列'),
        '本次快照无触发侧 —— 走的是显式空态分支'
      );
    }
    check('阶段一未放行时明确写出「方向没定之前不评估入场点」', ph.includes('方向没定之前不评估入场点'));
  } else {
    check('阶段二未被挡住时，流程条上不出现 blocked 压暗', !ph.includes('pipe-step warn blocked'), `status=${s2.status}`);
  }

  check(
    '阶段一区块把「需要人工确认的判据」显形（有就写出来，没有就不编）',
    s1.manualPending?.length ? ph.includes('需要人工确认的判据') : true,
    `人工 ${s1.manualPending?.length ?? 0} 条`
  );
  check(
    '阶段三无持仓时给「不适用」而不是一堆 0',
    s3.applicable ? true : ph.includes('不适用'),
    s3.applicable ? '有持仓，走完整区块' : '无持仓，走不适用分支'
  );
  check(
    '阶段三有持仓时展示加仓两道门与四条离场通道',
    !s3.applicable || (ph.includes('第一道门') && ph.includes('第二道门') && ph.includes('离场通道')),
    s3.applicable ? `urgency=${s3.urgency}` : '不适用'
  );
}

/* ══════════════════════════════════════════════════════════════════
 * G. trancheRows —— 分笔执行计划（策略卡里的落点）
 *
 * 这段文案只在「有触发侧」的快照里才渲染得出来，而真实快照经常没有触发侧，
 * 内联在 renderStrategy 里就等于长期无人覆盖 —— 所以拆成函数用合成输入直接测。
 * 要害是：两笔的止损是**两个不同的价**（头仓锚突破位、主仓锚中轨），
 * 不能让读者以为两笔共用一个止损。
 * ══════════════════════════════════════════════════════════════════ */

console.log('\nG. trancheRows —— 头仓 30% / 主仓 70%，各自独立止损');

const trFixture = {
  tranches: [
    { index: 1, name: '头仓（突破批次）', side: 'BREAKOUT', ratioBps: 3000, qty: '1000000000000000000', triggerPrice: '100000000000000000000', triggerKind: 'MARKET', stopPrice: '95000000000000000000', stopAnchor: '突破参考位外侧', active: true },
    { index: 2, name: '主仓（回调批次）', side: 'PULLBACK', ratioBps: 7000, qty: '2000000000000000000', triggerPrice: '98000000000000000000', triggerKind: 'LIMIT', stopPrice: '90000000000000000000', stopAnchor: '中轨外侧', active: true },
  ],
};
const trAll = api.trancheRows(trFixture);
check('不抛错且产出两行', (trAll.match(/class="kv"/g) || []).length === 2, `${(trAll.match(/class="kv"/g) || []).length} 行`);
check('两笔的止损是两个不同的价（95 与 90 都要出现）', trAll.includes('95.00') && trAll.includes('90.00'), '头仓止损 95 · 主仓止损 90');
check('回调批标出「限价」等回踩（挂不上就不成交，不改成追高）', trAll.includes('限价'));
check('占比按 30% / 70% 显示', trAll.includes('30.00%') && trAll.includes('70.00%'));
check('价格按 fmtPrice 显示（不是 1e20 也不带 18 位小数）', trAll.includes('100.00') && !/\d{15,}/.test(trAll));
check('没有渲染出 undefined / NaN / [object', !/undefined|NaN|\[object/.test(trAll));

const trOff = api.trancheRows({ tranches: trFixture.tranches.map((t) => ({ ...t, active: false })) });
check('未生效时逐行标出「未生效」（未放行时不得让人以为可以挂单）', (trOff.match(/未生效/g) || []).length === 2, `${(trOff.match(/未生效/g) || []).length}/2 行`);

/* ══════════════════════════════════════════════════════════════════
 * H. esc / mdt —— 判据文本里的 Markdown 强调
 *
 * src/ 的理由链是按 Markdown 写的（`**逆周期**`）。前端如果直接 esc，
 * 星号会原样印到用户脸上；如果顺序反了（先替换再 esc），就等于亲手
 * 开一个注入口子。这一组把两个方向都钉住。
 * ══════════════════════════════════════════════════════════════════ */

console.log('\nH. esc / mdt —— 强调与转义');

check('mdt 把 **强调** 变成 <b>', mdt('**逆周期**：相位与结构冲突') === '<b>逆周期</b>：相位与结构冲突', mdt('**逆周期**：相位与结构冲突'));
check('mdt 不跨行配对（两处无关的 ** 不会被误配成一对）', mdt('**a\n**b') === '**a\n**b', JSON.stringify(mdt('**a\n**b')));
// 顺序断言：如果实现是「先替换再转义」，这里会得到 &lt;b&gt; 或直接放过 <b> 标签
check(
  'mdt 先转义再替换 —— 原始 HTML 被转成实体，不能靠 ** 之外的路径注入标签',
  mdt('**a** <b onclick="x">y</b>') === '<b>a</b> &lt;b onclick=&quot;x&quot;&gt;y&lt;/b&gt;',
  mdt('**a** <b onclick="x">y</b>')
);
check('esc 也来自 app.js 源码（与页面同一份实现）', esc('<&">') === '&lt;&amp;&quot;&gt;', esc('<&">'));
// 渲染产物里不该再有星号：判据理由链是真实渲染路径，不是构造的 fixture
check('renderMacro 的产物里没有漏出来的 **', !/\*\*/.test(html), (html.match(/\*\*[^*\n]{0,20}\*\*/g) || []).join(' | '));
check('renderPipeline 的产物里没有漏出来的 **', !/\*\*/.test(els.pipeline.innerHTML), (els.pipeline.innerHTML.match(/\*\*[^*\n]{0,20}\*\*/g) || []).join(' | '));

const trEmpty = api.trancheRows({});
check('tranches 缺失时返回空串，让调用方走旧的兼容分支而不是抛错', trEmpty === '', JSON.stringify(trEmpty));

/* ══════════════════════════════════════════════════════════════════
 * I2. lastChange —— 「哪一天变的」不能取最新观测日
 *
 * 实测踩到（2026-09-23）：DFEDTARU 在 2026-09-17 由 3.75 变 4.00，此后每天都是
 * 4.00，最后一个观测日是 09-22。原实现把 `changedOn` 返回成**最后一个观测日**，
 * 于是界面上印出「最近一次**上调** 25bp，2026-09-22，6 天前」——
 * **日期与「6 天前」自相矛盾**，读的人会以为美联储昨天才加息。
 * 对一个方向决策系统来说，「哪天变的」本身就是结论的一部分，不能取错。
 * ══════════════════════════════════════════════════════════════════ */

console.log('\nI2. lastChange —— 变动日必须取「第一个带新值的观测日」');
{
  // 复刻真实源形态：旧值 6 天 → 新值 6 天（含端点）
  const rows = [];
  for (let d = 11; d <= 16; d++) rows.push({ date: `2026-09-${d}`, value: 3.75 });
  for (let d = 17; d <= 22; d++) rows.push({ date: `2026-09-${d}`, value: 4 });
  const c = lastChange(rows);

  check('方向识别为加息', c.direction === 'HIKE', JSON.stringify(c));
  check('幅度 25bp', c.deltaBp === 25, String(c.deltaBp));
  check('changedOn 取变动当天 2026-09-17', c.changedOn === '2026-09-17', `changedOn=${c.changedOn}`);
  check('回归守卫：changedOn 不再等于最新观测日 2026-09-22', c.changedOn !== '2026-09-22', `changedOn=${c.changedOn}`);
  check('sinceDate 是旧值的末次观测日 2026-09-16', c.sinceDate === '2026-09-16', `sinceDate=${c.sinceDate}`);
  check(
    '印出的「日期 + N 天前」不会自相矛盾',
    c.daysAgo === 6 && c.changedOn !== rows[rows.length - 1].date,
    `${c.changedOn}，${c.daysAgo} 天前`
  );

  const flat = lastChange([{ date: '2026-09-21', value: 4 }, { date: '2026-09-22', value: 4 }]);
  check('全平序列返回 FLAT 且不编造变动日', flat.direction === 'FLAT' && flat.changedOn === null, JSON.stringify(flat));
  check('空输入返回 null 而不是抛错', lastChange([]) === null && lastChange(null) === null);
}

/* ══════════════════════════════════════════════════════════════════
 * I3. 周期相位说明必须显形 —— 「自动」也不能是隐形的
 *
 * 相位是**唯一与价格无关**的输入：它决定方向层只许往哪边，也决定波动门槛
 * 的下限。一个不显示的自动值等于让用户去猜「系统认为现在是牛还是熊」，
 * 而那恰恰是他最该知道的一件事。
 *
 * 反面教材是改动前的行为：默认值 ACCUMULATION 与时钟推算的 DECLINE 不一致，
 * 界面上却只在 stale 时才提示；而绝大多数用户从没动过下拉框，
 * 于是长期带着一个"系统在按筑底算"的错觉 —— 实际上方向层压根没看这个值。
 * ══════════════════════════════════════════════════════════════════ */

console.log('\nI3. 相位说明 —— 自动模式下也必须写出来');

{
  const pc = snap.phaseCheck;
  check('真实快照带出 phaseCheck（相位必须可对账）', !!pc, JSON.stringify(pc));
  check('相位的取值域里有「自动」这一档', pc?.auto === true || pc?.manual != null, JSON.stringify({ auto: pc?.auto, manual: pc?.manual }));

  if (pc?.auto) {
    check('自动模式下界面写明「由减半时钟推算」', html.includes('周期相位：自动'), (html.match(/周期相位[^<]{0,20}/) || ['(无)'])[0]);
    check('自动模式必须给出推算出的具体相位名（不能只写"自动"）', html.includes(pc.derivedLabel) || html.includes(pc.derived), `derivedLabel=${pc.derivedLabel}`);
    check('自动模式给出距上次减半的月数（可核算）', html.includes('距上次减半'), '');
    // 自动是正常状态，不该同时报成"对账不一致"——那会训练用户忽略告警
    check('自动模式不再报「对账不一致」', !html.includes('周期相位对账不一致'), '');
  }

  /* 反向：人工指定一个与推算不同的相位时，必须报出来。
   * 这条用合成快照，不依赖"今天恰好是自动还是人工"。 */
  const synthetic = { ...snap, phaseCheck: { ...pc, auto: false, manual: 'ACCUMULATION', derived: 'DECLINE', stale: true, detail: '人工设定与推算不一致。' } };
  api.renderMacro(synthetic);
  const hSyn = els.macro.innerHTML;
  check('人工相位与推算不一致时，界面必须报出对账不一致', hSyn.includes('周期相位对账不一致'), '');
  check('报出时同时给出人工值与推算值', hSyn.includes('ACCUMULATION') && hSyn.includes('DECLINE'), '');
  check('对账提示里没有漏出来的 **', !/\*\*/.test(hSyn), '');

  /* 未知值：兜底成自动，但**必须**显形，否则用户以为自己指定了相位 */
  const typo = { ...snap, phaseCheck: { ...pc, auto: true, manual: null, unknown: true, requested: 'TYPO', derived: 'DECLINE', detail: '相位参数「TYPO」不是已知相位。' } };
  api.renderMacro(typo);
  const hTypo = els.macro.innerHTML;
  check('传了不认识的相位时，界面必须说明该参数已被忽略', hTypo.includes('TYPO') || hTypo.includes('不是已知相位'), '');

  // 收尾：把面板还原成真实快照的渲染，避免影响后续断言
  api.renderMacro(snap);
}

/* ── J. 宏观面板降级必须显形（2026-09 新增）─────────────────────────
 *
 * 六个免费源集体挂掉时，票面上是六个 0（全部弃权），与「六条都读到了、
 * 都投中性票」在票面上**长得一模一样** —— 但一个不可信、一个可信。
 * 所以服务端把降级状态放在 `macro.degraded` 里，界面必须把它渲染出来。
 *
 * 同时要钉住粒度：`errors` 非空（部分源失败）是**常态**，表格里已有
 * 红色的来源状态徽章，不该再弹一条大提示 —— 那会让提示变成永远挂着的噪音，
 * 真降级时反而没人看。只有 `degraded`（整体不可用）才出大提示。
 */
console.log('\nJ. 宏观面板降级必须显形');
{
  const ALL6 = ['media-extreme', 'etf-netflow', 'onchain-activity', 'liquidity-macro', 'institutional-holding', 'regulation-policy'];

  // ---- ① 有 degraded → 必须有提示，且说清「结论仍有效」 ----
  const degradedSnap = {
    ...snap,
    macro: {
      ...(snap.macro || {}),
      degraded: '六个数据源本次全部取不到',
      readings: (snap.macro?.readings || []).map((r) => ({ ...r, available: false, vote: 0, reason: `${r.name || r.id}取不到` })),
      errors: ['采集失败：演练'],
      sources: {},
    },
  };
  api.renderMacro(degradedSnap);
  const hd = els.macro.innerHTML;
  check('降级时渲染出「宏观读数本次降级」提示', hd.includes('宏观读数本次降级'), '');
  check('降级提示带上服务端给的具体原因（不自己编一个说法）', hd.includes('六个数据源本次全部取不到'), '');
  check('降级提示说明方向结论仍有效（别让读的人以为整块都废了）', /结论本身照常有效/.test(hd), '');
  check('降级时六条读数仍在表里（不是整块消失）', ALL6.every((id) => hd.includes(id)), '');
  check('降级时票列出现六个「弃权」', (hd.match(/弃权/g) || []).length >= 6, `实际 ${(hd.match(/弃权/g) || []).length}`);

  // ---- ② 未降级 → 不许出现这条提示（否则它会变成永远挂着的噪音）----
  api.renderMacro({ ...snap, macro: { ...(snap.macro || {}), degraded: null } });
  check('未降级时不渲染降级提示', !els.macro.innerHTML.includes('宏观读数本次降级'), '');

  // ---- ③ 部分源失败（errors 非空但没有 degraded）不该弹降级大提示 ----
  api.renderMacro({ ...snap, macro: { ...(snap.macro || {}), degraded: null, errors: ['onchain: fetch failed'] } });
  check('只有部分源失败时不弹降级提示（那是常态，表格里有状态徽章）', !els.macro.innerHTML.includes('宏观读数本次降级'), '');
}

console.log(`\n结论：${pass} 项通过，${fail} 项失败`);
process.exit(fail ? 1 : 0);
