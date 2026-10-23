// 轮67 R67-WP1：设置页备份面板的失败提示必须落在看得见的一屏里（真机量）。
//
// 为什么必须有真机这一条：面板内容 2762px、可视只有 698px，提示块固定挂在面板最顶部。
// 滚到最底部点「上传当前数据」，失败提示出现在容器上方 top=-221 的位置——
// 组件测试只验得到「hook 被调了」，验不到「用户真的看见了它」。
// jsdom 没有布局引擎，这条只能在 Chromium 里量矩形。
import { expect, test } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog } from "./ui";
import { writeFileSync } from "node:fs";
// 轮67 R67-WP7 复用同一份真机口径：桥里的数据根是内存替身（每用例 resetRetestDataRoot 复位），
// 所以「换根成功 / 换根被拒」两条都能在真人点出来的界面上走一遍。
import { RETEST_DATA_ROOT_BASE, setRetestSelectDataRootTarget } from "../bridge/retestBinding";

interface NoticeReading {
  buttonTop: number;
  panelsTop: number;
  panelsBottom: number;
  scrollBefore: number;
  scrollAfter: number;
  noticeCount: number;
  noticeTop: number;
  noticeBottom: number;
  noticeInView: boolean;
  noticeText: string;
}

test("R67-WP1 面板底部动作失败后，提示自己滚进可视区", async ({ page, retest }) => {
  test.setTimeout(240_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await page.goto("/");
  await dismissStartupDialog(page);
  await page.setViewportSize({ width: 1280, height: 820 });
  await navigate(page, "设置");
  await page.waitForSelector(".settings-workbench");
  await page.waitForTimeout(900);

  const reading = await page.evaluate(async (): Promise<NoticeReading> => {
    const panels = document.querySelector(".settings-panels") as HTMLElement;
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>(".settings-page button")).find((b) =>
      (b.textContent || "").includes("上传当前数据")
    )!;
    // 真人怎么操作：滚到底部那一行，点它
    button.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const scrollBefore = Math.round(panels.scrollTop);
    button.click();

    const started = Date.now();
    while (!document.querySelector(".app-data-backup-panel [role='alert']") && Date.now() - started < 20_000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // 给自动滚动留一帧（smooth 需要时间跑完）
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    const notice = document.querySelector(".app-data-backup-panel [role='alert']") as HTMLElement | null;
    const box = notice?.getBoundingClientRect();
    const frame = panels.getBoundingClientRect();
    return {
      buttonTop: Math.round(button.getBoundingClientRect().top),
      panelsTop: Math.round(frame.top),
      panelsBottom: Math.round(frame.bottom),
      scrollBefore,
      scrollAfter: Math.round(panels.scrollTop),
      noticeCount: document.querySelectorAll(".app-data-backup-panel [role='alert']").length,
      noticeTop: box ? Math.round(box.top) : Number.NaN,
      noticeBottom: box ? Math.round(box.bottom) : Number.NaN,
      noticeInView: !!box && box.top >= frame.top - 1 && box.bottom <= frame.bottom + 1,
      noticeText: notice ? (notice.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60) : "",
    };
  });

  console.log("R67-WP1 读数:", JSON.stringify(reading));
  expect(reading.noticeCount, "点了底部动作却没有任何失败提示出现").toBe(1);
  expect(reading.noticeInView, `提示没在可视区：top=${reading.noticeTop} bottom=${reading.noticeBottom} 框=${reading.panelsTop}~${reading.panelsBottom}`).toBe(true);
  // 提示挂在面板顶部、按钮在底部，所以这次是往上滚：位移为负才对（轮67 实测 -221 那档）。
  // 断言只看「容器动了没有」与「提示进框了没有」，方向交给 noticeInView。
  expect(reading.scrollAfter, "容器滚动位置没动，提示不可能自己进框").not.toBe(reading.scrollBefore);
});

// ── 轮67 R67-WP7：数据目录一节的三条提示通道同样要落在看得见的一屏里 ──
//
// 为什么单独再量一节：R67-WP1 那波只把「出现即滚进可视区」接到了备份面板的两条通道上，
// 而这一节的「需重启」横幅与两条失败提示原先挂在本节**最末尾**——真机修前读数（/tmp/cs/wp7-probe.txt）：
// 容器可视区底边 798，提示块顶边 884，86px 在框外。用户点完「更改位置…」、确认框一关，屏幕上
// 什么都不动，只会认为「按钮没反应」再点一次。
// 光接 hook 还不够：提示挂节尾时，迁移成功后 refreshDataSurfaces() 才落地，它上方那 7 行路径又长高
// 23px，把刚滚进框的提示重新顶出去（实测 top=785 bottom=821 / 框 100~798，关闭键正好被裁）。
// 所以三条提示一并挂到节首——提示之上只剩静态标题，迟到内容一律在下方生长，落点才稳。
interface SectionNoticeReading {
  containerTop: number;
  containerBottom: number;
  scrollBefore: number;
  scrollAfter: number;
  noticeCount: number;
  noticeTop: number;
  noticeBottom: number;
  inView: boolean;
  text: string;
  closeW: number;
  closeH: number;
  closeName: string;
  noticeRole: string;
}

/** 浏览器侧执行：必须自包含，选择器一律经参数传入。 */
function readNotice(args: [string, number, string]): SectionNoticeReading {
  const [noticeSelector, scrollBefore, closeSelector] = args;
  const panels = document.querySelector(".settings-panels") as HTMLElement;
  const notice = document.querySelector(noticeSelector) as HTMLElement | null;
  const box = notice?.getBoundingClientRect();
  const frame = panels.getBoundingClientRect();
  const close = notice?.querySelector<HTMLElement>(closeSelector) ?? null;
  const closeBox = close?.getBoundingClientRect();
  return {
    containerTop: Math.round(frame.top),
    containerBottom: Math.round(frame.bottom),
    scrollBefore,
    scrollAfter: Math.round(panels.scrollTop),
    noticeCount: document.querySelectorAll(noticeSelector).length,
    noticeTop: box ? Math.round(box.top) : Number.NaN,
    noticeBottom: box ? Math.round(box.bottom) : Number.NaN,
    inView: !!box && box.top >= frame.top - 1 && box.bottom <= frame.bottom + 1,
    text: notice ? (notice.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80) : "",
    closeW: closeBox ? Math.round(closeBox.width) : -1,
    closeH: closeBox ? Math.round(closeBox.height) : -1,
    closeName: close ? (close.getAttribute("aria-label") ?? "") : "",
    noticeRole: notice?.getAttribute("role") ?? "",
  };
}

/*
 * 复现「用户停在面板底部读别的小节，提示却出现在本节节首」这一档：
 * 先把容器滚到最底（节首远在可视区上方），再用 element.click() 直接点「更改位置…」。
 *
 * 为什么不能用 locator.click()：Playwright 为点按钮会先把它滚进框——那一步顺手把容器滚回了节首，
 * 要验的位移被测试自己抹平了。真机量过这一坑：那样跑完 scrollBefore/scrollAfter 都是 1681，
 * 提示顶边 425 早就在框内，inView 与「容器动了没」双双变空断言，摘掉 useKeepVisible 也照样绿。
 * 滚到底再点，提示必然落在可视区上方，只有 hook 干活才进得了框。
 */
async function triggerFromPanelBottom(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => {
    const panels = document.querySelector(".settings-panels") as HTMLElement;
    panels.scrollTop = panels.scrollHeight;
    const before = Math.round(panels.scrollTop);
    const button = Array.from(document.querySelectorAll<HTMLElement>("#settings-data-locations button")).find((b) =>
      (b.textContent || "").includes("更改位置")
    )!;
    button.click();
    return before;
  });
}

/** 确认框是 fixed 覆盖层，同样用 element.click()，免得 locator 又去滚面板。 */
async function clickModalConfirm(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForSelector(".modal-footer .btn-primary", { timeout: 15_000 });
  await page.evaluate(() => (document.querySelector(".modal-footer .btn-primary") as HTMLElement).click());
}

test("R67-WP7 换根完成后的需重启提示：进框、有 24px 关闭键、点得掉", async ({ page, retest }) => {
  test.setTimeout(240_000);
  await installRetestBridge(page, retest);
  setRetestSelectDataRootTarget(`${RETEST_DATA_ROOT_BASE}-moved`);
  await republishRetestData();
  await page.goto("/");
  await dismissStartupDialog(page);
  await page.setViewportSize({ width: 1280, height: 820 });
  await navigate(page, "设置");
  await page.waitForSelector(".settings-workbench");
  await page.waitForTimeout(900);

  const scrollBefore = await triggerFromPanelBottom(page);
  await clickModalConfirm(page);
  await expect(page.locator("#settings-data-locations .test-msg.warn")).toBeVisible({ timeout: 15_000 });
  // 给自动滚动留一帧（smooth 要跑完）
  await page.waitForTimeout(1_500);

  const reading = await page.evaluate(readNotice, [
    "#settings-data-locations .test-msg.warn",
    scrollBefore,
    ".test-msg-close",
  ] as [string, number, string]);
  writeFileSync("/tmp/cs/wp7-readings.txt", JSON.stringify(reading, null, 2));

  expect(reading.noticeCount, "换根成功后没出现需重启提示").toBe(1);
  expect(reading.inView, `提示没在可视区：top=${reading.noticeTop} bottom=${reading.noticeBottom} 框=${reading.containerTop}~${reading.containerBottom}`).toBe(true);
  // 提示在节首、起点在面板最底 ⇒ 只能往上滚。这一条同时钉住「hook 真的干了活」：
  // 摘掉 useKeepVisible，容器原地停在底部，提示留在可视区外。
  expect(reading.scrollAfter, `容器没把节首的提示滚进框：${reading.scrollBefore} → ${reading.scrollAfter}`).toBeLessThan(reading.scrollBefore);
  expect(reading.noticeRole, "关闭键不该动 tone：原先的播报语义要原样保留").toBe("status");
  // 关闭键自身也是可点击目标：轮37 R88 那一族（19x22）就是这么被抓出来的
  expect(reading.closeW, "关闭键宽度不达 24px（WCAG 2.2）").toBeGreaterThanOrEqual(24);
  expect(reading.closeH, "关闭键高度不达 24px（WCAG 2.2）").toBeGreaterThanOrEqual(24);
  expect(reading.closeName, "× 按钮必须点名是「关闭」，否则读屏只念出「乘号」").toBe("关闭");

  await page.locator("#settings-data-locations .test-msg.warn .test-msg-close").click();
  await expect(page.locator("#settings-data-locations .test-msg.warn")).toHaveCount(0);
  // 关掉提示不能把刚迁好的数据根一起抹掉：这一节仍然要说得出当前落在哪
  await expect(page.locator("#settings-data-locations")).toContainText(`${RETEST_DATA_ROOT_BASE}-moved`);
});

test("R67-WP7 换根被拒时，失败提示同样落在可视区", async ({ page, retest }) => {
  test.setTimeout(240_000);
  await installRetestBridge(page, retest);
  // 目标就是当前根：Go 侧判据拒绝，前端原地报错且不弹确认框
  setRetestSelectDataRootTarget(RETEST_DATA_ROOT_BASE);
  await republishRetestData();
  await page.goto("/");
  await dismissStartupDialog(page);
  await page.setViewportSize({ width: 1280, height: 820 });
  await navigate(page, "设置");
  await page.waitForSelector(".settings-workbench");
  await page.waitForTimeout(900);

  const scrollBefore = await triggerFromPanelBottom(page);
  await expect(page.locator("#settings-data-locations .inline-error")).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1_500);

  const reading = await page.evaluate(readNotice, [
    "#settings-data-locations .inline-error",
    scrollBefore,
    "button",
  ] as [string, number, string]);
  writeFileSync("/tmp/cs/wp7-readings.txt", JSON.stringify(reading, null, 2));

  expect(reading.noticeCount, "拒绝原因没显示出来").toBe(1);
  expect(reading.inView, `失败提示没在可视区：top=${reading.noticeTop} bottom=${reading.noticeBottom} 框=${reading.containerTop}~${reading.containerBottom}`).toBe(true);
  expect(reading.scrollAfter, `容器没把节首的提示滚进框：${reading.scrollBefore} → ${reading.scrollAfter}`).toBeLessThan(reading.scrollBefore);
  expect(reading.noticeRole, "错误提示必须是 alert，读屏才当场打断").toBe("alert");
  expect(reading.text, "提示内容应当是拒绝原因").toContain("相同");
});
