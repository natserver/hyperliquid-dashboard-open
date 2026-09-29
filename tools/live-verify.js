/**
 * 线上一致性确认：服务实际吐出来的前端代码，是不是修好的那一版。
 *
 * 静态文件改了但服务还在吐旧的，是这类「本地改对了、页面还是坏的」问题最常见的坑，
 * 所以每次改完前端都要走一遍这个确认。服务对静态资源回的是 no-cache，
 * 正常情况下刷新即可生效 —— 这里就是验证这一点。
 */
const BASE = process.env.BASE || 'http://127.0.0.1:8787';

const health = await (await fetch(`${BASE}/api/health`)).json();
console.log('服务:', health.service);
console.log('  只读:', health.readOnly, '| 不持密钥:', health.holdsKeys, '| 网络:', (health.networks || []).map((n) => n.key).join('/'));
console.log('  缓存条目:', JSON.stringify(health.cache));

const checks = [
  ['/app.js', ['ddView', '分母失真', 'const dec =', 'const wad =']],
  ['/charts.js', ['doubtful', '分母失真']],
  ['/styles.css', ['.doubt']],
  ['/index.html', ['data-network="testnet"']],
];

let bad = 0;
for (const [p, needles] of checks) {
  const r = await fetch(BASE + p);
  const t = await r.text();
  const miss = needles.filter((n) => !t.includes(n));
  const cc = r.headers.get('cache-control');
  console.log(`  ${p.padEnd(14)} ${r.status}  ${String(t.length).padStart(7)}B  cache-control=${cc}  ${miss.length ? '✗ 缺 ' + miss.join(', ') : '✓ 是修好的版本'}`);
  if (miss.length) bad += 1;
}

// 两个网络各打一发，确认切换没坏
for (const net of ['mainnet', 'testnet']) {
  const u = `${BASE}/api/snapshot?network=${net}&user=0x5972698398d8c5bbe67c0db74906236691020417&coin=BTC`;
  const j = await (await fetch(u)).json();
  console.log(`  ${net.padEnd(8)} ok=${j.ok} label=${j.networkLabel} equity=${j.account?.accountValue} K线=${j.candles?.BTC?.length ?? 0} 读数=${Object.keys(j.levelsByCoin || {}).length} dd=${j.equityCurve?.maxDrawdown?.pct} plausible=${j.equityCurve?.maxDrawdown?.plausible}`);
}

// 测试网那个「回撤 >100%」的账户，确认后端确实标了不可信
const big = await (await fetch(`${BASE}/api/snapshot?network=testnet&user=0xc64cc00b46101bd40aa1c3121195e85c0b0918d8&coin=BTC`)).json();
const dd = big.equityCurve?.maxDrawdown;
console.log(`\n测试网 156 仓位账户：回撤 ${(dd.pct * 100).toFixed(2)}%  plausible=${dd.plausible}`);
console.log(`  caveat: ${dd.caveat || '(无)'}`);
console.log(`  绝对金额: ${dd.drawdownAmount}`);
console.log(bad === 0 ? '\n结论：线上服务已在提供修复后的代码。' : `\n结论：有 ${bad} 个资源不是最新，需要确认服务是否需重启。`);
