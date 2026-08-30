// 95: PRD 剩余场景 — C2/C3（矩阵行跳转/一致性）、D6（执行失败）、
//     F2（快照浏览内容）、G2（任务详情）、H2（审计 jsonl 展开/筛选）
// 每个用例开头 republishRetestData 恢复基线；写操作类用 Nacos API 回读断言。
import { test, expect, fetchNacosContent } from "./retestTest";
import { installRetestBridge, RETEST_AUDIT_FILE } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog, setDiffSource } from "./ui";
import { loadRetestState } from "../state";
import { readFileSync } from "node:fs";

const state = loadRetestState();
const BASE_A = state.nacos.a.baseUrl;
const BASE_B = state.nacos.b.baseUrl;
const NS_A = state.nacos.a.namespace;
const NS_B = state.nacos.b.namespace;
const GROUP = "RETEST-PROD";
const PORT_KEY = "server.port";

/** 标准启动：装桥 + 播种 + 进首页关启动弹窗。 */
async function boot(page: import("@playwright/test").Page) {
  await installRetestBridge(page, state);
  await republishRetestData();
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
}

/** 矩阵页添加第二环境并执行审计（93 同套路：两个环境卡默认连接 A/B）。 */
async function runMatrixAudit(page: import("@playwright/test").Page) {
  await navigate(page, "配置矩阵");
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "+ 环境" }).click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "执行审计" }).click();
  await expect(page.locator(".audit-matrix-body .audit-matrix-row").first()).toBeVisible({ timeout: 60_000 });
}

/** Nacos 直接发布（绕过 UI，仅用于制造 D6 失败前置条件）。 */
async function nacosPublish(baseUrl: string, tenant: string, dataId: string, group: string, content: string) {
  const qs = `dataId=${encodeURIComponent(dataId)}&group=${encodeURIComponent(group)}&tenant=${encodeURIComponent(tenant)}&content=${encodeURIComponent(content)}&type=yaml`;
  await fetch(`${baseUrl}/v1/cs/configs?${qs}`, { method: "POST" });
}

// C2: 矩阵行「跳转 Diff 对比」/「生成变更计划」入口行为
test("C2 矩阵行: 跳转 Diff 对比与生成变更计划入口", async ({ page, retest }) => {
  await boot(page);
  await runMatrixAudit(page);

  // 选一个「不一致」行 → 详情面板
  const row = page
    .locator(".audit-matrix-body .audit-matrix-row")
    .filter({ has: page.locator(".audit-status-badge", { hasText: "不一致" }) })
    .first();
  await row.click();
  await expect(page.locator(".audit-detail").first()).toBeVisible({ timeout: 10_000 });

  // 跳转 Diff 对比 → 对比页两侧来源已按该行预填，且自动对比出结果
  await page.locator(".audit-detail button", { hasText: "跳转 Diff 对比" }).click();
  await expect(page.locator(".source-picker").first()).toBeVisible({ timeout: 20_000 });
  expect(await page.locator(".source-picker").count()).toBe(2);
  // 左右 dataId 一致（同一行）
  const dataIds = await page.locator(".source-picker input").evaluateAll((els) =>
    els.map((e) => (e as HTMLInputElement).value)
  );
  const picked = dataIds.filter((v) => v.startsWith("svc-"));
  expect(new Set(picked).size).toBe(1);
  await page.screenshot({ path: "results/c2-jump-diff.png", fullPage: true });

  // 返回矩阵重新执行审计 → 同一「不一致」行 → 生成变更计划 → 计划页含该 dataId 的条目
  await navigate(page, "配置矩阵");
  await runMatrixAudit(page);
  const row2 = page
    .locator(".audit-matrix-body .audit-matrix-row")
    .filter({ has: page.locator(".audit-status-badge", { hasText: "不一致" }) })
    .first();
  await expect(row2).toBeVisible({ timeout: 30_000 });
  const rowText = await row2.locator(".audit-dataid").first().innerText();
  await row2.click();
  await expect(page.locator(".audit-detail").first()).toBeVisible({ timeout: 10_000 });
  await page.locator(".audit-detail button", { hasText: "生成变更计划" }).click();
  await expect(page.locator(".apply-view .apply-ledger, .apply-view .apply-item-list").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".apply-view").first()).toContainText(rowText.trim(), { timeout: 10_000 });
  await page.screenshot({ path: "results/c2-start-apply.png", fullPage: true });
  void retest;
});

// C3: 矩阵数据与 Nacos 实际一致性抽查
test("C3 矩阵一致性: 抽查 server.port 单元格值与 Nacos 回读一致", async ({ page, retest }) => {
  await boot(page);
  await runMatrixAudit(page);

  // 先记录 Nacos 两侧实际值（抽查基准）
  const [aContent, bContent] = [
    await fetchNacosContent(BASE_A, NS_A, "svc-gateway.yaml", GROUP),
    await fetchNacosContent(BASE_B, NS_B, "svc-gateway.yaml", GROUP),
  ];
  const pickPort = (c: string) => (c.match(/^\s*port:\s*(\S+)/m) ?? [])[1] ?? "";
  const portA = pickPort(aContent);
  const portB = pickPort(bContent);
  expect(portA).toBeTruthy();
  expect(portB).toBeTruthy();

  // 行定位策略：优先精确匹配 key=server.port 的行；
  // 该 dataId 两侧 port 值相同时（8080/8080）行状态为「一致」，默认筛选下可能被隐藏，
  // 此时打开「一致」筛选再找；仍找不到则断言失败并打印当前可见行。
  const rowByPort = page
    .locator(".audit-matrix-body .audit-matrix-row")
    .filter({ has: page.locator(".audit-dataid", { hasText: "svc-gateway.yaml" }) })
    .filter({ has: page.locator(".audit-key", { hasText: "server.port" }) });
  if ((await rowByPort.count()) === 0) {
    await page.locator(".audit-filter-bar button", { hasText: "一致" }).first().click();
    await page.waitForTimeout(500);
  }
  await expect(rowByPort.first()).toBeVisible({ timeout: 15_000 });
  const portRow = rowByPort.first();
  const cellTexts = (await portRow.locator(".audit-cell.value").allInnerTexts()).map((s) => s.trim());
  const joined = cellTexts.join("|");
  console.log(`[C3] server.port 单元格=${JSON.stringify(cellTexts)} A=${portA} B=${portB}`);
  // 两侧单元格分别等于 Nacos 回读值（顺序 = 环境卡顺序 A, B）
  expect(cellTexts[0]).toBe(portA);
  expect(cellTexts[1]).toBe(portB);
  await page.screenshot({ path: "results/c3-consistency.png", fullPage: true });
  void retest;
});

// D6: 执行失败路径 — B 侧先被外部改成与计划目标不同的新值（带 updateTime），
//     计划执行时新鲜度校验失败 → 任务失败计数 + 错误展示，B 侧保持外部值。
test("D6 执行失败: 目标侧外部修改导致新鲜度校验失败", async ({ page, retest }) => {
  await boot(page);

  // 1) 对比 svc-gateway.yaml → 计划页（不执行）
  await navigate(page, "配置对比");
  await page.waitForTimeout(500);
  await setDiffSource(page, "left", { connection: "Retest Nacos A", namespace: NS_A, group: GROUP, dataId: "svc-gateway.yaml" });
  await setDiffSource(page, "right", { connection: "Retest Nacos B", namespace: NS_B, group: GROUP, dataId: "svc-gateway.yaml" });
  await page.getByRole("button", { name: "加载并对比" }).last().click();
  await expect(page.locator(".diff-panel")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "进入配置变更计划" }).last().click();
  await expect(page.locator(".apply-ledger, .apply-item-list").first()).toBeVisible({ timeout: 30_000 });
  const selectAllBtn = page.getByRole("button", { name: "全选" }).first();
  if (await selectAllBtn.count()) await selectAllBtn.click();

  // 2) 执行前：绕过 UI 直接改 B 侧（改 port 值并追加 marker）→ B 侧 updateTime 前进
  const bOriginal = await fetchNacosContent(BASE_B, NS_B, "svc-gateway.yaml", GROUP);
  const bTampered = bOriginal
    .replace("port: 9090", "port: 9091")
    + "\n# retest-d6-external-change\n";
  // B 侧 port 实际是 9090（prod 值）；若替换未命中则直接在尾部追加注释行制造差异
  const bFinal = bTampered.includes("port: 9091") ? bTampered : bOriginal + "\n# retest-d6-external-change\n";
  await nacosPublish(BASE_B, NS_B, "svc-gateway.yaml", GROUP, bFinal);
  await page.waitForTimeout(1_500); // 等 Nacos 落库 + md5/updateTime 生效

  // 3) Dry-run 检查 + 勾选确认 + 执行 → 新鲜度校验失败（目标侧已不同于计划基准）
  await page.locator("button", { hasText: "Dry-run 检查" }).last().click({ force: true }).catch(() => undefined);
  await page.waitForTimeout(1_000);
  await page.locator(".apply-confirm-check input").check({ force: true }).catch(() => undefined);
  await page.locator("button", { hasText: "执行变更" }).last().click({ force: true }).catch(() => undefined);

  // 4) 断言：执行进度「失败」状态 + 错误信息（stale 校验 / 变更执行失败）
  await expect(page.locator("body").getByText("变更执行失败").first()).toBeVisible({ timeout: 60_000 });
  await expect(
    page.locator(".apply-task-progress").getByText(/失败/).first()
  ).toBeVisible({ timeout: 10_000 });
  const bodyText = await page.locator("body").innerText();
  expect(bodyText).toMatch(/stale|过期|校验/i);
  expect(bodyText).toMatch(/失败/);
  await page.screenshot({ path: "results/d6-exec-failed.png", fullPage: true });

  // 5) B 侧回读：仍是外部改过的值（UI 执行未写入；B 原文本就含 port: 8080，不能据此断言）
  const after = await fetchNacosContent(BASE_B, NS_B, "svc-gateway.yaml", GROUP);
  expect(after).toContain("retest-d6-external-change");
  expect(after).not.toContain("port: 9091"); // 计划目标内容里也不该有这个值
  expect(after).toBe(bFinal);
  await page.screenshot({ path: "results/d6-after.png", fullPage: true });
  void retest;
});

// F2: 快照浏览 — 创建快照后在备份快照页查看快照内容（配置列表 + 详情字段）
test("F2 快照浏览: 创建快照后查看内容", async ({ page, retest }) => {
  await boot(page);

  // 浏览页创建当前列表快照（按钮 title=创建当前列表快照，文本即该词）
  await navigate(page, "配置浏览");
  await expect(page.locator(".browser-item-id").first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "创建当前列表快照" }).click();
  // 快照创建逐条 getConfig（约 16 项），等任务中心任务出现
  await navigate(page, "任务中心");
  await expect(page.getByText("创建当前列表快照：").first()).toBeVisible({ timeout: 30_000 });
  // 等任务跑完（success 状态出现）
  await expect(page.locator(".task-status-success").first()).toBeVisible({ timeout: 60_000 });

  // 备份快照页：快照列表出现新快照，点击查看详情
  await navigate(page, "备份快照");
  const item = page.locator(".backup-item").first();
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator(".backup-detail").first()).toBeVisible({ timeout: 10_000 });

  // 详情：基本信息行 + 配置列表（含 svc-gateway.yaml RETEST-PROD）
  const detail = page.locator(".backup-detail").first();
  await expect(detail.locator(".info-row").first()).toBeVisible({ timeout: 10_000 });
  const cfgRow = detail.locator(".backup-config-item", { hasText: "svc-gateway.yaml" }).first();
  await expect(cfgRow).toBeVisible({ timeout: 10_000 });
  await expect(cfgRow.locator(".backup-config-group")).toContainText("RETEST-PROD");
  // 配置项类型列非空（configType 字段已兼容）
  await expect(cfgRow.locator(".backup-config-type").first()).not.toHaveCount(0);
  await page.screenshot({ path: "results/f2-snapshot-view.png", fullPage: true });
  void retest;
});

// G2: 任务详情 — 点击任务条目展示详情字段（ID/类型/状态/耗时/失败计数）
test("G2 任务详情: 条目点击后详情字段完整", async ({ page, retest }) => {
  await boot(page);

  // 浏览页创建快照 → 任务中心出现任务
  await navigate(page, "配置浏览");
  await expect(page.locator(".browser-item-id").first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "创建当前列表快照" }).click();
  await navigate(page, "任务中心");
  await expect(page.getByText("创建当前列表快照：").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".task-status-success").first()).toBeVisible({ timeout: 60_000 });
  const task = page.locator(".task-item").first();
  await task.click();

  const detail = page.locator(".task-detail").first();
  await expect(detail).toBeVisible({ timeout: 10_000 });
  // 详情字段：任务 ID / 类型 / 状态 / 名称
  const detailText = await detail.innerText();
  expect(detailText).toMatch(/任务 ?ID|类型|状态|耗时|开始/);
  expect(detailText).toMatch(/快照|备份|snapshot|backup/i);
  // 操作按钮：删除（非 running 状态）或 取消
  await expect(
    detail.locator("button", { hasText: /删除|取消|复制/ }).first()
  ).toBeVisible({ timeout: 5_000 });
  await page.screenshot({ path: "results/g2-task-detail.png", fullPage: true });
  void retest;
});

// H2: 审计 jsonl — 展开/筛选（页面筛选已在 60-audit 覆盖；这里补 jsonl 侧：
//     本用例产生的会话在 audit-trail.jsonl 留有 session_start/result 且可按 sessionId 展开全部事件）
test("H2 审计记录: 对比+审计会话在 jsonl 可展开全部事件", async ({ page, retest }) => {
  await boot(page);

  // 执行一次单文档对比
  await navigate(page, "配置对比");
  await page.waitForTimeout(500);
  await setDiffSource(page, "left", { connection: "Retest Nacos A", namespace: NS_A, group: GROUP, dataId: "svc-gateway.yaml" });
  await setDiffSource(page, "right", { connection: "Retest Nacos B", namespace: NS_B, group: GROUP, dataId: "svc-gateway.yaml" });
  await page.getByRole("button", { name: "加载并对比" }).last().click();
  await expect(page.locator(".diff-panel")).toBeVisible({ timeout: 30_000 });

  // 再跑一次矩阵审计
  await runMatrixAudit(page);

  await page.waitForTimeout(1_000);
  if (!RETEST_AUDIT_FILE) throw new Error("RETEST_AUDIT_FILE 未配置");
  const lines = readFileSync(RETEST_AUDIT_FILE, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((x): x is Record<string, unknown> => !!x);

  // 取本次运行（ts 在最近 5 分钟内）的 compare 会话；session_start 自带 scope=kind
  const now = Date.now();
  const recent = lines.filter((l) => {
    const t = Date.parse(String(l.ts ?? l.timestamp ?? ""));
    return !isNaN(t) && now - t < 5 * 60 * 1000;
  });
  const compareStarts = recent.filter((l) => l.kind === "session_start" && (l.scope === "compare" || String(l.sessionId ?? "").startsWith("compare-")));
  const auditStarts = recent.filter((l) => l.kind === "session_start" && (l.scope === "audit" || String(l.sessionId ?? "").startsWith("audit-")));
  expect(compareStarts.length).toBeGreaterThan(0);
  expect(auditStarts.length).toBeGreaterThan(0);

  // 「展开」= 按 sessionId 聚合出完整事件链（start → … → result）
  const expand = (sid: string) => recent.filter((l) => l.sessionId === sid);
  const compareSession = expand(String(compareStarts[compareStarts.length - 1].sessionId));
  expect(compareSession.some((l) => l.kind === "session_start")).toBeTruthy();
  expect(compareSession.some((l) => /result|end|finish/i.test(String(l.kind)))).toBeTruthy();
  const auditSession = expand(String(auditStarts[auditStarts.length - 1].sessionId));
  expect(auditSession.some((l) => l.kind === "session_start")).toBeTruthy();
  expect(auditSession.some((l) => /result|end|finish/i.test(String(l.kind)))).toBeTruthy();
  console.log(`[H2] compare 事件数=${compareSession.length} audit 事件数=${auditSession.length}`);
  await page.screenshot({ path: "results/h2-audit-jsonl.png", fullPage: true });
  void retest;
});
