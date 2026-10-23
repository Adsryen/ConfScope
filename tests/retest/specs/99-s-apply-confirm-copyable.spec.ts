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

// 剪贴板读写都要真授权：本条的判据是「粘回来的那一串」，靠 page.evaluate 伪造粘贴不算测到闭环
test.use({ permissions: ["clipboard-read", "clipboard-write"] });

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

/**
 * 复制 → 粘贴的闭环（轮68 补，用户实测诉求）。
 *
 * 上面那条只证明「有复制出口、手敲能过」，没证明**粘回来的那一串能过校验**：
 * 复制键写的到底是什么、粘贴会不会带进看不见的换行、粘贴路径是否绕开逐字比对，
 * 三件事各是一个坑。所以这里走真人动作：点复制键 → 读剪贴板 → Ctrl+V → 看按钮。
 *
 * 先写哨兵再点复制键：不这么做的话，剪贴板里留着上一条用例的内容也能"看起来通过"。
 */
test("R68 确认文本点复制键写进剪贴板，粘贴回来能过校验（含换行与错文两条反向对照）", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  await seedProtectedTarget(page);
  await republishRetestData();
  await openProtectedPlan(page);

  const required = (await page.evaluate(readConfirmation)).text;
  expect(required.startsWith("APPLY "), "没拿到真实的确认文本，后面全是空转").toBe(true);

  const copyButton = page.getByRole("button", { name: "复制确认文本" });
  await expect(copyButton, "复制键不在页面上").toBeVisible();

  // 1) 先污染剪贴板，再点复制键：读回来必须逐字等于要求的那一串（证明写的是它，不是别的）。
  await page.evaluate(() => navigator.clipboard.writeText("SENTINEL-MUST-BE-OVERWRITTEN"));
  await copyButton.click();
  await expect
    .poll(async () => await page.evaluate(() => navigator.clipboard.readText()), { timeout: 10_000 })
    .toBe(required);
  // 复制成功要有反馈，且不许冒出「复制失败」的错误提示（轮6 R51 那条：失败以前是点了没反应）
  await expect(page.getByRole("button", { name: /已复制/ })).toBeVisible();
  await expect(page.locator(".toast-error")).toHaveCount(0);

  // 2) 真人粘贴：Ctrl+V 之后输入框里就是那一串，灰因清单清空，执行按钮放开
  const input = page.locator("#apply-confirmation-text");
  await input.click();
  await page.keyboard.press("Control+v");
  await expect(input).toHaveValue(required);
  const pasted = await page.evaluate(readConfirmation);
  expect(pasted.blockers, "粘贴正确文本后仍列着灰掉原因").toEqual([]);
  expect(pasted.exec.find((item) => item.text.startsWith("执行"))?.disabled, "粘贴正确文本却不放开执行按钮").toBe(false);

  // 3) 粘贴带首尾空格：看不见，但不该算错（与手敲同口径）。
  //    这里刻意用空格而不是换行——单行 input 的粘贴会先把 \n 吃掉（实测：写 `text\n`
  //    粘进去读回就是 text），拿换行去验 trim 是条空转断言，摘掉 trim 也照样绿。
  await page.evaluate((text) => navigator.clipboard.writeText(`  ${text}  `), required);
  await input.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+v");
  const pastedSpaces = await page.evaluate(readConfirmation);
  expect(pastedSpaces.exec.find((item) => item.text.startsWith("执行"))?.disabled, "粘贴带首尾空格就过不去").toBe(false);
  expect(pastedSpaces.blockers, "带空格的正确文本仍列着灰掉原因").toEqual([]);

  // 3b) 带尾换行的那一串只验「粘贴不卡住」：换行由浏览器吃掉，不归应用管
  await page.evaluate((text) => navigator.clipboard.writeText(`${text}\n`), required);
  await input.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+v");
  const pastedNewline = await page.evaluate(readConfirmation);
  expect(pastedNewline.exec.find((item) => item.text.startsWith("执行"))?.disabled, "粘贴带尾换行就过不去").toBe(false);

  // 4) 反向对照：粘贴路径不许绕开逐字比对——错文粘进去必须仍然灰着，且说的是「不一致」
  await page.evaluate((text) => navigator.clipboard.writeText(`${text}x`), required);
  await input.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+v");
  const pastedWrong = await page.evaluate(readConfirmation);
  expect(pastedWrong.exec.find((item) => item.text.startsWith("执行"))?.disabled, "粘错文本却给了执行按钮").toBe(true);
  expect(pastedWrong.blockers.join("|"), "粘贴错文本时报的仍是「还没输入」").toContain("不一致");
});
