/**
 * 比特皇方向判据层（A4~A7）
 * ══════════════════════════════════════════════════════════════════════
 *
 * 这一节把《比特皇精华总结》《比特皇语录》《比特皇交易记录整理》
 * 《交易心得 / 交易策略》里**所有关于「判断大方向」的原话**，逐条落成
 * 可回测的检查，并保留每条判据到原话的追溯链。
 *
 * 为什么单独成层，而不是塞进 regime.js 的 A2 四分量：
 *   1. A2 的权重经过回测校准。把新判据硬塞进去会改动已校准的行为，
 *      而「这次回测结果变了是因为权重动了还是因为判据变了」将无法回答。
 *   2. 分层之后每条判据都有自己的出处、阈值、可用性判定。
 *      判据缺失时明确**弃权**，而不是静默变成 0 分。
 *
 * 最危险的失败模式是「假装中性」：
 *   如果资金费历史拉不到、成交量全为 0、事件表没维护，而这些层悄悄输出 0 分，
 *   系统会看起来「所有判据都看过了、都没有异议」—— 这比明确报错危险得多。
 *   所以每一层都有 available 字段，缺失时下游必须把它当成弃权处理。
 *
 * 无状态：与 regime.js 一样是纯函数，可逐日回放。
 *
 * ── 判据来源原文（全部逐字摘录，便于对账） ──────────────────────────
 *
 * ① 确认趋势（《比特皇精华总结》一、交易系统）
 *    「确认趋势：基本面（市场热点）和技术面结合定方向。」
 *    「比特皇的 7 笔盈利交易中，有 6 笔都有极其明显的市场热点，而有 5 笔
 *      都跟比特币的减半有关……如果想通过做多挣钱，请耐心等待跟减半相关的
 *      热点出现。如果没有市场热点的推动，行情的波动性和持久性都会弱很多。」
 *    「在比特币减半的大前提下，如果出现了情绪极度恐慌、散户全面做空、
 *      多头大量爆仓的情况，则是多头入场的绝佳机会。反之空头同理。」
 *    「如果说基本面可以判断市场行情的大方向，技术面则可以告诉我们行情开启的时间。」
 *
 * ② 趋势与反转信号（《交易心得》1. 关于趋势判断）
 *    「利空不跌，见底信号。利多不涨，见顶信号。」
 *    「市场的下跌持续一段时间，出现交易量暴增，做多信号。
 *      市场的上涨持续一段时间出现交易量暴涨，意味着见顶。」
 *    「媒体的态度：当所有人都非常乐观……当所有媒体都一片悲观的时候
 *      意味着熊市也走到头了。」（→ 无接口，走事件表手工维护）
 *    「牛转熊的信号之一：市场主要股票进行 6% 的下跌，并且几个月都无法突破新高。」
 *
 * ③ 筑底形态（《比特皇语录》23）
 *    「观察图 1 中 ABC 下跌的斜率和成交量，得到的信息是下跌势能逐渐放缓，
 *      成交量逐渐减少，像筑底的形态。」
 *
 * ④ 均线与牛熊分界（《比特皇语录》3、22）
 *    「就拿最强势的 bch 来讲，都迟迟站不上 120 日线，主流技术面来讲确实
 *      走的很难看了。」
 *    「如果说 BTC 14000 刀算牛熊分界线的话……」
 *
 * ⑤ 多空博弈（《比特皇语录》8、14；《交易心得》）
 *    「多头趋势行情中摸顶空和空头趋势行情中抄底多，这是交易的大忌，
 *      不要和趋势做对。」
 *    「横盘震荡的时候就像是掰手腕……直到等到胜负已分的那一刻立马杀进去。」
 *    「利用头仓试错，头仓开小点，如果头仓盈利继续加仓，头仓损掉及时调转。」
 *    「只做日线级别趋势行情（波动＞30%），不做日内短线，不做震荡行情。」
 *    「要相信自己的眼睛，而不要相信自己的脑筋。」（只看 K 线）
 */

/**
 * 这里刻意**不** import regime.js 的 BIAS —— regime.js 要 import 本文件，
 * 互相 import 会形成循环依赖。ESM 虽然能靠 live binding 撑住（只要不在
 * 模块求值期访问），但这种「恰好能跑」的耦合一旦有人在顶层用一下就会炸，
 * 而且报错信息会是 TDZ 而不是「循环依赖」。方向枚举只有三个取值，
 * 字面量重复一次的代价远小于一个偶发的启动期神秘错误。
 * 两边取值一致性由 tools/regime-check.js 的断言锁死。
 */
const LONG_ONLY = 'LONG_ONLY';
const SHORT_ONLY = 'SHORT_ONLY';
const NEUTRAL = 'NEUTRAL';

const MS_PER_DAY = 86400000;
const DAYS_PER_MONTH = 30.44;

/* ══════════════════ 判据注册表 ══════════════════ */

/**
 * 三阶段划分 —— 这是比特皇自己给的框架，不是我们的发明。
 *
 *   「如果说基本面可以判断市场行情的大方向，技术面则可以告诉我们行情开启的时间。」
 *                                        —— 《比特皇精华总结》一、确认趋势
 *
 * 所以系统严格分三段，每段的职责互不越界：
 *
 *   阶段一 · 基本面   →  **往哪个方向**        （本文件 stage:1 的判据）
 *   阶段二 · 技术面   →  **什么时候扣扳机**    （本文件 stage:2 的判据）
 *   阶段三 · 持仓管理 →  **进去之后怎么办**    （本文件 stage:3 的判据）
 *
 * 为什么必须分清：方向判据和时机判据混在一起，会导致「方向对但位置错」
 * 这类错误无法被定位 —— 而比特皇的回撤几乎全部来自这一类错误
 * （见《实盘交易记录》：「策略没问题，但是回撤亏损」）。
 *
 * stage: 0 表示**全局约束** —— 它不是某一阶段的判据，而是所有阶段都要遵守的
 * 方法论红线（例如「只看 K 线，不相信脑筋」）。
 */

/**
 * 比特皇方向判据总表 —— 界面、文档、测试三处都从这里派生。
 *
 * implemented 的三种取值必须诚实：
 *   true      —— 已经在代码里跑起来，能用真实数据验证
 *   'partial' —— 只落了能做到的那部分，剩下的部分是主观判断，拒绝做成参数
 *   false     —— 没有可靠数据源，只能走事件表手工维护（manual=true）
 *
 * origin 同样必须诚实，这是这张表最重要的一个字段：
 *   'bithuang' —— 比特皇原话，quote 里逐字摘录
 *   'system'   —— **本系统的补充判据**，比特皇没有说过
 *
 * 为什么要有 origin：把「我们自己加的东西」和「比特皇说过的话」混在一起展示，
 * 读的人会以为全都是他的想法。200 周均线四分量加权就是本系统自己加的
 * （比特皇只点名过 120 日线），它必须自己承认这一点。
 *
 * 「没做就是没做」比「做了个假的」重要。把主观判断硬编码成权重，
 * 等于把「比特皇更喜欢做多」这种模糊偏好变成一条看起来精确的规则 —— 那是自欺。
 */
export const DIRECTION_CRITERIA = [
  /* ═══════════════════════════════════════════════════════════════
   * 阶段一 · 基本面 —— 决定「往哪个方向」
   *
   * 这一段的判据只回答一个问题：现在这个大方向是什么。
   * 它**不看**入场点，也**不看**仓位大小 —— 那些是阶段二、三的事。
   * ═══════════════════════════════════════════════════════════════ */

  /* ── 一、周期热点（比特皇盈利的最大来源） ── */
  {
    id: 'halving-hotspot', group: '周期热点', stage: 1, layer: 'A1', implemented: true, origin: 'bithuang',
    quote: '7 笔盈利交易中 6 笔有极其明显的市场热点，5 笔跟减半有关……请耐心等待跟减半相关的热点出现。',
    source: '《比特皇精华总结》一、确认趋势',
    rule: '减半时钟：只在减半相关的相位窗口内批准顺势开仓，其余时间双向不批。',
  },
  {
    id: 'halving-peak-12-18m', group: '周期热点', stage: 1, layer: 'A1', implemented: true, origin: 'bithuang',
    quote: '比特币在减半后 12-18 个月达到价格峰值。',
    source: '《交易心得》2025-02 预期段',
    rule: '峰值中位数（历史 12.2/17.3/18.0/18.5 个月）写入相位表：15~24 个月为 BLOWOFF，intent=NEUTRAL。',
  },
  {
    id: 'hotspot-required', group: '周期热点', stage: 1, layer: 'A1', implemented: true, origin: 'bithuang',
    quote: '如果没有市场热点的推动，行情的波动性和持久性都会弱很多。',
    source: '《比特皇精华总结》一、确认趋势',
    rule: '不在任何热点窗口内时，方向层输出 NEUTRAL（宁可空仓等热点，也不在无热点时找入场点）。第九笔、第十笔两笔翻倍交易都发生在减半热点窗口内。',
  },

  /* ── 二、情绪与消息反应（见底/见顶的反向信号） ── */
  {
    id: 'extreme-fear-contrarian', group: '情绪与消息', stage: 1, layer: 'A5+A6', implemented: true, origin: 'bithuang',
    quote: '在比特币减半的大前提下，如果出现了情绪极度恐慌、散户全面做空、多头大量爆仓的情况，则是多头入场的绝佳机会。反之空头同理。',
    source: '《比特皇精华总结》一、确认趋势',
    rule: '资金费率极端化（散户拥挤度代理）+ 投降式放量 → 反向机会信号。必须叠加「价格已止跌」，否则下跌初段会把「还在创新低」误读成底部。',
  },
  {
    id: 'headline-not-moving', group: '情绪与消息', stage: 1, layer: 'A7', implemented: true, origin: 'bithuang',
    quote: '利空不跌，见底信号。利多不涨，见顶信号。',
    source: '《交易心得》1. 关于趋势判断',
    rule: '事件反应检验：负面事件后 N 天价格没跌 → 见底证据；正面事件后没涨 → 见顶证据。带前视偏差防护（观察窗口未走完的事件不参与判定）。',
  },
  {
    id: 'media-extreme', group: '情绪与消息', stage: 1, layer: '—', implemented: true,
    dataSource: 'src/macro-sources.js', manual: true, origin: 'bithuang',
    quote: '当所有人都非常乐观意味着完全不懂的人也可能对股票产生了兴趣，当最后一个悲观者也变成了乐观者牛市也走到头了。当所有媒体都一片悲观的时候意味着熊市也走到头了。',
    source: '《交易心得》1. 关于趋势判断',
    rule:
      '数据源：alternative.me 加密恐慌与贪婪指数（免费无密钥）。0=极度恐慌 / 100=极度贪婪。≥75 视为"最后一个悲观者也变成乐观者" → 反向警示；≤25 视为"所有媒体都一片悲观" → 反向机会。读数与出处见 src/macro-sources.js。',
  },

  /* ── 三、宏观基本面（比特皇 2025-02 给出的明确门槛） ── */
  {
    id: 'etf-netflow', group: '宏观基本面', stage: 1, layer: '—', implemented: true,
    dataSource: 'src/macro-sources.js', manual: true, origin: 'bithuang',
    quote: '首要信号：若比特币 ETF 连续 3 日净流入超 2 亿美元，且价格突破 10.3 万美元，可确认短期上涨趋势启动。',
    source: '《交易心得》2025-02 首要信号',
    rule:
      '数据源：Farside Investors 日度净流入表（经 r.jina.ai 读取，回落到 CC0 归档）。逐项判断"连续 3 个交易日净流入均 > 2 亿美元"，并同时要求价格 > 10.3 万 —— 两个条件都成立才确认短期上涨趋势启动。只作加分项，不作否决项。',
  },
  {
    id: 'onchain-activity', group: '宏观基本面', stage: 1, layer: '—', implemented: true,
    dataSource: 'src/macro-sources.js', manual: true, origin: 'bithuang',
    quote: '中期确认：需同时满足链上活跃地址数增长（周环比 +5% 以上）……',
    source: '《交易心得》2025-02 中期确认',
    rule:
      '数据源：Blockchain.com 链上唯一地址数（免费无密钥）。取最近 7 日均值对比前 7 日均值算周环比，≥ +5% 才算中期确认。用 7 日均值而非单日，是因为单日噪声足以淹没信号。',
  },
  {
    id: 'liquidity-macro', group: '宏观基本面', stage: 1, layer: '—', implemented: true,
    dataSource: 'src/macro-sources.js', manual: true, origin: 'bithuang',
    quote: '……DXY 回落至 103 以下，以及美联储释放降息信号。',
    source: '《交易心得》2025-02 中期确认',
    rule:
      '数据源：Yahoo Finance 的 DXY 日线 + FRED（无需密钥）的 DFEDTARU / DGS2。判据是**中期确认的必要条件**，比特皇用的是「需同时满足」：DXY 必须回落到 103 下方，且美联储须有降息信号（政策利率最近一次变动为下调，或 2 年期美债收益率走低）。两个条件缺一不成立。',
  },
  {
    id: 'institutional-holding', group: '宏观基本面', stage: 1, layer: '—', implemented: true,
    dataSource: 'src/macro-sources.js', manual: true, origin: 'bithuang',
    quote: '长期支撑：监管政策落地（如 SEC 框架出台）、机构持仓占比突破 5%（当前约 3.5%）。',
    source: '《交易心得》2025-02 长期支撑',
    rule:
      '数据源：iShares（贝莱德）官方日度持仓文件 + Blockchain.com 流通量。口径是"美国现货 BTC ETF 合计持有量 ÷ BTC 流通量"，门槛 5%。注意：只有 IBIT 的发行人页面可被自动读取，其余发行人拒绝自动化请求，所以算出的是**下界**。这是长周期支撑项，不是择时项。',
  },
  {
    id: 'regulation-policy', group: '宏观基本面', stage: 1, layer: '—', implemented: true,
    dataSource: 'src/macro-sources.js', manual: true, origin: 'bithuang',
    quote: '风险提示：若 ETF 资金流出、DXY 持续走强或监管政策反复（如 SEC 起诉矿企案例增加），可能中断趋势。',
    source: '《交易心得》2025-02 风险提示',
    rule:
      '数据源：SEC / CFTC 官方新闻 RSS（政府部门公开信息，免费无密钥）为主，CoinDesk RSS 仅作旁证。按关键词抽取加密相关条目并分正负：官方执法条目累积 → 「监管政策反复」（风险提示）；官方出现框架/豁免类条目 → 「监管政策落地」（长期支撑）。两者都报，不单向解读。与黑天鹅通道的区别：这条是**渐变型**风险（多次起诉累积），黑天鹅是**突发型**。',
  },
  {
    id: 'macro-event-layer', group: '宏观基本面', stage: 1, layer: 'A3', implemented: true, origin: 'bithuang',
    quote: '第一笔：基本面 LTC 减半、交易所 IEO。第二笔：政府发文严禁投机。第三笔：减半预期炒作。第四笔：全球疫情、美国连续熔断。第七笔：机构入场、灰度解锁盘。',
    source: '《交易心得》跟着比特皇操作盈利 1 亿步骤（逐笔基本面）',
    rule: '大事件层：每条事件带权重与半衰期（默认 100 天），净权重作为方向修正项；黑天鹅事件走一票否决通道强制 NEUTRAL。',
  },

  /* ── 四、量能（比特皇把它归在「趋势判断」里） ── */
  {
    id: 'volume-capitulation', group: '量能', stage: 1, layer: 'A6', implemented: true, origin: 'bithuang',
    quote: '市场的下跌持续一段时间，出现交易量暴增，做多信号。',
    source: '《交易心得》1. 关于趋势判断',
    rule: '处于下跌段（现价低于 N 日前）且当日量 ≥ 回看窗口 90 分位 → 投降式放量，投多。',
  },
  {
    id: 'volume-blowoff-top', group: '量能', stage: 1, layer: 'A6', implemented: true, origin: 'bithuang',
    quote: '市场的上涨持续一段时间出现交易量暴涨，意味着见顶。',
    source: '《交易心得》1. 关于趋势判断',
    rule: '处于上涨段且当日量 ≥ 回看窗口 90 分位 → 顶部放量，投空并触发顶部刹车。',
  },
  {
    id: 'volume-dry-bottom', group: '量能', stage: 1, layer: 'A6', implemented: true, origin: 'bithuang',
    quote: '观察图 1 中 ABC 下跌的斜率和成交量，得到的信息是下跌势能逐渐放缓，成交量逐渐减少，像筑底的形态。',
    source: '《比特皇语录》23',
    rule: '下跌段 + 跌速放缓（后段跌幅 < 前段）+ 均量递减 → 筑底形态，投多（弱，票权 0.5）。',
  },

  /* ── 五、中期趋势分界（比特皇唯一点名过的均线） ── */
  {
    id: 'ma120-filter', group: '中期趋势', stage: 1, layer: 'A4', implemented: true, origin: 'bithuang',
    quote: '就拿最强势的 bch 来讲，都迟迟站不上 120 日线，主流技术面来讲确实走的很难看了。',
    source: '《比特皇语录》22',
    rule: '价格 vs 120 日均线 —— 比特皇唯一点名过的中期均线，作为方向层的独立投票。',
  },
  {
    id: 'bear-market-signal', group: '中期趋势', stage: 1, layer: 'A4', implemented: true, origin: 'bithuang',
    quote: '牛转熊的信号之一：市场主要股票进行 6% 的下跌，并且几个月都无法突破新高。',
    source: '《交易心得》6',
    rule: '距历史最高回撤超阈值 且 连续 N 个月未创新高 → 牛转熊确认。只在减半后 ≥15 个月才计票，否则「久未创新高」是上一轮熊市的遗留，必然误报。',
  },
  {
    id: 'bull-bear-line', group: '中期趋势', stage: 1, layer: 'A4', implemented: true, origin: 'bithuang',
    quote: '如果说 BTC 14000 刀算牛熊分界线的话……',
    source: '《比特皇语录》3',
    rule: '分界线不写死价格（每轮不同，写死必然失效）。改用等价表达：距历史最高回撤分档 + 未创新高月数。',
  },
  {
    id: 'longterm-structure', group: '中期趋势', stage: 1, layer: 'A1+A2', implemented: true, origin: 'system',
    quote: '（本系统补充 —— 比特皇没有说过 200 周均线四分量加权）',
    source: '本系统设计，非比特皇原话',
    rule: '200 周均线(2.0) + 200 日均线(1.0) + 200 日均线斜率(1.0) + 月线结构(1.5) 四分量加权归一化，是方向层唯一有权推翻周期相位的地方。**标为 system 是刻意的**：比特皇只点名过 120 日线，这套加权是工程补充。',
  },

  /* ═══════════════════════════════════════════════════════════════
   * 阶段二 · 技术面 —— 决定「什么时候扣扳机」
   *
   * 这一段的判据消费阶段一给出的方向，只回答「时分秒到了没」。
   * 它**不主张**方向：即使触发再漂亮，方向层不批就一律 VETOED。
   * ═══════════════════════════════════════════════════════════════ */

  {
    id: 'breakout-three-legs', group: '入场形态', stage: 2, layer: '系统二', implemented: true, origin: 'bithuang',
    quote: '价格连续 3 次有效突破 BOLL 上轨并站稳 → 大概率多头趋势开启。',
    source: '《比特皇精华总结》交易系统（4H 级别）',
    rule: '「3 次突破」数的是**3 条独立推进腿**（两腿之间必须至少收回轨内 1 根），不是连续 3 根收在轨外。一条长阳连续收在轨外 4 根只算 1 条腿 —— 这是本系统最重要的一处口径修正。',
  },
  {
    id: 'hold-above-band', group: '入场形态', stage: 2, layer: '系统二', implemented: true, origin: 'bithuang',
    quote: '……并站稳。',
    source: '《比特皇精华总结》交易系统（4H 级别）',
    rule: '站稳分三级：H0 已收回轨内（失败）/ H1 在轨外但不足 N 根（待确认）/ H2 连续 N 根在轨外（确认）。只有 H2 允许开单。',
  },
  {
    id: 'squeeze-then-expand', group: '入场形态', stage: 2, layer: '系统二', implemented: true, origin: 'bithuang',
    quote: '横盘震荡的时候就像是掰手腕……直到等到胜负已分的那一刻立马杀进去。',
    source: '《比特皇语录》14',
    rule: '收口条件：量的是**第一条推进腿之前**那根的带宽百分位（≤25 分位），不是当前这根 —— 当前带宽必然已被突破拉大，用它判定等于永远不成立。',
  },
  {
    id: 'pullback-to-mid', group: '入场形态', stage: 2, layer: '系统二', implemented: true, origin: 'bithuang',
    quote: '多头趋势：4H BOLL 中轨支撑回调入场；空头趋势：上轨/中轨压力入场。强势不回调时分批建仓：突破时买 30%，回调时买 70%（不踏空也不追高满仓）。',
    source: '《比特皇精华总结》入场位置 / bithuang-ai-trader STRATEGY.md',
    rule: '两种入场模式：BREAKOUT（突破即入）与 PULLBACK（回踩中轨不破、重新收在轨外才入）。回调价 = 中轨 ± buffer，止损锚跟着挪到结构位外侧。',
  },
  {
    id: 'key-level-break', group: '入场形态', stage: 2, layer: '系统二', implemented: true, origin: 'bithuang',
    quote: '突破关键压力位做多，突破支撑位置做空。（利弗莫尔策略二）确定趋势。查看关键支撑和突破位置。（交易策略 1）',
    source: '《交易心得》第一个策略 / 《交易策略》1',
    rule: '开单计划里给出的止损锚与止盈投影都锚在**K 线自己算出的**关键位（轨道 / 中轨 / 区间极值）上，不接受外部传入的目标价。',
  },
  {
    id: 'probe-with-head-position', group: '入场形态', stage: 2, layer: '系统二', implemented: true, origin: 'bithuang',
    quote: '利用头仓试错，头仓开小点，如果头仓盈利继续加仓，头仓损掉及时调转。',
    source: '《交易心得》1. 关于趋势判断',
    rule: '开单计划拆成两笔：头仓（突破批次，默认 30%）先试，主仓（回调批次，默认 70%）等回踩确认。头仓止损即整套作废 —— 这就是「损掉及时调转」的落实。',
  },
  {
    id: 'break-fail-then-flip', group: '入场形态', stage: 2, layer: '系统二', implemented: true, origin: 'bithuang',
    quote: '突破关键位置开单。突破后回撤回去立马止损。再次突破再次开单。（大作手操盘术 1）',
    source: '《交易心得》大作手操盘术',
    rule: '止损锚定在突破参考位外侧（默认 0.30% 缓冲），价格收回轨内即止损。推进腿计数保留，再次突破仍可再开 —— 不做「亏了就再也不碰」的一刀切。',
  },
  {
    id: 'trend-only-daily-30pct', group: '空间门槛', stage: 2, layer: '系统二', implemented: true, origin: 'bithuang',
    quote: '只做日线级别趋势行情（波动＞30%），不做日内短线，不做震荡行情，也不傻傻屯币。',
    source: '《比特皇精华总结》交易总结 3',
    rule: '由相位空间门槛（筑底 16% / 单边下跌 20% / 扩张 25% / 冲顶 35%）落实：K 线量出的区间投影必须超过门槛才开单。空间不够就不做，这是「不做震荡行情」的量化形式。',
  },
  {
    id: 'range-no-trade', group: '空间门槛', stage: 2, layer: '系统二', implemented: true, origin: 'bithuang',
    quote: '震荡行情中依然坚守趋势策略，并严格止损，耐心等待趋势到来。',
    source: '《交易心得》第二笔交易解读',
    rule: '量能枯竭的横盘段 → 本层量能判据弃权；方向层不据此表态。第二笔交易（2019-06~2019-12 宽幅震荡）正是「不断止损、耐心等待」的样本：亏 44% 也没破坏系统。',
  },

  /* ═══════════════════════════════════════════════════════════════
   * 阶段三 · 持仓管理 —— 决定「进去之后怎么办」
   *
   * 这一段的判据只在**已经有持仓**时才有意义。
   * 全部围绕三件事：止损放哪、什么时候加、什么时候走。
   * ═══════════════════════════════════════════════════════════════ */

  {
    id: 'stop-at-structure', group: '止损', stage: 3, layer: '系统二', implemented: true, origin: 'bithuang',
    quote: '单次止损 ≤ 总资金 5%；做错绝不扛单，立即止损。做错方向，绝不扛单，做错不可怕，归零最可怕。',
    source: '《比特皇精华总结》止盈止损 / 《交易心得》第二笔交易解读',
    rule: '止损候选五个（中轨 / 轨道极值 / 保本 / 距离上限 / 风险预算），推荐位取「通过全部约束且最贴近结构」的那一个；风险预算上限 5% 权益为**硬上限不可提高**。',
  },
  {
    id: 'profit-add-only', group: '加仓', stage: 3, layer: '系统二', implemented: true, origin: 'bithuang',
    quote: '只能盈利加仓，亏损不要加仓拉均价。最愚蠢的行为：卖掉盈利的持仓，买进亏损的持仓拉均价。',
    source: '《交易心得》1. 关于趋势判断 / 2. 最愚蠢的行为',
    rule: '加仓前置条件：未实现盈亏 > 0 且浮盈 ≥ pyramidTriggerBps。亏损状态下滚仓阶梯一律不给（不是提示，是不输出）。',
  },
  {
    id: 'add-on-pullback-resume', group: '加仓', stage: 3, layer: '系统二', implemented: true, origin: 'bithuang',
    quote: '浮盈加仓，是回撤在起势的时候加仓，让起势飞一会不要怕加晚。',
    source: '《交易心得》跟着比特皇操作盈利 1 亿步骤 · 第二步',
    rule: '加仓时机 = 浮盈达标 **且** 经历了一次回撤 **且** 重新起势（回撤后当前收盘重新站上回撤前的高点/创出新高）。只判「浮盈≥5%」会把追高也算进去 —— 比特皇要的是「起势」，不是「涨了很多」。',
  },
  {
    id: 'pyramid-decreasing', group: '加仓', stage: 3, layer: '系统二', implemented: true, origin: 'bithuang',
    quote: '先拿 500 美金，在比特币 5000 美开 20 倍多，然后，价格涨了，在加 500 美金，而不是平仓，然后继续涨继续加。',
    source: '《交易心得》第一笔交易',
    rule: '加仓量按初始量逐级减半（50% → 25% → 12.5%）—— 加得越晚，风险敞口增得越少。每次加仓后止损上移到新成本的保本位（只允许朝有利方向移动）。',
  },
  {
    id: 'scale-down-leverage', group: '加仓', stage: 3, layer: '系统二', implemented: true, origin: 'bithuang',
    quote: '加仓同时降低杠杆，资金量越大杠杆越低。开空更加谨慎，倍数更低。',
    source: '《交易心得》第一步~第三步 / 第四笔交易',
    rule: '杠杆档位随权益递减（<1万U:10x / 1-30万U:5x / >30万U:3x）；每一级滚仓后都报出 leverageAfter，超过配置上限即告警。做空没有对应加成 —— 比特皇明确说开空更谨慎。',
  },
  {
    id: 'no-fixed-takeprofit', group: '止盈', stage: 3, layer: '系统二', implemented: true, origin: 'bithuang',
    quote: '持仓到趋势结束。盈利多少是市场决定的并不是个人能力决定的。利润不要吃顶部和底部。',
    source: '《交易策略》7 / 《交易心得》2. 最愚蠢的行为 / 1. 关于趋势判断',
    rule: '不设固定止盈（takeProfitBps 默认 0）。给出的是参考位：区间等幅投影 + 1R/2R/3R，真正离场看趋势破坏信号。',
  },
  {
    id: 'exit-on-failed-bounce', group: '止盈', stage: 3, layer: '系统二', implemented: true, origin: 'bithuang',
    quote: '永远不要在最高点卖出，而是等到价格调整后没有反弹再卖出。你不需要和股市的任何一边牢牢绑定。',
    source: '《交易心得》4. 下跌趋势下',
    rule: '离场信号两条：① 收盘跌破中轨（趋势破坏）；② **回调后未反弹** —— 自近期高点回撤超过阈值，且在 N 根内没有收复回撤的一半，才判定为「调整后没有反弹」。这一条替代「手动猜顶」。',
  },
  {
    id: 'exit-on-bad-news', group: '止盈', stage: 3, layer: '系统二', implemented: true, origin: 'bithuang',
    quote: '下跌趋势下，有一个重大利空新闻马上平仓，防止回撤利润。',
    source: '《交易心得》4. 下跌趋势下',
    rule: '持仓期间若事件表里出现权重超过阈值的负面事件（且方向与持仓相反）→ 报出「立即平仓」信号，不等待技术位触发。这是唯一允许抢在止损位之前离场的通道。',
  },
  {
    id: 'withdraw-one-third', group: '止盈', stage: 3, layer: '—', implemented: 'partial', origin: 'bithuang',
    quote: '盈利后必须提取三分之一现金到银行卡。（大作手操盘术 3）',
    source: '《交易心得》大作手操盘术',
    rule: '这是**账户层面**的资金纪律，不是单笔交易的判据，且需要账户出入金权限（本看板是只读的）。目前只做到「把已实现盈利与提取建议算出来展示」，不自动执行。',
  },
  {
    id: 'compounding-30d', group: '止盈', stage: 3, layer: '—', implemented: 'partial', origin: 'bithuang',
    quote: '30 天内单利，每满 30 天复利一次。',
    source: 'bithuang-ai-trader STRATEGY.md（源自《比特皇精华总结》）',
    rule: '做成提示：距上次复利结算满 30 天时提醒。不复利计算本身 —— 它依赖账户净值曲线口径，与本看板「只读」定位冲突。',
  },

  /* ═══════════════════════════════════════════════════════════════
   * 全局约束 —— 不属于任何单一阶段，但每一阶段都必须遵守
   * ═══════════════════════════════════════════════════════════════ */

  {
    id: 'kline-only', group: '全局约束', stage: 0, layer: '全部', implemented: true, origin: 'bithuang',
    quote: '我不关注那些，只看 k 线图。要相信自己的眼睛，而不要相信自己的脑筋。',
    source: '《比特皇语录》20、25',
    rule: '所有判据只吃价格与成交量。不引入任何主观预测、观点或外部评级输入 —— 这是架构约束，不是风格偏好。',
  },
  {
    id: 'trend-not-against', group: '全局约束', stage: 0, layer: 'A1+A2', implemented: true, origin: 'bithuang',
    quote: '多头趋势行情中摸顶空和空头趋势行情中抄底多，这是交易的大忌，不要和趋势做对。',
    source: '《比特皇语录》8',
    rule: '结构读数与周期相位相反时输出 NEUTRAL 而**不反向** —— 这是本系统最核心的一条设计判断。阶段二的门禁 VETOED 就是这条的执法者。',
  },
  {
    id: 'no-zone-trade', group: '全局约束', stage: 0, layer: '系统二', implemented: true, origin: 'bithuang',
    quote: '不做日内短线，不做震荡行情，也不傻傻屯币。相对于做空，比特皇更喜欢做多。',
    source: '《比特皇精华总结》交易总结 3、6',
    rule: '「更喜欢做多」无法量化，拒绝做成权重 —— 把模糊偏好变成精确参数是自欺。只体现在两处：BLOWOFF 段 intent=NEUTRAL（不鼓励反手做空）、逆周期时不反向。',
  },
  {
    id: 'validate-by-market', group: '全局约束', stage: 0, layer: '—', implemented: 'partial', origin: 'bithuang',
    quote: '不要听信小道消息，要坚信自己看到的盘面数据。小道消息要去市场验证。不要听信权威，用市场检验。自己的交易系统已经盈利，不要轻易改变交易策略。',
    source: '《交易心得》第五个策略 / 3. 自己的交易系统已经盈利',
    rule: '方法论：任何改动都必须过 tools/regime-check.js 的回测断言，不能因为「听起来更对」就改参数。已落成「回测 + 断言」的开发纪律，但无法自动化「不要听信权威」。',
  },
];

/** 按层分组，给界面用。 */
export function criteriaByLayer() {
  const out = {};
  for (const c of DIRECTION_CRITERIA) {
    const k = c.layer || '—';
    (out[k] ||= []).push(c);
  }
  return out;
}

/** 按阶段分组 —— 界面按「三段」呈现时用这个。 */
export const STAGES = {
  0: { key: 'GLOBAL', name: '全局约束', question: '所有阶段都必须遵守的方法论红线' },
  1: { key: 'FUNDAMENTAL', name: '阶段一 · 基本面', question: '往哪个方向' },
  2: { key: 'TECHNICAL', name: '阶段二 · 技术面', question: '什么时候扣扳机' },
  3: { key: 'POSITION', name: '阶段三 · 持仓管理', question: '进去之后怎么办' },
};

export function criteriaByStage() {
  const out = { 0: [], 1: [], 2: [], 3: [] };
  for (const c of DIRECTION_CRITERIA) (out[c.stage] ||= []).push(c);
  return out;
}

/* ══════════════════ 工具 ══════════════════ */

function upto(bars, asOfMs) {
  const out = [];
  for (const b of bars || []) {
    if (b.t <= asOfMs) out.push(b);
    else break;
  }
  return out;
}

function mean(a) {
  if (!a.length) return null;
  let s = 0;
  for (const x of a) s += x;
  return s / a.length;
}

/** 分位：返回 x 在 arr 中的百分位（0~100）。窗口不足时返回 null（弃权，不是 50）。 */
function percentileOf(arr, x) {
  if (!arr || arr.length < 20) return null;
  let below = 0;
  for (const v of arr) if (v < x) below++;
  return (below / arr.length) * 100;
}

function round(v, d) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const m = 10 ** d;
  return Math.round(v * m) / m;
}

/** 月差（含小数），用于「距上次减半 / 距上次创新高」。 */
function monthsBetween(aMs, bMs) {
  return (bMs - aMs) / MS_PER_DAY / DAYS_PER_MONTH;
}

/* ══════════════════ A4 技术面补充 ══════════════════ */

/**
 * 中短期均线与牛转熊判定。
 *
 * 为什么 MA120 值得独立成票，而不是并进 A2 的 MA200：
 *   比特皇原文用的是 120 日线（不是 200），而且他用它做的是**中期**判断
 *   （「最强势的 bch 都站不上 120 日线」= 连强势品种的中期趋势都坏了）。
 *   MA120 转向比 MA200 早约 1~2 个月，这个提前量正是它的价值。
 *   两票高度相关但不是同一票 —— 短均线负责「早」，长均线负责「稳」。
 *
 * 牛转熊那条为什么必须门控：
 *   「几个月都无法突破新高」在减半后的头 6 个月是**必然成立**的
 *   （价格刚从上一轮熊市里爬出来，新高当然很久没创过）。不门控的话
 *   这条判据会在每一轮周期的起点稳定误报。所以只在减半后 ≥ gateMonths
 *   个月（默认 15）才计票 —— 那时「久未创新高」才是真的走弱信号。
 */
export function technicalsRead({ daily = [], asOfMs = Date.now(), cfg = {} }) {
  const d = upto(daily, asOfMs);
  const closes = d.map((x) => x.c);
  const price = closes.length ? closes[closes.length - 1] : null;

  const maWindow = cfg.ma120Window ?? 120;
  const bearDrawdownPct = cfg.bearDrawdownPct ?? 0.25;
  const bearStaleMonths = cfg.bearStaleMonths ?? 3;
  const gateMonths = cfg.bearGateMonths ?? 15;

  const notes = [];

  /* ① 价格 vs 120 日均线 */
  let ma120 = null;
  let priceVsMa120 = null;
  let vote120 = 0;
  let ext120 = null;
  if (price !== null && closes.length >= maWindow) {
    ma120 = mean(closes.slice(closes.length - maWindow));
    priceVsMa120 = price > ma120;
    ext120 = ma120 > 0 ? price / ma120 - 1 : null;
    vote120 = priceVsMa120 ? 1 : -1;
  } else {
    notes.push(`日线只有 ${closes.length} 根，不足 ${maWindow} 根，120 日均线判据弃权。`);
  }

  /* ② 距历史最高 + 未创新高月数 */
  let peak = null;
  let peakIdx = -1;
  for (let i = 0; i < d.length; i++) {
    if (peak === null || d[i].c > peak) {
      peak = d[i].c;
      peakIdx = i;
    }
  }
  const drawdownPct = price !== null && peak ? price / peak - 1 : null;

  // 未创新高月数：从「最后一次创出历史新高的那根」到 asOfMs
  let monthsSinceNewHigh = null;
  let lastHighMs = null;
  let lastHighPrice = null;
  if (peakIdx >= 0) {
    // 找最后一根「收盘价 ≥ 峰值 99.9%」的 K 线，避免把同一波顶部的多根都算成新高
    for (let i = d.length - 1; i >= 0; i--) {
      if (d[i].c >= peak * 0.999) {
        lastHighMs = d[i].t;
        lastHighPrice = peak;
        break;
      }
    }
    if (lastHighMs !== null) monthsSinceNewHigh = round(monthsBetween(lastHighMs, asOfMs), 1);
  }

  // 牛转熊：回撤够深 + 够久没创新高。两者都满足才算「确认」，缺一条只能说「走弱」。
  const drawdownDeep = drawdownPct !== null && drawdownPct <= -bearDrawdownPct;
  const staleLong = monthsSinceNewHigh !== null && monthsSinceNewHigh >= bearStaleMonths;
  const monthsSinceHalving = cfg.monthsSinceHalving ?? null;
  const gatedIn = monthsSinceHalving === null ? true : monthsSinceHalving >= gateMonths;
  const bearSignal = gatedIn && drawdownDeep && staleLong;

  if (!gatedIn && drawdownDeep && staleLong) {
    notes.push(
      `回撤 ${(drawdownPct * 100).toFixed(1)}%、已 ${monthsSinceNewHigh} 个月未创新高，但当前仅距上次减半 ${monthsSinceHalving} 个月（< ${gateMonths}）` +
        `—— 这个阶段「久未创新高」是上一轮熊市的遗留，必然成立，不计入牛转熊判定。`
    );
  }

  /* ③ 合成：牛转熊确认时投空，否则由 MA120 单票决定 */
  let vote = vote120;
  let verdict;
  if (bearSignal) {
    vote = -1;
    verdict = 'BEAR_CONFIRMED';
  } else if (drawdownDeep && staleLong) {
    verdict = 'BEAR_PENDING';
  } else if (vote120 > 0) {
    verdict = 'ABOVE_MA120';
  } else if (vote120 < 0) {
    verdict = 'BELOW_MA120';
  } else {
    verdict = 'UNKNOWN';
  }

  const drawdownZone =
    drawdownPct === null ? null
    : drawdownPct > -0.2 ? 'NEAR_ATH'
    : drawdownPct > -0.45 ? 'CORRECTION'
    : 'DEEP';

  return {
    available: vote120 !== 0 || bearSignal,
    ma120: round(ma120, 2),
    priceVsMa120,
    extensionVsMa120: round(ext120, 4),
    vote120,
    monthsSinceNewHigh,
    lastHighPrice: round(lastHighPrice, 2),
    drawdownPct: round(drawdownPct, 4),
    drawdownZone,
    bearDrawdownPct,
    bearStaleMonths,
    bearGateMonths: gateMonths,
    monthsSinceHalving,
    bearSignal,
    bearPending: !bearSignal && drawdownDeep && staleLong && !gatedIn,
    verdict,
    vote,
    notes,
    detail: bearSignal
      ? `牛转熊**确认**：距历史最高回撤 ${(drawdownPct * 100).toFixed(1)}%（阈值 ${(bearDrawdownPct * 100).toFixed(0)}%），` +
        `已连续 ${monthsSinceNewHigh} 个月未能突破新高（阈值 ${bearStaleMonths} 个月）。这两个条件同时成立时，历史上没有一次不是熊市。`
      : vote120 > 0
        ? `价格站上 120 日均线 ${round(ma120, 1)}（+${(ext120 * 100).toFixed(1)}%）—— 中期趋势尚未破坏。回撤 ${drawdownPct === null ? '—' : (drawdownPct * 100).toFixed(1)}%，` +
          `${monthsSinceNewHigh === null ? '—' : monthsSinceNewHigh + ' 个月'}未创新高。`
        : vote120 < 0
          ? `价格跌破 120 日均线 ${round(ma120, 1)}（${(ext120 * 100).toFixed(1)}%）—— 连中期趋势都坏了。比特皇原话：「都迟迟站不上 120 日线，主流技术面确实走的很难看」。`
          : '120 日均线判据弃权（日线不足）。',
  };
}

/* ══════════════════ A5 情绪拥挤度 ══════════════════ */

/**
 * 用**资金费率的自身分位**当「散户拥挤度」的代理。
 *
 * 为什么用资金费而不是多空比：
 *   多空持仓比（long/short ratio）在 Hyperliquid 上要付费或需要特定接口；
 *   而 fundingHistory 是公开的、历史的、可回测的。资金费率的经济含义很直白：
 *   正费率 = 多头付钱给空头 = 多头拥挤；负费率 = 空头付钱 = 空头拥挤。
 *   所以「费率处于自身历史的极端低位」就是「散户全面做空」的可测代理，
 *   正是比特皇那句「情绪极度恐慌、散户全面做空、多头大量爆仓」。
 *
 * 为什么用自身分位而不是绝对阈值：
 *   费率的绝对水平随市场结构漂移（早期交易所费率规则不同、牛市基准费率整体偏高）。
 *   写死一个绝对值（比如「费率 < -0.01%」）在下一轮周期必然失效。
 *   分位数是相对自身历史，天然自适应。
 *
 * 关键：**单看拥挤不够，还要看价格反应。**
 *   比特皇的原话是「极度恐慌 + 散户全面做空 + 多头爆仓」→ 多头机会。
 *   但空头拥挤同时出现在两个完全相反的场景：
 *     · 下跌末段：空头拥挤 + 价格跌不动 → 挤压反弹（比特皇说的机会）
 *     · 下跌初段：空头拥挤 + 价格继续破位 → 趋势延续（追空才对）
 *   两者靠「价格有没有继续创造新低」区分。所以本层输出两个独立字段：
 *   crowding（拥挤方向）与 priceHolding（价格是否止跌）。
 *   只有「空头拥挤 + 价格止跌」才投多。
 */
export function sentimentRead({ fundingSeries = [], daily = [], asOfMs = Date.now(), cfg = {} }) {
  const lookback = cfg.fundingLookback ?? 90;
  const extremePct = cfg.fundingExtremePercentile ?? 15;
  const holdBars = cfg.sentimentHoldBars ?? 10;

  // 只取 asOfMs 之前的费率点
  const fs = (fundingSeries || [])
    .filter((x) => x && x.t <= asOfMs && Number.isFinite(x.rate))
    .sort((a, b) => a.t - b.t);

  if (fs.length < 20) {
    return {
      available: false, reason: `资金费历史只有 ${fs.length} 条，不足以判断拥挤度（要求 ≥ 20），本层弃权。`,
      crowding: null, vote: 0, fundingNow: null, percentile: null, priceHolding: null,
    };
  }

  const rates = fs.map((x) => x.rate);
  const fundingNow = rates[rates.length - 1];
  const win = rates.slice(-lookback);
  const percentile = percentileOf(win, fundingNow);
  const meanRate = mean(win);

  const shortCrowded = percentile !== null && percentile <= extremePct;
  const longCrowded = percentile !== null && percentile >= 100 - extremePct;
  const crowding = shortCrowded ? 'SHORT_CROWDED' : longCrowded ? 'LONG_CROWDED' : 'NORMAL';

  // 价格是否止跌：最近 holdBars 根的收盘是否还在创造新低 / 新高
  const d = upto(daily, asOfMs);
  let priceHolding = null;
  let lowBarsAgo = null;
  let highBarsAgo = null;
  if (d.length >= holdBars * 2) {
    const recent = d.slice(-holdBars);
    const recentLow = Math.min(...recent.map((x) => x.l));
    const recentHigh = Math.max(...recent.map((x) => x.h));
    const winLow = Math.min(...d.map((x) => x.l));
    const winHigh = Math.max(...d.map((x) => x.h));
    // 最近 holdBars 根里有没有刷出全窗口新低
    const madeNewLow = recentLow <= winLow * 1.0001;
    const madeNewHigh = recentHigh >= winHigh * 0.9999;
    priceHolding = !madeNewLow && !madeNewHigh ? 'RANGE' : madeNewLow ? 'STILL_FALLING' : 'STILL_RISING';
    lowBarsAgo = d.findIndex((x) => x.l <= winLow * 1.0001);
    highBarsAgo = d.findIndex((x) => x.h >= winHigh * 0.9999);
  }

  let vote = 0;
  let signal = null;
  if (shortCrowded && priceHolding === 'RANGE') {
    vote = 1;
    signal = 'SQUEEZE_UP';
  } else if (longCrowded && priceHolding === 'RANGE') {
    vote = -1;
    signal = 'SQUEEZE_DOWN';
  }

  const detail =
    signal === 'SQUEEZE_UP'
      ? `资金费率处于近 ${win.length} 期的 ${percentile.toFixed(0)} 分位（当前 ${(fundingNow * 100).toFixed(4)}%，窗口均值 ${(meanRate * 100).toFixed(4)}%）—— 空头拥挤到要付钱持仓，` +
        `而且价格已经不再创造新低。这正是比特皇说的「散户全面做空 + 多头爆仓」之后的多头机会。`
      : signal === 'SQUEEZE_DOWN'
        ? `资金费率处于近 ${win.length} 期的 ${(100 - percentile).toFixed(0)} 分位（当前 ${(fundingNow * 100).toFixed(4)}%）—— 多头拥挤到要付钱持仓，而且价格已经不再创造新高。` +
          `这是「最后一个悲观者也变成乐观者」的位置。`
        : crowding === 'SHORT_CROWDED'
          ? `资金费率偏低（${percentile === null ? '—' : percentile.toFixed(0)} 分位）说明空头拥挤，但价格**仍在创造新低** —— 这是下跌初段而非末段，此时追空才对，不构成反向机会。`
          : crowding === 'LONG_CROWDED'
            ? `资金费率偏高（${percentile === null ? '—' : percentile.toFixed(0)} 分位）说明多头拥挤，但价格**仍在创造新高** —— 拥挤不等于反转，此时不能单凭费率做空。`
            : `资金费率处于中位（${percentile === null ? '—' : percentile.toFixed(0)} 分位），多空没有明显拥挤，本层不表态。`;

  return {
    available: true,
    fundingNow: round(fundingNow, 8),
    meanRate: round(meanRate, 8),
    percentile: round(percentile, 1),
    samples: win.length,
    crowding,
    extremePct,
    priceHolding,
    lowBarsAgo,
    highBarsAgo,
    vote,
    signal,
    detail,
  };
}

/* ══════════════════ A6 量能形态 ══════════════════ */

/**
 * 量能三形态 —— 对应比特皇的三句原话。
 *
 * 「下跌持续一段时间 + 成交量暴增 → 做多信号」
 * 「上涨持续一段时间 + 成交量暴涨 → 意味着见顶」
 * 「下跌的斜率和成交量同时放缓 → 像筑底的形态」
 *
 * 为什么量能必须看**分位**而不是绝对倍数：
 *   币圈的绝对成交量随周期整体漂移（每轮牛市的名义量都比上一轮大一个量级），
 *   而且交易所之间口径不同。用自身窗口的分位，才能问出「这根量在这个阶段里
 *   算不算大」这个真正有意义的问题。
 *
 * 为什么第三种（量价双降）是**弱**信号：
 *   它是「筑底形态」而不是「底部确认」。比特皇原话也是「像筑底的形态」。
 *   形态可以再跌 30%。所以它的票权低于投降式放量，且不能单独构成反转。
 */
export function volumeRead({ daily = [], asOfMs = Date.now(), cfg = {} }) {
  const lookback = cfg.volumeLookback ?? 90;
  const legBars = cfg.volumeLegBars ?? 20;
  const spikePct = cfg.volumeSpikePercentile ?? 90;
  const dryRatio = cfg.volumeDryRatio ?? 0.8;

  const d = upto(daily, asOfMs);
  if (d.length < lookback + 5) {
    return {
      available: false,
      reason: `日线只有 ${d.length} 根，不足 ${lookback + 5} 根，量能判据弃权。`,
      vote: 0, pattern: null,
    };
  }
  const vols = d.map((x) => x.v || 0);
  if (vols.every((v) => v === 0)) {
    return { available: false, reason: 'K 线没有成交量字段（全为 0），量能判据弃权。', vote: 0, pattern: null };
  }

  const volNow = vols[vols.length - 1];
  const volPct = percentileOf(vols.slice(-lookback), volNow);
  const avgNow = mean(vols.slice(-legBars));
  const avgPrev = mean(vols.slice(-2 * legBars, -legBars));
  const volRatio = avgPrev ? avgNow / avgPrev : null;

  // 当前所处的「腿」：现价 vs legBars 前
  const priceNow = d[d.length - 1].c;
  const priceThen = d[d.length - 1 - legBars].c;
  const legPct = priceThen ? priceNow / priceThen - 1 : 0;
  // 注意：这里必须先取出阈值再比较。写成 `legPct > cfg.legFlatPct ?? 0.03` 是错的 ——
  // `>` 的优先级高于 `??`，那样实际算的是 `(legPct > cfg.legFlatPct) ?? 0.03`，
  // 永远得到布尔值，`??` 成了死代码，阈值形同虚设。
  const flatPct = cfg.legFlatPct ?? 0.03;
  const leg = legPct > flatPct ? 'UP' : legPct < -flatPct ? 'DOWN' : 'FLAT';

  // 跌速是否放缓：最近 legBars 的跌幅 vs 再往前 legBars 的跌幅
  let decel = false;
  if (leg === 'DOWN') {
    const prevPrice = d[d.length - 1 - 2 * legBars]?.c;
    const recentDrop = priceThen ? priceNow / priceThen - 1 : 0;
    const prevDrop = prevPrice ? priceThen / prevPrice - 1 : 0;
    decel = prevDrop < 0 && recentDrop > prevDrop; // 后段跌幅更小 = 跌速放缓
  }

  let pattern = null;
  let vote = 0;
  let strength = 0;

  if (leg === 'DOWN' && volPct !== null && volPct >= spikePct) {
    pattern = 'CAPITULATION_VOLUME';
    vote = 1;
    strength = 1.0;
  } else if (leg === 'UP' && volPct !== null && volPct >= spikePct) {
    pattern = 'BLOWOFF_VOLUME';
    vote = -1;
    strength = 1.0;
  } else if (leg === 'DOWN' && decel && volRatio !== null && volRatio <= dryRatio) {
    pattern = 'DRY_BOTTOM';
    vote = 1;
    strength = 0.5;
  } else if (volRatio !== null && volRatio <= dryRatio && leg === 'FLAT') {
    pattern = 'QUIET_RANGE';
    vote = 0;
    strength = 0;
  } else {
    pattern = 'NORMAL';
  }

  const detailMsg = {
    CAPITULATION_VOLUME: `价格处于下跌段（近 ${legBars} 根 ${(legPct * 100).toFixed(1)}%），而当日成交量处于回看窗口的 ${volPct.toFixed(0)} 分位 —— ` +
      `这是比特皇说的「下跌持续一段时间后成交量暴增」，做多信号。恐慌盘交出了筹码。`,
    BLOWOFF_VOLUME: `价格处于上涨段（近 ${legBars} 根 +${(legPct * 100).toFixed(1)}%），而当日成交量处于回看窗口的 ${volPct.toFixed(0)} 分位 —— ` +
      `这是「上涨持续一段时间后成交量暴涨，意味着见顶」。注意：大成交量在顶部往往是**派发**（强手转弱手），不是健康信号。`,
    DRY_BOTTOM: `下跌段且跌速放缓（后 ${legBars} 根跌幅小于前 ${legBars} 根），均量降到前段的 ${volRatio === null ? '—' : (volRatio * 100).toFixed(0)}% —— ` +
      `「下跌势能逐渐放缓，成交量逐渐减少，像筑底的形态」。注意这是**形态**不是**确认**，形态之后可以再跌。`,
    QUIET_RANGE: `成交量枯竭、价格横盘 —— 「横盘震荡就像是掰手腕」，本层弃权。等胜负分明。`,
    NORMAL: `量能处于常态（${volPct === null ? '—' : volPct.toFixed(0)} 分位），没有可读的极端形态。`,
  }[pattern];

  return {
    available: true,
    volNow: round(volNow, 4),
    volPercentile: round(volPct, 1),
    avgNow: round(avgNow, 4),
    avgPrev: round(avgPrev, 4),
    volRatio: round(volRatio, 3),
    leg,
    legPct: round(legPct, 4),
    legBars,
    decelerating: decel,
    spikePercentile: spikePct,
    dryRatio,
    pattern,
    strength,
    vote,
    detail: detailMsg,
  };
}

/* ══════════════════ A7 事件反应检验 ══════════════════ */

/**
 * 「利空不跌，见底信号。利多不涨，见顶信号。」
 *
 * 这是全部判据里最有信息量、也最容易被忽略的一条：
 *   它测的不是事件本身，而是**市场对事件的反应**。
 *   同样一个利空，在下跌初期会让价格崩掉，在下跌末段却跌不动 ——
 *   后者说明卖压已经耗尽。比特皇用这条判断自己是不是站错了边。
 *
 * 实现方式：
 *   对事件表里每条权重足够大、且已过去至少 reactionDays 天的事件，
 *   量它之后 reactionDays 天的价格变化。
 *   · 负面事件（weight < 0）后价格**没有跌**超过 flatPct → 利空不跌
 *   · 正面事件（weight > 0）后价格**没有涨**超过 flatPct → 利多不涨
 *
 * 为什么需要「过去至少 N 天」：
 *   刚发生的事件反应还没走完，用半截数据判断等于用未来函数。
 *   这条规则本身就是对前视偏差的防护。
 *
 * 为什么要有 flatPct 这个「没动」的容差：
 *   利空之后价格横着不动，也是「不跌」。要求价格必须上涨才算，
 *   会把最有价值的一类样本（利空砸不动）漏掉。
 */
export function eventReactionRead({ events = [], daily = [], asOfMs = Date.now(), cfg = {} }) {
  const minWeight = cfg.reactionMinWeight ?? 0.3;
  const reactionDays = cfg.reactionDays ?? 14;
  const flatPct = cfg.reactionFlatPct ?? 0.02;
  const maxItems = cfg.reactionMaxItems ?? 6;

  const d = upto(daily, asOfMs);
  if (d.length < 30) {
    return { available: false, reason: `日线只有 ${d.length} 根，不足以做事件反应检验，本层弃权。`, vote: 0, items: [] };
  }

  // 事件表里可能只有日期没有价格序列 —— 用「事件日期之后第一根 K 线」当基准
  const idxAtOrAfter = (ms) => d.findIndex((x) => x.t >= ms);

  const items = [];
  for (const ev of events || []) {
    if (!ev || !ev.date) continue;
    const w = Number(ev.weight ?? 0);
    if (!Number.isFinite(w) || Math.abs(w) < minWeight) continue;

    const t0 = Date.parse(`${ev.date}T00:00:00Z`);
    if (!Number.isFinite(t0)) continue;
    const ageDays = (asOfMs - t0) / MS_PER_DAY;
    if (ageDays < reactionDays) continue; // 反应窗口还没走完，不许提前下结论

    const i0 = idxAtOrAfter(t0);
    if (i0 < 0) continue;
    const i1 = i0 + reactionDays;
    if (i1 >= d.length) continue;

    const p0 = d[i0].c;
    const p1 = d[i1].c;
    const reactionPct = p0 ? p1 / p0 - 1 : null;
    if (reactionPct === null) continue;

    let verdict = null;
    if (w < 0 && reactionPct > -flatPct) verdict = 'BEARISH_NOT_FALLING';
    else if (w > 0 && reactionPct < flatPct) verdict = 'BULLISH_NOT_RISING';

    items.push({
      id: ev.id,
      date: ev.date,
      kind: ev.kind ?? null,
      weight: w,
      ageDays: Math.round(ageDays),
      reactionDays,
      p0: round(p0, 2),
      p1: round(p1, 2),
      reactionPct: round(reactionPct, 4),
      flatPct,
      verdict,
      note: ev.note ?? null,
    });
  }

  // 按时间倒序，最多看最近 maxItems 条
  items.sort((a, b) => (a.date < b.date ? 1 : -1));
  const recent = items.slice(0, maxItems);

  const notFalling = recent.filter((x) => x.verdict === 'BEARISH_NOT_FALLING');
  const notRising = recent.filter((x) => x.verdict === 'BULLISH_NOT_RISING');

  let vote = 0;
  let pattern = null;
  if (notFalling.length > notRising.length && notFalling.length >= 1) {
    vote = 1;
    pattern = 'BEARISH_NOT_FALLING';
  } else if (notRising.length > notFalling.length && notRising.length >= 1) {
    vote = -1;
    pattern = 'BULLISH_NOT_RISING';
  }

  const detail =
    pattern === 'BEARISH_NOT_FALLING'
      ? `过去 ${recent.length} 条有效事件里有 ${notFalling.length} 条属于「利空不跌」：` +
        notFalling.map((x) => `${x.date}（权重 ${x.weight}，后 ${x.reactionDays} 天 ${(x.reactionPct * 100).toFixed(1)}%）`).join('、') +
        `。该跌不跌说明卖压已经耗尽 —— 这是比特皇的见底信号。`
      : pattern === 'BULLISH_NOT_RISING'
        ? `过去 ${recent.length} 条有效事件里有 ${notRising.length} 条属于「利多不涨」：` +
          notRising.map((x) => `${x.date}（权重 +${x.weight}，后 ${x.reactionDays} 天 ${(x.reactionPct * 100).toFixed(1)}%）`).join('、') +
          `。该涨不涨说明买盘已经接不住 —— 这是比特皇的见顶信号。`
        : items.length === 0
          ? `事件表里没有权重 ≥ ${minWeight}、且已过去 ≥ ${reactionDays} 天的事件，无法做反应检验。` +
            `（事件表是维护型数据，2025 年之后的条目需要手工补充。）`
          : `已检验 ${recent.length} 条事件，没有出现「利空不跌」或「利多不涨」的背离 —— 市场对消息的反应是正常的。`;

  return {
    available: items.length > 0,
    minWeight,
    reactionDays,
    flatPct,
    total: items.length,
    items: recent,
    bearishNotFalling: notFalling.length,
    bullishNotRising: notRising.length,
    pattern,
    vote,
    detail,
  };
}

/* ══════════════════ 反转合成 ══════════════════ */

/**
 * 把 A4~A7 的票合成一个「反转倾向」，并说明它该怎样影响方向层。
 *
 * 设计上**不等于**「发现反转信号就翻转方向」，原因有三：
 *   1. 比特皇自己的原话就限定了前提 —— 「在比特币减半的大前提下」。
 *      脱离周期谈极端情绪，等于丢掉这句话最重要的半句。
 *   2. 大方向上他反复强调「不要和趋势做对」。反转信号的价值是
 *      「让你别在错误的位置顺势加仓」，不是「让你反手」。
 *   3. 顶部与底部是过程不是瞬间。逆着趋势的信号需要极强证据，
 *      而方向层只有 4 年 4 次样本的周期表可用 —— 不足以支撑反手。
 *
 * 所以本函数输出两个**动作**，而不是一个新方向：
 *   · topBrake  —— 顶部刹车：禁止顺势做多的新开仓。
 *                  与「追高禁令」是姊妹规则，两者看的东西完全不同：
 *                  追高看**价格离均线多远**（位置），
 *                  顶部刹车看**量能与消息反应**（行为）。
 *                  一个位置不热但市场开始派发的顶，只有后者能挡住。
 *   · bottomConfirm —— 底部确认：方向层已许可做多时，抬高置信度。
 *                  它不能把 NEUTRAL 变成 LONG_ONLY —— 那需要周期层点头。
 */
export function synthesizeReversal({ clock = {}, technicals = {}, sentiment = {}, volume = {}, reaction = {}, macro = [], cfg = {} }) {
  const minVotes = cfg.reversalMinVotes ?? 2;

  /* 逐项列出「支持见底」与「支持见顶」的证据，含弃权的一并列出 ——
   * 弃权必须显形。否则用户会以为「没提到的判据都看过了且没有异议」。 */
  const evidence = [];

  // A5 情绪拥挤度
  if (!sentiment.available) {
    evidence.push({ layer: 'A5 情绪拥挤度', dir: 0, available: false, text: sentiment.reason || '弃权' });
  } else if (sentiment.vote !== 0) {
    evidence.push({
      layer: 'A5 情绪拥挤度', dir: sentiment.vote, available: true,
      text: sentiment.signal === 'SQUEEZE_UP' ? `空头拥挤且价格止跌（费率 ${sentiment.percentile} 分位）→ 挤空反弹`
        : `多头拥挤且价格滞涨（费率 ${sentiment.percentile} 分位）→ 多头清算风险`,
    });
  } else {
    evidence.push({ layer: 'A5 情绪拥挤度', dir: 0, available: true, text: sentiment.detail || '无拥挤极端' });
  }

  // A6 量能
  if (!volume.available) {
    evidence.push({ layer: 'A6 量能形态', dir: 0, available: false, text: volume.reason || '弃权' });
  } else if (volume.vote !== 0) {
    evidence.push({
      layer: 'A6 量能形态', dir: volume.vote, available: true,
      text: volume.pattern === 'CAPITULATION_VOLUME' ? `投降式放量（${volume.volPercentile} 分位，下跌段）→ 见底`
        : volume.pattern === 'BLOWOFF_VOLUME' ? `顶部放量（${volume.volPercentile} 分位，上涨段）→ 派发见顶`
        : `量价双降、跌速放缓 → 筑底形态（弱信号，权重 ${volume.strength}）`,
    });
  } else {
    evidence.push({ layer: 'A6 量能形态', dir: 0, available: true, text: volume.detail || '量能常态' });
  }

  // A7 事件反应
  if (!reaction.available) {
    evidence.push({ layer: 'A7 事件反应', dir: 0, available: false, text: reaction.reason || '弃权' });
  } else if (reaction.vote !== 0) {
    evidence.push({
      layer: 'A7 事件反应', dir: reaction.vote, available: true,
      text: reaction.pattern === 'BEARISH_NOT_FALLING' ? `利空不跌 ${reaction.bearishNotFalling} 例 → 见底`
        : `利多不涨 ${reaction.bullishNotRising} 例 → 见顶`,
    });
  } else {
    evidence.push({ layer: 'A7 事件反应', dir: 0, available: true, text: reaction.detail || '无背离' });
  }

  // A4 技术面的牛转熊只做「见顶侧」的证据；它本身不构成反转，因为它是趋势判据
  if (technicals.bearSignal) {
    evidence.push({ layer: 'A4 牛转熊', dir: -1, available: true, text: '回撤够深 + 久未创新高 → 牛转熊确认（趋势类，非反转类）' });
  }

  /* ── M1~M6 宏观与基本面读数（src/macro-sources.js） ──────────────────
   *
   * 这 6 条原本标着 `implemented:false`（"没有免费无密钥的接口"）走手工事件表，
   * 现在全部接上了真实数据源，于是它们能像 A5~A7 一样投票。
   *
   * 定位必须说清：**它们不是否决项**。唯一的一票否决通道仍然是 shock。
   * 这里只让它们影响 topVotes / bottomVotes 这两个动作侧信号 ——
   * 也就是"顶部刹车"和"底部确认"，不会把 NEUTRAL 翻成某个方向。
   *
   * 不能投票的理由之前是"没数据"，不是"不重要"。所以接上数据后，
   * **弃权（available:false）必须继续显形** —— 数据源挂掉时不能默认"没有异议"。
   */
  const macroTop = [];
  const macroBottom = [];
  for (const m of macro || []) {
    const label = m.layer ? `${m.layer} ${m.name || m.id}` : m.id;
    if (!m.available) {
      evidence.push({ layer: label, dir: 0, available: false, text: m.reason || '弃权' });
      continue;
    }
    evidence.push({ layer: label, dir: m.vote || 0, available: true, text: m.reason || '' });
    if (m.vote > 0) macroBottom.push(m);
    else if (m.vote < 0) macroTop.push(m);
  }

  // DRY_BOTTOM 是弱信号，按 strength 折算，不凑票
  const aBottomVotes =
    (sentiment.vote > 0 ? 1 : 0) +
    (volume.vote > 0 ? (volume.pattern === 'DRY_BOTTOM' ? 0 : 1) : 0) + // 筑底形态不单独凑票
    (reaction.vote > 0 ? 1 : 0);
  const aTopVotes =
    (sentiment.vote < 0 ? 1 : 0) +
    (volume.vote < 0 ? 1 : 0) +
    (reaction.vote < 0 ? 1 : 0);

  // 宏观票单独计数：界面上必须能看出"这几票是谁投的"，
  // 否则一个数据源出问题就会表现为"方向莫名其妙变了"。
  const bottomVotes = aBottomVotes + macroBottom.length;
  const topVotes = aTopVotes + macroTop.length;

  const bottomSignal = bottomVotes >= minVotes;
  const topSignal = topVotes >= minVotes;

  const intent = clock.intent;
  const inHalvingPremise = intent === LONG_ONLY || intent === SHORT_ONLY || clock.phase === 'BLOWOFF';

  let topBrake = false;
  let bottomConfirm = false;
  const notes = [];

  if (topSignal) {
    if (intent === LONG_ONLY) {
      topBrake = true; // 方向仍是多，但市场行为显示派发 —— 不在这里开新多
      notes.push(
        `**顶部刹车生效**：量能 / 消息反应 / 拥挤度三项里有 ${topVotes} 项指向见顶（要求 ≥ ${minVotes}），` +
          `而周期相位仍许可做多。这是比特皇式「先知先觉的离场侧证据」——不反手做空，但停止在这里加多。` +
          `顶部与底部是过程不是瞬间，反手需要有比周期表更强的证据，方向层没有。`
      );
    } else if (intent === NEUTRAL) {
      notes.push(
        `顶部证据（${topVotes} 项）出现在「${clock.label}」—— 周期层本来就不批准双向开仓，两者一致，维持 NEUTRAL。`
      );
    } else {
      notes.push(`顶部证据（${topVotes} 项）与当前的「只许做空」方向一致，但周期层已经给出方向，无需重复计票。`);
    }
  }

  if (bottomSignal) {
    if (intent === LONG_ONLY) {
      bottomConfirm = true;
      notes.push(
        `**底部确认**：量能 / 消息反应 / 拥挤度三项里有 ${bottomVotes} 项指向见底（要求 ≥ ${minVotes}），且周期相位许可做多 —— ` +
          `正落在比特皇说的「减半大前提下，情绪极度恐慌、散户全面做空、多头大量爆仓 = 多头入场的绝佳机会」上。置信度上调。`
      );
    } else if (intent === NEUTRAL) {
      notes.push(
        `出现 ${bottomVotes} 项见底证据，但周期相位「${clock.label}」不批准任何方向。` +
          `**不据此翻转成做多**：比特皇那条「极端恐慌 = 多头绝佳机会」有明确前提 ——「在比特币减半的大前提下」。` +
          `脱离减半窗口谈极端情绪，等于丢掉了这句话最重要的半句。`
      );
    } else {
      notes.push(
        `出现 ${bottomVotes} 项见底证据，但周期层当前「只许做空」。这是出清段的阶段性反弹信号，不是方向反转 —— ` +
          `历史上反弹很猛但很少创新高，逆周期做多是代价最高的错误。`
      );
    }
  }

  if (!inHalvingPremise) {
    notes.push(
      `注意：当前相位「${clock.label}」不在任何一个减半热点窗口内 —— 比特皇的核心结论是「没有市场热点的推动，行情的波动性和持久性都会弱很多」，` +
        `此时应捂紧口袋保本金，而不是找入场点。`
    );
  }

  // 宏观票单独说一句 —— 让"这几票来自哪里"在界面上是可追溯的
  const macroAbstain = (macro || []).filter((m) => !m.available).length;
  if (macroTop.length || macroBottom.length || macroAbstain) {
    const bits = [];
    if (macroBottom.length) bits.push(`见底侧 ${macroBottom.length} 项（${macroBottom.map((m) => m.id).join('、')}）`);
    if (macroTop.length) bits.push(`见顶侧 ${macroTop.length} 项（${macroTop.map((m) => m.id).join('、')}）`);
    if (macroAbstain) bits.push(`${macroAbstain} 项取不到数据、已计为弃权`);
    notes.push(
      `**宏观与基本面读数**（M1~M6，数据源见 src/macro-sources.js）：${bits.join('；')}。` +
        `这 6 条是加分项与刹车项，**不构成方向开关** —— 唯一的一票否决通道仍然是黑天鹅 shock。`
    );
  }

  return {
    bottomVotes,
    topVotes,
    minVotes,
    bottomSignal,
    topSignal,
    topBrake,
    bottomConfirm,
    inHalvingPremise,
    evidence,
    notes,
    macroVotes: { top: macroTop.length, bottom: macroBottom.length, abstain: macroAbstain, readings: macro || [] },
  };
}
