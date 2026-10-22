#!/usr/bin/env bash
# 在 Linux/WSL 上静态校验 Windows 安装包脚本能不能编译。
#
# 为什么要单独有这一个脚本：project.nsi 是手写的，而它的语法错误过去只能在
# Windows 的 wails build -nsis 里第一次暴露（CI 从来不出安装包 = 从来没验证过）。
# 本脚本让 preflight 作业（ubuntu）提前用 makensis 把语法/宏顺序/语言表问题抓出来。
#
# 只校验语法，不校验运行时行为（本机没有 Windows，装不了）。运行时验收靠
# tests/ux/windowsInstallerKeepsDataAndMatchesRuntimeLayout.test.ts 的文本判据。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALLER_DIR="${ROOT}/build/windows/installer"
BIN="${ROOT}/build/bin/ConfScope.exe"
BOOTSTRAPPER="${INSTALLER_DIR}/tmp/MicrosoftEdgeWebview2Setup.exe"

MAKENSIS="${MAKENSIS:-}"
if [ -z "${MAKENSIS}" ]; then
  MAKENSIS="$(command -v makensis || true)"
fi

if [ -z "${MAKENSIS}" ]; then
  echo "SKIP: 找不到 makensis（可设 MAKENSIS=/path/to/makensis）。"
  echo "      Debian/Ubuntu: apt-get install -y nsis；Windows: choco install nsis -y"
  exit 0
fi

# -VERSION 而不是 /VERSION：Debian/Ubuntu 打包的 makensis 把 / 开头的参数当脚本路径
# （实测报 "Can't open script /VERSION"），而 - 前缀在 Windows 的 NSIS 上也一样可用。
echo "makensis: $("${MAKENSIS}" -VERSION 2>/dev/null || echo unknown)"

# makensis 的 File 源路径相对它自己的 CWD，所以二进制必须给绝对路径。
if [ ! -f "${BIN}" ]; then
  echo "NOTE: 没有 ${BIN}，用占位文件只做语法校验（产物不可用）"
  BIN="${ROOT}/build/bin/confscope-installer-syntax-check.bin"
  mkdir -p "${ROOT}/build/bin"
  printf 'PLACEHOLDER' > "${BIN}"
fi

# wails_tools.nsh 里 File "tmp\MicrosoftEdgeWebview2Setup.exe" 需要这个文件存在。
# 真实构建时 wails v2.13 会从 CLI 自带的内嵌资产把它写进 tmp/（pkg/commands/build/
# nsis_installer.go -> webview2runtime.WriteInstallerToFile），CI 不需要另外下载；
# 只有本机没装 wails CLI 的场合（比如本脚本）才用占位文件做纯语法校验。
if [ ! -f "${BOOTSTRAPPER}" ]; then
  mkdir -p "${INSTALLER_DIR}/tmp"
  printf 'PLACEHOLDER' > "${BOOTSTRAPPER}"
fi

cd "${INSTALLER_DIR}"
# NSISDIR 是给「非标准安装位置」（例如 dpkg -x 解到临时目录）用的重定向开关
if [ -n "${NSISDIR:-}" ]; then
  export NSISDIR
fi
"${MAKENSIS}" -DARG_WAILS_AMD64_BINARY="$(readlink -f "${BIN}")" project.nsi

echo "OK: project.nsi 通过 makensis 编译校验"
