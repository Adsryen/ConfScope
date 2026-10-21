// 轮55 C线 真机永久回归：批量对比结果内的跨项内容搜索。
//
// 为什么必须钉成真机：这一轮的判据是「屏幕上的数字对不对」，而数字的来源有两处——
// 左栏列表的计数/徽标/片段（searchDiffContent 扫内存里的左右正文）与右侧 diff 的标红
// （useFindLayer 的 externalTerm 通道）。jsdom 里两边都能自证一致，却可能一起偏离服务端真值；
// 真机这一趟把**基准换成 Nacos 原文**：先读服务端，再数 UI，两个数对不上才算 bug。
//
// 另外两条只有真浏览器才成立：
// 1. 保活让配置浏览页的搜索框留在 DOM 里，用例必须只认 batch 容器内可见的那一个；
// 2. Esc 分层（跨项搜索挂 page 档而非 find 档）要看真实注册顺序下按键归谁，
//    jsdom 那条已按「先开内层查找栏、再往搜索框打字」摆过顺序，这里在真人手顺下复验一次。
//
// 手顺（与真人一致）：配置对比 → 两侧选 Retest Nacos A/B + RETEST-PROD → 加载并对比
// → 全选（13 个 dataId）→ 对比选中 → 左栏头上那颗搜索框里打词。
//
// 用例：
//   DBS-01 计数与徽标等于服务端真值（命中配置数 / 处数 / 每项 A·B / 首个命中行号）
//   DBS-02 「只看命中项」只改列表，进入变更计划的条数与勾着一动不动
//   DBS-03 点命中行换当前项，右侧 diff 按同一个词标红**并真的滚到那一行**（列表与正文说同一句话）
//   DBS-04 无命中把作用域说清（搜了几个配置、搜的是什么词），列表不静默变空
//   DBS-05 Esc 先给右侧差异查找栏，第二次才收跨项搜索
import { expect, type Page } from "@playwright/test";
import { test, fetchNacosContent } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { navigate, dismissStartupDialog, setDiffSource } from "./ui";
import { loadRetestState } from "../state";

const state = loadRetestState();
const NS_A = state.nacos.a.namespace;
const NS_B = state.nacos.b.namespace;
const GROUP = "RETEST-PROD";

/** 播种数据里这个跨文件词命中数适中、且左右处数不相等（gateway A≠B），能同时验数与验分侧计数。 */
const TERM = "timeout";
/** 双侧正文里都不存在的词（用于「无命中」那条）。 */
const MISS_TERM = "no-such-key-9z7x";

interface NavItem {
  dataId: string;
  badge: string | null;
  hitLine: string | null;
  snippet: string | null;
  snippetMarks: number;
  active: boolean;
}

interface Probe {
  toolsVisible: boolean;
  statusText: string;
  cappedText: string | null;
  items: NavItem[];
  planButtonText: string | null;
  onlyHitsChecked: boolean;
  /** batch 主区内可见的标红数（词下传后右侧 diff 的命中）。 */
  diffMarks: number;
  diffBarVisible: boolean;
  searchInputValue: string;
  activeElement: string;
}

/** 与 lib/textMatch 的 matchLiteral 默认口径一致：大小写不敏感的字面子串。 */
function countOccurrences(text: string, term: string): number {
  const haystack = text.toLowerCase();
  const needle = term.toLowerCase();
  if (!needle) return 0;
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at >= 0) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

/** 首个命中所在行号（1 起），与 lib/diffContentSearch 的 lineNumberAt 同一算法。 */
function firstHitLine(text: string, term: string): number {
  const at = text.toLowerCase().indexOf(term.toLowerCase());
  if (at < 0) return 0;
  return (text.slice(0, at).match(/\n/g)?.length ?? 0) + 1;
}

interface SideTruth {
  a: number;
  b: number;
  /** 左侧首个命中行（1 起），无命中 0。 */
  lineA: number;
  /** 右侧首个命中行（1 起），无命中 0。 */
  lineB: number;
  /** 徽标上那个数：先左后右，与 DiffView 的 `hit.left.line || hit.right.line` 同口径。 */
  line: number;
}

/**
 * 从两个 Nacos 读原文，逐条算 A/B 处数与各自的首个命中行号。
 *
 * 只返回命中过的条目。DBS-01 用它核对列表数字，DBS-03 用它挑「左右首个命中行号一致」
 * 且落点足够深的那一条 —— 徽标只写一个行号（先左后右），两侧首命中行号不同的条目本身就有歧义，
 * 拿它断言「滚到的那一行 = 徽标写的那一行」会把语义问题变成数据问题。
 */
async function buildServerTruth(dataIds: string[]): Promise<Map<string, SideTruth>> {
  const truth = new Map<string, SideTruth>();
  for (const dataId of dataIds) {
    const [left, right] = await Promise.all([
      fetchNacosContent(state.nacos.a.baseUrl, NS_A, dataId, GROUP),
      fetchNacosContent(state.nacos.b.baseUrl, NS_B, dataId, GROUP),
    ]);
    const a = countOccurrences(left, TERM);
    const b = countOccurrences(right, TERM);
    if (!a && !b) continue;
    const lineA = a ? firstHitLine(left, TERM) : 0;
    const lineB = b ? firstHitLine(right, TERM) : 0;
    truth.set(dataId, { a, b, lineA, lineB, line: lineA || lineB });
  }
  return truth;
}

/** 右侧 diff 滚动容器与第一处命中的几何（轮56：点命中行要真的滚到那一行）。 */
interface DiffLocate {
  bodyFound: boolean;
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  markCount: number;
  /** 第一处命中所在 diff 行的 data-row-index 与两侧行号槽。 */
  rowIndex: number | null;
  rowLeftNo: number | null;
  rowRightNo: number | null;
  /** 第一处命中的矩形换算：内容坐标（与 scrollTop 无关）＋视口相对位置。 */
  markContentTop: number;
  markHeight: number;
  markTopInBody: number;
  markBottomInBody: number;
}

async function probeDiffLocate(page: Page): Promise<DiffLocate> {
  return page.evaluate(() => {
    const empty: DiffLocate = {
      bodyFound: false, scrollTop: 0, clientHeight: 0, scrollHeight: 0, markCount: 0,
      rowIndex: null, rowLeftNo: null, rowRightNo: null,
      markContentTop: 0, markHeight: 0, markTopInBody: 0, markBottomInBody: 0,
    } as DiffLocate;
    const main = Array.from(document.querySelectorAll<HTMLElement>(".batch-diff-main")).find((m) => m.offsetParent !== null);
    const body = main?.querySelector<HTMLElement>(".diff-body");
    if (!body) return empty;
    const num = (text: string | null): number | null => {
      const trimmed = (text ?? "").trim();
      return trimmed && /^\d+$/.test(trimmed) ? Number(trimmed) : null;
    };
    const marks = Array.from(body.querySelectorAll<HTMLElement>("mark.search-hit")).filter((m) => m.offsetParent !== null);
    const first = marks[0] ?? null;
    const row = first?.closest<HTMLElement>(".diff-row") ?? null;
    const gutters = row ? Array.from(row.querySelectorAll<HTMLElement>(".diff-gutter")).map((g) => num(g.textContent)) : [];
    const bodyRect = body.getBoundingClientRect();
    const markRect = first?.getBoundingClientRect() ?? null;
    return {
      bodyFound: true,
      scrollTop: body.scrollTop,
      clientHeight: body.clientHeight,
      scrollHeight: body.scrollHeight,
      markCount: marks.length,
      rowIndex: row ? Number(row.getAttribute("data-row-index") ?? NaN) : null,
      rowLeftNo: gutters[0] ?? null,
      rowRightNo: gutters[1] ?? null,
      markContentTop: markRect ? markRect.top - bodyRect.top + body.scrollTop - body.clientTop : 0,
      markHeight: markRect ? markRect.height : 0,
      markTopInBody: markRect ? markRect.top - bodyRect.top : 0,
      markBottomInBody: markRect ? markRect.bottom - bodyRect.top : 0,
    };
  });
}

async function probeBatch(page: Page): Promise<Probe> {
  return page.evaluate(() => {
    const nav = Array.from(document.querySelectorAll<HTMLElement>(".batch-diff .batch-diff-nav")).find((n) => n.offsetParent !== null);
    const tools = nav?.querySelector<HTMLElement>(".batch-diff-search-tools") ?? null;
    const status = nav?.querySelector<HTMLElement>(".batch-diff-search-status") ?? null;
    const items = Array.from(nav?.querySelectorAll<HTMLElement>(".batch-diff-nav-item") ?? []).map((el) => ({
      dataId: el.querySelector<HTMLElement>(".batch-diff-nav-title")?.textContent?.trim() ?? "",
      badge: el.querySelector<HTMLElement>(".batch-diff-nav-hit-count")?.textContent?.trim() ?? null,
      hitLine: el.querySelector<HTMLElement>(".batch-diff-nav-hit-line")?.textContent?.trim() ?? null,
      snippet: el.querySelector<HTMLElement>(".batch-diff-nav-snippet")?.textContent ?? null,
      snippetMarks: el.querySelectorAll("mark.search-hit").length,
      active: el.classList.contains("active"),
    }));
    // 「进入配置变更计划」在 diff-loadbar 工具条里，是 .batch-diff 的兄弟节点（不是子树），
    // 用 .batch-diff 前缀限定会永远读到 null —— 那样连「过滤改写了条数」都断言不出来。
    const plan = document.querySelector<HTMLElement>(".diff-loadbar.result-actions .result-action-plan");
    const checkbox = nav?.querySelector<HTMLInputElement>(".batch-diff-search-filter input") ?? null;
    const main = Array.from(document.querySelectorAll<HTMLElement>(".batch-diff-main")).find((m) => m.offsetParent !== null);
    const input = nav?.querySelector<HTMLInputElement>(".batch-diff-search .search-input") ?? null;
    const active = document.activeElement as HTMLElement | null;
    return {
      toolsVisible: !!tools && tools.offsetParent !== null,
      statusText: status?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      cappedText: nav?.querySelector<HTMLElement>(".batch-diff-search-capped")?.textContent?.trim() ?? null,
      items,
      planButtonText: plan?.textContent?.replace(/\s+/g, " ").trim() ?? null,
      onlyHitsChecked: !!checkbox?.checked,
      diffMarks: main ? Array.from(main.querySelectorAll<HTMLElement>("mark.search-hit")).filter((m) => m.offsetParent !== null).length : 0,
      diffBarVisible: !!main?.querySelector<HTMLElement>(".code-find") && !!main?.querySelector(".code-find-input"),
      searchInputValue: input?.value ?? "",
      activeElement: active ? `${active.tagName.toLowerCase()}.${typeof active.className === "string" ? active.className.trim().split(/\s+/).join(".") : ""}` : "",
    };
  });
}

/** 走到「已生成 N 个文件对比」的批量态，返回应用自己匹配出来的 dataId 清单。 */
async function enterBatch(page: Page): Promise<string[]> {
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "配置对比");
  await page.waitForTimeout(500);
  await setDiffSource(page, "left", { connection: "Retest Nacos A", namespace: NS_A, group: GROUP });
  await setDiffSource(page, "right", { connection: "Retest Nacos B", namespace: NS_B, group: GROUP });
  await page.getByRole("button", { name: "加载并对比" }).last().click();
  await expect(page.locator(".match-list")).toBeVisible({ timeout: 30_000 });
  await page.locator(".match-toggle-all input").check();
  await page.getByRole("button", { name: /对比选中/ }).last().click();
  await expect(page.locator(".batch-diff .batch-diff-nav-item").first()).toBeVisible({ timeout: 90_000 });
  await page.waitForTimeout(500);
  const probe = await probeBatch(page);
  expect(probe.items.length, "批量态没把匹配到的配置都载进来").toBeGreaterThan(0);
  return probe.items.map((item) => item.dataId);
}

const searchBox = (page: Page) => page.locator(".batch-diff .batch-diff-search .search-input").filter({ visible: true }).first();

test("DBS-01 计数与徽标等于服务端真值", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  const dataIds = await enterBatch(page);

  // 基准：直接从两个 Nacos 读原文，逐条算 A/B 处数与首个命中行号
  const truth = await buildServerTruth(dataIds);
  const matchedItems = [...truth.values()];
  const expectMatches = matchedItems.reduce((sum, hit) => sum + hit.a + hit.b, 0);
  console.log(`[DBS-01] 作用域=${dataIds.length} 个已加载配置，服务端真值：命中 ${truth.size} 个 / 共 ${expectMatches} 处`);
  expect(truth.size, "播种数据里这个词一个都没命中，用例失去意义").toBeGreaterThan(0);
  expect(
    [...truth.values()].some((hit) => hit.a !== hit.b),
    "需要至少一条左右处数不相等的配置，才能验出「A/B 被合并成一个总数」的退化"
  ).toBeTruthy();

  await searchBox(page).fill(TERM);
  await expect
    .poll(async () => (await probeBatch(page)).statusText, "列表计数没出现或与真值不一致")
    .toBe(`命中 ${truth.size} 个配置 · 共 ${expectMatches} 处`);

  const probe = await probeBatch(page);
  // 触顶文案不许凭空出现（这批远小于上限 100）
  expect(probe.cappedText, `未触顶却挂着截断文案：${probe.cappedText}`).toBeNull();
  // 未命中的配置留在列表里（默认不过滤），且不挂徽标与片段
  expect(probe.items).toHaveLength(dataIds.length);
  const offenders: string[] = [];
  for (const item of probe.items) {
    const hit = truth.get(item.dataId);
    const wantBadge = hit ? `A ${hit.a} · B ${hit.b}` : null;
    if (item.badge !== wantBadge) offenders.push(`${item.dataId}: 徽标=${item.badge ?? "无"} 期望=${wantBadge ?? "无"}`);
    if (hit) {
      if (item.hitLine !== `第 ${hit.line} 行`) offenders.push(`${item.dataId}: 行号=${item.hitLine} 期望 第 ${hit.line} 行`);
      if (!item.snippet || item.snippetMarks === 0) offenders.push(`${item.dataId}: 命中了却没有标红片段`);
    } else if (item.snippet) {
      offenders.push(`${item.dataId}: 服务端没命中，列表却给了片段`);
    }
  }
  expect(offenders, "列表与服务端真值不一致：\n" + offenders.join("\n")).toEqual([]);
  await page.screenshot({ path: "results/v55_batch_search_counts.png" });
});

test("DBS-02 只看命中项只改列表，不动将要应用的东西", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  const dataIds = await enterBatch(page);
  await searchBox(page).fill(TERM);
  await expect.poll(async () => (await probeBatch(page)).toolsVisible).toBe(true);

  const before = await probeBatch(page);
  // 探针自身先自证：读到 null 就是选择器失效，必须当场红，不许靠 null === null 蒙过下一条断言
  expect(before.planButtonText, "没探到「进入配置变更计划」按钮，本条用例的不变式无从校验").toBeTruthy();
  const matched = before.items.filter((item) => item.badge).map((item) => item.dataId);
  expect(matched.length, "先确认有命中项，否则过滤这条没内容").toBeGreaterThan(0);
  expect(matched.length, "命中数不该等于全量（否则过滤无从分辨）").toBeLessThan(dataIds.length);

  await page.locator(".batch-diff .batch-diff-search-filter").filter({ visible: true }).first().click();
  await expect
    .poll(async () => (await probeBatch(page)).items.map((item) => item.dataId).join(","), "过滤后列表没收窄到命中项")
    .toBe(matched.join(","));

  const after = await probeBatch(page);
  expect(after.onlyHitsChecked).toBe(true);
  // 关键不变式：过滤只是看列表的方式，进入变更计划的条数照旧
  expect(after.planButtonText, "过滤把「进入配置变更计划」的条数改写了").toBe(before.planButtonText);
  expect(after.planButtonText).toBe(`进入配置变更计划（${dataIds.length} 个文件）`);

  await page.locator(".batch-diff .batch-diff-search-filter").filter({ visible: true }).first().click();
  await expect.poll(async () => (await probeBatch(page)).items.length, "取消过滤后列表没恢复全量").toBe(dataIds.length);
  await page.screenshot({ path: "results/v55_batch_search_filter.png" });
});

test("DBS-03 点命中行换当前项，右侧 diff 按同一个词标红并真的滚到那一行", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  const dataIds = await enterBatch(page);
  await searchBox(page).fill(TERM);
  await expect.poll(async () => (await probeBatch(page)).toolsVisible).toBe(true);

  // 挑一条「落点无歧义、且首命中就在这一屏之外」的：徽标只写一个行号（先左后右），
  // 两侧首命中行号不同的条目拿它断言落点会把语义问题算成数据问题；首命中太靠前的条目
  // 在 scrollTop=0 时本来就看得见，断言会空转（轮56 起草时正是靠深命中才拍到 bug）。
  const truth = await buildServerTruth(dataIds);
  const candidates = (await probeBatch(page))
    .items.filter((item) => item.badge)
    .map((item) => ({ item, hit: truth.get(item.dataId)! }))
    .filter((pair) => pair.hit && (pair.hit.lineA === 0 || pair.hit.lineB === 0 || pair.hit.lineA === pair.hit.lineB))
    .sort((a, b) => b.hit.line - a.hit.line);
  expect(candidates.length, "没有任何「左右首个命中行号一致」的命中项可点，播种数据变了就先这里换词").toBeGreaterThan(0);
  const target = candidates[0].item;
  const want = candidates[0].hit;

  await page.locator(".batch-diff .batch-diff-nav-item").filter({ visible: true }).filter({ hasText: target.dataId }).first().click();

  await expect
    .poll(async () => (await probeBatch(page)).diffMarks, `点到 ${target.dataId} 后右侧 diff 一处都没标红（词没下传）`)
    .toBeGreaterThan(0);
  const probe = await probeBatch(page);
  expect(probe.items.find((item) => item.dataId === target.dataId)?.active, "点中的行没成为当前项").toBe(true);
  expect(
    probe.items.filter((item) => item.active),
    "同时出现两个当前项"
  ).toHaveLength(1);
  // 徽标与内存真值必须还是同一句话，否则下面按行号核对落点没有意义
  expect(target.hitLine, `徽标行号与 Nacos 原文不一致：期望 第 ${want.line} 行`).toBe(`第 ${want.line} 行`);

  const locate = await probeDiffLocate(page);
  expect(locate.bodyFound, "没探到右侧 diff 的滚动容器 .diff-body，本条用例的判据无从校验").toBe(true);
  expect(locate.markCount, "diff 正文里一处命中都没有").toBeGreaterThan(0);
  const maxScroll = Math.max(0, locate.scrollHeight - locate.clientHeight);
  // 居中的是命中的矩形（lib/codeScroll 的口径），不是整行：长行换行时整行比视口还高
  const expected = Math.min(Math.max(locate.markContentTop - (locate.clientHeight - locate.markHeight) / 2, 0), maxScroll);
  console.log(
    `[DBS-03] ${target.dataId} 徽标=第 ${want.line} 行 A=${want.a} B=${want.b} | ` +
      `scrollTop=${locate.scrollTop.toFixed(1)} 期望=${expected.toFixed(1)} clientHeight=${locate.clientHeight} ` +
      `scrollHeight=${locate.scrollHeight} 命中内容偏移=${locate.markContentTop.toFixed(1)} 落点行=${locate.rowIndex}(L${locate.rowLeftNo}/R${locate.rowRightNo})`
  );
  // 1) 这一行必须本来看不见 ⇒ 定位真的动了 scrollTop（轮56 的缺陷就是标红却停在第 1 行）
  expect(locate.markContentTop > locate.clientHeight, `「第 ${want.line} 行」这一屏本来就看得见，本条用例失去意义，请换更深的命中`).toBe(true);
  expect(locate.scrollTop, "整篇标红却停在文件开头：外部搜索词没人负责滚动").toBeGreaterThan(0);
  // 2) 落点不是「随便滚了一下」：按同一套几何复算，误差 2px 内
  expect(Math.abs(locate.scrollTop - expected), `scrollTop=${locate.scrollTop} 与命中矩形居中的 ${expected} 不一致`).toBeLessThanOrEqual(2);
  // 3) 红字真的在视口里（用户看得见才叫定位成功）
  expect(locate.markTopInBody, "命中跑到视口之上").toBeGreaterThanOrEqual(-1);
  expect(locate.markBottomInBody, "命中跑到视口之下").toBeLessThanOrEqual(locate.clientHeight + 1);
  // 4) 列表与正文说同一句话：滚到的那一行的行号槽就是徽标写的第 N 行
  const gutterNumbers = [locate.rowLeftNo, locate.rowRightNo].filter((n): n is number => n !== null);
  expect(gutterNumbers, `落点行的行号槽(${gutterNumbers.join("/")})里没有徽标写的第 ${want.line} 行`).toContain(want.line);
  await page.screenshot({ path: "results/v56_batch_search_locate.png" });
});

test("DBS-04 无命中把作用域说清，列表不静默变空", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  const dataIds = await enterBatch(page);
  // 先确保这个词在两侧原文里真的不存在（否则「无命中」文案的断言会在数据变化后假红）
  for (const dataId of dataIds) {
    const [left, right] = await Promise.all([
      fetchNacosContent(state.nacos.a.baseUrl, NS_A, dataId, GROUP),
      fetchNacosContent(state.nacos.b.baseUrl, NS_B, dataId, GROUP),
    ]);
    expect(countOccurrences(left, MISS_TERM) + countOccurrences(right, MISS_TERM), `${dataId} 里居然有 ${MISS_TERM}`).toBe(0);
  }

  await searchBox(page).fill(MISS_TERM);
  await expect
    .poll(async () => (await probeBatch(page)).statusText, "无命中时没把搜了几个配置与搜的词说出来")
    .toBe(`这 ${dataIds.length} 个已加载配置的正文里没有「${MISS_TERM}」`);
  const probe = await probeBatch(page);
  // 列表不静默变空（默认没开过滤），也不许有徽标
  expect(probe.items).toHaveLength(dataIds.length);
  expect(probe.items.filter((item) => item.badge), "无命中却挂着徽标").toHaveLength(0);
  await page.screenshot({ path: "results/v55_batch_search_empty.png" });
});

test("DBS-05 Esc 先给右侧差异查找栏，第二次才收跨项搜索", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  await enterBatch(page);

  // 顺序有讲究：先把右侧差异正文的查找栏开起来（内层先登记），再回头往左栏搜索框打字。
  // 跨项搜索若借 find 档，父层注册排在子层之后、同档比注册序，就会反吃这一键。
  await page.locator(".batch-diff .code-find-open").filter({ visible: true }).first().click();
  await expect(page.locator(".batch-diff .code-find-input").filter({ visible: true }).first()).toBeVisible({ timeout: 10_000 });

  await searchBox(page).fill(TERM);
  await expect.poll(async () => (await probeBatch(page)).toolsVisible).toBe(true);

  await page.locator(".batch-diff .code-find-input").filter({ visible: true }).first().press("Escape");
  await expect(page.locator(".batch-diff .code-find-input").filter({ visible: true }).first(), "内层查找栏没被关掉").toBeHidden({
    timeout: 10_000,
  });
  expect((await probeBatch(page)).searchInputValue, "跨项搜索的词被第一次 Esc 擦了（档位抢键）").toBe(TERM);

  await searchBox(page).press("Escape");
  await expect.poll(async () => (await probeBatch(page)).toolsVisible, "第二次 Esc 没收起跨项搜索").toBe(false);
  const probe = await probeBatch(page);
  expect(probe.searchInputValue).toBe("");
  console.log(`[DBS-05] 焦点归还：${probe.activeElement}`);
  expect(probe.activeElement, "Esc 后焦点该留在搜索框里").toContain("input.search-input");
  await page.screenshot({ path: "results/v55_batch_search_escape_layers.png" });
});
