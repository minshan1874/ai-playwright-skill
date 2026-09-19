#!/usr/bin/env bash
#
# Uninstall the playwright-e2e skill.
#
#   ./uninstall.sh                 # 移除 ~/.dsh/skills/playwright-e2e
#   ./uninstall.sh --project       # 移除 ./.dsh/skills/playwright-e2e
#   ./uninstall.sh --target <目录> # 移除指定目录
#   ./uninstall.sh --purge         # 同时删除 ~/.dsh/playwright-e2e（依赖、运行数据、登录态）
#
set -euo pipefail

SKILL_NAME="playwright-e2e"
MODE="global"
PURGE=0
TARGET=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) MODE="project"; shift ;;
    --purge)   PURGE=1; shift ;;
    --target)  TARGET="${2:-}"; shift 2 ;;
    -h|--help)
      sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "未知参数：$1" >&2
      exit 2
      ;;
  esac
done

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
HOME_DIR="${PLAYWRIGHT_E2E_HOME:-$DSH_HOME/playwright-e2e}"

if [[ -n "$TARGET" ]]; then
  DEST="$TARGET"
elif [[ "$MODE" == "project" ]]; then
  DEST="$(pwd)/.dsh/skills/$SKILL_NAME"
else
  DEST="$DSH_HOME/skills/$SKILL_NAME"
fi

if [[ -e "$DEST" || -L "$DEST" ]]; then
  rm -rf "$DEST"
  echo "✅ 已移除 skill：$DEST"
else
  echo "ℹ️  未找到 skill：$DEST（可能已经移除）"
fi

if [[ "$PURGE" -eq 1 ]]; then
  if [[ -d "$HOME_DIR" ]]; then
    SIZE="$(du -sh "$HOME_DIR" 2>/dev/null | cut -f1 || echo '未知')"
    rm -rf "$HOME_DIR"
    echo "✅ 已删除运行数据：$HOME_DIR（释放 $SIZE）"
    echo "   包含：Playwright 依赖、npm 缓存、历史运行记录、保存的登录态。"
  else
    echo "ℹ️  未找到运行数据目录：$HOME_DIR"
  fi
else
  if [[ -d "$HOME_DIR" ]]; then
    cat <<EOF

ℹ️  运行数据仍保留在：$HOME_DIR
   其中包含已安装的 Playwright 依赖、历史运行记录和保存的登录态。
   如需一并删除：./uninstall.sh --purge
EOF
  fi
fi
