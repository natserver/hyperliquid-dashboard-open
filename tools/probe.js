/**
 * Hyperliquid 接口探针 —— 不启动服务，直接打 API，把每个请求类型的真实响应结构打出来。
 *
 * 用途：写数据层之前先确认字段名。字段名靠猜的话，界面渲染出来全是 undefined。
 *
 *   node tools/probe.js                      # 用零地址探测「请求类型是否合法 + 空响应结构」
 *   node tools/probe.js 0x你的地址             # 用真实地址探测「真实数据长什么样」
 *   node tools/probe.js 0x地址 testnet        # 指定网络
 *
 * 设计要点：
 *   * 零地址探测是有效手段 —— 请求类型非法时 Hyperliquid 会直接返回错误，
 *     合法但无数据时返回空结构。两种响应能把「名字写错」和「本来就没数据」区分开。
 *   * 只读，不需要任何密钥。clearinghouseState 等接口是公开的。
 */
'use strict';

const NETWORKS = {
  mainnet: 'https://api.hyperliquid.xyz/info',
  testnet: 'https://api.hyperliquid-testnet.xyz/info',
};

const ZERO = '0x0000000000000000000000000000000000000000';

/** 探测清单：请求体 + 说明。user 字段由命令行参数注入。 */
function buildCases(user) {
  const now = Date.now();
  return [
    ['meta', { type: 'meta' }, '永续合约元数据（universe / szDecimals / maxLeverage）'],
    ['metaAndAssetCtxs', { type: 'metaAndAssetCtxs' }, '元数据 + 每个标的的行情（标记价/资金费/持仓量）'],
    ['allMids', { type: 'allMids' }, '全市场中间价'],
    ['candleSnapshot', { type: 'candleSnapshot', req: { coin: 'BTC', interval: '4h', startTime: now - 40 * 3600 * 1000, endTime: now } }, 'K 线'],
    ['clearinghouseState', { type: 'clearinghouseState', user }, '账户持仓 / 保证金 / 可提现'],
    ['spotClearinghouseState', { type: 'spotClearinghouseState', user }, '现货余额'],
    ['openOrders', { type: 'openOrders', user }, '挂单'],
    ['frontendOpenOrders', { type: 'frontendOpenOrders', user }, '挂单（含前端附加字段：触发条件、reduceOnly）'],
    ['userFills', { type: 'userFills', user }, '成交记录（最近 2000 笔）'],
    ['userFillsByTime', { type: 'userFillsByTime', user, startTime: now - 30 * 24 * 3600 * 1000, endTime: now }, '按时间区间取成交（分页用）'],
    ['portfolio', { type: 'portfolio', user }, '权益曲线 / 盈亏曲线（多时间尺度）'],
    ['userFunding', { type: 'userFunding', user, startTime: now - 30 * 24 * 3600 * 1000 }, '资金费流水'],
    ['userNonFundingLedgerUpdates', { type: 'userNonFundingLedgerUpdates', user, startTime: now - 30 * 24 * 3600 * 1000 }, '存取款 / 转账流水'],
    ['userFees', { type: 'userFees', user }, '手续费率与成交额统计'],
    ['userRole', { type: 'userRole', user }, '账户角色（是否做市商 / 金库）'],
    ['userRateLimit', { type: 'userRateLimit', user }, '地址级限流额度'],
    ['l2Book', { type: 'l2Book', coin: 'BTC' }, 'L2 订单簿'],
    ['fundingHistory', { type: 'fundingHistory', coin: 'BTC', startTime: now - 24 * 3600 * 1000 }, '资金费历史'],
  ];
}

/** 把一个响应压成「结构摘要」，避免把几千行 JSON 全打出来。 */
function shape(value, depth = 0, maxDepth = 3) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[] (空)';
    const inner = depth >= maxDepth ? '…' : shape(value[0], depth + 1, maxDepth);
    return `Array(${value.length}) of ${inner}`;
  }
  const t = typeof value;
  if (t === 'object') {
    if (depth >= maxDepth) return '{…}';
    const keys = Object.keys(value);
    if (keys.length === 0) return '{} (空)';
    const body = keys.slice(0, 12).map((k) => `${k}: ${shape(value[k], depth + 1, maxDepth)}`).join(', ');
    return `{ ${body}${keys.length > 12 ? `, …共${keys.length}个键` : ''} }`;
  }
  if (t === 'string') return JSON.stringify(value.length > 22 ? value.slice(0, 22) + '…' : value);
  return String(value);
}

/** 取一个有代表性的样本做展示，避免第一个元素恰好是空壳。 */
function sample(v) {
  if (!Array.isArray(v)) return v;
  if (v.length === 0) return v;
  return v.find((x) => x && typeof x === 'object' && Object.keys(x).length > 0) || v[0];
}

async function probe(baseUrl, name, body) {
  const t0 = Date.now();
  let res, text;
  try {
    res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    text = await res.text();
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, note: `网络错误: ${e.message}` };
  }
  const ms = Date.now() - t0;
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, ms, note: `非 JSON 响应 (HTTP ${res.status}): ${text.slice(0, 160)}` };
  }
  // Hyperliquid 对非法请求类型会返回 200 + 一条错误消息
  const errMsg =
    json && typeof json === 'object' && !Array.isArray(json) && typeof json.error === 'string'
      ? json.error
      : typeof json === 'string'
      ? json
      : null;
  if (errMsg) return { ok: false, ms, note: `接口拒绝: ${errMsg}` };
  return { ok: true, ms, json };
}

async function main() {
  const argUser = process.argv[2];
  const network = (process.argv[3] || 'mainnet').toLowerCase();
  const baseUrl = NETWORKS[network];
  if (!baseUrl) {
    console.error(`未知网络: ${network}（可选 mainnet / testnet）`);
    process.exit(1);
  }
  const user = argUser || ZERO;
  const isReal = Boolean(argUser);

  console.log('='.repeat(78));
  console.log(`Hyperliquid 接口探针    网络=${network}    地址=${user}`);
  console.log(isReal ? '模式：真实地址探测' : '模式：零地址探测（只验证请求类型合法性与空响应结构）');
  console.log('='.repeat(78));

  for (const [name, body, desc] of buildCases(user)) {
    const r = await probe(baseUrl, name, body);
    console.log(`\n── ${name}  [${r.ms}ms]  ${desc}`);
    if (!r.ok) {
      console.log(`   ✗ ${r.note}`);
      continue;
    }
    const j = r.json;
    const empty = (Array.isArray(j) && j.length === 0) || (typeof j === 'object' && j && Object.keys(j).length === 0);
    if (empty) {
      console.log('   ○ 请求合法，但该地址无数据');
      if (Array.isArray(j)) console.log('     形状: []');
      else console.log('     形状:', shape(j));
      continue;
    }
    console.log('   ✓', shape(sample(j)));
  }

  console.log('\n' + '='.repeat(78));
  console.log('提示：真实数据需要传自己的主账户地址（不是 API Wallet 地址）。');
  console.log('     用 API Wallet 地址查询会返回空 —— 这是最常见的坑。');
}

main().catch((e) => {
  console.error('探针异常:', e);
  process.exit(1);
});
