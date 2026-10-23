// 轮67 R67-WP3a/3b：设置页左栏必须回答「现在在哪一节」，点完索引焦点要交给那一节（真机量）。
//
// 为什么必须有真机这一条：判据是「章节顶缘相对容器上缘的偏移」，jsdom 里所有矩形恒为 0，
// 组件测试只能验「点了之后高亮在点的那一项」，验不到「滚到中间时高亮跟着真实位置」；
// 焦点交接的 preventScroll 也只有真浏览器能证明没有二次滚动。
import { expect, test } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog } from "./ui";
import { writeFileSync } from "node:fs";

interface SpyReading {
  activeId: string | null;
  expectedId: string | null;
  activeAria: string | null;
  activeHasClass: boolean;
  focusId: string | null;
  panelsTop: number;
  scrollBefore: number;
  scrollAfter: number;
}

const readSpy = `(() => {
  const panels = document.querySelector(".settings-panels");
  const items = Array.from(document.querySelectorAll(".settings-rail-item"));
  const active = items.find((el) => el.getAttribute("aria-current") === "true") || null;
  const panelsTop = panels.getBoundingClientRect().top;
  let expected = null;
  document.querySelectorAll(".settings-panels section[id^='settings-']").forEach((sec) => {
    if (sec.getBoundingClientRect().top - panelsTop <= 24) expected = sec.id;
  });
  return {
    activeId: active ? active.getAttribute("data-nav-id") : null,
    expectedId: expected,
    activeAria: active ? active.getAttribute("aria-current") : null,
    activeHasClass: active ? active.className.includes("active") : false,
    focusId: document.activeElement ? document.activeElement.id : null,
    panelsTop: Math.round(panelsTop),
    scrollBefore: 0,
    scrollAfter: Math.round(panels.scrollTop),
  };
})()`;

test("R67-WP3 左栏跟随位置、点击钉住、焦点交接", async ({ page, retest }) => {
  test.setTimeout(240_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await page.goto("/");
  await dismissStartupDialog(page);
  await page.setViewportSize({ width: 1280, height: 820 });
  await navigate(page, "设置");
  await page.waitForSelector(".settings-workbench");
  await page.waitForTimeout(900);

  // 给每项打上可读回的标识（不改产品代码，只为把「高亮落在第几项」换成章节 id）
  await page.evaluate(() => {
    const ids = ["settings-general", "settings-network", "settings-compare", "settings-credentials", "settings-backup", "settings-data-locations", "settings-update", "settings-developer"];
    document.querySelectorAll(".settings-rail-item").forEach((el, index) => el.setAttribute("data-nav-id", ids[index]));
  });

  const atTop = await page.evaluate(readSpy);
  expect(atTop.activeId, "停在面板顶部时高亮应在第一节").toBe("settings-general");
  expect(atTop.activeHasClass).toBe(true);

  // ① 用户自己滚：高亮必须跟着真实位置走
  await page.evaluate(() => {
    const panels = document.querySelector(".settings-panels");
    const target = document.getElementById("settings-backup");
    panels.scrollTop = panels.scrollTop + target.getBoundingClientRect().top - panels.getBoundingClientRect().top - 100;
  });
  await page.waitForTimeout(400);
  const scrolled = await page.evaluate(readSpy);
  expect(scrolled.activeId, `滚到 ${scrolled.expectedId} 附近时高亮应跟着位置，实际停在 ${scrolled.activeId}`).toBe(scrolled.expectedId);
  expect(scrolled.activeId).not.toBe("settings-general");

  // ② 点最后一项：立刻钉住，动画结束也不许被中间章节抢走
  const before = await page.evaluate("document.querySelector('.settings-panels').scrollTop");
  await page.locator(".settings-rail-item").nth(7).click();
  await page.waitForTimeout(1_500);
  const jumped = await page.evaluate(readSpy);
  expect(jumped.scrollAfter).toBeGreaterThan(before as number);
  expect(jumped.activeId, "点「开发者」后高亮不许赖在中间某一节").toBe("settings-developer");
  expect(jumped.focusId, "焦点没交给目标章节").toBe("settings-developer");

  // ③ 滚轮 = 用户表态，交还位置判定
  await page.hover(".settings-panels");
  await page.mouse.wheel(0, -1_200);
  await page.waitForTimeout(500);
  const wheeled = await page.evaluate(readSpy);
  expect(wheeled.activeId, `滚轮之后高亮应回到位置判定的 ${wheeled.expectedId}`).toBe(wheeled.expectedId);

  // ④ 输入框里按方向键不算滚页面
  await page.locator(".settings-proxy-grid input").first().click();
  const pinnedBefore = await page.evaluate(readSpy);
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(300);
  const typed = await page.evaluate(readSpy);
  expect(typed.activeId).toBe(pinnedBefore.activeId);

  await page.screenshot({ path: "results/r67-wp3-rail-spy.png", fullPage: false });
  writeFileSync("/tmp/cs/wp3-readings.txt", JSON.stringify({ atTop, scrolled, jumped, wheeled, typed }, null, 2));
});
