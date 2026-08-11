#!/bin/bash
#
# install-perm-mode.sh — 安装 perm-mode 扩展（权限模式切换 + 状态栏）
#
# 用法: bash install-perm-mode.sh
#
# 行为:
#   1. 检查 pi-permission-system 是否已安装（策略执行依赖它）
#   2. 复制 perm-mode-extension/ 到 ~/.pi/agent/extensions/perm-mode/
#   3. 提示重启/重载生效
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/perm-mode-extension"
EXT_DIR="${EXT_DIR:-$HOME/.pi/agent/extensions}"
DEST="$EXT_DIR/perm-mode"

echo "==> 检查 pi-permission-system..."
if [ ! -d "$HOME/.pi/agent/extensions/pi-permission-system" ] \
   && ! ls "$HOME/.pi/agent/extensions/"*pi-permission-system* >/dev/null 2>&1 \
   && [ ! -d "$HOME/.pi/agent/npm/node_modules/@gotgenes/pi-permission-system" ]; then
  echo "!! 未检测到 pi-permission-system，请先安装:"
  echo "   pi install npm:@gotgenes/pi-permission-system"
  echo "   （perm-mode 只负责切换配置和显示，策略执行需要 pi-permission-system）"
fi

if [ ! -f "$SRC/index.ts" ]; then
  echo "ERROR: 找不到插件源码: $SRC/index.ts" >&2
  exit 1
fi

echo "==> 安装到 $DEST"
mkdir -p "$EXT_DIR"
if [ -d "$DEST" ]; then
  cp -r "$SRC/." "$DEST/"
else
  cp -r "$SRC" "$DEST"
fi

echo "==> 校验"
[ -f "$DEST/index.ts" ] && echo "   OK: $DEST/index.ts" || { echo "ERROR: 安装失败" >&2; exit 1; }

echo ""
echo "安装完成。重启 pi 会话（或 /reload）后生效。"
echo "使用:"
echo "   /perm-mode build      # 切 build 模式（项目内读写+bash自动，/tmp读放行）"
echo "   /perm-mode ask        # 切 ask 模式（项目内读+常用读bash自动）"
echo "   /perm-mode status     # 查看当前模式（状态栏也会常驻显示）"
echo ""
echo "注意: 项目需信任（/trust）后项目级配置才加载。"
