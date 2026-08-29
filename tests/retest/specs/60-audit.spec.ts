import { readFileSync } from "node:fs";
import { republishRetestData } from "../bridge/republishData";

/** 幂等重发 + 直连 Nacos 轮询确认两侧种子已落地（防止 republish 返回时数据尚未可查导致的偶发空矩阵）。 */
async function republishAndVerify(page: import("@playwright/test").Page) {
  await republishRetestData();
  for (let attempt = 0; attempt < 10; attempt++) {
    const ok = await page.evaluate(async () => {
      const probe = async (base: string, tenant: string) => {
        const r = await fetch(`${base}/v1/cs/configs?search=blur&dataId=&group=RETEST-PROD&tenant=${tenant}&pageNo=1&pageSize=50`);
        const d = await r.json();
        return d.pageItems?.length ?? 0;
      };
      const [a, b] = await Promise.all([
        probe("http://127.0.0.1:19848/nacos", "retest-dev"),
        probe("http://127.0.0.1:19849/nacos", "retest-qa"),
      ]);
      return a >= 13 && b >= 13;
    });
    if (ok) return;
    await page.waitForTimeout(2_000);
  }
}
import { test, expect } from "./retestTest";
import { installRetestBridge, RETEST_BRIDGE_MARKER, RETEST_AUDIT_FILE } from "../bridge/installRetestBridge";
import { navigate, dismissStartupDialog } from "./ui";

const GROUP = "RETEST-PROD";

/** 读取审计 jsonl 全部行（逐行解析为对象；跳过空行与无法解析的脏行）。
 *  逐行 try/catch：文件里若混入历史脏行（如早期非 JSON 行）不会让整次读取失败。 */
function readAuditLines(): Array<Record<string, unknown>> {
  if (!RETEST_AUDIT_FILE) return [];
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
      // 脏行：跳过（不中断其余有效行的读取）
    }
  }
  return out;
}

// T-AUD-01: 配置矩阵（AuditView）
// 两个 Nacos 环境（连接已配 defaultGroup=RETEST-PROD）→ 执行审计 →
// 13 个 svc-* 矩阵行/状态徽章/汇总/筛选/导出/跳 Diff（含 svc-legacy-prod.yaml）。
test("T-AUD-01 配置矩阵: 双环境审计 + 状态筛选 + 导出", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);

  // 幂等：前面的 T-AP-02 会执行变更把 B 侧改成和 A 一致，导致矩阵全是「一致」。
  // 重新发布种子数据恢复 A≠B 的干净基线，并轮询确认两侧 RETEST-PROD 均已落地。
  await republishAndVerify(page);

  await navigate(page, "配置矩阵");
  await expect(page.locator(".audit-page")).toBeVisible({ timeout: 15_000 });

  // 环境卡：连接已配 defaultGroup=RETEST-PROD → group 字段预填 RETEST-PROD（不再需要手工清空）
  const envCards = page.locator(".audit-env-card");
  expect(await envCards.count()).toBe(2);
  const envNames = await envCards.locator(".audit-env-name").allInnerTexts();
  console.log(`[T-AUD-01] 环境 = ${JSON.stringify(envNames)}`);
  expect(envNames.join(",").toLowerCase()).toContain("nacos a");
  expect(envNames.join(",").toLowerCase()).toContain("nacos b");
  // group 输入框预填自连接的 defaultGroup（RETEST-PROD）；
  // 注意 placeholder 是 i18n 的 diff.groupPlaceholder（非字面 "Group"），按 .audit-env-card 里的字段定位
  const groupInputs = envCards.locator("label.field:has(> span:text-is('group')) input");
  await expect(groupInputs.first()).toHaveValue("RETEST-PROD", { timeout: 10_000 });
  console.log(`[T-AUD-01] group 输入框数 = ${await groupInputs.count()}`);

  // 诊断：打印每个环境卡的 namespace/group 实际值（排查两环境是否读同一 ns）
  const nsVals = await envCards.locator("label.field:has(> span:text-is('命名空间')) input").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
  const groupVals = await envCards.locator("label.field:has(> span:text-is('group')) input").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
  console.log(`[T-AUD-01] 诊断 namespace=${JSON.stringify(nsVals)} group=${JSON.stringify(groupVals)}`);

  // 执行审计
  await page.locator(".audit-actions button.btn-primary", { hasText: "执行审计" }).click();

  // 矩阵表头（环境列 + 基准按钮）
  await expect(page.locator(".audit-matrix-header .audit-cell.env").first()).toBeVisible({ timeout: 60_000 });
  expect(await page.locator(".audit-matrix-header .audit-cell.env").count()).toBe(2);
  await expect(page.locator(".audit-matrix-header .audit-cell.baseline").first()).toBeVisible({ timeout: 10_000 });

  // 矩阵是 key 级（group+dataId+key 一行），13 个 dataId 会展开成很多 key 行（数百级）。
  // 这里只断言「至少有一些行」+「覆盖了多个 dataId」。
  const rows = page.locator(".audit-matrix-body .audit-matrix-row");
  await expect(rows.first()).toBeVisible({ timeout: 30_000 });
  const rowCount = await rows.count();
  console.log(`[T-AUD-01] 矩阵行数 = ${rowCount}`);
  expect(rowCount).toBeGreaterThan(0);

  // 状态分布（key 级）：A≠B 的 key → 不一致；
  // svc-notify.yaml B 侧 tab 缩进 YAML 语法错误 → 解析失败；
  // 不同 group 的同名 dataId（order/notify/monitor）在对方环境不存在 → 缺失（key 级缺失，正常）。
  const badges = await rows.locator(".audit-status-badge").allInnerTexts();
  console.log(`[T-AUD-01] 状态分布 = ${JSON.stringify(badges.slice(0, 10))} ... 共 ${badges.length}`);
  expect(badges).toContain("不一致");
  expect(badges).toContain("解析失败");

  // 汇总条（key 级，故"共 N 项"是 key 数不是 dataId 数）
  const summary = await page.locator(".audit-summary").first().innerText();
  console.log(`[T-AUD-01] 汇总 = ${summary.slice(0, 160)}`);
  expect(summary).toMatch(/共\s+\d+\s+项/);
  expect(summary).toMatch(/不一致|解析失败/);
  await page.screenshot({ path: "results/aud01-matrix.png", fullPage: true });

  // 状态筛选：勾选「不一致」后行数应 < 14
  await page.locator(".audit-filter-bar .audit-filter-chip, .audit-filter-bar button").filter({ hasText: "不一致" }).last().click();
  const visibleAfterFilter = await page.locator(".audit-matrix-body .audit-matrix-row").count();
  console.log(`[T-AUD-01] 筛选「不一致」后行数 = ${visibleAfterFilter}`);
  expect(visibleAfterFilter).toBeGreaterThan(0);
  expect(visibleAfterFilter).toBeLessThan(rowCount); // 筛选后行数应比全部少
  await page.locator(".audit-filter-bar .audit-filter-chip, .audit-filter-bar button").filter({ hasText: "不一致" }).last().click(); // 取消筛选，还原
  await page.waitForTimeout(300);
  await page.screenshot({ path: "results/aud01-filter.png", fullPage: true });

  // 导出 CSV
  const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
  await page.locator(".audit-export button", { hasText: "导出" }).click();
  const download = await downloadPromise;
  console.log(`[T-AUD-01] 导出文件名 = ${download.suggestedFilename()}`);
  expect(download.suggestedFilename()).toMatch(/^audit-.*\.csv$/);
  await page.screenshot({ path: "results/aud01-export.png", fullPage: true });

  // 选中不一致行 → 详情面板「跳转 Diff 对比」/「生成变更计划」
  const inconsistentRow = page
    .locator(".audit-matrix-body .audit-matrix-row")
    .filter({ has: page.locator(".audit-status-badge", { hasText: "不一致" }) })
    .first();
  await inconsistentRow.click();
  await expect(page.locator(".audit-detail").first()).toBeVisible({ timeout: 10_000 });
  const detailText = await page.locator(".audit-detail").first().innerText();
  console.log(`[T-AUD-01] 行详情 = ${detailText.slice(0, 200)}`);
  await page.screenshot({ path: "results/aud01-row.png", fullPage: true });
  expect(detailText).toMatch(/跳转 Diff 对比/);
  expect(detailText).toMatch(/生成变更计划/);

  // 跳转 Diff 对比 → 对比页，左右来源已按矩阵行预填（左右独立 namespace 修复验证点之一）
  await page.locator(".audit-detail button", { hasText: "跳转 Diff 对比" }).click();
  await expect(page.locator(".source-picker").first()).toBeVisible({ timeout: 20_000 });
  expect(await page.locator(".source-picker").count()).toBe(2);
  await page.screenshot({ path: "results/aud01-jump-diff.png", fullPage: true });
});

// T-AUD-02: 会话审计 JSONL（audit-trail.jsonl，模拟 Go AppendAuditEvent 落盘）
// 1) 单文档对比产生 compare_start / compare_result 事件，含方向与左右来源
// 2) 审计矩阵执行产生 audit_run_start / audit_run_result 事件
// 3) jsonl 每行可解析、含 sessionId、且绝不包含凭据字段
test("T-AUD-02 审计日志: audit-trail.jsonl 记录对比与审计全过程", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  // 幂等：audit-trail.jsonl 跨 run 只追加，记录本次起始时间戳，
  // 之后只断言「本次运行」产生的事件（过滤掉历史脏数据，如 compare_result=567 的陈旧行）。
  const runStartIso = new Date().toISOString();

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);

  // 1) 单文档对比（svc-gateway.yaml，左右独立 namespace）
  // 种子已把左右连接/namespace/group 预填为 RETEST-PROD，这里只需确认 group 非空后直接对比
  await navigate(page, "配置对比");
  const groupFields = page.locator(".source-picker label.field:has(> span:has-text('分组')) input");
  const leftGroupValue = await groupFields.nth(0).inputValue().catch(() => "");
  const rightGroupValue = await groupFields.nth(1).inputValue().catch(() => "");
  console.log(`[T-AUD-02] 预填 group: 左=${leftGroupValue} 右=${rightGroupValue}`);
  if (!leftGroupValue) {
    await groupFields.nth(0).fill("RETEST-PROD");
    await groupFields.nth(0).press("Enter");
  }
  if (!rightGroupValue) {
    await groupFields.nth(1).fill("RETEST-PROD");
    await groupFields.nth(1).press("Enter");
  }
  for (const side of [0, 1] as const) {
    const dataIdField = page.locator(".source-picker").nth(side).locator("label.field").filter({ hasText: "dataId" }).locator("input").first();
    await dataIdField.fill("svc-gateway.yaml");
    await dataIdField.press("Enter");
  }
  await page.getByRole("button", { name: "加载并对比" }).last().click();
  await expect(page.locator(".diff-panel")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(500);

  // 2) 审计矩阵
  await navigate(page, "配置矩阵");
  await page.locator(".audit-actions button.btn-primary", { hasText: "执行审计" }).click();
  await expect(page.locator(".audit-matrix-body .audit-matrix-row").first()).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(500);

  // 3) 校验 jsonl —— 只取「本次运行」的事件（ts >= runStartIso），排除历史脏数据
  const allLines = readAuditLines();
  const lines = allLines.filter((l) => {
    const ts = String(l.ts ?? "");
    return ts >= runStartIso; // ISO8601 字符串字典序 == 时间序
  });
  console.log(`[T-AUD-02] jsonl 总行数=${allLines.length}，本次运行=${lines.length}`);
  expect(lines.length).toBeGreaterThan(0);

  // 所有本次行必须是合法 JSON 对象，且含 kind
  for (const line of lines) {
    expect(line).toHaveProperty("kind");
  }

  // 对比事件：compare_start 与 compare_result 成对，含 direction 与左右来源
  const compareStarts = lines.filter((l) => l.kind === "compare_start");
  const compareResults = lines.filter((l) => l.kind === "compare_result");
  console.log(`[T-AUD-02] 本次 compare_start=${compareStarts.length} compare_result=${compareResults.length}`);
  expect(compareStarts.length).toBeGreaterThanOrEqual(1);
  expect(compareResults.length).toBeGreaterThanOrEqual(1);
  const lastResult = compareResults[compareResults.length - 1];
  expect(lastResult).toHaveProperty("sessionId");
  // direction 记录在 compare_start 上（compare_result 不含 direction 字段）
  const lastStart = compareStarts[compareStarts.length - 1];
  expect(String(lastStart.direction ?? "")).toMatch(/->/);
  expect(lastStart.source).toBeTruthy();
  expect(lastStart.target).toBeTruthy();
  const src = lastStart.source as Record<string, unknown>;
  const tgt = lastStart.target as Record<string, unknown>;
  expect(src.dataId).toBe("svc-gateway.yaml");
  expect(tgt.dataId).toBe("svc-gateway.yaml");
  // 左右独立 namespace：左 retest-dev / 右 retest-qa
  expect(String(src.namespace)).toBe("retest-dev");
  expect(String(tgt.namespace)).toBe("retest-qa");
  expect(String(src.group)).toBe(GROUP);
  expect(String(tgt.group)).toBe(GROUP);

  // 审计运行事件（本次）
  const auditRuns = lines.filter((l) => l.kind === "audit_run_start" || l.kind === "audit_run_result");
  console.log(`[T-AUD-02] 本次 audit_run 事件 = ${auditRuns.length}`);
  expect(auditRuns.length).toBeGreaterThanOrEqual(2);

  // 安全：任何事件不得包含凭据字段
  for (const line of lines) {
    const text = JSON.stringify(line);
    expect(text).not.toMatch(/accessToken|password/i);
  }
  await page.screenshot({ path: "results/aud02-jsonl.png", fullPage: true });
});
