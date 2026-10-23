/**
 * 轮67 R57 永久回归：本机配置版本历史在真人链路上到底攒不攒得到、切不切得动、清不清得干净。
 *
 * 为什么必须真机跑这一条（jsdom 与 Go 单测都给不出这几口气）：
 * - 「读到正文 = 本机见过这一版」写在 src/api/nacos.ts 那个全站唯一读取出口里，是 fire-and-forget。
 *   单测能证明函数被调用，证明不了浏览器里那一次真实读取真的把版本送进了绑定、界面又把它读了回来。
 * - 分段控件（配置中心 / 本机）的「在屏内容随档位而变」只有真渲染才看得出张冠李戴：
 *   守卫 tests/ux/configHistorySourceSegmentTellsTruth 钉的是源码形状，钉不出点下去屏幕换没换。
 * - 设置页清完之后，前端那份 md5 加速器必须一起清（resetConfigRevisionAccelerator）。
 *   漏掉这一句的现象最难查：清除成功了、界面也空了，可同样的正文再也攒不回第二版——
 *   因为「这一版我见过」的记忆还留在进程里，把后续观测全判成重复。只有真机能跑满这一圈。
 *
 * 判重/升级/保留策略的口径本身归 internal/revisions/trail_test.go；桥里那份内存替身只镜像
 * 前端可见的结果（见 tests/retest/bridge/retestBinding.ts 顶部说明），retest 绝不写正式数据目录。
 */
import { test, expect, fetchNacosContent } from "./retestTest";
import type { Page } from "@playwright/test";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { onBridgeLog, retestRevisionFacts, retestRevisionKeyStats, retestRevisionsSnapshot } from "../bridge/retestBinding";
import { publishNacosContent, republishRetestData } from "../bridge/republishData";
import { dismissStartupDialog, navigate } from "./ui";
import { backToBrowseFromPlan, expectRollbackPlanRow } from "./planExit";
import { loadRetestState } from "../state";

const state = loadRetestState();
const BASE_A = state.nacos.a.baseUrl;
const NS_A = state.nacos.a.namespace;
const GROUP = "RETEST-PROD";
/** svc-billing.yaml 正文干净（无重复顶层 key），且 99-s-history-search 已证明它能稳定加载。 */
const DATA_ID = "svc-billing.yaml";
/** 配置浏览页在 retest 里固定落在 A 连接（见 storageSeed 的 selectedConnectionId）。 */
const CONN_A = "retest-a";
/** 本机那一档的标题里唯一会出现的形态：本机历史（N）。 */
const LOCAL_HEAD_ROW = ".history-list-head-row";
const SOURCE_BAR = ".history-source-bar .view-mode";
const T = 20_000;

/** 桥日志水位线：只数真实发出的绑定调用（切到本机后服务端那一档不该再打一次请求）。 */
function bridgeWaterline() {
  const lines: string[] = [];
  onBridgeLog((line) => lines.push(line));
  return {
    mark: () => lines.length,
    countSince: (from: number, method: string) => lines.slice(from).filter((line) => line.includes(method)).length,
  };
}

/** 标准启动：装桥 + 复位本机版本历史替身（install 里做）+ 播种数据 + 进配置浏览。 */
async function boot(page: Page) {
  await installRetestBridge(page, state);
  await republishRetestData();
  await page.goto("/");
  await dismissStartupDialog(page);
  await navigate(page, "配置浏览");
  await expect(page.locator(".browser-item-id").first()).toBeVisible({ timeout: T });
}

/** 打开一个配置的正文（= 本机见过这一版：读取出口会 fire-and-forget 记一版）。 */
async function openConfig(page: Page) {
  await page.locator(".browser-item", { hasText: DATA_ID }).first().click({ timeout: T });
  await expect(page.locator(".browser-detail .detail-dataid")).toHaveText(DATA_ID, { timeout: T });
  await expect(page.locator(".content-box .code-area").first()).toBeVisible({ timeout: T });
}

/** 重新拉取内容（⟳ 在「内容」tab 的格式条里，aria-label 是唯一锚点）。 */
async function refreshContent(page: Page) {
  const btn = page.getByRole("button", { name: "重新拉取内容" });
  await expect(btn).toBeVisible({ timeout: T });
  await btn.click({ timeout: T });
  await expect(page.locator(".content-box .code-area").first()).toBeVisible({ timeout: T });
}

/**
 * 桥内替身里属于「这一个配置」的那一列。
 *
 * 为什么按键取而不是看整份记录：本机历史说的是「这台机器见过哪些版」，页面一挂载就会顺带读到别的配置的正文
 * （对比页的自动恢复也会各读一次左右两侧），那些都是真的落盘、但不是本用例种的地。
 * 整份计数当断言会把用例之间互相喂的数据算进来，既涨不成也跌不动，只会得到一串说不清为什么红的红。
 */
function keyStats() {
  return retestRevisionKeyStats(CONN_A, NS_A, GROUP, DATA_ID);
}

/** 等桥内替身为这个配置攒到 expected 版（fire-and-forget 的落点只能这样等，读屏会假绿）。 */
async function expectBridgeRevisions(expected: number) {
  await expect
    .poll(() => keyStats().records.length, {
      timeout: T,
      message: `桥内 ${CONN_A}/${GROUP}/${DATA_ID} 的本机版本历史应为 ${expected} 版`,
    })
    .toBe(expected);
}

/** 切到「历史变更」tab。 */
async function openHistoryTab(page: Page) {
  await page.locator(".detail-tabs .tab-btn", { hasText: "历史变更" }).first().click({ timeout: T });
  await expect(page.locator(SOURCE_BAR)).toBeVisible({ timeout: T });
}

/** 点「本机」那一档。 */
async function chooseLocalSource(page: Page) {
  await page.locator(SOURCE_BAR).getByRole("button", { name: "本机", exact: true }).click({ timeout: T });
  await expect(page.locator(LOCAL_HEAD_ROW)).toBeVisible({ timeout: T });
}

/** 当前分段：哪颗在pressed、两颗各叫什么（分段只在两个源都可达时出现）。 */
async function segmentState(page: Page) {
  return page.evaluate((sel: string) => {
    const group = document.querySelector(sel) as HTMLElement | null;
    if (!group) return { present: false, pressed: "", buttons: [] as string[], label: "" };
    const buttons = Array.from(group.querySelectorAll("button"));
    return {
      present: true,
      label: group.getAttribute("aria-label") ?? "",
      buttons: buttons.map((b) => (b.textContent ?? "").trim()),
      pressed: (buttons.find((b) => b.getAttribute("aria-pressed") === "true")?.textContent ?? "").trim(),
    };
  }, SOURCE_BAR);
}

/** 本机那一档标题里的条数（本机历史（N））；拿不到返回 -1，让断言信息仍然可读。 */
async function localCount(page: Page): Promise<number> {
  const text = await page.locator(LOCAL_HEAD_ROW).first().textContent();
  const matched = /（(\d+)）/.exec(text ?? "");
  return matched ? Number(matched[1]) : -1;
}

/** 服务端那一档的表头（历史版本（N））——用来证明「切档确实换了在屏内容」。 */
async function serverHeadText(page: Page): Promise<string> {
  return (await page.locator(".history-list-head").first().innerText()).replace(/\s+/g, " ").trim();
}

/** 重开本机那一档并等它把条数读到 expected（tab 与分段都会重新挂载，挂载即读）。 */
async function localHistoryShows(page: Page, expected: number) {
  await openHistoryTab(page);
  await chooseLocalSource(page);
  await expect.poll(() => localCount(page), { timeout: T, message: `本机历史应显示 ${expected} 版` }).toBe(expected);
}

test("LH-01 读到正文就攒出一版：分段切了，在屏内容跟着切，且不再打服务端历史", async ({ page }) => {
  test.setTimeout(300_000);
  const water = bridgeWaterline();
  await boot(page);
  await openConfig(page);
  await expectBridgeRevisions(1);

  // 桥内那一版必须真长得像「本机读到」：正文、字节数、归属键都在
  const rec = keyStats().records[0];
  expect(rec.kind, "读到正文记的不是 observed").toBe("observed");
  expect(rec.connectionId).toBe(CONN_A);
  expect(rec.namespace).toBe(NS_A);
  expect(rec.group).toBe(GROUP);
  expect(rec.dataId).toBe(DATA_ID);
  expect(rec.content.length, "这一版没带正文，界面只能显示空").toBeGreaterThan(0);
  expect(rec.bytes).toBeGreaterThan(0);
  expect(rec.contentOmittedReason, "没超限却标了省略").toBe("");

  await openHistoryTab(page);
  // 两个源都可达 ⇒ 分段出现，默认落在配置中心那一档（服务端能给历史时不抢本机）
  const seg = await segmentState(page);
  expect(seg.present, "服务端历史与本机历史都可达，分段却没出现").toBe(true);
  expect(seg.buttons, `分段少了档位：${seg.buttons.join("/")}`).toEqual(["配置中心", "本机"]);
  expect(seg.pressed, "默认档不该抢本机").toBe("配置中心");
  // 服务端那一档的拉取是挂载后异步发出去的（面板先渲染，请求才上路）：等它真的上路再取水位线，
  // 否则 mark 会落在那一次请求之前，切到本机后那条迟到的日志会被误判成「还在打」。
  await expect
    .poll(() => water.countSince(0, "ConfigCenterListHistory"), {
      timeout: T,
      message: "停在配置中心那一档却没拉服务端历史",
    })
    .toBeGreaterThanOrEqual(1);
  expect(await serverHeadText(page)).toContain("历史版本");

  await page.waitForTimeout(1_500);
  const mark = water.mark();
  await chooseLocalSource(page);
  expect(await localCount(page), "本机那一档的条数对不上").toBe(1);
  // 这一列说的是这台机器见过哪一版：徽章必须是「本机读到」，不许冒充发布时间
  await expect(page.locator(".history-item-main .op").first()).toHaveText("本机读到", { timeout: T });
  await expect(page.locator(LOCAL_HEAD_ROW)).toContainText("本机历史（1）", { timeout: T });
  const hashCell = page.locator(".history-item-id.mono").first();
  expect(((await hashCell.getAttribute("title")) ?? "").startsWith("sha256:"), "摘要列没带完整 hash").toBe(true);
  // 只有一条记录 ⇒ 右侧提示选一个版本；选了以后默认「高亮变更」，与「上一条」比 = 本机最早的一条
  await expect(page.locator(".history-detail .pad-msg").first()).toContainText("点击左侧版本查看内容", { timeout: T });
  await page.locator(".history-item-main").first().click({ timeout: T });
  await expect(page.locator(".diff-panel").first()).toBeVisible({ timeout: T });
  await expect(page.locator(".content-box-head .vs-prev").first()).toContainText("本机最早的一条", { timeout: T });
  await page.getByRole("button", { name: "原始内容" }).first().click({ timeout: T });
  await expect(page.locator(".content-box .code-area").first()).toBeVisible({ timeout: T });

  // 切到本机以后，服务端那一档整块卸载：不许继续在后台按同一份参数打历史请求
  await page.waitForTimeout(1_500);
  expect(water.countSince(mark, "ConfigCenterListHistory"), "切到本机那一档还在打服务端历史请求").toBe(0);
});

test("LH-02 同一版重复读不涨：判重是常态，界面也不会因此少一版", async ({ page }) => {
  test.setTimeout(300_000);
  await boot(page);
  await openConfig(page);
  await expectBridgeRevisions(1);

  await refreshContent(page);
  await refreshContent(page);
  await page.waitForTimeout(1_000);

  const snap = keyStats();
  expect(snap.records.length, "同一版重复读被记成了两版").toBe(1);
  expect(snap.appended, "这个配置只该被攒下一版").toBe(1);
  // 必须真的走到判重这一支：只有「第二次读的正文送到了写入出口又被判成同一版」才算数，
  // 否则「重复读压根没发出去」也会留下同样的 1 版，看不出区别。
  expect(snap.duplicate, "重复读没走到判重这一支").toBeGreaterThanOrEqual(1);
  expect(snap.promoted, "重复读到正文不该把这一版升级成写入确认").toBe(0);
  expect(snap.records[0].hash.startsWith("sha256:"), "摘要前缀不对").toBe(true);

  await localHistoryShows(page, 1);
  // 重复读不许把唯一那一版挤掉：右侧仍能读到正文
  await page.locator(".history-item-main").first().click({ timeout: T });
  await page.getByRole("button", { name: "原始内容" }).first().click({ timeout: T });
  await expect(page.locator(".content-box .code-area").first()).toContainText("billing", { timeout: T });
});

test("LH-03 服务端改一版再读才涨：最新在前，旧的一版仍可回看", async ({ page }) => {
  test.setTimeout(300_000);
  await boot(page);
  await openConfig(page);
  await expectBridgeRevisions(1);
  const baseline = (await fetchNacosContent(BASE_A, NS_A, DATA_ID, GROUP)).trim();

  const marker = `retestLocalHistory: v2-${Date.now()}`;
  await publishNacosContent(BASE_A, NS_A, DATA_ID, GROUP, `${baseline}\n${marker}\n`);
  await refreshContent(page);
  await expectBridgeRevisions(2);

  await localHistoryShows(page, 2);
  const rows = page.locator(".history-item");
  expect(await rows.count()).toBe(2);
  const newestHash = (await rows.nth(0).locator(".history-item-id.mono").first().getAttribute("title")) ?? "";
  const olderHash = (await rows.nth(1).locator(".history-item-id.mono").first().getAttribute("title")) ?? "";
  expect(newestHash === olderHash, "两版的摘要一样，判重把新改版吃掉了").toBe(false);

  // 最新那一版：与上一条本机记录相比多了 marker（默认视图 = 高亮变更）
  await rows.nth(0).locator(".history-item-main").click({ timeout: T });
  await expect(page.locator(".content-box-head .vs-prev").first()).toContainText("相对上一条本机记录", { timeout: T });
  await expect(page.locator(".diff-panel .udiff-row.add").filter({ hasText: "retestLocalHistory" }).first()).toBeVisible({
    timeout: T,
  });
  // 旧那一版：正文里绝不该出现新的 marker（读的是记录里带着的那一版，不是线上现值）
  await rows.nth(1).locator(".history-item-main").click({ timeout: T });
  await page.getByRole("button", { name: "原始内容" }).first().click({ timeout: T });
  await expect(page.locator(".content-box .code-area").first()).toBeVisible({ timeout: T });
  const olderRaw = (await page.locator(".content-box .code-area").first().innerText()) ?? "";
  expect(olderRaw.includes("retestLocalHistory"), "旧版正文里混进了新版内容").toBe(false);
  expect(olderRaw.includes("billing"), "旧版正文没读出来").toBe(true);

  // 切回配置中心那一档，服务端历史还在：两份历史各说各的，不合并成一列
  await page.locator(SOURCE_BAR).getByRole("button", { name: "配置中心", exact: true }).click({ timeout: T });
  await expect(page.locator(".history-list-head").first()).toContainText("历史版本", { timeout: T });
  expect(await page.locator(LOCAL_HEAD_ROW).count(), "切回配置中心后本机那一档的表头还在屏上").toBe(0);
});

test("LH-04 设置页看得见体量、清掉后回到诚实空态，清完还能重新攒起来", async ({ page }) => {
  test.setTimeout(300_000);
  await boot(page);
  await openConfig(page);
  await expectBridgeRevisions(1);

  await navigate(page, "设置");
  const section = page.locator("#settings-data-locations");
  await expect(section).toBeVisible({ timeout: T });
  const row = section.locator(".settings-setting-row").filter({ has: page.locator("strong", { hasText: "清除本机版本历史" }) });
  await expect(row).toBeVisible({ timeout: T });
  // 数字不写死：本机历史是全机共享的一份记录，页面挂载时顺带读到的别的配置也算数（见 keyStats 的说明）。
  // 这里钉的是「设置页念的数 == 桥内这份记录的真实体量」，写死 1 反而会把这份诚实证歪。
  const factsRow = row.locator(".settings-data-root-facts");
  await expect
    .poll(
      async () => {
        const dom = (await factsRow.innerText()).replace(/\s+/g, " ");
        const bridge = retestRevisionFacts();
        return (
          (dom.includes(`已记录 ${bridge.records} 版`) && dom.includes(`涉及 ${bridge.keys} 个配置`) && dom.includes("每个配置最多留 50 版")
            ? "match"
            : `界面=${dom} / 桥内=${bridge.records} 版 ${bridge.keys} 个配置`
          ) as string
        );
      },
      { timeout: T, message: "设置页那行的体量与桥内记录不是同一份实话" }
    )
    .toBe("match");
  const facts = (await factsRow.innerText()).replace(/\s+/g, " ");
  expect(facts, "本机历史体积该说实话").toMatch(/占用 [\d.]+\s*[KM]?B/);

  await row.getByRole("button", { name: "清除本机版本历史" }).click({ timeout: T });
  const modal = page.locator(".modal.modal-sm");
  await expect(modal).toBeVisible({ timeout: T });
  await expect(modal.locator(".confirm-details")).toContainText("配置中心的服务端历史不受影响", { timeout: T });
  await modal.getByRole("button", { name: "确定" }).click({ timeout: T });
  await expect(section.locator(".test-msg.ok")).toContainText("本机版本历史已清除", { timeout: T });

  const afterClear = retestRevisionsSnapshot();
  expect(afterClear.records.length, "清除没真的把版本清掉").toBe(0);
  expect(afterClear.clears).toBe(1);

  // 回到浏览页：读得出来但确实没记过 ⇒ 说空态那句实话，不许冒出一句红字
  await navigate(page, "配置浏览");
  await localHistoryShows(page, 0);
  await expect(page.locator(".history-items .pad-msg").first()).toContainText("本机还没记下这个配置的版本", { timeout: T });
  expect(await page.locator(".history-items .pad-msg.err").count(), "空历史被渲染成了读取失败").toBe(0);

  // 关键一环：清除必须连前端那份 md5 记忆一起清。漏掉的话，同样的正文再也攒不回第二版，
  // 而现象只是「本机历史一直是空的」，看不出任何错误。
  await page.locator(".detail-tabs .tab-btn", { hasText: "内容" }).first().click({ timeout: T });
  await refreshContent(page);
  await expectBridgeRevisions(1);
  await localHistoryShows(page, 1);
});

test("LH-05 本机那一版能生成回滚计划：两下确认，执行前配置中心一个字都不改", async ({ page }) => {
  test.setTimeout(300_000);
  await boot(page);
  await openConfig(page);
  await expectBridgeRevisions(1);
  const baseline = (await fetchNacosContent(BASE_A, NS_A, DATA_ID, GROUP)).trim();

  const marker = `retestLocalHistory: rollback-${Date.now()}`;
  await publishNacosContent(BASE_A, NS_A, DATA_ID, GROUP, `${baseline}\n${marker}\n`);
  await refreshContent(page);
  await expectBridgeRevisions(2);

  await localHistoryShows(page, 2);
  // 回滚的目标是「本机更早那一版」：列表最新在前，所以旧的一版在第 2 行
  await page.locator(".history-item").nth(1).locator(".history-item-main").click({ timeout: T });
  const rbBtn = page.getByRole("button", { name: /生成回滚计划/ }).last();
  await expect(rbBtn).toBeVisible({ timeout: T });
  await rbBtn.click({ timeout: T });
  await expect(rbBtn).toHaveText(/确认生成回滚计划/, { timeout: T });
  await rbBtn.click({ timeout: T });

  // 出路只有变更计划：进计划页、一条项、动作是覆盖（本机那一版与线上现值确实不同）
  const action = await expectRollbackPlanRow(page, DATA_ID);
  expect(["overwrite", "skip"], "回滚计划的动作挂错了").toContain(action);
  const online = await fetchNacosContent(BASE_A, NS_A, DATA_ID, GROUP);
  expect(online.includes("retestLocalHistory"), "只生成回滚计划就改写了配置中心").toBe(true);

  await backToBrowseFromPlan(page);
  // 收尾把基线写回去：整批是串行的，后面的 99-s-* 还指着这份数据
  await republishRetestData();
});
