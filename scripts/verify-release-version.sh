#!/usr/bin/env bash
# verify-release-version.sh — 打 tag 之前把「版本号能不能真的进产物」验一遍（轮51）
#
# 为什么需要这条脚本：Go 链接器对**不存在的** `-X` 注入目标静默忽略
# （`-X nope.nope.NotThere=1` 一样 exit 0、零警告）。77fa451 把 appVersion 从 package main
# 迁到 confscope/internal/app 之后，release.yml 仍写 `-X main.appVersion=${VERSION}`，
# 于是 CI 构建全绿、v1.9.1 的发布产物却永远带着 "dev"：关于页显示 vdev，
# 而 parseVersion("dev") 等价 0.0.0 ⇒「检查更新」永远提示有新版本。
# 这类漂移不会产生任何报错，只能靠可执行证据拦在发版前。
#
# 轮52 在这条闸门上补了两件事，因为它们是同一个洞的另一半：
#   - 发版链路此前一条检查都不跑（vite/esbuild 只剥类型），所以这里跑过的守卫
#     要在 CI 的 preflight 作业里同样跑一遍（release.yml 里判据由守卫钉住）；
#   - update.json 的 notes 原先取自「尚未创建的 Release」，线上恒为占位文案，
#     现在由 scripts/extract-release-notes.mjs 从 CHANGELOG 抽，抽不到就别发。
#
# 用法:
#   scripts/verify-release-version.sh                 # 以 package.json 的版本号自检
#   scripts/verify-release-version.sh --version 1.9.2 # 显式指定待发布版本
#   scripts/verify-release-version.sh --skip-bundle   # 跳过前端构建（只改 Go/CI 时快跑）
# 任一检查不过即非 0 退出——那时不要打 tag。
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/usr/local/go/bin:$PATH"

VERSION=""
SKIP_BUNDLE=0
for arg in "$@"; do
  case "$arg" in
    --version) echo "错误: --version 需要跟一个 x.y.z" >&2; exit 2 ;;
    --version=*) VERSION="${arg#*=}" ;;
    --skip-bundle) SKIP_BUNDLE=1 ;;
    *) echo "未知参数: $arg（支持 --version=x.y.z / --skip-bundle）" >&2; exit 2 ;;
  esac
done

failures=0
ok() { echo "  ✓ $1"; }
bad() { echo "  ✗ $1" >&2; failures=$((failures + 1)); }

# 注入符号的事实源：变量真实所在的包 + 变量名
GO_VERSION_FILE="internal/app/app.go"
INJECT_SYMBOL="confscope/internal/app.appVersion"

echo ">> 1) 版本号四处一致（package.json / CHANGELOG / tag / wails.json）"
PKG_VERSION="$(node -p "require('./package.json').version")"
if [ -z "$VERSION" ]; then
  VERSION="$PKG_VERSION"
fi
if [ "$VERSION" = "$PKG_VERSION" ]; then
  ok "package.json version = $VERSION"
else
  bad "package.json 是 $PKG_VERSION，本次要发的是 $VERSION（发版提交里一起改）"
fi
if grep -qE "^## \[$VERSION\] - [0-9]{4}-[0-9]{2}-[0-9]{2}" CHANGELOG.md; then
  ok "CHANGELOG 有 [$VERSION] 段落"
else
  bad "CHANGELOG 缺 [$VERSION] 段落（或段落没有日期）"
fi
UNRELEASED_BODY="$(perl -0pe 's/<!--.*?-->//gs' CHANGELOG.md | awk '/^## \[Unreleased\]/{flag=1;next} /^## \[/{flag=0} flag' | tr -d '[:space:]')"
if [ -z "$UNRELEASED_BODY" ]; then
  ok "[Unreleased] 已清空（内容都并进具体版本了）"
else
  bad "CHANGELOG 的 [Unreleased] 还有内容，先并入 [$VERSION]"
fi
# wails.json 的 info.productVersion 是 Windows 安装包版本号的第二条通道：wails 用它渲染
# build/windows/installer/wails_tools.nsh，进而进 VIProductVersion（exe 文件属性）、
# 卸载条目的 DisplayVersion 和 install.json 的 version。过去只有 CI 用 jq 改写工作副本，
# 发版提交与本地构建脚本都不碰它，于是仓库里躺着 1.9.5、分支/本地自构建的安装包
# 属性页也永远显示 1.9.5——三处一致的闸门看不见它，因为它压根不在闸门里。
WAILS_PRODUCT_VERSION="$(node -p "require('./wails.json').info.productVersion" 2>/dev/null)" || WAILS_PRODUCT_VERSION=""
if [ "$WAILS_PRODUCT_VERSION" = "$VERSION" ]; then
  ok "wails.json info.productVersion = $VERSION（安装包文件属性/卸载条目/install.json 取这里）"
else
  bad "wails.json 的 info.productVersion 是 ${WAILS_PRODUCT_VERSION:-读不出来}，本次要发的是 $VERSION：发版提交里一起改，否则自构建的安装包属性还是旧版本号"
fi

if git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null; then
  echo "  · tag v$VERSION 已存在（刚发过属正常；重复发布请先删本地 tag 再确认远端）" >&2
fi

echo ">> 2) 构建期注入符号确实打中 Go 声明"
if grep -qE "^var appVersion = \"dev\"$" "$GO_VERSION_FILE"; then
  ok "$GO_VERSION_FILE 的 appVersion 保持字符串默认值 dev"
else
  bad "$GO_VERSION_FILE 里 appVersion 的默认声明形态变了，判据要同步改"
fi
for entrypoint in .github/workflows/release.yml scripts/build-latest.sh scripts/build-latest.ps1; do
  if grep -q -- "-X ${INJECT_SYMBOL}=" "$entrypoint"; then
    ok "$entrypoint 注入 $INJECT_SYMBOL"
  else
    bad "$entrypoint 没有注入 $INJECT_SYMBOL（漏注入或包路径写错，链接器只会静默忽略）"
  fi
done

echo ">> 3) 注入动作的可执行证据（正例 + 变异对照）"
if command -v go >/dev/null 2>&1; then
  if CONFSCOPE_EXPECT_APP_VERSION=9.9.9 go test -count=1 \
      -ldflags "-X ${INJECT_SYMBOL}=9.9.9" \
      -run TestAppVersionInjectionLandsInThisPackage ./internal/app/ >/dev/null 2>&1; then
    ok "带 -ldflags 注入 9.9.9 后包内读到 9.9.9"
  else
    bad "注入 9.9.9 没落进 internal/app：符号路径与变量所在包不一致"
  fi
  if CONFSCOPE_EXPECT_APP_VERSION=9.9.9 go test -count=1 \
      -ldflags "-X main.appVersion=9.9.9" \
      -run TestAppVersionInjectionLandsInThisPackage ./internal/app/ >/dev/null 2>&1; then
    bad "旧写法 -X main.appVersion 居然也过：断言在空转，这条检查没有意义"
  else
    ok "变异对照：旧写法 -X main.appVersion 如预期落空（本轮线上事故的形态）"
  fi
else
  bad "未找到 go（>=1.25），无法验证注入"
fi

echo ">> 4) 静态守卫与单测"
# 失败时把 vitest 的用例名与断言原文一起吐出来。此前一律进 /dev/null，只报一句「见上面用例名」，
# 而上面根本没有——本地和 CI 的 preflight 撞上这条都得再手工跑一遍这 4 个文件才知道红在哪一条。
GUARD_TESTS=(
  tests/ux/buildVersionSymbolResolvesToGoDeclaration.test.ts
  tests/ux/backgroundUpdateCheckSkipsUnreleasedBuild.test.ts
  tests/ux/releaseChainContractStaysAligned.test.ts
  src/lib/appVersion.test.ts
)
GUARD_LOG="$(mktemp -t confscope-release-guard.XXXXXX)"
if npx vitest run --reporter=dot "${GUARD_TESTS[@]}" >"$GUARD_LOG" 2>&1; then
  ok "版本链路与发版契约相关的 4 个测试文件全绿"
else
  bad "版本号或发版契约的守卫/单测有红，用例名与断言见下"
  tail -80 "$GUARD_LOG" >&2
fi
rm -f "$GUARD_LOG"

echo ">> 5) 发版说明能真的抽出来（update.json 的 notes 与 GitHub Release 正文都是给用户看的文字）"
NOTES_OUT="$(node scripts/extract-release-notes.mjs "$VERSION" 2>/dev/null)" || NOTES_OUT=""
if [ -n "$NOTES_OUT" ]; then
  ok "CHANGELOG 的 [$VERSION] 段落抽出 $(printf '%s\n' "$NOTES_OUT" | wc -l) 行发行说明"
else
  bad "抽不出 [$VERSION] 的发行说明：CI 出包会在这一步红，别带着占位文案发布"
fi
if grep -q -- "extract-release-notes.mjs" .github/workflows/release.yml; then
  ok "release.yml 的 notes 走 extract-release-notes.mjs（不再读尚未创建的 Release）"
else
  bad "release.yml 不再调用 extract-release-notes.mjs：更新说明会退回「发行版 x.y.z」"
fi

# GitHub Release 正文与上面同源（轮58）：本仓库不走 PR 流程，GitHub 的自动注记只会剩一行 compare 链接
BODY_OUT="$(node scripts/sync-github-release-notes.mjs --print-body="$VERSION" 2>/dev/null)" || BODY_OUT=""
if printf '%s' "$BODY_OUT" | grep -q '^### ' && printf '%s' "$BODY_OUT" | grep -q '^\*\*Full Changelog\*\*: '; then
  ok "CHANGELOG 的 [$VERSION] 段落能渲染成 Release 正文（$(printf '%s\n' "$BODY_OUT" | wc -l) 行，含 compare 链接）"
else
  bad "渲染不出 [$VERSION] 的 Release 正文：releases 页又会只剩一行链接，先补齐 CHANGELOG 段落"
fi
if grep -q -- "sync-github-release-notes.mjs" .github/workflows/release.yml && grep -q -- "body_path:" .github/workflows/release.yml; then
  ok "release.yml 的 Release 正文走 sync 脚本 + body_path"
else
  bad "release.yml 不再由 sync 脚本渲染正文／没有 body_path：GitHub Release 会退回自动注记（只剩一行 compare）"
fi
if grep -q -- "generate_release_notes: true" .github/workflows/release.yml; then
  bad "release.yml 又打开了 generate_release_notes：自动注记会把 CHANGELOG 渲染的正文顶掉"
fi

if [ "$SKIP_BUNDLE" -eq 1 ]; then
  echo ">> 6) 前端构建与生产守卫：已按 --skip-bundle 跳过"
else
  echo ">> 6) 前端构建与生产守卫（脚手架不得混进产物）"
  if pnpm build:web >/dev/null 2>&1 && pnpm check:bundle >/dev/null 2>&1; then
    ok "pnpm build:web + check:bundle 通过"
  else
    bad "前端构建或生产守卫没通过"
  fi
fi

echo
if [ "$failures" -ne 0 ]; then
  echo "结论：$failures 项不过，先别打 tag v$VERSION。" >&2
  exit 1
fi
echo "结论：版本号链路就绪，可以发布 v$VERSION。"
echo "  发布动作由人执行（会触发 CI 出包，不可逆）："
echo "    git tag -a v$VERSION -m \"ConfScope v$VERSION\""
echo "    git push origin v$VERSION"
