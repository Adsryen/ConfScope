import { test, expect } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { navigate, dismissStartupDialog, setDiffSource } from "./ui";
import { republishRetestData } from "../bridge/republishData";

// T-DIFF-06: 对比页对"位置不同的重复 key"给出可见警告（左右各自提示 + 行号）
// 注意：本用例直接断言 A/B 容器内数据的行号与重复 key 路径，
// 必须先重新播种测试数据（其他 apply 类用例可能已写入 A 内容，污染基线）。
test("T-DIFF-06 重复 key 警告: 单文档对比显示 duplicate key 提示条", async ({ page, retest }) => {
  await installRetestBridge(page, retest);
  await republishRetestData();
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
  // A 侧 logging.elk 同父路径重复（行 54/58），B 侧 security.tls 同父路径重复（行 75/79）。
  // 行号随测试数据演进，按「完整 key 路径 + 行号对」正则断言，避免硬编码漂移。
  expect(count).toBe(2);
  const left = (await warnings.nth(0).textContent()) ?? "";
  const right = (await warnings.nth(1).textContent()) ?? "";
  expect(left).toContain("svc-gateway.yaml");
  expect(left).toMatch(/"logging\.elk" @ 行 54, 58/);
  expect(right).toContain("svc-gateway.yaml");
  expect(right).toMatch(/"security\.tls" @ 行 75, 79/);
  // 关键回归：不同父路径的同名 key（payment.mock.enabled vs alipay.enabled 之类）不得误报
  expect(left).not.toContain('"enabled"');
  expect(right).not.toContain('"enabled"');
  await page.screenshot({ path: "results/diff06-duplicate-key-warning.png", fullPage: true });
});
