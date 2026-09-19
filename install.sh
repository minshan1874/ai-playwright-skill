#!/usr/bin/env bash
#
# Install the playwright-e2e skill for DSH and/or Codex.
#
#   ./install.sh                 # 安装到 ~/.dsh/skills/playwright-e2e（DSH 全局）
#   ./install.sh --codex         # 安装到 ~/.codex/skills/playwright-e2e（Codex 全局）
#   ./install.sh --all           # 同时装到 DSH 和 Codex
#   ./install.sh --project       # 安装到 ./.dsh/skills/playwright-e2e（仅当前项目）
#   ./install.sh --update        # 就地覆盖更新所有已发现的副本（含装错目录名的）
#   ./install.sh --status        # 只检查各处已安装副本的版本，不安装
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
STATUS_ONLY=0
UPDATE_ONLY=0
TARGETS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) MODE="project"; TARGETS+=("project"); shift ;;
    --codex)   TARGETS+=("codex"); shift ;;
    --all)     TARGETS+=("dsh" "codex"); shift ;;
    --link)    MODE="link"; shift ;;
    --force)   FORCE=1; shift ;;
    --status)  STATUS_ONLY=1; shift ;;
    --update)  UPDATE_ONLY=1; shift ;;
    --target)  TARGET="${2:-}"; shift 2 ;;
    -h|--help)
      sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "未知参数：$1" >&2
      echo "运行 ./install.sh --help 查看用法。" >&2
      exit 2
      ;;
  esac
done

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"


# --- Read the version declared by a SKILL.md --------------------------------
skill_version() {
  local file="$1"
  [[ -f "$file" ]] || { echo "?"; return; }
  awk '/^metadata:/{m=1} m&&/^[[:space:]]+version:/{gsub(/[^0-9.]/,"",$2); print $2; exit}' "$file"
}

# --- Read the `name:` declared by a SKILL.md --------------------------------
skill_name() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  awk '/^name:[[:space:]]*/{print $2; exit}' "$file" | tr -d '\r'
}

# --- Content hash of a skill tree --------------------------------------------
# Comparing only one file is not enough: an agent editing SKILL.md in place would
# go unnoticed while the version string still claimed to match.
_hash_tool() {
  if command -v shasum >/dev/null 2>&1; then echo "shasum"
  elif command -v sha1sum >/dev/null 2>&1; then echo "sha1sum"
  else echo ""
  fi
}

tree_hash() {
  local dir="$1" tool
  tool="$(_hash_tool)"
  [[ -n "$tool" ]] || { echo "unknown"; return; }
  (
    cd "$dir" || exit 1
    find . -type f \
      -not -path './node_modules/*' \
      -not -path './.npm-cache/*' \
      -not -path './runs/*' \
      -not -name '.DS_Store' \
      -not -name '*.updating.*' \
      -not -name '*.old.*' \
      | LC_ALL=C sort \
      | while IFS= read -r f; do "$tool" "$f"; done
  ) | "$tool" | awk '{print $1}'
}

# --- Every directory holding a copy of THIS skill ----------------------------
# Scans the roots rather than fixed paths, because a copy installed under the
# wrong directory name (e.g. `skills/skill/`) is exactly the kind of stale
# duplicate that goes unnoticed.
find_copies() {
  for root in "$DSH_HOME/skills" "$CODEX_HOME/skills" "$(pwd)/.dsh/skills"; do
    [[ -d "$root" ]] || continue
    for dir in "$root"/*/; do
      [[ -f "$dir/SKILL.md" ]] || continue
      [[ "$(skill_name "$dir/SKILL.md")" == "$SKILL_NAME" ]] || continue
      echo "${dir%/}"
    done
  done
}

# --- Report every installed copy and whether it matches the source -----------
report_status() {
  local source_version source_hash
  source_version="$(skill_version "$SOURCE_DIR/SKILL.md")"
  source_hash="$(tree_hash "$SOURCE_DIR")"
  echo "源码版本：$source_version"

  local copies
  copies="$(find_copies)"
  if [[ -z "$copies" ]]; then
    echo
    echo "未发现任何已安装副本。"
    return
  fi

  echo
  printf "%-10s %-8s %s\n" "版本" "内容" "路径"
  printf "%-10s %-8s %s\n" "────" "────" "────"
  while IFS= read -r dir; do
    [[ -n "$dir" ]] || continue
    local version mark="✅"
    version="$(skill_version "$dir/SKILL.md")"
    # Compare the whole tree: an agent editing SKILL.md in place leaves the
    # scripts identical while the documentation silently diverges.
    [[ "$(tree_hash "$dir")" == "$source_hash" ]] || mark="⚠️ 不同"
    printf "%-10s %-8s %s\n" "$version" "$mark" "$dir"
  done <<< "$copies"

  local stale
  stale="$(while IFS= read -r dir; do
    [[ -n "$dir" ]] || continue
    if [[ "$(tree_hash "$dir")" != "$source_hash" ]] \
       || [[ "$(skill_version "$dir/SKILL.md")" != "$source_version" ]]; then
      echo "$dir"
    fi
  done <<< "$copies")"

  if [[ -n "$stale" ]]; then
    echo
    echo "⚠️  以下副本与源码不一致（版本号不同，或内容被改过）："
    while IFS= read -r dir; do
      [[ -n "$dir" ]] && echo "     $dir"
    done <<< "$stale"
    echo "    运行 ./install.sh --update 可就地覆盖修复。"
  fi

  # Two copies under one root means the loader picks one arbitrarily — usually
  # the older one, which is exactly the confusing failure this check exists for.
  local duplicates
  duplicates="$(echo "$copies" | sed 's|/[^/]*$||' | sort | uniq -d)"
  if [[ -n "$duplicates" ]]; then
    echo
    echo "⚠️  以下目录里有多个同名 skill 副本，加载哪一份不确定，请删掉多余的："
    while IFS= read -r root; do
      [[ -n "$root" ]] || continue
      echo "     $root/"
      echo "$copies" | grep "^$root/" | sed 's|^|       |'
    done <<< "$duplicates"
  fi
}

if [[ "$STATUS_ONLY" -eq 1 ]]; then
  report_status
  exit 0
fi

# --- Resolve the destination ------------------------------------------------
if [[ ${#TARGETS[@]} -eq 0 ]]; then
  if [[ -n "$TARGET" ]]; then
    TARGETS=("explicit")
  elif [[ "$MODE" == "project" ]]; then
    TARGETS=("project")
  else
    TARGETS=("dsh")
  fi
fi

# --- Sanity-check the source ------------------------------------------------
if [[ ! -f "$SOURCE_DIR/SKILL.md" ]]; then
  echo "❌ 找不到 $SOURCE_DIR/SKILL.md，请在仓库根目录运行本脚本。" >&2
  exit 1
fi

SKILL_NAME_IN_FILE="$(awk '/^name:[[:space:]]*/{print $2; exit}' "$SOURCE_DIR/SKILL.md" | tr -d '\r')"
if [[ "$SKILL_NAME_IN_FILE" != "$SKILL_NAME" ]]; then
  echo "❌ SKILL.md 的 name 字段是「${SKILL_NAME_IN_FILE:-空}」，期望「${SKILL_NAME}」。" >&2
  echo "   DSH 与 Codex 都要求 name 为 kebab-case 且与目录名一致。" >&2
  exit 1
fi

if ! grep -q '^description:[[:space:]]*.' "$SOURCE_DIR/SKILL.md"; then
  echo "❌ SKILL.md 缺少 description 字段，运行时会被忽略。" >&2
  exit 1
fi

# --- Update every copy in place ---------------------------------------------
# Replaces a directory using a staging dir plus a swap, so a failure midway
# leaves the previous install intact instead of a half-copied mess.
replace_dir() {
  local dest="$1"
  local staging="$dest.updating.$$"
  local backup="$dest.old.$$"

  rm -rf "$staging" "$backup"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --exclude 'node_modules' --exclude '.npm-cache' --exclude 'runs' "$SOURCE_DIR/" "$staging/"
  else
    cp -R "$SOURCE_DIR" "$staging"
    rm -rf "$staging/node_modules" "$staging/.npm-cache" "$staging/runs"
  fi

  mv "$dest" "$backup" || { rm -rf "$staging"; return 1; }
  if mv "$staging" "$dest"; then
    rm -rf "$backup"
    return 0
  fi
  # Roll back so the caller still has a working install.
  mv "$backup" "$dest"
  rm -rf "$staging"
  return 1
}

update_all_copies() {
  local copies
  copies="$(find_copies)"

  if [[ -z "$copies" ]]; then
    echo "未发现任何已安装副本，无需更新。"
    echo "首次安装请运行：./install.sh [--codex|--all]"
    return 0
  fi

  local source_version updated=0 failed=0
  source_version="$(skill_version "$SOURCE_DIR/SKILL.md")"

  while IFS= read -r dir; do
    [[ -n "$dir" ]] || continue
    # Never overwrite the source itself, e.g. when the repo sits inside a
    # scanned skills root.
    if [[ "$(cd "$dir" && pwd -P)" == "$(cd "$SOURCE_DIR" && pwd -P)" ]]; then
      echo "⏭  跳过源码目录本身：$dir"
      continue
    fi

    local before
    before="$(skill_version "$dir/SKILL.md")"
    if replace_dir "$dir"; then
      echo "✅ 已更新：${dir}（$before → ${source_version}）"
      updated=$((updated + 1))
    else
      echo "❌ 更新失败，已回滚到原状：$dir" >&2
      failed=$((failed + 1))
    fi
  done <<< "$copies"

  echo
  echo "更新完成：$updated 个成功，$failed 个失败。"
  [[ "$failed" -eq 0 ]]
}

if [[ "$UPDATE_ONLY" -eq 1 ]]; then
  update_all_copies
  echo
  report_status
  exit $?
fi

# --- Install ----------------------------------------------------------------
install_into() {
  local dest="$1"

  if [[ -e "$dest" || -L "$dest" ]]; then
    if [[ "$FORCE" -ne 1 ]]; then
      echo "⚠️  $dest 已存在，跳过。"
      echo "   要覆盖请加 --force。"
      return 1
    fi
    echo "→ 移除已存在的安装：$dest"
    rm -rf "$dest"
  fi

  mkdir -p "$(dirname "$dest")"

  if [[ "$MODE" == "link" ]]; then
    ln -s "$SOURCE_DIR" "$dest"
    echo "✅ 已创建软链接：$dest → $SOURCE_DIR"
  else
    # node_modules is never shipped; the toolchain is installed at runtime.
    if command -v rsync >/dev/null 2>&1; then
      rsync -a --exclude 'node_modules' --exclude '.npm-cache' --exclude 'runs' "$SOURCE_DIR/" "$dest/"
    else
      cp -R "$SOURCE_DIR" "$dest"
      rm -rf "$dest/node_modules" "$dest/.npm-cache" "$dest/runs"
    fi
    echo "✅ 已安装到：$dest"
  fi

  if [[ ! -f "$dest/SKILL.md" ]]; then
    echo "❌ 安装后校验失败：$dest/SKILL.md 不存在。" >&2
    return 1
  fi

  local count
  count="$(find "$dest" -type f -not -path '*/node_modules/*' | wc -l | tr -d ' ')"
  echo "   共 $count 个文件，版本 $(skill_version "$dest/SKILL.md")。"
  return 0
}

INSTALLED_ANY=0
LAST_DEST=""

for target in "${TARGETS[@]}"; do
  case "$target" in
    dsh)     dest="$DSH_HOME/skills/$SKILL_NAME" ;;
    codex)   dest="$CODEX_HOME/skills/$SKILL_NAME" ;;
    project) dest="$(pwd)/.dsh/skills/$SKILL_NAME" ;;
    explicit) dest="$TARGET" ;;
    *)       echo "❌ 未知安装目标：$target" >&2; exit 2 ;;
  esac
  if install_into "$dest"; then
    INSTALLED_ANY=1
    LAST_DEST="$dest"
  fi
done

if [[ "$INSTALLED_ANY" -eq 0 ]]; then
  echo
  echo "没有安装任何副本。如需覆盖，请加 --force。"
  exit 1
fi

cat <<EOF

下一步
──────────────────────────────────────────────
1. 在 DSH / Codex 中新开一个会话（skill 目录会被自动扫描，无需重启服务）。
2. 用 /$SKILL_NAME 调用，或直接说：
   「用 playwright-e2e 测一下 https://example.com，用例文件是 xxx.xlsx」

首次使用时会自动安装 Playwright 环境（依赖 + Chromium）。
浏览器默认有头（会弹窗口）；不想弹窗或用 CI/服务器时加 --headless。

运行数据默认放在 ~/.dsh/playwright-e2e/，不会污染被测项目。

检查各处副本是否为最新：
   ./install.sh --status

想先离线验证整条链路：
   node "$LAST_DEST/scripts/demo.mjs"
EOF

if [[ "$MODE" == "project" ]]; then
  cat <<EOF

提示：本次是项目级安装，只对 $(pwd) 生效。
如果 .dsh/ 被提交到版本库，建议把 .dsh/skills/ 加入 .gitignore。
EOF
fi

# Warn about stale copies elsewhere, which is how a "looks updated" install rots.
echo
report_status
