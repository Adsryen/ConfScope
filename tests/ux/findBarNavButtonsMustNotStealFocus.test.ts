/**
 * 查找栏的按钮必须逐个决定「要不要抢焦点」，而不是整条栏一刀切（轮32 F-29）。
 *
 * 缺陷长什么样：轮22 那批只给匹配口径开关（`Aa` / `ab|`）加了 `onMouseDown preventDefault`，
 * ↑↓ 两个跳转按钮没加。用户在查找栏里选好了词，点一下 ↓ 想跳下一处——焦点当场跑到按钮上，
 * 再敲字符既不进输入框也不进正文。Chromium 真机取证（任务目录 research/focus_probe.txt）：
 *   nav-btn  next {"active":"next","inputSel":[0,7]}
 *   nav-btn  prev {"active":"prev","inputSel":[0,7]}
 *   toggle   tog  {"active":"inp","inputSel":[0,7]}      ← 对照组：带 preventDefault 的开关
 *   点 next 后敲 99 => { inp: 'timeout', ta: 'hello world' }   ← 两个字符哪儿都没去
 * 编辑态（CodeEditor）后果更重：焦点离开 textarea 后选区一起消失、Ctrl+S 不再被编辑区接管。
 *
 * ✕ 是**故意**相反的：它的语义是「我刚结束查找，把焦点还给正文」，onClick 里显式 focus
 * （CodeView 归还 .code-area 的键盘层，CodeEditor 归还 textarea，轮31 R62）。给它加 preventDefault
 * 等于让焦点掉回 body——所以这条守卫同时钉住「该挡的挡了」和「不该挡的没被顺手挡」。
 *
 * 轮48：条子抽成 src/components/FindBar.tsx 一份实现，浏览态 / 编辑态 / 并排差异三个宿主共用，
 * 于是「两个视图各守一遍」换成两条：只有一份可守（第一、三、四条），以及三个宿主各自
 * 把焦点还回自己那一层（第二条）。少了后者，条子里的 ✕ 就成了不知道在关谁的栏。
 * 轮49：量 DOM 那一派（DiffPanel / UnifiedDiff）的 closeFind 收进 src/lib/useFindLayer.ts，
 * 于是「还焦点那句」的可守站点变成 CodeView / CodeEditor / 共享层三处——宿主侧改守
 * 「关栏出口只有一个名字接给条子」（onClose={closeFind}），不再各抄一份 focus 调用。
 */
import { describe, expect, it } from "vitest";
import { readScannedSource } from "./scanUtils";

const BAR = "src/components/FindBar.tsx";
const CANCEL = "onMouseDown={(e) => e.preventDefault()}";

/** 把每个 `<button …>…</button>` 切出来；按 aria-label 归组，不依赖属性的书写顺序。 */
function buttonBlocks(source: string): Record<string, string> {
  const acc: Record<string, string> = {};
  for (const chunk of source.split(/(?=<button)/).slice(1)) {
    const end = chunk.indexOf("</button>");
    if (end < 0) continue;
    const block = chunk.slice(0, end);
    const label = /aria-label=\{t\("config\.(find\w+)"\)\}/.exec(block)?.[1];
    if (label) acc[label] = block;
  }
  return acc;
}

describe("查找栏按钮的焦点策略（轮32 F-29）", () => {
  it("↑↓ 与两个口径开关都挡住 mousedown，✕ 明确不挡", () => {
    for (const file of [BAR]) {
      const blocks = buttonBlocks(readScannedSource(file));
      for (const label of ["findCaseSensitive", "findWholeWord", "findPrev", "findNext"]) {
        expect(blocks[label], `${file} 找不到 ${label} 按钮（改文案或改 aria-label 前先想清楚下游）`).toBeTruthy();
        expect(blocks[label], `${file} 的 ${label} 会把焦点从查找输入框 / textarea 上抢走`).toContain(CANCEL);
      }
      expect(blocks.findClose, `${file} 的 ✕ 找不到`).toBeTruthy();
      expect(blocks.findClose, `${file} 的 ✕ 挡住了 mousedown：closeFind 里那句 focus 就永远不会被触发`).not.toContain(CANCEL);
      // 条子只认 onClose 这一个出口名；具体还给哪一层由宿主实现（第二条逐个宿主校验）
      expect(blocks.findClose, `${file} 的 ✕ 不再是「关栏并归还焦点」那条出口`).toContain("onClick={onClose}");
    }
  });

  it("✕ 归还焦点那句还在（这才允许它不挡 mousedown）", () => {
    const view = readScannedSource("src/components/CodeView.tsx");
    const editor = readScannedSource("src/components/CodeEditor.tsx");
    expect(view, "CodeView 的 closeFind 不再把焦点还给 .code-area：方向键 / PageUp / PageDown 当场失效").toMatch(
      /areaRef\.current\?\.focus\(\{ preventScroll: true \}\);/
    );
    expect(editor, "CodeEditor 的 closeFind 不再把焦点还给 textarea：用户得重新点一下才能打字").toMatch(/taRef\.current\?\.focus\(\);/);
    // 轮48/49：量 DOM 那一派（`.diff-body` / `.udiff`）共用共享层那一句归还——都是 tabIndex=0 +
    // role="region" 的正文层，少这一句就是同一个 R62（关栏后方向键 / PageUp 一动不动）。
    const layer = readScannedSource("src/lib/useFindLayer.ts");
    expect(layer, "共享层的 closeFind 不再把焦点还给正文层：两个差异宿主一起退回「焦点掉回 body」").toMatch(
      /bodyRef\.current\?\.focus\(\{ preventScroll: true \}\);/
    );
    // 宿主侧不许再抄一份：抄了就出现「换内容重置也移焦」这类语义混用（R62 口径）
    for (const host of ["src/components/DiffPanel.tsx", "src/components/UnifiedDiff.tsx"]) {
      expect(readScannedSource(host), `${host} 自己写了一份归还焦点（关栏出口不再只有一个）`).not.toMatch(/bodyRef\.current\?\.focus\(/);
      expect(readScannedSource(host), `${host} 的 ✕ 没接关栏出口：焦点归还不成立`).toContain("onClose={closeFind}");
    }
  });

  it("整条查找栏里取消 mousedown 的只有那四个，没有第五个", () => {
    for (const file of [BAR]) {
      const source = readScannedSource(file);
      const findBar = /<div className="code-find"[\s\S]*?<\/div>\s*\)/.exec(source);
      expect(findBar, `${file} 读不到查找栏的 JSX`).not.toBeNull();
      expect(
        findBar![0].split(CANCEL).length - 1,
        `${file} 查找栏里挡住 mousedown 的按钮数量变了：4 个（两个开关 + ↑↓），✕ 必须留在外面`
      ).toBe(4);
    }
  });

  it("守卫自身不空转：这个形状在条子里真的存在", () => {
    for (const file of [BAR]) {
      const source = readScannedSource(file);
      const blocks = buttonBlocks(source);
      expect(Object.keys(blocks).sort(), `${file} 查找栏的按钮集合读出来的不是四个`).toEqual([
        "findCaseSensitive",
        "findClose",
        "findNext",
        "findPrev",
        "findWholeWord",
      ]);
      // 锚点必须是代码而不是注释：readScannedSource 剥注释，注释里写多少遍都不算
      expect(source).not.toMatch(/preventDefault[\s\S]{0,40}抢焦点/);
    }
  });
});
