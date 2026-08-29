import { test, expect, fetchNacosContent } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { loadRetestState } from "../state";
import { navigate, dismissStartupDialog } from "./ui";

const state = loadRetestState();
const A = state.nacos.a;
const GROUP = "RETEST-PROD";

// T-HIS-01: 历史变更 tab
// 1) 播种一条真实「更新」历史（svc-data.yaml）→ 历史列表出现
// 2) 点击某版本 → 右侧显示相对上一版 diff
// 3) 勾选 2 个版本 → 两版本互相对比
// 4) 回滚守卫：按当前安全模型，历史回滚一律被阻断（必须走 ApplyPlan），
//    点击回滚后 Nacos 内容不被改写
test("T-HIS-01 历史变更: 列表/查看/对比/回滚守卫", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "配置浏览");
  await expect(page.locator(".browser-item-id", { hasText: "svc-data.yaml" })).toBeVisible({ timeout: 30_000 });

  // 1) 播种一条「更新」历史：给 svc-data.yaml 追加一行标记
  const original = await fetchNacosContent(A.baseUrl, A.namespace, "svc-data.yaml", GROUP);
  const marker = `retest-his-t01-${Date.now()}`;
  // 每轮追加唯一 marker 行 → 每次跑都产生一条新的「更新」历史
  const mutated = original.replace(/\n?$/, `\n# ${marker}\n`);
  await page.evaluate(async ({ url, content }) => {
    const res = await fetch(url, {
      method: "POST",
      body: new URLSearchParams({
        tenant: "retest-dev",
        dataId: "svc-data.yaml",
        group: "RETEST-PROD",
        type: "yaml",
        content,
      }),
    });
    const text = await res.text();
    if (res.status !== 200 || text !== "true") throw new Error(`seed publish failed: ${res.status} ${text}`);
  }, { url: `${A.baseUrl}/v1/cs/configs`, content: mutated });
  await page.waitForTimeout(500);
  // 测试结束恢复原内容时把累积的 marker 行全部清掉, 避免文件无限增长
  const cleanup = () => page.evaluate(async ({ url, content }) => {
    await fetch(url, {
      method: "POST",
      body: new URLSearchParams({ tenant: "retest-dev", dataId: "svc-data.yaml", group: "RETEST-PROD", type: "yaml", content }),
    });
  }, { url: `${A.baseUrl}/v1/cs/configs`, content: original.replace(/\n# retest-his-t01-\d+/g, "").replace(/\n# retest-diag2?-\d+/g, "") });

  // 2) 打开配置 → 历史变更 tab
  await page.locator(".browser-item", { hasText: "svc-data.yaml" }).first().click();
  await expect(page.locator(".code-area")).toBeVisible({ timeout: 15_000 });
  await page.locator(".detail-tabs .tab-btn", { hasText: "历史变更" }).click();
  await expect(page.locator(".history-view")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".history-item").first()).toBeVisible({ timeout: 30_000 });
  const itemCount = await page.locator(".history-item").count();
  console.log(`[T-HIS-01] 历史条数 = ${itemCount}`);
  expect(itemCount).toBeGreaterThanOrEqual(1);
  await page.screenshot({ path: "results/his01-list.png", fullPage: true });

  // 3) 点击最新版本 → 右侧相对上一版 diff 出现
  const first = page.locator(".history-item").first();
  await first.click({ position: { x: 40, y: 15 } });
  await expect(page.locator(".history-detail .content-box-head")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".history-detail .content-box .pad-msg", { hasText: "加载" })).toBeHidden({ timeout: 20_000 }).catch(() => {});
  await expect(page.locator(".history-detail .diff-panel").first()).toBeVisible({ timeout: 20_000 });
  const boxHead = await page.locator(".history-detail .content-box-head").first().innerText();
  console.log(`[T-HIS-01] 查看头 = ${boxHead.slice(0, 120)}`);
  expect(boxHead).toMatch(/nid/);
  await page.screenshot({ path: "results/his01-view.png", fullPage: true });

  // 5) 回滚守卫：回滚按钮只存在于「查看单版本」态（content-box 头部）；
  // 一旦勾选 ≥1 个版本进入对比态，detail 区渲染 diff-panel，回滚按钮被卸载
  // （已复现确认：勾选 2 版本后 .history-detail 内无任何按钮）。
  // 因此先在「查看」态走回滚守卫，再做双版本对比。
  // 按钮带 onBlur 重置确认态，click 后等 300ms 再第二次点击 = 确认 + 执行。
  const rbBtn = page.locator(".history-detail button", { hasText: "回滚" }).first();
  await expect(rbBtn).toBeVisible({ timeout: 10_000 });
  await rbBtn.click({ force: true });
  await page.waitForTimeout(300);
  await expect(rbBtn).toHaveText(/确认回滚/, { timeout: 5_000 });
  await rbBtn.click({ force: true });
  await page.waitForTimeout(800);
  let errorText = await page.locator(".history-view .err, .history-view .pad-msg.err").allInnerTexts();
  console.log(`[T-HIS-01] 回滚反馈 = ${JSON.stringify(errorText)}`);
  expect(errorText.join("\n")).toMatch(/直接配置写入已禁用|配置回滚失败/);
  // 守卫执行后 rbConfirm 已重置、error 已显示，重新点击该版本确保 detail 处于查看态
  await first.click({ position: { x: 40, y: 15 } });
  await page.waitForTimeout(300);

  // 6) 勾选最新+次新版本 → 两版本互相对比
  const boxes = page.locator(".history-item input[type='checkbox']");
  await expect(boxes).toHaveCount(Math.max(itemCount, 2), { timeout: 10_000 });
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await expect(page.locator(".history-detail .diff-panel").first()).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: "results/his01-compare2.png", fullPage: true });

  // Nacos 内容不变（仍是播种的 marker 版本）
  const after = await fetchNacosContent(A.baseUrl, A.namespace, "svc-data.yaml", GROUP);
  expect(after).toContain(marker);
  // 清理：恢复原内容并清掉历史累积的 marker 行
  await cleanup();
  await page.screenshot({ path: "results/his01-rollback-guarded.png", fullPage: true });
});
