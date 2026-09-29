#!/usr/bin/env node
/**
 * 比特皇每日总结（默认北京时间 18:00 推送到微信/企微/Telegram）。
 *
 * 为什么是这五段 —— 这就是比特皇看盘的顺序，顺序错了结论就错了：
 *   ① 先定方向   周期相位 → 结构 → 情绪 → 事件，方向没定，后面全是白看
 *   ② 六项读数   M1~M6，谁给了多头票、谁给了空头票、谁弃权、谁的源挂了
 *   ③ 关键事件   未来有没有能改变方向的事，shock 是不是在窗口里
 *   ④ 持仓与风控 有仓才谈得上管理：止损在哪、离清算多远、滚仓条件到没到
 *   ⑤ 今天做什么 收敛成可执行的 1~3 条，不是复述数据
 *
 * 用法：
 *   node tools/daily-brief.js --dry-run     只打印，不推送（先看效果）
 *   node tools/daily-brief.js --now         立刻推一次（跳过定时）
 *   node tools/daily-brief.js --daemon      常驻：每天 18:00 推，由 entrypoint 起
 *
 * 环境变量：HL_BASE / HL_USER / HL_COIN / HL_BRIEF_AT（默认 18:00）/ HL_BRIEF（总开关）
 *
 * 地址没配也能推：方向层、六项读数、事件都不需要地址，只是持仓那两段会注明省略。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAlertConfig, loadState, ALERT_DIR } from '../src/alertstore.js';
import { evaluateAlerts } from '../src/alerts.js';
import { sendNotify } from '../src/notify.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, '.data');
const BRIEF_STATE = path.join(DATA_DIR, 'brief-state.json');

const ZERO = '0x0000000000000000000000000000000000000000';
const BASE = process.env.HL_BASE || 'http://127.0.0.1:8787';
const USER = process.env.HL_USER || ZERO;
const COIN = process.env.HL_COIN || 'BTC';
const AT = process.env.HL_BRIEF_AT || '18:00';
const TZ_OFFSET_MIN = 480; // 北京时间固定 +8（中国无夏令时，写死比算时区安全）

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const DRY = has('--dry-run');
const QUIET = has('--quiet');

const log = (...a) => {
  if (!QUIET) console.log(...a);
};
const num = (v, dp = 2) => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(dp) : '—';
};
const pct = (v, dp = 1) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(dp)}%`;
};
const sgn = (v, dp = 1) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `${n > 0 ? '+' : ''}${(n * 100).toFixed(dp)}%`;
};
/** 价格按量级取精度：8 万的 BTC 和 0.03 的 meme 不能用同一个小数位 */
const px = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return '—';
  const dp = Math.abs(n) >= 1000 ? 1 : Math.abs(n) >= 1 ? 2 : 4;
  return n.toLocaleString('en-US', { maximumFractionDigits: dp });
};
const beijingNow = () => new Date(Date.now() + TZ_OFFSET_MIN * 60000);
const beijingDate = (t = Date.now()) => new Date(t + TZ_OFFSET_MIN * 60000).toISOString().slice(0, 10);
const hhmm = (d = beijingNow()) => d.toISOString().slice(11, 16);
/** 北京时间某个 HH:MM 对应的绝对时间戳（已过就顺延到明天） */
function nextAt(hhmmStr, now = Date.now()) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmmStr || '18:00'));
  const H = m ? Number(m[1]) : 18;
  const M = m ? Number(m[2]) : 0;
  const dayStamp = (offsetDays) => {
    const b = new Date(now + TZ_OFFSET_MIN * 60000 + offsetDays * 86400000);
    return Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate(), H - 8, M, 0, 0);
  };
  const today = dayStamp(0);
  return now >= today ? dayStamp(1) : today;
}

/* ────────────────────────── 取数 ────────────────────────── */

async function getSnapshot() {
  const url = `${BASE}/api/snapshot?network=mainnet&user=${encodeURIComponent(USER)}&coin=${encodeURIComponent(COIN)}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 180000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const s = await r.json();
    if (!s || s.ok === false) throw new Error(s?.error || 'snapshot ok=false');
    return s;
  } finally {
    clearTimeout(timer);
  }
}

/** 活动预警（只读 state，不写 —— 写状态是 watch.js 的活，两边抢一个文件会互相吞事件） */
async function getAlerts(snapshot) {
  try {
    const cfg = await loadAlertConfig();
    const prev = await loadState('mainnet', USER);
    const res = evaluateAlerts({ snapshot, prev, config: cfg });
    return { active: res.active || {}, summary: res.summary || {}, ok: res.ok && !res.disabled };
  } catch (e) {
    return { active: {}, summary: {}, ok: false, error: String(e.message || e) };
  }
}

/* ────────────────────── 比特皇思维 · 五段 ────────────────────── */

const VOTE_TAG = (v) => (Number(v) > 0 ? '多' : Number(v) < 0 ? '空' : '弃');

function sectionDirection(s) {
  const r = s.regime || {};
  const L = ['## ① 先定方向', ''];
  L.push(
    `**${r.biasLabel || '—'}** · 置信度 ${r.confidence || '—'} · ${
      r.approved ? '已批准开仓' : '不批准开新仓'
    }`
  );
  L.push(
    `只许做哪边：**${r.intentLabel || '—'}**${r.allowLong ? '（可做多）' : ''}${
      r.allowShort ? '（可做空）' : ''
    }`
  );
  const c = r.clock || {};
  if (c.label) L.push(`周期相位：**${c.label}**${c.intent ? ` → ${c.intent}` : ''}（距下次减半 ${num(c.monthsToNext, 1)} 个月）`);
  const st = r.structure || {};
  if (st.verdict) L.push(`结构：**${st.verdict}** · 200日均线${st.priceVs200d ? '上方' : '下方'} · 距前高 ${pct(r.technicals?.drawdownPct)}`);
  const sn = r.sentiment || {};
  if (sn.available) L.push(`情绪：资金费 ${num(sn.percentile, 0)} 分位 · 拥挤度 ${sn.crowding || '—'} · ${sn.priceHolding || ''}`);
  const ev = r.events || {};
  if (ev.items?.length)
    L.push(`事件层净权重 **${num(ev.net, 2)}**${ev.shock?.active ? ' · ⚠ 黑天鹅冷却窗口内' : ''}`);
  if (r.stableDays != null) L.push(`<font color="comment">迟滞：已稳定 ${r.stableDays} 天 / 翻转需 ${r.confirmDays} 天 / 最短持有 ${r.minHoldDays} 天</font>`);

  const reasons = Array.isArray(r.reasons) ? r.reasons : [];
  if (reasons.length) {
    L.push('', '**理由**');
    reasons.slice(0, 5).forEach((x) => L.push(`· ${String(x).replace(/\*\*/g, '').trim()}`));
  }
  return L.join('\n');
}

function sectionMacro(s) {
  const m = s.macro || {};
  const rows = Array.isArray(m.readings) ? m.readings : [];
  const L = ['## ② 六项读数', ''];
  if (!rows.length) L.push('（读数不可用）');
  rows.forEach((r) => {
    const tag = r.available === false ? '源不可用' : VOTE_TAG(r.vote);
    const v = Number(r.value);
    const val = r.value != null && Number.isFinite(v)
      ? v.toLocaleString('en-US', { maximumFractionDigits: 2 })
      : '—';
    const bit = r.available === false ? '🔴' : Number(r.vote) > 0 ? '🟢' : Number(r.vote) < 0 ? '🔴' : '⚪';
    L.push(`${bit} **${r.layer || '—'} ${r.name || r.label || r.id || ''}** ${val} → ${tag}`);
    if (r.reason) L.push(`  <font color="comment">${String(r.reason).replace(/\*\*/g, '').slice(0, 88)}</font>`);
  });
  if (m.errors?.length) L.push('', `<font color="comment">源异常：${m.errors.slice(0, 3).join(' / ')}</font>`);
  return L.join('\n');
}

function sectionEvents(s) {
  const ev = s.regime?.events || {};
  const items = Array.isArray(ev.items) ? ev.items : [];
  const L = ['## ③ 关键事件', ''];
  if (!items.length) L.push('（事件表为空）');

  // 每日总结看的是「接下来有什么」，不是复盘历史：先未来日程，再还在起作用的旧事件
  const future = items.filter((e) => e.pending).sort((a, b) => (a.date < b.date ? -1 : 1));
  const live = items
    .filter((e) => !e.pending && Math.abs(Number(e.effective ?? 0)) >= 0.05)
    .sort((a, b) => Math.abs(Number(b.effective ?? 0)) - Math.abs(Number(a.effective ?? 0)));

  if (future.length) {
    L.push('**日程（还没发生）**');
    future.slice(0, 4).forEach((e) => L.push(`📅 **${e.date}** ${e.note || e.kind}（权重 ${num(e.weight, 1)}）`));
    L.push('');
  }
  if (live.length) {
    L.push('**仍在起作用**');
    live.slice(0, 3).forEach((e) => {
      const w = Number(e.effective ?? 0);
      L.push(
        `· **${e.date}** ${e.note || e.kind}（${w > 0 ? '偏多' : '偏空'} ${num(w, 2)} · ${num(e.ageDays, 0)} 天前，半衰期 ${
          e.halfLifeDays
        } 天）`
      );
    });
  }
  if (!future.length && !live.length) L.push('近期无有效事件（日程为空，旧事件已衰减到 0.05 以下）');

  if (ev.shock?.active)
    L.push('', `⚡ **黑天鹅冷却中**：${ev.shock.date}，${num(ev.shock.ageDays, 0)} 天前 · 冷却至 ${ev.shock.cooldownUntil || '—'} —— 方向层强制 NEUTRAL，只管既有仓位`);
  return L.join('\n');
}

function sectionPositions(s, alerts) {
  const L = ['## ④ 持仓与风控', ''];
  if (USER === ZERO) L.push('（未配置地址 HL_USER，持仓部分省略 —— 方向/读数/事件不受影响）');
  else {
    const pos = (Array.isArray(s.positions) ? s.positions : []).filter((p) => Math.abs(Number(p.szi || 0)) > 0);
    if (!pos.length) L.push('**当前无持仓**');
    else {
      const top = pos
        .map((p) => ({ p, v: Math.abs(Number(p.positionValue) / 1e18 || 0) }))
        .sort((a, b) => b.v - a.v)
        .slice(0, 5)
        .map((x) => x.p);
      L.push(`共 ${pos.length} 个持仓 · 名义前 ${top.length}：`);
      top.forEach((p) => {
        const pnl = Number(p.unrealizedPnl) / 1e18;
        const lev = p.leverage?.value ? `${p.leverage.value}x${p.leverage.type === 'isolated' ? '逐仓' : ''}` : '—';
        const liq = Number(p.liquidationPx) > 0 ? px(Number(p.liquidationPx) / 1e18) : '—';
        L.push(
          `**${p.coin}** ${p.isLong ? '多' : '空'} · ${pnl >= 0 ? '+' : ''}${num(pnl, 0)} USDC · ${lev} · 清算 ${liq} · 现价 ${px(
            Number(p.markPx) / 1e18
          )}`
        );
      });
    }

    // 重点币：只对「有事的」详细展开，没事的压成一行 —— 总结是给人看的，不是日志
    const lv = s.levelsByCoin || {};
    const detail = [];
    const calm = [];
    Object.keys(lv).forEach((coin) => {
      const L2 = lv[coin];
      if (!L2?.hasPosition) return;
      const st = L2.stop || {};
      const roll = L2.roll || {};
      const ex = L2.exitSignals || {};
      const gate = L2.gate || {};
      const hot = st.breached || ex.active || roll.ready || (gate.state && gate.state !== 'IDLE');
      if (!hot) {
        calm.push(
          `${coin} ${gate.side > 0 ? '多' : '空'} 浮盈 ${pct(roll.profitPct)}（滚仓需 ${num(roll.triggerBps / 100, 1)}%）`
        );
        return;
      }
      const b = [`**${coin}**`];
      if (ex.active)
        b.push(`🔴 离场信号【${ex.urgency}】：${String(ex.summary || '').replace(/\*\*/g, '').slice(0, 76)}`);
      if (st.breached)
        b.push(`🔴 止损被击穿（锚 ${px(Number(st.anchor) / 1e18)}）—— 立马走，**不要把止损往下挪**`);
      else if (Number(st.recommended || st.anchor) > 0)
        b.push(`止损参考 ${px(Number(st.recommended || st.anchor) / 1e18)}`);
      if (roll.ready) b.push(`🟠 滚仓条件达成：浮盈 ${pct(roll.profitPct)} ≥ ${num(roll.triggerBps / 100, 1)}%`);
      if (gate.state && gate.state !== 'IDLE') b.push(`开仓门：${gate.state}`);
      detail.push(b.join('\n'));
    });
    if (detail.length) L.push('', ...detail);
    if (calm.length) L.push('', `<font color="comment">其余 ${calm.length} 个重点币无异动：${calm.slice(0, 4).join(' · ')}</font>`);
  }

  L.push('');
  const sum = alerts.summary || {};
  if (alerts.ok && sum.total) {
    L.push(`**活动预警 ${sum.total} 条**（严重 ${sum.critical ?? 0} / 警告 ${sum.warn ?? 0}）`);
    const list = Object.values(alerts.active);
    list.slice(0, 5).forEach((a) =>
      L.push(`${a.severity === 'critical' ? '🔴' : '🟠'} ${a.coin || ''} ${a.title || ''}`.trim())
    );
    if (list.length > 5) L.push(`<font color="comment">…另有 ${list.length - 5} 条，开看板看全部</font>`);
  } else if (alerts.ok) {
    L.push('活动预警：**无**');
  } else {
    L.push(`<font color="comment">预警引擎不可用${alerts.error ? `：${alerts.error}` : ''}</font>`);
  }
  return L.join('\n');
}

/** ⑤ 今天做什么 —— 按优先级收敛成 1~3 条可执行的，不是复述数据 */
function sectionAction(s) {
  const L = ['## ⑤ 今天做什么', ''];
  const r = s.regime || {};
  const pipe = s.pipeline || {};
  const lv = Object.values(s.levelsByCoin || {}).filter((x) => x?.hasPosition);
  const out = [];

  // 同一件事在 N 个币上同时发生时只说一次 —— 连推三条一模一样的「先处理离场」
  // 就等于把后面真正重要的方向结论挤出屏幕了
  const exits = lv.filter((x) => x.exitSignals?.active && x.exitSignals.urgency === 'IMMEDIATE');
  const breaches = lv.filter((x) => x.stop?.breached && !exits.includes(x));
  if (exits.length)
    out.push(
      `🔴 **先处理离场**：${exits.map((x) => x.coin).join('/')} 共 ${exits.length} 个币触发 IMMEDIATE 离场信号 —— 按规则走，别把止损往下挪`
    );
  if (breaches.length) out.push(`🔴 **止损被击穿**：${breaches.map((x) => x.coin).join('/')} —— 平掉，不加仓摊平`);

  const rolls = lv.filter((x) => x.roll?.ready);
  if (rolls.length) out.push(`🟠 **滚仓条件到了**：${rolls.map((x) => x.coin).join('/')} —— 只用利润加，最多 ${rolls[0].roll.maxAdds} 档`);

  if (r.events?.shock?.active) out.push('⚡ **黑天鹅冷却中**，方向层强制 NEUTRAL —— 冻结新开仓，只管既有仓位');
  out.push(
    r.approved && (r.allowLong || r.allowShort)
      ? `✅ **方向已批准**（${r.intentLabel || ''}）—— 看阶段二的入场条件，条件不到就等`
      : `⏸ **${pipe.headline || r.biasLabel || '方向未定'}** —— 方向没定，开什么都是赌。等条件，不动手`
  );
  out.push('🛡 风险预算先行：破了止损就走，不挪止损、不摊平');

  L.push(...out.slice(0, 4));
  if (pipe.bottleneck?.reason)
    L.push('', `<font color="comment">卡点：${String(pipe.bottleneck.reason).replace(/\*\*/g, '').slice(0, 130)}</font>`);
  return L.join('\n');
}

/**
 * 标题 = 一行状态摘要，硬上限 32 字（Server酱 `title` 超长会被截断）。
 *
 * 为什么状态必须塞进标题：Server酱**免费版走微信服务号通道时只显示 title、
 * 不下发正文**（官方《通道对比》：「免费版卡片仅显示标题」）。也就是说正文写得
 * 再全，用户点开也只有这一行 —— 那么「今天到底什么状况」就得在这一行里说清。
 * 换了能看到正文的通道（企业微信应用消息等）时，它顺带也是会话列表里的预览。
 *
 * 取舍：方向 > 预警数 > 最要紧的那个币（击穿/离场/滚仓）。日期只留 MM-DD ——
 * 每天同一时刻推同名消息，列表里不带日期会分不清哪条是哪天的。
 */
function buildTitle(s, alerts) {
  const r = s.regime || {};
  const head = beijingNow().toISOString().slice(5, 10); // MM-DD
  const dir = r.approved ? String(r.intentLabel || '已批准') : '未定';
  const n = alerts.summary?.total ?? 0;

  let urgent = '';
  for (const x of Object.values(s.levelsByCoin || {})) {
    if (!x?.hasPosition) continue;
    if (x.stop?.breached) {
      urgent = `${x.coin}击穿`;
      break;
    }
    if (x.exitSignals?.active) {
      urgent = `${x.coin}离场`;
      break;
    }
    if (x.roll?.ready) {
      urgent = `${x.coin}滚仓`;
      break;
    }
  }

  const parts = [head, `比特皇·${dir}`];
  if (n) parts.push(`${n}预警`);
  if (urgent) parts.push(urgent);
  const t = parts.join('·');
  return t.length > 32 ? `${t.slice(0, 31)}…` : t;
}

function buildBrief(s, alerts) {
  const now = beijingNow();
  const date = now.toISOString().slice(0, 10);
  const body = [
    `## 比特皇每日总结 · ${date} ${AT}`,
    `> ${hhmm(now)}（北京时间）· ${USER === ZERO ? '未配置地址' : USER.slice(0, 6) + '…' + USER.slice(-4)} · ${
      s.focusCoin || COIN
    } · 现价 ${px(s.markets?.[s.focusCoin || COIN]?.markPx)}`,
    '',
    sectionDirection(s),
    '',
    sectionMacro(s),
    '',
    sectionEvents(s),
    '',
    sectionPositions(s, alerts),
    '',
    sectionAction(s),
  ].join('\n');

  const text = body
    .replace(/^##+\s*/gm, '')
    .replace(/\*\*/g, '')
    .replace(/<font[^>]*>|<\/font>/g, '')
    .replace(/^>\s*/gm, '');

  return {
    title: buildTitle(s, alerts),
    body,
    text,
    summary: {
      bias: s.regime?.bias,
      biasLabel: s.regime?.biasLabel,
      alerts: alerts.summary?.total ?? 0,
      at: Date.now(),
    },
  };
}

/* ────────────────────── 推送与调度 ────────────────────── */

async function pushOnce({ force = false } = {}) {
  const date = beijingDate();
  if (!force) {
    try {
      const st = JSON.parse(await fs.readFile(BRIEF_STATE, 'utf8'));
      if (st?.lastPushDate === date) {
        log(`今天（${date}）已推送过，跳过`);
        return false;
      }
    } catch {
      /* 没有状态文件就是还没推过 */
    }
  }

  log(`拉取快照 ${BASE} …`);
  const snap = await getSnapshot();
  const alerts = await getAlerts(snap);
  const payload = buildBrief(snap, alerts);

  if (DRY) {
    console.log(
      `\n──── DRY-RUN（未推送）· 标题 ${payload.title.length}/32 字 · 正文 ${payload.body.length} 字${
        payload.body.length > 3800 ? ' ⚠ 超过企微 3800 会被截断' : ''
      } ────\n标题：${payload.title}\n\n` +
        payload.body +
        '\n──────────────────────────────'
    );
    return true;
  }

  log(`正文 ${payload.body.length} 字${payload.body.length > 3800 ? ' ⚠ 超企微 3800 截断线' : ''}`);
  try {
    const cfg = JSON.parse(await fs.readFile(path.join(ALERT_DIR, 'config.json'), 'utf8'));
    const res = await sendNotify(cfg, payload);
    log(
      `推送${res.ok ? '成功' : '失败'}：通道 ${res.delivered.join(', ') || '无'}${
        res.failed.length ? ` · 失败 ${res.failed.join(', ')}` : ''
      }`
    );
    if (res.ok) {
      await fs.mkdir(DATA_DIR, { recursive: true });
      const cur = JSON.parse(await fs.readFile(BRIEF_STATE, 'utf8').catch(() => '{}'));
      await fs.writeFile(BRIEF_STATE, JSON.stringify({ ...cur, lastPushDate: date, lastPushAt: Date.now() }, null, 2));
    }
    return res.ok;
  } catch (e) {
    log(`推送异常：${e.message}`);
    return false;
  }
}

async function daemon() {
  const at = AT;
  log(`每日总结守护已启动：每天 ${at}（北京时间）推送 · 等待下一个触发点`);
  for (;;) {
    const wait = nextAt(at) - Date.now();
    log(`  下次：${new Date(Date.now() + wait).toISOString()}（还有 ${Math.round(wait / 60000)} 分钟）`);
    await new Promise((r) => setTimeout(r, Math.max(1000, wait)));
    try {
      await pushOnce();
    } catch (e) {
      log(`本轮失败（下一轮会重试）：${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 60000)); // 过了触发点再等一分钟，避免同一分钟推两次
  }
}

const main = async () => {
  if (has('--help') || has('-h')) {
    console.log('用法: node tools/daily-brief.js [--dry-run] [--now] [--daemon] [--quiet]');
    process.exit(0);
  }
  if (has('--daemon')) return daemon();
  await pushOnce({ force: has('--now') || has('--dry-run') });
};

main().then(
  () => {
    if (!has('--daemon')) process.exit(0);
  },
  (e) => {
    console.error('daily-brief 失败：', e);
    process.exit(1);
  }
);
