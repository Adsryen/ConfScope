#!/usr/bin/env bash
# release-consent.sh — 发布授权的账本与闸门（轮102）
#
# 为什么需要它：v1.9.14→v1.9.19 一天发六个版本，用户一句都没同意过（「我都没同意发版啊？」）。
# 根因不是手滑，是会话里零散的「发版吧」被提炼成常驻规则「用户习惯：做完就发版」，
# 之后每轮都把这条**推定**当成授权来执行，v1.9.19 更是在用户要求的真机验证还没跑完时就发了。
# 推定的授权不是授权。这个脚本把授权变成可核对的实物：必须有用户当前这轮对话里的原话，
# 原话进账本，发版闸门只认账本里那条记录，而且记录不得早于待发布的提交。
#
# 用法:
#   scripts/release-consent.sh check  --version=1.9.20
#   scripts/release-consent.sh record --version=1.9.20 --quote="发版吧"
# 账本每行: <ISO 时间>\tv<x.y.z>\tquote=<用户原话>\tby=<账户>\tcommit=<HEAD 短哈希>
# 位置: ${CONFSCOPE_RELEASE_APPROVALS:-.trellis/workspace/ryen/release-approvals.log}
#
# 为什么单独成一个脚本而不是塞进 verify-release-version.sh：那条闸门第 4 步会跑 vitest，
# 测试里再 exec 整条闸门就是自我递归（轮102 真踩过，一次卡死七层 vitest）。
# 授权校验必须能被单独调用、单独测试。
set -euo pipefail
cd "$(dirname "$0")/.."

APPROVAL_LOG="${CONFSCOPE_RELEASE_APPROVALS:-.trellis/workspace/ryen/release-approvals.log}"

CMD="${1:-}"
VERSION=""
QUOTE=""
for arg in "${@:2}"; do
  case "$arg" in
    --version=*) VERSION="${arg#*=}" ;;
    --quote=*) QUOTE="${arg#*=}" ;;
    *) echo "未知参数: $arg（支持 --version=x.y.z / --quote=\"用户原话\"）" >&2; exit 2 ;;
  esac
done

if [ -z "$CMD" ] || [ -z "$VERSION" ]; then
  echo "用法: scripts/release-consent.sh check|record --version=x.y.z [--quote=\"用户在当前对话里的原话\"]" >&2
  exit 2
fi

TAG="v$VERSION"

# 原话得真是一句同意：有发布动作词，且没有被否定过。
# 否定词表比正面词表重要——「我还没同意发版」「先实测后再说」都含「发版」，
# 只查正面词就等于把拒绝读成许可。
validate_quote() {
  local quote="$1"
  if [ -z "$quote" ]; then
    echo "拒绝：没有原话就没有授权。要发版，先让用户在当前这轮对话里明确说出来。" >&2
    return 3
  fi
  if ! printf '%s' "$quote" | grep -qE "发版|发布|上线|推上去|推送并发布|出包"; then
    echo "拒绝：这句话里找不到发布授权（$quote）" >&2
    return 3
  fi
  if printf '%s' "$quote" | grep -qE "不要发|不用发|先别|别发|还没|不许|禁止|等一下|等等再|先测|先实测|没同意"; then
    echo "拒绝：这句话听上去是不发、或还没到发的时机（$quote）" >&2
    return 3
  fi
  return 0
}

case "$CMD" in
  record)
    validate_quote "$QUOTE"
    mkdir -p "$(dirname "$APPROVAL_LOG")"
    printf '%s\t%s\tquote=%s\tby=%s\tcommit=%s\n' \
      "$(date -Is)" "$TAG" "$QUOTE" "$(id -un)" "$(git rev-parse --short HEAD)" >> "$APPROVAL_LOG"
    echo "授权已入账：$TAG  <-  「$QUOTE」"
    ;;

  check)
    if [ -n "${GITHUB_ACTIONS:-}" ]; then
      echo "  ✓ CI 环境跳过授权校验（能走到这里说明 tag 已被人推送，授权在推送之前完成）"
      exit 0
    fi
    RECORD="$(awk -F'\t' -v tag="$TAG" '$2==tag{line=$0} END{print line}' "$APPROVAL_LOG" 2>/dev/null || true)"
    if [ -z "$RECORD" ]; then
      echo "  ✗ 没有 $TAG 的授权记录：没有用户同意就不能发。等用户明确说了，再走 scripts/tag-release.sh --version=$VERSION --quote=\"用户原话\" --push" >&2
      exit 1
    fi
    REC_TS="$(printf '%s' "$RECORD" | cut -f1)"
    QUOTE_TEXT="$(printf '%s' "$RECORD" | cut -f3 | sed 's/^quote=//')"
    EPOCH_E="$(date -d "$REC_TS" +%s 2>/dev/null || echo 0)"
    EPOCH_H="$(git log -1 --format=%ct)"
    if [ -z "$QUOTE_TEXT" ]; then
      echo "  ✗ $TAG 的授权记录里没有用户原话：一条空记录不算授权" >&2
      exit 1
    fi
    if ! validate_quote "$QUOTE_TEXT" >/dev/null 2>&1; then
      echo "  ✗ $TAG 的授权原话过不了校验（记的是「$QUOTE_TEXT」）" >&2
      exit 1
    fi
    if [ "$EPOCH_E" -lt "$EPOCH_H" ]; then
      echo "  ✗ 授权（$REC_TS）早于待发布提交 $(git log -1 --format='%h %cd' --date=iso)：那是上一批代码的同意，不能复用到 $TAG" >&2
      exit 1
    fi
    echo "  ✓ 已获授权 $TAG：「$QUOTE_TEXT」（记录于 $REC_TS）"
    ;;

  *)
    echo "未知命令: $CMD（只支持 check / record）" >&2
    exit 2
    ;;
esac
