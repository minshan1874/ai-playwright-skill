#!/usr/bin/env bash
#
# Install the playwright-e2e skill for DSH.
#
#   ./install.sh                 # 安装到 ~/.dsh/skills/playwright-e2e（全局，任何项目可用）
#   ./install.sh --project       # 安装到 ./.dsh/skills/playwright-e2e（仅当前项目）
#   ./install.sh --link          # 用软链接指向本仓库（开发用，改代码立即生效）
#   ./install.sh --force         # 覆盖已存在的安装
#   ./install.sh --target <目录> # 安装到指定目录
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$SCRIPT_DIR/skill"
SKILL_NAME="playwright-e2e"

MODE="global"
FORCE=0
TARGET=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) MODE="project"; shift ;;
    --link)    MODE="link"; shift ;;
    --force)   FORCE=1; shift ;;
    --target)  TARGET="${2:-}"; shift 2 ;;
    -h|--help)
      sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "未知参数：$1" >&2
      echo "运行 ./install.sh --help 查看用法。" >&2
      exit 2
      ;;
  esac
done

# --- Resolve the destination ------------------------------------------------
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"

if [[ -n "$TARGET" ]]; then
  DEST="$TARGET"
elif [[ "$MODE" == "project" ]]; then
  DEST="$(pwd)/.dsh/skills/$SKILL_NAME"
else
  DEST="$DSH_HOME/skills/$SKILL_NAME"
fi

# --- Sanity-check the source ------------------------------------------------
if [[ ! -f "$SOURCE_DIR/SKILL.md" ]]; then
  echo "❌ 找不到 $SOURCE_DIR/SKILL.md，请在仓库根目录运行本脚本。" >&2
  exit 1
fi

SKILL_NAME_IN_FILE="$(awk '/^name:[[:space:]]*/{print $2; exit}' "$SOURCE_DIR/SKILL.md" | tr -d '\r')"
if [[ "$SKILL_NAME_IN_FILE" != "$SKILL_NAME" ]]; then
  echo "❌ SKILL.md 的 name 字段是「${SKILL_NAME_IN_FILE:-空}」，期望「$SKILL_NAME」。" >&2
  echo "   DSH 要求 name 为 kebab-case 且与目录名一致。" >&2
  exit 1
fi

if ! grep -q '^description:[[:space:]]*.' "$SOURCE_DIR/SKILL.md"; then
  echo "❌ SKILL.md 缺少 description 字段，DSH 会忽略这个 skill。" >&2
  exit 1
fi

# --- Install ----------------------------------------------------------------
if [[ -e "$DEST" || -L "$DEST" ]]; then
  if [[ "$FORCE" -ne 1 ]]; then
    echo "⚠️  $DEST 已存在。"
    echo "   要覆盖请加 --force；要移除旧版本请先运行 ./uninstall.sh。"
    exit 1
  fi
  echo "→ 移除已存在的安装：$DEST"
  rm -rf "$DEST"
fi

mkdir -p "$(dirname "$DEST")"

if [[ "$MODE" == "link" ]]; then
  ln -s "$SOURCE_DIR" "$DEST"
  echo "✅ 已创建软链接：$DEST → $SOURCE_DIR"
else
  # node_modules is never shipped; the toolchain is installed at runtime.
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --exclude 'node_modules' --exclude '.npm-cache' --exclude 'runs' "$SOURCE_DIR/" "$DEST/"
  else
    cp -R "$SOURCE_DIR" "$DEST"
    rm -rf "$DEST/node_modules" "$DEST/.npm-cache" "$DEST/runs"
  fi
  echo "✅ 已安装到：$DEST"
fi

# --- Verify -----------------------------------------------------------------
if [[ ! -f "$DEST/SKILL.md" ]]; then
  echo "❌ 安装后校验失败：$DEST/SKILL.md 不存在。" >&2
  exit 1
fi

FILE_COUNT="$(find "$DEST" -type f -not -path '*/node_modules/*' | wc -l | tr -d ' ')"
echo "   共 $FILE_COUNT 个文件。"

cat <<EOF

下一步
──────────────────────────────────────────────
1. 在 DSH 中新开一个会话（skill 目录会被自动扫描，无需重启 DSH 服务）。
2. 用 /$SKILL_NAME 调用，或直接说：
   「用 playwright-e2e 测一下 https://example.com，用例文件是 xxx.xlsx」

首次使用时会自动安装 Playwright 环境（依赖 + Chromium）。
运行数据默认放在 ~/.dsh/playwright-e2e/，不会污染被测项目。

想先离线验证整条链路：
   node "$DEST/scripts/demo.mjs"
EOF

if [[ "$MODE" == "project" ]]; then
  cat <<EOF

提示：本次是项目级安装，只对 $(pwd) 生效。
如果 .dsh/ 被提交到版本库，建议把 .dsh/skills/ 加入 .gitignore。
EOF
fi
