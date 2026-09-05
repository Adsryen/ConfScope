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
  Write-Host ">> 清理 node_modules ..." -ForegroundColor Yellow
  if (Test-Path node_modules) { Remove-Item -Recurse -Force node_modules }
}

Write-Host ">> 安装依赖 (pnpm install) ..." -ForegroundColor Cyan
pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw "pnpm install 失败。若为权限/链接问题（EACCES），请在 WSL 中 rm -rf node_modules 后加 -ForceClean 重试。" }

if ($SkipFrontend) {
  if (-not (Test-Path dist)) { throw "未找到 dist/，请先完整构建一次（不加 -SkipFrontend）" }
  Write-Host ">> wails build -s（快速编译：复用现有前端 dist，仅重编 Go 侧）..." -ForegroundColor Cyan
  wails build -s
} else {
  Write-Host ">> 构建前端 + 生产守卫 + wails build ..." -ForegroundColor Cyan
  wails build
}

$exe = Join-Path (Split-Path -Parent $PSScriptRoot) "build\bin\ConfScope.exe"
if (-not (Test-Path $exe)) { throw "未找到产物 $exe" }
$stamp = (Get-Item $exe).LastWriteTime
Write-Host ""
Write-Host "构建完成: $exe" -ForegroundColor Green
Write-Host ("构建耗时: " + [math]::Floor(((Get-Date) - $startTime).TotalSeconds) + "s")

if ($Launch) {
  $dataDir = Join-Path (Split-Path -Parent $PSScriptRoot) "portable\ConfScopeData"
  if (-not (Test-Path $dataDir)) { throw "数据目录不存在: $dataDir" }
  $env:CONFSCOPE_DATA_DIR = $dataDir
  Start-Process -FilePath $exe
  Write-Host "已启动应用（数据目录: $dataDir）" -ForegroundColor Green
} else {
  Write-Host "启动方式: 桌面快捷方式，或 scripts\build-latest.ps1 -Launch"
}
