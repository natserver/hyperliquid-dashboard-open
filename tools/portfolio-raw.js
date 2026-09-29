const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const A = process.env.USER_ADDR || '0x010461c14e146ac35fe42271bdc1134ee31c703a';

// 直接取后端代理的原始 portfolio 响应（不经我们的 parseWad）
const raw = await (
  await fetch(`${BASE}/api/proxy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ network: 'mainnet', body: { type: 'portfolio', user: A } }),
  })
).json();

const arr = raw?.data ?? raw;
if (!Array.isArray(arr)) { console.log('原始响应形态异常:', JSON.stringify(raw).slice(0, 300)); process.exit(0); }

const d = new Map(arr.map(([p, x]) => [p, x]));
for (const name of ['day', 'perpDay', 'perpAllTime']) {
  const h = d.get(name)?.accountValueHistory;
  if (!h) { console.log(`${name}: 无 accountValueHistory`); continue; }
  console.log(`\n=== ${name}  n=${h.length}  原始前 5 条 ===`);
  for (const [t, v] of h.slice(0, 5)) console.log(`   t=${new Date(t).toISOString()}  raw=${JSON.stringify(v)}`);
  console.log(`   ... 后 3 条 ===`);
  for (const [t, v] of h.slice(-3)) console.log(`   t=${new Date(t).toISOString()}  raw=${JSON.stringify(v)}`);
}
