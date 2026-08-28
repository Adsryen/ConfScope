import { test, expect } from "./retestTest";
import { installRetestBridge, RETEST_BRIDGE_MARKER } from "../bridge/installRetestBridge";
import { navigate, dismissStartupDialog, setDiffSource } from "./ui";

const NS_A = "retest-dev", NS_B = "retest-qa", GROUP = "retest_group";

test("diag: 单文档计划 dry-run 与执行全链路状态", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  const consoleLines: string[] = [];
  page.on("console", (m) => {
    const t = m.text();
    if (t.includes("retest-bridge") || m.type() === "error") consoleLines.push(`[${m.type()}] ${t}`);
  });
  page.on("pageerror", (e) => consoleLines.push(`[pageerror] ${String(e).slice(0, 300)}`));

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "配置对比");
  await setDiffSource(page, "left", { connection: "Retest Nacos A", namespace: NS_A, dataId: "retest-plain.txt", group: GROUP });
  await setDiffSource(page, "right", { connection: "Retest Nacos B", namespace: NS_B, dataId: "retest-plain.txt", group: GROUP });
  await page.getByRole("button", { name: "加载并对比" }).last().click();
  await expect(page.locator(".diff-panel")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "进入配置变更计划" }).last().click();
  await expect(page.locator(".apply-item-list, .apply-ledger").first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2000);

  // 勾选确认
  await page.locator(".apply-confirm-check input").check();
  // 先 dry-run
  const dryBtn = page.getByRole("button", { name: /Dry-run/ }).last();
  console.log("DIAG dryBtn text:", await dryBtn.textContent(), "disabled:", await dryBtn.isDisabled());
  await dryBtn.click();
  await page.waitForTimeout(8000);
  const afterDry = await page.evaluate(() => ({
    notice: document.querySelector(".apply-execution-notice")?.textContent ?? "",
    err: document.querySelector(".inline-error .inline-error-body")?.textContent?.slice(0, 500) ?? "",
    task: document.querySelector(".apply-task-progress")?.textContent?.slice(0, 300) ?? "",
    dryDisabled: (document.querySelector(".apply-confirmation-actions button") as HTMLButtonElement | null)?.disabled,
  }));
  console.log("DIAG after dry-run:", JSON.stringify(afterDry));

  // 执行
  const execBtn = page.getByRole("button", { name: /执行变更/ }).last();
  console.log("DIAG execBtn text:", await execBtn.textContent(), "disabled:", await execBtn.isDisabled());
  await execBtn.click();
  await page.waitForTimeout(15000);
  const afterExec = await page.evaluate(() => ({
    notice: document.querySelector(".apply-execution-notice")?.textContent ?? "",
    err: document.querySelector(".inline-error .inline-error-body")?.textContent?.slice(0, 800) ?? "",
    task: document.querySelector(".apply-task-progress")?.textContent?.slice(0, 400) ?? "",
    taskErr: document.querySelector(".apply-task-progress-error")?.textContent?.slice(0, 400) ?? "",
  }));
  console.log("DIAG after exec:", JSON.stringify(afterExec));
  for (const l of consoleLines) console.log("DIAG-C:", l);
  await page.screenshot({ path: "results/diag-exec.png", fullPage: true });
  expect(true).toBeTruthy();
});
