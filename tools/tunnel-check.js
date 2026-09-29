/**
 * Telegram 可达性 / 代理隧道诊断 —— 推送发不出去时先跑这个。
 *
 *   node tools/tunnel-check.js
 *   node tools/tunnel-check.js --proxy http://127.0.0.1:7890
 *
 * 依次报告两件事：
 *   ① 直连 api.telegram.org 通不通（国内一般是**不通**的，这是预期，不是 bug）
 *   ② 经代理走 CONNECT 隧道通不通
 *
 * 只请求 https://api.telegram.org/ 这个**公开根路径**，不带 token、不碰 chatId，
 * 所以它不需要配置任何密钥就能跑，也不会泄漏任何密钥。
 *
 * 退出码：任一条通 = 0，都不通 = 1（方便塞进别的脚本里做前置检查）。
 */

import fs from 'node:fs';
import https from 'node:https';
import { makeProxyAgent } from '../src/notify.js';

const args = process.argv.slice(2);
const valOf = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};

const TARGET = 'api.telegram.org';

function loadChannels() {
  try {
    const raw = fs.readFileSync(new URL('../.alerts/config.json', import.meta.url), 'utf8');
    return JSON.parse(raw)?.channels ?? [];
  } catch {
    return [];
  }
}

/** 把人话讲清楚：`ECONNRESET` 对用户没有意义，「连接被重置」才有。 */
function describe(e) {
  const c = e?.code;
  const msg = e?.message || String(e);
  if (c === 'ENOTFOUND') return '域名解析失败（DNS 被污染，或本机断网）';
  if (c === 'ECONNRESET') return '连接被重置（典型的阻断特征）';
  if (c === 'ETIMEDOUT' || /超时/.test(msg)) return '连接超时（包被丢弃）';
  if (c === 'ECONNREFUSED') return '连接被拒绝（代理端口没在监听？）';
  if (c === 'EACCES') return '端口被拒绝访问';
  return c ? `${c}：${msg}` : msg;
}

function probe({ agent, timeoutMs = 8000 } = {}) {
  const started = Date.now();
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: TARGET,
        port: 443,
        path: '/',
        method: 'GET',
        headers: { 'User-Agent': 'hl-dashboard-tunnel-check' },
        ...(agent ? { agent } : {}),
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ ok: true, status: res.statusCode, ms: Date.now() - started }));
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`超时（${timeoutMs}ms）`)));
    req.on('error', (e) => resolve({ ok: false, error: describe(e), ms: Date.now() - started }));
    req.end();
  });
}

const line = (r) => `${r.ok ? '✓' : '✗'} ${r.ok ? `HTTP ${r.status}` : r.error}  (${r.ms}ms)`;

console.log('');
console.log('  Telegram 可达性诊断');
console.log('  ─────────────────────────────────────────────');
console.log(`  目标    : https://${TARGET}/  （公开根路径，不带 token）`);

const channels = loadChannels();
const tgChannel = channels.find((c) => c?.type === 'telegram') ?? null;
const proxyUrl = valOf('proxy') || tgChannel?.proxy || process.env.HTTPS_PROXY || process.env.https_proxy || null;
const proxyFrom = valOf('proxy') ? '命令行' : tgChannel?.proxy ? '配置' : proxyUrl ? '环境变量' : '无';

console.log(`  代理    : ${proxyUrl || '（未配置）'}${proxyUrl ? ` · 来自${proxyFrom}` : ''}`);
console.log('');
console.log('  ① 直连');
const direct = await probe();
console.log(`     ${line(direct)}`);

console.log('');
console.log('  ② 经代理隧道');
let via = null;
if (!proxyUrl) {
  console.log('     - 跳过：没有可用的代理地址');
} else {
  try {
    const agent = makeProxyAgent(proxyUrl);
    via = await probe({ agent });
    console.log(`     ${line(via)}`);
  } catch (e) {
    console.log(`     ✗ 代理地址不可用：${e.message}`);
  }
}

console.log('');
if (direct.ok) {
  console.log('  结论：直连可用 —— telegram 通道不必配 proxy。');
} else if (via?.ok) {
  console.log('  结论：直连不通、代理通 —— 在 telegram 通道上加 proxy 字段即可（当前已生效）。');
} else if (proxyUrl) {
  console.log('  结论：直连和代理都不通 —— 先确认代理软件在跑、端口没写错，再重跑本命令。');
} else {
  console.log('  结论：直连不通且没配代理 —— 在 telegram 通道上加 "proxy": "http://127.0.0.1:端口"。');
}
console.log('');

process.exitCode = direct.ok || via?.ok ? 0 : 1;
