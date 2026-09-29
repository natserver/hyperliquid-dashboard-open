/**
 * 历史账本的「终端回看」渲染 —— 纯函数，只把数据变成文本。
 *
 * ── 为什么单独一个模块，而不是塞在 tools/macro-daily.js 里 ──────────────
 *
 * `tools/macro-daily.js` 是**顶层就会执行**的 CLI：一 import 它，采集、落库、
 * process.exit 全都会跑一遍。把渲染逻辑留在那里 = 这段逻辑无法被测试覆盖，
 * 而它恰恰有不少容易错的分支（只有 1 天记录、某个判据整窗取不到、
 * `errors` 列是 JSON 串、CJK 列宽、美元金额压缩）。
 *
 * 所以：数据装配（historyViewData）与文本渲染（renderHistoryView）都放这里，
 * CLI 只负责「解析参数 → 调它 → 打印」。渲染函数**只返回字符串，不打印** ——
 * 这样测试可以直接断言字符串，不必去捞 stdout。
 *
 * ── 两个刻意的显示取舍（都踩过）──────────────────────────────────────
 *
 * 1. **小数位按单位定，不按数量级定。** M6 是「官方净条目数」（计数），
 *    按数量级猜会印出 `1.00` 这种噪音。规则写在 `macro-sources.js` 的
 *    `valueDecimals()`，与网页共用 —— 两边各写一份必然漂移。
 *
 * 2. **不到 2 个点不画走势条。** 单点只能画出一条平线，看着像「非常稳定」，
 *    实际是「什么都不知道」。宁可直接写「仅 1 天记录」。
 *    另外走势条固定放在**行尾**：块状字符（▁▂▃）的宽度在不同终端/字体下不一致，
 *    放中间会把整列带歪；放末尾即使偏了也不影响其它列。
 */

import { valueDecimals } from './macro-sources.js';

/** 终端显示宽度：CJK 占 2 格。
 *  `String.prototype.padEnd` 按**字符数**算，中文列必然错位 ——
 *  实测后果不是「稍微不齐」，而是整张表列全歪，扫读直接失效。 */
export const displayWidth = (s) =>
  [...String(s)].reduce(
    (n, c) => n + (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(c) ? 2 : 1),
    0
  );

/** 按显示宽度右侧补空格 */
export const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - displayWidth(s)));

/** 终端里的紧凑数值。
 *  与网页目标不同：网页要「精确读数 + 完整单位文案」，终端要「一眼扫过去」，
 *  所以这里多做一层量级压缩（美元折成 亿/万）。小数位仍走共享的 valueDecimals。 */
export function cell(value, unit) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const v = Number(value);
  const u = String(unit || '');
  if (u.startsWith('USD')) {
    const a = Math.abs(v);
    const sign = v < 0 ? '-' : v > 0 ? '+' : '';
    if (a >= 1e8) return `${sign}${(a / 1e8).toFixed(2)} 亿`;
    if (a >= 1e4) return `${sign}${(a / 1e4).toFixed(2)} 万`;
    return `${sign}${a.toFixed(0)}`;
  }
  const s = v.toFixed(valueDecimals(unit, v));
  return u.startsWith('%') ? `${s}%` : s;
}

const GLYPH = '▁▂▃▄▅▆▇█';

/** 与 cell 同源但不加正号 —— 用在「首 → 末」这种带正号会读错的位置。
 *  （`-3.20 亿 → +3.20 亿` 里的 `+` 会被误读成"从正数涨上来的"。） */
const compact = (v, unit) => {
  const c = cell(v, unit);
  return c.startsWith('+') ? c.slice(1) : c;
};

/** 变化量：带正负号，且单位口径与「最新」列一致。
 *  不一致的话会出现「最新 9.99 亿 / 变化 999000000」这种同一行两种量纲的读法。 */
function deltaText(d, unit) {
  if (!Number.isFinite(d)) return '—';
  const body = cell(Math.abs(d), unit).replace(/^[+-]/, '');
  return (d > 0 ? '+' : d < 0 ? '-' : '') + body;
}

/**
 * 终端单色走势条。不足 2 点返回 `null`（调用方负责明说「仅 1 天记录」）。
 *
 * 单色是刻意的：恐慌贪婪指数上涨是**坏消息**，与价格红涨绿跌的语义正好相反，
 * 套用价格配色会让读者把方向读反。
 *
 * @param {number[]} values 按时间升序
 * @param {number} width    最多几个字符（超出则等距抽样，首尾一定保留）
 * @returns {string|null}
 */
export function sparkTerm(values, width = 12) {
  if (!Array.isArray(values) || values.length < 2) return null;
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length < 2) return null;

  let v = finite;
  if (v.length > width) {
    const step = (v.length - 1) / (width - 1);
    v = Array.from({ length: width }, (_, i) => finite[Math.round(i * step)]);
  }
  const lo = Math.min(...v);
  const hi = Math.max(...v);
  if (hi === lo) return GLYPH[0].repeat(v.length); // 真·水平：如实画平线，不是「没数据」
  return v.map((x) => GLYPH[Math.min(7, Math.max(0, Math.round(((x - lo) / (hi - lo)) * 7)))]).join('');
}

/** `macro_runs.errors` 存的是 JSON 串（如 `["institutional: fetch failed"]`）。
 *  解析不了就原样截断 —— 不要因为一行脏数据把整张表带崩。 */
export function failedNames(raw) {
  if (raw === null || raw === undefined || raw === '') return '—';
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch {
    return String(raw).slice(0, 24);
  }
  if (!Array.isArray(arr) || !arr.length) return '—';
  return arr.map((e) => String(e).split(':')[0].trim()).filter(Boolean).join(',') || '—';
}

/** 短单位：取 `（` 之前那一段，够读又不占列宽 */
export const unitShort = (unit) => String(unit || '').split('（')[0].trim() || '—';

/**
 * 把库里的数据装配成可渲染的结构。**只读，不写库，不联网。**
 *
 * @param {object} p
 * @param {object} p.store                 openMacroStore() 的返回值
 * @param {string[]} p.order               判据顺序（CRITERIA_ORDER）
 * @param {number} [p.days=30]             回看窗口（天）
 * @param {number} [p.now=Date.now()]      当前时刻，便于测试固定窗口
 * @param {(ms:number)=>string} p.dayOf    采集日转换
 * @param {object} [p.summary]             storeSummary() 的结果（不传则内部由 store 读）
 */
export function historyViewData({ store, order, days = 30, now = Date.now(), dayOf, summary = null }) {
  const since = dayOf(now - days * 86400000);
  let runs = [];
  try {
    runs = store.runs(days);
  } catch {
    runs = [];
  }

  const criteria = (order || []).map((id, i) => {
    let rows = [];
    try {
      rows = store.history(id, since);
    } catch {
      rows = [];
    }
    // 只有**有限数值**才算「有用的读数」：取不到时 value 是 null，
    // 那是「缺失」不是「0」，不能混进走势里。
    const pts = rows.filter((r) => r.value !== null && r.value !== undefined && Number.isFinite(Number(r.value)));
    const lastRow = rows.length ? rows[rows.length - 1] : null;
    const lastPt = pts.length ? pts[pts.length - 1] : null;
    return {
      id,
      code: `M${i + 1}`,
      label: lastRow?.label || id,
      unit: lastRow?.unit || null,
      // available 取**最后一次观测**的可用性，而不是「窗口里有点就算可用」——
      // 否则「最后一轮取不到、但前几天有值」会被显示成正常的票，
      // 而那一轮恰恰是最该被看见的一轮（这次取不到 = 现在的读数不可信）。
      available: !!(lastRow && lastRow.available),
      vote: lastRow ? lastRow.vote : null,
      latest: lastPt ? Number(lastPt.value) : null,
      points: pts.map((p) => ({ day: p.day, value: Number(p.value) })),
      records: rows.length,
    };
  });

  return { days, since, summary, runs, criteria };
}

/**
 * 渲染成终端文本（纯函数，不打印）。
 *
 * @param {object} data historyViewData() 的返回值
 * @returns {string}
 */
export function renderHistoryView(data) {
  const { days, since, summary = {}, runs = [], criteria = [] } = data;
  const rule = '─'.repeat(74);
  const out = [];

  out.push(`宏观历史账本 · ${summary.backend || '—'} · ${pathOf(summary)}`);
  out.push(
    `共 ${summary.days ?? 0} 天 / ${summary.rows ?? 0} 行（${summary.firstDay || '—'} ~ ${summary.lastDay || '—'}）` +
      ` · 有用数值 ${summary.available ?? 0}/${summary.rows ?? 0}`
  );

  if (!summary.rows) {
    out.push(rule);
    out.push('  库里还没有任何记录。先跑一次采集：npm run macro:daily');
    return out.join('\n');
  }

  /* ① 每日概览 —— 回答「那天系统给出了什么结论、有几个源失联」。
   *    `macro_runs` 那一行是唯一能把「读数」和「当时算出的方向」对上号的地方。 */
  out.push('');
  out.push(`① 每日采集概览（近 ${days} 天，共 ${runs.length} 次）`);
  out.push(rule);
  out.push(
    '   ' + pad('日期', 12) + pad('取到', 7) + pad('多/空/弃', 11) + pad('方向', 11) + pad('相位', 15) + pad('现价', 12) + '失败源'
  );
  if (!runs.length) out.push('   （无）');
  for (const r of runs) {
    const total = (r.available ?? 0) + (r.abstain ?? 0);
    const got = r.available === null || r.available === undefined ? '—' : `${r.available}/${total}`;
    const votes = [r.vote_long, r.vote_short, r.abstain].map((x) => (x === null || x === undefined ? '—' : x)).join('/');
    const px =
      r.spot_price === null || r.spot_price === undefined ? '—' : `$${Math.round(r.spot_price).toLocaleString('en-US')}`;
    out.push(
      '   ' +
        pad(r.day, 12) +
        pad(got, 7) +
        pad(votes, 11) +
        pad(r.bias || '—', 11) +
        pad(r.cycle_phase || '—', 15) +
        pad(px, 12) +
        failedNames(r.errors)
    );
  }

  /* ② 逐判据 —— 回答「每条读数这几天的走向」。 */
  out.push('');
  out.push(`② 逐判据（近 ${days} 天）`);
  out.push(rule);
  out.push('   ' + pad('判据', 20) + pad('单位', 13) + pad('最新', 13) + pad('区间首→末（变化）', 26) + '票');
  for (const c of criteria) {
    // 最后一次观测取不到 → 明确标弃权。不能沿用前几天的票：
    // 读的人会把「前几天投的票」当成「现在的读数」。
    const voteTxt = !c.available
      ? '弃权'
      : c.vote === null || c.vote === undefined
        ? '—'
        : c.vote > 0
          ? '多'
          : c.vote < 0
            ? '空'
            : '—';
    const latestTxt = c.latest === null ? '—' : cell(c.latest, c.unit);

    let changeTxt;
    let spark = '';
    if (c.points.length >= 2) {
      const first = c.points[0].value;
      const lastV = c.points[c.points.length - 1].value;
      changeTxt = `${compact(first, c.unit)} → ${compact(lastV, c.unit)}（${deltaText(lastV - first, c.unit)}）`;
      spark = sparkTerm(c.points.map((p) => p.value)) || '';
    } else if (c.points.length === 1) {
      // 只有一天 —— 明说，不画折线（单点画出来看着像「非常稳定」）
      changeTxt = '仅 1 天记录';
    } else {
      changeTxt = c.records ? '窗口内无数值' : '暂无历史';
    }

    out.push(
      '   ' +
        pad(`${c.code} ${c.label}`, 20) +
        pad(unitShort(c.unit), 13) +
        pad(latestTxt, 13) +
        pad(changeTxt, 26) +
        voteTxt +
        (spark ? `  ${spark}` : '')
    );
  }

  out.push('');
  out.push(`   （回看窗口自 ${since} 起 · 走势条为单色，不套用红涨绿跌 ——`);
  out.push('     恐慌贪婪上涨是坏消息，颜色语义与价格相反，用色反而会读反）');
  return out.join('\n');
}

const pathOf = (summary) => summary.path || '—';
