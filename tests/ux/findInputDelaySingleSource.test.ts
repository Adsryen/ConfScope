/**
 * 查找词的输入延迟只许有一份策略（轮29 F-16）。
 *
 * 缺陷长什么样：查找输入框每敲一个字母都要重算命中、重标记整篇、再把整段正文交回浏览器解析。
 * 实测每键成本 2 000 行 26ms / 5 000 行 67ms / 20 000 行 177ms / 200 000 行 ≈1 800ms，
 * 输入一个六字母的词在 10MB 配置里要卡 10.8 秒（`.trellis/tasks/10-18-ui-ux-29-find-input-cost/research/bench_f16_keystroke_cost.log`）。
 *
 * 修法是一个 hook，但它有两个方向的失败模式，所以钉形状：
 * 1. 阈值/延迟若在视图里各写一份，两个视图会对「什么时候开始等」给出不同答案（编辑态与浏览态必须同口径）；
 * 2. 延迟若被写成「永远等 200ms」，小文件里的「输入即所见」就没了——那是查找的基本体感。
 *    因此 hook 里 `delay <= 0` 必须**直接透传**、不建定时器。
 * 3. 推迟的只能是「查找栏自己输入的词」。外部内容搜索词（searchTerm）必须留在即时那一侧：
 *    它是左侧列表跨文件搜索的结果，命中数要与列表同一帧一致（configContentSearch.test.ts 钉的跨模块不变式）。
 */
import { describe, expect, it } from "vitest";
import { readScannedSource, sourceFiles } from "./scanUtils";

const POLICY = "src/lib/findInput.ts";
const VIEWS = ["src/components/CodeView.tsx", "src/components/CodeEditor.tsx"];

/** 视图里引 hook 的唯一合法形状：词来自查找栏，行数决定要不要推迟。 */
const HOOK_CALL = /useDebouncedFindTerm\(findTerm, totalLines\)/;
/** 命中层只认这一份 term；名字换了就是第二份口径的开头。 */
const EFFECTIVE_TERM = /const effectiveTerm = findOpen \? committedFindTerm : [^\n]*searchTerm/;

/** 按「谁引用了这个符号」统计站点，含定义所在文件。 */
function referencingFiles(symbol: string): string[] {
  return sourceFiles().filter((file) => readScannedSource(file).includes(symbol));
}

describe("查找词输入延迟单一来源（轮29 F-16）", () => {
  it("阈值与延迟在 lib 里各只有一份，视图不许自己算", () => {
    const policy = readScannedSource(POLICY);
    expect(policy).toMatch(/export const FIND_INPUT_DEFER_MIN_LINES = \d+/);
    expect(policy).toMatch(/export const FIND_INPUT_DEBOUNCE_MS = \d+/);
    expect(policy).toMatch(/export function findInputDelayFor\(totalLines: number\): number/);
    // 策略的引用站点只许是归属地自己：视图一律经 hook 拿延迟
    expect(referencingFiles("findInputDelayFor("), "阈值判断被抄到了第二处").toEqual([POLICY]);
  });

  it("延迟为 0 时直接透传：小文档不许等定时器", () => {
    const policy = readScannedSource(POLICY);
    expect(policy, "delay <= 0 那条分支不见了，小文档也要开始排队").toMatch(/if \(delay <= 0\) \{/);
    expect(policy, "透传被改成读 committed：输入即所见没了").toMatch(/term: delay > 0 \? committed : requested/);
    expect(policy, "pending 判定不再看延迟：小文档会一直显示没落定").toMatch(/isPending: delay > 0 && committed !== requested/);
    // 卸载/换词都要收定时器
    expect(policy).toMatch(/clearTimeout\(timerRef\.current\)/);
  });

  it("两个视图都走同一份 hook，且 searchTerm 留在即时那一侧", () => {
    for (const file of VIEWS) {
      const view = readScannedSource(file);
      expect(view, `${file} 没引用 lib/findInput`).toMatch(/from "\.\.\/lib\/findInput"/);
      expect(view, `${file} 的 hook 调用形状变了`).toMatch(HOOK_CALL);
      expect(view, `${file} 的命中层不再只认这一份 term`).toMatch(EFFECTIVE_TERM);
      expect(view, `${file} 自己写了一份延迟`).not.toMatch(/FIND_INPUT_DEBOUNCE_MS|findInputDelayFor/);
    }
    expect(referencingFiles("useDebouncedFindTerm"), "hook 的定义/调用站点变了").toEqual([...VIEWS, POLICY].sort());
  });

  it("Enter / 上下处按钮先提交没落地的字符，不许拿旧词的命中表跳格子", () => {
    for (const file of VIEWS) {
      const view = readScannedSource(file);
      const nav = view.slice(view.indexOf("const navigate = useCallback("));
      expect(nav, `${file} 的 navigate 里没有「先提交」这一步`).toMatch(/if \(findTermPending\) \{\s*flushFindTerm\(\);/);
    }
  });
});

describe("守卫自身不空转：三种退回必须判红", () => {
  it("自检一：视图退回「直接读输入框的值」必须判红", () => {
    const view = readScannedSource(VIEWS[0]);
    expect(view).toMatch(EFFECTIVE_TERM);
    const regressed = view.replace(/const effectiveTerm = findOpen \? committedFindTerm/, "const effectiveTerm = findOpen ? findTerm");
    expect(regressed.includes("? findTerm :"), "变异没落到 effectiveTerm 上，这条自检是空转").toBe(true);
    expect(regressed).not.toMatch(EFFECTIVE_TERM);
  });

  it("自检二：hook 改成「永远读 committed」必须判红", () => {
    const policy = readScannedSource(POLICY);
    const honest = "term: delay > 0 ? committed : requested";
    expect(policy).toContain(honest);
    const regressed = policy.replace(honest, "term: committed");
    expect(regressed).not.toMatch(/term: delay > 0 \? committed : requested/);
  });

  it("自检三：navigate 去掉「先提交」必须判红", () => {
    const view = readScannedSource(VIEWS[0]);
    const nav = view.slice(view.indexOf("const navigate = useCallback("));
    expect(nav).toMatch(/if \(findTermPending\) \{\s*flushFindTerm\(\);/);
    const regressed = nav.replace(/if \(findTermPending\) \{\s*flushFindTerm\(\);\s*return;\s*\}/, "");
    expect(regressed.slice(0, 400)).not.toMatch(/if \(findTermPending\) \{\s*flushFindTerm\(\);/);
  });
});
