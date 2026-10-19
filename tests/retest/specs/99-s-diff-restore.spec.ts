/**
 * 轮46：重启后「上一轮比的那一对」必须还是同一对（对比来源的单一事实源 = cs.diffViewPreferences）。
 *
 *  轮45 R03 修的是「绕一趟浏览页把那一对抹了」；轮46 R01 扫出来的是更狠的一条：
 *  同一件事有两个写侧（cs.ui 的 diff 一族键只由 App 跳转时写 / prefs 由 DiffView 每次改动都写），
 *  镜像常年是旧的 ⇒ 重启时旧的赢下界面，盖完又被保存 effect 抄回 prefs，
 *  用户真正比过的那一对一次重启就永久丢失。
 *
 *  DR-01 手工换成另一对并比完 ⇒ 重启后 DOM 仍是这一对、自动比的就是它，prefs 没被回写成种子对，
 *       且 cs.ui 里查不到任何 diff 键（第二个写侧已经不存在了）。
 *  DR-02 prefs 少一侧 dataId（不齐）⇒ 启动一次都不许自动比（宁可不比也不拿空 dataId 去跑智能匹配），
 *       但来源照旧预填，用户点一下就有。
 *
 * 与桥的关系（不写清楚这两条就会测到一个假现场）：
 *  installRetestBridge 的 init script 每次文档加载都无条件把种子覆写回 localStorage，
 *  所以「用户自己改过的那一对」在 page.reload() 后会被种子盖掉——探针期实测就被这条误导过
 *  （P46-A 看到的"回到种子对"里有一部分是桥干的，不全是产品行为）。
 *  做法：把 reload 前要留住的那份 prefs 用**另一条 init script** 注册在桥之后
 *  （init script 按注册顺序执行）：桥覆写种子 → 我们覆写回用户现场 → App 第一次读到的
 *  就是「上一轮退出时的那一对」，这才叫忠实的应用重启。
 *  另一条反向通道是主数据文件：bootstrap 时若文件比 localStorage 新会水合回 localStorage
 *  （src/lib/appDataDoc.ts 的 PUSH_DEBOUNCE_MS = 2000），所以 reload 前必须等 debounce 推送落地，
 *  两条路指向同一份现场，断言才站得住。
 */
import { expect, type Page } from "@playwright/test";
import { test } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { onBridgeLog } from "../bridge/retestBinding";
import { republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog, setDiffSource, selectSel, ensureSourcesPanelExpanded } from "./ui";
import { loadRetestState } from "../state";

const state = loadRetestState();
const NS_A = state.nacos.a.namespace;
const NS_B = state.nacos.b.namespace;
const GROUP = "RETEST-PROD";
/** 种子里那一对（bridge/storageSeed.ts 的 cs.diffViewPreferences）。 */
const SEED_ID = "svc-gateway.yaml";
/** 用户手工换上的另一对（A/retest-dev 与 B/retest-qa 都有这个 dataId）。 */
const PICK_ID = "svc-billing.yaml";
const T = 30_000;

type P = Page;

function panel(page: P, side: "left" | "right") {
  const title = side === "left" ? "来源（左）" : "目标（右）";
  return page.locator(".source-picker").filter({ has: page.locator(`.source-title:has-text("${title}")`) }).first();
}

function visibleRows(page: P) {
  return page.locator(".diff-panel .diff-row").filter({ visible: true });
}

async function readDom(page: P) {
  const out: Record<string, string> = {};
  for (const side of ["left", "right"] as const) {
    const p = panel(page, side);
    const dataId = p.locator(`label.field:has(> span:has-text("dataId"))`).first().locator("input").first();
    out[side] = await dataId.inputValue().catch(() => "?");
  }
  return out;
}

async function readUiState(page: P): Promise<Record<string, unknown>> {
  return page.evaluate(() => JSON.parse(window.localStorage.getItem("cs.ui") || "{}") as Record<string, unknown>);
}

async function readPrefs(page: P): Promise<Record<string, any>> {
  return page.evaluate(
    () => JSON.parse(window.localStorage.getItem("cs.diffViewPreferences") || "{}") as Record<string, any>
  );
}

/** cs.ui 里残留的 diff 一族键名（轮46 R01 之后必须恒为空数组）。 */
function diffKeysIn(ui: Record<string, unknown>): string[] {
  return Object.keys(ui).filter((key) => key.startsWith("diff"));
}

function auditWaterline() {
  const lines: string[] = [];
  onBridgeLog((line) => lines.push(line));
  let mark = 0;
  return {
    mark: () => {
      mark = lines.length;
    },
    compares: () =>
      lines
        .slice(mark)
        .filter((l) => l.includes('"kind":"compare_start"'))
        .map((l) => `${/"left":"([^"]*)"/.exec(l)?.[1] ?? "?"} vs ${/"right":"([^"]*)"/.exec(l)?.[1] ?? "?"}`),
  };
}

/** 换成 billing 这一对（右侧先切环境：来源候选按「该面板当前连接的环境」过滤）。 */
async function pickPair(page: P) {
  await navigate(page, "配置对比");
  await page.waitForTimeout(600);
  await ensureSourcesPanelExpanded(page);
  await selectSel(page, panel(page, "right"), "环境", "Sandbox");
  await page.waitForTimeout(400);
  await setDiffSource(page, "right", { connection: "Retest Nacos B", namespace: NS_B, group: GROUP, dataId: PICK_ID });
  await setDiffSource(page, "left", { connection: "Retest Nacos A", namespace: NS_A, group: GROUP, dataId: PICK_ID });
  await page.waitForTimeout(600);
}

async function runCompare(page: P) {
  await page.getByRole("button", { name: "加载并对比" }).last().click();
  await expect(page.locator(".diff-panel").filter({ visible: true }).first()).toBeVisible({ timeout: T });
  await expect(visibleRows(page).first()).toBeVisible({ timeout: T });
  await page.waitForTimeout(1_200);
  return visibleRows(page).count();
}

test.beforeEach(async ({ page, retest }) => {
  await installRetestBridge(page, retest);
});

test("DR-01 手工换成另一对比完之后，重启仍是这一对、自动比的就是它", async ({ page }) => {
  test.setTimeout(300_000);
  await republishRetestData();
  const water = auditWaterline();
  await page.goto("/");
  await dismissStartupDialog(page);

  // 首屏就该由 prefs 里那一对自动比出来（轮46 R02：意图 = 上一轮退出时停在对比页，来源齐 ⇒ 比）
  await expect(visibleRows(page).first()).toBeVisible({ timeout: T });
  const bootCompares = water.compares();
  expect(bootCompares, `首屏自动比应当恰好一轮，实测 ${JSON.stringify(bootCompares)}`).toHaveLength(1);
  expect(bootCompares[0], "首屏比的应当是种子里那一对").toContain(SEED_ID);
  expect(diffKeysIn(await readUiState(page)), "cs.ui 不许再留 diff 一族键").toEqual([]);

  await pickPair(page);
  const rows = await runCompare(page);
  expect(rows, "手工换的这一对比不出差异，后面的断言就是在测空现场").toBeGreaterThan(0);

  const prefsBefore = await readPrefs(page);
  expect(prefsBefore.left?.dataId, "比完之后 prefs 必须记下用户真正比的这一对").toBe(PICK_ID);
  expect(prefsBefore.right?.dataId).toBe(PICK_ID);
  expect(diffKeysIn(await readUiState(page))).toEqual([]);

  // 等 debounce 推送落地（2s），再让这条 init script 注册在桥之后覆写回用户现场
  await page.waitForTimeout(3_000);
  await page.addInitScript((value) => {
    window.localStorage.setItem("cs.diffViewPreferences", value);
  }, JSON.stringify(prefsBefore));
  water.mark();

  await page.reload({ waitUntil: "load" });
  await dismissStartupDialog(page);
  await expect(visibleRows(page).first()).toBeVisible({ timeout: T });
  await page.waitForTimeout(2_500);

  const compares = water.compares();
  expect(compares, `重启后的自动比必须恰好一轮，实测 ${JSON.stringify(compares)}`).toHaveLength(1);
  expect(compares[0], "重启后比的必须还是用户那一对，不是种子对").toContain(PICK_ID);

  const dom = await readDom(page);
  expect(dom.left, "左侧 DOM 回到了种子对 = 旧镜像赢下界面那条路又回来了").toBe(PICK_ID);
  expect(dom.right).toBe(PICK_ID);

  const prefsAfter = await readPrefs(page);
  expect(prefsAfter, "prefs 被回写成了别的对 = 真值又被污染一次").toEqual(prefsBefore);
  expect(diffKeysIn(await readUiState(page))).toEqual([]);
  console.log(`[DR-01] 重启后 DOM=${JSON.stringify(dom)} 自动比=${JSON.stringify(compares)}`);
  await page.screenshot({ path: "results/dr01-restore-pair.png", fullPage: true });
});

test("DR-02 prefs 少一侧 dataId：启动一次都不许自动比，但来源照旧预填", async ({ page }) => {
  test.setTimeout(240_000);
  await republishRetestData();
  const water = auditWaterline();
  // 注册在桥的种子之后：先按种子播种，再把右侧 dataId 抹空，造出「不齐的一对」
  await page.addInitScript(() => {
    try {
      const prefs = JSON.parse(window.localStorage.getItem("cs.diffViewPreferences") || "{}") as Record<string, any>;
      if (!prefs.right) return;
      prefs.right.dataId = "";
      window.localStorage.setItem("cs.diffViewPreferences", JSON.stringify(prefs));
    } catch {
      /* noop */
    }
  });
  await page.goto("/");
  await dismissStartupDialog(page);
  await page.waitForTimeout(6_000);

  // dataId 为空的 loadBoth 走的是整命名空间扫描的智能匹配：绝不该在启动时替用户按下
  const compares = water.compares();
  expect(compares, `不齐的一对却自动比了 ${JSON.stringify(compares)}`).toEqual([]);
  expect(await visibleRows(page).count(), "没比过就不该出现差异行").toBe(0);

  const dom = await readDom(page);
  expect(dom.left, "不自动比不等于不恢复来源：左半仍然在").toBe(SEED_ID);
  expect(dom.right).toBe("");
  expect(diffKeysIn(await readUiState(page))).toEqual([]);
  console.log(`[DR-02] 启动 6s 后 DOM=${JSON.stringify(dom)} 自动比=0 轮`);
  await page.screenshot({ path: "results/dr02-incomplete-pair.png", fullPage: true });
});
