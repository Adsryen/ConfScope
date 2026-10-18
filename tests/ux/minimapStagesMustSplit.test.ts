/**
 * 缩略图必须分两阶段算，标尺不许退回全文 maxLen，而且**两个视图只许有一份实现**
 * （轮28 F-11 + F-12 + F-13 / 轮30 F-20 + F-24）。
 *
 * 三条缺陷各自都有「一改就退回去」的形状，所以钉形状不钉性能数字：
 * 1) F-12：`minimapRows` 原先挂在含 currentLine 的 memo 上，桶内行长 / 行类型 / 条宽只跟正文有关，
 *    却每按一次 Enter 把 20 万行重新 `line.replace(/\t/g, "  ")` 一遍（实测单次 21-46ms）。
 *    ⇒ 贵的那一阶段（prepareMinimapBuckets）不许看命中，视图侧的 buckets memo 依赖只许 [lines, rowLimit]。
 * 2) F-11：条宽用全文最长行归一时，「800 行正常配置 + 1 行 60000 字符证书」让 266/267 个桶
 *    塌到 3px 下限（实测条宽 p50 = 3.0px），缩略图唯一的用处（哪里内容密集）没了。
 *    ⇒ 标尺走桶最长行的 p95 常量，ratio 必须 `min(1, …)` 触顶，函数里不许再出现 maxLen。
 * 3) F-13：`hasMinimap` 原先只看「设置开了且有行」，内容不满一屏时缩略图照样画——
 *    点了不动的死控件。加可滚判断的同时，右侧留白**必须继续用旧条件**，
 *    否则「隐藏缩略图 ⇒ 正文宽 8px ⇒ 可能不再需要横向滚动条 ⇒ clientHeight 变 ⇒ 又该显示」自激振荡。
 * 4) F-24（本轮新增）：这条控件原先只有浏览态有，编辑态整个没有；「照着再补一份」会把
 *    上面三条口径各复制一遍，两份实现就是下一轮 bug 的出处。
 *    ⇒ 桶表 / 画布 / 点击映射 / 尺寸观察 / 视口框只许住在 src/components/CodeMinimap.tsx，
 *      两个视图只递数据与几何，画布与 jumpFromPointer 一处都不许再出现。
 *
 * 末尾几条自检把几种退回钉成判红。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT, readScannedSource } from "./scanUtils";

const LIB = "src/lib/codeLines.ts";
const MM = "src/components/CodeMinimap.tsx";
const VIEW = "src/components/CodeView.tsx";
const EDITOR = "src/components/CodeEditor.tsx";
const CSS_FILE = "src/styles.css";

const CSS = readFileSync(join(PROJECT_ROOT, CSS_FILE), "utf8");

/** 取 `export function name(...)` 到下一个顶层 export 之前（够覆盖整个函数体）。 */
function exportedBody(source: string, name: string): string {
  const start = source.indexOf(`export function ${name}(`);
  expect(start, `找不到 ${name} 的定义`).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start);
  const end = rest.search(/\nexport (async )?(function|const|interface|type)\b/);
  return end > 0 ? rest.slice(0, end) : rest;
}

/** 取 `export function name(...)` 的形参表原文。 */
function exportedParams(source: string, name: string): string {
  const start = source.indexOf(`export function ${name}(`);
  expect(start, `找不到 ${name} 的定义`).toBeGreaterThanOrEqual(0);
  const open = start + `export function ${name}(`.length;
  const close = source.indexOf("): ", open) >= 0 ? source.indexOf("): ", open) : source.indexOf(") {", open);
  expect(close, `${name} 的形参表读不到`).not.toBeNull();
  return source.slice(open, close).replace(/\s+/g, " ");
}

/** 取某条 `const x = useMemo(...)` 的依赖数组内容（空白压成单空格）。 */
function memoDeps(source: string, decl: string): string {
  const start = source.indexOf(decl);
  expect(start, `缺少 ${decl}`).toBeGreaterThanOrEqual(0);
  const found = /,\s*\[([^\]]*)\]\)/.exec(source.slice(start));
  expect(found, `${decl} 的依赖数组读不到`).not.toBeNull();
  return (found?.[1] ?? "").replace(/\s+/g, " ").trim();
}

/** 把若干条与「右侧留白」相关的声明行挑出来（留白的判据必须只看设置位）。 */
function padLines(source: string): string[] {
  return source.split("\n").filter((line) => /(--code-pad-right|--code-find-right|const padRight)/.test(line));
}

describe("缩略图分两阶段（轮28 F-12）", () => {
  it("贵的那一阶段完全不碰命中：参数与函数体里都不许出现 hits / currentLine", () => {
    const source = readScannedSource(LIB);
    const params = exportedParams(source, "prepareMinimapBuckets");
    expect(params, "prepareMinimapBuckets 不该接收命中").not.toMatch(/hits|currentLine|Set<number>/);
    expect(params).toBe("lines: string[], rowLimit: number");
    const body = exportedBody(source, "prepareMinimapBuckets");
    expect(body, "第一阶段算出了命中语义，第二阶段就没活干了").not.toMatch(/hasHit|isCurrent|currentLine/);
  });

  it("便宜的那一阶段不许重算正文：不读 lines、不做 Tab 归一、不判行类型", () => {
    const source = readScannedSource(LIB);
    const params = exportedParams(source, "decorateMinimapRows");
    expect(params).toBe("buckets: MinimapBuckets, sortedHitLines: number[], currentLine: number | null");
    const body = exportedBody(source, "decorateMinimapRows");
    expect(body, "第二阶段又去遍历全文了（每按一次 Enter 再付 21-46ms）").not.toMatch(/\.replace\(\/\\t\/g/);
    expect(body, "第二阶段重算了行长类型").not.toMatch(/isBlankLine|isCommentLine/);
    expect(body, "第二阶段重算了条宽").not.toMatch(/widthRatio\s*[:=]\s*[^,}]*\//);
  });

  it("buildMinimapRows 只是薄封装（口径只有一份，画布侧不改）", () => {
    const source = readScannedSource(LIB);
    const body = exportedBody(source, "buildMinimapRows");
    expect(body, "薄封装里不许再自己算行长").not.toMatch(/\.replace\(\/\\t\/g/);
    expect(body).toMatch(/decorateMinimapRows\(prepareMinimapBuckets\(lines,\s*rowLimit\),\s*Array\.from\(hits\),\s*currentLine\)/);
    expect(exportedParams(source, "buildMinimapRows")).toBe(
      "lines: string[], hits: Set<number>, currentLine: number | null, rowLimit: number"
    );
  });

  it("唯一那份实现里拆成两条 memo，且不许走薄封装", () => {
    const mm = readScannedSource(MM);
    expect(mm, "缩略图不许一次算完（那正是每次 Enter 重付全文的钱）").not.toMatch(/buildMinimapRows\(/);
    expect(memoDeps(mm, "const buckets = useMemo(")).toBe("lines, rowLimit");
    const rowsDeps = memoDeps(mm, "const minimapRows = useMemo(");
    expect(rowsDeps, "minimapRows 又依赖整篇正文了").not.toMatch(/\blines\b/);
    expect(rowsDeps).toContain("buckets");
    expect(rowsDeps).toContain("currentLine");
  });
});

describe("缩略图条宽标尺（轮28 F-11）", () => {
  it("标尺是 p95 常量，不是全文 maxLen", () => {
    const source = readScannedSource(LIB);
    expect(source, "p95 常量没定义").toMatch(/export const MINIMAP_WIDTH_RULER_PERCENTILE\s*=\s*0\.95;/);
    const body = exportedBody(source, "prepareMinimapBuckets");
    expect(body, "标尺退回全文最长行：一行脏数据就能把整张图压扁").not.toMatch(/\bmaxLen\b/);
    expect(body, "标尺没用分位数").toMatch(/percentileAscending\(/);
    expect(body, "ratio 没触顶，超长行会画出画布外").toMatch(/Math\.min\(1,\s*longestInBucket\s*\/\s*ruler\)/);
  });

  it("分桶最长行只算一趟（旧实现每行 replace 两次）", () => {
    const body = exportedBody(readScannedSource(LIB), "prepareMinimapBuckets");
    expect(body.match(/\.replace\(\/\\t\/g/g) || [], "同一行被量了两次长度").toHaveLength(1);
  });
});

describe("缩略图显隐与右侧留白（轮28 F-13）", () => {
  it("显隐要判「真能滚」，留白要用设置位", () => {
    const mm = readScannedSource(MM);
    expect(mm, "缩略图又在内容不满一屏时画了个点了不动的死控件").toMatch(
      /const canScrollContent = metrics\.scrollHeight <= 0 \|\| metrics\.scrollHeight > metrics\.clientHeight \+ 1;/
    );
    expect(mm, "量不到几何时不许闪没：首帧放行").toMatch(/if \(!canScrollContent\) return null;/);
    for (const [file, src] of [
      [VIEW, readScannedSource(VIEW)],
      [EDITOR, readScannedSource(EDITOR)],
    ] as const) {
      expect(src, `${file} 的留白依据必须是设置位，不是显隐`).toMatch(/const minimapReserved = showMinimap && totalLines > 0;/);
      const lines = padLines(src);
      expect(lines.length, `${file} 读不到右侧留白的声明`).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line, `${file} 留白跟着缩略图显隐变 ⇒ 正文宽变 ⇒ 高度又变 ⇒ 抖动`).not.toMatch(
          /canScroll|scrollHeight|clientHeight|hasMinimap/
        );
      }
      expect(src, `${file} 的留白数值必须取共享组件那份常量`).toContain("MINIMAP_RESERVED_RIGHT");
    }
  });

  it("缩略图尺寸的 ResizeObserver 依赖跟着显隐位（元素自己消失后要有人再量它）", () => {
    const mm = readScannedSource(MM);
    const block = /const measure = \(\) => setMinimapSize\([\s\S]*?\}, \[([^\]]*)\]\);/.exec(mm);
    expect(block, "读不到 minimapSize 的 ResizeObserver 块").not.toBeNull();
    expect(block?.[1], "元素会因不满一屏自己消失，只盯调用方的设置位就再也没人量它").toContain("canScrollContent");
  });
});

describe("缩略图只许有一份实现（轮30 F-24）", () => {
  /** 视图里再出现这些，就是第二份画布 / 第二份点击映射 / 第二份桶表。 */
  const SECOND_IMPLEMENTATION = [
    /getContext\("2d"\)/,
    /prepareMinimapBuckets\(/,
    /decorateMinimapRows\(/,
    /buildMinimapRows\(/,
    /jumpFromPointer/,
    /setMinimapSize/,
    /code-minimap-canvas/,
  ];

  it("两个视图都只渲染共享组件，且不残留任何第二份实现的零件", () => {
    const mm = readScannedSource(MM);
    expect(mm).toMatch(/const ctx = canvas\.getContext\("2d"\);/);
    expect(mm.match(/jumpFromPointer/g) || [], "点击映射只许有一份").toHaveLength(3); // 定义 + pointerdown + pointermove
    for (const [file, src] of [
      [VIEW, readScannedSource(VIEW)],
      [EDITOR, readScannedSource(EDITOR)],
    ] as const) {
      expect(src, `${file} 没接上共享的缩略图组件`).toMatch(/<CodeMinimap/);
      for (const pattern of SECOND_IMPLEMENTATION) {
        expect(src, `${file} 里还有第二份实现：${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("条宽内缩与画布占宽各自只有一个出处，CSS 与 TS 同值", () => {
    const raw = readScannedSource(MM);
    const inset = /const MM_INSET_X = (\d+);/.exec(raw);
    expect(inset, "MM_INSET_X 没定义").not.toBeNull();
    const width = /export const MINIMAP_W = (\d+);/.exec(raw);
    expect(width, "MINIMAP_W 没定义").not.toBeNull();
    // 画条的 x 与条宽标尺必须用同一个数（原先一边写 4、一边写 width - 8）
    const mm = raw;
    expect(mm, "条宽标尺没用 MM_INSET_X").toMatch(/width - MM_INSET_X \* 2/);
    expect(mm.match(/ctx\.fillRect\(MM_INSET_X,/g) || [], "画条左右内缩有两处以上写法").toHaveLength(2);
    for (const selector of [".code-view", ".code-editor"]) {
      const block = new RegExp(`${selector.replace(/\./g, String.raw`\.`)} \\{([^}]*)\\}`, "m").exec(CSS);
      expect(block, `styles.css 里找不到 ${selector} 规则块`).not.toBeNull();
      expect(
        new RegExp(`--code-minimap-w: ${width?.[1]}px;`).exec(block![1]),
        `${selector} 的 --code-minimap-w 与 MINIMAP_W 不同值`
      ).not.toBeNull();
    }
    expect(inset![1], "内缩不该超过图宽的一半").toBe("4");
  });

  it("编辑态的缩略图必须压在 textarea 之上且收得到指针事件（层级靠特异度，不靠 DOM 顺序）", () => {
    expect(CSS).toMatch(/\.code-editor \.code-minimap \{\n\s*z-index: 3;\n\s*\}/);
  });
});

describe("缩略图让开原生滚动条（轮31 F-28）", () => {
  /** 取某条选择器块里的某个声明值（值内空白压平）；找不到声明返回 null。判据只看传进来的那份 CSS。 */
  function declIn(css: string, selector: string, prop: string): string | null {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
    const rule = new RegExp(`${escaped} \\{([^}]*)\\}`, "m").exec(css);
    expect(rule, `styles.css 里找不到 ${selector} 规则块`).not.toBeNull();
    const found = new RegExp(`${prop.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)}:\\s*([^;]+);`).exec(rule![1]);
    return found ? found[1].replace(/\s+/g, " ").trim() : null;
  }
  const decl = (selector: string, prop: string) => declIn(CSS, selector, prop);

  /** 从 CodeMinimap.tsx 里取一个数值常量（`export const NAME = 12;` 或 `const NAME = 12;`）。 */
  function numericConst(name: string): number {
    const found = new RegExp(`(?:export )?const ${name} = (\\d+);`).exec(readScannedSource(MM));
    expect(found, `CodeMinimap.tsx 里读不到常量 ${name}`).not.toBeNull();
    return Number(found![1]);
  }

  it("CSS 侧：滚动条占宽只有一个数，缩略图按它让位", () => {
    const scrollbarW = decl("::-webkit-scrollbar", "width");
    expect(scrollbarW, "全站滚动条宽度读不到，这条守卫就成了空转").not.toBeNull();
    expect(scrollbarW, "横向滚动条高度与纵向宽度不同值？那要拆成两个变量分别让位").toBe(decl("::-webkit-scrollbar", "height"));

    expect(decl(":root", "--code-scrollbar-w"), `:root 里缺少 --code-scrollbar-w（必须与 ::-webkit-scrollbar 的 ${scrollbarW} 同源）`).toBe(
      scrollbarW
    );
    expect(decl(".code-minimap", "right"), "缩略图还贴着 right:0：整条纵向滚动条被不透明的它盖住").toBe("var(--code-scrollbar-w)");
    expect(decl(".code-minimap", "bottom"), "缩略图还贴着 bottom:0：横向滚动条右端那 66px 抓到的全是图").toBe("var(--code-scrollbar-w)");
  });

  it("TS 侧：留白按三个分量算，缺一项就是把滚动条盖回去", () => {
    const w = numericConst("MINIMAP_W");
    const gap = numericConst("MINIMAP_SIDE_GAP");
    const bar = numericConst("MINIMAP_SCROLLBAR_W");
    expect(bar, "MINIMAP_SCROLLBAR_W 必须与 CSS 那份同值").toBe(Number(decl("::-webkit-scrollbar", "width")!.replace("px", "")));

    const reserved = /export const MINIMAP_RESERVED_RIGHT = ([^;]+);/.exec(readScannedSource(MM));
    expect(reserved, "读不到 MINIMAP_RESERVED_RIGHT 的定义").not.toBeNull();
    expect(reserved![1].replace(/\s+/g, " ").trim(), "留白少了滚动条那一格：必须是三个分量之和").toBe(
      "MINIMAP_W + MINIMAP_SIDE_GAP + MINIMAP_SCROLLBAR_W"
    );
    expect(w + gap + bar, "三个分量加起来要正好等于留白（正文右缘与查找条都按它对齐）").toBe(86);

    // .code-area 的兜底留白（JS 没下发时的值）不许停在旧的两分量数字上
    const fallback = /--code-pad-right,\s*(\d+)px/.exec(CSS);
    expect(fallback, "读不到 .code-area 的右侧留白兜底值").not.toBeNull();
    expect(Number(fallback![1]), "兜底留白与 MINIMAP_RESERVED_RIGHT 分叉：JS 下发失败时就又盖住滚动条").toBe(w + gap + bar);
  });

  it("两个视图的 CSS 块各自都要看得到占宽（让位变量在 :root，靠继承下发）", () => {
    for (const selector of [".code-view", ".code-editor"]) {
      expect(decl(selector, "--code-minimap-w"), `${selector} 的 --code-minimap-w 必须与 MINIMAP_W 同值`).toBe(
        `${numericConst("MINIMAP_W")}px`
      );
    }
  });

  it("自检六：把 right/bottom 退回 0 必须判红", () => {
    const regressed = CSS.replace(".code-minimap {", ".code-minimap {").replace(
      "  right: var(--code-scrollbar-w);\n  bottom: var(--code-scrollbar-w);",
      "  right: 0;\n  bottom: 0;"
    );
    expect(regressed, "变异没落到源码里，这条自检是空转").not.toBe(CSS);
    expect(declIn(regressed, ".code-minimap", "right"), "退回 0 之后判据必须看得见差别").toBe("0");
    expect(declIn(regressed, ".code-minimap", "bottom"), "退回 0 之后判据必须看得见差别").toBe("0");
    expect(decl(".code-minimap", "right"), "真源码必须是让位写法，否则上面那两条对比是空转").not.toBe("0");
  });

  it("自检七：留白退回两个分量必须判红", () => {
    const mm = readScannedSource(MM);
    const regressed = mm.replace(
      "export const MINIMAP_RESERVED_RIGHT = MINIMAP_W + MINIMAP_SIDE_GAP + MINIMAP_SCROLLBAR_W;",
      "export const MINIMAP_RESERVED_RIGHT = MINIMAP_W + MINIMAP_SIDE_GAP;"
    );
    expect(regressed, "变异没落到源码里，这条自检是空转").not.toBe(mm);
    const reserved = /export const MINIMAP_RESERVED_RIGHT = ([^;]+);/.exec(regressed);
    expect(reserved![1].replace(/\s+/g, " ").trim(), "少一个分量就必须判红：正文右缘会压住滚动条那 10px").not.toBe(
      "MINIMAP_W + MINIMAP_SIDE_GAP + MINIMAP_SCROLLBAR_W"
    );
  });
});

describe("缩略图的鼠标出口必须自己收尾（轮31 F-25 / F-26 / F-27）", () => {
  /**
   * 写完 scrollTop 的出口必须当帧补一次同步（轮30 F-20 那条不变式）。
   *
   * 判据按「写入点 → 所属函数收尾」取窗口：行号层与命中行底色层在滚动容器之外，靠
   * `translateY(-scrollTop)` 跟手，浏览器不替我们滚它们，而 scroll 事件是异步派发的——
   * 新出口（点击、拖动、滚轮）只要少一次当帧同步，侧栏就永远慢一帧。
   */
  function unsyncedScrollWrites(source: string): number[] {
    const lines = source.split("\n");
    const offenders: number[] = [];
    lines.forEach((line, i) => {
      if (!/\.scrollTop\s*=[^=]/.test(line)) return;
      let window = "";
      for (let j = i + 1; j < lines.length; j += 1) {
        window += `${lines[j]}\n`;
        if (/^ {2,4}\}/.test(lines[j])) break;
      }
      if (!/syncScroll\(\)/.test(window)) offenders.push(i + 1);
    });
    return offenders;
  }

  it("每一处写 scrollTop 都在同一个函数里补了同步", () => {
    const mm = readScannedSource(MM);
    const writes = mm.split("\n").filter((line) => /\.scrollTop\s*=[^=]/.test(line));
    expect(writes.length, "缩略图连一处写偏移都没有？那这条守卫是空转").toBeGreaterThan(0);
    expect(unsyncedScrollWrites(mm), "这些行写了正文偏移却没当帧同步行号层与命中行层").toEqual([]);
  });

  it("wheel 必须是元素上的原生 non-passive 监听，JSX 里不许出现 onWheel", () => {
    const mm = readScannedSource(MM);
    expect(mm, "React 18 的 onWheel 挂在根容器且是 passive，preventDefault 实测无效（双滚拦不住）").not.toMatch(/onWheel=\{/);
    const listener = /addEventListener\("wheel",\s*[^,]+,\s*\{([^}]*)\}\)/.exec(mm);
    expect(listener, "wheel 没走原生监听，或第三个参数没显式写选项").not.toBeNull();
    expect(listener![1].replace(/\s+/g, " "), "passive 必须是 false，否则浏览器直接忽略 preventDefault").toMatch(/passive: false/);
    expect(mm, "卸载时不摘监听：换文件重挂会攒出一串 handler，同一格滚轮滚好几遍").toMatch(/removeEventListener\("wheel"/);
  });

  it("pointerdown 必须取消默认动作（mousedown 才是抢焦点那一步）", () => {
    const mm = readScannedSource(MM);
    const handler = /onPointerDown=\{\s*\(e\)\s*=>\s*\{([\s\S]*?)\n {6}\}\}/.exec(mm);
    expect(handler, "读不到 onPointerDown 的函数体").not.toBeNull();
    expect(handler![1], "不取消 pointerdown：编辑态 textarea 失焦，浏览态方向键当场失效").toMatch(/e\.preventDefault\(\);/);
    expect(handler![1], "取消默认动作不能把跳转一起取消掉").toMatch(/jumpFromPointer\(e\.clientY\);/);
  });

  it("画条只用正文像素尺，估算分母只许有一个出处", () => {
    const mm = readScannedSource(MM);
    expect(mm.match(/padTop \* 2/g) || [], "又出现第二处「padTop*2 + 行数*行高」估算：那就是第三把尺").toHaveLength(1);
    expect(mm, "视口框自己估分母（把 padBottom 当 padTop）").not.toMatch(/padTop \* 2 \+ totalLines \* rowHeight/);
    expect(mm, "画条又退回行序号比例尺：画的和跳的会差一个 padTop").not.toMatch(/row\.startLine \/ n\) \* height/);
    expect(mm, "画条必须按正文像素：(padTop + startLine*rowHeight) / contentHeight * height").toMatch(
      /y = \(\(padTop \+ row\.startLine \* rowHeight\) \/ contentHeight\) \* height;/
    );
    expect(mm, "分母要收在一条 memo 里，两个出口各取一次").toMatch(/const contentHeight = useMemo\(/);
    // 这条 memo 的依赖数组被 Prettier 排在下一行，通用 memoDeps（要求 ] 紧跟 )）会一路扫到别人的依赖表，这里单独宽松提取。
    const denomDeps = /const contentHeight = useMemo\([\s\S]*?,\s*\[([^\]]*)\]\s*\n\s*\);/.exec(mm);
    expect(denomDeps, "分母的依赖数组读不到").not.toBeNull();
    expect(denomDeps![1].replace(/\s+/g, " ").trim(), "分母的依赖少一项，查找栏开合或正文变长时画条就不跟着动").toBe(
      "metrics.scrollHeight, padTop, lines.length, rowHeight"
    );
  });

  it("自检八：新出口只写偏移不补同步必须判红", () => {
    const mm = readScannedSource(MM);
    const regressed = mm.replace(
      "      el.scrollTop = clamp(el.scrollTop + delta, 0, Math.max(0, el.scrollHeight - el.clientHeight));\n      syncScroll();",
      "      el.scrollTop = clamp(el.scrollTop + delta, 0, Math.max(0, el.scrollHeight - el.clientHeight));"
    );
    expect(regressed, "变异没落到源码里，这条自检是空转").not.toBe(mm);
    expect(unsyncedScrollWrites(regressed), "漏掉当帧同步的那一行必须被抓出来").toEqual([
      regressed.slice(0, regressed.indexOf("el.scrollTop = clamp(el.scrollTop + delta")).split("\n").length,
    ]);
  });

  it("自检九：wheel 退回 React 的 onWheel 必须判红", () => {
    const mm = readScannedSource(MM);
    const regressed = mm
      .replace('mm.addEventListener("wheel", onWheel, { passive: false });', "const onWheelJsx = onWheel;")
      .replace('className="code-minimap"', 'className="code-minimap" onWheel={(e) => onWheel(e.nativeEvent)}');
    expect(regressed, "变异没落到源码里，这条自检是空转").not.toBe(mm);
    expect(regressed, "出现 onWheel= 就必须判红（passive 监听里 preventDefault 无效）").toMatch(/onWheel=\{/);
    expect(/addEventListener\("wheel",\s*[^,]+,\s*\{([^}]*)\}\)/.exec(regressed), "原生监听没了也必须判红").toBeNull();
  });

  it("自检十：pointerdown 不再 preventDefault 必须判红", () => {
    const mm = readScannedSource(MM);
    const handler = /onPointerDown=\{\s*\(e\)\s*=>\s*\{([\s\S]*?)\n {6}\}\}/.exec(mm);
    expect(handler, "读不到 onPointerDown，这条自检是空转").not.toBeNull();
    const regressed = mm.replace(handler![1], handler![1].replace("e.preventDefault();", ""));
    expect(regressed, "变异没落到源码里，这条自检是空转").not.toBe(mm);
    const regressedHandler = /onPointerDown=\{\s*\(e\)\s*=>\s*\{([\s\S]*?)\n {6}\}\}/.exec(regressed);
    expect(regressedHandler![1], "去掉 preventDefault 之后判据必须看不见它").not.toMatch(/e\.preventDefault\(\);/);
  });

  it("自检十一：画条退回 (startLine / n) * height 必须判红", () => {
    const mm = readScannedSource(MM);
    const regressed = mm
      .replace("const y = ((padTop + row.startLine * rowHeight) / contentHeight) * height;", "const y = (row.startLine / n) * height;")
      .replace(
        "const h = Math.max(1, (((row.endLine - row.startLine) * rowHeight) / contentHeight) * height - MM_BAR_ROW_GAP);",
        "const h = Math.max(1, ((row.endLine - row.startLine) / n) * height - MM_BAR_ROW_GAP);"
      );
    expect(regressed, "变异没落到源码里，这条自检是空转").not.toBe(mm);
    expect(regressed, "退回行序号尺就必须判红").toMatch(/row\.startLine \/ n\) \* height/);
    expect(regressed, "像素尺那条判据对变异样本必须失配").not.toMatch(
      /y = \(\(padTop \+ row\.startLine \* rowHeight\) \/ contentHeight\) \* height;/
    );
  });
});

describe("自检：几种退回都必须判红", () => {
  it("自检一：把 currentLine 圈回 buckets 依赖必须判红", () => {
    const mm = readScannedSource(MM);
    const regressed = mm.replace(
      "const buckets = useMemo(() => prepareMinimapBuckets(lines, rowLimit), [lines, rowLimit]);",
      "const buckets = useMemo(() => prepareMinimapBuckets(lines, rowLimit), [lines, rowLimit, currentLine]);"
    );
    expect(regressed, "变异没落到源码里，这条自检是空转").not.toBe(mm);
    expect(memoDeps(regressed, "const buckets = useMemo("), "依赖里多一个 currentLine 就必须整篇重算").not.toBe("lines, rowLimit");
  });

  it("自检二：留白退回可滚判断必须判红", () => {
    const view = readScannedSource(VIEW);
    const regressed = view.replace("const padRight = minimapReserved ?", "const padRight = canScrollContent ?");
    expect(regressed, "变异没落到源码里，这条自检是空转").not.toBe(view);
    expect(
      padLines(regressed).some((line) => /canScroll|scrollHeight|clientHeight/.test(line)),
      "留白跟着显隐变必须判红"
    ).toBe(true);
  });

  it("自检三：标尺退回全文 maxLen 必须判红", () => {
    const source = readScannedSource(LIB);
    const regressed = source
      .replace("const ruler = Math.max(", "const maxLen = Math.max(")
      .replace("longestInBucket / ruler", "longestInBucket / maxLen");
    expect(regressed, "变异没落到源码里，这条自检是空转").not.toBe(source);
    expect(regressed.includes("longestInBucket / ruler"), "第二处变异没落地").toBe(false);
    // 上面那条 `not.toMatch(/\bmaxLen\b/)` 必须能抓到这个形状
    expect(exportedBody(regressed, "prepareMinimapBuckets"), "退回 maxLen 必须判红").toMatch(/\bmaxLen\b/);
    expect(exportedBody(regressed, "prepareMinimapBuckets"), "ratio 丢掉触顶也必须判红").not.toMatch(
      /Math\.min\(1,\s*longestInBucket\s*\/\s*ruler\)/
    );
  });

  it("自检四：编辑态自己再画一份画布必须判红", () => {
    const editor = readScannedSource(EDITOR);
    const regressed = editor.replace(
      "const vars = {",
      `const drawSecondCanvas = (canvas: HTMLCanvasElement) => canvas.getContext("2d");\n  const vars = {`
    );
    expect(regressed, "变异没落到源码里，这条自检是空转").not.toBe(editor);
    expect(/getContext\("2d"\)/.test(regressed), "视图里冒出第二份 getContext 就必须判红").toBe(true);
  });

  it("自检五：尺寸观察的依赖退回空数组必须判红（缩略图重新出现后没人再量它）", () => {
    const mm = readScannedSource(MM);
    const regressed = mm.replace(
      "    // 依赖写 canScrollContent 而不是调用方的设置位：元素会因为「内容不满一屏」自己消失，",
      "    //\n    // 依赖写 canScrollContent 而不是调用方的设置位：元素会因为「内容不满一屏」自己消失，"
    );
    // 注释在剥过的源码里不存在，直接改依赖数组才是有效变异
    const real = mm.replace("  }, [canScrollContent]);", "  }, []);");
    expect(regressed, "改注释是空转变异（守卫读的是剥注释后的源码）").toBe(mm);
    expect(real, "变异没落到源码里，这条自检是空转").not.toBe(mm);
    const block = /const measure = \(\) => setMinimapSize\([\s\S]*?\}, \[([^\]]*)\]\);/.exec(real);
    expect(block?.[1] ?? "", "依赖退回空数组，重新挂载后没人再量它").not.toContain("canScrollContent");
  });
});
