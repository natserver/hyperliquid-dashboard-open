/**
 * 从测试网公开的 trades 推送里捞活跃账户地址。
 *
 * 为什么不猜地址：测试网的活跃账户无法枚举（info 接口都是 per-user 的），
 * 而 WS 的 trades 频道是公开广播，每条成交都带 users[]（taker/maker）。
 * 这是唯一能可靠拿到「真实有仓位、有成交」的测试网地址的公开途径。
 *
 * 用法：node tools/testnet-find-account.js [监听秒数]
 */
const SECONDS = Number(process.argv[2] || 25);
const WS_URL = 'wss://api.hyperliquid-testnet.xyz/ws';
const INFO = 'https://api.hyperliquid-testnet.xyz/info';

const coins = ['BTC', 'ETH', 'SOL', 'HYPE', 'DOGE', 'XRP', 'SUI', 'AVAX', 'LINK', 'ARB'];
const counts = new Map();

console.log(`监听测试网 trades ${SECONDS}s（订阅 ${coins.length} 个标的）…`);

const ws = new WebSocket(WS_URL);

await new Promise((resolve) => {
  ws.onopen = () => {
    for (const coin of coins) {
      ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin } }));
    }
  };
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.channel !== 'trades' || !Array.isArray(m.data)) return;
    for (const t of m.data) {
      for (const u of t.users || []) {
        if (typeof u === 'string' && /^0x[0-9a-fA-F]{40}$/.test(u)) {
          counts.set(u.toLowerCase(), (counts.get(u.toLowerCase()) || 0) + 1);
        }
      }
    }
  };
  ws.onerror = (e) => console.log('WS 错误：' + (e.message || e.type));
  setTimeout(() => { try { ws.close(); } catch {} resolve(); }, SECONDS * 1000);
});

console.log(`\n收到 ${counts.size} 个唯一地址，共 ${[...counts.values()].reduce((a, b) => a + b, 0)} 次出现`);
const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);

/** 查这个地址在测试网上有没有真实仓位/成交 */
async function probe(addr) {
  const post = (body) => fetch(INFO, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  }).then((r) => r.json());

  const [st, fills] = await Promise.all([
    post({ type: 'clearinghouseState', user: addr }).catch(() => null),
    post({ type: 'userFills', user: addr }).catch(() => null),
  ]);
  const positions = st?.assetPositions?.length ?? 0;
  const equity = Number(st?.marginSummary?.accountValue ?? 0);
  const nFills = Array.isArray(fills) ? fills.length : 0;
  const coinsHeld = (st?.assetPositions || []).map((p) => p.position?.coin).filter(Boolean);
  return { positions, equity, nFills, coinsHeld };
}

console.log('\n候选地址（按成交频次）:');
const good = [];
for (const [addr, n] of ranked) {
  const r = await probe(addr);
  console.log(
    `  ${addr}  出现 ${String(n).padStart(3)} 次  仓位 ${String(r.positions).padStart(2)}  权益 $${r.equity.toFixed(2).padStart(12)}  成交 ${String(r.nFills).padStart(4)}  ${r.coinsHeld.slice(0, 6).join(',')}`
  );
  if (r.positions > 0 && r.nFills > 0) good.push({ addr, ...r });
}

console.log('\n可用于完整走查的地址（有仓位 + 有成交）:');
for (const g of good) {
  console.log(`  ★ ${g.addr}  仓位 ${g.positions}  权益 $${g.equity.toFixed(2)}  成交 ${g.nFills}  ${g.coinsHeld.slice(0, 8).join(',')}`);
}
if (!good.length) console.log('  （本次监听窗口内没有捕到，可加大监听秒数）');
