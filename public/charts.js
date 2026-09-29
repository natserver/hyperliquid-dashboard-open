/**
 * SVG 图表渲染器（零依赖，手绘）。
 *
 * 为什么不用图表库：这个看板要在 K 线上叠加布林三轨、开仓价、清算价、
 * 止损位、滚仓阶梯、止盈参考位、趋势突破标记 —— 这些都需要精确的坐标控制
 * 和自定义标注。引一个库再往回改，比直接画费劲得多。
 *
 * 配色遵循中国习惯：涨红跌绿。
 */

const THEME = {
  bg: '#ffffff',
  rail: '#f6f8fa', // 右侧标注栏底色：把文字从 K 线里「抬」出来
  railEdge: '#e7ebef',
  grid: '#eef1f4',
  gridStrong: '#dfe4e9',
  axis: '#8c959f',
  text: '#1f2328',
  muted: '#656d76',
  up: '#cf222e',
  down: '#1a7f37',
  // 关键位配色。
  //
  // 曾经的坑：liq 用了和 up 一样的红、roll 用了和 down 一样的绿、三个止盈位
  // 共用同一个紫 —— 六条线在图上只有三种颜色，用户无法分辨哪条是哪条。
  // 现在的规则是「一条线一种颜色，且不与涨跌红绿撞色」。
  // 唯一有意共用的是 fill：同一族（如止盈的 1R/2R/3R）用同一个实心色画小圆点，
  // 靠文字区分，不再靠颜色区分。
  band: '#8250df',
  bandFill: '#8250df',
  entry: '#0969da', // 开仓价：蓝
  live: '#0d7d7d', // 现价：青
  liq: '#82071e', // 清算价：暗红（深于涨红，避免与阳线混）
  stop: '#bc4c00', // 止损：橙（与琥珀滚仓色拉开）
  roll: '#1a7f37', // 滚仓：绿
  tp1: '#8250df', // 1R：紫
  tp2: '#6639ba', // 2R：深紫
  tp3: '#4c2889', // 3R：更深的紫
  mm: '#0a3069', // 等幅目标：深蓝（说明它来自 K 线量出，不是人工目标）
};

/** 关键位的完整定义：颜色 + 图上的短名 + 一句人话解释。 */
const LEVEL_KINDS = {
  entry: { color: THEME.entry, name: '开仓价', desc: '当前持仓的成交均价，盈亏从这里起算', solid: true, fill: true },
  liq: { color: THEME.liq, name: '清算价', desc: '跌破/涨过这里会被强平；这是不可协商的硬边界', fill: true },
  stop: { color: THEME.stop, name: '止损位', desc: '结构位被打穿的位置，破位即离场', solid: true, fill: true },
  roll: { color: THEME.roll, name: '滚仓点', desc: '浮盈加仓的触发价，加完止损上移至保本', fill: true },
  tp1: { color: THEME.tp1, name: '1R 止盈', desc: '赚回一次风险单位即走，回本线', fill: true },
  tp2: { color: THEME.tp2, name: '2R 止盈', desc: '赚两次风险单位，常见止盈区', fill: true },
  tp3: { color: THEME.tp3, name: '3R 止盈', desc: '赚三次风险单位，强势趋势目标', fill: true },
  tpmm: { color: THEME.mm, name: '等幅目标', desc: 'K 线区间自己量出的可得空间，不是外部目标价', solid: true, fill: true },
  live: { color: THEME.live, name: '现价', desc: '交易所推送的实时中间价，最后一根 K 线由它驱动', fill: true },
};

const kindOf = (k) => LEVEL_KINDS[k] || { color: THEME.axis, name: '', desc: '', fill: false };
const colorOf = (k) => kindOf(k).color;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** 价格轴标签：大数少给小数位，小数币多给 */
function priceLabel(v) {
  const a = Math.abs(v);
  if (a >= 100000) return v.toFixed(0);
  if (a >= 10000) return v.toFixed(1);
  if (a >= 100) return v.toFixed(2);
  if (a >= 1) return v.toFixed(4);
  return v.toFixed(6);
}

function niceTicks(min, max, count = 5) {
  if (!(max > min)) return [min];
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const start = Math.ceil(min / step) * step;
  const out = [];
  for (let v = start; v <= max + step * 0.001; v += step) out.push(v);
  return out;
}

function timeLabel(ms, spanMs) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  if (spanMs > 60 * 86400000) return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  if (spanMs > 3 * 86400000) return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:00`;
}

/* ─────────────────────── K 线图 ─────────────────────── */

/**
 * @param {object} args
 * @param {Array}  args.candles [{t,o,h,l,c,v}]，值为数字
 * @param {Array}  args.bands   布林序列 [{i, upper, mid, lower}]
 * @param {Array}  args.lines   关键位 [{price, label, kind, fill, legend}]
 *         kind 决定颜色（见 LEVEL_KINDS）；缺省颜色兜到坐标轴灰，不会画成黑。
 * @param {Array}  args.markers 突破标记 [{index, side}]
 */
export function renderCandles({ candles, bands = [], lines = [], markers = [], width = 1180, height = 430 }) {
  if (!candles || candles.length === 0) {
    return { svg: `<div class="tbl-empty">暂无 K 线数据</div>`, legend: [], clipped: 0, key: [] };
  }

  const padL = 8;
  const padT = 14;
  const padB = 26;

  // ── 右侧标注栏 ──
  //
  // 这里是本次「图太乱」修复的核心。原来的做法是把标签直接压在图上：
  // 一行 10.5px 的名字 + 一行 10px 的价格，背板是透明的，K 线和关键位横线
  // 从文字底下穿过；六条线挤在一起时防重叠逻辑只会把标签一味下推，
  // 最后标签离自己的线几十像素远，右侧糊成一片看不出谁是谁。
  //
  // 现在的做法：给右侧划出一条不透明的栏，栏里每条关键位一个「胶囊」，
  // 胶囊 = 颜色圆点 + 名称 + 序号；价格另起一行右对齐。胶囊绝不重叠，
  // 排不下就折行 / 变成更矮的圆点序号，信息一条都不丢。
  const RAIL = 132;
  const railX = width - RAIL;

  // 价格范围以 **K 线本身** 为准。
  let baseLo = Infinity;
  let baseHi = -Infinity;
  for (const c of candles) {
    if (c.l < baseLo) baseLo = c.l;
    if (c.h > baseHi) baseHi = c.h;
  }
  if (!Number.isFinite(baseLo) || !Number.isFinite(baseHi) || baseHi <= baseLo) {
    return { svg: `<div class="tbl-empty">K 线数据异常，无法绘图</div>`, legend: [], clipped: 0, key: [] };
  }

  // 关键位只在「不会把视野撑大超过一倍」时才并入坐标轴。
  //
  // 为什么要这条守卫：曾经有一次注记价格被误乘了 1e18（量纲错），它被直接并入
  // 价格范围后，视野从 [6.2万, 8.2万] 爆成 [−4.9e21, 8.7e22]，301 根 K 线
  // 被压到画布底部不足 1 像素 —— 整个图看起来「根本没画出来」，而且没有任何报错。
  // 现在：超出合理范围的关键位不参与定轴，改为在边缘画一个带标签的提示，
  // 信息不丢，但主图永远可用。
  //
  // ⚠️ 这里必须给底部留出「标注栏最少要占的高度」：右侧一条关键位一个胶囊，
  // 竖着排下来要多少像素是固定的。如果范围太窄，六条线会挤在二三十像素内，
  // 胶囊就只能一路往下溢。所以视野下限由「K 线振幅」和「标注栏高度需求」共同决定。
  const axisSpan = baseHi - baseLo;
  const loLimit = baseLo - axisSpan * 0.5;
  const hiLimit = baseHi + axisSpan * 0.5;
  const inAxis = (p) => Number.isFinite(p) && p > 0 && p >= loLimit && p <= hiLimit;

  const usable = lines.filter((l) => inAxis(l.price));
  const clipped = lines.filter((l) => Number.isFinite(l.price) && l.price > 0 && !inAxis(l.price));
  // 坐标未知的关键位（价格字段缺失）不进图，但也不静默吞掉 —— 由调用方在 key 里说明。
  const unknown = lines.filter((l) => !Number.isFinite(l.price) || l.price <= 0);

  let lo = baseLo;
  let hi = baseHi;
  for (const l of usable) {
    if (l.price < lo) lo = l.price;
    if (l.price > hi) hi = l.price;
  }
  const spread0 = hi - lo;
  const minSpread = ((usable.length - 1) * 22 + 40) / (height - padT - padB) * spread0 * 0.5;
  if (spread0 < minSpread) {
    // 拉宽视野而不是把胶囊拆开：宁可图上下留白，也要让每个价格落在自己的线上
    const mid = (hi + lo) / 2;
    lo = mid - minSpread / 2;
    hi = mid + minSpread / 2;
  }
  const pad = (hi - lo) * 0.06;
  lo -= pad;
  hi += pad;

  const plotW = railX - padL - 6;
  const plotH = height - padT - padB;

  const x = (i) => padL + (candles.length <= 1 ? plotW / 2 : (i / (candles.length - 1)) * plotW);
  const y = (p) => padT + plotH - ((p - lo) / (hi - lo)) * plotH;
  const bw = Math.max(1, Math.min(9, (plotW / candles.length) * 0.66));

  const parts = [];
  const legend = [];
  const key = [];

  // 标注栏底：先铺满整条右侧，主图的线就不会再从文字底下穿过。
  parts.push(
    `<rect x="${railX}" y="0" width="${width - railX}" height="${height}" fill="${THEME.rail}"/>` +
      `<line x1="${railX}" y1="0" x2="${railX}" y2="${height}" stroke="${THEME.railEdge}" stroke-width="1"/>`
  );

  parts.push(`<rect x="0" y="0" width="${railX}" height="${height}" fill="${THEME.bg}"/>`);

  // 横向网格与价格轴
  for (const t of niceTicks(lo, hi, 5)) {
    const yy = y(t);
    if (yy < padT - 1 || yy > padT + plotH + 1) continue;
    parts.push(`<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${railX}" y2="${yy.toFixed(1)}" stroke="${THEME.grid}" stroke-width="1"/>`);
    parts.push(
      `<text x="${padL + 2}" y="${(yy - 3).toFixed(1)}" font-size="10" fill="${THEME.axis}" font-family="monospace">${priceLabel(t)}</text>`
    );
  }

  // 纵向时间刻度（最多 7 个）
  const tickEvery = Math.max(1, Math.ceil(candles.length / 7));
  for (let i = 0; i < candles.length; i += tickEvery) {
    const xx = x(i);
    parts.push(`<line x1="${xx.toFixed(1)}" y1="${padT}" x2="${xx.toFixed(1)}" y2="${padT + plotH}" stroke="${THEME.grid}" stroke-width="1"/>`);
  }
  const spanMs = candles[candles.length - 1].t - candles[0].t;
  for (let i = 0; i < candles.length; i += tickEvery) {
    parts.push(
      `<text x="${x(i).toFixed(1)}" y="${height - 8}" font-size="10" fill="${THEME.axis}" text-anchor="middle" font-family="monospace">${esc(
        timeLabel(candles[i].t, spanMs)
      )}</text>`
    );
  }

  // 布林带：先画填充带（上轨与下轨之间），再画三条线
  if (bands.length > 1) {
    const up = bands.map((b) => `${x(b.i).toFixed(1)},${y(b.upper).toFixed(1)}`).join(' ');
    const dn = bands
      .slice()
      .reverse()
      .map((b) => `${x(b.i).toFixed(1)},${y(b.lower).toFixed(1)}`)
      .join(' ');
    parts.push(`<polygon points="${up} ${dn}" fill="${THEME.bandFill}" fill-opacity="0.06" stroke="none"/>`);
    const line = (key2, color, dash, w) =>
      `<polyline points="${bands
        .map((b) => `${x(b.i).toFixed(1)},${y(b[key2]).toFixed(1)}`)
        .join(' ')}" fill="none" stroke="${color}" stroke-width="${w}" ${dash ? `stroke-dasharray="${dash}"` : ''} stroke-linejoin="round"/>`;
    parts.push(line('upper', THEME.band, null, 1.2));
    parts.push(line('mid', THEME.band, '4 3', 1.2));
    parts.push(line('lower', THEME.band, null, 1.2));
    legend.push({ label: 'BOLL(20, 2σ) 布林带', color: THEME.band, dash: true, desc: '20 根均线 ± 2 倍标准差；中轨是多空分界，也是动态离场参考' });
  }

  // K 线本体
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const up = c.c >= c.o;
    const color = up ? THEME.up : THEME.down;
    const xx = x(i);
    const yo = y(c.o);
    const yc = y(c.c);
    const top = Math.min(yo, yc);
    const h = Math.max(1, Math.abs(yc - yo));
    parts.push(
      `<line x1="${xx.toFixed(1)}" y1="${y(c.h).toFixed(1)}" x2="${xx.toFixed(1)}" y2="${y(c.l).toFixed(1)}" stroke="${color}" stroke-width="1"/>`
    );
    parts.push(
      `<rect x="${(xx - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${up ? '#fff' : color}" stroke="${color}" stroke-width="1"/>`
    );
  }

  // 趋势突破标记
  for (const m of markers) {
    if (m.index < 0 || m.index >= candles.length) continue;
    const xx = x(m.index);
    const c = candles[m.index];
    const above = m.side === 1;
    const yy = above ? y(c.h) - 8 : y(c.l) + 8;
    const tri = above
      ? `${xx - 4},${yy + 5} ${xx + 4},${yy + 5} ${xx},${yy - 1}`
      : `${xx - 4},${yy - 5} ${xx + 4},${yy - 5} ${xx},${yy + 1}`;
    parts.push(`<polygon points="${tri}" fill="${above ? THEME.up : THEME.down}" fill-opacity="0.85"/>`);
  }
  if (markers.length) legend.push({ label: `有效突破 ×${markers.length}`, color: THEME.up });

  // 关键位横线：画到 railX 为止，绝不越过标注栏
  //
  // 两个顺序是**分开**的，这一点是实测才想明白的：
  //
  //   · 序号（谁先看）按「离当前价由近到远」—— 交易时先关心最近的止损/止盈，
  //     越远的越不紧急。所以 1 号永远是「离现价最近的那条线」。
  //   · 胶囊位置（谁在上面）按**价格高低** —— 右侧那一栏在视觉上就是一把价格尺，
  //     y 与主图的价格轴共用同一套映射。如果按序号排，会出现
  //     「81526 → 81095 → 82098 → 80092」这种不单调的顺序，眼睛立刻读不懂。
  //
  // 早先两者都用序号顺序，结果就是后者 —— 线在图上是对的，右栏却是乱的。
  const ref = usable.find((l) => l.kind === 'live')?.price ?? (baseLo + baseHi) / 2;
  const byDistance = usable.slice().sort((a, b) => Math.abs(a.price - ref) - Math.abs(b.price - ref));
  const byPrice = usable.slice().sort((a, b) => b.price - a.price);

  const nByPrice = new Map();
  byDistance.forEach((l, i) => nByPrice.set(l, i + 1));

  const railItems = [];
  // 按价格由高到低铺（y 由上到下），但序号取自己在距离序里的名次
  byPrice.forEach((l) => {
    const n = nByPrice.get(l);
    const yy = y(l.price);
    const mk = kindOf(l.kind);
    const color = mk.color;
    const solid = Boolean(mk.solid);
    if (yy < padT - 2 || yy > padT + plotH + 2) return;

    parts.push(
      `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${railX}" y2="${yy.toFixed(1)}" stroke="${color}" stroke-width="1.3" stroke-dasharray="${
        solid ? '' : '6 4'
      }" stroke-opacity="0.9"/>`
    );
    // 序号：标在左边线上，和右侧标注栏里的数字一一对应。
    // 有了它，即使两个价格只差几块钱、胶囊被挤开，也能一眼对上是哪条线。
    parts.push(
      `<circle cx="${padL + 3}" cy="${yy.toFixed(1)}" r="7" fill="${THEME.bg}" stroke="${color}" stroke-width="1.2"/>` +
        `<text x="${padL + 3}" y="${(yy + 3).toFixed(1)}" font-size="8.5" fill="${color}" text-anchor="middle" font-family="monospace" font-weight="700">${n}</text>`
    );

    railItems.push({ n, y: yy, price: l.price, kind: l.kind, label: l.label, sub: l.sub, color, fill: l.fill !== false });
    if (l.legend !== false) {
      key.push({
        n,
        kind: l.kind,
        kindName: mk.name,
        label: l.label,
        desc: mk.desc,
        price: l.price,
        priceText: priceLabel(l.price),
        color,
      });
    }
  });

  // key 按序号排，让「图上 1 号」在表里也是第一行。渲染器不管表怎么排，
  // 但给一个有序的数组，调用方就不用再排一次。
  key.sort((a, b) => a.n - b.n);

  // ── 把胶囊铺进标注栏 ──
  //
  // 每项占 22px 的「一格」，格子的中心就是它所属横线的 y。
  // 遇到挤在一起的价格，用**居中扩散**的方式把格子推开（而不是像原来那样只管下推），
  // 这样标签始终在它自己那条线的附近，不会整体漂移到别的价格上去。
  // 实在排不下时降级：先缩成 13px 的矮胶囊，再缩成只留「圆点 + 序号」，
  // 但价格数字一行都不会少。
  let placed = [];
  const N = railItems.length;
  if (N === 1) {
    placed = railItems.map((it) => ({ ...it, cy: clamp(it.y, padT + 8, padT + plotH - 8), h: 22 }));
  } else if (N > 1) {
    const SLOT = 22;
    let slotH = Math.min(SLOT, Math.max(9, plotH - 16) / N);
    const want = railItems.map((it) => it.y);
    const gap = Math.max(8, slotH);
    let lo2 = want[0];
    let hi2 = want[0];
    for (const w of want) {
      lo2 = Math.min(lo2, w);
      hi2 = Math.max(hi2, w);
    }
    // 先尽量保持原有顺序，超界就整体平移
    let c = clamp(lo2, padT + slotH / 2 + 6, padT + plotH - (N - 1) * gap - slotH / 2 - 6);
    const cy = [];
    for (let i = 0; i < N; i++) {
      cy.push(c);
      c += gap;
    }
    // 若仍越界（高度真的不够），压到极限并允许圆点退化
    if (cy[N - 1] > padT + plotH - 4 || cy[0] < padT + 4) {
      const usable2 = Math.max(40, plotH - 12);
      slotH = Math.max(9, usable2 / N);
      const g2 = Math.max(9, slotH);
      const s0 = padT + 6 + slotH / 2;
      for (let i = 0; i < N; i++) cy[i] = clamp(want[i], s0 + i * g2, s0 + i * g2);
      for (let i = 1; i < N; i++) cy[i] = Math.max(cy[i], cy[i - 1] + g2);
      if (cy[N - 1] > padT + plotH - 3) {
        const over = cy[N - 1] - (padT + plotH - 3);
        for (let i = 0; i < N; i++) cy[i] -= over;
      }
    }
    placed = railItems.map((it, i) => ({ ...it, cy: cy[i], h: slotH }));
  }

  const micro = placed.length > 0 && placed[0].h < 11;

  for (const it of placed) {
    const h = it.h;
    const cy = clamp(it.cy, padT + h / 2 + 3, padT + plotH - h / 2 - 3);
    const top = cy - h / 2;
    // 胶囊：浅色底 + 同色描边，把文字从网格里彻底隔离出来
    parts.push(
      `<rect x="${railX + 5}" y="${top.toFixed(1)}" width="${RAIL - 11}" height="${h.toFixed(1)}" rx="4" fill="${it.fill ? tint(it.color) : THEME.bg}" stroke="${it.color}" stroke-opacity="0.4" stroke-width="1"/>`
    );
    if (micro) {
      // 最矮档：圆点 + 序号 + 价格（名称在这个高度放不下，交给图例表）
      parts.push(
        `<circle cx="${railX + 15}" cy="${cy.toFixed(1)}" r="3" fill="${it.color}"/>` +
          `<text x="${railX + 23}" y="${(cy + 3.2).toFixed(1)}" font-size="9" fill="${it.color}" font-family="monospace" font-weight="700">${
            it.n
          }</text>` +
          `<text x="${width - 9}" y="${(cy + 3.2).toFixed(1)}" font-size="9.5" fill="${THEME.text}" text-anchor="end" font-family="monospace" font-weight="600">${
            priceLabel(it.price)
          }</text>`
      );
      continue;
    }
    // 第一行：颜色圆点 + 序号 + 短名（短名过长时截断，不挤掉价格）
    const name = it.sub || kindOf(it.kind).name || it.label || '';
    const nameX = railX + 22;
    parts.push(`<circle cx="${railX + 14}" cy="${(cy - h / 4 + 1).toFixed(1)}" r="3.2" fill="${it.color}"/>`);
    parts.push(
      `<text x="${railX + 19}" y="${(cy - h / 4 + 4).toFixed(1)}" font-size="9" fill="${it.color}" font-family="monospace" font-weight="700">${
        it.n
      }</text>` +
        `<text x="${nameX + 10}" y="${(cy - h / 4 + 4).toFixed(1)}" font-size="10" fill="${THEME.text}" font-family="monospace" font-weight="600">${
          esc(name)
        }</text>`
    );
    // 第二行：价格右对齐（h 够时才画）
    if (h >= 17) {
      parts.push(
        `<text x="${width - 9}" y="${(cy + h / 4 + 2.5).toFixed(1)}" font-size="10.5" fill="${it.color}" text-anchor="end" font-family="monospace" font-weight="700">${
          priceLabel(it.price)
        }</text>`
      );
    }
  }
  // 右上角盖住溢出的胶囊（极端情况下允许被裁掉一点，好过糊满整张图）
  parts.push(
    `<rect x="${railX}" y="0" width="${width - railX}" height="${padT - 4}" fill="${THEME.rail}"/>` +
      `<rect x="${railX}" y="${padT + plotH + 4}" width="${width - railX}" height="${height - padT - plotH - 4}" fill="${THEME.rail}"/>`
  );

  // 未并入坐标轴的关键位：在上下边缘给提示，既不丢信息也不破坏主图比例。
  // 命中这里通常意味着注记价格量纲错了（或被极端行情甩出视野）。
  const clipUp = clipped.filter((l) => l.price > hi);
  const clipDn = clipped.filter((l) => l.price < lo);
  const edgeTag = (list, atTop) => {
    list.slice(0, 4).forEach((l, k) => {
      const yy = atTop ? padT + 10 + k * 12 : padT + plotH - 4 - k * 12;
      const mk = kindOf(l.kind);
      const color = mk.color || THEME.muted;
      parts.push(
        `<text x="${padL + 4}" y="${yy.toFixed(1)}" font-size="10" fill="${color}" font-family="monospace" font-weight="600">${
          atTop ? '▲' : '▼'
        } ${esc(l.sub || mk.name || l.label)} ${priceLabel(l.price)} 超出视图</text>`
      );
      key.push({
        n: 0,
        kind: l.kind,
        kindName: mk.name,
        label: l.label,
        desc: `在视图外（${atTop ? '高于' : '低于'}当前显示区间），图上只在边缘给出位置提示`,
        price: l.price,
        priceText: priceLabel(l.price),
        color,
        clipped: true,
      });
    });
  };
  edgeTag(clipUp, true);
  edgeTag(clipDn, false);
  if (clipped.length) legend.push({ label: `超出视图 ×${clipped.length}`, color: THEME.muted });

  return {
    svg: `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" role="img">${parts.join('')}</svg>`,
    legend,
    clipped: clipped.length,
    unknown: unknown.length,
    key,
  };
}

/** 叠在胶囊底色上的浅色版：与色相同族，保证深色文字可读。 */
function tint(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return '#f6f8fa';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const mix = (c) => Math.round(c + (255 - c) * 0.9);
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
}

function clamp(v, a, b) {
  if (!Number.isFinite(v)) return a;
  return v < a ? a : v > b ? b : v;
}

/* ─────────────────────── 权益曲线 ─────────────────────── */

/**
 * 权益曲线 + 回撤阴影。
 * @param {Array} points [{t, v}] v 为数字
 * @param {object} dd 最大回撤 {peakAt, at}
 */
export function renderEquity({ points, dd, width = 1180, height = 220 }) {
  if (!points || points.length < 2) return `<div class="tbl-empty">暂无权益数据</div>`;

  const padL = 10;
  const padR = 96;
  const padT = 12;
  const padB = 24;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  let lo = Infinity;
  let hi = -Infinity;
  for (const p of points) {
    if (p.v < lo) lo = p.v;
    if (p.v > hi) hi = p.v;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return `<div class="tbl-empty">权益数据异常</div>`;
  if (hi === lo) {
    hi += Math.abs(hi) * 0.01 + 1;
    lo -= Math.abs(lo) * 0.01 + 1;
  }
  const padv = (hi - lo) * 0.08;
  lo -= padv;
  hi += padv;

  const x = (i) => padL + (i / (points.length - 1)) * plotW;
  const y = (v) => padT + plotH - ((v - lo) / (hi - lo)) * plotH;

  const parts = [];
  for (const t of niceTicks(lo, hi, 4)) {
    const yy = y(t);
    if (yy < padT - 1 || yy > padT + plotH + 1) continue;
    parts.push(`<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${padL + plotW}" y2="${yy.toFixed(1)}" stroke="${THEME.grid}"/>`);
    parts.push(
      `<text x="${padL + plotW + 5}" y="${(yy + 3.5).toFixed(1)}" font-size="10" fill="${THEME.axis}" font-family="monospace">${priceLabel(t)}</text>`
    );
  }

  const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const area = `${padL},${(padT + plotH).toFixed(1)} ${line} ${(padL + plotW).toFixed(1)},${(padT + plotH).toFixed(1)}`;

  const rising = points[points.length - 1].v >= points[0].v;
  const stroke = rising ? THEME.up : THEME.down;

  parts.push(`<polygon points="${area}" fill="${stroke}" fill-opacity="0.07"/>`);
  parts.push(`<polyline points="${line}" fill="none" stroke="${stroke}" stroke-width="1.6" stroke-linejoin="round"/>`);

  // 标注回撤区间
  if (dd && dd.peakAt && dd.at && dd.pct > 0) {
    const i1 = points.findIndex((p) => p.t >= dd.peakAt);
    const i2 = points.findIndex((p) => p.t >= dd.at);
    if (i1 >= 0 && i2 >= 0 && i2 > i1) {
      parts.push(
        `<rect x="${x(i1).toFixed(1)}" y="${padT}" width="${(x(i2) - x(i1)).toFixed(1)}" height="${plotH}" fill="${THEME.up}" fill-opacity="0.08"/>`
      );
      parts.push(
        `<text x="${((x(i1) + x(i2)) / 2).toFixed(1)}" y="${padT + 11}" font-size="10.5" fill="${THEME.up}" text-anchor="middle" font-family="monospace">最大回撤 ${(
          dd.pct * 100
        ).toFixed(2)}%${dd.doubtful ? '（分母失真，仅绝对金额可信）' : ''}</text>`
      );
    }
  }

  // 时间轴
  const spanMs = points[points.length - 1].t - points[0].t;
  const every = Math.max(1, Math.ceil(points.length / 6));
  for (let i = 0; i < points.length; i += every) {
    parts.push(
      `<text x="${x(i).toFixed(1)}" y="${height - 6}" font-size="10" fill="${THEME.axis}" text-anchor="middle" font-family="monospace">${esc(
        timeLabel(points[i].t, spanMs)
      )}</text>`
    );
  }

  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" role="img">${parts.join('')}</svg>`;
}
