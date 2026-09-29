/**
 * 测试网连通性探测
 * 直接打 testnet 官方 API（不经本服务代理），逐类型确认可达性与响应形态。
 */
const NET = 'testnet';
const BASE = `https://api.hyperliquid-${NET}.xyz/info`;
const A = process.env.USER_ADDR || '0x010461c14e146ac35fe42271bdc1134ee31c703a';

const TYPES = [
  { type: 'meta' },
  { type: 'metaAndAssetCtxs' },
  { type: 'allMids' },
  { type: 'clearinghouseState', user: A },
  { type: 'spotClearinghouseState', user: A },
  { type: 'openOrders', user: A },
  { type: 'frontendOpenOrders', user: A },
  { type: 'userFills', user: A },
  { type: 'portfolio', user: A },
  { type: 'userFunding', user: A, startTime: Date.now() - 30 * 86400000 },
  { type: 'userNonFundingLedgerUpdates', user: A, startTime: Date.now() - 30 * 86400000 },
  { type: 'userFees', user: A },
  { type: 'userRole', user: A },
  { type: 'userRateLimit', user: A },
  { type: 'l2Book', coin: 'BTC' },
  { type: 'fundingHistory', coin: 'BTC', startTime: Date.now() - 7 * 86400000 },
  { type: 'candleSnapshot', req: { coin: 'BTC', interval: '4h', startTime: Date.now() - 10 * 14400000, endTime: Date.now() } },
];

const shape = (v) => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array[${v.length}]`;
  if (typeof v === 'object') return `object{${Object.keys(v).slice(0, 8).join(',')}}`;
  return typeof v + ' ' + JSON.stringify(v).slice(0, 60);
};

console.log(`测试网连通性探测  ${BASE}`);
console.log(`地址 ${A}\n`);

for (const q of TYPES) {
  const t0 = Date.now();
  try {
    const r = await fetch(BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(q),
      signal: AbortSignal.timeout(20000),
    });
    const ms = Date.now() - t0;
    const txt = await r.text();
    let j;
    try { j = JSON.parse(txt); } catch { j = txt; }
    console.log(`✓ ${String(q.type).padEnd(32)} HTTP ${r.status} ${String(ms).padStart(5)}ms  ${shape(j)}`);
    if (r.status !== 200) console.log(`    ✗ 响应体 ${txt.slice(0, 200)}`);
  } catch (e) {
    console.log(`✗ ${String(q.type).padEnd(32)} 失败：${e.message}`);
  }
}
