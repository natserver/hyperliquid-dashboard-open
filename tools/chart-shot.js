/**
 * 把看板真实数据的 K 线图渲染成一份自包含 HTML，供肉眼验收标注效果。
 * 走**真实渲染器**（public/charts.js）+ **真实快照**，不是示意图。
 *
 * 用法：node tools/chart-shot.js [地址] [币种]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { parseWad, bandsAt } from '../src/strategy.js';
import { renderCandles } from '../public/charts.js';

const BASE = process.env.HL_BASE || 'http://127.0.0.1:8787';
const USER = process.argv[2] || '0x010461c14e146ac35fe42271bdc1134ee31c703a';
const COIN = process.argv[3] || 'BTC';

const snap = await (await fetch(`${BASE}/api/snapshot?network=mainnet&user=${USER}&coin=${COIN}`)).json();
if (!snap.ok) {
  console.error('快照失败：' + snap.error + '（服务没起？先 node server.js）');
  process.exit(1);
}

// ⚠️ 量纲：快照里的价格字段**已经是 WAD 十进制字符串**，只需 ÷1e18。
// 只有交易所回来的原始十进制串（K 线的 OHLC）才需要 parseWad。
const num = (w) => Number(BigInt(w ?? 0)) / 1e18;

const ivMs = 14400000;
const pj = await (
  await fetch(`${BASE}/api/proxy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      network: 'mainnet',
      body: {
        type: 'candleSnapshot',
        req: { coin: COIN, interval: '4h', startTime: Date.now() - 300 * ivMs, endTime: Date.now() },
      },
    }),
  })
).json();

const candles = pj.data.map((c) => ({
  t: c.t,
  o: Number(c.o),
  h: Number(c.h),
  l: Number(c.l),
  c: Number(c.c),
  v: Number(c.v),
  cs: c.c,
}));
const closes = candles.map((c) => parseWad(c.cs ?? c.c));
const bands = [];
for (let i = 19; i < closes.length; i++) {
  const b = bandsAt(closes, i, 20, 20000);
  if (b) bands.push({ i, upper: num(b.upper), mid: num(b.mid), lower: num(b.lower) });
}

const L = snap.levelsByCoin?.[COIN];
const pos = snap.positions.find((p) => p.coin === COIN);
const lines = [];
if (pos) {
  lines.push({ price: num(pos.entryPx), label: '开仓价', sub: '开仓价', kind: 'entry' });
  if (pos.liquidationPx) lines.push({ price: num(pos.liquidationPx), label: '清算价', sub: '清算价', kind: 'liq' });
}
if (L?.stop?.recommended) lines.push({ price: num(L.stop.recommended.price), label: '止损位', sub: '止损位', kind: 'stop' });
for (const a of L?.roll?.ladder || []) {
  lines.push({ price: num(a.triggerPrice), label: `滚仓点 ${a.index}`, sub: `滚仓点${a.index}`, kind: 'roll' });
}
for (const r of L?.takeProfit?.rMultiples || []) {
  lines.push({ price: num(r.price), label: `${r.r}R`, sub: `${r.r}R 止盈`, kind: `tp${r.r}` });
}
if (L?.takeProfit?.measuredMove) {
  lines.push({ price: num(L.takeProfit.measuredMove.target), label: '等幅目标', sub: '等幅目标', kind: 'tpmm' });
}
// 真实前端用 WebSocket 中间价；这里用标记价代替，保证「序号 1 = 离现价最近」这条语义可验
const livePx = num(L?.mark ?? snap.markets[COIN]?.markPx);
lines.push({ price: livePx, label: '现价', sub: '现价', kind: 'live', legend: false });

const out = renderCandles({ candles, bands, lines, markers: [] });

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dots = (color) =>
  String(color || '#8c959f')
    .split('|')
    .map((c) => `<span class="keydot" style="background:${c.trim()}"></span>`)
    .join('');
const mainColor = (color) => String(color || '#8c959f').split('|')[0].trim();

const rows = (out.key || [])
  .map(
    (k) => `<tr>
  <td>${k.n ? `<span class="keynum" style="border-color:${mainColor(k.color)};color:${mainColor(k.color)}">${k.n}</span>` : '<span class="keynum off">—</span>'}</td>
  <td>${dots(k.color)}${esc(k.kindName)}</td>
  <td class="kprice">${esc(k.priceText)}</td>
  <td>${esc(k.label)}</td>
  <td>${esc(k.desc || '')}</td>
</tr>`
  )
  .join('');

const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>K 线标注验收 —— ${COIN} 4H</title>
<style>
:root{--border:#e7ebef;--muted:#656d76;--soft:#8c959f}
*{box-sizing:border-box}
body{font:13px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#1f2328;background:#fff;margin:0;padding:20px 22px}
h1{font-size:17px;margin:0 0 2px}
.sub{color:var(--muted);font-size:12px;margin-bottom:14px}
.sub code{background:#f6f8fa;padding:1px 5px;border-radius:4px}
.chart{border:1px solid var(--border);border-radius:9px;overflow:hidden}
.chart svg{display:block;width:100%;height:auto}
.chart-legend{padding:8px 13px 12px;font-size:11.5px;color:var(--muted);border-top:1px solid var(--border)}
.chart-legend-bar{display:flex;flex-wrap:wrap;gap:6px 16px;padding-bottom:9px}
.lg{display:inline-flex;align-items:center;gap:5px;font-family:ui-monospace,Consolas,monospace}
.sw{width:11px;height:3px;border-radius:2px;display:inline-block}
.lgtip{color:var(--soft)}
table{width:100%;border-collapse:collapse;font-size:11.5px;border:1px solid var(--border);border-radius:7px;overflow:hidden}
th{background:#fbfcfd;border-bottom:1px solid var(--border);padding:5px 9px;text-align:left;font-weight:620;font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.3px}
td{padding:6px 9px;border-bottom:1px solid var(--border);vertical-align:top;line-height:1.55}
tbody tr:last-child td{border-bottom:0}
.kprice{font-family:ui-monospace,Consolas,monospace;white-space:nowrap}
.keynum{display:inline-flex;align-items:center;justify-content:center;width:17px;height:17px;border-radius:50%;border:1.2px solid var(--muted);font-family:ui-monospace,monospace;font-size:9.5px;font-weight:700}
.keynum.off{border-style:dashed;color:var(--soft)}
.keydot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px;vertical-align:1px}
.note{margin-top:9px;padding:9px 11px;border-radius:7px;background:#f6f8fa;border:1px solid var(--border);font-size:11.5px;color:var(--muted);line-height:1.7}
.note b{color:#1f2328}
</style></head><body>
<h1>K 线 · 布林带 · 关键位 —— ${COIN} 4H</h1>
<div class="sub">账户 <code>${USER}</code>　标记价 <b>${livePx.toFixed(2)}</b>　${candles.length} 根 K 线　图上 ${(out.key || []).length} 个标注　超出视图 ${out.clipped} 个</div>
<div class="chart">${out.svg}</div>
<div class="chart-legend">
  <div class="chart-legend-bar">
    ${(out.legend || [])
      .map(
        (l) =>
          `<span class="lg"><i class="sw" style="background:${l.color}"></i>${esc(l.label)}${
            l.desc ? `<span class="lgtip"> · ${esc(l.desc)}</span>` : ''
          }</span>`
      )
      .join('')}
  </div>
  <table>
    <thead><tr>
      <th style="width:34px">图</th><th style="width:124px">类别</th><th style="width:92px">价格</th>
      <th style="width:150px">名称</th><th>这是什么</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="note">
    「图」列的编号 = 图左侧空心圆圈里的编号，方便两处对上；「—」表示该项本次没画在图上。
    <b>1R 是什么意思</b>：从入场基准到止损位的价差算作一个 R（一次风险的代价），
    2R / 3R 就是把这段价差再走两倍、三倍 —— 所以它们衡量的是「赚了几个风险单位」，
    而不是「涨了百分之几」。等幅目标与 R 倍数无关，它是 K 线区间自己量出来的可得空间。
    一行里若出现多个色点，说明这<b>一个价格</b>同时是几个身份（比如滚仓后「止损」正好等于「保本」），
    图上只会画一条线，不是漏画。
  </div>
</div>
</body></html>`;

mkdirSync('tools/chart-shot-out', { recursive: true });
writeFileSync('tools/chart-shot-out/chart.html', html, 'utf8');
console.log(`clipped=${out.clipped} unknown=${out.unknown} key=${(out.key || []).length}`);
for (const k of out.key || []) console.log(`  #${k.n}  ${k.kind.padEnd(6)} ${k.priceText.padStart(10)}  ${k.kindName}`);
console.log('→ tools/chart-shot-out/chart.html');
