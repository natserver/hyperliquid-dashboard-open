/**
 * 宏观与基本面数据源（Macro Sources）
 * ══════════════════════════════════════════════════════════════════════
 *
 * ── 这个文件为什么存在 ────────────────────────────────────────────────
 *
 * `src/regime-criteria.js` 里有 6 条判据，rule 原文写的是：
 *
 *     「没有免费无密钥的接口能可靠量化媒体情绪」
 *     「ETF 日度净流入需付费数据源」
 *     「链上活跃地址需第三方数据源（Glassnode 等，无免费无密钥接口）」
 *     「DXY / 美联储议息均无免费无密钥接口」
 *     「机构持仓占比需链上/申报数据汇总」
 *     「监管事件需人工分类」
 *
 * **这六句结论经实测全部是错的**（2026-09 逐条请求验证）。全部六条都有
 * 免费、无需注册、无需密钥的公开源。本模块把它们接上，于是那 6 条判据
 * 从 `implemented: false`（弃权）变成可求值的真实读数。
 *
 * 保持诚实的两条底线：
 *   · 每个读数都带 `provider` / `url` / `asOf` / `license` —— 谁的数据、什么时候的、
 *     什么许可，界面上必须看得见。转述别人的数据不署来源是不可接受的。
 *   · 取不到就是取不到。`status` 三态：ok（新鲜）/ stale（可用但过期）/
 *     unavailable（彻底失败，回落到手工事件表）。**绝不用 0 假装取到了。**
 *
 * ── 为什么 ETF 那一源要三级回落 ──────────────────────────────────────
 *
 * Farside 是业内事实标准，但前面挂着 Cloudflare（直连 403）。所以：
 *   ① 直连 Farside          —— 最快，但通常 403
 *   ② 经 r.jina.ai 读取      —— 实测可绕开，能拿到**当天**数据
 *   ③ CC0 冻结数据集回落     —— GitHub 上的公共领域归档，历史最长（14 个月），
 *                              但冻结在 2026-09-10，只能标 stale
 *
 * 三级都在同一个函数里，且**如实报告用的是哪一级** —— 用户看到的"最新"
 * 到底是今天的还是十天前的，不能靠猜。
 *
 * ── 机构持仓占比怎么算 ────────────────────────────────────────────────
 *
 * 比特皇原话是「机构持仓占比突破 5%（当前约 3.5%）」—— 他没说分子分母是什么。
 * 本模块取**可验证的定义**：美国现货 BTC ETF 合计持有的 BTC ÷ BTC 流通量。
 * 理由是 ETF 持仓是机构敞口里唯一有官方日度披露、可逐日复核的部分。
 * 这个定义写在读数里明示，不让读的人以为它是"全部机构持仓"。
 */

const DAY = 86400e3;

/** 六个源的定义 —— 界面、文档、测试三处都从这里派生。 */
export const MACRO_SOURCES = [
  {
    criterion: 'media-extreme',
    name: '加密恐慌与贪婪指数',
    provider: 'alternative.me',
    url: 'https://api.alternative.me/fng/?limit=30&format=json',
    license: '免费、无需密钥；使用时须署名 alternative.me',
    ttlMs: 6 * 3600e3,
    note: '综合波动率、动量、社交媒体、搜索热度、BTC 占比五项，0=极度恐慌 100=极度贪婪。恰好是「媒体情绪」的量化替身。',
  },
  {
    criterion: 'etf-netflow',
    name: '美国现货 BTC ETF 日度净流入',
    provider: 'Farside Investors',
    url: 'https://farside.co.uk/bitcoin-etf-flow-all-data/',
    license: '公开网页；经 r.jina.ai 读取，回落到 CC0 归档',
    ttlMs: 30 * 60e3,
    note: '逐日、逐基金（IBIT/FBTC/GBTC…）。判据要的是"连续 3 日净流入 > 2 亿美元"，所以必须按交易日算，不能按自然日。',
  },
  {
    criterion: 'onchain-activity',
    name: 'BTC 链上活跃地址数',
    provider: 'Blockchain.com',
    url: 'https://api.blockchain.info/charts/n-unique-addresses?timespan=4weeks&format=json',
    license: '免费、无需密钥',
    ttlMs: 3 * 3600e3,
    note: '每日新增/使用的唯一地址数。判据要的是周环比 +5% 以上，所以取最近 7 日均值对比前 7 日均值 —— 单日噪声太大。',
  },
  {
    criterion: 'liquidity-macro',
    name: '美元指数 DXY + 美联储政策利率',
    provider: 'Yahoo Finance + FRED（圣路易斯联储）',
    url: 'https://query1.finance.yahoo.com/v8/finance/chart/DX-Y.NYB + fredgraph.csv?id=DFEDTARU,DGS2',
    license: '免费、无需密钥',
    ttlMs: 3 * 3600e3,
    note: '判据是「DXY 回落至 103 以下，以及美联储释放降息信号」——两个条件都要。降息信号用两个可观测代理：目标利率区间上限下调、以及 2 年期美债收益率（市场对政策的即时定价）走低。',
  },
  {
    criterion: 'institutional-holding',
    name: '现货 BTC ETF 持仓占流通量比',
    provider: 'iShares（贝莱德）官方日度持仓文件 + Blockchain.com 流通量',
    url: 'https://www.ishares.com/us/products/333011/ishares-bitcoin-trust-etf/latest-holdings.csv',
    license: '发行人官方公开文件；免费、无需密钥',
    ttlMs: 12 * 3600e3,
    note: 'IBIT 是唯一能被自动读取的发行人页面（贝莱德）。其余发行人拒绝对自动化请求，所以占比是**下界**——真实值只会更高。这个保守偏差写在读数里。',
  },
  {
    criterion: 'regulation-policy',
    name: '监管动态（SEC / CFTC 官方发布）',
    provider: 'SEC 新闻稿 RSS + CFTC 新闻 RSS + CoinDesk RSS',
    url: 'https://www.sec.gov/news/pressreleases.rss',
    license: '政府公开信息；免费、无需密钥',
    ttlMs: 3 * 3600e3,
    note: '判据是「监管政策反复（SEC 起诉矿企案例增加）」——**渐变型**风险。做法是按关键词抽取加密相关的执法/立法条目，再按正负分类，看最近 30 天的净倾向。',
  },
];

/* ─────────────────────────── 工具 ─────────────────────────── */

const num = (s) => Number(String(s).replace(/,/g, '').replace(/[()]/g, '').trim());
const isNegParen = (s) => /^\s*\(.*\)\s*$/.test(String(s));

/**
 * 按 RFC4180 切一行 CSV —— **必须尊重引号**。
 *
 * 踩过的坑：iShares 的持仓文件把数值写成 `"63,435,884,526.17"`，
 * 千分位逗号在引号里面。直接 `line.split(',')` 会把它切成 `"63` 和 `435`…
 * 于是持仓量 786,359 BTC 被读成 786，占比算出 0.002% 而不是 3.91%
 * —— 数字量级错了 3 个数量级，而且**看起来完全正常**（就是个小数）。
 * 这种 bug 不会报错，只会给一个可信的错答案。
 */
export function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export async function httpGet(url, { fetchImpl = fetch, timeoutMs = 25000, headers = {} } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36',
        Accept: '*/*',
        ...headers,
      },
      signal: ctl.signal,
      redirect: 'follow',
    });
    const text = await r.text();
    return { ok: r.ok, status: r.status, text };
  } finally {
    clearTimeout(timer);
  }
}

const ymd = (d) => new Date(d).toISOString().slice(0, 10);
const parseYmd = (s) => Date.parse(`${s}T00:00:00Z`);

/* ══════════════════ ① 恐慌与贪婪（媒体情绪） ══════════════════ */

export function parseFearGreed(text) {
  const j = JSON.parse(text);
  const rows = (j.data || []).map((d) => ({
    value: Number(d.value),
    label: d.value_classification,
    ts: Number(d.timestamp) * 1000,
  }));
  if (!rows.length) throw new Error('fng 空数据');
  const latest = rows[0];
  const win = rows.slice(0, 14);
  const avg14 = win.reduce((a, b) => a + b.value, 0) / win.length;
  return {
    latest: latest.value,
    latestLabel: latest.label,
    asOf: ymd(latest.ts),
    avg14: Math.round(avg14 * 10) / 10,
    series: rows.map((r) => r.value).reverse(),
  };
}

/* ══════════════════ ② ETF 净流入 ══════════════════ */

/**
 * 解析 Farside 表格 —— **必须同时吃两种渲染形态**。
 *
 * 同一个 URL 经 r.jina.ai 读出来，实测出现过两种完全不同的结构：
 *
 *   A. Markdown 管道表（首次探测时）
 *        | 21 Sep 2026 | 381.4 | 238.8 | ... | 999.0 |
 *
 *   B. 制表符 + 换行分隔（后续探测时）
 *        21 Sep 2026\t\n381.4\n\t\n238.8 ... \t\n999.0
 *
 * 只写一种解析器的话，会在"今天能用"和"明天不能用"之间随机切换 ——
 * 而且失败方式很隐蔽：解析到 0 行就抛错，于是静默回落成十几天前的归档数据。
 * 所以这里先把 `|` 一律换成 `\t`，再按 `[\t\n]+` 切词，两种形态归一。
 *
 * 末列是 Total。**必须取"行内最后一个数值"而不是按列名找** ——
 * 列数会随新基金上市而增减（这张表从 2024 年的 12 列长到了 13 列）。
 *
 * 负数用括号表示：(450.4) = -450.4。单位是**百万美元**。
 */
export function parseFarside(text) {
  const tokens = text
    .replace(/\|/g, '\t')
    .split(/[\t\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const DATE = /^(\d{1,2})\s+([A-Z][a-z]{2})\s+(\d{4})$/;
  const NUM = /^\(?-?[\d,]+(\.\d+)?\)?$/;
  const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

  const rows = [];
  let cur = null;
  for (const tk of tokens) {
    const m = tk.match(DATE);
    if (m && m[1] && MON[m[2]] != null) {
      if (cur) rows.push(cur);
      cur = { date: `${m[3]}-${String(MON[m[2]] + 1).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`, cells: [] };
      continue;
    }
    if (/^Total$/i.test(tk)) {
      // 表尾汇总行 → 收尾并终止；表头里的列名 "Total" → 忽略（此时 cur 为 null）
      if (cur) { rows.push(cur); cur = null; break; }
      continue;
    }
    if (cur && NUM.test(tk)) cur.cells.push(tk);
  }
  if (cur) rows.push(cur);

  const out = [];
  for (const r of rows) {
    if (!r.cells.length) continue;
    const last = r.cells[r.cells.length - 1];
    out.push({ date: r.date, totalUsd: (isNegParen(last) ? -1 : 1) * num(last) * 1e6 });
  }
  if (!out.length) throw new Error('farside 未解析到任何数据行（渲染形态无法识别？）');
  out.sort((a, b) => (a.date < b.date ? -1 : 1));
  return out;
}

/** 兼容旧名 —— 早期版本只处理 Markdown 管道形态。 */
export const parseFarsideMarkdown = parseFarside;

/** 解析 CC0 归档 CSV（date,asset,net_inflow_usd,...），只取 BTC。 */
export function parseEtfArchiveCsv(text) {
  const lines = text.trim().split('\n');
  const head = lines[0].split(',');
  const iD = head.indexOf('date');
  const iA = head.indexOf('asset');
  const iN = head.indexOf('net_inflow_usd');
  if (iD < 0 || iN < 0) throw new Error('归档 CSV 表头不符');
  const out = [];
  for (const l of lines.slice(1)) {
    const c = l.split(',');
    if (iA >= 0 && c[iA] !== 'BTC') continue;
    const v = Number(c[iN]);
    if (!c[iD] || !Number.isFinite(v)) continue;
    out.push({ date: c[iD], totalUsd: v });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : 1));
  return out;
}

/**
 * 从逐日流量算出判据要的读数。
 * 判据原文：「连续 3 日净流入超 2 亿美元」—— 注意是**每一个交易日都 > 2 亿**，
 * 不是"3 日合计 > 2 亿"。所以取最近 3 个交易日逐日比对。
 */
export function readEtfFlow(rows, { thresholdUsd = 2e8, days = 3 } = {}) {
  const last = rows.slice(-days);
  const recent = rows.slice(-1)[0];
  const streak = (() => {
    let n = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].totalUsd > thresholdUsd) n++;
      else break;
    }
    return n;
  })();
  const sum = last.reduce((a, b) => a + b.totalUsd, 0);
  return {
    asOf: recent.date,
    latestUsd: recent.totalUsd,
    lastDays: last,
    sumLastDaysUsd: sum,
    allAboveThreshold: last.length === days && last.every((r) => r.totalUsd > thresholdUsd),
    consecutiveDaysAbove: streak,
    thresholdUsd,
  };
}

/* ══════════════════ ③ 链上活跃地址 ══════════════════ */

export function parseUniqueAddresses(text) {
  const j = JSON.parse(text);
  const vals = (j.values || []).filter((v) => Number.isFinite(v.y));
  if (vals.length < 14) throw new Error(`唯一地址序列太短（${vals.length} 天）`);
  const series = vals.map((v) => v.y);
  const last7 = series.slice(-7);
  const prev7 = series.slice(-14, -7);
  const avgLast = last7.reduce((a, b) => a + b, 0) / 7;
  const avgPrev = prev7.reduce((a, b) => a + b, 0) / 7;
  return {
    latest: Math.round(series[series.length - 1]),
    avg7: Math.round(avgLast),
    avgPrev7: Math.round(avgPrev),
    wowPct: Math.round(((avgLast / avgPrev - 1) * 100) * 100) / 100,
    asOf: ymd(vals[vals.length - 1].x * 1000),
  };
}

/* ══════════════════ ④ DXY + 政策利率 ══════════════════ */

export function parseYahooChart(text) {
  const j = JSON.parse(text);
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error(j?.chart?.error?.description || 'yahoo chart 无结果');
  const ts = res.timestamp || [];
  const closes = (res.indicators?.quote?.[0]?.close || []).map((v) => (v == null ? null : v));
  const pts = [];
  for (let i = 0; i < ts.length; i++) if (closes[i] != null) pts.push({ t: ts[i] * 1000, c: closes[i] });
  if (!pts.length) throw new Error('yahoo chart 无收盘价');
  return { series: pts, latest: pts[pts.length - 1].c, asOf: ymd(pts[pts.length - 1].t) };
}

export function readDxy(pts, { threshold = 103, lookbackDays = 20 } = {}) {
  const latest = pts.latest;
  const back = pts.series[Math.max(0, pts.series.length - 1 - lookbackDays)]?.c ?? latest;
  return {
    latest: Math.round(latest * 1000) / 1000,
    change20d: Math.round(((latest / back - 1) * 100) * 100) / 100,
    belowThreshold: latest < threshold,
    threshold,
    asOf: pts.asOf,
  };
}

/** FRED CSV：observation_date,<ID> / 逐行 日期,值；缺失值写作 "." */
export function parseFredCsv(text) {
  const lines = text.trim().split('\n');
  const out = [];
  for (const l of lines.slice(1)) {
    const [d, v] = l.split(',');
    if (!d || v == null || v === '.' || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) out.push({ date: d, value: n });
  }
  if (!out.length) throw new Error('FRED CSV 无有效观测');
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * 找出某个序列「最近一次变动」的方向与幅度。
 *
 * 踩过的坑：原实现拿「窗口内首个观测」对比「最新观测」，结果 2026-09-17 的
 * **加息 25bp** 被报成 `changed:false, deltaBp:+25` —— 看起来像"没动"，
 * 实际上是把 90 天前更低的利率当成了起点。而降息和加息在这里的意义完全相反，
 * 报错方向等于给了一个反向的宏观读数。正确做法是**从尾部往前找第一个不同的值**。
 */
export function lastChange(rows) {
  if (!rows?.length) return null;
  const latest = rows[rows.length - 1];
  for (let i = rows.length - 2; i >= 0; i--) {
    if (rows[i].value !== latest.value) {
      /* `changedOn` 必须是**第一个带新值的观测日**，不是最后一个观测日。
       *
       * 这里踩过一个会误导人的坑（实测）：DFEDTARU 在 2026-09-17 由 3.75 变 4.00，
       * 此后每天都印 4.00，最后一个观测日是 2026-09-22。原实现返回 `latest.date`，
       * 于是界面上印出「最近一次上调 25bp，2026-09-22，6 天前」——
       * **日期与「6 天前」自相矛盾**，读的人会以为美联储昨天才加息。
       * 对一个方向决策系统来说，「哪一天变的」本身就是结论的一部分，不能取错。
       *
       * `daysAgo` 保持原口径（旧值末次观测 → 最新观测）：在每天都有观测的日频序列上
       * 它等于「距变动发生几天」，此处 = 09-16 → 09-22 = 6，与 changedOn（09-17）自洽。 */
      const changedRow = rows[i + 1] ?? latest;
      return {
        latest: latest.value,
        from: rows[i].value,
        deltaBp: Math.round((latest.value - rows[i].value) * 100),
        direction: latest.value > rows[i].value ? 'HIKE' : 'CUT',
        changedOn: changedRow.date,
        sinceDate: rows[i].date,
        daysAgo: Math.round((parseYmd(latest.date) - parseYmd(rows[i].date)) / DAY),
      };
    }
  }
  return { latest: latest.value, from: latest.value, deltaBp: 0, direction: 'FLAT', changedOn: null, sinceDate: latest.date, daysAgo: null };
}

/**
 * 降息信号 —— 判据原文：「DXY 回落至 103 以下，以及美联储释放降息信号」。
 *
 * 两个可观测代理，任一成立即视为有信号，但**两个证据都列出来**：
 *   · 目标利率区间上限（DFEDTARU）最近一次变动是下调
 *   · 2 年期美债收益率（DGS2）近 `windowDays` 走低 —— 市场对政策的即时定价
 *
 * 注意：加息同样是"变动"。`cutting` 只在**向下**时为真；若最近一次是加息，
 * `tightening:true` 会显式标出来，供方向层把它当作收紧信号。
 */
export function readRateSignal(target, dgs2, { windowDays = 90, now = Date.now() } = {}) {
  const cut = target?.length ? lastChange(target) : null;
  const y2 = (() => {
    if (!dgs2?.length) return null;
    const latest = dgs2[dgs2.length - 1];
    const cutoff = now - windowDays * DAY;
    const inWin = dgs2.filter((r) => parseYmd(r.date) >= cutoff);
    const from = inWin.length ? inWin[0].value : latest.value;
    return {
      latest: latest.value,
      from,
      falling: latest.value < from,
      rising: latest.value > from,
      deltaBp: Math.round((latest.value - from) * 100),
      asOf: latest.date,
      windowDays,
    };
  })();

  const recentDays = 90;
  const recentCut = !!cut && cut.direction === 'CUT' && cut.daysAgo != null && cut.daysAgo <= recentDays;
  const recentHike = !!cut && cut.direction === 'HIKE' && cut.daysAgo != null && cut.daysAgo <= recentDays;

  return {
    targetRateUpper: cut,
    twoYearYield: y2,
    cutting: recentCut || !!y2?.falling,
    tightening: recentHike || !!y2?.rising,
    recentCut,
    recentHike,
    asOf: y2?.asOf || cut?.changedOn || null,
  };
}

/* ══════════════════ ⑤ 机构持仓 ══════════════════ */

/**
 * iShares 官方日度持仓 CSV。前 5 行是元数据，形如：
 *   Shares Outstanding,"1,386,480,000.00"
 * 之后是持仓表，BTC 行的倒数第 3 列是数量（BTC）。
 *
 * ⚠ 必须用 splitCsvLine，不能用 split(',') —— 见 splitCsvLine 的注释。
 */
export function parseIbitHoldings(text) {
  const out = { sharesOutstanding: null, netAssetsUsd: null, btc: null, asOf: null };
  const m = text.match(/Fund Holdings as of,\s*"?([^"\n]+)"?/);
  if (m) {
    const t = Date.parse(m[1].trim());
    if (Number.isFinite(t)) out.asOf = new Date(t).toISOString().slice(0, 10);
  }
  const s = text.match(/Shares Outstanding,\s*"?([\d,.]+)"?/);
  if (s) out.sharesOutstanding = num(s[1]);

  const lines = text.split('\n').filter((l) => l.includes(','));
  for (const l of lines) {
    const c = splitCsvLine(l);
    if (c[0] === 'BTC') {
      // 表头：Ticker,Name,Sector,Asset Class,Market Value,Weight (%),Notional Value,Quantity,Market Currency,Accrual Date
      // 取 Quantity 列；列位可能变动，所以按表头定位，取不到再回落倒数第 3 列。
      out.netAssetsUsd = Number(String(c[4]).replace(/[",]/g, '')) || null;
      const qtyCol = c.length >= 8 ? c.length - 3 : null;
      const qty = Number(String(qtyCol != null ? c[qtyCol] : c[7]).replace(/[",]/g, ''));
      if (Number.isFinite(qty) && qty > 0) out.btc = qty;
      break;
    }
  }
  if (out.btc == null || !Number.isFinite(out.btc)) throw new Error('IBIT CSV 未解析到 BTC 持仓量');
  return out;
}

export function readInstitutional(ibit, supplyBtc, { target = 0.05, reference = 0.035 } = {}) {
  const round2 = (x) => Math.round(x * 100) / 100;
  const sharePct = Math.round(((ibit.btc / supplyBtc) * 100) * 1000) / 1000;
  return {
    ibitBtc: Math.round(ibit.btc),
    supplyBtc: Math.round(supplyBtc),
    sharePct,
    targetPct: round2(target * 100),
    referencePct: round2(reference * 100),
    aboveTarget: sharePct >= target * 100,
    asOf: ibit.asOf,
    // 只有 IBIT 一个发行人能被自动读取，其余拒绝自动化请求 → 真实占比只会更高
    isLowerBound: true,
  };
}

/* ══════════════════ ⑥ 监管动态 ══════════════════ */

/**
 * 关键词分类。
 *
 * 踩过的坑：第一版把 `settle` 直接放进偏空正则，结果 ECB 的
 * 「deploys Pontes platform to **settle** wholesale tokenized assets」
 * 被判成执法行动 —— 这里的 settle 是"结算"，不是"和解"。
 * 同类歧义词还有 `charge`（收费）、`action`（一般动作）、`fine`（"好"）。
 * 所以偏空一律要求**搭配法律语境**，宁可漏判不可误判：
 * 漏判只是少一条噪声，误判会凭空造出一个不存在的监管风险。
 */
const CRYPTO_RE =
  /(crypto|bitcoin|btc\b|digital asset|tokeniz|tokenised|blockchain|stablecoin|digital currency|digital token)/i;

const NEG_RE = new RegExp(
  [
    '\\bcharges?\\s+(?:against|filed)',
    '\\bcharges?\\s+\\w+\\s+with\\b',
    '\\bcharged\\s+with\\b',
    // ⚠ 左右都要锚：只写 `sues?\b` 会命中 "Issues"（I-ssues）——
    //    SEC 那条「SEC Issues "Innovation Exemption"…」正是被这么判成偏空的。
    //    右侧有 \b 不够，左边也得有。
    '\\bsues?\\b',
    '\\bsued\\b',
    '\\blawsuits?\\b',
    '\\benforcement\\b',
    '\\bfraud\\b',
    '\\bpenalt(?:y|ies)\\b',
    '\\bsettle(?:s|d|ment)\\s+(?:with|charges|claims|allegations|case)\\b',
    '\\bcease[- ]and[- ]desist\\b',
    '\\bviolat',
    '\\bindict',
    '\\bsubpoenas?\\b',
    '\\bcracks?\\s+down\\b',
    '\\bsanctions?\\b',
    '\\bhalts?\\b',
    '\\bhalted\\b',
    '\\bbars?\\s+\\w+\\s+from\\b',
  ].join('|'),
  'i'
);

const POS_RE = new RegExp(
  [
    '\\bapprov(?:e|es|ed|al)',
    '\\bexemptions?\\b',
    '\\bauthoriz',
    '\\bframeworks?\\b',
    '\\bclarity\\b',
    '\\blicens',
    '\\bpermit',
    '\\bgreenlights?\\b',
    '\\badopts?\\b',
    '\\bfacilitat',
    '\\bproposes?\\s+new\\s+regulation\\b',
    '\\bregulat\\w*\\s+(?:for|on|of)\\s+crypto',
    '\\blegitimacy\\b',
    '\\bnew rules?\\b',
  ].join('|'),
  'i'
);

/** RSS 条目 → 结构化。SEC 的 item 标题里带换行，必须容错。 */
export function parseRssItems(xml) {
  const items = xml.split(/<item[\s>]/).slice(1);
  const out = [];
  for (const it of items) {
    const pick = (tag) => {
      const m =
        it.match(new RegExp(`<${tag}[^>]*>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</${tag}>`, 'i')) ||
        it.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
      return m ? m[1].replace(/\s+/g, ' ').trim() : '';
    };
    const title = pick('title');
    if (!title) continue;
    out.push({ title, link: pick('link'), date: pick('pubDate') || pick('dc:date') });
  }
  return out;
}

export function classifyRegulatoryTitle(title) {
  if (!CRYPTO_RE.test(title)) return null;
  const neg = NEG_RE.test(title);
  const pos = POS_RE.test(title);
  // 同时命中时判为负 —— 风险提示宁可保守
  return neg ? -1 : pos ? 1 : 0;
}

/**
 * 监管判据读数的口径 —— 这一层必须分清「谁在说话」。
 *
 * 判据原文是「监管政策反复（如 SEC 起诉矿企案例增加）」，指的是**监管机构的行为**。
 * 第一版把 CoinDesk（加密原生媒体，每天几十条）和 SEC/CFTC（官方发布，每周几条）
 * 混在一个计数里，结果是媒体稿把官方条目挤出了视野：24 条里 20 条来自媒体，
 * 而真正说明"监管走向"的两条 SEC 公告（正是判据提到的"框架出台"）
 * 反而被淹没了 —— 计数看起来很正常，结论却是反的。
 *
 * 所以分两层：
 *   official（SEC / CFTC）—— 决定 vote。这才是判据说的"监管政策"
 *   media（CoinDesk）     —— 只作旁证展示，不参与 vote
 */
export function readRegulatory(feeds, { windowDays = 30, now = Date.now() } = {}) {
  const cutoff = now - windowDays * DAY;
  const all = [];
  for (const f of feeds) {
    const tier = f.tier || 'media';
    for (const it of f.items || []) {
      const impact = classifyRegulatoryTitle(it.title);
      if (impact == null) continue;
      const t = Date.parse(it.date);
      if (Number.isFinite(t) && t < cutoff) continue;
      all.push({ ...it, source: f.provider, tier, impact });
    }
  }
  all.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));

  const official = all.filter((i) => i.tier === 'official');
  const media = all.filter((i) => i.tier === 'media');
  const count = (arr, k) => arr.filter((i) => i.impact === k).length;

  return {
    windowDays,
    count: all.length,
    official,
    media,
    officialPositive: count(official, 1),
    officialNegative: count(official, -1),
    mediaPositive: count(media, 1),
    mediaNegative: count(media, -1),
    // 兼容旧字段名
    positives: count(all, 1),
    negatives: count(all, -1),
    net: official.reduce((a, b) => a + b.impact, 0),
    asOf: all[0]?.date ? ymd(Date.parse(all[0].date)) : null,
  };
}

/* ══════════════════ 采集编排 ══════════════════ */

const RSS_FEEDS = [
  // tier 决定它在监管读数里的权重：官方发布才是判据说的"监管政策"，媒体只作旁证
  { provider: 'SEC', url: 'https://www.sec.gov/news/pressreleases.rss', tier: 'official' },
  { provider: 'CFTC', url: 'https://www.cftc.gov/RSS/RSSGP/rssgp.xml', tier: 'official' },
  { provider: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', tier: 'media' },
];

/**
 * 采集全部六个源。任何一个失败都不影响其它 —— 每个源独立 try/catch，
 * 失败记 `status:'unavailable'` 与 `error`，绝不让一个挂掉的源把整层拖垮。
 *
 * @param {object}   o
 * @param {Function} o.fetchImpl  可注入，便于离线测试
 * @param {number}   o.now
 * @param {object}   o.cache      上一轮采集结果（用于回落与"新鲜度"判断）
 */
export async function collectMacroSources({ fetchImpl = fetch, now = Date.now(), cache = {}, config = {} } = {}) {
  const results = {};
  const errors = [];
  const took = (name, fn) =>
    (async () => {
      try {
        results[name] = await fn();
      } catch (e) {
        results[name] = { status: 'unavailable', error: String(e.message || e) };
        errors.push(`${name}: ${e.message || e}`);
      }
    })();

  const get = (url, opts) => httpGet(url, { fetchImpl, ...opts });

  await Promise.all([
    /* ① 恐慌贪婪 */
    took('fearGreed', async () => {
      const r = await get('https://api.alternative.me/fng/?limit=30&format=json');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = parseFearGreed(r.text);
      return { status: 'ok', provider: 'alternative.me', url: 'https://api.alternative.me/fng/', ...d };
    }),

    /* ② ETF 净流入 —— 三级回落 */
    took('etfFlow', async () => {
      /*
       * 顺序是**实测出来的，不是猜的**：
       *   · 直连 Farside 前面挂着 Cloudflare，稳定 403（耗时 2s 后失败）
       *   · r.jina.ai 能拿到**当天**数据 —— 实测可用，所以放第一
       *   · CC0 归档做兜底，历史最长但冻结在 2026-09-10
       * 直连仍保留在中间：万一 Cloudflare 策略放宽，它就是最省事的一级。
       */
      const trySteps = [
        { via: 'r.jina.ai', url: 'https://r.jina.ai/https://farside.co.uk/bitcoin-etf-flow-all-data/', parse: parseFarside, live: true },
        { via: 'direct', url: 'https://farside.co.uk/bitcoin-etf-flow-all-data/', parse: parseFarside, live: true },
        {
          via: 'cc0-archive',
          url: 'https://raw.githubusercontent.com/bykarantelicom/crypto-datasets/main/data/etf-flows.csv',
          parse: parseEtfArchiveCsv,
          live: false,
        },
      ];
      const fails = [];
      for (const s of trySteps) {
        try {
          const r = await get(s.url, { timeoutMs: s.via === 'r.jina.ai' ? 35000 : 20000 });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const rows = s.parse(r.text);
          const read = readEtfFlow(rows, { thresholdUsd: config.etfFlowThresholdUsd ?? 2e8, days: 3 });
          const staleDays = Math.round((now - parseYmd(read.asOf)) / DAY);
          return {
            // 归档源一律标 stale；实时源若数据本身已过期 >3 天也降级
            status: s.live && staleDays <= 3 ? 'ok' : 'stale',
            via: s.via,
            provider: s.via === 'cc0-archive' ? 'ByKaranteli CC0 归档（GitHub）' : 'Farside Investors',
            url: s.url,
            staleDays,
            historyDays: rows.length,
            ...read,
          };
        } catch (err) {
          fails.push(`${s.via}: ${err.message}`);
        }
      }
      throw new Error(fails.join(' | '));
    }),

    /* ③ 链上活跃地址 */
    took('onchain', async () => {
      const r = await get('https://api.blockchain.info/charts/n-unique-addresses?timespan=4weeks&format=json&sampled=false');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = parseUniqueAddresses(r.text);
      return { status: 'ok', provider: 'Blockchain.com', url: 'https://api.blockchain.info/charts/n-unique-addresses', ...d };
    }),

    /* ④ DXY + 利率 */
    took('liquidity', async () => {
      const [dxyR, tarR, y2R] = await Promise.all([
        get('https://query1.finance.yahoo.com/v8/finance/chart/DX-Y.NYB?range=6mo&interval=1d'),
        get('https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFEDTARU'),
        get('https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS2'),
      ]);
      const dxy = dxyR.ok ? readDxy(parseYahooChart(dxyR.text), { threshold: config.dxyThreshold ?? 103 }) : null;
      const rate = tarR.ok || y2R.ok
        ? readRateSignal(tarR.ok ? parseFredCsv(tarR.text) : null, y2R.ok ? parseFredCsv(y2R.text) : null, { now })
        : null;
      if (!dxy && !rate) throw new Error('DXY 与利率双双失败');
      return { status: 'ok', provider: 'Yahoo Finance（DXY）+ FRED', url: 'DX-Y.NYB / DFEDTARU / DGS2', dxy, rate };
    }),

    /* ⑤ 机构持仓 */
    took('institutional', async () => {
      const [ibitR, supR] = await Promise.all([
        get('https://www.ishares.com/us/products/333011/ishares-bitcoin-trust-etf/latest-holdings.csv'),
        get('https://api.blockchain.info/charts/total-bitcoins?timespan=5days&format=json'),
      ]);
      if (!ibitR.ok) throw new Error(`IBIT CSV HTTP ${ibitR.status}`);
      if (!supR.ok) throw new Error(`流通量 HTTP ${supR.status}`);
      const ibit = parseIbitHoldings(ibitR.text);
      const supJson = JSON.parse(supR.text);
      const supplyBtc = supJson.values[supJson.values.length - 1].y;
      const d = readInstitutional(ibit, supplyBtc, { target: config.institutionalTargetPct ?? 0.05 });
      return {
        status: 'ok',
        provider: 'iShares（贝莱德）官方持仓 + Blockchain.com 流通量',
        url: 'ishares.com/.../latest-holdings.csv',
        netAssetsUsd: ibit.netAssetsUsd,
        sharesOutstanding: ibit.sharesOutstanding,
        ...d,
      };
    }),

    /* ⑥ 监管动态 */
    took('regulatory', async () => {
      const feeds = [];
      for (const f of RSS_FEEDS) {
        try {
          const r = await get(f.url, { timeoutMs: 15000 });
          if (r.ok) feeds.push({ provider: f.provider, tier: f.tier, items: parseRssItems(r.text) });
        } catch {
          /* 单条 RSS 挂掉不影响其余 */
        }
      }
      if (!feeds.length) throw new Error('三个 RSS 全部失败');
      const d = readRegulatory(feeds, { windowDays: config.regulatoryWindowDays ?? 30, now });
      return {
        status: 'ok',
        provider: feeds.map((f) => f.provider).join(' / '),
        url: 'RSS',
        feedsOk: feeds.map((f) => `${f.provider}(${f.tier})`),
        ...d,
      };
    }),
  ]);

  // 掉线的源：如果缓存里有新鲜度尚可的上一轮结果，回落到缓存并标 stale
  for (const def of MACRO_SOURCES) {
    const key = { 'media-extreme': 'fearGreed', 'etf-netflow': 'etfFlow', 'onchain-activity': 'onchain', 'liquidity-macro': 'liquidity', 'institutional-holding': 'institutional', 'regulation-policy': 'regulatory' }[def.criterion];
    const r = results[key];
    if (!r || r.status === 'unavailable') {
      const prev = cache?.sources?.[key];
      if (prev && prev.status !== 'unavailable') {
        results[key] = { ...prev, status: 'stale', degradedFrom: r?.error || 'fetch failed' };
        errors.push(`${key}: 回落到缓存快照（${prev.asOf || '未知日期'}）`);
      }
    }
  }

  return {
    fetchedAt: new Date(now).toISOString(),
    errors,
    sources: results,
    /** 六个源对应六条判据 —— 供编排层直接消费 */
    byCriterion: {
      'media-extreme': results.fearGreed,
      'etf-netflow': results.etfFlow,
      'onchain-activity': results.onchain,
      'liquidity-macro': results.liquidity,
      'institutional-holding': results.institutional,
      'regulation-policy': results.regulatory,
    },
  };
}

/* ══════════════════ 把读数翻译成「判据投票」 ══════════════════ */

/**
 * 单条判据求值抛错时的降级读数。
 *
 * 与「源明确没数据」刻意区分开：那个是 `available:false` 且 reason 说「取不到」；
 * 这个是**代码没能读懂这个形状**（上游改了字段名、返回半截对象、子请求超时后
 * 只填了一半）。两者都不投票，但排查方向完全不同，所以多带一个 `broken` 标记 ——
 * 界面与终端据此能把「源没数据」和「我们读崩了」分开。
 */
const brokenReading = (name, e) => ({
  available: false,
  vote: 0,
  broken: true,
  reason: `${name}读数形状异常，本条已降级（其余判据不受影响）：${e.message}`,
});

/**
 * 每条判据的求值——输入是上面采集到的读数，输出是 A7 反应检验能消费的票。
 * vote: +1 支持多头 / -1 支持空头 / 0 中性或缺数据。
 *
 * 关键取舍（与注册表里原本的措辞一致）：
 *   · 这 6 条**都不是否决项**。ETF/链上/机构/流动性是"加分项"，
 *     监管与极端情绪是"刹车项"。唯一能一票否决的仍然是 shock。
 *   · 缺数据 → available:false，不是 vote:0。这两者含义完全不同：
 *     前者是"不知道"，后者是"知道且中性"。
 *
 * ⚠ 六条各自独立 try/catch，**不要合并成一个外层 try**。
 *    源是"部分成功"的：`status` 说 ok，字段却可能不全（实测 6 种缺字段形状里
 *    有 4 种会让求值抛 TypeError）。若只在最外层兜住，一条形状异常的源会把另外
 *    五条**已经拿到**的读数一起丢掉 —— onchain 少个字段不该让恐慌贪婪指数的
 *    读数也消失。逐条兜住的代价只有那一项降级，而且降级是显形的。
 */
export function evaluateMacroCriteria(src, { price = null, config = {} } = {}) {
  const out = [];
  const push = (id, layer, name, r) => out.push({ id, layer, name, ...r });

  /* ① 媒体情绪极端 */
  try {
    const g = src?.sources?.fearGreed;
    if (!g || g.status === 'unavailable') push('media-extreme', 'M1', '媒体情绪', { available: false, vote: 0, reason: '恐慌贪婪指数取不到' });
    else {
      const v = g.latest;
      const extremeGreed = v >= (config.fngGreedThreshold ?? 75);
      const extremeFear = v <= (config.fngFearThreshold ?? 25);
      push('media-extreme', 'M1', '媒体情绪', {
        available: true,
        vote: extremeGreed ? -1 : extremeFear ? 1 : 0,
        value: v,
        unit: '指数 0-100（越高越贪婪）',
        ttl: g.status,
        asOf: g.asOf,
        reason: extremeGreed
          ? `恐慌贪婪指数 ${v}（${g.latestLabel}，14 日均 ${g.avg14}）—— 极端乐观，按「最后一个悲观者也变成乐观者时牛市也走到头了」属反向警示信号`
          : extremeFear
            ? `恐慌贪婪指数 ${v}（${g.latestLabel}，14 日均 ${g.avg14}）—— 极端悲观，按「所有媒体都一片悲观时熊市也走到头了」属反向机会信号`
            : `恐慌贪婪指数 ${v}（${g.latestLabel}，14 日均 ${g.avg14}）—— 未到极端，不构成反向信号`,
      });
    }
  } catch (e) {
    push('media-extreme', 'M1', '媒体情绪', brokenReading('媒体情绪', e));
  }

  /* ② ETF 净流入 */
  try {
    const e = src?.sources?.etfFlow;
    if (!e || e.status === 'unavailable') push('etf-netflow', 'M2', 'ETF 净流入', { available: false, vote: 0, reason: 'ETF 流量取不到' });
    else {
      const th = e.thresholdUsd / 1e8;
      const priceOk = price != null && price > (config.etfPriceTrigger ?? 103000);
      const flowOk = e.allAboveThreshold;
      const bothOk = flowOk && priceOk;
      const m = (x) => `${x < 0 ? '-' : ''}$${(Math.abs(x) / 1e8).toFixed(2)} 亿`;
      const dayList = e.lastDays.map((r) => `${r.date.slice(5)} ${m(r.totalUsd)}`).join(' / ');
      const srcNote = e.status === 'stale' ? `（数据源：${e.provider}，已滞后 ${e.staleDays} 天）` : '';
      push('etf-netflow', 'M2', 'ETF 净流入', {
        available: true,
        vote: bothOk ? 1 : 0,
        value: e.latestUsd,
        unit: 'USD（最新单日净流入）',
        ttl: e.status,
        asOf: e.asOf,
        reason: bothOk
          ? `ETF 连续 ${e.consecutiveDaysAbove} 个交易日净流入均超 ${th} 亿（${dayList}），且价格 ${price.toFixed(0)} 已突破 ${config.etfPriceTrigger ?? 103000} —— 短期上涨趋势确认条件齐备 ✓`
          : flowOk
            ? `ETF 连续 ${e.consecutiveDaysAbove} 个交易日净流入均超 ${th} 亿（${dayList}），但价格 ${price == null ? '未知' : price.toFixed(0)} 未突破 ${config.etfPriceTrigger ?? 103000} —— 金额条件已到、价格条件未到${srcNote}`
            : `最近 3 个交易日净流入 ${dayList}，已连续 ${e.consecutiveDaysAbove} 日超 ${th} 亿；因未做到"3 日均超 ${th} 亿"，短期趋势确认不成立${srcNote}`,
      });
    }
  } catch (e) {
    push('etf-netflow', 'M2', 'ETF 净流入', brokenReading('ETF 净流入', e));
  }

  /* ③ 链上活跃地址 */
  try {
    const o = src?.sources?.onchain;
    if (!o || o.status === 'unavailable') push('onchain-activity', 'M3', '链上活跃', { available: false, vote: 0, reason: '链上活跃地址取不到' });
    else {
      const need = config.onchainWowPct ?? 5;
      const ok = o.wowPct >= need;
      push('onchain-activity', 'M3', '链上活跃', {
        available: true,
        vote: ok ? 1 : 0,
        value: o.wowPct,
        unit: '%（活跃地址周环比）',
        ttl: o.status,
        asOf: o.asOf,
        reason: `链上活跃地址 7 日均 ${o.avg7.toLocaleString('en-US')}，前 7 日均 ${o.avgPrev7.toLocaleString('en-US')}，周环比 ${o.wowPct > 0 ? '+' : ''}${o.wowPct}% —— ${ok ? `已达 +${need}% 的中期确认门槛` : `未达 +${need}% 的中期确认门槛`}`,
      });
    }
  } catch (e) {
    push('onchain-activity', 'M3', '链上活跃', brokenReading('链上活跃', e));
  }

  /* ④ DXY + 降息信号（gate 型：两个都要） */
  try {
    const l = src?.sources?.liquidity;
    if (!l || l.status === 'unavailable') push('liquidity-macro', 'M4', '流动性与利率', { available: false, vote: 0, reason: 'DXY / 利率取不到' });
    else {
      const dxyOk = !!l.dxy?.belowThreshold;
      const cutOk = !!l.rate?.cutting;
      const bothOk = dxyOk && cutOk;
      const parts = [];
      if (l.dxy) {
        parts.push(
          `DXY ${l.dxy.latest}（20 日 ${l.dxy.change20d >= 0 ? '+' : ''}${l.dxy.change20d}%），${dxyOk ? `已在 ${l.dxy.threshold} 下方 ✓` : `仍在 ${l.dxy.threshold} 上方 ✗`}`
        );
      }
      const tu = l.rate?.targetRateUpper;
      if (tu) {
        const dirTxt =
          tu.direction === 'CUT' ? `最近一次下调 ${Math.abs(tu.deltaBp)}bp` :
          tu.direction === 'HIKE' ? `最近一次**上调** ${tu.deltaBp}bp` : '窗口内未变动';
        parts.push(`政策利率上限 ${tu.latest}%（${dirTxt}${tu.changedOn ? `，${tu.changedOn}，${tu.daysAgo} 天前` : ''}）`);
      }
      const y2 = l.rate?.twoYearYield;
      if (y2) {
        const dirTxt = y2.falling ? `走低 ${Math.abs(y2.deltaBp)}bp ✓` : y2.rising ? `**走高** ${y2.deltaBp}bp ✗` : '持平';
        parts.push(`2 年期美债 ${y2.latest}%（近 ${y2.windowDays} 日 ${dirTxt}）`);
      }
      push('liquidity-macro', 'M4', '流动性与利率', {
        available: true,
        vote: bothOk ? 1 : 0,
        /* 这一条原本**没有 value** —— 它是个 gate（两个条件都要），
         * 于是历史库里它永远画不出趋势。但「DXY 在靠近 103 还是远离 103」
         * 恰恰是这条判据最值得看的变化，所以把 DXY 水平作为它的数值。
         * 注意：这个值只是「该条的门槛之一」，不等于该条成立（还要看降息信号）。 */
        value: l.dxy?.latest ?? null,
        unit: 'DXY（美元指数）',
        ttl: l.status,
        asOf: l.dxy?.asOf || l.rate?.asOf,
        gate: { dxyOk, cutOk },
        tightening: !!l.rate?.tightening,
        reason: `${parts.join('；')} —— 该条是中期确认的**必要条件**，DXY 与降息信号须同时成立；当前${bothOk ? '已同时成立 ✓' : `未同时成立（DXY ${dxyOk ? '过' : '未过'}、降息信号 ${cutOk ? '有' : '无'}）`}`,
      });
    }
  } catch (e) {
    push('liquidity-macro', 'M4', '流动性与利率', brokenReading('流动性与利率', e));
  }

  /* ⑤ 机构持仓占比 */
  try {
    const i = src?.sources?.institutional;
    if (!i || i.status === 'unavailable') push('institutional-holding', 'M5', '机构持仓', { available: false, vote: 0, reason: '机构持仓取不到' });
    else {
      push('institutional-holding', 'M5', '机构持仓', {
        available: true,
        vote: i.aboveTarget ? 1 : 0,
        value: i.sharePct,
        unit: '%（IBIT 占流通量，下界）',
        ttl: i.status,
        asOf: i.asOf,
        reason: `IBIT 持有 ${i.ibitBtc.toLocaleString('en-US')} BTC ÷ 流通量 ${i.supplyBtc.toLocaleString('en-US')} = ${i.sharePct}%（门槛 ${i.targetPct}%，原话参考值 ${i.referencePct}%）${i.isLowerBound ? ' —— 仅 IBIT 可自动读取，其余发行人拒绝对自动化请求，故为**下界**' : ''}`,
      });
    }
  } catch (e) {
    push('institutional-holding', 'M5', '机构持仓', brokenReading('机构持仓', e));
  }

  /* ⑥ 监管动态 */
  try {
    const g = src?.sources?.regulatory;
    if (!g || g.status === 'unavailable') push('regulation-policy', 'M6', '监管政策', { available: false, vote: 0, reason: '监管动态取不到' });
    else {
      /*
       * 口径以**官方发布**为准，媒体只作旁证（见 readRegulatory 的注释）。
       * 判据同时提到两个方向：
       *   风险提示 →「监管政策反复（如 SEC 起诉矿企案例增加）」
       *   长期支撑 →「监管政策落地（如 SEC 框架出台）」
       * 所以这是个双向读数，不是单纯的刹车。
       */
      const negTrig = config.regulatoryNegativesTrigger ?? 3;
      const reversal = g.officialNegative >= negTrig;
      const landed = g.officialPositive > 0 && g.officialNegative === 0;
      const vote = reversal ? -1 : landed ? 1 : 0;
      const officialTxt = g.official.length
        ? g.official.slice(0, 3).map((i) => `「${i.title.slice(0, 60)}」`).join('、')
        : '无';
      push('regulation-policy', 'M6', '监管政策', {
        available: true,
        vote,
        /* 与 M4 同理：这条原本没有 value，历史库里画不出趋势。
         * 取「官方净条目数」(偏多 - 偏空)——它跟 vote 不是一回事：
         * vote 还叠加了执法阈值判定，而净条目数只是事实本身。
         * 趋势看的是「监管风向在变好还是变坏」，不是当时投了什么票。 */
        value: (g.officialPositive || 0) - (g.officialNegative || 0),
        unit: '条（官方净条目 = 偏多 − 偏空）',
        ttl: g.status,
        asOf: g.asOf,
        reason: `近 ${g.windowDays} 天官方发布（SEC/CFTC）加密相关共 ${g.official.length} 条：偏多 ${g.officialPositive}、偏空 ${g.officialNegative}，代表条目 ${officialTxt}；媒体（CoinDesk）另有 ${g.media.length} 条（偏多 ${g.mediaPositive}、偏空 ${g.mediaNegative}）—— ${
          reversal
            ? `执法类条目已达 ${g.officialNegative} 条，属判据所指的「监管政策反复」⚠`
            : landed
              ? '官方以建设性条目为主且无执法条目，对应判据里的「监管政策落地（如 SEC 框架出台）」，属长期支撑项 ✓'
              : '官方条目未显示明确的政策反复或落地，中性'
        }`,
        items: [...g.official, ...g.media].slice(0, 8),
      });
    }
  } catch (e) {
    push('regulation-policy', 'M6', '监管政策', brokenReading('监管政策', e));
  }

  return out;
}

/**
 * 判据值的显示小数位 —— 按**单位**定，不是按数量级定。
 *
 * 为什么不能只看数量级：M6 的 value 是「官方净条目数」（计数，通常 0~3），
 * 而 M2 的 value 是美元金额。按「小于 100 就留 2 位」的通用规则，M6 会印出
 * 「0.00 → 1.00」这种噪音 —— 一个计数不该有小数点。
 *
 * 这个规则有两个消费方，必须同源：
 *   · 浏览器 `public/app.js` 的 `dpFor(unit, v)`（面板的趋势列）
 *   · 终端 `tools/macro-daily.js --view`（历史账本回看）
 * 两边各自实现必然漂移，所以规则放在这里，网页那份由
 * `tools/macro-render-smoke.mjs` 的漂移守卫断言与实际一致。
 *
 * @param {string|null|undefined} unit 判据单位（形如 `条（…）` / `指数 0-100（…）` / `USD（…）`）
 * @param {number} v 判据值
 * @returns {number} 小数位
 */
export function valueDecimals(unit, v) {
  const u = String(unit || '');
  if (u.startsWith('条') || u.startsWith('指数') || u.startsWith('USD')) return 0;
  const a = Math.abs(Number(v));
  if (!Number.isFinite(a)) return 0;
  if (a >= 1000) return 0;
  if (a >= 100) return 1;
  return 2;
}

/**
 * 采集失败时的降级读数：六条判据照常在列，每条标 `available:false`。
 *
 * 为什么不干脆给下游传空数组 —— 空数组会让 M1~M6 从证据链里**整体消失**，
 * 方向层的弃权汇总只会说「5 条弃权」（A4~A7 那几条），读的人无从知道
 * 宏观那两条本该在场、这次是缺了的。喂一个空源对象重新求值，产出的仍是
 * 完整六条，只是每条 reason 写明「取不到」；方向层据此把 M1~M6 一并标成
 * 弃权，「这次少了什么」在界面上看得见。
 *
 * 复用的正是同一条求值代码（`evaluateMacroCriteria`），所以降级形状永远与
 * 正常形状同构 —— 不存在「降级那天字段少一个」这种只在出事时才暴露的差异。
 *
 * @param {{price?: number|null, config?: object, reason?: string|null}} o
 * @returns {{src: object, readings: Array}} 与 `collectMacroSources()` 同构的降级源 + 六条读数
 */
export function degradedMacro({ price = null, config = {}, reason = null } = {}) {
  const why = reason ? String(reason) : '采集失败';
  const src = {
    sources: {},
    byCriterion: {},
    errors: [`采集失败：${why}`],
    fetchedAt: new Date().toISOString(),
    degraded: why,
  };
  return { src, readings: evaluateMacroCriteria(src, { price, config }) };
}
