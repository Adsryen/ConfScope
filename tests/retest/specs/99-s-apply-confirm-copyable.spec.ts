// 轮67 R67-WP10：受保护目标的确认文本必须「抄得走、也敲得完」。
//
// 为什么必须真机：`body { user-select: none }` 是全站既定设计，某个 <code> 到底被哪条规则放开、
// 鼠标拖过去能不能选中，jsdom 一律量不出来。修前实测（/tmp/cs/step5-confirm-probe.txt）：
// 确认文本 80 字符（真实 MSE 命名空间是 36 位 UUID 时约 110 字符）、computed user-select=none、
// 拖选与三击选中的都是 0 个字符、面板里一颗复制键都没有 ⇒ 抄不走又敲不完，第五步直接堵住。
import { expect, test } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog, setDiffSource } from "./ui";
import { writeFileSync } from "node:fs";

const NS_A = "retest-dev";
const NS_B = "retest-qa";
const GROUP = "RETEST-PROD";

/** 把 retest-b 改名成生产：isProtectedApplyTarget 认连接名/环境名/标签里的 prod|生产 等标记。 */
async function seedProtectedTarget(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    try {
      const raw = window.localStorage.getItem("cs.connections");
      if (!raw) return;
      const list = JSON.parse(raw) as Array<Record<string, unknown>>;
      const target = list.find((item) => item.id === "retest-b");
      if (target) {
        target.name = "MSE 生产集群";
        target.sourceName = "MSE 生产集群";
        target.environmentName = "Production";
      }
      window.localStorage.setItem("cs.connections", JSON.stringify(list));
    } catch {
      /* 播种失败就让后面的断言自己飘红 */
    }
  });
}

async function openProtectedPlan(page: import("@playwright/test").Page) {
  await page.goto("/");
  await dismissStartupDialog(page);
  await page.setViewportSize({ width: 1280, height: 820 });
  await navigate(page, "配置对比");
  await page.waitForTimeout(500);
  await setDiffSource(page, "left", { connection: "Retest Nacos A", namespace: NS_A, group: GROUP, dataId: "svc-gateway.yaml" });
  await setDiffSource(page, "right", { connection: "MSE 生产集群", namespace: NS_B, group: GROUP, dataId: "svc-gateway.yaml" });
  await page.getByRole("button", { name: "加载并对比" }).last().click();
  await expect(page.locator(".diff-panel")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "进入配置变更计划" }).last().click();
  await expect(page.locator(".apply-confirmation-code").first()).toBeVisible({ timeout: 30_000 });
  const selectAll = page.getByRole("button", { name: "全选" }).first();
  if (await selectAll.count()) await selectAll.click();
  await page.waitForTimeout(300);
}

const readConfirmation = `(() => {
  const code = document.querySelector(".apply-confirmation-code");
  const cs = getComputedStyle(code);
  const copy = Array.from(document.querySelectorAll(".apply-confirmation button")).find((btn) =>
    (btn.textContent ?? "").includes("确认文本")
  );
  const blockers = Array.from(document.querySelectorAll(".apply-blocker-hint li")).map((li) => (li.textContent ?? "").trim());
  const exec = Array.from(document.querySelectorAll("button"))
    .filter((btn) => (btn.textContent ?? "").includes("执行"))
    .map((btn) => ({ text: (btn.textContent ?? "").trim(), disabled: btn.disabled }));
  return {
    text: (code.textContent ?? "").trim(),
    userSelect: cs.userSelect || cs.getPropertyValue("-webkit-user-select"),
    copyLabel: copy ? (copy.textContent ?? "").trim() : null,
    blockers,
    exec,
  };
})()`;

test("R67-WP10 受保护目标的确认文本敲得完、抄得走，敲错时说的是不一致", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  await seedProtectedTarget(page);
  await republishRetestData();
  await openProtectedPlan(page);

  const before = await page.evaluate(readConfirmation);
  writeFileSync("/tmp/cs/wp10-readings.txt", JSON.stringify(before, null, 2));

  // 1) 长度：旧格式实测 80 字符（生产 110），手敲不可能；现在只留 `APPLY <planId>`。
  expect(before.text.startsWith("APPLY "), "确认文本不再是 APPLY <planId> 这一串").toBe(true);
  expect(before.text).not.toContain(" TO ");
  expect(before.text.length, `确认文本 ${before.text.length} 个字符：${before.text}`).toBeLessThanOrEqual(32);

  // 2) 选得中：computed user-select 必须是 text（修前 none）。
  expect(before.userSelect, "确认文本又被 body 的 user-select:none 禁掉了").toBe("text");
  const box = await page.locator(".apply-confirmation-code").boundingBox();
  expect(box, "确认文本没有渲染出来").not.toBeNull();
  await page.mouse.move(box!.x + 3, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width - 3, box!.y + box!.height / 2, { steps: 12 });
  await page.mouse.up();
  const dragged = await page.evaluate(() => (window.getSelection()?.toString() ?? "").trim());
  expect(dragged, "拖选确认文本选中 0 个字符：抄不走就只能整串用眼睛记").toBe(before.text);
  await page.evaluate(() => window.getSelection()?.removeAllRanges());

  // 3) 有复制出口（只做复制，不做一键填入：填进去等于跳过手敲那层防呆）。
  expect(before.copyLabel, "确认文本旁边没有复制键").not.toBeNull();

  // 4) 一个字没敲 vs 敲了但差一个字符，必须是两句话。
  expect(before.blockers.join("|")).toContain("还没输入");
  expect(before.blockers.join("|")).not.toContain("不一致");
  await page.locator("#apply-confirmation-text").fill(`${before.text}x`);
  const mismatch = await page.evaluate(readConfirmation);
  expect(mismatch.blockers.join("|"), "敲错一个字符时报的仍是「还没输入」，用户看不出自己已经输入过").toContain("不一致");
  expect(mismatch.blockers.join("|")).not.toContain("还没输入");
  expect(mismatch.exec.find((item) => item.text.startsWith("执行"))?.disabled, "文本不对却给了执行按钮").toBe(true);

  // 5) 尾随空格不算错：手敲 26 个字符带进一个看不见的空格，不该永远灰着。
  await page.locator("#apply-confirmation-text").fill(`${before.text}  `);
  const filled = await page.evaluate(readConfirmation);
  expect(filled.exec.find((item) => item.text.startsWith("执行"))?.disabled, "多敲了看不见的首尾空格就过不去").toBe(false);
  expect(filled.blockers, "灰掉的原因清单该随就绪清空").toEqual([]);
});
