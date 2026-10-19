/**
 * 查找快捷键（Ctrl+F / ⌘F / F3）的「这次按键归不归我」只许有一份判定（轮39 R39-3 / R39-5）。
 *
 * 缺陷长什么样（真机取证见 `.trellis/tasks/10-19-ui-ux-39-find-key-ownership/prd.md`）：
 * 浏览态 CodeView 与编辑态 CodeEditor 各写了一遍所有权判定，两份口径已经分叉——
 * CodeView 认「焦点在不在本视图内 / 是不是 body」，CodeEditor 额外用
 * `document.querySelector(".code-view")` 猜「浏览态会不会抢」。猜的那份把被保活隐藏
 * （`active=false`，监听都没挂）的视图也算成会抢，于是两边都不接管：
 * 在左侧列表点一条配置（焦点停在不可编辑的 `.browser-item`）后按 Ctrl+F 是**死键**，
 * 而这恰好是用户最自然的手顺。
 *
 * 这不是「条件少写了一支行一下就好」的缺陷：一处放宽、一处不放宽，就是轮4/轮30
 * 反复出现的「修了浏览态忘了编辑态」那个分叉的第三次复发。所以守卫钉四件事：
 * 1. 判定本体只存在于 src/lib/findKeyOwnership.ts，两个视图只递参数；
 * 2. 旧的两份判据字面（`=== document.body`、`.code-view` 存在性猜测、`isContentEditable`、
 *    `takesThisView`）在视图里不许复活；
 * 3. 注册表属性 `data-find-key-owner` 与 keydown 监听**同生同灭**：挂在同一个 effect 里，
 *    且必须在 `if (!enableFind || !active) return` 之后——先打标记再退出，等于把
 *    「隐藏的视图会抢」这条假信息重新写回 DOM，就是本轮的根因；
 * 4. 全站只有这两个视图劫持 Ctrl+F/F3，别处再加第三份所有权判定会被第一条判红。
 */
import { describe, expect, it } from "vitest";
import { readScannedSource, sourceFiles } from "./scanUtils";

const LIB = "src/lib/findKeyOwnership.ts";
const CODE_VIEW = "src/components/CodeView.tsx";
const CODE_EDITOR = "src/components/CodeEditor.tsx";
const VIEWS = [CODE_VIEW, CODE_EDITOR];
const ATTR = "FIND_KEY_OWNER_ATTR";

/** 视图里唯一合法的接管形状：把事件源和本视图根交给共享判定，自己不再算条件。 */
const TAKE_CALL = /takesFindKeyOwnership\(\{\s*target: e\.target,\s*root:\s*[^\n]*rootRef\.current\s*\}\)/;

/** 已被本轮拆掉的旧判据。名字按两份旧实现里的原样钉，复活即分叉。 */
const LEGACY_TESTS: Array<[string, RegExp]> = [
  ["「焦点是不是 body」这套手搓判据（现在归 lib 的第 4 支）", /===\s*document\.(body|documentElement)/],
  ["用 .code-view 类名猜浏览态会不会抢（保活隐藏后类名仍在 DOM）", /querySelector(?:All)?\(\s*["']\.code-view/],
  ["自己读 isContentEditable（可编辑判定现在归 lib 的 holdsTextCaret）", /isContentEditable/],
  ["takesThisView（CodeView 那份旧函数的名字）", /takesThisView/],
  ["自己读焦点（焦点判定现在归 lib，视图不许再取 activeElement）", /document\.activeElement/],
];

/** Ctrl+F / F3 的劫持点，用来数「全站有几处在管这个快捷键」。 */
const FIND_KEY_TEST = /key === "f" \|\| key === "F"/;

/**
 * 按括号配对截出 `useEffect(...)` 整块（含依赖数组）。
 *
 * 不用 `[\s\S]*?\n\s*\}, \[` 那种惰性匹配：effect 里嵌了 return 的清理函数，
 * 惰性收口会停在第一个 `}, [` 上，拿到的半块能让「同生同灭」这条断言假绿。
 */
function effectBlocks(src: string): string[] {
  const out: string[] = [];
  const re = /\buseEffect\(/g;
  let m = re.exec(src);
  while (m) {
    const start = m.index;
    let i = start + m[0].length - 1;
    let depth = 0;
    for (; i < src.length; i += 1) {
      const ch = src[i];
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push(src.slice(start, i + 1));
    re.lastIndex = i + 1;
    m = re.exec(src);
  }
  return out;
}

/** 视图里那个「挂着查找快捷键监听」的 effect。 */
function findKeyEffect(src: string): string {
  const block = effectBlocks(src).find((b) => b.includes("takesFindKeyOwnership("));
  expect(block, "找不到含 takesFindKeyOwnership 的 useEffect——接管点不再挂在监听里了").toBeTruthy();
  return block ?? "";
}

/** 按「谁引用了这个符号」统计站点（不含测试文件，sourceFiles 已排除 *.test.*）。 */
function referencingFiles(symbol: string): string[] {
  return sourceFiles().filter((file) => readScannedSource(file).includes(symbol));
}

describe("查找快捷键所有权单一出处（轮39 R39-3）", () => {
  it("判定本体在 lib 里只有一份，四个判据按顺序写着", () => {
    const lib = readScannedSource(LIB);
    expect(lib).toMatch(/export const FIND_KEY_OWNER_ATTR = "data-find-key-owner"/);
    expect(lib).toMatch(/export function holdsTextCaret\(/);
    expect(lib).toMatch(/export function findKeyOwners\(/);
    expect(lib).toMatch(/export function takesFindKeyOwnership\(/);
    // 四支判据的顺序即语义（①本视图 → ②文本光标让位 → ③别的视图让位 → ④文档序第一个接管）
    const order = [
      lib.indexOf("containsNode(root, target"),
      lib.indexOf("holdsTextCaret(active"),
      lib.indexOf("owners.some("),
      lib.indexOf("const first = owners[0]"),
    ];
    expect(order, "四支判据的顺序被动过，语义就变了").toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i >= 0)).toBe(true);
    // 「谁真的挂着监听」只能按注册表读，不许按类名猜
    expect(lib).toMatch(/querySelectorAll\(`\[\$\{FIND_KEY_OWNER_ATTR\}\]`\)/);
    expect(lib).not.toMatch(/querySelector(?:All)?\(\s*["'`]\./);
  });

  it("两个视图都只递参数，旧判据不许复活", () => {
    for (const file of VIEWS) {
      const src = readScannedSource(file);
      expect(src, `${file} 没有引用 lib/findKeyOwnership`).toContain('from "../lib/findKeyOwnership"');
      expect(src, `${file} 的接管点不是共享判定`).toMatch(TAKE_CALL);
      for (const [why, re] of LEGACY_TESTS) {
        expect(re.test(src), `${file} 复活了${why}`).toBe(false);
      }
    }
    // 引用站点必须是「lib 定义 + 两个视图使用」，多出第三处 = 又写了一份所有权
    expect(referencingFiles("takesFindKeyOwnership"), "接管判定的站点变了").toEqual([...VIEWS, LIB].sort());
  });

  it("注册表与监听同生同灭：同一个 effect 里打标记、在 active 短路之后、卸载时摘掉", () => {
    for (const file of VIEWS) {
      const block = findKeyEffect(readScannedSource(file));
      expect(block, `${file} 没在监听所在的 effect 里注册所有权`).toContain(`setAttribute(${ATTR}`);
      expect(block, `${file} 卸载时不摘标记，兄弟视图会一直以为它还会抢`).toContain(`removeAttribute(${ATTR}`);
      expect(block).toMatch(/window\.addEventListener\("keydown", handler, true\)/);
      expect(block).toMatch(/window\.removeEventListener\("keydown", handler, true\)/);
      // 顺序：`if (!enableFind || !active) return;` 必须先于打标记
      const guard = block.search(/if \(!enableFind \|\| !active\) return/);
      const mark = block.indexOf(`setAttribute(${ATTR}`);
      expect(guard, `${file} 的 active 短路不见了，保活隐藏的视图也会认领 Ctrl+F`).toBeGreaterThan(-1);
      expect(mark).toBeGreaterThan(-1);
      expect(mark, `${file} 在 active 短路之前就打了标记——隐藏的视图又被算进注册表`).toBeGreaterThan(guard);
      // 摘标记必须在 removeEventListener 之前或同块，缺一半就是泄漏
      expect(block.indexOf(`removeAttribute(${ATTR}`)).toBeLessThan(block.length);
    }
  });

  it("所有权标记只由这两个视图读写，别处不许再插一套", () => {
    const users = referencingFiles(ATTR).sort();
    expect(users, "注册表属性的读写站点变了").toEqual([...VIEWS, LIB].sort());
    // 属性名字面量也只许出现在 lib（视图经符号引用，抄字符串就是第二份口径）
    expect(sourceFiles().filter((file) => file !== LIB && readScannedSource(file).includes('"data-find-key-owner"'))).toEqual([]);
  });

  it("全站只有这两个视图劫持 Ctrl+F/F3，别处再加一份所有权判定就判红", () => {
    const hijackers = sourceFiles()
      .filter((file) => file !== LIB)
      .filter((file) => FIND_KEY_TEST.test(readScannedSource(file)));
    expect(hijackers, "出现了第三处查找快捷键劫持点").toEqual([...VIEWS].sort());
  });

  it("组合态（IME）先让位：两条监听都在所有权判定之前挡掉输入法候选", () => {
    for (const file of VIEWS) {
      const block = findKeyEffect(readScannedSource(file));
      const ime = block.search(/if \(isImeComposing\(e\)\) return/);
      const take = block.indexOf("takesFindKeyOwnership(");
      expect(ime, `${file} 不再先挡输入法组合态`).toBeGreaterThan(-1);
      expect(take).toBeGreaterThan(-1);
      expect(ime, `${file} 的所有权判定跑在 IME 之前了`).toBeLessThan(take);
    }
  });
});

describe("守卫自身不空转：三种退回必须判红", () => {
  it("自检一：视图退回自己算焦点（读 activeElement）必须判红", () => {
    const view = readScannedSource(CODE_VIEW);
    const block = findKeyEffect(view);
    expect(block).toContain("takesFindKeyOwnership(");
    const regressed = block.replace(
      "if (!takesFindKeyOwnership({ target: e.target, root: rootRef.current })) return;",
      "const focused = document.activeElement;\n      if (!focused || focused === document.body) return;"
    );
    expect(regressed, "变异没落到接管点上，这条自检是空转").not.toBe(block);
    expect(LEGACY_TESTS.some(([, re]) => re.test(regressed))).toBe(true);
  });

  it("自检二：把 .code-view 存在性猜测加回来必须判红", () => {
    const block = findKeyEffect(readScannedSource(CODE_EDITOR));
    const regressed = block.replace(
      "if (!takesFindKeyOwnership({ target: e.target, root: rootRef.current })) return;",
      'if (document.querySelector(".code-view")) return;\n      if (!takesFindKeyOwnership({ target: e.target, root: rootRef.current })) return;'
    );
    expect(regressed, "变异没落到接管点上，这条自检是空转").not.toBe(block);
    const legacy = LEGACY_TESTS.find(([, re]) => re.test(regressed));
    expect(legacy, "旧判据字面没被任何一条正则抓到").toBeTruthy();
  });

  it("自检三：只打标记不摘、或标记打在 active 短路之前，都必须判红", () => {
    const block = findKeyEffect(readScannedSource(CODE_VIEW));
    const leaked = block.replace(`root?.removeAttribute(${ATTR});`, "root?.classList.add(codeViewClass);");
    expect(leaked, "变异没落到摘标记那行").not.toBe(block);
    expect(leaked).not.toContain(`removeAttribute(${ATTR}`);
    const early = block
      .replace(`root?.setAttribute(${ATTR}, "1");`, "")
      .replace("if (!enableFind || !active) return;", `root?.setAttribute(${ATTR}, "1");\n    if (!enableFind || !active) return;`);
    expect(early, "变异没落到打标记那行").not.toBe(block);
    expect(early.indexOf(`setAttribute(${ATTR}`)).toBeLessThan(early.search(/if \(!enableFind \|\| !active\) return/));
  });
});
