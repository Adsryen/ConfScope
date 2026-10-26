import { test, expect, fetchNacosContent } from "./retestTest";
import { readFileSync } from "node:fs";
import { installRetestBridge, RETEST_AUDIT_FILE } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { backToBrowseFromPlan, expectNoDisabledWriteError, planRows } from "./planExit";

/** republish 后轮询确认 Nacos B 的 svc-gateway.yaml 恢复为生产基线（publish 异步落库，偶尔返回后尚未可查）。 */
async function republishAndVerifyBaseline() {
  await republishRetestData();
  for (let i = 0; i < 5; i++) {
    try {
      // public 这一支不是摆设：B 侧命名空间换了值就得走它，所以 NS_B 故意不标成字面量类型
      // （写成 const NS_B = "retest-qa" 会被推成字面量，tsc 判这个比较恒假，见轮85 记账）。
      const tenant = NS_B === PUBLIC_NAMESPACE ? "" : NS_B;
      const res = await fetch(
        `${BASE_B}/v1/cs/configs?dataId=svc-gateway.yaml&group=${encodeURIComponent(GROUP)}&tenant=${encodeURIComponent(tenant)}`,
        { cache: "no-store" }
      );
      const text = res.ok ? await res.text() : "";
      if (text.includes("生产环境") && !text.includes("开发环境")) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 1500));
  }
}
import { navigate, dismissStartupDialog, setDiffSource } from "./ui";

const NS_A = "retest-dev";
// 故意标成 string：B 侧命名空间若换成 public，上面那个 public 分支必须还接得住。
// 写成字面量常量会被推成 "retest-qa"，tsc 判 `NS_B === "public"` 恒假（TS2367），
// 分支在编译器眼里就是死代码——轮85 把 tests/ 纳入 typecheck 时捞出来的第一条真缺陷。
const NS_B: string = "retest-qa";
const PUBLIC_NAMESPACE = "public";
const BASE_A = "http://127.0.0.1:19848/nacos";
const BASE_B = "http://127.0.0.1:19849/nacos";
const GROUP = "RETEST-PROD";

/** 读取可能不存在的元素文本（存在则等待，否则 undefined）。 */
async function optionalText(page: import("@playwright/test").Page, selector: string, timeoutMs = 3_000): Promise<string | undefined> {
  const loc = page.locator(selector).first();
  try {
    await loc.waitFor({ state: "attached", timeout: timeoutMs });
    return (await loc.textContent({ timeout: 1_000 })) ?? undefined;
  } catch {
    return undefined;
  }
}

/** 单文档对比（自动恢复种子：左右连接+namespace+group 已预填 svc-gateway.yaml，这里显式重设保证确定性）。 */
async function loadSingleCompare(page: import("@playwright/test").Page, dataId = "svc-gateway.yaml") {
  await navigate(page, "配置对比");
  // 对比页自动恢复展开来源面板，过渡期间摘要条拦截点击，等过渡稳定。
  await page.waitForTimeout(500);
  await setDiffSource(page, "left", { connection: "Retest Nacos A", namespace: NS_A, group: GROUP, dataId });
  await setDiffSource(page, "right", { connection: "Retest Nacos B", namespace: NS_B, group: GROUP, dataId });
  await page.getByRole("button", { name: "加载并对比" }).last().click();
  await expect(page.locator(".diff-panel")).toBeVisible({ timeout: 30_000 });
}

// T-AP-01: 单文档完整链路：对比 → 进入计划 → 生成 dry-run → Dry-run 检查 → 勾选确认 → 执行 → Nacos B 落库
test("T-AP-01 单文档变更计划: 生成→dry-run→执行→落库验证", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  const t0 = Date.now();
  const mark = (label: string) => console.log(`[T-AP-01][t+${Date.now() - t0}ms] ${label}`);
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await loadSingleCompare(page);
  mark("对比完成");

  const before = await fetchNacosContent(BASE_B, NS_B, "svc-gateway.yaml", GROUP);
  mark("fetch before 完成");
  expect(before).toContain("生产环境");
  expect(before).not.toContain("开发环境");

  // 进入配置变更计划
  await page.getByRole("button", { name: "进入配置变更计划" }).last().click();
  await expect(page.locator(".apply-ledger, .apply-item-list").first()).toBeVisible({ timeout: 30_000 });
  mark("进入计划");

  // 全选变更项(计划默认可能未勾选, Dry-run 按钮需 selectedCount>0)
  const selectAllBtn = page.getByRole("button", { name: "全选" }).first();
  if (await selectAllBtn.count()) await selectAllBtn.click();
  await page.waitForTimeout(300);

  // Dry-run 检查 (自定义 button 组件, 用文本+force 定位)
  const dryRunBtn = page.locator("button", { hasText: "Dry-run 检查" }).last();
  await dryRunBtn.click({ force: true, timeout: 10_000 }).catch(() => undefined);
  if ((await page.locator(".apply-execution-notice").count()) === 0) {
    await dryRunBtn.evaluate((el) => (el as HTMLElement).click());
  }
  await expect(page.locator(".apply-execution-notice").filter({ hasText: "Dry-run 检查通过" })).toBeVisible({ timeout: 60_000 });
  mark("dry-run 通过");

  // 勾选确认 → 执行变更
  await page.locator(".apply-confirm-check input").check();
  await page.waitForTimeout(300);
  const execBtn = page.locator("button", { hasText: "执行变更" }).last();
  await execBtn.click({ force: true, timeout: 10_000 }).catch(() => undefined);
  if ((await page.locator(".apply-task-progress").count()) === 0) {
    await execBtn.evaluate((el) => (el as HTMLElement).click());
  }
  mark("已点击执行变更");

  await expect(page.locator(".apply-task-progress, .inline-error").first()).toBeVisible({ timeout: 60_000 });
  mark("进度面板出现");
  await expect(page.locator(".apply-task-progress .task-status-success, .apply-task-progress .task-status-failed").first()).toBeVisible({ timeout: 60_000 });
  mark("状态徽章出现");
  const taskStatus = await page.locator(".apply-task-progress .task-status").first().textContent().catch(() => null);
  const execNotice = await page.locator(".apply-execution-notice").last().textContent().catch(() => null);
  const execError = await optionalText(page, ".inline-error-body");
  console.log(`[T-AP-01] 任务状态=${taskStatus} 提示=${execNotice} 错误=${execError?.slice(0, 200)}`);
  expect(execError).toBeFalsy();
  expect(execNotice).toContain("变更执行完成");
  mark("执行完成断言通过");

  // 落库验证：B 侧变成 A 侧内容（开发环境注释回来，生产环境消失）
  const after = await fetchNacosContent(BASE_B, NS_B, "svc-gateway.yaml", GROUP);
  mark("fetch after 完成");
  expect(after).toContain("开发环境");
  expect(after).not.toContain("生产环境");
  await page.screenshot({ path: "results/ap01-single-executed.png", fullPage: true });
  mark("全部完成");
});

// T-AP-02: 批量对比（14 个同名 dataId，跨 RETEST-PROD/RETEST-ORDER/RETEST-MESSENGE/DEFAULT_GROUP 多 group）
// B 侧 svc-notify.yaml 是 tab 缩进 YAML 语法错误 → 该项 parse_error 被阻断，
// 勾选阻断项时执行按钮禁用（安全守卫）→ 取消勾选后执行其余 12 项
test("T-AP-02 批量变更计划: 13 项匹配 + parse_error 阻断守卫 + 执行落库", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  // 幂等：本测试会写库（执行变更），开始前重新发布种子数据，恢复 A/B 干净基线，
  // 否则上次执行已把 A/B 改成一致，计划会变成 11 skip 导致无可执行项。
  await republishAndVerifyBaseline();

  const t0 = Date.now();
  const mark = (label: string) => console.log(`[T-AP-02][t+${Date.now() - t0}ms] ${label}`);
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "配置对比");
  await setDiffSource(page, "left", { connection: "Retest Nacos A", namespace: NS_A, group: GROUP });
  await setDiffSource(page, "right", { connection: "Retest Nacos B", namespace: NS_B, group: GROUP });
  await page.getByRole("button", { name: "加载并对比" }).last().click();

  // 匹配列表：12 个 dataId 双侧都存在
  await expect(page.locator(".match-list")).toBeVisible({ timeout: 30_000 });
  const items = page.locator(".match-item");
  const itemCount = await items.count();
  console.log(`[T-AP-02] 匹配项数量 = ${itemCount}`);
  expect(itemCount).toBe(13);

  // 全选 → 批量对比
  await page.locator(".match-toggle-all input").check();
  await page.getByRole("button", { name: /对比选中/ }).last().click();
  await expect(page.locator(".batch-diff .batch-diff-nav-item").first()).toBeVisible({ timeout: 60_000 });
  mark("批量对比完成");

  // 批量进入变更计划
  const batchApplyBtn = page.getByRole("button", { name: /进入.*计划|批量.*计划/ }).last();
  if (await batchApplyBtn.count() === 0) {
    await page.getByRole("button", { name: "进入配置变更计划" }).last().click();
  } else {
    await batchApplyBtn.click();
  }
  await expect(page.locator(".apply-item-list, .apply-ledger").first()).toBeVisible({ timeout: 60_000 });
  mark("进入批量计划");

  // 计划摘要：13 项覆盖 + 1 项 parse_error（12 项中 1 项两侧一致被跳过）（svc-notify.yaml B 侧 tab 缩进）
  const summaryText = await page.locator(".apply-summary, .apply-count-strip").first().innerText().catch(() => "");
  console.log(`[T-AP-02] 计划摘要 = ${summaryText.slice(0, 200)}`);
  expect(summaryText).toMatch(/13/);
  expect(summaryText).toMatch(/解析失败 1|阻塞 1/);

  // svc-notify.yaml 行应标记为「已阻塞」
  const notifyRow = page.locator(".apply-item-row", { hasText: "svc-notify.yaml" }).first();
  await expect(notifyRow).toBeVisible({ timeout: 15_000 });
  expect(await notifyRow.locator(".apply-blocked").count()).toBeGreaterThan(0);
  await page.screenshot({ path: "results/ap02-batch-plan.png", fullPage: true });
  mark("parse_error 阻断项确认");

  // 安全守卫（执行层兜底 + UI 层禁用双保险）：
  //   ① svc-notify.yaml（parse_error）的 checkbox 必须 disabled，用户根本无法勾选它；
  //   ② 确认框 + 全选后，「执行变更」按钮针对 11 个可执行项可用（blocked 项从未进入选择集，
  //      所以按钮不该因它被禁用）；
  //   ③ 执行后 B 侧 svc-notify.yaml 必须保持原样（执行层 runPlan 兜底过滤 blocked/parse_error）。
  const notifyCheck = notifyRow.locator("input[type='checkbox']").first();
  expect(await notifyCheck.isDisabled()).toBeTruthy();
  console.log("[T-AP-02] svc-notify.yaml 复选框 disabled（不可被勾选）");

  // 确认框 + 点击「全选」按钮（限 .apply-item-toolbar，避免误命中匹配页/其他按钮）
  // → 仅 11 个可执行项进入选择集（blocked 项 checkbox 已 disabled，不会被全选）
  await page.locator(".apply-confirm-check input").check();
  await page.locator(".apply-item-toolbar button", { hasText: "全选" }).first().click();
  await page.waitForTimeout(300);
  const execBtn = page.getByRole("button", { name: /^执行/ }).last();
  const selectionText = await page.locator(".apply-item-toolbar > span").first().innerText().catch(() => "");
  console.log(`[T-AP-02] 选择集 = ${selectionText}  执行按钮 disabled=${await execBtn.isDisabled()}`);
  // 已选 11 项且不含 blocked → 执行按钮应可用
  expect(await execBtn.isDisabled()).toBeFalsy();
  await page.screenshot({ path: "results/ap02-exec-blocked.png", fullPage: true });
  mark("仅可执行项进入选择集，执行按钮可用");

  await execBtn.click();
  await expect(page.locator(".apply-task-progress .task-status-success, .apply-task-progress .task-status-failed").first()).toBeVisible({ timeout: 120_000 });
  const taskStatus = await page.locator(".apply-task-progress .task-status").first().textContent().catch(() => null);
  const execNotice = await page.locator(".apply-execution-notice").last().textContent().catch(() => null);
  console.log(`[T-AP-02] 任务状态=${taskStatus} 提示=${execNotice?.slice(0, 200)}`);
  expect(taskStatus).toContain("成功");
  expect(execNotice).toMatch(/变更执行完成|已应用 11/);
  // 阻断项未执行的提示。文案事实源：apply.executionSucceededWithBlocked
  // （80c3c38 把整句收进 i18n 后是「另有 N 项被阻断，未执行」，此前断言写死的「已阻断」再没匹配上过）
  expect(execNotice).toMatch(/2 项被阻断/);
  await page.screenshot({ path: "results/ap02-batch-executed.png", fullPage: true });
  mark("批量执行完成");

  // 落库验证：
  //  - B 侧 svc-gateway.yaml 应变成 A（开发）内容；
  //  - B 侧 svc-notify.yaml 因 B 侧 tab 缩进解析失败被跳过，保持原样（仍含 tab）；
  //  - 本次对比只针对 RETEST-PROD group，RETEST-ORDER 的 svc-order.toml 不在选择集内，
  //    必须保持原样（验证执行只改选择集内项，不跨 group 误写）。
  const bGateway = await fetchNacosContent(BASE_B, NS_B, "svc-gateway.yaml", GROUP);
  expect(bGateway).toContain("开发环境");
  const bNotify = await fetchNacosContent(BASE_B, NS_B, "svc-notify.yaml", GROUP);
  expect(bNotify).toContain("	");
  const bOrder = await fetchNacosContent(BASE_B, NS_B, "svc-order.toml", "RETEST-ORDER");
  expect(bOrder).not.toContain("开发端口"); // 未被 RETEST-PROD 对比波及
  mark("落库验证完成");
});

// T-AP-03: 浏览页直接发布被阻断（安全模型：只能走 ApplyPlan）
test("T-AP-03 浏览页保存走变更计划、未确认执行前 Nacos 不变", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "配置浏览");
  await page.locator(".browser-item", { hasText: "svc-pay.json" }).first().click();
  await expect(page.locator(".code-area")).toBeVisible({ timeout: 15_000 });

  // 进入编辑模式
  await page.getByRole("button", { name: "编辑" }).first().click();
  await expect(page.locator(".code-editor-ta")).toBeVisible({ timeout: 15_000 });
  const editor = page.locator(".code-editor-ta").first();
  await editor.click();
  await page.keyboard.press("Control+a");
  // 关键：编辑对象是 JSON 格式（svc-pay.json），若填入纯文本会被 validateConfig 判为
  // 「JSON 解析失败」而止步于格式校验，根本走不到写入这一步。必须填入合法 JSON，
  // 才能验证「保存不直写、必须先成计划」这条守卫（本测试真正要验证的）。
  await editor.evaluate((el) => {
    const input = el as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set?.bind(input);
    setter?.("{\"retest\": \"direct publish attempt\"}");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

  // 保存 = 生成变更计划（轮42 前的形态是「点保存 → 必然抛直接写入已禁用」，
  // 本用例锁的意图没变：浏览页的保存不能绕过计划确认直接改写 Nacos）。
  const saveBtn = page.getByRole("button", { name: /生成变更计划/ }).first();
  await expect(saveBtn).toBeVisible({ timeout: 15_000 });
  await saveBtn.click();
  await page.waitForTimeout(1500);

  // 守卫仍在：保存只落到变更计划——一条覆盖项，挂在正在编辑的那个配置上
  const rows = await planRows(page);
  console.log(`[T-AP-03] 计划项=${JSON.stringify(rows)}`);
  expect(rows.length, "就地编辑没有只生成一条计划").toBe(1);
  expect(rows[0].dataId, "计划挂在了别的配置上").toBe("svc-pay.json");
  expect(rows[0].action, "编辑保存的计划动作不是覆盖").toBe("overwrite");
  // 不许再出现「点了才报错」的直写失败呈现（旧形态的错误行 / 必然失败的重试）
  await expectNoDisabledWriteError(page);
  await backToBrowseFromPlan(page);
  await page.screenshot({ path: "results/ap03-direct-publish.png", fullPage: true });

  // Nacos 内容不变：未确认执行前守卫阻止了写入，A 侧 svc-pay.json 不应包含本次注入的标记
  const after = await fetchNacosContent(BASE_A, NS_A, "svc-pay.json", GROUP);
  expect(after).not.toContain("direct publish attempt");
});

/** 读取审计 jsonl 全部行（逐行解析；跳过脏行）。 */
function readAuditLines(): Array<Record<string, unknown>> {
  let text: string;
  try {
    text = readFileSync(RETEST_AUDIT_FILE, "utf8");
  } catch {
    return [];
  }
  const out: Array<Record<string, unknown>> = [];
  for (const raw of text.split("\n")) {
    const l = raw.trim();
    if (!l) continue;
    try {
      const obj = JSON.parse(l) as unknown;
      if (obj && typeof obj === "object" && !Array.isArray(obj)) out.push(obj as Record<string, unknown>);
    } catch {
      // 脏行：跳过
    }
  }
  return out;
}

// T-AP-04: 变更会话记录（apply-* 事件链，含完整配置内容）
// 单文档 对比→计划→dry-run→执行 全链路后，audit-trail.jsonl 必须出现
// 本次运行的 apply_session_start / apply_selection / apply_dryrun / apply_execute /
// apply_item_result / apply_result（同 sessionId 串成一条时间线），
// payload 含完整配置内容（svc-gateway.yaml 的“生产环境”/“开发环境”），
// 且任何事件不含凭据字段（accessToken/password）。
test("T-AP-04 变更会话记录: 5 步事件链 + 完整内容 + 无凭据", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  const runStartIso = new Date().toISOString();
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  // 重置测试数据基线（写库测试会修改 Nacos B，需恢复到"生产/开发"基线）
  await republishAndVerifyBaseline();
  await loadSingleCompare(page);

  await page.getByRole("button", { name: "进入配置变更计划" }).last().click();
  await expect(page.locator(".apply-ledger, .apply-item-list").first()).toBeVisible({ timeout: 30_000 });

  const selectAllBtn = page.getByRole("button", { name: "全选" }).first();
  if (await selectAllBtn.count()) await selectAllBtn.click();
  await page.waitForTimeout(300);

  const dryRunBtn = page.locator("button", { hasText: "Dry-run 检查" }).last();
  await dryRunBtn.click({ force: true, timeout: 10_000 }).catch(() => undefined);
  if ((await page.locator(".apply-execution-notice").count()) === 0) {
    await dryRunBtn.evaluate((el) => (el as HTMLElement).click());
  }
  await expect(page.locator(".apply-execution-notice").filter({ hasText: "Dry-run 检查通过" })).toBeVisible({ timeout: 60_000 });

  await page.locator(".apply-confirm-check input").check();
  await page.waitForTimeout(300);
  const execBtn = page.locator("button", { hasText: "执行变更" }).last();
  await execBtn.click({ force: true, timeout: 10_000 }).catch(() => undefined);
  if ((await page.locator(".apply-task-progress").count()) === 0) {
    await execBtn.evaluate((el) => (el as HTMLElement).click());
  }
  await expect(page.locator(".apply-task-progress, .inline-error").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".apply-task-progress .task-status-success, .apply-task-progress .task-status-failed").first()).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(500);

  const lines = readAuditLines().filter((l) => String(l.ts ?? "") >= runStartIso);
  const byKind = (k: string) => lines.filter((l) => l.kind === k);
  console.log(`[T-AP-04] 本次行数=${lines.length}` +
    ` session_start=${byKind("apply_session_start").length}` +
    ` selection=${byKind("apply_selection").length}` +
    ` dryrun=${byKind("apply_dryrun").length}` +
    ` execute=${byKind("apply_execute").length}` +
    ` item_result=${byKind("apply_item_result").length}` +
    ` result=${byKind("apply_result").length}`);

  // 5 步事件链齐全（同一条变更会话）
  for (const kind of ["apply_session_start", "apply_selection", "apply_dryrun", "apply_execute", "apply_item_result", "apply_result"] as const) {
    expect(byKind(kind).length).toBeGreaterThanOrEqual(1);
  }
  // 同一 sessionId 串成时间线（除 session_start/end 外的 apply-* 事件共用一个会话）
  const sessionIds = new Set(lines.filter((l) => String(l.kind).startsWith("apply_")).map((l) => l.sessionId));
  expect(sessionIds.size).toBe(1);
  const applySessionId = [...sessionIds][0];
  for (const kind of ["apply_session_start", "apply_selection", "apply_dryrun", "apply_execute", "apply_item_result", "apply_result"] as const) {
    expect(byKind(kind).every((l) => l.sessionId === applySessionId)).toBe(true);
  }

  // 完整配置内容：session_start 的 payload 含 svc-gateway.yaml 的源/目标全文
  const start = byKind("apply_session_start")[0] as { payload?: string };
  const startPayload = JSON.parse(String(start.payload ?? "{}")) as {
    items?: Array<{ ref?: { dataId?: string }; sourceValue?: { content?: string }; targetValue?: { content?: string } }>;
  };
  const startItem = startPayload.items?.find((i) => i.ref?.dataId === "svc-gateway.yaml");
  expect(startItem).toBeTruthy();
  expect(startItem?.sourceValue?.content).toContain("开发环境");
  expect(startItem?.targetValue?.content).toContain("生产环境");

  // 逐项结果：before/after 完整内容
  const itemResult = byKind("apply_item_result")[0] as { payload?: string };
  const itemPayload = JSON.parse(String(itemResult.payload ?? "{}")) as { beforeContent?: string; afterContent?: string };
  expect(String(itemPayload.beforeContent ?? "")).toContain("生产环境");
  expect(String(itemPayload.afterContent ?? "")).toContain("开发环境");

  // 安全：任何本次事件不含凭据字段
  for (const line of lines) {
    expect(JSON.stringify(line)).not.toMatch(/accessToken|password/i);
  }
  await page.screenshot({ path: "results/ap04-apply-session-record.png", fullPage: true });
});

// T-AP-05: 变更计划内人工编辑目标内容（机器判定不准/需人工补充场景）
// 链路：对比 svc-pay.properties → 进入计划 → 选中项 → 编辑目标内容 → 保存并重新校验
// → diff 预览含新 marker → dry-run → 执行 → B 侧落库含 marker → 恢复基线。
// 附带断言：编辑事件 apply_edit_target 写入变更会话且含完整编辑后内容。
test("T-AP-05 变更计划内人工编辑目标内容: 编辑→校验→执行→落库", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  // 幂等：执行变更会写 B 侧，开始前恢复种子基线
  await republishRetestData();

  const t0 = Date.now();
  const mark = (label: string) => console.log(`[T-AP-05][t+${Date.now() - t0}ms] ${label}`);
  const runStartIso = new Date().toISOString();
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);

  await loadSingleCompare(page, "svc-pay.properties");
  mark("对比完成");

  const before = await fetchNacosContent(BASE_B, NS_B, "svc-pay.properties", GROUP);
  mark("fetch before 完成");
  expect(before).toBeTruthy();

  await page.getByRole("button", { name: "进入配置变更计划" }).last().click();
  await expect(page.locator(".apply-ledger, .apply-item-list").first()).toBeVisible({ timeout: 30_000 });
  mark("进入计划");

  const selectAllBtn = page.getByRole("button", { name: "全选" }).first();
  if (await selectAllBtn.count()) await selectAllBtn.click();
  await page.waitForTimeout(300);

  // 打开选中项详情（默认选中第一项），点"编辑目标内容"
  await page.locator(".apply-item-row").first().click().catch(() => undefined);
  // 编辑面板会盖住上方"全选"按钮，先点"编辑目标内容"再勾选，
  // 避免点"全选"时实际点到编辑面板（导致面板关闭、勾选中止）
  await page.getByRole("button", { name: "编辑目标内容" }).click({ timeout: 10_000 });
  await expect(page.locator(".apply-edit-panel")).toBeVisible({ timeout: 10_000 });
  mark("编辑面板打开");

  const marker = `retest.edit.marker=${Date.now()}`;
  await page.locator(".apply-edit-editor textarea").first().fill(before + "\n" + marker + "\n");
  await page.getByRole("button", { name: "保存并重新校验" }).click();
  await page.waitForTimeout(800);
  await expect(page.locator(".apply-edit-panel")).toHaveCount(0);
  const diffText = (await page.locator(".apply-diff-preview").textContent().catch(() => "")) ?? "";
  expect(diffText, "diff 预览应包含编辑后 marker").toContain(marker);
  mark("编辑保存，diff 已更新");

  // 勾选本变更项（详情勾选框；面板遮挡下用 force 点击）
  const itemCheck = page.locator(".apply-item-row input[type=checkbox]").first();
  await itemCheck.check({ force: true });
  await expect(page.locator(".apply-selection-note").first()).toContainText("已选变更项：1");
  mark("变更项已勾选");

  // 确认项已选中（无需再点"全选"——编辑面板遮挡时点"全选"可能误触面板）

  // Dry-run → 执行
  const dryRunBtn = page.locator("button", { hasText: "Dry-run 检查" }).last();
  await dryRunBtn.click({ force: true, timeout: 10_000 }).catch(() => undefined);
  if ((await page.locator(".apply-execution-notice").count()) === 0) {
    await dryRunBtn.evaluate((el) => (el as HTMLElement).click());
  }
  await expect(page.locator(".apply-execution-notice").filter({ hasText: "Dry-run 检查" })).toBeVisible({ timeout: 60_000 });
  mark("dry-run 完成");

  await page.locator(".apply-confirm-check input").check();
  await page.waitForTimeout(300);
  const execBtn = page.locator("button", { hasText: "执行变更" }).last();
  await execBtn.click({ force: true, timeout: 10_000 }).catch(() => undefined);
  if ((await page.locator(".apply-task-progress").count()) === 0) {
    await execBtn.evaluate((el) => (el as HTMLElement).click());
  }
  await expect(page.locator(".apply-task-progress, .inline-error").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".apply-task-progress .task-status-success, .apply-task-progress .task-status-failed").first()).toBeVisible({ timeout: 60_000 });
  const execNotice = await page.locator(".apply-execution-notice").last().textContent().catch(() => null);
  console.log(`[T-AP-05] 执行提示=${String(execNotice).slice(0, 80)}`);
  expect(execNotice).toContain("变更执行完成");
  mark("执行完成");

  // 落库验证：轮询 B 侧直到 marker 出现（publish 异步落库）
  let after = "";
  for (let i = 0; i < 30; i++) {
    after = await fetchNacosContent(BASE_B, NS_B, "svc-pay.properties", GROUP).catch(() => "");
    if (after.includes(marker)) break;
    await page.waitForTimeout(2000);
  }
  expect(after, "B 侧应包含人工编辑写入的 marker").toContain(marker);
  mark("B 侧落库验证通过");

  // 会话记录：apply_edit_target 事件含完整编辑后内容
  const lines = readAuditLines().filter((l) => String(l.ts ?? "") >= runStartIso);
  const editEvents = lines.filter((l) => l.kind === "apply_edit_target");
  expect(editEvents.length).toBeGreaterThanOrEqual(1);
  const editPayload = JSON.parse(String((editEvents[0] as { payload?: string }).payload ?? "{}")) as {
    dataId?: string; afterContent?: string;
  };
  expect(editPayload.dataId).toBe("svc-pay.properties");
  expect(String(editPayload.afterContent ?? "")).toContain(marker);
  mark("apply_edit_target 会话记录验证通过");

  // 恢复基线（把 marker 摘掉，保证后续用例/人工复测基线干净）
  await republishRetestData();
  for (let i = 0; i < 15; i++) {
    const cur = await fetchNacosContent(BASE_B, NS_B, "svc-pay.properties", GROUP).catch(() => "");
    if (!cur.includes(marker)) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  await page.screenshot({ path: "results/ap05-edit-target.png", fullPage: true });
  mark("全部完成");
});
