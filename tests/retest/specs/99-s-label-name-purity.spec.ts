/**
 * R67-WP9 真机永久回归：<label> 给出的可访问名必须「只有标题」（轮67）。
 *
 * 为什么必须真机（静态守卫 inputsNeedAccessibleName 做不到的一半）：
 * 可访问名由浏览器的 accname 实现算出来。静态守卫只读 JSX，它不知道下面两件事在真浏览器里
 * 到底产出什么字符串：
 *   1. 隐式 label 关联只认子树里**第一只** labelable 后代——连接表单「项目」栏在同一只 label 里
 *      并排坐着下拉框和新建时的文本框，修前真机读数：下拉框 = "项目"，文本框 = ""（完全没名字）；
 *   2. label 子树里的动作文字会被并进控件名字——修前真机读数：
 *      「默认命名空间」框 = "默认命名空间 ID（留空=public） 加载命名空间"，
 *      对比页 dataId 组合框 = "dataId (13) 重试配置列表 复制错误"。
 * 读屏用户听完标题还要再听一遍按钮名，`getByLabel(标题, {exact:true})` 也取不到框。
 * 这两条正好都是 Playwright 的 getByRole/getByLabel（走真 accname）能直接判红/判绿的，所以钉在这里。
 *
 * 分工：静态守卫管全站普查（新增脏 label 当场红 + 数量下限防永真），本 spec 管这三只框的真机读数。
 * 数据一律走桥的内存替身，禁止碰 portable/ConfScopeData（数据纪律第 3 条）。
 */
import { type Page } from "@playwright/test";
import { expect, test } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog, ensureSourcesPanelExpanded } from "./ui";

const T = 20_000;

async function boot(page: Page, retest: Parameters<typeof installRetestBridge>[1]): Promise<void> {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await page.goto("/");
  await dismissStartupDialog(page);
  await page.setViewportSize({ width: 1280, height: 860 });
}

test("R67-WP9 连接表单：并排两只控件都有名，且名字里不掺按钮文字", async ({ page, retest }) => {
  await boot(page, retest);
  await navigate(page, "连接管理");
  await page.locator(".conn-create-btn").first().click({ timeout: T });
  await expect(page.locator(".conn-form")).toBeVisible({ timeout: T });

  // 「项目」：新建连接时下拉框与文本框同屏（候选里没选中项 ⇒ 走新建分支）。
  // 修前文本框在 accname 树里是空名字，这里必须判红。
  const projectSelect = page.getByRole("combobox", { name: "项目", exact: true });
  const projectInput = page.getByRole("textbox", { name: "项目", exact: true });
  await expect(projectSelect).toHaveCount(1, { timeout: T });
  await expect(projectInput, "同一只 label 里的第二只控件拿不到名字（隐式关联只认第一个）").toHaveCount(1);

  // 选一个已存在的候选 ⇒ 文本框退场，名字仍归下拉框（证明两只确实是同一栏的两个分支）
  await projectSelect.selectOption({ index: 0 });
  await expect(projectInput).toHaveCount(0, { timeout: T });
  await expect(projectSelect).toHaveCount(1);

  // 「默认命名空间」：动作按钮坐在同一只 label 里。
  const nsCaption = "默认命名空间 ID（留空=public）";
  await expect(page.getByRole("textbox", { name: nsCaption, exact: true })).toHaveCount(1, { timeout: T });
  await expect(page.getByRole("textbox", { name: /加载命名空间|重试|复制/ }), "按钮文字还是并进了命名空间框的名字").toHaveCount(0);

  // 单控件的干净 label 仍是合规来源（防止「为了干净把隐式关联全拆掉」的反向漂）
  await expect(page.getByRole("combobox", { name: "环境", exact: true })).toHaveCount(1);

  // 「本地快照目录」：同 label 里坐着选择目录 + 校验两颗按钮。
  await page.locator(".conn-form label.field", { hasText: "配置中心" }).locator("select").selectOption("local");
  await expect(page.getByRole("textbox", { name: "本地快照目录", exact: true })).toHaveCount(1, { timeout: T });
  await expect(page.getByRole("textbox", { name: /选择文件夹|校验目录/ }), "按钮文字还是并进了路径框的名字").toHaveCount(0);
});

test("R67-WP9 对比页：dataId 组合框的名字只有 dataId", async ({ page, retest }) => {
  await boot(page, retest);
  await navigate(page, "配置对比");
  await expect(page.locator(".diff-source-panel").first()).toBeVisible({ timeout: T });
  await ensureSourcesPanelExpanded(page);

  // 名字必须是可见标题那句 "dataId"（WCAG 2.5.3 要求名字含可见文字，且不掺动作）
  for (const title of ["来源（左）", "目标（右）"]) {
    const panel = page.locator(".source-picker").filter({ has: page.locator(`.source-title:has-text("${title}")`) }).first();
    await expect(panel.getByRole("combobox", { name: "dataId", exact: true })).toHaveCount(1, { timeout: T });
  }
  await expect(page.getByRole("combobox", { name: /重试|复制/ }), "重试/复制的按钮文字还是并进了 dataId 组合框的名字").toHaveCount(0);
});
