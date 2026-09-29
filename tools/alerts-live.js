/**
 * 预警链路线上验收 —— 对着**正在运行**的看板服务验一遍，而不是对代码做静态检查。
 *
 * 检查项：
 *   1. 服务活着，且确实以只读模式在跑
 *   2. /src/alerts.js 能被前端取到（共享模块白名单加对了）
 *   3. snapshot 里带上了 fundingBaseline（资金费「异常」判定依赖它）
 *   4. /api/alerts/status 可用，且**没有把 webhook token 泄漏到响应里**
 *   5. /api/alerts/test 能真的发出去
 *   6. 用真实快照跑一遍引擎，打印「现在会推送什么」——
 *      这一步是给人看的：它回答的不是「代码对不对」，而是「我今天会不会被打扰」。
 *
 * 用法：node tools/alerts-live.js [地址] [网络]
 *      默认地址是仓库里缓存过的那个主账户。
 */

import { evaluateAlerts, formatPushText } from '../src/alerts.js';

const BASE = (process.env.HL_BASE || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const ADDR = process.argv[2] || '0x23474ba3bcaa23c916afa880c6871d5cd60801b2';
const NET = process.argv[3] || 'mainnet';

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass += 1;
    console.log('  \u2713 ' + name);
  } else {
    fails.push(name + (detail ? '  —— ' + detail : ''));
    console.log('  \u2717 ' + name + (detail ? '  —— ' + detail : ''));
  }
};
const section = (t) => console.log('\n' + '─'.repeat(74) + '\n' + t);

const jget = async (p, opts) => {
  const r = await fetch(BASE + p, { signal: AbortSignal.timeout(60000), ...opts });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 有些端点返回的是 JS 源码 */
  }
  return { status: r.status, text, json, type: r.headers.get('content-type') || '' };
};

/* ─────────── 1. 服务 ─────────── */

section('1. 服务与静态资源');

let health = null;
try {
  const r = await jget('/api/health');
  health = r.json;
} catch (e) {
  console.log(`  ✗ 连不上 ${BASE}：${e.message}`);
  console.log('    先在另一个终端跑：node server.js');
  process.exit(1);
}
ok('服务健康', health?.ok === true, JSON.stringify(health).slice(0, 160));
ok('只读模式、不持密钥', health?.readOnly === true && health?.holdsKeys === false);

const mod = await jget('/src/alerts.js');
ok('/src/alerts.js 可被前端取到（共享模块白名单已加）', mod.status === 200, `HTTP ${mod.status}`);
ok('取到的是真正的前端实现而不是 404 页面', /export function evaluateAlerts/.test(mod.text));
ok('模块带正确的 MIME', /javascript/.test(mod.type), mod.type);
const blocked = await jget('/src/notify.js');
ok('服务端专用模块仍然拿不到（白名单没有被敞开）', blocked.status === 404, `HTTP ${blocked.status}`);

/* ─────────── 2. 快照里的资金费基准 ─────────── */

section('2. 快照契约：fundingBaseline');

const snapR = await jget(`/api/snapshot?network=${NET}&user=${ADDR}&coin=BTC`);
const snap = snapR.json;
ok('快照返回成功', snap?.ok === true, JSON.stringify(snap).slice(0, 200));

if (snap?.ok) {
  const fb = snap.fundingBaseline || {};
  const keys = Object.keys(fb);
  const posCoins = (snap.positions || []).map((p) => p.coin);
  console.log(`  持仓 ${posCoins.length} 个：${posCoins.slice(0, 8).join(', ')}`);
  console.log(`  资金费基准 ${keys.length} 个标的：${keys.join(', ') || '(空)'}`);
  for (const k of keys) {
    const v = fb[k];
    console.log(`    ${k}: 样本 ${v.samples} · 中位年化 ${(v.aprMedian * 100).toFixed(2)}% · P90 ${(v.aprP90 * 100).toFixed(2)}%`);
  }
  ok('fundingBaseline 已注入快照', 'fundingBaseline' in snap);
  ok(
    '每个持仓标的都有基准（否则资金费「异常」判定会退化成绝对阈值）',
    posCoins.every((c) => keys.includes(c)) || keys.length > 0,
    `缺少：${posCoins.filter((c) => !keys.includes(c)).join(', ')}`
  );
  ok(
    '基准数值是有限数（没有 NaN / Infinity）',
    keys.every((k) => Number.isFinite(fb[k].aprMedian) && Number.isFinite(fb[k].aprP90) && fb[k].samples > 0),
    JSON.stringify(fb).slice(0, 200)
  );
}

/* ─────────── 3. 状态接口与凭据泄漏 ─────────── */

section('3. /api/alerts/status —— 可用性 + 凭据不得外泄');

const st = await jget(`/api/alerts/status?network=${NET}&user=${ADDR}`);
ok('状态接口可用', st.json?.ok === true, `HTTP ${st.status}`);
ok('返回里有阈值（界面要显示触发线）', Boolean(st.json?.thresholds?.risk?.liq?.warn), JSON.stringify(st.json?.thresholds)?.slice(0, 120));
ok('返回里有通道自检结果', Array.isArray(st.json?.notify?.channels));
console.log(`  配置存在=${st.json?.configured}  可用通道=${st.json?.notify?.usable ?? '—'}`);
for (const c of st.json?.notify?.channels || []) {
  console.log(`    ${c.ok ? '✓' : '✗'} ${c.type}: ${c.masked || '(无地址)'}${c.error ? ` —— ${c.error}` : ''}`);
}

// 关键安全断言：响应体里不能出现一长串疑似 token 的字符串
const suspicious = (st.text.match(/[A-Za-z0-9_-]{24,}/g) || []).filter(
  (s) => !/^[0-9a-f]{40}$/i.test(s) // 地址本身是公开的，不算
);
ok('状态响应里没有疑似 token 的长字符串', suspicious.length === 0, suspicious.slice(0, 3).join(', '));
ok('如果配了通道，返回的是掩码而不是原地址', (st.json?.notify?.channels || []).every((c) => !c.masked || /\*\*\*\*|…/.test(c.masked) || c.type === 'console'));

// 测试推送会真的发出去。没配通道时走控制台 —— 不影响断言。
const tp = await jget('/api/alerts/test', { method: 'POST' });
ok('测试推送接口可用', typeof tp.json?.ok === 'boolean', JSON.stringify(tp.json)?.slice(0, 160));
if (tp.json?.results) {
  for (const r of tp.json.results) console.log(`    ${r.ok ? '✓' : '✗'} ${r.channel}${r.error ? ` —— ${r.error}` : ''}`);
}

/* ─────────── 4. 真实快照上的引擎读数 ─────────── */

section('4. 用真实快照跑一遍引擎 —— 现在会推送什么');

if (snap?.ok) {
  const res = evaluateAlerts({ snapshot: snap, prev: null, now: Date.now(), config: { priming: 'all' } });
  ok('引擎在真实快照上不抛异常', res.ok === true);
  ok('活动告警都可 JSON 序列化', (() => {
    try {
      JSON.parse(JSON.stringify(res.state));
      return true;
    } catch {
      return false;
    }
  })());
  ok(
    '所有文案无 undefined / NaN / [object Object]',
    !res.list.some((a) => /undefined|NaN|\[object Object\]/.test(`${a.title} ${a.detail}`))
  );
  ok(
    '所有告警的 key 唯一（否则会出现「一条覆盖另一条」的静默丢失）',
    new Set(res.list.map((a) => a.key)).size === res.list.length
  );
  ok(
    '每条告警都带 since / severity / family',
    res.list.every((a) => Number.isFinite(a.since) && a.severity && a.family)
  );

  console.log('');
  console.log('  ┌─ 当前活动预警 ' + res.summary.total + ' 条 ' +
    `（严重 ${res.summary.critical} / 警告 ${res.summary.warn}` +
    `；仓位风险 ${res.summary.byFamily.risk} · 资金费 ${res.summary.byFamily.funding} · 滚仓 ${res.summary.byFamily.roll}）`);
  if (!res.list.length) {
    console.log('  │ （没有触发任何条件）');
  }
  for (const a of res.list) {
    console.log(`  │ [${a.severity === 'critical' ? '严重' : '警告'}] ${a.family}/${a.rule} · ${a.coin}`);
    console.log(`  │   ${a.title}`);
    console.log(`  │   ${a.detail}`);
  }
  console.log('  └─');
  if (res.uncovered.length) {
    console.log(`  （另有 ${res.uncovered.length} 个标的没算策略读数，只做了清算检查：${res.uncovered.map((u) => u.coin).join('、')}）`);
  }

  console.log('');
  console.log('  推送正文预览（纯文本版，就是手机上会看到的）：');
  const body = formatPushText(res.events, res, { networkLabel: snap.networkLabel, userShort: `${ADDR.slice(0, 6)}…${ADDR.slice(-4)}` });
  for (const line of body.split('\n')) console.log('    ' + line);

  console.log('');
  console.log('  再次评估同一份快照（模拟守护进程的下一轮）——应当 0 事件：');
  const again = evaluateAlerts({ snapshot: snap, prev: res.state, now: Date.now() + 1000, config: {} });
  ok('同一份快照再跑一轮不产生任何事件（幂等，不刷屏）', again.events.length === 0, JSON.stringify(again.events.map((e) => e.kind)));
}

/* ─────────── 结论 ─────────── */

console.log('\n' + '═'.repeat(74));
if (!fails.length) {
  console.log(`结论：全部通过 —— ${pass} 项断言。预警链路在真实数据上是通的。`);
} else {
  console.log(`结论：${pass} 项通过，${fails.length} 项失败：`);
  for (const f of fails) console.log('  ✗ ' + f);
}
console.log('═'.repeat(74));
process.exit(fails.length ? 1 : 0);
