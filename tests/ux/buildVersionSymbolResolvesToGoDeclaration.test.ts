/**
 * 构建期注入的版本号符号必须真的打中 Go 声明（轮51）。
 *
 * 缺陷长什么样（证据链见 `.trellis/tasks/10-20-build-version-drift/prd.md`）：
 * 77fa451 把 appVersion 从 package main 迁到 confscope/internal/app，
 * 而 `.github/workflows/release.yml` 的注入指令仍写 `-X main.appVersion=${VERSION}`。
 * Go 链接器对不存在的 -X 目标**静默忽略**（实测 `-X nope.nope.NotThere=1` 也是 exit 0 零警告），
 * 于是 v1.9.1 起发布产物里 appVersion 恒为 "dev"；`parseVersion("dev")` 又把它解析成 0.0.0，
 * 结果「检查更新」永远显示有新版本、关于页显示 vdev。
 * 本地 `scripts/build-latest.{sh,ps1}` 压根不带 -ldflags，开发机永远 dev，
 * 把 CI 的注入失效伪装成开发版的正常表现，所以 45 天没人怀疑。
 *
 * 守卫钉五条：
 * 1. release.yml 必须存在指向 appVersion 的 -X 注入（漏注入直接红）；
 * 2. 每个 -X 目标都要用 go.mod 的 module 名解析成真实目录，并在该目录的非测试 .go 里
 *    存在同名包级 var —— 这是唯一能替代「链接器不报错」的检查；
 * 3. 本地构建脚本同样必须注入，且版本取自 git describe（防止「只有 CI 是对的」）；
 * 4. 版本事实源是 tag：CI 从 GITHUB_REF_NAME 推导，脚本里不许写死版本号；
 * 5. 被注入的那个 Go 变量必须是 string 且默认 "dev"（类型错了链接器照样静默）。
 * YAML/shell 注释里引用的历史写法不算代码（先剥注释再抽符号），否则守卫会在解释自己的注释上自红。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT, stripComments } from "./scanUtils";

const RELEASE_WORKFLOW = ".github/workflows/release.yml";
const SH_BUILDER = "scripts/build-latest.sh";
const PS1_BUILDER = "scripts/build-latest.ps1";
const BUILD_ENTRYPOINTS = [RELEASE_WORKFLOW, SH_BUILDER, PS1_BUILDER];
const GO_VERSION_VAR = "internal/app/app.go";

type XSymbol = {
  file: string;
  importPath: string;
  ident: string;
  raw: string;
  line: number;
};

/** YAML 与 shell/pwsh 的行注释都是 # 起头，stripComments 只认 //，先按行摘掉。 */
function stripHashComments(raw: string): string {
  return raw
    .split("\n")
    .map((line) => (/^\s*#/.test(line) ? "" : line.replace(/\s+#\s+\S.*$/, "")))
    .join("\n");
}

function readBuildEntrypoint(rel: string): string {
  const raw = readFileSync(join(PROJECT_ROOT, rel), "utf8");
  if (/\.(yml|yaml|sh|bash|ps1)$/.test(rel)) {
    return stripComments(stripHashComments(raw));
  }
  return stripComments(raw);
}

/** 抽出 `-X <importPath>.<Ident>=` 形态的链接器注入目标。 */
function ldflagsSymbols(rel: string): XSymbol[] {
  const text = readBuildEntrypoint(rel);
  const out: XSymbol[] = [];
  for (const match of text.matchAll(/-X\s+([^\s"']+?)\.([A-Za-z_]\w*)\s*=/g)) {
    out.push({
      file: rel,
      importPath: match[1],
      ident: match[2],
      raw: match[0],
      line: text.slice(0, match.index).split("\n").length,
    });
  }
  return out;
}

function goModule(): string {
  const text = readFileSync(join(PROJECT_ROOT, "go.mod"), "utf8");
  const match = /^module\s+(\S+)\s*$/m.exec(text);
  if (!match) throw new Error("go.mod 里读不到 module 名");
  return match[1];
}

/** module 路径 → 仓库内目录；main（或裸 module 名）就是仓库根。 */
function packageDir(importPath: string, module: string): string | null {
  if (importPath === "main" || importPath === module) return ".";
  if (importPath.startsWith(`${module}/`)) return importPath.slice(module.length + 1);
  return null;
}

function declaresPackageVar(text: string, ident: string): boolean {
  const single = new RegExp(`^var\\s+${ident}(?:\\s+[\\w*[.]+)?(?:\\s*=|\\s*$)`, "m");
  if (single.test(text)) return true;
  // var ( ... ) 块里的裸声明
  const block = new RegExp(`^\\s+${ident}(?:\\s+[\\w*[.]+)?(?:\\s*=|\\s*$)`, "m");
  return /(^|\n)\s*var\s*\(/.test(text) && block.test(text);
}

function goFiles(dir: string): string[] {
  const abs = join(PROJECT_ROOT, dir === "." ? "" : dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs).filter((name) => name.endsWith(".go") && !name.endsWith("_test.go"));
}

/** 校验 -X 目标是否真能落进某个包级 var；返回问题清单。 */
function unresolvedSymbols(symbols: XSymbol[], module: string): string[] {
  const out: string[] = [];
  for (const sym of symbols) {
    const dir = packageDir(sym.importPath, module);
    if (dir === null) {
      out.push(`${sym.file}:${sym.line} 「${sym.raw}」的包路径 ${sym.importPath} 不在 module ${module} 之下`);
      continue;
    }
    const files = goFiles(dir);
    if (files.length === 0) {
      out.push(`${sym.file}:${sym.line} 目录 ${dir} 里没有非测试 .go 文件，链接器会静默忽略这个 -X`);
      continue;
    }
    const hit = files.some((name) =>
      declaresPackageVar(stripComments(readFileSync(join(PROJECT_ROOT, dir === "." ? name : `${dir}/${name}`), "utf8")), sym.ident)
    );
    if (!hit) {
      const where = dir === "." ? "仓库根包（package main）" : `${dir} 包`;
      out.push(`${sym.file}:${sym.line} ${where} 里没有包级 var ${sym.ident}（写成 ${sym.importPath}.${sym.ident}，链接器只会静默忽略）`);
    }
  }
  return out;
}

function versionSymbols(symbols: XSymbol[]): XSymbol[] {
  return symbols.filter((sym) => sym.ident === "appVersion");
}

describe("构建期版本注入符号必须打中 Go 声明（轮51）", () => {
  const module = goModule();
  const all = BUILD_ENTRYPOINTS.flatMap((file) => ldflagsSymbols(file));

  it("module 名就是 confscope（换 module 名会先在这里红）", () => {
    expect(module).toBe("confscope");
  });

  it("真实文件：所有 -X 注入目标都能在 Go 源码里打中包级 var", () => {
    expect(all.length, "一个 -X 注入都没抽到，守卫口径失效").toBeGreaterThan(0);
    expect(unresolvedSymbols(all, module)).toEqual([]);
  });

  it("release.yml 确实注入版本号（漏注入 = 线上永远是 dev）", () => {
    expect(versionSymbols(ldflagsSymbols(RELEASE_WORKFLOW)).length, `${RELEASE_WORKFLOW} 没有注入 appVersion`).toBe(1);
  });

  it("本地构建脚本也必须注入，且版本来自 git describe（防止只有 CI 是对的）", () => {
    for (const file of [SH_BUILDER, PS1_BUILDER]) {
      expect(versionSymbols(ldflagsSymbols(file)).length, `${file} 没注入 appVersion`).toBeGreaterThanOrEqual(1);
      expect(readBuildEntrypoint(file), `${file} 的版本号没走 git describe`).toMatch(/git\s+describe/);
    }
  });

  it("CI 版本事实源是 tag，脚本里不许写死版本号", () => {
    expect(readBuildEntrypoint(RELEASE_WORKFLOW)).toMatch(/VERSION="\$\{GITHUB_REF_NAME#v\}"/);
    for (const file of BUILD_ENTRYPOINTS) {
      const text = readBuildEntrypoint(file);
      expect(text, `${file} 里出现了写死的三段式版本号`).not.toMatch(/appVersion=\s*["']?\d+\.\d+\.\d+/);
    }
  });

  it("被注入的 Go 变量是 string 且默认 dev（类型错了链接器照样静默）", () => {
    const text = stripComments(readFileSync(join(PROJECT_ROOT, GO_VERSION_VAR), "utf8"));
    expect(/var\s+appVersion\s*=\s*"dev"/.test(text), `${GO_VERSION_VAR} 的 appVersion 不再是字符串 "dev" 默认值`).toBe(true);
  });

  it("自检：把本轮线上那个 main.appVersion 原样抄回必须判红", () => {
    const symbols: XSymbol[] = [
      { file: RELEASE_WORKFLOW, importPath: "main", ident: "appVersion", raw: "-X main.appVersion=${VERSION}", line: 82 },
    ];
    expect(unresolvedSymbols(symbols, module).length).toBe(1);
  });

  it("自检：包路径拼错（目录都不存在）必须判红", () => {
    const symbols: XSymbol[] = [
      { file: SH_BUILDER, importPath: "confscope/internal/appz", ident: "appVersion", raw: "-X confscope/internal/appz.appVersion", line: 1 },
    ];
    expect(unresolvedSymbols(symbols, module).length).toBe(1);
  });

  it("自检：变量迁走了但注入没跟着改必须判红（重命名 App 包的场景）", () => {
    const symbols: XSymbol[] = [
      { file: RELEASE_WORKFLOW, importPath: "confscope/internal/app", ident: "appBuidVersion", raw: "-X confscope/internal/app.appBuidVersion=", line: 1 },
    ];
    expect(unresolvedSymbols(symbols, module).length).toBe(1);
  });

  it("自检：release.yml 漏掉 -X 注入必须判红", () => {
    expect(versionSymbols(ldflagsSymbols("tests/ux/fixtures/noVersionInject.yml")).length).toBe(0);
  });

  it("YAML 注释里的历史写法不判红（守卫不能在自己解释自己的注释上自红）", () => {
    const symbols = ldflagsSymbols("tests/ux/fixtures/versionOnlyInComment.yml");
    expect(symbols.map((sym) => `${sym.importPath}.${sym.ident}`)).toEqual(["confscope/internal/app.appVersion"]);
  });
});
