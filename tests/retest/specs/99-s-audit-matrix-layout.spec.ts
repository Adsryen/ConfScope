// 轮34/35 F-35 真机复核：配置矩阵在短窗口下的布局下限、详情条 sticky、以及两处 chrome 的滚轮归属。
//
// 背景（PRD：.trellis/tasks/10-18-ui-ux-34-audit-matrix-collapse/prd.md）：应用默认窗口 1280x820，
// 执行完审计点开任意一行详情时，实测 .audit-matrix-body 高 0px、可见 0 行，真点击被 .audit-detail-head
// 拦到超时——171 行数据在 DOM 里却一行都看不见也点不动。根因是 .audit-page{display:flex;overflow:auto}
// 里只有 .audit-matrix{flex:1;min-height:0} 允许收缩，视口一矮它把挤压全吞掉，页面永不溢出（room 恒 0），
// 于是两处 sticky 没有行程、两条 chrome 条成了滚轮死区。甲方案三条 CSS 修好后，本用例把结论钉成回归。
//
// 口径（先把量法钉死再谈结论）：
//  1. 行高实测 48px、表头 58px、.audit-toolbar 恒 398px（与宽度无关）⇒ 矩阵上方固定块合计 651px，
//     所以「不滚动时视口内只剩 1~2 行」是正常现象；可见行数一律先把 .audit-page 推到底再按
//     .audit-matrix-body 的框数（boxRows），要求 ≥ 4 行，且这些行的下缘要高于详情条上缘（clearRows）。
//  2. sticky 只钉 .audit-detail（实测从 room-120 推到 room，条的 viewport top 位移 = 0）。
//     .audit-matrix-header 不写钉住判据：它的包含块是非滚动的 flex 父 .audit-matrix，自己又是第一个子项
//     ⇒ sticky 行程恒为 0（结构死），列头常驻靠的是 flex 布局而不是 sticky，实测它跟着内容走（dHeader=-120）。
//     判据见 .trellis/spec/frontend/quality-guidelines.md。
//  3. 滚轮按 Chromium 的实测归属钉：滚动命中会穿过不可滚的浮条，落到该点最上面的可滚节点，所以
//     表头条/摘要/筛选条 → 滚 .audit-page；详情条（此时它正盖在列表上）→ 滚 .audit-matrix-body；
//     滚到底脱离列表后往上滚 → 仍旧滚 .audit-page（能把整页退回去）；详情值框 → 自己有 overflow:auto
//     且 overscroll-behavior:contain，内容不足时是一小块不外溢的死区（R46 既有取舍，本轮不加第 5 个兜底根）。
//     若哪天 Chromium 的滚动命中口径变了，本用例会红在这里，需要重新取证而不是直接放宽断言。
import { expect, type Page } from "@playwright/test";
import { test } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog } from "./ui";

/** 一格滚轮的像素量：Chromium 的 mouse.wheel 走 deltaMode=0，120 就是 120px。 */
const WHEEL_STEP = 120;
/** 甲方案下限：.audit-matrix{min-height:280px} ⇒ 表头 58 + 列表体 ≥ 220 ⇒ 框内 4 整行（行高 48）。 */
const MATRIX_MIN_H = 280;
const BODY_MIN_H = 220;
const MIN_ROWS = 4;
/** 详情条不许被 flex 压扁（改前实测 2px）：head 51 + body 74 = 125。 */
const DETAIL_MIN_H = 110;

interface Snap {
  clientH: number;
  room: number;
  scrollTop: number;
  hOver: number;
  matrixH: number;
  headerH: number;
  bodyH: number;
  bodyBottom: number;
  detailH: number;
  detailTop: number;
  boxRows: number;
  clearRows: number;
  rows: number;
  rowH: number;
}

interface Scrollers {
  page: { top: number; room: number };
  body: { top: number; room: number };
  values: { top: number; room: number }[];
}

/** 页面侧快照：逐块高度 + 框内整行数 + 不被详情条盖住的整行数。 */
function readSnap(): Snap {
  const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
  const page = q(".audit-page");
  const matrix = q(".audit-matrix");
  const header = q(".audit-matrix-header");
  const body = q(".audit-matrix-body");
  const detail = q(".audit-detail");
  if (!page || !matrix || !header || !body) throw new Error("配置矩阵元素缺失（.audit-page/.audit-matrix/-header/-body）");
  const rows = Array.from(body.querySelectorAll(".audit-matrix-row")) as HTMLElement[];
  const br = body.getBoundingClientRect();
  const barTop = detail ? detail.getBoundingClientRect().top : window.innerHeight;
  const inBox = rows.filter((r) => {
    const x = r.getBoundingClientRect();
    return x.top >= br.top - 1 && x.bottom <= br.bottom + 1;
  });
  return {
    clientH: Math.round(page.clientHeight),
    room: Math.round(page.scrollHeight - page.clientHeight),
    scrollTop: Math.round(page.scrollTop),
    hOver: Math.round(page.scrollWidth - page.clientWidth),
    matrixH: Math.round(matrix.getBoundingClientRect().height),
    headerH: Math.round(header.getBoundingClientRect().height),
    bodyH: Math.round(body.getBoundingClientRect().height),
    bodyBottom: Math.round(br.bottom),
    detailH: detail ? Math.round(detail.getBoundingClientRect().height) : 0,
    detailTop: detail ? Math.round(detail.getBoundingClientRect().top) : window.innerHeight,
    boxRows: inBox.length,
    clearRows: inBox.filter((r) => r.getBoundingClientRect().bottom <= barTop + 1).length,
    rows: rows.length,
    rowH: rows.length ? Math.round(rows[0].getBoundingClientRect().height) : 0,
  };
}

/** 滚轮监控容器：页面根 + 列表体 + 两个环境值框（钉住的是归属，不是某一个 class）。 */
function readScrollers(): Scrollers {
  const out = {
    page: { top: 0, room: 0 },
    body: { top: 0, room: 0 },
    values: [] as { top: number; room: number }[],
  };
  const p = document.querySelector(".audit-page") as HTMLElement | null;
  const b = document.querySelector(".audit-matrix-body") as HTMLElement | null;
  if (p) out.page = { top: Math.round(p.scrollTop), room: Math.round(p.scrollHeight - p.clientHeight) };
  if (b) out.body = { top: Math.round(b.scrollTop), room: Math.round(b.scrollHeight - b.clientHeight) };
  document.querySelectorAll(".audit-detail-value").forEach((el) => {
    const v = el as HTMLElement;
    out.values.push({ top: Math.round(v.scrollTop), room: Math.round(v.scrollHeight - v.clientHeight) });
  });
  return out;
}

/** 把页面/列表的滚动位置拨回已知起点：停在底部会被误判成「没接管」。 */
function setPrime(bottom: boolean): void {
  const p = document.querySelector(".audit-page") as HTMLElement;
  const b = document.querySelector(".audit-matrix-body") as HTMLElement;
  b.scrollTop = 0;
  p.scrollTop = bottom ? p.scrollHeight - p.clientHeight : 0;
}

/** sticky 行程：从 room-step 推到 room，量条/表头的 viewport top 变化（room 不足时返回 0 行程）。 */
function stickyTravel(step: number): { room: number; dDetail: number; dHeader: number } {
  const p = document.querySelector(".audit-page") as HTMLElement;
  const detail = document.querySelector(".audit-detail") as HTMLElement | null;
  const header = document.querySelector(".audit-matrix-header") as HTMLElement | null;
  const room = Math.round(p.scrollHeight - p.clientHeight);
  if (!detail || !header || room <= step) return { room, dDetail: 0, dHeader: 0 };
  p.scrollTop = room - step;
  const d0 = Math.round(detail.getBoundingClientRect().top);
  const h0 = Math.round(header.getBoundingClientRect().top);
  p.scrollTop = room;
  return {
    room,
    dDetail: Math.round(detail.getBoundingClientRect().top) - d0,
    dHeader: Math.round(header.getBoundingClientRect().top) - h0,
  };
}

async function bootstrap(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
}

async function runMatrixAudit(page: Page): Promise<void> {
  await navigate(page, "配置矩阵");
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "+ 环境" }).click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "执行审计" }).click();
  await expect(page.locator(".audit-matrix-body .audit-matrix-row").first()).toBeVisible({ timeout: 60_000 });
}

/** 落点 = 元素矩形中心；前后各读一次所有滚动容器，返回位移表 + elementFromPoint 的命中。 */
async function wheelZone(page: Page, sel: string, dy: number, nth = 0) {
  const box = await page.locator(sel).nth(nth).boundingBox();
  expect(box, `滚轮落点元素缺失或不可见：${sel}`).not.toBeNull();
  const x = Math.round(box!.x + box!.width / 2);
  const y = Math.round(box!.y + box!.height / 2);
  await page.mouse.move(x, y);
  await page.waitForTimeout(120);
  const before = await page.evaluate(readScrollers);
  await page.mouse.wheel(0, dy);
  await page.waitForTimeout(320);
  const after = await page.evaluate(readScrollers);
  const hit = await page.evaluate(
    (pt: number[]) => {
      const el = document.elementFromPoint(pt[0], pt[1]);
      return el ? `${el.tagName.toLowerCase()}.${((el as HTMLElement).className || "").toString().trim().split(/\s+/)[0]}` : "null";
    },
    [x, y]
  );
  const values = after.values.map((v, i) => ({
    delta: Math.round(v.top - (before.values[i]?.top ?? 0)),
    room: v.room,
  }));
  return {
    sel,
    point: [x, y] as [number, number],
    hit,
    dPage: Math.round(after.page.top - before.page.top),
    dBody: Math.round(after.body.top - before.body.top),
    values,
    rooms: { page: after.page.room, body: after.body.room },
  };
}

const VIEWPORTS: [number, number][] = [
  [1280, 820], // main.go 默认窗口
  [1280, 790], // 默认窗口扣掉标题栏
  [1280, 700],
  [1280, 600], // MinHeight
  [1440, 900],
  [1920, 1080],
];

test("F35 配置矩阵短窗口布局 + sticky + chrome 滚轮分区", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  await republishRetestData();

  await page.setViewportSize({ width: 1280, height: 820 });
  await bootstrap(page);
  await runMatrixAudit(page);

  // ── AC1：详情未开时列表就不该塌 ──
  await page.evaluate(setPrime, false);
  const a = await page.evaluate(readSnap);
  console.log(`A 1280x820 详情未开 ${JSON.stringify(a)}`);
  expect(a.rows, "审计应产出多行矩阵").toBeGreaterThanOrEqual(20);
  expect(a.rowH, "行高实测 48px").toBeGreaterThanOrEqual(40);
  expect(a.matrixH, "AC1 .audit-matrix 不低于下限").toBeGreaterThanOrEqual(MATRIX_MIN_H);
  expect(a.bodyH, "AC1 列表体 ≥ 220px").toBeGreaterThanOrEqual(BODY_MIN_H);
  expect(a.hOver, "AC7 无横向溢出").toBe(0);

  // ── AC2：打开详情后仍要 ≥ 4 整行，且第 4 行点得动 ──
  await page.locator(".audit-matrix-body .audit-matrix-row").first().click();
  await expect(page.locator(".audit-detail").first()).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(300);

  for (const [w, h] of VIEWPORTS) {
    await page.setViewportSize({ width: w, height: h });
    await page.evaluate(setPrime, false);
    const top = await page.evaluate(readSnap);
    await page.evaluate(setPrime, true);
    const bottom = await page.evaluate(readSnap);
    const travel = await page.evaluate(stickyTravel, WHEEL_STEP);
    console.log(`V ${w}x${h} top=${JSON.stringify(top)} bottom=${JSON.stringify(bottom)} travel=${JSON.stringify(travel)}`);

    expect(top.matrixH, `AC2 ${w}x${h} .audit-matrix 保住下限`).toBeGreaterThanOrEqual(MATRIX_MIN_H);
    expect(top.bodyH, `AC2 ${w}x${h} 列表体 ≥ 220px`).toBeGreaterThanOrEqual(BODY_MIN_H);
    expect(top.detailH, `AC2 ${w}x${h} 详情条不被压扁`).toBeGreaterThanOrEqual(DETAIL_MIN_H);
    expect(top.hOver, `AC7 ${w}x${h} 无横向溢出`).toBe(0);
    expect(bottom.boxRows, `AC2 ${w}x${h} 滚到底框内整行 ≥ ${MIN_ROWS}`).toBeGreaterThanOrEqual(MIN_ROWS);
    if (bottom.room > 0) {
      expect(Math.abs(bottom.scrollTop - bottom.room), `AC3 ${w}x${h} 页面真的滚得到底`).toBeLessThanOrEqual(1);
      // 整行都落在详情条上方：键盘走查（F-29/F-61）靠 scroll-padding-bottom 让位，肉眼不会再看到被盖住的行。
      expect(bottom.clearRows, `AC2 ${w}x${h} 整行离开浮条 ≥ ${MIN_ROWS}`).toBeGreaterThanOrEqual(MIN_ROWS);
      expect(bottom.bodyBottom, `AC2 ${w}x${h} 列表下缘在详情条之上`).toBeLessThanOrEqual(bottom.detailTop + 1);
      // 详情条 sticky;bottom:0 复活：推到最底过程中顶边不动（表头那条不写判据，见文件头口径 2）。
      expect(Math.abs(travel.dDetail), `AC3 ${w}x${h} 详情条钉住位移 ≤ 2px`).toBeLessThanOrEqual(2);
      if (travel.dHeader > 0) console.log(`NOTE ${w}x${h} 表头出现钉住位移 dHeader=${travel.dHeader}：矩阵 DOM 变了，回来重判 sticky 生死`);
    } else {
      // 1920x1080 这类高窗口：甲方案零影响，页面本来就不需要滚。
      expect(bottom.room, `AC7 ${w}x${h} 高窗口不该被留白顶出可滚余量`).toBe(0);
      expect(bottom.clearRows, `AC7 ${w}x${h} 不滚动也要看得见 ≥ ${MIN_ROWS} 整行`).toBeGreaterThanOrEqual(MIN_ROWS);
    }

    // 真点击：改前这里 5s 超时（.audit-detail-head 压在行的矩形上）。
    const fourth = page.locator(".audit-matrix-body .audit-matrix-row").nth(MIN_ROWS - 1);
    await fourth.click({ timeout: 5_000 });
    const hitCell = await page.evaluate((index: number) => {
      const rows = document.querySelectorAll(".audit-matrix-body .audit-matrix-row") as NodeListOf<HTMLElement>;
      const r = rows[index].getBoundingClientRect();
      const el = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      return el ? `${el.tagName.toLowerCase()}.${((el as HTMLElement).className || "").toString().trim().split(/\s+/)[0]}` : "null";
    }, MIN_ROWS - 1);
    expect(hitCell, `AC2 ${w}x${h} 第 4 行中心应命中单元格`).toContain("audit-cell");
    await page.waitForTimeout(200);
  }

  // ── AC4：两处 chrome 条的滚轮归属（1280x820 默认窗口，详情开着）──
  await page.setViewportSize({ width: 1280, height: 820 });

  for (const sel of [".audit-matrix-header", ".audit-summary", ".audit-filter-bar"]) {
    await page.evaluate(setPrime, false);
    const r = await wheelZone(page, sel, WHEEL_STEP);
    console.log(`W ${sel} ${JSON.stringify(r)}`);
    expect(r.dPage, `AC4 ${sel} 交还原生滚 .audit-page（改前 moved={} 死区）`).toBe(Math.min(WHEEL_STEP, r.rooms.page));
    expect(r.dBody, `AC4 ${sel} 不许抢列表体的滚动`).toBe(0);
  }

  for (const sel of [".audit-detail", ".audit-detail-head"]) {
    await page.evaluate(setPrime, false);
    const r = await wheelZone(page, sel, WHEEL_STEP);
    console.log(`W ${sel} ${JSON.stringify(r)}`);
    // 此时详情条正盖在列表上，滚动命中穿过浮条落到 .audit-matrix-body（实测 dBody=+120 / dPage=0）；
    // 钉的用户诉求是「这一格不是死区」，所以只要求整页或列表至少滚掉一格。
    expect(r.dPage + r.dBody, `AC4 ${sel} 不能是谁都不动的死区`).toBeGreaterThanOrEqual(WHEEL_STEP);
  }

  await page.evaluate(setPrime, false);
  const valueZone = await wheelZone(page, ".audit-detail-value", WHEEL_STEP);
  console.log(`W .audit-detail-value ${JSON.stringify(valueZone)}`);
  expect(valueZone.dPage, "值框这一格由 overscroll-behavior:contain 钉住，不外溢到页面").toBe(0);
  expect(valueZone.dBody, "值框这一格由 overscroll-behavior:contain 钉住，不外溢到列表").toBe(0);
  expect(valueZone.values[0].delta, "值框自己可滚时归它自己").toBe(Math.min(WHEEL_STEP, valueZone.values[0].room));

  // 滚到底（详情条脱离列表）后往上滚一格：必须能把整页退回去，不然用户被钉住的条卡死在底部。
  await page.evaluate(setPrime, true);
  const escape = await wheelZone(page, ".audit-detail-head", -WHEEL_STEP);
  console.log(`W 钉住态往上 .audit-detail-head ${JSON.stringify(escape)}`);
  expect(escape.dPage, "钉住态往上滚应退整页").toBe(-WHEEL_STEP);

  // ── AC2 收口：关掉详情，布局回到「详情未开」那一档 ──
  await page.evaluate(setPrime, false);
  const close = page.locator(".audit-detail-actions button", { hasText: "关闭" });
  if (await close.count()) {
    await close.first().click();
    await expect(page.locator(".audit-detail")).toHaveCount(0, { timeout: 10_000 });
  }
  await page.evaluate(setPrime, true);
  const c = await page.evaluate(readSnap);
  console.log(`C 1280x820 详情已关 ${JSON.stringify(c)}`);
  expect(c.matrixH).toBeGreaterThanOrEqual(MATRIX_MIN_H);
  expect(c.bodyH).toBeGreaterThanOrEqual(BODY_MIN_H);
  expect(c.hOver).toBe(0);

  await page.evaluate(setPrime, false);
  await page.locator(".audit-matrix-body .audit-matrix-row").first().click();
  await page.waitForTimeout(300);
  await page.evaluate(setPrime, true);
  await page.screenshot({ path: "results/99-s-audit-matrix-820-bottom.png" });
});
