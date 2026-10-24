Unicode true

; 首三字节必须是 UTF-8 BOM（EF BB BF），编辑器/脚本别把它抹掉：Windows 上的 makensis 对
; 没有 BOM 的脚本按宿主 ANSI 码页解释源码（en-US 机器 = CP1252），下面 9 组中文 LangString
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
!define WAIT_TICKS 30
!define WAIT_INTERVAL 500

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
; 首次安装收尾给一个「运行 ConfScope」勾选框（默认不勾）。
; 注意：/UPDATE 路径整页跳过，升级完成不会自动拉起应用 —— 避免和刚退出的旧实例抢数据根。
!define MUI_FINISHPAGE_RUN "$INSTDIR\${PRODUCT_EXECUTABLE}"

Var UpdateMode   ; "1" = ConfScope 自动发起（命令行带 /UPDATE），向导只留进度页
Var AppPid       ; /PID= 传进来的旧进程 PID；空串 = 人工双击，只能靠文件占用探测
Var SlotBusy     ; slotBusy 的出参（NSIS 函数没有返回值）
Var KeepData     ; 卸载时是否在程序目录里检测到数据目录

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
; 现在能不能覆盖程序文件？两条探针，任一命中即「还不能」：
;   ① 应用带了 /PID 来 → 只等那一个进程。别的实例（比如U盘里的便携版同名 exe）
;      不该挡住本机安装版升级，所以不能按进程名一刀切。
;   ② 目标 exe 仍被占用 → append 方式打开只是探测占用（不截断、不删、不改），
;      打不开就是还被加载着。人工双击安装包时没有 PID，只能靠这条。
; OpenProcess 用 PROCESS_QUERY_LIMITED_INFORMATION(0x1000)，查不到就当作已退出：
; 宁可少等一轮，也绝不 taskkill —— 主数据是 debounce 落盘的，强杀会吃掉最后一次写入。
; ---------------------------------------------------------------------------
Function slotBusy
    StrCpy $SlotBusy 0
    ${If} $AppPid != ""
        System::Call 'kernel32::OpenProcess(i 0x1000, i 0, i $AppPid) i.r1'
        ${If} $1 != 0
            System::Call 'kernel32::CloseHandle(p $1)'
            StrCpy $SlotBusy 1
        ${EndIf}
    ${EndIf}
    ${If} $SlotBusy = 0
        ${If} ${FileExists} "$INSTDIR\${PRODUCT_EXECUTABLE}"
            ClearErrors
            FileOpen $2 "$INSTDIR\${PRODUCT_EXECUTABLE}" a
            ${IfNot} ${Errors}
                FileClose $2
            ${Else}
                StrCpy $SlotBusy 1
            ${EndIf}
        ${EndIf}
    ${EndIf}
FunctionEnd

; ---------------------------------------------------------------------------
; 有界等待，单点闸门：整个脚本只有这里检查旧进程，Section 里不得再出现第二份。
; 放在 Section 开头而不是 .onInit —— .onInit 阶段 InstFiles 页还没建好，
; DetailPrint 用户根本看不见，「等待」就变成了界面无响应。
; 上限 ${WAIT_TICKS} × ${WAIT_INTERVAL}ms ≈ 15s；超时后有界面给「重试/取消」，
; 静默（/S，留给脚本与 CI）则直接非 0 退出并放弃覆盖，绝不硬抢运行中的 exe。
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
        ${EndIf}
        IntOp $R9 $R9 + 1
        ${If} $R9 >= ${WAIT_TICKS}
            ${If} ${Silent}
                DetailPrint "$(CS_WAIT_GIVEUP)"
                SetErrorLevel 75
                Abort
            ${EndIf}
            MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(CS_WAIT_RETRY)" /SD IDCANCEL IDRETRY cs_wait_reset
            SetErrorLevel 75
            Abort
            cs_wait_reset:
            StrCpy $R9 0
        ${EndIf}
        Sleep ${WAIT_INTERVAL}
    ${Loop}
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

LangString CS_WAIT_RETRY ${LANG_SIMPCHINESE} "ConfScope 还在运行，无法覆盖正在使用的程序文件。$\r$\n$\r$\n「重试」继续等待；「取消」退出安装程序 —— 已装的版本不会被破坏。"
LangString CS_WAIT_RETRY ${LANG_ENGLISH} "ConfScope is still running, so its program file cannot be replaced.$\r$\n$\r$\nRetry keeps waiting; Cancel leaves the installed version intact."

LangString CS_MARKER_OK ${LANG_SIMPCHINESE} "已写入运行形态标记 install.json（安装态）"
LangString CS_MARKER_OK ${LANG_ENGLISH} "Wrote install.json runtime marker (installed mode)"

LangString CS_MARKER_FAIL ${LANG_SIMPCHINESE} "写入 install.json 失败，应用会按便携态解析数据根"
LangString CS_MARKER_FAIL ${LANG_ENGLISH} "Failed to write install.json; the app will resolve the data root as portable"

LangString CS_UPDATE_DONE ${LANG_SIMPCHINESE} "安装完成，请重新启动 ConfScope。$\r$\n配置与凭据数据不受影响。"
LangString CS_UPDATE_DONE ${LANG_ENGLISH} "Installation complete. Please start ConfScope again.$\r$\nYour configuration and credential data are untouched."

LangString CS_KEEP_DATA ${LANG_SIMPCHINESE} "保留数据目录 $INSTDIR\${APP_DATA_DIR_NAME}（卸载不删数据）"
LangString CS_KEEP_DATA ${LANG_ENGLISH} "Keeping $INSTDIR\${APP_DATA_DIR_NAME} (uninstall never deletes data)"

LangString CS_KEEP_DATA_MSG ${LANG_SIMPCHINESE} "已删除程序文件，但保留了目录里的配置数据：$\r$\n$INSTDIR\${APP_DATA_DIR_NAME}$\r$\n$\r$\n凭据与 %APPDATA% 下的数据同样没有被触碰。重装即可继续使用。"
LangString CS_KEEP_DATA_MSG ${LANG_ENGLISH} "Program files removed, but the configuration data next to them was kept:$\r$\n$INSTDIR\${APP_DATA_DIR_NAME}$\r$\n$\r$\nCredentials and data under %APPDATA% were not touched either."

Function .onInit
    !insertmacro wails.checkArchitecture

    StrCpy $UpdateMode "0"
    StrCpy $AppPid ""

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

    ; 覆盖二进制之前先确认旧进程已经退出（见函数注释：判据归属在安装程序）
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
        MessageBox MB_OK|MB_ICONINFORMATION "$(CS_UPDATE_DONE)" /SD IDOK
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
