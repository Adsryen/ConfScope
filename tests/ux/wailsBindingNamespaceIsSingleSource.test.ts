/**
 * Wails 原生绑定的命名空间只许有一处出处（轮50）。
 *
 * 缺陷长什么样（证据链见 `.trellis/tasks/10-20-data-binding-drift/prd.md`）：
 * 77fa451 把 App 从 package main 迁到 internal/app（package app），Wails 按包名注册，
 * 运行时命名空间随之从 `window.go.main.App` 变成 `window.go.app.App`。
 * 走 wailsjs 生成物的 `src/api/*` 编译期自动跟上，而 `src/lib/appDataDoc.ts` 里
 * 手写的那句 `g.go?.main?.App` 没人管：绑定取不到 ⇒ 主数据文件的水合、debounce 落盘、
 * 损坏隔离提示整体静默失效 45 天；同期 4 个 api 测试仍 stub 旧命名空间，红着被当基线吸收。
 *
 * 守卫钉四条：
 * 1. 命名空间的事实源是 Go 包名：`internal/app` 的 package 必须等于前端的 WAILS_APP_NAMESPACE；
 * 2. 产品代码（src 非测试）除出口外不许自己拼 `go.<ns>.App`——命名空间对了也不行，
 *    因为「对了」只是今天对了，下次改名还是只有生成物会跟着变；
 * 3. 打桩/安装侧（测试 stub、retest 与 smoke 的 bridge）允许出现命名空间字面量，
 *    但必须等于真值：本轮那 4 个 `main:` stub 就是靠这条判红的；
 * 4. 出口必须保留「取不到绑定返回 null」的显式降级，数据层必须经出口取绑定。
 * 注释里的历史写法不算代码（统一走 stripComments），否则守卫会在解释自己的注释上自红；
 * 运行时动态取键（`Object.keys(window.go)`）也不算，不许为了过关去改真机 smoke 的探测方式。
 */
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT, stripComments } from "./scanUtils";

const OUTLET = "src/lib/wailsAppBindings.ts";
const DATA_DOC = "src/lib/appDataDoc.ts";
const GUARD = "tests/ux/wailsBindingNamespaceIsSingleSource.test.ts";
/** 命名空间事实源：Go 侧 App 服务所在包。 */
const GO_APP_PACKAGE_FILE = "internal/app/app.go";

/** 出现命名空间字面量的各种写法（捕获组 1 = 被用的命名空间）。 */
const NAMESPACE_PATTERNS: RegExp[] = [
  /\bgo\s*\?\.\s*([A-Za-z_$][\w$]*)\s*\?\.\s*App\b/g,
  /\bgo\s*\?\.\s*([A-Za-z_$][\w$]*)\s*\.\s*App\b/g,
  /\bgo\s*\.\s*([A-Za-z_$][\w$]*)\s*\.\s*App\b/g,
  /\b\[\s*["']go["']\s*\]\s*\.\s*([A-Za-z_$][\w$]*)\s*\.\s*App\b/g,
  /\bstubGlobal\(\s*["']go["']\s*,\s*\{\s*([A-Za-z_$][\w$]*)\s*:/gs,
  /\bgo\s*=\s*\{\s*([A-Za-z_$][\w$]*)\s*:/gs,
  /\bgo\??\s*:\s*\{\s*([A-Za-z_$][\w$]*)\??\s*:/gs,
];

type Entry = { path: string; text: string };

function isProductFile(rel: string): boolean {
  return rel.startsWith("src/") && !/\.(test|spec)\.(ts|tsx)$/.test(rel);
}

function goAppPackageName(): string {
  const text = stripComments(readFileSync(`${PROJECT_ROOT}/${GO_APP_PACKAGE_FILE}`, "utf8"));
  const match = /^package\s+([A-Za-z_][\w]*)\s*$/m.exec(text);
  if (!match) throw new Error(`${GO_APP_PACKAGE_FILE} 里读不到 package 名`);
  return match[1];
}

function namespacesUsed(text: string): string[] {
  const found: string[] = [];
  for (const pattern of NAMESPACE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) found.push(match[1]);
    }
  }
  return found;
}

function outletNamespace(text: string): string | null {
  const match = /WAILS_APP_NAMESPACE\s*=\s*["']([A-Za-z_$][\w$]*)["']/.exec(text);
  return match ? match[1] : null;
}

function namespaceViolations(entries: Entry[], expected: string): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.path === OUTLET) {
      const literal = outletNamespace(entry.text);
      if (literal !== expected) {
        out.push(`${entry.path}: WAILS_APP_NAMESPACE=${literal}，Go 包名是 ${expected}`);
      }
      if (!/\?\?\s*null/.test(entry.text)) {
        out.push(`${entry.path}: 出口丢了「取不到绑定返回 null」的显式降级`);
      }
      continue;
    }
    const used = namespacesUsed(entry.text);
    if (used.length === 0) continue;
    if (isProductFile(entry.path)) {
      out.push(`${entry.path}: 产品代码自己拼了 go.${used[0]}.App，只许调用 ${OUTLET}`);
      continue;
    }
    for (const ns of new Set(used)) {
      if (ns !== expected) {
        out.push(`${entry.path}: 打桩/安装用的命名空间是 ${ns}，真值是 ${expected}`);
      }
    }
  }
  return out;
}

function walk(dir: string, acc: string[]): string[] {
  for (const entry of readdirSync(`${PROJECT_ROOT}/${dir}`, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      walk(rel, acc);
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry.name)) acc.push(rel);
  }
  return acc;
}

/** 扫描全仓 ts/tsx，只保留剥注释后真的摸过 `go` 全局的文件。 */
function bindingTouchingEntries(): Entry[] {
  const entries: Entry[] = [];
  for (const rel of [...walk("src", []), ...walk("tests", [])]) {
    if (rel === GUARD) continue;
    const stripped = stripComments(readFileSync(`${PROJECT_ROOT}/${rel}`, "utf8"));
    if (!/\bgo\b/.test(stripped)) continue;
    if (namespacesUsed(stripped).length === 0 && !/\bstubGlobal\(\s*["']go["']/.test(stripped)) continue;
    entries.push({ path: rel, text: stripped });
  }
  return entries;
}

describe("Wails 绑定命名空间唯一事实源（轮50）", () => {
  const expected = goAppPackageName();

  it("Go 侧 App 包名就是 app（再改包名会先在这里红）", () => {
    expect(expected).toBe("app");
  });

  it("真实代码：产品侧除出口外零自拼，打桩侧命名空间全部等于真值", () => {
    const entries = bindingTouchingEntries();
    expect(entries.length, "扫描没抓到任何摸绑定的文件，守卫口径失效").toBeGreaterThan(0);
    expect(namespaceViolations(entries, expected)).toEqual([]);
    // 出口与数据层本身
    const outlet = stripComments(readFileSync(`${PROJECT_ROOT}/${OUTLET}`, "utf8"));
    expect(outletNamespace(outlet)).toBe(expected);
    const dataDoc = stripComments(readFileSync(`${PROJECT_ROOT}/${DATA_DOC}`, "utf8"));
    expect(dataDoc).toContain("wailsAppBindings<");
    // 扫描确实覆盖到了打桩侧（否则第 3 条是空守）
    const stubSites = entries.filter((entry) => /stubGlobal\(\s*["']go["']/.test(entry.text));
    expect(stubSites.length, "扫描漏掉了测试 stub 站点").toBeGreaterThan(0);
  });

  it("注释里的历史写法不判红（守卫不能在自己解释自己的注释上自红）", () => {
    const entries: Entry[] = [
      { path: DATA_DOC, text: stripComments("// 曾自己写 g.go?.main?.App\nconst x = 1;\n") },
    ];
    expect(namespaceViolations(entries, expected)).toEqual([]);
  });

  it("动态取键的真机探测不判红（不许为了过关改 smoke 的探测方式）", () => {
    const entries: Entry[] = [
      { path: "tests/smoke/specs/x.spec.ts", text: "const keys = Object.keys(window.go);\n" },
    ];
    expect(namespaceViolations(entries, expected)).toEqual([]);
  });

  it("自检：把本轮的线上 bug 原样抄回数据层必须判红", () => {
    const entries: Entry[] = [{ path: DATA_DOC, text: "const app = g.go?.main?.App;\n" }];
    expect(namespaceViolations(entries, expected).length).toBe(1);
  });

  it("自检：产品代码把命名空间写对了也要判红（只是今天对了）", () => {
    const entries: Entry[] = [{ path: "src/lib/somewhere.ts", text: "const a = window.go.app.App;\n" }];
    expect(namespaceViolations(entries, expected).length).toBe(1);
  });

  it("自检：测试 stub 退回旧命名空间必须判红（本轮 4 个陈旧 mock 的形态）", () => {
    const entries: Entry[] = [
      { path: "src/api/app.test.ts", text: 'vi.stubGlobal("go", {\n  main: {\n    App: goApp,\n  },\n});\n' },
    ];
    expect(namespaceViolations(entries, expected).length).toBe(1);
  });

  it("自检：Go 包名与出口字面量分叉必须判红", () => {
    const entries: Entry[] = [
      { path: OUTLET, text: `export const WAILS_APP_NAMESPACE = "main";\nconst a = g.go?.[WAILS_APP_NAMESPACE]?.App ?? null;\n` },
    ];
    expect(namespaceViolations(entries, "app").length).toBe(1);
  });

  it("自检：出口丢掉 null 降级必须判红", () => {
    const entries: Entry[] = [
      { path: OUTLET, text: `export const WAILS_APP_NAMESPACE = "${expected}";\nreturn app;\n` },
    ];
    expect(namespaceViolations(entries, expected).length).toBe(1);
  });

  it("自检：把出口改成动态命名空间（不再钉死真值）必须判红", () => {
    const entries: Entry[] = [
      { path: OUTLET, text: "const a = g.go?.[someVar]?.App ?? null;\n" },
    ];
    expect(namespaceViolations(entries, expected).length).toBe(1);
  });

  it("自检：打桩侧写对命名空间不误红（守卫不是把所有 stub 一律判红）", () => {
    const entries: Entry[] = [
      { path: "src/api/app.test.ts", text: 'vi.stubGlobal("go", {\n  app: {\n    App: goApp,\n  },\n});\n' },
    ];
    expect(namespaceViolations(entries, expected)).toEqual([]);
  });
});
