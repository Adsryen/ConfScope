// 轮67 R67-WP4：备份活动行的时间必须是本机可读格式，UTC ISO 原文只留在 datetime 属性上（真机量）。
//
// 为什么必须有真机这一条：这条缺陷本身就是「页面上印出来的字符串」——修前面板直出
// `2026-10-23T01:23:45.678Z`（同机本地是 09:23），组件测试里换 mock 数据能验格式，
// 但真实活动条目走的是 Go 数据文档 → localStorage 水合 → store 归一化整条链路，
// 只有真机能量到用户实际看到的那一格。
import { expect, test } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog } from "./ui";

const ISO = "2026-10-23T01:23:45.678Z";

interface TimeReading {
  rowCount: number;
  text: string;
  datetime: string | null;
  panelHasRawIso: boolean;
}

test("R67-WP4 备份活动行显示本机时间，ISO 原文只在 datetime 属性里", async ({ page, retest }) => {
  test.setTimeout(240_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await page.goto("/");
  await dismissStartupDialog(page);
  await page.setViewportSize({ width: 1280, height: 820 });
  await navigate(page, "设置");
  await page.waitForSelector(".settings-workbench");
  await page.waitForTimeout(900);

  // 真机种一条活动：面板挂载时从 loadAppDataBackupState() 读，切走再回来即重挂
  await page.evaluate((iso) => {
    const stored = JSON.parse(localStorage.getItem("cs.appDataBackup") || "{}");
    stored.webdav = stored.webdav || { enabled: false, url: "", username: "", password: "", rootPath: "/confscope" };
    stored.activities = [
      { id: "r67-wp4-act", type: "local_export", status: "success", target: "/tmp/confscope.csbackup", message: "seeded", createdAt: iso },
    ];
    localStorage.setItem("cs.appDataBackup", JSON.stringify(stored));
  }, ISO);

  await navigate(page, "配置浏览");
  await page.waitForSelector(".browser-item-id");
  await page.waitForTimeout(400);
  await navigate(page, "设置");
  await page.waitForSelector(".app-data-backup-activity");
  await page.waitForTimeout(600);

  const reading: TimeReading = await page.evaluate(() => {
    const row = document.querySelector(".app-data-backup-activity") as HTMLElement;
    const time = row.querySelector("time") as HTMLElement;
    const panel = document.querySelector(".app-data-backup-panel") as HTMLElement;
    return {
      rowCount: document.querySelectorAll(".app-data-backup-activity").length,
      text: (time?.textContent || "").trim(),
      datetime: time?.getAttribute("datetime") ?? null,
      panelHasRawIso: (panel.textContent || "").includes("01:23:45.678Z"),
    };
  });

  expect(reading.rowCount, "没种进活动列表，后面的断言全是空的").toBeGreaterThan(0);
  expect(reading.text, `页面上应当是「YYYY-MM-DD HH:mm」的本机时间，实测 ${reading.text}`).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  expect(reading.datetime).toBe(ISO);
  expect(reading.panelHasRawIso, "带 Z 带毫秒的 UTC 原文不许再出现在面板正文里").toBe(false);

  await page.screenshot({ path: "results/r67-wp4-backup-times.png" });
});
