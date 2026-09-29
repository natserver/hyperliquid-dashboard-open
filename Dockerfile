# 比特皇 · Hyperliquid 只读看板 —— 容器镜像
#
# 整个工程**零 npm 依赖**，所以镜像里没有 `npm install` 这一步：
# 构建 = 拷源码。这既是这个项目能跑在路由器上的原因，也是它应该保持的样子 ——
# 一旦为了部署而引入依赖树，"只读看板不该有供应链风险"这条就开始漏水了。
#
# 基础镜像取 node:22-alpine：
#   · alpine 体积最小（路由器上存储金贵）；
#   · Node ≥22.5 自带 node:sqlite，宏观历史库直接走 sqlite；
#     取不到 sqlite 时 src/macro-store.js 会自动降级到 jsonl，所以这不是硬要求。
FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    HL_WATCH=0

WORKDIR /app

# 只拷运行时真正需要的东西。docs / report / .git 与镜像无关，
# `.alerts`（含 webhook 密钥）与 `.data`（宏观历史账本）绝不打进镜像 ——
# 它们用卷挂出来，换镜像时账本不会跟着被冲掉。
COPY package.json ./
COPY server.js ./
COPY src/ ./src/
COPY public/ ./public/
COPY config/ ./config/
COPY tools/ ./tools/
COPY docker/ ./docker/

RUN mkdir -p /app/.data /app/.alerts

EXPOSE 8787

# alpine 自带 busybox wget，够用来探活；不额外装 curl。
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -T 3 -O /dev/null "http://127.0.0.1:${PORT}/api/health" || exit 1

CMD ["sh", "docker/entrypoint.sh"]
