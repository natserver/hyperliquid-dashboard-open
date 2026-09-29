/**
 * 探一个地址当前有没有仓位（用于挑「有持仓的地址」跑预警验收）。
 *
 * 用法：node tools/probe-positions.js 0x地址 [mainnet|testnet]
 */
const BASE = (process.env.HL_BASE || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const ADDR = process.argv[2];
const NET = process.argv[3] || 'mainnet';

const r = await fetch(`${BASE}/api/snapshot?network=${NET}&user=${ADDR}&coin=BTC`, { signal: AbortSignal.timeout(90000) });
const s = await r.json();
if (!s.ok) {
  console.log(`${NET} ${ADDR} → 读取失败：${s.error || JSON.stringify(s).slice(0, 200)}`);
  process.exit(0);
}
const pos = s.positions || [];
const withLiq = pos.filter((p) => p.liquidationPx);
const withLevels = pos.filter((p) => p.levels);
console.log(
  `${NET} ${ADDR} → 持仓 ${pos.length} 个 · 有清算价 ${withLiq.length} 个 · 有策略读数 ${withLevels.length} 个 · ` +
    `权益 $${Number(BigInt(s.account.accountValue)) / 1e18}`
);
for (const p of pos.slice(0, 10)) {
  console.log(
    `   ${p.isLong ? '多' : '空'} ${p.coin}  开仓 ${Number(BigInt(p.entryPx)) / 1e18}  ` +
      `清算 ${p.liquidationPx ? Number(BigInt(p.liquidationPx)) / 1e18 : '未给出'}  ` +
      `读数 ${p.levels ? '有' : '无'}`
  );
}
