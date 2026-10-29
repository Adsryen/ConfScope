// r134：对比流程里「只想复制一侧，结果两侧同时被选中复制走」（用户原话见派工单）。
//
// 并排 diff 每行是「左行号 → 左 cell → 合并箭头 → 右行号 → 右格」的兄弟节点，选区取
// 文档序区间：串侧守卫类一被清空，这次拖选两侧的正文就都可选，复制出来左右粘在一起。
// 真机取证（2026-10-29，chromium）钉死两条事实，本文件按它们收口判据：
//  1. 从行号槽（user-select:none）起手，Chromium 不产生任何选区 —— 行号槽起手不是缺陷面；
//  2. 从 .diff-body 之外（头部标签栏 / 正文上方）起手往下拖进正文，pointerdown 落点不在
//     body 内，守卫类被清空，拖选进正文后两侧同时被选中 —— 这才是用户可感的复现路径。
// 判据读真实选区（document.getSelection().toString()），断言用「行多集」：
// 选区里右侧任何一行的出现次数不许超过左侧同文行的次数。用多集而不是子串，
// 是因为行序对调型 diff 里左行集合 == 右行集合，子串/单行匹配会误报。
//
// 坐标纪律（同一真机跑出的教训）：重复 key 警告条、词条回填、字体加载都会让 diff 区
// 在「行已出现」之后继续异步重排，量完坐标到 mouse.down 之间布局一移，落点就打到
// 横幅/头部/别的元素上，整次拖选读成空选区（上一轮 R1–R3 全部假红于「选区为空」，
// 而同坐标的手动诊断拖选选区正常——漂移就在这条缝里）。因此每次量坐标前：
//  - 等 document.fonts.ready；
//  - .diff-body 包围盒 + 警告条高度连续两轮（120ms 间隔）采样相同才算定稳；
//  - 量完后用 elementFromPoint 验落点确实落在起手元素上，没验过就回炉再稳再量（≤5 轮）。
import { test, expect } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog, setDiffSource } from "./ui";
import { loadRetestState } from "../state";

const state = loadRetestState();
const NS_A = state.nacos.a.namespace;
const NS_B = state.nacos.b.namespace;
const GROUP = "RETEST-PROD";
const BASE_B = state.nacos.b.baseUrl;

/** 确保 Nacos B 的 svc-gateway.yaml 是"生产"基线（写库类测试可能把它改成开发侧，导致 0 差异）。
 *  与 20-diff.spec.ts 同一口径：republishRetestData 重发种子 + 轮询确认。 */
async function ensureDiffBaseline(): Promise<void> {
  const tenant = NS_B === "public" ? "" : NS_B;
  const url = `${BASE_B}/v1/cs/configs?dataId=svc-gateway.yaml&group=${encodeURIComponent(GROUP)}&tenant=${encodeURIComponent(tenant)}`;
  const res = await fetch(url, { cache: "no-store" });
  const text = res.ok ? await res.text() : "";
  if (text && text.includes("开发环境")) {
    await republishRetestData();
    for (let i = 0; i < 5; i++) {
      const r2 = await fetch(url, { cache: "no-store" });
      const t2 = r2.ok ? await r2.text() : "";
      if (t2.includes("生产环境") && !t2.includes("开发环境")) return;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

interface DragPlan {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  /** 途经行（可见行）左右两侧逐行文本（trim 后，空侧为 ""）。 */
  leftLines: string[];
  rightLines: string[];
}

type StartSpec =
  | { kind: "cell"; side: "left" | "right" }
  | { kind: "gutter"; side: "left" | "right" }
  | { kind: "head"; side: "left" | "right" };

/** 布局定稳 = .diff-body 包围盒与警告条高度连续两轮（120ms 间隔）采样相同。 */
async function waitForStableRect(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const w = window as unknown as { __r134Settle?: string };
      const bodyEl = document.querySelector<HTMLElement>(".diff-body");
      if (!bodyEl) return false;
      const r = bodyEl.getBoundingClientRect();
      const warn = document.querySelector<HTMLElement>(".diff-panel .diff-warnings");
      const wr = warn ? warn.getBoundingClientRect() : null;
      const sig = [
        Math.round(r.top * 2),
        Math.round(r.left * 2),
        Math.round(r.width * 2),
        Math.round(r.height * 2),
        wr ? Math.round(wr.height * 2) : -1,
      ].join("/");
      const prev = w.__r134Settle;
      w.__r134Settle = sig;
      return prev === sig;
    },
    undefined,
    { timeout: 10_000, polling: 120 }
  );
}

/**
 * 量一次真人拖选：等布局定稳后按起手位取起点，终点统一在最后一行可见行的起手侧列，
 * 并用 elementFromPoint 验证落点确实落在起手元素上（没验过就回炉再稳再量）。
 * 返回途经行的左右逐行文本，供行多集断言。
 */
async function settledPlan(
  page: import("@playwright/test").Page,
  spec: StartSpec
): Promise<{ plan: DragPlan; hitOk: boolean; hit: string }> {
  let last: { plan: DragPlan; hitOk: boolean; hit: string } = {
    plan: { startX: 0, startY: 0, endX: 0, endY: 0, leftLines: [], rightLines: [] },
    hitOk: false,
    hit: "未测量",
  };
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>(".diff-body");
      if (el) {
        el.scrollTop = 0;
        el.scrollLeft = 0;
      }
    });
    await page.evaluate(() => document.fonts.ready);
    await waitForStableRect(page);
    last = await page.evaluate((s: StartSpec) => {
      const bodyEl = document.querySelector<HTMLElement>(".diff-body");
      if (!bodyEl) throw new Error("diff body 不存在");
      const panel = bodyEl.closest<HTMLElement>(".diff-panel");
      if (!panel) throw new Error("diff panel 不存在");
      const rows = Array.from(bodyEl.querySelectorAll<HTMLElement>(".diff-row"));
      const viewportH = window.innerHeight;
      const boxOf = (el: Element) => el.getBoundingClientRect();
      const visible = rows.filter((r) => {
        const b = boxOf(r);
        return b.height > 0 && b.top >= 0 && b.bottom <= viewportH;
      });
      if (visible.length < 2) throw new Error(`可见行不足 2（${visible.length}），没法量拖选`);
      const textOf = (r: HTMLElement, sel: string): string => {
        const el = r.querySelector<HTMLElement>(sel);
        return el ? (el.textContent ?? "").trim() : "";
      };
      const leftLines = visible.map((r) => textOf(r, ".diff-cell.left"));
      const rightLines = visible.map((r) => textOf(r, ".diff-cell.right"));
      if (leftLines.every((t) => !t) || rightLines.every((t) => !t)) {
        throw new Error("两侧都是空行，判据没有区分度");
      }
      const gutterOf = (r: HTMLElement, side: string): HTMLElement | null => {
        const gutters = r.querySelectorAll<HTMLElement>(".diff-gutter");
        return side === "left" ? (gutters[0] ?? null) : (gutters[1] ?? null);
      };
      let startEl: Element;
      if (s.kind === "head") {
        const heads = panel.querySelectorAll<HTMLElement>(".diff-head-cell");
        const el = s.side === "left" ? heads[0] : heads[heads.length - 1];
        if (!el) throw new Error("diff 头部标签不存在");
        startEl = el;
      } else if (s.kind === "gutter") {
        startEl = gutterOf(visible[0], s.side) ?? visible[0];
      } else {
        startEl = visible[0].querySelector<HTMLElement>(`.diff-cell.${s.side}`) ?? visible[0];
      }
      const endEl =
        s.kind === "head"
          ? (gutterOf(visible[visible.length - 1], s.side) ?? visible[visible.length - 1])
          : (visible[visible.length - 1].querySelector<HTMLElement>(`.diff-cell.${s.side}`) ??
            visible[visible.length - 1]);
      const sBox = boxOf(startEl);
      const eBox = boxOf(endEl);
      const startX = sBox.left + sBox.width / 2;
      const startY = sBox.top + sBox.height / 2;
      const endX = eBox.left + eBox.width / 2;
      const endY = eBox.top + eBox.height / 2;
      const hit = document.elementFromPoint(startX, startY);
      const hitOk = hit != null && (hit === startEl || startEl.contains(hit));
      return {
        plan: { startX, startY, endX, endY, leftLines, rightLines },
        hitOk,
        hit: hit ? `${hit.tagName}.${hit.className}` : "null",
      };
    }, spec);
    if (last.hitOk) return last;
    // 落点被偷走：布局在验证后又移了，回炉再稳再量。
    await page.waitForTimeout(250);
  }
  throw new Error(`落点验证连续 5 轮失败（最后一次打在 ${last.hit}），布局未定稳，不拖了`);
}

/** 竖向下拖（8 段步进模拟真实手势）并读选区文本。 */
async function dragAndReadSelection(page: import("@playwright/test").Page, plan: DragPlan): Promise<string> {
  const steps = 8;
  await page.mouse.move(plan.startX, plan.startY);
  await page.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(
      plan.startX + ((plan.endX - plan.startX) * i) / steps,
      plan.startY + ((plan.endY - plan.startY) * i) / steps
    );
  }
  await page.mouse.up();
  return page.evaluate(() => document.getSelection()?.toString() ?? "");
}

/**
 * 行多集判据：选区文本里，右侧任何一行的出现次数不得超过左侧同文行的次数。
 * 两侧同时被选中时，右侧独有行（或换行后的同文行）必然超数；只有一侧时被选行 ⊆ 起手侧行集合。
 */
function assertOneSideCopy(name: string, selText: string, plan: DragPlan, wantSide: "left" | "right", allowEmpty: boolean): void {
  if (allowEmpty && selText.trim() === "") {
    // Chromium 从 user-select:none 起手不产生选区（取证事实 1）：空选区不算两侧串选。
    return;
  }
  expect(selText, `${name}：选区为空，拖选没发生`).not.toBe("");
  const selLines = selText.split("\n").map((t) => t.trim()).filter((t) => t !== "");
  const count = (lines: string[]) => {
    const m = new Map<string, number>();
    for (const t of lines) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
  };
  const wantLines = count(wantSide === "left" ? plan.leftLines : plan.rightLines);
  const gotLines = count(wantSide === "left" ? plan.rightLines : plan.leftLines);
  const selCount = count(selLines);
  const leaks: string[] = [];
  for (const [line] of gotLines) {
    if (!line) continue;
    if ((selCount.get(line) ?? 0) > (wantLines.get(line) ?? 0)) leaks.push(`${line} ×${selCount.get(line)}（对侧仅 ${wantLines.get(line) ?? 0}）`);
  }
  expect(leaks, `${name}：对侧行混进了选区（两侧同时被选中）：${leaks.join("；")}\n选区=${JSON.stringify(selText.slice(0, 300))}`).toEqual([]);
  // 顺手钉住「起手侧真的被选到了」——防空转假绿。
  const wantAny = [...wantLines.keys()].find((t) => t !== "");
  if (wantAny && !allowEmpty) {
    expect(selLines.some((t) => t.includes(wantAny) || wantAny.includes(t)), `${name}：起手侧文本没进选区：${JSON.stringify(selText.slice(0, 200))}`).toBe(true);
  }
}

async function bootstrapDiff(page: import("@playwright/test").Page, retest: ReturnType<typeof loadRetestState>): Promise<void> {
  await installRetestBridge(page, retest);
  await republishRetestData();
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await ensureDiffBaseline();
  await navigate(page, "配置对比");
  await page.waitForTimeout(500);
  await setDiffSource(page, "left", { connection: "Retest Nacos A", namespace: NS_A, group: GROUP, dataId: "svc-gateway.yaml" });
  await setDiffSource(page, "right", { connection: "Retest Nacos B", namespace: NS_B, group: GROUP, dataId: "svc-gateway.yaml" });
  await page.getByRole("button", { name: "加载并对比" }).last().click();
  await expect(page.locator(".diff-panel")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".diff-row.modify, .diff-row.add, .diff-row.del")).not.toHaveCount(0);
}

test("R1 对照：从左侧正文格起手下拖 → 选区只含左侧", async ({ page, retest }) => {
  await bootstrapDiff(page, retest);
  const { plan } = await settledPlan(page, { kind: "cell", side: "left" });
  const selText = await dragAndReadSelection(page, plan);
  assertOneSideCopy("R1 正文格起手", selText, plan, "left", false);
  await page.screenshot({ path: "results/r134-r1-cell-start.png", fullPage: false });
});

test("R2 缺陷：从头部标签（body 外）起手拖进左列 → 选区只含左侧", async ({ page, retest }) => {
  await bootstrapDiff(page, retest);
  const { plan } = await settledPlan(page, { kind: "head", side: "left" });
  const selText = await dragAndReadSelection(page, plan);
  assertOneSideCopy("R2 头部起手进左列", selText, plan, "left", false);
  await page.screenshot({ path: "results/r134-r2-head-start-left.png", fullPage: false });
});

test("R3 对称：从头部标签（body 外）起手拖进右列 → 选区只含右侧", async ({ page, retest }) => {
  await bootstrapDiff(page, retest);
  const { plan } = await settledPlan(page, { kind: "head", side: "right" });
  const selText = await dragAndReadSelection(page, plan);
  assertOneSideCopy("R3 头部起手进右列", selText, plan, "right", false);
  await page.screenshot({ path: "results/r134-r3-head-start-right.png", fullPage: false });
});

test("R4 行号槽起手：选区至多含起手侧（Chromium 下允许空选区）", async ({ page, retest }) => {
  await bootstrapDiff(page, retest);
  const { plan } = await settledPlan(page, { kind: "gutter", side: "left" });
  const selText = await dragAndReadSelection(page, plan);
  assertOneSideCopy("R4 行号槽起手", selText, plan, "left", true);
  await page.screenshot({ path: "results/r134-r4-gutter-start.png", fullPage: false });
});
