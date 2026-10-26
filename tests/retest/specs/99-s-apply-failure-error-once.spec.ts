// 轮67 R67-WP11：第五步执行失败时，同一句错误只许出现在一个地方。
//
// 为什么要真机量：进度面板的 <pre class="apply-task-progress-error"> 与 InlineError 的
// <pre class="inline-error-body"> 拿的是同一个字符串（applyPlanExecution.recordFailure 里
// completeTask(taskId,false,error) 与 return {error} 用的是同一个 error），组件各写各的、
// 谁都没错——只有把整屏渲染出来数一遍才发现用户读的是同一句话的两份拷贝。
// jsdom 里两条通道也各自断言过自己的存在，加在一起没人管。
import { expect, test, fetchNacosContent } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog, setDiffSource } from "./ui";
import { writeFileSync } from "node:fs";

const NS_A = "retest-dev";
const NS_B = "retest-qa";
const GROUP = "RETEST-PROD";
const DATA_ID = "svc-gateway.yaml";

/** 绕过 UI 直接改 B 侧，制造「计划基准已过期」这条必然失败（与 95-remaining D6 同法）。 */
async function nacosPublish(baseUrl: string, tenant: string, dataId: string, group: string, content: string) {
  const qs = `dataId=${encodeURIComponent(dataId)}&group=${encodeURIComponent(group)}&tenant=${encodeURIComponent(tenant)}&content=${encodeURIComponent(content)}&type=yaml`;
  const res = await fetch(`${baseUrl}/v1/cs/configs?${qs}`, { method: "POST" });
  expect(res.ok, `制造前置失败用的发布没成（${res.status}）`).toBe(true);
}

/** 浏览器侧执行：必须自包含。 */
function readFailureScreen(): {
  blocks: { cls: string; text: string }[];
  messageOnce: number;
  inlineErrorCount: number;
  taskStatus: string;
  taskId: string;
  taskIdCopiable: boolean;
  hasRetry: boolean;
  hasCopyError: boolean;
  progressVisible: boolean;
} {
  const norm = (value: string) => value.replace(/\s+/g, " ").trim();
  const inlineBody = document.querySelector(".inline-error-body");
  const message = inlineBody ? norm(inlineBody.textContent ?? "") : "";
  const blocks = Array.from(document.querySelectorAll<HTMLElement>(".apply-task-progress-error, .inline-error-body")).map((node) => ({
    cls: node.className,
    text: norm(node.textContent ?? ""),
  }));
  const copyErr = Array.from(document.querySelectorAll(".inline-error button")).find((btn) => (btn.textContent ?? "").includes("复制"));
  const retry = Array.from(document.querySelectorAll(".inline-error button")).find((btn) => (btn.textContent ?? "").includes("重试"));
  return {
    blocks,
    messageOnce: message ? blocks.filter((block) => block.text === message).length : 0,
    inlineErrorCount: document.querySelectorAll(".inline-error").length,
    taskStatus: norm(document.querySelector(".apply-task-progress .task-status")?.textContent ?? ""),
    taskId: norm(document.querySelector(".apply-task-progress-id .mono")?.textContent ?? ""),
    taskIdCopiable: !!Array.from(document.querySelectorAll(".apply-task-progress-id button")).length,
    hasRetry: !!retry,
    hasCopyError: !!copyErr,
    progressVisible: !!document.querySelector(".apply-task-progress"),
  };
}

test("R67-WP11 执行失败时同一句错误只出现一次，进度面板仍说得出任务", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await page.goto("/");
  await dismissStartupDialog(page);
  await page.setViewportSize({ width: 1280, height: 820 });

  await navigate(page, "配置对比");
  await page.waitForTimeout(500);
  await setDiffSource(page, "left", { connection: "Retest Nacos A", namespace: NS_A, group: GROUP, dataId: DATA_ID });
  await setDiffSource(page, "right", { connection: "Retest Nacos B", namespace: NS_B, group: GROUP, dataId: DATA_ID });
  await page.getByRole("button", { name: "加载并对比" }).last().click();
  await expect(page.locator(".diff-panel")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "进入配置变更计划" }).last().click();
  await expect(page.locator(".apply-ledger, .apply-item-list").first()).toBeVisible({ timeout: 30_000 });
  const selectAll = page.getByRole("button", { name: "全选" }).first();
  if (await selectAll.count()) await selectAll.click();

  // 执行前把 B 侧改掉：计划基准立刻过期，执行必然失败且不写任何东西
  const baseB = retest.nacos.b.baseUrl;
  const original = await fetchNacosContent(baseB, NS_B, DATA_ID, GROUP);
  expect(original).not.toContain("retest-wp11-external-change");
  await nacosPublish(baseB, NS_B, DATA_ID, GROUP, `${original}\n# retest-wp11-external-change\n`);
  await page.waitForTimeout(1_500);

  await page.locator("button", { hasText: "Dry-run 检查" }).last().click({ force: true });
  await page.waitForTimeout(1_000);
  await page.locator(".apply-confirm-check input").check({ force: true });
  await page.locator("button", { hasText: "执行变更" }).last().click({ force: true });

  await expect(page.locator(".inline-error").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".apply-task-progress").first()).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(500);

  const reading = await page.evaluate(readFailureScreen);
  writeFileSync("/tmp/cs/wp11-readings.txt", JSON.stringify(reading, null, 2));

  expect(reading.progressVisible, "失败后进度面板整个消失了：任务号与状态也得一起没").toBe(true);
  expect(reading.inlineErrorCount, "第五步的失败块应当走 InlineError 这一份出口（复制/重试都在它身上）").toBe(1);
  expect(reading.hasCopyError, "留下的那一份必须抄得走").toBe(true);
  // 这一条是本轮的正题：修前实测同一句话在 .apply-task-progress-error 与 .inline-error-body 各一份
  expect(reading.messageOnce, `同一句错误出现了 ${reading.messageOnce} 份：${JSON.stringify(reading.blocks)}`).toBe(1);
  // 去重不许把面板自己的事实一并抹掉
  expect(reading.taskStatus, "进度面板不再说得出「失败」").toContain("失败");
  expect(reading.taskId, "进度面板不再给出任务号").toMatch(/^task_/);
  expect(reading.taskIdCopiable, "任务号旁边的复制键被顺带删掉了").toBe(true);
});
