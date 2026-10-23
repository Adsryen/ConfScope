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
