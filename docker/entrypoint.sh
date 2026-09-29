#!/bin/sh
# 容器入口：四件事 —— 看板服务、（可选）预警守护进程、每日采集、（可选）每日总结推送。
#
# 两个进程放在**同一个容器**里是有意的：预警守护进程走本地 HTTP 取数
# （见 tools/watch.js 头注释 —— 它故意复用看板的限流窗口与同一份缓存，
# 自己另拉一遍很容易同时吃 429）。分容器就得共享网络命名空间，白绕一圈。
#
# 默认只开看板、每日采集与每日总结：
#   · 预警推送默认关 —— 电脑上那份计划任务若还在跑，两边都推 = 同一件事推两遍；
#   · 每日采集默认开 —— 它是唯一「有没有人打开页面都必须跑」的活，
#     因为 M1~M6 的源只提供「当前值 + 近期窗口」，当天没记就永远缺那一天。
#     一轮跑三个脚本：macro-daily（M1~M6）、events-daily（黑天鹅/减半/美联储）、
#     snapshot-daily（Hyperliquid 侧全部参数：K线/持仓/点位/三阶段/预警落档）。
#   · 每日总结默认开 —— 到点没人开页面也得推，这是它存在的全部理由。
set -e

mkdir -p /app/.data /app/.alerts

PORT="${PORT:-8787}"

node server.js &
SERVER_PID=$!

# 等服务起来再谈别的 —— 否则守护进程第一轮就会拿到连接被拒。
i=0
while [ "$i" -lt 60 ]; do
  if wget -q -T 2 -O /dev/null "http://127.0.0.1:${PORT}/api/health" 2>/dev/null; then
    break
  fi
  i=$((i + 1))
  sleep 1
done

WATCH_PID=""
if [ "${HL_WATCH:-0}" = "1" ] && [ -n "${HL_USER:-}" ]; then
  echo "[entrypoint] 启动预警守护进程 user=${HL_USER} net=${HL_NETWORK:-mainnet} coin=${HL_COIN:-BTC}"
  node tools/watch.js \
    --user "$HL_USER" \
    --network "${HL_NETWORK:-mainnet}" \
    --coin "${HL_COIN:-BTC}" \
    --interval "${HL_INTERVAL:-60}" &
  WATCH_PID=$!
else
  echo "[entrypoint] 预警守护进程未启用（要开：-e HL_WATCH=1 -e HL_USER=0x...）"
fi

# ───────── 每日采集循环：开机补一次，之后按周期跑 ─────────
#
# 为什么必须有个循环，而不是「靠页面拉」：
#   看板只在有人请求快照时才去采源（带 TTL 缓存），没人开页面就没人采。
#   而 M1~M6 这六个源只给「当前值 + 近期窗口」，**当天没记就永远缺那一天** ——
#   历史账本补不回来。事件那三类（黑天鹅/减半/美联储）同理：日程过一天少一天。
#
# 两个脚本按天 upsert，重复跑同一天只是用更新的读数覆盖，不会插重复行。
DAILY_PID=""
RUN_MACRO="${HL_MACRO:-1}"
RUN_SNAPSHOT="${HL_SNAPSHOT:-1}"
DAILY_INTERVAL="${HL_MACRO_INTERVAL:-86400}"

if [ "$RUN_MACRO" = "1" ] || [ "$RUN_SNAPSHOT" = "1" ]; then
  echo "[entrypoint] 每日采集循环已启用：开机先补一次，之后每 ${DAILY_INTERVAL}s 一轮"
  if [ "$RUN_MACRO" = "1" ]; then
    echo "[entrypoint]   · macro-daily  → M1~M6 六个外部条件 → .data/macro.db"
    echo "[entrypoint]   · events-daily → 黑天鹅/减半/美联储决议 → .data/events-auto.json"
  fi
  if [ "$RUN_SNAPSHOT" = "1" ]; then
    echo "[entrypoint]   · snapshot-daily → Hyperliquid 侧全部参数（K线/持仓/点位/三阶段/预警）"
    echo "[entrypoint]                        → .data/snapshot-daily/（默认留 3 天，顺带给缓存预热）"
  fi
  (
    while :; do
      if [ "$RUN_MACRO" = "1" ]; then
        # --quiet：只留一行摘要给容器日志。
        # 采集失败不退出：部分源挂掉是常态，昨天的 DXY 比没有 DXY 有用。
        node tools/macro-daily.js --quiet || {
          rc=$?
          echo "[macro] 本轮采集未完全成功（退出码 ${rc}），下一轮继续 —— 部分源挂掉不等于这一轮白跑"
        }
        node tools/events-daily.js --quiet || {
          rc=$?
          echo "[events] 本轮事件抓取未完全成功（退出码 ${rc}），下一轮继续"
        }
      fi
      if [ "$RUN_SNAPSHOT" = "1" ]; then
        # 走本地看板取完整快照：自己另拉一遍会绕过它的限流窗口与缓存。
        HL_BASE="http://127.0.0.1:${PORT}" node tools/snapshot-daily.js --quiet || {
          rc=$?
          echo "[snapshot] 本轮落档未成功（退出码 ${rc}），下一轮继续 —— 服务刚起或限流都可能让它失败"
        }
      fi
      sleep "$DAILY_INTERVAL"
    done
  ) &
  DAILY_PID=$!
else
  echo "[entrypoint] 每日采集循环已全部关闭（HL_MACRO=0 且 HL_SNAPSHOT=0）—— 历史账本只在有人打开页面时才更新"
fi

# ───────── 每日总结：北京时间 18:00 把方向/读数/事件/持仓/预警压成一条推到微信 ─────────
#
# 为什么是守护进程而不是 cron：容器里没有 cron，装一个为了这一件事不划算；
# 它自己算「下一个 18:00 还有多久」再睡，重启后由 brief-state.json 保证同一天不重复推。
BRIEF_PID=""
if [ "${HL_BRIEF:-1}" = "1" ]; then
  echo "[entrypoint] 每日总结已启用：每天 ${HL_BRIEF_AT:-18:00}（北京时间）推送"
  HL_BASE="http://127.0.0.1:${PORT}" node tools/daily-brief.js --daemon &
  BRIEF_PID=$!
else
  echo "[entrypoint] 每日总结已关闭（HL_BRIEF=0）"
fi

stop_all() {
  if [ -n "$BRIEF_PID" ]; then kill "$BRIEF_PID" 2>/dev/null || true; fi
  if [ -n "$DAILY_PID" ]; then kill "$DAILY_PID" 2>/dev/null || true; fi
  if [ -n "$WATCH_PID" ]; then kill "$WATCH_PID" 2>/dev/null || true; fi
  kill "$SERVER_PID" 2>/dev/null || true
}
trap stop_all TERM INT

# 只等看板服务：它挂了容器就退出，交给 restart 策略拉起。
wait "$SERVER_PID"
