// 轮38 R94 真机永久回归：逐文本节点量「实测前景 vs 实际生效背景」的对比度，真不达 AA 必须为 0。
//
// 为什么要真机量，而不是只靠静态守卫（tests/ux/contrastTokens.test.ts）：
// 静态只能算「同一个规则块里」的配对。实际渲染的底是祖先链一层层叠出来的，还夹着
// 半透明状态底（`.env-badge.env-other` 的 rgba(158,158,158,.15) 叠 --bg3 实测 #3e3e41，
// --text-dim 在上面只有 4.08:1 —— token 够 ≠ 渲染够）和祖先降透明（`.btn:disabled{opacity:.45}`）。
// 两条守卫互补：静态守写法，真机守渲染。
//
// 三桶判据（轮38 建线取证口径，改判据必须先重跑取证，不许放宽断言）：
//   A real      —— 正常启用、无祖先降透明 ⇒ 真不达，本用例唯一该红的东西。
//   B inactive  —— 命中 `:disabled` / `[disabled]` / `[aria-disabled]` 或祖先 opacity<1
//                  ⇒ WCAG 1.4.3「非活动 UI 组件」豁免，只记不修。
//   C invisible —— 祖先链累积 opacity < 0.05 ⇒ 折叠态压根没渲染（`.diff-source-summary{opacity:0}`），
//                  v1 探针把这 40 个节点算成 1.00:1 假阳性，就是没做累积 opacity。
//
// 轮38 修掉的 7 组（--accent 作文字 ×4、硬编码次级灰 ×1、tint chip ×2、饱和填充上的深字 ×1）
// 见 .trellis/tasks/10-19-ui-ux-38-accent-tint-chip/prd.md 的实测表。
import { expect, test } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog } from "./ui";

interface ContrastOpts {
  normal: number;
  large: number;
  largePx: number;
  largeBoldPx: number;
  invisibleBelow: number;
}

interface ContrastGroup {
  key: string;
  n: number;
  min: number;
  ex: string[];
  cls: string[];
  fg: string;
  bg: string;
  rawFg: string;
  size: number;
  bold: boolean;
  need: number;
  why: string[];
}

interface ContrastReport {
  scanned: number;
  unknown: number;
  invisible: number;
  inactive: number;
  A: ContrastGroup[];
  B: ContrastGroup[];
}

/**
 * 浏览器侧执行：必须自包含（不能引用外部作用域），所以阈值一律经参数传入。
 * 前景 = computed color × 自身 alpha × 祖先链累积 opacity；背景 = 祖先非透明 background-color 从外到内叠加。
 */
function scanContrast(o: ContrastOpts): ContrastReport {
  const parse = (s: string): [number, number, number, number] | null => {
    const m = /rgba?\(([^)]+)\)/.exec(s || "");
    if (!m) return null;
    const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number);
    return [p[0] || 0, p[1] || 0, p[2] || 0, p.length >= 4 ? p[3] : 1];
  };
  const over = (fg: number[], bg: number[]): number[] => [
    fg[0] * fg[3] + bg[0] * (1 - fg[3]),
    fg[1] * fg[3] + bg[1] * (1 - fg[3]),
    fg[2] * fg[3] + bg[2] * (1 - fg[3]),
  ];
  const lum = (c: number[]) => {
    const f = (v: number) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a: number[], b: number[]) => {
    const L1 = lum(a);
    const L2 = lum(b);
    return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
  };
  const hex = (c: number[]) => "#" + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  const vis = (el: Element, cs: CSSStyleDeclaration) => {
    if (cs.visibility === "hidden" || cs.display === "none") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const opChain = (el: Element, self: number): number => {
    let v = self;
    let cur: Element | null = el.parentElement;
    while (cur) {
      v *= Number(getComputedStyle(cur).opacity || "1");
      cur = cur.parentElement;
    }
    return v;
  };
  const bgOf = (el: Element | null) => {
    const layers: number[][] = [];
    let unknown = false;
    let cur: Element | null = el;
    while (cur) {
      const cs = getComputedStyle(cur);
      const b = parse(cs.backgroundColor);
      if (b && b[3] > 0) layers.unshift([b[0], b[1], b[2], b[3]]);
      const bi = cs.backgroundImage;
      if (bi && bi !== "none" && !/^(repeating-)?linear-gradient\(transparent/.test(bi)) unknown = true;
      cur = cur.parentElement;
    }
    let acc: number[] = [255, 255, 255];
    for (const l of layers) acc = over(l, acc.length === 3 ? [...acc, 1] : acc);
    return { rgb: layers.length ? acc : null, unknown };
  };

  type Bag = Record<string, {
    n: number; min: number; ex: string[]; cls: string[]; fg: string; bg: string;
    rawFg: string; size: number; bold: boolean; need: number; why: string[];
  }>;
  const mk = (): Bag => ({});
  const A = mk();
  const B = mk();
  let scanned = 0;
  let unknown = 0;
  let invisible = 0;
  let inactive = 0;

  const add = (bag: Bag, el: Element, fg: string, bg: string, rawFg: string, r: number,
               size: number, bold: boolean, need: number, txt: string, why: string) => {
    const key = `${rawFg}@${fg}@${bg}|${Math.round(size)}|${bold ? "b" : "n"}`;
    const g = (bag[key] = bag[key] || {
      n: 0, min: 99, ex: [], cls: [], fg, bg, rawFg, size: Math.round(size), bold, need, why: [],
    });
    g.n += 1;
    g.min = Math.min(g.min, Number(r.toFixed(2)));
    if (g.ex.length < 3) g.ex.push(txt.slice(0, 28));
    const cn = ((el as HTMLElement).className || el.tagName.toLowerCase()).slice(0, 46);
    if (!g.cls.includes(cn) && g.cls.length < 5) g.cls.push(cn);
    if (!g.why.includes(why)) g.why.push(why);
  };

  Array.from(document.querySelectorAll("*")).forEach((el) => {
    const cs = getComputedStyle(el);
    if (!vis(el, cs)) return;
    const txt = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3 && (n.textContent || "").trim().length)
      .map((n) => (n.textContent || "").trim())
      .join(" ");
    if (!txt) return;
    const fgA = parse(cs.color);
    if (!fgA) return;
    const bg = bgOf(el);
    if (!bg.rgb) return;
    if (bg.unknown) unknown += 1;
    scanned += 1;
    const effOp = opChain(el, Number(cs.opacity));
    if (effOp < o.invisibleBelow) {
      invisible += 1;
      return;
    }
    const fg = [...over([fgA[0], fgA[1], fgA[2], fgA[3] * effOp], bg.rgb), 1];
    const size = parseFloat(cs.fontSize) || 12;
    const bold = Number(cs.fontWeight) >= 700;
    const need = size >= o.largePx || (bold && size >= o.largeBoldPx) ? o.large : o.normal;
    const r = ratio(fg, bg.rgb);
    if (r >= need) return;
    const dis = el.closest(":disabled, [disabled], [aria-disabled='true']");
    const dimAncestor = el.parentElement
      ? Array.from(function* () {
          let c: Element | null = el.parentElement;
          while (c) { yield c; c = c.parentElement; }
        }()).find((c) => Number(getComputedStyle(c).opacity || "1") < 1)
      : undefined;
    const why = dis
      ? `disabled:${(dis as HTMLElement).className || dis.tagName}`
      : dimAncestor
        ? `opacity:${getComputedStyle(dimAncestor).opacity} on .${(dimAncestor as HTMLElement).className || dimAncestor.tagName.toLowerCase()}`
        : "";
    if (why) {
      inactive += 1;
      add(B, el, hex(fg), hex(bg.rgb), hex([fgA[0], fgA[1], fgA[2]]), r, size, bold, need, txt, why);
    } else {
      add(A, el, hex(fg), hex(bg.rgb), hex([fgA[0], fgA[1], fgA[2]]), r, size, bold, need, txt, "real");
    }
  });

  const flat = (bag: Bag) => Object.keys(bag).map((k) => ({ key: k, ...bag[k] })).sort((a, b) => a.min - b.min);
  return { scanned, unknown, invisible, inactive, A: flat(A), B: flat(B) };
}

/** 浏览器侧执行：量单个元素的 color × background 配对（用于 hover 态复核）。自包含。 */
function measurePair(el: HTMLElement, o: ContrastOpts) {
  const parse = (s: string): number[] | null => {
    const m = /rgba?\(([^)]+)\)/.exec(s || "");
    if (!m) return null;
    const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number);
    return [p[0] || 0, p[1] || 0, p[2] || 0, p.length >= 4 ? p[3] : 1];
  };
  const lum = (c: number[]) => {
    const f = (v: number) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const cs = getComputedStyle(el);
  const fg = parse(cs.color);
  const bg = parse(cs.backgroundColor);
  if (!fg || !bg || bg[3] < 1) return null;
  const size = parseFloat(cs.fontSize) || 12;
  const bold = Number(cs.fontWeight) >= 700;
  const need = size >= o.largePx || (bold && size >= o.largeBoldPx) ? o.large : o.normal;
  const L1 = lum(fg);
  const L2 = lum(bg);
  return { ratio: Number(((Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)).toFixed(2)), need, color: cs.color, background: cs.backgroundColor, text: (el.textContent || "").trim().slice(0, 20) };
}

const OPTS: ContrastOpts = { normal: 4.5, large: 3, largePx: 24, largeBoldPx: 18.66, invisibleBelow: 0.05 };
const VIEWS = ["配置浏览", "配置对比", "配置矩阵", "操作历史", "备份快照", "任务中心", "审计日志", "连接管理", "SSH 隧道", "设置", "关于"];

test("轮38 R94 全站文字对比度普查：真不达 AA 必须为 0", async ({ page, retest }) => {
  test.setTimeout(420_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await page.setViewportSize({ width: 1280, height: 820 });

  let scannedTotal = 0;
  let unknownTotal = 0;
  let invisibleTotal = 0;
  let inactiveTotal = 0;
  const real: Record<string, ContrastGroup & { states: string[] }> = {};

  const take = async (state: string) => {
    const r = await page.evaluate(scanContrast, OPTS);
    scannedTotal += r.scanned;
    unknownTotal += r.unknown;
    invisibleTotal += r.invisible;
    inactiveTotal += r.inactive;
    console.log(
      `CONTRAST ${state} 文本节点=${r.scanned} 渐变底=${r.unknown} 真不达组=${r.A.length} ` +
        `禁用豁免节点=${r.inactive} 折叠不可见节点=${r.invisible}`,
    );
    r.A.forEach((g) => {
      const s = (real[g.key] = real[g.key] || { ...g, states: [] });
      if (!s.states.includes(state)) s.states.push(state);
    });
  };

  for (const label of VIEWS) {
    await navigate(page, label);
    await page.waitForTimeout(700);
    await take(label);
  }

  // 带数据的深状态：选中文件（代码视图 476 文本节点）、矩阵详情（919 节点）、展开的 diff 来源面板
  await navigate(page, "配置浏览");
  await expect(page.locator(".browser-item").first()).toBeVisible({ timeout: 30_000 });
  await page.locator(".browser-item-id").filter({ hasText: "svc-legacy-prod.yaml" }).first().click();
  await expect(page.locator(".code-area").first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(600);
  await take("配置浏览+选中文件");

  await navigate(page, "配置矩阵");
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "+ 环境" }).click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "执行审计" }).click();
  await expect(page.locator(".audit-matrix-body .audit-matrix-row").first()).toBeVisible({ timeout: 60_000 });
  await page.locator(".audit-matrix-body .audit-matrix-row").first().click();
  await expect(page.locator(".audit-detail").first()).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(500);
  await take("配置矩阵+详情");

  await navigate(page, "配置对比");
  await page.waitForTimeout(600);
  await page.locator(".diff-source-toggle-edge").first().click().catch(() => {});
  await page.waitForTimeout(500);
  await take("配置对比+展开来源面板");

  const merged = Object.keys(real).map((k) => real[k]).sort((a, b) => a.min - b.min);
  console.log(
    `CONTRAST_SUMMARY ${JSON.stringify({
      scannedTotal, unknownTotal, invisibleTotal, inactiveTotal,
      realGroups: merged.length,
      realNodes: merged.reduce((s, x) => s + x.n, 0),
      merged,
    })}`,
  );

  // 防空转：解析器一旦失效（选择器改动 / evaluate 拿不到节点），三条地板都会先炸
  expect(scannedTotal, "13 个状态一共只量到这么点文本节点，普查多半没真正跑起来").toBeGreaterThan(1_500);
  expect(invisibleTotal, "一个折叠态不可见节点都没量到 ⇒ 累积 opacity 逻辑失效（B 桶会跟着漏）").toBeGreaterThan(0);
  expect(inactiveTotal, "一个禁用/降透明节点都没量到 ⇒ B 桶豁免逻辑失效").toBeGreaterThan(0);

  // 空转自检的正向对照：造一个已知不达 AA 的节点（#007acc on #2d2d30 = 3.04:1），必须被 A 桶抓到
  await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.id = "contrast-canary";
    probe.style.cssText = "position:fixed;left:-9999px;top:0;width:200px;color:#007acc;background:#2d2d30;font-size:12px;";
    probe.textContent = "canary accent text";
    const wrap = document.createElement("div");
    wrap.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;overflow:visible;";
    wrap.appendChild(probe);
    document.body.appendChild(wrap);
  });
  const canary = await page.evaluate(scanContrast, OPTS);
  await page.evaluate(() => document.getElementById("contrast-canary")?.parentElement?.remove());
  expect(
    canary.A.some((g) => g.rawFg === "#007acc" && g.min < 4.5),
    "注入的 3.04:1 探针节点没被抓到 ⇒ A 桶判据失效，上面的「真不达 = 0」不可信",
  ).toBe(true);

  expect(merged, "这些文字在实际渲染底色上不达 WCAG AA，且不属于禁用/折叠豁免").toEqual([]);
});

test("轮38 R92 hover 态蓝底按钮标签达标（白字在 --accent-h 上无解，故转黑）", async ({ page, retest }) => {
  test.setTimeout(180_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await page.setViewportSize({ width: 1280, height: 820 });
  await navigate(page, "设置");
  await page.waitForTimeout(800);

  const btn = page.locator(".btn-primary:visible").first();
  await expect(btn, "设置页找不到 .btn-primary，本用例失去意义").toBeVisible({ timeout: 20_000 });
  const rest = await btn.evaluate(measurePair, OPTS);
  await btn.hover();
  await page.waitForTimeout(200);
  const hov = await btn.evaluate(measurePair, OPTS);
  console.log(`CONTRAST_HOVER rest=${JSON.stringify(rest)} hover=${JSON.stringify(hov)}`);
  expect(rest, "默认态量不到 color×background 配对").not.toBeNull();
  expect(hov, "hover 态量不到 color×background 配对").not.toBeNull();
  expect(hov!.ratio, `hover 态 ${hov!.text}：${hov!.color} on ${hov!.background} 只有 ${hov!.ratio}:1`).toBeGreaterThanOrEqual(hov!.need);
  expect(rest!.ratio, `默认态 ${rest!.text}：${rest!.color} on ${rest!.background} 只有 ${rest!.ratio}:1`).toBeGreaterThanOrEqual(rest!.need);
});
