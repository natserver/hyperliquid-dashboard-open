/**
 * 侦察 v2：确定 userFillsByTime 的真实语义与可回溯深度。
 *
 * v1 的发现：传一年的窗口，返回的是区间内**最早**的 2000 笔（而不是最新），
 * 所以「往前翻页」（endTime = 本页最早 - 1）方向错了，才会立刻拿到 0 条。
 *
 * v2 要回答：
 *   A. 改成向前翻页（startTime = 本页最晚 + 1）能不能持续走？
 *   B. 走多少页会撞到天花板？天花板是按【笔数】还是按【时间】算的？
 *   C. 指定一段明确的历史窗口，还能不能取到？
 *
 * B 的答案决定了「一年真实成交」对这个账户是否可行：
 *   - 如果是按笔数封顶（最近 N 笔），那么低频账户一年完全可行，
 *     高频账户只能取到很短的窗口。
 */

import { info, normalizeAddress } from '../src/hl.js';

const NET = process.argv[2] || 'mainnet';
const ADDR = normalizeAddress(process.argv[3] || '0x010461c14e146ac35fe42271bdc1134ee31c703a');
const DAY = 86400000;
const ts = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 19);
const daysAgo = (t, now) => ((now - t) / DAY).toFixed(3);

async function q(body) {
  return info(NET, body, { noCache: true, ttl: 0, timeout: 30000 });
}

(async () => {
  const now = Date.now();
  console.log('='.repeat(80));
  console.log('侦察 v2 · 向前翻页与历史窗口可达性   网络=' + NET);
  console.log('地址 ' + ADDR);
  console.log('='.repeat(80));

  /* ── A. 向前翻页 ── */
  console.log('\n[A] 向前翻页（startTime = 本页最晚 + 1）');
  const seen = new Set();
  let cursor = 0;
  let pages = 0;
  let newest = 0;
  let oldest = now;
  const MAX_PAGES = 30;

  while (pages < MAX_PAGES) {
    const batch = await q({ type: 'userFillsByTime', user: ADDR, startTime: cursor, endTime: now });
    pages += 1;
    if (!Array.isArray(batch) || batch.length === 0) {
      console.log(`  第 ${String(pages).padStart(2)} 页 → 0 条，终止`);
      break;
    }
    let added = 0;
    let hi = 0;
    let lo = Infinity;
    for (const f of batch) {
      const k = f.tid ?? `${f.hash}:${f.oid}:${f.time}`;
      if (!seen.has(k)) { seen.add(k); added += 1; }
      if (f.time > hi) hi = f.time;
      if (f.time < lo) lo = f.time;
    }
    newest = Math.max(newest, hi);
    oldest = Math.min(oldest, lo);
    const full = batch.length >= 2000;
    console.log(
      `  第 ${String(pages).padStart(2)} 页 → ${String(batch.length).padStart(4)} 条（新增 ${String(added).padStart(4)}）` +
      `  ${ts(lo)} ~ ${ts(hi)}  最早 ${daysAgo(lo, now)} 天前  ${full ? '【满页】' : '【未满】'}`
    );
    if (!full) break;
    if (hi < cursor) { console.log('  游标未推进，终止（防死循环）'); break; }
    cursor = hi + 1;
  }

  console.log(`\n  累计去重 ${seen.size} 笔，翻页 ${pages} 次`);
  console.log(`  触及区间 ${ts(oldest)} ~ ${ts(newest)}`);
  console.log(`  向前翻页是否有效：${newest > oldest && pages > 1 ? '是' : '否/受限'}`);

  /* ── B. 明确的历史窗口测试 ── */
  console.log('\n[B] 指定历史窗口，看还能不能取到');
  const windows = [
    ['最近 1 小时', 1 / 24],
    ['1 天前~现在', 1],
    ['7 天前~现在', 7],
    ['30 天前~现在', 30],
    ['90 天前~现在', 90],
    ['180 天前~现在', 180],
    ['365 天前~现在', 365],
  ];
  for (const [label, d] of windows) {
    try {
      const r = await q({ type: 'userFillsByTime', user: ADDR, startTime: now - d * DAY, endTime: now });
      const n = Array.isArray(r) ? r.length : -1;
      let span = '';
      if (n > 0) {
        const t = r.map((f) => f.time);
        span = `  实际 ${ts(Math.min(...t))} ~ ${ts(Math.max(...t))}`;
      }
      console.log(`  ${label.padEnd(16)} → ${String(n).padStart(4)} 条${span}`);
    } catch (e) {
      console.log(`  ${label.padEnd(16)} → 失败: ${e.message}`);
    }
  }

  /* ── C. 单独一段旧的窄窗口（排除「与 now 相连」的干扰）── */
  console.log('\n[C] 独占的旧窗口（不与 now 相连）');
  for (const [label, from, to] of [
    ['30~29 天前', 30, 29],
    ['90~89 天前', 90, 89],
    ['200~199 天前', 200, 199],
    ['360~359 天前', 360, 359],
  ]) {
    try {
      const r = await q({
        type: 'userFillsByTime',
        user: ADDR,
        startTime: now - from * DAY,
        endTime: now - to * DAY,
      });
      const n = Array.isArray(r) ? r.length : -1;
      console.log(`  ${label.padEnd(16)} → ${String(n).padStart(4)} 条`);
    } catch (e) {
      console.log(`  ${label.padEnd(16)} → 失败: ${e.message}`);
    }
  }

  /* ── D. 对照：funding 与 ledger 的可回溯深度 ── */
  console.log('\n[D] 资金费与出入金账本的可回溯深度（对照）');
  for (const [label, type] of [['userFunding', 'userFunding'], ['ledger', 'userNonFundingLedgerUpdates']]) {
    for (const d of [30, 365]) {
      try {
        const r = await q({ type, user: ADDR, startTime: now - d * DAY });
        const n = Array.isArray(r) ? r.length : -1;
        let span = '';
        if (n > 0) {
          const t = r.map((x) => x.time);
          span = `  ${ts(Math.min(...t))} ~ ${ts(Math.max(...t))}`;
        }
        console.log(`  ${label} ${String(d).padStart(3)} 天 → ${String(n).padStart(5)} 条${span}`);
      } catch (e) {
        console.log(`  ${label} ${String(d).padStart(3)} 天 → 失败: ${e.message}`);
      }
    }
  }

  console.log('\n' + '='.repeat(80));
})().catch((e) => {
  console.error('侦察失败:', e);
  process.exit(1);
});
