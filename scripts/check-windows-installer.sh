#!/usr/bin/env bash
# 在 Linux/WSL 上静态校验 Windows 安装包脚本能不能编译。
#
# 为什么要单独有这一个脚本：project.nsi 是手写的，而它的语法错误过去只能在
# Windows 的 wails build -nsis 里第一次暴露（CI 从来不出安装包 = 从来没验证过）。
# 本脚本让 preflight 作业（ubuntu）提前用 makensis 把语法/宏顺序/语言表问题抓出来。
#
# 只校验语法，不校验运行时行为（本机没有 Windows，装不了）。运行时验收靠
# tests/ux/windowsInstallerKeepsDataAndMatchesRuntimeLayout.test.ts 的文本判据。
#
# 但「字符串编码」这一类例外：POSIX 侧的 makensis 恒按 UTF-8 读脚本，缺 BOM 也不会乱，
# 所以本地编译过 ≠ Windows 编译出来没乱码（v1.9.9 就是这道闸门全绿而线上安装包乱码）。
# 这里额外跑一次 scripts/check-installer-strings.mjs：它在 Linux 上证明的是「判据本身没坏」
# （判据失效时本步骤会红），真正的 Windows 侧证据在 release.yml 的 build 作业里对
# 真实产物再跑一次同一条命令。
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

# 产物级字符串体检（判红就退出非 0）
ARTIFACT="${ROOT}/build/bin/confscope-windows-amd64-installer.exe"
if [ -f "${ARTIFACT}" ] && command -v node >/dev/null 2>&1; then
  # 必须看到实际输出：判据脚本没真的跑（入口判定不成立时它会静默 exit 0）就等于没闸门
  node "${ROOT}/scripts/check-installer-strings.mjs" "${ARTIFACT}" | grep -E "UTF-16LE"
elif [ -n "${REQUIRE_STRING_CHECK:-}" ]; then
  echo "REQUIRE_STRING_CHECK=1 但没跑成字符串体检（缺 node 或缺产物）" >&2
  exit 1
fi

echo "OK: project.nsi 通过 makensis 编译校验"
