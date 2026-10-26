/**
 * Windows 安装包脚本（build/windows/installer/project.nsi）的七组不变量，轮62 起钉在这里。
 *
 * 为什么要这么写：本机没有 Windows，wails build -nsis 出来的安装程序没法真跑；
 * CI 的 preflight 只能证明这脚本「编译得过」。而编译得过不等于行为对——下面每一条
 * 都是「漂了不会有人立刻发现」的形态：
 *
 *  A. 安装/卸载程序不能毁掉用户数据。wails 默认模板里那行 RMDir /r "$AppData\..."
 *     删的正是数据根迁移认得的旧 webview 数据源目录之一；整体 RMDir /r $INSTDIR 会把
 *     放在程序目录里的 ConfScopeData 连锅端。症状是用户丢数据，且要到下次升级才看得见。
 *  B. 安装程序必须「等」而不是「杀」。主数据是 debounce 落盘的，强杀等于吃掉最后一次写入。
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

function read(rel: string): string {
  return readFileSync(join(PROJECT_ROOT, rel), "utf8");
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

describe("B. 覆盖二进制之前必须确认旧进程已退出，且绝不强杀", () => {
  it("没有任何强杀/隐藏 helper 的形态", () => {
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
    for (const key of ["CS_WAIT_FILE", "CS_WAIT_NOPID", "CS_WAIT_PID_ALIVE", "CS_WAIT_PID_GONE", "CS_WAIT_PROGRESS", "CS_WAIT_SECONDS", "CS_WAIT_GIVEUP_LONG"]) {
      expect(countOccurrences(code, new RegExp(String.raw`LangString ${key} \$\{LANG_`, "g")), `${key} 必须中英各一条`).toBe(2);
    }
    expect(code).toMatch(/SetErrorLevel 75/);
    expect(countOccurrences(code, /Abort/g), "放弃覆盖必须真的中止 Section").toBeGreaterThanOrEqual(3);
    expect(countOccurrences(code, /Call ensureSlotFree/g), "单点闸门：判据只许出现在安装 Section 开头一次").toBe(1);
    const ins = installSection(code);
    expect(ins.indexOf("Call ensureSlotFree"), "ensureSlotFree 必须在 wails.files 覆盖之前").toBeLessThan(ins.indexOf("!insertmacro wails.files"));
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

    const wf = yamlCode(read(WORKFLOW));
    expect(wf).toContain("check-windows-installer-handoff.ps1");
    expect(wf, "CI 必须真的看到成功标记，看不到就报错（空气闸门教训）").toMatch(/HANDOFF-CI ok scenarios=4/);
    const build = stepChunk(wf, "Build application") || wf;
    expect(build.indexOf("Run Windows installer handoff check"), "交接实测必须在上传安装包产物之前").toBeLessThan(
      build.indexOf("Upload artifact (Windows installer)"),
    );
  });
});

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

function countOccurrences(text: string, re: RegExp): number {
  return [...text.matchAll(re)].length;
}
