// r139 真机判据：配置矩阵（一致性审计）的项目级跨环境内容搜索。
//
// 用户诉求原话：「我现在需要对一个项目下的所有环境支持搜索的功能」——落点是配置矩阵页，
// 因为一轮审计早就把 环境数 × 配置数 的正文取回内存了，再问「这个词散在哪几个环境」
// 不该再取一次数（选型与理由见 docs/todo/v1.10.0-progress.md 轮139 段）。
//
// 七条判据各钉一件事，红的时候能直接说清是谁动的手：
// - AES-01 处数只有一个来源：列头徽标、DOM 红底、`1/N` 三个读数必须相等（同一页两套「处」是最恶劣的错）；
// - AES-02 名称列逐处可停靠 + 只有一侧有值时徽标只落在那一列 + 详情面板共用同一份区间；
// - AES-03 跨屏命中导航：Enter 连走只许往下，不许把用户已读的那屏弹回开头；
// - AES-04 Ctrl+F 的焦点归属：空白处抢给矩阵搜索框，环境卡输入框不被抢，框内再按不死键；
// - AES-05 输入法组合态：半截拼音不上屏就不扫描（轮66 同一课的第二次应用）；
// - AES-06 还没执行审计：回车 = 先跑这轮审计再带着原词命中，不让人白等一趟；
// - AES-07 零命中必须把作用域念出来（多少行、几个环境），否则用户只当搜索坏了。
//
// 夹具自播种自清理：A/B 各发一条 `retest-r139-search.yaml`（group RETEST-PROD）。
// 选词普查过：A/B 现存 13 条 svc-* 全文里 alpha / scan-shared / dev-only-7f3a / r139 命中数都是 0，
// 于是「命中处数」能写成常量而不是相对读数。dataId 前缀 retest- 归 strays 清扫兜底，
// afterAll 再显式删一次，红在中间也不给下一批留尸体。
import { test, expect } from "./retestTest";
import type { Page } from "@playwright/test";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { publishNacosContent } from "../bridge/republishData";
import { navigate, dismissStartupDialog } from "./ui";
import { loadRetestState, type RetestState } from "../state";

const state = loadRetestState();
const BASE_A = state.nacos.a.baseUrl;
const BASE_B = state.nacos.b.baseUrl;
const NS_A = state.nacos.a.namespace;
const NS_B = state.nacos.b.namespace;
const GROUP = "RETEST-PROD";
const DATA_ID = "retest-r139-search.yaml";
const NO_TERM = "zzz-not-exist-9x";

/** 夹具形状（决定每条用例的期望处数，改夹具必须同步改这里）。 */
const SCAN_KEYS = 40;
const FIXTURE_ROWS = 3 + SCAN_KEYS; // token / port / only + scan00..scan39
/** A 侧「alpha alpha」2 处 + B 侧「alpha」1 处，值命中 3 处，名称列 0 处。 */
const ALPHA_TARGETS = 3;
/** 40 行 × 每行 A/B 各 1 处 = 80 处，够跨出两三屏。 */
const SCAN_TARGETS = SCAN_KEYS * 2;
/** 43 行 ×（dataId 1 处 + key 1 处），值列一处都没有。 */
const NAME_TARGETS = FIXTURE_ROWS * 2;

const SEARCH_INPUT = ".audit-search-input";

function fixtureContent(side: "A" | "B"): string {
  const lines = [
    "# r139 跨环境搜索真机夹具（跑完即删）",
    "r139:",
    // A 侧一行两处、B 侧一处：徽标与 1/N 是否同源，就看这两格
    side === "A" ? "  token: alpha alpha" : "  token: alpha",
    "  port: 8080",
  ];
  // only 只写 A 侧：B 侧那一格必须判「缺失」，画不出红底也不许算进徽标
  if (side === "A") lines.push("  only: dev-only-7f3a");
  for (let i = 0; i < SCAN_KEYS; i += 1) {
    lines.push(`  scan${String(i).padStart(2, "0")}: scan-shared`);
  }
  return `${lines.join("\n")}\n`;
}

/** 双侧播种（幂等：内容一致时 publish 直接过）。每条用例开头都调一次，防被上一批的收尾删掉。 */
async function seedFixture(): Promise<void> {
  await publishNacosContent(BASE_A, NS_A, DATA_ID, GROUP, fixtureContent("A"));
  await publishNacosContent(BASE_B, NS_B, DATA_ID, GROUP, fixtureContent("B"));
}

async function dropFixture(): Promise<void> {
  for (const [base, ns] of [
    [BASE_A, NS_A],
    [BASE_B, NS_B],
  ] as const) {
    const url = `${base}/v1/cs/configs?dataId=${encodeURIComponent(DATA_ID)}&group=${encodeURIComponent(GROUP)}&tenant=${encodeURIComponent(ns)}`;
    await fetch(url, { method: "DELETE" }).catch(() => null);
  }
}

/** 矩阵行高是常量（轮34/35 实测 48px），但一律实测而不写死：写了就要在下次改行高时红一次。 */
async function matrixGeometry(page: Page): Promise<{ rows: number; rowHeight: number; viewportH: number }> {
  return page.locator(".audit-matrix-body").evaluate((body) => {
    const spacer = body.querySelector<HTMLElement>(".audit-matrix-spacer");
    const row = body.querySelector<HTMLElement>(".audit-matrix-row");
    const rowHeight = row ? row.getBoundingClientRect().height : 0;
    const rows = spacer && rowHeight > 0 ? Math.round(spacer.getBoundingClientRect().height / rowHeight) : 0;
    return { rows, rowHeight, viewportH: body.clientHeight };
  });
}

/** 列头徽标读数（按列标签取，不赌列序）。没出徽标的列记 0。 */
async function envBadges(page: Page): Promise<Array<{ label: string; count: number }>> {
  return page.locator(".audit-matrix-header .audit-cell.env").evaluateAll((cells) =>
    cells.map((cell) => ({
      label: cell.querySelector(".audit-env-label")?.textContent?.trim() ?? "",
      count: Number(cell.querySelector(".audit-env-hit-badge")?.textContent?.trim() ?? "0"),
    }))
  );
}

async function searchCountText(page: Page): Promise<string> {
  const box = page.locator(".audit-search-count");
  return (await box.count()) > 0 ? (await box.first().innerText()).trim() : "";
}

async function summaryMainText(page: Page): Promise<string> {
  const box = page.locator(".audit-search-summary-main");
  return (await box.count()) > 0 ? (await box.first().innerText()).trim() : "";
}

/** 输入 + 回车：回车走 runNow，不等 400ms 防抖，扫描一定已经发生。 */
async function submitSearch(page: Page, term: string): Promise<void> {
  const input = page.locator(SEARCH_INPUT);
  await input.fill(term);
  await input.press("Enter");
  await expect(page.locator(".audit-search-summary")).toBeVisible({ timeout: 15_000 });
}

/** 当前停靠处的几何：实心高亮是否恰好一处、且落在列表视口里。 */
async function hitSnapshot(page: Page): Promise<{ currentCount: number; insideBody: boolean; scrollTop: number }> {
  return page.evaluate(() => {
    const marks = Array.from(document.querySelectorAll("mark.search-hit-current"));
    const body = document.querySelector<HTMLElement>(".audit-matrix-body");
    if (!body) return { currentCount: marks.length, insideBody: false, scrollTop: -1 };
    const b = body.getBoundingClientRect();
    const inside =
      marks.length === 1 &&
      (() => {
        const r = marks[0].getBoundingClientRect();
        return r.top >= b.top - 1 && r.bottom <= b.bottom + 1;
      })();
    return { currentCount: marks.length, insideBody: inside, scrollTop: body.scrollTop };
  });
}

async function bootstrap(page: Page, retest: RetestState): Promise<void> {
  await installRetestBridge(page, retest);
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await seedFixture();
  await navigate(page, "配置矩阵");
  await expect(page.locator(".audit-page")).toBeVisible({ timeout: 15_000 });
}

async function runAudit(page: Page): Promise<void> {
  await page.locator(".audit-actions button.btn-primary", { hasText: "执行审计" }).click();
  await expect(page.locator(".audit-matrix-header .audit-cell.env").first()).toBeVisible({ timeout: 90_000 });
}

test.describe("r139 配置矩阵跨环境内容搜索", () => {
  test.afterAll(async () => {
    await dropFixture();
  });

  test("AES-01 值命中逐处编号：徽标、DOM 红底、1/N 三处同源，只看命中行可折叠", async ({ page, retest }) => {
    await bootstrap(page, retest);
    await runAudit(page);
    const before = await matrixGeometry(page);
    console.log(`[AES-01] 全量行=${before.rows} 行高=${before.rowHeight} 视口高=${before.viewportH}`);
    expect(before.rows).toBeGreaterThan(FIXTURE_ROWS);

    await submitSearch(page, "alpha");
    const badges = await envBadges(page);
    const badgeSum = badges.reduce((sum, item) => sum + item.count, 0);
    const countText = await searchCountText(page);
    const marks = await page.locator(".audit-matrix-body mark.search-hit").count();
    const current = await page.locator("mark.search-hit-current").count();
    const summary = await summaryMainText(page);
    console.log(`[AES-01] 徽标=${JSON.stringify(badges)} 徽标和=${badgeSum} DOM红底=${marks} 1/N=${countText} 当前处=${current} 摘要=${summary}`);

    expect(badgeSum, "列头徽标之和必须等于可导航处数").toBe(ALPHA_TARGETS);
    expect(marks, "画得出的红底数必须等于可导航处数（同一页不许有两套「处」）").toBe(ALPHA_TARGETS);
    expect(countText).toBe(`1/${ALPHA_TARGETS}`);
    expect(current, "实心高亮任何时刻只许有一处").toBe(1);

    const devBadge = badges.find((item) => item.label.includes(NS_A));
    const qaBadge = badges.find((item) => item.label.includes(NS_B));
    expect(devBadge?.count, `A 侧「alpha alpha」应画 2 处，读数=${JSON.stringify(badges)}`).toBe(2);
    expect(qaBadge?.count, `B 侧「alpha」应画 1 处，读数=${JSON.stringify(badges)}`).toBe(1);

    const parsed = /在 (\d+) 行 · (\d+) 个环境中命中 (\d+) 处/.exec(summary);
    expect(parsed, `摘要文案口径变了：${summary}`).not.toBeNull();
    expect(Number(parsed?.[1]), "摘要说的行数 = 参与匹配的行数（折叠不改作用域）").toBe(before.rows);
    expect(Number(parsed?.[2])).toBe(2);
    expect(Number(parsed?.[3])).toBe(ALPHA_TARGETS);

    // 「只看命中行」默认开着：列表收窄到那一行
    const onlyHits = page.locator(".audit-search-opt input[type='checkbox']");
    expect(await onlyHits.isChecked(), "只看命中行默认勾选（命中几十处时全量列表等于让人自己找）").toBe(true);
    expect((await matrixGeometry(page)).rows).toBe(1);
    await onlyHits.click();
    await expect
      .poll(async () => (await matrixGeometry(page)).rows, { timeout: 15_000 })
      .toBe(before.rows);
    // 展开全量后命中行未必在渲染窗口里（列表是窗口化的，行 42 / 214 根本不在 DOM 里），
    // 靠命中导航把它带进视口再数——这本身就是要钉的行为：Enter 必须真的能定位到那一行。
    await page.locator(SEARCH_INPUT).press("Enter");
    await expect
      .poll(() => page.locator(".audit-matrix-body .audit-matrix-row.has-hit").count(), { timeout: 15_000 })
      .toBe(1);
    expect(
      await page.locator(".audit-matrix-body mark.search-hit").count(),
      "折叠只影响行集合，不影响处数：展开后红底仍是同样 3 处"
    ).toBe(ALPHA_TARGETS);
    await onlyHits.click();
    await expect
      .poll(async () => (await matrixGeometry(page)).rows, { timeout: 15_000 })
      .toBe(1);

    // 切到「仅名称」：值命中一律不算，集合必须能解释（不是「值优先」那种糊弄）
    await page.locator(".audit-search button", { hasText: "仅名称" }).click();
    await expect(page.locator(".audit-search-count")).toHaveText("无命中", { timeout: 15_000 });
    expect(await page.locator(".audit-matrix-body mark.search-hit").count()).toBe(0);
    expect(await page.locator(".audit-env-hit-badge").count(), "仅名称档下不得出现列头徽标").toBe(0);
    await page.locator(".audit-search button", { hasText: "全部" }).click();
    await expect(page.locator(".audit-search-count")).toHaveText(`1/${ALPHA_TARGETS}`, { timeout: 15_000 });
    await page.screenshot({ path: "results/r139-aes01-value-hits.png", fullPage: true });
  });

  test("AES-02 名称列逐处 + 只有一侧有值：徽标只落那一列，详情与跳转 Diff 跟着命中行", async ({ page, retest }) => {
    await bootstrap(page, retest);
    await runAudit(page);

    // ① 名称列：43 行 ×（dataId + key），值列一处都没有
    await submitSearch(page, "r139");
    const badges = await envBadges(page);
    const countText = await searchCountText(page);
    const summary = await summaryMainText(page);
    const rows = (await matrixGeometry(page)).rows;
    const currentInsideKey = await page.evaluate(() => {
      const mark = document.querySelector("mark.search-hit-current");
      return mark?.closest(".audit-cell.key") !== null;
    });
    console.log(`[AES-02] r139 档：1/N=${countText} 折叠后行=${rows} 徽标=${JSON.stringify(badges)} 当前处在名称列=${currentInsideKey} 摘要=${summary}`);
    expect(countText).toBe(`1/${NAME_TARGETS}`);
    expect(rows, "命中行 = 夹具的 43 个 key 行").toBe(FIXTURE_ROWS);
    expect(badges.reduce((sum, item) => sum + item.count, 0), "r139 不出现在任何值里，列头徽标必须全是 0").toBe(0);
    expect(currentInsideKey, "第一处停在名称列（dataId 在前）").toBe(true);

    // ② 只有 A 侧有的词：徽标只落 A 列，B 那一格是「—」
    await submitSearch(page, "dev-only-7f3a");
    const sideBadges = await envBadges(page);
    const dev = sideBadges.find((item) => item.label.includes(NS_A));
    const qa = sideBadges.find((item) => item.label.includes(NS_B));
    console.log(`[AES-02] 单侧档：徽标=${JSON.stringify(sideBadges)} 1/N=${await searchCountText(page)}`);
    expect(dev?.count, "A 列该有 1 处").toBe(1);
    expect(qa?.count ?? 0, "B 列缺失，不该有徽标").toBe(0);
    expect(await page.locator(".audit-matrix-body .audit-cell.missing").count(), "B 侧那一格渲染成缺失占位").toBe(1);

    // ③ 详情面板吃同一份命中区间：格子里有红底，点开就不许一片白
    await page.locator(".audit-matrix-body .audit-matrix-row.has-hit").first().click();
    await expect(page.locator(".audit-detail").first()).toBeVisible({ timeout: 10_000 });
    expect(await page.locator(".audit-detail mark.search-hit").count(), "详情面板两处各标一次，不二次匹配").toBe(1);
    await page.screenshot({ path: "results/r139-aes02-detail.png", fullPage: true });

    // ④ 跳转 Diff：落到正确 dataId（B 侧那份虽然没这个 key，仍按命中行的 dataId 去比）
    await page.locator(".audit-detail button", { hasText: "跳转 Diff 对比" }).click();
    await expect(page.locator(".source-picker").first()).toBeVisible({ timeout: 20_000 });
    const ids = await page.locator(".source-picker").evaluateAll((panels) =>
      panels.map((panel) => {
        const fields = Array.from(panel.querySelectorAll<HTMLElement>("label.field"));
        const target = fields.find((f) => (f.querySelector(":scope > span")?.textContent ?? "").trim().toLowerCase().startsWith("dataid"));
        return (target?.querySelector("input") as HTMLInputElement | null)?.value ?? "";
      })
    );
    console.log(`[AES-02] 跳转后两侧 dataId=${JSON.stringify(ids)}`);
    expect(ids[0]).toBe(DATA_ID);
    expect(ids[1] ?? "").toBe(DATA_ID);
  });

  test("AES-03 跨屏命中导航：Enter 连走只往下，不许把用户已读的那屏弹回开头", async ({ page, retest }) => {
    await bootstrap(page, retest);
    await runAudit(page);
    await submitSearch(page, "scan-shared");

    const countText = await searchCountText(page);
    const badges = await envBadges(page);
    const geometry = await matrixGeometry(page);
    console.log(`[AES-03] 1/N=${countText} 徽标=${JSON.stringify(badges)} 命中行=${geometry.rows} 视口可放=${Math.floor(geometry.viewportH / geometry.rowHeight)} 行`);
    expect(countText.split("/")[1]).toBe(String(SCAN_TARGETS));
    expect(
      badges.reduce((sum, item) => sum + item.count, 0),
      "80 处 = 两列徽标之和（徽标与导航同源）"
    ).toBe(SCAN_TARGETS);

    const perScreen = Math.max(1, Math.floor(geometry.viewportH / geometry.rowHeight));
    const steps = Math.max(20, perScreen * 2 + 2);
    let previousTop = (await hitSnapshot(page)).scrollTop;
    const readings: string[] = [];
    for (let step = 1; step <= steps; step += 1) {
      await page.locator(SEARCH_INPUT).press("Enter");
      await page.waitForTimeout(120);
      const snap = await hitSnapshot(page);
      readings.push(`${step}:${snap.scrollTop}`);
      expect(snap.currentCount, `第 ${step} 步必须有且只有一处实心高亮（读数 ${readings.join(" ")}）`).toBe(1);
      expect(snap.insideBody, `第 ${step} 步当前处必须在列表视口内（读数 ${readings.join(" ")}）`).toBe(true);
      expect(snap.scrollTop, `第 ${step} 步滚动位置不得倒退或归零（读数 ${readings.join(" ")}）`).toBeGreaterThanOrEqual(previousTop);
      previousTop = snap.scrollTop;
      expect(await searchCountText(page), `第 ${step} 步序号要跟着走`).toBe(`${step + 1}/${SCAN_TARGETS}`);
    }
    console.log(`[AES-03] 连走 ${steps} 步的 scrollTop：${readings.join(" ")}`);
    expect(previousTop, "走完至少一屏后滚动条必须还在下面（回到 0 = 又被弹回开头）").toBeGreaterThan(0);

    // 反向走一格：序号回退，位置不倒退成 0
    await page.locator(SEARCH_INPUT).press("Shift+F3");
    await expect(async () => {
      expect(await searchCountText(page)).toBe(`${steps}/${SCAN_TARGETS}`);
    }).toPass({ timeout: 10_000 });
    await page.screenshot({ path: "results/r139-aes03-navigation.png", fullPage: true });
  });

  test("AES-04 Ctrl+F 的焦点归属：空白处抢给矩阵搜索框，别的输入框不被抢，框内再按不死键", async ({ page, retest }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    await bootstrap(page, retest);
    await runAudit(page);

    const activeInfo = () =>
      page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return { tag: el?.tagName ?? "", cls: el?.className ?? "" };
      });
    // 句柄比对而不是把选择器塞进 document.querySelector：环境卡那只是 Playwright 的 :has-text
    // 语法，浏览器原生 querySelector 不认，混用会当场 SyntaxError（轮140 实测红过一次）。
    async function isActiveAs(handle: import("@playwright/test").ElementHandle | null): Promise<boolean> {
      if (!handle) throw new Error("isActiveAs: 拿不到元素句柄");
      return page.evaluate((el) => document.activeElement === el, handle);
    }

    // ① 焦点不在任何文本框里：Ctrl+F 把光标送进矩阵搜索框（用户要的「在 code 里 Ctrl+F 直接搜这个文件」同一条路）
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
    await page.keyboard.press("ControlOrMeta+f");
    const afterFirst = await activeInfo();
    console.log(`[AES-04] 空白处 Ctrl+F → activeElement=${JSON.stringify(afterFirst)}`);
    expect(afterFirst.cls).toContain("audit-search-input");

    // ② 焦点在环境卡的 dataId 筛选框：那儿的 Ctrl+F 归浏览器原生查找，页面抢了就成了死键（轮39 取证 #7/#8）
    const envFilter = page.locator(".audit-env-card label.field:has(> span:has-text('dataId')) input").first();
    const envFilterHandle = await envFilter.elementHandle();
    await envFilter.click();
    await page.keyboard.press("ControlOrMeta+f");
    const stillOnEnvFilter = await isActiveAs(envFilterHandle);
    console.log(`[AES-04] 环境卡输入框 Ctrl+F 后焦点还在原处=${stillOnEnvFilter} active=${JSON.stringify(await activeInfo())}`);
    expect(stillOnEnvFilter, "环境卡里的输入框不该被矩阵搜索框抢走焦点").toBe(true);

    // ③ 焦点已经在搜索框里再按 Ctrl+F：不报错、焦点仍在（不能把自己关掉后变成死键）
    await page.locator(SEARCH_INPUT).focus();
    await page.keyboard.press("ControlOrMeta+f");
    expect(await isActiveAs(await page.locator(SEARCH_INPUT).elementHandle())).toBe(true);
    expect(pageErrors, `页面异常：${pageErrors.join(" | ")}`).toEqual([]);
  });

  test("AES-05 输入法组合态：半截拼音不上屏就不扫描，compositionend 后才出结果", async ({ page, retest }) => {
    await bootstrap(page, retest);
    await runAudit(page);

    // 组合期间 Chromium 每敲一个字母都派发 input：这里直接塞值，看它扫不扫描
    await page.locator(SEARCH_INPUT).evaluate((el) => {
      const input = el as HTMLInputElement;
      input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "alpha");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForTimeout(700); // 防抖 400ms：真扫描了就一定看得见痕迹
    expect(await page.locator(SEARCH_INPUT).inputValue(), "回显永远即时").toBe("alpha");
    expect(await page.locator(".audit-search-summary").count(), "组合期间不得出摘要").toBe(0);
    expect(await page.locator(".audit-search-count").count(), "组合期间不得出 1/N").toBe(0);
    expect(await page.locator("mark.search-hit").count(), "组合期间不得画红底").toBe(0);

    await page.locator(SEARCH_INPUT).evaluate((el) => {
      const input = el as HTMLInputElement;
      input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: input.value }));
    });
    await expect(page.locator(".audit-search-summary")).toBeVisible({ timeout: 5_000 });
    expect(await searchCountText(page), "上屏后补排的那次扫描必须真的出结果").toBe(`1/${ALPHA_TARGETS}`);
    console.log(`[AES-05] 上屏后：1/N=${await searchCountText(page)} 摘要=${await summaryMainText(page)}`);
  });

  test("AES-06 还没执行审计：回车与「执行并搜索」都先跑这轮审计，再带着原词命中", async ({ page, retest }) => {
    await bootstrap(page, retest);
    expect(await page.locator(".audit-matrix-body").count(), "未执行审计时列表不该存在").toBe(0);

    const input = page.locator(SEARCH_INPUT);
    await input.fill("alpha");
    await expect(input).toHaveAttribute("title", /尚未执行审计/);
    const goButton = page.locator(".audit-search button", { hasText: "执行并搜索" });
    await expect(goButton).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".audit-search-summary-main")).toHaveText(/先执行本轮审计/, { timeout: 10_000 });
    console.log(`[AES-06] 空态：按钮=执行并搜索 title=${await input.getAttribute("title")}`);

    await goButton.click();
    await expect(page.locator(".audit-matrix-header .audit-cell.env").first()).toBeVisible({ timeout: 90_000 });
    await expect(page.locator(".audit-search-count")).toHaveText(`1/${ALPHA_TARGETS}`, { timeout: 20_000 });
    const badges = await envBadges(page);
    console.log(`[AES-06] 审计跑完自动带原词命中：徽标=${JSON.stringify(badges)} 摘要=${await summaryMainText(page)}`);
    expect(badges.reduce((sum, item) => sum + item.count, 0)).toBe(ALPHA_TARGETS);
    await page.screenshot({ path: "results/r139-aes06-run-and-search.png", fullPage: true });
  });

  test("AES-07 零命中把作用域念出来：行数、环境数、搜索词都在文案里，导航键禁用", async ({ page, retest }) => {
    await bootstrap(page, retest);
    await runAudit(page);
    const before = await matrixGeometry(page);

    await submitSearch(page, NO_TERM);
    const nohit = page.locator(".audit-search-nohit");
    await expect(nohit).toBeVisible({ timeout: 15_000 });
    const text = (await nohit.innerText()).trim();
    const summary = await summaryMainText(page);
    console.log(`[AES-07] 零命中=${text} 摘要=${summary} 1/N=${await searchCountText(page)}`);
    expect(text).toContain(`「${NO_TERM}」`);
    const parsed = /在 (\d+) 行 · (\d+) 个环境中没有找到/.exec(text);
    expect(parsed, `零命中文案没把作用域念全：${text}`).not.toBeNull();
    expect(Number(parsed?.[1]), "说的行数必须就是刚才那一份数据的行数").toBe(before.rows);
    expect(Number(parsed?.[2])).toBe(2);
    expect(await searchCountText(page)).toBe("无命中");
    await expect(page.locator(".audit-search button[aria-label='上一处命中']")).toBeDisabled();
    await expect(page.locator(".audit-search button[aria-label='下一处命中']")).toBeDisabled();
    await page.screenshot({ path: "results/r139-aes07-nohit.png", fullPage: true });
  });
});
