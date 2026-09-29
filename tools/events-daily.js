#!/usr/bin/env node
/**
 * 每日事件采集 —— 把「黑天鹅 / 减半 / 美联储决议」从手工录入改成自动抓。
 *
 * ── 与 macro-daily 的分工 ────────────────────────────────────────
 *   macro-daily  ：M1~M6 六个**读数**（情绪/ETF/链上/利率/持仓/监管）→ 落 .data/macro.db
 *   events-daily ：三类**事件**（shock/halving/liquidity 日程与决议）→ 落 .data/events-auto.json
 * 两者都由 entrypoint.sh 的循环每天跑一次，都只依赖公开免费接口、无密钥。
 *
 * ── 自动表与手工表的关系 ────────────────────────────────────────
 * 手工表 `config/macro-events.json` 一个字不动。自动表是**另一份文件**，
 * 合并在 loadMacroEvents 里做，规则只有一条：**手工永远优先** ——
 * 同 kind 且日期差 ≤3 天的手工条目存在时，自动条目直接丢弃，
 * 否则同一次减半会在界面日程里出现两次。
 *
 * ── 「不编造」在这里怎么落地 ────────────────────────────────────
 * 黑天鹅没有事件就是没有事件（当前没有暴跌就写 0 条），不拿占位顶上；
 * FOMC 只把联储官网**已经公布**的日期写进去；利率变动取 FRED 实测值；
 * 减半由块高算出来，note 里写明是估算。抓不到就少一类，不报错。
 *
 * 用法：
 *   node tools/events-daily.js               采集 + 落盘
 *   node tools/events-daily.js --quiet       只打一行摘要（给 cron/容器日志）
 *   node tools/events-daily.js --json        结构化输出（给自动化）
 *   node tools/events-daily.js --dry-run     只抓不写
 *   node tools/events-daily.js --view        回看自动表（不联网）
 */

import fs from 'node:fs';
import path from 'node:path';
import { collectAutoEvents } from '../src/events-sources.js';
import { DATA_DIR } from '../src/macro-store.js';
import { MACRO_EVENTS_PATH } from '../src/regime-inputs.js';

const AUTO_PATH = path.join(DATA_DIR, 'events-auto.json');
const DAY = 86400000;

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const QUIET = has('--quiet');
const JSON_OUT = has('--json');
const DRY = has('--dry-run');
const VIEW = has('--view');

const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (s) => Date.parse(`${s}T00:00:00Z`);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 手工表（只读，永不写它）。 */
function readManual() {
  try {
    const j = JSON.parse(fs.readFileSync(MACRO_EVENTS_PATH, 'utf8'));
    return Array.isArray(j.events) ? j.events : [];
  } catch {
    return [];
  }
}

/**
 * 同类事件是否已被手工表覆盖 —— 同 kind 且日期差 ≤3 天算同一件事。
 * 减半是块高估算，跟手工表写的预估日期本就可能差一两天，3 天的窗口刚好
 * 接得住，又不至于把两次真的不同的事件并成一条。
 */
function coveredByManual(auto, manual) {
  return manual.some(
    (m) =>
      m.kind === auto.kind &&
      Number.isFinite(dayMs(m.date)) &&
      Math.abs(dayMs(m.date) - dayMs(auto.date)) <= 3 * DAY,
  );
}

/** 自动表里的事件分两类：日程过期就没用，读数事件留 400 天。 */
function keepEvent(e, now) {
  if (!Number.isFinite(dayMs(e.date))) return false;
  const isSchedule = e.kind === 'halving' || e.id.startsWith('auto:fomc-');
  return isSchedule ? dayMs(e.date) >= now : now - dayMs(e.date) <= 400 * DAY;
}

async function main() {
  const now = Date.now();

  if (VIEW) {
    const auto = readJson(AUTO_PATH, { events: [] }).events || [];
    const manual = readManual();
    const live = auto.filter((e) => keepEvent(e, now));
    if (JSON_OUT) {
      console.log(
        JSON.stringify(
          { ok: true, view: 'events', path: AUTO_PATH, auto: live.length, manual: manual.length, events: live },
          null,
          2,
        ),
      );
      return;
    }
    console.log(`自动事件表 · ${AUTO_PATH}`);
    console.log(`自动 ${live.length} 条 / 手工 ${manual.length} 条`);
    for (const e of [...live, ...manual.filter((m) => dayMs(m.date) >= now)].sort((a, b) => dayMs(a.date) - dayMs(b.date))) {
      console.log(`  ${e.date}  ${e.kind.padEnd(9)} ${String(e.weight).padStart(5)}  ${e.id}`);
    }
    return;
  }

  const manual = readManual();
  const { events: fresh, sources } = await collectAutoEvents({ now });

  // 旧的自动条目先按有效期裁一遍，再让本次抓到的按 id 覆盖同名
  const prev = (readJson(AUTO_PATH, { events: [] }).events || []).filter((e) => keepEvent(e, now));
  const byId = new Map();
  for (const e of prev) byId.set(e.id, e);
  for (const e of fresh) byId.set(e.id, e);

  // 手工表覆盖过的丢掉（不重复）；日程/读数按有效期再裁一次
  const merged = [...byId.values()]
    .filter((e) => !coveredByManual(e, manual))
    .filter((e) => keepEvent(e, now))
    .sort((a, b) => dayMs(a.date) - dayMs(b.date));

  const written = !DRY;
  if (written) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      AUTO_PATH,
      `${JSON.stringify({ version: 1, updatedAt: ymd(now), events: merged }, null, 2)}\n`,
    );
  }

  const failed = sources.filter((s) => !s.ok);
  const got = fresh.length;
  const summary = `事件 ${merged.length} 条（本次抓到 ${got}）· 自动源 ${sources.length - failed.length}/${sources.length}` +
    (failed.length ? ` · 失败 ${failed.map((f) => f.key).join(',')}` : '');

  if (JSON_OUT) {
    console.log(JSON.stringify({ ok: failed.length < sources.length, written, path: AUTO_PATH, sources, events: merged }, null, 2));
  } else if (QUIET) {
    console.log(`[events-daily] ${ymd(now)} ${summary}`);
  } else {
    console.log(`[events-daily] ${ymd(now)} ${summary}`);
    for (const s of sources) console.log(`  ${s.ok ? '✓' : '✗'} ${s.key.padEnd(8)} 抓到 ${s.got}${s.ok ? '' : ` —— ${s.error}`}`);
    for (const e of fresh) console.log(`  + ${e.date} ${e.kind} w=${e.weight}  ${e.id}`);
    if (DRY) console.log('  （--dry-run：未写盘）');
    console.log('  说明：手工表仍是 config/macro-events.json，自动表不覆盖它。');
  }

  // 四路全挂才算失败（与 macro-daily 同口径：部分失败不影响其余可用数据）
  if (failed.length === sources.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`[events-daily] 失败：${e?.message || e}`);
  process.exitCode = 1;
});
