// 轮67 R67-WP3c：切走再回设置页，阅读位置必须停在原来那一屏（真机量）。
//
// 为什么必须有真机这一条：jsdom 的 scrollTop 读写都是空操作，组件层只能证明「账本写进去了、
// 赋值发出去了」，证明不了两件事——
//   ① Chrome 的 scroll anchoring 会在异步内容补进来那一帧把容器又推走 93px（实测 800→893）；
//   ② 首帧内容只有 2386px，深位置（2000）会被夹回 1688 且再也没补上。
// 这两个都只有真浏览器 + 真实异步渲染才看得见。
import { expect, test } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog } from "./ui";
import { writeFileSync } from "node:fs";

const readGeo = `(() => {
  const p = document.querySelector(".settings-panels");
  const top = p.getBoundingClientRect().top;
  const off = (id) => {
    const el = document.getElementById(id);
    return el ? Math.round(el.getBoundingClientRect().top - top) : null;
  };
  const active = Array.from(document.querySelectorAll(".settings-rail-item")).find(
    (el) => el.getAttribute("aria-current") === "true"
  );
  return {
    scrollTop: Math.round(p.scrollTop),
    scrollHeight: Math.round(p.scrollHeight),
    backup: off("settings-backup"),
    developer: off("settings-developer"),
    activeText: active ? active.textContent : null,
  };
})()`;

test("R67-WP3c 中途与接近底部两档位置，切走再回来都停在原处", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await page.goto("/");
  await dismissStartupDialog(page);
  await page.setViewportSize({ width: 1280, height: 820 });
  await navigate(page, "设置");
  await page.waitForSelector(".settings-workbench");
  await page.waitForTimeout(900);

  const readings: Record<string, unknown> = {};
  for (const park of [800, 2000]) {
    await page.evaluate((v: number) => {
      (document.querySelector(".settings-panels") as HTMLElement).scrollTop = v;
    }, park);
    await page.waitForTimeout(600);
    const before = await page.evaluate(readGeo);
    expect(before.scrollTop, "探针没把面板滚到位，后面全是空断言").toBe(park);

    await navigate(page, "配置浏览");
    await page.waitForSelector(".browser-item-id");
    await page.waitForTimeout(400);
    await navigate(page, "设置");
    await page.waitForSelector(".settings-workbench");
    await page.waitForTimeout(900);
    const after = await page.evaluate(readGeo);

    expect(Math.abs(after.scrollTop - before.scrollTop), `停在 ${park} 再回来变成 ${after.scrollTop}`).toBeLessThanOrEqual(2);
    // 屏幕上是同一段内容：两节相对容器上缘的偏移必须一致（只有 scrollTop 相等还不够，
    // 内容整体长高过之后再比偏移才是「用户眼里的那一屏」没动）
    expect(after.backup, "回来时备份节的位置变了，用户看到的不是原来那一屏").toBe(before.backup);
    expect(after.developer).toBe(before.developer);
    expect(after.activeText, "左栏指的节和屏幕上的节不是同一节").toBe(before.activeText);
    readings[`park${park}`] = { before, after };
  }

  await page.screenshot({ path: "results/r67-wp3c-scroll-restore.png" });
  writeFileSync("/tmp/cs/wp3c-readings.txt", JSON.stringify(readings, null, 2));
});
