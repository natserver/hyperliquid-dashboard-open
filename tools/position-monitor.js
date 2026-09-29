#!/usr/bin/env node
/**
 * 比特皇「适合开单」条件监控器
 * ══════════════════════════════════════════════════════════════════════
 *
 * 复用生产路径，绝不重写判定逻辑：
 *   · fetchRegimeInputs('mainnet')  → BTC 三路 K 线 + 资金费（公开接口，无密钥）
 *   · collectMacroSources           → M1~M6 六个宏观源
 *   · buildRegime                   → 系统一：宏观方向层（A1 减半时钟 + A2 结构 + A3 事件）
 *   · computeLevels                 → 内部调用 analyzeSetup（系统二触发层）+ gate（交汇点）
 *                                     并把 gate 结果挂到 levels.gate 上
 *
 * 输出：把比特皇提出的**全部适合开单判据**逐项列清，并给出两方向开单可行性
 *       （做多 / 做空各自的 SIGNAL / ARMED / VETOED / IDLE）。
 *       当某一方向从「非开单」翻转为 SIGNAL（已批准）或 ARMED（正在成形）时，
 *       自动推送 Telegram（需先在 .alerts/config.json 配好 telegram 通道）。
 *
 * 用法：
 *   node tools/position-monitor.js                打印完整报告（并按需推 Telegram）
 *   node tools/position-monitor.js --json         输出 JSON（给自动化/外部读）
 *   node tools/position-monitor.js --quiet        只打印一行摘要（cron 日志友好）
 *   node tools/position-monitor.js --no-push      不推 Telegram，仅本地报告
 *   node tools/position-monitor.js --force-push   即使无状态变化也推一条（测试用）
 *   node tools/position-monitor.js --phase DECLINE 指定周期相位（默认 AUTO = 按减半时钟推算）
 *
 * 设计要点（与看板同源，避免漂）：
 *   · 相位在脚本开头就用 derivePhase 解析成具体值，绝不把 PHASE_AUTO 下传；
 *     否则 phaseFloorBps 收到非四相位值会静默落到 DECLINE 档（巧合正确、实际是 bug）。
 *   · 状态写进 .data/monitor-state.json，只在「翻转为可开单/正在成形」时推送，
 *     避免每个 6 小时都重复轰炸。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchRegimeInputs, loadMacroEvents, buildRegime } from '../src/regime-inputs.js';
import { collectMacroSources, evaluateMacroCriteria, MACRO_SOURCES } from '../src/macro-sources.js';
import {
  defaultConfig,
  PHASE_AUTO,
  derivePhase,
  phaseFloorBps,
  validateParams,
  parseWad,
  defaultTiers,
  PHASE_LABELS,
} from '../src/strategy.js';
import { computeLevels } from '../src/levels.js';
import { info } from '../src/hl.js';
import { sendNotify } from '../src/notify.js';
import { loadAlertConfig } from '../src/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dirname, '..');
const STATE_PATH = path.resolve(PROJECT, '.data', 'monitor-state.json');
const FOUR_HOURS = 4 * 3600 * 1000;

/* ───────────────────────── 参数 ───────────────────────── */
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const JSON_OUT = has('--json');
const QUIET = has('--quiet');
const NO_PUSH = has('--no-push');
const FORCE_PUSH = has('--force-push');
const PHASE_ARG = String(val('--phase', PHASE_AUTO)).toUpperCase();

const log = (...a) => {
  if (!QUIET) console.log(...a);
};
const logErr = (...a) => console.error(...a);

/* ───────────────────────── 状态文件 ───────────────────────── */
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}
function saveState(s) {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
  } catch {
    /* 状态文件写失败不应阻断监控 */
  }
}

/* ───────────────────────── 单方向可行性推导 ─────────────────────────
 * 严格镜像 src/strategy.js 的 gate() 逻辑（只做两侧展开）：
 *   · 追高否决 / 顶部刹车 —— 仅对「方向是多头」生效
 *   · 逆势否决 —— 触发方向与宏观许可相反
 *   · 方向未定（NEUTRAL）→ 不开新仓
 *   · 方向放行 + 该侧触发腿已足 → 主导侧用真实 gate.state；非主导侧标注待核验
 */
function deriveDirection(want, regime, setup, gate) {
  if (!regime) return { state: 'IDLE', note: '方向层未计算' };
  const allow = want === 1 ? !!regime.allowLong : !!regime.allowShort;
  const bias = regime.bias;
  const macroOpposite =
    (want === 1 && bias === 'SHORT_ONLY') || (want === -1 && bias === 'LONG_ONLY');
  const chaseBlocked = want === 1 && bias === 'LONG_ONLY' && !!regime.chaseBlocked;
  const topBrake = want === 1 && bias === 'LONG_ONLY' && !!regime.topBrake;
  const legs = want === 1 ? setup?.longLegs || 0 : setup?.shortLegs || 0;
  const required = setup?.required || 3;

  if (chaseBlocked) return { state: 'VETOED', note: '追高否决：价格过热，位置赔率不成立' };
  if (topBrake) return { state: 'VETOED', note: '顶部刹车：量能派发/消息反应/拥挤度指向见顶' };
  if (macroOpposite) return { state: 'VETOED', note: '逆势否决：触发方向与宏观许可相反' };
  if (!allow) return { state: 'IDLE', note: '方向未定（NEUTRAL），不开新仓' };

  if (legs >= required) {
    if (setup && setup.side === want) {
      return { state: gate?.state || 'SIGNAL', note: '方向放行 + 该侧触发已成形' };
    }
    return { state: 'ARMED', note: '方向放行 + 该侧推进腿已足（squeeze/H2 未对该侧单独核验）' };
  }
  if (legs > 0) return { state: 'ARMED', note: `方向放行，触发腿 ${legs}/${required}` };
  return { state: 'ARMED', note: '方向放行，等待触发形态（独立推进腿）' };
}

const STATE_RANK = { IDLE: 0, ARMED: 1, SIGNAL: 2, VETOED: 3 };

/* ═══════════════════════════════════════════════════════════════════ */
async function main() {
  const nowMs = Date.now();
  const t0 = nowMs;

  /* 相位解析（开头就做，绝不把 AUTO 下传） */
  const phaseResolved = derivePhase(nowMs, PHASE_ARG);
  const PHASE = phaseResolved.phase;
  if (phaseResolved.unknown && !JSON_OUT) {
    logErr(`⚠ --phase ${PHASE_ARG} 不是已知相位，已改用减半时钟推算的 ${PHASE}`);
  }

  /* 策略配置（与 server.js / macro-daily.js 同源） */
  const cfg = defaultConfig(PHASE);
  cfg.cyclePhase = PHASE;
  cfg.risk.minExpectedMoveBps = Math.max(phaseFloorBps(PHASE), 1800);
  const warnings = [];
  try {
    validateParams(cfg.risk, PHASE);
  } catch (e) {
    warnings.push(`配置校验：${e.message}`);
  }
  const tiers = defaultTiers();

  /* ① 三路 K 线 + 资金费（方向层输入） */
  log('▶ 拉取 BTC 方向层输入（日/周/月 K 线 + 资金费）…');
  const inputs = await fetchRegimeInputs('mainnet', { nowMs });
  const spotPrice = inputs.daily.length ? inputs.daily[inputs.daily.length - 1].c : null;

  /* ② 4H 触发 K 线（系统二需要 WAD 收盘价） */
  log('▶ 拉取 BTC 4H 触发 K 线…');
  const raw4h = await info(
    'mainnet',
    {
      type: 'candleSnapshot',
      req: { coin: 'BTC', interval: '4h', startTime: nowMs - 200 * FOUR_HOURS, endTime: nowMs },
    },
    { ttl: 20 * 1000 }
  );
  const candles = (raw4h || []).map((c) => ({
    t: Number(c.t),
    o: String(c.o),
    h: String(c.h),
    l: String(c.l),
    c: String(c.c),
    v: String(c.v),
  }));
  const markWad = candles.length ? parseWad(candles[candles.length - 1].c) : 0n;

  /* ③ M1~M6 宏观源 */
  log('▶ 采集 M1~M6 宏观源…');
  const src = await collectMacroSources({ now: nowMs });
  const readings = evaluateMacroCriteria(src, { price: spotPrice, config: cfg });

  /* ④ 方向层 + 触发层 + 门禁（生产路径） */
  const events = loadMacroEvents();
  const regime = buildRegime({ inputs, cfg, events, macro: readings, nowMs });
  const levels = computeLevels({
    coin: 'BTC',
    candles,
    markWad,
    position: null,
    equityWad: 0n,
    config: cfg,
    tiers,
    regime,
  });
  const gate = levels.gate || levels.entryPlan?.gate || null;
  const setup = levels.trigger || levels.setup || null;

  /* ───────── 报告组装 ───────── */
  const clock = regime?.clock;
  const structure = regime?.structure;
  const macroAvail = readings.filter((r) => r.available).length;
  const voteLong = readings.filter((r) => r.available && r.vote > 0).length;
  const voteShort = readings.filter((r) => r.available && r.vote < 0).length;

  const longSt = deriveDirection(1, regime, setup, gate);
  const shortSt = deriveDirection(-1, regime, setup, gate);

  const phaseLabel = PHASE_LABELS[PHASE] || PHASE;
  const intentLabel = regime?.intentLabel || '—';

  const lines = [];
  const L = (s) => lines.push(s);

  L(`═══ 比特皇「适合开单」监控 · ${new Date(nowMs).toLocaleString('zh-CN', { hour12: false })} ═══`);
  L('');

  /* A1 减半时钟 */
  L(`【A1 减半时钟】${PHASE}（${phaseLabel}）· 距上次减半 ${clock?.monthsSince ?? '—'} 个月`);
  L(`   许可方向：${intentLabel}  →  波动门槛 ${phaseFloorBps(PHASE) / 100}%`);
  if (phaseResolved.stale) L(`   ⚠ ${phaseResolved.detail}`);

  /* A2 结构 */
  L(`【方向层结论】bias=${regime?.biasLabel || '—'} · 置信度 ${regime?.confidence || '—'}`);
  if (structure) {
    L(`【A2 结构】verdict=${structure.verdict}（归一化 ${structure.normalized}）· 回撤区 ${structure.drawdownZone}`);
    for (const c of structure.components || []) {
      if (c.vote === 0 && c.detail?.includes('弃权')) {
        L(`   · ${c.label}：弃权（${c.detail}）`);
      } else {
        const v = c.value == null ? '—' : Number(c.value).toLocaleString('en-US', { maximumFractionDigits: 2 });
        L(`   · ${c.label}：vote ${c.vote > 0 ? '+' : ''}${c.vote}（值 ${v}）`);
      }
    }
    if (structure.chaseForbidden) {
      L(`   · 追高禁令：触发（价格高于 200 日均线 ${(structure.extensionVs200d * 100).toFixed(1)}%）`);
    }
  }

  /* 触发层 系统二 */
  L(`【系统二 触发层】side=${setup?.side === 1 ? '多' : setup?.side === -1 ? '空' : '无'} · 多腿 ${setup?.longLegs || 0}/空腿 ${setup?.shortLegs || 0}（required ${setup?.required || 3}）`);
  if (setup) {
    L(`   收口(squeeze)：${setup.squeeze?.ok ? `是（分位 ${setup.squeeze.percentile}）` : setup.squeeze?.percentile == null ? '弃权' : `否（分位 ${setup.squeeze.percentile}）`}`);
    L(`   入口模式：${setup.entryMode || '—'} · gate=${gate?.state || '—'}`);
  }
  if (gate?.reason) L(`   gate 理由：${gate.reason}`);

  /* 两方向可行性 */
  L('【两方向开单可行性】');
  L(`   做多：${longSt.state} —— ${longSt.note}`);
  L(`   做空：${shortSt.state} —— ${shortSt.note}`);

  /* M1~M6 */
  L(`【宏观 M1~M6】取到 ${macroAvail}/${readings.length} · 多 ${voteLong} / 空 ${voteShort} / 弃权 ${readings.length - macroAvail}`);
  for (const r of readings) {
    const st = r.available ? (r.broken ? 'BROKEN' : 'ok') : '弃权';
    const voteTxt = r.available ? (r.vote > 0 ? `+${r.vote}` : `${r.vote}`) : '—';
    const valTxt = r.value == null ? '—' : String(r.value);
    L(`   ${r.id} ${r.name}：vote ${voteTxt} [${st}] 值=${valTxt}`);
    if (r.reason && !JSON_OUT) L(`        ${r.reason}`);
  }

  /* A4~A7 判据层（来自 regime） */
  if (regime?.technicals || regime?.sentiment || regime?.volume || regime?.reaction) {
    L('【A4~A7 判据层】');
    const t = regime.technicals;
    if (t) L(`   A4 技术面：${t.verdict || '—'}（${t.detail || ''}）`);
    const s = regime.sentiment;
    if (s) L(`   A5 情绪：${s.verdict || '—'}（${s.detail || ''}）`);
    const v = regime.volume;
    if (v) L(`   A6 量能：${v.verdict || '—'}（${v.detail || ''}）`);
    const r = regime.reaction;
    if (r) L(`   A7 事件反应：${r.verdict || '—'}（${r.detail || ''}）`);
    if (regime.reversal) {
      const rv = regime.reversal;
      if (rv.topVotes) L(`   顶部刹车票数：${rv.topVotes}/${rv.minVotes ?? 2}`);
      if (rv.bottomVotes) L(`   底部确认票数：${rv.bottomVotes}/${rv.minVotes ?? 2}`);
    }
  }

  /* 结论 */
  L('═══ 结论 ═══');
  const openable = longSt.state === 'SIGNAL' || shortSt.state === 'SIGNAL';
  if (openable) {
    const side = longSt.state === 'SIGNAL' ? '做多' : '做空';
    L(`⚡ 比特皇框架当前【批准开${side}】—— gate=${gate?.state}。详见上方各判据。`);
  } else {
    L('当前比特皇框架不开新仓（NEUTRAL 或方向未放行）。');
    if (intentLabel.includes('空')) {
      L('唯一可能批的是【做空】，需等：① 结构转空（跌破 200 日均线/周均线、月线转低）；② 做空触发成形（3 条独立下推腿 + Bollinger 收口 + H2 站稳）。');
    } else if (intentLabel.includes('多')) {
      L('当前相位许可【做多】，需等结构转多 + 做多触发成形。');
    } else {
      L('当前相位为 NEUTRAL（顶部构筑区），双向都不批准新开仓。');
    }
  }
  if (warnings.length) L(`\n⚠ ${warnings.join('；')}`);

  /* ───────── 推送逻辑 ───────── */
  const cur = {
    long: longSt.state,
    short: shortSt.state,
    gate: gate?.state || null,
    at: nowMs,
  };
  const prev = loadState();
  const prevCur = prev.cur || null;
  const changed =
    !prevCur ||
    prevCur.long !== cur.long ||
    prevCur.short !== cur.short ||
    prevCur.gate !== cur.gate;

  const isSignal = (s) => s === 'SIGNAL';
  const isArmed = (s) => s === 'ARMED';
  const signalNow = isSignal(cur.long) || isSignal(cur.short);
  const armedNow = isArmed(cur.long) || isArmed(cur.short);
  const signalPrev = prevCur && (isSignal(prevCur.long) || isSignal(prevCur.short));
  const armedPrev = prevCur && (isArmed(prevCur.long) || isArmed(prevCur.short));

  // 仅在「翻转为已批准」或「翻转为正在成形」时推送；首次运行也推一条基线
  const shouldPush =
    !NO_PUSH && (FORCE_PUSH || signalNow || (armedNow && !armedPrev) || (signalNow && !signalPrev) || !prevCur);

  if (JSON_OUT) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          at: nowMs,
          spotPrice,
          phase: PHASE,
          phaseLabel,
          intent: regime?.intent,
          bias: regime?.bias,
          confidence: regime?.confidence,
          allowLong: regime?.allowLong ?? false,
          allowShort: regime?.allowShort ?? false,
          gate: gate?.state ?? null,
          gateReason: gate?.reason ?? null,
          long: longSt,
          short: shortSt,
          structure: structure
            ? {
                verdict: structure.verdict,
                normalized: structure.normalized,
                drawdownZone: structure.drawdownZone,
                chaseForbidden: structure.chaseForbidden,
              }
            : null,
          setup: setup
            ? {
                side: setup.side,
                longLegs: setup.longLegs,
                shortLegs: setup.shortLegs,
                required: setup.required,
                squeezeOk: setup.squeeze?.ok ?? null,
                entryMode: setup.entryMode,
              }
            : null,
          macro: readings.map((r) => ({
            id: r.id,
            name: r.name,
            available: !!r.available,
            broken: !!r.broken,
            vote: r.vote ?? null,
            value: r.value ?? null,
            status: r.ttl ?? null,
            reason: r.reason,
          })),
          signalNow,
          armedNow,
          shouldPush,
          elapsedMs: Date.now() - t0,
        },
        null,
        2
      )
    );
  } else {
    console.log(lines.join('\n'));
  }

  // 状态落盘（先于推送，确保即便推送失败也有记录）
  saveState({ cur, prevAt: prevCur ? prev.at : null, lastRunAt: nowMs });

  if (shouldPush) {
    try {
      const cfgAlert = await loadAlertConfig();
      const pushBody = lines.join('\n');
      const textBody = pushBody;
      const result = await sendNotify(cfgAlert, {
        title: signalNow ? '⚡ 比特皇：适合开单信号出现' : armedNow ? '🟠 比特皇：开单条件正在成形' : '比特皇监控基线',
        body: pushBody,
        text: textBody,
        summary: { total: signalNow ? 1 : 0, critical: signalNow ? 1 : 0, warn: armedNow ? 1 : 0, byFamily: {} },
      });
      if (result && result.ok) {
        logErr(`\n✔ 已推送 Telegram（通道 ${result.okCount ?? '?'} 条成功）`);
      } else if (result && !result.ok) {
        logErr(`\n⚠ 推送未成功：${JSON.stringify(result.errors || result)}`);
      } else {
        logErr('\n⚠ 未配置任何可用推送通道（在 .alerts/config.json 加入 telegram 通道即可）');
      }
    } catch (e) {
      logErr(`\n⚠ 推送异常：${e.message}`);
    }
  } else if (!NO_PUSH && !JSON_OUT) {
    logErr('（状态无变化，未推送；如需测试加 --force-push）');
  }

  // 退出码：SIGNAL 算「有信号」返回 0（成功），便于外部脚本感知
  process.exit(0);
}

main().catch((e) => {
  console.error('监控失败：', e?.stack || e?.message || e);
  process.exit(1);
});
