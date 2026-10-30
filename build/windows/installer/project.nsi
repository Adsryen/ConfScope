Unicode true

; 首三字节必须是 UTF-8 BOM（EF BB BF），编辑器/脚本别把它抹掉：Windows 上的 makensis 对
; 没有 BOM 的脚本按宿主 ANSI 码页解释源码（en-US 机器 = CP1252），下面这些中文 LangString
; 会被编成乱码，用户在安装进度页看到的就是「ConfScope å·²é€€å‡º」这种形态（v1.9.9 线上事故）。
; `Unicode true` 只保证运行时用 UTF-16，救不了源码阶段的解码；而 POSIX 侧的 makensis 恒按
; UTF-8 读源码（C.UTF-8 / C / ISO-8859-1 四种 locale 下产物 sha256 全等），所以 Linux 那道
; 语法闸门原理上抓不到它——验收靠 scripts/check-installer-strings.mjs 直接解编译产物，
; 判据钉在 tests/ux/windowsInstallerKeepsDataAndMatchesRuntimeLayout.test.ts 的 G 组。


####
## ConfScope Windows 安装包 —— 本文件是手写的，不是 wails 模板产物。
##
## 为什么能这么干：`wails build -nsis` 每次只重写 wails_tools.nsh（它头部写着
## DO NOT EDIT），project.nsi 存在就不动。所以凡与 wails 默认行为冲突的地方，
## 一律在本文件里用 !define 覆盖，或者干脆不调用那个宏、自己实现一份：
##   - REQUEST_EXECUTION_LEVEL：默认 admin（每机 Program Files，每次升级弹 UAC）→ 改 user
##   - PRODUCT_EXECUTABLE：默认 ${INFO_PROJECTNAME}.exe = confscope.exe，与
##     wails.json outputfilename 分叉 → 显式统一成 ConfScope.exe。注意这只管
##     「装进程序目录的可执行文件名」；发布资产名是另一件事（轮70 起统一为
##     confscope-windows-amd64-portable.exe / -installer.exe，由 CI 在上传前改名），
##     两者不同源也不冲突。
##   - wails.writeUninstaller / wails.deleteUninstaller：硬编码 HKLM，user 级写入
##     静默失败（控制面板根本没有卸载入口）→ 不调用，自建 HKCU 版本
##
## 定调（2026-10-22，两条任务线联合验收，勿再翻）：
##   1. 每用户安装：$LOCALAPPDATA\Programs\ConfScope，免 UAC，无管理员权限也能装能升；
##      数据与凭据本来就是每用户（WinCred 按用户隔离），程序目录跟着每用户走才自洽。
##   2. 程序永不替换自己的二进制。覆盖二进制是安装程序的责任，不是 ConfScope 进程的责任，
##      所以「等旧进程退出」这段逻辑收在这里（见 ensureSlotFree），不存在隐形 helper 脚本。
##   3. 卸载只删程序目录，绝不碰数据（$AppData 与 $INSTDIR\ConfScopeData 都保留）。
##
## 本地语法校验（Linux/WSL 即可，不必有 Windows；CI 的 preflight 作业也跑这个）：
##   mkdir -p build/windows/installer/tmp
##   printf PLACEHOLDER > build/windows/installer/tmp/MicrosoftEdgeWebview2Setup.exe
##   cd build/windows/installer
##   makensis -DARG_WAILS_AMD64_BINARY="$PWD/../../bin/ConfScope.exe" project.nsi
##   # File 的源路径相对 makensis 的 CWD（不是 .nsi 所在目录），所以必须传绝对路径。
##
## 下面这些信息取自 wails.json 的 info 段（CI 在构建前把 info.productVersion 写成真实版本号）：
##   INFO_PROJECTNAME / INFO_COMPANYNAME / INFO_PRODUCTNAME / INFO_PRODUCTVERSION / INFO_COPYRIGHT
####

; ---- 必须在 !include "wails_tools.nsh" 之前定下的三条 ----
!define REQUEST_EXECUTION_LEVEL "user"
!define PRODUCT_EXECUTABLE "ConfScope.exe"
!define UNINST_KEY_NAME "ConfScope"

!include "wails_tools.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

; ---- 与 Go 侧的唯一契约：internal/portabledata/runtime_layout.go ----
; 这两个字符串改了必须同时改 Go 侧常量，守卫
; tests/ux/windowsInstallerKeepsDataAndMatchesRuntimeLayout.test.ts 会同时扫两边。
!define APP_DATA_DIR_NAME "ConfScopeData"
!define INSTALL_MARKER_NAME "install.json"

!define DEFAULT_INSTALL_DIR "$LOCALAPPDATA\Programs\ConfScope"
; 装完把程序打开之后的确认探针：新镜像重新被锁住 = 新实例真的在跑。
; 最多 ${LAUNCH_PROBE_ROUNDS} × ${LAUNCH_PROBE_INTERVAL}ms，问不到也只是一句提示，不改任何判据。
!define LAUNCH_PROBE_ROUNDS 8
!define LAUNCH_PROBE_INTERVAL 250
!define WAIT_TICKS 30
!define WAIT_INTERVAL 500
; 一轮 ≈ ${WAIT_TICKS} × ${WAIT_INTERVAL}ms = 15s。用户点「重试」最多再来 ${WAIT_ROUNDS} 轮，
; 到点必须给个明确的停止说法，不能让人对着无限转圈的「等待」自己猜。
!define WAIT_ROUNDS 3
; 每 ${WAIT_PROGRESS_TICKS} 次探测（≈5s）在进度页打一行「已经等了多久」，
; 让「还在动」和「卡住了」在界面上看得出区别。
!define WAIT_PROGRESS_TICKS 10
; Windows 的 STILL_ACTIVE：GetExitCodeProcess 还返回它才说明进程真的活着。
!define STILL_ACTIVE 259

; 让位覆盖（轮100）：等满一轮还是占用时，把旧镜像改名让开正位，新文件写在正位。
; 能做到这件事的 Windows 语义：loader 打开 image section 时带 FILE_SHARE_READ | FILE_SHARE_DELETE，
; 所以**改名可以、删除不行**（VS Code 的 Code.exe.old、Inno Setup 的 RestartReplace 同一族做法）。
; 这条出路把「不强杀」从「只能等」变成「等不到就让位」：零终止、零跨语言授权契约。
!define PARKED_SUFFIX ".pending-"
; 让位目标名重名时往后加计数（同版本号重复升级、或上一份遗留还被旧进程攥着）。改名本身失败
; 不是名字冲突，加计数也不会成，超过这个上限就如实失败并继续走等待/放弃那几条出口。
!define PARK_MAX_ATTEMPTS 5

# 这两行必须是四段式版本号
VIProductVersion "${INFO_PRODUCTVERSION}.0"
VIFileVersion    "${INFO_PRODUCTVERSION}.0"

VIAddVersionKey "CompanyName"     "${INFO_COMPANYNAME}"
VIAddVersionKey "FileDescription" "${INFO_PRODUCTNAME} Installer"
VIAddVersionKey "ProductVersion"  "${INFO_PRODUCTVERSION}"
VIAddVersionKey "FileVersion"     "${INFO_PRODUCTVERSION}"
VIAddVersionKey "LegalCopyright"  "${INFO_COPYRIGHT}"
VIAddVersionKey "ProductName"     "${INFO_PRODUCTNAME}"

# Enable HiDPI support. https://nsis.sourceforge.io/Reference/ManifestDPIAware
ManifestDPIAware true

!include "MUI2.nsh"

!define MUI_ICON "..\icon.ico"
!define MUI_UNICON "..\icon.ico"
# !define MUI_WELCOMEFINISHPAGE_BITMAP "resources\leftimage.bmp" # 164x314
!define MUI_FINISHPAGE_NOAUTOCLOSE # 停在 INSTFILES 页让用户看得见明细
!define MUI_ABORTWARNING           # 中途退出要警告
; 收尾给一个「运行 ConfScope」勾选框。MUI2 在没有定义 MUI_FINISHPAGE_RUN_NOTCHECKED 时
; 把复选框置为**默认勾上**（Contrib/Modern UI 2/Pages/Finish.nsh 里 !ifndef ...NOTCHECKED →
; BM_SETCHECK BST_CHECKED），文案走 MUI2 内置的 MUI_TEXT_FINISH_RUN，跟着界面语言自动中/英，
; 所以这里不再自定义 RUN_TEXT —— 少一处要防码页乱码的中文字符串。
; 勾选框的动作接到 csRelaunchApp（不是 MUI2 默认的 Exec）：让位覆盖之后旧窗口还在跑老版本，
; 那时候必须拦下来，不然两个实例共用同一份本地数据。
!define MUI_FINISHPAGE_RUN "$INSTDIR\${PRODUCT_EXECUTABLE}"
!define MUI_FINISHPAGE_RUN_FUNCTION csRelaunchApp

Var UpdateMode   ; "1" = ConfScope 自动发起（命令行带 /UPDATE），向导只留进度页
Var AppPid       ; /PID= 传进来的旧进程 PID；空串 = 人工双击，只能靠文件占用探测
Var SlotBusy     ; slotBusy 的出参（NSIS 函数没有返回值）
Var KeepData     ; 卸载时是否在程序目录里检测到数据目录
Var AppPidAlive  ; appPidAlive 的出参：1 = /PID 那个进程还在跑（只用于解释「在等谁」）
Var WaitRound    ; 当前是第几轮等待（超时后用户点重试才 +1）
Var ParkOk       ; parkLockedSlot 的出参："1" = 旧镜像已让位，正位可以覆盖
Var ParkErr      ; parkLockedSlot 的出参：让位失败的原因（只给进度页看，不参与判据）
Var ParkAttempt  ; 让位目标名重名时的计数
Var ParkTarget   ; 本次尝试的让位目标全路径（成功后打印出来，便于人工找回旧文件）
Var RelaunchSafe ; canRelaunch 的出参："1" = 此刻拉起只会有一个实例（不会与旧窗口抢同一份本地数据）

; ---------------------------------------------------------------------------
; 运行形态标记：install.json 写在 exe 同级，声明「这一份是安装态」。
; internal/portabledata/runtime_layout.go 靠它把数据根定到 OS 用户数据目录，
; 本程序自己永不写这个文件（只有安装程序写）。
; ${GetTime} 的 "LS" = GetSystemTime（UTC），返回顺序是 日 月 年 星期 时 分 秒。
; ---------------------------------------------------------------------------
Function writeInstallMarker
    ${GetTime} "" "LS" $R0 $R1 $R2 $R3 $R4 $R5 $R6
    ClearErrors
    FileOpen $9 "$INSTDIR\${INSTALL_MARKER_NAME}" w
    ${If} ${Errors}
        DetailPrint "$(CS_MARKER_FAIL)"
        Return
    ${EndIf}
    FileWrite $9 '{"mode":"installed","version":"${INFO_PRODUCTVERSION}","installedAt":"$R2-$R1-$R0T$R4:$R5:$R6Z"}'
    FileWrite $9 '$\r$\n'
    FileClose $9
    DetailPrint "$(CS_MARKER_OK)"
FunctionEnd

; ---------------------------------------------------------------------------
; 现在能不能覆盖程序文件？唯一判据：目标 exe 能不能以追加方式打开。
; 打不开 = 还被某个进程当镜像加载着 = 不能覆盖。Windows 上只要进程在跑，它的 exe
; 必然被锁，所以这条探针把「占用」这件事一次说尽，不需要再按进程名/进程号猜。
;
; v1.9.9 线上事故：这里先看 /PID 的 OpenProcess 是否成功，成功就当「进程还活着」，
; 并且**跳过**文件探针。进程已退出但句柄仍被别处引用、或 PID 被复用时，判据永远为真，
; 用户看到的就是「等待 ConfScope 退出」反复打转、永不停歇。进程号从此只做诊断。
; 探测方式仍然只是打开再关闭：不截断、不删、不改，绝不硬抢运行中的 exe。
; ---------------------------------------------------------------------------
Function slotBusy
    StrCpy $SlotBusy 0
    ${If} ${FileExists} "$INSTDIR\${PRODUCT_EXECUTABLE}"
        ClearErrors
        FileOpen $2 "$INSTDIR\${PRODUCT_EXECUTABLE}" a
        ${IfNot} ${Errors}
            FileClose $2
        ${Else}
            StrCpy $SlotBusy 1
        ${EndIf}
    ${EndIf}
FunctionEnd

; ---------------------------------------------------------------------------
; /PID 那个进程到底还活着吗？只用来决定「等待」那几行该对用户说什么，
; 不参与能不能覆盖的判断（判据在 slotBusy，唯一一条）。
; OpenProcess 拿不到句柄 = 进程早没了；拿到了还要问 GetExitCodeProcess，
; 只有 STILL_ACTIVE 才算活着 —— 单看句柄非空会把「已退出但句柄被引用」误判成活。
; 三条 API 成对使用，拿到句柄必须 CloseHandle，否则装完留下句柄泄漏。
; ---------------------------------------------------------------------------
Function appPidAlive
    StrCpy $AppPidAlive 0
    ${If} $AppPid == ""
        Return
    ${EndIf}
    System::Call 'kernel32::OpenProcess(i 0x1000, i 0, i $AppPid) i.r1'
    ${If} $1 = 0
        Return
    ${EndIf}
    System::Call 'kernel32::GetExitCodeProcess(p $1, *i.r2)'
    System::Call 'kernel32::CloseHandle(p $1)'
    ${If} $2 = ${STILL_ACTIVE}
        StrCpy $AppPidAlive 1
    ${EndIf}
FunctionEnd

; ---------------------------------------------------------------------------
; 让位：把正位那个还被锁着的 exe 改名挪开，正位空出来给新文件（轮100）。
; 出参 $ParkOk（"1" = 成功）与 $ParkErr（失败原因，只给进度页看，不参与判据）。
;
; 为什么改名能成而删除不能：Windows 的 image section 以 FILE_SHARE_DELETE 打开 exe，
; 改名只要目标名可用；删除会被 loader 的句柄扣住。旧进程拿着已经改名的那份镜像继续跑，
; 不受任何打扰 —— 这正是「零终止」能成立的地方。
; 遗留文件由应用下次启动时 best-effort 清掉（Go 侧 portabledata.CleanParkedExecutables，
; 名字前缀与本文件的 ${PARKED_SUFFIX} 同源），卸载逐条遍历 $INSTDIR\* 时也会连带删掉它。
;
; 寄存器纪律：ensureSlotFree 用 $R7/$R8/$R9 数等待轮次，本函数一律不碰。
; ---------------------------------------------------------------------------
Function parkLockedSlot
    StrCpy $ParkOk "0"
    StrCpy $ParkErr ""
    StrCpy $ParkAttempt 0
    cs_park_try:
    ${If} $ParkAttempt = 0
        StrCpy $ParkTarget "$INSTDIR\${PRODUCT_EXECUTABLE}${PARKED_SUFFIX}${INFO_PRODUCTVERSION}"
    ${Else}
        StrCpy $ParkTarget "$INSTDIR\${PRODUCT_EXECUTABLE}${PARKED_SUFFIX}${INFO_PRODUCTVERSION}.$ParkAttempt"
    ${EndIf}
    ${If} ${FileExists} "$ParkTarget"
        ; 目标名被占（上一轮让位留下的旧镜像还被它的进程攥着）→ 换下一个计数名。
        ; 不去覆盖别人的镜像：那份文件可能正是用户回退时要找的东西。
        IntOp $ParkAttempt $ParkAttempt + 1
        ${If} $ParkAttempt <= ${PARK_MAX_ATTEMPTS}
            Goto cs_park_try
        ${EndIf}
        StrCpy $ParkErr "$(CS_PARK_NAME_BUSY)"
        Return
    ${EndIf}
    ClearErrors
    Rename "$INSTDIR\${PRODUCT_EXECUTABLE}" "$ParkTarget"
    ${IfNot} ${Errors}
        StrCpy $ParkOk "1"
        Return
    ${EndIf}
    ; 改名都被扣住 = 不是「正在运行的镜像」这一类占用（杀软、网络盘、非 share-delete 句柄），
    ; 再换名字也不会成。把原因如实写出来，退回有界等待：到点放弃覆盖，已装版本不受损。
    ; GetLastError 只是给用户一个可搜索的线索，可能因为 NSIS 自己的后续调用而偏一点；
    ; 它不参与任何判据（能不能覆盖的判据永远只有 slotBusy 那一条）。
    System::Call 'kernel32::GetLastError() i.r1'
    StrCpy $ParkErr "GetLastError=$1"
    Return
FunctionEnd

; ---------------------------------------------------------------------------
; 有界等待，单点闸门：整个脚本只有这里检查旧进程，Section 里不得再出现第二份。
; 放在 Section 开头而不是 .onInit —— .onInit 阶段 InstFiles 页还没建好，
; DetailPrint 用户根本看不见，「等待」就变成了界面无响应。
;
; 本轮把「等待」做成看得见的东西：
;   · 一撞上占用就打印在等谁（文件路径 + 进程号线索），不再是同一句话刷屏；
;   · 每 ${WAIT_PROGRESS_TICKS} 次探测报一次「已等 N 秒」，界面看得出还在数；
;   · 一轮 ${WAIT_TICKS} × ${WAIT_INTERVAL}ms ≈ 15s，等满还没退就让位（把旧镜像改名挪开，
;     见 parkLockedSlot）；让位也失败才按轮重试，最多 ${WAIT_ROUNDS} 轮，
;     用完就明确停手并说明已装版本未受损 —— 绝不无限转圈，也绝不终止任何进程
;     （主数据是 debounce 落盘的，强杀会吃掉最后一次写入；让位这条路连终止都不需要）。
; 静默（/S，留给脚本与 CI）让位也失败时直接非 0 退出并放弃覆盖。
; ---------------------------------------------------------------------------
Function ensureSlotFree
    StrCpy $R9 0
    ${Do}
        Call slotBusy
        ${If} $SlotBusy = 0
            ${If} $R9 > 0
                DetailPrint "$(CS_WAIT_DONE)"
            ${EndIf}
            Return
        ${EndIf}
        ${If} $R9 = 0
            DetailPrint "$(CS_WAITING)"
            DetailPrint "$(CS_WAIT_FILE)"
            DetailPrint "    $INSTDIR\${PRODUCT_EXECUTABLE}"
            Call appPidAlive
            ${If} $AppPid == ""
                DetailPrint "$(CS_WAIT_NOPID)"
            ${ElseIf} $AppPidAlive = 1
                DetailPrint "$(CS_WAIT_PID_ALIVE)"
                DetailPrint "    PID $AppPid"
            ${Else}
                DetailPrint "$(CS_WAIT_PID_GONE)"
                DetailPrint "    PID $AppPid"
            ${EndIf}
        ${EndIf}
        IntOp $R9 $R9 + 1
        IntOp $R8 $R9 % ${WAIT_PROGRESS_TICKS}
        ${If} $R8 = 0
            IntOp $R7 $R9 * ${WAIT_INTERVAL}
            IntOp $R7 $R7 / 1000
            DetailPrint "$(CS_WAIT_PROGRESS)$R7$(CS_WAIT_SECONDS)"
        ${EndIf}
        ${If} $R9 >= ${WAIT_TICKS}
            ; 等满一轮还是占用 → 先让位（轮100），不等用户对着「等待退出」自己猜。
            ; 静默与人工两条路都试这一脚。正常「退出并安装」的实例在 15 秒内早退了，
            ; 走不到这里，所以不会平白留下遗留文件。让位成功就直接覆盖正位并返回，
            ; 失败才落到下面今天的三条出口（静默放弃 / 重试 / 到点停手），一条都没减。
            DetailPrint "$(CS_PARK_TRY)"
            Call parkLockedSlot
            ${If} $ParkOk == "1"
                DetailPrint "$(CS_PARK_DONE)"
                DetailPrint "    $ParkTarget"
                DetailPrint "$(CS_PARK_RESTART)"
                Return
            ${EndIf}
            DetailPrint "$(CS_PARK_FAIL)$ParkErr"
            ${If} ${Silent}
                DetailPrint "$(CS_WAIT_GIVEUP)"
                SetErrorLevel 75
                Abort
            ${EndIf}
            ${If} $WaitRound >= ${WAIT_ROUNDS}
                MessageBox MB_OK|MB_ICONSTOP "$(CS_WAIT_GIVEUP_LONG)" /SD IDOK
                SetErrorLevel 75
                Abort
            ${EndIf}
            MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(CS_WAIT_RETRY)" /SD IDCANCEL IDRETRY cs_wait_reset
            SetErrorLevel 75
            Abort
            cs_wait_reset:
            IntOp $WaitRound $WaitRound + 1
            StrCpy $R9 0
        ${EndIf}
        Sleep ${WAIT_INTERVAL}
    ${Loop}
FunctionEnd

; ---------------------------------------------------------------------------
; 装完到底能不能把程序打开？只回答一个问题：现在拉起会不会多出第二个实例。
;
; 与 slotBusy 的分工，别读串了：slotBusy 回答「能不能覆盖二进制」，那条判据全脚本只有一份；
; 这里回答的是另一件事 —— 旧实例还在不在。
;   · 没让位过：覆盖得以发生就说明那一刻正位是空的，旧镜像没人攥着 ⇒ 旧实例已经退了；
;   · 让位过：旧镜像被改名搬走，正位空不空说明不了任何事，只能问 /PID 那个进程退了没有；
;     人工双击不带 /PID，问不到就当它还活着 —— 宁可让用户自己去点图标，也不能开出两个实例
;     共用同一份本地数据（程序没有单实例锁，主数据又是 debounce 落盘，后写会盖掉先写）。
; ---------------------------------------------------------------------------
Function canRelaunch
    StrCpy $RelaunchSafe "1"
    ${If} $ParkOk != "1"
        Return
    ${EndIf}
    StrCpy $RelaunchSafe "0"
    ${If} $AppPid == ""
        DetailPrint "$(CS_LAUNCH_BLOCKED)"
        Return
    ${EndIf}
    Call appPidAlive
    ${If} $AppPidAlive = 0
        StrCpy $RelaunchSafe "1"
    ${Else}
        DetailPrint "$(CS_LAUNCH_BLOCKED)"
    ${EndIf}
FunctionEnd

; ---------------------------------------------------------------------------
; 唯一的「打开程序」出口：人工收尾的勾选框与 /UPDATE 收尾的弹窗都只能经这里出去
; （判据写两份必然漂，所以 MUI_FINISHPAGE_RUN_FUNCTION 也指向它）。
;
; 为什么是 ExecShell 而不是 Exec：B 组把裸 Exec 全文件判红（历史形态 = 安装程序里偷偷起
; 看不见的 helper），而 $LOCALAPPDATA 完全可能带空格，ExecShell 把路径整个交给 ShellExecute，
; 不经过命令行解析。拉起前那行 DetailPrint 留着：进度页至少看得见「说了要启动」。
; 静默（/S，CI 与脚本）永不拉起 GUI —— 收尾弹窗的 /SD 默认按钮已经是「否」，这里再兜一道。
; ---------------------------------------------------------------------------
Function csRelaunchApp
    ${If} ${Silent}
        DetailPrint "$(CS_LAUNCH_SILENT)"
        Return
    ${EndIf}
    Call canRelaunch
    ${If} $RelaunchSafe != "1"
        ; 用户是明确勾了「运行 ConfScope」才走到这里的，拦下来必须说清为什么，不许静默什么都不做。
        MessageBox MB_OK|MB_ICONINFORMATION "$(CS_LAUNCH_BLOCKED_MSG)" /SD IDOK
        Return
    ${EndIf}
    DetailPrint "$(CS_LAUNCH_OK)"
    ExecShell "open" "$INSTDIR\${PRODUCT_EXECUTABLE}"
    Call confirmLaunched
FunctionEnd

; ---------------------------------------------------------------------------
; 「说了要启动」之后，得能看出它到底起来没有。ExecShell 在各版本 NSIS 里都不给可靠的错误位，
; 所以这里不问它，只问一件看得见的事：正位那份新镜像有没有重新被进程锁住。
;   · 锁住 = 新实例在跑（CreateProcess 返回时镜像必然已经映射，所以正常第一次就中）；
;   · 问满 ${LAUNCH_PROBE_ROUNDS} × ${LAUNCH_PROBE_INTERVAL}ms 还是空的 = 大概率没起来
;     （也可能只是这台机器此刻慢得离谱），如实告诉用户去哪儿自己打开，
;     别让人对着毫无反应的桌面猜「我是不是已经装坏了」。
; 这里复用了 slotBusy 这只探针，但问的不是「能不能覆盖」——那条判据仍然只在 ensureSlotFree 里出现一次。
; 计数器用 $R5：$R7/$R8/$R9 是 ensureSlotFree 数等待轮次的，本函数不碰。
; ---------------------------------------------------------------------------
Function confirmLaunched
    StrCpy $R5 0
    cs_launch_probe:
    Call slotBusy
    ${If} $SlotBusy = 1
        DetailPrint "$(CS_LAUNCH_CONFIRMED)"
        Return
    ${EndIf}
    IntOp $R5 $R5 + 1
    ${If} $R5 >= ${LAUNCH_PROBE_ROUNDS}
        DetailPrint "$(CS_LAUNCH_UNCONFIRMED)"
        MessageBox MB_OK|MB_ICONINFORMATION "$(CS_LAUNCH_UNCONFIRMED)" /SD IDOK
        Return
    ${EndIf}
    Sleep ${LAUNCH_PROBE_INTERVAL}
    Goto cs_launch_probe
FunctionEnd

; ---------------------------------------------------------------------------
; 安装位置回读：绝不能因为 /UPDATE 跳过了目录页，就把用户当初选过的路径重置成默认值。
; 自己读 HKCU 而不是用 InstallDirRegKey —— 卸载项是用 SetRegView 64 写的，
; InstallDirRegKey 在 .onInit 时跑在默认(32 位)视图上，读写视图不一致就等于读不到。
; ---------------------------------------------------------------------------
Function resolveInstallDir
    SetRegView 64
    ReadRegStr $R0 HKCU "${UNINST_KEY}" "InstallLocation"
    SetRegView 32
    ${If} $R0 != ""
        ${If} ${FileExists} "$R0\${PRODUCT_EXECUTABLE}"
            StrCpy $INSTDIR "$R0"
        ${EndIf}
    ${EndIf}
FunctionEnd

; /UPDATE 时跳过 Welcome / Directory / Finish，只留 InstFiles：
; 用户仍然看得见进度、仍然能取消，但不用在向导里点四遍。
; （MUI2 的 page 宏在展开末尾会 !undef 掉 MUI_PAGE_CUSTOMFUNCTION_PRE，所以每页各自 define 一次）
Function muiSkipWhenUpdating
    ${If} $UpdateMode == "1"
        Abort
    ${EndIf}
FunctionEnd

; ---------------------------------------------------------------------------
; HKCU 卸载项（替代 wails.writeUninstaller，后者硬编码 HKLM）
; InstallLocation 是上面 resolveInstallDir 的回读源，必须写。
; ---------------------------------------------------------------------------
Function writeUninstallEntry
    WriteUninstaller "$INSTDIR\uninstall.exe"

    SetRegView 64
    WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${INFO_COMPANYNAME}"
    WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${INFO_PRODUCTNAME}"
    WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${INFO_PRODUCTVERSION}"
    WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${PRODUCT_EXECUTABLE}"
    WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
    WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
    WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" "$\"$INSTDIR\uninstall.exe$\" /S"
    WriteRegStr HKCU "${UNINST_KEY}" "URLInfoAbout" "https://github.com/Adsryen/ConfScope"
    WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
    WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1

    ${GetSize} "$INSTDIR" "/S=0K" $R0 $R1 $R2
    IntFmt $R0 "0x%08X" $R0
    WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" "$R0"
    SetRegView 32
FunctionEnd

Name "${INFO_PRODUCTNAME}"
; 产物名不带版本号，与既有产物约定一致（linux 的 tar.gz/deb/rpm、darwin 的 dmg 都不带）：
; 版本由所在 Release 的 tag 与包内 install.json/注册表 DisplayVersion 承载。
; 把版本号写进文件名反而会让 dev 构建带着正式版本号骗人。
OutFile "..\..\bin\confscope-windows-${ARCH}-installer.exe"
InstallDir "${DEFAULT_INSTALL_DIR}"
ShowInstDetails show
ShowUninstDetails show

!define MUI_DIRECTORYPAGE_TEXT_TOP "$(CS_DIR_HINT)"

!define MUI_PAGE_CUSTOMFUNCTION_PRE muiSkipWhenUpdating
!insertmacro MUI_PAGE_WELCOME
!define MUI_PAGE_CUSTOMFUNCTION_PRE muiSkipWhenUpdating
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_PAGE_CUSTOMFUNCTION_PRE muiSkipWhenUpdating
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

; 自定义文案。必须排在 !insertmacro MUI_LANGUAGE 之后 —— LANG_SIMPCHINESE 这些
; 常量是 MUI_LANGUAGE 才定义出来的，写在前面会被当成非法语言 id（实测静默退化成 1033）。
LangString CS_DIR_HINT ${LANG_SIMPCHINESE} "默认装到当前用户的目录，不需要管理员权限；升级时覆盖同一位置即可。"
LangString CS_DIR_HINT ${LANG_ENGLISH} "Installed per user by default (no administrator rights). Updates overwrite the same folder."

LangString CS_WAITING ${LANG_SIMPCHINESE} "等待 ConfScope 退出（不强杀进程，避免丢掉正在写入的本地数据）..."
LangString CS_WAITING ${LANG_ENGLISH} "Waiting for ConfScope to exit (never force-killed, so pending local writes are not lost)..."

LangString CS_WAIT_DONE ${LANG_SIMPCHINESE} "ConfScope 已退出，继续覆盖安装"
LangString CS_WAIT_DONE ${LANG_ENGLISH} "ConfScope has exited, continuing"

LangString CS_WAIT_GIVEUP ${LANG_SIMPCHINESE} "ConfScope 仍在运行，静默安装放弃覆盖（未破坏已装版本）"
LangString CS_WAIT_GIVEUP ${LANG_ENGLISH} "ConfScope is still running; silent install gives up without touching the current version"

LangString CS_WAIT_FILE ${LANG_SIMPCHINESE} "被占用、暂时还不能覆盖的文件："
LangString CS_WAIT_FILE ${LANG_ENGLISH} "Program file in use, cannot be replaced yet:"

LangString CS_WAIT_NOPID ${LANG_SIMPCHINESE} "安装程序没有拿到应用进程号（人工双击安装的常见情形），只按上面的文件占用判断。"
LangString CS_WAIT_NOPID ${LANG_ENGLISH} "No app process id was passed in (typical for a manually started installer); only the file lock above is used."

LangString CS_WAIT_PID_ALIVE ${LANG_SIMPCHINESE} "应用进程仍在运行，等它自己退出（不会强杀）："
LangString CS_WAIT_PID_ALIVE ${LANG_ENGLISH} "The app is still running, waiting for it to exit on its own (never force-killed):"

LangString CS_WAIT_PID_GONE ${LANG_SIMPCHINESE} "应用进程已经退出，文件还没被系统释放，继续等："
LangString CS_WAIT_PID_GONE ${LANG_ENGLISH} "The app process already exited, its file is not released yet, still waiting:"

LangString CS_WAIT_PROGRESS ${LANG_SIMPCHINESE} "仍在等待，已等 "
LangString CS_WAIT_PROGRESS ${LANG_ENGLISH} "Still waiting, "

LangString CS_WAIT_SECONDS ${LANG_SIMPCHINESE} " 秒"
LangString CS_WAIT_SECONDS ${LANG_ENGLISH} " seconds so far"

LangString CS_WAIT_GIVEUP_LONG ${LANG_SIMPCHINESE} "ConfScope 的程序文件一直被占用，安装到此停止。$\r$\n$\r$\n已经装好的版本没有被破坏，直接重新打开 ConfScope 就能继续用。$\r$\n如果确认已经没有窗口在运行，请在任务管理器里结束残留的 ConfScope 进程，或注销后重新运行本安装程序。"
LangString CS_WAIT_GIVEUP_LONG ${LANG_ENGLISH} "ConfScope's program file stayed locked, so this installation stopped here.$\r$\n$\r$\nYour installed version is intact - just start ConfScope again to keep using it.$\r$\nIf no window is running, end the leftover ConfScope process in Task Manager, or sign out and run this installer again."

LangString CS_WAIT_RETRY ${LANG_SIMPCHINESE} "ConfScope 还在运行，无法覆盖正在使用的程序文件。$\r$\n$\r$\n「重试」继续等待；「取消」退出安装程序 —— 已装的版本不会被破坏。"
LangString CS_WAIT_RETRY ${LANG_ENGLISH} "ConfScope is still running, so its program file cannot be replaced.$\r$\n$\r$\nRetry keeps waiting; Cancel leaves the installed version intact."

LangString CS_PARK_TRY ${LANG_SIMPCHINESE} "旧进程等满一轮仍未退出，改用「让位覆盖」：把正在运行的程序文件改名挪开，新文件写进正位（不强杀任何进程）..."
LangString CS_PARK_TRY ${LANG_ENGLISH} "The app did not exit within one round, switching to park-and-replace: renaming the running program file out of the way instead of installing over it (no process is ever terminated)..."

LangString CS_PARK_DONE ${LANG_SIMPCHINESE} "旧版本已让位，继续覆盖安装："
LangString CS_PARK_DONE ${LANG_ENGLISH} "The running copy was parked out of the way, continuing:"

LangString CS_PARK_RESTART ${LANG_SIMPCHINESE} "注意：还开着的窗口跑的仍是老版本，安装完成后请重新启动 ConfScope 才用得上新版本。"
LangString CS_PARK_RESTART ${LANG_ENGLISH} "Note: windows that are still open keep running the old version - restart ConfScope after this install to use the new one."

LangString CS_PARK_FAIL ${LANG_SIMPCHINESE} "连改名都被扣住，不是「正在运行的程序」这一类占用，放弃让位（已装版本未受损）。原因："
LangString CS_PARK_FAIL ${LANG_ENGLISH} "Even renaming was refused, so this is not a running-image lock; giving up without touching the installed version. Reason: "

LangString CS_PARK_NAME_BUSY ${LANG_SIMPCHINESE} "让位位置已被更早留下的旧版本占满（请启动一次 ConfScope，程序会自己清掉这些遗留文件）"
LangString CS_PARK_NAME_BUSY ${LANG_ENGLISH} "Every parked name is already taken by older leftovers (start ConfScope once - it cleans them up itself)"

LangString CS_MARKER_OK ${LANG_SIMPCHINESE} "已写入运行形态标记 install.json（安装态）"
LangString CS_MARKER_OK ${LANG_ENGLISH} "Wrote install.json runtime marker (installed mode)"

LangString CS_MARKER_FAIL ${LANG_SIMPCHINESE} "写入 install.json 失败，应用会按便携态解析数据根"
LangString CS_MARKER_FAIL ${LANG_ENGLISH} "Failed to write install.json; the app will resolve the data root as portable"

LangString CS_UPDATE_DONE ${LANG_SIMPCHINESE} "安装完成，请重新启动 ConfScope。$\r$\n配置与凭据数据不受影响。"
LangString CS_UPDATE_DONE ${LANG_ENGLISH} "Installation complete. Please start ConfScope again.$\r$\nYour configuration and credential data are untouched."

LangString CS_LAUNCH_ASK ${LANG_SIMPCHINESE} "安装完成，配置与凭据数据不受影响。$\r$\n$\r$\n是否现在启动 ConfScope？"
LangString CS_LAUNCH_ASK ${LANG_ENGLISH} "Installation complete - your configuration and credential data are untouched.$\r$\n$\r$\nStart ConfScope now?"

LangString CS_LAUNCH_OK ${LANG_SIMPCHINESE} "正在启动 ConfScope"
LangString CS_LAUNCH_OK ${LANG_ENGLISH} "Starting ConfScope"

LangString CS_LAUNCH_CONFIRMED ${LANG_SIMPCHINESE} "ConfScope 已经启动"
LangString CS_LAUNCH_CONFIRMED ${LANG_ENGLISH} "ConfScope is running"

LangString CS_LAUNCH_UNCONFIRMED ${LANG_SIMPCHINESE} "没能确认 ConfScope 已经启动。$\r$\n$\r$\n如果它没有打开，请从桌面或开始菜单的图标启动；安装本身已经完成，你的配置与凭据数据没有被动过。"
LangString CS_LAUNCH_UNCONFIRMED ${LANG_ENGLISH} "Could not confirm that ConfScope started.$\r$\n$\r$\nIf no window appeared, open it from the desktop or the Start menu - the install itself finished, and your configuration and credential data were untouched."

LangString CS_LAUNCH_SKIP ${LANG_SIMPCHINESE} "按你的选择没有启动，随时可以从桌面或开始菜单打开 ConfScope"
LangString CS_LAUNCH_SKIP ${LANG_ENGLISH} "Not started, as you chose - open ConfScope from the desktop or the Start menu whenever you like"

LangString CS_LAUNCH_SILENT ${LANG_SIMPCHINESE} "静默安装不自动启动应用"
LangString CS_LAUNCH_SILENT ${LANG_ENGLISH} "Silent install does not start the app"

LangString CS_LAUNCH_BLOCKED ${LANG_SIMPCHINESE} "仍有 ConfScope 窗口在运行，不自动启动新版本（两个实例会共用同一份本地数据）"
LangString CS_LAUNCH_BLOCKED ${LANG_ENGLISH} "A ConfScope window is still running, so the new version is not started on its own (two instances would share one copy of the local data)"

LangString CS_LAUNCH_BLOCKED_MSG ${LANG_SIMPCHINESE} "安装已经完成，但还有 ConfScope 窗口在运行。$\r$\n$\r$\n现在再开一个，两个实例会共用同一份本地数据，保存会互相覆盖。$\r$\n请先关闭还开着的窗口，再从桌面或开始菜单启动 ConfScope。"
LangString CS_LAUNCH_BLOCKED_MSG ${LANG_ENGLISH} "The install finished, but a ConfScope window is still running.$\r$\n$\r$\nStarting another one now would put two instances on the same local data, and their saves would overwrite each other.$\r$\nClose the running windows first, then start ConfScope from the desktop or the Start menu."

LangString CS_KEEP_DATA ${LANG_SIMPCHINESE} "保留数据目录 $INSTDIR\${APP_DATA_DIR_NAME}（卸载不删数据）"
LangString CS_KEEP_DATA ${LANG_ENGLISH} "Keeping $INSTDIR\${APP_DATA_DIR_NAME} (uninstall never deletes data)"

LangString CS_KEEP_DATA_MSG ${LANG_SIMPCHINESE} "已删除程序文件，但保留了目录里的配置数据：$\r$\n$INSTDIR\${APP_DATA_DIR_NAME}$\r$\n$\r$\n凭据与 %APPDATA% 下的数据同样没有被触碰。重装即可继续使用。"
LangString CS_KEEP_DATA_MSG ${LANG_ENGLISH} "Program files removed, but the configuration data next to them was kept:$\r$\n$INSTDIR\${APP_DATA_DIR_NAME}$\r$\n$\r$\nCredentials and data under %APPDATA% were not touched either."

Function .onInit
    !insertmacro wails.checkArchitecture

    StrCpy $UpdateMode "0"
    StrCpy $AppPid ""
    StrCpy $WaitRound 0
    StrCpy $ParkOk "0"

    ${GetOptions} "$CmdLine" "/UPDATE" $R0
    ${IfNot} ${Errors}
        StrCpy $UpdateMode "1"
    ${EndIf}

    ; 应用自动发起时带上 /PID=<旧进程 pid>。GetOptions 对 "/PID" 会把等号留在返回值里，
    ; 这里一并兼容 /PID=1234 与 /PID 1234 两种写法。
    ${GetOptions} "$CmdLine" "/PID" $R0
    ${IfNot} ${Errors}
        StrCpy $AppPid $R0
        StrCpy $R1 $AppPid 1
        ${If} $R1 == "="
            StrCpy $AppPid $AppPid "" 1
        ${EndIf}
    ${EndIf}

    ; 人工双击且没给 PID 时，$AppPid 为空串，ensureSlotFree 自动改用文件占用探测。
    Call resolveInstallDir
FunctionEnd

Section
    !insertmacro wails.setShellContext

    ; 覆盖二进制之前先确认正位可写：旧进程已退出，或已被改名让位（见函数注释：判据归属在安装程序）
    Call ensureSlotFree

    !insertmacro wails.webview2runtime

    SetOutPath $INSTDIR

    !insertmacro wails.files

    Call writeInstallMarker

    CreateShortcut "$SMPROGRAMS\${INFO_PRODUCTNAME}.lnk" "$INSTDIR\${PRODUCT_EXECUTABLE}"
    CreateShortCut "$DESKTOP\${INFO_PRODUCTNAME}.lnk" "$INSTDIR\${PRODUCT_EXECUTABLE}"

    !insertmacro wails.associateFiles
    !insertmacro wails.associateCustomProtocols

    Call writeUninstallEntry

    ${If} $UpdateMode == "1"
        ; /UPDATE 整页跳过了 Finish，人工路径那个勾选框根本不会出现，所以升级收尾要自己给出口。
        Call canRelaunch
        ${If} $RelaunchSafe == "1"
            ; 旧实例确实退了：一键打开，别让人去桌面找图标。
            ; /SD IDNO —— 静默（CI 与脚本）取默认按钮，永远进不到 launcher。
            MessageBox MB_YESNO|MB_ICONINFORMATION "$(CS_LAUNCH_ASK)" /SD IDNO IDYES cs_update_relaunch
            DetailPrint "$(CS_LAUNCH_SKIP)"
            Goto cs_update_end
            cs_update_relaunch:
            Call csRelaunchApp
            cs_update_end:
        ${Else}
            ; 让过位而旧窗口还活着：屏幕上跑的还是老版本，不重启用不上新版本；
            ; 这时候问「要不要现在启动」是给一个按判据不能按的按钮，所以只给信息。
            MessageBox MB_OK|MB_ICONINFORMATION "$(CS_UPDATE_DONE)$\r$\n$\r$\n$(CS_PARK_RESTART)" /SD IDOK
        ${EndIf}
    ${EndIf}
SectionEnd

Section "uninstall"
    !insertmacro wails.setShellContext

    ; 原模板这里有一行 RMDir /r "$AppData\${PRODUCT_EXECUTABLE}"（注释写的是"清理 WebView2 数据"）。
    ; PRODUCT_EXECUTABLE 统一成 ConfScope.exe 之后，那行删的就是 %APPDATA%\ConfScope.exe ——
    ; 正是数据根迁移认得的旧 webview 数据源目录之一（internal/portabledata/portable_data.go）。
    ; 卸载顺手删掉用户旧位置的缓存是不可解释的行为，删掉这一行。
    ;
    ; 程序目录逐条删除，唯一豁免 ${APP_DATA_DIR_NAME}：不整体 RMDir /r $INSTDIR，
    ; 免得有人把数据放在程序目录里时被连锅端。
    StrCpy $KeepData 0
    FindFirst $R0 $R1 "$INSTDIR\*"
    ${DoWhile} $R1 != ""
        ${If} $R1 != "."
        ${AndIf} $R1 != ".."
            ${If} ${FileExists} "$INSTDIR\$R1\*.*"
                ${If} $R1 == "${APP_DATA_DIR_NAME}"
                    StrCpy $KeepData 1
                    DetailPrint "$(CS_KEEP_DATA)"
                ${Else}
                    RMDir /r "$INSTDIR\$R1"
                ${EndIf}
            ${Else}
                Delete "$INSTDIR\$R1"
            ${EndIf}
        ${EndIf}
        FindNext $R0 $R1
    ${Loop}
    FindClose $R0

    ; 数据目录还在 → 目录非空 → 这一句失败是预期内的，程序目录连同数据留在原地
    RMDir "$INSTDIR"

    Delete "$SMPROGRAMS\${INFO_PRODUCTNAME}.lnk"
    Delete "$DESKTOP\${INFO_PRODUCTNAME}.lnk"

    !insertmacro wails.unassociateFiles
    !insertmacro wails.unassociateCustomProtocols

    SetRegView 64
    DeleteRegKey HKCU "${UNINST_KEY}"
    SetRegView 32

    ${If} $KeepData = 1
        MessageBox MB_OK|MB_ICONINFORMATION "$(CS_KEEP_DATA_MSG)" /SD IDOK
    ${EndIf}
SectionEnd
