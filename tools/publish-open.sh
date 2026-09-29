#!/bin/sh
# 把当前仓库的**可运行部分**推到公开分发仓库，供「一条命令直接下载安装」。
#
# 为什么要分两个仓库：
#   · 这个（私有）仓库留着 README / docs —— 说明文档、走查报告、安全边界说明
#   · 分发仓库 hyperliquid-dashboard-open 是**公开**的，只放跑起来需要的东西
#     （源码、Dockerfile、install.sh、配置模板），不带说明文件
#
# 分发仓库的历史不留：每次都是**单条提交的快照**（force push），
# 免得翻旧版本时翻出已删除的文档，也省得把私有仓库的提交历史公开出去。
#
# 用法：sh tools/publish-open.sh
set -e

OPEN_URL=https://github.com/natserver/hyperliquid-dashboard-open.git
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# 从当前仓库的最新提交 clone。
# `file://` 前缀不是可有可无的：**本地路径 clone 会忽略 --depth**（git 明说的），
# 于是整个私有仓库的提交历史 —— 连同历史里的 README、docs、报告 ——
# 会被一起推到公开仓库去。第一次发布就这么中过一次（公开仓库上挂了 8 个提交）。
#
# 光有 --depth 仍然不够：浅克隆的提交**带着父引用**，直接 push 过去，
# GitHub 上那条提交依旧指向私有历史（parents:1），等于历史还挂在公开仓库上。
# 所以下面必须 `checkout --orphan` 重开一条**无父**提交再推。
git clone -q --depth 1 "file://$ROOT" "$TMP/dist"
cd "$TMP/dist"

# 说明文件不进分发仓库
rm -rf README.md docs report

git checkout -q --orphan dist
git add -A
git -c core.safecrlf=false commit -q -m "比特皇看板 · 直接下载安装用的代码" \
  -m "只有跑起来需要的东西：源码、Dockerfile、install.sh、配置模板。不带说明文档。"

# -f：公开仓库只保留这一条无父快照
git push -f -q "$OPEN_URL" dist:master

echo "✓ 已同步到 $OPEN_URL"
echo "  首次安装："
echo "    wget -O - ${OPEN_URL%.git}/archive/refs/heads/master.tar.gz | tar xz -C /root && cd /root/hyperliquid-dashboard-open-master && sh install.sh"
echo "  以后更新（在已装好的项目目录里执行）："
echo "    cd /root/hyperliquid-dashboard-open-master && wget -O - ${OPEN_URL%.git}/archive/refs/heads/master.tar.gz | tar xz --strip-components=1 -C . && sh install.sh"
echo "    ↑ 更新必须 --strip-components=1：不剥顶层目录会多套一层，覆盖不到旧文件。"
