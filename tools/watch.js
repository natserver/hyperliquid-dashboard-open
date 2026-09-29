/**
 * 预警守护进程 —— 轮询本地看板的快照 → 跑规则引擎 → 把新告警推送出去。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 为什么走本地 HTTP，而不是自己再去拉一次 Hyperliquid：
 *
 *   `src/hl.js` 的限流闸门（并发上限 + 最小间隔）是**进程内**的。
 *   如果守护进程用自己的进程独立拉取，就变成对**同一个 IP 配额**打双份请求，
 *   很容易触发 429 —— 而限流一旦触发，你屏幕上看到的和推送给你的会同时开始出错。
 *   走本地看板还顺带保证了两件事：① 同一份快照，数字必然一致；
 *   ② 只有一份缓存，不会出现「界面已刷新、推送还是旧的」。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 用法：
 *
 *   node tools/watch.js --user 0x你的地址                       # 常驻，默认 60 秒一轮
 *   node tools/watch.js --user 0x… --interval 30               # 30 秒一轮
 *   node tools/watch.js --user 0x… --once                      # 只跑一轮，打印结果后退出
 *   node tools/watch.js --test-push                            # 只发一条测试推送
 *   node tools/watch.js --user 0x… --network testnet           # 走测试网
 *
 *   先把看板服务跑起来（node server.js），守护进程依赖它取数。
 *
 * 推送通道在 .alerts/config.json 里配，没配就只打控制台。
 * 配置文件含 webhook token，界面上任何地方都不会回显完整地址。
 */

import { evaluateAlerts, formatPush, formatPushText } from '../src/alerts.js';
import { sendNotify, maskUrl, CHANNELS, resolveProxy } from '../src/notify.js';
import {
  appendHistory,
  loadAlertConfig,
  loadState,
  saveHeartbeat,
  saveState,
  configPath,
} from '../src/alertstore.js';

/* ───────────────────────── 参数 ───────────────────────── */

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
/**
 * 布尔开关匹配。⚠️ 传**裸名**（'once'），不要传 '--once' ——
 * 这里会自己补前缀。传成 '--once' 会去找 '----once'，
 * 结果是开关静默失效：不报错、不生效，看起来像「跑过了但没输出」。
 */
const has = (flag) => argv.includes(`--${flag}`);

const BASE = (argOf('base') || process.env.HL_BASE || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const USER = argOf('user') || process.env.HL_USER || '';
const NETWORK = argOf('network') || process.env.HL_NETWORK || 'mainnet';
/* 缺省 = 自动（按减半时钟推算），与 server.js / 前端默认值一致。
 * 此前这里硬编码 ACCUMULATION，而方向层根本不看 phase（它自己读时钟），
 * 于是守护进程拉到的快照波动门槛长期按熊末 16% 算，与看板看到的不是同一份决策。 */
const PHASE = argOf('phase') || process.env.HL_PHASE || 'AUTO';
const COIN = argOf('coin') || process.env.HL_COIN || 'BTC';
const INTERVAL_MS = Math.max(10, Number(argOf('interval') || process.env.HL_INTERVAL || 60)) * 1000;
const ONCE = has('once');
const TEST_PUSH = has('test-push');
const QUIET = has('quiet');

const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const log = (...a) => {
  if (!QUIET) console.log(`[${stamp()}]`, ...a);
};

/* ───────────────────────── 取数 ───────────────────────── */

async function fetchSnapshot() {
  const url = `${BASE}/api/snapshot?network=${encodeURIComponent(NETWORK)}&user=${encodeURIComponent(
    USER
  )}&coin=${encodeURIComponent(COIN)}&phase=${encodeURIComponent(PHASE)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  const json = await res.json().catch(() => null);
  if (!json) throw new Error(`快照响应不是合法 JSON（HTTP ${res.status}）—— 看板服务是否在 ${BASE} 上？`);
  return json;
}

/* ───────────────────────── 推送 ───────────────────────── */

/**
 * 单轮：取快照 → 评估 → 落状态 → 有事件就推送。
 * @returns {{result:object, delivered:string[], failed:string[], events:Array}}
 */
async function tick(cfg, prevState) {
  const snapshot = await fetchSnapshot();
  const result = evaluateAlerts({ snapshot, prev: prevState, now: Date.now(), config: cfg });
  const events = result.events;

  let delivered = [];
  let failed = [];
  if (events.length) {
    const meta = {
      networkLabel: snapshot.networkLabel || NETWORK,
      userShort: USER ? `${USER.slice(0, 6)}…${USER.slice(-4)}` : '',
    };
    const payload = {
      title: buildTitle(events, result),
      body: formatPush(events, result, meta),
      text: formatPushText(events, result, meta),
      events,
      summary: result.summary,
    };
    const sent = await sendNotify(cfg, payload);
    delivered = sent.delivered;
    failed = sent.failed;
    for (const r of sent.results) {
      if (!r.ok) log(`  ⚠ 通道 ${r.channel} 发送失败：${r.error}`);
    }
  }

  return { result, delivered, failed, events, snapshot };
}

function buildTitle(events, result) {
  const critical = events.filter((e) => e.severity === 'critical').length;
  const rec = events.filter((e) => e.kind === 'recovered').length;
  if (critical) return `比特皇看板 · ${critical} 条严重预警`;
  if (rec === events.length) return `比特皇看板 · ${events.length} 条已恢复`;
  return `比特皇看板 · ${events.length} 条预警变化（当前 ${result.summary.total} 条活动）`;
}

/* ───────────────────────── 主流程 ───────────────────────── */

async function main() {
  const cfg = await loadAlertConfig();

  if (TEST_PUSH) {
    const sent = await sendNotify(cfg, {
      title: '比特皇看板 · 测试推送',
      body: '## 测试推送\n\n收到这条消息说明推送通道已经打通。',
      text: '测试推送\n\n收到这条消息说明推送通道已经打通。',
      events: [],
      summary: { total: 0, critical: 0, warn: 0, byFamily: {} },
    });
    printChannelSummary(cfg, sent);
    process.exitCode = sent.ok ? 0 : 1;
    return;
  }

  if (!USER || !/^0x[0-9a-fA-F]{40}$/.test(USER)) {
    console.error('');
    console.error('  缺少或非法的 --user 参数：应为 0x 开头 42 位十六进制的主账户地址。');
    console.error('');
    console.error('  例：node tools/watch.js --user 0x23474ba3bcaa23c916afa880c6871d5cd60801b2');
    console.error('');
    process.exitCode = 2;
    return;
  }

  // 启动前先确认看板服务在跑 —— 否则会进入一个永远失败的循环，日志刷屏且看不出原因
  try {
    const h = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(8000) });
    if (!h.ok) throw new Error(`HTTP ${h.status}`);
  } catch (e) {
    console.error('');
    console.error(`  连接不上本地看板服务（${BASE}）：${e.message}`);
    console.error('  请先在另一个终端启动：node server.js');
    console.error('');
    process.exitCode = 3;
    return;
  }

  printBanner(cfg);

  let prev = await loadState(NETWORK, USER);
  if (prev) {
    log(`已载入上次状态：${Object.keys(prev.active || {}).length} 条活动预警（不会重复推送历史既存状态）`);
  } else {
    log(`首次运行：按 priming=${cfg.priming || 'critical'} 策略建基线 —— 只推严重级，避免启动瞬间刷屏`);
  }

  let runs = 0;
  let notified = 0;
  let lastError = null;
  let running = false;
  let stopping = false;

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    log('收到退出信号，保存状态后结束。');
    try {
      if (prev) await saveState(NETWORK, USER, prev);
    } catch {
      /* 退出路径上不再抛 */
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const loop = async () => {
    if (stopping) return;
    if (running) {
      // 上一轮还没跑完（接口慢或限流），跳过这一轮而不是并发叠加 —— 叠加会把限流压得更死
      log('上一轮尚未结束，跳过本次。');
      return;
    }
    running = true;
    try {
      const { result, delivered, failed, events } = await tick(cfg, prev);
      prev = result.state;
      runs += 1;
      lastError = null;

      await saveState(NETWORK, USER, prev);
      if (events.length) {
        notified += events.length;
        await appendHistory(NETWORK, {
          at: result.at,
          network: NETWORK,
          user: USER,
          counts: result.changes,
          summary: result.summary,
          delivered,
          failed,
          events: events.map((e) => ({
            kind: e.kind,
            severity: e.severity,
            family: e.family,
            rule: e.rule,
            coin: e.coin,
            title: e.title,
          })),
        });
        log(
          `${events.length} 条变化（${kindBrief(result.changes)}）→ ${delivered.length ? delivered.join('+') : '未送达'}｜当前活动 ${result.summary.total} 条（严重 ${result.summary.critical}）`
        );
        for (const e of events) {
          log(`  · ${e.kind === 'recovered' ? '🟢' : e.severity === 'critical' ? '🔴' : '🟠'} [${e.coin}] ${e.title}`);
        }
      } else if (!QUIET) {
        log(`无新变化｜当前活动 ${result.summary.total} 条（严重 ${result.summary.critical} / 警告 ${result.summary.warn}）`);
      }
      if (result.uncovered?.length) {
        log(`  注：${result.uncovered.map((u) => u.coin).join('、')} 未算策略读数，本次只做了清算检查`);
      }
      await saveHeartbeat(NETWORK, USER, {
        at: Date.now(),
        intervalMs: INTERVAL_MS,
        runs,
        notified,
        lastError: null,
        activeCount: result.summary.total,
        network: NETWORK,
        user: USER,
        stale: Boolean(result.stale),
      });
    } catch (e) {
      lastError = String(e?.message || e);
      log(`本轮失败（活动集保持不动，不会误报「已恢复」）：${lastError}`);
      // 失败也写心跳，界面才能区分「守护进程死了」和「在跑但取数失败」
      try {
        await saveHeartbeat(NETWORK, USER, {
          at: Date.now(),
          intervalMs: INTERVAL_MS,
          runs,
          notified,
          lastError,
          activeCount: prev ? Object.keys(prev.active || {}).length : 0,
          network: NETWORK,
          user: USER,
          degraded: true,
        });
      } catch {
        /* 心跳写不进去不影响主流程 */
      }
    } finally {
      running = false;
    }
  };

  await loop();
  if (ONCE) {
    log(`--once 完成：跑了 ${runs} 轮，${notified} 条变化。`);
    return;
  }

  // 用「上一轮结束后再排下一轮」而不是 setInterval：
  // setInterval 在单轮超时的情况下会不断堆积，最终把限流压死。
  const schedule = () => {
    if (stopping) return;
    setTimeout(async () => {
      await loop();
      schedule();
    }, INTERVAL_MS);
  };
  schedule();
  log(`守护进程已启动，每 ${INTERVAL_MS / 1000} 秒一轮。Ctrl+C 退出。`);
}

function kindBrief(c) {
  const p = [];
  if (c.fired) p.push(`新增 ${c.fired}`);
  if (c.escalated) p.push(`升级 ${c.escalated}`);
  if (c.recovered) p.push(`恢复 ${c.recovered}`);
  if (c.reminder) p.push(`提醒 ${c.reminder}`);
  return p.join(' / ') || '—';
}

function printBanner(cfg) {
  console.log('');
  console.log('  比特皇看板 · 预警守护进程');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  看板      : ${BASE}`);
  console.log(`  账户      : ${USER}`);
  console.log(`  网络/相位 : ${NETWORK} · ${PHASE}`);
  console.log(`  轮询间隔  : ${INTERVAL_MS / 1000} 秒`);
  console.log(`  配置      : ${configPath()}`);
  printChannelSummary(cfg, null);
  console.log('');
}

function printChannelSummary(cfg, sent) {
  const list = Array.isArray(cfg.channels) ? cfg.channels : [];
  if (!list.length) {
    console.log('  推送通道  : 未配置 —— 只在控制台输出');
    console.log('              要真推送，把 .alerts/config.example.json 复制成');
    console.log('              .alerts/config.json 并填入你的机器人 webhook。');
    if (sent) console.log(`  测试结果  : ${sent.ok ? '控制台可用' : '失败'}`);
    return;
  }
  console.log('  推送通道  :');
  for (const ch of list) {
    // 代理走没走必须显形：否则「连接超时」时看不出是直连被墙还是代理没生效
    const px = resolveProxy(ch);
    const via = px ? `（经代理 ${maskUrl(px.url)}${px.source === 'env' ? ' · 环境变量' : ''}）` : '';
    console.log(`    · ${CHANNELS[ch.type] || ch.type} → ${maskUrl(ch.url) || '(本地输出)'}${via}`);
  }
  if (sent) {
    console.log(`  测试结果  : ${sent.ok ? '至少一个通道成功' : '全部失败'}`);
    for (const r of sent.results) {
      console.log(`    ${r.ok ? '✓' : '✗'} ${r.channel}${r.error ? ` —— ${r.error}` : ''}`);
    }
  }
}

main().catch((e) => {
  console.error('守护进程异常退出：', e?.stack || e);
  process.exitCode = 1;
});
