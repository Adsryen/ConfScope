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
import { installRetestBridge, RETEST_AUDIT_FILE } from "../bridge/installRetestBridge";
import { navigate, dismissStartupDialog } from "./ui";

const GROUP = "RETEST-PROD";

type Page = import("@playwright/test").Page;

/**
 * 汇总条的状态分布。
 * 这是「全量口径」的读数：AuditView 的 summaryBar 吃的是未过滤 rows（src/components/AuditView.tsx:1114），
 * r111 起矩阵 body 只挂可见窗口，想问「某个状态到底有没有 / 有多少」只能走这里，不能数 DOM 行。
 */
async function summaryStatusCounts(page: Page): Promise<Record<string, number>> {
  const items = await page.locator(".audit-summary .audit-summary-item").allInnerTexts();
  const out: Record<string, number> = {};
  for (const item of items) {
    const m = item.match(/^(.+?):\s*(\d+)\s*$/);
    if (m) out[m[1].trim()] = Number(m[2]);
  }
  return out;
}

/** 矩阵当前的数据量：spacer 总高 ÷ 单行高（窗口化渲染下 DOM 行数只是可见窗口大小）。 */
async function matrixRowCount(page: Page): Promise<number> {
  const spacer = await page.locator(".audit-matrix-spacer").first().boundingBox();
  const rowH = await page.locator(".audit-matrix-body .audit-matrix-row").first().boundingBox();
  if (!spacer || !rowH || rowH.height <= 0) return 0;
  return Math.round(spacer.height / rowH.height);
}

/** 状态筛选 chip（按钮文案就是状态名）。 */
function statusChip(page: Page, label: string) {
  return page.locator(".audit-filter-bar button").filter({ hasText: label }).last();
}

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
  const nsVals = await envCards
    .locator("label.field:has(> span:text-is('命名空间')) input")
    .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
  const groupVals = await envCards
    .locator("label.field:has(> span:text-is('group')) input")
    .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
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
  // 读法（r111 起 body 窗口化，数 DOM 行看不到全量）：汇总条给全量分布，状态筛选给「筛得对不对」。
  const totalRows = await matrixRowCount(page);
  console.log(`[T-AUD-01] 全量数据量 = ${totalRows}，DOM 可见窗口行数 = ${rowCount}`);
  expect(totalRows, "矩阵应有多行数据").toBeGreaterThan(rowCount);

  const summary = await page.locator(".audit-summary").first().innerText();
  console.log(`[T-AUD-01] 汇总 = ${summary.slice(0, 200)}`);
  expect(summary).toMatch(/共\s+\d+\s+项/);
  const counts = await summaryStatusCounts(page);
  console.log(`[T-AUD-01] 汇总状态分布 = ${JSON.stringify(counts)}`);
  expect(counts["不一致"] ?? 0, "A/B 之间有取值不同的 key，汇总必须报出「不一致」").toBeGreaterThan(0);
  expect(counts["解析失败"] ?? 0, "svc-notify.yaml 的 tab 缩进必须判成「解析失败」并计入汇总").toBeGreaterThan(0);
  await page.screenshot({ path: "results/aud01-matrix.png", fullPage: true });

  // 状态筛选「解析失败」：数据量要收窄到汇总里那个数，且可见行徽章全是它（窗口化下的正确读法）
  await statusChip(page, "解析失败").click();
  await page.waitForTimeout(250);
  const parseErrRows = await matrixRowCount(page);
  const parseErrBadges = await page.locator(".audit-matrix-body .audit-matrix-row .audit-status-badge").allInnerTexts();
  console.log(`[T-AUD-01] 筛选「解析失败」：数据量 ${parseErrRows}，可见行徽章 ${JSON.stringify(parseErrBadges)}`);
  expect(parseErrRows, "筛选后的数据量必须等于汇总里的「解析失败」条数").toBe(counts["解析失败"]);
  expect(Array.from(new Set(parseErrBadges)), "筛选后可见行的徽章只能全是「解析失败」").toEqual(["解析失败"]);
  // 汇总条始终是未过滤的全量分布（这也是上面走它取数的原因），筛选不该改动它
  expect(await summaryStatusCounts(page), "筛选后汇总条仍是全量口径").toEqual(counts);
  await statusChip(page, "解析失败").click(); // 取消筛选，还原
  await page.waitForTimeout(250);

  // 状态筛选「不一致」：同样只看数据量与徽章，不再比 DOM 行数大小（两侧都被窗口截断，比不出关系）
  await statusChip(page, "不一致").click();
  await page.waitForTimeout(250);
  const inconsistentRows = await matrixRowCount(page);
  const inconsistentBadges = await page.locator(".audit-matrix-body .audit-matrix-row .audit-status-badge").allInnerTexts();
  console.log(`[T-AUD-01] 筛选「不一致」：数据量 ${inconsistentRows}，可见行数 ${inconsistentBadges.length}`);
  expect(inconsistentRows, "筛选后的数据量必须等于汇总里的「不一致」条数").toBe(counts["不一致"]);
  expect(inconsistentRows, "筛选必须真的收窄数据量").toBeLessThan(totalRows);
  expect(Array.from(new Set(inconsistentBadges)), "筛选后可见行的徽章只能全是「不一致」").toEqual(["不一致"]);
  await statusChip(page, "不一致").click(); // 取消筛选，还原
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
  const leftGroupValue = await groupFields
    .nth(0)
    .inputValue()
    .catch(() => "");
  const rightGroupValue = await groupFields
    .nth(1)
    .inputValue()
    .catch(() => "");
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
    const dataIdField = page
      .locator(".source-picker")
      .nth(side)
      .locator("label.field")
      .filter({ hasText: "dataId" })
      .locator("input")
      .first();
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

// T-AUD-03: 重复配置检查面板（r110 引入，1.10.0 修掉它顶掉钉住详情条的回归）
// 口径：默认收起 + 组数常显；展开后每页 10 组；无论清单多长，面板都排在 .audit-detail 之前，
// 滚到底详情条必须仍在视口内（sticky;bottom:0 的两个前提，F35 那套判据在这里再走一遍真机路径）。
test("T-AUD-03 重复配置检查: 默认收起、展开分页、不把钉住的详情条顶出视口", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await republishAndVerify(page);

  await navigate(page, "配置矩阵");
  await expect(page.locator(".audit-page")).toBeVisible({ timeout: 15_000 });
  await page.locator(".audit-actions button.btn-primary", { hasText: "执行审计" }).click();
  await expect(page.locator(".audit-matrix-header .audit-cell.env").first()).toBeVisible({ timeout: 60_000 });

  const panel = page.locator(".dup-check");
  await expect(panel).toBeVisible();

  // ── 收起态：组数是这条面板唯一可见的信息量，清单与忽略清单都不许摊开 ──
  const countText = await panel.locator(".dup-check-count").innerText();
  const totalGroups = Number((countText.match(/\d+/) ?? ["0"])[0]);
  console.log(`[T-AUD-03] 收起态组数文案 = ${JSON.stringify(countText)} ⇒ 解析出 ${totalGroups} 组`);
  expect(totalGroups).toBeGreaterThan(0);
  expect(await panel.locator("li.dup-check-group").count(), "默认收起：一条清单都不摊开").toBe(0);
  expect(await panel.locator(".dup-check-ignores").count(), "默认收起：忽略清单也不摊开").toBe(0);
  // 判据开关与统计留在面板头上——关掉一条判据不该先展开面板
  await expect(panel.locator(".dup-check-bar .dup-check-stat")).toBeVisible();
  await expect(panel.locator(".dup-check-toggle")).toHaveAttribute("aria-expanded", "false");

  // ── 选中一行，钉住的详情条出现 ──
  await page.locator(".audit-matrix-body .audit-matrix-row").first().click();
  await expect(page.locator(".audit-detail")).toBeVisible({ timeout: 10_000 });

  // ── 展开：每页最多 10 组，超出给「再显示」 ──
  await panel.locator(".dup-check-toggle").click();
  await expect(panel.locator(".dup-check-toggle")).toHaveAttribute("aria-expanded", "true");
  const rendered = await panel.locator("li.dup-check-group").count();
  console.log(`[T-AUD-03] 展开后首屏组数 = ${rendered}（全量 ${totalGroups}）`);
  expect(rendered).toBe(Math.min(10, totalGroups));
  if (totalGroups > 10) {
    const more = panel.locator(".dup-check-more");
    await expect(more).toBeVisible();
    await more.click();
    const rendered2 = await panel.locator("li.dup-check-group").count();
    console.log(`[T-AUD-03] 点「再显示」后组数 = ${rendered2}`);
    expect(rendered2).toBe(Math.min(20, totalGroups));
  }

  // ── 真机几何：展开清单后滚到底，详情条必须还钉在视口下缘 ──
  const geom = await page.evaluate(() => {
    const pageEl = document.querySelector(".audit-page") as HTMLElement;
    pageEl.scrollTop = pageEl.scrollHeight - pageEl.clientHeight;
    const detail = document.querySelector(".audit-detail") as HTMLElement;
    const dup = document.querySelector(".dup-check") as HTMLElement;
    const kids = Array.from(pageEl.children);
    const rect = detail.getBoundingClientRect();
    return {
      orderOk: kids.indexOf(dup) < kids.indexOf(detail),
      isLast: !detail.nextElementSibling,
      top: Math.round(rect.top),
      gap: Math.round(window.innerHeight - rect.bottom),
      pageH: Math.round(pageEl.scrollHeight - pageEl.clientHeight),
      scrollTop: Math.round(pageEl.scrollTop),
    };
  });
  console.log(`[T-AUD-03] 滚到底 ${JSON.stringify(geom)}`);
  expect(geom.orderOk, "重复检查面板必须排在 .audit-detail 之前").toBe(true);
  expect(geom.isLast, "详情条必须是页面流最后一个元素，否则 sticky;bottom:0 失效").toBe(true);
  expect(geom.top, "展开清单后详情条仍要留在视口内（改前实测整条飞出到 -4463）").toBeGreaterThanOrEqual(0);
  expect(geom.gap, "详情条下缘与视口下缘只留 padding-bottom:16 的呼吸").toBeGreaterThanOrEqual(-2);
  expect(geom.gap, "详情条下缘与视口下缘只留 padding-bottom:16 的呼吸").toBeLessThanOrEqual(20);

  await page.screenshot({ path: "results/aud03-dup-panel.png", fullPage: false });
});
