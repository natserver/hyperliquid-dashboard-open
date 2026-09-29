#!/usr/bin/env node
/**
 * 每日全量采集：把「比特皇今天看到的全部参数」抓一份存档。
 *
 * ── 已经有的每天采集 ──────────────────────────────────────
 *   tools/macro-daily.js   → M1~M6 六个外部条件 → .data/macro.db
 *   tools/events-daily.js  → 黑天鹅 / 减半 / 美联储 → .data/events-auto.json
 * 那两个抓的是**外部世界**。缺的是 Hyperliquid 这一侧：K 线、资金费、市场、
 * 持仓、止损与滚仓点位、三阶段结论、活动预警 —— 这些原本只有「有人打开页面」
 * 才会现拉一次，没人看就一直是冷的、旧的。
 *
 * ── 所以这个脚本做什么 ────────────────────────────────────
 *   ① 拉一次完整快照（顺带给服务端缓存预热，之后打开页面秒开）
 *   ② 跑一遍预警引擎，把「此刻有哪些活动预警」一起存进去
 *   ③ 剥掉可重新拉的大块（K 线、挂单、成交、资金费序列、全市场行情）
 *   ④ 写 .data/snapshot-daily/YYYY-MM-DD.json，并保留最近 N 天
 *
 * 存的是**决策依据与结论**，不是原始数据：方向层全部读数与理由、六项读数、
 * 三阶段卡在哪、每个持仓的入场/浮盈/清算、止损与滚仓点位、离场信号、活动预警。
 * 这些重新拉不出来 —— 它们是「那一刻的判断」。
 *
 * 用法：
 *   node tools/snapshot-daily.js              采集 + 落档（默认保留 3 天）
 *   node tools/snapshot-daily.js --keep 10    保留最近 10 天
 *   node tools/snapshot-daily.js --view       看最新一份的摘要
 *   node tools/snapshot-daily.js --view 2026-09-28
 *   node tools/snapshot-daily.js --dry-run    采集并打印摘要，不写文件
 *   node tools/snapshot-daily.js --quiet      只输出一行结论
 *
 * 环境变量：HL_BASE（服务端地址，默认 127.0.0.1:8787）/ HL_USER / HL_COIN
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '../src/macro-store.js';
import { evaluateAlerts } from '../src/alerts.js';
import { loadAlertConfig, loadState } from '../src/alertstore.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, '..');
const OUT_DIR = path.join(DATA_DIR, 'snapshot-daily');
const LATEST = path.join(OUT_DIR, 'latest.json');

const BASE = process.env.HL_BASE || 'http://127.0.0.1:8787';
const ZERO = '0x0000000000000000000000000000000000000000';
const USER = process.env.HL_USER || ZERO;
const COIN = process.env.HL_COIN || 'BTC';
const DEFAULT_KEEP = 3;

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const opt = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('-') ? args[i + 1] : d;
};
const QUIET = has('--quiet');
const log = (...a) => {
  if (!QUIET) console.log(...a);
};

/* ────────────────────────── 取数 ────────────────────────── */

async function getSnapshot() {
  const url = `${BASE}/api/snapshot?network=mainnet&user=${encodeURIComponent(USER)}&coin=${encodeURIComponent(COIN)}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 300000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const s = await r.json();
    if (!s || s.ok === false) throw new Error(s?.error || 'snapshot ok=false');
    return s;
  } finally {
    clearTimeout(timer);
  }
}

/** 活动预警只读不写：写状态是 watch.js 的活，两边抢一个文件会互相吞事件 */
async function getAlerts(snapshot) {
  try {
    const cfg = await loadAlertConfig();
    const prev = await loadState('mainnet', USER);
    const res = evaluateAlerts({ snapshot, prev, config: cfg });
    return {
      total: res.summary?.total ?? 0,
      critical: res.summary?.critical ?? 0,
      warn: res.summary?.warn ?? 0,
      byFamily: res.summary?.byFamily ?? {},
      list: Object.values(res.active || {}).map((a) => ({
        severity: a.severity,
        family: a.family,
        rule: a.rule,
        coin: a.coin,
        title: a.title,
      })),
      engineOk: Boolean(res.ok) && !res.disabled,
    };
  } catch (e) {
    return { total: 0, critical: 0, warn: 0, byFamily: {}, list: [], engineOk: false, error: String(e.message || e) };
  }
}

/* ────────────────────── 瘦身：剥掉可重新拉的 ────────────────────── */

/**
 * 不存的两类：
 *   ① 重新拉一次就有的 —— K 线、挂单、成交、入金、资金费序列、全市场行情。
 *      它们占了快照的三分之一，而且每天抓一次的存档里放逐笔成交没有意义。
 *   ② 重复的副本 —— `positions[i].levels` 与 `levelsByCoin[coin]` 是**同一个东西**
 *      （6 个持仓各背一份，207 KB），`levelsByCoin[coin].regime` 是顶层 `regime`
 *      的完整拷贝（6 份共 143 KB）。顶层各留一份就够，重复的剥掉不丢任何信息。
 *   ③ 一次性诊断字段 —— timings / warnings / candleErrors，是当次请求的体检。
 *
 * 留下的全部是「那一刻的判断」：方向、读数、结论、点位、预警。
 */
const DROP = new Set([
  'candles', // 105 KB · 可随时重拉
  'orders', // 29 KB · 挂单明细
  'trades', // 1.2 KB
  'deposits', // 0.7 KB
  'funding', // 27.5 KB · 200 根资金费序列，页面上现拉
  'markets', // 34 KB · 177 个币的行情，只要 focusCoin 的现价（另存）
  'timings',
  'warnings',
  'candleErrors',
  'network',
  'networkLabel',
  'ok',
]);

/** levelsByCoin 里真正值钱的是点位与结论，不是中间计算量，也不是重复的副本 */
const LEVEL_DROP = new Set(['bands', 'trigger', 'trend', 'regime']); // regime = 顶层那份的拷贝

function slim(snapshot) {
  const out = {};
  for (const [k, v] of Object.entries(snapshot)) {
    if (DROP.has(k)) continue;
    out[k] = v;
  }

  // 每个重点币：剥掉 bands/trigger/trend 这些中间量与重复的 regime 副本，
  // 留 stop / roll / exit / gate / risk / takeProfit
  if (out.levelsByCoin && typeof out.levelsByCoin === 'object') {
    const lv = {};
    for (const [coin, L] of Object.entries(out.levelsByCoin)) {
      if (!L || typeof L !== 'object') {
        lv[coin] = L;
        continue;
      }
      const s = {};
      for (const [k, v] of Object.entries(L)) {
        if (LEVEL_DROP.has(k)) continue;
        s[k] = v;
      }
      lv[coin] = s;
    }
    out.levelsByCoin = lv;
  }

  // positions[i].levels 就是 levelsByCoin[coin] 那一份（只有重点币带，各 34 KB）。
  // 顶层留了同一份，持仓里这份纯属重复 —— 177 个持仓背着 6 份，207 KB
  if (Array.isArray(out.positions)) {
    out.positions = out.positions.map(({ levels, ...rest }) => rest);
  }

  // 现价单独留一份（markets 整块被剥了，但总结与回看都要知道当时价）
  const mc = snapshot.focusCoin || COIN;
  out.markPrice = snapshot.markets?.[mc]?.markPx ?? null;
  out.markets = snapshot.markets
    ? { [mc]: snapshot.markets[mc] }
    : null;

  out.user = snapshot.user ?? USER;
  out.fetchedAt = snapshot.fetchedAt ?? Date.now();
  return out;
}

/* ────────────────────────── 落档 ────────────────────────── */

function dayOf(ts = Date.now()) {
  // 用北京时间归档：账户与推送都按北京时间看，用 UTC 会在早上 8 点前归错天
  return new Date(ts + 8 * 3600000).toISOString().slice(0, 10);
}

function prune(keep) {
  let removed = 0;
  try {
    const files = fs
      .readdirSync(OUT_DIR)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort(); // YYYY-MM-DD 字典序 = 时间序
    while (files.length > keep) {
      fs.unlinkSync(path.join(OUT_DIR, files.shift()));
      removed++;
    }
  } catch {
    /* 目录读不了就不裁剪，不因为清理失败而让整轮采集失败 */
  }
  return removed;
}

async function view(which) {
  const file = which && /^\d{4}-\d{2}-\d{2}$/.test(which) ? path.join(OUT_DIR, `${which}.json`) : LATEST;
  if (!fs.existsSync(file)) {
    console.error(`没有档案：${path.relative(ROOT, file)}（先跑一次采集）`);
    process.exit(1);
  }
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const s = j.snapshot || {};
  const r = s.regime || {};
  // 容器里是 UTC，采集时间按北京时间显示才跟归档日期对得上
  const at = new Date(j.at + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
  console.log(`档案 ${j.date} · 采集 ${at}（北京时间）`);
  console.log(`  地址     ${j.user === ZERO ? '（未配置）' : j.user}`);
  console.log(`  方向     ${r.biasLabel || '—'} · ${r.confidence || '—'} · ${r.intentLabel || '—'}`);
  console.log(`  相位     ${r.clock?.label || '—'}`);
  console.log(`  结论     ${s.pipeline?.headline || '—'}`);
  console.log(`  读数     ${(s.macro?.readings || []).map((x) => `${x.layer}:${x.available === false ? '缺' : x.vote > 0 ? '多' : x.vote < 0 ? '空' : '弃'}`).join(' ')}`);
  console.log(`  持仓     ${(s.positions || []).length} 个 · 现价 ${s.markPrice ?? '—'}`);
  console.log(`  预警     ${j.alerts?.total ?? 0} 条（严重 ${j.alerts?.critical ?? 0} / 警告 ${j.alerts?.warn ?? 0}）`);
  console.log(`  体积     ${Math.round(fs.statSync(file).size / 102.4) / 10} KB`);
}

async function main() {
  const keep = Number(opt('--keep', DEFAULT_KEEP)) || DEFAULT_KEEP;

  if (has('--view')) return view(opt('--view', null));

  log(`拉取完整快照 ${BASE} …`);
  const raw = await getSnapshot();
  const rawKb = Math.round(Buffer.byteLength(JSON.stringify(raw)) / 102.4) / 10;
  const slimmed = slim(raw);
  const alerts = await getAlerts(raw);
  const day = dayOf();
  const rec = {
    version: 1,
    date: day,
    at: Date.now(),
    user: USER,
    coin: COIN,
    focusCoin: raw.focusCoin || COIN,
    alerts,
    snapshot: slimmed,
  };

  const text = JSON.stringify(rec);
  const kb = Math.round(Buffer.byteLength(text) / 102.4) / 10;
  const r = slimmed.regime || {};
  const summary =
    `方向 ${r.bias || '—'} · 持仓 ${(slimmed.positions || []).length} · ` +
    `预警 ${alerts.total} · ${kb} KB`;

  if (has('--dry-run')) {
    console.log(`\nDRY-RUN（未写档）：${day} · ${summary}`);
    console.log(`  体积构成：原始 ${rawKb} KB → 剥离后 ${kb} KB（K线/挂单/成交/资金费序列/全市场行情不存）`);
    console.log(`  方向理由 ${(r.reasons || []).length} 条 · 读数 ${(slimmed.macro?.readings || []).length} 条 · ` +
      `重点币 ${Object.keys(slimmed.levelsByCoin || {}).length} 个`);
    return true;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `${day}.json`), text);
  fs.writeFileSync(LATEST, text);
  const removed = prune(keep);
  log(`✔ ${day} 已落档 ${kb} KB · ${summary}${removed ? ` · 清掉 ${removed} 份超期旧档（只留最近 ${keep} 天）` : ''}`);
  console.log(`[snapshot] ${day} · ${summary}`);
  return true;
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`[snapshot-daily] 本轮失败：${e.message}`);
    process.exit(1); // 交 entrypoint 打一行错误，下一轮继续 —— 部分源挂掉不等于这一轮白跑
  }
);
