/**
 * 预警的本地持久化 —— 配置、活动状态、推送历史。仅服务端使用。
 *
 * 全部落在项目根目录的 `.alerts/` 下（**不在 public/ 里，HTTP 拿不到**）：
 *
 *   .alerts/config.json                  推送通道与阈值覆盖（含 webhook token，按密钥对待）
 *   .alerts/state-<net>-<addr>.json      每个账户一份活动告警状态，重启不丢
 *   .alerts/history-<net>.jsonl          推送历史（一行一条，追加写）
 *
 * 为什么要按账户分状态：同一个看板会切主网/测试网、也会换地址。
 * 状态混在一起的话，切地址时会把上一个账户的活动集当成「已恢复」全刷一遍。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ALERT_DIR = path.resolve(__dirname, '..', '.alerts');

export const configPath = () => path.join(ALERT_DIR, 'config.json');

/** 状态与历史按「网络 + 地址」隔离，避免切账户时误报「已恢复」 */
export function statePath(network, user) {
  const safe = String(user || 'none').toLowerCase().replace(/[^0-9a-z]/g, '');
  return path.join(ALERT_DIR, `state-${safeId(network)}-${safe.slice(0, 42)}.json`);
}
export function historyPath(network) {
  return path.join(ALERT_DIR, `history-${safeId(network)}.jsonl`);
}

/** 文件名白名单：网络名会进路径，必须过滤（Windows 上 `:` 之类的字符会让写入静默失败） */
function safeId(s) {
  return String(s || 'mainnet').toLowerCase().replace(/[^0-9a-z_-]/g, '');
}

async function ensureDir() {
  await fsp.mkdir(ALERT_DIR, { recursive: true });
}

/* ───────────────────────── 配置 ───────────────────────── */

/** 读不到 / 解析失败都返回 {} —— 配置坏了应该退回默认阈值，而不是让预警整体失效 */
export async function loadAlertConfig() {
  try {
    const raw = await fsp.readFile(configPath(), 'utf8');
    const j = JSON.parse(raw);
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

export async function saveAlertConfig(cfg) {
  await ensureDir();
  await fsp.writeFile(configPath(), `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  return configPath();
}

/* ───────────────────────── 状态 ───────────────────────── */

export async function loadState(network, user) {
  try {
    const raw = await fsp.readFile(statePath(network, user), 'utf8');
    const j = JSON.parse(raw);
    if (j && typeof j === 'object' && j.active && typeof j.active === 'object') return j;
    return null;
  } catch {
    return null;
  }
}

/** 原子写：先写临时文件再 rename，避免进程被 kill 时留下半个 JSON 导致状态丢失 */
export async function saveState(network, user, state) {
  await ensureDir();
  const target = statePath(network, user);
  const tmp = `${target}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(state), 'utf8');
  await fsp.rename(tmp, target);
  return target;
}

/* ───────────────────────── 推送历史 ───────────────────────── */

export async function appendHistory(network, record) {
  await ensureDir();
  await fsp.appendFile(historyPath(network), `${JSON.stringify(record)}\n`, 'utf8');
}

/** 读最近 n 条（从尾部反向扫，避免把整个文件读进内存） */
export async function readHistory(network, limit = 50) {
  try {
    const raw = await fsp.readFile(historyPath(network), 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        out.push(JSON.parse(lines[i]));
      } catch {
        /* 半行（进程正好在写）直接跳过 */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** 心跳文件：让界面能显示「守护进程上次跑是什么时候」 */
export function heartbeatPath(network, user) {
  return path.join(ALERT_DIR, `heartbeat-${safeId(network)}-${String(user || 'none').toLowerCase().replace(/[^0-9a-z]/g, '').slice(0, 42)}.json`);
}

export async function saveHeartbeat(network, user, info) {
  await ensureDir();
  await fsp.writeFile(heartbeatPath(network, user), JSON.stringify(info), 'utf8');
}

export async function loadHeartbeat(network, user) {
  try {
    return JSON.parse(await fsp.readFile(heartbeatPath(network, user), 'utf8'));
  } catch {
    return null;
  }
}

/** 是否存在配置文件（用于界面提示「尚未配置推送通道」） */
export function configExists() {
  try {
    return fs.existsSync(configPath());
  } catch {
    return false;
  }
}
