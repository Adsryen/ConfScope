import { test, expect } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { navigate, dismissStartupDialog, setDiffSource } from "./ui";

// T-DIFF-06: 对比页对"位置不同的重复 key"给出可见警告（左右各自提示 + 行号）
test("T-DIFF-06 重复 key 警告: 单文档对比显示 duplicate key 提示条", async ({ page, retest }) => {
  await installRetestBridge(page, retest);
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "配置对比");
  await page.waitForTimeout(600);
  await setDiffSource(page, "left", { connection: "Retest Nacos A", namespace: "retest-dev", group: "RETEST-PROD", dataId: "svc-gateway.yaml" });
  await setDiffSource(page, "right", { connection: "Retest Nacos B", namespace: "retest-qa", group: "RETEST-PROD", dataId: "svc-gateway.yaml" });
  await page.getByRole("button", { name: "加载并对比" }).last().click();
  await expect(page.locator(".diff-panel")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);

  const warnings = page.locator(".diff-warning");
  const count = await warnings.count();
  // A 侧 logging.elk 同父路径重复（行 54/58），B 侧 security.tls 同父路径重复（行 74/78）
  expect(count).toBe(2);
  const left = (await warnings.nth(0).textContent()) ?? "";
  const right = (await warnings.nth(1).textContent()) ?? "";
  expect(left).toContain("svc-gateway.yaml");
  expect(left).toContain("logging.elk");
  expect(left).toContain("54");
  expect(left).toContain("58");
  expect(right).toContain("svc-gateway.yaml");
  expect(right).toContain("security.tls");
  expect(right).toContain("74");
  expect(right).toContain("78");
  // 关键回归：不同父路径的同名 key（payment.mock.enabled vs alipay.enabled 之类）不得误报
  expect(left).not.toContain('"enabled"');
  expect(right).not.toContain('"enabled"');
  await page.screenshot({ path: "results/diff06-duplicate-key-warning.png", fullPage: true });
});
