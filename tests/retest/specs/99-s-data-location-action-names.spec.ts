// 轮67 R67-WP5：数据位置每行的「复制 / 打开」必须各自能分辨（真机量可访问名）。
//
// 为什么必须真机：jsdom 里 accessibleName 要自己拿 aria-label 拼，测不出「Tab 走到第 34 颗时
// 屏幕上到底念出什么」。修前实测 7 行 14 颗按钮的可访问名全是「复制」「打开」两个词各刷 7 遍，
// 键盘用户根本分不清按下的是日志目录还是备份快照（WCAG 2.4.6）。
import { expect, test } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog } from "./ui";
import { writeFileSync } from "node:fs";

const readActions = `(() => {
  // 轮74 A3 之后忙态文案与静息文案同占一格（不可见那一档 visibility:hidden + aria-hidden），
  // textContent 会把两档一起读回来——可见文字必须按「屏幕上真看得见」算，否则 WCAG 2.5.3 判错对象。
  const visibleText = (node) => {
    const parts = [];
    const walk = (el) => {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || el.getAttribute("aria-hidden") === "true") return;
      if (el.children.length === 0) parts.push(el.textContent || "");
      else Array.from(el.children).forEach(walk);
    };
    Array.from(node.childNodes).forEach((n) => (n.nodeType === 3 ? parts.push(n.textContent || "") : walk(n)));
    return parts.join("").replace(/\s+/g, " ").trim();
  };
  const section = document.getElementById("settings-data-locations");
  // 只数「带路径的那 7 行」：第一行运行形态与数据根只有一个动作按钮，不是同名动作的来源
  const rows = Array.from(section.querySelectorAll(".settings-setting-row")).filter((row) => row.querySelector(".settings-data-location-path"));
  const perRow = rows.map((row) => ({
    rowName: (row.querySelector("strong")?.textContent ?? "").trim(),
    actions: Array.from(row.querySelectorAll(".settings-data-location-actions button")).map((btn) => ({
      visible: visibleText(btn),
      ariaLabel: btn.getAttribute("aria-label"),
    })),
  }));
  // 整节范围内所有按钮的可访问名（没标 aria-label 时 accname 取可见文字）
  const allNames = Array.from(section.querySelectorAll("button")).map((btn) => (btn.getAttribute("aria-label") ?? visibleText(btn)).trim());
  return { perRow, allNames };
})()`;

test("R67-WP5 数据位置每行的动作按钮都有各自的可访问名", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await page.goto("/");
  await dismissStartupDialog(page);
  await page.setViewportSize({ width: 1280, height: 820 });
  await navigate(page, "设置");
  await page.waitForSelector(".settings-workbench");
  await page.waitForTimeout(900);

  const { perRow, allNames } = await page.evaluate(readActions);
  writeFileSync("/tmp/cs/wp5-readings.txt", JSON.stringify({ perRow, allNames }, null, 2));

  expect(perRow.length, "数据位置一节没渲染出带路径的行来，后面全是空断言").toBeGreaterThanOrEqual(2);

  const names: string[] = [];
  for (const row of perRow) {
    expect(row.actions.length, `${row.rowName} 这行的动作按钮数对不上`).toBe(2);
    for (const action of row.actions) {
      expect(action.ariaLabel, `「${row.rowName}」这行的动作「${action.visible}」没有可访问名`).not.toBeNull();
      expect(action.ariaLabel, "可见文字必须含在可访问名里（WCAG 2.5.3），否则键盘念到的和屏幕上看到的不是一回事").toContain(action.visible);
      expect(action.ariaLabel, "可访问名得点名是哪一行，光「复制」两个字无法分辨 7 行").toContain(row.rowName);
      names.push(action.ariaLabel as string);
    }
  }

  const distinct = new Set(names);
  expect(distinct.size, `${names.length} 颗按钮只念得出 ${distinct.size} 个名字：${[...distinct].join(" / ")}`).toBe(names.length);
  // 整节收一遍：任何两颗按钮都不许念出同一个名字（「更改位置…」这类名字本身就唯一）
  const sectionDistinct = new Set(allNames);
  expect(sectionDistinct.size, `本节 ${allNames.length} 颗按钮里有同名：${allNames.join(" / ")}`).toBe(allNames.length);
});
