import { test, expect, fetchNacosContent } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog, setDiffSource } from "./ui";
import { backToBrowseFromPlan, expectNoDisabledWriteError, expectPlanItem } from "./planExit";
import { loadRetestState } from "../state";

const state = loadRetestState();
const BASE_A = state.nacos.a.baseUrl;
const BASE_B = state.nacos.b.baseUrl;
const NS_A = state.nacos.a.namespace;
const NS_B = state.nacos.b.namespace;
const GROUP = "RETEST-PROD";

/**
 * UX-01: 用户误读场景——进入第四步计划页后，未执行任何操作，
 * 界面必须明确告知「尚未写入右侧目标」，且 B 侧内容保持不变。
 * 复现用户报告：「没改任何东西，左侧却看到很多应用的修改项」。
 */
test("UX-01 第四步计划页: 未执行时明确 dry-run 提示且右侧未被写入", async ({ page, retest }) => {
  await installRetestBridge(page, retest);
  await republishRetestData();

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "配置对比");
  await page.waitForTimeout(500);
  await setDiffSource(page, "left", { connection: "Retest Nacos A", namespace: NS_A, group: GROUP, dataId: "svc-gateway.yaml" });
  await setDiffSource(page, "right", { connection: "Retest Nacos B", namespace: NS_B, group: GROUP, dataId: "svc-gateway.yaml" });
  await page.getByRole("button", { name: "加载并对比" }).last().click();
  await expect(page.locator(".diff-panel")).toBeVisible({ timeout: 30_000 });

  const before = await fetchNacosContent(BASE_B, NS_B, "svc-gateway.yaml", GROUP);
  expect(before).toContain("生产环境");
  expect(before).not.toContain("开发环境");

  await page.getByRole("button", { name: "进入配置变更计划" }).last().click();
  await expect(page.locator(".apply-ledger, .apply-item-list").first()).toBeVisible({ timeout: 30_000 });

  // 展开第一个计划项详情 → diff 上方必须出现 dry-run 预览提示条
  // 计划项行；若未选中则点击第一个行选中（详情默认可能已选中首项）
  const firstItem = page.locator(".apply-item-row").first();
  await expect(firstItem).toBeVisible({ timeout: 15_000 });
  if ((await page.locator(".apply-dryrun-note").count()) === 0) {
    await firstItem.click({ force: true });
  }
  await expect(page.locator(".apply-dryrun-note").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".apply-dryrun-note").first()).toContainText("尚未写入");

  // 页面不得出现任何「已应用/已写入/变更执行完成」类残留文案
  const bodyText = await page.locator("body").innerText();
  const suspicious = ["已应用", "已写入", "变更执行完成"].filter((w) => bodyText.includes(w));
  expect(suspicious).toEqual([]);

  // 工作流卡片步骤文案必须体现 dry-run 语义（卡片默认折叠，只断言 DOM 存在）
  expect(await page.locator(".diff-workflow-step-label", { hasText: "dry-run" }).count()).toBeGreaterThan(0);

  // 未执行 → B 侧内容必须保持原样（右侧未被写入）
  const after = await fetchNacosContent(BASE_B, NS_B, "svc-gateway.yaml", GROUP);
  expect(after).toBe(before);

  await page.screenshot({ path: "results/ux01-plan-dryrun-note.png", fullPage: true });
});

/**
 * UX-02: 配置浏览 → 编辑 → 保存。
 * 当前产品决策：直接写入已禁用，「保存」= 生成变更计划（轮42 起入口自己就说清楚），
 * 但编辑流必须完整可用：
 * 1) 合法内容 → 进入变更计划页（覆盖 1 项），未确认执行前 Nacos 不变，草稿不丢
 * 2) 格式校验不通过的内容 → 被格式校验拦截（连计划都不生成）
 * 3) 编辑工具栏必须**预告**「保存会生成变更计划」，而不是点下去才报错
 */
test("UX-02 配置浏览编辑: 编辑流可用，保存走变更计划且不直写", async ({ page, retest }) => {
  await installRetestBridge(page, retest);
  await republishRetestData();

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "配置浏览");
  await expect(page.locator(".browser-item-id", { hasText: "svc-pay.properties" })).toBeVisible({ timeout: 30_000 });
  await page.locator(".browser-item-id", { hasText: "svc-pay.properties" }).click();
  await expect(page.locator(".code-view, .fmt-bar").first()).toBeVisible({ timeout: 15_000 });

  // 进入编辑态
  await page.getByRole("button", { name: "编辑" }).click();
  const ta = page.locator(".code-editor-ta").first();
  await expect(ta).toBeVisible({ timeout: 10_000 });

  // 预告：编辑工具栏里必须先看到「保存会生成变更计划」这条可见说明，不是点了才知道
  await expect(page.locator(".fmt-write-hint").filter({ visible: true }).first()).toContainText("变更计划", { timeout: 10_000 });

  // 场景 A: 合法 properties 追加 → 校验通过 → 生成「覆盖」计划，Nacos 仍不变
  await ta.click();
  await ta.press("End");
  await ta.press("\n");
  await ta.type("# ux02-a: 合法注释");
  await page.getByRole("button", { name: /生成变更计划/ }).click();
  await expectPlanItem(page, "overwrite");
  await expectNoDisabledWriteError(page);
  // 回到浏览页：编辑态与草稿必须还在（生成计划不是写入成功，不该把用户的工作丢掉）
  await backToBrowseFromPlan(page);
  await expect(ta).toBeVisible({ timeout: 15_000 });
  const draftText = await ta.inputValue();
  expect(draftText).toContain("# ux02-a: 合法注释");

  // 场景 B: 重复 key → 格式校验拦截，提示校验未通过，连计划都不生成
  await ta.click();
  await ta.press("End");
  await ta.type("\nspring.datasource.url=jdbc:mysql://localhost:3306/ux02\nspring.datasource.url=jdbc:mysql://localhost:3306/ux02-b");
  await page.getByRole("button", { name: /生成变更计划/ }).click();
  await expect(page.getByRole("heading", { name: "格式校验未通过" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "确定" }).click();

  // 取消编辑：草稿非空 ⇒ 必须先问「放弃未保存的修改?」，确认后才退出编辑态（轮7 的脏草稿守卫）
  // 轮90：这条路只退出编辑态、不跳到别的配置，确认按钮是「放弃修改」（旧文案「放弃并切换」在这里说谎）
  await page.getByRole("button", { name: "取消" }).click();
  await expect(page.getByRole("heading", { name: /放弃未保存的修改/ })).toBeVisible({ timeout: 5_000 });
  await page.getByRole("button", { name: "放弃修改" }).click();
  await expect(ta).toBeHidden({ timeout: 5_000 });
  const nacosText = await fetchNacosContent(BASE_A, NS_A, "svc-pay.properties", GROUP);
  expect(nacosText).not.toContain("ux02");

  await page.screenshot({ path: "results/ux02-browse-edit-plan.png", fullPage: true });
});
