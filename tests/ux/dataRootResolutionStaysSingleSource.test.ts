/**
 * 数据根解析与换根迁移的唯一事实源守卫（轮62）。
 *
 * 缺陷长什么样：轮62 之前「数据根在哪」这句话被抄了至少三份——
 * portable_data.go 一份（env + exe 同级）、app_audit.go 的 auditDataDir 一份、
 * 安装器与 vbs 启动脚本又各写一遍。其中一份漏了安装态，deb/rpm 装完就永远
 * 读写不到主数据文件而静默降级；另一份漂了，审计就写到别的目录里去，用户出事时
 * 我们连日志都找不到。换根迁移更怕的是「写坏了直接把旧数据删了」，那没有任何回头路。
 *
 * 守卫钉五条：
 * 1. 解析规则只许住在 internal/portabledata：别处不得读 CONFSCOPE_DATA_DIR、
 *    不得手拼数据根内的相对布局（app-data / confscope-data.json / webview / ...）；
 * 2. 指针文件不得落在数据根里（否则换根时把「我在哪」这句话一起搬走，根就找不到根了）；
 * 3. 迁移必须「先复制并校验、后写指针」，且全程禁止 RemoveAll、禁止删旧根、禁止 move-first；
 * 4. 目标与源互相包含必须判非法（递归嵌套会把正在复制的目录吃进复制集）；
 * 5. 新增的原生绑定要同时在 wailsjs 出口与 retest 桥里落地，否则 retest 直接炸
 *    或者 dev 正常而真机 undefined。
 * 注释里的历史写法不算代码（统一走 stripComments），否则守卫会在解释自己的注释上自红。
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT, stripComments } from "./scanUtils";

const RESOLVER = "internal/portabledata/runtime_layout.go";
const MIGRATION = "internal/portabledata/data_root_migration.go";
const LEGACY_PORTABLE = "internal/portabledata/portable_data.go";
const AUDIT_BINDING = "internal/app/app_audit.go";
const BRIDGE_INSTALL = "tests/retest/bridge/installRetestBridge.ts";
const BRIDGE_BINDING = "tests/retest/bridge/retestBinding.ts";

/** 数据根内的相对布局字面量：只许 portabledata 包声明一次，别处一律用导出常量/函数。 */
const LAYOUT_LITERALS = [
  "ConfScopeData",
  "app-data",
  "confscope-data.json",
  "webview",
  "snapshots",
  "app-data-recovery-points",
  "logs",
];

/** 轮62 新增的换根绑定：wailsjs 出口、retest 桥的方法表与 case 必须三处齐全。 */
const DATA_ROOT_BINDINGS = [
  "GetRuntimeLayout",
  "SelectDataRootDirectory",
  "PlanDataRootMigration",
  "MigrateDataRoot",
  "CheckDataRootRollback",
  "RollbackDataRoot",
];

function read(rel: string): string {
  return stripComments(readFileSync(`${PROJECT_ROOT}/${rel}`, "utf8"));
}

function walkGo(dir: string, acc: string[]): string[] {
  for (const entry of readdirSync(`${PROJECT_ROOT}/${dir}`, { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      walkGo(rel, acc);
      continue;
    }
    if (!/\.go$/.test(entry.name) || /_test\.go$/.test(entry.name)) continue;
    acc.push(rel);
  }
  return acc;
}

/** portabledata 之外的 Go 代码里「又抄了一遍解析规则」的证据。 */
function resolutionDrift(text: string): string[] {
  const out: string[] = [];
  if (/os\.Getenv\(\s*"CONFSCOPE_DATA_DIR"\s*\)/.test(text) || /os\.Getenv\(\s*[A-Za-z_.]*DataDirEnvName\s*\)/.test(text)) {
    out.push("自己读 CONFSCOPE_DATA_DIR（只有 resolver 有资格读环境变量）");
  }
  if (/portabledata\.DataDirName/.test(text)) {
    out.push("在包外拿 DataDirName 拼数据根（等于再写一套解析规则）");
  }
  for (const match of text.matchAll(/filepath\.Join\(([^\n]*)\)/g)) {
    const args = match[1];
    const literal = LAYOUT_LITERALS.find((item) => args.includes(`"${item}"`));
    if (literal) out.push(`filepath.Join(..., "${literal}")：数据根内的布局字面量只能在 portabledata 出现`);
  }
  return out;
}

/** 指针文件被拼到数据根里 = 换根时「数据在哪」这句话跟着数据一起被搬走。 */
function pointerInsideDataRoot(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/filepath\.Join\(\s*([^,()]+)\s*,\s*[A-Za-z_.]*PointerFileName/g)) {
    if (!/pointerDir/i.test(match[1])) out.push(`指针拼在 ${match[1]} 下，必须来自 pointerDir`);
  }
  return out;
}

/** 取某个 Go 函数体的文本（从声明到下一个顶层 func，找不到就到文件尾）。 */
function goFuncBody(text: string, declaration: RegExp, label: string): string {
  const start = text.search(declaration);
  expect(start, `读不到${label}，守卫口径失效`).toBeGreaterThanOrEqual(0);
  const next = text.slice(start + 1).search(/^func /m);
  return next < 0 ? text.slice(start) : text.slice(start, start + 1 + next);
}

/** 迁移的不可逆动作清单：删目录、先 move 后写指针。 */
function irreversibleMigration(migrateBody: string): string[] {
  const out: string[] = [];
  if (/os\.RemoveAll\(/.test(migrateBody)) out.push("迁移里出现 os.RemoveAll（失败只回收本次自己拷的文件，绝不整目录删）");
  const verify = migrateBody.indexOf("verifyCopiedFiles(");
  const point = migrateBody.indexOf("SaveDataRootPointer(");
  if (point >= 0 && (verify < 0 || verify > point)) {
    out.push("写指针排在复制校验之前（move-first：校验没过就已经换根了）");
  }
  return out;
}

/** 回退只许改指针：一旦它开始搬文件或删文件，「退回去」就不再是安全动作。 */
function rollbackMustOnlyRepoint(rollbackBody: string): string[] {
  const out: string[] = [];
  if (/copyVerifiedFile\(|verifyCopiedFiles\(/.test(rollbackBody)) out.push("回退里出现复制动作（回退只改指针）");
  if (/os\.Remove\(|os\.RemoveAll\(/.test(rollbackBody)) out.push("回退里出现删除动作（两侧数据都不许动）");
  if (!/SaveDataRootPointer\(/.test(rollbackBody)) out.push("回退没有写指针，等于什么都没做");
  return out;
}

/** 换根绑定的三处落点：wailsjs 类型+导出、retest 方法表、retest case。缺一处报一条。 */
function bindingDrift(outlet: string, methodTable: string, cases: string): string[] {
  const out: string[] = [];
  for (const method of DATA_ROOT_BINDINGS) {
    if (!new RegExp(`\\b${method}\\(.*\\):\\s*Promise<`).test(outlet)) out.push(`App.ts 类型声明缺 ${method}`);
    if (!new RegExp(`export const ${method} = `).test(outlet)) out.push(`App.ts 导出的 const 缺 ${method}`);
    if (!methodTable.includes(`"${method}"`)) out.push(`retest WAILS_METHODS 缺 ${method}`);
    if (!cases.includes(`case "${method}"`)) out.push(`retest 桥 case 缺 ${method}`);
  }
  return out;
}

describe("数据根解析与换根迁移唯一事实源（轮62）", () => {
  const goFiles = walkGo("internal", []).filter((rel) => !rel.startsWith("internal/portabledata/"));

  it("真实代码：portabledata 之外没有第二套解析规则", () => {
    expect(goFiles.length, "扫描没抓到任何 internal Go 文件，守卫口径失效").toBeGreaterThan(0);
    const violations: string[] = [];
    for (const rel of goFiles) {
      for (const item of resolutionDrift(read(rel))) violations.push(`${rel}: ${item}`);
    }
    expect(violations).toEqual([]);
  });

  it("真实代码：审计目录走 resolver，不再自己拼", () => {
    const text = read(AUDIT_BINDING);
    expect(text).toContain("portabledata.DataRootFor(");
    expect(resolutionDrift(text)).toEqual([]);
  });

  it("真实代码：指针只落在 pointerDir，且随数据根一起搬的情况被挡死", () => {
    expect(pointerInsideDataRoot(read(RESOLVER))).toEqual([]);
    // 指针目录与 OS 数据目录撞车时另起一处（否则换根后指针会被当成数据搬走）
    expect(read(RESOLVER)).toContain("ConfScopeRuntime");
  });

  it("真实代码：迁移先复制校验后写指针，全程不删目录", () => {
    const migration = read(MIGRATION);
    expect(irreversibleMigration(goFuncBody(migration, /^func migrateDataRoot\(/m, "迁移函数"))).toEqual([]);
    expect(rollbackMustOnlyRepoint(goFuncBody(migration, /^func rollbackDataRoot\(/m, "回退函数"))).toEqual([]);
  });

  it("真实代码：源与目标互相包含双向判非法", () => {
    const body = goFuncBody(read(MIGRATION), /^func buildMigrationPlan\(/m, "迁移计划函数");
    expect(body).toContain("isAncestorDir(source, target)");
    expect(body).toContain("isAncestorDir(target, source)");
    // 安装形态不许把数据迁进安装目录（升级会被覆盖）
    expect(body).toContain("isAncestorDir(layout.ExeDir, target)");
  });

  it("真实代码：复制目录也带互相包含判据（老迁移路径同样不许嵌套）", () => {
    const body = goFuncBody(read(LEGACY_PORTABLE), /^func copyDirectoryExcluding\(/m, "目录复制函数");
    expect(body).toMatch(/isAncestorDir\(source, target\)\s*\|\|\s*isAncestorDir\(target, source\)/);
  });

  it("真实代码：换根绑定在 wailsjs 出口与 retest 桥三处齐全", () => {
    expect(bindingDrift(read("wailsjs/go/app/App.ts"), read(BRIDGE_INSTALL), read(BRIDGE_BINDING))).toEqual([]);
  });

  it("自检：审计目录退回自己抄一遍解析规则必须判红（就是本轮之前的形态）", () => {
    const drifted = [
      `dir := os.Getenv("CONFSCOPE_DATA_DIR")`,
      `if dir == "" { dir = filepath.Join(filepath.Dir(exe), "ConfScopeData") }`,
      `return filepath.Join(dir, "app-data")`,
    ].join("\n");
    expect(resolutionDrift(drifted).length).toBeGreaterThanOrEqual(3);
  });

  it("自检：resolver 之外拿 DataDirName 拼根也判红（常量对了照样是两套规则）", () => {
    expect(resolutionDrift('root := filepath.Join(exeDir, portabledata.DataDirName)').length).toBe(1);
  });

  it("自检：把指针写进数据根必须判红", () => {
    expect(pointerInsideDataRoot("p := filepath.Join(layout.DataRoot, PointerFileName)").length).toBe(1);
    expect(pointerInsideDataRoot("p := filepath.Join(pointerDir, PointerFileName)")).toEqual([]);
  });

  it("自检：move-first（先写指针再校验）必须判红", () => {
    const body = [
      "func migrateDataRoot(target string, ctx runtimeContext) error {",
      "\tSaveDataRootPointer(pointerPath, next)",
      "\tverifyCopiedFiles(source, target, files)",
      "}",
    ].join("\n");
    expect(irreversibleMigration(body).length).toBe(1);
  });

  it("自检：迁移里用 RemoveAll 清场必须判红", () => {
    const body = [
      "func migrateDataRoot(target string, ctx runtimeContext) error {",
      "\tverifyCopiedFiles(source, target, files)",
      "\tos.RemoveAll(source)",
      "\tSaveDataRootPointer(pointerPath, next)",
      "}",
    ].join("\n");
    const flags = irreversibleMigration(body);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatch(/os\.RemoveAll/);
  });

  it("自检：回退顺手搬文件/删文件必须判红", () => {
    const body = [
      "func rollbackDataRoot(ctx runtimeContext) error {",
      "\tcopyVerifiedFile(a, b, 1)",
      "\tos.RemoveAll(layout.DataRoot)",
      "\tSaveDataRootPointer(pointerPath, next)",
      "}",
    ].join("\n");
    expect(rollbackMustOnlyRepoint(body).length).toBe(2);
  });

  it("自检：桥里漏注册一个换根绑定必须判红（dev 正常、retest 或真机炸的形态）", () => {
    const outlet = read("wailsjs/go/app/App.ts");
    const methodTable = read(BRIDGE_INSTALL);
    const cases = read(BRIDGE_BINDING);
    expect(bindingDrift(outlet, methodTable, cases)).toEqual([]);
    expect(bindingDrift(outlet.replace("export const MigrateDataRoot = ", "export const MigrateDataRootRenamed = "), methodTable, cases)).toEqual([
      "App.ts 导出的 const 缺 MigrateDataRoot",
    ]);
    expect(bindingDrift(outlet, methodTable.replace('"MigrateDataRoot",', ""), cases)).toEqual(["retest WAILS_METHODS 缺 MigrateDataRoot"]);
    expect(bindingDrift(outlet, methodTable, cases.replace('case "MigrateDataRoot"', 'case "MigrateDataRootX"'))).toEqual([
      "retest 桥 case 缺 MigrateDataRoot",
    ]);
  });
});
