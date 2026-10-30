/**
 * Windows 安装包脚本（build/windows/installer/project.nsi）的 A–I 九组不变量，轮62 起钉在这里。
 *
 * 为什么要这么写：本机没有 Windows，wails build -nsis 出来的安装程序没法真跑；
 * CI 的 preflight 只能证明这脚本「编译得过」。而编译得过不等于行为对——下面每一条
 * 都是「漂了不会有人立刻发现」的形态：
 *
 *  A. 安装/卸载程序不能毁掉用户数据。wails 默认模板里那行 RMDir /r "$AppData\..."
 *     删的正是数据根迁移认得的旧 webview 数据源目录之一；整体 RMDir /r $INSTDIR 会把
 *     放在程序目录里的 ConfScopeData 连锅端。症状是用户丢数据，且要到下次升级才看得见。
 *  B. 安装程序必须「等」而不是「杀」，等不到就「让位」。主数据是 debounce 落盘的，强杀等于吃掉最后一次
 *     写入；轮100 起的出路是把还被锁着的旧 exe 改名挪开（零终止，正位让给新文件），遗留副本由应用下次
 *     启动时 best-effort 清掉。「装不上」从此不再依赖旧进程肯不肯退出。
 *  C. 两侧字面量必须同源：数据目录名、install.json 的文件名与字段、/UPDATE 与 /PID 开关，
 *     一半写在 .nsi、一半写在 Go。Go 读不到标记就按便携态解析数据根，用户看到的症状
 *     是「装了之后数据不见了」——2026-09-04 的事故形态。
 *  D. 程序自己永不写运行形态标记：写了就等于把便携副本伪装成安装态。
 *  E. 交接出路的绑定面（wailsjs 两段 + 前端 API + 两套测试桥 + Go 方法）不能缺角。
 *  F. CI 不能静默不出安装包：wails v2.13 找不到 makensis 时只打一行 Warning 就 return nil。
 *  G. 安装包里的中文必须是真中文：project.nsi 缺 UTF-8 BOM 时，Windows 的 makensis 按宿主
 *     ANSI 码页（en-US = CP1252）解释源码，9 组中文 LangString 全被编成乱码，用户在安装进度
 *     页看到的是「ConfScope å·²é€€å‡ºï¼Œç»§ç»­è¦†ç›–å®‰è£…」（v1.9.9 线上事故）。这道缺陷在
 *     Linux 侧原理上不可见——POSIX 的 makensis 恒按 UTF-8 读脚本，四种 locale 下产物 sha256
 *     全等，所以 F 组那道语法闸门全绿也拦不住它，只能验编译产物本身（G 组）。
 *  H. 窗口关了进程必须真的退出去：进度页的「等待」只看正位镜像占不占用，而占不占用取决于应用
 *     能不能自己退出。SSH 隧道拨号持锁会把退出拖死 = 用户看到的「一直退不出去」。
 *  I. 装完能把程序打开，但不许开出第二个实例：程序没有单实例锁，主数据又是 debounce 落盘，
 *     两个实例共用同一份数据根时后写盖掉先写。所以这条出口只许一个、静默永不拉起、
 *     让过位之后必须先确认旧实例真的退了。
 *
 * NSIS 的注释有整行 #、整行 ; 和行尾 # 三种，解释历史的注释不算行为（project.nsi 头部
 * 就写着「默认 admin」），所以先剥注释再抽判据，否则守卫会在自己解释自己的注释上自红。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT, stripComments } from "./scanUtils";

const NSI = "build/windows/installer/project.nsi";
const TOOLS = "build/windows/installer/wails_tools.nsh";
const PARKED_GO = "internal/portabledata/parked_executable.go";
const MAIN_GO = "main.go";
const HANDOFF_GO = "internal/updatecheck/handoff.go";
const ARTIFACT_GO = "internal/updatecheck/artifact.go";
const APP_GO = "internal/app/app.go";
const TUNNEL_GO = "internal/ssh/tunnel.go";
const MANAGER_GO = "internal/ssh/manager.go";
const HANDOFF_PS1 = "scripts/check-windows-installer-handoff.ps1";
const WORKFLOW = ".github/workflows/release.yml";
const STRINGS_SCRIPT = "scripts/check-installer-strings.mjs";
const WAILS_TS = "wailsjs/go/app/App.ts";
const MARKER_CONSUMER_DIRS = ["internal/portabledata", "internal/app", "internal/updatecheck"];

const HANDOFF_BINDINGS = [
  "LaunchUpdateInstaller",
  "RevealDownloadedArtifact",
  "AttachUpdateImage",
  "UpdateInstallCommand",
  "ListActiveSSHTunnels",
  "QuitApplication",
];
const BRIDGE_FILES = [
  "src/api/app.ts",
  "tests/retest/bridge/retestBinding.ts",
  "tests/retest/bridge/installRetestBridge.ts",
  "tests/smoke/bridge/appBinding.ts",
  "tests/smoke/bridge/installWailsBridge.ts",
];

/**
 * 判据文本一律先统一换行符再比对。
 *
 * 教训（v1.11.1 出包断在这里）：`.gitattributes` 给 `*.ps1` 定了 `eol=crlf`（PowerShell 5.1
 * 吃 LF-only 的亏），所以 **CI 检出的是 CRLF，WSL 工作区里却是 LF**，而 `git status` 两边都算干净。
 * 按 `\n}\n` 切函数体、按 `\{\n\s+` 配对的判据在 CRLF 下会切出空串或整篇，守卫本地绿、CI 红。
 */
function read(rel: string): string {
  return readFileSync(join(PROJECT_ROOT, rel), "utf8").replace(/\r\n/g, "\n");
}

/** 只留行为：整行 # / ; 注释与行尾 # 注释都剥掉。 */
function nsisCode(rel: string): string {
  return read(rel)
    .split("\n")
    .map((line) => {
      const head = line.replace(/^[ \t]+/, "");
      if (head.startsWith("#") || head.startsWith(";")) return "";
      return line.replace(/[ \t]+#.*$/, "");
    })
    .join("\n");
}

/** 只留行为：YAML 的整行注释不算判据（发版链路的注释里全是「原先怎么写错了」）。 */
function yamlCode(text: string): string {
  return text
    .split("\n")
    .map((line) => (/^[ \t]*#/.test(line) ? "" : line))
    .join("\n");
}

function stepChunk(workflowCode: string, name: string): string {
  const header = `name: ${name}\n`;
  const hit = workflowCode.split(/\n {6}- /).find((part) => part.startsWith(header));
  return hit ?? "";
}

function sectionSlice(code: string, header: string): string {
  const start = code.indexOf(header);
  if (start < 0) return "";
  const end = code.indexOf("SectionEnd", start);
  return code.slice(start, end < 0 ? code.length : end);
}

function uninstallSection(code: string): string {
  return sectionSlice(code, 'Section "uninstall"');
}

function installSection(code: string): string {
  const at = code.indexOf("\nSection\n");
  return at < 0 ? "" : sectionSlice(code.slice(at), "\nSection\n").trimStart();
}

function goStringConst(rel: string, name: string): string {
  // 允许中间夹类型名：Go 里写的是 RuntimeModeInstalled RuntimeMode = "installed"
  const m = new RegExp(String.raw`${name}[^\n=]*=\s*"([^"]*)"`).exec(stripComments(read(rel)));
  if (!m) throw new Error(`${rel} 里找不到字符串常量 ${name}`);
  return m[1];
}

function goStructTags(rel: string, structName: string): string[] {
  const m = new RegExp(String.raw`type ${structName} struct \{([\s\S]*?)\n\}`).exec(stripComments(read(rel)));
  if (!m) throw new Error(`${rel} 里找不到 type ${structName} struct`);
  return [...m[1].matchAll(/json:"([^",]+)/g)].map((found) => found[1]);
}

describe("A. 安装程序不得毁掉用户数据", () => {
  it("每用户安装：user 执行级别必须在 include wails_tools 之前定下", () => {
    const code = nsisCode(NSI);
    const defineAt = code.search(/!define REQUEST_EXECUTION_LEVEL "user"/);
    const includeAt = code.search(/!include "wails_tools\.nsh"/);
    expect(defineAt, "wails_tools.nsh 的默认执行级别是 admin（每机 Program Files + 每次升级弹 UAC），" +
      "只能在 include 之前用 !define 覆盖，写在后面就晚了").toBeGreaterThanOrEqual(0);
    expect(includeAt, "找不到 !include wails_tools.nsh").toBeGreaterThan(defineAt);
    expect(code.match(/!define REQUEST_EXECUTION_LEVEL/g)?.length, "执行级别只能定一处").toBe(1);
  });

  it("默认安装位置在当前用户目录下，且回读自己读 HKCU", () => {
    const code = nsisCode(NSI);
    const installDir = /!define DEFAULT_INSTALL_DIR "([^"]*)"/.exec(code)?.[1];
    expect(installDir, "必须显式 !define DEFAULT_INSTALL_DIR").toBeTruthy();
    expect(installDir).toContain("$LOCALAPPDATA");
    expect(installDir).not.toMatch(/Program Files/);
    expect(code).toMatch(/InstallDir "\$\{DEFAULT_INSTALL_DIR\}"/);
    // 不能用 InstallDirRegKey：卸载条目是 SetRegView 64 写的，.onInit 跑在默认 32 位视图上读不到
    expect(code).not.toMatch(/InstallDirRegKey/);
    expect(code).toMatch(/ReadRegStr \$R0 HKCU "\$\{UNINST_KEY\}" "InstallLocation"/);
  });

  it("卸载只删程序目录并豁免数据目录：无 $AppData、无整体 RMDir /r、不碰 HKLM", () => {
    const code = nsisCode(NSI);
    expect(code, "$AppData 下是 webview 缓存与凭据，安装/卸载程序都没有资格删它").not.toMatch(/\$AppData/);
    expect(code, "这套脚本只写 HKCU：user 级安装写 HKLM 是静默失败").not.toMatch(/HKLM/);
    expect(code).not.toMatch(/RMDir\s+\/r\s+"\$INSTDIR"/);

    const un = uninstallSection(code);
    expect(un, "找不到 uninstall Section").toBeTruthy();
    expect(un).toContain("${APP_DATA_DIR_NAME}");
    expect(un).toMatch(/RMDir "\$INSTDIR"/);
    expect(un).toMatch(/DeleteRegKey HKCU/);
    const ins = installSection(code);
    expect(ins).toMatch(/SetOutPath \$INSTDIR/);
    expect(ins).toMatch(/!insertmacro wails\.files/);
  });

  it("程序名与卸载键与 wails.json、update.json 同源", () => {
    const code = nsisCode(NSI);
    expect(/!define PRODUCT_EXECUTABLE "([^"]*)"/.exec(code)?.[1]).toBe("ConfScope.exe");
    expect(/!define UNINST_KEY_NAME "([^"]*)"/.exec(code)?.[1]).toBe("ConfScope");
    const wailsJson = JSON.parse(read("wails.json")) as { outputfilename: string; info: { productName: string } };
    expect(wailsJson.outputfilename + ".exe", "wails.json 的输出名要与安装脚本的 PRODUCT_EXECUTABLE 一致，否则装的是 confscope.exe 而更新链路认的是 ConfScope.exe")
      .toBe(/!define PRODUCT_EXECUTABLE "([^"]*)"/.exec(code)?.[1]);
    expect(wailsJson.info.productName).toBe(/!define UNINST_KEY_NAME "([^"]*)"/.exec(code)?.[1]);
    expect(countOccurrences(code, /\$\{INFO_PRODUCTNAME\}/g)).toBeGreaterThan(0);
  });
});

describe("B. 覆盖二进制之前必须确认正位可写（已退出或已让位），且绝不终止进程", () => {
  it("没有任何强杀/隐藏 helper 的形态", () => {
    // 唯一允许的「看得见地起进程」是装完把程序打开，且只许 ExecShell "open" 一处，判据归 I 组。
    const code = nsisCode(NSI);
    for (const banned of [/taskkill/i, /nsExec/i, /Process::Kill/i, /\bExecWait\b/i, /\bExec\b/]) {
      expect(code, `安装程序不许起看不见的进程或强杀（判据归属：何时可覆盖是安装程序的责任，用有界等待）：命中 ${banned}`).not.toMatch(banned);
    }
  });

  it("能不能覆盖只看目标 exe 被不被占用；进程号降级成诊断", () => {
    const code = nsisCode(NSI);
    // v1.9.9 线上事故的形态：slotBusy 里先看 OpenProcess 成不成，成功就当「进程还活着」并跳过
    // 文件探针。进程已退出而句柄仍被引用、或 PID 被复用时判据永远为真，用户看到的症状就是
    // 「等待 ConfScope 退出」无限打转。所以探针必须只剩文件这一条。
    const probe = functionBody(code, "slotBusy");
    expect(probe).toMatch(/FileOpen \$2 "\$INSTDIR\\\$\{PRODUCT_EXECUTABLE\}" a/);
    expect(probe, "slotBusy 里不许再按进程号判忙：判据归属只能有一条").not.toMatch(/OpenProcess/);

    // 进程号那一脚只能在 appPidAlive 里，且必须问 GetExitCodeProcess（句柄非空 ≠ 活着），
    // 拿到句柄必须关掉。
    const pidProbe = functionBody(code, "appPidAlive");
    expect(pidProbe).toMatch(/kernel32::OpenProcess\(i 0x1000/);
    expect(pidProbe).toMatch(/kernel32::GetExitCodeProcess\(p \$1, \*i\.r2\)/);
    expect(pidProbe).toMatch(/kernel32::CloseHandle\(p \$1\)/);
    expect(pidProbe).toMatch(/\$\{If\} \$2 = \$\{STILL_ACTIVE\}/);
    expect(countOccurrences(code, /kernel32::OpenProcess/g), "OpenProcess 每次都得有对应的 CloseHandle").toBeLessThanOrEqual(
      countOccurrences(code, /kernel32::CloseHandle/g),
    );
  });

  it("有界等待 + 轮次上限 + 进度可见：宁可这一版不覆盖，也绝不无限转圈", () => {
    const code = nsisCode(NSI);
    expect(code).toMatch(/Sleep \$\{WAIT_INTERVAL\}/);
    expect(code).toMatch(/\$\{If\} \$R9 >= \$\{WAIT_TICKS\}/);
    expect(code).toMatch(/!define WAIT_ROUNDS \d+/);
    expect(code).toMatch(/\$\{If\} \$WaitRound >= \$\{WAIT_ROUNDS\}/);
    expect(code).toMatch(/!define WAIT_PROGRESS_TICKS \d+/);
    expect(code).toMatch(/IntOp \$R8 \$R9 % \$\{WAIT_PROGRESS_TICKS\}/);
    // 「还在数」必须在进度页看得见，否则用户只能对着静止的窗口猜。
    expect(code).toMatch(/DetailPrint "\$\(CS_WAIT_PROGRESS\)\$R7\$\(CS_WAIT_SECONDS\)"/);
    // 一撞上占用就要说清在等谁：文件路径 + 进程号线索，两类都得有中英文案。
    const keys = [
      "CS_WAIT_FILE",
      "CS_WAIT_NOPID",
      "CS_WAIT_PID_ALIVE",
      "CS_WAIT_PID_GONE",
      "CS_WAIT_PROGRESS",
      "CS_WAIT_SECONDS",
      "CS_WAIT_GIVEUP_LONG",
      // 让位（轮100）：进度页与收尾弹窗的每一句都得中英各一条，缺一条就是英文用户在中文机器上看中文提示。
      "CS_PARK_TRY",
      "CS_PARK_DONE",
      "CS_PARK_FAIL",
      "CS_PARK_NAME_BUSY",
      "CS_PARK_RESTART",
    ];
    for (const key of keys) {
      expect(countOccurrences(code, new RegExp(String.raw`LangString ${key} \$\{LANG_`, "g")), `${key} 必须中英各一条`).toBe(2);
    }
    expect(code).toMatch(/SetErrorLevel 75/);
    expect(countOccurrences(code, /Abort/g), "放弃覆盖必须真的中止 Section").toBeGreaterThanOrEqual(3);
    expect(countOccurrences(code, /Call ensureSlotFree/g), "单点闸门：判据只许出现在安装 Section 开头一次").toBe(1);
    const ins = installSection(code);
    expect(ins.indexOf("Call ensureSlotFree"), "ensureSlotFree 必须在 wails.files 覆盖之前").toBeLessThan(ins.indexOf("!insertmacro wails.files"));
  });

  it("等不到退出时有第二条出路：改名让位，零终止（轮100）", () => {
    const code = nsisCode(NSI);
    expect(parkProblems(code), "让位这一脚的不变量漂了").toEqual([]);
    // 让位只在等满一轮之后发生：正常「退出并安装」的实例几秒内就退了，
    // 不该平白在程序目录里留下一份旧副本。
    const gate = functionBody(code, "ensureSlotFree");
    const roundFull = gate.indexOf("${If} $R9 >= ${WAIT_TICKS}");
    expect(roundFull, "找不到「等满一轮」的判定：让位就没了落点").toBeGreaterThanOrEqual(0);
    expect(gate.indexOf("Call parkLockedSlot"), "让位必须排在等满一轮之内，不能一撞上占用就改名").toBeGreaterThan(roundFull);
  });

  it("让位不取代等待：静默放弃 / 重试 / 到点停手三条既有出口一条都不许少", () => {
    const code = nsisCode(NSI);
    const gate = functionBody(code, "ensureSlotFree");
    expect(gate).toContain("Sleep ${WAIT_INTERVAL}");
    expect(countOccurrences(gate, /SetErrorLevel 75/g), "让位失败仍要能非 0 退出").toBeGreaterThanOrEqual(3);
    expect(countOccurrences(gate, /\bAbort\b/g), "放弃覆盖必须真的中止 Section").toBeGreaterThanOrEqual(3);
    expect(
      gate,
      "静默模式仍然要有立刻放弃的出口：让位失败就落到它，不许再兜一圈",
    ).toMatch(/\$\{If\} \$ParkOk == "1"\n[\s\S]*?\$\{EndIf\}\n\s*DetailPrint "\$\(CS_PARK_FAIL\)\$ParkErr"\n\s*\$\{If\} \$\{Silent\}/);
    const ins = installSection(code);
    expect(ins.indexOf("Call ensureSlotFree")).toBeLessThan(ins.indexOf("!insertmacro wails.files"));
    expect(countOccurrences(code, /Call ensureSlotFree/g), "单点闸门：判据只许出现在安装 Section 开头一次").toBe(1);
    expect(countOccurrences(code, /Call parkLockedSlot/g), "让位只许在闸门里调一次").toBe(1);
  });

  it("变异对照：删掉让位、让位后不 Return、让位里动手删文件、越界改计数器，都必须判红", () => {
    const code = nsisCode(NSI);
    expect(parkProblems(code)).toEqual([]);

    const noPark = code.replace("Call parkLockedSlot", "Call unrelatedSlot");
    expect(noPark, "变异没落到实处").not.toBe(code);
    expect(parkProblems(noPark).length, "整脚让位被删掉必须判红").toBeGreaterThan(0);

    const noReturn = code.replace('                DetailPrint "$(CS_PARK_RESTART)"\n                Return\n', '                DetailPrint "$(CS_PARK_RESTART)"\n');
    expect(noReturn, "变异没落到实处").not.toBe(code);
    expect(parkProblems(noReturn).length, "让位成功不 Return 必须判红").toBeGreaterThan(0);

    const deletes = code.replace('    Rename "$INSTDIR\\${PRODUCT_EXECUTABLE}" "$ParkTarget"', '    Delete "$INSTDIR\\${PRODUCT_EXECUTABLE}"');
    expect(deletes, "变异没落到实处").not.toBe(code);
    expect(parkProblems(deletes).length, "让位里出现删除动作必须判红").toBeGreaterThan(0);

    const kills = code.replace(
      '        StrCpy $ParkOk "1"\n        Return',
      '        System::Call \'kernel32::TerminateProcess(p $1, i 0)\'\n        StrCpy $ParkOk "1"\n        Return'
    );
    expect(kills, "变异没落到实处").not.toBe(code);
    expect(parkProblems(kills).length, "让位里出现终止进程必须判红").toBeGreaterThan(0);

    const clobbers = code.replace('    StrCpy $ParkErr ""\n', '    StrCpy $R9 0\n    StrCpy $ParkErr ""\n');
    expect(clobbers, "变异没落到实处").not.toBe(code);
    expect(parkProblems(clobbers).length, "让位改了等待计数器必须判红").toBeGreaterThan(0);

    expect(parkedSuffixProblems(code.replace('!define PARKED_SUFFIX ".pending-"', '!define PARKED_SUFFIX ".old-"')).length, "让位前缀两侧字面量漂了必须判红").toBeGreaterThan(0);
  });
});

describe("C. 安装包与程序两侧的字面量必须同源", () => {
  it("数据目录名与安装标记名取自 Go 侧常量的同一字面量", () => {
    const code = nsisCode(NSI);
    const nsiDataDir = /!define APP_DATA_DIR_NAME "([^"]*)"/.exec(code)?.[1];
    const nsiMarker = /!define INSTALL_MARKER_NAME "([^"]*)"/.exec(code)?.[1];
    expect(nsiDataDir, "project.nsi 必须 !define APP_DATA_DIR_NAME，卸载豁免靠它").toBeTruthy();
    expect(nsiMarker, "project.nsi 必须 !define INSTALL_MARKER_NAME").toBeTruthy();
    expect(nsiDataDir).toBe(goStringConst("internal/portabledata/portable_data.go", "DataDirName"));
    expect(nsiMarker).toBe(goStringConst("internal/portabledata/runtime_layout.go", "InstallMarkerFileName"));
  });

  it("install.json 写的字段 Go 侧全解得出来，mode 值就是 installed", () => {
    const code = nsisCode(NSI);
    const body = /FileWrite \$9 '(\{[^']*\})'/.exec(code)?.[1];
    expect(body, "writeInstallMarker 必须写出一行 install.json").toBeTruthy();
    const keys = [...(body as string).matchAll(/"([^"]+)":/g)].map((m) => m[1]);
    const tags = goStructTags("internal/portabledata/runtime_layout.go", "InstallMarker");
    for (const key of keys) {
      expect(tags, `安装包写的字段 ${key} 不在 Go 的 InstallMarker json tag 里，读回来是空值 ⇒ 按便携态解析数据根`).toContain(key);
    }
    expect([...keys].sort()).toEqual([...tags].sort());
    expect(/"mode":"installed"/.test(body as string)).toBe(true);
    expect(goStringConst("internal/portabledata/runtime_layout.go", "RuntimeModeInstalled")).toBe("installed");
  });

  it("命令行开关与 Go 侧发起安装包时传的参数逐字一致", () => {
    const code = nsisCode(NSI);
    expect(code).toMatch(/\$\{GetOptions\} "\$CmdLine" "\/UPDATE"/);
    expect(code).toMatch(/\$\{GetOptions\} "\$CmdLine" "\/PID"/);
    const handoff = stripComments(read(HANDOFF_GO));
    expect(handoff, "Go 侧传的要与 .nsi 解析的开关同名，否则升级永远走成人工双击").toContain('exec.Command(path, "/UPDATE", "/PID="+');
  });

  it("让位前缀与 Go 侧 ParkedExecutableSuffix 同源（漂了就是遗留文件永远清不掉）", () => {
    expect(parkedSuffixProblems(nsisCode(NSI))).toEqual([]);
  });

  it("Go 侧清扫只认安装态，并且真的挂在启动链路上", () => {
    const parked = stripComments(read(PARKED_GO));
    expect(parked, "非安装态必须原样退出：便携版的 exe 可能在 U 盘或别人的目录里，程序没资格在那儿删文件")
      .toMatch(/if layout\.Mode != RuntimeModeInstalled \{/);
    expect(parked, "取不到绝对路径时不许拿占位路径去扫当前工作目录").toMatch(/!filepath\.IsAbs\(exePath\)/);
    expect(parked, "「没扫」与「扫了但没有遗留」得看得出区别，否则日志读成空气").toMatch(/report\.Reason =/);
    expect(parked, "真扫过就必须留自证据").toMatch(/AppendRuntimeLogLine\(layout\.DataRoot, report\.logLine\(\)\)/);
    expect(parked, "只删普通文件：同名目录绝不递归删除，符号链接绝不跟随").toMatch(/!info\.Mode\(\)\.IsRegular\(\)/);

    const main = stripComments(read(MAIN_GO));
    expect(main, "清扫没接到启动链路上就是死代码：让位留下的旧副本会永远躺着")
      .toMatch(/portabledata\.CleanParkedExecutables\(layout, exePath\)/);
  });
});

describe("D. 程序自己永不写运行形态标记", () => {
  it("非测试 Go 代码里没有任何写 install.json 的路径", () => {
    const offenders: string[] = [];
    for (const dir of MARKER_CONSUMER_DIRS) {
      for (const name of readdirSync(join(PROJECT_ROOT, dir))) {
        if (!name.endsWith(".go") || name.endsWith("_test.go")) continue;
        const text = readFileSync(join(PROJECT_ROOT, dir, name), "utf8");
        for (const line of stripComments(text).split("\n")) {
          if (!line.includes("InstallMarkerFileName")) continue;
          if (/os\.(WriteFile|Create|OpenFile|Remove|Rename)/.test(line)) offenders.push(`${dir}/${name}: ${line.trim()}`);
        }
      }
    }
    expect(offenders, "只有安装程序写 install.json；程序写它等于把便携副本伪装成安装态").toEqual([]);
  });
});

describe("E. 交接出路的绑定面不缺角", () => {
  it("wailsjs 的接口段与导出段都写着同一个名字", () => {
    const text = read(WAILS_TS);
    for (const name of HANDOFF_BINDINGS) {
      expect(text, `${name} 缺接口声明（type 段）`).toMatch(new RegExp(String.raw`^\s*${name}\(.*\): Promise`, "m"));
      expect(text, `${name} 缺导出（export 段）`).toMatch(new RegExp(String.raw`export const ${name} = \(`));
    }
  });

  it("前端 API 与两套测试桥都覆盖这一批方法", () => {
    for (const file of BRIDGE_FILES) {
      const text = read(file);
      for (const name of HANDOFF_BINDINGS) {
        expect(text, `${file} 缺 ${name}：retest/smoke 会静默走不到新出路，等于没测`).toContain(name);
      }
    }
  });

  it("Go 侧真的有同名方法挂在 App 上", () => {
    const appGo = stripComments(read(APP_GO));
    for (const name of HANDOFF_BINDINGS) {
      expect(appGo, `internal/app/app.go 没有 func (a *App) ${name}(...)，绑定表写的是空气`).toMatch(new RegExp(String.raw`func \(a \*App\) ${name}\(`));
    }
  });
});

describe("F. CI 不能静默不出安装包", () => {
  it("OutFile 产物名 → CI 断言/上传/manifest → Go 查表键，一条链对齐", () => {
    const code = nsisCode(NSI);
    const outFile = /OutFile "([^"]*)"/.exec(code)?.[1];
    expect(outFile, "OutFile 必须显式定义，否则产物名跟着 wails 模板漂").toBeTruthy();
    expect(outFile).toBe("..\\..\\bin\\confscope-windows-${ARCH}-installer.exe");
    const artifact = (outFile as string).split("\\").pop() as string;
    expect(artifact.replace("${ARCH}", "amd64")).toBe("confscope-windows-amd64-installer.exe");
    const key = `windows-${artifact.replace("${ARCH}", "amd64").replace(/^confscope-windows-/, "").replace(/-installer\.exe$/, "")}-installer`;
    expect(key).toBe(goStringConst(ARTIFACT_GO, "InstallerPlatformKey"));

    const wf = read(WORKFLOW);
    // upload-artifact 的 name 决定 generate-manifest/release 里的目录名，约定是 ConfScope-<manifest 键>
    expect(wf).toContain(`name: ConfScope-${key}`);
    expect(wf).toContain(`path: build/bin/${artifact.replace("${ARCH}", "amd64")}`);
    expect(wf).toContain(`sha256sum "artifacts/ConfScope-${key}/${artifact.replace("${ARCH}", "amd64")}"`);
    expect(wf).toContain(`fileName: "${artifact.replace("${ARCH}", "amd64")}"`);
    expect(wf).toContain(`artifacts/ConfScope-${key}/${artifact.replace("${ARCH}", "amd64")}`);
  });

  it("build 作业对 windows 显式带 -nsis，断言步骤不吞错", () => {
    const wf = yamlCode(read(WORKFLOW));
    const build = stepChunk(wf, "Build");
    // 只看报错文案里的 -nsis 不算：必须真的赋成开关，并真的进 wails 那一行
    expect(build).toMatch(/NSIS_FLAG="-nsis"/);
    expect(build).toMatch(/wails build [^\n]*\$\{NSIS_FLAG\}/);
    expect(build).toContain("command -v makensis");
    expect(build).toContain(".info.productVersion");
    expect(build).toContain("INSTALLER_VERSION");

    const assertStep = stepChunk(wf, "Assert Windows installer exists");
    expect(assertStep, "没有断言安装包存在的步骤：makensis 缺失时 wails 只打一行 Warning 就 return nil，构建全绿而产物没有安装包").toBeTruthy();
    expect(assertStep).toContain("test -f");
    expect(assertStep).not.toContain("|| true");

    const nsisStep = stepChunk(wf, "Install NSIS (Windows)");
    expect(nsisStep, "Windows 作业不装 NSIS，-nsis 就是空转").toContain("choco install nsis");
    expect(nsisStep).toContain("GITHUB_PATH");
  });

  it("preflight 在 Linux 上就把安装包脚本编译一遍", () => {
    const wf = yamlCode(read(WORKFLOW));
    const step = stepChunk(wf, "Validate Windows installer script (makensis)");
    expect(step, "project.nsi 的语法错误又只能在 Windows 出包时暴露了").toBeTruthy();
    expect(step).toContain("apt-get install -y nsis");
    expect(step).toContain("command -v makensis");
    expect(step).toContain("bash scripts/check-windows-installer.sh");
    expect(step).toContain("test -f build/bin/confscope-windows-amd64-installer.exe");
  });

  it("wails_tools.nsh 的默认值仍可被 project.nsi 覆盖（每次构建会被 wails 重写）", () => {
    const tools = nsisCode(TOOLS);
    expect(tools, "wails 若去掉 !ifndef 守卫，我们的 !define 就不再起作用，得改在别处覆盖").toMatch(/!ifndef REQUEST_EXECUTION_LEVEL/);
    expect(tools).toMatch(/!ifndef INFO_PRODUCTVERSION/);
    expect(tools).toMatch(/!define ARCH "amd64"/);
  });

  it("安装包版本号两条通道都对齐：四段式 VIProductVersion + 构建前写 wails.json", () => {
    const code = nsisCode(NSI);
    expect(code).toMatch(/VIProductVersion "\$\{INFO_PRODUCTVERSION\}\.0"/);
    expect(code).toMatch(/FileWrite \$9 '\{"mode":"installed","version":"\$\{INFO_PRODUCTVERSION\}"/);
    const committed = JSON.parse(read("wails.json")) as { info: { productVersion: string } };
    expect(committed.info.productVersion, "仓库里提交的 info.productVersion 必须是三段式数字：CI 构建前按 tag 覆写，dev 构建覆写成 0.0.0")
      .toMatch(/^\d+\.\d+\.\d+$/);
    const wf = yamlCode(read(WORKFLOW));
    expect(stepChunk(wf, "Build")).toMatch(/jq --arg v "\$\{INSTALLER_VERSION\}" '\.info\.productVersion = \$v'/);
  });
});

describe("G. 安装包的中文不能是码页错读出来的乱码", () => {
  // 判据本身是负向的：不校验「有没有中文」，只校验「有没有 UTF-8 字节被当单字节码页读出来
  // 的形态」。这样 NSIS 版本、语言表、字符串顺序变了都不会让守卫自红。
  it("project.nsi 带非 ASCII 就必须带 UTF-8 BOM，且 BOM 后第一行是 Unicode true", () => {
    const bytes = readBytes(NSI);
    expect(hasNonAscii(bytes), "project.nsi 的中文 LangString 又被清空了？安装进度页会只剩英文").toBe(true);
    expect(encodingProblems({ nsiBytes: bytes })).toEqual([]);
    const text = bytes.subarray(3).toString("utf8");
    expect(text.split("\n")[0].trim(), "BOM 后面第一行必须是 Unicode true").toBe("Unicode true");
  });

  it("wails_tools.nsh 每次构建被 wails 重写且不带 BOM，所以它里面不许有非 ASCII", () => {
    const tools = readBytes(TOOLS);
    expect(hasNonAscii(tools), "wails 模板里出现了非 ASCII：它不带 BOM，Windows 编译必乱码，得把文案挪回 project.nsi").toBe(false);
  });

  it("Linux 闸门跑产物体检，Windows 出包链路也跑，两处都不许静默跳过", () => {
    const sh = read("scripts/check-windows-installer.sh");
    expect(sh, "preflight 只验语法就等于没验：产物体检必须在编译完就跑一次").toContain("check-installer-strings.mjs");
    expect(sh).toContain("REQUIRE_STRING_CHECK");
    // 体检脚本静默退出 0（入口判定不成立、或压根没跑）也算过，那是空气闸门：两处都得要求实际输出
    expect(sh, "产物体检没要求实际输出，静默跳过就查不出来").toContain('grep -E "UTF-16LE"');
    const wf = yamlCode(read(WORKFLOW));
    expect(stepChunk(wf, "Validate Windows installer script (makensis)")).toContain("REQUIRE_STRING_CHECK=1");
    const check = stepChunk(wf, "Check Windows installer strings");
    expect(check, "Windows 出包时没对真实安装包跑乱码判据，v1.9.9 那次的乱码包还会再发一次").toBeTruthy();
    expect(check).toContain("check-installer-strings.mjs --self-test");
    expect(check).toContain("build/bin/confscope-windows-amd64-installer.exe");
    expect(check).toMatch(/--self-test\s*\|\s*grep/);
    expect(check).toMatch(/installer\.exe\s*\|\s*grep -E "UTF-16LE"/);
    // 判据得排在「安装包确实存在」之后、上传之前：缺产物时先报缺产物，乱码包不许进 artifact
    const order = wf.indexOf("- name: Assert Windows installer exists");
    const checkAt = wf.indexOf("- name: Check Windows installer strings");
    const uploadAt = wf.indexOf("- name: Upload artifact (Windows installer)");
    expect(checkAt).toBeGreaterThan(order);
    expect(checkAt).toBeLessThan(uploadAt);
  });

  it("判据自身有可执行证据：脚本 --self-test 必须退出 0", () => {
    const out = execFileSync("node", ["scripts/check-installer-strings.mjs", "--self-test"], {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
    });
    expect(out).toMatch(/ok/i);
  });

  it("体检脚本「直接执行」的判定跨平台成立（CI 那一步不是空气闸门）", () => {
    const scriptText = read(STRINGS_SCRIPT);
    expect(entrypointProblems(scriptText), "入口判定的形态漂了").toEqual([]);

    // 可执行证据：路径里带空格时 import.meta.url 会转成 %20，而 argv[1] 不会——
    // 这正是 Windows 上「反斜杠 + 盘符」那类不等价的同型场景。此时 CLI 必须照样真的跑。
    const spacedDir = mkdtempSync(join(tmpdir(), "confscope installer check-"));
    const target = join(spacedDir, "check-installer-strings.mjs");
    writeFileSync(target, scriptText, "utf8");
    const out = execFileSync("node", [target, "--self-test"], { encoding: "utf8" });
    expect(out).toMatch(/blocks=\d+ bad=\d+/);
    expect(out, "静默退出（什么都没输出）说明入口判定又错了").toMatch(/正确中文不该判红/);

    // 变异对照：换回逐字比对的写法，带空格路径这一跑就没输出了
    const naive = scriptText.replace(
      "resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))",
      "import.meta.url === `file://${process.argv[1]}`"
    );
    expect(naive).not.toBe(scriptText);
    expect(entrypointProblems(naive).length).toBeGreaterThan(0);
    const naiveTarget = join(spacedDir, "naive-entry.mjs");
    writeFileSync(naiveTarget, naive, "utf8");
    const silent = execFileSync("node", [naiveTarget, "--self-test"], { encoding: "utf8" });
    expect(silent.trim(), "旧写法在这种路径形态下压根不跑 CLI").toBe("");
  });

  it("变异对照：抹掉 BOM、给 tools 塞中文、删掉 Windows 那一步、preflight 放宽，都必须判红", () => {
    const nsiBytes = readBytes(NSI);
    const tools = read(TOOLS);
    const wf = yamlCode(read(WORKFLOW));
    const preflight = stepChunk(wf, "Validate Windows installer script (makensis)");
    // 先确认这一步还在：整块被删/改名时，下面那句「放宽 REQUIRE_STRING_CHECK」的变异是在不存在的文本上做文章
    expect(preflight, "release.yml 里找不到 makensis 校验那一步").toContain("makensis");

    const noBom = Buffer.concat([Buffer.from("Unicode true\n"), nsiBytes.subarray(3)]);
    expect(encodingProblems({ nsiBytes: noBom }).length).toBeGreaterThan(0);

    expect(encodingProblems({ nsiBytes, toolsText: tools + '\nLangString zh 1000 "\u4e2d\u6587"\n' }).length).toBeGreaterThan(0);

    const withoutStep = wf.replace("      - name: Check Windows installer strings\n", "      - name: x\n");
    expect(withoutStep).not.toBe(wf);
    expect(workflowProblems(withoutStep).length).toBeGreaterThan(0);

    const lenient = wf.replace("REQUIRE_STRING_CHECK=1 bash scripts/check-windows-installer.sh", "bash scripts/check-windows-installer.sh");
    expect(lenient).not.toBe(wf);
    expect(workflowProblems(lenient).length).toBeGreaterThan(0);

    const silentCi = wf.replace(' | grep -E "UTF-16LE"\n', "\n");
    expect(silentCi).not.toBe(wf);
    expect(workflowProblems(silentCi).length).toBeGreaterThan(0);

    const silentSelfTest = wf.replace(' --self-test | grep -E "^ok +.*blocks=[0-9]+ bad=[0-9]+"', " --self-test");
    expect(silentSelfTest).not.toBe(wf);
    expect(workflowProblems(silentSelfTest).length).toBeGreaterThan(0);
  });
});

describe("H. 窗口关了进程必须真的退出去（否则安装永远等在占用上）", () => {
  it("拨号不在锁里：停止/退出不会被一条拨不动的隧道拖死", () => {
    const tunnel = stripComments(read(TUNNEL_GO));
    const start = /func \(t \*Tunnel\) Start\(\)[\s\S]*?\n}/.exec(tunnel)?.[0] ?? "";
    expect(start, "找不到 Tunnel.Start").not.toBe("");
    expect(start, "Start 里不许用 defer 持锁跨拨号：那是「窗口没了进程还活着」的第一现场").not.toMatch(/defer t\.mu\.Unlock\(\)/);
    expect(start).toMatch(/t\.mu\.Unlock\(\)/);
    const forward = /func \(t \*Tunnel\) forward\([\s\S]*?\n}/.exec(tunnel)?.[0] ?? "";
    expect(forward, "Accept 出错且没要求停止时要退避，否则空转烧 CPU").toMatch(/acceptRetryDelay/);

    const manager = stripComments(read(MANAGER_GO));
    expect(manager).toMatch(/func \(m \*Manager\) StopAllWithCeiling\(ceiling time\.Duration\) \[\]string/);
    const create = /func \(m \*Manager\) CreateTunnel\([\s\S]*?\n}/.exec(manager)?.[0] ?? "";
    expect(create, "CreateTunnel 不许持 m.mu 跨拨号").not.toMatch(/m\.mu\.Lock\(\)\n\s*defer m\.mu\.Unlock\(\)/);
    expect(create).toMatch(/stopped while connecting/);
  });

  it("退出收尾走带硬上限的那一支，超时点名到连接", () => {
    const app = stripComments(read(APP_GO));
    expect(app).toMatch(/const shutdownTunnelCeiling = \d+ \* time\.Second/);
    expect(app, "退出收尾必须把「关掉所有隧道」交给带上限的实现").toMatch(/mgr\.StopAllWithCeiling\(ceiling\)/);
    const shutdown = /func \(a \*App\) Shutdown\(ctx context\.Context\)\s*\{[\s\S]*?\n}/.exec(app)?.[0] ?? "";
    expect(shutdown).toMatch(/stopAllTunnelsOnShutdown\(a\.sshMgr, shutdownTunnelCeiling\)/);
    expect(shutdown).toMatch(/reportPendingTunnelsOnShutdown/);
    expect(app, "退出诊断要有类别前缀，才能和启动时的数据根解析分开检索").toMatch(String.raw`shutdown\t`);
  });

  it("交接实测脚本与 CI 闸门都在位：Windows 真机跑过才算修完", () => {
    const ps1 = read(HANDOFF_PS1);
    expect(ps1).toMatch(/\$ErrorActionPreference\s*=\s*'Stop'/);
    expect(ps1, "静默安装必须带 /UPDATE，且 /D= 只能放最后一个参数").toMatch(/\/UPDATE/);
    expect(ps1).toMatch(/HANDOFF-CI ok scenarios=\d+/);
    expect(ps1, "每个场景都得先清掉上一轮留下的 HKCU 卸载项，否则 resolveInstallDir 会把 /D 覆盖掉").toMatch(/Uninstall\\ConfScope/);
    for (const flag of ["/PID=", "/S"]) expect(ps1).toContain(flag);
    // 轮100：场景 A 从「必须 75」翻成「必须 0 + 让位断言」。还钉着旧期望就是在验旧行为。
    expect(ps1, "场景 A 必须期望让位覆盖装上（退出码 0），否则等不到退出就还是只能放弃").toMatch(/-Prepare \$scenarioA -Expect 0/);
    expect(ps1, "让位的三条硬断言一条都不能少：遗留副本在、副本还被锁着、旧进程还活着").toMatch(/ConfScope\.exe\.pending-\*/);
    expect(ps1).toMatch(/Test-FileLocked -Path \$parkedPath/);
    expect(ps1).toMatch(/Get-Process -Id \(\[int\]\$ProcId\)/);
    expect(ps1, "每个场景只许产出一行结果：CI 钉的是 scenarios=4，多写一行就多一个假失败")
      .toMatch(/\$script:results \+= "FAIL \$Name : \$detail"/);

    const wf = yamlCode(read(WORKFLOW));
    expect(wf).toContain("check-windows-installer-handoff.ps1");
    expect(wf, "CI 必须真的看到成功标记，看不到就报错（空气闸门教训）").toMatch(/HANDOFF-CI ok scenarios=4/);
    const build = stepChunk(wf, "Build application") || wf;
    expect(build.indexOf("Run Windows installer handoff check"), "交接实测必须在上传安装包产物之前").toBeLessThan(
      build.indexOf("Upload artifact (Windows installer)"),
    );
  });
});

describe("I. 装完能把程序打开，但不许开出第二个实例", () => {
  it("拉起这一脚的不变量：单一出口 + 静默永不拉起 + 让位后先问旧实例退没退", () => {
    const code = nsisCode(NSI);
    expect(relaunchProblems(code), "「装完打开程序」的不变量漂了").toEqual([]);
  });

  it("MUI 勾选框默认勾上、文案跟着界面语言、动作接到自己的函数", () => {
    const code = nsisCode(NSI);
    // MUI2 的 Finish.nsh：!ifndef MUI_FINISHPAGE_RUN_NOTCHECKED → BM_SETCHECK BST_CHECKED，
    // 也就是「默认勾上」；定义了 RUN_FUNCTION 之后 MUI2 不再自己 Exec，只 Call 我们的函数。
    expect(code).toMatch(/!define MUI_FINISHPAGE_RUN "\$INSTDIR\\\$\{PRODUCT_EXECUTABLE\}"/);
    expect(code, "勾选框的动作必须接到唯一出口，否则两条出口各漂各的判据").toMatch(/!define MUI_FINISHPAGE_RUN_FUNCTION csRelaunchApp/);
    expect(code, "默认不勾 = 用户装完不知道能立刻打开（这轮要修的正是这件事）").not.toMatch(/MUI_FINISHPAGE_RUN_NOTCHECKED/);
    expect(code, "文案走 MUI2 内置串：自定义一条就得再过一次码页乱码那道关（G 组）").not.toMatch(/MUI_FINISHPAGE_RUN_TEXT/);
  });

  it("变异对照：删静默保险 / 删安全判定 / 默认按钮翻成「是」/ 加第二处拉起，都必须判红", () => {
    const code = nsisCode(NSI);
    expect(relaunchProblems(code)).toEqual([]);

    const silentInsurance = '    ${If} ${Silent}\n        DetailPrint "$(CS_LAUNCH_SILENT)"\n        Return\n    ${EndIf}\n';
    const noSilentGuard = code.replace(silentInsurance, "");
    expect(noSilentGuard, "变异没落到实处").not.toBe(code);
    expect(relaunchProblems(noSilentGuard).length, "静默安装把界面拉起来必须判红").toBeGreaterThan(0);

    const noLauncherCheck = code.replace('    Call canRelaunch\n    ${If} $RelaunchSafe != "1"', '    ${If} $RelaunchSafe != "1"');
    expect(noLauncherCheck, "变异没落到实处").not.toBe(code);
    expect(relaunchProblems(noLauncherCheck).length, "出口里删掉安全判定必须判红").toBeGreaterThan(0);

    const noSectionCheck = code.replace('        Call canRelaunch\n        ${If} $RelaunchSafe == "1"', '        ${If} $RelaunchSafe == "1"');
    expect(noSectionCheck, "变异没落到实处").not.toBe(code);
    expect(relaunchProblems(noSectionCheck).length, "升级收尾不问一句就弹「是否现在启动」必须判红").toBeGreaterThan(0);

    const autoYes = code.replace('"$(CS_LAUNCH_ASK)" /SD IDNO IDYES', '"$(CS_LAUNCH_ASK)" /SD IDYES IDYES');
    expect(autoYes, "变异没落到实处").not.toBe(code);
    expect(relaunchProblems(autoYes).length, "静默默认按钮翻成「是」= CI 每次装完自己开一个界面，必须判红").toBeGreaterThan(0);

    const noPidProbe = code.replace("    Call appPidAlive\n    ${If} $AppPidAlive = 0\n", "    ${If} $AppPidAlive = 0\n");
    expect(noPidProbe, "变异没落到实处").not.toBe(code);
    expect(relaunchProblems(noPidProbe).length, "让过位却不问旧进程退没退就说安全，必须判红").toBeGreaterThan(0);

    const noPidArg = code.replace('    ${If} $AppPid == ""\n        DetailPrint "$(CS_LAUNCH_BLOCKED)"\n        Return\n    ${EndIf}\n', "");
    expect(noPidArg, "变异没落到实处").not.toBe(code);
    expect(relaunchProblems(noPidArg).length, "人工双击没有 /PID 却当旧实例已退，必须判红").toBeGreaterThan(0);

    const secondExit = code.replace("    Call writeUninstallEntry", '    ExecShell "open" "$INSTDIR\\${PRODUCT_EXECUTABLE}"\n    Call writeUninstallEntry');
    expect(secondExit, "变异没落到实处").not.toBe(code);
    expect(relaunchProblems(secondExit).length, "多开一条拉起出口（判据写两份必然漂）必须判红").toBeGreaterThan(0);

    const noProbe = code.replace('    ExecShell "open" "$INSTDIR\\${PRODUCT_EXECUTABLE}"\n    Call confirmLaunched', '    ExecShell "open" "$INSTDIR\\${PRODUCT_EXECUTABLE}"');
    expect(noProbe, "变异没落到实处").not.toBe(code);
    expect(relaunchProblems(noProbe).length, "拉起之后不确认有没有真的起来必须判红").toBeGreaterThan(0);

    const clobbers = code.replace("    Call slotBusy\n    ${If} $SlotBusy = 1", "    StrCpy $R9 0\n    Call slotBusy\n    ${If} $SlotBusy = 1");
    expect(clobbers, "变异没落到实处").not.toBe(code);
    expect(relaunchProblems(clobbers).length, "确认探针越界改等待计数器必须判红").toBeGreaterThan(0);

    const missingEnglish = code.replace(/LangString CS_LAUNCH_BLOCKED_MSG \$\{LANG_ENGLISH\}[^\n]*/, "");
    expect(missingEnglish, "变异没落到实处").not.toBe(code);
    expect(relaunchProblems(missingEnglish).length, "拦截弹窗少一条英文文案，英文机器上会弹空串，必须判红").toBeGreaterThan(0);

    const parkBlind = code.replace('${If} $ParkOk != "1"', '${If} $ParkOk == "0"');
    expect(parkBlind, "变异没落到实处").not.toBe(code);
    expect(relaunchProblems(parkBlind).length, "让位状态读反（把「没让位」当成「让过位」）必须判红").toBeGreaterThan(0);
  });

  it("CI 实测脚本盯得住静默收尾：真拉起来就判红，且不因杀软短暂占用误红", () => {
    const ps1 = read(HANDOFF_PS1);
    expect(ps1, "静默收尾要有审计这一脚").toMatch(/function Get-SilentLaunchFault \{/);
    expect(ps1, "判据只看硬证据：WorkRoot 下冒出「不是本轮人造占用」的 ConfScope 实例").toMatch(/function Get-LauncherSpawnedInstance \{/);
    expect(ps1, "ping 改名的人造占用进程也叫 ConfScope，必须从判据里排掉，否则场景 A 恒红").toMatch(/\$script:spawned -notcontains \$_\.Id/);
    expect(ps1, "进度页文字要收下来当佐证（宿主码页不可信，所以它只是第二条腿）").toMatch(/-RedirectStandardOutput \$StdoutFile/);
    const auditFn = ps1.slice(ps1.indexOf("function Get-SilentLaunchFault {"));
    const auditBody = auditFn.slice(0, auditFn.indexOf("\n}\n"));
    expect(auditBody.length, "找不到 Get-SilentLaunchFault 的函数体").toBeGreaterThan(0);
    expect(auditBody, "不许用「新 exe 被占用」当静默判红依据：杀软扫一眼刚落地的文件就会短暂锁住，那是假失败").not.toMatch(/Test-FileLocked/);
    expect(auditBody, "探针必须是有界的，且第一次问之前要给 ExecShell 一点起步时间").toMatch(/Start-Sleep -Milliseconds/);
    const installAt = ps1.indexOf("Invoke-Installer -TargetDir $targetDir -PidArg $pidArg -StdoutFile $stdoutFile");
    const auditAt = ps1.indexOf("Get-SilentLaunchFault -StdoutFile $stdoutFile");
    expect(installAt, "找不到「带 stdout 的静默安装」那一步").toBeGreaterThanOrEqual(0);
    expect(auditAt, "静默收尾审计必须排在安装进程退出之后").toBeGreaterThan(installAt);
    expect(ps1, "真把应用拉起来了就得收掉，否则下一个场景被上一个的残留挡住").toMatch(/finally \{\n        Stop-WorkRootConfScope/);
    // 判红要落在所属场景那一行：CI 钉的是 scenarios=4，多写一行结果就多一个假失败。
    const audit = ps1.slice(ps1.indexOf("foreach ($fault in @($script:launchFaults))"));
    expect(audit.length, "找不到把静默审计并进场景结果的这一段").toBeGreaterThan(0);
    expect(audit).toMatch(/FAIL \$who :/);
    expect(audit, "静默审计不许往 results 里追加行").not.toMatch(/\$script:results \+=/);
    expect(audit).toMatch(/Write-Output "LAUNCH-AUDIT \$fault"/);
  });

  it("判据不随检出换行符变形：*.ps1 在 CI 是 CRLF，本地是 LF", () => {
    // 这条钉的是 read() 本身：谁把它改回裸 readFileSync，上面那两条按 \n}\n 切函数体的判据
    // 就会在 CI 上假红（本地永远看不见，因为 WSL 检出的是 LF）。
    const raw = readFileSync(join(PROJECT_ROOT, HANDOFF_PS1), "utf8");
    expect(read(HANDOFF_PS1), "判据文本里不许留 CR：CI 检出为 CRLF，切片会切空").not.toContain("\r");
    // 模拟 CI 的检出形态，确认归一之后仍能切出函数体、且函数体里确实不引用 Test-FileLocked。
    const crlf = raw.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
    const normalized = crlf.replace(/\r\n/g, "\n");
    const start = normalized.indexOf("function Get-SilentLaunchFault {");
    expect(start, "CRLF 形态下找不到静默收尾审计这一脚").toBeGreaterThan(-1);
    const body = normalized.slice(start, normalized.indexOf("\n}\n", start));
    expect(body.length, "CRLF 形态下切不出函数体：守卫会在 CI 里假红").toBeGreaterThan(0);
    expect(body, "静默判红不许用「新 exe 被占用」").not.toMatch(/Test-FileLocked/);
  });
});


/**
 * 让位覆盖（轮100）的不变量。返回问题清单，方便变异对照在同一套判据上跑。
 *
 * 为什么值得钉住：这条路是「等不到退出」的唯一出路，漂了不会有人立刻发现——
 * 症状是用户又对着安装进度页白等，或者程序目录里堆满没人清的旧副本。
 * 判据本身是负向的：让位只许改名，任何删除/终止/起进程的动作都判红，
 * 「不强杀」这条红线因此不是靠注释守着的。
 */
function parkProblems(code: string): string[] {
  const problems: string[] = [];
  let gate: string;
  try {
    gate = functionBody(code, "ensureSlotFree");
  } catch {
    return ["找不到 Function ensureSlotFree：单点闸门没了，让位也无从谈起"];
  }
  const parkAt = gate.indexOf("Call parkLockedSlot");
  const giveUpAt = gate.indexOf("SetErrorLevel 75");
  if (parkAt < 0) {
    problems.push("ensureSlotFree 里没有让位这一脚：等不到退出就只剩「继续等」和「放弃」两条路（用户实测的卡点）");
  }
  if (parkAt >= 0 && giveUpAt >= 0 && parkAt > giveUpAt) {
    problems.push("让位必须排在放弃覆盖之前：等满一轮直接 exit 75 的话，让位永远跑不到");
  }
  const successBlock = /\$\{If\} \$ParkOk == "1"\n([\s\S]*?)\$\{EndIf\}/.exec(gate)?.[1] ?? "";
  if (!successBlock) {
    problems.push("让位成功之后没有明确分支：$ParkOk 出参没人读，改名成功了也不会继续覆盖");
  } else if (!successBlock.includes("Return")) {
    problems.push("让位成功必须 Return 回 Section 继续覆盖：留在等待里打转等于白让");
  }

  let park = "";
  try {
    park = functionBody(code, "parkLockedSlot");
  } catch {
    problems.push("找不到 Function parkLockedSlot");
    return problems;
  }
  if (!/Rename "\$INSTDIR\\\$\{PRODUCT_EXECUTABLE\}" "\$ParkTarget"/.test(park)) {
    problems.push("让位必须把正位 exe 改名到 $ParkTarget：正位空出来才能覆盖");
  }
  if (!/\$ParkTarget "\$INSTDIR\\\$\{PRODUCT_EXECUTABLE\}\$\{PARKED_SUFFIX\}/.test(park)) {
    problems.push("让位目标名必须由 ${PARKED_SUFFIX} 拼出来，否则 Go 侧按前缀清不到遗留文件");
  }
  if (!/ClearErrors\n\s*Rename/.test(park)) {
    problems.push("Rename 之前必须 ClearErrors：错误位带着上一步的残留，${Errors} 就成了假信号");
  }
  for (const banned of [/Delete\b/, /RMDir/i, /taskkill/i, /TerminateProcess/i, /OpenProcess/, /\bExec\b/, /\$AppPid/]) {
    if (banned.test(park)) {
      problems.push(`parkLockedSlot 只许改名，不许删除/终止/起进程/按进程号做事：命中 ${banned}`);
    }
  }
  if (/\$R[789]/.test(park)) {
    problems.push("parkLockedSlot 不许碰 $R7/$R8/$R9：那是 ensureSlotFree 数等待轮次的计数器");
  }
  if (countOccurrences(code, /Function parkLockedSlot/g) !== 1) {
    problems.push("让位函数只许有一份");
  }
  return problems;
}

/** 让位前缀是 Go ⇄ NSIS 的第二条同源线：漂了就是「遗留文件永远清不掉」。 */
function parkedSuffixProblems(code: string): string[] {
  const nsi = /!define PARKED_SUFFIX "([^"]*)"/.exec(code)?.[1];
  if (!nsi) return ['project.nsi 必须 !define PARKED_SUFFIX，Go 侧按它清扫遗留副本'];
  const go = goStringConst(PARKED_GO, "ParkedExecutableSuffix");
  if (nsi !== go) return [`让位前缀两侧不同源：NSI "${nsi}" ⇄ Go "${go}" ⇒ 安装留下的旧副本永远清不掉`];
  return [];
}

/** G 组的共享判据：读文件、看码页、比 BOM，全走真实字节而不是解码后的字符串。 */
function readBytes(rel: string): Buffer {
  return readFileSync(join(PROJECT_ROOT, rel));
}

function hasNonAscii(bytes: Buffer): boolean {
  return bytes.some((byte) => byte > 0x7f);
}

/**
 * 源码侧的编码不变量：非 ASCII 的 .nsi 只有带 UTF-8 BOM 才可能在 Windows 上被正确解码；
 * wails 重写的 wails_tools.nsh 永远不带 BOM，所以它根本不该出现非 ASCII。
 * workflow 侧的不变量：preflight 不许放宽，Windows 出包链路必须对真实产物再跑一次。
 */
function encodingProblems(args: { nsiBytes: Buffer; toolsText?: string }): string[] {
  const problems: string[] = [];
  const { nsiBytes } = args;
  const toolsText = args.toolsText ?? read(TOOLS);
  if (hasNonAscii(nsiBytes) && !(nsiBytes[0] === 0xef && nsiBytes[1] === 0xbb && nsiBytes[2] === 0xbf)) {
    problems.push("project.nsi 含非 ASCII 却没有 UTF-8 BOM：Windows 的 makensis 会按 CP1252 读源码，产物里的中文全成乱码");
  }
  if (hasNonAscii(Buffer.from(toolsText, "utf8"))) {
    problems.push("wails_tools.nsh 含非 ASCII：它由 wails 重写且不带 BOM，Windows 侧编译必乱码");
  }
  return problems;
}

function workflowProblems(workflowCode: string): string[] {
  const problems: string[] = [];
  if (!workflowCode.includes("- name: Check Windows installer strings")) {
    problems.push("release.yml 的 build 作业不再对真实安装包跑乱码判据");
  }
  const preflight = stepChunk(workflowCode, "Validate Windows installer script (makensis)");
  if (!preflight.includes("REQUIRE_STRING_CHECK=1")) {
    problems.push("preflight 把产物体检放宽成可跳过（缺 node/缺产物时静默放行）");
  }
  const check = stepChunk(workflowCode, "Check Windows installer strings");
  if (!/installer\.exe\s*\|\s*grep -E "UTF-16LE"/.test(check)) {
    problems.push("Windows 侧的产物体检没要求实际输出：脚本静默退出 0 也会一路绿灯");
  }
  if (!/--self-test\s*\|\s*grep/.test(check)) {
    problems.push("判据脚本的自检没要求实际输出，跑没跑看不出来");
  }
  const sh = read("scripts/check-windows-installer.sh");
  if (!sh.includes('grep -E "UTF-16LE"')) {
    problems.push("preflight 的产物体检同样没要求实际输出");
  }
  return problems;
}

/**
 * 直接执行的判定必须走路径解析，不能逐字比 `file://${process.argv[1]}`：
 * Windows 上 argv[1] 是 D:\a\... 而 import.meta.url 是 file:///D:/a/...（反斜杠 + 盘符多一个斜杠），
 * 逐字比对恒假 ⇒ CI 那一步静默 exit 0。同一类缺陷在 Linux 上也能复现：路径里带空格时
 * import.meta.url 会把空格转成 %20，argv[1] 不会——下面的可执行证据就走这条路。
 */
function entrypointProblems(scriptText: string): string[] {
  const problems: string[] = [];
  if (/file:\$\{process\.argv\[1\]\}/.test(scriptText)) {
    problems.push("入口判定退回逐字比对 file://${process.argv[1]}：Windows（以及带空格的路径）上恒假");
  }
  if (!scriptText.includes("fileURLToPath")) {
    problems.push("入口判定没有 fileURLToPath，跨平台比不出同一个文件");
  }
  if (!/resolve\(process\.argv\[1\]\)\s*===\s*resolve\(fileURLToPath\(import\.meta\.url\)\)/.test(scriptText)) {
    problems.push("入口判定不是 resolve(argv[1]) === resolve(fileURLToPath(import.meta.url)) 这个形态");
  }
  return problems;
}

/** NSIS 函数体：从 `Function 名字` 到自己那一行的 `FunctionEnd`。 */
function functionBody(code: string, name: string): string {
  const start = code.indexOf(`Function ${name}`);
  if (start < 0) throw new Error(`project.nsi 里找不到 Function ${name}`);
  const end = code.indexOf("FunctionEnd", start);
  return code.slice(start, end < 0 ? code.length : end);
}

/**
 * 「装完把程序打开」（轮141）的不变量。返回问题清单，方便变异对照在同一套判据上跑。
 *
 * 为什么值得钉住：程序没有单实例锁，主数据是 debounce 落盘的——两个实例共用同一份数据根时
 * 后写盖掉先写，症状是用户丢配置，而且要到下次升级才看得见。所以这条「打开」的出口必须同时
 * 守住三件事：只许一个出口、静默永不拉起、让过位之后先确认旧实例真的退了。
 */
function relaunchProblems(code: string): string[] {
  const problems: string[] = [];
  let guard: string;
  let launcher: string;
  let probe: string;
  try {
    guard = functionBody(code, "canRelaunch");
    launcher = functionBody(code, "csRelaunchApp");
    probe = functionBody(code, "confirmLaunched");
  } catch (err) {
    return [(err as Error).message + "：「装完打开程序」这条出口整个没了"];
  }

  // 静默保险必须是 launcher 的第一道判定：后面任何一步漏判，静默都不该走到 GUI。
  const firstIf = /\$\{If\}[^\n]*/.exec(launcher);
  if (!firstIf || !firstIf[0].startsWith("${If} ${Silent}")) {
    problems.push("csRelaunchApp 的第一道判定不是 ${If} ${Silent}：静默（CI 与脚本）可能把界面拉起来");
  }
  for (const needle of ["Call canRelaunch", '${If} $RelaunchSafe != "1"', '"$(CS_LAUNCH_BLOCKED_MSG)"', 'ExecShell "open" "$INSTDIR\\${PRODUCT_EXECUTABLE}"', "Call confirmLaunched"]) {
    if (!launcher.includes(needle)) problems.push(`csRelaunchApp 里缺 ${needle}`);
  }
  const shellAt = launcher.indexOf('ExecShell "open"');
  const blockedAt = launcher.indexOf("$(CS_LAUNCH_BLOCKED_MSG)");
  if (shellAt >= 0 && blockedAt >= 0 && blockedAt > shellAt) {
    problems.push("拦截解释排在拉起之后：用户先看见程序被打开，再被告知不许打开");
  }

  // canRelaunch 只回答「现在拉起会不会多出第二个实例」，三要素一条都不能少。
  if (!guard.includes('StrCpy $RelaunchSafe "1"')) problems.push("canRelaunch 没有默认放行的一支");
  if (!guard.includes('${If} $ParkOk != "1"')) {
    problems.push("canRelaunch 没读让位状态：没让过位（正位覆盖成功 = 旧镜像没人攥着）也要能被放行");
  } else if (!guard.includes('StrCpy $RelaunchSafe "0"')) {
    problems.push("canRelaunch 让过位之后没有先判为不安全");
  } else if (guard.indexOf('${If} $ParkOk != "1"') > guard.indexOf('StrCpy $RelaunchSafe "0"')) {
    problems.push("canRelaunch 的让位判定排在改写安全性之后");
  }
  if (!guard.includes('${If} $AppPid == ""')) {
    problems.push("canRelaunch 少了「人工双击没有 /PID」这一支：问不到就当旧实例还活着，宁可让用户自己点图标");
  }
  if (!guard.includes("Call appPidAlive")) problems.push("canRelaunch 没问 /PID 那个进程退了没有");
  if (!guard.includes("${If} $AppPidAlive = 0")) problems.push("canRelaunch 没有「旧进程已退 ⇒ 可以拉起」这一支");

  // 确认探针只借用 slotBusy 这只眼睛，问的是「新镜像有没有重新被锁住」。
  if (!probe.includes("Call slotBusy")) problems.push("confirmLaunched 没有回探正位镜像有没有重新被占用");
  for (const needle of ["StrCpy $R5 0", "IntOp $R5 $R5 + 1", "$R5 >= ${LAUNCH_PROBE_ROUNDS}", "Sleep ${LAUNCH_PROBE_INTERVAL}"]) {
    if (!probe.includes(needle)) problems.push(`confirmLaunched 缺 ${needle}：探针必须是有界的`);
  }
  if (/\$R[789]/.test(probe)) problems.push("confirmLaunched 碰了 $R7/$R8/$R9：那是 ensureSlotFree 数等待轮次的计数器");
  if (!code.includes("!define LAUNCH_PROBE_ROUNDS ") || !code.includes("!define LAUNCH_PROBE_INTERVAL ")) {
    problems.push("确认探针的轮次与间隔没有 !define：写死的数字漂了没人看得见");
  }

  // 升级收尾：/UPDATE 整页跳过 Finish，人工路径那个勾选框根本不会出现，所以这一段就是它的出口。
  const ins = installSection(code);
  for (const needle of ["Call canRelaunch", '${If} $RelaunchSafe == "1"', '"$(CS_LAUNCH_ASK)" /SD IDNO IDYES', "Call csRelaunchApp", "$(CS_PARK_RESTART)"]) {
    if (!ins.includes(needle)) problems.push(`安装 Section 的收尾缺 ${needle}`);
  }
  if (!ins.includes("$(CS_UPDATE_DONE)")) problems.push("让位没退那一支还得把「安装完成，请重新启动」说给用户");
  if (ins.includes("Call canRelaunch") && ins.includes("!insertmacro wails.files") && ins.indexOf("Call canRelaunch") < ins.indexOf("!insertmacro wails.files")) {
    problems.push("canRelaunch 排在覆盖文件之前：那一刻旧镜像多半还被攥着，判不出任何东西");
  }

  // 全脚本口径：拉起只许一处、只许 ExecShell，安全判定只许两条出口共用同一份。
  if (countOccurrences(code, /ExecShell/g) !== 1) problems.push("ExecShell 的数量不是 1：拉起出口必须只有一条");
  if (/\bExec\b/.test(code)) problems.push("出现了裸 Exec：B 组红线，且 $LOCALAPPDATA 完全可能带空格");
  if (countOccurrences(code, /Call canRelaunch/g) !== 2) problems.push("Call canRelaunch 不是恰好 2 次（人工出口 + 升级出口各一次）");
  if (countOccurrences(code, /Call csRelaunchApp/g) !== 1) problems.push("Call csRelaunchApp 不是恰好 1 次（勾选框经 MUI_FINISHPAGE_RUN_FUNCTION 进来）");
  if (countOccurrences(code, /Function csRelaunchApp/g) !== 1) problems.push("Function csRelaunchApp 定义不唯一");
  if (!code.includes("Var RelaunchSafe")) problems.push("Var RelaunchSafe 没了：canRelaunch 的出参没有落点");
  for (const key of [
    "CS_LAUNCH_ASK",
    "CS_LAUNCH_OK",
    "CS_LAUNCH_CONFIRMED",
    "CS_LAUNCH_UNCONFIRMED",
    "CS_LAUNCH_SKIP",
    "CS_LAUNCH_SILENT",
    "CS_LAUNCH_BLOCKED",
    "CS_LAUNCH_BLOCKED_MSG",
  ]) {
    if (countOccurrences(code, new RegExp(String.raw`LangString ${key} \$\{LANG_`, "g")) !== 2) problems.push(`${key} 必须中英各一条`);
  }
  for (const body of [guard, launcher, probe]) {
    if (/taskkill|Stop-Process|TerminateProcess|nsExec/i.test(body)) problems.push("拉起这条链上出现了终止进程或隐藏执行的形态");
  }
  return problems;
}

function countOccurrences(text: string, re: RegExp): number {
  return [...text.matchAll(re)].length;
}
