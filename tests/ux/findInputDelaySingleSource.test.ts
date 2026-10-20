/**
 * 查找词的输入延迟只许有一份策略（轮29 F-16，轮49 起第四个宿主也走这一份）。
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
 * 4. 轮49：量 DOM 那一派（DiffPanel / UnifiedDiff）的这套编排收进 src/lib/useFindLayer.ts，
 *    于是「谁调 hook」变成两件事——未迁移的两个代码视图自己调，迁移后的两个宿主只能经共享层调。
 *    宿主里再出现一次 useDebouncedFindTerm 就是第二套延迟口径（条子与正文会各说各话）。
 */
import { describe, expect, it } from "vitest";
import { readScannedSource, sourceFiles } from "./scanUtils";

const POLICY = "src/lib/findInput.ts";
const LAYER = "src/lib/useFindLayer.ts";
const CODE_VIEW = "src/components/CodeView.tsx";
const CODE_EDITOR = "src/components/CodeEditor.tsx";
const DIFF_PANEL = "src/components/DiffPanel.tsx";
const UNIFIED_DIFF = "src/components/UnifiedDiff.tsx";
/** 直接调 hook 的地方：两个未迁宿主 + 共享层。 */
const CALLERS = [CODE_VIEW, CODE_EDITOR, LAYER];
/** 经共享层拿命中词的两个宿主（轮49 迁完）。 */
const LAYER_HOSTS = [DIFF_PANEL, UNIFIED_DIFF];

/**
 * 调用形状：词来自查找栏，工作量决定要不要推迟。
 * 入参名按正文形状走：代码视图是总行数，量 DOM 那一派只有**渲染出来的**行参与命中扫描
 * （勾掉等行之后那份工作量确实小了），所以允许 `rows.length`。
 */
const HOOK_CALL = /useDebouncedFindTerm\(findTerm, (?:totalLines|rows\.length)\)/;
/** 命中层只认这一份 term；名字换了就是第二份口径的开头。未迁宿主与共享层各按自己的入参名。 */
const EFFECTIVE_TERM_HOST = /const effectiveTerm = findOpen \? committedFindTerm : [^\n]*searchTerm/;
const EFFECTIVE_TERM_LAYER = /const effectiveTerm = findOpen \? committedTerm : externalTerm;/;
/** 「先提交没落地的字符」那一步：宿主叫 findTermPending/flushFindTerm，共享层叫 isPending/flushTerm。 */
const COMMIT_FIRST = /if \((?:findTermPending|isPending)\) \{\s*(?:flushFindTerm|flushTerm)\(\);/;

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

  it("调 hook 的只有三处，且外部 searchTerm 一律留在即时那一侧", () => {
    for (const file of CALLERS) {
      const view = readScannedSource(file);
      expect(view, `${file} 没引用 lib/findInput`).toMatch(/from "(?:\.\.\/lib|\.)\/findInput"/);
      expect(view, `${file} 的 hook 调用形状变了`).toMatch(HOOK_CALL);
      expect(view, `${file} 自己写了一份延迟`).not.toMatch(/FIND_INPUT_DEBOUNCE_MS|findInputDelayFor/);
    }
    expect(referencingFiles("useDebouncedFindTerm"), "hook 的定义/调用站点变了").toEqual([...CALLERS, POLICY].sort());
    for (const file of [CODE_VIEW, CODE_EDITOR]) {
      expect(readScannedSource(file), `${file} 的命中层不再只认这一份 term`).toMatch(EFFECTIVE_TERM_HOST);
    }
    expect(readScannedSource(LAYER), `${LAYER} 的命中层不再只认这一份 term`).toMatch(EFFECTIVE_TERM_LAYER);
    // 迁移后的宿主不许绕过共享层
    for (const file of LAYER_HOSTS) {
      const src = readScannedSource(file);
      expect(src, `${file} 自己又调了一份 useDebouncedFindTerm（第二套延迟口径）`).not.toMatch(/useDebouncedFindTerm|from "\.\.\/lib\/findInput"/);
      expect(src, `${file} 没把外部搜索词交给共享层（关栏后标红会整片消失）`).toMatch(/externalTerm: [^\n]*,/);
    }
    // 轮55 C线：并排差异也有了外部词那条路径（批量对比左栏的跨项内容搜索传下来），
    // 口径与单列差异完全同一句话——没词就传空串，等于「栏一关没词」
    expect(readScannedSource(DIFF_PANEL), `${DIFF_PANEL} 的外部词来源变了`).toMatch(/externalTerm: searchTerm \?\? "",/);
    expect(readScannedSource(DIFF_PANEL), `${DIFF_PANEL} 的外部词入参声明没了（宿主传不进来）`).toMatch(/searchTerm\?: string;/);
    // 单列差异有外部词（浏览态「按内容搜索」传下来），而且必须是不经延迟的那一颗
    expect(readScannedSource(UNIFIED_DIFF), `${UNIFIED_DIFF} 的外部词来源变了`).toMatch(/externalTerm: searchTerm \?\? "",/);
  });

  it("Enter / 上下处按钮先提交没落地的字符，不许拿旧词的命中表跳格子", () => {
    for (const file of CALLERS) {
      const view = readScannedSource(file);
      const nav = view.slice(view.indexOf("const navigate = useCallback("));
      expect(nav, `${file} 的 navigate 里没有「先提交」这一步`).toMatch(COMMIT_FIRST);
    }
    // 宿主不许自带一份 navigate 状态机：步进编排只在共享层
    for (const file of LAYER_HOSTS) {
      const src = readScannedSource(file);
      expect(src, `${file} 自己写了一份 navigate（会绕开「先提交」）`).not.toMatch(/const navigate = useCallback\(/);
      expect(src, `${file} 没把共享层的 navigate 接给条子`).toMatch(/onNavigate=\{navigate\}/);
    }
  });
});

describe("守卫自身不空转：三种退回必须判红", () => {
  it("自检一：视图退回「直接读输入框的值」必须判红", () => {
    const view = readScannedSource(CODE_VIEW);
    expect(view).toMatch(EFFECTIVE_TERM_HOST);
    const regressed = view.replace(/const effectiveTerm = findOpen \? committedFindTerm/, "const effectiveTerm = findOpen ? findTerm");
    expect(regressed.includes("? findTerm :"), "变异没落到 effectiveTerm 上，这条自检是空转").toBe(true);
    expect(regressed).not.toMatch(EFFECTIVE_TERM_HOST);
  });

  it("自检二：hook 改成「永远读 committed」必须判红", () => {
    const policy = readScannedSource(POLICY);
    const honest = "term: delay > 0 ? committed : requested";
    expect(policy).toContain(honest);
    const regressed = policy.replace(honest, "term: committed");
    expect(regressed).not.toMatch(/term: delay > 0 \? committed : requested/);
  });

  it("自检三：navigate 去掉「先提交」必须判红", () => {
    const view = readScannedSource(CODE_VIEW);
    const nav = view.slice(view.indexOf("const navigate = useCallback("));
    expect(nav).toMatch(COMMIT_FIRST);
    const regressed = nav.replace(/if \(findTermPending\) \{\s*flushFindTerm\(\);\s*return;\s*\}/, "");
    expect(regressed.slice(0, 400)).not.toMatch(COMMIT_FIRST);
  });

  it("自检四：共享层里 effectiveTerm 改成只看栏内词必须判红（轮49）", () => {
    const layer = readScannedSource(LAYER);
    expect(layer).toMatch(EFFECTIVE_TERM_LAYER);
    const regressed = layer.replace("const effectiveTerm = findOpen ? committedTerm : externalTerm;", "const effectiveTerm = committedTerm;");
    expect(regressed !== layer, "变异没落到源码里，这条自检是空转").toBe(true);
    expect(regressed).not.toMatch(EFFECTIVE_TERM_LAYER);
  });
});
