/**
 * Windows 安装包脚本（build/windows/installer/project.nsi）的六组不变量，轮62 起钉在这里。
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
 *
 * NSIS 的注释有整行 #、整行 ; 和行尾 # 三种，解释历史的注释不算行为（project.nsi 头部
 * 就写着「默认 admin」），所以先剥注释再抽判据，否则守卫会在自己解释自己的注释上自红。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT, stripComments } from "./scanUtils";

const NSI = "build/windows/installer/project.nsi";
const TOOLS = "build/windows/installer/wails_tools.nsh";
const HANDOFF_GO = "internal/updatecheck/handoff.go";
const ARTIFACT_GO = "internal/updatecheck/artifact.go";
const APP_GO = "internal/app/app.go";
const WORKFLOW = ".github/workflows/release.yml";
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

  it("有界等待 + 超时放弃：宁可这一版不覆盖，也不硬抢运行中的 exe", () => {
    const code = nsisCode(NSI);
    expect(code).toMatch(/System::Call 'kernel32::OpenProcess\(i 0x1000/);
    expect(code).toMatch(/FileOpen \$2 "\$INSTDIR\\\$\{PRODUCT_EXECUTABLE\}" a/);
    expect(code).toMatch(/Sleep \$\{WAIT_INTERVAL\}/);
    expect(code).toMatch(/\$\{If\} \$R9 >= \$\{WAIT_TICKS\}/);
    expect(code).toMatch(/SetErrorLevel 75/);
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

function countOccurrences(text: string, re: RegExp): number {
  return [...text.matchAll(re)].length;
}
