/**
 * 「跳到下一处」的副作用不许写在 setState updater 里，垂直落地只许一个出口（轮29 F-17 / F-18）。
 *
 * 缺陷长什么样（F-17）：浏览态的 `navigate` 把 `scrollLineIntoView(...)` 写在 `setActiveIdx` 的
 * updater 里。React 的口径是 updater 必须是纯函数——StrictMode 每次更新把 updater 连调两遍来
 * 暴露副作用，实测**按一次 Enter 给 scrollTop 赋值两次**（用例里数出来了），未来的并发重放
 * 与 offscreen 渲染同样会多滚。守卫直接钉形状：滚动是副作用，只许待在 effect 里。
 *
 * F-18 是 F-17 修完立刻暴露的下一条：全文只有 1 处命中时 `(0 + 1 + 1) % 1 === 0`，序号没变，
 * React 连重渲染都省了，落地效果根本不跑。旧实现"能用"靠的正是 updater 里那句副作用——
 * 等于拿脏写法把这条盖住了。守卫要钉的是：跳一次的落地不许只依赖「activeIdx 变了」。
 *
 * 还钉一条口径收敛：开栏 / 改词 / 导航的落地原先分家（一条 useEffect 在绘制后滚、updater 在
 * 更新中滚），合并成 useLayoutEffect 里同一次「提交后、绘制前」落地。分家的代价量过：
 * 绘制后才滚会先闪一帧旧位置，两条出口还会互相覆盖。
 */
import { describe, expect, it } from "vitest";
import { readScannedSource } from "./scanUtils";

const CODE_VIEW = "src/components/CodeView.tsx";
const CODE_EDITOR = "src/components/CodeEditor.tsx";

/** updater 里不许出现的东西：滚动、量矩形、读 DOM、多条语句。 */
const SIDE_EFFECT = /scrollLineIntoView|revealHit|revealMarkHorizontally|scrollTo\(|querySelector/;

/** `const navigate = useCallback(` 到它自己收尾的那一行。 */
function navigateBlock(src: string): string {
  const start = src.indexOf("const navigate = useCallback(");
  expect(start, "找不到 navigate（形状变了，守卫在空转）").toBeGreaterThanOrEqual(0);
  const end = src.indexOf("\n  );", start);
  expect(end, "navigate 的 useCallback 没收尾，切片口径失效").toBeGreaterThan(start);
  return src.slice(start, end);
}

/** 整块 effect（含依赖数组）。 */
function effectBlocks(src: string, kind: "useEffect" | "useLayoutEffect"): string[] {
  return [...src.matchAll(new RegExp(`\\n  ${kind}\\(\\(\\) => \\{[\\s\\S]*?\\n  \\}, \\[[^\\]]*\\]\\);`, "g"))].map((m) => m[0]);
}

/**
 * `setActiveIdx(...)` 这次调用的实参文本（只扫 navigate 这一块）。
 *
 * 别用 `[^;]*` 之类的正则去截：块体 updater（`setActiveIdx((prev) => { ... })`）体内带分号，
 * 正则要么截断要么整个匹配不上返回 null，于是「副作用塞进 updater」的变异反而扫不到，
 * 守卫就空转了。括号配对从调用起点走到配平的那个右括号，表达式体与块体都能完整取到。
 */
function setActiveIdxArgs(nav: string): string | null {
  // 两个视图的提交口不同名：浏览态直接 setActiveIdx，编辑态连着口径一起存，叫 commitActiveIdx
  // （轮30 F-22）。判据盯的是「这个调用」，不是这个字。
  const m = nav.match(/(setActiveIdx|commitActiveIdx)\(/);
  if (!m || m.index === undefined) return null;
  const call = m[0];
  const at = m.index;
  let depth = 0;
  for (let i = at + call.length - 1; i < nav.length; i += 1) {
    const ch = nav[i];
    if (ch === "(") depth += 1;
    else if (ch === ")" && depth > 0) {
      depth -= 1;
      if (depth === 0) return nav.slice(at + call.length, i);
    }
  }
  return null; // 括号不配平：切片口径失效，交给上层判红
}

/** F-17 判据：updater 纯、副作用留在更新之外。违规返回说明，合法返回 null。 */
function updaterSideEffectViolation(src: string): string | null {
  const nav = navigateBlock(src);
  const args = setActiveIdxArgs(nav);
  if (!args) return "navigate 里没有跳转序号的提交调用";
  if (SIDE_EFFECT.test(args)) return `setState updater 里写了副作用：setActiveIdx(${args})`;
  if (/=>\s*\{/.test(args)) return `updater 是块体写法，副作用查无可查：setActiveIdx(${args})`;
  return null;
}

/**
 * 垂直落地的两种写法：浏览态直接 `scrollLineIntoView`，编辑态经 `revealHit`（里面滚行 + 落选区）。
 * 判据要认两种，否则编辑态把滚动包进 revealHit 就扫不到了——那正是轮30 F-22 的那条出口。
 */
const VERTICAL_LANDING = /(scrollLineIntoView|revealHit)\(/;

/** 绘制后滚的出口必须为 0，绘制前的落地出口必须恰好一条。违规返回说明。 */
function paintOrderViolation(src: string): string | null {
  const late = effectBlocks(src, "useEffect").filter((block) => VERTICAL_LANDING.test(block));
  if (late.length) return `又出现 ${late.length} 条绘制后才滚的 useEffect：会先闪一帧旧位置，还与定位效果各写一次`;
  const landing = effectBlocks(src, "useLayoutEffect").filter((block) => VERTICAL_LANDING.test(block));
  if (landing.length !== 1) return `垂直落地不在唯一那条绘制前的 useLayoutEffect 里（找到 ${landing.length} 条）`;
  // 浏览态把三步写在同一条里：切类与水平必须都在这条里，且排在垂直之后
  if (landing[0].includes("classList.add(CURRENT_HIT_CLASS)")) {
    if (!landing[0].includes("revealMarkHorizontally")) return "垂直落地与水平定位分家了：两条出口会互相覆盖";
    const vertical = landing[0].search(VERTICAL_LANDING);
    const addClass = landing[0].indexOf("classList.add(CURRENT_HIT_CLASS)");
    const reveal = landing[0].indexOf("revealMarkHorizontally");
    if (!(addClass > vertical && reveal > addClass)) return "落地顺序不是「垂直 → 换类 → 水平」：先量就量到上一处";
  }
  return null;
}

/** 唯一那条绘制前的落地效果（顺带钉住「恰好一条」，取到多条就是守卫在空转）。 */
function landingBlock(src: string): string {
  const landing = effectBlocks(src, "useLayoutEffect").filter((block) => VERTICAL_LANDING.test(block));
  expect(landing.length, `绘制前的落地效果应有且只有一条，找到 ${landing.length} 条`).toBe(1);
  return landing[0];
}

/** 一条效果的依赖数组文本（形如 `  }, [a, b]);` 的那三行）。 */
function effectDeps(block: string): string {
  const m = block.match(/\}, \[([^\]]*)\]\);\s*$/);
  expect(m, "取不到依赖数组，这条守卫在空转").toBeTruthy();
  return m?.[1] ?? "";
}

/**
 * 编辑态专属的口径（轮30 F-22）：正文不许进落地的依赖。
 *
 * 为什么浏览态能带 html 而编辑态不能：浏览态的正文只读，`html` 变了就是「换了内容 / 改了词」，
 * 落回当前那处正是用户要的；编辑态的字是用户自己敲的，正文一变就落回第一处命中，
 * 光标会在下一个字被从正在编辑的行拽走——配置直接改到别的行上去。
 */
function landingFollowsBodyViolation(src: string): string | null {
  const deps = effectDeps(landingBlock(src));
  if (/\b(doc|lines|hits|html|totalLines)\b/.test(deps)) {
    return `正文进了落地依赖：打字会把光标与视口从正在编辑的那行拽到第一处命中（[${deps.trim()}]）`;
  }
  return null;
}

/** 编辑态专属的口径（轮30 F-22）：垂直落地必须排在「换类 + 水平定位」那条之前。 */
function landingBeforeDecorateViolation(src: string): string | null {
  const landing = landingBlock(src);
  const decorate = effectBlocks(src, "useLayoutEffect").find((b) => b.includes("revealMarkHorizontally"));
  expect(decorate, "没找到换类 + 水平定位那条效果，这条守卫在空转").toBeTruthy();
  const at = src.indexOf(landing);
  const decorateAt = src.indexOf(decorate as string);
  expect(at, "落地效果不在源文件里（切片口径失效）").toBeGreaterThanOrEqual(0);
  // 同一批 useLayoutEffect 按声明顺序执行：排在后面就会先按旧位置量一次矩形
  if (at > decorateAt) return "垂直落地声明在「换类 + 水平」之后：同一次提交里量到的是没滚过的旧位置";
  return null;
}

/** F-18 判据：落地不许只靠 activeIdx 变化被触发。 */
function jumpNeedsNoIndexChange(src: string): boolean {
  const nav = navigateBlock(src);
  if (/setNavTick\(/.test(nav)) return true; // 浏览态：序号不变也 bump 跳转计数
  return /revealHit\(hits\[next\]\)/.test(nav); // 编辑态：无条件定位到算出来的那一处
}

describe("跳下一处的副作用留在更新之外（轮29 F-17 / F-18）", () => {
  it("两个视图的 setState updater 都是纯的", () => {
    for (const file of [CODE_VIEW, CODE_EDITOR]) {
      const violation = updaterSideEffectViolation(readScannedSource(file));
      expect(violation, `${file}: ${violation}`).toBeNull();
    }
  });

  it("命中只有一处时「再跳一次」仍然会落地", () => {
    for (const file of [CODE_VIEW, CODE_EDITOR]) {
      expect(jumpNeedsNoIndexChange(readScannedSource(file)), `${file} 的落地只依赖「序号变了」，单命中时一动不动`).toBe(true);
    }
  });

  it("浏览态的垂直落地只有一个出口：绘制前的 useLayoutEffect，不许有第二条 useEffect 在滚", () => {
    const violation = paintOrderViolation(readScannedSource(CODE_VIEW));
    expect(violation, violation ?? "").toBeNull();
  });

  it("编辑态的垂直落地也只有一个出口，且不跟正文变化跑（轮30 F-22）", () => {
    const src = readScannedSource(CODE_EDITOR);
    expect(paintOrderViolation(src), "编辑态的落地出口形状不对").toBeNull();
    expect(landingFollowsBodyViolation(src), "编辑态的落地不许把正文也算作触发条件").toBeNull();
    expect(landingBeforeDecorateViolation(src), "编辑态的垂直落地要排在换类 + 水平之前").toBeNull();
  });

  it("落地顺序：垂直 → 换当前命中的类 → 水平（先切类才量得准）", () => {
    const src = readScannedSource(CODE_VIEW);
    const block = effectBlocks(src, "useLayoutEffect").find((b) => b.includes("scrollLineIntoView(")) ?? "";
    const vertical = block.indexOf("scrollLineIntoView(");
    const addClass = block.indexOf("classList.add(CURRENT_HIT_CLASS)");
    const reveal = block.indexOf("revealMarkHorizontally");
    expect(vertical, "没找到垂直落地").toBeGreaterThanOrEqual(0);
    expect(addClass, "没找到切类").toBeGreaterThan(vertical);
    expect(reveal, "没找到水平定位").toBeGreaterThan(addClass);
  });
});

describe("守卫自身不空转：五种退回必须判红", () => {
  it("退回「浏览态 updater 里滚动」判红", () => {
    const honest = readScannedSource(CODE_VIEW);
    expect(updaterSideEffectViolation(honest)).toBeNull();
    const regressed = honest.replace(
      "setActiveIdx((prev) => (prev + delta + hits.length) % hits.length);",
      `setActiveIdx((prev) => {
        const next = (prev + delta + hits.length) % hits.length;
        scrollLineIntoView(hits[next].line);
        return next;
      });`
    );
    expect(setActiveIdxArgs(navigateBlock(regressed)), "变异没落到 updater 里，这条自检是空转").toContain("scrollLineIntoView");
    expect(updaterSideEffectViolation(regressed), "滚动写回 updater 却没判红").not.toBeNull();
  });

  it("退回「编辑态 updater 里定位」判红", () => {
    const honest = readScannedSource(CODE_EDITOR);
    expect(updaterSideEffectViolation(honest)).toBeNull();
    const regressed = honest.replace("revealHit(hits[next]);", "").replace(
      "commitActiveIdx(next);",
      `commitActiveIdx(() => {
        revealHit(hits[next]);
        return next;
      });`
    );
    expect(updaterSideEffectViolation(regressed), "编辑态把定位塞回 updater 却没判红").not.toBeNull();
  });

  it("退回「只靠序号变化触发落地」（F-18）判红", () => {
    const honest = readScannedSource(CODE_VIEW);
    expect(jumpNeedsNoIndexChange(honest)).toBe(true);
    const regressed = honest.replace("      setNavTick((tick) => tick + 1);\n", "");
    expect(regressed, "变异没撤掉跳转计数，这条自检是空转").not.toContain("setNavTick((tick)");
    expect(jumpNeedsNoIndexChange(regressed), "撤掉跳转计数却没判红").toBe(false);
  });

  it("退回「第二条绘制后滚动的出口」判红", () => {
    const honest = readScannedSource(CODE_VIEW);
    expect(paintOrderViolation(honest)).toBeNull();
    // 锚点必须是代码而不是注释：readScannedSource 会把注释剥成空白，
    // 早先用「// 切换文件时收起查找栏」当锚点时代替没落地，这条自检一直是空转的。
    const ANCHOR = "  const visibleRange = useMemo(() => {";
    expect(honest.includes(ANCHOR), "锚点变了，这条自检插不进变异").toBe(true);
    const regressed = honest.replace(
      ANCHOR,
      `  useEffect(() => {
    if (!findOpen || !hits.length) return;
    scrollLineIntoView(hits[clamp(activeIdx, 0, hits.length - 1)].line);
  }, [findOpen, effectiveTerm, matchOptions]);

${ANCHOR}`
    );
    const late = effectBlocks(regressed, "useEffect").filter((b) => b.includes("scrollLineIntoView("));
    expect(late.length, "变异没插进第二条出口，这条自检是空转").toBeGreaterThan(0);
    expect(paintOrderViolation(regressed), "又冒出一条绘制后滚的 useEffect 却没判红").not.toBeNull();
  });

  it("退回「垂直落地不在这条效果里」判红", () => {
    const block = effectBlocks(readScannedSource(CODE_VIEW), "useLayoutEffect").find((b) => b.includes("scrollLineIntoView(")) ?? "";
    const regressed = block.replace("    scrollLineIntoView(hits[idx].line);\n", "");
    expect(regressed, "变异没撤掉垂直落地，这条自检是空转").not.toContain("scrollLineIntoView(hits[idx].line)");
    expect(regressed.indexOf("scrollLineIntoView("), "撤掉垂直落地后这条判据不再成立（vertical 取到 -1）").toBe(-1);
  });

  it("退回「编辑态的落地写在绘制后的 useEffect 里」判红", () => {
    const honest = readScannedSource(CODE_EDITOR);
    const landing = landingBlock(honest);
    const regressed = honest.replace(landing, landing.replace("useLayoutEffect", "useEffect"));
    expect(regressed, "变异没落到编辑态的落地效果上，这条自检是空转").not.toBe(honest);
    expect(paintOrderViolation(regressed), "编辑态的落地退回绘制后的 useEffect 却没判红").not.toBeNull();
  });

  it("退回「正文进了编辑态落地的依赖」判红", () => {
    const honest = readScannedSource(CODE_EDITOR);
    const landing = landingBlock(honest);
    const regressed = honest.replace(landing, landing.replace("[findOpen,", "[html, findOpen,"));
    expect(regressed, "变异没改到依赖数组，这条自检是空转").not.toBe(honest);
    expect(landingFollowsBodyViolation(regressed), "正文进了落地依赖却没判红（打字会拽走光标）").not.toBeNull();
  });

  it("退回「编辑态的落地声明在换类之后」判红", () => {
    const honest = readScannedSource(CODE_EDITOR);
    const landing = landingBlock(honest);
    const decorate = effectBlocks(honest, "useLayoutEffect").find((b) => b.includes("revealMarkHorizontally")) as string;
    // 把两条对调：落地跑到换类 + 水平之后
    const swapped = honest.replace(landing, "@@LANDING@@").replace(decorate, landing).replace("@@LANDING@@", decorate);
    expect(swapped, "对调没改动源码，这条自检是空转").not.toBe(honest);
    expect(landingBeforeDecorateViolation(swapped), "落地排在换类之后却没判红").not.toBeNull();
  });
});
