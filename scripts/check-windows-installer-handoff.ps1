# 升级交接实测（轮71）：在真的 Windows 上把「安装程序能不能覆盖」这一脚跑穿。
#
# 为什么要真机跑：project.nsi 里的判据是内核调用，Linux 侧只能证明它编译得过。
# v1.9.9 线上事故的形态——应用窗口早就没了、安装程序却永远卡在「等待 ConfScope 退出」——
# 在文本判据里完全看不出来。这里用四种真实进程状态去撞同一道闸门，退出码就是断言：
# 场景 A 在轮100 从「必须 75」翻成「必须 0 + 三条让位断言」：装得上不再依赖旧进程肯不肯退，
# 但代价是旧窗口还在跑老版本，所以断言不能只看退出码，必须同时看到遗留文件与活着的旧进程。
#
#   A  目标 exe 正被某个进程当镜像加载着   -> 必须 0 （等满一轮后改名让位，新文件照样落地，旧进程一个也不许终止）
#   B1 /PID 给的是一个还在跑的无关进程     -> 必须 0 （v1.9.9 在这里白等 15 秒）
#   B2 进程已退出、但句柄仍被别处引用       -> 必须 0 （v1.9.9 在这里永久判忙 = 线上事故）
#   C  没有 /PID（人工双击）且目标空闲      -> 必须 0
#
# 轮141 加了一条附赠红线：四个场景都走 /S，静默收尾**既不许弹框也不许把应用拉起来**
# （「装完立刻打开」是给人看的，静默下收尾弹窗必须自动取「否」）。判定只看硬证据：
# WorkRoot 下冒出一个「不是本轮人造占用进程」的 ConfScope 实例，就是它被拉起来了。
# 进度页文字（码页不可靠）只当第二条佐证。不用「新 exe 被占用」当判据：杀软扫一眼
# 刚落地文件就会短暂锁住，那是假失败。
#
# 用法（CI 的 windows 作业里直接调用）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-windows-installer-handoff.ps1
#   可选 -Installer <安装包路径>；成功时最后一行打印 "HANDOFF-CI ok scenarios=4"。

param(
    [string]$Installer = "",
    [string]$WorkRoot = "",
    [int]$TimeoutSec = 180
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $Installer) {
    $Installer = Join-Path $repoRoot "build\bin\confscope-windows-amd64-installer.exe"
}
if (-not (Test-Path -LiteralPath $Installer)) {
    throw "找不到安装包：$Installer（先构建 -nsis 安装包，或用 -Installer 指定路径）"
}
$Installer = (Resolve-Path -LiteralPath $Installer).Path

if (-not $WorkRoot) {
    # NSIS 的 /D= 取命令行里它之后的全部内容：路径带空格时 PowerShell 会加引号，
    # 引号会渗进 InstallDir，四个场景全变成测不到目标的假绿。挑一个不含空格的位置。
    $candidates = @(@($env:TEMP, $env:LOCALAPPDATA, $env:USERPROFILE) | Where-Object { $_ -and ($_ -notmatch " ") })
    if ($candidates.Count -eq 0) {
        throw "找不到没有空格的临时目录：NSIS 的 /D= 不接受带引号的路径，请用 -WorkRoot 指定一个不含空格的目录"
    }
    $WorkRoot = Join-Path $candidates[0] ("confscope-handoff-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
}
if ($WorkRoot -match " ") {
    throw "工作目录不能带空格（NSIS /D= 的解析限制）：$WorkRoot"
}
New-Item -ItemType Directory -Force -Path $WorkRoot | Out-Null

$script:results = @()
$script:spawned = @()
$script:launchFaults = @()

# resolveInstallDir 会优先回读 HKCU 卸载项里的 InstallLocation，把传进去的 /D 覆盖掉。
# 每个场景之前必须抹掉这一项，否则上一个场景装的目录会渗进下一个场景。
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\ConfScope'

function Remove-UninstallEntry {
    if (Test-Path -LiteralPath $uninstallKey) {
        Remove-Item -LiteralPath $uninstallKey -Recurse -Force
    }
}

function Start-PersistentProcess {
    # 系统自带的 ping 改名后带 -t 跑起来：进程持续存在。用它当「ConfScope 还开着」的等价物，
    # 是因为它一旦跑起来，它自己的 exe 镜像必然被系统锁住（不用 notepad.exe：
    # Win11 镜像上它是 App Execution Alias 存根，进程立刻退出，场景 A 就锁不住任何东西）。
    param([string]$Destination)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
    Copy-Item -LiteralPath (Join-Path $env:SystemRoot "System32\ping.exe") -Destination $Destination -Force
    $proc = Start-Process -FilePath $Destination -ArgumentList @("-t", "127.0.0.1") -PassThru -WindowStyle Hidden
    $script:spawned += $proc.Id
    return $proc
}

function Test-FileLocked {
    param([string]$Path)
    try {
        $stream = [System.IO.File]::Open($Path, "Open", "ReadWrite", "None")
        $stream.Dispose()
        return $false
    } catch {
        return $true
    }
}

function Get-InstallerConsoleText {
    # 静默安装的进度页文字会被 NSIS 写到 stdout（Invoke-Installer 把它重定向收下来）。
    # 这一条只是佐证：两侧 makensis 在不同宿主码页下写出的字节不一样，中文可能读成乱码，
    # 所以多试几种解码，读到才算证据，读不到绝不影响主判据（看进程）。
    param([string]$StdoutFile)
    if (-not (Test-Path -LiteralPath $StdoutFile)) { return "" }
    $bytes = [System.IO.File]::ReadAllBytes($StdoutFile)
    $encodings = @([System.Text.Encoding]::Unicode, [System.Text.Encoding]::UTF8, [System.Text.Encoding]::Default)
    try { $encodings += [System.Text.Encoding]::GetEncoding(936) } catch { }
    foreach ($enc in $encodings) {
        $text = $enc.GetString($bytes)
        if ($text -match "正在启动" -or $text -match "Starting ConfScope") { return $text }
    }
    return ""
}

function Get-LauncherSpawnedInstance {
    # 「谁把新装的程序跑起来了」的唯一硬证据：WorkRoot 下有个 ConfScope 进程，
    # 而它不是本轮用来制造占用的人造 blocker（那些 PID 都在 $script:spawned 里）。
    try {
        return @(Get-Process -Name "ConfScope" -ErrorAction SilentlyContinue | Where-Object {
            ($_.Path -like "$WorkRoot\*") -and ($script:spawned -notcontains $_.Id)
        })
    } catch {
        return @()
    }
}

function Get-SilentLaunchFault {
    param([string]$StdoutFile)
    $problems = @()
    if (Get-InstallerConsoleText -StdoutFile $StdoutFile) {
        $problems += "进度页打了「正在启动 ConfScope」：/S 静默收尾不许走拉起出口"
    }
    # ExecShell 是异步的，给一点起步时间；问满 6 次 × 300ms 就放过。
    for ($i = 0; $i -lt 6; $i++) {
        $spawned = @(Get-LauncherSpawnedInstance)
        if ($spawned.Count -gt 0) {
            $ids = @($spawned | ForEach-Object { $_.Id }) -join ","
            $problems += "静默收尾把新装的 ConfScope.exe 跑起来了（PID $ids）：装完开不开是给人选的，CI 不许弹框也不许开界面"
            break
        }
        Start-Sleep -Milliseconds 300
    }
    return $problems
}

function Stop-WorkRootConfScope {
    # 判红的那种情况（真把应用拉起来了）不能留在 runner 上继续占文件，也不许误杀别的 ConfScope。
    $victims = @()
    try {
        $victims = @(Get-Process -Name "ConfScope" -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$WorkRoot\*" })
    } catch {
        $victims = @()
    }
    foreach ($v in $victims) {
        Stop-Process -Id $v.Id -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-Installer {
    # 静默升级：/S + /UPDATE（只留进度页，收尾提示走默认按钮）+ /PID=... + /D=...。
    # /D 必须是最后一个参数，NSIS 才把它当安装目录；/PID 带等号要整体加引号。
    param([string]$TargetDir, [string]$PidArg, [string]$StdoutFile)
    $argList = @("/S", "/UPDATE")
    if ($PidArg) {
        $argList += "/PID=$PidArg"
    }
    $argList += "/D=$TargetDir"
    $proc = Start-Process -FilePath $Installer -ArgumentList $argList -PassThru -WindowStyle Hidden -RedirectStandardOutput $StdoutFile
    # 用 WaitForExit(毫秒) 而不是 Wait-Process：后者成功时不输出任何东西，
    # 「if (-not (Wait-Process ...))」恒为真，会把四个场景全判成超时（第一次 CI 跑就是这样误红的）。
    if (-not $proc.WaitForExit($TimeoutSec * 1000)) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        throw "安装程序在 $TimeoutSec 秒内没有退出——这正是 v1.9.9 线上「等待 ConfScope 退出」永不结束的形态"
    }
    Write-Host "  安装进程 $($proc.Id) 退出码 $($proc.ExitCode)"
    return $proc.ExitCode
}

function Invoke-Scenario {
    # 每个场景只往 $script:results 里写一行：CI 断言的是 scenarios=4，多写一行就多一个假失败。
    param(
        [string]$Name,
        [scriptblock]$Prepare,
        [int]$Expect,
        [scriptblock]$PostCheck = $null
    )
    Remove-UninstallEntry
    $targetDir = Join-Path $WorkRoot ("t-" + $Name)
    $stdoutFile = Join-Path $WorkRoot ("stdout-" + [guid]::NewGuid().ToString("N").Substring(0, 8) + ".txt")
    Write-Host ">> $Name（期望退出码 $Expect）目标：$targetDir"
    try {
        $pidArg = & $Prepare $targetDir
        $code = Invoke-Installer -TargetDir $targetDir -PidArg $pidArg -StdoutFile $stdoutFile
        foreach ($fault in @(Get-SilentLaunchFault -StdoutFile $stdoutFile)) {
            $script:launchFaults += "SCENARIO=$Name $fault"
        }
        $exe = Join-Path $targetDir "ConfScope.exe"
        $marker = Join-Path $targetDir "install.json"
        if ($code -ne $Expect) {
            $script:results += "FAIL $Name : 退出码 $code，期望 $Expect"
        }
        elseif ($Expect -eq 0) {
            $detail = ""
            if (-not (Test-Path -LiteralPath $exe)) {
                $detail = "退出码 0，但 $exe 没装上"
            }
            elseif (-not (Test-Path -LiteralPath $marker)) {
                $detail = "装了 exe 却没写 install.json，应用会按便携态解析数据根"
            }
            elseif ($PostCheck) {
                # 让位这类场景光看退出码不够：装上了但把旧进程杀了，同样是事故。
                # 必须在 finally 那段 Stop-Process 之前问，所以 PostCheck 排在 try 里。
                $problems = @(& $PostCheck $targetDir $pidArg)
                if ($problems.Count -gt 0) {
                    $detail = ($problems -join "；")
                }
            }
            if ($detail) {
                $script:results += "FAIL $Name : $detail"
            }
            else {
                $script:results += "ok   $Name : 退出码 $code，已覆盖安装到独立目录"
            }
        }
        elseif (Test-Path -LiteralPath $marker) {
            $script:results += "FAIL $Name : 说好放弃覆盖，却写了安装标记"
        }
        else {
            $script:results += "ok   $Name : 退出码 $code，放弃覆盖且没动目标目录"
        }
    }
    catch {
        $script:results += "FAIL $Name : $_"
    }
    finally {
        Stop-WorkRootConfScope
        foreach ($procId in $script:spawned) {
            Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        }
        $script:spawned = @()
        Start-Sleep -Milliseconds 300
    }
}

# A：目标 exe 正被占用 -> 等满一轮必须让位覆盖（退出码 0），且旧进程一个都不许少
$scenarioA = {
    param($dir)
    $exe = Join-Path $dir "ConfScope.exe"
    $proc = Start-PersistentProcess -Destination $exe
    $deadline = (Get-Date).AddSeconds(10)
    $locked = $false
    while ((Get-Date) -lt $deadline) {
        if (Test-FileLocked -Path $exe) {
            $locked = $true
            break
        }
        Start-Sleep -Milliseconds 200
    }
    if (-not $locked) {
        throw "自证失败：$exe 没被锁住，场景 A 的判据无从谈起"
    }
    return [string]$proc.Id
}

# B1：另一个进程活着，但它跟目标文件毫无关系 -> 不许挡路
$scenarioB1 = {
    param($dir)
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $proc = Start-PersistentProcess -Destination (Join-Path $WorkRoot "unrelated\OtherApp.exe")
    return [string]$proc.Id
}

# B2：进程已经退出，但句柄还被 PowerShell 攥着 -> 不许挡路（v1.9.9 的永久误判，本轮判红主力）
$scenarioB2 = {
    param($dir)
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $proc = Start-PersistentProcess -Destination (Join-Path $WorkRoot "ghost\GhostApp.exe")
    $held = $proc.Handle          # 摸一次 .Handle 才会真的开句柄；对象留在脚本级，句柄不随作用域释放
    $script:heldProc = $proc
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    $proc.WaitForExit()
    Start-Sleep -Milliseconds 500
    if (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue) {
        throw "自证失败：PID $($proc.Id) 还在，场景 B2 测不到「已退出但句柄被引用」"
    }
    return [string]$proc.Id
}

# C：没有 /PID（人工双击安装），目标空闲 -> 直接装
$scenarioC = {
    param($dir)
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    return ""
}

# 让位成功的三条硬断言：遗留文件在、还被锁着、发起它的进程还活着，而正位上是新文件。
$checkA = {
    param($Dir, $ProcId)
    $problems = @()
    $exe = Join-Path $Dir "ConfScope.exe"
    $parked = @(Get-ChildItem -LiteralPath $Dir -Filter "ConfScope.exe.pending-*" -File)
    if ($parked.Count -eq 0) {
        $problems += "没让位：程序目录里没有 ConfScope.exe.pending-* 遗留副本（新文件是怎么挤掉正在运行的镜像的？）"
    }
    else {
        $parkedPath = $parked[0].FullName
        if (-not (Test-FileLocked -Path $parkedPath)) {
            $problems += "遗留副本 $parkedPath 已经不占用了：旧进程可能已经退出，A 就没测到「占用中让位」"
        }
        if ((Get-Item -LiteralPath $exe).Length -eq $parked[0].Length) {
            $problems += "$exe 与遗留副本同尺寸：正位上不像装了新文件"
        }
    }
    if (-not (Get-Process -Id ([int]$ProcId) -ErrorAction SilentlyContinue)) {
        $problems += "旧进程 $ProcId 不在了：本轮红线是零终止，安装程序不许杀任何进程"
    }
    return $problems
}

Invoke-Scenario -Name "A-占用必须让位覆盖" -Prepare $scenarioA -Expect 0 -PostCheck $checkA
Invoke-Scenario -Name "B1-无关进程不该挡路" -Prepare $scenarioB1 -Expect 0
Invoke-Scenario -Name "B2-句柄残留不该挡路" -Prepare $scenarioB2 -Expect 0
Invoke-Scenario -Name "C-无PID空闲目录" -Prepare $scenarioC -Expect 0

# 静默收尾把应用拉起来了：改的是它所属场景那一行，不新增行 —— CI 钉的是 scenarios=4，
# 多一行就多一个假失败（轮100 已经为这件事写过注释）。
foreach ($fault in @($script:launchFaults)) {
    if ($fault -notmatch "^SCENARIO=(\S+) ") { continue }
    $who = $Matches[1]
    for ($i = 0; $i -lt $script:results.Count; $i++) {
        if ($script:results[$i] -like "ok   $who *") {
            $script:results[$i] = "FAIL $who : 退出码与落盘都对，但 /S 静默收尾把应用拉起来了 —— $($fault.Substring(10 + $who.Length))"
        }
    }
    Write-Output "LAUNCH-AUDIT $fault"
}

$script:results | ForEach-Object { Write-Output $_ }
$failed = @($script:results | Where-Object { $_ -like "FAIL*" })
if ($failed.Count -gt 0) {
    Write-Output "HANDOFF-CI failed scenarios=$($script:results.Count) bad=$($failed.Count)"
    exit 1
}
Write-Output "HANDOFF-CI ok scenarios=$($script:results.Count)"
exit 0
