/**
 * 轮33 F-34：滚轮兜底的接线形状（静态守卫）。
 *
 * 机制本身由 src/lib/useWheelColumnResolver.test.tsx 钉（24 例），真页面行为由
 * ConfigBrowser.test.tsx / DiffView.test.tsx 用取证矩形钉。这里只钉「接线接在哪儿」——
 * 这两件事一旦退回 per-surface 补丁或退回节点快照，页面上不会报错，只会静默变回死区：
 *
 * 1) 登记要递 ref，不能递 `ref.current`：批量态左列、匹配态两列表、切文件后的正文都是
 *    「组件挂载 → effect 登记 → 节点之后才渲染出来」的形状，抄快照等于这条兜底永远不生效
 *    （轮33 组件守卫第一次跑就是这么抓出来的）。
 * 2) 页面根要选在 chrome 的公共祖先、且把 `.page-header` 留在外面（PRD 要求 3 的禁区）；
 *    选错根（例如整个 `.workspace`）会连侧栏与别的页一起接管，选太窄则 chrome 接不到。
 * 3) 消费方组件里不许再出现第二份 wheel 监听（React 的 onWheel 是 passive，preventDefault 无效）。
 */
import { describe, expect, it } from "vitest";
import { readScannedSource, sourceFiles } from "./scanUtils";

const CORE = "src/lib/wheelScroll.ts";
const RESOLVER = "src/lib/useWheelColumnResolver.ts";
const BROWSER = "src/components/ConfigBrowser.tsx";
const DIFF = "src/components/DiffView.tsx";
const PANEL = "src/components/DiffPanel.tsx";
const VIEW = "src/components/CodeView.tsx";
const EDITOR = "src/components/CodeEditor.tsx";
const MM = "src/components/CodeMinimap.tsx";

/** 抓某个文件里所有 `useWheelSurface(...)` 调用。 */
function surfaceCalls(src: string): string[] {
  return src.match(/useWheelSurface\(([^;]*)\)/g) ?? [];
}

/**
 * 登记点合格的形状：第一个实参是 ref 本身，且整个调用里不出现 `.current`。
 * 两条都要，少一条就拦不住「退回节点快照」——`bodyRef.current` 一样能匹配上 `\w+Ref\b`。
 */
function registersRefItself(call: string): boolean {
  return /useWheelSurface\(\s*\w+Ref\b/.test(call) && !/\.current\b/.test(call);
}

/**
 * 页头是否排在根开标签之前。
 * 静态源码次序只是代理判据（真行为由组件守卫按取证矩形钉）：DiffView 的 return 是
 * `.diff-view` > `.page-header` > `.diff-workspace`，页头在根之前 ⇒ 根罩不住页头；
 * 一旦根换成 `.diff-view`，次序翻成「根开标签在前、页头在后」，也就是页头落进根的子树。
 */
function headerPrecedesRoot(src: string, rootMarker: string): boolean {
  const header = src.indexOf('className="page-header diff-header"');
  const root = src.indexOf(rootMarker);
  expect(header, "读不到差异对比的页头").toBeGreaterThanOrEqual(0);
  expect(root, `读不到根：${rootMarker}`).toBeGreaterThanOrEqual(0);
  return root > header;
}

describe("滚动面登记递的是 ref（轮33 F-34 要求 1）", () => {
  const pages = [
    [BROWSER, 1],
    [DIFF, 3],
    [PANEL, 1],
    [VIEW, 1],
    [EDITOR, 1],
  ] as const;

  it("每个登记点都递 `xxxRef` 本身", () => {
    for (const [file, count] of pages) {
      const src = readScannedSource(file);
      const calls = surfaceCalls(src);
      expect(calls.length, `${file}：登记了几块滚动面？`).toBe(count);
      for (const call of calls) {
        expect(registersRefItself(call), `${file}：${call} 递的不是 ref 本身`).toBe(true);
      }
    }
  });

  it("自检：把登记退回节点快照必须判红", () => {
    const src = readScannedSource(PANEL);
    const regressed = src.replace("useWheelSurface(bodyRef);", "useWheelSurface(bodyRef.current);");
    expect(regressed, "变异没落到源码里，这条自检是空转").not.toBe(src);
    const call = surfaceCalls(regressed)[0];
    expect(registersRefItself(call), "退回快照还能过守卫，这条就是空转").toBe(false);
  });

  it("登记表按引用现取：resolve 只认事件当时的节点", () => {
    const core = readScannedSource(CORE);
    expect(core, "登记目标只剩一种写法了？那这份「现取」的不变式没人守").toMatch(/function resolveWheelSurfaceTarget/);
    expect(core, "查询时不现取节点，条件渲染的容器就永远进不了候选").toMatch(/resolveWheelSurfaceTarget\(reg\.target\)/);
    expect(core, "同一节点重复登记要以最后一次为准（不攒出多份同步回调）").toMatch(/byNode\.set\(/);
  });
});

describe("页面根选在 chrome 的公共祖先、把页头留在外面（轮33 F-34 要求 3）", () => {
  it("配置浏览挂在 .browser 上，.page-header 由 App 层持有、不在这棵子树里", () => {
    const src = readScannedSource(BROWSER);
    expect(src, "根必须落在 .browser：它的子树正好罩住 chrome 条与两列正文").toMatch(/className="browser" ref=\{browserRootRef\}/);
    expect(src, "解析器没接上").toMatch(/useWheelColumnResolver\(browserRootRef\)/);
    expect(src, "配置浏览自己不许渲染 .page-header（禁区）").not.toMatch(/className="page-header/);
  });

  it("差异对比挂在 .diff-workspace 上，页头在它前面、属于另一块", () => {
    const src = readScannedSource(DIFF);
    expect(src, "根必须落在 .diff-workspace：DiffView 自己的 return 里就有 .page-header").toMatch(
      /className="diff-workspace" ref=\{workspaceRef\}/
    );
    expect(src, "解析器没接上").toMatch(/useWheelColumnResolver\(workspaceRef\)/);
    expect(headerPrecedesRoot(src, 'className="diff-workspace" ref={workspaceRef}'), "页头必须在根之前、而不是根的子树里").toBe(true);
  });

  it("自检：根退回包含页头的 .diff-view 必须判红", () => {
    const src = readScannedSource(DIFF);
    const regressed = src
      .replace('className="diff-view"', 'className="diff-view" ref={workspaceRef}')
      .replace('className="diff-workspace" ref={workspaceRef}', 'className="diff-workspace"');
    expect(regressed, "变异没落到源码里，这条自检是空转").not.toBe(src);
    expect(regressed, "退回 .diff-view 之后页头就进了兜底作用域").not.toMatch(/className="diff-workspace" ref=\{workspaceRef\}/);
    // 变异样本里页头必须落进根的子树（次序反过来），否则这条判据证明不了什么；
    // 反过来主判据 headerPrecedesRoot 就会判红，加上上一行的根标记消失，这条兜底退回就拦得住。
    expect(
      headerPrecedesRoot(regressed, 'className="diff-view" ref={workspaceRef}'),
      "变异样本里页头必须在根之内（否则这条判据证明不了什么）"
    ).toBe(false);
  });
});

describe("旧的 per-surface 接线整体退场（轮33 F-34 要求 2）", () => {
  /**
   * 「上线即删」不是洁癖：两套并存时同一格滚轮会被处理两遍（双滚），而下一轮改兜底的人只会看见
   * 自己那套，旧那套永远留在原地。所以这里钉的是「旧形状全站为零」，而不只是「新形状存在」。
   */
  it("src 里再没有第二份实现，也没有人再递 reattachKey", () => {
    const files = sourceFiles();
    const hit = (needle: RegExp, skip?: string) => files.filter((f) => f !== skip).filter((f) => needle.test(readScannedSource(f)));

    expect(hit(/useWheelScrollsContainer/), "旧出口文件已经删了，谁把它引回来就是第二套并存").toEqual([]);
    // reattachKey 这个概念只在兜底解析器内部还活着（根元素本身也可能被重建）；消费方一律不许再递
    expect(hit(/reattachKey\s*:/, RESOLVER), "登记递的是引用，重挂依据这套东西已经退场").toEqual([]);
  });

  it("兜底根全站只有这四处：两个页面 + 两个代码视图", () => {
    const roots = sourceFiles()
      .filter((f) => f !== RESOLVER) // 解析器自己那份是定义，不是接线
      .map((f) => ({ f, n: (readScannedSource(f).match(/useWheelColumnResolver\(/g) || []).length }))
      .filter((x) => x.n > 0);
    expect(roots.map((x) => `${x.f}:${x.n}`).sort(), "挂根的位置要多一处，得先说清它的子树里有没有可滚容器、弹框在不在里面").toEqual(
      [`${BROWSER}:1`, `${DIFF}:1`, `${EDITOR}:1`, `${VIEW}:1`].sort()
    );
    // 代码视图挂自己那棵的根：历史版本 / 变更计划 / 应用计划这三个宿主没有页面级根，
    // 靠页面级接线的话，删掉旧监听就等于让它们退回死区（静默回归，页面上不会报错）。
    expect(readScannedSource(VIEW), "浏览态的根要落在 .code-view：正文与三块浮层的公共祖先").toMatch(
      /useWheelColumnResolver\(rootRef,\s*\{\s*localPriority:\s*true\s*\}\)/
    );
    expect(readScannedSource(EDITOR), "编辑态的根要落在 .code-editor：同上").toMatch(
      /useWheelColumnResolver\(rootRef,\s*\{\s*localPriority:\s*true\s*\}\)/
    );
    // 页面级根保持默认（不开 localPriority）：.browser / .diff-workspace 的子树里全是别人的滚动区，
    // 一开就会越过闸门去滚自己登记的正文，等于把「谁的外层面板」抢过来。
    expect(readScannedSource(BROWSER), "配置浏览的页面根不许开 localPriority").not.toMatch(/localPriority/);
    expect(readScannedSource(DIFF), "差异对比的页面根不许开 localPriority").not.toMatch(/localPriority/);
  });

  it("localPriority 只许组件级根用：全站就这两个文件", () => {
    const hits = sourceFiles()
      .filter((f) => f !== RESOLVER)
      .filter((f) => /localPriority/.test(readScannedSource(f)));
    expect(hits.sort(), "再加一处 localPriority 就得先说清：这块浮层是不是真的为那篇正文存在、宿主可滚容器是不是它自己包的").toEqual(
      [EDITOR, VIEW].sort()
    );
  });
});

describe("消费方不许再自建第二份 wheel 监听（轮33 F-34 要求 2）", () => {
  for (const file of [MM, VIEW, EDITOR, BROWSER, DIFF, PANEL] as const) {
    it(`${file}：既没有 JSX 的 onWheel，也没有自己的 addEventListener("wheel")`, () => {
      const src = readScannedSource(file);
      expect(src, "React 18 的 wheel 是 passive 委托，preventDefault 实测无效").not.toMatch(/onWheel=\{/);
      expect(src, "换算与夹界只许住在 wheelScroll.ts：抄第二份就是下一轮 bug 的出处").not.toMatch(/addEventListener\("wheel"/);
      expect(src, "deltaMode 换算只许有一份").not.toMatch(/deltaMode/);
    });
  }

  it("黑名单按 DOM 子树判定，弹框/下拉/消息流三族都要在里面", () => {
    const resolver = readScannedSource(RESOLVER);
    const deny = /export const WHEEL_DENY_SELECTOR = "([^"]+)";/.exec(resolver);
    expect(deny, "读不到黑名单常量").not.toBeNull();
    for (const sel of [".modal-overlay", ".sel-menu", ".message-list"]) {
      expect(deny![1], `兜底把 ${sel} 放出去了：这些子树的滚动语义会被改写`).toContain(sel);
    }
    expect(resolver, "闸门（祖先链有可滚容器就不接）不见了，兜底会抢走原生滚动").toMatch(/if \(hasScrollableAncestor\(/);
    expect(resolver, "已经被消费的事件要让路，否则同一格滚两遍").toMatch(/if \(event\.defaultPrevented\) return;/);
    // 黑名单豁免不能只看「包住 root」：.message-list / .sel-menu 自己就是滚动区，
    // 只有 fixed 定位那种 overflow:visible 的遮罩层（.modal-overlay）才算「只是包裹」。
    expect(resolver, "豁免少了第二道边界：宿主子树里真正可滚的容器（消息流、下拉）会被组件级根抢走").toMatch(
      /denyHit\.contains\(root\) && !isVerticallyScrollable\(denyHit\)/
    );
    expect(resolver, "闸门只能被 localPriority 绕过，别把它写成无条件").toMatch(
      /if \(hasScrollableAncestor\(landing\) && !localPriority\) return;/
    );
  });

  it("自检：把闸门删掉必须判红", () => {
    const resolver = readScannedSource(RESOLVER);
    const regressed = resolver.replace("      if (hasScrollableAncestor(landing) && !localPriority) return;\n", "");
    expect(regressed, "变异没落到源码里，这条自检是空转").not.toBe(resolver);
    expect(/if \(hasScrollableAncestor\(/.test(regressed), "闸门没了还判绿，这条守卫是空转").toBe(false);
  });
});
