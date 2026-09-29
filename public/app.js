/**
 * 比特皇 · Hyperliquid 只读看板 —— 前端
 *
 * 直接 import 后端的同一份策略数学模块（/src/strategy.js 等），
 * 所以界面显示的数字与链上风控、与后端算出来的完全一致，不存在两套实现漂移的问题。
 *
 * 本文件不含任何密钥处理代码，也不含任何下单/签名路径 —— 整个工程是纯只读的。
 */

import { renderCandles, renderEquity } from './charts.js';
import {
  CYCLE_PHASES,
  PHASE_AUTO,
  bandsAt,
  fmtBps,
  fmtPrice,
  fmtWad,
  parseWad,
  wadToNumber,
} from '/src/strategy.js';
import {
  FAMILY_LABELS,
  RULE_LABELS,
  SEVERITY_LABELS,
  evaluateAlerts,
  fmtDuration,
  resolveConfig,
} from '/src/alerts.js';

/* ─────────────────────── 状态 ─────────────────────── */

const LS_KEY = 'bithuang-hl-dashboard/v1';

/** 相位语义版本。1（隐式）= 旧默认值 ACCUMULATION；2 = 默认「自动」。
 *  只用于把 localStorage 里的旧默认值迁掉，见 loadState 里的说明。 */
const PHASE_VER = 2;

const state = {
  network: 'mainnet',
  address: '',
  coin: 'BTC',
  /* 默认「自动」：相位由减半时钟推算。
   * 以前这里是硬编码的 ACCUMULATION —— 那是错的，不是"保守的默认值"：
   * 方向层根本不看这个字段（它自己读时钟），所以这个默认值唯一的作用
   * 就是把**波动门槛**按熊末筑底的 16% 收，而方向层可能早已按出清段的
   * 20% 在算。两边不同步比两边都保守更危险。 */
  phase: PHASE_AUTO,
  interval: '4h',
  period: 'perpAllTime',
  levelCoin: null,
  showBands: true,
  showLevels: true,
  autoRefresh: true,
  snap: null,
  chartCache: new Map(), // `${coin}|${interval}` -> candles(数字化)
  mids: {},
  loading: false,
};

function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    for (const k of ['network', 'address', 'coin', 'phase', 'interval', 'period', 'showBands', 'showLevels', 'autoRefresh']) {
      if (s[k] !== undefined) state[k] = s[k];
    }
    /* ── 一次性迁移：把历史遗留的 ACCUMULATION 换成「自动」 ──────────
     * 老版本把 ACCUMULATION 硬编码成默认值，而这个默认值会**被存进
     * localStorage**。只改代码默认值的话，所有老用户仍然带着这个值 ——
     * 他们会以为自己已经用上了新逻辑，实际相位还是错的。
     *
     * 为什么敢直接改用户存的值：因为它压根不是用户选的，它是旧默认值。
     * 真想要筑底相位的人在界面上再点一次即可（下拉里仍然有它）。
     * 用版本号保证只迁一次，避免以后用户主动选 ACCUMULATION 又被改掉。 */
    if (s.phaseVer !== PHASE_VER && (s.phase === undefined || s.phase === 'ACCUMULATION')) {
      state.phase = PHASE_AUTO;
    }
  } catch {
    /* 配置损坏就按默认走，不阻断使用 */
  }
}

/**
 * URL 参数覆盖（`?user=0x…&network=testnet&coin=BTC&phase=EXPANSION`）。
 *
 * 两个用途：
 *   · 链接可收藏 / 可分享 —— 「打开就是我常看的那个账户、那个标的、那个相位」；
 *   · 可脚本化 —— 无头浏览器能直接截到一个有数据的页面，
 *     否则要先用 DOM 交互填地址，而地址存在 localStorage 里，冷启动拿不到。
 *
 * 放在 loadState **之后**：URL 是"这一次要看的"，localStorage 是"上次看的"，
 * 显式传参优先。优先级：URL > localStorage > 默认值。
 *
 * 地址是公开的链上数据，不进任何请求体以外的地方；这里只做长度/前缀校验，
 * 不做"合法性"拦截 —— 校验失败就静默忽略该参数，不要让一个手抖的查询串白屏。
 */
const URL_PARAM_KEYS = {
  user: 'address',
  address: 'address',
  network: 'network',
  coin: 'coin',
  phase: 'phase',
  interval: 'interval',
};
function applyUrlParams() {
  let q;
  try {
    q = new URLSearchParams(location.search);
  } catch {
    return;
  }
  for (const [param, key] of Object.entries(URL_PARAM_KEYS)) {
    const v = q.get(param);
    if (!v) continue;
    if (key === 'address' && !/^0x[0-9a-fA-F]{40}$/.test(v)) continue;
    if (key === 'network' && v !== 'mainnet' && v !== 'testnet') continue;
    if (key === 'coin' && !/^[A-Za-z0-9:_-]{1,20}$/.test(v)) continue;
    /* 相位只认「自动」与四个具体相位。
     * 拼错的值**不要**透传：服务端会把未知值兜成自动模式（并留一条 warning），
     * 用户却以为自己指定了相位 —— 宁可在前端就不认，让下拉保持选中「自动」。 */
    if (key === 'phase') {
      const up = v.toUpperCase();
      if (up !== PHASE_AUTO && !CYCLE_PHASES.includes(up)) continue;
      state.phase = up;
      continue;
    }
    state[key] = key === 'coin' ? v.toUpperCase() : v;
  }
}

function saveState() {
  try {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        network: state.network,
        address: state.address,
        coin: state.coin,
        phase: state.phase,
        phaseVer: PHASE_VER,
        interval: state.interval,
        period: state.period,
        showBands: state.showBands,
        showLevels: state.showLevels,
        autoRefresh: state.autoRefresh,
      })
    );
  } catch {
    /* 隐私模式下 localStorage 不可用，忽略 */
  }
}

/* ─────────────────────── 小工具 ─────────────────────── */

const $ = (id) => document.getElementById(id);

/**
 * 快照里存在两种数值形态，量纲差 1e18。混用会让所有价格放大 1e18 倍 ——
 * 曾导致「标记价显示成 7.76375e+22」和「K 线被压成一条线、看起来根本没画出来」。
 *
 *   WAD 形态 —— 后端把 BigInt 直接序列化成**纯整数串**，如 "2448410000000000000000"
 *                代表 2448.41。已经含了 1e18 标度，只能 BigInt(v)，绝不能再乘 1e18。
 *   DEC 形态 —— 信息接口**原样透传**的十进制，如 markets.markPx "77442.0"、
 *                fundingRate 0.0000125。本身是人读值，要 parseWad 放大 1e18 才能进 WAD 运算。
 *
 * 判别规则：纯整数串 → WAD；含小数点或指数 → DEC。
 * 读快照字段一律用 wad()；读 markets / mids / feeRates / closing.best|worst
 * 这几个透传字段一律用 dec()。
 *
 * wad() 对两种形态都能给出正确结果（非纯整数字符串时会退化为 dec 解析），
 * 所以即使后端将来改了序列化方式也不会静默算错 —— 只会退化成慢一点。
 */
const wad = (v) => {
  if (typeof v === 'bigint') return v;
  const s = String(v ?? '0');
  return /^-?\d+$/.test(s) ? BigInt(s) : parseWad(s);
};
/** 接口原样透传的十进制 → WAD。只用于 markets / mids / feeRates / closing.best|worst */
const dec = (v) => parseWad(v ?? 0);

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * 判据文本里的 `**强调**` → `<b>强调</b>`。
 *
 * src/ 里判据的理由链是按 Markdown 写的（`**逆周期**`），直接 esc 会把星号
 * 原样印到界面上 —— 「首要原因：**逆周期**：周期相位要求…」。
 *
 * 顺序不能反：**先 esc 再替换**。先替换的话，`<b>` 是我们自己造的标签，
 * 但原文里如果混进 `<script>`，它就已经被 esc 变成实体了；反过来做等于
 * 亲手开一个注入口子。只处理单行内的成对星号，不跨行 —— 跨行匹配会把
 * 两个不相关的强调误配成一对。
 */
const mdt = (s) => esc(s).replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');

/**
 * 迷你趋势线 —— 把一条历史序列画成 84×20 的内联 SVG 折线。
 *
 * 为什么手写而不用图表库：这个页面是**零依赖**的（package.json 里
 * dependencies 是空的），为 6 条 30 点的折线引一个图表库不划算；
 * 而且那些库默认深色主题，在这个浅色页面上每次都要覆写一堆变量。
 *
 * 为什么画在 esc/mdt 旁边（这里明明是文本区）：冒烟测试是从源码里
 * **切片**取函数出来跑的，切片边界是 `const esc` → `const cls`。
 * 放在这个区间内，sparkline 就自动被纳入测试覆盖，不需要在测试里
 * 额外接一根线 —— 少一处接线就少一处会腐化。
 *
 * 刻意保持**单色**：这 6 条指标量纲各异（指数 / 美元 / 百分比），
 * 用红涨绿跌去上色会暗示"读数是涨还是跌 = 好还是坏"，
 * 而恐慌贪婪从 78 涨到 90 恰恰是**坏**消息。方向语义交给「票」那一列表达。
 *
 * @param {Array<{value:number|null}>} points 按时间正序
 */
function sparkline(points, { w = 84, h = 20, pad = 2 } = {}) {
  const vals = (points || []).filter((p) => p && Number.isFinite(p.value));
  if (vals.length < 2) return '';
  const ys = vals.map((p) => p.value);
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const span = hi - lo || 1; // 全平序列：给个非零跨度，画成一条居中的直线
  const X = (i) => pad + (i * (w - pad * 2)) / (vals.length - 1);
  const Y = (v) => h - pad - ((v - lo) / span) * (h - pad * 2);
  const d = vals.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.value).toFixed(1)}`).join(' ');
  const lx = X(vals.length - 1).toFixed(1);
  const ly = Y(ys[ys.length - 1]).toFixed(1);
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
    <path d="${d}" fill="none" stroke="#656d76" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${lx}" cy="${ly}" r="2.1" fill="#656d76"/>
  </svg>`;
}

const cls = (v) => (v > 0n ? 'num-up' : v < 0n ? 'num-down' : 'num-zero');
const sign = (v) => (v > 0n ? '+' : '');
const pct = (x, dp = 2) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(dp)}%`);
const num = (x, dp = 2) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(dp));
const dt = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '—');
const dtShort = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '—');

/**
 * 关键位配色 —— 必须与 public/charts.js 的 LEVEL_KINDS 保持一致。
 *
 * 为什么在这里再写一份：chart-legend 里除了图上画出来的线，还要列出「图上没画」的
 * 条目（坐标缺失、被裁到视图外、无持仓时的占位行）。那些条目拿不到 charts.js 内部
 * 的颜色对象，如果就地写死或漏写，右侧色点会变成 undefined ——
 * 这正是一次真实的翻车点（渲染层的坏值扫描抓到了 12 处 undefined）。
 * 所以集中放一份，两边都从这里取。
 */
const LEVEL_COLORS = {
  entry: '#0969da',
  liq: '#82071e',
  stop: '#bc4c00',
  roll: '#1a7f37',
  tp1: '#8250df',
  tp2: '#6639ba',
  tp3: '#4c2889',
  tpmm: '#0a3069',
  live: '#0d7d7d',
  neutral: '#8c959f',
};
const levelColor = (kind) => LEVEL_COLORS[kind] || '#8c959f';

/** 与 LEVEL_COLORS 同源的显示名，用于「同一价位多个身份」时并列写出。 */
const LEVEL_NAMES = {
  entry: '开仓价',
  liq: '清算价',
  stop: '止损位',
  roll: '滚仓点',
  tp1: '1R 止盈',
  tp2: '2R 止盈',
  tp3: '3R 止盈',
  tpmm: '等幅目标',
  live: '现价',
  neutral: '无持仓占位',
};
const kindNameOf = (kind) => LEVEL_NAMES[kind] || kind || '—';

/** 带正负色的金额 */
const money = (v, dp = 2) => `<span class="${cls(v)}">${sign(v)}${fmtWad(v, dp)}</span>`;

/**
 * 最大回撤的展示文案统一出口。
 *
 * 后端在「回撤百分比的分母不是真实资金基数」时会给出 `plausible: false`
 * 并附 `caveat`。触发原因有二：
 *   · 权益快照接近 0（账户被提空）；
 *   · 成交其实发生在 HIP-3（builder-deployed）子账户上，
 *     而 clearinghouseState / portfolio 默认只返回主合约账户。
 * 此时百分比是没有意义的 —— 实测测试网某账户算出 164%，越过了 100% 的物理上界。
 *
 * 关键是：**不能只把这个数字画出来然后把限定条件丢掉**，
 * 那等于让界面拿着一个假百分比下结论。必须显式标注，并把绝对金额一并给出。
 */
function ddView(dd) {
  if (!dd || dd.pct === null || dd.pct === undefined) {
    return { text: '—', sub: '—', doubtful: false, has: false };
  }
  const method = dd.method === 'pnl-space' ? '盈亏空间（已排除出入金）' : '权益峰谷（含出入金）';
  // 后端标记优先；同时自己兜一道 —— 权益口径下 >100% 的回撤在任何情况下都不成立。
  // 只在 pct > 0 时才判定：0% 表示「没有回撤」，给它挂个「分母失真」角标会自相矛盾。
  const doubtful = dd.pct > 0 && (dd.plausible === false || dd.pct > 1);
  if (!doubtful) return { text: pct(dd.pct), sub: `口径 ${method}`, doubtful: false, has: true };
  return {
    text: `${pct(dd.pct)}<span class="doubt">分母失真</span>`,
    sub: `口径 ${method} · 亏 $${fmtWad(wad(dd.drawdownAmount ?? 0n), 2)} · 分母非真实资金基数，百分比不可用`,
    doubtful: true,
    has: true,
  };
}

/* ─────────────────────── 数据获取 ─────────────────────── */

async function fetchSnapshot() {
  const url = `/api/snapshot?network=${encodeURIComponent(state.network)}&user=${encodeURIComponent(
    state.address
  )}&coin=${encodeURIComponent(state.coin)}&phase=${encodeURIComponent(state.phase)}`;
  const res = await fetch(url);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

async function fetchCandles(coin, interval) {
  const key = `${coin}|${interval}`;
  const cached = state.chartCache.get(key);
  if (cached && Date.now() - cached.at < 30_000) return cached.data;

  const bars = interval === '1d' ? 260 : interval === '4h' ? 300 : 400;
  const ms = { '1h': 3600000, '4h': 14400000, '1d': 86400000 }[interval];
  const res = await fetch('/api/proxy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      network: state.network,
      body: {
        type: 'candleSnapshot',
        req: { coin, interval, startTime: Date.now() - bars * ms, endTime: Date.now() },
      },
    }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error);
  // cs 保留原始收盘价「字符串」：WAD 运算必须走共享模块的 parseWad(字符串)，
  // 才能和服务端策略读数得到**逐位相同**的布林带。
  // 曾经这里用 BigInt(Math.round(c.c*100))*1e16 自己量化到 2 位小数，
  // 结果 NOT（0.00047）被量化成 0、DOGE 偏差 1.7% —— 图上布林带与读数互相打架。
  const data = json.data.map((c) => ({
    t: c.t,
    o: Number(c.o),
    h: Number(c.h),
    l: Number(c.l),
    c: Number(c.c),
    v: Number(c.v),
    cs: c.c,
  }));
  state.chartCache.set(key, { at: Date.now(), data });
  return data;
}

/* ─────────────────────── 渲染：KPI ─────────────────────── */

function renderKPIs(s) {
  const a = s.account;
  const unreal = s.positions.reduce((acc, p) => acc + wad(p.unrealizedPnl), 0n);
  const net = wad(s.summary.realizedNet);
  const dd = ddView(s.equityCurve?.maxDrawdown);

  const card = (label, value, sub, extraCls = '') =>
    `<div class="kpi"><div class="kpi-label">${label}</div><div class="kpi-value ${extraCls}">${value}</div>${
      sub ? `<div class="kpi-sub">${sub}</div>` : ''
    }</div>`;

  /* 分成两组：首页只留「现在这一刻的状态」，历史统计数收进「账户明细」。
   * 拆分的界线是**时效性** —— 权益/浮盈/保证金率是每分钟都在看的，
   * 胜率/最大回撤是复盘时才看的。两组都在，只是不同屏。 */
  const primary = [
    card('账户权益', `$${fmtWad(wad(a.accountValue), 2)}`, `${s.networkLabel} · 合约账户`),
    card('未实现盈亏', money(unreal), `${s.positions.length} 个持仓`),
    card(
      '保证金使用率',
      pct(a.marginRatio),
      `维持保证金 $${fmtWad(wad(a.maintenanceMargin), 2)}`,
      a.marginRatio > 0.7 ? 'up' : a.marginRatio > 0.4 ? '' : 'down'
    ),
    card('可提现', `$${fmtWad(wad(a.withdrawable), 2)}`, `保证金占用 $${fmtWad(wad(a.marginUsed), 2)}`),
  ];
  const more = [
    card('已实现净额', money(net), `${s.summary.closing.count} 笔平仓 · 手续费 $${fmtWad(wad(s.summary.fees), 2)}`),
    card(
      '资金费净额',
      money(wad(s.summary.fundingNet)),
      '持仓期间的资金费收支',
      wad(s.summary.fundingNet) < 0n ? 'up' : 'down'
    ),
    card('最大回撤', dd.text, dd.sub, dd.doubtful ? 'up' : ''),
    card(
      '平仓胜率',
      s.summary.closing.winRate === null ? '—' : pct(s.summary.closing.winRate, 1),
      `${s.summary.closing.wins} 胜 / ${s.summary.closing.losses} 负`
    ),
  ];
  $('kpis').innerHTML = primary.join('');
  const moreEl = $('kpis-more');
  if (moreEl) moreEl.innerHTML = more.join('');
}

/* ═══════════════ 渲染：结论卡（全站唯一的「现在该怎么办」） ═══════════════
 *
 * 这一卡的内容全部来自 s.pipeline —— 页面自己不再算任何东西。
 * 后端的 runPipeline 已经把「三段跑到哪、卡在哪、给什么动作」算完了，
 * 前端只做一件事：把它摆成 ① 方向 → ② 开单 → ③ 止损 → ④ 加仓 → ⑤ 离场。
 *
 * 三段的推演、42 条判据、每一个止损候选位都在下面的折叠区里，不在这一屏出现。
 *
 * 为什么行数随持仓状态变（无持仓 3 行 / 有持仓 5 行）：
 * 无持仓时「止损 / 加仓 / 止盈」会连着写三遍「不适用」—— 那是为了版面整齐
 * 而制造的信息噪音。形状只在开平仓时变化，而那正是你会重新读这张卡的时刻。
 */

const VD_KIND = {
  READY: { tone: 't-wait', act: '可以开单', badge: 'ok' },
  HOLD: { tone: 't-flat', act: '继续持有', badge: 'neutral' },
  EXIT: { tone: 't-exit', act: '该离场', badge: 'bad' },
  MANAGE: { tone: 't-add', act: '可以加仓', badge: 'ok' },
  DATA_MISSING: { tone: 't-flat', act: '不开新仓', badge: 'neutral' },
  NO_DIRECTION: { tone: 't-flat', act: '不开新仓', badge: 'neutral' },
  WAIT_TRIGGER: { tone: 't-wait', act: '先别动手', badge: 'warn' },
  PLAN_BLOCKED: { tone: 't-wait', act: '先别动手', badge: 'warn' },
  VETOED: { tone: 't-wait', act: '先别动手', badge: 'warn' },
  NO_TRIGGER: { tone: 't-wait', act: '先别动手', badge: 'warn' },
};

/** 一步一行。step 是固定宽度的标签，val 是结论（可含标记），aux 是右侧读数。 */
function vdRow(step, val, aux = '') {
  return `<div class="vd-row"><span class="vd-step">${esc(step)}</span><span class="vd-val">${val}</span><span class="vd-aux">${esc(
    aux
  )}</span></div>`;
}

/** ② 开单这一行的结论。可执行才报价格；不可执行时只说「不动手」—— 结果就是不动手。 */
function vdEntryRow(s1, s2) {
  if (!s1.pass) return '<span class="muted">不动手 —— 方向没定之前不评估入场点</span>';
  if (s2.status === 'SIGNAL') {
    if (s2.executable === false) {
      return `计划被卡住 —— <span class="muted">${esc((s2.blockers || [])[0] || '空间或盈亏比门槛未过')}</span>`;
    }
    const ts = s2.tranches || [];
    const head = ts.find((t) => t.side === 'BREAKOUT' && t.active);
    const main = ts.find((t) => t.side === 'PULLBACK' && t.active);
    const parts = [];
    if (head) parts.push(`现价进头仓 <b>${fmtPrice(wad(head.triggerPrice))}</b>`);
    if (main) parts.push(`挂限价 <b>${fmtPrice(wad(main.triggerPrice))}</b> 等回踩`);
    return parts.length ? parts.join(' · ') : '<span class="muted">计划已备好，但两笔都未生效</span>';
  }
  if (s2.status === 'ARMED') return `等确认 —— <span class="muted">${esc((s2.blockers || [])[0] || '条件未齐')}</span>`;
  if (s2.status === 'VETOED') return `被否决 —— <span class="muted">${esc((s2.blockers || [])[0] || '')}</span>`;
  return `<span class="muted">${esc((s2.blockers || [])[0] || '没有形成触发')}</span>`;
}

function vdEntryAux(s2) {
  const ts = (s2.tranches || []).filter((t) => t.active);
  if (s2.status !== 'SIGNAL' || !ts.length) return '';
  return ts.map((t) => `${(t.ratioBps / 100).toFixed(0)}%`).join(' + ');
}

function renderVerdict(s) {
  const el = $('verdict');
  if (!el) return;

  const P = s.pipeline;
  if (!P || !Array.isArray(P.stages) || P.stages.length < 3) {
    el.className = 'verdict t-flat';
    el.innerHTML =
      `<div class="vd-head"><div class="vd-action">读数不可用</div>` +
      `<span class="badge neutral">${s.regime ? '该标的缺少技术面读数' : '宏观方向层未接入'}</span></div>` +
      `<div class="vd-note">方向层缺席时整套流程停摆 —— 宁可漏做，不可乱做。</div>`;
    return;
  }

  const [s1, s2, s3] = P.stages;
  const bn = P.bottleneck || {};
  const km = VD_KIND[bn.kind] || { tone: 't-flat', act: '只观察', badge: 'neutral' };

  /* 方向决定色条：多头红、空头绿（中国习惯）。
   * 「不做」的状态刻意用灰/琥珀而不是红绿 —— 红绿是「有方向」的信号，
   * 给「观望」上红绿会让它看起来像一个建议。 */
  const longSide = s1.direction === 'LONG_ONLY' || s3.isLong === true;
  let tone = km.tone;
  if (bn.kind === 'READY' || bn.kind === 'MANAGE') tone = longSide ? 't-buy' : 't-sell';

  let action = km.act;
  if (bn.kind === 'EXIT') action = s3.urgency === 'IMMEDIATE' ? '立刻离场（市价）' : '该离场（收盘确认）';
  else if (bn.kind === 'READY') action = longSide ? '做多 · 可以开单' : '做空 · 可以开单';
  el.className = `verdict ${tone}`;

  const rows = [];

  /* ① 方向 —— 阶段一的结论 */
  if (s1.status === 'ABSENT') {
    rows.push(vdRow('① 方向', '<span class="muted">方向层数据缺失 —— 全流程停摆</span>', '不开新仓'));
  } else if (!s1.pass) {
    rows.push(vdRow('① 方向', '不批准任何方向 · <b>不开新仓</b>', '方向未定'));
  } else {
    const side = longSide ? '<b class="b-up">做多</b>' : '<b class="b-down">做空</b>';
    const gate = s1.allows && !s1.allows.long && !s1.allows.short ? ' <span class="muted">（位置闸门还关着）</span>' : '';
    rows.push(vdRow('① 方向', `只批准${side}${gate}`, `置信度 ${s1.confidence || '—'}`));
  }

  /* ② 开单 —— 阶段二的结论 */
  rows.push(vdRow('② 开单', vdEntryRow(s1, s2), vdEntryAux(s2)));

  if (!s3.applicable) {
    /* 阶段三整段不适用时合成一行 —— 不留三行「不适用」 */
    rows.push(vdRow('③ 持仓', '<span class="muted">当前无持仓 —— 止损 / 加仓 / 止盈均不适用</span>', ''));
  } else {
    /* ③ 止损 */
    const rec = s3.stop?.recommended;
    if (rec) {
      /* 「亏 0.00% 权益」不是读数错误，是仓位很小时的舍入结果 ——
       * 但印成 0.00% 会被读成「这个止损没有成本」，那是错的。
       * 小到两位小数看不见时明说「小于」；真的是 0 才写 0。
       * 判据用 wei 的零花钱数（rec.loss）而不是百分比：百分比在这一档已经被截断成 0，
       * 拿它去判「是不是真的没亏损」会把「很小」和「没有」混为一谈。 */
      const eq =
        rec.lossPctEquity === null || rec.lossPctEquity === undefined
          ? ''
          : rec.loss === 0n
            ? '亏 0'
            : rec.lossPctEquity < 0.00005
              ? '亏 <0.01% 权益'
              : `亏 ${pct(rec.lossPctEquity)}权益`;
      rows.push(
        vdRow(
          '③ 止损',
          `<b>${fmtPrice(wad(rec.price))}</b> <span class="muted">${esc(rec.label)}</span>${s3.stop?.breached ? ' <span class="badge bad">已击穿</span>' : ''}`,
          `距现价 ${num(rec.distancePct)}%${eq ? ' · ' + eq : ''}`
        )
      );
    } else {
      rows.push(vdRow('③ 止损', '<span class="muted">没有可用的止损候选（止损位条件不满足）</span>', ''));
    }

    /* ④ 加仓 —— 被哪一道门挡住就写哪一道，不写笼统的「条件不满足」。
     * 三道门的修法完全不同：方向未定要等方向，浮盈不够只能等，时机未到只能等回撤。 */
    const roll = s3.roll || {};
    const ladder = roll.ladder || [];
    const ladderAux = ladder.length ? `第 ${ladder.length} 档 @ ${fmtPrice(wad(ladder[0].triggerPrice))}` : '未生成阶梯';
    if (s3.canAdd) {
      rows.push(vdRow('④ 加仓', `<b>可以加仓</b> —— 浮盈 ${pct(roll.profitPct)}，且回撤后已起势`, ladderAux));
    } else if (s3.addBlockedBy === 'DIRECTION') {
      /* 方向未定时不谈加仓 —— 否则会出现「卡在阶段一」与「可以加仓」同屏自相矛盾。
       * 注意这里不报浮盈读数：报了就等于在暗示「浮盈够了就能加」，那是错的。 */
      rows.push(vdRow('④ 加仓', '<span class="muted">不加仓 —— 方向未定，这一轮只做风控与离场</span>', ''));
    } else if (!ladder.length) {
      rows.push(vdRow('④ 加仓', '<span class="muted">暂不加仓 —— 浮盈未到第一道门</span>', `浮盈 ${pct(roll.profitPct)}`));
    } else if (!roll.profitOk) {
      rows.push(vdRow('④ 加仓', `<span class="muted">暂不加仓 —— 浮盈未达 ${fmtBps(roll.triggerBps || 0)}</span>`, `当前 ${pct(roll.profitPct)}`));
    } else {
      rows.push(vdRow('④ 加仓', '<span class="muted">暂不加仓 —— 回撤后还没重新起势</span>', ladderAux));
    }

    /* ⑤ 离场 —— 紧急度决定市价单还是收盘价单。
     * 价位只放在右侧读数里：第 ③ 行已经给过止损价，中轨与止损位只差一个缓冲，
     * 同一张卡里出现两个都叫「中轨」的数字（80604 / 80846）比少给一个更糟。
     * 正文只说**条件**，数字留给 aux。 */
    const ex = s3.exitSignals || {};
    const mid = ex.bandBroken?.trigger;
    const r3 = (s3.takeProfit?.rMultiples || [])[2];
    const midAux = mid ? `中轨 ${fmtPrice(wad(mid))}` : '';
    if (s3.urgency === 'IMMEDIATE') {
      /* IMMEDIATE 有两条独立来源：重大利空、止损击穿。
       * 旧代码无条件取 newsExit.reason，在止损击穿时会推给「重大利空」。 */
      const why = ex.newsExit?.active
        ? ex.newsExit.reason || '重大利空'
        : '止损已击穿 —— 立刻走，不要把止损往不利方向挪';
      rows.push(vdRow('⑤ 离场', `<b>立刻离场（市价单）</b> —— ${esc(why)}`, '不等技术位'));
    } else if (s3.urgency === 'ON_CLOSE') {
      rows.push(
        vdRow(
          '⑤ 离场',
          `<b>收盘离场</b> —— ${esc(
            ex.bandBroken?.active ? '收盘已跌破中轨，趋势破坏' : ex.failedBounce?.reason || '调整后没有反弹'
          )}`,
          midAux
        )
      );
    } else if (ex.failedBounce?.failedBounce) {
      rows.push(vdRow('⑤ 离场', '<b>「调整后不反弹」已触发 —— 该走了</b>', midAux));
    } else {
      rows.push(
        vdRow(
          '⑤ 离场',
          '持有 —— 收盘跌破中轨 或「调整后不反弹」才走',
          [midAux, r3 ? `3R 参考 ${fmtPrice(wad(r3.price))}` : '不设固定止盈'].filter(Boolean).join(' · ')
        )
      );
    }
  }

  const badges = [`<span class="badge ${km.badge}">${esc(P.headline)}</span>`];
  /* 这三条都是「结果有保留」的提示，必须和结论同屏：
   * 一条说「有几项取不到数据、系统不会替你猜」，一条说 M1~M6 到底有没有读数，
   * 另一条说「离场通道当前是失效的」。
   * 它们放进折叠区就等于没写 —— 用户看到结论就不会再往下点。 */
  const manual = (s1.manualPending || []).length;
  if (manual) badges.push(`<span class="badge warn">${manual} 项待人工确认</span>`);

  /* M1~M6 宏观与基本面读数。
   * 以前这 6 条恒为「待人工」（没有数据源），现在全部自动采集。
   * 但报的是**几项真有数据**，而不是笼统的"已接入" ——
   * 数据源挂掉时 available 会掉下来，那时这个角标就是唯一的第一屏警示。 */
  const ms = s1.macroSummary;
  if (ms && ms.total) {
    const votes = [ms.voteLong ? `多 ${ms.voteLong}` : '', ms.voteShort ? `空 ${ms.voteShort}` : ''].filter(Boolean).join(' / ');
    badges.push(
      `<span class="badge ${ms.abstain === 0 ? 'info' : 'warn'}">宏观 M1~M6 ${ms.available}/${ms.total}${ms.abstain ? ` · ${ms.abstain} 项弃权` : ''}${votes ? ` · ${votes}` : ''}</span>`
    );
  }
  if (s3.newsStale) badges.push('<span class="badge bad">离场通道口径不一致</span>');

  el.innerHTML =
    `<div class="vd-head"><div class="vd-action">${esc(action)}</div>${badges.join('')}</div>` +
    `<div class="vd-rows">${rows.join('')}</div>` +
    `<div class="vd-note">理由：${mdt(bn.reason || '—')}</div>`;
}

/** 折叠组的右侧状态小字 —— 收起时也知道里面是什么结果，不用点开。 */
function renderFoldStates(s) {
  const set = (id, txt, cls = '') => {
    const e = $(id);
    if (!e) return;
    e.textContent = txt || '';
    e.className = `fold-state ${cls}`;
  };
  const P = s.pipeline;
  const c = P?.criteria || {};
  const manual = (c.manualPending || []).length;
  set('fold-pipeline-state', P ? `${c.total ?? '—'} 条判据${manual ? ` · ${manual} 条待人工` : ''}` : '读数不可用', manual ? 'warn' : '');

  const [s1, s2] = P?.stages || [];
  set('fold-strategy-state', s2 ? (STAGE_META[2][s2.status] || {}).txt || '' : '', s2?.status === 'SIGNAL' && s2.executable ? 'ok' : '');

  set('fold-macro-state', s.regime?.biasLabel || (s.regime ? '' : '未接入'), s.regime ? '' : 'warn');

  set('fold-account-state', s.account ? `权益 $${fmtWad(wad(s.account.accountValue), 2)}` : '');
}

/* ─────────────────────── 渲染：持仓风控 ─────────────────────── */

function renderPositions(s) {
  $('positions-note').textContent = `${s.positions.length} 个持仓`;

  /* 无持仓时整卡隐藏，而不是显示一张写着「当前无持仓」的空卡。
   * 空卡片也是卡片 —— 它会占据首屏最有价值的位置，只为了说一句
   * 结论卡第 ③ 行已经说过的话。
   *
   * 注意仍然把内容写进去再隐藏，而不是留空：卡片被隐藏是「呈现层的选择」，
   * 面板里有没有内容才是「数据层的事实」。两者混在一起会让「隐藏」变成
   * 「这个面板永远不会渲染」—— 以后想把它放出来时会得到一个空卡片。 */
  if (!s.positions.length) {
    $('position-card')?.classList.add('hidden');
    $('positions').innerHTML = '<div class="tbl-empty">当前无持仓</div>';
    return;
  }
  $('position-card')?.classList.remove('hidden');

  const eq = wad(s.account.accountValue);
  const rows = s.positions
    .map((p, idx) => {
      const unreal = wad(p.unrealizedPnl);
      const val = wad(p.positionValue);
      const exposure = eq > 0n ? Number((val * 10000n) / eq) / 10000 : 0;
      // 优先用实时中间价（WebSocket 推送，十进制串 → dec），
      // 回落到快照里的 markPx（后端已转成 WAD → wad）。两者形态不同，不能混用一个转换函数。
      const mark = state.mids[p.coin] ? dec(state.mids[p.coin]) : p.markPx ? wad(p.markPx) : null;
      const liq = p.liquidationPx ? wad(p.liquidationPx) : null;

      let liqTxt = '—';
      let liqBar = '';
      if (liq && mark) {
        const d = p.isLong ? mark - liq : liq - mark;
        const ratio = Number((d * 10000n) / mark) / 10000;
        // 距清算越近越危险：<5% 红、<15% 黄
        const level = ratio < 0.05 ? 'bad' : ratio < 0.15 ? 'warn' : 'ok';
        liqTxt = `<span class="badge ${level}">${(ratio * 100).toFixed(2)}%</span>`;
        const w = Math.max(2, Math.min(100, (ratio / 0.5) * 100));
        const color = ratio < 0.05 ? 'var(--up)' : ratio < 0.15 ? '#d4a72c' : 'var(--down)';
        liqBar = `<div class="bar" title="距清算 ${(ratio * 100).toFixed(2)}%（满格代表 50%）"><i style="width:${w}%;background:${color}"></i></div>`;
      } else if (mark) {
        liqTxt = '<span class="badge neutral" title="全仓保证金且保证金充足时接口不返回清算价">未给出</span>';
      }

      const lev = p.leverage ? `${p.leverage.value}x ${p.leverage.type === 'cross' ? '全仓' : '逐仓'}` : '—';
      const warnCount = (p.levels?.warnings || []).length;
      const hasLevels = Boolean(p.levels);

      const main = `<tr>
        <td><b>${esc(p.coin)}</b> <span class="badge ${p.isLong ? 'long' : 'short'}">${p.isLong ? '多' : '空'}</span></td>
        <td>${fmtWad(wad(p.qty), 6)}</td>
        <td>${fmtPrice(wad(p.entryPx))}</td>
        <td>${mark ? fmtPrice(mark) : '—'}</td>
        <td>${liq ? fmtPrice(liq) : '—'}</td>
        <td>${liqTxt}${liqBar}</td>
        <td>${lev}</td>
        <td class="${cls(unreal)}">${sign(unreal)}${fmtWad(unreal, 2)}</td>
        <td>$${fmtWad(val, 2)}</td>
        <td>${pct(exposure, 1)}</td>
        <td>${warnCount ? `<span class="badge warn">${warnCount}</span>` : '<span class="badge ok">✓</span>'}</td>
        <td>${hasLevels ? `<button class="expand-btn" data-expand="${idx}">展开</button>` : '—'}</td>
      </tr>`;

      if (!hasLevels) return main;

      // 展开行：该持仓的策略读数摘要
      const L = p.levels;
      const rec = L.stop?.recommended;
      const nextRoll = (L.roll?.ladder || []).find((x) => !x.reached);
      const tp2 = (L.takeProfit?.rMultiples || [])[1];
      const detail = `<tr class="detail-row" data-detail="${idx}" style="display:none"><td colspan="12"><div class="detail-inner">
        <div class="trend-strip" style="margin-bottom:8px">
          ${setupPips(L)}
          <span class="badge ${L.isLong ? 'long' : 'short'}">${L.isLong ? '做多' : '做空'}</span>
          ${L.gate ? `<span class="badge ${(GATE_META[L.gate.state] || GATE_META.IDLE).cls}">门禁 ${esc(L.gate.state)}</span>` : ''}
          ${L.dirUndecided ? '<span class="badge warn">方向未定</span>' : ''}
        </div>
        <div class="detail-cols">
          <div class="detail-block">
            <div class="dh">止损点</div>
            <div class="db">
              <div><span class="dk">推荐</span><span>${rec ? fmtPrice(wad(rec.price)) : '—'}</span></div>
              <div><span class="dk">距开仓</span><span>${rec ? num(rec.distancePct) + '%' : '—'}</span></div>
              <div><span class="dk">触发后亏损</span><span>${rec && rec.loss !== null ? '$' + fmtWad(wad(rec.loss), 2) : '—'}</span></div>
              <div><span class="dk">占权益</span><span>${rec && rec.lossPctEquity !== null ? pct(rec.lossPctEquity) : '—'}</span></div>
              <div><span class="dk">当前状态</span><span>${L.stop?.breached ? '<span class="badge bad">已击穿</span>' : '<span class="badge ok">安全</span>'}</span></div>
            </div>
          </div>
          <div class="detail-block">
            <div class="dh">滚仓点（浮盈加仓）</div>
            <div class="db">
              <div><span class="dk">当前浮盈</span><span>${pct(L.roll?.profitPct)}</span></div>
              <div><span class="dk">触发阈值</span><span>+${fmtBps(L.roll?.triggerBps)}</span></div>
              <div><span class="dk">可否加仓</span><span>${L.roll?.ready ? '<span class="badge ok">已达阈值</span>' : '<span class="badge neutral">未达</span>'}</span></div>
              <div><span class="dk">下一档触发价</span><span>${nextRoll ? fmtPrice(wad(nextRoll.triggerPrice)) : '已用尽'}</span></div>
              <div><span class="dk">加仓后止损移至</span><span>${nextRoll ? fmtPrice(wad(nextRoll.newStop)) : '—'}</span></div>
            </div>
          </div>
          <div class="detail-block">
            <div class="dh">止盈参考位</div>
            <div class="db">
              <div><span class="dk">2R</span><span>${tp2 ? fmtPrice(wad(tp2.price)) : '—'}</span></div>
              <div><span class="dk">区间等幅投影</span><span>${L.takeProfit?.measuredMove ? fmtPrice(wad(L.takeProfit.measuredMove.target)) : '—'}</span></div>
              <div><span class="dk">动态离场</span><span>${L.takeProfit?.bandTrail ? '收盘跌破中轨 ' + fmtPrice(wad(L.takeProfit.bandTrail.exitTrigger)) : '—'}</span></div>
            </div>
          </div>
          <div class="detail-block">
            <div class="dh">资金费（自开仓）</div>
            <div class="db">
              <div><span class="dk">本期</span><span>${p.cumFunding ? '$' + fmtWad(wad(p.cumFunding.sinceOpen), 3) : '—'}</span></div>
              <div><span class="dk">历史累计</span><span>${p.cumFunding ? '$' + fmtWad(wad(p.cumFunding.allTime), 2) : '—'}</span></div>
              <div><span class="dk">占用保证金</span><span>$${fmtWad(wad(p.marginUsed), 2)}</span></div>
              <div><span class="dk">ROE</span><span>${p.returnOnEquity === null ? '—' : pct(p.returnOnEquity)}</span></div>
            </div>
          </div>
        </div>
        ${
          (L.warnings || []).length
            ? `<div style="margin-top:9px">${L.warnings
                // 走 mdt 而不是 esc：这些告警文案来自策略层，里面带 **强调**（比如
                // 「最新一根就是最低点」）。esc 会把星号原样吐出来，用户直接看到字面 **。
                // mdt 先转义再替换，所以转义这层安全性不会因此丢掉。
                .map((w) => `<div class="warn-item">${mdt(w)}</div>`)
                .join('')}</div>`
            : ''
        }
      </div></td></tr>`;

      return main + detail;
    })
    .join('');

  /* 限高 + 内部滚动：177 个持仓的表如果不封顶，会把下面的 K 线图顶到屏幕外，
   * 而「有多少个持仓」这件事已经写在卡片标题和 KPI 里了，不需要靠表格长度表达。 */
  $('positions').innerHTML = `<div class="tbl-wrap scroll-y"><table>
    <thead><tr>
      <th>标的</th><th>数量</th><th>开仓价</th><th>标记价</th><th>清算价</th><th>距清算</th>
      <th>杠杆</th><th>未实现盈亏</th><th>名义价值</th><th>占权益</th><th>告警</th><th></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;

  $('positions').querySelectorAll('[data-expand]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const row = $('positions').querySelector(`[data-detail="${btn.dataset.expand}"]`);
      const open = row.style.display !== 'none';
      row.style.display = open ? 'none' : '';
      btn.textContent = open ? '展开' : '收起';
    });
  });
}

function trendPips(L) {
  const t = L.trend;
  const cls2 = L.isLong ? 'on-long' : 'on-short';
  const n = t.required;
  const done = Math.max(t.longBreaks, t.shortBreaks);
  let pips = '';
  for (let i = 0; i < n; i++) pips += `<span class="pip ${i < done ? cls2 : ''}"></span>`;
  return `<span class="trend-pips" title="连续有效突破次数">${pips}</span><span class="trend-text">${mdt(t.reason)}</span>`;
}

/* 系统二的进度条 —— 数的是「独立推进腿」，不是「连续收在轨外的根数」。
 * 这两者的差别就是本次架构修正的全部要害：一根长阳连续收在轨外 4 根，
 * 旧口径会数成 4 次突破并直接宣布方向；新口径只算 1 条腿。 */
const HOLD_META = {
  H0: { cls: 'neutral', txt: '未守住' },
  H1: { cls: 'warn', txt: '待确认' },
  H2: { cls: 'ok', txt: '已站稳' },
};

const GATE_META = {
  SIGNAL: { cls: 'ok', txt: '可以开单' },
  ARMED: { cls: 'info', txt: '挂弦待确认' },
  VETOED: { cls: 'bad', txt: '被宏观否决' },
  IDLE: { cls: 'neutral', txt: '不动手' },
};

function setupPips(L) {
  const t = L.trigger;
  if (!t) return trendPips(L); // 兼容：没有触发层数据时退回旧口径展示
  const side = t.side || (L.isLong ? 1 : -1);
  const cls2 = side === 1 ? 'on-long' : 'on-short';
  const n = t.required || 3;
  const done = Math.min(n, side === 1 ? t.longLegs : t.shortLegs);
  let pips = '';
  for (let i = 0; i < n; i++) pips += `<span class="pip ${i < done ? cls2 : ''}"></span>`;
  return `<span class="trend-pips" title="独立推进腿数（两腿之间必须至少收回轨内 1 根）">${pips}</span><span class="trend-text">${mdt(t.reason || '')}</span>`;
}

/* ─────────────────── 渲染：系统一 · 宏观方向层 ───────────────────
 *
 * 这一层与「价格」「当前选的标的」都无关，所以独立成卡、全局只渲染一次。
 * 它存在的唯一理由是回答一个问题：**现在只允许往哪个方向开仓**。
 * 它不回答「什么时候开」—— 那是系统二的事。两套系统的唯一交汇点是门禁。
 */

const BIAS_META = {
  LONG_ONLY: { cls: 'long', txt: '只许做多', hint: '方向层只批准做多 —— 所有做空信号一律被门禁拦下' },
  SHORT_ONLY: { cls: 'short', txt: '只许做空', hint: '方向层只批准做空 —— 所有做多信号一律被门禁拦下' },
  NEUTRAL: { cls: 'neutral', txt: '方向未定', hint: '方向层不表态 —— 不开任何新仓（注意这不是"两个方向都行"）' },
};

/* ─────────────── 比特皇判据清单（静态，只拉一次） ───────────────
 *
 * 这份清单回答用户的原始问题：「比特皇判断大方向的依据都是什么」。
 * 它是**静态**数据 —— 出处、原话、落实方式都不会随行情变化，
 * 所以走独立接口拉一次缓存，不塞进每几秒刷新一次的 /api/snapshot。
 */
let CRITERIA_CACHE = null;
let CRITERIA_PENDING = false;

async function loadCriteria() {
  if (CRITERIA_CACHE || CRITERIA_PENDING) return;
  CRITERIA_PENDING = true;
  try {
    const res = await fetch('/api/regime-criteria');
    const j = await res.json();
    if (j && j.ok) {
      CRITERIA_CACHE = j;
      // 拿到之后补渲染一次 —— 否则用户要等下一个刷新周期才看到判据表。
      // 三张卡都吃这份清单：宏观卡的总表、系统一与系统二的心得对照。
      if (state.snap) {
        renderPanel('macro', () => renderMacro(state.snap));
        renderPanel('trend-match', () => renderTrendMatch(state.snap));
        renderPanel('trade-match', () => renderTradeMatch(state.snap));
      }
    }
  } catch (e) {
    console.error('判据清单加载失败', e);
  } finally {
    CRITERIA_PENDING = false;
  }
}

/* 落实程度徽章 —— 必须能一眼分辨「真跑了」和「只是写在这里」。
 * 把没实现的说成实现了，是这个系统最不该犯的错。 */
const IMPL_META = {
  true: { cls: 'ok', txt: '已实现' },
  partial: { cls: 'warn', txt: '部分落实' },
  false: { cls: 'neutral', txt: '人工维护' },
};

/** 单选一行证据：见顶/见底/中性，或「弃权」——弃权必须显形。
 *
 * ⚠ 正文必须走 `mdt` 而不是 `esc`：证据链是按 Markdown 写的
 * （`**逆周期**`、`**上调** 25bp`、`**下界**`…），只做 HTML 转义会把星号原样印到界面上。
 * `mdt` 内部是先 esc 再替换，所以安全性等价于 esc，不存在注入口子。
 * 这个坑在接 M1~M6 时又踩了一次 —— 同一类错误会在不同渲染点上重复出现，
 * 所以「凡是渲染理由链的地方一律 mdt」应当作为约定固定下来。 */
function evidenceRow(e) {
  const dirTxt = e.dir > 0 ? '见底' : e.dir < 0 ? '见顶' : '中性';
  const dirCls = e.dir > 0 ? 'num-up' : e.dir < 0 ? 'num-down' : 'num-zero';
  if (!e.available) {
    return `<div class="reason-item note"><b>${esc(e.layer)}</b> · <span class="muted">弃权</span> — ${mdt(e.text || '')}</div>`;
  }
  return `<div class="reason-item"><b>${esc(e.layer)}</b> · <span class="${dirCls}">${dirTxt}</span> — ${mdt(e.text || '')}</div>`;
}

function renderMacro(s) {
  const el = $('macro');
  if (!el) return;

  const r = s.regime;
  if (!r) {
    el.innerHTML = `<div class="tbl-empty">宏观方向层不可用：没能取到 BTC 的长周期数据（日/周/月线）。<br/>方向层缺席时系统二一律不开仓 —— 宁可漏做，不可乱做。</div>`;
    return;
  }

  const c = r.clock || {};
  const st = r.structure || {};
  const ev = r.events || {};
  const meta = BIAS_META[r.bias] || BIAS_META.NEUTRAL;
  const intentTxt = c.intent === 'LONG_ONLY' ? '只多' : c.intent === 'SHORT_ONLY' ? '只空' : '不表态';
  const p = [];

  /* ① 结论条 —— 一眼看到"只许做什么" */
  p.push(`<div class="macro-head">
    <span class="badge ${meta.cls} macro-bias">${esc(meta.txt)}</span>
    <span class="badge ${r.confidence === 'HIGH' ? 'ok' : r.confidence === 'MEDIUM' ? 'info' : 'neutral'}">置信度 ${esc(r.confidence || '—')}</span>
    ${r.pendingFlip ? `<span class="badge warn">切换确认中 ${r.stableDays}/${r.confirmDays} 天</span>` : ''}
    ${r.chaseBlocked ? '<span class="badge bad">追高否决生效</span>' : ''}
    <span class="muted">${esc(meta.hint)}</span>
  </div>`);

  /* ② 周期时钟 —— 确定性锚，零自由度 */
  p.push(`<div class="sec">
    <div class="sec-head">
      <h3>周期时钟（减半） <span class="tag">确定性锚 · 不可调参 —— 它只看时间，不看价格</span></h3>
      <span class="badge ${c.intent === 'LONG_ONLY' ? 'long' : c.intent === 'SHORT_ONLY' ? 'short' : 'neutral'}">许可方向 ${esc(intentTxt)}</span>
    </div>
    <div>
      <div class="kv"><span class="k">距上次减半</span><span class="v">${num(c.monthsSince, 1)} 个月<span class="muted">（${esc(c.last?.date || '—')} · 第 ${c.last?.block ?? '—'} 区块）</span></span></div>
      <div class="kv"><span class="k">距下次减半</span><span class="v">${c.monthsToNext === null || c.monthsToNext === undefined ? '—' : num(c.monthsToNext, 1) + ' 个月'}<span class="muted">${c.next?.estimated ? '（估）' : ''}</span></span></div>
      <div class="kv"><span class="k">当前相位</span><span class="v">${esc(c.label || '—')}</span></div>
      <div class="kv"><span class="k">相位进度</span><span class="v">${c.progress === null || c.progress === undefined ? '—' : pct(Math.max(0, Math.min(1, c.progress)), 0)}</span></div>
    </div>
    ${c.note ? `<div class="sec-note">${mdt(c.note)}</div>` : ''}
  </div>`);

  /* ③ 长周期结构 —— 四分量加权，唯一有权推翻周期相位的地方 */
  const compRows = (st.components || [])
    .map((x) => {
      const vCls = x.vote > 0 ? 'num-up' : x.vote < 0 ? 'num-down' : 'num-zero';
      const vTxt = x.vote > 0 ? '多' : x.vote < 0 ? '空' : '弃权';
      return `<tr class="${x.vote === 0 ? 'dim' : ''}">
        <td style="text-align:left">${esc(x.label)}</td>
        <td>${num(x.weight, 1)}</td>
        <td class="${vCls}">${vTxt}</td>
        <td style="text-align:left"><span class="muted">${mdt(x.detail || '')}</span></td>
      </tr>`;
    })
    .join('');

  const verdictBadge =
    st.verdict === 'BULL' ? '<span class="badge long">多头结构</span>'
    : st.verdict === 'BEAR' ? '<span class="badge short">空头结构</span>'
    : '<span class="badge neutral">结构不明</span>';

  p.push(`<div class="sec">
    <div class="sec-head">
      <h3>长周期结构（周/月线） <span class="tag">四分量加权后归一化到 −1 ~ +1，|值| ≥ 0.2 才表态</span></h3>
      ${verdictBadge}
    </div>
    <div class="tbl-wrap"><table class="lvl-table">
      <thead><tr><th style="text-align:left">分量</th><th>权重</th><th>投票</th><th style="text-align:left">读数</th></tr></thead>
      <tbody>${compRows || '<tr><td colspan="4" class="tbl-empty">无可用分量</td></tr>'}</tbody>
    </table></div>
    <div class="sec-note">
      加权得分 <b>${num(st.score, 2)}</b> / 权重和 5.5 → 归一化 <b>${num(st.normalized, 3)}</b>，有效分量 ${st.usable ?? '—'} 个。
      月线只用<strong>已收盘</strong>的那根 —— 当月的跳空不参与判定，避免前视偏差。
    </div>
  </div>`);

  /* ④ 位置修饰 —— 回撤只作信息，禁多判据看"离均线多远" */
  const ext = st.extensionVs200d;
  const chaseMax = st.chaseMaxExtensionPct;
  p.push(`<div class="sec">
    <div class="sec-head"><h3>位置修饰 <span class="tag">不改方向，只决定"这个位置能不能进场"</span></h3>
      ${st.chaseForbidden ? '<span class="badge bad">过热 · 禁多</span>' : '<span class="badge ok">未过热</span>'}
    </div>
    <div>
      <div class="kv"><span class="k">离历史最高</span><span class="v">${pct(st.drawdownPct)}<span class="muted"> · ${esc(st.drawdownZone === 'NEAR_ATH' ? '顶部区' : st.drawdownZone === 'CORRECTION' ? '回调区' : st.drawdownZone === 'DEEP' ? '深度回撤' : '—')}</span></span></div>
      <div class="kv"><span class="k">高于 200 日均线</span><span class="v">${pct(ext)}<span class="muted"> / 上限 ${pct(chaseMax, 0)}</span></span></div>
    </div>
    <div class="sec-note">
      追高禁令的判据是<strong>「高于 200 日均线的幅度」</strong>，不是「离历史最高多近」。
      牛市里价格本来就该贴着最高点走，用回撤当判据会把整段主升浪封死 —— 那是代价最高的误伤。
      回撤数据仍会展示，但它只是信息，不参与否决。
    </div>
  </div>`);

  /* ⑤ 事件层 —— 只做修正项与黑天鹅闸门 */
  const activeItems = (ev.items || []).filter((x) => Math.abs(x.effective) >= 0.1);
  p.push(`<div class="sec">
    <div class="sec-head"><h3>大事件层 <span class="tag">按半衰期衰减 · 只做修正项，不单独决定方向</span></h3>
      ${ev.shock?.active ? '<span class="badge bad">黑天鹅冷却中</span>' : `<span class="badge ${ev.net > 0.3 ? 'long' : ev.net < -0.3 ? 'short' : 'neutral'}">净权重 ${ev.net > 0 ? '+' : ''}${num(ev.net, 2)}</span>`}
    </div>
    ${ev.shock?.active ? `<div class="callout bad">${mdt(ev.shock.detail)}</div>` : ''}
    ${
      activeItems.length
        ? `<div class="tbl-wrap"><table class="lvl-table">
            <thead><tr><th style="text-align:left">事件</th><th>日期</th><th>原始权重</th><th>当前有效</th></tr></thead>
            <tbody>${activeItems
              .map(
                (x) => `<tr>
                <td style="text-align:left">${esc(x.note || x.id)}</td>
                <td>${esc(x.date)}</td>
                <td>${num(x.weight, 2)}</td>
                <td class="${x.effective > 0 ? 'num-up' : 'num-down'}">${x.effective > 0 ? '+' : ''}${num(x.effective, 3)}</td>
              </tr>`
              )
              .join('')}</tbody></table></div>`
        : `<div class="tbl-empty">事件表里目前没有仍在起作用的条目。<span class="muted">（事件表是维护型数据，2025 年之后的条目需要手工补充 —— 系统不会替你去猜。）</span></div>`
    }
  </div>`);

  /* ⑥ 迟滞说明 + 判定理由 */
  const notes = [...(r.hysteresisNotes || [])];
  p.push(`<div class="sec">
    <div class="sec-head"><h3>判定理由 <span class="tag">方向层必须能自我解释 —— 否则你无法判断该不该信它</span></h3>
      <span class="muted" style="font-size:11.5px">已成立 ${r.stableDays ?? '—'} 天 · 最短持有 ${r.minHoldDays ?? '—'} 天</span>
    </div>
    <div class="reason-list">
      ${(r.reasons || []).map((x) => `<div class="reason-item">${mdt(x)}</div>`).join('') || '<div class="tbl-empty">无</div>'}
      ${notes.map((x) => `<div class="reason-item note">${mdt(x)}</div>`).join('')}
    </div>
  </div>`);

  /* ⑦ 周期相位 —— 自动推算要显形，人工与推算不一致时更要显形。
   *
   * 为什么"自动"也要在界面上写一行：相位是**唯一与价格无关**的输入，
   * 它决定方向层只许往哪边，也决定波动门槛的下限。一个不显示的自动值
   * 等于让用户去猜「系统认为现在是牛还是熊」—— 而那正是他最该知道的事。
   * 反过来，自动模式本身是正常状态，所以用 info 而不是 warn。 */
  const pc = s.phaseCheck;
  if (pc && pc.stale) {
    p.push(`<div class="callout warn" style="margin:10px 13px 13px">
      <b>周期相位对账不一致</b>：查询参数手填的是「${esc(pc.manual)}」，而减半时钟推算出的是「${esc(pc.derived)}」（距上次减半 ${num(pc.monthsSince, 1)} 个月）。
      当前以人工值优先，但这意味着波动门槛可能偏离真实的周期位置。${mdt(pc.detail || '')}
    </div>`);
  } else if (pc && pc.unknown) {
    /* 显式传了一个不认识的相位 —— 输入被拒了，必须说，
     * 否则用户以为自己指定了相位，实际用的是时钟值。 */
    p.push(`<div class="callout warn" style="margin:10px 13px 13px">${mdt(pc.detail || '')}</div>`);
  } else if (pc && pc.auto) {
    p.push(`<div class="callout info" style="margin:10px 13px 13px">
      <b>周期相位：自动（${esc(pc.derivedLabel || pc.derived)}）</b> —— 由减半时钟推算，距上次减半 ${num(pc.monthsSince, 1)} 个月，
      不是手填值。方向层与波动门槛都按这一相位取值，不存在两处不一致。
    </div>`);
  }

  /* ⑧ 判据层读数 —— 比特皇原话的落点（A4 技术面 / A5 拥挤度 / A6 量能 / A7 事件反应）
   *
   * 这四层与 A1 时钟、A2 结构是**正交**的：它们全部回答「反转有没有在发生」，
   * 而不是「现在该往哪边」。所以它们只产出两件事：
   *   · topBrake      —— 禁止顺势加多的第二道闸（与追高禁令并列）
   *   · bottomConfirm —— 方向已许可做多时抬高置信度
   * 它**不会**把 NEUTRAL 变成 LONG_ONLY。比特皇原话里「在比特币减半的大前提下」
   * 是这半句话的硬约束，脱离周期谈极端情绪等于丢掉判据本身。 */
  const tech = r.technicals || null;
  const sent = r.sentiment || null;
  const vol = r.volume || null;
  const rx = r.reaction || null;
  const rev = r.reversal || null;

  if (tech || sent || vol || rx) {
    const verdictBadge = tech
      ? tech.bearSignal
        ? '<span class="badge bad">牛转熊确认</span>'
        : tech.bearPending
          ? '<span class="badge warn">牛转熊待确认</span>'
          : tech.verdict === 'ABOVE_MA120'
            ? '<span class="badge long">站上 120 日线</span>'
            : tech.verdict === 'BELOW_MA120'
              ? '<span class="badge short">跌破 120 日线</span>'
              : '<span class="badge neutral">技术面弃权</span>'
      : '<span class="badge neutral">无数据</span>';

    const voteTxt = (v) => (v > 0 ? '<span class="num-up">投多</span>' : v < 0 ? '<span class="num-down">投空</span>' : '<span class="num-zero">不表态</span>');

    p.push(`<div class="sec">
      <div class="sec-head">
        <h3>判据层读数（A4~A7） <span class="tag">比特皇原话的落点 · 只用于「刹车 / 确认」，不翻方向</span></h3>
        ${verdictBadge}
        ${r.topBrake ? '<span class="badge bad">顶部刹车生效</span>' : ''}
        ${rev?.bottomConfirm ? '<span class="badge ok">底部确认</span>' : ''}
      </div>

      <div class="tbl-wrap"><table class="lvl-table">
        <thead><tr><th style="text-align:left">层</th><th style="text-align:left">读数</th><th>票</th><th style="text-align:left">说明</th></tr></thead>
        <tbody>
          <tr class="${tech && !tech.available ? 'dim' : ''}">
            <td style="text-align:left">A4 技术面</td>
            <td style="text-align:left">${
              tech && tech.available
                ? `120 日线 ${num(tech.ma120, 0)}（<b>${pct(tech.extensionVsMa120)}</b>）· 回撤 ${pct(tech.drawdownPct)} · ${tech.monthsSinceNewHigh ?? '—'} 个月未创新高`
                : '<span class="muted">弃权</span>'
            }</td>
            <td>${tech ? voteTxt(tech.vote) : '<span class="num-zero">弃权</span>'}</td>
            <td style="text-align:left"><span class="muted">${mdt(tech?.detail || '日线不足 120 根')}</span></td>
          </tr>
          <tr class="${sent && !sent.available ? 'dim' : ''}">
            <td style="text-align:left">A5 情绪拥挤度</td>
            <td style="text-align:left">${
              sent && sent.available
                ? `${esc(
                    sent.crowding === 'SHORT_CROWDED' ? '散户极度做空' : sent.crowding === 'LONG_CROWDED' ? '多头拥挤' : '无极端'
                  )} · 费率 <b>${num(sent.percentile, 1)} 分位</b> · 价格 ${esc(
                    sent.priceHolding === 'RANGE' ? '已止跌横盘' : sent.priceHolding === 'STILL_FALLING' ? '仍在创新低' : '仍在创新高'
                  )}`
                : '<span class="muted">弃权</span>'
            }</td>
            <td>${sent && sent.available ? voteTxt(sent.vote) : '<span class="num-zero">弃权</span>'}</td>
            <td style="text-align:left"><span class="muted">${mdt(sent?.detail || sent?.reason || '')}</span></td>
          </tr>
          <tr class="${vol && !vol.available ? 'dim' : ''}">
            <td style="text-align:left">A6 量能形态</td>
            <td style="text-align:left">${
              vol && vol.available
                ? `${esc(
                    vol.pattern === 'CAPITULATION_VOLUME' ? '投降式放量' :
                    vol.pattern === 'BLOWOFF_VOLUME' ? '顶部放量' :
                    vol.pattern === 'DRY_BOTTOM' ? '缩量筑底' : '量能常态'
                  )} · <b>${num(vol.volPercentile, 0)} 分位</b> · 均量比 ${num(vol.volRatio, 2)}`
                : '<span class="muted">弃权</span>'
            }</td>
            <td>${vol && vol.available ? voteTxt(vol.vote) : '<span class="num-zero">弃权</span>'}</td>
            <td style="text-align:left"><span class="muted">${mdt(vol?.detail || vol?.reason || '')}</span></td>
          </tr>
          <tr class="${rx && !rx.available ? 'dim' : ''}">
            <td style="text-align:left">A7 事件反应</td>
            <td style="text-align:left">${
              rx && rx.available
                ? `已检验 ${rx.total} 条 · 利空不跌 <b>${rx.bearishNotFalling}</b> · 利多不涨 <b>${rx.bullishNotRising}</b>`
                : '<span class="muted">弃权</span>'
            }</td>
            <td>${rx && rx.available ? voteTxt(rx.vote) : '<span class="num-zero">弃权</span>'}</td>
            <td style="text-align:left"><span class="muted">${mdt(rx?.detail || rx?.reason || '')}</span></td>
          </tr>
        </tbody>
      </table></div>

      ${rev ? `<div class="sec-note">
        <b>合成</b>：见顶票 ${rev.topVotes} / 见底票 ${rev.bottomVotes}（门槛 ${rev.minVotes}）。
        顶部刹车 = <b>${rev.topBrake ? '生效' : '未生效'}</b>，底部确认 = <b>${rev.bottomConfirm ? '成立' : '未成立'}</b>。
        减半大前提：<b>${rev.inHalvingPremise ? '在窗口内' : '不在窗口内'}</b> —— 不在窗口内时，见底证据不足以翻转方向。
      </div>` : ''}

      ${rev?.evidence?.length ? `<div class="reason-list" style="margin-top:8px">
        ${rev.evidence.map(evidenceRow).join('')}
      </div>` : ''}

      ${rev?.notes?.length ? `<div class="reason-list" style="margin-top:6px">
        ${rev.notes.map((n) => `<div class="reason-item note">${mdt(n)}</div>`).join('')}
      </div>` : ''}
    </div>`);
  }

  /* ⑧b 宏观与基本面读数（M1~M6）—— 自动采集，非手工维护
   *
   * 这一段是**后加的**：这 6 条判据原先标注 `implemented:false`，理由是
   * 「没有免费且无需密钥的数据源」。经逐条实测，这句话是错的 —— 六个源全部
   * 有免费公开入口（详见 src/macro-sources.js 的 MACRO_SOURCES 目录）。
   *
   * 三个必须显示出来的东西，缺一个这张表就不该存在：
   *   · provider + asOf —— 谁的数据、什么时候的
   *   · status          —— ok / stale（数据过期但可用）/ unavailable
   *   · 票              —— 它对 topBrake / bottomConfirm 投了什么
   * 只显示结论不显示出处，读的人无法判断该不该信。
   */
  const mrc = s.macro;
  if (mrc?.readings?.length) {
    const voteBadge = (v) => (v > 0 ? '<span class="num-up">多</span>' : v < 0 ? '<span class="num-down">空</span>' : '<span class="num-zero">—</span>');
    const statusBadge = (st, staleDays) =>
      st === 'ok' ? '<span class="badge ok">新鲜</span>'
      : st === 'stale' ? `<span class="badge warn">数据滞后${staleDays != null ? ` ${staleDays} 天` : ''}</span>`
      : '<span class="badge bad">取不到</span>';
    /* 趋势单元：折线 + 「起点 → 现值（变化）· N 天」。
     * 不足 2 天就明说「仅 1 天记录」，不画一条只有一个点的假折线 ——
     * 单点连不成趋势，画出来只会让人以为"波动很小"。 */
    const hist = s.macroHistory || {};
    /* 小数位按**单位**定，而不是只看数量级。
     * 踩过的坑：M6 的数值是「官方净条目数」（整数，通常 0~3），
     * 只按数量级判断会走到 dp=2 的分支，印出「0.00 → 1.00」这种噪音 ——
     * 一个计数不该有小数点。 */
    const dpFor = (unit, v) => {
      const u = String(unit || '');
      if (u.startsWith('条') || u.startsWith('指数') || u.startsWith('USD')) return 0;
      if (Math.abs(v) >= 1000) return 0;
      if (Math.abs(v) >= 100) return 1;
      return 2;
    };
    const trendCell = (id, unit) => {
      const pts = (hist[id] || []).filter((p) => p && Number.isFinite(p.value));
      if (pts.length < 2) {
        return `<span class="muted" style="font-size:11px">${pts.length === 1 ? '仅 1 天记录' : '暂无历史'}</span>`;
      }
      const first = pts[0].value;
      const last = pts[pts.length - 1].value;
      const delta = last - first;
      const dp = dpFor(unit, last);
      const sign = delta > 0 ? '+' : '';
      return `${sparkline(pts)}
        <div class="muted" style="font-size:11px;white-space:nowrap">${first.toFixed(dp)} → ${last.toFixed(dp)}（${sign}${delta.toFixed(dp)}）· ${pts.length} 天</div>`;
    };
    const rows = mrc.readings
      .map((m) => {
        const src = mrc.sources?.[{
          'media-extreme': 'fearGreed', 'etf-netflow': 'etfFlow', 'onchain-activity': 'onchain',
          'liquidity-macro': 'liquidity', 'institutional-holding': 'institutional', 'regulation-policy': 'regulatory',
        }[m.id]] || {};
        return `<tr class="${m.available ? '' : 'dim'}">
          <td style="text-align:left">${esc(m.layer || '')} ${esc(m.name || m.id)}</td>
          <td>${m.available ? voteBadge(m.vote) : '<span class="num-zero">弃权</span>'}</td>
          <td class="col-reason" style="text-align:left"><span class="muted">${mdt(m.reason || '')}</span></td>
          <td class="col-trend" style="text-align:left">${trendCell(m.id, m.unit)}</td>
          <td class="col-src" style="text-align:left">${statusBadge(src.status || (m.available ? 'ok' : 'unavailable'), src.staleDays)}<br/>
            <span class="muted" style="font-size:11px">${esc(src.provider || m.provider || '—')}</span>
            ${src.asOf || m.asOf ? `<br/><span class="muted" style="font-size:11px">数据日期 ${esc(src.asOf || m.asOf)}</span>` : ''}
          </td>
        </tr>`;
      })
      .join('');
    const avail = mrc.readings.filter((m) => m.available).length;
    // 历史库摘要 —— 只有真的攒到数据才写这一行；库打不开时它会静默消失，
    // 因为「没有历史库」不该在界面上被渲染成一个错误。
    const storeInfo = (() => {
      const st = s.macroStore;
      if (!st || !st.days) return '';
      return `历史库（<code>${esc(st.backend)}</code>）：${st.days} 天 / ${st.rows} 行 · ${esc(st.firstDay || '—')} ~ ${esc(st.lastDay || '—')}`;
    })();
    /* 采集降级必须显形 —— 「六个源全取不到」与「市场确实平静」在票面上
     * 都是六个 0，但一个不可信、一个可信，不能长得一样。
     * 注意措辞：方向结论本身不受影响（M1~M6 只投票、不是方向开关），
     * 受影响的是「这六条证据这次没参与」这件事的可信度。 */
    const degradedNote = mrc.degraded
      ? `<div class="callout warn" style="margin:10px 13px 0">
          <b>宏观读数本次降级</b>：${esc(mrc.degraded)}。下面六条全部记为「弃权」——
          方向层是在<b>缺这六票</b>的情况下算出来的。结论本身照常有效（M1~M6 只投票、不决定方向），
          但别把它们当成「市场平静」的证据。</div>`
      : '';
    p.push(`<div class="sec">
      <div class="sec-head">
        <h3>宏观与基本面读数（M1~M6） <span class="tag">自动采集 · 免费无密钥源 · 与事件表互为补充</span></h3>
        <span class="badge ${avail === mrc.readings.length ? 'ok' : avail ? 'warn' : 'bad'}">${avail}/${mrc.readings.length} 项取到数据</span>
        ${mrc.cached ? '<span class="badge neutral">缓存</span>' : ''}
      </div>
      ${degradedNote}
      <div class="tbl-wrap"><table class="lvl-table macro-table">
        <thead><tr><th style="text-align:left">层</th><th>票</th><th class="col-reason" style="text-align:left">读数</th><th class="col-trend" style="text-align:left">趋势（近 30 天）</th><th class="col-src" style="text-align:left">来源 / 新鲜度</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div class="sec-note">
        这一组是<strong>加分项与刹车项，不是方向开关</strong> —— 它们只投 topBrake / bottomConfirm 两道动作侧信号，
        不会把 NEUTRAL 翻成某个方向。唯一的一票否决通道仍然是黑天鹅 shock。
        每条的数据来源与许可写在 <code>src/macro-sources.js</code> 的 <code>MACRO_SOURCES</code> 里；
        「数据滞后」表示这一级源挂了、回落到更旧的一级（例如 Farside 直连被 Cloudflare 挡住时回落到 CC0 归档）。
        ${storeInfo ? `<br/>${storeInfo} —— 每天由 <code>tools/macro-daily.js</code> 定时写入；<strong>趋势列只有攒够 2 天才会出现</strong>，头一天显示「仅 1 天记录」是正常的。` : ''}
      </div>
    </div>`);
  }

  /* ⑨ 判据总表 —— 回答「比特皇判断大方向的依据到底有哪些」
   *
   * 这张表刻意把「没实现的」也列出来并标成灰色。理由：如果只列已实现的，
   * 看的人会以为判据就这么多。
   *
   * ⚠ 2026-09 更新：原先这里有 6 条标「人工维护」的判据，理由是"没有免费数据源"。
   *    逐条实测后这句话被证伪 —— 六个源全部有免费无密钥入口，已全部接上
   *    （见上面的 M1~M6 表）。所以「人工维护」计数现在应为 0。
   *    如果某天这个数又变成非 0，说明有源退回到了手工维护 —— 那是需要解释的事，
   *    不是正常状态。 */
  const cr = CRITERIA_CACHE;
  if (!cr) {
    loadCriteria();
    p.push(`<div class="sec"><div class="sec-head"><h3>比特皇判据总表</h3></div>
      <div class="tbl-empty">正在加载判据清单……</div></div>`);
  } else {
    const groups = {};
    for (const c of cr.criteria || []) (groups[c.group] ||= []).push(c);
    const implBadge = (v) => {
      const m = IMPL_META[v] || IMPL_META.false;
      return `<span class="badge ${m.cls}">${m.txt}</span>`;
    };
    p.push(`<div class="sec">
      <div class="sec-head">
        <h3>比特皇判据总表 <span class="tag">逐条对应原话 · 已实现 ${cr.implemented} / 部分 ${cr.partial} / 人工维护 ${cr.manual}</span></h3>
        <span class="muted" style="font-size:11.5px">共 ${cr.total} 条</span>
      </div>
      ${Object.entries(groups)
        .map(
          ([g, list]) => `
        <div style="margin:10px 0 4px"><span class="badge info">${esc(g)}</span>
          <span class="muted" style="font-size:11.5px">${list.length} 条</span></div>
        <div class="tbl-wrap"><table class="lvl-table">
          <thead><tr><th style="text-align:left">判据</th><th>落实</th><th style="text-align:left">原话</th><th style="text-align:left">本系统怎么落实</th></tr></thead>
          <tbody>${list
            .map(
              (c) => `<tr class="${c.implemented === false ? 'dim' : ''}">
                <td style="text-align:left"><code>${esc(c.id)}</code><br/><span class="muted" style="font-size:11px">${esc(c.source)}</span></td>
                <td>${implBadge(c.implemented)}</td>
                <td style="text-align:left"><span class="muted">「${esc(c.quote)}」</span></td>
                <td style="text-align:left">${mdt(c.rule)}</td>
              </tr>`
            )
            .join('')}</tbody>
        </table></div>`
        )
        .join('')}
      <div class="sec-note">
        这一列「落实」标的是<strong>判据在当前代码里怎么落地</strong>：已实现 = 有真实数据在跑；
        部分 = 只做了能做到的那部分，剩下是主观判断、拒绝做成参数。
        标灰的行表示该判据当前<strong>取不到数据、处于弃权</strong> ——
        弃权会一直显示出来，不会被当成"没有异议"。
      </div>
    </div>`);
  }

  el.innerHTML = p.join('');
}

/* ─────────────── 渲染：三段流程（① 定方向 → ② 定时点 → ③ 管持仓） ───────────────
 *
 * 这一卡和上面两张卡的区别是**视角**：
 *   · 宏观卡  把「阶段一」讲深（判据、时钟、结构、事件）；
 *   · 策略卡  把「阶段二 / 三」的每一个位讲深（止损候选、滚仓阶梯、止盈 R 倍数）。
 * 而这一卡只回答一个跨段的问题 —— **现在卡在哪一段，为什么**。
 *
 * 三段是**单向依赖**的，所以界面必须把顺序画出来：
 *   阶段一不放行 → 阶段二不产出可执行计划（注意：不是"产出了但标成否决"）
 *   阶段二不放行 → 阶段三只做风控与离场，不谈加仓
 * 这条链如果只写成文字，读的人会以为三段可以并行、可以挑着看。
 */

const STAGE_META = {
  1: {
    DECIDED: { cls: 'ok', txt: '方向已定' },
    NEUTRAL: { cls: 'warn', txt: '方向未定' },
    ABSENT: { cls: 'bad', txt: '方向层缺席' },
  },
  2: {
    SIGNAL: { cls: 'ok', txt: '可以开单' },
    ARMED: { cls: 'info', txt: '挂弦待确认' },
    VETOED: { cls: 'bad', txt: '被宏观否决' },
    IDLE: { cls: 'neutral', txt: '不动手' },
    BLOCKED_BY_STAGE1: { cls: 'warn', txt: '被阶段一挡住' },
    ABSENT: { cls: 'neutral', txt: '读数缺席' },
  },
  3: {
    EXIT: { cls: 'bad', txt: '触发离场' },
    CAN_ADD: { cls: 'ok', txt: '可以加仓' },
    HOLD: { cls: 'info', txt: '持有中' },
    NOT_APPLICABLE: { cls: 'neutral', txt: '无持仓 · 不适用' },
    ABSENT: { cls: 'neutral', txt: '读数缺席' },
  },
};

/* 徽章颜色 → 步骤底色。'on' 是「正在这一步上推演」，'off' 是「这一步还没轮到」。 */
const STAGE_STEP_CLS = { ok: 'ok', bad: 'bad', warn: 'warn', info: 'on', neutral: 'off' };

const BOTTLENECK_CLS = {
  READY: 'k-read', HOLD: 'k-read', MANAGE: 'k-read',
  EXIT: 'k-exit', DATA_MISSING: 'k-exit',
  NO_DIRECTION: 'k-wait', WAIT_TRIGGER: 'k-wait', NO_TRIGGER: 'k-wait', VETOED: 'k-exit', PLAN_BLOCKED: 'k-wait',
};

const URGENCY_META = {
  IMMEDIATE: { cls: 'bad', txt: '立即离场 · 市价单' },
  ON_CLOSE: { cls: 'warn', txt: '收盘确认离场' },
  WATCH: { cls: 'info', txt: '观察中' },
  NONE: { cls: 'neutral', txt: '无离场信号' },
};

/** 阶段一的一句话答案：只说「批了哪个方向」，理由留给下面的证据链。 */
function pipeAnswer1(st) {
  if (st.status === 'ABSENT') return '<span class="muted">没能取到长周期数据，方向无法判定。</span>';
  if (!st.pass) {
    const lead = (st.evidence || [])[0];
    return `不批准任何方向 —— 不开新仓。<br/><span class="muted">${mdt(lead || '')}</span>`;
  }
  const side = st.direction === 'LONG_ONLY' ? '只批准<b>做多</b>' : '只批准<b>做空</b>';
  const gate = st.allows && !st.allows.long && !st.allows.short ? '（但位置/行为闸门当前把新开仓也关上了）' : '';
  return `${side} · 置信度 ${esc(st.confidence || '—')}${esc(gate)}`;
}

/** 阶段二的一句话答案：方向没定时不谈入场点 —— 这是本卡最容易写错的地方。 */
function pipeAnswer2(st) {
  if (st.status === 'ABSENT') return '<span class="muted">K 线不足，无法评估入场时机。</span>';
  if (st.status === 'BLOCKED_BY_STAGE1') {
    return '不评估入场点。<br/><span class="muted">方向没定之前找入场点本末倒置 —— 下面的腿数与收口只当「热度」看。</span>';
  }
  if (st.status === 'SIGNAL') {
    if (st.executable === false) {
      return `形态成立但计划被卡住 —— <span class="muted">${mdt((st.blockers || []).join('；'))}</span>`;
    }
    const mode = st.entryMode === 'PULLBACK' ? '回调入场' : '突破入场';
    return `<b>${esc(mode)}</b> · 分两笔执行（头仓 30% / 主仓 70%，各自独立止损）。`;
  }
  if (st.status === 'ARMED') return `挂弦待确认 —— ${mdt((st.blockers || []).join('；'))}`;
  if (st.status === 'VETOED') return `被否决 —— ${mdt((st.blockers || [])[0] || '')}`;
  return `<span class="muted">${mdt((st.blockers || [])[0] || '没有形成触发。')}</span>`;
}

/** 阶段三的一句话答案：把「紧急度」放最前 —— 它决定市价单还是收盘价单。 */
function pipeAnswer3(st) {
  if (st.status === 'ABSENT') return '<span class="muted">没有持仓读数。</span>';
  if (st.status === 'NOT_APPLICABLE') return '当前无持仓，这一段不适用。';
  if (st.status === 'EXIT') {
    const u = URGENCY_META[st.urgency] || URGENCY_META.NONE;
    return `<b>${esc(u.txt)}</b> —— ${mdt(st.summary || '')}`;
  }
  if (st.status === 'CAN_ADD') {
    const roll = st.roll || {};
    return `可以加仓 —— 浮盈 ${pct(roll.profitPct)}，且回撤后已重新起势。`;
  }
  return '持有中 —— 止损与止盈参考位见下，暂无加仓条件。';
}

function pipeStep(smeta, st, m) {
  const stepCls = STAGE_STEP_CLS[m.cls] || 'off';
  const blocked = st.status === 'BLOCKED_BY_STAGE1' ? ' blocked' : '';
  const answer = [pipeAnswer1, pipeAnswer2, pipeAnswer3][st.stage - 1](st);
  return `<div class="pipe-step ${stepCls}${blocked}">
    <div class="pipe-step-head">
      <span class="pipe-num">${st.stage}</span>
      <span class="pipe-name">${esc(smeta?.name || ('阶段' + st.stage))}</span>
      <span class="badge ${m.cls}">${esc(m.txt)}</span>
    </div>
    <div class="pipe-q">${esc(smeta?.question || '')}</div>
    <div class="pipe-answer">${answer}</div>
    ${smeta?.quote ? `<div class="pipe-quote">「${esc(smeta.quote)}」<br/>—— ${esc(smeta.source || '')}</div>` : ''}
  </div>`;
}

function renderPipeline(s) {
  const el = $('pipeline');
  if (!el) return;

  const P = s.pipeline;
  if (!P || !Array.isArray(P.stages)) {
    el.innerHTML = `<div class="tbl-empty">三段流程读数不可用：${
      !s.regime ? '宏观方向层未接入' : '该标的缺少技术面读数'
    }。<br/>方向层缺席时整套流程停摆 —— 宁可漏做，不可乱做。</div>`;
    return;
  }

  const metas = {};
  for (const x of P.stagesMeta || []) metas[x.index] = x;

  const [s1, s2, s3] = P.stages;
  const m1 = STAGE_META[1][s1.status] || STAGE_META[1].NEUTRAL;
  // SIGNAL 但计划不可执行（空间 / 盈亏比被卡）→ 徽章不能让用户误读成"可以开单"
  const m2 =
    s2.status === 'SIGNAL' && !s2.executable
      ? { cls: 'warn', txt: '计划被门槛卡住' }
      : STAGE_META[2][s2.status] || STAGE_META[2].IDLE;
  const m3 = STAGE_META[3][s3.status] || STAGE_META[3].HOLD;
  const bn = P.bottleneck || {};
  const bnCls = BOTTLENECK_CLS[bn.kind] || 'k-wait';
  const byStage = P.criteria?.byStage || {};
  const p = [];

  /* ① 结论条 —— 整张卡只有这一句在回答「现在该怎么办」，所以给它最强的视觉权重 */
  p.push(`<div class="pipe-verdict ${bnCls}">
    <span class="headline">${esc(P.headline || '状态未知')}</span>
    ${bn.stage ? `<span class="badge ${(STAGE_META[bn.stage] || {})[P.stages[bn.stage - 1].status]?.cls || 'info'}">卡在阶段 ${bn.stage}</span>` : '<span class="badge ok">无卡点</span>'}
    <span class="badge neutral">${esc(bn.kind || '—')}</span>
    <span class="pipe-meta">判据共 ${P.criteria?.total ?? '—'} 条 ·
      全局约束 ${byStage['0'] ?? 0} · 基本面 ${byStage['1'] ?? 0} · 技术面 ${byStage['2'] ?? 0} · 持仓管理 ${byStage['3'] ?? 0}</span>
  </div>`);

  /* ② 三段流程条 —— 箭头是单向的，这个视觉信息本身就是规则 */
  p.push(`<div class="pipe-flow">
    ${pipeStep(metas[1], s1, m1)}
    <div class="pipe-arrow">→</div>
    ${pipeStep(metas[2], s2, m2)}
    <div class="pipe-arrow">→</div>
    ${pipeStep(metas[3], s3, m3)}
  </div>`);

  /* ③ 卡点的完整理由 —— 一句话结论之外，必须能追到具体判据 */
  if (bn.reason) {
    p.push(`<div class="callout ${bnCls === 'k-exit' ? 'bad' : bnCls === 'k-read' ? 'ok' : 'warn'}">
      <b>卡点理由</b>：${mdt(bn.reason)}</div>`);
  }

  /* ④ 阶段一 · 决策契约 —— 批了什么、弃权了什么、还有什么没数据源
   *
   * 这一块与宏观卡的「判定理由」刻意不同粒度：宏观卡解释「为什么是这个读数」，
   * 这里只交代**决策契约**（允许哪一边 / 哪些判据弃权 / 哪些判据只能人工填）。
   * 弃权与人工必须显形 —— 把「没有数据」静默当成「没有异议」，是这个系统最不该犯的错。 */
  const evRows = (s1.evidence || []).map((x) => `<div class="reason-item">${mdt(x)}</div>`).join('');
  const abst = s1.abstentions || [];
  const manual = s1.manualPending || [];
  p.push(`<div class="sec">
    <div class="sec-head">
      <h3>阶段一 · 决策契约 <span class="tag">批了哪一边 / 哪些判据弃权 / 哪些判据只能人工填</span></h3>
      <span class="badge ${s1.pass ? (s1.direction === 'LONG_ONLY' ? 'long' : 'short') : 'neutral'}">${esc(s1.directionLabel || '—')}</span>
    </div>
    <div>
      <div class="kv"><span class="k">允许开多 / 开空</span><span class="v">${s1.allows?.long ? '<span class="num-up">允许</span>' : '<span class="muted">不允许</span>'} / ${s1.allows?.short ? '<span class="num-down">允许</span>' : '<span class="muted">不允许</span>'}</span></div>
      <div class="kv"><span class="k">追高禁令 / 顶部刹车</span><span class="v">${s1.chaseBlocked ? '<span class="badge bad">禁多生效</span>' : '<span class="muted">未触发</span>'} ${s1.topBrake ? '<span class="badge bad">刹车生效</span>' : ''}</span></div>
      <div class="kv"><span class="k">本段判据 / 其中人工</span><span class="v">${s1.criteriaTotal ?? '—'} 条 / ${s1.manualCount ?? 0} 条</span></div>
    </div>
    ${evRows ? `<div class="reason-list">${evRows}</div>` : ''}
    ${abst.length ? `<div class="reason-list" style="margin-top:6px">${abst
      .map((x) => `<div class="reason-item note"><b>${esc(x)}</b> · <span class="muted">本轮弃权（数据不足，未投任何票）</span></div>`)
      .join('')}</div>` : ''}
    ${manual.length ? `<div class="reason-list" style="margin-top:6px">
      <div class="reason-item note"><b>需要人工确认的判据</b>：${esc(manual.join('、'))}
      —— 这几条没有免费且无需密钥的数据源，系统不会替你猜。请对照 <code>config/macro-events.json</code> 手工核。</div>
    </div>` : ''}
  </div>`);

  /* ⑤ 阶段二 · 执行计划（只有方向放行时才可能生效）
   *
   * 关键：不生效时**逐行画出划线**，而不是干脆不画。理由是「挂不上」本身是信息 ——
   * 比特皇原话是「不踏空也不追高满仓」，主仓挂不上就一直挂着，不改成追高。
   * 如果这里隐藏掉，用户会在策略卡看到 30%/70% 的分配，误以为两笔都能成。 */
  const tranches = s2.tranches || [];
  if (tranches.length || s2.status === 'BLOCKED_BY_STAGE1') {
    const rows = tranches
      .map((t) => {
        const off = !t.active;
        const kindTxt = t.triggerKind === 'LIMIT' ? '限价挂单' : '触价市价';
        return `<tr class="${off ? 'tranche-off' : ''}">
        <td style="text-align:left">第 ${t.index} 笔 · ${esc(t.name)}</td>
        <td>${esc(t.side === 'BREAKOUT' ? '突破批' : '回调批')}</td>
        <td>${(t.ratioBps / 100).toFixed(0)}%</td>
        <td>${fmtWad(wad(t.qty), 6)}</td>
        <td>${fmtPrice(wad(t.triggerPrice))}</td>
        <td style="text-align:left">${esc(kindTxt)}</td>
        <td>${fmtPrice(wad(t.stopPrice))}</td>
        <td style="text-align:left"><span class="muted">${esc(t.stopAnchor || '')}</span></td>
        <td>${t.active ? '<span class="badge ok">生效</span>' : '<span class="badge neutral">未生效</span>'}</td>
      </tr>`;
      })
      .join('');

    p.push(`<div class="sec">
      <div class="sec-head">
        <h3>阶段二 · 执行计划 <span class="tag">头仓 30% 突破 + 主仓 70% 回调 · 两笔各自独立止损</span></h3>
        ${s2.executable ? '<span class="badge ok">可执行</span>' : '<span class="badge neutral">不可执行</span>'}
        ${s2.entryMode ? `<span class="badge info">${esc(s2.entryMode === 'PULLBACK' ? '回调入场' : '突破入场')}</span>` : ''}
      </div>
      ${
        rows
          ? `<div class="tbl-wrap"><table class="lvl-table">
              <thead><tr><th style="text-align:left">批次</th><th>类型</th><th>占计划</th><th>数量</th><th>触发价</th><th style="text-align:left">方式</th><th>止损</th><th style="text-align:left">止损锚</th><th>状态</th></tr></thead>
              <tbody>${rows}</tbody></table></div>`
          : '<div class="tbl-empty">方向未放行 —— 入场点根本不该算，所以这里没有计划可列。</div>'
      }
      ${(s2.blockers || []).length ? `<div class="reason-list">${s2.blockers
        .map((x) => `<div class="reason-item note">${mdt(x)}</div>`)
        .join('')}</div>` : ''}
      <div class="sec-note">${esc(s2.trancheNote || '')}</div>
    </div>`);
  }

  /* ⑥ 阶段三 · 持仓管理（只在有持仓时才适用 —— 没持仓时给一句「不适用」，不留空数字） */
  if (s3.applicable) {
    const roll = s3.roll || {};
    const res = roll.resume || {};
    const ex = s3.exitSignals || {};
    const u = URGENCY_META[s3.urgency] || URGENCY_META.NONE;

    /* 加仓两道门分开报 —— 混成一句会让人去调错参数（浮盈不够 vs 时机没到，改的地方不同） */
    const gateRows = [
      {
        name: '第一道门 · 浮盈够格',
        ok: !!roll.profitOk,
        detail: `当前浮盈 ${pct(roll.profitPct)} / 阈值 +${fmtBps(roll.triggerBps || 0)}`,
      },
      {
        name: '第二道门 · 回撤后已起势',
        ok: !!roll.timingOk,
        detail: `${mdt(res.reason || '无回撤读数')}${res.pulledBack ? `（回撤深度 ${pct(res.depthPct)} · 反弹比 ${pct(res.reboundRatio)}）` : ''}`,
      },
    ];

    p.push(`<div class="sec">
      <div class="sec-head">
        <h3>阶段三 · 加仓（滚仓）<span class="tag">只加盈利仓 · 越加越少 · 加完就保本</span></h3>
        ${s3.canAdd ? '<span class="badge ok">两道门都过 · 可以加</span>' : '<span class="badge neutral">暂不加仓</span>'}
      </div>
      <div class="tbl-wrap"><table class="lvl-table">
        <thead><tr><th style="text-align:left">门限</th><th>结果</th><th style="text-align:left">读数</th></tr></thead>
        <tbody>${gateRows
          .map(
            (g) => `<tr class="${g.ok ? '' : 'dim'}">
            <td style="text-align:left">${esc(g.name)}</td>
            <td>${g.ok ? '<span class="badge ok">通过</span>' : '<span class="badge neutral">未过</span>'}</td>
            <td style="text-align:left"><span class="muted">${g.detail}</span></td>
          </tr>`
          )
          .join('')}</tbody>
      </table></div>
      ${
        roll.ladder?.length
          ? `<div class="sec-note">加仓阶梯共 ${roll.ladder.length} 档，触发价从 ${fmtPrice(wad(roll.ladder[0].triggerPrice))} 起每档递减 —— 完整阶梯见下方策略卡的「滚仓点」。</div>`
          : ''
      }
    </div>`);

    p.push(`<div class="sec">
      <div class="sec-head">
        <h3>阶段三 · 离场通道 <span class="tag">四条通道的紧急度不同，决定了市价单还是收盘价单</span></h3>
        <span class="badge ${u.cls}">${esc(u.txt)}</span>
        ${s3.stop?.breached ? '<span class="badge bad">止损已击穿</span>' : ''}
      </div>
      <div class="tbl-wrap"><table class="lvl-table">
        <thead><tr><th style="text-align:left">通道</th><th>触发</th><th style="text-align:left">读数 / 说明</th></tr></thead>
        <tbody>
          <tr class="${ex.newsExit?.active ? '' : 'dim'}">
            <td style="text-align:left">① 重大利空 · 立即离场</td>
            <td>${ex.newsExit?.active ? '<span class="badge bad">触发</span>' : '<span class="badge neutral">未触发</span>'}</td>
            <td style="text-align:left"><span class="muted">${esc(ex.newsExit?.reason || '消息面无反向重事件')}</span></td>
          </tr>
          <tr class="${ex.stopBreached?.active ? '' : 'dim'}">
            <td style="text-align:left">② 止损击穿 · 立即离场</td>
            <td>${ex.stopBreached?.active ? '<span class="badge bad">触发</span>' : '<span class="badge neutral">未触发</span>'}</td>
            <td style="text-align:left"><span class="muted">${esc(ex.stopBreached?.detail || '无结构位止损可判')}</span></td>
          </tr>
          <tr class="${ex.bandBroken?.active ? '' : 'dim'}">
            <td style="text-align:left">③ 收盘跌破中轨 · 趋势破坏</td>
            <td>${ex.bandBroken?.active ? '<span class="badge warn">触发</span>' : '<span class="badge neutral">未触发</span>'}</td>
            <td style="text-align:left"><span class="muted">${mdt(ex.bandBroken?.detail || '')}</span></td>
          </tr>
          <tr class="${ex.failedBounce?.failedBounce ? '' : 'dim'}">
            <td style="text-align:left">④ 回调不反弹 · 观察</td>
            <td>${ex.failedBounce?.failedBounce ? '<span class="badge warn">触发</span>' : '<span class="badge neutral">未触发</span>'}</td>
            <td style="text-align:left"><span class="muted">${esc(ex.failedBounce?.reason || '无读数')}</span></td>
          </tr>
        </tbody>
      </table></div>
      <div class="sec-note">
        止损参考：${s3.stop?.recommended ? `<b>${esc(s3.stop.recommended.label)} @ ${fmtPrice(wad(s3.stop.recommended.price))}</b>` : '无可用止损候选'}　·　
        ${esc(ex.summary || '')}
      </div>
    </div>`);
  } else {
    p.push(`<div class="sec">
      <div class="sec-head"><h3>阶段三 · 持仓管理</h3><span class="badge neutral">不适用</span></div>
      <div class="sec-note">当前无持仓 —— 加仓 / 止损 / 止盈只在有仓位时才有意义。这一块留空不是「算出来是 0」，而是「这一段没轮上」。</div>
    </div>`);
  }

  el.innerHTML = p.join('');
}



/* 分两笔执行 —— 关键是**两笔的止损锚不一样**（头仓锚在突破位外侧、主仓锚在中轨外侧），
 * 所以不能用一行「分批建仓 30%/70%」带过：那样读的人会以为两笔共用一个止损。
 *
 * 抽成独立函数是为了可测：这段文案只在"有触发侧"的快照里才会真正渲染出来，
 * 而真实快照经常没有触发侧 —— 内联在 renderStrategy 里就等于长期无人覆盖。 */
function trancheRows(e) {
  return (e.tranches || [])
    .map((t) => {
      const off = t.active ? '' : ' <span class="badge neutral">未生效</span>';
      return `<div class="kv"><span class="k">第 ${t.index} 笔 · ${esc(
        t.side === 'BREAKOUT' ? '突破头仓' : '回调主仓'
      )}（${fmtBps(t.ratioBps)}）</span><span class="v">${fmtWad(wad(t.qty), 6)} 个 @ ${
        t.triggerKind === 'LIMIT' ? '限价 ' : ''
      }${fmtPrice(wad(t.triggerPrice))} · 止损 ${fmtPrice(wad(t.stopPrice))}${off}</span></div>`;
    })
    .join('');
}

function renderStrategy(s) {
  const coins = s.levelCoins || Object.keys(s.levelsByCoin || {});
  const sel = $('level-coin');
  if (sel.options.length !== coins.length || [...sel.options].some((o, i) => o.value !== coins[i])) {
    sel.innerHTML = coins.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  }
  const coin = state.levelCoin && coins.includes(state.levelCoin) ? state.levelCoin : coins[0];
  state.levelCoin = coin;
  sel.value = coin;

  const L = s.levelsByCoin?.[coin];
  if (!L) {
    $('strategy').innerHTML = `<div class="tbl-empty">${esc(coin)} 的策略读数不可用（K 线不足或该标的无永续合约）</div>`;
    return;
  }

  const parts = [];

  /* ── 系统二 · 战术触发层 + 门禁状态 ──
   *
   * 这一条同时展示两套系统的交汇结果：左侧是触发层进度（三条独立推进腿 + 站稳等级），
   * 右侧是门禁状态 —— 只有门禁给 SIGNAL 才真的可以开单。
   * 触发成立而门禁不放行（VETOED/IDLE）是常态，不是异常：方向层的职责就是拒绝大多数触发。 */
  const trig = L.trigger;
  const g = L.gate;
  const gm = g ? GATE_META[g.state] || GATE_META.IDLE : null;
  const holdMeta = trig && trig.side !== 0 ? HOLD_META[trig.hold?.level] || HOLD_META.H0 : null;

  parts.push(`<div class="trend-strip">
    ${setupPips(L)}
    <span class="badge ${L.isLong ? 'long' : 'short'}">${L.hasPosition ? '持仓方向' : '候选方向'} ${L.isLong ? '多' : '空'}</span>
    ${trig && trig.side !== 0 ? `<span class="badge ${holdMeta.cls}">站稳 ${esc(trig.hold?.level || '—')} · ${esc(holdMeta.txt)}</span>` : '<span class="badge neutral">无触发侧</span>'}
    ${gm ? `<span class="badge ${gm.cls}">门禁 ${esc(g.state)} · ${esc(gm.txt)}</span>` : ''}
    ${trig?.entryMode ? `<span class="badge info">入场模式 ${esc(trig.entryMode === 'PULLBACK' ? '回调' : '突破')}</span>` : ''}
    ${L.entryPlan ? (L.entryPlan.executable === false ? '<span class="badge bad">计划不可执行</span>' : '<span class="badge ok">计划可执行</span>') : ''}
    ${L.dirUndecided ? '<span class="badge warn">方向未定</span>' : ''}
    <span class="muted">标记价 ${fmtPrice(wad(L.mark))}</span>
  </div>`);

  // 门禁的完整理由 —— 这是「为什么现在不能动手」的权威答案，必须原样展示给用户
  if (g && g.reason) {
    const calloutCls = g.state === 'SIGNAL' ? 'ok' : g.state === 'ARMED' ? 'info' : g.state === 'VETOED' ? 'bad' : 'warn';
    parts.push(`<div class="callout ${calloutCls}"><b>门禁 · ${esc(g.state)}</b>：${mdt(g.reason)}</div>`);
  }

  // 触发层技术细节：三条腿 + 收口分位
  if (trig) {
    const sq = trig.squeeze || {};
    parts.push(`<div class="sec">
      <div class="sec-head">
        <h3>触发层明细 <span class="tag">「连续三次突破布林带站稳」的落实方式</span></h3>
        ${sq.ok ? '<span class="badge ok">收口后扩张</span>' : '<span class="badge neutral">收口条件未满足</span>'}
      </div>
      <div>
        <div class="kv"><span class="k">独立推进腿（向上 / 向下）</span><span class="v">${trig.longLegs} / ${trig.shortLegs}<span class="muted"> · 要求 ${trig.required} 条</span></span></div>
        <div class="kv"><span class="k">站稳等级</span><span class="v">${trig.side === 0 ? '—' : esc(trig.hold?.level || '—')}<span class="muted">${trig.side === 0 ? '' : ' · 已持续 ' + (trig.hold?.bars ?? 0) + ' 根'}</span></span></div>
        <div class="kv"><span class="k">突破前带宽分位</span><span class="v">${sq.percentile === null || sq.percentile === undefined ? '—' : sq.percentile + ' 分位'}<span class="muted"> / 门槛 ≤ ${s.config.squeezeMaxPercentile ?? '—'}${sq.nowPercentile !== null && sq.nowPercentile !== undefined ? ' · 当前 ' + sq.nowPercentile + ' 分位' : ''}</span></span></div>
      </div>
      <div class="sec-note">${mdt(sq.detail || '')}</div>
    </div>`);
  }

  // 兼容提示：方向层缺席时系统二一律不开仓
  if (!s.regime) {
    parts.push(`<div class="callout warn">宏观方向层未接入 —— 系统二<b>一律不开仓</b>。触发信号存在也不动手：没有方向约束的突破策略，就是那个会把一根长阳数成"三次突破"的旧版本。</div>`);
  } else if (L.dirUndecided) {
    parts.push(`<div class="callout warn">方向未定（宏观层输出 NEUTRAL）—— 两个方向都不批准开新仓。这不是"随便选一个"，而是"这一段时间不参与"。</div>`);
  }

  /* ── 止损点 ── */
  const stopRows = (L.stop?.candidates || [])
    .map((c) => {
      const isRec = L.stop.recommended && L.stop.recommended.label === c.label;
      const rowCls = isRec ? 'rec' : c.triggersImmediately || c.notAStop ? 'dim' : '';
      const flags = [
        c.triggersImmediately ? '<span class="badge bad">会立刻触发</span>' : '',
        c.notAStop ? '<span class="badge neutral">非结构位</span>' : '',
        c.onProfitSide && !c.notAStop && !c.triggersImmediately ? '<span class="badge ok">已在盈利区</span>' : '',
        !c.withinDistance ? '<span class="badge warn">超12%上限</span>' : '',
        c.withinBudget === false ? '<span class="badge bad">超5%预算</span>' : '',
      ].filter(Boolean).join(' ');
      return `<tr class="${rowCls}">
        <td>${esc(c.label)}${isRec ? ' <span class="badge info">推荐</span>' : ''}</td>
        <td>${fmtPrice(wad(c.price))}</td>
        <td>${num(c.distancePct)}%</td>
        <td>${c.loss === null ? '—' : '$' + fmtWad(wad(c.loss), 2)}</td>
        <td>${c.lossPctEquity === null ? '—' : pct(c.lossPctEquity)}</td>
        <td style="text-align:left">${flags || '—'}</td>
      </tr>`;
    })
    .join('');

  parts.push(`<div class="sec">
    <div class="sec-head"><h3>止损点 <span class="tag">结构位 ± ${fmtBps(s.config.risk.stopBufferBps)} 缓冲，再受 12% 距离上限与 ${fmtBps(s.config.risk.riskPerTradeBps)} 权益预算双重约束</span></h3>
      ${L.stop?.breached ? '<span class="badge bad">已击穿</span>' : '<span class="badge ok">未击穿</span>'}
    </div>
    <div class="tbl-wrap"><table class="lvl-table">
      <thead><tr><th>候选依据</th><th>价格</th><th>距开仓</th><th>触发亏损</th><th>占权益</th><th style="text-align:left">校验</th></tr></thead>
      <tbody>${stopRows || '<tr><td colspan="6" class="tbl-empty">无可用止损候选</td></tr>'}</tbody>
    </table></div>
    <div class="sec-note">
      基准价 ${fmtPrice(wad(L.stop.anchor))} · 风险预算 $${fmtWad(wad(L.stop.riskBudget), 2)} ·
      推荐：${L.stop.recommended ? `<b>${esc(L.stop.recommended.label)} @ ${fmtPrice(wad(L.stop.recommended.price))}</b>` : '无（没有任何候选能同时满足距离与预算约束）'}
    </div>
  </div>`);

  /* ── 滚仓点 ── */
  const ladder = L.roll?.ladder || [];
  const rollRows = ladder
    .map(
      (a) => `<tr class="${a.reached ? '' : 'dim'}">
      <td>第 ${a.index} 档 ${a.reached ? '<span class="badge ok">已触发</span>' : ''}</td>
      <td>${fmtPrice(wad(a.triggerPrice))}</td>
      <td>${(a.sizePctOfBase / 100).toFixed(2)}%</td>
      <td>${fmtWad(wad(a.addQty), 6)}</td>
      <td>${fmtPrice(wad(a.newAvg))}</td>
      <td>${fmtPrice(wad(a.newStop))}</td>
      <td>${fmtWad(wad(a.worstCaseLoss), 2)}</td>
      <td>${a.passesBudget ? '<span class="badge ok">✓</span>' : '<span class="badge bad">超预算</span>'}</td>
    </tr>`
    )
    .join('');

  parts.push(`<div class="sec">
    <div class="sec-head">
      <h3>滚仓点（浮盈加仓） <span class="tag">触发阈值 +${fmtBps(L.roll?.triggerBps)}，量按 ${(L.roll?.ratioBps / 100).toFixed(0)}% 逐档减半，止损随之上移至保本</span></h3>
      ${L.roll?.ready ? '<span class="badge ok">已达加仓阈值</span>' : '<span class="badge neutral">未达阈值</span>'}
    </div>
    ${
      ladder.length
        ? `<div class="tbl-wrap"><table class="lvl-table">
        <thead><tr><th>档位</th><th>触发价</th><th>占初始</th><th>加仓量</th><th>加仓后均价</th><th>止损移至</th><th>最坏亏损</th><th>校验</th></tr></thead>
        <tbody>${rollRows}</tbody></table></div>`
        : `<div class="tbl-empty">无持仓，暂不计算滚仓阶梯（未持仓时先看下方的开单计划）</div>`
    }
    <div class="sec-note">
      ${
        L.roll?.ladder?.length
          ? `当前浮盈 ${pct(L.roll.profitPct)}，名义 $${fmtWad(wad(L.roll.notionalNow || 0n), 2)}。
        「最坏亏损」指按新的均价与上移后的止损计算的最坏结果，需 ≤ 权益 ${fmtBps(s.config.maxAddsRiskBps)}。
        比特皇的规则是<strong>只加盈利仓、越加越少、加完就保本</strong> —— 这样加仓不增加风险敞口。`
          : '滚仓阶梯在持仓成立后才有意义。'
      }
    </div>
  </div>`);

  /* ── 止盈点 ── */
  const rRows = (L.takeProfit?.rMultiples || [])
    .map(
      (r) => `<tr>
      <td>${r.r}R</td>
      <td>${fmtPrice(wad(r.price))}</td>
      <td>${num(r.movePct)}%</td>
      <td style="text-align:left">${r.r === 1 ? '回本即走' : r.r === 2 ? '常见止盈区' : '强势趋势目标'}</td>
    </tr>`
    )
    .join('');

  const mm = L.takeProfit?.measuredMove;
  parts.push(`<div class="sec">
    <div class="sec-head"><h3>止盈点 <span class="tag">比特皇不设固定止盈，主张持仓到趋势结束</span></h3>
      ${s.config.takeProfitBps > 0 ? `<span class="badge info">已配固定止盈 ${fmtBps(s.config.takeProfitBps)}</span>` : '<span class="badge violet">趋势跟踪离场</span>'}
    </div>
    <div class="tbl-wrap"><table class="lvl-table">
      <thead><tr><th>R 倍数</th><th>价格</th><th>距入场</th><th style="text-align:left">含义</th></tr></thead>
      <tbody>${rRows || '<tr><td colspan="4" class="tbl-empty">无数据</td></tr>'}</tbody>
    </table></div>
    <div class="sec-note">
      ${mm
        ? `<strong>区间等幅量出投影：${fmtPrice(wad(mm.target))}</strong>
        （回看窗口区间 ${fmtPrice(wad(mm.low))} ~ ${fmtPrice(wad(mm.high))}，突破位 ${fmtPrice(wad(mm.pivot))}）。
        这是<strong>合约自己从 K 线量出的可得空间</strong>，不是外部传入的目标价 ——
        所以它无法被单个参数放大，也不会出现「声明一个很远的止盈把门槛刷过去」的情况。`
        : '区间幅度不足，无法给出等幅投影。'}
      <br/>动态离场参考：多头收盘跌破布林中轨 <b>${L.takeProfit?.bandTrail ? fmtPrice(wad(L.takeProfit.bandTrail.exitTrigger)) : '—'}</b> 视为趋势破坏。
    </div>
  </div>`);

  /* ── 风险敞口 ── */
  const r = L.risk || {};
  parts.push(`<div class="sec">
    <div class="sec-head"><h3>风险敞口</h3></div>
    <div>
      <div class="kv"><span class="k">名义敞口</span><span class="v">$${fmtWad(wad(r.exposure || 0n), 2)}（占权益 ${pct(r.exposurePct, 1)}）</span></div>
      <div class="kv"><span class="k">实际杠杆</span><span class="v">${num(r.effectiveLeverage)}x<span class="muted"> / 配置上限 ${s.config.leverageCap}x</span></span></div>
      <div class="kv"><span class="k">距清算价</span><span class="v">${r.distToLiqPct === null || r.distToLiqPct === undefined ? '<span class="muted">接口未返回清算价</span>' : pct(r.distToLiqPct)}</span></div>
      <div class="kv"><span class="k">止损触发亏损</span><span class="v">${r.riskAtStop === null || r.riskAtStop === undefined ? '—' : '$' + fmtWad(wad(r.riskAtStop), 2) + '（占权益 ' + pct(r.riskAtStopPct) + '）'}</span></div>
      <div class="kv"><span class="k">占用保证金</span><span class="v">$${fmtWad(wad(r.marginUsed || 0n), 2)}</span></div>
    </div>
  </div>`);

  /* ── 开单计划（无持仓且有方向时） ── */
  if (L.entryPlan) {
    const e = L.entryPlan;
    const trRows = trancheRows(e);
    parts.push(`<div class="sec">
      <div class="sec-head">
        <h3>开单计划 <span class="tag">${esc(e.phaseLabel)}相位 · 门槛 ${fmtBps(e.requiredMoveBps)}</span></h3>
        ${e.executable === false ? '<span class="badge bad">不可执行</span>' : '<span class="badge ok">可执行</span>'}
        ${e.passMoveGate ? '<span class="badge ok">可得空间达标</span>' : '<span class="badge bad">可得空间不足</span>'}
        ${e.passRewardGate === false ? '<span class="badge bad">盈亏比不足</span>' : ''}
      </div>
      <div>
        <div class="kv"><span class="k">方向 / 杠杆</span><span class="v">${e.isLong ? '做多' : '做空'} · ${e.leverage}x${e.cappedByLeverage ? '<span class="muted">（已被杠杆上限压过）</span>' : ''}</span></div>
        <div class="kv"><span class="k">入场参考价</span><span class="v">${fmtPrice(wad(e.entryPrice))}</span></div>
        <div class="kv"><span class="k">止损位</span><span class="v">${fmtPrice(wad(e.stopPrice))}（距入场 ${(e.stopDistanceBps / 100).toFixed(2)}%）</span></div>
        <div class="kv"><span class="k">计划总量</span><span class="v">${fmtWad(wad(e.totalQty), 6)} 个</span></div>
        ${
          trRows ||
          `<div class="kv"><span class="k">分批建仓</span><span class="v">突破批 ${fmtWad(wad(e.breakQty), 6)}（${fmtBps(
            s.config.risk.breakBatchBps
          )}） / 回调批 ${fmtWad(wad(e.pullbackQty), 6)}（${fmtBps(s.config.risk.pullbackBatchBps)}）</span></div>`
        }
        <div class="kv"><span class="k">止损全额亏损</span><span class="v">$${fmtWad(wad(e.lossAtStop), 2)}（占权益 ${pct(e.lossPctEquity)}，预算 ${fmtBps(s.config.risk.riskPerTradeBps)}）</span></div>
        <div class="kv"><span class="k">可得空间</span><span class="v">${num(e.projectedMovePct)}% / 门槛 ${fmtBps(e.requiredMoveBps)}（相位下限 ${fmtBps(e.phaseFloorBps)}）</span></div>
        <div class="kv"><span class="k">盈亏比</span><span class="v">${(e.rewardRiskBps / 10000).toFixed(2)} : 1<span class="muted"> / 要求 ≥ ${(s.config.minRewardRiskBps / 10000).toFixed(2)}</span></span></div>
      </div>
      ${
        (e.blockedBy || []).length
          ? `<div class="reason-list" style="margin-top:8px">${e.blockedBy
              .map((x) => `<div class="reason-item note">${esc(x)}</div>`)
              .join('')}</div>`
          : ''
      }
      ${
        e.passMoveGate
          ? ''
          : `<div class="callout bad" style="margin:9px 13px 12px">可得空间 ${num(
              e.projectedMovePct
            )}% 低于门槛 ${fmtBps(e.requiredMoveBps)} —— 按规则<strong>拒绝出手</strong>。这个门槛由减半周期相位决定，只能在研究支持的范围内收紧，不能放松。</div>`
      }
      ${
        e.passRewardGate === false
          ? `<div class="callout bad" style="margin:9px 13px 12px">盈亏比 ${(e.rewardRiskBps / 10000).toFixed(
              2
            )} : 1 低于要求 ≥ ${((s.config.minRewardRiskBps || 10000) / 10000).toFixed(2)} —— 按规则<strong>拒绝出手</strong>。</div>`
          : ''
      }
    </div>`);
  }

  $('strategy').innerHTML = parts.join('');
}

/* ─────────────────────── 渲染：图表 ─────────────────────── */

async function renderChart(s) {
  const coin = state.coin;
  const interval = state.interval;
  const ivMs = { '1h': 3600000, '4h': 14400000, '1d': 86400000 }[interval] || 14400000;

  // WebSocket 中间价（十进制串 → dec）。同步可取，所以标题上就能显示现价。
  const liveMid = state.mids[coin] ? wadToNumber(dec(state.mids[coin])) : null;
  const hasLive = Number.isFinite(liveMid) && liveMid > 0;
  $('chart-title').textContent = `K 线 · 布林带 · 关键位 —— ${coin} ${interval.toUpperCase()}${
    hasLive ? `　现价 ${liveMid.toFixed(2)}` : ''
  }`;

  let candles;
  try {
    candles = await fetchCandles(coin, interval);
  } catch (e) {
    $('chart').innerHTML = `<div class="tbl-empty">K 线拉取失败：${esc(e.message)}</div>`;
    $('chart-legend').innerHTML = '';
    return;
  }
  if (!candles?.length) {
    $('chart').innerHTML = '<div class="tbl-empty">无 K 线数据</div>';
    return;
  }

  // ── 实时化：用中间价驱动「正在形成」的那根 K 线 ──
  // fetchCandles 有 30 秒缓存、且返回的是缓存里的**同一个数组**，所以这里绝不能就地修改 ——
  // 否则一次瞬时插针会把虚高的 high 永久写进缓存，之后每次刷新的布林带都被它污染。
  // 做法：只对最后一根做浅拷贝放进「视图数组」，缓存保持原样。
  let liveApplied = false;
  let view = candles;
  if (hasLive) {
    const last = candles[candles.length - 1];
    // 只在这根 K 线还没收盘时覆盖（已定型的收盘价不允许被篡改）
    if (Date.now() < last.t + ivMs) {
      view = candles.slice();
      view[view.length - 1] = {
        ...last,
        c: liveMid,
        cs: String(liveMid), // 让布林带的 WAD 运算也用上实时价
        h: Math.max(last.h, liveMid),
        l: Math.min(last.l, liveMid),
      };
      liveApplied = true;
    }
  }

  // 用共享模块算布林带，与策略读数同一套算法 —— 且必须用原始字符串走 parseWad，
  // 否则低价币（如 NOT 0.00047）会被浮点量化吃成 0，图上布林带整体归零后画到画布外。
  const closes = view.map((c) => parseWad(c.cs ?? c.c));
  const bands = [];
  if (state.showBands) {
    for (let i = 19; i < closes.length; i++) {
      const b = bandsAt(closes, i, 20, 20000);
      if (b) bands.push({ i, upper: wadToNumber(b.upper), mid: wadToNumber(b.mid), lower: wadToNumber(b.lower) });
    }
  }

  // ── 关键位 ──
  //
  // 这里曾经是一个「平铺数组」：六条线 push 进同一个数组，止盈的 1R/2R/3R/等幅目标
  // 还共用同一个紫色，图上完全分不出哪条是哪条。现在每一项都带三个明确的语义字段：
  //   kind —— 决定颜色，一条线一种颜色（见 charts.js 的 LEVEL_KINDS）
  //   sub  —— 图右侧标注栏里的短名（要短，价格数字才是主角）
  //   label—— 完整名字，进下面的图例表
  // 加上 lineKey() 返回的坐标，组成「每一项是什么意思」的完整答案。
  const lines = [];
  const keyRows = [];
  const L = s.levelsByCoin?.[coin];

  const lineKey = (v) => (Number.isFinite(v) && v > 0 ? v : null);
  const kfmt = (v) => (Number.isFinite(v) && v > 0 ? v.toFixed(2) : '—');
  const pctTo = (v) => (Number.isFinite(v) && v > 0 && hasLive ? `${(((v - liveMid) / liveMid) * 100).toFixed(2)}%` : '—');
  // 往图例表里登记一行。图上没画的（坐标未知、被裁到视图外）也登记 ——
  // 「为什么这项不在图上」本身就是必须回答的问题，静默丢掉最不该发生。
  //
  // color 在这里统一补上：调用点只需给 kind，不用各自记颜色，漏写也不会渲染出 undefined。
  const reg = (row) => keyRows.push({ color: levelColor(row.kind), ...row });

  if (state.showLevels && L) {
    // ① 开仓价 —— 只有真持仓才有，含义是「盈亏从这里起算」
    const pos = s.positions.find((p) => p.coin === coin);
    if (pos) {
      const v = lineKey(wadToNumber(wad(pos.entryPx)));
      if (v !== null) lines.push({ price: v, label: '开仓价', sub: '开仓价', kind: 'entry' });
      reg({
        kind: 'entry',
        kindName: '开仓价',
        label: '开仓价（持仓成交均价）',
        price: kfmt(v),
        pct: pctTo(v),
        desc: '当前持仓的成交均价，未实现盈亏以它为原点计算。它不是支撑也不是压力，只代表你的成本。',
        extra: v === null ? '本次快照未取到该持仓的开仓价，图上未画' : '',
      });
    }

    // ② 清算价 —— 只有真持仓才有，含义是「再往前一步会被强平」
    if (pos?.liquidationPx) {
      const v = lineKey(wadToNumber(wad(pos.liquidationPx)));
      if (v !== null) lines.push({ price: v, label: '清算价', sub: '清算价', kind: 'liq' });
      reg({
        kind: 'liq',
        kindName: '清算价',
        label: '清算价（强平线）',
        price: kfmt(v),
        pct: pctTo(v),
        desc: '标记价触及这里会被交易所强制平仓。这是不可协商的硬边界，任何策略规则都不能让它变松。',
        extra:
          v === null
            ? '接口未返回清算价（全仓保证金且保证金充足时属于正常），以维持保证金率自行判断'
            : '',
      });
    }

    // ③ 止损位 —— 推荐的那个候选，含义是「结构被打穿，逻辑失效」
    const rec = L.stop?.recommended;
    if (rec) {
      const v = lineKey(wadToNumber(wad(rec.price)));
      if (v !== null) lines.push({ price: v, label: '止损位', sub: '止损位', kind: 'stop' });
      reg({
        kind: 'stop',
        kindName: '止损位',
        label: `止损位（推荐：${rec.label}）`,
        price: kfmt(v),
        pct: pctTo(v),
        desc: `从 ${rec.label} 加减 ${fmtBps(s.config.risk.stopBufferBps)} 缓冲得出，是「凭什么继续持有」的结构依据。收盘价站不回来就离场，不等回本。`,
        extra: '',
      });
    } else if (L.stop) {
      reg({
        kind: 'stop',
        kindName: '止损位',
        label: '止损位',
        price: '—',
        pct: '—',
        desc: '没有任何候选同时满足 12% 距离上限与 5% 权益预算 —— 这是「不该开仓」的信号，不是「随便挑一个」。',
        extra: '图上未画',
      });
    }

    // ④ 滚仓点 —— 浮盈加仓的触发价，含义是「到这里才允许加更多」
    for (const a of L.roll?.ladder || []) {
      const v = lineKey(wadToNumber(wad(a.triggerPrice)));
      if (v !== null) lines.push({ price: v, label: `滚仓点 ${a.index}`, sub: `滚仓点${a.index}`, kind: 'roll' });
      reg({
        kind: 'roll',
        kindName: '滚仓点',
        label: `滚仓点 第 ${a.index} 档${a.reached ? '（已触发）' : ''}`,
        price: kfmt(v),
        pct: pctTo(v),
        desc: `浮盈每涨 ${fmtBps(L.roll?.triggerBps)} 触发一档：加初始量的一半、逐档减半，并把止损抬到保本。规则是「只加盈利仓」，所以加仓不增加风险敞口。`,
        extra:
          v === null
            ? '本次未取到该档触发价（浮盈未达阈值时部分档位不生成），图上未画'
            : a.reached
              ? '该档已经触发过'
              : '',
      });
    }

    // ⑤ 0R —— 保本止损。
    //
    // 这一条只在「结构止损恰好落在成本价附近」时才需要单独说明，因为那时它恰好等于
    // 1R 的终点（0 + 1×R）与潜在滚仓的触发价，三者在同一个价位上。默认不画线，
    // 避免给正常的结构止损平白多出一条重复横线；由下面的 ⓪ 归并步骤按需补齐。
    const be = L.stop?.candidates?.find((c) => c.label === '保本止损');

    // ⑥ 1R / 2R / 3R —— R 倍数止盈，含义是「赚了几个风险单位」
    //
    // 关键：这里必须把「1R 是多少钱」讲清楚，否则用户只会看到三个价格。
    const rUnit = L.takeProfit?.rUnit ? wadToNumber(wad(L.takeProfit.rUnit)) : null;
    const rEntry = L.takeProfit?.entryForR ? wadToNumber(wad(L.takeProfit.entryForR)) : null;
    const rMean = { 0: '保本线（还差一个 R 才回本）', 1: '回本即走（赚回一次风险）', 2: '常见止盈区（赚回两次风险）', 3: '强势趋势目标（赚回三次风险）' };
    const rRows = [];
    for (const r of L.takeProfit?.rMultiples || []) {
      const v = lineKey(wadToNumber(wad(r.price)));
      const kind = `tp${r.r}`;
      if (v !== null) lines.push({ price: v, label: `${r.r}R`, sub: `${r.r}R 止盈`, kind });
      const row = {
        kind,
        kindName: `${r.r}R 止盈`,
        label: `${r.r}R 止盈（${rMean[r.r] || '参考位'}）`,
        price: kfmt(v),
        pct: pctTo(v),
        desc:
          `1R = 入场到止损的距离，也就是「承担一次风险」的价差。` +
          (rUnit && rEntry
            ? `本例入场基准 ${rEntry.toFixed(2)}、1R 幅度 ${rUnit.toFixed(2)}，所以 ${r.r}R 就是这个基准再走 ${r.r} 个 ${rUnit.toFixed(2)}。`
            : '') +
          `注意这是参考位：比特皇不设固定止盈，实际离场看趋势是否走完。`,
        extra: v === null ? '本次未取到该倍数价格，图上未画' : '',
      };
      rRows.push(row);
      reg(row);
    }

    // ⓪ 同一价位上的多义归并 —— 这一步是「标清楚每一项」的兑现点。
    //
    // 真实数据里会撞价：现价 81091.2 时，结构止损落在 80095.69、0R 保本位也在 80095.69；
    // 更有代表性的是滚仓后止损上移到保本，那时「止损 / 保本 / 0R」会精确重合在同一个数上。
    // 撞价时渲染器只会画一条线（后画的盖住先画的），汇总表如果也各写一行，
    // 就出现「表里 8 行、图上 7 条线」——用户第一反应是「图坏了」。
    //
    // 正确做法不是删掉多余的行，而是**把它们合成一行**，并在「这是什么」里
    // 把每个含义都讲一遍：同一个价格上的三个身份，全都是真的。
    const bump = (row, addKind, addName) => {
      if (!row) return;
      row.alsoKinds = row.alsoKinds || [];
      if (!row.alsoKinds.includes(addKind)) row.alsoKinds.push(addKind);
      row.alsoNames = row.alsoNames || [];
      if (!row.alsoNames.includes(addName)) row.alsoNames.push(addName);
    };
    const samePx = (a, b) =>
      Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Math.abs(Number(a) - Number(b)) < 0.005;

    // ⑥a 保本止损与某个已登记的价位重合 → 那句话并进那一行
    if (be) {
      const bev = lineKey(wadToNumber(wad(be.price)));
      if (bev !== null) {
        const hit =
          keyRows.find((r) => r.kind === 'stop' && samePx(r.price, bev)) || keyRows.find((r) => samePx(r.price, bev));
        if (hit) {
          bump(hit, 'stop', '保本止损');
          hit.desc += ` 这里同时是保本止损位（成本价外侧留 ${fmtBps(s.config.breakevenBufferBps || 30)} 缓冲）—— 滚仓后止损就应上移到这个位置，到位即「最坏打平」。`;
        } else {
          // 结构止损与保本价相差较远（正常情况）：保本位不值得单独占一条线，
          // 但它是滚仓的目标位置，还是要在汇总表里给一行，并注明不在图上。
          reg({
            kind: 'stop',
            kindName: '保本止损',
            label: '保本止损（滚仓后止损的上移目标）',
            price: kfmt(bev),
            pct: pctTo(bev),
            desc: `成本价外侧留 ${fmtBps(s.config.breakevenBufferBps || 30)} 缓冲的位置。滚仓后止损要移到这里 —— 到位后最坏结果是不亏不赚。它与结构止损不在同一价位，所以图上不画线，只在这里登记。`,
            extra: '图上未画（与结构止损不同价）',
          });
        }
      }
    }

    // ⑥ 等幅目标 —— K 线自己量出的可得空间，含义是「这段行情理论上还能走多远」
    const mmv = L.takeProfit?.measuredMove;
    if (mmv) {
      const v = lineKey(wadToNumber(wad(mmv.target)));
      if (v !== null) lines.push({ price: v, label: '等幅目标', sub: '等幅目标', kind: 'tpmm' });
      const loT = wadToNumber(wad(mmv.low));
      const hiT = wadToNumber(wad(mmv.high));
      const pvT = wadToNumber(wad(mmv.pivot));
      reg({
        kind: 'tpmm',
        kindName: '等幅目标',
        label: '等幅目标（区间等幅量出投影）',
        price: kfmt(v),
        pct: pctTo(v),
        desc:
          `从突破位 ${pvT.toFixed(2)} 起，加上回看窗口的区间高度（${loT.toFixed(2)} ~ ${hiT.toFixed(2)}）量出。` +
          `它是合约自己从 K 线量出来的，不是外部传进来的目标价 —— 所以没法靠调一个参数把它吹远。`,
        extra: v === null ? '本次未取到等幅目标，图上未画' : '',
      });
    }

    if (state.showLevels && !pos) {
      reg({
        kind: 'neutral',
        kindName: '持仓相关位',
        label: '开仓价 / 清算价',
        price: '—',
        pct: '—',
        desc: '当前账户在该标的上没有持仓，所以没有成本价与强平线。等开仓后这两条会自动出现。',
        extra: '无持仓',
      });
    }
  }

  // ── 现价参考线（来自 WebSocket，实时更新）──
  //
  // 必须在归并之前登记：现价有时会正好压在某个 R 位或滚仓点上（尤其价格是整数时），
  // 那时两行数字一模一样、图上却只有一条线，用户会以为漏画了。归并逻辑统一处理。
  //
  // legend: false —— 现价不进「图例色条」，因为它的青线在图上自明；
  // 但汇总表里一定有它一行，否则那个青色圆圈没有出处。
  if (liveApplied) {
    lines.push({ price: liveMid, label: '现价', sub: '现价', kind: 'live', legend: false });
  }

  // ── 归并：现价与已登记价位同价时，并进去而非另起一行 ──
  if (liveApplied) {
    const hit = keyRows.find((r) => Number.isFinite(Number(r.price)) && Math.abs(Number(r.price) - liveMid) < 0.005);
    if (hit) bump(hit, 'live', '现价');
    else {
      keyRows.unshift({
        kind: 'live',
        kindName: '现价',
        label: '现价（实时中间价）',
        price: liveMid.toFixed(2),
        pct: '0.00%',
        desc: '交易所 WebSocket 推送的中间价，也是图上最后一根「还在形成」的 K 线的收盘价。所有「距现价」的百分比都以它为分母。',
        extra: '',
      });
    }
  }

  // 归并的收尾：受影响的行走这里统一改写显示字段。
  // color 用 | 拼接多个色值，渲染成多个小圆点 —— 图上那条线是其中一种颜色，
  // 用户需要知道另一个颜色指的是同一个价位的另一个身份。
  for (const row of keyRows) {
    if (!row.alsoKinds?.length) continue;
    row.kindName = [row.kindName, ...row.alsoKinds.map((k) => kindNameOf(k))].join(' / ');
    row.color = [row.color, ...row.alsoKinds.map((k) => levelColor(k))].join('|');
    row.desc += ` 这个价位上叠着不止一个身份：${row.alsoNames.join('、')}；它们是同一个价格的不同叫法，不是多条线。`;
  }

  // 突破标记（按 4H 读数折算到当前图的索引区间；仅 4H 图直接对齐）
  let markers = [];
  if (state.showBands && interval === '4h' && L?.trend?.marks?.length) {
    const offset = candles.length - 200;
    markers = L.trend.marks
      .map((m) => ({ index: m.index + offset, side: m.side }))
      .filter((m) => m.index >= 0 && m.index < candles.length);
  }

  const out = renderCandles({ candles: view, bands, lines, markers });
  $('chart').innerHTML = out.svg;

  // 图上画的每一个序号，在下面的表里都能找到同一序号 —— 这是「标清楚每一项」的落地方式。
  // 序号按「离现价由近到远」排，和交易时真正关心的顺序一致。
  //
  // 配对必须同时满足「类别相同」和「价格相同」：同一个类别（比如 3 个滚仓点）
  // 会有多行，光靠 kind 会把序号串错。
  const drawn = (out.key || []).filter((k) => k.n > 0);
  const usedSeq = new Set();
  for (const row of keyRows) {
    if (!Number.isFinite(Number(row.price))) continue;
    const hit = drawn.find(
      (k) => !usedSeq.has(k.n) && String(k.kind) === String(row.kind) && Math.abs(Number(k.price) - Number(row.price)) < 1e-6
    );
    if (hit) {
      row.n = hit.n;
      usedSeq.add(hit.n);
    }
  }
  keyRows.sort((a, b) => (a.n || 999) - (b.n || 999) || String(a.kind).localeCompare(String(b.kind)));

  // color 现在是 "色1|色2" 形式（同一价位叠了多个身份）。拆开渲染成并排的色点，
  // 序号圆圈用主色 —— 图上那条线画的就是主色，用它才认得出。
  const dotsOf = (color) =>
    String(color || '#8c959f')
      .split('|')
      .map((c) => `<span class="keydot" style="background:${c.trim() || '#8c959f'}"></span>`)
      .join('');
  const mainColor = (color) => String(color || '#8c959f').split('|')[0].trim() || '#8c959f';

  const keyHtml = keyRows.length
    ? `<table class="chart-key">
        <thead><tr>
          <th style="width:34px">图</th><th style="width:104px">类别</th><th style="width:92px">价格</th>
          <th style="width:78px">距现价</th><th style="text-align:left">这是什么</th>
        </tr></thead>
        <tbody>${keyRows
          .map((r) => {
            const chip = r.n
              ? `<span class="keynum" style="border-color:${mainColor(r.color)};color:${mainColor(r.color)}">${r.n}</span>`
              : `<span class="keynum off">—</span>`;
            return `<tr>
              <td>${chip}</td>
              <td>${dotsOf(r.color)}${esc(r.kindName ?? '—')}</td>
              <td class="kprice">${esc(r.price ?? '—')}</td>
              <td class="kprice">${esc(r.pct ?? '—')}</td>
              <td style="text-align:left">${esc(r.label ?? '—')} —— ${esc(r.desc ?? '')}${
                r.extra ? ` <span class="muted">（${esc(r.extra)}）</span>` : ''
              }</td>
            </tr>`;
          })
          .join('')}</tbody>
      </table>
      <div class="chart-key-note">
        「图」列的编号 = 图左侧空心圆圈里的编号，方便两处对上；「—」表示该项本次没画在图上。
        <b>1R 是什么意思</b>：从入场基准到止损位的价差算作一个 R（一次风险的代价），
        2R / 3R 就是把这段价差再走两倍、三倍 —— 所以它们衡量的是「赚了几个风险单位」，
        而不是「涨了百分之几」。等幅目标与 R 倍数无关，它是 K 线区间自己量出来的可得空间。
        一行里若出现多个色点，说明这<b>一个价格</b>同时是几个身份（比如滚仓后「止损」正好等于「保本」），
        图上只会画一条线，不是漏画。
      </div>`
    : '';

  keyRows.length = 0; // 表已渲染，清掉暂存，避免下一次刷新叠行

  // 图例保留，但降级为「一眼扫过」的色条摘要；真正的逐项说明在 keyHtml 表里。
  // 两者分工明确：上面的图例回答「图上有什么颜色」，下面的表回答「这一项是什么意思」。
  //
  // ⚠️ 每个字段都要显式兜底。曾经这里是 title="${esc(l.desc || '')}"，看着有兜底，
  // 但渲染器自己 push 进来的图例项（布林带 / 有效突破 / 超出视图）根本没有 desc 字段，
  // 于是 12 个字面量 "undefined" 直接进了 HTML，被渲染层坏值扫描抓出来。
  // 教训：凡是「另一个模块塞进数组再回来渲染」的数据，字段存在性都要当成未知。
  const bits = out.legend
    .map((l) => {
      const label = l.label ?? '—';
      const color = l.color || '#8c959f';
      const tip = l.desc ? `<span class="lgtip"> · ${esc(l.desc)}</span>` : '';
      return `<span class="lg"><i class="sw" style="background:${color};color:${color}"></i>${esc(label)}${tip}</span>`;
    })
    .join('');
  $('chart-legend').innerHTML =
    `<div class="chart-legend-bar">${bits}
      <span class="lg">${liveApplied ? '实时：最后一根 K 线由中间价驱动' : '实时推送未接入，显示已收盘数据'}</span>
      ${
        out.unknown
          ? `<span class="lg" style="color:var(--warn, #9a6700)">${out.unknown} 个关键位本次未取到价格（见下表）</span>`
          : ''
      }
    </div>` + keyHtml;
}

/* ═══════════════════ 两大系统 · 心得逐条对照 ═══════════════════
 *
 * 这两张表回答用户最关心的那句话：「哪条心得现在符合、哪条不符合，为什么」。
 *
 * 判定语义必须先讲清楚，否则这一列会变成噪音：
 *   · 符合     —— 这条心得**描述的情形**当前确实成立（判据读数越过了它自己的门槛）
 *   · 不符合   —— 读数可用，但情形不成立（明确写出差在哪）
 *   · 未参与   —— 本轮取不到数据 / 不适用 —— **不等于「安全」**
 *   · 常驻生效 —— 架构约束，一直成立，没有「本轮」之说
 *   · 待人工   —— 该条需要人来确认，系统不替你猜
 *
 * 「符合/不符合」说的是**心得描述的市场情形**，不是「和最终方向一致」——
 * 方向本身由这些判据合成，拿结论去反判判据是循环论证。
 * 方向性证据放在「投票」列里，由读的人自己看。
 */
const MATCH_META = {
  hit: { cls: 'ok', txt: '符合' },
  miss: { cls: 'bad', txt: '不符合' },
  off: { cls: 'neutral', txt: '未参与' },
  always: { cls: 'info', txt: '常驻生效' },
  manual: { cls: 'warn', txt: '待人工' },
};

const matchVote = (v) =>
  v > 0 ? '<span class="num-up">投多</span>'
  : v < 0 ? '<span class="num-down">投空</span>'
  : '<span class="num-zero">不表态</span>';

/** 单条心得在**本轮快照**上的状态。所有字段一律可选 —— 缺读数就报「未参与」，绝不编。 */
function criterionState(c, s) {
  const r = s.regime;
  const [s1, s2, s3] = s.pipeline?.stages || [];
  const readings = new Map((s.macro?.readings || []).map((m) => [m.id, m]));
  const coins = s.levelCoins || Object.keys(s.levelsByCoin || {});
  const coin = state.levelCoin && coins.includes(state.levelCoin) ? state.levelCoin : coins[0];
  const L = coin ? s.levelsByCoin?.[coin] : null;
  const trig = L?.trigger || null;
  const plan = L?.entryPlan || null;
  const rl = s3?.roll || null;
  const ex = s3?.exitSignals || null;
  const off = (e) => ({ state: 'off', evidence: e });

  switch (c.id) {
    /* ─────── stage 0 · 全局约束 ─────── */
    case 'kline-only':
      return { state: 'always', evidence: '所有判据只吃价格与成交量，没有引入任何主观预测、观点或外部评级。' };

    case 'trend-not-against': {
      if (!r?.clock || !r?.structure) return off('方向层或结构读数不可用。');
      const iv = r.clock.intent;
      const sv = r.structure.verdict;
      if (iv === 'NEUTRAL') return off(`相位「${r.clock.label}」不指定方向 —— 本轮没有逆向诱惑。`);
      if (sv === 'MIXED') return off(`结构读数未分出胜负（归一化 ${num(r.structure.normalized, 2)}）—— 无趋势可逆。`);
      const want = iv === 'LONG_ONLY' ? 'BULL' : 'BEAR';
      return sv === want
        ? { state: 'hit', evidence: `结构 ${sv} 与相位 ${iv} 同向 —— 当前不存在摸顶空/抄底多的诱惑。` }
        : { state: 'miss', evidence: `结构 ${sv} 与相位 ${iv} 相反 —— 这正是「和趋势作对」的位置，方向层已输出 NEUTRAL 挡住开仓。` };
    }

    case 'no-zone-trade': {
      if (!r) return off('方向层未接入。');
      if (r.clock?.phase === 'BLOWOFF') return { state: 'hit', evidence: '冲顶段 intent=NEUTRAL —— 既不追高也不反手做空，「不参与」这一条生效。' };
      if (r.bias === 'NEUTRAL') return { state: 'hit', evidence: '方向层本轮 NEUTRAL —— 这一段时间不参与。' };
      return { state: 'miss', evidence: `方向已定（${r.biasLabel}）—— 本轮不属于「不参与」的情形。` };
    }

    case 'validate-by-market':
      return { state: 'manual', evidence: '已落成「回测 + 断言」的开发纪律（改动必须过 regime-check）；「不要听信权威」这一半无法自动化，仍需人工拍板。' };

    /* ─────── stage 1 · 周期热点 ─────── */
    case 'halving-hotspot':
    case 'hotspot-required': {
      if (!r?.clock) return off('减半时钟不可用。');
      return r.clock.intent === 'NEUTRAL'
        ? { state: 'miss', evidence: `${r.clock.label} —— 不在减半热点窗口内，方向层双向都不批。` }
        : { state: 'hit', evidence: `${r.clock.label} —— 在减半热点窗口内，允许${r.clock.intent === 'LONG_ONLY' ? '顺势做多' : '顺势做空'}。` };
    }

    case 'halving-peak-12-18m': {
      if (!r?.clock) return off('减半时钟不可用。');
      return r.clock.phase === 'BLOWOFF'
        ? { state: 'hit', evidence: `${r.clock.label} —— 已进入峰值窗口（减半后 15~24 个月）。` }
        : { state: 'miss', evidence: `${r.clock.label} —— 尚未进入峰值窗口。` };
    }

    /* ─────── stage 1 · 情绪与消息 ─────── */
    case 'extreme-fear-contrarian': {
      const sn = r?.sentiment;
      if (!sn?.available) return off('拥挤度/费率读数不可用。');
      if (sn.signal === 'SQUEEZE_UP' || sn.signal === 'SQUEEZE_DOWN')
        return { state: 'hit', evidence: sn.detail || '极端拥挤 + 价格已止住 —— 反向机会成立。', vote: sn.vote };
      return { state: 'miss', evidence: sn.detail || '未同时满足「极端拥挤」与「价格已止住」。', vote: 0 };
    }

    case 'headline-not-moving': {
      const rx = r?.reaction;
      if (!rx?.available) return off('事件反应检验暂无数据（本条不默认为「安全」）。');
      const n = Number(rx.bearishNotFalling || 0) + Number(rx.bullishNotRising || 0);
      return n > 0
        ? { state: 'hit', evidence: `${rx.detail || rx.reason || ''} —— 已检验 ${rx.total} 条事件，${n} 条出现「利空不跌 / 利多不涨」。`.trim(), vote: rx.vote }
        : { state: 'miss', evidence: `已检验 ${rx.total ?? 0} 条事件，价格反应都正常 —— 没有出现「利空不跌 / 利多不涨」。`, vote: 0 };
    }

    case 'media-extreme':
    case 'etf-netflow':
    case 'onchain-activity':
    case 'liquidity-macro':
    case 'institutional-holding':
    case 'regulation-policy': {
      const m = readings.get(c.id);
      if (!m || !m.available) return off('该读数本次取不到数据 —— 系统不替它猜，本条本轮弃权。');
      if (!m.vote) return { state: 'miss', evidence: m.reason || '读数可用，但没有越过本条门槛。', vote: 0 };
      return { state: 'hit', evidence: m.reason || '读数越过了本条门槛。', vote: m.vote };
    }

    case 'macro-event-layer': {
      const e = r?.events;
      if (!e) return off('事件层不可用。');
      if (e.shock?.active) return { state: 'hit', evidence: e.shock.detail || '黑天鹅事件生效中 —— 一票否决，方向强制 NEUTRAL。' };
      const net = Number(e.net || 0);
      const n = (e.items || []).filter((i) => Math.abs(Number(i.effective || 0)) >= 0.1).length;
      return Math.abs(net) >= 0.5
        ? { state: 'hit', evidence: `事件层净权重 ${net > 0 ? '+' : ''}${net}（${n} 条仍在起作用）—— 作为方向修正项参与。`, vote: net > 0 ? 1 : -1 }
        : { state: 'miss', evidence: `事件层净权重 ${net} —— 当前没有足够强的事件在推动方向。`, vote: 0 };
    }

    /* ─────── stage 1 · 量能 ─────── */
    case 'volume-capitulation':
    case 'volume-blowoff-top':
    case 'volume-dry-bottom': {
      const v = r?.volume;
      if (!v?.available) return off('量能读数不可用（日线不足）。');
      const want = {
        'volume-capitulation': 'CAPITULATION_VOLUME',
        'volume-blowoff-top': 'BLOWOFF_VOLUME',
        'volume-dry-bottom': 'DRY_BOTTOM',
      }[c.id];
      return v.pattern === want
        ? { state: 'hit', evidence: v.detail || v.reason || `量能形态 ${want} 成立。`, vote: v.vote }
        : { state: 'miss', evidence: v.detail || v.reason || `量能形态未出现（当前 ${v.pattern || '—'}）。`, vote: 0 };
    }

    /* ─────── stage 1 · 中期趋势 ─────── */
    case 'ma120-filter': {
      const t = r?.technicals;
      if (!t?.available) return off('120 日线判据弃权（日线不足）。');
      return t.vote120 > 0
        ? { state: 'hit', evidence: t.detail || `价格站上 120 日线 ${num(t.ma120, 1)}。`, vote: t.vote }
        : { state: 'miss', evidence: t.detail || `价格跌破 120 日线 ${num(t.ma120, 1)}。`, vote: t.vote };
    }

    case 'bear-market-signal': {
      const t = r?.technicals;
      if (!t?.available) return off('中期趋势读数不可用。');
      if (t.bearSignal) return { state: 'hit', evidence: t.detail || '牛转熊确认。', vote: -1 };
      if (t.bearPending) return off(`${(t.notes || []).join(' ') || '牛转熊待确认'} —— 门槛条件尚未走完，本条本轮不计票。`);
      return { state: 'miss', evidence: t.detail || '回撤与未创新高月数都没到牛转熊门槛。', vote: t.vote };
    }

    case 'bull-bear-line': {
      const t = r?.technicals;
      if (!t?.available) return off('回撤/新高读数不可用。');
      if (t.drawdownPct === null || t.drawdownPct === undefined)
        return off('缺少历史最高价，无法算回撤分档。');
      const dd = Number(t.drawdownPct);
      const mo = t.monthsSinceNewHigh === null || t.monthsSinceNewHigh === undefined ? 0 : Number(t.monthsSinceNewHigh);
      const away = t.drawdownZone !== 'NEAR_ATH';
      return away
        ? { state: 'hit', evidence: `距最高回撤 ${(dd * 100).toFixed(1)}%（${t.drawdownZone} 区间）、${mo} 个月未创新高 —— 牛熊分界已被触及。`, vote: t.vote }
        : { state: 'miss', evidence: `距最高回撤 ${(dd * 100).toFixed(1)}%（${t.drawdownZone} 区间）、${mo} 个月未创新高 —— 仍在分界线的安全侧。`, vote: 0 };
    }

    case 'longterm-structure': {
      const st = r?.structure;
      if (!st) return off('结构读数不可用。');
      return st.verdict === 'MIXED'
        ? { state: 'miss', evidence: `四分量归一化 ${num(st.normalized, 2)} —— 还没分出多空。`, vote: 0 }
        : { state: 'hit', evidence: `四分量归一化 ${num(st.normalized, 2)} → ${st.verdict}。`, vote: st.verdict === 'BULL' ? 1 : -1 };
    }

    /* ─────── stage 2 · 入场形态 / 空间门槛（系统二 · 开单） ─────── */
    case 'breakout-three-legs': {
      if (!trig) return off('触发层读数不可用。');
      const legs = Math.max(Number(trig.longLegs || 0), Number(trig.shortLegs || 0));
      const req = Number(trig.required || 0);
      return legs >= req && req > 0
        ? { state: 'hit', evidence: `向上/向下推进腿 ${trig.longLegs}/${trig.shortLegs} —— 已达到「${req} 条独立推进腿」。` }
        : { state: 'miss', evidence: `向上/向下推进腿 ${trig.longLegs ?? 0}/${trig.shortLegs ?? 0} —— 未达到 ${req} 条。` };
    }

    case 'hold-above-band': {
      if (!trig) return off('触发层读数不可用。');
      const lv = trig.hold?.level;
      return lv === 'H2'
        ? { state: 'hit', evidence: `连续 ${trig.hold?.bars ?? 0} 根收在轨外，站稳等级 H2 —— 只有 H2 允许开单。` }
        : { state: 'miss', evidence: lv ? `站稳等级 ${lv} —— 还没到 H2。` : '尚未形成触发侧，没有站稳等级。' };
    }

    case 'squeeze-then-expand': {
      if (!trig) return off('触发层读数不可用。');
      const sq = trig.squeeze || {};
      return sq.ok
        ? { state: 'hit', evidence: sq.detail || '第一条推进腿之前的带宽在 25 分位以下 —— 掰手腕已分出胜负。' }
        : { state: 'miss', evidence: sq.detail || `带宽分位 ${sq.percentile ?? '—'}，收口条件未满足。` };
    }

    case 'pullback-to-mid': {
      if (!trig?.entryMode) return off('本轮未生成入场模式。');
      return trig.entryMode === 'PULLBACK'
        ? { state: 'hit', evidence: '入场模式 = 回调入场（回踩中轨不破、重新收在轨外才入），不追高。' }
        : { state: 'miss', evidence: '入场模式 = 突破入场 —— 本轮没有出现「回踩中轨」这一情形。' };
    }

    case 'break-fail-then-flip': {
      if (!trig?.entryMode) return off('本轮未生成入场模式。');
      return trig.entryMode === 'BREAKOUT'
        ? { state: 'hit', evidence: '入场模式 = 突破入场，止损锚在突破参考位外侧 —— 收回轨内就止损，再次突破可以再开。' }
        : { state: 'miss', evidence: '本轮是回调入场 —— 「突破后回撤回去立马止损」这一情形未出现。' };
    }

    case 'key-level-break': {
      if (!plan) return off('尚无开单计划（方向未定或形态未成立）。');
      return { state: 'hit', evidence: '止损锚与止盈投影都锚在 K 线自己算出的关键位（轨道/中轨/区间极值）上，不接受外部传入的目标价。' };
    }

    case 'probe-with-head-position': {
      if (!plan) return off('尚无开单计划。');
      const ts = plan.tranches || [];
      return ts.length >= 2
        ? { state: 'hit', evidence: `计划拆成 ${ts.length} 笔：头仓 ${fmtBps(ts[0].ratioBps)} 先试错，主仓 ${fmtBps(ts[1].ratioBps)} 等回踩确认。` }
        : { state: 'miss', evidence: `计划只有 ${ts.length} 笔 —— 「头仓先试」的两批结构没成型。` };
    }

    case 'trend-only-daily-30pct':
      if (!plan) return off('尚无开单计划。');
      return plan.passMoveGate
        ? { state: 'hit', evidence: `区间投影 ${num(plan.projectedMovePct, 2)}% ≥ 「${plan.phaseLabel || '—'}」相位门槛 —— 空间够，属于可做的级别。` }
        : { state: 'miss', evidence: `区间投影 ${num(plan.projectedMovePct, 2)}% < 「${plan.phaseLabel || '—'}」相位门槛 —— 空间不够，不做。` };

    case 'range-no-trade':
      if (!plan) return off('尚无开单计划。');
      return plan.passMoveGate
        ? { state: 'miss', evidence: `空间够（${num(plan.projectedMovePct, 2)}%）—— 当前不属于「横盘不参与」的情形。` }
        : { state: 'hit', evidence: `空间不足（${num(plan.projectedMovePct, 2)}%）—— 按这条：耐心等趋势到来，不参与。` };

    /* ─────── stage 3 · 止损 / 加仓 / 止盈（系统二 · 开单后） ─────── */
    case 'stop-at-structure': {
      const st = s3?.stop;
      if (!st) return off('没有止损读数（无持仓且无开单计划）。');
      if (!st.recommended) return { state: 'miss', evidence: '没有任何候选能同时通过 12% 距离上限与 5% 权益预算 —— 止损无处可设。' };
      return {
        state: 'hit',
        evidence: `推荐 ${st.recommended.label} @ ${fmtPrice(wad(st.recommended.price))}；5% 权益预算是硬上限，不可提高${st.breached ? '。注意：标记价已击穿该位' : ''}。`,
      };
    }

    case 'profit-add-only': {
      if (!rl) return off('当前无持仓，滚仓阶梯不适用。');
      if (Number(rl.profitPct || 0) <= 0)
        return { state: 'miss', evidence: `浮盈 ${pct(rl.profitPct)} —— 亏损状态下滚仓阶梯一律不给，不许拉均价。` };
      return rl.profitOk
        ? { state: 'hit', evidence: `浮盈 ${pct(rl.profitPct)} ≥ 门槛 ${fmtBps(rl.triggerBps || 0)} —— 只有盈利仓才谈加仓。` }
        : { state: 'miss', evidence: `浮盈 ${pct(rl.profitPct)} < 门槛 ${fmtBps(rl.triggerBps || 0)} —— 第一道门未过，先不动。` };
    }

    case 'add-on-pullback-resume': {
      if (!rl) return off('当前无持仓，加仓时机不适用。');
      if (!rl.ladder?.length) return off('浮盈未过第一道门，阶梯尚未生成 —— 时机判据本轮不参与。');
      return rl.timingOk
        ? { state: 'hit', evidence: rl.resume?.reason || '回撤后已重新起势 —— 加仓时机成立，让起势飞一会。' }
        : { state: 'miss', evidence: rl.resume?.reason || '回撤后还没重新起势 —— 不怕加晚，怕追高。' };
    }

    case 'pyramid-decreasing': {
      if (!rl?.ladder?.length) return off('尚无加仓阶梯。');
      return {
        state: 'hit',
        evidence: `阶梯共 ${rl.ladder.length} 档，加仓量逐级递减；每次加仓后止损上移到新成本的保本位，只允许朝有利方向移动。`,
      };
    }

    case 'scale-down-leverage': {
      if (!rl?.ladder?.length) return off('尚无加仓阶梯，谈不上降杠杆。');
      const lt = rl.leverageTrim || {};
      return lt.needsTrim
        ? { state: 'miss', evidence: lt.detail || '加仓后实际杠杆将超过当前权益档位的建议上限 —— 杠杆纪律被破坏。' }
        : { state: 'hit', evidence: lt.detail || '加完阶梯后仍在档位建议的杠杆以内 —— 资金越大杠杆越低。' };
    }

    case 'no-fixed-takeprofit': {
      const tp = s3?.takeProfit || L?.takeProfit;
      if (!tp) return off('止盈读数不可用。');
      return { state: 'hit', evidence: '不设固定止盈；给出 1R/2R/3R 与区间等幅投影只作参考，真正离场看趋势破坏信号 —— 不吃顶也不吃底。' };
    }

    case 'exit-on-failed-bounce': {
      if (!ex?.applicable) return off('当前无持仓，离场通道不适用。');
      if (ex.bandBroken?.active) return { state: 'hit', evidence: ex.bandBroken.detail || '收盘已跌破中轨 —— 趋势被破坏。' };
      const fb = ex.failedBounce || {};
      return fb.failedBounce
        ? { state: 'hit', evidence: fb.reason || '调整后没有反弹 —— 该走了。' }
        : { state: 'miss', evidence: fb.reason || '回撤后已经反弹，或者回撤还不够深 —— 还不到离场时候。' };
    }

    case 'exit-on-bad-news': {
      if (!ex?.applicable) return off('当前无持仓，该通道不适用。');
      const n = ex.newsExit || {};
      if (n.available === false) return off(n.reason || '事件表不可用 —— 本条本轮无法评估，不按「没有利空」处理。');
      return n.active
        ? { state: 'hit', evidence: n.reason || '事件表出现与持仓反向的重事件 —— 立即平仓，不等技术位。' }
        : { state: 'miss', evidence: '持仓期间没有出现超过阈值的反向重事件。' };
    }

    case 'withdraw-one-third':
      return { state: 'manual', evidence: '账户层面的资金纪律，且本看板只读、没有出入金权限 —— 需要你手动执行，系统只负责提醒。' };

    case 'compounding-30d':
      return { state: 'manual', evidence: '依赖账户净值曲线口径，与「只读看板」定位冲突 —— 只做到提示，不自动复利。' };

    default:
      return off('本条暂无实时读数。');
  }
}

/** 一张「心得 → 本系统怎么落实 → 现在符合吗」的表。stages 决定取哪几阶段的判据。 */
function renderMatchInto(el, s, stages) {
  const cr = CRITERIA_CACHE;
  if (!cr) {
    loadCriteria();
    el.innerHTML = '<div class="tbl-empty">正在加载心得清单…</div>';
    return;
  }
  const list = (cr.criteria || []).filter((c) => stages.includes(c.stage));
  if (!list.length) {
    el.innerHTML = '<div class="tbl-empty">该系统暂无已收录的心得条目。</div>';
    return;
  }
  const groups = {};
  for (const c of list) (groups[c.group] ||= []).push(c);
  const counts = { hit: 0, miss: 0, off: 0, always: 0, manual: 0 };
  const p = [];

  p.push(`<div class="match-sum">`);
  for (const c of list) {
    const st = criterionState(c, s);
    counts[st.state] = (counts[st.state] || 0) + 1;
  }
  p.push(
    `<span class="badge ok">符合 ${counts.hit}</span>`,
    `<span class="badge bad">不符合 ${counts.miss}</span>`,
    `<span class="badge neutral">未参与 ${counts.off}</span>`,
    counts.always ? `<span class="badge info">常驻生效 ${counts.always}</span>` : '',
    counts.manual ? `<span class="badge warn">待人工 ${counts.manual}</span>` : '',
    `<span class="muted">共 ${list.length} 条心得已收录</span>`
  );
  p.push(`</div>`);

  for (const [g, items] of Object.entries(groups)) {
    const rows = items
      .map((c) => {
        const st = criterionState(c, s);
        const meta = MATCH_META[st.state] || MATCH_META.off;
        const cls = st.state === 'miss' ? '' : st.state === 'hit' ? '' : 'dim';
        return `<tr class="${cls}">
          <td style="text-align:left;width:34%"><span class="muted">「${esc(c.quote)}」</span>
            <div class="muted" style="font-size:11px">${esc(c.source || '')}</div></td>
          <td style="text-align:left" class="col-reason">${mdt(c.rule)}</td>
          <td style="text-align:center;white-space:nowrap"><span class="badge ${meta.cls}">${meta.txt}</span></td>
          <td style="text-align:left"><span class="muted">${mdt(st.evidence || '')}</span></td>
          <td style="text-align:center;white-space:nowrap">${matchVote(st.vote || 0)}</td>
        </tr>`;
      })
      .join('');
    p.push(`
      <div style="margin:12px 0 4px"><span class="badge info">${esc(g)}</span>
        <span class="muted" style="font-size:11.5px">${items.length} 条</span></div>
      <div class="tbl-wrap"><table class="lvl-table match-table">
        <thead><tr>
          <th style="text-align:left">心得原话</th>
          <th style="text-align:left">本系统怎么落实</th>
          <th style="text-align:center">当前</th>
          <th style="text-align:left">证据 / 差在哪</th>
          <th style="text-align:center">投票</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`);
  }

  p.push(`<div class="sec-note">
    「符合」说的是<strong>这条心得描述的情形现在成立</strong>，不是「和最终方向一致」——
    方向本身由这些判据合成，拿结论反过来判判据是循环论证；方向性证据看最右边的投票列。
    <strong>「未参与」不等于安全</strong>：它表示本轮取不到数据或该情形不适用，系统宁可显式弃权，
    也不会替这条判据默认成「没问题」。
  </div>`);

  el.innerHTML = p.join('');
}

function renderTrendMatch(s) {
  const el = $('trend-match');
  if (el) renderMatchInto(el, s, [0, 1]);
}

function renderTradeMatch(s) {
  const el = $('trade-match');
  if (el) renderMatchInto(el, s, [2, 3]);
}

/* ───────── 系统一 · 比特皇为什么给这个趋势 ─────────
 *
 * 与宏观卡的「判定理由」刻意不同粒度：宏观卡解释**每个读数为什么是这个值**，
 * 这张卡只回答「**为什么最后是这个方向**」—— 一句话结论 + 完整理由链 + 六个关键读数。
 * 理由链不截断、不摘要：用户要能顺着它一路追到判据。 */
function renderTrendWhy(s) {
  const el = $('trend-why');
  if (!el) return;
  const r = s.regime;
  const s1 = s.pipeline?.stages?.[0];
  if (!r || !s1) {
    el.innerHTML = `<div class="tbl-empty">宏观方向层不可用 —— 没有方向，也就没有「为什么」。<br/>
      <span class="muted">方向层缺席时系统二一律不开仓：宁可漏做，不可乱做。</span></div>`;
    return;
  }
  const badge = STAGE_META[1][s1.status] || STAGE_META[1].NEUTRAL;
  const kv = (k, v) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${v}</span></div>`;
  const reasons = (r.reasons || []).map((x) => `<div class="reason-item">${mdt(x)}</div>`).join('');
  const abst = (s1.abstentions || []);

  el.innerHTML = `
    <div class="why-head">
      <span class="badge ${badge.cls}">${esc(badge.txt)}</span>
      <b>${esc(r.biasLabel || '未定')}</b>
      <span class="muted">置信度 ${esc(r.confidence || '—')} · ${esc(r.intentLabel || '—')}</span>
      <span class="muted">${mdt(s1.summary || '')}</span>
    </div>
    <div class="why-grid">
      <div>
        <div class="why-title">比特皇为什么给这个趋势 <span class="muted">（完整理由链，不摘要）</span></div>
        <div class="reason-list">${reasons || '<div class="reason-item">方向层没有给出理由。</div>'}</div>
        ${abst.length ? `<div class="reason-list">${abst
          .map((x) => `<div class="reason-item note"><b>${esc(x)}</b> · <span class="muted">本轮弃权（数据不足，未投任何票）</span></div>`)
          .join('')}</div>` : ''}
        ${!abst.length ? '<div class="muted" style="font-size:11.5px;margin-top:6px">本轮没有判据弃权。</div>' : ''}
      </div>
      <div>
        <div class="why-title">六个关键读数 <span class="muted">（理由链里的量化支撑）</span></div>
        ${kv('周期相位', r.clock ? `${esc(r.clock.label)} <span class="muted">距上次减半 ${num(r.clock.monthsSince, 1)} 个月</span>` : '—')}
        ${kv('长周期结构', r.structure ? `<b>${esc(r.structure.verdict)}</b> <span class="muted">归一化 ${num(r.structure.normalized, 2)}</span>` : '—')}
        ${kv('120 日线', r.technicals?.available ? `<b>${esc(r.technicals.verdict)}</b> <span class="muted">${num(r.technicals.ma120, 1)}</span>` : '<span class="muted">弃权</span>')}
        ${kv('情绪拥挤度', r.sentiment?.available ? `${esc(r.sentiment.crowding || '无极端')} <span class="muted">${num(r.sentiment.percentile, 0)} 分位</span>` : '<span class="muted">弃权</span>')}
        ${kv('量能形态', r.volume?.available ? `${esc(r.volume.pattern || '常态')} <span class="muted">${num(r.volume.volPercentile, 0)} 分位</span>` : '<span class="muted">弃权</span>')}
        ${kv('顶部刹车', r.topBrake ? '<span class="badge bad">生效中</span>' : '<span class="muted">未触发</span>')}
      </div>
    </div>`;
}

/* ───────── 系统二 · 离场四通道（含比特皇原话） ───────── */
const EXIT_QUOTES = {
  stop: { q: '开单后亏损应该恐惧立马止损。', s: '《大作手操盘术》2' },
  news: { q: '下跌趋势下，有一个重大利空新闻马上平仓，防止回撤利润。', s: '《交易心得》4' },
  band: { q: '持仓到趋势结束。', s: '《交易策略》7' },
  fb: { q: '永远不要在最高点卖出，而是等到价格调整后没有反弹再卖出。', s: '《交易心得》4' },
};

function renderExitBoard(s) {
  const el = $('exit-board');
  if (!el) return;
  const s3 = s.pipeline?.stages?.[2];
  if (!s3 || s3.status === 'ABSENT') {
    el.innerHTML = '<div class="tbl-empty">没有持仓读数 —— 离场通道无从谈起。</div>';
    return;
  }
  if (s3.status === 'NOT_APPLICABLE') {
    el.innerHTML = `<div class="tbl-empty">当前无持仓 —— 系统二的离场通道不适用。<br/>
      <span class="muted">开单之后再回来这张表，四条通道会各自亮起。</span></div>`;
    return;
  }
  const ex = s3.exitSignals || {};
  const u = URGENCY_META[ex.urgency || s3.urgency] || URGENCY_META.NONE;
  const q = (k) => EXIT_QUOTES[k];
  const row = (k, name, active, txt, cls) => `
    <tr class="${active ? '' : 'dim'}">
      <td style="text-align:left">${name}<div class="muted" style="font-size:11px">「${esc(q(k).q)}」— ${esc(q(k).s)}</div></td>
      <td style="text-align:center">${active ? `<span class="badge ${cls}">触发</span>` : '<span class="badge neutral">未触发</span>'}</td>
      <td style="text-align:left"><span class="muted">${mdt(txt)}</span></td>
    </tr>`;

  const rec = s3.stop?.recommended;
  const struct = s3.stop?.structural;
  el.innerHTML = `
    <div class="why-head">
      <span class="badge ${u.cls}">${esc(u.txt)}</span>
      <b>${esc(s3.status === 'EXIT' ? '现在该离场' : s3.status === 'CAN_ADD' ? '可以加仓' : '持有中')}</b>
      <span class="muted">${mdt(s3.summary || '')}</span>
    </div>
    <div class="tbl-wrap"><table class="lvl-table">
      <thead><tr><th style="text-align:left">通道 · 比特皇为什么这么做</th><th style="text-align:center">触发</th><th style="text-align:left">读数 / 说明</th></tr></thead>
      <tbody>
        ${row('stop', '① 止损击穿 · 市价立刻走', !!ex.stopBreached?.active, ex.stopBreached?.detail || '无结构位止损可判。', 'bad')}
        ${row('news', '② 重大利空 · 市价立刻走', !!ex.newsExit?.active, ex.newsExit?.reason || '事件表无反向重事件。', 'bad')}
        ${row('band', '③ 收盘跌破中轨 · 收盘走', !!ex.bandBroken?.active, ex.bandBroken?.detail || '最新收盘仍在中轨安全侧。', 'warn')}
        ${row('fb', '④ 调整后没有反弹 · 观察后走', !!ex.failedBounce?.failedBounce, ex.failedBounce?.reason || '回撤后已反弹，或回撤不够深。', 'warn')}
      </tbody>
    </table></div>
    <div class="sec-note">
      止损：${rec ? `<b>${esc(rec.label)} @ ${fmtPrice(wad(rec.price))}</b>` : '无可用推荐位'}${
        struct && struct.label !== rec?.label ? ` <span class="muted">· 结构位参考 ${esc(struct.label)} @ ${fmtPrice(wad(struct.price))}</span>` : ''
      }${s3.stop?.breached ? ' <span class="badge bad">已击穿</span>' : ''}
      <br/>四条通道紧急度不同，决定市价单还是收盘价单 —— 跳空行情里这两者差很多。
      ${mdt(ex.summary || '')}
    </div>`;
}

function renderEquityChart(s) {
  const series = s.equityCurvesByPeriod?.[state.period];
  if (!series?.equity?.length) {
    $('equity').innerHTML = '<div class="tbl-empty">该时间尺度暂无数据</div>';
    $('equity-legend').innerHTML = '';
    return;
  }
  const points = series.equity.map((p) => ({ t: p.t, v: wadToNumber(wad(p.v)) }));
  const rawDd = state.period === 'perpAllTime' ? s.equityCurve?.maxDrawdown : null;
  const dd = ddView(rawDd);

  $('equity').innerHTML = renderEquity({ points, dd: rawDd ? { ...rawDd, doubtful: dd.doubtful } : null });
  const first = points[0].v;
  const last = points[points.length - 1].v;
  const chg = last - first;
  $('equity-legend').innerHTML = `
    <span class="lg">起点 $${first.toFixed(2)}</span>
    <span class="lg">末值 $${last.toFixed(2)}</span>
    <span class="lg" style="color:${chg >= 0 ? 'var(--up)' : 'var(--down)'}">区间变化 ${chg >= 0 ? '+' : ''}${chg.toFixed(2)}（${
    first ? ((chg / first) * 100).toFixed(2) : '0'
  }%）</span>
    <span class="lg">数据点 ${points.length}</span>
    ${
      dd.has
        ? `<span class="lg">最大回撤 ${
            dd.doubtful
              ? `${pct(rawDd.pct)}<span class="doubt">分母失真</span>，请看绝对金额 $${fmtWad(wad(rawDd.drawdownAmount ?? 0n), 2)}`
              : `${pct(rawDd.pct)}（${rawDd.method === 'pnl-space' ? '已排除出入金' : '含出入金'}）`
          }</span>`
        : ''
    }
  `;
}

/* ─────────────────────── 渲染：绩效 / 成交 / 其它 ─────────────────────── */

function renderPerformance(s) {
  const S = s.summary;
  const c = S.closing;
  const cy = S.cycles;
  const kv = (k, v) => `<div class="kv"><span class="k">${k}</span><span class="v">${v}</span></div>`;

  const partA = `
    <div class="sec-title">口径 A · 按平仓成交（窗口无关，当前可用）</div>
    ${kv('平仓成交笔数', c.count)}
    ${kv('胜 / 负', `${c.wins} / ${c.losses}`)}
    ${kv('胜率', c.winRate === null ? '—' : pct(c.winRate, 2))}
    ${kv('盈利总额', '$' + fmtWad(wad(c.grossWin), 2))}
    ${kv('亏损总额', '$' + fmtWad(wad(c.grossLoss), 2))}
    ${kv('平均盈利', '$' + fmtWad(wad(c.avgWin), 2))}
    ${kv('平均亏损', '$' + fmtWad(wad(c.avgLoss), 2))}
    ${kv('盈亏比', c.payoffRatio === null ? '—' : c.payoffRatio.toFixed(2) + ' : 1')}
    ${kv('利润因子', c.profitFactor === null ? '—' : c.profitFactor.toFixed(2))}
    ${kv('毛盈亏', '$' + fmtWad(wad(S.realizedGross), 2))}
    ${kv('手续费', '$' + fmtWad(wad(S.fees), 2))}
    ${kv('资金费净额', '$' + fmtWad(wad(S.fundingNet), 2))}
    ${kv('已实现净额', '<b>$' + fmtWad(wad(S.realizedNet), 2) + '</b>')}`;

  const partB = `
    <div class="sec-title">口径 B · 按持仓周期 ${cy.reliable ? '' : '<span class="badge warn">样本不可信</span>'}</div>
    ${kv('完整周期', cy.closed)}
    ${kv('未平仓', cy.open)}
    ${kv('周期胜率', cy.winRate === null ? '—' : pct(cy.winRate, 2))}
    ${kv('周期利润因子', cy.profitFactor === null ? '—' : cy.profitFactor.toFixed(2))}
    ${kv('最长连胜', cy.longestWinStreak)}
    ${kv('最长连亏', cy.longestLossStreak)}
    ${cy.note ? `<div class="warn-item" style="margin:9px 13px">${esc(cy.note)}</div>` : ''}`;

  const partC = `
    <div class="sec-title">成交窗口</div>
    ${kv('成交笔数', S.fills.count)}
    ${kv('时间跨度', S.fills.spanDays === null ? '—' : S.fills.spanDays.toFixed(2) + ' 天')}
    ${kv('涉及标的', S.fills.coins)}
    ${kv('最早 / 最近', `${dtShort(S.fills.firstTime)} → ${dtShort(S.fills.lastTime)}`)}`;

  $('performance').innerHTML = partA + partB + partC;
}

function renderByCoin(s) {
  const rows = (s.summary.byCoin || [])
    .slice(0, 40)
    .map((c) => {
      const net = wad(c.net);
      return `<tr>
      <td>${esc(c.coin)}</td>
      <td>${c.fills}</td>
      <td>${c.wins}/${c.losses}</td>
      <td class="${cls(net)}">${sign(net)}${fmtWad(net, 2)}</td>
    </tr>`;
    })
    .join('');
  $('bycoin').innerHTML = rows
    ? `<div class="tbl-wrap scroll-y"><table><thead><tr><th>标的</th><th>成交</th><th>胜/负</th><th>净额</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : '<div class="tbl-empty">无成交数据</div>';
}

function renderFills(s) {
  const rows = (s.trades || [])
    .map((t) => {
      const net = wad(t.netPnl);
      const state2 = t.stillOpen
        ? '<span class="badge info">持仓中</span>'
        : t.win
        ? '<span class="badge ok">盈</span>'
        : '<span class="badge bad">亏</span>';
      return `<tr>
      <td>${esc(t.coin)} <span class="badge ${t.isLong ? 'long' : 'short'}">${t.isLong ? '多' : '空'}</span></td>
      <td>${dtShort(t.closeTime || t.openTime)}</td>
      <td>${t.fillCount}</td>
      <td class="${cls(net)}">${sign(net)}${fmtWad(net, 2)}</td>
      <td>${state2}</td>
    </tr>`;
    })
    .join('');
  $('fills-note').textContent = s.summary.cycles.reliable
    ? `${s.summary.cycles.closed} 个完整周期`
    : '按持仓周期归集（样本见绩效区说明）';
  $('fills').innerHTML = rows
    ? `<div class="tbl-wrap scroll-y"><table><thead><tr><th>标的</th><th>时间</th><th>成交数</th><th>净盈亏</th><th>结果</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : '<div class="tbl-empty">窗口内未归集到完整持仓周期</div>';
}

function renderOrders(s) {
  $('orders-note').textContent = `${s.orders.length} 笔`;
  const rows = (s.orders || [])
    .slice(0, 120)
    .map(
      (o) => `<tr>
      <td>${esc(o.coin)} <span class="badge ${o.side === 'B' ? 'long' : 'short'}">${o.side === 'B' ? '买' : '卖'}</span>${o.reduceOnly ? ' <span class="badge neutral">只减仓</span>' : ''}</td>
      <td>${fmtPrice(wad(o.limitPx))}</td>
      <td>${fmtWad(wad(o.sz), 6)}</td>
      <td>${esc(o.orderType || '')}${o.tif ? '/' + esc(o.tif) : ''}</td>
      <td>${o.isTrigger ? '<span class="badge warn">' + esc(o.triggerCondition || '触发') + '</span>' : '—'}</td>
    </tr>`
    )
    .join('');
  $('orders').innerHTML = rows
    ? `<div class="tbl-wrap scroll-y-sm"><table><thead><tr><th>标的</th><th>价格</th><th>数量</th><th>类型</th><th>触发</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : '<div class="tbl-empty">无挂单</div>';
}

function renderFunding(s) {
  const rows = (s.funding || [])
    .slice(0, 120)
    .map((f) => {
      const u = wad(f.usdc);
      return `<tr><td>${esc(f.coin || '')}</td><td>${dtShort(f.time)}</td><td class="${cls(u)}">${sign(u)}${fmtWad(u, 4)}</td>
      <td>${f.fundingRate ? (Number(f.fundingRate) * 100).toFixed(4) + '%' : '—'}</td></tr>`;
    })
    .join('');
  $('funding').innerHTML = rows
    ? `<div class="tbl-wrap scroll-y-sm"><table><thead><tr><th>标的</th><th>时间</th><th>金额</th><th>费率</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : '<div class="tbl-empty">无资金费流水</div>';
}

function renderDeposits(s) {
  const d = s.deposits || {};
  const kv = (k, v) => `<div class="kv"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  const rows = (d.detail || [])
    .slice(0, 60)
    .map((x) => {
      const u = wad(x.usdc);
      return `<tr><td>${esc(x.type || '')}</td><td>${dtShort(x.time)}</td><td class="${cls(u)}">${sign(u)}${fmtWad(u, 2)}</td></tr>`;
    })
    .join('');
  $('deposits').innerHTML =
    kv('累计转入', '$' + fmtWad(wad(d.deposit), 2)) +
    kv('累计转出', '$' + fmtWad(wad(d.withdraw), 2)) +
    kv('净出入金', '$' + fmtWad(wad(d.net), 2)) +
    (rows
      ? `<div class="tbl-wrap scroll-y-sm"><table><thead><tr><th>类型</th><th>时间</th><th>金额</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<div class="tbl-empty">无流水</div>');
}

function renderWarnings(s) {
  const all = [];
  for (const w of s.warnings || []) all.push({ w, kind: 'warn' });
  for (const p of s.positions || []) {
    for (const w of p.levels?.warnings || []) all.push({ w: `[${p.coin}] ${w}`, kind: 'warn' });
  }
  const el = $('warnings');
  if (!all.length) {
    el.innerHTML = '<div class="warn-list"><div class="warn-item ok">未触发任何规则告警</div></div>';
    return;
  }
  el.innerHTML = `<div class="warn-list">${all
    // 同 renderPositions：告警文案带 **强调**，用 esc 会露出字面星号。
    .map((x) => `<div class="warn-item ${x.kind === 'bad' ? 'bad' : ''}">${mdt(x.w)}</div>`)
    .join('')}</div>`;
}

/* ─────────────────────── 预警中心 ─────────────────────── */

/**
 * 预警在浏览器里也是**本地评估**的，用的是和后端守护进程同一份 src/alerts.js。
 *
 * 为什么要本地再算一遍：守护进程 60 秒一轮，而这里跟着 WebSocket 的中间价走 ——
 * 价格击穿止损的那一瞬间就能看到，不用等下一轮轮询。两者共用同一个纯函数引擎，
 * 所以阈值、迟滞、文案不会出现两套。
 *
 * 状态存在 localStorage（按 网络+地址 分桶），刷新页面不会把已经看过的告警再弹一遍。
 */
const ALERT_LS = 'bithuang-hl-alerts/v1';

const alerting = {
  state: null, // 上一次的引擎状态（活动集 + 每条的 lastNotifyAt）
  result: null,
  config: resolveConfig(null),
  muted: new Set(),
  notify: false,
  pushStatus: null,
  statusAt: 0,
  saveTimer: null,
  bucket: null, // 当前状态所属的「网络+地址」桶
};

function alertBucketKey() {
  return `${ALERT_LS}/${state.network}/${state.address || 'none'}`;
}

/**
 * 切换账户/网络时切换状态桶。
 *
 * 必须做隔离：主网换到测试网、或换一个地址时，如果沿用上一个账户的活动集，
 * 新账户的所有条件都会被判成「从活跃变消失」→ 一次性刷出一堆「已恢复」。
 */
function syncAlertBucket() {
  const k = alertBucketKey();
  if (alerting.bucket === k) return false;
  alerting.bucket = k;
  alerting.result = null;
  loadAlerting();
  return true;
}

function loadAlerting() {
  alerting.state = null;
  alerting.muted = new Set();
  alerting.notify = false;
  try {
    const raw = localStorage.getItem(alertBucketKey());
    if (!raw) return;
    const j = JSON.parse(raw);
    if (j?.state?.active) alerting.state = j.state;
    if (Array.isArray(j?.muted)) alerting.muted = new Set(j.muted);
    if (typeof j?.notify === 'boolean') alerting.notify = j.notify;
  } catch {
    /* 存储损坏按空状态走：顶多多弹一次，不影响功能 */
  }
}

function saveAlerting() {
  if (alerting.saveTimer) return;
  // 引擎每 1.2 秒就可能跑一次（跟着中间价），没必要每次都落盘
  alerting.saveTimer = setTimeout(() => {
    alerting.saveTimer = null;
    try {
      localStorage.setItem(
        alertBucketKey(),
        JSON.stringify({ state: alerting.state, muted: [...alerting.muted], notify: alerting.notify })
      );
    } catch {
      /* 隐私模式忽略 */
    }
  }, 2500);
}

/** 跑一轮引擎并产出通知。mids 传入后，预警会跟着实时价走。 */
function runAlerting(snap) {
  if (!snap?.ok) return;
  try {
    const res = evaluateAlerts({
      snapshot: snap,
      mids: state.mids,
      prev: alerting.state,
      now: Date.now(),
      config: alerting.config,
    });
    alerting.result = res;
    alerting.state = res.state;
    saveAlerting();

    const fresh = res.events.filter((e) => !alerting.muted.has(e.key));
    if (fresh.length) notifyAlerts(fresh);
  } catch (e) {
    console.error('预警引擎异常', e);
  }
}

function notifyAlerts(events) {
  const box = $('toasts');
  if (!box) return;
  for (const e of events) {
    pushToast(box, e);
    maybeSystemNotify(e);
  }
}

const ALERT_ICON = { critical: '🔴', warn: '🟠', info: '🟢' };

function pushToast(box, e) {
  const el = document.createElement('div');
  el.className = `toast ${e.severity}`;
  el.innerHTML = `<div class="th">${ALERT_ICON[e.severity] || ''} ${esc(e.title)}</div>` +
    (e.detail ? `<div class="tb">${mdt(e.detail)}</div>` : '') +
    `<div class="tm">${esc(FAMILY_LABELS[e.family] || '')} · ${esc(e.coin)} · ${new Date(e.at).toLocaleTimeString('zh-CN', { hour12: false })}</div>`;
  el.title = '点击关闭';
  el.addEventListener('click', () => el.remove());
  box.appendChild(el);
  // 极端情况下（比如一次切换网络触发了十几条）不要把屏幕糊满
  while (box.children.length > 5) box.firstChild.remove();
  setTimeout(() => el.remove(), 12000);
}

/**
 * 系统级通知的取舍：
 *   · 严重级 —— 总是弹（哪怕你正盯着页面，也值得打断）；
 *   · 警告级 —— 只在页面不处于前台时弹。否则你在盯盘，弹窗会一直遮挡界面。
 */
function maybeSystemNotify(e) {
  if (!alerting.notify) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const isRecovery = e.kind === 'recovered';
  if (!isRecovery && e.severity !== 'critical' && !document.hidden) return;
  try {
    new Notification(isRecovery ? '预警已恢复' : `${ALERT_ICON[e.severity] || ''} 预警 · ${e.coin}`, {
      body: `${e.title}${e.detail ? `\n${e.detail}` : ''}`,
      // tag 相同 → 同一条件的重复通知会替换而不是堆叠
      tag: e.key,
    });
  } catch {
    /* 某些环境（无通知服务）会抛，忽略 */
  }
}

function fmtAgo(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

const FAMILY_BADGE = { risk: 'bad', funding: 'warn', roll: 'info' };

function renderAlerts(s) {
  const res = alerting.result;
  const badge = $('alert-badge');
  const counts = $('alert-counts');

  if (!res) {
    $('alerts').innerHTML = '<div class="tbl-empty">等待首份快照…</div>';
    counts.textContent = '';
    badge.classList.add('hidden');
    return;
  }

  const sum = res.summary;

  // 顶栏角标始终反映**真实**状态，不因「已读」而减少 ——
  // 预警显示一旦开始粉饰，就等于没有预警。
  if (sum.total === 0) {
    badge.className = 'alert-badge clear';
    badge.textContent = '✓ 无预警';
    badge.classList.remove('hidden');
  } else {
    badge.className = `alert-badge${sum.critical ? ' critical' : ''}`;
    badge.textContent = `⚠ ${sum.total}${sum.critical ? ` · 严重 ${sum.critical}` : ''}`;
    badge.classList.remove('hidden');
  }

  counts.innerHTML =
    sum.total === 0
      ? '<span class="c-ok">未触发任何规则</span>'
      : `<span class="c-crit">${sum.critical} 严重</span> · <span class="c-warn">${sum.warn} 警告</span> · 仓位风险 ${sum.byFamily.risk} / 资金费 ${sum.byFamily.funding} / 滚仓 ${sum.byFamily.roll}`;

  const now = Date.now();
  const rows = res.list
    .map((a) => {
      const muted = alerting.muted.has(a.key);
      return `<div class="alert-row ${a.severity}${muted ? ' muted' : ''}">
      <div class="who">
        <span class="coin">${esc(a.coin)}</span>
        <span class="badge ${FAMILY_BADGE[a.family] || 'neutral'}">${esc(FAMILY_LABELS[a.family] || a.family)}</span>
      </div>
      <div class="body">
        <div class="t">${esc(a.title)}
          <span class="badge ${a.severity === 'critical' ? 'bad' : 'warn'}">${esc(SEVERITY_LABELS[a.severity] || a.severity)}</span>
          <span class="tag">${esc(RULE_LABELS[a.rule] || a.rule)}</span>
          ${muted ? '<span class="badge neutral">已静音</span>' : ''}
        </div>
        <div class="d">${mdt(a.detail)}</div>
      </div>
      <div class="when" title="条件成立时间 ${dt(a.since)}">持续<br>${esc(fmtDuration(now - (a.since || now)))}</div>
      <div class="act"><button class="mute-btn" data-mute="${esc(a.key)}">${muted ? '取消静音' : '静音'}</button></div>
    </div>`;
    })
    .join('');

  $('alerts').innerHTML =
    sum.total === 0
      ? `<div class="alert-empty ok">当前没有触发任何预警条件。正在监控 ${s.positions.length} 个持仓的清算距离、止损距离、趋势、资金费与滚仓触发价。</div>`
      : `<div class="alert-list">${rows}</div>`;

  $('alerts').querySelectorAll('[data-mute]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const k = btn.dataset.mute;
      if (alerting.muted.has(k)) alerting.muted.delete(k);
      else alerting.muted.add(k);
      saveAlerting();
      renderAlerts(s);
    });
  });

  const foot = [
    `<span>监控 ${s.positions.length} 个持仓 · 每条规则都带迟滞与 ${Math.round(
      (alerting.config.cooldownMs || 0) / 60000
    )} 分钟冷却 —— 阈值附近抖动不会重复推送</span>`,
    `<span class="mut">上次评估 ${new Date(res.at).toLocaleTimeString('zh-CN', { hour12: false })}</span>`,
  ];
  if (res.uncovered.length) {
    foot.push(
      `<span class="mut">${esc(res.uncovered.map((u) => u.coin).join('、'))} 未算策略读数，本次只做了清算检查</span>`
    );
  }
  if (alerting.muted.size) {
    foot.push(`<span class="mut">已静音 ${alerting.muted.size} 条（仅影响通知，列表照常显示）</span>`);
  }
  $('alert-foot').innerHTML = foot.join('');
}

/* ─────────────────────── 服务端推送状态 ─────────────────────── */

async function fetchAlertStatus(force = false) {
  if (!state.address) return;
  // 60 秒节流：这个接口要读磁盘，没必要跟着每次刷新打
  if (!force && Date.now() - alerting.statusAt < 60000) return;
  alerting.statusAt = Date.now();
  try {
    const res = await fetch(
      `/api/alerts/status?network=${encodeURIComponent(state.network)}&user=${encodeURIComponent(state.address)}`
    );
    const j = await res.json();
    alerting.pushStatus = j?.ok ? j : null;
    // 阈值以后端配置为准 —— 否则界面上的迟滞行为会和推送出去的对不上
    if (j?.ok && j.thresholds) alerting.config = resolveConfig(j.thresholds);
  } catch {
    alerting.pushStatus = null;
  }
  renderPushStatus();
}

function renderPushStatus() {
  const el = $('alert-push-status');
  if (!el) return;
  const p = alerting.pushStatus;
  if (!p) {
    el.textContent = '服务端推送状态不可用';
    return;
  }
  if (!p.configured) {
    el.innerHTML =
      '服务端推送未配置 <span class="muted">（把 .alerts/config.example.json 复制成 config.json 并填入机器人地址）</span>';
    return;
  }
  const usable = p.notify?.usable || 0;
  const total = p.notify?.channels?.length || 0;
  const w = p.watcher || {};
  let wTxt;
  if (w.lastRunAt == null) wTxt = '守护进程未启动';
  else if (w.running) wTxt = `守护进程在跑（${w.runs ?? '?'} 轮）`;
  else wTxt = `守护进程已停止（上次 ${fmtAgo(Date.now() - w.lastRunAt)}）`;
  el.innerHTML = `推送通道 <b>${usable}/${total}</b> 可用 · ${esc(wTxt)}${
    w.lastError ? ` <span class="muted">· 最近错误：${esc(w.lastError)}</span>` : ''
  }`;
}

/* ─────────────────────── 主流程 ─────────────────────── */

let renderTimer = null;
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    if (state.snap) renderAll(state.snap);
  }, 1200);
}

/**
 * 把单个面板的渲染失败局限在它自己那张卡片里。
 *
 * 为什么必须这样：renderAll 之前是「全有或全无」——
 * 一处 fmtWad 拿到字符串就抛 TypeError，于是它之后的 12 个面板集体空白
 * （含 K 线图），而异常被 refresh() 的 catch 吞成一条横幅，界面上根本看不出问题在哪。
 * 现在每个面板各自 try/catch，失败就地把错误写进自己的卡片，其余面板照常渲染。
 */
function renderPanel(id, fn) {
  try {
    fn();
  } catch (e) {
    const el = $(id);
    if (el) el.innerHTML = `<div class="tbl-empty">该面板渲染失败：${esc(e.message)}</div>`;
    console.error(`面板 ${id} 渲染失败`, e);
  }
}

function renderAll(s) {
  // 预警放在最前：即便下面某个面板渲染抛错，预警也必须已经产出并展示出来。
  // 预警是「离场/加仓」的判断依据，它的优先级高于任何一个展示面板。
  runAlerting(s);
  renderPanel('alerts', () => renderAlerts(s));
  // 结论卡放在最前：它只读 s.pipeline 的结果，不参与任何计算。
  // 它失败时页面最重要的那一格会明说失败，而不是留白 —— 留白会被读成「无动作」。
  renderPanel('verdict', () => renderVerdict(s));
  // 两大系统各自的「为什么」与「心得逐条对照」—— 它们只读快照，不参与任何计算。
  renderPanel('trend-why', () => renderTrendWhy(s));
  renderPanel('trend-match', () => renderTrendMatch(s));
  renderPanel('exit-board', () => renderExitBoard(s));
  renderPanel('trade-match', () => renderTradeMatch(s));
  renderPanel('kpis', () => renderKPIs(s));
  renderPanel('fold-pipeline-state', () => renderFoldStates(s));
  renderPanel('positions', () => renderPositions(s));
  renderPanel('macro', () => renderMacro(s));
  renderPanel('pipeline', () => renderPipeline(s));
  renderPanel('strategy', () => renderStrategy(s));
  renderPanel('equity', () => renderEquityChart(s));
  renderPanel('performance', () => renderPerformance(s));
  renderPanel('bycoin', () => renderByCoin(s));
  renderPanel('fills', () => renderFills(s));
  renderPanel('orders', () => renderOrders(s));
  renderPanel('funding', () => renderFunding(s));
  renderPanel('deposits', () => renderDeposits(s));
  renderPanel('warnings', () => renderWarnings(s));
  // 图表渲染失败必须显形 —— 之前这里吞掉异常，图表区会「一片空白且没有任何提示」，
  // 排查时根本不知道是没数据、还是渲染炸了。
  renderChart(s).catch((e) => {
    $('chart').innerHTML = `<div class="tbl-empty">K 线渲染失败：${esc(e.message)}</div>`;
    $('chart-legend').innerHTML = '';
    console.error('renderChart failed', e);
  });
  $('foot-status').textContent = `地址 ${s.user} · ${s.networkLabel} · 快照 ${dt(s.fetchedAt)}`;
  const t = s.timings || {};
  $('foot-timing').textContent = `接口耗时 ${Object.entries(t)
    .map(([k, v]) => `${k} ${v}ms`)
    .join(' · ')}`;
}

function showBanner(msg, kind = 'error') {
  const el = $('banner');
  el.className = `banner ${kind}`;
  el.textContent = msg;
  el.classList.remove('hidden');
}
function hideBanner() {
  $('banner').classList.add('hidden');
}

async function refresh() {
  if (!state.address) return;
  if (state.loading) return;
  state.loading = true;
  $('refresh').disabled = true;
  try {
    syncAlertBucket(); // 换地址/换网络要先切状态桶，否则会误报一片「已恢复」
    const snap = await fetchSnapshot();
    state.snap = snap;
    $('empty-state').classList.add('hidden');
    $('content').classList.remove('hidden');
    hideBanner();
    renderAll(snap);
    fetchAlertStatus(); // 内部有 60 秒节流，不必 await
  } catch (e) {
    showBanner(`加载失败：${e.message}`, 'error');
    if (!state.snap) $('empty-state').classList.remove('hidden');
  } finally {
    state.loading = false;
    $('refresh').disabled = false;
  }
}

/* ─────────────────────── WebSocket 实时价格 ─────────────────────── */

let ws = null;
let wsRetry = 0;
let wsTimer = null;

function connectWS() {
  if (ws) {
    try {
      ws.close();
    } catch {}
    ws = null;
  }
  const url = state.network === 'testnet' ? 'wss://api.hyperliquid-testnet.xyz/ws' : 'wss://api.hyperliquid.xyz/ws';
  try {
    ws = new WebSocket(url);
  } catch {
    return;
  }

  ws.onopen = () => {
    wsRetry = 0;
    $('live-dot').classList.add('on');
    $('live-dot').title = '实时价格推送已连接';
    // 只订阅全市场中间价 —— 公开频道，无需认证
    ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'allMids' } }));
    // 定期 ping 保活（服务端 50 秒无消息会断）
    if (wsTimer) clearInterval(wsTimer);
    wsTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ method: 'ping' }));
    }, 40000);
  };

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.channel === 'allMids' && msg.data?.mids) {
      const coins = new Set([
        state.coin,
        ...(state.snap?.positions || []).map((p) => p.coin),
        ...(state.snap?.levelCoins || []),
      ]);
      let changed = false;
      for (const c of coins) {
        const v = msg.data.mids[c];
        if (v && state.mids[c] !== v) {
          state.mids[c] = v;
          changed = true;
        }
      }
      if (changed) scheduleRender();
    }
  };

  ws.onclose = () => {
    $('live-dot').classList.remove('on');
    $('live-dot').title = '实时价格推送已断开，正在重连';
    if (wsTimer) clearInterval(wsTimer);
    // 指数退避重连，最多 30 秒
    wsRetry = Math.min(wsRetry + 1, 6);
    setTimeout(connectWS, Math.min(1000 * 2 ** wsRetry, 30000));
  };

  ws.onerror = () => {
    try {
      ws.close();
    } catch {}
  };
}

/* ─────────────────────── 事件绑定 ─────────────────────── */

function bind() {
  $('network-seg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-network]');
    if (!btn) return;
    state.network = btn.dataset.network;
    [...$('network-seg').children].forEach((b) => b.classList.toggle('active', b === btn));
    saveState();
    state.chartCache.clear();
    state.snap = null;
    connectWS();
    refresh();
  });

  let addrTimer = null;
  $('address').addEventListener('input', (e) => {
    const v = e.target.value.trim();
    state.address = v;
    saveState();
    clearTimeout(addrTimer);
    // 地址是 42 位才自动触发，避免每敲一个字符就发请求
    if (/^0x[0-9a-fA-F]{40}$/.test(v)) addrTimer = setTimeout(refresh, 400);
  });

  $('coin').addEventListener('change', (e) => {
    state.coin = e.target.value.trim().toUpperCase() || 'BTC';
    saveState();
    refresh();
  });

  $('phase').addEventListener('change', (e) => {
    state.phase = e.target.value;
    saveState();
    refresh();
  });

  $('interval-seg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-interval]');
    if (!btn) return;
    state.interval = btn.dataset.interval;
    [...$('interval-seg').children].forEach((b) => b.classList.toggle('active', b === btn));
    saveState();
    if (state.snap) renderChart(state.snap);
  });

  $('period-seg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-period]');
    if (!btn) return;
    state.period = btn.dataset.period;
    [...$('period-seg').children].forEach((b) => b.classList.toggle('active', b === btn));
    saveState();
    if (state.snap) renderEquityChart(state.snap);
  });

  $('level-coin').addEventListener('change', (e) => {
    state.levelCoin = e.target.value;
    if (state.snap) renderStrategy(state.snap);
  });

  $('show-bands').addEventListener('change', (e) => {
    state.showBands = e.target.checked;
    saveState();
    if (state.snap) renderChart(state.snap);
  });
  $('show-levels').addEventListener('change', (e) => {
    state.showLevels = e.target.checked;
    saveState();
    if (state.snap) renderChart(state.snap);
  });

  $('autorefresh').addEventListener('change', (e) => {
    state.autoRefresh = e.target.checked;
    saveState();
    setupAutoRefresh();
  });

  $('refresh').addEventListener('click', refresh);

  $('alert-badge').addEventListener('click', () => {
    const el = $('alert-card');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // 「重置提醒计时」：把当前活动告警的 lastNotifyAt 推到当前时刻，
  // 只影响「重复提醒」的节奏，不减列表、不减角标 —— 提醒可以推迟，事实不能被隐藏。
  $('alert-reset').addEventListener('click', () => {
    if (!alerting.state?.active) return;
    const t = Date.now();
    for (const a of Object.values(alerting.state.active)) a.lastNotifyAt = t;
    saveAlerting();
    if (state.snap) renderAlerts(state.snap);
  });

  $('notify-perm').addEventListener('change', async (e) => {
    const want = e.target.checked;
    if (!want) {
      alerting.notify = false;
      saveAlerting();
      return;
    }
    if (typeof Notification === 'undefined') {
      e.target.checked = false;
      showBanner('这个浏览器不支持系统通知。', 'warn');
      return;
    }
    let perm = Notification.permission;
    if (perm === 'default') perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      e.target.checked = false;
      alerting.notify = false;
      showBanner(
        perm === 'denied'
          ? '系统通知已被浏览器拒绝。需要在地址栏左侧的站点设置里手动允许，然后刷新页面。'
          : '未获得通知授权。',
        'warn'
      );
      // 注意：不能在用户手势之外直接请求权限，所以这里不重试
      setTimeout(hideBanner, 8000);
      return;
    }
    alerting.notify = true;
    saveAlerting();
    new Notification('预警通知已开启', {
      body: '严重级预警会立即通知；警告级只在你切到别的标签页时通知。',
      tag: 'bithuang-notify-on',
    });
  });
}

let autoTimer = null;
function setupAutoRefresh() {
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = null;
  if (state.autoRefresh && state.address) {
    autoTimer = setInterval(refresh, 20000);
  }
}

/* ─────────────────────── 启动 ─────────────────────── */

function boot() {
  loadState();
  applyUrlParams(); // URL 是"这一次要看的"，localStorage 是"上次看的" —— 前者优先
  syncAlertBucket(); // 先按已保存的 网络+地址 载入预警状态，再回填 UI

  // 回填 UI
  [...$('network-seg').children].forEach((b) => b.classList.toggle('active', b.dataset.network === state.network));
  $('address').value = state.address;
  $('coin').value = state.coin;
  $('phase').value = state.phase;
  $('autorefresh').checked = state.autoRefresh;
  $('show-bands').checked = state.showBands;
  $('show-levels').checked = state.showLevels;

  // 通知开关要和浏览器实际授权状态对齐 ——
  // 用户可能在站点设置里撤销过授权，这时开关必须显示为关闭，而不是骗人。
  const granted = typeof Notification !== 'undefined' && Notification.permission === 'granted';
  alerting.notify = alerting.notify && granted;
  $('notify-perm').checked = alerting.notify;
  renderPushStatus();

  [...$('interval-seg').children].forEach((b) => b.classList.toggle('active', b.dataset.interval === state.interval));
  [...$('period-seg').children].forEach((b) => b.classList.toggle('active', b.dataset.period === state.period));

  bind();
  connectWS();
  setupAutoRefresh();
  // 判据清单与行情无关，尽早拉 —— 这样第一次渲染宏观卡时它已经在手上了
  loadCriteria();

  if (state.address) {
    refresh();
  } else {
    $('empty-state').classList.remove('hidden');
    $('content').classList.add('hidden');
  }
}

boot();
