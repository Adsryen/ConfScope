param(
  [string]$DataDir,
  [switch]$SkipBackup,
  [switch]$ViteOrigin,
  [switch]$NoLaunch,
  [switch]$ProductionBuild
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrWhiteSpace($DataDir)) {
  $DataDir = Join-Path $repo "portable\ConfScopeData"
}

if (-not (Test-Path -LiteralPath $DataDir)) {
  throw "Data directory does not exist: $DataDir"
}

$resolvedDataDir = (Resolve-Path -LiteralPath $DataDir).Path

if (-not $SkipBackup) {
  $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $backupRoot = Join-Path $repo "local-backups\before-dev-portable-data-$timestamp"
  $backupDest = Join-Path $backupRoot "ConfScopeData"
  # 数据目录含 WebView2 深层缓存树（如 EBWebView\component_crx_cache\<64位哈希>），
  # 拼上备份前缀后会超过 Windows MAX_PATH(260)，Copy-Item 直接 DirectoryNotFound；
  # robocopy 走 Win32 长路径无此限制，备份一律用 robocopy（退出码 >=8 才算失败）。
  $null = robocopy $resolvedDataDir $backupDest /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS /NP
  if ($LASTEXITCODE -ge 8) {
    throw "robocopy backup failed (exit code $LASTEXITCODE): $resolvedDataDir -> $backupDest"
  }
  Write-Host "Data backup created: $backupDest"
}

$env:CONFSCOPE_DATA_DIR = $resolvedDataDir
Write-Host "Dev data directory: $env:CONFSCOPE_DATA_DIR"

if ($ViteOrigin) {
  Write-Host "Starting original Wails dev with Vite origin."
  Write-Host "Note: Vite origin uses a separate WebView localStorage origin and may not show production connections."
  pnpm dev:plain
  exit $LASTEXITCODE
}

if ($ProductionBuild) {
  Write-Host "Building production app for same-origin portable-data testing."
  Write-Host "Production build does not enable right-click Inspect Element."
  pnpm build
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
  $exePath = Join-Path $repo "build\bin\ConfScope.exe"
} else {
  Write-Host "Building debug app for same-origin portable-data testing."
  Write-Host "DevTools are enabled in this mode, so you can right-click and inspect elements."
  wails build -debug -devtools -nopackage -o ConfScope-debug.exe
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
  $exePath = Join-Path $repo "build\bin\ConfScope-debug.exe"
}

if (-not (Test-Path -LiteralPath $exePath)) {
  throw "Build output does not exist: $exePath"
}

Write-Host "Built debug/test executable: $exePath"
if ($NoLaunch) {
  Write-Host "NoLaunch was set; skip launching the app."
  exit 0
}

Write-Host "Launching with CONFSCOPE_DATA_DIR: $env:CONFSCOPE_DATA_DIR"
& $exePath
exit $LASTEXITCODE



