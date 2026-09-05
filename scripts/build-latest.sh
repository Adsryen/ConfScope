#!/usr/bin/env bash
# build-latest.sh — 一键用最新代码重编 ConfScope（Linux / WSL）
#
# 用法:
#   scripts/build-latest.sh                 # 安装依赖 + 构建前端(含生产守卫) + wails build
#   scripts/build-latest.sh --skip-frontend # 快速编译：跳过前端构建，仅重编 Go 侧（仅改 Go 代码时用）
#   scripts/build-latest.sh --launch        # 构建后启动（默认数据目录 portable/ConfScopeData）
#   scripts/build-latest.sh --clean         # 先删除 node_modules 再重装（Windows 侧构建后链接损坏时用）
#
# 说明:
#   - 前端构建链路为 pnpm build:web && pnpm check:bundle，
#     生产 bundle 含 retest/manual-bridge 脚手架时构建直接失败。
#   - 产物: build/bin/ConfScope（WSLg/桌面环境可直接运行）。
#   - 数据目录: 默认 exe 旁 ConfScopeData，可用 CONFSCOPE_DATA_DIR 覆盖。
#   - 依赖: Go >= 1.25（优先 /usr/local/go）、pnpm、wails CLI（缺失时自动装 v2.13.0）、
#           libwebkit2gtk-4.1-dev、libgtk-3-dev。
#   - 若在 Windows 侧运行过 build-latest.ps1，本侧 node_modules 可能损坏，
#     报错时加 --clean 重试。
set -euo pipefail
cd "$(dirname "$0")/.."

LAUNCH=0
CLEAN=0
SKIP_FRONTEND=0
for arg in "$@"; do
  case "$arg" in
    --launch) LAUNCH=1 ;;
    --clean) CLEAN=1 ;;
    --skip-frontend) SKIP_FRONTEND=1 ;;
    *) echo "未知参数: $arg（支持 --skip-frontend / --launch / --clean）" >&2; exit 2 ;;
  esac
done
START_SECONDS=$SECONDS

# 1) Go：优先 /usr/local/go（>=1.25），其次 PATH 上的 go
if [ -x /usr/local/go/bin/go ]; then
  export PATH="/usr/local/go/bin:$PATH"
fi
GO_VER="$(go version 2>/dev/null | awk '{print $3}' || true)"
if [ -z "$GO_VER" ]; then
  echo "错误: 未找到 Go。请安装 Go >= 1.25（如 /usr/local/go）。" >&2
  exit 1
fi
case "$GO_VER" in
  go1.2[5-9]*|go1.[3-9][0-9]*|go[2-9].*) : ;;
  *) echo "错误: Go 版本过低: $GO_VER（需要 >= 1.25）。" >&2; exit 1 ;;
esac

command -v pnpm >/dev/null 2>&1 || { echo "错误: 未找到 pnpm。" >&2; exit 1; }
pkg-config --exists webkit2gtk-4.1 2>/dev/null || {
  echo "错误: 缺少 webkit2gtk-4.1 开发库。请: sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev" >&2
  exit 1
}

# 2) wails CLI：缺失时安装与 go.mod 一致的 v2.13.0
export PATH="$HOME/go/bin:$PATH"
if ! command -v wails >/dev/null 2>&1; then
  echo ">> 安装 wails CLI v2.13.0 ..."
  go install github.com/wailsapp/wails/v2/cmd/wails@v2.13.0
fi

# 3) 依赖
if [ "$CLEAN" -eq 1 ]; then
  echo ">> 清理 node_modules ..."
  rm -rf node_modules
fi
export CI=true
echo ">> 安装依赖 (pnpm install) ..."
pnpm install --frozen-lockfile

# 4) 构建（frontend:build 内含生产守卫 check:bundle）
if [ "$SKIP_FRONTEND" -eq 1 ]; then
  [ -d dist ] || { echo "错误: 未找到 dist/，请先完整构建一次（不加 --skip-frontend）。" >&2; exit 1; }
  echo ">> wails build -s（快速编译：复用现有前端 dist，仅重编 Go 侧）..."
  wails build -s
else
  echo ">> wails build ..."
  wails build
fi

BIN="build/bin/ConfScope"
[ -x "$BIN" ] || { echo "错误: 未找到产物 $BIN" >&2; exit 1; }
echo ""
echo "构建完成: $BIN（耗时 ${SECONDS}s）"
echo "直接运行: ./$BIN   （数据目录: exe 旁 ConfScopeData，或 CONFSCOPE_DATA_DIR 指定）"

if [ "$LAUNCH" -eq 1 ]; then
  export CONFSCOPE_DATA_DIR="${CONFSCOPE_DATA_DIR:-$PWD/portable/ConfScopeData}"
  if [ ! -d "$CONFSCOPE_DATA_DIR" ]; then
    echo "警告: 数据目录不存在: $CONFSCOPE_DATA_DIR（将在 exe 旁新建）"
  fi
  nohup ./"$BIN" >/tmp/confscope-linux.log 2>&1 &
  echo "已启动应用（数据目录: $CONFSCOPE_DATA_DIR，日志: /tmp/confscope-linux.log）"
fi
