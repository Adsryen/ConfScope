// 轮73 R73-I1：指针停在设置页左栏上，滚轮必须真的能滚正文（真机量）。
//
// 为什么必须有真机这一条：这一族的两个成因里，一个（左栏自己写了 overflow-y:auto +
// overscroll-behavior:contain）删掉 CSS 就够了，另一个（左栏不是 .settings-panels 的子孙、
// 祖先链上没有任何可滚容器，滚轮无处可去）只有真浏览器能证明——jsdom 不派发原生滚动，
// 也量不到 scrollTop 的实际变化。删掉 overflow 后实测仍旧是 0 → 0，就是这一条把它钉住的。
// 顺带钉住兜底的另一半：兜底直接写 scrollTop，容器上的 wheel 监听收不到事件，
// 不把位置判定交还出来的话，点过某一节之后高亮会赖在那一节不动。
import { expect, test } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog } from "./ui";

const readPanels = `(() => {
  const panels = document.querySelector(".settings-panels");
  const rail = document.querySelector(".settings-rail");
  const active = document.querySelector(".settings-rail-item.active");
  return {
    scrollTop: Math.round(panels.scrollTop),
    railScrollTop: Math.round(rail.scrollTop),
    railOverflowY: getComputedStyle(rail).overflowY,
    activeText: active ? active.textContent.trim() : null,
  };
})()`;

interface PanelsReading {
  scrollTop: number;
  railScrollTop: number;
  railOverflowY: string;
  activeText: string | null;
}

test("R73-I1 左栏不是滚轮死区：同一手势落在左栏与正文上滚得一样多", async ({ page, retest }) => {
  test.setTimeout(240_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await page.goto("/");
  await dismissStartupDialog(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await navigate(page, "设置");
  await page.waitForSelector(".settings-workbench");
  await page.waitForTimeout(900);

  await page.evaluate(() => {
    const panels = document.querySelector(".settings-panels");
    if (!panels) throw new Error("找不到 .settings-panels，正文滚动位置无从归零");
    panels.scrollTop = 0;
  });
  await page.waitForTimeout(300);
  const atTop = await page.evaluate<PanelsReading>(readPanels);
  expect(atTop.scrollTop, "起点应停在正文顶部").toBe(0);
  expect(atTop.railOverflowY, "左栏不许再自己滚动（必要条件的守卫在 tests/ux/settingsPageRhythmStaysAligned）").toBe("visible");

  // ① 手势落在左栏（面积最大、最容易被指针压住的那一列）
  await page.hover(".settings-rail");
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(500);
  const afterRail = await page.evaluate<PanelsReading>(readPanels);
  expect(afterRail.railScrollTop, "左栏自己攒出滚动条就是兜底失活的前兆").toBe(0);
  expect(afterRail.scrollTop, "指针停在左栏上滚 600px，正文一格都没动 —— 又变成死区了").toBeGreaterThanOrEqual(500);

  // ② 同一手势落在正文上：应当接着往下滚，而不是把左栏那一格当成「已经滚过」
  await page.hover(".settings-panel-head h4");
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(500);
  const afterHead = await page.evaluate<PanelsReading>(readPanels);
  expect(afterHead.scrollTop, "落在正文上的同一手势应比落在左栏上滚得更多或一样多").toBeGreaterThanOrEqual(afterRail.scrollTop);

  // ③ 兜底写的是 scrollTop，容器收不到 wheel：位置判定必须被交还，高亮不许赖在刚点过的那一节
  await page.locator(".settings-rail-item").nth(2).click();
  await page.waitForTimeout(1_500);
  const pinned = await page.evaluate<PanelsReading>(readPanels);
  expect(pinned.activeText, "点完索引应当钉住这一节").toBe("智能对比");
  await page.hover(".settings-rail");
  await page.mouse.wheel(0, -3_000);
  await page.waitForTimeout(700);
  const released = await page.evaluate<PanelsReading>(readPanels);
  const expected = await page.evaluate<string | null>(`(() => {
    const panels = document.querySelector(".settings-panels");
    const panelsTop = panels.getBoundingClientRect().top;
    let expected = null;
    document.querySelectorAll(".settings-panels section[id^='settings-']").forEach((sec) => {
      if (sec.getBoundingClientRect().top - panelsTop <= 24) expected = sec.querySelector("h4").textContent.trim();
    });
    return expected;
  })()`);
  expect(released.activeText, `滚轮之后高亮该跟着位置回到「${expected}」，实际停在 ${released.activeText}`).toBe(expected);

  await page.screenshot({ path: "results/r73-i1-rail-wheel.png", fullPage: false });
});
