const BASE = 'http://127.0.0.1:8787';
const CASES = [
  ['正常散户 2 仓', '0x5972698398d8c5bbe67c0db74906236691020417'],
  ['大账户 156 仓', '0xc64cc00b46101bd40aa1c3121195e85c0b0918d8'],
  ['零售多标的 6 仓', '0x882b29d0831a6a565e7d9ec4c3621b3e843538e4'],
  ['空账户', '0x010461c14e146ac35fe42271bdc1134ee31c703a'],
];

for (const [name, addr] of CASES) {
  const t0 = Date.now();
  let j, status;
  try {
    const r = await fetch(`${BASE}/api/snapshot?network=testnet&user=${addr}&coin=BTC&phase=ACCUMULATION`, {
      signal: AbortSignal.timeout(90000),
    });
    status = r.status;
    j = await r.json();
  } catch (e) {
    console.log(`✗ ${name}  请求失败 ${e.message}`);
    continue;
  }
  const ms = Date.now() - t0;
  if (!j.ok) { console.log(`✗ ${name}  HTTP ${status}  ${ms}ms  error=${j.error}`); continue; }

  const pos = j.positions || [];
  const withLevels = pos.filter((p) => p.levels);
  const cdl = j.candles || {};
  const coinKs = Object.keys(cdl);
  const focus = j.focusCoin;

  console.log(`✓ ${name}  HTTP ${status}  ${ms}ms`);
  console.log(`   network=${j.network}  label=${j.networkLabel}  equity=${j.account?.accountValue}`);
  console.log(`   仓位 ${pos.length} 个 · 带策略读数 ${withLevels.length} 个 · 成交 ${(j.trades || []).length} · 挂单 ${(j.orders || []).length} · 资金费 ${(j.funding || []).length}`);
  console.log(`   markets=${Object.keys(j.markets || {}).join(',') || '(空)'}`);
  console.log(`   candles 键=${coinKs.join(',') || '(空)'}  BTC根数=${cdl.BTC?.length ?? 0}  candleErrors=${JSON.stringify(j.candleErrors || {})}`);
  console.log(`   levelsByCoin=${Object.keys(j.levelsByCoin || {}).join(',') || '(空)'}  levelCoins=${(j.levelCoins || []).join(',') || '(空)'}  focus=${focus}`);
  console.log(`   权益曲线周期=${Object.keys(j.equityCurvesByPeriod || {}).length}  warnings=${(j.warnings || []).length}`);
  for (const w of j.warnings || []) console.log(`     ⚠ ${w}`);

  if (withLevels.length) {
    const l = withLevels[0];
    console.log(`   读数样本 ${l.coin}: mark=${l.mark}  布林中轨=${l.bands?.mid}  upper=${l.bands?.upper}  lower=${l.bands?.lower}`);
  }
  console.log('');
}
