import { test, expect, fetchNacosContent } from "./retestTest";
import { installRetestBridge, RETEST_BRIDGE_MARKER } from "../bridge/installRetestBridge";
import { loadRetestState } from "../state";
import { navigate, dismissStartupDialog } from "./ui";

const state = loadRetestState();
const A = state.nacos.a;
const GROUP = "retest_group";

// T-HIS-01: 历史变更 tab
// 1) 真实 Nacos 历史列表（复测桥按「本会话内发布过的 dataId」过滤，避免历史容器里的旧噪音）
// 2) 点击某版本 → 右侧显示相对上一版 diff
// 3) 勾选 1 个版本 → 该版本 vs 当前线上 DiffPanel
// 4) 回滚守卫：按当前安全模型，历史回滚一律被阻断（必须走 ApplyPlan），
//    这里验证两次点击确认回滚后 Nacos 内容不被改写（bug #9：by-design 守卫，需测试锁定）
test("T-HIS-01 历史变更: 列表/查看/对比/回滚守卫", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "配置浏览");

  // 1) 播种 A 侧 retest-plain.txt 内容，制造一条真实「更新」历史
  const original = await fetchNacosContent(A.baseUrl, A.namespace, "retest-plain.txt", GROUP);
  const mutated = original.replace("line2", "line2 HIS-T01-MARKER");
  await page.evaluate(async ({ url, content }) => {
    const res = await fetch(url, {
      method: "POST",
      body: new URLSearchParams({
        tenant: "retest-dev",
        dataId: "retest-plain.txt",
        group: "retest_group",
        type: "txt",
        content,
      }),
    });
    const text = await res.text();
    if (res.status !== 200 || text !== "true") throw new Error(`seed publish failed: ${res.status} ${text}`);
  }, { url: `${A.baseUrl}/v1/cs/configs`, content: mutated });
  await page.waitForTimeout(300); // Nacos 历史表落库有轻微延迟

  // 2) 打开配置 → 历史变更 tab
  await page.locator(".browser-item", { hasText: "retest-plain.txt" }).first().click();
  await expect(page.locator(".code-area")).toBeVisible({ timeout: 15_000 });
  await page.locator(".detail-tabs .tab-btn", { hasText: "历史变更" }).click();
  await expect(page.locator(".history-view")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".history-item").first()).toBeVisible({ timeout: 30_000 });
  const itemCount = await page.locator(".history-item").count();
  console.log(`[T-HIS-01] 历史条数 = ${itemCount}`);
  expect(itemCount).toBeGreaterThanOrEqual(1);
  await page.screenshot({ path: "results/his01-list.png", fullPage: true });

  // 3) 点击最新版本 → 右侧相对上一版 diff 出现
  //    view() 用 useDeferredValue，内容异步加载，需等待 loading 消失
  const first = page.locator(".history-item").first();
  await first.locator(".history-item-main").click();
  await expect(page.locator(".history-detail .content-box-head")).toBeVisible({ timeout: 15_000 });
  // 等待 loading 消息消失（内容加载完成）
  await expect(page.locator(".history-detail .content-box .pad-msg", { hasText: "加载" })).toBeHidden({ timeout: 20_000 }).catch(() => {});
  // diff-panel 由 UnifiedDiff 或 DiffPanel 渲染，两者都有 .diff-panel 类
  await expect(page.locator(".history-detail .diff-panel").first()).toBeVisible({ timeout: 20_000 });
  const boxHead = await page.locator(".history-detail .content-box-head").first().innerText();
  console.log(`[T-HIS-01] 查看头 = ${boxHead.slice(0, 120)}`);
  expect(boxHead).toMatch(/nid /);
  await page.screenshot({ path: "results/his01-view.png", fullPage: true });

  // 4) 勾选最新+次新版本 → 两版本互相对比（DiffPanel）
  const boxes = page.locator(".history-item input[type=checkbox]");
  await expect(boxes).toHaveCount(Math.max(itemCount, 2), { timeout: 10_000 });
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await expect(page.locator(".history-detail .diff-panel").first()).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: "results/his01-compare2.png", fullPage: true });

  // 5) 回滚守卫：两次点击（回滚 → 确认回滚?）后必须失败且 Nacos 不变
  // 导航离开再回来，强制 HistoryView 重新挂载（viewing/picked 初始为空）
  await navigate(page, "配置对比");
  await page.waitForTimeout(500);
  await navigate(page, "配置浏览");
  await page.locator(".browser-item", { hasText: "retest-plain.txt" }).first().click();
  await expect(page.locator(".code-area")).toBeVisible({ timeout: 15_000 });
  await page.locator(".detail-tabs .tab-btn", { hasText: "历史变更" }).click();
  await expect(page.locator(".history-view")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".history-item").first()).toBeVisible({ timeout: 30_000 });
  // 点击最新版本（fresh mount → viewing 从 null 变化 → view() 一定触发）
  const freshFirst = page.locator(".history-item").first();
  await freshFirst.locator(".history-item-main").click();
  await expect(page.locator(".history-detail .content-box-head")).toBeVisible({ timeout: 20_000 });
  const rbBtn = page.locator(".history-detail .head-actions button", { hasText: "回滚" }).last();
  await rbBtn.click();
  const confirmBtn = page.locator(".history-detail .head-actions button", { hasText: "确认回滚?" }).last();
  await expect(confirmBtn).toBeVisible({ timeout: 10_000 });
  await confirmBtn.click();
  await expect(page.locator(".history-detail .pad-msg.err, .history-view .pad-msg.err").first()).toBeVisible({ timeout: 15_000 });
  const errText = await page.locator(".history-view .pad-msg.err").first().innerText();
  console.log(`[T-HIS-01] 回滚守卫提示 = ${errText.slice(0, 120)}`);
  expect(errText).toContain("直接配置写入已禁用");
  // 消息中心应出现回滚失败错误
  await page.locator(".message-center-btn").hover();
  await expect(page.locator(".message-panel")).toBeVisible({ timeout: 10_000 });
  const msgPanel = await page.locator(".message-panel").innerText();
  expect(msgPanel).toMatch(/配置回滚失败|直接配置写入已禁用/);
  // Nacos 内容保持被改过的值（未被回滚覆盖）
  const after = await fetchNacosContent(A.baseUrl, A.namespace, "retest-plain.txt", GROUP);
  expect(after).toContain("HIS-T01-MARKER");
  // 恢复原内容，供后续 spec（90-browse 删除测试等）使用
  await page.evaluate(async ({ url, content }) => {
    await fetch(url, {
      method: "POST",
      body: new URLSearchParams({
        tenant: "retest-dev",
        dataId: "retest-plain.txt",
        group: "retest_group",
        type: "txt",
        content,
      }),
    });
  }, { url: `${A.baseUrl}/v1/cs/configs`, content: original });
  await page.screenshot({ path: "results/his01-rollback-guard.png", fullPage: true });
});
