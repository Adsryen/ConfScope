/**
 * 对比页保活范围回归（轮44 AC1 / AC2 / AC3 / AC8，用例号 DK-01…DK-04）。
 *
 * 立轮理由（轮43 实测取证）：`.diff-apply-cache` 的条件是 `mode === "diff" || mode === "apply"`，
 * 而 `.browse-cache` 是「切走只 hidden、不卸载」。于是从对比页绕一趟浏览页，刚跑完的 60 行差异
 * 直接归零（探针读数：可见 .diff-row 60 → 0），切回还要重打 8 次请求。本轮把两页对齐成
 * 「第一次可见才挂载，之后永不卸载只 hidden」，代价是新风险：常驻挂载不能变成后台轮询。
 *
 * 分工（别在这里重复单测已经钉死的东西）：
 *  DK-01 绕道浏览页后对比结果还在 + 切回 0 次取数（AC1）——只有真机能证明「整棵子树留住了」。
 *  DK-02 没进过对比页 ⇒ DOM 里根本没有对比页 + 前台静置不自己发请求（AC2，挡「常驻挂载」这个方案）。
 *  DK-03 隐藏期改连接依赖 ⇒ dataId 候选一次都不许发；切回 ⇒ 必须补做一次（AC3 两半都在真机上钉）。
 *        「补齐用的是最新连接而不是旧连接」仍由 src/components/DiffView.test.tsx 钉：DOM 层判不出
 *        这件事，硬要在真机上判就只能数请求次数，反而糊掉归属。
 *  DK-04 真机批起跑后服务端干净：三组合 0 条 `retest-*` 残留，且播种的 `svc-*` 与四个 group 一条没少
 *        （AC6/AC7 的永久回归——清扫是环境兜底，判错前缀就是删用户数据）。
 *
 * 归属判定口径（DK-01/02/03 都靠它）：桥日志一行带 `[连接id baseUrl]` 指纹，浏览页与对比页打的是
 * 同两个方法名（ConfigCenterListNamespaces / ConfigCenterListConfigs），所以数请求必须限定在
 * 「双方都挂载且已沉降」之后的窗口里——窗口内任何一次取数都不是首屏该发的那一次。
 *
 * 但连接id 分不出「是谁发的」：连接管理的编辑表单自己就打 ConfigCenterListNamespaces
 * （namespace-preview，profile.id 就是 retest-a，指纹与对比页完全一样，真机第一轮 DK-03 就是这么误红的）。
 * 所以要区分归属的窗口只数 ConfigCenterListConfigs——连接管理不发它，对比页左面板必发它。
 */
import { test, expect } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { onBridgeLog } from "../bridge/retestBinding";
import { republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog, setDiffSource } from "./ui";
import { loadRetestState } from "../state";
import { sweepRetestStrays, sweepTargets } from "../strays";

const state = loadRetestState();
const BASE_A = state.nacos.a.baseUrl;
const BASE_B = state.nacos.b.baseUrl;
const NS_A = state.nacos.a.namespace;
const NS_B = state.nacos.b.namespace;
const GROUP = "RETEST-PROD";
const BILLING = "svc-billing.yaml";
const T = 30_000;

type Page_ = import("@playwright/test").Page;

/** 来源面板的取数指纹：命名空间列表 + dataId 候选（对比页两侧面板都靠这两个）。 */
const SOURCE_FETCH = /ConfigCenterListNamespaces|ConfigCenterListConfigs/;

function bridgeWaterline() {
  const lines: string[] = [];
  onBridgeLog((line) => lines.push(line));
  let mark = 0;
  return {
    mark: () => {
      mark = lines.length;
    },
    /** 窗口内命中的取数请求行（带指纹，便于失败时直接读是谁发的）。 */
    since: () => lines.slice(mark).filter((l) => SOURCE_FETCH.test(l)),
    /** 只数 dataId 候选：连接管理 / 命名空间预览不发它，需要区分归属的窗口用它。 */
    sinceConfigList: () => lines.slice(mark).filter((l) => l.includes("ConfigCenterListConfigs")),
    tail: (n = 20) => lines.slice(-n).join("\n"),
  };
}

/** 对比页两侧来源指到 A/B 两个真实连接，并把一条差异跑出来。 */
async function openLoadedDiff(page: Page_): Promise<void> {
  await navigate(page, "配置对比");
  await page.waitForTimeout(500);
  await setDiffSource(page, "left", { connection: "Retest Nacos A", namespace: NS_A, group: GROUP, dataId: BILLING });
  await setDiffSource(page, "right", { connection: "Retest Nacos B", namespace: NS_B, group: GROUP, dataId: BILLING });
  await page.getByRole("button", { name: "加载并对比" }).last().click();
  await expect(page.locator(".diff-panel").filter({ visible: true }).first()).toBeVisible({ timeout: T });
  await expect(page.locator(".diff-panel .diff-row").filter({ visible: true }).first()).toBeVisible({ timeout: T });
}

/** 先把浏览页挂载并沉降好：否则它的首屏取数会落进后面要数的窗口里。 */
async function settleBrowse(page: Page_): Promise<void> {
  await navigate(page, "配置浏览");
  await expect(page.locator(".browser-item-id").filter({ visible: true }).first()).toBeVisible({ timeout: T });
  await page.waitForTimeout(1_500);
}

/**
 * 把启动页钉回「配置浏览」。
 *
 * retest 种子的 cs.ui 里 mode 写死 "diff"、左右来源齐全地住在 cs.diffViewPreferences
 * （bridge/storageSeed.ts:49-85，别的 spec 要靠它直接从对比页起步；轮46 R01 起「要不要自动比」
 * = 启动就落在对比页 + 这一对齐全，来源本身不再有第二个镜像），
 * 而桥的 init script 每次加载都重新覆写种子——
 * 于是 DK-02 想测的「新会话没进过对比页」在默认种子上根本不成立：首屏就挂在对比页上
 * （真机第一轮 count=1 就是这么红的，不是上一批把 mode 存脏了）。
 *
 * 做法是再补一层 addInitScript 而不是 goto 之后改 localStorage：init script 按注册顺序执行，
 * 它在桥的种子之后、App 第一次读 cs.ui 之前跑，既不依赖任何 debounce，也不会被下次 goto 冲掉。
 */
async function pinStartupToBrowse(page: Page_): Promise<void> {
  await page.addInitScript(() => {
    try {
      const ui = JSON.parse(window.localStorage.getItem("cs.ui") || "{}") as Record<string, unknown>;
      ui.mode = "browse";
      window.localStorage.setItem("cs.ui", JSON.stringify(ui));
    } catch {
      window.localStorage.setItem("cs.ui", JSON.stringify({ mode: "browse" }));
    }
  });
}

async function listConfigs(baseUrl: string, namespace: string): Promise<{ dataId: string; group: string }[]> {
  const items: { dataId: string; group: string }[] = [];
  for (let pageNo = 1; pageNo <= 10; pageNo += 1) {
    const url =
      `${baseUrl}/v1/cs/configs?search=accurate&dataId=&group=` +
      `&pageNo=${pageNo}&pageSize=300&tenant=${encodeURIComponent(namespace)}`;
    const res = await fetch(url);
    expect(res.ok, `列不出 ${namespace} HTTP=${res.status}`).toBe(true);
    const body = (await res.json()) as { pageItems?: { dataId: string; group: string }[]; totalCount?: number };
    const page = body.pageItems ?? [];
    items.push(...page);
    if (page.length === 0 || items.length >= (body.totalCount ?? items.length)) break;
  }
  return items;
}

test.beforeEach(async ({ page, retest }) => {
  await installRetestBridge(page, retest);
});

test("DK-01 对比结果绕道浏览页后还在, 切回 0 次取数", async ({ page }) => {
  test.setTimeout(240_000);
  await republishRetestData();
  const water = bridgeWaterline();

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await settleBrowse(page);
  await openLoadedDiff(page);

  const rows = page.locator(".diff-panel .diff-row").filter({ visible: true });
  const n1 = await rows.count();
  expect(n1, "对比结果一条都没跑出来，DK-01 无从判定").toBeGreaterThan(0);
  console.log(`[DK-01] 绕道前可见 diff-row = ${n1}`);

  water.mark();
  await navigate(page, "配置浏览");
  await expect(page.locator(".browse-page").filter({ visible: true }).first()).toBeVisible({ timeout: T });
  // 保活的直接证据：对比页整棵子树仍在 DOM 里，只是不可见
  expect(await page.locator(".diff-apply-cache").count(), "切走即卸载 = .diff-apply-cache 没了").toBe(1);
  expect(await page.locator(".diff-apply-cache").evaluate((el) => (el as HTMLElement).hidden), "对比页切走没被 hidden").toBe(true);

  await navigate(page, "配置对比");
  const n2 = await rows.count().catch(() => 0);
  const fired = water.since();
  console.log(`[DK-01] 绕道后可见 diff-row = ${n2}；绕道期间取数请求 = ${fired.length} 次`);
  if (fired.length) console.log(`[DK-01] 桥日志 tail:\n${water.tail(8)}`);
  expect(n2, "绕道浏览页后对比结果没了 = diff 子树被卸载").toBe(n1);
  expect(fired.length, "切走/切回期间自己发了取数请求 = 保活页没兜住 active 闸门").toBe(0);
  await page.screenshot({ path: "results/dk01-diff-after-detour.png", fullPage: true });
});

test("DK-02 没进过对比页就不挂载, 前台静置也不自己发请求", async ({ page }) => {
  test.setTimeout(180_000);
  await republishRetestData();
  const water = bridgeWaterline();

  await pinStartupToBrowse(page);
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await settleBrowse(page);

  // 档位自检：这一趟确实从浏览页起步，否则下面的 count=0 断的是另一台机器
  expect(await page.locator(".browse-page").filter({ visible: true }).count(), "启动页没被钉回浏览页").toBe(1);

  // 否决「常驻挂载」方案：没进过这一页就不该在 DOM 里，更不该在启动路径上多打请求
  expect(await page.locator(".diff-apply-cache").count(), "新会话没进对比页却已经挂载 = 给启动加了取数").toBe(0);
  water.mark();
  await page.waitForTimeout(3_000);
  expect(water.since().length, "停在浏览页静置 3s 仍发对比页请求 = 后台轮询").toBe(0);

  // 检测器不能是瞎的：第一次进对比页必须挂载并立刻取数
  await navigate(page, "配置对比");
  await expect(page.locator(".diff-view").filter({ visible: true }).first()).toBeVisible({ timeout: T });
  await page.waitForTimeout(1_500);
  expect(water.since().length, "第一次进对比页没有取数 = 水位线看不见这一页的请求").toBeGreaterThan(0);
  await page.screenshot({ path: "results/dk02-first-entry.png", fullPage: true });
});

test("DK-03 隐藏期改连接依赖不取数, 切回才补齐", async ({ page }) => {
  test.setTimeout(240_000);
  await republishRetestData();
  const water = bridgeWaterline();

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await settleBrowse(page);
  await navigate(page, "配置对比");
  // 只把左侧来源面板加载好（命名空间 + 候选），差异本身不跑，窗口才干净
  await page.waitForTimeout(2_000);
  expect(await page.locator(".diff-view").filter({ visible: true }).count()).toBe(1);

  await navigate(page, "配置浏览");
  await expect(page.locator(".browse-page").filter({ visible: true }).first()).toBeVisible({ timeout: T });

  // 隐藏期制造一次真实的依赖变化：编辑并保存播种连接 A（值不变，但 connections 里换了对象）
  await navigate(page, "连接管理");
  const item = page.locator(".conn-item", { hasText: "Retest Nacos A" }).first();
  await expect(item, "连接管理里找不到播种连接 A").toBeVisible({ timeout: T });
  await item.click();
  // 编辑表单的命名空间预览会自己打请求，等它沉降完再开水位线
  await page.waitForTimeout(2_500);
  water.mark();
  await page.locator("button", { hasText: "保存" }).last().click();
  await expect(page.locator(".conn-item", { hasText: "Retest Nacos A" }).first()).toBeVisible({ timeout: T });
  await page.waitForTimeout(2_000);

  // 窗口只数 dataId 候选：这一趟在连接管理里编辑过 A，它自己的命名空间预览也发
  // ConfigCenterListNamespaces，还带一模一样的 [retest-a] 指纹，按全量数会把别人的账算到对比页头上
  const duringHidden = water.sinceConfigList();
  console.log(
    `[DK-03] 隐藏期 dataId 候选取数 = ${duringHidden.length} 次（全量取数 ${water.since().length} 次，多出来的是连接管理自己的命名空间预览）`
  );
  if (duringHidden.length) console.log(`[DK-03] 桥日志 tail:\n${water.tail(10)}`);
  expect(duringHidden.length, "对比页藏着的时候因为依赖变化自己发了请求 = activeRef 闸门漏了").toBe(0);

  // 切回：隐藏期记的那一笔要合并补做，这一页才挂得上最新连接的真值
  await navigate(page, "配置对比");
  await expect(page.locator(".diff-view").filter({ visible: true }).first()).toBeVisible({ timeout: T });
  await page.waitForTimeout(2_500);
  const afterBack = water.sinceConfigList();
  console.log(`[DK-03] 切回后 dataId 候选补做 = ${afterBack.length} 次`);
  expect(afterBack.length, "切回对比页没有补齐取数 = 隐藏期只 return 没记账（pendingFetchRef 漏了）").toBeGreaterThan(0);
  await page.screenshot({ path: "results/dk03-back-to-diff.png", fullPage: true });
});

test("DK-04 真机批起跑后服务端干净: 0 条 retest- 残留且播种数据没被误删", async ({}) => {
  await republishRetestData();
  const combos = [
    { label: "A/dev", baseUrl: BASE_A, namespace: NS_A, minSeed: 10 },
    { label: "A/qa", baseUrl: BASE_A, namespace: NS_B, minSeed: 1 },
    { label: "B/qa", baseUrl: BASE_B, namespace: NS_B, minSeed: 10 },
  ];
  for (const combo of combos) {
    const items = await listConfigs(combo.baseUrl, combo.namespace);
    const strays = items.filter((i) => i.dataId.toLowerCase().startsWith("retest-"));
    const seeded = items.filter((i) => i.dataId.startsWith("svc-"));
    console.log(`[DK-04] ${combo.label} 共 ${items.length} 条，svc-* ${seeded.length} 条，retest-* ${strays.length} 条`);
    // 清扫的本职：上一批崩在中间留下的条目不能活到这一批的条数断言里
    expect(strays, `${combo.label} 残留 ${JSON.stringify(strays)}：清扫没跑或判据漏了`).toEqual([]);
    // 清扫的副作用红线：判据一旦放宽到 group / 前缀写错，播种基线就会被当垃圾扫掉
    expect(seeded.length, `${combo.label} 的 svc-* 播种数据被误删了`).toBeGreaterThanOrEqual(combo.minSeed);
  }
  // RETEST-* 是 group 名不是 dataId，四个组都得还在
  const groups = new Set((await listConfigs(BASE_A, NS_A)).map((i) => i.group));
  for (const g of ["DEFAULT_GROUP", "RETEST-MESSENGE", "RETEST-ORDER", "RETEST-PROD"]) {
    expect(groups.has(g), `A/dev 的 group ${g} 没了（清扫不该碰 group）`).toBe(true);
  }
});

/** 往指定落点投一条 `retest-` 前缀条目，模拟上一条用例崩在中途留下的尸体。 */
async function publishStray(baseUrl: string, tenant: string, dataId: string): Promise<void> {
  const qs =
    `dataId=${encodeURIComponent(dataId)}&group=${encodeURIComponent(GROUP)}` +
    `&tenant=${encodeURIComponent(tenant)}&content=${encodeURIComponent("# v44 stray\n")}&type=properties`;
  const res = await fetch(`${baseUrl}/v1/cs/configs?${qs}`, { method: "POST" });
  const body = await res.text();
  expect(res.ok && body.trim() === "true", `投残留就失败 HTTP=${res.status} body=${body.slice(0, 60)}`).toBe(true);
}

/** 三个落点当前的 retest-* 残留清单——落点取自 sweepTargets()，别和清扫各写一套。 */
async function listStrays(): Promise<string[]> {
  const acc: string[] = [];
  for (const target of sweepTargets()) {
    for (const item of await listConfigs(target.baseUrl, target.namespace)) {
      if (item.dataId.toLowerCase().startsWith("retest-")) acc.push(`${target.label}/${item.dataId}(${item.group})`);
    }
  }
  return acc.sort();
}

/** 三个落点各自的 svc-* 条数，用来证明清扫没顺手删掉播种基线。 */
async function seededCounts(): Promise<Record<string, number>> {
  const acc: Record<string, number> = {};
  for (const target of sweepTargets()) {
    const items = await listConfigs(target.baseUrl, target.namespace);
    acc[target.label] = items.filter((i) => i.dataId.startsWith("svc-")).length;
  }
  return acc;
}

/**
 * 清扫的永久回归（AC8）：DK-04 只证明「起跑后服务端是干净的」，它证不出清扫真的删过东西——
 * 判据整体失效（比如前缀写错、DELETE 的 URL 拼错）时 DK-04 照样绿，尸体继续污染下一批，
 * 而这个兜底机制正是本轮省掉那一轮假红的全部理由。所以这里必须投进去再扫出来。
 */
test("DK-05 清扫真删得动: 投 2 条残留 → 扫 → 清掉且播种一条不少", async ({}) => {
  test.setTimeout(240_000);
  await republishRetestData();
  const seedBefore = await seededCounts();
  expect(Object.keys(seedBefore).sort(), "落点清单变了，DK-05 的对照失效").toEqual(["A/dev", "A/qa", "B/qa"]);

  await publishStray(BASE_A, NS_A, "retest-v44-stray-a.properties");
  await publishStray(BASE_B, NS_B, "retest-v44-stray-b.properties");
  // Nacos v1 写入最终一致：刚 POST 完立刻列可能看不见（新建条目先 404），轮询到出现为止
  const expected = [`A/dev/retest-v44-stray-a.properties(${GROUP})`, `B/qa/retest-v44-stray-b.properties(${GROUP})`].sort();
  await expect
    .poll(listStrays, { timeout: 30_000, message: "残留没出现在列表里：投放失败或落点清单不对" })
    .toEqual(expected);

  const { removed, failed } = await sweepRetestStrays("dk-05");
  console.log(`[DK-05] removed=${JSON.stringify(removed)} failed=${JSON.stringify(failed)}`);
  expect(failed, `清扫自己报失败：${JSON.stringify(failed)}`).toEqual([]);
  expect(removed.sort(), "清扫报清除的条数和投放的对不上").toEqual(expected);
  await expect
    .poll(listStrays, { timeout: 30_000, message: "清扫说删了但服务端还列得出来 = DELETE 没真落地" })
    .toEqual([]);

  const seedAfter = await seededCounts();
  expect(seedAfter, "播种数据少了 = 清扫判据越界删了 svc-*").toEqual(seedBefore);
});
