/**
 * 结构深挖 —— 把某个请求类型的完整响应结构展开成缩进树，用于确认字段名。
 *
 *   node tools/shape.js metaAndAssetCtxs
 *   node tools/shape.js portfolio 0x地址
 *   node tools/shape.js clearinghouseState 0x地址 testnet
 *
 * 与 probe.js 的分工：probe 负责「哪些接口能用」，shape 负责「字段到底叫什么」。
 * 字段名猜错是这类对接最常见的返工来源，所以单独做成一个可复用工具。
 */
'use strict';

const NETWORKS = {
  mainnet: 'https://api.hyperliquid.xyz/info',
  testnet: 'https://api.hyperliquid-testnet.xyz/info',
};

const ZERO = '0x0000000000000000000000000000000000000000';
const now = Date.now();

/** 内置几个常用请求体模板，方便直接调用 */
const PRESETS = {
  meta: () => ({ type: 'meta' }),
  metaAndAssetCtxs: () => ({ type: 'metaAndAssetCtxs' }),
  allMids: () => ({ type: 'allMids' }),
  clearinghouseState: (u) => ({ type: 'clearinghouseState', user: u }),
  spotClearinghouseState: (u) => ({ type: 'spotClearinghouseState', user: u }),
  portfolio: (u) => ({ type: 'portfolio', user: u }),
  userFills: (u) => ({ type: 'userFills', user: u }),
  openOrders: (u) => ({ type: 'openOrders', user: u }),
  frontendOpenOrders: (u) => ({ type: 'frontendOpenOrders', user: u }),
  userFunding: (u) => ({ type: 'userFunding', user: u, startTime: now - 30 * 24 * 3600 * 1000 }),
  userNonFundingLedgerUpdates: (u) => ({ type: 'userNonFundingLedgerUpdates', user: u, startTime: now - 90 * 24 * 3600 * 1000 }),
  userFees: (u) => ({ type: 'userFees', user: u }),
  userRateLimit: (u) => ({ type: 'userRateLimit', user: u }),
  userRole: (u) => ({ type: 'userRole', user: u }),
  candleSnapshot: () => ({ type: 'candleSnapshot', req: { coin: 'BTC', interval: '4h', startTime: now - 3 * 86400000, endTime: now } }),
  l2Book: () => ({ type: 'l2Book', coin: 'BTC' }),
  fundingHistory: () => ({ type: 'fundingHistory', coin: 'BTC', startTime: now - 86400000 }),
  vaultDetails: (u) => ({ type: 'vaultDetails', vaultAddress: u }),
};

function render(value, depth = 0, key = '', maxDepth = 6) {
  const pad = '  '.repeat(depth);
  if (value === null) return `${pad}${key}null`;
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}${key}[]  空数组`;
    const head = `${pad}${key}Array(${value.length})`;
    if (depth >= maxDepth) return `${head} …`;
    // 短数组（如 metaAndAssetCtxs 的 [meta, ctxs]、portfolio 的 [period, data]）
    // 每个元素都展开 —— 这些数组的不同位置装的是不同东西，只看 [0] 会漏掉关键结构。
    if (value.length <= 3) {
      return head + '\n' + value.map((v, i) => render(v, depth + 1, `[${i}] `, maxDepth)).join('\n');
    }
    // 长数组只展开第一个元素，避免 234 个标的全打出来
    const first = render(value[0], depth + 1, '[0] ', maxDepth);
    const extra = `\n${pad}  …另有 ${value.length - 1} 个同构元素`;
    return `${head}\n${first}${extra}`;
  }
  const t = typeof value;
  if (t === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return `${pad}${key}{}  空对象`;
    const head = `${pad}${key}{}`;
    if (depth >= maxDepth) return `${head} …${keys.length}键`;
    const body = keys.map((k) => render(value[k], depth + 1, `${k}: `, maxDepth)).join('\n');
    return `${pad}${key}\n${body}`;
  }
  if (t === 'string') return `${pad}${key}string = ${JSON.stringify(value)}`;
  if (t === 'number') return `${pad}${key}number = ${value}`;
  return `${pad}${key}${t} = ${value}`;
}

async function main() {
  const type = process.argv[2];
  const user = process.argv[3] || ZERO;
  const network = (process.argv[4] || 'mainnet').toLowerCase();

  if (!type || !PRESETS[type]) {
    console.error(`用法: node tools/shape.js <类型> [地址] [mainnet|testnet]`);
    console.error(`可用类型: ${Object.keys(PRESETS).join(', ')}`);
    process.exit(1);
  }
  const baseUrl = NETWORKS[network];
  if (!baseUrl) {
    console.error(`未知网络: ${network}`);
    process.exit(1);
  }

  const body = PRESETS[type](user);
  console.log(`POST ${baseUrl}`);
  console.log(JSON.stringify(body));
  console.log('-'.repeat(70));

  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json();
  console.log(render(json));
}

main().catch((e) => {
  console.error('异常:', e);
  process.exit(1);
});
