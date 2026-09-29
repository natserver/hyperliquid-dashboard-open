/**
 * 推送通道 —— 仅服务端使用（前端不 import 本文件）。
 *
 * 支持：企业微信群机器人 / 钉钉机器人 / Bark / Server 酱 / Telegram（电报）/
 *       通用 webhook / 控制台。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ⚠️ 安全约束（本工程会经手你的账户地址，而推送 URL 里带 token，必须当密钥对待）
 *
 *   1. **只从本机配置文件读取**，绝不接受来自 HTTP 请求的任意 URL。
 *      否则这台本地服务就成了一个 SSRF 跳板：任何能访问 127.0.0.1:8787 的页面
 *      都能诱导它去请求内网地址。
 *   2. 默认**只允许 https**；指向内网/回环/云元数据地址的目标必须显式打开
 *      `allowPrivateTargets` —— 这是为了挡住「把 token 推到攻击者服务器」之外，
 *      还挡住拿本服务当内网扫描器。
 *   3. 任何输出（日志、/api/alerts/status、命令行回显）都必须走 maskUrl。
 *      webhook 的 token 一旦进了日志文件或接口响应，等于泄漏。
 *
 *   4. 通道级 `proxy` 字段同样**只从本机配置读**，且只支持 http(s) 代理。
 *      它是给 Telegram 这类「本机直连不可达」的通道用的，不是通用出口 ——
 *      别把它做成「把任意地址转发出去」的开放代理。
 */

import https from 'node:https';
import http from 'node:http';
import tls from 'node:tls';

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, // link-local
  /^100\.(6[4-9]|[7-9]\d|1[0-2]\d)\./, // CGNAT
  /^\[?::1\]?$/i,
  /^\[?f[cd][0-9a-f]{2}:/i, // ULA
  /metadata\.google\.internal$/i,
  /\.internal$/i,
  /\.local$/i,
];

export const CHANNELS = Object.freeze({
  console: '控制台（始终可用，用于调试）',
  wecom: '企业微信群机器人',
  dingtalk: '钉钉机器人',
  bark: 'Bark（iOS 推送）',
  serverchan: 'Server 酱',
  telegram: 'Telegram（电报）Bot',
  generic: '通用 webhook（POST JSON）',
});

/**
 * 校验 webhook 地址。不合法就抛异常 —— 宁可配置时报错，也不要运行时把 token 发到意外的地方。
 * @returns {URL}
 */
export function assertSafeWebhookUrl(raw, { allowPrivateTargets = false } = {}) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw new Error(`推送地址不是合法 URL：${maskUrl(raw)}`);
  }
  const https = u.protocol === 'https:';
  const httpLocal = u.protocol === 'http:';
  if (!https && !httpLocal) throw new Error(`推送地址只允许 http(s)：${maskUrl(raw)}`);
  const priv = PRIVATE_HOST_PATTERNS.some((re) => re.test(u.hostname));
  if (priv && !allowPrivateTargets) {
    throw new Error(
      `推送地址指向内网/回环/元数据地址（${u.hostname}），默认拒绝 —— ` +
        `这条规则是为了防止本服务被当成内网跳板。确实需要时在配置里打开 allowPrivateTargets`
    );
  }
  if (!https && !priv && !allowPrivateTargets) {
    throw new Error(`外部推送地址必须用 https（当前 ${u.protocol}）：${maskUrl(raw)}`);
  }
  return u;
}

/** 把 token 掩掉的展示形式。任何面向人的输出都必须先过这一层。 */
export function maskUrl(raw) {
  if (raw === null || raw === undefined || raw === '') return '';
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    const s = String(raw);
    return s.length <= 8 ? '****' : `${s.slice(0, 4)}…${s.slice(-4)}`;
  }
  const segs = u.pathname
    .split('/')
    .map((seg) => {
      if (!seg) return seg;
      if (seg.length <= 8 && !/\d{3,}/.test(seg)) return seg;
      return `${seg.slice(0, 4)}…${seg.slice(-4)}`;
    })
    .join('/');
  const q = [...u.searchParams.keys()].map((k) => `${k}=****`).join('&');
  return `${u.protocol}//${u.host}${segs}${q ? `?${q}` : ''}`;
}

/* ───────────────────── 通道级代理（Telegram 等直连不可达的场景） ───────────────────── */

/**
 * 经本地 HTTP 代理发 HTTPS 请求 —— 走 CONNECT 隧道。
 *
 * 为什么必须自己写这三行隧道：
 *   · Node 内置 fetch **不读** HTTPS_PROXY；`--use-env-proxy` 是**进程级**开关，
 *     开了会让所有 fetch 都走代理 —— 包括轮询本机 127.0.0.1:8787 的看板，反而更危险；
 *   · undici 的 ProxyAgent 拿不到：undici 不是 builtin module，本项目零依赖；
 *   · 真正想要的是「**就这一条通道**走代理」，进程级环境变量给不了这个粒度。
 *
 * 只负责建隧道：CONNECT 打通后套上 TLS，HTTP 报文（含 chunked）仍交给
 * Node 的 https 模块解析，**不手写协议解析** —— 那是最容易出边界 bug 的地方。
 */
class TunnelAgent extends https.Agent {
  #proxy;
  constructor(proxy, options = {}) {
    super({ keepAlive: false, ...options });
    this.#proxy = proxy;
  }
  /** @param {import('node:https').RequestOptions} options @param {Function} cb */
  createConnection(options, cb) {
    let settled = false;
    const once = (err, sock) => {
      if (settled) return;
      settled = true;
      cb(err, sock);
    };
    const proxy = this.#proxy;
    const auth = proxy.username
      ? `Basic ${Buffer.from(
          `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
        ).toString('base64')}`
      : null;
    const target = `${options.host}:${options.port || 443}`;
    const viaTls = proxy.protocol === 'https:';
    const transport = viaTls ? https : http;
    const req = transport.request({
      host: proxy.hostname,
      port: Number(proxy.port || (viaTls ? 443 : 80)),
      method: 'CONNECT',
      path: target,
      headers: auth ? { 'Proxy-Authorization': auth } : {},
    });
    req.setTimeout(12000, () => req.destroy(new Error(`连接代理 ${proxy.host} 超时`)));
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        once(new Error(`代理 CONNECT ${target} 被拒：HTTP ${res.statusCode}`));
        return;
      }
      const tlsSocket = tls.connect({ socket, servername: options.servername || options.host });
      tlsSocket.once('error', (e) => once(e));
      once(null, tlsSocket);
    });
    req.once('error', (e) => once(e));
    req.end();
  }
}

const proxyAgents = new Map();

/** 把代理地址变成一个可复用的隧道 agent。地址非法就抛 —— 配置错误要在自检时显形。 */
export function makeProxyAgent(proxyUrl) {
  const key = String(proxyUrl);
  if (proxyAgents.has(key)) return proxyAgents.get(key);
  const p = new URL(key);
  if (p.protocol !== 'http:' && p.protocol !== 'https:') {
    throw new Error(`代理只支持 http(s)：${maskUrl(key)}`);
  }
  const agent = new TunnelAgent(p);
  proxyAgents.set(key, agent);
  return agent;
}

/**
 * 这条通道走不走代理。优先级：通道的 `proxy` 字段 > 环境变量 HTTPS_PROXY。
 *
 * 返回 `source` 是刻意的：「到底走没走代理」如果不显形，排查时会变成
 * 「消息发不出去但看不出为什么」—— 这类静默失败本项目一律要求标出来。
 */
export function resolveProxy(ch) {
  if (ch?.proxy) return { url: String(ch.proxy), source: 'channel' };
  const env = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (env) return { url: String(env), source: 'env' };
  return null;
}

/** 有 agent 时改用 https 模块发（fetch 不接受 https.Agent，只接受 undici dispatcher） */
function httpsPostJson(target, payload, { agent, timeoutMs = 12000 } = {}) {
  const u = target instanceof URL ? target : new URL(String(target));
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        agent,
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          buf += c;
        });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(buf);
          else reject(new Error(`HTTP ${res.statusCode}：${buf.slice(0, 160)}`));
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时（${timeoutMs}ms）`)));
    req.on('error', reject);
    req.end(payload);
  });
}

async function postJson(url, body, timeoutMs = 12000, agent) {
  if (agent) return httpsPostJson(url, JSON.stringify(body), { agent, timeoutMs });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}：${text.slice(0, 160)}`);
  return text;
}

/**
 * 一个通道发一条消息。
 * @returns {{channel:string, ok:boolean, status?:number, error?:string, masked:string, skipped?:boolean}}
 */
export async function sendToChannel(ch, { title, body, text, events, summary }) {
  const name = ch?.type;
  if (!ch || !name) return { channel: '?', ok: false, error: '通道缺少 type', masked: '' };
  if (!CHANNELS[name]) return { channel: name, ok: false, error: `未知通道类型 ${name}`, masked: '' };

  if (name === 'console') {
    process.stdout.write(`\n[推送·控制台] ${title}\n${text}\n`);
    return { channel: name, ok: true, masked: '(本地标准输出)' };
  }

  let url;
  try {
    url = assertSafeWebhookUrl(ch.url, { allowPrivateTargets: Boolean(ch.allowPrivateTargets) });
  } catch (e) {
    return { channel: name, ok: false, error: e.message, masked: maskUrl(ch.url) };
  }
  const masked = maskUrl(ch.url);

  // 直连不可达的通道（Telegram）可以配 proxy。代理地址本身不合法时直接判
  // 这条通道失败，而不是静默退回直连 —— 否则现场表现是「莫名其妙的超时」。
  let agent;
  if (name === 'telegram') {
    const px = resolveProxy(ch);
    if (px) {
      try {
        agent = makeProxyAgent(px.url);
      } catch (e) {
        return { channel: name, ok: false, error: e.message, masked };
      }
    }
  }

  try {
    if (name === 'wecom') {
      // 企业微信群机器人：markdown 上限 4096 字节，超了要截断，否则整条发不出去
      const content = body.length > 3800 ? `${body.slice(0, 3800)}\n…（已截断）` : body;
      const out = await postJson(url, { msgtype: 'markdown', markdown: { content } });
      const j = safeJson(out);
      if (j && j.errcode) throw new Error(`企业微信返回 errcode=${j.errcode} ${j.errmsg || ''}`);
    } else if (name === 'dingtalk') {
      const out = await postJson(url, { msgtype: 'markdown', markdown: { title, text: body } });
      const j = safeJson(out);
      if (j && j.errcode) throw new Error(`钉钉返回 errcode=${j.errcode} ${j.errmsg || ''}`);
    } else if (name === 'bark') {
      await postJson(url, { title, body: text });
    } else if (name === 'telegram') {
      const chatId = String(ch.chatId ?? '').trim();
      if (!chatId) {
        throw new Error('telegram 通道缺少 chatId（私聊填数字 id，群/频道填 -100 开头的负数）');
      }
      // token 在路径里：https://api.telegram.org/bot<TOKEN>/sendMessage
      const endpoint = /\/sendMessage$/i.test(url.pathname)
        ? url
        : new URL(`${url.href.replace(/\/+$/, '')}/sendMessage`);

      // 用 text（纯文本）而不是 body（markdown）：MarkdownV2 的转义规则极严，
      // 正文里一个没转义的 _ 或 * 就让整条 400 发不出去。要富文本就显式配
      // parseMode 并自己保证转义 —— 默认宁可少点格式，也不要整条发不出去。
      const merged = title ? `${title}\n\n${text}` : text;
      const limit = 3900; // 官方上限是 4096「字符」（不是字节），留余量给截断标记
      const payload = {
        chat_id: chatId,
        text: merged.length > limit ? `${merged.slice(0, limit)}\n…（已截断）` : merged,
        disable_web_page_preview: true,
      };
      if (ch.parseMode) payload.parse_mode = String(ch.parseMode);

      let out;
      try {
        out = await postJson(endpoint, payload, 12000, agent);
      } catch (e) {
        // Telegram 的错误几乎都走非 2xx，人话在 body 里，翻出来再抛
        const friendly = telegramError(e?.message);
        throw friendly ? new Error(friendly) : e;
      }
      const j = safeJson(out);
      if (j && j.ok === false) {
        throw new Error(`Telegram 拒绝：${j.description || '未知原因'}`);
      }
    } else if (name === 'serverchan') {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ title, desp: body }).toString(),
        signal: AbortSignal.timeout(12000),
      });
      const out = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}：${out.slice(0, 160)}`);
      const j = safeJson(out);
      if (j && j.code && j.code !== 0) throw new Error(`Server 酱返回 code=${j.code} ${j.message || ''}`);
    } else if (name === 'generic') {
      await postJson(url, {
        title,
        text,
        markdown: body,
        summary: summary || null,
        events: (events || []).map((e) => ({
          kind: e.kind,
          severity: e.severity,
          family: e.family,
          rule: e.rule,
          coin: e.coin,
          title: e.title,
          detail: e.detail,
          at: e.at,
        })),
      });
    }
    return { channel: name, ok: true, masked };
  } catch (e) {
    return { channel: name, ok: false, error: String(e?.message || e), masked };
  }
}

/**
 * 把 postJson 抛出的 `HTTP 401：{"ok":false,...,"description":"..."}` 翻成人话。
 *
 * 为什么需要：Telegram 的错误（token 无效 / chat 不存在 / 被用户拉黑）**全是非 2xx**，
 * 状态码本身说明不了原因，真正有用的信息在 body 的 description 里。
 * 不解析它，用户只会看到「HTTP 400」然后不知道该改哪儿。
 * 解析不出 description 时返回 null —— 宁可原样抛出，也不要编一个理由。
 */
export function telegramError(raw) {
  const m = /^HTTP \d+：([\s\S]+)$/.exec(String(raw ?? ''));
  const j = m ? safeJson(m[1]) : null;
  if (j && j.description) {
    return `Telegram 拒绝：${j.description}${j.error_code ? `（错误码 ${j.error_code}）` : ''}`;
  }
  return null;
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * 按配置把一条消息发往所有通道。
 *
 * 关键取舍：**只要有一个通道成功就算发送成功**。多个通道之间是冗余关系而不是投票关系 ——
 * 企业微信挂了但 Bark 通了，消息就已经送到人手里了，不该因为一个通道失败就整体报错。
 */
export async function sendNotify(config, payload) {
  const list = Array.isArray(config?.channels) ? config.channels : [];
  const targets = list.length ? list : [{ type: 'console' }];
  const results = await Promise.all(targets.map((ch) => sendToChannel(ch, payload)));
  return {
    ok: results.some((r) => r.ok),
    results,
    delivered: results.filter((r) => r.ok).map((r) => r.channel),
    failed: results.filter((r) => !r.ok).map((r) => r.channel),
  };
}

/** 配置自检：把每个通道的地址格式与安全性过一遍，返回可读结论（不泄漏 token） */
export function inspectChannels(config) {
  const list = Array.isArray(config?.channels) ? config.channels : [];
  return list.map((ch) => {
    const base = { type: ch?.type, label: CHANNELS[ch?.type] || '未知类型', masked: maskUrl(ch?.url) };
    if (!ch?.type || !CHANNELS[ch.type]) return { ...base, ok: false, error: '通道类型未知' };
    if (ch.type === 'console') return { ...base, ok: true };
    try {
      assertSafeWebhookUrl(ch.url, { allowPrivateTargets: Boolean(ch.allowPrivateTargets) });
      if (ch.type === 'telegram') {
        if (!String(ch.chatId ?? '').trim()) return { ...base, ok: false, error: '缺少 chatId' };
        // 代理地址非法要在自检阶段就暴露，而不是等到真要推送时才炸
        const px = resolveProxy(ch);
        if (px) makeProxyAgent(px.url);
      }
      return { ...base, ok: true };
    } catch (e) {
      return { ...base, ok: false, error: e.message };
    }
  });
}
