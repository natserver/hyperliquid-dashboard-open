/**
 * 比特皇 · Hyperliquid 只读看板 —— 服务端
 *
 * 零依赖：只用 Node 内置模块（http / fs / path / url）与内置 fetch。
 * 不引入任何 npm 包 —— 这个服务会经手你的账户地址，依赖越少越安全。
 *
 *   node server.js             默认 http://127.0.0.1:8787
 *   node server.js --port 9000
 *   node server.js --host 0.0.0.0   对外监听（Docker / 局域网部署时用）
 *
 * 安全边界（重要）：
 *   * 默认只监听 127.0.0.1，局域网内其他机器访问不到 —— 要对外必须显式指定 --host；
 *   * 全站只做只读查询，代码里没有任何签名/下单路径，也不接收任何私钥或助记词；
 *   * 只读数据的读取权限来自 Hyperliquid 本身的公开性，不是本服务授予的。
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  NETWORKS,
  allMids,
  cacheStats,
  clearinghouseState,
  clearCache,
  fetchFills,
  fetchFillsRange,
  frontendOpenOrders,
  getNetwork,
  indexMarket,
  info,
  isValidAddress,
  metaAndAssetCtxs,
  normalizeAddress,
  portfolio,
  recentFills,
  userFees,
  userFunding,
  userNonFundingLedgerUpdates,
  userRole,
} from './src/hl.js';

import { computeLevels, parsePosition } from './src/levels.js';
import {
  buildTrades,
  extractEquityCurve,
  netDeposits,
  summarizePerformance,
} from './src/metrics.js';
import {
  CYCLE_PHASES,
  PHASE_AUTO,
  PHASE_LABELS,
  defaultConfig,
  defaultTiers,
  fmtPrice,
  fmtUsd,
  parseWad,
  phaseFloorBps,
  validateParams,
} from './src/strategy.js';

/* 系统一：宏观方向层。与系统二（src/strategy.js 的 analyzeSetup/gate）严格分工 ——
 * 它只回答「只许往哪个方向开新仓」，不输出任何价格。 */
import { derivePhase, halvingClock } from './src/regime.js';
// 判据注册表是**静态**数据（出处 + 原话 + 落实方式），不随轮询变化。
// 所以它走独立接口一次性拉取，而不是塞进 /api/snapshot —— 后者每几秒一次，
// 把 6KB 的常量反复搬进快照纯属浪费。
import { DIRECTION_CRITERIA, criteriaByLayer } from './src/regime-criteria.js';
// 三阶段编排：把「基本面 → 技术面 → 持仓管理」的交接契约显式化，
// 并给出唯一的关键结论「现在卡在哪一段」。
import { runPipeline } from './src/pipeline.js';
import { collectMacroSources, degradedMacro, evaluateMacroCriteria, MACRO_SOURCES } from './src/macro-sources.js';
// 方向层的输入装配（三路 K 线 + 资金费 + cfg 透传）与每日采集任务共用同一份实现，
// 避免出现「看板算出的方向和落库的历史不是一回事」。
import { buildRegime, fetchRegimeInputs, lastClose, loadMacroEvents } from './src/regime-inputs.js';
// 宏观读数的历史库（SQLite，Node<22.5 自动降级 JSONL）
import { macroHistory, openMacroStore, recordMacro, storeSummary } from './src/macro-store.js';

import { resolveConfig, summarizeFundingHistory } from './src/alerts.js';
import { inspectChannels, sendNotify } from './src/notify.js';
import {
  configExists,
  loadAlertConfig,
  loadHeartbeat,
  loadState,
  readHistory,
} from './src/alertstore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || argValue('--port') || 8787);
/**
 * 默认只监听本地回环 —— 在本机跑时，不该顺手把看板暴露到局域网。
 * 要对外（Docker / 局域网）必须**显式**给 HOST 或 --host，由部署脚本负责设置；
 * 没给就退回 127.0.0.1，不会因为换了个运行环境就悄悄开洞。
 */
const HOST = process.env.HOST || argValue('--host') || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const SRC_DIR = path.join(__dirname, 'src');

const CHART_BARS = 200; // 4H × 200 ≈ 33 天，够画图也够算 48 根回看的趋势
const MAX_LEVEL_COINS = 6; // 最多给 6 个持仓算策略读数，避免请求数失去控制

/* ─────────────────── M1~M6 宏观数据源的采集与缓存 ─────────────────── */

/**
 * 为什么要在服务端做一层独立缓存（而不是每次快照都去拉）：
 *
 * 这六个源里最慢的（Farside 经 r.jina.ai）单次要 8~12 秒，而快照接口
 * 被前端每 5 秒轮询一次。不缓存的话，一次页面停留就会对外发起上百次请求 ——
 * 既慢，也是对别人免费服务的滥用。而这些数据的更新频率本来就是
 * 「每天一次」（ETF 收盘后、FRI 利率、日度链上），轮询到分钟级毫无意义。
 *
 * 缓存 TTL 取各源声明的最小值（ETF 30 分钟最紧），到点后**在后台刷新**：
 * 请求仍立刻返回旧值并标记 `refreshing:true`，避免用户等 10 秒白屏。
 */
const MACRO_CACHE_MS = 30 * 60 * 1000;

/* 降级演练开关：`--macro-offline` 让六个宏观源这一步**整体失败**。
 *
 * 为什么做成正式开关而不是测试后门：六个免费源哪天集体抽风时，这是复现
 * 那个场景的唯一办法 —— 否则只能等它真的发生，而那天恰好是最不该现场改
 * 代码的时候。它同时是「宏观源失败不该连坐方向层」这条不变式的验收手段。
 * 默认不传，行为与从前完全一致（不设环境变量、不改缓存状态）。 */
const MACRO_OFFLINE = !!argValue('--macro-offline') || process.env.MACRO_OFFLINE === '1';

let macroCache = { at: 0, data: null, inflight: null };

async function getMacroSources({ force = false } = {}) {
  if (MACRO_OFFLINE) throw new Error('演练：--macro-offline 把六个宏观源整体置为不可用');
  const now = Date.now();
  const fresh = macroCache.data && now - macroCache.at < MACRO_CACHE_MS;
  if (fresh && !force) return { ...macroCache.data, cached: true };

  // 已有在途请求 → 复用它，不要并发拉同一批源
  if (macroCache.inflight) return { ...(macroCache.data || {}), inflight: true };

  macroCache.inflight = (async () => {
    try {
      const data = await collectMacroSources({ now: Date.now(), cache: macroCache.data });
      macroCache = { at: Date.now(), data, inflight: null };
      return data;
    } catch (e) {
      macroCache.inflight = null;
      throw e;
    }
  })();

  try {
    const data = await macroCache.inflight;
    return { ...data, cached: false };
  } catch (e) {
    // 采集整体失败 → 回落到上一次的成功结果；再没有就返回空壳
    if (macroCache.data) return { ...macroCache.data, cached: true, degraded: String(e.message || e) };
    return { fetchedAt: new Date().toISOString(), errors: [`采集失败：${e.message}`], sources: {}, byCriterion: {} };
  }
}

/* ─────────────────── 宏观历史库（SQLite / JSONL 降级） ─────────────────── */

/**
 * 历史库懒打开，且只尝试一次。
 *
 * 为什么不放在模块顶层直接打开：`.data/` 可能是只读盘、SQLite 可能不可用、
 * 磁盘可能满 —— 这些都不该阻止看板启动。打开失败就退化成「没有历史」，
 * 界面少一块趋势图，但方向、策略、预警全部照常。
 */
let macroStoreCache;
let macroStoreTried = false;
function getMacroStore() {
  if (!macroStoreTried) {
    macroStoreTried = true;
    try {
      macroStoreCache = openMacroStore();
    } catch {
      macroStoreCache = null;
    }
  }
  return macroStoreCache || null;
}

/**
 * 允许前端 import 的共享模块白名单。
 *
 * 为什么要有白名单：前端需要 /src/strategy.js 等做交互式重算，所以 /src/ 必须开放；
 * 但 src/hl.js 是服务端数据客户端（含出站请求与缓存逻辑），属于服务端实现细节，
 * 没有理由暴露给浏览器。按白名单逐个放行，比整个目录敞开安全。
 */
const SHARED_MODULES = new Set(['strategy.js', 'levels.js', 'metrics.js', 'alerts.js', 'regime.js', 'macro-sources.js']);

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/* ───────────────────────── HTTP 小工具 ───────────────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj, bigintReplacer);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** JSON 里不能有 bigint，统一转成字符串（前端自己决定怎么格式化） */
function bigintReplacer(_k, v) {
  return typeof v === 'bigint' ? v.toString() : v;
}

async function readJsonBody(req, limitBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limitBytes) throw new Error('请求体过大');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function serveStatic(res, baseDir, rel) {
  // 路径穿越防护：解析后必须仍在 baseDir 之内
  const target = path.resolve(baseDir, '.' + path.posix.normalize('/' + rel));
  if (!target.startsWith(baseDir)) {
    res.writeHead(403).end('Forbidden');
    return true;
  }
  try {
    const stat = await fsp.stat(target);
    if (!stat.isFile()) return false;
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'no-cache',
    });
    fs.createReadStream(target).pipe(res);
    return true;
  } catch {
    return false;
  }
}

/* ───────────────────────── 看板聚合 ───────────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clampSeries(series, maxPoints) {
  if (!series || series.length <= maxPoints) return series;
  const step = series.length / maxPoints;
  const out = [];
  for (let i = 0; i < maxPoints; i++) out.push(series[Math.floor(i * step)]);
  const last = series[series.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/** 精简 K 线字段，压掉 payload 体积 */
const slim = (c) => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v });

/**
 * 构建一次完整的看板数据。
 * 设计为「部分失败不影响整体」：任一块拉取失败只记一条 warning，
 * 其余面板照常渲染 —— 交易所偶发抽风时不应该整个页面空白。
 */
async function buildSnapshot({ network, user, coin, phase }) {
  const net = getNetwork(network);
  const addr = normalizeAddress(user);
  const warnings = [];
  const timings = {};

  const time = async (label, fn, fallback) => {
    const t0 = Date.now();
    try {
      const v = await fn();
      timings[label] = Date.now() - t0;
      return v;
    } catch (e) {
      timings[label] = Date.now() - t0;
      warnings.push(`${label} 拉取失败：${e.message}`);
      return fallback;
    }
  };

  // 第一波：账户状态 + 行情 + 权益曲线 + 持仓（彼此独立，并发拉）
  const [state, marketRaw, pf, mids] = await Promise.all([
    time('clearinghouseState', () => clearinghouseState(net.key, addr), null),
    time('metaAndAssetCtxs', () => metaAndAssetCtxs(net.key), null),
    time('portfolio', () => portfolio(net.key, addr), null),
    time('allMids', () => allMids(net.key), {}),
  ]);

  if (!state) {
    return {
      ok: false,
      network: net.key,
      user: addr,
      warnings,
      error:
        '无法读取账户状态。请确认：① 地址是主账户地址（不是 API Wallet 地址）；' +
        '② 网络选对了（主网/测试网）；③ 该地址确实在 Hyperliquid 上开过账户。',
      timings,
    };
  }

  // 第二波：成交、挂单、资金费、出入金
  const [fills, orders, funding, ledger, fees, role] = await Promise.all([
    // 面板要的是「最近成交」→ 走 userFills（原生语义就是最新 2000 笔）。
    // ⚠️ 早先这里用 fetchFills + startTime:0，而 userFillsByTime 返回的是区间内**最早**的
    //    2000 笔，所以面板实际展示的是账户最旧的成交。这是实测发现的真实缺陷。
    time('userFills', () => recentFills(net.key, addr), []),
    time('openOrders', () => frontendOpenOrders(net.key, addr), []),
    time('userFunding', () => userFunding(net.key, addr), []),
    time('ledger', () => userNonFundingLedgerUpdates(net.key, addr), []),
    time('userFees', () => userFees(net.key, addr), null),
    time('userRole', () => userRole(net.key, addr), null),
  ]);

  const market = marketRaw ? indexMarket(marketRaw[0], marketRaw) : new Map();

  // 持仓解析
  const positions = (state.assetPositions || [])
    .map(parsePosition)
    .filter(Boolean)
    .sort((a, b) => Number(b.positionValue - a.positionValue));

  const equityWad = parseWad(state.marginSummary?.accountValue ?? 0);

  /* ── 相位解析 —— 必须在构建 cfg **之前**做 ──────────────────────
   * PHASE_AUTO（以及任何未知值）在这里就被解析成具体相位。
   * 绝不能让 'AUTO' 流进 phaseFloorBps —— 那里非四相位值会静默落到 DECLINE 档，
   * 眼下巧合正确，等哪天门槛表调整就会无声变错。
   *
   * 时间戳也一并提到这里：方向层的「距上次减半几个月」和门槛用的是
   * 同一个 `nowMs`，否则跨零点采样时两处会差一天。
   */
  const nowMs = Date.now();
  const phaseResolved = derivePhase(nowMs, phase);
  const effectivePhase = phaseResolved.phase;

  // 策略配置
  const cfg = defaultConfig(effectivePhase);
  if (phaseResolved.unknown) warnings.push(`未知相位 ${phase}，已改用减半时钟推算的 ${effectivePhase}`);
  cfg.cyclePhase = effectivePhase;
  cfg.risk.minExpectedMoveBps = Math.max(phaseFloorBps(cfg.cyclePhase), 1800);
  try {
    validateParams(cfg.risk, cfg.cyclePhase);
  } catch (e) {
    warnings.push(`配置校验：${e.message}`);
  }
  const tiers = defaultTiers();

  /* ─────────────── 系统一：宏观方向层 ───────────────
   * 始终以 BTC 为标的 —— 减半周期是 BTC 独有的宏观锚，山寨币没有自己的减半节奏。
   * 对山寨币而言，BTC 的宏观方向充当「整体风险偏好」的闸门，这正是我们要的效果。
   *
   * 三路 K 线变化很慢，给长缓存；事件表每次读盘（很小的 JSON），
   * 这样用户改完事件不用重启服务。
   */
  let regime = null;
  let phaseCheck = null;
  // M1~M6 采集结果。必须在 try 之外声明 —— 返回值在 try 块外组装，
  // 块内声明的 const 到这里已经出作用域（实测报 "macroPanel is not defined"）。
  let macroPanel = null;

  /* ── 三段各自容错，不让「宏观源抖动」连坐整个方向层 ────────────────
   * 早期版本把这几步包在**同一个** try 里，任何一步抛都让 regime 变成 null ——
   * 连确定性最强的减半时钟和结构层读数一起消失。实测真的发生过：六个免费源
   * 里有一个抖动，整个方向层面板变空，界面上看起来像"系统坏了"。
   *
   * 这三段的失败后果本来就不同，不该捆在一起：
   *   ① 行情输入失败 → 方向层确实算不出来（结构层要靠 K 线）
   *   ② M1~M6 失败   → 只降级宏观面板；方向层照常算，并把六条如实标为「弃权」
   *   ③ 历史落库失败 → 只影响历史，recordMacro 内部已吞异常
   */

  // ① 行情输入（三路 K 线 + 资金费）—— 与宏观源无关，它自己一段
  let inputs = null;
  try {
    inputs = await fetchRegimeInputs(net.key, { nowMs });
  } catch (e) {
    warnings.push(`方向层行情输入获取失败（方向未定，不出开单计划）：${e.message}`);
  }

  if (inputs) {
    const macro = loadMacroEvents();

    // 行情价格取 BTC 最新日线收盘 —— 判据 `etf-netflow` 需要它做
    // 「价格突破 10.3 万」那一半条件。这里不依赖 levels（还没算出来），
    // 直接用已经拉到的日线，避免引入顺序耦合。
    const spotPrice = lastClose(inputs.daily);

    /* 判据参数只读一次，正常路径与降级路径共用同一份 ——
     * 同一份配置抄两遍正是「两边慢慢漂开」的经典来源。 */
    const macroCfg = {
      etfFlowThresholdUsd: cfg.etfFlowThresholdUsd,
      etfPriceTrigger: cfg.etfPriceTrigger,
      fngGreedThreshold: cfg.fngGreedThreshold,
      fngFearThreshold: cfg.fngFearThreshold,
      onchainWowPct: cfg.onchainWowPct,
      dxyThreshold: cfg.dxyThreshold,
      institutionalTargetPct: cfg.institutionalTargetPct,
      regulatoryNegativesTrigger: cfg.regulatoryNegativesTrigger,
      regulatoryWindowDays: cfg.regulatoryWindowDays,
    };

    // ② M1~M6 宏观读数 —— 失败只降级面板
    let macroSrc = null;
    let macroReadings = null;
    try {
      macroSrc = await getMacroSources();
      macroReadings = evaluateMacroCriteria(macroSrc, { price: spotPrice, config: macroCfg });
    } catch (e) {
      /*
       * 降级：**复用同一条求值代码**（`degradedMacro` 内部就是喂空源后调
       * `evaluateMacroCriteria`），所以降级形状永远与正常形状同构。
       *
       * 为什么不干脆给方向层传空数组：那样 M1~M6 会从证据链里整体消失，
       * 方向层只会说「5 条弃权」-- 读的人无从知道宏观那两条本该在场。
       * 喂空源则照样产出六条（每条 reason 写明「取不到」），方向层据此把
       * M1~M6 一并标为弃权，界面上看得见「这次少了什么」。
       */
      warnings.push(`宏观读数（M1~M6）采集失败，面板降级为「不可用」；方向层照常计算并把这六条标为弃权：${e.message}`);
      ({ src: macroSrc, readings: macroReadings } = degradedMacro({
        price: spotPrice,
        config: macroCfg,
        reason: e.message,
      }));
    }

    /*
     * ⚠ 这里必须把「读数数组」和「来源元信息」分开装。
     * 早期版本图省事，直接把 sources/errors 挂在读数数组上（`arr.sources = …`），
     * 看起来能读到 —— 但 `JSON.stringify` 对数组**只序列化下标元素**，
     * 自定义属性会被静默丢弃。于是接口返回的 `macro.sources` 永远是 undefined，
     * 而服务端自己 log 出来却是好好的。这种 bug 在单元测试里也测不出来
     * （测试直接调函数、不走 JSON），只有真的看一眼 HTTP 响应才会发现。
     */
    macroPanel = {
      readings: macroReadings,
      sources: macroSrc.sources || {},
      byCriterion: macroSrc.byCriterion || {},
      errors: macroSrc.errors || [],
      fetchedAt: macroSrc.fetchedAt,
      cached: !!macroSrc.cached,
      spotPrice,
      catalog: MACRO_SOURCES,
      /* 降级必须显形 —— 六个源全取不到时给明确标记，界面据此提示。
       * 少了它，一次源抖动在界面上与「市场确实平静」无法区分：
       * 两种情况都是六条 vote=0，但一个可信、一个不可信。 */
      degraded:
        macroSrc.degraded || (macroReadings.every((r) => !r.available) ? '六个数据源本次全部取不到' : null),
    };

    // ③ 方向层 —— 自己一段，失败只丢方向，不连坐上面已经拿到的宏观面板
    try {
      // 装配 + 计算都在 src/regime-inputs.js 里（与每日采集任务共用）
      regime = buildRegime({ inputs, cfg, events: macro, macro: macroReadings, nowMs });
    } catch (e) {
      warnings.push(`方向层计算失败（方向未定，不出开单计划）：${e.message}`);
    }

    /* ── 落库 ──────────────────────────────────────────────────────
     * 把这一刻的六条读数写进历史库（按天 upsert，同一天重复刷新只覆盖不追加）。
     *
     * 为什么要在「看快照」时也写：定时任务一天只跑一次，但看板可能一整天都开着。
     * 两条路都写才能保证「只要有人看过，这天就有记录」。
     *
     * 方向层失败也照样写 —— 六条读数本身有历史价值，那几个结论字段允许为空
     * （库里读到 bias=null 就是「那天读数在、但方向没算出来」，是事实）。
     * 落库失败**绝不影响快照**：历史是辅助，看板是主功能。recordMacro 内部
     * 已经吞掉异常并返回 null，这里只在成功时挂个标记。
     */
    const stored = recordMacro(getMacroStore(), macroPanel, {
      now: nowMs,
      bias: regime?.bias ?? null,
      biasLabel: regime?.biasLabel ?? null,
      confidence: regime?.confidence ?? null,
    });
    if (stored) macroPanel.stored = stored;
  }

  /* 相位对账 —— 结果在函数开头就为了构建 cfg 而算好了（cfg 依赖它），
   * 这里只负责**告警**与透出。它不依赖上面任何一步，所以放在容错块外面：
   * 数据源挂了不该连带相位告警一起消失。
   * 自动模式下不产生 warning：那是现在的正常状态，不是异常；
   * 把它当告警会让 warnings 失去信噪比。 */
  phaseCheck = phaseResolved;
  if (phaseCheck.stale) warnings.push(`周期相位对账：${phaseCheck.detail}`);

  // 决定要算策略读数的标的：主图标的 + 名义价值最大的几个持仓
  const focusCoin = coin || 'BTC';
  const levelCoins = [focusCoin, ...positions.map((p) => p.coin)];
  const uniqCoins = [...new Set(levelCoins)].slice(0, MAX_LEVEL_COINS);
  if (levelCoins.length > uniqCoins.length) {
    warnings.push(`持仓标的超过 ${MAX_LEVEL_COINS} 个，仅对名义价值最大的部分计算策略读数`);
  }

  // 第三波：K 线（并发拉，之后统一算读数）
  const candleMap = {};
  const candleErrors = {};
  await Promise.all(
    uniqCoins.map(async (c) => {
      try {
        const raw = await info(
          net.key,
          {
            type: 'candleSnapshot',
            req: { coin: c, interval: '4h', startTime: Date.now() - CHART_BARS * 4 * 3600 * 1000, endTime: Date.now() },
          },
          { ttl: 20 * 1000 }
        );
        if (Array.isArray(raw) && raw.length) candleMap[c] = raw.slice(-CHART_BARS).map(slim);
      } catch (e) {
        candleErrors[c] = e.message;
        warnings.push(`${c} 的 K 线拉取失败：${e.message}`);
      }
    })
  );

  // 第三波补：资金费历史 —— 用来建立**该标的自己的基准**。
  //
  // 为什么必须要有基准：资金费告警如果只用一个绝对阈值，对 BTC 和对某个
  // 小币种要么太松要么太紧（两者「正常水位」差一个数量级）。有了基准才能判「异常」。
  //
  // 只统计成摘要再返回：原始历史 30 天有上千行，塞进每 20 秒轮询一次的快照
  // 会让 payload 直接爆掉。取不到时静默降级（退化为绝对阈值），不打 warning ——
  // 这不是数据故障，只是判定精度下降。
  const fundingBaseline = {};
  await Promise.all(
    uniqCoins.map(async (c) => {
      try {
        const rows = await info(
          net.key,
          { type: 'fundingHistory', coin: c, startTime: Date.now() - 30 * 86400000 },
          { ttl: 10 * 60 * 1000 }
        );
        const s = summarizeFundingHistory(rows);
        if (s) fundingBaseline[c] = s;
      } catch {
        /* 静默降级 */
      }
    })
  );

  // 策略读数
  const levels = {};
  for (const c of uniqCoins) {
    const candles = candleMap[c];
    if (!candles || candles.length < 25) continue;
    const pos = positions.find((p) => p.coin === c) || null;
    const midStr = mids?.[c];
    const ctxMark = market.get(c)?.ctx?.markPx;
    const markWad = midStr ? parseWad(midStr) : ctxMark ? parseWad(ctxMark) : parseWad(candles[candles.length - 1].c);
    try {
      levels[c] = computeLevels({ coin: c, candles, markWad, position: pos, equityWad, config: cfg, tiers, regime });
    } catch (e) {
      warnings.push(`${c} 的策略读数计算失败：${e.message}`);
    }
  }

  /* 三阶段编排 —— 用「焦点标的」的读数组装。
   *
   * 为什么只给焦点标的：三阶段结论是**账户级**的一句话（"现在卡在哪一段"），
   * 不是一个可以按标的各来一份的东西 —— 那样界面会变成 N 张互相矛盾的结论卡。
   * 焦点标的默认 BTC，也就是比特皇唯一做的那个币。
   * 没有焦点标的读数时给 null，前端会明确显示「未计算」，而不是拿别的标的顶上。 */
  const pipeline = levels[focusCoin] ? runPipeline({ regime, levels: levels[focusCoin], cfg }) : null;

  // 绩效
  const trades = buildTrades(fills);
  const summary = summarizePerformance({    fills,
    funding: funding.map((f) => f.delta).filter(Boolean),
    trades,
  });
  const curve = extractEquityCurve(pf, 'perpAllTime');
  // 注意：userNonFundingLedgerUpdates 的元素是 { time, hash, delta }，
  // 而 time 在外层包装上、不在 delta 里。只传 delta 会把时间丢掉。
  // 这里把 time 拍平进去，出入金流水才带得上时间戳。
  const deposits = netDeposits(
    ledger.map((l) => (l.delta ? { ...l.delta, time: l.time } : null)).filter(Boolean)
  );

  if (summary.cycles && summary.cycles.reliable === false && summary.cycles.note) {
    warnings.push(`绩效口径提醒：${summary.cycles.note}`);
  }
  if (curve?.primary?.maxDrawdown?.includesTransfers) {
    warnings.push(`回撤口径提醒：${curve.primary.maxDrawdown.caveat}`);
  }

  const marginSum = state.marginSummary || {};
  const accountValue = parsePad(marginSum.accountValue);
  const withdrawable = parsePad(state.withdrawable);
  const marginUsed = parsePad(marginSum.totalMarginUsed);

  return {
    ok: true,
    network: net.key,
    networkLabel: net.label,
    user: addr,
    fetchedAt: Date.now(),
    timings,
    warnings,

    account: {
      accountValue,
      withdrawable,
      marginUsed,
      totalNotional: parsePad(marginSum.totalNtlPos),
      maintenanceMargin: parsePad(state.crossMaintenanceMarginUsed),
      marginRatio: accountValue > 0n ? Number((marginUsed * 10000n) / accountValue) / 10000 : 0,
      crossAccountValue: parsePad(state.crossMarginSummary?.accountValue),
      updatedAt: state.time,
      role: role?.role || null,
      feeRates: fees
        ? {
            cross: fees.userCrossRate,
            add: fees.userAddRate,
            referralDiscount: fees.activeReferralDiscount,
            stakingDiscount: fees.activeStakingDiscount?.discount ?? null,
          }
        : null,
      // dailyUserVlm 里 exchange 字段是整个交易所的量，不是用户的；
      // 用户自己的量要把 userCross + userAdd 逐日相加。
      userVlm14d: fees?.dailyUserVlm?.length
        ? fees.dailyUserVlm.reduce(
            (a, d) => a + Number(d.userCross || 0) + Number(d.userAdd || 0),
            0
          )
        : null,
    },

    equityCurve: curve?.primary
      ? {
          period: curve.primary.period,
          maxDrawdown: curve.primary.maxDrawdown,
          volume: curve.primary.volume,
          equity: clampSeries(curve.primary.equity, 400),
          pnl: clampSeries(curve.primary.pnl, 400),
          available: Object.keys(curve.byPeriod),
        }
      : null,
    equityCurvesByPeriod: curve
      ? Object.fromEntries(
          Object.entries(curve.byPeriod).map(([k, v]) => [
            k,
            { equity: clampSeries(v.equity, 400), pnl: clampSeries(v.pnl, 400) },
          ])
        )
      : {},

    positions: positions.map((p) => ({
      coin: p.coin,
      qty: p.qty,
      szi: p.szi,
      isLong: p.isLong,
      entryPx: p.entryPx,
      positionValue: p.positionValue,
      unrealizedPnl: p.unrealizedPnl,
      returnOnEquity: p.returnOnEquity,
      liquidationPx: p.liquidationPx,
      marginUsed: p.marginUsed,
      leverage: p.leverage,
      maxLeverage: p.maxLeverage,
      marginMode: p.marginMode,
      cumFunding: p.cumFunding,
      markPx: mids?.[p.coin] ? parsePad(mids[p.coin]) : null,
      levels: levels[p.coin] || null,
    })),

    orders: (orders || []).map((o) => ({
      coin: o.coin,
      side: o.side,
      limitPx: parsePad(o.limitPx),
      sz: parsePad(o.sz),
      origSz: parsePad(o.origSz),
      oid: o.oid,
      timestamp: o.timestamp,
      isTrigger: o.isTrigger,
      triggerPx: parsePad(o.triggerPx),
      triggerCondition: o.triggerCondition,
      reduceOnly: o.reduceOnly,
      isPositionTpsl: o.isPositionTpsl,
      orderType: o.orderType,
      tif: o.tif,
    })),

    trades: trades.slice(-60).reverse().map((t) => ({
      coin: t.coin,
      isLong: t.isLong,
      openTime: t.openTime ?? null,
      // 未平仓的交易没有平仓时间。显式给 null 而不是省略字段 ——
      // 省略会让 JSON 里整个键消失，消费方无法区分「没有值」和「字段名写错」。
      closeTime: t.closeTime ?? null,
      vwapEntry: t.vwapEntry ?? null,
      peakQty: t.peakQty ?? null,
      grossPnl: t.grossPnl ?? 0n,
      netPnl: t.netPnl ?? 0n,
      fees: t.fees ?? 0n,
      win: t.win ?? null,
      stillOpen: Boolean(t.stillOpen),
      fillCount: t.fillCount,
    })),
    summary,

    funding: (funding || []).slice(-200).reverse().map((f) => ({
      time: f.time,
      coin: f.delta?.coin,
      usdc: parsePad(f.delta?.usdc ?? 0),
      szi: parsePad(f.delta?.szi ?? 0),
      fundingRate: f.delta?.fundingRate ?? null,
      nSamples: f.delta?.nSamples ?? null,
    })),

    deposits: {
      deposit: deposits.deposit,
      withdraw: deposits.withdraw,
      net: deposits.net,
      detail: deposits.detail.slice(-60).reverse().map((d) => ({
        type: d.type,
        usdc: d.usdc,
        time: d.time,
      })),
    },

    markets: Object.fromEntries(
      [...market.entries()]
        .filter(([name]) => ['BTC', 'ETH', 'SOL', 'HYPE'].includes(name) || positions.some((p) => p.coin === name))
        .map(([name, m]) => [
          name,
          {
            markPx: m.ctx?.markPx ?? null,
            oraclePx: m.ctx?.oraclePx ?? null,
            funding: m.ctx?.funding ?? null,
            openInterest: m.ctx?.openInterest ?? null,
            dayNtlVlm: m.ctx?.dayNtlVlm ?? null,
            prevDayPx: m.ctx?.prevDayPx ?? null,
            maxLeverage: m.maxLeverage,
            szDecimals: m.szDecimals,
            index: m.index,
          },
        ])
    ),

    candles: candleMap,
    candleErrors,
    /** 按标的的资金费基准（30 天 |小时费率| 的统计摘要），供预警的「异常」判定使用 */
    fundingBaseline,

    // 按标的索引的策略读数。单独给一份是因为「焦点标的」可能并没有持仓，
    // 此时它的读数（含开单计划）挂不到任何 position 下面。
    levelsByCoin: levels,
    levelCoins: uniqCoins,
    focusCoin,

    /**
     * 系统一 · 宏观方向层读数。会原样送到前端 —— 它是「现在只允许往哪边开新仓」
     * 的唯一来源。里面**没有**任何价格字段，这是刻意的：方向层不许沾染入场点。
     */
    regime,
    /** 手填相位与减半时钟推算相位的对账结果（含 stale 标记） */
    phaseCheck,

    /**
     * M1~M6 宏观与基本面读数（自动采集，非手工维护）。
     *
     * 每个读数都带 provider / url / asOf / status / vote —— 谁的数据、
     * 什么时候的、署什么许可，界面上必须看得见。
     * status 三态：ok（新鲜）/ stale（可用但过期）/ unavailable（彻底失败）。
     */
    macro: macroPanel,

    /**
     * M1~M6 的历史序列（默认近 30 天）+ 历史库自身的状态。
     *
     * 为什么要有这个：单点快照回答不了「在变好还是变坏」——
     * 恐慌贪婪从 30 涨到 78（情绪升温）和从 95 回落到 78（情绪退潮）
     * 是两件完全不同的事，只有序列能区分。
     *
     * 库打不开时返回 {} / null，界面自动不画趋势图，不影响其余部分。
     */
    macroHistory: macroHistory(getMacroStore(), { days: 30 }),
    macroStore: storeSummary(getMacroStore()),

    /**
     * 三阶段编排结论（基本面 → 技术面 → 持仓管理）。
     *
     * 与 regime 分开给是有意的：regime 是阶段一的原始读数，
     * pipeline 是「三段拼起来之后，现在到底停在哪一步」。
     * 后者才是使用者第一眼要看的东西 —— 前者要自己拼。
     */
    pipeline,

    config: {
      cyclePhase: cfg.cyclePhase,
      phaseLabel: PHASE_LABELS[cfg.cyclePhase],
      phaseFloorBps: phaseFloorBps(cfg.cyclePhase),
      availablePhases: CYCLE_PHASES.map((p) => ({ key: p, label: PHASE_LABELS[p], floorBps: phaseFloorBps(p) })),
      risk: cfg.risk,
      leverageCap: cfg.leverageCap,
      trendPeriod: cfg.trendPeriod,
      trendRequiredBreaks: cfg.trendRequiredBreaks,
      trendLookbackBars: cfg.trendLookbackBars,
      trendMinPenetrationBps: cfg.trendMinPenetrationBps,
      // 系统二：触发层的语义参数（"三次突破站稳"到底怎么落实）
      setupMinLegBars: cfg.setupMinLegBars,
      setupMinInsideBars: cfg.setupMinInsideBars,
      setupHoldBars: cfg.setupHoldBars,
      squeezeLookbackBars: cfg.squeezeLookbackBars,
      squeezeMaxPercentile: cfg.squeezeMaxPercentile,
      // 系统一：方向层的迟滞参数
      regimeConfirmDays: cfg.regimeConfirmDays,
      regimeMinHoldDays: cfg.regimeMinHoldDays,
      shockWindowDays: cfg.shockWindowDays,
      shockCooldownDays: cfg.shockCooldownDays,
      chaseMaxExtensionPct: cfg.chaseMaxExtensionPct,
      minRewardRiskBps: cfg.minRewardRiskBps,
      maxAddsRiskBps: cfg.maxAddsRiskBps,
      breakevenBufferBps: cfg.breakevenBufferBps,
      takeProfitBps: cfg.takeProfitBps,
    },
  };
}

/** 数值安全兜底：接口偶发返回 null/undefined 时按 0 处理，避免整页崩掉 */
function parsePad(v) {
  return parseWad(v ?? 0);
}

/* ───────────────────────── 路由 ───────────────────────── */

const ALLOWED_PROXY_TYPES = new Set([
  'meta',
  'metaAndAssetCtxs',
  'allMids',
  'candleSnapshot',
  'clearinghouseState',
  'spotClearinghouseState',
  'openOrders',
  'frontendOpenOrders',
  'userFills',
  'userFillsByTime',
  'portfolio',
  'userFunding',
  'userNonFundingLedgerUpdates',
  'userFees',
  'userRole',
  'userRateLimit',
  'l2Book',
  'fundingHistory',
  'vaultDetails',
]);

async function handle(req, res, url) {
  const p = url.pathname;

  if (p === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      service: 'bithuang-hyperliquid-dashboard',
      networks: Object.values(NETWORKS).map((n) => ({ key: n.key, label: n.label })),
      readOnly: true,
      holdsKeys: false,
      cache: cacheStats(),
    });
  }

  if (p === '/api/snapshot') {
    const user = url.searchParams.get('user');
    if (!isValidAddress(user)) {
      return sendJson(res, 400, {
        ok: false,
        error: '缺少或非法的 user 参数：应为 0x 开头 42 位十六进制的主账户地址',
      });
    }
    const network = url.searchParams.get('network') || 'mainnet';
    const coin = url.searchParams.get('coin') || 'BTC';
    /* 缺省 = 自动（按减半时钟推算），不再硬编码 ACCUMULATION。
     * 硬编码的后果见 src/strategy.js 里 PHASE_AUTO 的注释：
     * 方向层读时钟、门槛读手填值，默认状态下两边不同步。 */
    const phase = url.searchParams.get('phase') || PHASE_AUTO;
    try {
      const snap = await buildSnapshot({ network, user, coin, phase });
      return sendJson(res, snap.ok ? 200 : 502, snap);
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message, stack: e.stack?.split('\n').slice(0, 4) });
    }
  }

  if (p === '/api/regime-criteria') {
    // 比特皇「判断大方向」的全部依据清单 —— 逐条带出处原话与落实方式。
    // 界面用它渲染判据表；测试用它断言「每条都有出处」。
    return sendJson(res, 200, {
      ok: true,
      total: DIRECTION_CRITERIA.length,
      implemented: DIRECTION_CRITERIA.filter((c) => c.implemented === true).length,
      partial: DIRECTION_CRITERIA.filter((c) => c.implemented === 'partial').length,
      manual: DIRECTION_CRITERIA.filter((c) => c.implemented === false).length,
      byLayer: criteriaByLayer(),
      criteria: DIRECTION_CRITERIA,
    });
  }

  if (p === '/api/proxy' && req.method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
    const { network, body: hlBody } = body || {};
    if (!hlBody || !ALLOWED_PROXY_TYPES.has(hlBody.type)) {
      return sendJson(res, 400, {
        ok: false,
        error: `不允许的请求类型。允许：${[...ALLOWED_PROXY_TYPES].join(', ')}`,
      });
    }
    try {
      const data = await info(network || 'mainnet', hlBody, { noCache: true });
      return sendJson(res, 200, { ok: true, data });
    } catch (e) {
      return sendJson(res, 502, { ok: false, error: e.message });
    }
  }

  if (p === '/api/cache/clear' && req.method === 'POST') {
    clearCache();
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/format-check') {
    // 自检：确认格式化函数在真实数值上不炸
    const samples = ['77407.0', '0.49252', '-0.0004133661', '1884490944.7706599236'];
    return sendJson(res, 200, {
      ok: true,
      samples: samples.map((s) => {
        const w = parseWad(s);
        return { raw: s, wad: w.toString(), price: fmtPrice(w), usd: fmtUsd(w) };
      }),
    });
  }

  /**
   * 预警通道状态 —— 给界面显示「服务端推送是否已启用、上次推送是什么时候」。
   *
   * ⚠️ 返回里绝不含任何完整 webhook 地址：全部走 maskUrl 掩码。
   *    接口响应会进浏览器、可能被截图、可能被贴进聊天窗口 —— token 一旦从这里出去就等于泄漏。
   */
  if (p === '/api/alerts/status') {
    const user = url.searchParams.get('user');
    const network = url.searchParams.get('network') || 'mainnet';
    const cfg = await loadAlertConfig();
    const configured = configExists();
    const channels = inspectChannels(cfg);
    const hb = isValidAddress(user) ? await loadHeartbeat(network, user) : null;
    const state = isValidAddress(user) ? await loadState(network, user) : null;
    const history = await readHistory(network, 30);
    return sendJson(res, 200, {
      ok: true,
      readOnly: true,
      holdsKeys: false,
      configured,
      configPathHint: '.alerts/config.json',
      enabled: cfg.enabled !== false,
      // 阈值是可公开的信息（不含任何凭据），界面用它来显示「触发线是多少」
      thresholds: resolveConfig(cfg),
      notify: {
        channels: channels.map((c) => ({ type: c.type, label: c.label, ok: c.ok, masked: c.masked, error: c.error })),
        usable: channels.filter((c) => c.ok).length,
      },
      watcher: hb
        ? {
            running: Date.now() - (hb.at || 0) < Math.max(120000, (hb.intervalMs || 60000) * 3),
            lastRunAt: hb.at ?? null,
            intervalMs: hb.intervalMs ?? null,
            runs: hb.runs ?? null,
            notified: hb.notified ?? null,
            lastError: hb.lastError ?? null,
          }
        : { running: false, lastRunAt: null },
      activeCount: state ? Object.keys(state.active || {}).length : 0,
      history: history.map((h) => ({
        at: h.at,
        delivered: h.delivered ?? [],
        failed: h.failed ?? [],
        counts: h.counts ?? null,
        summary: h.summary ?? null,
      })),
    });
  }

  /** 发一条测试推送，确认通道配好没有。只在本地回环可达，不接收任何来自请求的 URL。 */
  if (p === '/api/alerts/test' && req.method === 'POST') {
    const cfg = await loadAlertConfig();
    const now = Date.now();
    const stub = {
      at: now,
      summary: { total: 1, critical: 0, warn: 1, byFamily: { risk: 1, funding: 0, roll: 0 } },
    };
    const events = [
      {
        kind: 'fired',
        at: now,
        severity: 'warn',
        family: 'risk',
        rule: 'liq-approach',
        coin: 'TEST',
        title: '这是一条测试预警',
        detail: '收到这条消息说明推送通道已经打通。真实预警会带上具体的标的、价格与阈值。',
      },
    ];
    const { formatPush, formatPushText } = await import('./src/alerts.js');
    const result = await sendNotify(cfg, {
      title: '比特皇看板 · 测试推送',
      body: formatPush(events, stub, { networkLabel: '本机', userShort: '测试' }),
      text: formatPushText(events, stub, { networkLabel: '本机', userShort: '测试' }),
      events,
      summary: stub.summary,
    });
    return sendJson(res, 200, result);
  }

  // 静态资源
  if (p === '/' || p === '/index.html') {
    if (await serveStatic(res, PUBLIC_DIR, '/index.html')) return;
  }
  if (p.startsWith('/src/')) {
    const name = p.slice('/src/'.length);
    if (!SHARED_MODULES.has(name)) {
      return res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
    }
    if (await serveStatic(res, SRC_DIR, '/' + name)) return;
  }
  if (await serveStatic(res, PUBLIC_DIR, p)) return;

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  handle(req, res, url).catch((e) => {
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(e?.message || e) });
    else res.end();
  });
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  比特皇 · Hyperliquid 只读看板');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  地址   : http://${HOST}:${PORT}`);
  console.log(`  模式   : 只读（无密钥、无签名、无下单路径）`);
  console.log(`  监听   : ${HOST}${HOST === '127.0.0.1' ? '（仅本机可访问）' : '（对外监听 —— 只在可信内网里这么做）'}`);
  console.log('');
  const sample = '0x0000000000000000000000000000000000000000';
  console.log(`  自检   : curl "http://${HOST}:${PORT}/api/health"`);
  console.log(`  快照   : http://${HOST}:${PORT}/api/snapshot?network=mainnet&user=${sample}&coin=BTC`);
  console.log('');
});
