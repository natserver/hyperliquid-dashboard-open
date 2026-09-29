/**
 * 方向层的「输入装配」—— 拉三路 K 线与资金费、读事件表、组装 computeRegime 的 cfg。
 *
 * ── 为什么要单独抽出来 ────────────────────────────────────────────────
 *
 * 这段逻辑原本长在 `server.js` 里。现在多了一个消费者：每日定时采集任务
 * （`tools/macro-daily.js`）也要算一遍方向，好把「那天读到什么 → 判了什么方向」
 * 一起落进历史库。
 *
 * 如果两边各抄一份，最先漂的会是 cfg 透传那 30 行 —— 少透一个参数不会报错，
 * 只会让定时任务算出跟看板**不一样的方向**，而历史库里的记录看起来还挺正常。
 * 这种错没有任何测试会主动发现，只能靠「只有一份实现」来杜绝。
 *
 * 所以：装配输入这件事只在这里做，server.js 和采集任务都调它。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { info } from './hl.js';
import { barsOf, computeRegime } from './regime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 宏观方向层的事件表。手工维护，改完不需要重启服务（每次快照都重新读盘）。 */
export const MACRO_EVENTS_PATH = path.resolve(__dirname, '..', 'config', 'macro-events.json');

/**
 * 自动事件表 —— tools/events-daily.js 每天从免费公开接口抓出来写在这里。
 * 放 `.data/` 而不是 `config/`：`.data` 是 bind mount（容器重建不丢），
 * `config/` 是构建时 COPY 进镜像的，容器里写了下次重建就没了。
 */
export const AUTO_EVENTS_PATH = path.resolve(__dirname, '..', '.data', 'events-auto.json');

const EVENT_DAY = 86400000;
const eventDayMs = (s) => Date.parse(`${String(s).slice(0, 10)}T00:00:00Z`);

/** 手工表里已有同 kind 且日期差 ≤3 天的条目 → 自动那条是同一件事，丢掉。 */
function coveredByManual(auto, manual) {
  return manual.some(
    (m) =>
      m.kind === auto.kind &&
      Number.isFinite(eventDayMs(m.date)) &&
      Number.isFinite(eventDayMs(auto.date)) &&
      Math.abs(eventDayMs(m.date) - eventDayMs(auto.date)) <= 3 * EVENT_DAY,
  );
}

function readEventsFile(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      events: Array.isArray(j.events) ? j.events : [],
      shockWindowDays: j.shockWindowDays,
      shockCooldownDays: j.shockCooldownDays,
    };
  } catch {
    return { events: [], shockWindowDays: undefined, shockCooldownDays: undefined };
  }
}

/**
 * 读事件表。任何异常都降级为「没有事件」，**不打 warning** ——
 * 事件层只是修正项，缺了它方向层照常工作（减半时钟 + 结构层仍在），
 * 把它报成故障会让用户误以为整个方向层坏了。
 *
 * 默认读手工表，并**合并** `.data/events-auto.json` 里每日自动抓来的事件。
 * 合并只有一条规则：**手工永远优先** —— 同 kind 且日期差 ≤3 天时丢掉自动那条，
 * 否则同一次减半会在界面日程里出现两次（手工写 2028-04-15、块高算出 2028-04-13）。
 * 顶层的 shockWindowDays / shockCooldownDays 也只认手工表的，
 * 自动表没有这两项的定义权。
 *
 * 传了自定义 `file`（测试与工具会这么做）就只读那个文件、**不合并** ——
 * 调用方指定了数据源，不该再悄悄掺进 `.data` 的东西。
 */
export function loadMacroEvents(file = MACRO_EVENTS_PATH) {
  const base = readEventsFile(file);
  if (file !== MACRO_EVENTS_PATH) return base;

  const auto = readEventsFile(AUTO_EVENTS_PATH).events;
  if (!auto.length) return base;

  const merged = [...base.events, ...auto.filter((e) => !coveredByManual(e, base.events))];
  return { ...base, events: merged };
}

/** 日线要覆盖两个减半周期（约 4 年≈1460 天），留到 2300 天给 200 周均线预热 */
const DAILY_LOOKBACK_DAYS = 2300;
const WEEKLY_LOOKBACK_DAYS = 2900;
const FUNDING_LOOKBACK_DAYS = 120;

/**
 * 拉方向层所需的三路 K 线与资金费历史。
 *
 * TTL 都是「变化很慢」的量级（30~60 分钟），所以上层无论怎么轮询，
 * 这里都不会对 Hyperliquid 造成压力。
 *
 * @param {string} net         网络 key（'mainnet' | 'testnet'）
 * @param {object} [opts]
 * @param {number} [opts.nowMs]
 * @returns {Promise<{daily:Array, weekly:Array, monthly:Array, fundingSeries:Array}>}
 */
export async function fetchRegimeInputs(net, { nowMs = Date.now() } = {}) {
  const [dRaw, wRaw, mRaw, fRaw] = await Promise.all([
    info(net, { type: 'candleSnapshot', req: { coin: 'BTC', interval: '1d', startTime: nowMs - DAILY_LOOKBACK_DAYS * 86400000, endTime: nowMs } }, { ttl: 30 * 60 * 1000 }),
    info(net, { type: 'candleSnapshot', req: { coin: 'BTC', interval: '1w', startTime: nowMs - WEEKLY_LOOKBACK_DAYS * 86400000, endTime: nowMs } }, { ttl: 60 * 60 * 1000 }),
    info(net, { type: 'candleSnapshot', req: { coin: 'BTC', interval: '1M', startTime: nowMs - WEEKLY_LOOKBACK_DAYS * 86400000, endTime: nowMs } }, { ttl: 60 * 60 * 1000 }),
    // A5 情绪拥挤度用：BTC 的资金费历史。
    // 这是**公开**接口（不需要 user 参数），而且有历史、可回测 ——
    // 比拿当时的「多空持仓比」当代理靠谱得多，后者要么收费要么只有当前快照。
    // 拉 120 天是为了让 90 期的分位窗口在早期也有足够样本。
    info(net, { type: 'fundingHistory', coin: 'BTC', startTime: nowMs - FUNDING_LOOKBACK_DAYS * 86400000 }, { ttl: 15 * 60 * 1000 }),
  ]);

  // fundingHistory → [{t, rate}]。字段名是 fundingRate（有的接口回 rate），两个都吃。
  const fundingSeries = (fRaw || [])
    .map((r) => ({ t: Number(r?.time), rate: Number(r?.fundingRate ?? r?.rate) }))
    .filter((x) => Number.isFinite(x.t) && Number.isFinite(x.rate));

  return {
    daily: barsOf(dRaw),
    weekly: barsOf(wRaw),
    monthly: barsOf(mRaw),
    fundingSeries,
  };
}

/** BTC 最新日线收盘价 —— 判据 `etf-netflow` 需要它做「突破 10.3 万」那一半条件 */
export function lastClose(daily) {
  return Array.isArray(daily) && daily.length ? daily[daily.length - 1].c : null;
}

/**
 * 把策略配置 + 事件表组装成 computeRegime 需要的 cfg。
 *
 * 注意 `events` 只用来取 shock 相关的两个窗口参数（shockWindowDays /
 * shockCooldownDays 存在事件表里而不是策略配置里，因为它描述的是事件层的语义）。
 */
export function regimeConfig(cfg, events = {}) {
  return {
    confirmDays: cfg.regimeConfirmDays,
    minHoldDays: cfg.regimeMinHoldDays,
    shockWindowDays: events.shockWindowDays ?? cfg.shockWindowDays,
    // cooldown 只影响 shock.cooldownUntil 的展示值（压制窗口用 shockWindowDays），
    // 但它被写进了配置文件，就必须真的生效 —— 配置里写了不生效是更坏的情况。
    shockCooldownDays: events.shockCooldownDays ?? cfg.shockCooldownDays,
    // A4~A7 比特皇判据层的参数，全部从 cfg 透传
    chaseMaxExtensionPct: cfg.chaseMaxExtensionPct,
    ma120Window: cfg.ma120Window,
    bearDrawdownPct: cfg.bearDrawdownPct,
    bearStaleMonths: cfg.bearStaleMonths,
    bearGateMonths: cfg.bearGateMonths,
    fundingLookback: cfg.fundingLookback,
    fundingExtremePercentile: cfg.fundingExtremePercentile,
    sentimentHoldBars: cfg.sentimentHoldBars,
    volumeLookback: cfg.volumeLookback,
    volumeLegBars: cfg.volumeLegBars,
    volumeSpikePercentile: cfg.volumeSpikePercentile,
    volumeDryRatio: cfg.volumeDryRatio,
    legFlatPct: cfg.legFlatPct,
    reactionMinWeight: cfg.reactionMinWeight,
    reactionDays: cfg.reactionDays,
    reactionFlatPct: cfg.reactionFlatPct,
    reactionMaxItems: cfg.reactionMaxItems,
    reversalMinVotes: cfg.reversalMinVotes,
  };
}

/**
 * 算方向。inputs 从 fetchRegimeInputs 来，events 从 loadMacroEvents 来。
 */
export function buildRegime({ inputs, cfg, events = {}, macro = [], nowMs = Date.now() }) {
  return computeRegime({
    daily: inputs.daily,
    weekly: inputs.weekly,
    monthly: inputs.monthly,
    events: events.events || [],
    fundingSeries: inputs.fundingSeries,
    macro,
    nowMs,
    cfg: regimeConfig(cfg, events),
  });
}
