/**
 * 轮44：保活范围（配置对比页）与真机残留清扫的接线形状（静态守卫）。
 *
 * 机制本身另有两处钉：`src/lib/keepAlive.test.tsx`（挂载一次的语义）、
 * `src/components/DiffView.test.tsx` 的「保活可见性闸门」用例（active=false 不取数）。
 * 这里只钉「接线会不会在后续重构里被悄悄拆掉」——这四件事坏了页面都不报错，只静默退化：
 *
 * 1) 保活容器要么经 `useMountOnceVisible`，要么是浏览页那种「首屏必然挂载」的既有条件；
 *    容器的 `hidden` 档位必须和传给页内组件的 `active` 档位同源，否则改错一个字符串
 *    就是「藏着但还在取数」。挂载闸门与 hidden 各写一半，正是轮43 探针挖出的那两个洞。
 * 2) DiffView 的取数闸门必须是「隐藏期记账、切回合并补做」，且 `active` 不得进取数依赖：
 *    少闸门 = 常驻挂载退化成后台轮询；把 `active` 塞进依赖 = 每绕一趟浏览页把两侧候选
 *    重新打一遍（DK-01 实测 4 次请求）；只 return 不记账 = 隐藏期连接被编辑过就再没人补
 *    这一取，切回来挂的是上一个连接的候选。补做 effect 只依赖 active，两笔 reload 一起补。
 * 3) 清扫判据只有 `retest-` 前缀、只看 dataId、三组合齐、失败不判红（播种数据 `svc-*` 永不命中）。
 * 4) 清扫 fixture 必须 worker 作用域 + auto，且起跑/收工各扫一次。
 *
 * 每条都配一次「把接线改回坏形状」的自检变异（沿用 wheelFallbackWiring 的口径），
 * 否则守卫只是在原地空转。
 */
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT, readScannedSource } from "./scanUtils";

/** 递归收集目录下的 ts/tsx（跳过隐藏目录与临时产物）。 */
function collectTsFiles(dir: string): string[] {
  const acc: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      acc.push(...collectTsFiles(abs));
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry.name)) acc.push(relative(PROJECT_ROOT, abs).split("\\").join("/"));
  }
  return acc.sort();
}

const APP = "src/App.tsx";
const KEEPALIVE = "src/lib/keepAlive.ts";
const DIFF = "src/components/DiffView.tsx";
const STRAYS = "tests/retest/strays.ts";
const RETEST_TEST = "tests/retest/specs/retestTest.ts";
/** 清扫的永久回归用例所在文件：它是 fixture 之外唯一允许直连 strays 的地方（把清扫当被测对象）。 */
const SWEEP_SPEC = "tests/retest/specs/99-s-diff-keepalive.spec.ts";

/**
 * tests/retest 下引用 strays 的文件（除 allow 白名单）。
 * helper 化是为了让自检能拿「少一个白名单」再跑一遍——判据不真的跑一遍，
 * 守卫就只是原地空转（真机第一轮 DK-05 之前没人管 spec 侧的清扫调用，正是这个洞）。
 */
function straysImporters(allow: Set<string>): string[] {
  const offenders: string[] = [];
  for (const rel of collectTsFiles(join(PROJECT_ROOT, "tests/retest"))) {
    if (allow.has(rel)) continue;
    if (readScannedSource(rel).includes("/strays")) offenders.push(rel);
  }
  return offenders;
}

/** 允许「无条件常驻挂载」的保活容器：浏览页是落地页，首屏本来就要挂它。 */
const ALWAYS_MOUNTED = ["browse-cache"];

interface CacheBlock {
  cls: string;
  gate: string;
  hiddenMode: string;
}

/**
 * 抓 App 里所有保活容器：`{connections.length > 0 [&& 挂载闸门] && (<div className="x-cache" hidden={mode !== "…"}>`。
 * gate 取 `&&` 与开标签之间的那一段（注释已被 stripComments 摊成空白，所以只做长度限制）。
 */
function cacheBlocks(src: string): CacheBlock[] {
  const re = /\{\s*connections\.length > 0\s*&&([\s\S]{0,200}?)<div className="([a-z-]+-cache)"\s+hidden=\{mode !== "([^"]+)"\}/g;
  return Array.from(src.matchAll(re), (m) => ({ cls: m[2], gate: m[1].replace(/\s+/g, " ").trim(), hiddenMode: m[3] }));
}

/** 从 App 里拿到「由 useMountOnceVisible 派生出来的挂载变量名」。 */
function mountVars(src: string): { name: string; visibleArg: string }[] {
  return Array.from(src.matchAll(/const (\w+) = useMountOnceVisible\(([^)]*)\)/g), (m) => ({ name: m[1], visibleArg: m[2].trim() }));
}

interface FetchEffect {
  fn: string;
  /** 闸门读的是 ref（activeRef.current），不是 props 上的同名变量 */
  gatedByRef: boolean;
  /** 隐藏期有没有记账 */
  recordsPending: boolean;
  depHasActive: boolean;
  deps: string[];
}

/** 抓含取数调用的 effect：返回函数名、闸门形态、有没有记账、依赖里有没有 active。 */
function fetchEffects(src: string): FetchEffect[] {
  const re = /useEffect\(\(\) => \{([\s\S]*?)\}, \[([^\]]*)\]\);/g;
  const out: FetchEffect[] = [];
  for (const m of src.matchAll(re)) {
    const body = m[1];
    const fn = ["listNamespaces(", "listAllConfigs(", "listConfigs(", "getConfig("].find((name) => body.includes(name));
    if (!fn) continue;
    const deps = m[2].split(",").map((d) => d.trim()).filter(Boolean);
    out.push({
      fn,
      // 钉的是 activeRef.current：换成 `!activeProject` 这类同名变量不算闸门（见末尾自检）
      gatedByRef: /!activeRef\.current\s*\)/.test(body),
      recordsPending: /pendingFetchRef\.current = true;/.test(body),
      depHasActive: deps.includes("active"),
      deps,
    });
  }
  return out;
}

/** 抓「切回可见时合并补做」的那个 effect：整块文本（含依赖数组），找不到返回 undefined。 */
function catchUpEffect(src: string): string | undefined {
  return src
    .match(/useEffect\(\(\) => \{([\s\S]*?)\}, \[([^\]]*)\]\);/g)
    ?.find((block) => block.includes("pendingFetchRef.current = false;"));
}

describe("保活容器都经挂载闸门（轮44 D3）", () => {
  it("每个 *-cache 要么走 useMountOnceVisible，要么在常驻白名单里", () => {
    const src = readScannedSource(APP);
    const blocks = cacheBlocks(src);
    // 档位清单：新增保活页时必须同时来这张守卫登记，别让「顺手加一个 cache 容器」绕过闸门
    expect(blocks.map((b) => b.cls).sort()).toEqual(["browse-cache", "diff-apply-cache"]);
    const vars = mountVars(src);
    for (const block of blocks) {
      if (ALWAYS_MOUNTED.includes(block.cls)) {
        expect(block.gate, `${block.cls} 是首屏常驻页，不该出现第二份挂载判断`).toBe("(");
        continue;
      }
      const mounted = vars.find((v) => new RegExp(`^${v.name}\\s*&&\\s*\\(`).test(block.gate));
      expect(mounted, `${block.cls} 的挂载条件没走 useMountOnceVisible：gate="${block.gate}"`).toBeTruthy();
    }
  });

  it("hidden 档位与页内 active 档位同源", () => {
    const src = readScannedSource(APP);
    for (const block of cacheBlocks(src)) {
      expect(src, `缺少与 hidden={mode !== "${block.hiddenMode}"} 同源的 active 闸门`).toContain(`active={mode === "${block.hiddenMode}"}`);
    }
    // 两处 active 各自属于 browsePage / diffPage，不许出现第三种档位写法
    expect(Array.from(src.matchAll(/active=\{mode === "([^"]+)"\}/g), (m) => m[1]).sort()).toEqual(["browse", "diff"]);
  });

  it("对比页的挂载范围含「apply 的回程目标是 diff」，且 focusStep 只在可见时递", () => {
    const src = readScannedSource(APP);
    const visible = src.match(/const diffVisible = ([^;]+);/);
    expect(visible, "读不到 diffVisible 的定义").toBeTruthy();
    expect(visible![1]).toContain('mode === "diff"');
    expect(visible![1]).toContain("applyReturnTarget");
    // 回程聚焦：只有 diff 确实是回程目标时才递 focusStep（否则递给看不见的子树去抢焦点）
    expect(src).toContain('if (applyReturnTarget === "diff") setDiffFocusStep(focusStep ?? null);');
    // 旧的三态路由（靠类名猜归属）必须彻底拆掉，不许回退
    expect(src).not.toContain("diffApplyRoute");
    expect(src).not.toContain("diff-apply-route");
  });

  it("自检：把挂载闸门退回「常驻挂载」或「切走即卸载」都必须判红", () => {
    const src = readScannedSource(APP);
    // 退回常驻挂载（轮43 探针实测切回一次打 8 次请求的那条路）
    const alwaysMounted = src.replace("{connections.length > 0 && diffMounted && (", "{connections.length > 0 && (");
    expect(alwaysMounted, "变异没落到源码里，这条自检是空转").not.toBe(src);
    expect(cacheBlocks(alwaysMounted).find((b) => b.cls === "diff-apply-cache")?.gate).toBe("(");
    expect(ALWAYS_MOUNTED.includes("diff-apply-cache")).toBe(false);

    // 退回切走即卸载：hidden 条件被改成 mode === "diff" &&，容器只在可见时存在
    const unmount = src.replace('<div className="diff-apply-cache" hidden={mode !== "diff"}>', '<div className="diff-apply-cache" hidden={mode !== "apply"}>');
    expect(unmount, "变异没落到源码里，这条自检是空转").not.toBe(src);
    const hidden = unmount.match(/<div className="diff-apply-cache"\s+hidden=\{([^}]*)\}/)?.[1] ?? "";
    expect(hidden).not.toBe('mode !== "diff"');
    // 与之配对的 active 档位随之错位 → 「藏着但还在取数」
    expect(unmount).not.toContain('active={mode !== "apply"}');
  });
});

/**
 * 保活层的 `[hidden]` 兜底（轮44 R1 的样式侧）。
 *
 * 为什么 CSS 也要单独钉：容器基块写的是 `display:flex`，和 UA 给 `[hidden]` 的 `display:none`
 * 只差一档属性选择器——不带 `!important` 就是跟文档顺序赌。兜底一断，`hidden` 只等于
 * 「视觉上看不见」而不等于「不在布局里、不可命中、不可点」：轮43 的 T-PG-02 就是被隐藏
 * 子树里那个同名按钮吃掉，白烧 480s，而 JS 侧的接线守卫当时全是绿的。
 * 这类断裂在浏览器里不报错，只能靠静态守卫把「每个保活容器都配兜底」钉成一条规则。
 */
describe("保活层的 [hidden] 兜底（轮44 R1：看不见必须同时不在布局里）", () => {
  const CSS = readScannedSource("src/styles.css");

  /** 规则块摊平成 { sel（已压空白）, body }。注释已被剥成空白，不会误命中。 */
  function cssRules(css: string): Array<{ sel: string; body: string }> {
    return Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g), (m) => ({
      sel: m[1]
        .slice(m[1].lastIndexOf("}") + 1)
        .replace(/\s+/g, " ")
        .trim(),
      body: m[2],
    }));
  }

  /** 某个保活容器的 `[hidden]` 兜底块；没有则 undefined——判据要能区分「没有」和「被削弱」。 */
  function hiddenRule(css: string, cls: string): { sel: string; body: string } | undefined {
    return cssRules(css).find((rule) =>
      rule.sel
        .split(",")
        .map((part) => part.trim())
        .includes(`.${cls}[hidden]`)
    );
  }

  /** App 里真正渲染出来的保活容器类名——档位清单从 JSX 反推，不在这儿抄第二份。 */
  function cacheClasses(): string[] {
    const src = readScannedSource(APP);
    return Array.from(new Set(Array.from(src.matchAll(/className="([a-z-]+-cache)"/g), (m) => m[1]))).sort();
  }

  /** 逐容器核对兜底，返回不达标的具体说明。主用例和自检变异共用同一个判据，免得自检空转。 */
  function violations(css: string): string[] {
    const out: string[] = [];
    cacheClasses().forEach((cls) => {
      const guard = hiddenRule(css, cls);
      if (!guard) {
        out.push(`.${cls}[hidden] 兜底缺失：hidden 会被基块的 display:flex 顶掉`);
        return;
      }
      if (!/display:\s*none\s*!important/.test(guard.body.replace(/\s+/g, " "))) {
        out.push(`.${cls}[hidden] 的兜底没带 !important，等于跟文档顺序赌`);
      }
      const base = cssRules(css).find((rule) => rule.sel === `.${cls}`);
      if (!base) out.push(`styles.css 里找不到 .${cls} 基块：容器结构改过就要重新核对兜底是否仍必要`);
      else if (!/display:\s*flex/.test(base.body)) out.push(`.${cls} 基块不再声明 display，兜底的对手变了`);
    });
    return out;
  }

  it("每个 *-cache 都配了 .X[hidden]{display:none !important}，且基块确实声明了 display", () => {
    // 与「保活容器都经挂载闸门」那张档位清单同源：少一个或多一个，两边要一起改
    expect(cacheClasses()).toEqual(["browse-cache", "diff-apply-cache"]);
    expect(violations(CSS), "保活层的兜底不成套（这类断裂浏览器不报错，只静默退化）").toEqual([]);
  });

  it("旧的三态路由类名不得再出现在样式里（靠类名猜视图归属就是轮43 那个洞）", () => {
    expect(CSS).not.toContain("diff-apply-route");
  });

  it("自检：删掉兜底、或退回不带 !important，都必须判红", () => {
    const dropped = CSS.replace(/\.diff-apply-cache\[hidden\]\s*\{[^{}]*\}/, "");
    expect(dropped, "变异没落到样式里，这条自检是空转").not.toBe(CSS);
    expect(
      violations(dropped),
      "删掉兜底却查不出来，判据是空的"
    ).toContain(".diff-apply-cache[hidden] 兜底缺失：hidden 会被基块的 display:flex 顶掉");
    // 基块仍在，只是没人压住它：这正是「看不见但仍在布局里、仍可被命中」的坏形状
    expect(cssRules(dropped).some((rule) => rule.sel === ".diff-apply-cache")).toBe(true);

    const weakened = CSS.replace(/\.diff-apply-cache\[hidden\]\s*\{[^{}]*\}/, ".diff-apply-cache[hidden] {\n  display: none;\n}");
    expect(weakened, "变异没落到样式里，这条自检是空转").not.toBe(CSS);
    expect(violations(weakened).join("\n"), "不带 !important 的兜底必须判红").toContain("没带 !important");
  });
});

describe("useMountOnceVisible 的实现形状（轮44 D2）", () => {
  it("只回答「该不该还在 DOM 里」，且首帧就返回 visible", () => {
    const src = readScannedSource(KEEPALIVE);
    expect(src).toContain("export function useMountOnceVisible(visible: boolean): boolean");
    // `visible ||` 不是冗余：少了它首屏那一帧先渲染空壳，正是本轮要消灭的闪屏
    expect(src).toMatch(/return visible \|\| everVisible;/);
    // 挂载一次靠 state 留住，不能用 ref（ref 改了不触发重渲染 → 永远挂不上）
    expect(src).toMatch(/const \[everVisible, setEverVisible\] = useState\(visible\);/);
    expect(src).not.toContain("useRef");
  });

  it("自检：丢掉 visible || 这一支会被判成首帧空壳", () => {
    const src = readScannedSource(KEEPALIVE);
    const regress = src.replace("return visible || everVisible;", "return everVisible;");
    expect(regress, "变异没落到源码里，这条自检是空转").not.toBe(src);
    expect(regress).not.toMatch(/return visible \|\| everVisible;/);
  });
});

describe("DiffView 的取数闸门（轮44 R2：看不见 ≠ 没挂载，但翻可见 ≠ 重取）", () => {
  it("两个取数 effect 读 activeRef 闸门并记账，依赖里绝不许出现 active", () => {
    const src = readScannedSource(DIFF);
    const effects = fetchEffects(src);
    expect(effects.map((e) => e.fn).sort()).toEqual(["listAllConfigs(", "listNamespaces("]);
    for (const effect of effects) {
      expect(effect.gatedByRef, `${effect.fn} 的 effect 少了 !activeRef.current 闸门：常驻挂载会退化成后台轮询`).toBe(true);
      expect(effect.recordsPending, `${effect.fn} 隐藏期只 return 不记账：连接被编辑过就再没人补这一取`).toBe(true);
      expect(effect.depHasActive, `${effect.fn} 的依赖里出现了 active：可见性一翻转就重取（DK-01 实测 4 次请求）`).toBe(false);
    }
  });

  it("补做 effect 只依赖 active，两笔 reload 一起补", () => {
    const src = readScannedSource(DIFF);
    const catchUp = catchUpEffect(src);
    expect(catchUp, "读不到「切回可见合并补做」的 effect").toBeTruthy();
    expect(catchUp).toContain("activeRef.current = active;");
    expect(catchUp).toContain("if (!active || !pendingFetchRef.current) return;");
    // 两笔都要补：只补 ns = dataId 候选还挂在旧连接上；只补 cfg = 命名空间下拉空着
    expect(catchUp).toContain("setNsReload((value) => value + 1);");
    expect(catchUp).toContain("setCfgReload((value) => value + 1);");
    const deps = catchUp!.match(/\}, \[([^\]]*)\]\);$/)?.[1].trim();
    // 依赖多写一个（比如 conn）就又是一次重取，绕趟浏览页的 4 次请求会换个名字回来
    expect(deps, `补做 effect 的依赖应该是 [active]，实际是 [${deps}]`).toBe("active");
  });

  it("activeRef / pendingFetchRef 都必须在 SourcePicker 里声明，且只有一处同步", () => {
    const src = readScannedSource(DIFF);
    expect(src).toContain("const activeRef = useRef(active);");
    expect(src).toContain("const pendingFetchRef = useRef(false);");
    // 两处同步 = 闸门有两条写路径，后续重构里最容易漏掉一条
    expect(src.match(/activeRef\.current = active;/g)?.length).toBe(1);
  });

  it("props 声明 active 且缺省为 true，两侧来源面板都收到 active", () => {
    const src = readScannedSource(DIFF);
    expect(src).toContain("active?: boolean;");
    expect(src).toMatch(/DiffView\(\{ active = true,/);
    expect(src.match(/active=\{active\}/g)?.length).toBe(2);
  });

  it("focusStep 消费也要过 active 闸门（隐藏子树里不抢焦点）", () => {
    const src = readScannedSource(DIFF);
    const focus = src.match(/useEffect\(\(\) => \{([\s\S]*?)\}, \[([^\]]*)\]\);/g)?.find((b) => b.includes("focusWorkflowStep(focusStep)"));
    expect(focus, "读不到 focusStep 的 effect").toBeTruthy();
    expect(focus).toMatch(/(^|[^A-Za-z0-9_])!active([^A-Za-z0-9_]|$)/);
    expect(focus).toMatch(/}, \[active, focusStep,/);
  });

  it("写后失效的订阅不需要 active 闸门（只置标记、不取数），但不能反过来被拆掉", () => {
    const src = readScannedSource(DIFF);
    expect(src).toContain("subscribeConfigChanges(");
    expect(src).toContain("setResultStale(true)");
  });

  it("自检：摘闸门、不记账、把 active 塞回依赖，三种坏形状都必须判红", () => {
    const src = readScannedSource(DIFF);

    // 变异一：整个闸门摘掉（后台轮询回来了）
    const noGate = src.replace("    if (!activeRef.current) {\n      pendingFetchRef.current = true;\n      return;\n    }\n", "");
    expect(noGate, "变异没落到源码里，这条自检是空转").not.toBe(src);
    expect(fetchEffects(noGate).some((e) => !e.gatedByRef), "摘掉闸门还能过守卫，这条就是空转").toBe(true);

    // 变异二：只 return 不记账（切回来挂着旧连接的候选，静默的错数据）
    const noPending = src.replace("      pendingFetchRef.current = true;\n", "");
    expect(noPending, "变异没落到源码里，这条自检是空转").not.toBe(src);
    expect(fetchEffects(noPending).some((e) => !e.recordsPending), "删掉记账还能过守卫，这条就是空转").toBe(true);

    // 变异三：方案 a 回潮——把 active 塞回命名空间取数的依赖
    const refetch = src.replace("}, [conn, nsReload, source.connId, t, title]);", "}, [active, conn, nsReload, source.connId, t, title]);");
    expect(refetch, "变异没落到源码里，这条自检是空转").not.toBe(src);
    expect(fetchEffects(refetch).some((e) => e.fn === "listNamespaces(" && e.depHasActive)).toBe(true);

    // 变异四：补做 effect 顺手多依赖一个 conn（等于隐藏期一改连接就重取）
    const looseCatchUp = src.replace("    setCfgReload((value) => value + 1);\n  }, [active]);", "    setCfgReload((value) => value + 1);\n  }, [active, conn]);");
    expect(looseCatchUp, "变异没落到源码里，这条自检是空转").not.toBe(src);
    expect(catchUpEffect(looseCatchUp)!.match(/\}, \[([^\]]*)\]\);$/)?.[1].trim()).not.toBe("active");
  });

  it("自检：`!activeProject` 这类同名变量骗不过闸门判据", () => {
    const src = readScannedSource(DIFF);
    expect(src).toContain("if (!activeProject) return;");
    const lookalike = src.replace(/if \(!activeRef\.current\) \{/g, "if (!activeProject) {");
    expect(lookalike, "变异没落到源码里，这条自检是空转").not.toBe(src);
    expect(fetchEffects(lookalike).every((e) => e.gatedByRef)).toBe(false);
  });
});

describe("真机批 retest-* 残留清扫（轮44 R5）", () => {
  it("判据只有 dataId 前缀 retest-，且代码里不出现播种前缀 svc-", () => {
    const src = readScannedSource(STRAYS);
    expect(src).toContain('export const STRAY_DATAID_PREFIX = "retest-";');
    const isStray = src.match(/function isStray\(dataId: string\): boolean \{([\s\S]*?)\}/);
    expect(isStray, "读不到 isStray 的判据").toBeTruthy();
    expect(isStray![1]).toContain("dataId.toLowerCase().startsWith(STRAY_DATAID_PREFIX)");
    // 判据里掺进 group / namespace 就会碰到 RETEST-* 组名，那是另一码事
    expect(isStray![1]).not.toContain("group");
    expect(src, "清扫判据里出现了播种前缀，会误删 svc-* 基线数据").not.toContain("svc-");
    // 判据的**行为**由 tests/retest/strays.test.ts 用假 fetch 钉（这里只钉形状）
  });

  it("三个落点齐、列表用精确搜索、删除判 body === true", () => {
    const src = readScannedSource(STRAYS);
    const labels = Array.from(src.matchAll(/label: "([^"]+)"/g), (m) => m[1]);
    expect(labels).toEqual(["A/dev", "A/qa", "B/qa"]);
    expect(src).toContain("search=accurate");
    expect(src).toContain('method: "DELETE"');
    expect(src).toContain('body === "true"');
  });

  it("清扫失败只记 console，绝不判红（它是环境兜底不是断言）", () => {
    const src = readScannedSource(STRAYS);
    const sweep = src.match(/export async function sweepRetestStrays[\s\S]*?\n\}/);
    expect(sweep, "读不到 sweepRetestStrays").toBeTruthy();
    expect(sweep![0]).not.toMatch(/\bthrow\b/);
    expect(sweep![0]).toContain("failed.push(");
    expect(sweep![0]).toContain("console.log(");
  });

  it("自检：判据放宽到组名、或把失败变红，都必须被抓住", () => {
    const src = readScannedSource(STRAYS);
    const loose = src.replace("dataId.toLowerCase().startsWith(STRAY_DATAID_PREFIX)", "item.group.toLowerCase().startsWith(STRAY_DATAID_PREFIX)");
    expect(loose, "变异没落到源码里，这条自检是空转").not.toBe(src);
    expect(loose).not.toContain("dataId.toLowerCase().startsWith(STRAY_DATAID_PREFIX)");

    const red = src.replace('console.log(\n    `[strays:${when}]', 'throw new Error(\n    `[strays:${when}]');
    const throwing = red === src ? src.replace("failed.push(`${tag}: HTTP", "throw new Error(`${tag}: HTTP") : red;
    expect(throwing, "两种变异都没落到源码里，这条自检是空转").not.toBe(src);
  });

  it("fixture 接线：worker 作用域 + auto，起跑与收工各扫一次", () => {
    const src = readScannedSource(RETEST_TEST);
    expect(src).toContain("base.extend<RetestFixtures, RetestWorkerFixtures>");
    expect(src).toContain("retestSweep: void;");
    expect(src).toContain('sweepRetestStrays("worker-start")');
    expect(src).toContain('sweepRetestStrays("worker-end")');
    expect(src).toMatch(/\{\s*scope: "worker",\s*auto: true\s*\}/);
    // 收工清扫必须排在 use() 之后（teardown 路径），红掉的用例才兜得住
    const start = src.indexOf('sweepRetestStrays("worker-start")');
    const use = src.indexOf("await use();");
    const end = src.indexOf('sweepRetestStrays("worker-end")');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(use).toBeGreaterThan(start);
    expect(end).toBeGreaterThan(use);
  });

  it("自检：退回 test 作用域或去掉 auto 都必须判红", () => {
    const src = readScannedSource(RETEST_TEST);
    const perTest = src.replace('{ scope: "worker", auto: true }', '{ scope: "test", auto: true }');
    expect(perTest, "变异没落到源码里，这条自检是空转").not.toBe(src);
    expect(perTest).not.toMatch(/\{\s*scope: "worker",\s*auto: true\s*\}/);

    const manual = src.replace('{ scope: "worker", auto: true }', '{ scope: "worker" }');
    expect(manual).not.toMatch(/\{\s*scope: "worker",\s*auto: true\s*\}/);
  });

  it("清扫调用点只有白名单三处：fixture 起收、假 fetch 单测、DK-05 的永久回归", () => {
    const importer = readScannedSource(RETEST_TEST);
    expect(importer).toContain('from "../strays"');
    // 白名单之外一律不许引 strays：单条 spec 各自「顺手扫一遍」= 清扫档位漂移
    // （有的 worker 扫、有的不扫），下一次假红更难认。
    // DK-05 是唯一例外——它把清扫当**被测对象**（投进去再扫出来），不是拿它当收尾。
    const allow = new Set([STRAYS, RETEST_TEST, "tests/retest/strays.test.ts", SWEEP_SPEC]);
    expect(straysImporters(allow), "这些文件也引了 strays：清扫应收在 fixture 一处").toEqual([]);
    // 扫描器不能是瞎的：白名单里确实有东西被它看见（否则上面那条永远绿）
    expect(straysImporters(new Set([STRAYS, RETEST_TEST])), "白名单外的扫描没抓到任何引用方，这条守卫是空转").toContain(SWEEP_SPEC);
  });

  it("DK-05 必须投放→清扫→核对播种，不能只数服务端干不干净", () => {
    const src = readScannedSource(SWEEP_SPEC);
    expect(src).toContain('sweepRetestStrays("dk-05")');
    expect(src).toContain("async function publishStray(");
    expect(src).toContain("await publishStray(BASE_A");
    expect(src).toContain("seededCounts()");
    // 投放失败必须判红：否则「removed 为空」会被读成清扫生效，检测器直接瞎掉
    expect(src).toContain("投残留就失败");
    expect(src).toContain("清扫报清除的条数和投放的对不上");
    expect(src).toContain("播种数据少了 = 清扫判据越界删了 svc-*");
    // 落点清单必须复用 sweepTargets()，别和清扫各写一套（写了第二套就会漏扫一个组合还没人知道）
    expect(src).toContain("for (const target of sweepTargets())");
  });
});
