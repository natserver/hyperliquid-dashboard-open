#!/bin/sh
# 比特皇看板 · OpenWrt 一键安装
#
# 用法（在项目目录里执行，三种就够）：
#   sh install.sh                构建镜像并启动（重复执行 = 更新重建）
#   sh install.sh --logs         跟着看日志
#   sh install.sh --stop         停掉容器（镜像与数据都留着）
#   sh install.sh --uninstall    删容器和镜像（.data / .alerts 仍然留着）
#   sh install.sh --port 9090    换端口（默认 8787）
#
# 更新到最新版（在路由器上执行这一条，任意目录都行）：
#   cd <本目录> && wget -O - https://github.com/natserver/hyperliquid-dashboard-open/archive/refs/heads/master.tar.gz \
#     | tar xz --strip-components=1 -C . && sh install.sh
#   tar 用 --strip-components=1 才能平铺覆盖旧文件 —— 不加会多套一层目录，
#   覆盖不到旧代码（白更新）；.data / .alerts 不在 tarball 里，不会被冲掉。
#
# 为什么是 `sh install.sh` 而不是 `./install.sh`：
#   OpenWrt 上 `/bin/sh` 是 busybox ash，没有 bash；本脚本也刻意不用 bash 特性。
#   行尾必须是 LF —— 拷过去变 CRLF 的话，第一行 shebang 就会报怪错。
#
# 数据挂在本目录的 .data/ 与 .alerts/ 下：宏观历史账本与推送配置不随镜像走，
# 所以「重新构建 / 升级镜像」和「丢数据」是两件互不相干的事。

set -e

IMAGE="bithuang-dashboard:latest"
NAME="bithuang-dashboard"
PORT="8787"
ACTION="up"
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

usage() {
  cat <<'EOF'
比特皇 · Hyperliquid 只读看板 —— OpenWrt 一键安装

  sh install.sh              构建镜像并启动（重复执行 = 更新重建）
  sh install.sh --port 9090  换端口，默认 8787
  sh install.sh --logs       跟着看日志
  sh install.sh --stop       停掉容器（保留镜像与数据）
  sh install.sh --uninstall  删除容器与镜像（保留 .data / .alerts）
  sh install.sh -h           显示本帮助

环境变量：
  HL_WATCH=1 HL_USER=0x...   顺便在容器里起预警守护进程（默认关）
  HL_USER=0x...              每日总结里的持仓段要用（不配也能推，
                             只是总结里少掉「持仓与风控」那两行）
  HL_BRIEF=0                 关掉每日总结推送（默认开）
  HL_BRIEF_AT=18:00          总结推送时间，北京时间（默认 18:00）
  HL_MACRO=0                 关掉每日宏观采集循环（默认开）
  HL_MACRO_INTERVAL=21600    采集周期，秒（默认 86400 = 每天一次）
  HL_SNAPSHOT=0              关掉每日全量落档（默认开：每天抓一份 Hyperliquid 侧
                             全部参数 —— K线/持仓/点位/三阶段/预警 —— 存进
                             .data/snapshot-daily/，默认留 3 天，顺带预热缓存）
EOF
  # 更新命令带真实路径，只能在非引号上下文里展开，所以不放进上面的 heredoc。
  printf '\n更新到最新版（有新版本时，在路由器上执行这一条）：\n  cd %s && wget -O - https://github.com/natserver/hyperliquid-dashboard-open/archive/refs/heads/master.tar.gz | tar xz --strip-components=1 -C . && sh install.sh\n' "$DIR"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --stop)       ACTION="stop" ;;
    --uninstall)  ACTION="uninstall" ;;
    --logs)       ACTION="logs" ;;
    --port)       PORT="$2"; shift ;;
    --port=*)     PORT="${1#--port=}" ;;
    -h|--help)    usage; exit 0 ;;
    *)            echo "不认识的参数：$1（用 -h 看用法）" >&2; exit 2 ;;
  esac
  shift
done

step() { printf '\n── %s\n' "$*"; }
die()  { printf '✗ %s\n' "$*" >&2; exit 1; }

# 参数先验完再碰 docker —— 打错字不该先等一句「没装 docker」。
case "$PORT" in
  ''|*[!0-9]*) die "端口必须是数字，收到：$PORT" ;;
esac

# ────────────── 0. 前置检查 ──────────────

command -v docker >/dev/null 2>&1 || die "没找到 docker。
  OpenWrt 上先装：
    opkg update && opkg install docker dockerd
    /etc/init.d/dockerd enable && /etc/init.d/dockerd start
  装完再回来跑 sh install.sh"

docker info >/dev/null 2>&1 || die "docker 守护进程没起来，先执行：
  /etc/init.d/dockerd start"

# ────────────── 1. 按动作走 ──────────────

if [ "$ACTION" = "logs" ]; then
  exec docker logs -f --tail 200 "$NAME"
fi

if [ "$ACTION" = "stop" ]; then
  step "停止容器"
  docker rm -f "$NAME" >/dev/null 2>&1 || echo "（本来就没在跑）"
  echo "✓ 已停止。数据仍在 $DIR/.data 与 $DIR/.alerts"
  exit 0
fi

if [ "$ACTION" = "uninstall" ]; then
  step "删除容器与镜像"
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker rmi "$IMAGE" >/dev/null 2>&1 || true
  echo "✓ 已卸载。数据仍在 $DIR/.data 与 $DIR/.alerts（要一起删自己手动 rm -rf）"
  exit 0
fi

step "构建镜像 $IMAGE"
docker build -t "$IMAGE" "$DIR"

step "启动容器"
# 先删再起：docker run 撞上同名容器会直接失败，而"更新"本就是要重建。
docker rm -f "$NAME" >/dev/null 2>&1 || true

# .data / .alerts 必须先存在：让 docker 去建的话，宿主机上会冒出 root 属主的
# 空目录，而你之后在路由器上手工改推送配置时会踩到权限问题。
mkdir -p "$DIR/.data" "$DIR/.alerts"

if ! docker run -d \
  --name "$NAME" \
  --restart unless-stopped \
  -p "${PORT}:8787" \
  -e HOST=0.0.0.0 \
  -e PORT=8787 \
  -e HL_WATCH="${HL_WATCH:-0}" \
  -e HL_USER="${HL_USER:-}" \
  -e HL_NETWORK="${HL_NETWORK:-mainnet}" \
  -e HL_COIN="${HL_COIN:-BTC}" \
  -e HL_MACRO="${HL_MACRO:-1}" \
  -e HL_MACRO_INTERVAL="${HL_MACRO_INTERVAL:-86400}" \
  -e HL_SNAPSHOT="${HL_SNAPSHOT:-1}" \
  -e HL_BRIEF="${HL_BRIEF:-1}" \
  -e HL_BRIEF_AT="${HL_BRIEF_AT:-18:00}" \
  -v "$DIR/.data:/app/.data" \
  -v "$DIR/.alerts:/app/.alerts" \
  "$IMAGE" >/dev/null; then
  die "容器起不来。常见原因是端口 $PORT 被占：
  docker ps --format '{{.Names}} {{.Ports}}'
  或换一个：sh install.sh --port 9090"
fi

step "等待健康检查"
# 探活**在容器里做**：容器内有 busybox wget，一定有。
# 探宿主机的 wget/curl 反而不可靠 —— 换台机器、换个 shell 就可能没有，
# 那种「因为没有探针工具所以判定不健康」是假失败，最坑人。
container_healthy() {
  docker exec "$NAME" wget -q -T 3 -O /dev/null "http://127.0.0.1:8787/api/health" 2>/dev/null
}
# 宿主机侧再探一次：它验证的是端口映射真的通了，不只是容器内活着。
host_probe() {
  if command -v wget >/dev/null 2>&1; then
    wget -q -T 3 -O /dev/null "http://127.0.0.1:${PORT}/api/health" 2>/dev/null
  elif command -v curl >/dev/null 2>&1; then
    curl -fsS -m 3 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1
  else
    return 0 # 本机没有探针工具，跳过这一层（不因为工具缺失而判失败）
  fi
}

i=0
READY=0
while [ "$i" -lt 40 ]; do
  if container_healthy; then
    READY=1
    break
  fi
  # 容器要是已经退出了，别傻等 40 秒
  if [ -z "$(docker ps -q -f name="^${NAME}\$" 2>/dev/null)" ]; then
    break
  fi
  i=$((i + 1))
  sleep 1
done

if [ "$READY" != "1" ]; then
  echo "✗ 健康检查没通过，最近的日志：" >&2
  docker logs --tail 40 "$NAME" >&2 || true
  exit 1
fi

if ! host_probe; then
  echo "✗ 容器内健康，但宿主机 http://127.0.0.1:${PORT} 不通 —— 端口映射有问题：" >&2
  docker ps --filter name="^${NAME}\$" --format '{{.Names}} {{.Ports}}' >&2 || true
  exit 1
fi

# 局域网 IP：给个能点的地址，而不是让你自己去翻 ifconfig
LAN_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n1)
if [ -z "$LAN_IP" ]; then
  LAN_IP=$(ubus call network.interface.lan status 2>/dev/null | sed -n 's/.*"address": "\([0-9.]*\)".*/\1/p' | head -n1)
fi
[ -n "$LAN_IP" ] || LAN_IP="<路由器IP>"

cat <<EOF

✓ 看板已运行

  打开   http://${LAN_IP}:${PORT}
  日志   sh install.sh --logs
  停止   sh install.sh --stop

  自动获取：容器内每 ${HL_MACRO_INTERVAL:-86400} 秒跑一轮两个采集脚本，开机先补一次 —
            · 宏观读数（比特皇看的六个外部条件：媒体情绪 / ETF 净流入 / 链上活跃 /
              美联储与 DXY / 机构持仓 / 监管动态）→ .data/macro.db
            · 事件（黑天鹅暴跌 / 减半时钟 / 美联储 FOMC 日程与利率决议）
              → .data/events-auto.json
            都不依赖有没有人打开页面；这六个源只给「当前值」，当天没记就永远缺那一天。

  不自动的：事件表 config/macro-events.json 里**手工录的**那些仍然手工
            （自动表是 .data/events-auto.json 另一份文件，合并时手工永远优先）。
            没有免费接口能可靠给出的类别，不会为了「看起来有数据」去编造 ——
            黑天鹅没有暴跌就是没有。

  说明：容器默认不推送预警（Windows 上那份计划任务还在跑，两边都开会把同一件事
        推两遍）。要在容器里开推送：
          HL_WATCH=1 HL_USER=0x你的地址 sh install.sh
EOF
