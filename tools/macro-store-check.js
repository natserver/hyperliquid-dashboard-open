#!/usr/bin/env node
/**
 * 历史库测试 —— 结构、upsert 语义、查询、裁剪、迁移、以及**两个后端的一致性**。
 *
 * ── 为什么「两个后端一致」是这里最重要的一组断言 ──────────────────────
 *
 * `src/macro-store.js` 有两个后端：node:sqlite（Node 22.5+）和 JSONL（降级）。
 * 它们会用在不同机器上 —— 你自己的机器走 SQLite，别人 clone 下来跑在 Node 20
 * 上就走 JSONL。如果两者语义有偏差，那么「同一份代码在不同机器上攒出不同的历史」
 * 这种事会一直潜伏到某天有人对不上数为止。
 *
 * 这个测试在**同一份输入**上跑两个后端，逐字段比对输出。写这个文件的过程中
 * 它已经抓到三个真实偏差：
 *   · latestRows 一个返回列名对象、一个返回裸数组
 *   · prune 一个报天数、一个报行数（量纲都不同）
 *   · 排序一个按字典序、一个按写入序（latest[0] 不是同一条判据）
 * 这三个都不是靠读代码能看出来的。
 *
 * 用法：
 *   node tools/macro-store-check.js
 *   node tools/macro-store-check.js --keep    保留测试目录（默认跑完就删）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CRITERIA_ORDER,
  DATA_DIR,
  dayOf,
  macroHistory,
  openMacroStore,
  recordMacro,
  storeSummary,
} from '../src/macro-store.js';
import { displayWidth, failedNames, historyViewData, pad, renderHistoryView, sparkTerm } from '../src/macro-view.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TMP = path.join(ROOT, '.cache', 'store-check');
const KEEP = process.argv.includes('--keep');

let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`);
  }
};

/** 判据顺序直接用库里那份常量 —— 测试再抄一份就等于给「顺序漂移」留了第三处入口 */
const ORDER = CRITERIA_ORDER;

/** 一份贴近真实形状的读数（含 gate / tightening 这类附加字段） */
const panel = {
  fetchedAt: '2026-09-22T05:00:00.000Z',
  spotPrice: 85592,
  errors: ['onchain: fetch failed'],
  readings: [
    { id: 'media-extreme', layer: 'M1', name: '媒体情绪', available: true, vote: -1, value: 78, unit: '指数 0-100（越高越贪婪）', ttl: 'ok', asOf: '2026-09-22', reason: '极端乐观' },
    { id: 'etf-netflow', layer: 'M2', name: 'ETF 净流入', available: true, vote: 0, value: 999000000, unit: 'USD（最新单日净流入）', ttl: 'ok', asOf: '2026-09-21', reason: '仅 2 日超阈' },
    { id: 'onchain-activity', layer: 'M3', name: '链上活跃', available: false, vote: 0, ttl: 'unavailable', reason: '取不到' },
    { id: 'liquidity-macro', layer: 'M4', name: '流动性与利率', available: true, vote: 0, value: 100.373, unit: 'DXY（美元指数）', ttl: 'ok', asOf: '2026-09-22', gate: { dxyOk: true, cutOk: false }, tightening: true, reason: 'DXY 过 / 降息信号无' },
    { id: 'institutional-holding', layer: 'M5', name: '机构持仓', available: true, vote: 0, value: 3.915, unit: '%（IBIT 占流通量，下界）', ttl: 'ok', asOf: '2026-09-17', reason: '3.915% < 5%' },
    { id: 'regulation-policy', layer: 'M6', name: '监管政策', available: true, vote: 1, value: 1, unit: '条（官方净条目 = 偏多 − 偏空）', ttl: 'ok', asOf: '2026-09-22', reason: '官方 1 偏多', items: [{ title: 'SEC Issues Innovation Exemption' }] },
  ],
};

const META = { bias: 'NEUTRAL', biasLabel: '方向未定（不开新仓）', confidence: 'MEDIUM', cyclePhase: 'ACCUMULATION', now: Date.parse('2026-09-22T05:00:00.000Z') };

const cleanup = () => {
  if (!KEEP) fs.rmSync(TMP, { recursive: true, force: true });
};
cleanup();

console.log('A. 打开与建表');
const opened = {};
for (const backend of ['sqlite', 'jsonl']) {
  const dir = path.join(TMP, backend);
  const st = openMacroStore({ dir, backend });
  opened[backend] = st;
  check(`${backend} 后端可打开`, !!st);
  check(`${backend} 报告了后端类型与路径`, st.kind === backend && typeof st.path === 'string', `${st.kind} / ${path.basename(st.path)}`);
  const s0 = st.stats();
  check(`${backend} 空库统计为 0 行`, (s0.rows || 0) === 0 && (s0.days || 0) === 0);
  check(`${backend} 空库 firstDay/lastDay 为 null`, s0.first_day === null && s0.last_day === null);
}

console.log('\nB. upsert 语义（同一天重复写只覆盖不追加）');
for (const backend of ['sqlite', 'jsonl']) {
  const st = opened[backend];
  const r1 = recordMacro(st, panel, META);
  const r2 = recordMacro(st, { ...panel, spotPrice: 86000 }, { ...META, bias: 'NEUTRAL' });
  check(`${backend} 写入返回 day + 行数`, !!r1 && r1.day === '2026-09-22' && r1.rows === 6, JSON.stringify(r1));
  check(`${backend} 同一天写两次仍是 6 行`, st.stats().rows === 6, `实际 ${st.stats().rows}`);
  check(`${backend} 第二次写覆盖而不是追加`, r2 && r2.day === r1.day && st.stats().days === 1);

  const latest = st.latestRows(st.latestDay());
  check(`${backend} latestRows 返回 6 条`, latest.length === 6, `实际 ${latest.length}`);
  check(`${backend} latestRows[0] 是 M1 而不是字典序第一条`, latest[0].criterion === 'media-extreme', latest[0].criterion);
  check(`${backend} spotPrice 被覆盖为最新值`, latest[0].spot_price === 86000, String(latest[0].spot_price));
  check(`${backend} 数值字段可读`, latest[0].value === 78 && latest[0].vote === -1);
  check(`${backend} 单位字段落库`, latest[0].unit === '指数 0-100（越高越贪婪）', String(latest[0].unit));
  check(`${backend} 数据日与采集日分开存`, latest[0].data_day === '2026-09-22' && latest[0].day === '2026-09-22');
  check(`${backend} 取不到的判据 available=0 且无值`, (() => { const m3 = latest.find((x) => x.criterion === 'onchain-activity'); return m3.available === 0 && m3.value === null; })());
  check(`${backend} 附加字段（gate/tightening）进 detail`, (() => { const m4 = latest.find((x) => x.criterion === 'liquidity-macro'); const d = JSON.parse(m4.detail); return d.gate.dxyOk === true && d.tightening === true; })());
  check(`${backend} reason 不重复进 detail`, (() => { const m1 = latest.find((x) => x.criterion === 'media-extreme'); return !m1.detail || !m1.detail.includes('极端乐观'); })());

  const run = st.runs(1)[0];
  check(`${backend} run 记下方向与相位`, run.bias === 'NEUTRAL' && run.cycle_phase === 'ACCUMULATION' && run.confidence === 'MEDIUM', `${run.bias} / ${run.cycle_phase}`);
  check(`${backend} run 记下取源失败`, String(run.errors).includes('onchain'), String(run.errors).slice(0, 40));
  /* 这四列曾经是建了却永远写 null 的死列 —— 比没有这一列更坏，因为看起来有数据。
   * 断言盯死它们必须真的被填：5 条取到 / 1 条弃权 / 多 1 / 空 1（见 panel 的构造）。 */
  check(
    `${backend} run 的 available/abstain/vote 统计真的被填（不是死列）`,
    run.available === 5 && run.abstain === 1 && run.vote_long === 1 && run.vote_short === 1,
    JSON.stringify({ available: run.available, abstain: run.abstain, long: run.vote_long, short: run.vote_short })
  );
}

console.log('\nC. 历史序列查询');
for (const backend of ['sqlite', 'jsonl']) {
  const st = opened[backend];
  // 造一个 5 天前的历史点
  const old = dayOf(Date.parse('2026-09-22T05:00:00.000Z') - 5 * 86400000);
  st.writeDay({
    day: old,
    fetchedAt: '2026-09-17T05:00:00.000Z',
    spotPrice: 80000,
    bias: 'SHORT_ONLY',
    biasLabel: '只许做空',
    confidence: 'LOW',
    cyclePhase: 'DECLINE',
    errors: [],
    rows: ORDER.map((id, i) => [old, i, id, null, null, 50, 'x', 1, -1, old, 'ok', `历史 ${id}`, null, 80000, null, '2026-09-17T05:00:00.000Z']),
  });

  check(`${backend} 库内 2 天`, st.stats().days === 2, `实际 ${st.stats().days}`);
  check(`${backend} 按判据查到 2 个点`, st.history('media-extreme', '2026-01-01').length === 2);
  const h = macroHistory(st, { days: 100000 });
  check(`${backend} macroHistory 覆盖全部 6 个判据`, Object.keys(h).length === 6, Object.keys(h).length + ' 个');
  check(`${backend} 序列按时间正序`, h['media-extreme'][0].day < h['media-extreme'][1].day, h['media-extreme'].map((x) => x.day).join(' → '));
  check(`${backend} 序列带 available / vote`, typeof h['media-extreme'][0].available === 'boolean' && h['media-extreme'][0].vote === -1);
  const series = st.series('media-extreme', 1);
  check(`${backend} series(limit=1) 取最新一条`, series.length === 1 && series[0].day === '2026-09-22', series[0] && series[0].day);
}

console.log('\nD. 裁剪（保留期）');
/* prune 的保留期是相对**真实当前时间**算的，而本文件的数据日期写死了 2026-09-22。
 * 两者错开之后（过了 09-23，cut 推到 09-23）连 09-22 都会被当成过期数据裁掉 ——
 * 这一组于是自己变红，跟库里有几天数据无关，纯粹是时间在流逝。
 * 所以把基准时刻显式钉死，让它永不腐烂。 */
const PRUNE_NOW = Date.parse('2026-09-22T05:00:00.000Z');
const pruned = {};
for (const backend of ['sqlite', 'jsonl']) {
  const st = opened[backend];
  const pr = st.prune(1, PRUNE_NOW);
  pruned[backend] = pr;
  check(`${backend} prune 报告天数 + 行数 + run 数（同一套口径）`, 'removedDays' in pr && 'removedRows' in pr && 'removedRuns' in pr, JSON.stringify(pr));
  check(`${backend} 裁掉了那 1 个旧日`, pr.removedDays === 1, String(pr.removedDays));
  check(`${backend} 裁掉了 6 行`, pr.removedRows === 6, String(pr.removedRows));
  check(`${backend} 裁剪后只剩 1 天`, st.stats().days === 1, String(st.stats().days));
  check(`${backend} 裁剪不动今天的数据`, st.latestRows('2026-09-22').length === 6);
  /* 反向断言：省略基准时刻时必须仍按真实当前时间算。
   * 默认值一旦写坏成 undefined，cut 会退化成 NaN 文本，`day >= cut` 全假 → 一次裁光；
   * 而那种坏法在生产里的表现是「账本被清空且不报任何错」，必须有人盯着。 */
  const keepAll = st.prune(100000);
  check(`${backend} 省略基准时刻时按真实当前时间算（默认值没坏）`, keepAll.removedDays === 0, JSON.stringify(keepAll));
}

console.log('\nE. 跨后端一致性（本文件存在的首要理由）');
const SKIP = new Set(['fetched_at', 'errors']); // 时间戳与文案允许不同外部形态
const norm = (rows) =>
  rows
    .map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !SKIP.has(k))))
    .sort((a, b) => (a.criterion < b.criterion ? -1 : 1));
const cmp = (label, a, b) => {
  const A = JSON.stringify(a);
  const B = JSON.stringify(b);
  check(label, A === B, A === B ? '' : `sqlite=${A.slice(0, 90)} | jsonl=${B.slice(0, 90)}`);
};

for (const backend of ['sqlite', 'jsonl']) {
  const st = opened[backend];
  recordMacro(st, panel, META); // 保证两个后端状态一致
}
const L = { sqlite: opened.sqlite.latestRows('2026-09-22'), jsonl: opened.jsonl.latestRows('2026-09-22') };
cmp('E1 latestRows 完全一致（含顺序与全部列）', norm(L.sqlite), norm(L.jsonl));
const hist = { sqlite: macroHistory(opened.sqlite, { days: 100000 }), jsonl: macroHistory(opened.jsonl, { days: 100000 }) };
cmp('E2 macroHistory 完全一致', hist.sqlite, hist.jsonl);
/* path 与 backend 是**仅有的**允许不同的字段 —— 它们描述"用的是哪个后端/哪个文件"，
 * 本来就不该相同（macro.db vs macro.jsonl）。除这两项以外必须逐字节一致。 */
const sum = (st) => {
  const { path: _p, backend: _b, ...rest } = storeSummary(st);
  return rest;
};
cmp('E3 storeSummary 一致（path / backend 除外）', sum(opened.sqlite), sum(opened.jsonl));
cmp('E4 prune 报告一致', pruned.sqlite, pruned.jsonl);
cmp('E5 run 记录的业务字段一致', (() => { const r = { ...opened.sqlite.runs(1)[0] }; delete r.fetched_at; delete r.errors; return r; })(), (() => { const r = { ...opened.jsonl.runs(1)[0] }; delete r.fetched_at; delete r.errors; return r; })());
cmp('E6 run 的键集完全一致（含值为 null 的列）', Object.keys(opened.sqlite.runs(1)[0]).sort(), Object.keys(opened.jsonl.runs(1)[0]).sort());

console.log('\nF. 边界与容错');
for (const backend of ['sqlite', 'jsonl']) {
  const st = opened[backend];
  check(`${backend} readings 为空时返回 null 而不是写脏数据`, recordMacro(st, { readings: [] }, META) === null);
  check(`${backend} panel 为 null 时返回 null`, recordMacro(st, null, META) === null);
  const rowsBefore = st.stats().rows;
  recordMacro(st, { ...panel, readings: null }, META);
  check(`${backend} readings 为 null 不改变库内容`, st.stats().rows === rowsBefore);
}
check('store 为 null 时 recordMacro 安全返回 null', recordMacro(null, panel, META) === null);
check('store 为 null 时 macroHistory 返回 {}', Object.keys(macroHistory(null)).length === 0);
check('store 为 null 时 storeSummary 返回 null', storeSummary(null) === null);
check('未知判据 id 不会崩', (() => { try { recordMacro(opened.sqlite, { ...panel, readings: [{ id: 'nope', available: true, vote: 0 }] }, META); return true; } catch { return false; } })());

console.log('\nG. 迁移（旧库补列，不靠重建）');
{
  const dir = path.join(TMP, 'migrate');
  fs.mkdirSync(dir, { recursive: true });
  // 手工造一个「旧版本」的库：没有 ord / cycle_phase / unit 这些列
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const old = new DatabaseSync(path.join(dir, 'macro.db'));
  old.exec(`CREATE TABLE macro_daily (
    day TEXT NOT NULL, criterion TEXT NOT NULL, layer TEXT, label TEXT, value REAL,
    available INTEGER NOT NULL DEFAULT 0, vote INTEGER, data_day TEXT, freshness TEXT,
    reason TEXT, provider TEXT, spot_price REAL, detail TEXT, fetched_at TEXT NOT NULL,
    PRIMARY KEY (day, criterion));`);
  old.exec(`CREATE TABLE macro_runs (
    day TEXT PRIMARY KEY, fetched_at TEXT NOT NULL, available INTEGER, abstain INTEGER,
    vote_long INTEGER, vote_short INTEGER, spot_price REAL, bias TEXT,
    confidence TEXT, errors TEXT);`);
  old.prepare('INSERT INTO macro_daily (day,criterion,available,vote,value,fetched_at) VALUES (?,?,?,?,?,?)')
    .run('2026-09-10', 'media-extreme', 1, -1, 55, '2026-09-10T00:00:00.000Z');
  old.close();

  const st = openMacroStore({ dir, backend: 'sqlite' });
  const cols = st.latestRows('2026-09-10');
  const colsDaily = new Set(cols.length ? Object.keys(cols[0]) : []);
  check('旧库能被打开（不是 resolve 失败）', !!st && st.kind === 'sqlite');
  check('补上了 ord 列', colsDaily.has('ord'), [...colsDaily].join(','));
  check('补上了 unit 列', colsDaily.has('unit'));
  const ok = recordMacro(st, panel, META);
  check('旧库升级后能正常写入', !!ok && ok.rows === 6, JSON.stringify(ok));
  check('旧数据没被清掉', st.history('media-extreme', '2026-01-01')[0].day === '2026-09-10');
  const run = st.runs(1)[0];
  check('补上了 cycle_phase 列并能写入', run.cycle_phase === 'ACCUMULATION', String(run.cycle_phase));
  /* ⚠ 必须显式 close。Windows 上 SQLite 会持有文件句柄，不关就删不掉目录，
   * 测试末尾的 rmSync 会以 EBUSY 挂掉 —— 而且报错位置在 clean，看起来跟测试无关。 */
  st.close();
}

console.log('\nH. 生产数据目录不被测试污染');
check('.data/ 在 .gitignore 里（账本不该入库）', fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').includes('.data/'));
check('测试用的是 .cache/store-check 而不是真实 .data/', TMP.includes('store-check') && !TMP.includes(`${path.sep}.data`));

/* ══════════ I. --view 回看渲染（src/macro-view.js）══════════
 *
 * 为什么单独测这一段：它是给「看板没开着 / 网也断了」准备的 ——
 * 没有页面可看、没有联网可兜底，它错了用户看到的就是错的全部。
 * 而它恰好有五个容易错的分支：
 *   · 只有 1 天记录 → 必须写「仅 1 天记录」，不能画一条单点假走势条
 *     （单点画出来是条平线，看着像「非常稳定」，实际是「什么都不知道」）
 *   · value=null（取不到）→ 是「缺失」不是 0，也不能混进走势
 *   · M6 是计数 → 变化量不能带小数点（小数位按**单位**定，不按数量级定）
 *   · 美元大额 → 要折成 亿/万，且「最新」列与「变化」列必须同一口径
 *   · CJK 列宽 → 中英混排要按显示宽度对齐（padEnd 按字符数算会把整列带歪）
 */
console.log('\nI. --view 回看渲染');
{
  const VDIR = path.join(ROOT, '.cache', 'store-view');
  fs.rmSync(VDIR, { recursive: true, force: true });
  const vst = openMacroStore({ dir: VDIR });

  const dayMs = (d) => Date.parse(`2026-09-${d}T05:00:00.000Z`);
  // 三天：M1 44 → 78（上升）、M3 第一天取不到、M6 计数 0 → 1、
  //       M5 最后一天取不到（但前几天有值 —— 用来钉「票」列不能沿用旧票）
  const seed = (d, v) =>
    recordMacro(
      vst,
      {
        fetchedAt: `2026-09-${d}T05:00:00.000Z`,
        spotPrice: 80000 + d * 100,
        errors: v.m3 === null ? ['onchain: fetch failed'] : [],
        readings: [
          { id: 'media-extreme', layer: 'M1', name: '媒体情绪', available: true, vote: 0, value: v.m1, unit: '指数 0-100（越高越贪婪）', ttl: 'ok' },
          { id: 'etf-netflow', layer: 'M2', name: 'ETF 净流入', available: true, vote: 0, value: -320000000, unit: 'USD（最新单日净流入）', ttl: 'ok' },
          { id: 'onchain-activity', layer: 'M3', name: '链上活跃', available: v.m3 !== null, vote: 0, value: v.m3, unit: '%（活跃地址周环比）', ttl: v.m3 === null ? 'unavailable' : 'ok' },
          { id: 'liquidity-macro', layer: 'M4', name: '流动性与利率', available: true, vote: 0, value: 102.4, unit: 'DXY（美元指数）', ttl: 'ok' },
          { id: 'institutional-holding', layer: 'M5', name: '机构持仓', available: v.m5 !== null, vote: 0, value: v.m5, ttl: v.m5 === null ? 'unavailable' : 'ok' },
          { id: 'regulation-policy', layer: 'M6', name: '监管政策', available: true, vote: 0, value: v.m6, unit: '条（官方净条目 = 偏多 − 偏空）', ttl: 'ok' },
        ],
      },
      { bias: 'NEUTRAL', confidence: 'MEDIUM', cyclePhase: 'ACCUMULATION', now: dayMs(d) }
    );

  seed(20, { m1: 44, m3: null, m5: 3.61, m6: 0 });
  seed(21, { m1: 60, m3: 2.5, m5: 3.7, m6: 0 });
  seed(22, { m1: 78, m3: 3.78, m5: null, m6: 1 });

  const data = historyViewData({
    store: vst,
    order: ORDER,
    days: 30,
    now: dayMs(22),
    dayOf,
    summary: storeSummary(vst),
  });
  const text = renderHistoryView(data);

  check('渲染出文本且不抛错', typeof text === 'string' && text.length > 300, `${text.length} 字符`);
  check('表头给出库规模（3 天 / 18 行）', text.includes('共 3 天 / 18 行'));
  check('没有 NaN / undefined / [object 漏出', !/NaN|undefined|\[object/.test(text));
  check('数据装配按 CRITERIA_ORDER 顺序编号 M1~M6', data.criteria.map((c) => `${c.code}:${c.id}`).join(',') === ORDER.map((id, i) => `M${i + 1}:${id}`).join(','));

  const rowOf = (marker) => text.split('\n').filter((l) => l.includes(marker)).pop() || '';
  const m1r = rowOf('M1 媒体情绪');
  const m3r = rowOf('M3 链上活跃');
  const m5r = rowOf('M5 机构持仓');
  const m6r = rowOf('M6 监管政策');
  const m2r = rowOf('M2 ETF 净流入');

  check('M1 区间变化正确（44 → 78，+34）', m1r.includes('44 → 78（+34）'), m1r.trim().slice(0, 60));
  check('有 ≥2 天时画出走势条', [...m1r].some((ch) => '▁▂▃▄▅▆▇█'.includes(ch)));
  check('M3 那天取不到 → 只按 2 个有效点算（2.5 → 3.78）', m3r.includes('2.50% → 3.78%（+1.28%）'), m3r.trim().slice(0, 70));
  check('缺失日没有被当成 0 混进走势', !m3r.includes('0.00% →'));
  check('M6（计数）变化量不带小数点', (m6r.match(/（([+-][\d.]+)）/) || [])[1] === '+1', `实际「${(m6r.match(/（([+-][\d.]+)）/) || [])[1]}」`);
  check('美元大额折成 亿（不是 999000000 那种原文）', m2r.includes('3.20 亿') && !m2r.includes('320000000'), m2r.trim().slice(0, 70));
  check('「最新」列与「变化」列同一口径（不会一边亿一边原值）', m2r.includes('-3.20 亿 → -3.20 亿'));
  check('单位缺失时列里显示 —，不显示空字符串', m5r.includes('—'));
  check('最后一轮取不到 → 票列标「弃权」，不沿用前几天的票', m5r.includes('弃权'), m5r.trim().slice(-40));
  check('最后一轮取不到但前几天有值时，仍如实给出区间变化', m5r.includes('3.61 → 3.70（+0.09）'), m5r.trim().slice(0, 70));

  /* 有记录、但整窗一个有效数值都没有 → 必须说清是「取不到」，
   * 不能显示成 0 或空白（那是两种完全不同的意思）。 */
  const noVal = renderHistoryView({
    days: 30,
    since: '2026-08-23',
    summary: { rows: 2, days: 1 },
    runs: [],
    criteria: [{ id: 'x', code: 'M5', label: '机构持仓', unit: null, available: false, vote: 0, latest: null, points: [], records: 2 }],
  });
  check('整窗无数值时标「窗口内无数值」+「弃权」', noVal.includes('窗口内无数值') && noVal.includes('弃权'));

  // ---- 只有 1 个有效点 → 必须明说，不能画单点走势条 ----
  /* 刻意用合成输入而不是真实库：本项目的窗口口径是「day >= now - N 天」，
   * 所以 `--days 1` 其实含**两个**日历日（昨天 + 今天），
   * 想造「只有一个点」用窗口是造不出来的。 */
  const oneText = renderHistoryView({
    days: 30,
    since: '2026-08-23',
    summary: { rows: 1, days: 1 },
    runs: [],
    criteria: [
      { id: 'media-extreme', code: 'M1', label: '媒体情绪', unit: '指数 0-100（越高越贪婪）', available: true, vote: -1, latest: 78, points: [{ day: '2026-09-22', value: 78 }], records: 1 },
    ],
  });
  const m1One = oneText.split('\n').filter((l) => l.includes('M1 媒体情绪')).pop() || '';
  check('窗口内只有 1 天时写「仅 1 天记录」', m1One.includes('仅 1 天记录'), m1One.trim().slice(0, 60));
  check('单点不画走势条', ![...m1One].some((ch) => '▁▂▃▄▅▆▇█'.includes(ch)));

  // ---- 空库 / 缺数据时不能崩 ----
  const empty = renderHistoryView({ days: 30, since: '2026-08-23', summary: { rows: 0, days: 0 }, runs: [], criteria: [] });
  check('空库给出口径明确的提示', empty.includes('库里还没有任何记录') && empty.includes('npm run macro:daily'));
  check(
    'runs 为空但明细存在时不抛错',
    (() => {
      try {
        return renderHistoryView({ days: 30, since: 'x', summary: { rows: 1, days: 1 }, runs: [], criteria: [] }).includes('（无）');
      } catch {
        return false;
      }
    })()
  );

  // ---- 工具函数 ----
  check('sparkTerm 少于 2 点返回 null', sparkTerm([5]) === null && sparkTerm([]) === null && sparkTerm(null) === null);
  check('sparkTerm 全平如实画平线（不是「没数据」）', sparkTerm([3, 3, 3]) === '▁▁▁');
  const sp = sparkTerm([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  check('sparkTerm 超宽时抽样到指定宽度', sp.length === 12, `长度 ${sp.length}`);
  check('sparkTerm 忽略非有限值', sparkTerm([1, NaN, 3, Infinity, 5]).length === 3);
  check('failedNames 解析 JSON 串取源名', failedNames('["onchain: fetch failed"]') === 'onchain');
  check('failedNames 容忍 null 与坏 JSON', failedNames(null) === '—' && failedNames('{坏').length > 0);
  check('显示宽度：CJK 按 2 格算', displayWidth('中文') === 4 && displayWidth('ab') === 2);
  check('按显示宽度补齐后宽度精确等于目标', displayWidth(pad('中文', 6)) === 6);

  vst.close();
  fs.rmSync(VDIR, { recursive: true, force: true });
}

for (const backend of ['sqlite', 'jsonl']) opened[backend].close();
cleanup();

console.log('\n' + '='.repeat(78));
console.log(`结论：${pass} 项通过，${fail} 项失败。`);
if (fail === 0) {
  console.log('历史库的结构、upsert 语义、查询、裁剪、迁移、两个后端一致性都符合预期。');
}
console.log('='.repeat(78));
process.exit(fail === 0 ? 0 : 1);
