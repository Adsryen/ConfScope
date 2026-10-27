#!/usr/bin/env bash
# tag-release.sh — 打 tag 的唯一入口（轮102）
#
# 为什么要有一个入口脚本：v1.9.14→v1.9.19 一天发六个版本，用户一句都没同意过。
# 根因不是手滑，是 AI 把会话里零散的「发版吧」提炼成了一条常驻规则「用户习惯：做完就发版」，
# 之后每轮都拿这条推定的规则当授权用。推定的授权不叫授权。这个脚本把授权变成交换物：
# 必须逐字交出用户当前这轮对话里的原话，原话进 release-approvals.log，
# verify-release-version.sh 的第 0 道闸门只认那条记录（且不能早于待发布的提交）。
#
# 用法:
#   scripts/tag-release.sh --version=1.9.20 --quote="发版吧" --push   # 记授权→自检→打 tag→推送
#   scripts/tag-release.sh --version=1.9.20 --quote="发版吧"          # 同上，但 tag 留在本地不推
# 任一步不过即非 0 退出，且不会留下半个 tag。
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=""
QUOTE=""
PUSH=0
VERIFY_ARGS=()

for arg in "$@"; do
  case "$arg" in
    --version=*) VERSION="${arg#*=}" ;;
    --quote=*) QUOTE="${arg#*=}" ;;
    --push) PUSH=1 ;;
    --skip-bundle) VERIFY_ARGS+=("--skip-bundle") ;;
    *) echo "未知参数: $arg（支持 --version=x.y.z / --quote=\"用户原话\" / --push / --skip-bundle）" >&2; exit 2 ;;
  esac
done

if [ -z "$VERSION" ]; then
  echo "用法: scripts/tag-release.sh --version=x.y.z --quote=\"用户在当前对话里的原话\" [--push]" >&2
  exit 2
fi
if [ -z "$QUOTE" ]; then
  echo "拒绝：没有 --quote 就没有授权。发版需要先让用户在当前这轮对话里明确说出来。" >&2
  exit 3
fi

# 授权原话的校验与入账都在 release-consent.sh 里，这里只负责串起来：
# 先过工作区/tag 存在性，再入账，再跑闸门，最后才打 tag——顺序反了就会留下
# 「有授权记录但没有版本」或「tag 已推但闸门红」的半截状态。
# 未提交的改动进不了 tag，发出去的产物就会和仓库不一致
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "拒绝：工作区有未提交改动，先提交，再来谈发版。" >&2
  git status --short --untracked-files=no >&2
  exit 4
fi

TAG="v$VERSION"
if git rev-parse -q --verify "$TAG" >/dev/null; then
  echo "tag $TAG 已存在，不重复发版（要往前走得先有新提交和新的用户同意）。" >&2
  exit 5
fi

bash scripts/release-consent.sh record --version="$VERSION" --quote="$QUOTE"

echo ">> 发版自检（第 0 道就是刚才那条授权）"
bash scripts/verify-release-version.sh --version="$VERSION" ${VERIFY_ARGS[@]+"${VERIFY_ARGS[@]}"}

git tag -a "$TAG" -m "ConfScope $TAG"
echo "已打本地 tag $TAG（$(git rev-parse --short HEAD)）。"

if [ "$PUSH" -eq 1 ]; then
  git push origin "$TAG"
  echo "已推送 $TAG：CI 开始出包并在 GitHub Releases 覆盖发布，用户侧「检查更新」会看到它。"
else
  echo "未推送。确认无误后自己执行: git push origin $TAG"
fi
