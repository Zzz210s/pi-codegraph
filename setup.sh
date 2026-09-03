#!/usr/bin/env bash
# pi-codegraph 一键部署:把扩展安装到 ~/.pi/agent/extensions/codegraph/ 并装依赖。
# 幂等:可重复运行。真源为本仓库;config-pi 的 setup.sh 也会在部署后调用本脚本。
# 用法:bash setup.sh [--test](--test 先跑单测,失败则中止部署)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"

log(){ printf '\033[1;34m[codegraph]\033[0m %s\n' "$*"; }
warn(){ printf '\033[1;33m[codegraph:warn]\033[0m %s\n' "$*" >&2; }
die(){ printf '\033[1;31m[codegraph:err]\033[0m %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null || die "未找到 node(需 >= 24,原生 TS 类型剥离 + 测试)"
command -v npm  >/dev/null || die "未找到 npm"

if [ "${1:-}" = "--test" ]; then
  log "安装依赖并运行单测..."
  (cd "$REPO_DIR/extensions/codegraph" && npm ci --silent 2>/dev/null || npm install --silent) || die "依赖安装失败"
  (cd "$REPO_DIR/extensions/codegraph" && npm test --silent) || die "单测失败,中止部署"
fi

DEST="$AGENT_DIR/extensions/codegraph"
log "部署 codegraph -> $DEST"
rm -rf "$DEST"
cp -r "$REPO_DIR/extensions/codegraph" "$DEST"

log "安装原生依赖(tree-sitter / better-sqlite3)..."
(cd "$DEST" && npm install --omit=dev --silent) || die "依赖安装失败(检查 .npmrc legacy-peer-deps 与构建工具链)"

log "完成。新会话或 /reload 后生效;/reindex <仓库根> 建索引,/code doctor 体检。"
