/**
 * 「直写入口 → 变更计划」的公共断言（轮42）。
 *
 * 这些用例原本断言的是：点保存/删除/新建/回滚 → 冒出一句「直接配置写入已禁用」。
 * 那句断言锁的意图是**写入没有发生**，不是那句错误文案。本轮把四个入口本身改成
 * 计划入口（点一下生成变更计划，执行仍要 dry-run + 确认），所以证据换成同一意图的新呈现：
 * 进入计划页（`.apply-item-list` 只有 ApplyPlanView 渲染）→ 计划项动作正确 → Nacos 侧零变化。
 * 八处共用这一个模块，免得各写各的再次分叉。
 */
import { expect, type Page } from "@playwright/test";
import { navigate } from "./ui";

/** API 层禁用直写时抛出的原句；UI 里再出现就是回到「点了才报错」。 */
const DISABLED_WRITE_TEXT = "直接配置写入已禁用";

/** 计划项动作，取自 `.apply-action-<action>` 类名（locale 无关，比读文案稳）。 */
export type PlanAction = "create" | "overwrite" | "delete" | "skip" | "parse_error";

/** 进计划页并返回可见计划项的 (dataId, action)。 */
export async function planRows(page: Page): Promise<Array<{ dataId: string; action: string }>> {
  const list = page.locator(".apply-item-list").filter({ visible: true }).first();
  await expect(list).toBeVisible({ timeout: 30_000 });
  const rows = page.locator(".apply-item-row").filter({ visible: true });
  await expect(rows.first()).toBeVisible({ timeout: 30_000 });
  const out: Array<{ dataId: string; action: string }> = [];
  const n = await rows.count();
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    const dataId = (
      (
        await row
          .locator(".apply-item-main")
          .innerText()
          .catch(() => "")
      ).split("\n")[0] ?? ""
    ).trim();
    const cls =
      (await row
        .locator(".apply-action")
        .getAttribute("class")
        .catch(() => "")) ?? "";
    const action = /apply-action-([\w-]+)/.exec(cls)?.[1] ?? "";
    out.push({ dataId, action });
  }
  return out;
}

/** 断言计划里恰好一条指定动作的项（用于内容必然不同的确定场景：编辑保存 / 删除 / 新建）。 */
export async function expectPlanItem(page: Page, action: PlanAction): Promise<void> {
  await expect(page.locator(".apply-item-list").filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(`.apply-action-${action}`).filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 });
}

/**
 * 回滚类场景的动作判据。
 *
 * 为什么不只认「覆盖」：Nacos 历史条目存的是**发布之前**的内容，v1 单节点连发同内容还会合并 nid
 * （S8 用例开头就写了这条已知行为），所以「选中的历史版本正文」与线上现值是否真的不同，
 * 不由用例决定——相同则 classify 给 skip（跳过），不同则给 overwrite。两者的意图一样：
 * 没有直写，写入被挡在计划确认之后。删除/新增是另一码事，出现即说明回滚出路挂错了动作。
 */
export async function expectRollbackPlanRow(page: Page, dataId: string): Promise<string> {
  const rows = await planRows(page);
  expect(rows.length, "回滚计划不是一条项").toBe(1);
  expect(rows[0].dataId, "回滚计划挂在了别的配置上").toBe(dataId);
  expect(["overwrite", "skip"], `回滚计划的动作不对`).toContain(rows[0].action);
  return rows[0].action;
}

/** 从计划页回配置浏览：走侧栏真人路径（浏览视图被保活，编辑态与草稿都还在）。 */
export async function backToBrowseFromPlan(page: Page): Promise<void> {
  await navigate(page, "配置浏览");
  await expect(page.locator(".browser-item-id").first()).toBeVisible({ timeout: 30_000 });
}

/**
 * 断言页面上没有任何「点了才报错」的直写失败呈现。
 *
 * 只看错误容器，不看全文：编辑工具栏那条可见说明（`.fmt-write-hint`）本来就该提到
 * 「直接写入已禁用」，它是预告不是失败。
 */
export async function expectNoDisabledWriteError(page: Page): Promise<void> {
  const containers = ".inline-error, .test-msg.err, .pad-msg.err, .modal-error, .toaster .toast";
  const texts = (await page.locator(containers).filter({ visible: true }).allInnerTexts()).filter((t) => t.includes(DISABLED_WRITE_TEXT));
  expect(texts, "界面又出现直写禁用的就地失败提示").toEqual([]);
}
