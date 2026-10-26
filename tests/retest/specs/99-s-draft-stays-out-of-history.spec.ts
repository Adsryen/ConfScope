/**
 * 轮90 R90：配置浏览的编辑态草稿绝不能落进任何历史（活体）。
 *
 * 论题只有一句话：改了正文但不保存 ⇒ 本机版本历史和操作历史一条都不许多。
 * 这条论题只有真机能证，jsdom / Go 单测给不出这口气：
 * - 「读到正文 = 本机见过这一版」写在 src/api/nacos.ts 那个全站唯一读取出口里，是 fire-and-forget。
 *   jsdom 能证明 discardDraft 之后 state 干净，证明不了浏览器里除了那一次真实读取之外，
 *   没有别的调用（切 tab、开查找栏、切走再回来、生成计划）把草稿正文喂进版本历史。
 * - 操作历史落在 localStorage 的真实键上。草稿不保存不该写它，这个「不写」只有真跑一遍才看得见。
 * - 零增量断言最大的风险是**假绿**：计数器压根没接上时永远是 0。所以两条用例各自带正控
 *   （DF-01：正文真换一版 → 版本历史 +1；两条用例都：导出当前列表 → 操作历史 +1），
 *   先证明这两台计数器推得动，再要求草稿路径上它们一动不动。
 *
 * 与既有用例的分工（不重复别人的地）：
 * - 99-s-browse-extra S3：切走再回来**草稿不丢**（锁草稿存活，不锁历史计数）。
 * - 99-s-direct-write-exit DWE-02：四个直写入口只生成计划、**零失败审计**（锁审计不冒红）。
 * - 99-s-history-local-revisions LH-01/02：读到就攒版、同一版重复读不涨（锁攒版这条正路）。
 * - 本文件：草稿的三条出路（继续编辑 / 放弃 / 带着草稿去变更计划再回来）在两台计数器上零增量，
 *   且草稿正文一个字都不许出现在任何一版里。
 *
 * 计数只按「这一个配置键」取（retestRevisionKeyStats）：页面挂载与切档会顺带读到别的配置，
 * 那些是真落盘但不是本用例种的地（口径同 LH-01 的 keyStats 说明）。
 */
import { test, expect, fetchNacosContent } from "./retestTest";
import type { Page } from "@playwright/test";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { retestRevisionKeyStats, retestRevisionsSnapshot } from "../bridge/retestBinding";
import { publishNacosContent, republishRetestData } from "../bridge/republishData";
import { dismissStartupDialog, navigate } from "./ui";
import { backToBrowseFromPlan, planRows } from "./planExit";
import { loadRetestState } from "../state";

const state = loadRetestState();
const BASE_A = state.nacos.a.baseUrl;
const NS_A = state.nacos.a.namespace;
const GROUP = "RETEST-PROD";
/** 配置浏览页在 retest 里固定落在 A 连接（见 storageSeed 的 selectedConnectionId）。 */
const CONN_A = "retest-a";
/** svc-billing.yaml 正文干净（无重复顶层 key），加一行注释不会被 YAML 校验拦下。 */
const DATA_ID = "svc-billing.yaml";
/** 「切换配置」这条草稿路径的落点：与 DATA_ID 不同键，不污染本用例的计数。 */
const OTHER_ID = "svc-search.yaml";
const OPS_KEY = "cs.operationHistory";
const T = 20_000;
/** 比较前让在途的读取落地：fire-and-forget 的写入没有屏可读，只能给它一点时间再取快照。 */
const SETTLE_MS = 1_200;

interface OpsRecord {
  id: string;
  type: string;
  result: string;
}

/** 一个配置键的两台计数器：本机版本历史（桥内替身）+ 操作历史（localStorage）。 */
interface Census {
  records: number;
  appended: number;
  promoted: number;
  duplicate: number;
  attempts: number;
  ops: number;
}

function keyStats(dataId: string) {
  return retestRevisionKeyStats(CONN_A, NS_A, GROUP, dataId);
}

/** 读当前 profile 的操作历史（按 id 增量比对，比翻操作历史页的 DOM 稳；口径同 DWE）。 */
async function readOps(page: Page): Promise<OpsRecord[]> {
  return page.evaluate((key) => {
    let parsed: unknown = [];
    try {
      parsed = JSON.parse(localStorage.getItem(key) ?? "[]");
    } catch {
      parsed = [];
    }
    const list = Array.isArray(parsed) ? parsed : [];
    return list
      .map((raw) => {
        const r = raw as Record<string, unknown>;
        return { id: String(r.id ?? ""), type: String(r.type ?? ""), result: String(r.result ?? "") };
      })
      .filter((r) => r.id);
  }, OPS_KEY);
}

async function censusOf(page: Page, dataId: string = DATA_ID): Promise<Census> {
  const stats = keyStats(dataId);
  const ops = await readOps(page);
  return {
    records: stats.records.length,
    appended: stats.appended,
    promoted: stats.promoted,
    duplicate: stats.duplicate,
    attempts: stats.attempts,
    ops: ops.length,
  };
}

/**
 * 草稿标记当正则用。
 *
 * 标记里有连字符和斜杠，不转义就会被当范围/字符类读——四处断言共用这一份转义口径。
 */
function markerRegex(marker: string): RegExp {
  return new RegExp(marker.replace(/[-/]/g, (m) => `\\${m}`));
}

/** 打开一个配置的正文（这一次真实读取就是本用例的基线，也是版本历史计数器的内置正控）。 */
async function openDetail(page: Page, dataId: string) {
  await page.locator(".browser-item", { hasText: dataId }).first().click({ timeout: T });
  await expect(page.locator(".browser-detail .detail-dataid")).toHaveText(dataId, { timeout: T });
  await expect(page.locator(".content-box .code-area").first()).toBeVisible({ timeout: T });
}

/**
 * 进编辑态并改正文，返回那句只有本用例知道的草稿标记。
 *
 * 用注释行改 YAML：正文合法，「生成变更计划」不会被校验弹框拦住（DF-02 要走完那条路）。
 */
async function makeDraft(page: Page, tag: string): Promise<string> {
  await page.getByRole("button", { name: "编辑", exact: true }).first().click({ timeout: T });
  const ta = page.locator(".code-editor-ta").first();
  await expect(ta).toBeVisible({ timeout: T });
  const marker = `# draft-must-not-enter-history-${tag}`;
  await ta.fill(`${(await ta.inputValue()).trimEnd()}\n${marker}\n`);
  await expect(ta).toHaveValue(markerRegex(marker));
  return marker;
}

/** 放弃确认框当前这一档的文案与按钮（标题固定，正文/按钮随动作分档）。 */
function discardModal(page: Page) {
  const modal = page.locator(".modal.modal-sm");
  return {
    modal,
    heading: page.getByRole("heading", { name: "放弃未保存的修改？" }),
    message: modal.locator(".confirm-msg"),
  };
}

/**
 * 断言草稿路径上两台计数器一条都没多，且草稿正文不在任何一版里。
 *
 * 两档口径，差别只在「允不允许多做一次真实读取」：
 * - strict：草稿的弃路 / 切 tab / 换配置一次读取都不许多做，六个字段全等基线（DF-01 走这档）。
 * - allowReReads：生成变更计划要经唯一读取出口把线上现值取回来当对比基线，那是合法重读，
 *   duplicate/attempts 会涨。这一档只钉「不攒新版」这一件真事：
 *   records/appended/promoted 与操作历史 ops 必须一字不动（DF-02 走这档）。
 *   反过来用 toEqual 会把合法重读判成缺陷——那是用例的错，不是程序的错。
 */
async function expectDraftLeavesNothing(
  page: Page,
  baseline: Census,
  marker: string,
  stage: string,
  mode: "strict" | "allowReReads" = "strict"
) {
  await page.waitForTimeout(SETTLE_MS);
  const now = await censusOf(page);
  if (mode === "strict") {
    expect(now, `${stage}：草稿路径不许推动任何一台计数器`).toEqual(baseline);
  } else {
    for (const field of ["records", "appended", "promoted", "ops"] as const) {
      expect(now[field], `${stage}：草稿路径把 ${field} 推动了`).toBe(baseline[field]);
    }
  }
  const polluted = retestRevisionsSnapshot().records.filter((rec) => (rec.content ?? "").includes(marker));
  expect(polluted.length, `${stage}：草稿正文出现在了本机版本历史里`).toBe(0);
}

/** 正控 B：导出当前列表是纯本机的真操作，必须往操作历史写一条（否则前面的零增量是假绿）。 */
async function exportMovesOps(page: Page, before: Census, stage: string) {
  const download = page.waitForEvent("download", { timeout: T }).catch(() => undefined);
  await page.getByRole("button", { name: "导出当前列表" }).click({ timeout: T });
  await expect(page.locator(".toaster .toast-success", { hasText: "已导出配置列表" }).first()).toBeVisible({ timeout: T });
  await download;
  const after = await censusOf(page);
  expect(after.ops, `${stage}：导出一整份列表都没往操作历史写一条，说明这台计数器是死的`).toBeGreaterThan(before.ops);
  const newest = (await readOps(page))[0];
  expect(newest.type, `${stage}：新写的那条操作记录不是导出`).toBe("export");
  return after;
}

test("DF-01 草稿的弃路与换配置路：两台计数器零增量，正控证明它们真推得动", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await page.goto("/");
  await dismissStartupDialog(page);
  await navigate(page, "配置浏览");
  await expect(page.locator(".browser-item-id").first()).toBeVisible({ timeout: T });

  const serverBaseline = await fetchNacosContent(BASE_A, NS_A, DATA_ID, GROUP);
  await openDetail(page, DATA_ID);
  // 内置正控：这一眼读取本身就该攒出一版。攒不出来，后面所有「零增量」都只是没接上表。
  await expect
    .poll(() => keyStats(DATA_ID).records.length, { timeout: T, message: "读到正文却没攒出本机版本历史的第一版" })
    .toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(SETTLE_MS);
  const base = await censusOf(page);
  expect(base.appended, "基线那一版必须走 appended 这一支").toBeGreaterThanOrEqual(1);
  expect(base.promoted, "只是读到正文，不该是写入确认").toBe(0);

  // ── 出路一：改正文 → 视图内查找 → 切到历史变更再切回 → Esc 只是「继续编辑」──
  const marker = await makeDraft(page, `df01a-${Date.now()}`);
  await page.locator(".code-editor-ta").first().click({ timeout: T });
  await page.keyboard.press("Control+f");
  await expect(page.locator(".code-find")).toBeVisible({ timeout: T });
  await page.locator(".code-find-input").fill(marker);
  await expect(page.locator(".code-find-count")).not.toContainText("无匹配", { timeout: T });
  await page.getByRole("button", { name: "关闭查找" }).click({ timeout: T });
  await expect(page.locator(".code-find")).toHaveCount(0);

  await page.locator(".detail-tabs .tab-btn", { hasText: "历史变更" }).first().click({ timeout: T });
  await expect(page.locator(".history-list-head, .history-list-head-row").first()).toBeVisible({ timeout: T });
  await page.locator(".detail-tabs .tab-btn", { hasText: "内容" }).first().click({ timeout: T });
  await expect(page.locator(".code-editor-ta").first()).toHaveValue(markerRegex(marker), {
    timeout: T,
  });
  await expectDraftLeavesNothing(page, base, marker, "编辑态查找与切 tab");

  const first = discardModal(page);
  await page.keyboard.press("Escape");
  await expect(first.heading).toBeVisible({ timeout: T });
  // 轮90 的文案分档：Esc/取消只退出编辑态、不跳任何配置，正文不许说「切换后将丢失」。
  await expect(first.message).toContainText("放弃后这些改动会丢失", { timeout: T });
  await expect(first.message).not.toContainText("切换");
  await expect(first.modal.getByRole("button", { name: "继续编辑" })).toBeVisible();
  await expect(first.modal.getByRole("button", { name: "放弃修改" })).toBeVisible();
  await first.modal.getByRole("button", { name: "继续编辑" }).click({ timeout: T });
  await expect(first.modal).toHaveCount(0);
  await expect(page.locator(".code-editor-ta")).toHaveCount(1);
  await expectDraftLeavesNothing(page, base, marker, "放弃确认后继续编辑");

  // ── 同一档的另一半：按「放弃修改」真的退出编辑态，草稿消失，历史仍一动不动 ──
  await page.keyboard.press("Escape");
  await expect(first.heading).toBeVisible({ timeout: T });
  await first.modal.getByRole("button", { name: "放弃修改" }).click({ timeout: T });
  await expect(page.locator(".code-editor-ta")).toHaveCount(0);
  await expect(page.locator(".content-box .code-area").first()).toBeVisible({ timeout: T });
  await expectDraftLeavesNothing(page, base, marker, "放弃修改退出编辑态");
  expect(await fetchNacosContent(BASE_A, NS_A, DATA_ID, GROUP), "草稿没保存却改到了服务端").toBe(serverBaseline);

  // ── 出路二：带着草稿换配置——确认文案必须改口说「切换」，放弃后新配置正常攒自己的版 ──
  const markerB = await makeDraft(page, `df01b-${Date.now()}`);
  await page.locator(".browser-item", { hasText: OTHER_ID }).first().click({ timeout: T });
  const second = discardModal(page);
  await expect(second.heading).toBeVisible({ timeout: T });
  await expect(second.message).toContainText("切换后将丢失这些改动", { timeout: T });
  await expect(second.modal.getByRole("button", { name: "放弃并切换" })).toBeVisible();
  await expect(second.modal.getByRole("button", { name: "留在当前" })).toBeVisible();
  await second.modal.getByRole("button", { name: "留在当前" }).click({ timeout: T });
  await expect(page.locator(".browser-detail .detail-dataid")).toHaveText(DATA_ID, { timeout: T });
  await expect.poll(() => page.locator(".code-editor-ta").count(), { timeout: T, message: "留在当前却把编辑态也收了" }).toBe(1);
  await expectDraftLeavesNothing(page, base, markerB, "放弃确认后留在当前");

  await page.locator(".browser-item", { hasText: OTHER_ID }).first().click({ timeout: T });
  await expect(second.heading).toBeVisible({ timeout: T });
  await second.modal.getByRole("button", { name: "放弃并切换" }).click({ timeout: T });
  await expect(page.locator(".browser-detail .detail-dataid")).toHaveText(OTHER_ID, { timeout: T });
  await expectDraftLeavesNothing(page, base, markerB, "放弃并切换离开这个配置");
  // 换过去的那一份是该攒自己的版（证明「零增量」不是因为整台表停摆）
  await expect
    .poll(() => keyStats(OTHER_ID).records.length, { timeout: T, message: "换过去的配置没攒到自己的第一版" })
    .toBeGreaterThanOrEqual(1);

  await page.screenshot({ path: "results/df01-draft-paths.png", fullPage: true });

  // ── 正控 A 上半场：同一份正文读第二次 → 只该走 duplicate 这一支。
  // 这一步既是「duplicate 计数器是活的」的取证，也顺手钉住「重读不攒新版」——
  // 原本把它塞到发布新版之后断言是错的：新正文走 appended，永远不会碰 duplicate。──
  await openDetail(page, DATA_ID);
  await expect
    .poll(() => keyStats(DATA_ID).duplicate, { timeout: T, message: "换回来重读同一份正文该走重复读这一支" })
    .toBeGreaterThan(base.duplicate);
  await page.waitForTimeout(SETTLE_MS);
  const beforeProbe = await censusOf(page);
  expect(beforeProbe.records, "同一份正文重读不该攒新版").toBe(base.records);
  expect(beforeProbe.appended, "同一份正文重读不该走 appended").toBe(base.appended);

  // ── 正控 A 下半场：正文真换一版 → 版本历史 +1 且走 appended。做不到，前面的「零增量」毫无意义。──
  const probe = `# r90-live-probe-${Date.now()}`;
  await publishNacosContent(BASE_A, NS_A, DATA_ID, GROUP, `${serverBaseline.trimEnd()}\n${probe}\n`);
  await page.getByRole("button", { name: "重新拉取内容" }).click({ timeout: T });
  await expect(page.locator(".content-box .code-area").first()).toContainText("billing", { timeout: T });
  await expect
    .poll(() => keyStats(DATA_ID).records.length, { timeout: T, message: "正文换了一版，本机版本历史却没跟着攒" })
    .toBe(beforeProbe.records + 1);
  const afterProbe = await censusOf(page);
  expect(afterProbe.appended, "新版没走 appended 这一支").toBe(beforeProbe.appended + 1);
  expect(afterProbe.duplicate, "正文换了新版，却被记成同内容重复读").toBe(beforeProbe.duplicate);

  // ── 正控 B：操作历史也推得动 ──
  await exportMovesOps(page, afterProbe, "DF-01");

  // 收尾把基线写回去：整批是串行的，后面的 99-s-* 还指着这份数据。
  await republishRetestData();
});

test("DF-02 带着草稿去生成变更计划再回来：草稿不进历史，服务端一字未改", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await page.goto("/");
  await dismissStartupDialog(page);
  await navigate(page, "配置浏览");
  await expect(page.locator(".browser-item-id").first()).toBeVisible({ timeout: T });

  const serverBaseline = await fetchNacosContent(BASE_A, NS_A, DATA_ID, GROUP);
  await openDetail(page, DATA_ID);
  await expect.poll(() => keyStats(DATA_ID).records.length, { timeout: T, message: "基线那一版没攒出来" }).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(SETTLE_MS);
  const base = await censusOf(page);

  const marker = await makeDraft(page, `df02-${Date.now()}`);
  await page.getByRole("button", { name: /生成变更计划/ }).click({ timeout: T });

  // 计划里是草稿那一份（覆盖），这是「草稿被带出编辑态」的合法去向，但它仍不是历史
  const rows = await planRows(page);
  expect(rows.length, "就地编辑的计划不该只有一条项").toBe(1);
  expect(rows[0].dataId, "计划挂在了别的配置上").toBe(DATA_ID);
  expect(rows[0].action, "草稿与线上正文不同，计划动作该是覆盖").toBe("overwrite");
  await expectDraftLeavesNothing(page, base, marker, "生成变更计划（未执行）", "allowReReads");

  await backToBrowseFromPlan(page);
  await expect(page.locator(".code-editor-ta").first()).toHaveValue(markerRegex(marker), {
    timeout: T,
  });
  await expectDraftLeavesNothing(page, base, marker, "从计划页回到浏览（草稿还在）", "allowReReads");

  const serverAfterPlan = await fetchNacosContent(BASE_A, NS_A, DATA_ID, GROUP);
  expect(serverAfterPlan, "只生成计划就把草稿写进了服务端").toBe(serverBaseline);
  expect(serverAfterPlan, "计划里带着草稿正文，服务端却该一个字没改").not.toContain(marker);
  await page.screenshot({ path: "results/df02-draft-via-plan.png", fullPage: true });

  // 正控 B：这条用例自己的操作历史计数器也得证明是活的
  await exportMovesOps(page, await censusOf(page), "DF-02");

  // 草稿还在屏上：退出浏览页前确认它落进放弃弹框，而不是悄悄留在保活子树里
  await page
    .locator(".fmt-bar button", { hasText: /^取消$/ })
    .first()
    .click({ timeout: T });
  const modal = discardModal(page);
  await expect(modal.heading).toBeVisible({ timeout: T });
  await modal.modal.getByRole("button", { name: "放弃修改" }).click({ timeout: T });
  await expect(page.locator(".code-editor-ta")).toHaveCount(0);
  await republishRetestData();
});
