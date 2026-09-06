<#
build-latest.ps1 — 一键用最新代码重编 ConfScope.exe（Windows）

用法:
  scripts\build-latest.ps1                  # 安装依赖 + 构建前端(含生产守卫) + wails build
  scripts\build-latest.ps1 -SkipFrontend   # 快速编译：跳过前端构建，仅重编 Go 侧（仅改 Go 代码时用）
  scripts\build-latest.ps1 -Launch         # 构建后用 portable\ConfScopeData 数据目录启动应用
  scripts\build-latest.ps1 -ForceClean     # 先删除 node_modules 再重装（Linux 侧构建后链接损坏时用）

说明:
  - 前端构建链路为 pnpm build:web && pnpm check:bundle，
    生产 bundle 含 retest/manual-bridge 脚手架时构建直接失败。
  - 产物: build\bin\ConfScope.exe（桌面快捷方式指向同一文件，重编即生效）。
  - 数据目录: portable\ConfScopeData（经 CONFSCOPE_DATA_DIR 环境变量注入；Windows 可用本地启动脚本）。
  - 若在 WSL/Linux 侧运行过 build-latest.sh，Windows 侧 node_modules 可能损坏，
    报 EACCES/ENOENT 时加 -ForceClean 重试。
#>
param(
  [switch]$Launch,
  [switch]$ForceClean,
  [switch]$SkipFrontend
)
$ErrorActionPreference = "Stop"
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
$env:CI = "true"
$startTime = Get-Date

if ($ForceClean) {
  Write-Host ">> cleaning node_modules ..." -ForegroundColor Yellow
  if (Test-Path node_modules) { Remove-Item -Recurse -Force node_modules }
}

Write-Host ">> installing dependencies (pnpm install) ..." -ForegroundColor Cyan
pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw "pnpm install failed. If it is a permission/link issue (EACCES), delete node_modules and retry with -ForceClean." }

if ($SkipFrontend) {
  if (-not (Test-Path dist)) { throw "dist/ not found. Run a full build once first (without -SkipFrontend)." }
  Write-Host ">> wails build -s (fast build: reuse existing frontend dist, rebuild Go side only)..." -ForegroundColor Cyan
  wails build -s
} else {
  Write-Host ">> building frontend + production guard + wails build ..." -ForegroundColor Cyan
  wails build
}

$exe = Join-Path (Split-Path -Parent $PSScriptRoot) "build\bin\ConfScope.exe"
if (-not (Test-Path $exe)) { throw "build output not found: $exe" }
$stamp = (Get-Item $exe).LastWriteTime
Write-Host ""
Write-Host "Build finished: $exe" -ForegroundColor Green
Write-Host ("Build took " + [math]::Floor(((Get-Date) - $startTime).TotalSeconds) + "s")

if ($Launch) {
  $dataDir = Join-Path (Split-Path -Parent $PSScriptRoot) "portable\ConfScopeData"
  if (-not (Test-Path $dataDir)) { throw "data dir not found: $dataDir" }
  $env:CONFSCOPE_DATA_DIR = $dataDir
  Start-Process -FilePath $exe
  Write-Host "App launched (data dir: $dataDir)" -ForegroundColor Green
} else {
  Write-Host "Launch via the desktop shortcut, or: scripts\build-latest.ps1 -Launch"
}
