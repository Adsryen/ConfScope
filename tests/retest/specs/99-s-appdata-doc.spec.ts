// 轮50 真机永久回归：主数据文档（[数据根]/app-data/confscope-data.json）的绑定链路真的活着。
//
// 为什么必须钉成真机（jsdom 写不出这几条）：
// 1. 这条链路是靠 window.go.app.App 的原生绑定接地的，而绑定命名空间由 Go 包名决定；
//    77fa451 把 App 迁到 internal/app 后运行时命名空间变成 go.app.App，
//    src/lib/appDataDoc.ts 里手写的 g.go?.main?.App 取不到绑定，
//    于是「水合 / debounce 落盘 / 重启从文件恢复」在桌面端整体静默失效 45 天，
//    前端一路跑在 localStorage 热缓存上，用户与规约（第 6 条：文件是唯一事实源）看到的都不是一回事。
// 2. 「重启后文件赢过重新播种的热缓存」只有在真实导航 + init script 时序下才成得出。
//
// 桥侧替身见 tests/retest/bridge/retestBinding.ts：文档只放内存，
// 绝不写 portable/ConfScopeData（数据纪律第 3 条：retest 禁碰桌面应用正式数据目录）。
//
// 用例：
//   DD-01 首启即向绑定读文档，并把热缓存导入主文件（imported-from-storage 的合同）
//   DD-02 改界面语言后 debounce 把文档推给绑定，文档里就是改后的值（schemaVersion 2）
//   DD-03 刷新后从绑定水合：init script 把 locale 重新播种成 zh-CN，界面仍是文件里的 en-US
import { expect, type Page } from "@playwright/test";
import { test } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { retestAppDataDocSnapshot } from "../bridge/retestBinding";
import { navigate, dismissStartupDialog } from "./ui";

/** 与 src/lib/appDataDoc.ts 的 APP_DATA_DOC_SCHEMA_VERSION 一致。 */
const SCHEMA_VERSION = 2;

interface DocSnapshot {
  document: { schemaVersion: number; savedAt: string; data: Record<string, unknown> } | null;
  saves: number;
  gets: number;
}

async function bootstrap(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await page.setViewportSize({ width: 1280, height: 820 });
}

/** 等桥内替身满足条件（debounce 2s + 重试，所以不能靠固定 sleep 一次判定）。 */
async function waitDoc(
  predicate: (snap: DocSnapshot) => boolean,
  describeWant: string,
  timeoutMs = 20_000
): Promise<DocSnapshot> {
  const start = Date.now();
  for (;;) {
    const snap = retestAppDataDocSnapshot() as DocSnapshot;
    if (predicate(snap)) return snap;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`等不到${describeWant}；当前 ${JSON.stringify({ saves: snap.saves, gets: snap.gets, locale: snap.document?.data?.locale })}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

test.beforeEach(async ({ page, retest }) => {
  await installRetestBridge(page, retest);
  await republishRetestData();
  await bootstrap(page);
});

test("DD-01 首启向绑定读主数据文档，并把热缓存导入文件", async ({ page }) => {
  test.setTimeout(180_000);
  // bootstrap 一定会去读文件（读不到才谈得上「从热缓存导入一次」）
  const imported = await waitDoc(
    (snap) => snap.gets >= 1 && snap.saves >= 1 && snap.document !== null,
    "首启的绑定读取与导入落盘"
  );
  expect(imported.document?.schemaVersion, "导入的文档没带 schemaVersion").toBe(SCHEMA_VERSION);
  // 导进来的必须是桥播种的那份热缓存，而不是空文件
  expect(Array.isArray(imported.document?.data.connections), "文档里没有 connections 分区").toBe(true);
  expect((imported.document?.data.connections as unknown[]).length, "文档里的连接是空的，热缓存没被导入").toBeGreaterThan(0);
  expect(imported.document?.data.locale).toBe("zh-CN");
  console.log(`[DD-01] gets=${imported.gets} saves=${imported.saves} 连接=${(imported.document?.data.connections as unknown[]).length}`);
  await page.screenshot({ path: "results/r50_appdata_doc_import.png" });
});

test("DD-02 改界面语言后 debounce 把文档推给绑定，文档里是改后的值", async ({ page }) => {
  test.setTimeout(180_000);
  await waitDoc((snap) => snap.saves >= 1, "首启导入");
  const before = retestAppDataDocSnapshot() as DocSnapshot;

  await navigate(page, "设置");
  await expect(page.locator(".lang-switch")).toBeVisible({ timeout: 15_000 });
  await page.locator(".lang-switch").selectOption("en-US");
  await expect(page.locator(".side-nav-item", { hasText: "Settings" }).first(), "切了语言但侧边导航没跟着变英文").toBeVisible({ timeout: 15_000 });

  const saved = await waitDoc(
    (snap) => snap.document?.data.locale === "en-US",
    "语言变更被推给绑定"
  );
  expect(saved.saves, "改动没有产生新的落盘调用").toBeGreaterThan(before.saves);
  expect(saved.document?.schemaVersion).toBe(SCHEMA_VERSION);
  // 时间戳与构建版本的分工：前端交空串，由 Go 侧盖章
  //（internal/app/app_data_doc.go:146-149 —— AppVersion 空则填构建版本，SavedAt 一律取 now）。
  // 前端自己盖章就是把「本机时钟」当成第二份事实源，规约里文件时间只能由写文件的那一侧决定。
  expect(saved.document?.savedAt, "前端不许自己盖 savedAt（Go 侧负责）").toBe("");
  expect(saved.document?.appVersion, "前端不许自己填 appVersion（Go 侧负责）").toBe("");
  // 其余分区不能被这次改动抹掉
  expect((saved.document?.data.connections as unknown[])?.length).toBeGreaterThan(0);
  console.log(`[DD-02] saves ${before.saves}→${saved.saves} locale=${saved.document?.data.locale}`);
  await page.screenshot({ path: "results/r50_appdata_doc_locale.png" });
});

test("DD-03 刷新后从绑定水合：文件赢过被重新播种的热缓存", async ({ page }) => {
  test.setTimeout(180_000);
  await waitDoc((snap) => snap.saves >= 1, "首启导入");
  await navigate(page, "设置");
  await page.locator(".lang-switch").selectOption("en-US");
  await waitDoc((snap) => snap.document?.data.locale === "en-US", "语言变更落绑定");

  // 刷新：init script 会把 locale 无条件覆写回 zh-CN（模拟「热缓存被重新灌旧值」），
  // 只有 bootstrap 真的从绑定读到文档，界面才会停在 en-US。
  const getsBefore = (retestAppDataDocSnapshot() as DocSnapshot).gets;
  await page.reload();
  await dismissStartupDialog(page);
  const rehydrated = await waitDoc(
    (snap) => snap.gets >= getsBefore + 1 && snap.document?.data.locale === "en-US",
    "重启后从绑定读到那份 en-US 的文档"
  );
  await expect(page.locator(".lang-switch"), "界面语言回到了热缓存的中文：文件没赢").toHaveValue("en-US", { timeout: 20_000 });
  // 水合是「文件 → 缓存」的单向覆写：缓存此刻必须已被文件里的 en-US 盖掉
  //（播种写回的 zh-CN 只是启动瞬间的中间态，留住它就说明 hydrate 没跑）。
  const cacheLocale = await page.evaluate(() => window.localStorage.getItem("locale"));
  expect(cacheLocale, "水合后缓存应被文件值覆盖（说明 hydrate 真的写回缓存）").toBe("en-US");
  expect(rehydrated.document?.data.locale).toBe("en-US");
  console.log(`[DD-03] gets ${getsBefore}→${rehydrated.gets} 文件 locale=en-US 缓存 locale=${cacheLocale}`);
  await page.screenshot({ path: "results/r50_appdata_doc_rehydrate.png" });
});
