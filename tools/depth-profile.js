/**
 * 标定：成交历史的可回溯深度，到底是按【笔数】封顶还是按【时间】封顶？
 *
 * 为什么必须搞清这件事：
 *   用户要「跑一年真实成交」。如果截断是按时间（比如只保留最近 2 小时），
 *   那对任何人都拿不到一年，方案得整个换掉；
 *   如果是按笔数（比如只保留最近 N 笔），那么低频账户一年完全可行，
 *   高频账户就只能拿到很短的窗口 —— 这两种情况的结论天差地别。
 *
 * 方法：从官方排行榜取不同成交量的真实地址，逐个向前翻页找到「最早可得成交」，
 * 再看它与成交量/成交笔数的关系。
 */

const NET = process.argv[2] || 'mainnet';
const INFO = NET === 'testnet'
  ? 'https://api.hyperliquid-testnet.xyz/info'
  : 'https://api.hyperliquid.xyz/info';
const LW = NET === 'testnet' ? 'Testnet' : 'Mainnet';
const DAY = 86400000;
const ts = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 19);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function info(body, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(INFO, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
      if (r.status === 429) { await sleep(1500 * (i + 1)); continue; }
      const t = await r.text();
      const j = JSON.parse(t);
      if (j && !Array.isArray(j) && typeof j.error === 'string') throw new Error(j.error);
      return j;
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(800 * (i + 1));
    }
  }
}

/** 向前翻页，找到最早可得的成交，返回 { fills, oldest, newest, pages, exhausted } */
async function depth(addr, maxPages = 8) {
  const seen = new Set();
  let cursor = 0;
  let pages = 0;
  let oldest = Infinity;
  let newest = 0;
  let exhausted = false;

  while (pages < maxPages) {
    const batch = await info(
      { type: 'userFillsByTime', user: addr, startTime: cursor, endTime: Date.now() },
      2
    );
    if (!Array.isArray(batch) || batch.length === 0) { exhausted = true; break; }
    pages += 1;
    let hi = 0;
    for (const f of batch) {
      const k = f.tid ?? `${f.hash}:${f.oid}:${f.time}`;
      seen.add(k);
      if (f.time > hi) hi = f.time;
      if (f.time < oldest) oldest = f.time;
    }
    if (hi > newest) newest = hi;
    if (batch.length < 2000) { exhausted = true; break; }
    if (hi < cursor) break;
    cursor = hi + 1;
    await sleep(80);
  }
  return { fills: seen.size, oldest, newest, pages, exhausted };
}

(async () => {
  const now = Date.now();
  console.log('='.repeat(96));
  console.log('成交历史可回溯深度标定   网络=' + NET);
  console.log('='.repeat(96));

  console.log('\n[1] 拉取官方排行榜，取不同成交量的真实地址');
  let lb = null;
  const urls = [
    `https://stats-data.hyperliquid.xyz/${LW}/leaderboard`,
    `https://stats-data.hyperliquid.xyz/${LW}/leaderboard?t=day`,
  ];
  for (const u of urls) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(45000) });
      const j = await r.json();
      const rows = j?.leaderboardRows || j?.rows || (Array.isArray(j) ? j : null);
      if (rows?.length) { lb = rows; console.log(`  ✓ ${u.split('/').pop()} → ${rows.length} 行`); break; }
    } catch (e) {
      console.log(`  ✗ ${u} → ${e.message}`);
    }
  }
  if (!lb) {
    console.log('  排行榜不可用，改为只测已知地址');
  }

  /* 从排行榜里按「30 天成交量」分档抽样 */
  const samples = [];
  if (lb) {
    const parsed = lb
      .map((r) => ({
        addr: (r.ethAddress || r.address || '').toLowerCase(),
        av: Number(r.accountValue ?? r.account_value ?? 0),
        vlm: Number(r.dayVlm ?? r.day_vlm ?? r.vlm ?? 0),
      }))
      .filter((r) => /^0x[0-9a-f]{40}$/.test(r.addr))
      .sort((a, b) => b.vlm - a.vlm);

    const n = parsed.length;
    const pick = (frac, label) => {
      const r = parsed[Math.floor(n * frac) - 1] || parsed[Math.floor(n * frac)];
      if (r) samples.push({ ...r, tier: label });
    };
    pick(0.02, '高成交·前2%');
    pick(0.10, '前10%');
    pick(0.30, '前30%');
    pick(0.50, '中位');
    pick(0.70, '后30%');
    pick(0.90, '低成交·后10%');
    pick(0.98, '极低·后2%');
  }
  samples.push({ addr: '0x010461c14e146ac35fe42271bdc1134ee31c703a', vlm: NaN, tier: 'HLP 做市(参照)' });

  console.log(`\n[2] 逐个向前翻页，定位最早可得成交（每地址最多 8 页 = 16000 笔）\n`);
  console.log(
    '  ' + '档位'.padEnd(18) + '日成交量'.padStart(14) + '可得笔数'.padStart(10) +
    '最早可得'.padStart(21) + '可回溯'.padStart(11) + ' 页'
  );
  console.log('  ' + '-'.repeat(92));

  const results = [];
  for (const s of samples) {
    try {
      const d = await depth(s.addr);
      const days = d.oldest === Infinity ? 0 : (now - d.oldest) / DAY;
      results.push({ ...s, ...d, days });
      console.log(
        '  ' +
        s.tier.padEnd(18) +
        (Number.isFinite(s.vlm) ? s.vlm.toExponential(2) : '—').padStart(14) +
        String(d.fills).padStart(10) +
        (d.oldest === Infinity ? '无成交' : ts(d.oldest)).padStart(21) +
        `${days.toFixed(3)}天`.padStart(11) +
        String(d.pages).padStart(4)
      );
    } catch (e) {
      console.log('  ' + s.tier.padEnd(18) + '  查询失败: ' + e.message.slice(0, 60));
    }
    await sleep(150);
  }

  console.log('\n[3] 结论');
  const usable = results.filter((r) => r.oldest !== Infinity);
  if (usable.length >= 2) {
    const byDays = [...usable].sort((a, b) => b.days - a.days);
    const deepest = byDays[0];
    const shallowest = byDays[byDays.length - 1];
    console.log(`  可回溯最深的样本：${deepest.tier}  → ${deepest.days.toFixed(2)} 天，${deepest.fills} 笔`);
    console.log(`  可回溯最浅的样本：${shallowest.tier}  → ${shallowest.days.toFixed(3)} 天，${shallowest.fills} 笔`);
    console.log(
      `  深度与成交量的相关性：${deepest.vlm < shallowest.vlm ? '成交量越大 → 可回溯越浅（支持「按笔数封顶」）' : '不单调'}`
    );
    const capped = usable.filter((r) => r.pages >= 8 && !r.exhausted);
    console.log(`  撞到翻页上限仍未取尽的地址数：${capped} / ${usable.length}`);
  }
  console.log('\n  说明：若各档位的「可得笔数」都量级相近（而不是时间跨度相近），');
  console.log('        则截断是按笔数封顶 —— 低频账户因此能拿回更长的历史。');
  console.log('='.repeat(96));
})().catch((e) => {
  console.error('标定失败:', e);
  process.exit(1);
});
