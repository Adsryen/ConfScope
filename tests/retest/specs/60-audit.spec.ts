import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { test, expect } from "./retestTest";
import { installRetestBridge, RETEST_BRIDGE_MARKER } from "../bridge/installRetestBridge";
import { navigate, dismissStartupDialog, selectSel } from "./ui";

// T-AUD-01: 配置矩阵（AuditView）
// 两个 Nacos 环境各加载播种配置 → 执行审计 → 矩阵行/状态徽章/汇总/筛选/导出
test("T-AUD-01 配置矩阵: 双环境审计 + 状态筛选 + 导出", async ({ page, retest }) => {
  // preflight 两步（顺序不能反）：
  // 1) 重跑幂等 seed 脚本：前序 spec（ApplyPlan 等）会覆写/删除两侧 retest 配置，
  //    seed 会先删除再重建全部 retest 前缀配置，保证审计前两侧 == 精确播种基线，
  //    同时刷新 Nacos Last-Modified（v1 秒级精度下这是唯一可靠的「全新发布」锚点）。
  // 2) 清空 retest 命名空间的全部 /tmp 发布 stamp：前序 spec 写入的 stamp 可能晚于
  //    刚刷新的 Nacos 时间戳（同秒发布无法区分），保留会让 bridge 误判 B 侧「内容未变」；
  //    审计矩阵只比较内容（updateTime 不参与），审计前本会话没有发布动作，
  //    清空后 bridge 回落到 Nacos Last-Modified 即可。保留非 retest 命名空间的键。
  const seedScript = "../../.trellis/tasks/08-28-full-functionality-retest/env/seed_nacos.py";
  console.log("[T-AUD-01] preflight: 重跑 seed_nacos.py 恢复两侧基线…");
  execFileSync("python3", [seedScript], { cwd: ".", timeout: 60_000, stdio: "pipe" });
  const stampFile = "/tmp/confscope-retest-publish-stamps.json";
  if (existsSync(stampFile)) {
    const stamps = JSON.parse(readFileSync(stampFile, "utf8")) as Record<string, number>;
    const ns = retest.nacos;
    const kept: Record<string, number> = {};
    for (const [key, value] of Object.entries(stamps)) {
      const [baseUrl, namespace] = key.split("|");
      const isRetest = (baseUrl === ns.a.baseUrl && namespace === ns.a.namespace) || (baseUrl === ns.b.baseUrl && namespace === ns.b.namespace);
      if (!isRetest) kept[key] = value;
    }
    console.log(`[T-AUD-01] preflight: 清空 retest stamp（保留 ${Object.keys(kept).length} 个非 retest 键）`);
    writeFileSync(stampFile, JSON.stringify(kept));
  }
  await installRetestBridge(page, retest);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "配置矩阵");
  await expect(page.locator(".audit-page")).toBeVisible({ timeout: 15_000 });

  // 默认已有两个环境卡（播种连接 retest-a / retest-b）。
  // AuditView 环境卡 group 默认硬编码 DEFAULT_GROUP（只含播种 4 项），
  // 测试环境为 retest-dev/retest-qa 全命名空间对比 → 清空 group 过滤（真人操作等价于留空 placeholder）。
  const envCards = page.locator(".audit-env-card");
  expect(await envCards.count()).toBe(2);
  const envNames = await envCards.locator(".audit-env-name").allInnerTexts();
  console.log(`[T-AUD-01] 环境 = ${JSON.stringify(envNames)}`);
  expect(envNames.join(",")).toContain("Retest Nacos A");
  expect(envNames.join(",")).toContain("Retest Nacos B");
  // 按 placeholder 定位（card 作用域）：命名空间 placeholder=public，group placeholder=DEFAULT_GROUP
  for (const card of await envCards.all()) {
    const groupInput = card.locator("input[placeholder='DEFAULT_GROUP']");
    await expect(groupInput).toHaveValue("DEFAULT_GROUP");
    await groupInput.fill("");
    await expect(groupInput).toHaveValue("");
  }

  // 执行审计
  await page.locator(".audit-actions button.btn-primary", { hasText: "执行审计" }).click();

  // 矩阵表头（环境列 + 基准按钮）
  await expect(page.locator(".audit-matrix-header .audit-cell.env").first()).toBeVisible({ timeout: 60_000 });
  expect(await page.locator(".audit-matrix-header .audit-cell.env").count()).toBe(2);
  // 基准标记
  await expect(page.locator(".audit-matrix-header .audit-cell.baseline").first()).toBeVisible({ timeout: 10_000 });

  // 矩阵行：yaml/json/properties 双侧值不同 → 不一致；toml 双侧相同 → 一致；
  // only-a / only-b / edit-a 各缺一侧 → 缺失；txt 按 __document 整体比较
  const rows = page.locator(".audit-matrix-body .audit-matrix-row");
  await expect(rows.first()).toBeVisible({ timeout: 30_000 });
  const rowCount = await rows.count();
  console.log(`[T-AUD-01] 矩阵行数 = ${rowCount}`);
  expect(rowCount).toBeGreaterThanOrEqual(15);
  const diag = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".audit-matrix-body .audit-matrix-row"));
    return rows.map((r) => {
      const key = r.querySelector(".audit-cell.key")?.innerText?.trim() ?? "";
      const cells = Array.from(r.querySelectorAll(".audit-cell.value, .audit-cell.missing")).map((c) =>
        c.classList.contains("missing") ? "MISSING" : c.innerText.trim()
      );
      return { key, cells };
    });
  });
  console.log(`[T-AUD-01] 矩阵明细 = ${JSON.stringify(diag)}`);
  const badges = await rows.locator(".audit-status-badge").allInnerTexts();
  console.log(`[T-AUD-01] 状态分布 = ${JSON.stringify(badges)}`);
  // 按 key 展开：yaml/json/properties 两侧值不同 → 不一致；txt 的 line2 在 B 侧被改写 → 不一致
  expect(badges).toContain("不一致");
  // toml 两侧完全相同（3.1/3.2）→ 一致
  expect(badges).toContain("一致");
  // only-a / only-b / edit-a 三个 dataId 各缺一侧 → 缺失行
  expect(badges).toContain("缺失");

  // 汇总条
  const summary = await page.locator(".audit-summary").first().innerText();
  console.log(`[T-AUD-01] 汇总 = ${summary.slice(0, 160)}`);
  expect(summary).toMatch(/共 \d+ 项/);
  expect(summary).toMatch(/不一致/);
  await page.screenshot({ path: "results/aud01-matrix.png", fullPage: true });

  // 状态筛选：勾选「一致」后，「不一致」行应被隐藏
  await page.locator(".audit-filter-bar .audit-filter-chip, .audit-filter-bar button", { hasText: "一致" }).last().click();
  const visibleAfterFilter = await page.locator(".audit-matrix-body .audit-matrix-row").count();
  console.log(`[T-AUD-01] 筛选「一致」后行数 = ${visibleAfterFilter}`);
  expect(visibleAfterFilter).toBeLessThan(rowCount);
  await page.screenshot({ path: "results/aud01-filter.png", fullPage: true });

  // 导出：浏览器下载方式（downloadFile 走 <a download>），捕获下载事件验证文件名/扩展名
  const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
  await page.locator(".audit-export button", { hasText: "导出" }).click();
  const download = await downloadPromise;
  console.log(`[T-AUD-01] 导出文件名 = ${download.suggestedFilename()}`);
  expect(download.suggestedFilename()).toMatch(/^audit-.*\.csv$/);
  await page.screenshot({ path: "results/aud01-export.png", fullPage: true });

  // 选中一行 → 详情面板出现「跳转 Diff 对比」/「生成变更计划」
  const inconsistentRow = page.locator(".audit-matrix-body .audit-matrix-row").filter({ has: page.locator(".audit-status-badge", { hasText: "不一致" }) }).first();
  await inconsistentRow.click();
  await expect(page.locator(".audit-detail").first()).toBeVisible({ timeout: 10_000 });
  const detailText = await page.locator(".audit-detail").first().innerText();
  console.log(`[T-AUD-01] 行详情 = ${detailText.slice(0, 200)}`);
  await page.screenshot({ path: "results/aud01-row.png", fullPage: true });
  expect(detailText).toMatch(/跳转 Diff 对比/);
  expect(detailText).toMatch(/生成变更计划/);

  // 跳转 Diff 对比 → 侧边栏切到配置对比页，且左右来源已按矩阵行预填
  await page.locator(".audit-detail button", { hasText: "跳转 Diff 对比" }).click();
  await expect(page.locator(".source-picker").first()).toBeVisible({ timeout: 20_000 });
  const pickers = await page.locator(".source-picker").count();
  console.log(`[T-AUD-01] 跳转后来源面板数 = ${pickers}`);
  expect(pickers).toBeGreaterThanOrEqual(1);
  await page.screenshot({ path: "results/aud01-jump-diff.png", fullPage: true });
});
