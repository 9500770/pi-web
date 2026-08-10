#!/bin/bash
#
# pi-permission-fix
# 检查 pi-permission-modes 的 process.cwd() 项目根 bug 是否已修复：
#   - 未安装          → 跳过，无需处理
#   - 已修复          → 报告 OK
#   - 未修复          → 钉住当前版本（防 pi update 覆盖）并打补丁（备份后修改）
#
# 背景：该插件用 process.cwd() 作为“项目根”。CLI 在项目目录里启动时碰巧
# 正确；但 pi-web 从安装目录启动服务进程，process.cwd() 恒为安装目录，
# 导致会话项目内的一切路径都被误判为 outside project。
# 修复：在 session_start / tool_call 时把 root 绑定为 ctx.cwd（会话 cwd）。
#
# 用法: bash pi-permission-fix [--dry-run]
# 环境变量覆盖（测试用）:
#   PM_PKG_DIR     插件安装目录（默认 ~/.pi/agent/npm/node_modules/pi-permission-modes）
#   SETTINGS_FILE  全局 settings.json（默认 ~/.pi/agent/settings.json）
#
set -euo pipefail

DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then DRY_RUN=1; fi

PM_PKG_DIR="${PM_PKG_DIR:-$HOME/.pi/agent/npm/node_modules/pi-permission-modes}"
SETTINGS_FILE="${SETTINGS_FILE:-$HOME/.pi/agent/settings.json}"
PREFIX="npm:pi-permission-modes"

log() { echo "[pi-permission-fix] $*"; }

# ---------- 1. 未安装则跳过 ----------
if [ ! -d "$PM_PKG_DIR" ]; then
  log "pi-permission-modes 未安装，无需处理。"
  exit 0
fi

INDEX="$PM_PKG_DIR/src/index.ts"
if [ ! -f "$INDEX" ]; then
  log "未找到 $INDEX（包结构异常，跳过）"
  exit 1
fi

# ---------- 2. 检查是否已修复 ----------
if grep -q "root = ctx.cwd" "$INDEX" 2>/dev/null; then
  log "OK: 已修复（src/index.ts 已包含会话级项目根 root = ctx.cwd）。"
  exit 0
fi

log "检测到未修复版本：项目根仍取 process.cwd()（pi-web 下会误报 outside project）。"

# ---------- 3. 读取版本 + 检查是否钉住 ----------
VERSION=$(python3 -c "
import json
print(json.load(open('$PM_PKG_DIR/package.json')).get('version',''))
" 2>/dev/null || true)
if [ -z "$VERSION" ]; then
  log "无法读取插件版本，请手动处理。"
  exit 1
fi
log "当前版本: $VERSION"

PINNED=$(python3 -c "
import json, sys
pkg = '$PREFIX'
try:
    d = json.load(open('$SETTINGS_FILE'))
except Exception:
    sys.exit(0)
for e in (d.get('packages') or []):
    s = e if isinstance(e, str) else e.get('source', '')
    if s.startswith(pkg + '@') and len(s) > len(pkg) + 1:
        print('yes')
        sys.exit(0)
" 2>/dev/null || true)

if [ "$PINNED" != "yes" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    log "[dry-run] 将执行: pi install ${PREFIX}@${VERSION}（钉住版本，防止 pi update 覆盖补丁）"
  else
    log "钉住版本: pi install ${PREFIX}@${VERSION} ..."
    pi install "${PREFIX}@${VERSION}"
  fi
else
  log "版本已钉住（${PREFIX}@${VERSION}），跳过重装。"
fi

if [ "$DRY_RUN" = "1" ]; then
  log "[dry-run] 将备份并修改 $INDEX"
  exit 0
fi

# ---------- 4. 备份 + 打补丁 ----------
BACKUP="$INDEX.bak-$(date +%Y%m%d%H%M%S)"
cp "$INDEX" "$BACKUP"
log "备份: $BACKUP"

python3 - "$INDEX" <<'PYEOF'
import sys
p = sys.argv[1]
s = open(p, encoding="utf-8").read()

old1 = "  const root = process.cwd();"
new1 = ("  // Session project root. process.cwd() is the launcher's cwd, which is wrong\n"
        "  // under pi-web (the server runs from its install dir) — re-bind it to the\n"
        "  // session cwd on session_start and at each tool_call gate.\n"
        "  let root = process.cwd();")
assert s.count(old1) == 1, "patch target 1 not found (版本可能已变化，请手动处理)"
s = s.replace(old1, new1)

old2 = ('  pi.on("session_start", async (_event, ctx) => {\n'
        "    uiCtx = ctx;\n"
        "    config = loadModeConfig(ctx.cwd, getAgentDir(), (m) =>")
new2 = ('  pi.on("session_start", async (_event, ctx) => {\n'
        "    uiCtx = ctx;\n"
        "    root = ctx.cwd; // the session's project root, not the launcher cwd\n"
        "    config = loadModeConfig(ctx.cwd, getAgentDir(), (m) =>")
assert s.count(old2) == 1, "patch target 2 not found (版本可能已变化，请手动处理)"
s = s.replace(old2, new2)

old3 = ('  pi.on("tool_call", async (event, ctx) => {\n'
        "    uiCtx = ctx;\n"
        "    const { toolName } = event;")
new3 = ('  pi.on("tool_call", async (event, ctx) => {\n'
        "    uiCtx = ctx;\n"
        "    root = ctx.cwd; // hardening: /reload re-runs factories and resets root\n"
        "    const { toolName } = event;")
assert s.count(old3) == 1, "patch target 3 not found (版本可能已变化，请手动处理)"
s = s.replace(old3, new3)

open(p, "w", encoding="utf-8").write(s)
print("patch applied")
PYEOF

if grep -q "root = ctx.cwd" "$INDEX"; then
  log "OK: 补丁已应用 -> $INDEX"
  log "    备份: $BACKUP"
  log "    重启 pi-web (pi-web-daemon restart) 或重开 pi CLI 后生效。"
  exit 0
else
  log "ERROR: 补丁应用后校验失败，请检查 $INDEX（可用备份回滚）。"
  exit 1
fi
