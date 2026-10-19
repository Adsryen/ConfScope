// 轮37 R88 真机永久回归：可点击目标的「有效命中区」必须 ≥ 24x24 CSS px（WCAG 2.2 / 2.5.8）。
//
// 为什么要真机量而不是静态守（PRD：.trellis/tasks/10-19-ui-ux-37-visibility-scan/prd.md）：
// 盒尺寸是 padding / line-height / flex / 字号共同算出来的，grep 源码只能守字面量，
// 「写 24 但被 flex 压扁」和「写 22 但 label 撑到 30」两类都漏。轮37 建线时逐视图实测，
// 11 视图 + 5 个带数据状态里揪出 8 处不达（.btn.btn-sm 22、查找条 ✕/Aa 22、连接行 ⧉/× 22、
// 来源面板边条 36x18、复选框整行 15~17 高），全部按真实盒尺寸修到位，本用例负责守住不再掉回去。
//
// 量法（口径先钉死，改判据必须先重跑取证，不许放宽断言）：
//  1. 有效命中区 = 控件自身 rect ∪ 关联 label rect ∪ ::before/::after 扩击盒。
//     复选框本体只有 15px，但点 label 文字同样能勾 ⇒ 命中区是整行；反过来，行高 15 的整行仍然不达 24。
//     伪元素扩击本仓库有先例（.audit-add-env::before），不并上会把已达标的算成误报。
//  2. 行内例外：`display:inline` 且落在句子文本里的链接按 WCAG 2.5.8 Inline exception 免，
//     只允许 EXEMPT 白名单里那一条（新增例外要改 PRD 并写理由）。
//  3. disabled / 不可见 / 视口外控件不参与（用户点不到也就不构成命中区问题）。
import { test, expect } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog, setDiffSource } from "./ui";
import { loadRetestState } from "../state";

const state = loadRetestState();
const NS_A = state.nacos.a.namespace;
const NS_B = state.nacos.b.namespace;
const GROUP = "RETEST-PROD";

/** WCAG 2.2 / 2.5.8 Target Size (Minimum)。 */
const MIN_TARGET = 24;

/** 唯一豁免：关于页页脚 "Made with ❤️ by Adsryen" 里的行内链接（句子内，尺寸由行盒决定）。 */
const EXEMPT = [{ cls: "about-footer-link-inline-exempt", reason: "页脚句子内的行内链接，WCAG 2.5.8 Inline exception" }];

const VIEWS = ["配置浏览", "配置对比", "配置矩阵", "操作历史", "备份快照", "任务中心", "审计日志", "连接管理", "SSH 隧道", "设置", "关于"];
// 轮44 R88：与对比度普查同一口径，把「必须扫到的状态」写成清单。check() 是 async，
// 上一版这里有两处漏了 await，失败数组在断言之后才落账 ⇒ 报红被静默吞掉（假绿）。
// 现在每个状态扫完登记一次，末尾逐条比对，少一个状态就当场判红。
const DEEP_CHECKS = [
  "配置浏览+选中文件",
  "配置浏览+查找条",
  "配置浏览+内容搜索命中列表",
  "配置矩阵+结果",
  "配置矩阵+详情",
  "配置对比+结果",
  "侧边栏收起",
  "配置对比+匹配列表",
  "配置对比+批量结果",
];
const EXPECTED_CHECKS = [...VIEWS, ...DEEP_CHECKS];

interface TargetReport {
  fails: { sel: string; own: string; eff: string; inline: boolean; txt: string }[];
  scanned: number;
  exemptHits: number;
}

/** 浏览器侧执行：必须自包含（不能引用外部作用域变量），所以阈值以参数传入。 */
function scanTargets(minTarget: number): TargetReport {
  const R = (el: Element) => el.getBoundingClientRect();
  const cs = (el: Element, pseudo?: string) => getComputedStyle(el, pseudo || null);
  const cls = (el: Element) => {
    const c = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean) : [];
    return (el.tagName.toLowerCase() + (c.length ? "." + c.slice(0, 3).join(".") : "")).slice(0, 60);
  };
  const vis = (el: Element) => {
    const b = R(el);
    return b.width > 0 && b.height > 0 && cs(el).visibility !== "hidden" && cs(el).display !== "none";
  };
  const union = (a: { top: number; left: number; right: number; bottom: number }, b: DOMRect) => ({
    top: Math.min(a.top, b.top),
    left: Math.min(a.left, b.left),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
  });

  const SEL = "button, a[href], input:not([type=hidden]), select, textarea, [role='button'], [role='tab'], [role='checkbox'], [role='switch'], summary";
  const fails: TargetReport["fails"] = [];
  let scanned = 0;
  let exemptHits = 0;

  Array.from(document.querySelectorAll(SEL)).forEach((el) => {
    if (!vis(el)) return;
    if ((el as HTMLButtonElement).disabled) return;
    const own = R(el);
    let box = union(own, own);

    // ① 关联 label：点 label 文字同样能改控件 ⇒ 命中区要并上
    const asInput = el as HTMLInputElement;
    if (asInput instanceof HTMLInputElement && /(checkbox|radio)/.test(asInput.type)) {
      const lab: Element | null =
        el.closest("label") || (asInput.id ? document.querySelector(`label[for="${CSS.escape(asInput.id)}"]`) : null);
      if (lab && vis(lab)) box = union(box, R(lab));
    }
    // ② 伪元素扩击盒（绝对定位且带 content 的 ::before/::after）
    ["::before", "::after"].forEach((pseudo) => {
      const st = cs(el, pseudo);
      if (!st.content || st.content === "none" || st.content === "normal") return;
      if (st.position !== "absolute" && st.position !== "fixed") return;
      const w = st.width === "auto" ? own.width : parseFloat(st.width);
      const h = st.height === "auto" ? own.height : parseFloat(st.height);
      const t = parseFloat(st.top) || 0;
      const l = parseFloat(st.left) || 0;
      box = union(box, new DOMRect(own.left + l, own.top + t, w, h));
    });

    const w = Math.round(box.right - box.left);
    const h = Math.round(box.bottom - box.top);
    scanned += 1;
    if (Math.min(w, h) >= minTarget) return;

    // ③ 行内例外：句子内的 inline 链接（白名单只有一条，命中就计数，不命中即失败）
    const inlineInText = cs(el).display === "inline" && !!el.closest("p");
    if (inlineInText) {
      exemptHits += 1;
      return;
    }
    fails.push({
      sel: cls(el),
      own: `${Math.round(own.width)}x${Math.round(own.height)}`,
      eff: `${w}x${h}`,
      inline: inlineInText,
      txt: (el.textContent || asInput.value || el.getAttribute("aria-label") || asInput.placeholder || "").trim().slice(0, 18),
    });
  });

  return { fails, scanned, exemptHits };
}

test("R88 可点击目标有效命中区全站 ≥24px（11 视图 + 9 个带数据状态）", async ({ page, retest }) => {
  test.setTimeout(420_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await page.setViewportSize({ width: 1280, height: 820 });

  const failures: string[] = [];
  let totalScanned = 0;
  let totalExempt = 0;
  const statesChecked: string[] = [];

  const check = async (state: string) => {
    const r = await page.evaluate(scanTargets, MIN_TARGET);
    statesChecked.push(state);
    totalScanned += r.scanned;
    totalExempt += r.exemptHits;
    console.log(`R88 ${state} 控件=${r.scanned} 豁免=${r.exemptHits} 失败=${r.fails.length} ${JSON.stringify(r.fails)}`);
    r.fails.forEach((f) => failures.push(`${state} ${f.sel} 自身=${f.own} 有效=${f.eff} 文本=${f.txt}`));
  };

  for (const label of VIEWS) {
    await navigate(page, label);
    await page.waitForTimeout(700);
    await check(label);
  }

  // ── 带数据 / 带结果的五个状态（轮37 建线时 8 处不达里有 5 处只在这些状态下出现） ──
  await navigate(page, "配置浏览");
  await expect(page.locator(".browser-item").first()).toBeVisible({ timeout: 30_000 });
  await page.locator(".browser-item-id").filter({ hasText: "svc-legacy-prod.yaml" }).first().click();
  await expect(page.locator(".code-area").first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(500);
  await check("配置浏览+选中文件");

  await page.locator(".code-area").first().click({ position: { x: 40, y: 40 } });
  await page.keyboard.press("Control+f");
  await expect(page.locator(".code-find").first()).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(400);
  await check("配置浏览+查找条");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);

  // 轮44 R88：内容搜索（用户主场景）。这一档会把列表项换成「复选框 + 摘要」的形态，
  // .browser-result-check（实测 78x17）与 .browser-replace-btn 只在这里存在，以前普查从没扫过。
  // 扫完切回 DataId 模式，别把带色列表留给后面的状态。
  await page.locator(".browser-search-mode .btn", { hasText: "内容" }).first().click({ timeout: 15_000 });
  await page.locator(".browser-search .search-input").first().fill("enabled");
  await expect(page.locator(".browser-item-summary mark.search-hit").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".browser-result-check").first()).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(500);
  await check("配置浏览+内容搜索命中列表");
  await page.locator(".browser-search .search-input").first().fill("");
  await page.locator(".browser-search-mode .btn", { hasText: "文件名" }).first().click({ timeout: 15_000 });
  await page.waitForTimeout(250);

  await navigate(page, "配置矩阵");
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "+ 环境" }).click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "执行审计" }).click();
  await expect(page.locator(".audit-matrix-body .audit-matrix-row").first()).toBeVisible({ timeout: 60_000 });
  await check("配置矩阵+结果");
  await page.locator(".audit-matrix-body .audit-matrix-row").first().click();
  await expect(page.locator(".audit-detail").first()).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(400);
  await check("配置矩阵+详情");

  await page.locator(".audit-detail button", { hasText: "跳转 Diff 对比" }).click();
  await expect(page.locator(".diff-body, .diff-view").first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2_500);
  await check("配置对比+结果");

  await page.locator(".sidebar-toggle").click();
  await page.waitForTimeout(500);
  await check("侧边栏收起");
  await page.locator(".sidebar-toggle").click();
  await page.waitForTimeout(400);

  // ── 轮44 新增：对比页带结果的深状态（保活让它成为普查必须覆盖的常态） ──
  // 改造前对比页切走即卸载，这两屏只有用户手动跑批量时才出现，普查的「配置对比+结果」
  // 走的是审计矩阵跳转（不自动比对，页面上其实没有结果）。轮44 常驻挂载后上一次跑完的差异
  // 一直留在可见子树里，普查真的会扫到它们——实测正是这样揪出 .diff-workflow-step-btn(82x22)
  // 与 .diff-toggle(78x17) 两处不达 24px、以及 hljs-comment 在 diff 语义底色上的 3.49~4.17:1。
  await navigate(page, "配置对比");
  await page.waitForTimeout(600);
  await setDiffSource(page, "left", { connection: "Retest Nacos A", namespace: NS_A, group: GROUP });
  await setDiffSource(page, "right", { connection: "Retest Nacos B", namespace: NS_B, group: GROUP });
  await page.getByRole("button", { name: "加载并对比" }).last().click();
  await expect(page.locator(".match-list").filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(400);
  await check("配置对比+匹配列表");

  const matchBoxes = page.locator(".match-side-list.left .match-side-row input");
  await matchBoxes.nth(0).check();
  await matchBoxes.nth(1).check();
  await page.getByRole("button", { name: /对比选中/ }).last().click();
  await expect(page.locator(".batch-diff .batch-diff-nav-item").filter({ visible: true }).first()).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(500);
  await check("配置对比+批量结果");

  // 防漏 await 守卫：清单里的状态一个都不能少（少一个就是某处 check() 忘了 await）
  expect(
    [...new Set(statesChecked)].sort(),
    "普查覆盖的状态和清单不一致：多半是某处 check() 漏了 await，或新增状态没登记",
  ).toEqual(EXPECTED_CHECKS.slice().sort());

  // 白名单确实被用到（说明豁免逻辑没空转），且控件普查覆盖足够广
  expect(EXEMPT.length, "豁免白名单只允许已写明理由的那几条").toBe(1);
  expect(totalExempt, "行内例外至少要命中关于页页脚那一条链接").toBeGreaterThanOrEqual(1);
  expect(totalScanned, "普查覆盖的控件数不该退化成扫了个空页").toBeGreaterThan(60);
  expect(failures, `不达 ${MIN_TARGET}px 的控件必须为 0：\n${failures.join("\n")}`).toEqual([]);
});
