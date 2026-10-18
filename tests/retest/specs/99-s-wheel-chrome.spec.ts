// 轮33 F-34 真机复核：滚轮兜底（useWheelColumnResolver + useWheelSurface）在真实 DOM 上的落点归属。
//
// 探针口径（每条都一样，先把量法钉死再谈结论）：
//  1. 给 12 块监控滚动容器打标记（只看可见副本：keep-alive 的 *-cache 里还有一套隐藏 DOM）；
//  2. 每次量之前把所有标记容器的 scrollTop 拨回 0（prime），否则「已滚到底」会被误判成「没接管」；
//  3. 落点用 elementFromPoint 实测（列表滚动后 .browser-item 的 rect 会被 sticky 的 .browser-search 盖住，
//     按 rect 算出来的点其实压在 chrome 上）；
//  4. page.mouse.wheel(0, 120) 发真事件（CDP 走 Input.dispatchMouseEvent，deltaMode=0）；
//  5. 读每块容器的位移，外加 window 冒泡阶段看到的 defaultPrevented（兜底根在元素上，比 window 早）。
//
// 覆盖：F34-1 配置浏览（需求三件套 + 左右两列 chrome + 正文原生 + 编辑态 + 历史态）、
//       F34-2 差异对比单文件态、F34-3 匹配态与批量态（三块列各自命中自己列）、F34-6 来源面板底缘的 ⌄ 边条、
//       F34-4 变更计划（G1：宿主面板自己可滚时组件级根仍旧接管浮层）、
//       F34-5 新建配置弹框（G2：浮层在弹框里不再是纯死区）。
// 期望值全部来自 PRD 的 Acceptance Criteria；SKIP 只允许出现在「这块地方根本没有滚动余量」或
// 「当前态没有该元素」两种情形，且必须打 NOTE 说明。
import { expect, type Page } from "@playwright/test";
import { test } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog, setDiffSource, ensureSourcesPanelExpanded } from "./ui";
import { loadRetestState } from "../state";

const state = loadRetestState();
const NS_A = state.nacos.a.namespace;
const NS_B = state.nacos.b.namespace;
const GROUP = "RETEST-PROD";

/** 一格滚轮的像素量：Chromium 的 mouse.wheel 走 deltaMode=0，120 就是 120px。 */
const WHEEL_STEP = 120;
/** 低于这个余量就没法判断「到底滚了没有」，直接 SKIP 并打 NOTE。 */
const MIN_ROOM = 100;

interface SurfaceDef {
  name: string;
  sel: string;
  /** 同一选择器有多个可见实例时取第 n 个（匹配态左右两列同 class）。 */
  nth?: number;
}

/** 12 块监控滚动容器：4 块兜底靶面 + 4 块列表面 + 4 块「现有滚动语义不许被动过」的原生区。 */
const SURFACES: SurfaceDef[] = [
  { name: "browser-items", sel: ".browser-items" },
  { name: "code-area", sel: ".code-area" },
  { name: "editor-ta", sel: ".code-editor-ta" },
  { name: "diff-body", sel: ".diff-body" },
  { name: "match-left", sel: ".match-side-scroll", nth: 0 },
  { name: "match-right", sel: ".match-side-scroll", nth: 1 },
  { name: "batch-nav", sel: ".batch-diff-nav-scroll" },
  { name: "apply-detail", sel: ".apply-detail" },
  { name: "apply-list", sel: ".apply-item-list" },
  { name: "modal-body", sel: ".modal-body" },
  { name: "sel-menu", sel: ".sel-menu, .sel-menu-portal" },
  { name: "message-list", sel: ".message-list" },
];

interface Probe {
  /** 打印用名字。 */
  tag: string;
  /** chrome 落点的选择器（按可见实例取第 nth 个）。 */
  sel: string;
  nth?: number;
  /** 相对该元素左上角的落点偏移，默认水平中心 + 垂直中心。 */
  offset?: [number, number];
  /** 期望被滚动的靶面（按登记序，并列时取先登记的那块）。空数组 = 谁都不许动。 */
  expect?: string[];
  /** 额外允许跟着动的容器（原生滚动语义区，如落在 .sel-menu 自己身上时）。 */
  allow?: string[];
  /** true = 这一格必须整个交还原生：defaultPrevented 为 false，但 expect 仍要自己滚起来。 */
  native?: boolean;
  /** 该态下这个元素可能不存在（无失败项 / 无分页条），缺失时记 SKIP 而不是 FAIL。 */
  optional?: boolean;
}

interface ProbePoint {
  ok: boolean;
  x?: number;
  y?: number;
  /** 落点命中链（elementFromPoint 往上 8 层），用来核对「这一下真的压在 chrome 上」。 */
  chain?: string[];
  /** 命中节点是否落在目标元素子树内（sticky 覆盖会把它变成 false）。 */
  hitInTarget?: boolean;
  /** 落点祖先链里第一个可滚容器（硬闸门的现场读数）。 */
  gate?: string;
  rooms?: Record<string, number>;
}

const label = (el: Element): string => {
  const h = el as HTMLElement;
  const cls = (h.className || "").toString().trim().split(/\s+/).slice(0, 3).join(".");
  return `${el.tagName.toLowerCase()}${cls ? "." + cls : ""}`;
};

/** 页面侧：给可见的监控容器打标记，并顺手把不可见副本排除在测量之外。 */
async function markSurfaces(page: Page): Promise<string[]> {
  return page.evaluate((defs) => {
    const visible = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el as HTMLElement).visibility !== "hidden";
    };
    document.querySelectorAll("[data-wheel-probe]").forEach((el) => el.removeAttribute("data-wheel-probe"));
    const marked: string[] = [];
    for (const d of defs) {
      const list = Array.from(document.querySelectorAll(d.sel)).filter(visible);
      const node = d.nth == null ? list[0] : list[d.nth];
      if (node) {
        node.setAttribute("data-wheel-probe", d.name);
        marked.push(d.name);
      }
    }
    return marked;
  }, SURFACES);
}

const readOffsets = (page: Page) =>
  page.evaluate(() => {
    const out: Record<string, number> = {};
    document.querySelectorAll<HTMLElement>("[data-wheel-probe]").forEach((el) => {
      out[el.getAttribute("data-wheel-probe") as string] = el.scrollTop;
    });
    return out;
  });

/** 量之前全部归零：容器停在底部时兜底写完偏移也读不出变化（夹界在 scrollHeight-clientHeight）。 */
async function prime(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll<HTMLElement>("[data-wheel-probe]").forEach((el) => {
      el.scrollTop = 0;
    });
  });
  await page.waitForTimeout(120);
}

/** window 冒泡阶段记录最后一格滚轮的 defaultPrevented（兜底根上的监听比 window 早，读得到结果）。 */
async function installWheelSpy(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __wheelSpy?: { prevented: boolean; deltaY: number; deltaMode: number }[] };
    if (w.__wheelSpy) return;
    w.__wheelSpy = [];
    window.addEventListener("wheel", (event) => {
      w.__wheelSpy!.push({ prevented: event.defaultPrevented, deltaY: event.deltaY, deltaMode: event.deltaMode });
      if (w.__wheelSpy!.length > 40) w.__wheelSpy!.shift();
    });
  });
}

const lastSpy = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __wheelSpy?: { prevented: boolean; deltaY: number; deltaMode: number }[] };
    const events = w.__wheelSpy ?? [];
    return events.length ? events[events.length - 1] : null;
  });

async function resolvePoint(page: Page, probe: Probe): Promise<ProbePoint> {
  return page.evaluate(
    ({ sel, nth, offset, defs }) => {
      const visible = (el: Element) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el as HTMLElement).visibility !== "hidden";
      };
      const scrollable = (el: Element | null): el is HTMLElement => {
        if (!(el instanceof HTMLElement)) return false;
        if (el.scrollHeight - el.clientHeight <= 1) return false;
        const oy = getComputedStyle(el).overflowY;
        return oy === "auto" || oy === "scroll" || oy === "overlay";
      };
      const labelOf = (el: Element) => {
        const cls = (el as HTMLElement).className?.toString().trim().split(/\s+/).slice(0, 3).join(".") ?? "";
        return `${el.tagName.toLowerCase()}${cls ? "." + cls : ""}`;
      };
      const list = Array.from(document.querySelectorAll(sel)).filter(visible);
      const target = nth == null ? list[0] : list[nth];
      const rooms: Record<string, number> = {};
      document.querySelectorAll<HTMLElement>("[data-wheel-probe]").forEach((el) => {
        rooms[el.getAttribute("data-wheel-probe") as string] = el.scrollHeight - el.clientHeight;
      });
      if (!target) return { ok: false, rooms };
      const rect = target.getBoundingClientRect();
      // 负偏移 = 从右/下边缘往回量：chrome 条真正「什么都没有」的那块空隙一般在右下角
      const x = Math.round(offset ? (offset[0] < 0 ? rect.right + offset[0] : rect.left + offset[0]) : rect.left + rect.width / 2);
      const y = Math.round(offset ? (offset[1] < 0 ? rect.bottom + offset[1] : rect.top + offset[1]) : rect.top + rect.height / 2);
      const hit = document.elementFromPoint(x, y);
      const chain: string[] = [];
      let cur: Element | null = hit;
      let gate = "none";
      while (cur && chain.length < 8) {
        chain.push(labelOf(cur));
        if (gate === "none" && scrollable(cur)) gate = labelOf(cur);
        cur = cur.parentElement;
      }
      void defs;
      return { ok: !!hit, x, y, chain, hitInTarget: !!hit && (target.contains(hit) || hit === target), gate, rooms };
    },
    { sel: probe.sel, nth: probe.nth, offset: probe.offset ?? null, defs: SURFACES }
  );
}

/**
 * 跑一条探针并当场判定。
 *
 * 判定规则（钉的是机制，不是某个 class）：
 * - 兜底（native=false）：必须 defaultPrevented=true，且 expect 里至少一块的位移 == min(120, 余量)；
 * - 原生（native=true）：必须 defaultPrevented=false，且 expect 里那块自己滚起来了；
 * - expect 为空：谁都不许动 + 不取消默认动作（`.page-header`、黑名单子树都是这一支）；
 * - expect/allow 之外的容器一律不许动 —— 「不跨列」与「抢外层面板」都由这条抓住。
 */
async function runProbe(page: Page, probe: Probe, failures: string[]): Promise<void> {
  const expect = probe.expect ?? [];
  const allow = probe.allow ?? [];
  await markSurfaces(page);
  const point = await resolvePoint(page, probe);
  if (!point.ok || point.x == null || point.y == null) {
    const line = `| ${probe.optional ? "SKIP" : "FAIL"} | ${probe.tag} | 落点元素不存在或不可见：${probe.sel} |`;
    console.log(line);
    if (!probe.optional) failures.push(probe.tag + ": 落点元素不存在");
    return;
  }
  const room = Math.max(0, ...expect.map((n) => point.rooms?.[n] ?? 0));
  if (expect.length > 0 && room < MIN_ROOM) {
    console.log(`| SKIP | ${probe.tag} | NOTE expect=${expect.join("/")} 无滚动余量 room=${Math.round(room)} |`);
    return;
  }

  await prime(page);
  await page.mouse.move(point.x, point.y);
  await page.waitForTimeout(80);
  const before = await readOffsets(page);
  await page.mouse.wheel(0, WHEEL_STEP);
  await page.waitForTimeout(260);
  const after = await readOffsets(page);
  const spy = await lastSpy(page);

  const deltas: Record<string, number> = {};
  for (const name of Object.keys(after)) deltas[name] = Math.round((after[name] ?? 0) - (before[name] ?? 0));
  const moved = Object.entries(deltas).filter(([, d]) => d !== 0);
  const wantDelta = Math.min(WHEEL_STEP, room);
  const hitExpected = expect.some((n) => Math.abs((deltas[n] ?? 0) - wantDelta) <= (probe.native ? Math.max(1, wantDelta) : 2));
  const offenders = moved.filter(([n]) => !expect.includes(n) && !allow.includes(n));

  const problems: string[] = [];
  if (expect.length === 0) {
    if (moved.length > 0) problems.push(`谁都不许动，却动了 ${offenders.map(([n, d]) => `${n}:${d}`).join(",")}`);
    if (spy?.prevented) problems.push("不该取消默认动作却取消了（原生被抢）");
  } else if (!hitExpected) {
    problems.push(
      `expect=${expect.join("/")} 没按预期滚动，位移=${expect.map((n) => `${n}:${deltas[n] ?? 0}`).join(",")}（应为 ${wantDelta}）`
    );
  }
  if (offenders.length > 0 && expect.length > 0) {
    problems.push(`动到了不该动的 ${offenders.map(([n, d]) => `${n}:${d}`).join(",")}`);
  }
  if (spy && spy.deltaMode !== 0) problems.push(`deltaMode=${spy.deltaMode}：探针发的应该是像素档`);
  if (probe.native && spy?.prevented) problems.push("这一格必须整个交还原生，但 defaultPrevented=true");
  if (!probe.native && expect.length > 0 && spy && !spy.prevented) problems.push("兜底接管了却没取消默认动作：外层会跟着一起滚");

  const status = problems.length === 0 ? "OK" : "FAIL";
  const summary = Object.entries(deltas)
    .filter(([, d]) => d !== 0)
    .map(([n, d]) => `${n}:${d > 0 ? "+" : ""}${d}`)
    .join(" ");
  console.log(
    `| ${status} | ${probe.tag} | landed=${(point.chain ?? [])[0] ?? "-"} gate=${point.gate} prevented=${
      spy ? String(spy.prevented) : "-"
    } expect=${expect.join("/") || "none"}${probe.native ? "(native)" : ""} moved=${summary || "none"}${
      point.hitInTarget ? "" : " NOTE 落点压在目标之外"
    }${problems.length ? " -> " + problems.join(" ; ") : ""} |`
  );
  for (const p of problems) failures.push(`${probe.tag}: ${p}`);
}

async function bootstrap(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await installWheelSpy(page);
}

const visible = (page: Page, sel: string) => page.locator(sel).filter({ visible: true });

/** 打开一条真实存在的配置（svc-legacy-prod.yaml：353 行、17KB，正文与左列都有滚动余量）。 */
async function openBrowseWithConfig(page: Page): Promise<void> {
  await navigate(page, "配置浏览");
  await expect(visible(page, ".browser-item").first()).toBeVisible({ timeout: 30_000 });
  await visible(page, ".browser-item-id").filter({ hasText: "svc-legacy-prod.yaml" }).first().click();
  await expect(visible(page, ".code-area").first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(400);
}

/** 批量对比两侧同 group，进入匹配态（左列/右列两张列表 + 匹配计数条）。 */
async function enterMatchState(page: Page): Promise<void> {
  await navigate(page, "配置对比");
  await page.waitForTimeout(500);
  await setDiffSource(page, "left", { connection: "Retest Nacos A", namespace: NS_A, group: GROUP });
  await setDiffSource(page, "right", { connection: "Retest Nacos B", namespace: NS_B, group: GROUP });
  await page.getByRole("button", { name: "加载并对比" }).last().click();
  await expect(visible(page, ".match-list").first()).toBeVisible({ timeout: 30_000 });
}

/** 匹配态 → 全选 → 对比选中 → 批量结果视图（左文件列表 + 右差异正文）。 */
async function enterBatchState(page: Page): Promise<void> {
  await page.locator(".match-toggle-all input").check();
  await page
    .getByRole("button", { name: /对比选中/ })
    .last()
    .click();
  await expect(visible(page, ".batch-diff-nav-item").first()).toBeVisible({ timeout: 60_000 });
}

test.beforeEach(async () => {
  // retest Nacos 容器提供真数据（bridge 只 mock Wails，Nacos 方法是真打）
  expect(state.nacos.a.baseUrl, "retest Nacos A 必须起在 19848").toBeTruthy();
});

test("F34-1 配置浏览：行号+缩略图+Ctrl+F 就地搜索，两列 chrome 各归各列，正文与 page-header 不动", async ({ page, retest }) => {
  await installRetestBridge(page, retest);
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootstrap(page);
  const failures: string[] = [];

  await openBrowseWithConfig(page);

  // ── 需求 1：行号 + 命中行高亮；需求 3：Ctrl+F 直接在此文件开始搜索 ──
  expect(await visible(page, ".code-gutter .code-ln").count(), "右侧代码容器必须有行号").toBeGreaterThan(0);
  await expect(visible(page, ".code-minimap").first()).toBeVisible({ timeout: 10_000 });
  // 指针先落在这个文件上（真人是看着正文按 Ctrl+F；焦点还留在列表行上时查找快捷键让给焦点）
  await visible(page, ".code-area")
    .first()
    .click({ position: { x: 40, y: 40 } });
  await page.waitForTimeout(150);
  await page.keyboard.press("Control+f");
  const findInput = visible(page, ".code-find-input").first();
  await expect(findInput).toBeVisible({ timeout: 10_000 });
  await findInput.fill("module");
  // 命中词有 debounce，等首枚 mark 出现再数
  await expect(visible(page, "mark.search-hit").first()).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(400);
  expect(await visible(page, "mark.search-hit").count(), "搜索内容必须标红").toBeGreaterThan(0);
  expect(await visible(page, "mark.search-hit-current").count(), "当前命中只许有一处").toBe(1);
  expect(await visible(page, ".code-line.is-current").count(), "命中所在行必须高亮").toBe(1);
  expect(await visible(page, ".code-ln.is-current").count(), "行号所在行要跟着高亮").toBe(1);

  // ── 需求 2：右侧缩略图（CodeMinimap 自己不许抢滚轮，滚它下面那块正文） ──
  // 查找栏还开着：先量条子本身与计数区，再关掉量缩略图与浮标
  await runProbe(page, { tag: "配置浏览 .code-find（查找条）", sel: ".code-find", offset: [420, 10], expect: ["code-area"] }, failures);
  await runProbe(
    page,
    { tag: "配置浏览 .code-find-count（命中计数）", sel: ".code-find-count", offset: [4, 6], expect: ["code-area"] },
    failures
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  await runProbe(page, { tag: "配置浏览 .code-find-open（⌕ 浮标）", sel: ".code-find-open", expect: ["code-area"] }, failures);
  await runProbe(
    page,
    { tag: "配置浏览 .code-minimap（缩略图）", sel: ".code-minimap", offset: [8, 120], expect: ["code-area"] },
    failures
  );
  await runProbe(
    page,
    { tag: "配置浏览 .detail-header（详情头）", sel: ".detail-header", offset: [120, 8], expect: ["code-area"] },
    failures
  );

  // ── 左列 chrome：滚左列列表，不许跨列去滚正文（900 高时 13 条没有余量，压到 700 造余量） ──
  await page.setViewportSize({ width: 1440, height: 700 });
  await page.waitForTimeout(400);
  await runProbe(
    page,
    { tag: "配置浏览 .browser-search-mode（搜索模式开关）", sel: ".browser-search-mode", offset: [-14, 6], expect: ["browser-items"] },
    failures
  );
  await runProbe(
    page,
    { tag: "配置浏览 .browser-search 空隙", sel: ".browser-search", offset: [-12, -8], expect: ["browser-items"] },
    failures
  );
  await runProbe(
    page,
    { tag: "配置浏览 .browser-count（计数条）", sel: ".browser-count", offset: [40, 8], expect: ["browser-items"] },
    failures
  );
  // 分页条：PAGE_SIZE=50 且只有 13 条时这一态根本不渲染，optional 记 SKIP
  await runProbe(
    page,
    { tag: "配置浏览 .pager（分页条）", sel: ".pager", offset: [40, 6], expect: ["browser-items"], optional: true },
    failures
  );
  // 正文本体归原生：caret / 选区 / 惯性都不许被兜底改写
  await runProbe(
    page,
    { tag: "配置浏览 .browser-item（原生滚左列）", sel: ".browser-item", nth: 2, expect: ["browser-items"], native: true },
    failures
  );

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(400);

  // ── 硬闸门③：page-header 在 .browser 外面，一格都不许动，也不许取消默认动作 ──
  await runProbe(page, { tag: "配置浏览 .page-header（不接）", sel: ".page-header", offset: [300, 8] }, failures);
  await runProbe(
    page,
    { tag: "配置浏览 .code-area 正文（原生）", sel: ".code-area", offset: [400, 300], expect: ["code-area"], native: true },
    failures
  );

  // ── 编辑态：CodeEditor 的组件级根，chrome 条滚 textarea ──
  await page.getByRole("button", { name: "编辑" }).first().click();
  await expect(visible(page, ".code-editor-ta").first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(400);
  await runProbe(page, { tag: "配置浏览编辑态 .fmt-bar", sel: ".fmt-bar", offset: [-260, -8], expect: ["editor-ta"] }, failures);
  await runProbe(page, { tag: "配置浏览编辑态 .code-find-open", sel: ".code-find-open", expect: ["editor-ta"] }, failures);
  await page.getByRole("button", { name: "取消" }).first().click();
  await page.waitForTimeout(400);

  // ── 历史态：勾历史 tab → 点首条版本 → 切「原始内容」→ CodeView 的浮层滚正文 ──
  await page.locator(".detail-tabs .tab-btn", { hasText: "历史变更" }).first().click();
  await expect(visible(page, ".history-items").first()).toBeVisible({ timeout: 20_000 });
  await visible(page, ".history-item-main").first().click();
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "原始内容" }).first().click();
  await expect(visible(page, ".code-area").first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(400);
  await runProbe(
    page,
    { tag: "配置浏览历史态 .content-box-head", sel: ".content-box-head", offset: [60, 8], expect: ["code-area"] },
    failures
  );
  await runProbe(page, { tag: "配置浏览历史态 .code-find-open", sel: ".code-find-open", expect: ["code-area"] }, failures);
  await runProbe(page, { tag: "配置浏览历史态 .code-minimap", sel: ".code-minimap", offset: [8, 120], expect: ["code-area"] }, failures);

  expect(failures, "真机复核未通过项:\n" + failures.join("\n")).toEqual([]);
});

test("F34-2 差异对比单文件态：stats/head 滚 diff-body，正文与下拉黑名单照旧归原生", async ({ page, retest }) => {
  await installRetestBridge(page, retest);
  await republishRetestData();
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootstrap(page);
  const failures: string[] = [];

  await navigate(page, "配置对比");
  await page.waitForTimeout(500);
  await setDiffSource(page, "left", {
    connection: "Retest Nacos A",
    namespace: NS_A,
    group: GROUP,
    dataId: "svc-gateway.yaml",
  });
  await setDiffSource(page, "right", {
    connection: "Retest Nacos B",
    namespace: NS_B,
    group: GROUP,
    dataId: "svc-gateway.yaml",
  });
  await page.getByRole("button", { name: "加载并对比" }).last().click();
  await expect(visible(page, ".diff-body").first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(500);
  expect(await visible(page, ".diff-row").count(), "两侧必须真有差异行").toBeGreaterThan(4);

  await runProbe(page, { tag: "单文件对比 .diff-stats", sel: ".diff-stats", offset: [40, 8], expect: ["diff-body"] }, failures);
  await runProbe(page, { tag: "单文件对比 .diff-head-cell", sel: ".diff-head-cell", offset: [40, 8], expect: ["diff-body"] }, failures);
  await runProbe(page, { tag: "单文件对比 .page-header.diff-header", sel: ".page-header.diff-header", offset: [300, 8] }, failures);
  await runProbe(
    page,
    { tag: "单文件对比 .diff-body .diff-row（原生）", sel: ".diff-body .diff-row", nth: 8, expect: ["diff-body"], native: true },
    failures
  );

  // 黑名单按 DOM 子树：展开来源面板 → 打开一个下拉 → 滚轮压在 .sel-menu 上，兜底一律不接
  await ensureSourcesPanelExpanded(page);
  const trigger = visible(page, ".source-picker .sel-trigger").first();
  await expect(trigger).toBeVisible({ timeout: 10_000 });
  await trigger.click({ force: true });
  await page.waitForTimeout(350);
  if (await visible(page, ".sel-menu, .sel-menu-portal").count()) {
    await runProbe(
      page,
      {
        tag: "单文件对比 .sel-menu（黑名单子树）",
        sel: ".sel-menu, .sel-menu-portal",
        offset: [120, 30],
        allow: ["sel-menu"],
      },
      failures
    );
  } else {
    console.log("| SKIP | 单文件对比 .sel-menu（黑名单子树） | NOTE 该态没开出下拉 |");
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  expect(failures, "真机复核未通过项:\n" + failures.join("\n")).toEqual([]);
});

test("F34-3 匹配态与批量态：三块列各自命中自己列，互不抢，列表项本体归原生", async ({ page, retest }) => {
  await installRetestBridge(page, retest);
  await republishRetestData();
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootstrap(page);
  const failures: string[] = [];

  await enterMatchState(page);
  await page.waitForTimeout(400);
  await runProbe(page, { tag: "匹配态 .match-list-head", sel: ".match-list-head", offset: [40, 8], expect: ["match-left"] }, failures);
  await runProbe(
    page,
    { tag: "匹配态 .match-side-title 左列", sel: ".match-side-title", nth: 0, offset: [40, 8], expect: ["match-left"] },
    failures
  );
  await runProbe(
    page,
    { tag: "匹配态 .match-side-title 右列", sel: ".match-side-title", nth: 1, offset: [40, 8], expect: ["match-right"] },
    failures
  );

  await enterBatchState(page);
  await page.waitForTimeout(600);
  await runProbe(
    page,
    { tag: "批量态 .batch-diff-nav-head", sel: ".batch-diff-nav-head", offset: [40, 8], expect: ["batch-nav"] },
    failures
  );
  await runProbe(
    page,
    { tag: "批量态 .batch-diff-main-head", sel: ".batch-diff-main-head", offset: [120, 8], expect: ["diff-body"] },
    failures
  );
  await runProbe(
    page,
    { tag: "批量态 .batch-diff-nav-item（原生滚文件列表）", sel: ".batch-diff-nav-item", nth: 3, expect: ["batch-nav"], native: true },
    failures
  );
  await runProbe(
    page,
    {
      tag: "批量态 .batch-diff-failures-head",
      sel: ".batch-diff-failures-head",
      offset: [60, 8],
      expect: ["batch-nav"],
      optional: true,
    },
    failures
  );

  expect(failures, "真机复核未通过项:\n" + failures.join("\n")).toEqual([]);
});

test("F34-4 变更计划：宿主面板自己可滚时，代码浮层仍旧滚正文（G1）", async ({ page, retest }) => {
  await installRetestBridge(page, retest);
  await republishRetestData();
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootstrap(page);
  const failures: string[] = [];

  await enterMatchState(page);
  await enterBatchState(page);
  await page.waitForTimeout(400);
  await visible(page, ".batch-diff-nav-item").filter({ hasText: "svc-gateway.yaml" }).first().click();
  await expect(visible(page, ".diff-body").first()).toBeVisible({ timeout: 30_000 });
  await page
    .getByRole("button", { name: /进入配置变更计划（\d+ 个文件）/ })
    .first()
    .click();
  await expect(visible(page, ".apply-ledger").first()).toBeVisible({ timeout: 30_000 });
  await expect(visible(page, ".apply-item-list").first()).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(400);

  // 计划页自己没有兜底根（本轮定案：不加，避免第 5 个根），这两块 chrome 本来就压在可滚列表/面板上 ⇒ 原生
  await runProbe(
    page,
    {
      tag: "计划页 .apply-item-toolbar（sticky 在可滚列表里）",
      sel: ".apply-item-toolbar",
      // 左列只有 300 出头，正偏移 320 会越过列边界落到 .apply-detail 上（上一轮就是这条 NOTE）；
      // 改成落在工具条自己的左侧空隙。
      offset: [10, 6],
      expect: ["apply-list"],
      native: true,
    },
    failures
  );
  // 计划页没有兜底根（本轮定案：不加，避免第 5 个根）⇒ 这些落点一律不许被 preventDefault。
  // .apply-detail 在该态常常没有溢出，读不出原生位移，所以 expect 留空、只钉「没被劫持」：
  // 有溢出时它跟着原生滚动算合规（allow），没有溢出时谁都不动也算合规。
  await runProbe(
    page,
    {
      tag: "计划页 .apply-dryrun-note（DiffPanel chrome，不许被抢）",
      sel: ".apply-dryrun-note",
      offset: [120, 6],
      expect: [],
      allow: ["apply-detail"],
      native: true,
    },
    failures
  );
  await runProbe(
    page,
    {
      tag: "计划页 .apply-detail-head（详情头，不许被抢）",
      sel: ".apply-detail-head",
      offset: [120, 8],
      expect: [],
      allow: ["apply-detail"],
      native: true,
    },
    failures
  );

  // 编辑目标内容：CodeEditor 的组件级根开了 localPriority ⇒ 浮层滚 textarea，不越权去滚宿主面板
  await page.getByRole("button", { name: "编辑目标内容" }).first().click();
  await expect(visible(page, ".apply-edit-editor .code-editor").first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(500);
  expect(await visible(page, ".code-editor").count(), "变更计划页需要出现 CodeEditor 才能验证 G1").toBeGreaterThan(0);
  await runProbe(
    page,
    { tag: "计划页 CodeEditor .code-find-open（G1）", sel: ".code-editor .code-find-open", expect: ["editor-ta"] },
    failures
  );
  await visible(page, ".code-editor .code-find-open").first().click();
  await page.waitForTimeout(300);
  await runProbe(
    page,
    { tag: "计划页 CodeEditor .code-find（G1）", sel: ".code-editor .code-find", offset: [400, 8], expect: ["editor-ta"] },
    failures
  );

  expect(failures, "真机复核未通过项:\n" + failures.join("\n")).toEqual([]);
});

test("F34-5 新建配置弹框：浮层在弹框里不再是纯死区（G2）", async ({ page, retest }) => {
  await installRetestBridge(page, retest);
  await republishRetestData();
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootstrap(page);
  const failures: string[] = [];

  await navigate(page, "配置浏览");
  await expect(visible(page, ".browser-item").first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "新建配置" }).first().click();
  await expect(visible(page, ".modal-overlay .modal-body").first()).toBeVisible({ timeout: 20_000 });
  await expect(visible(page, ".code-editor-ta").first()).toBeVisible({ timeout: 10_000 });

  // 给正文灌够行数，textarea 与 .modal-body 都真的有滚动余量（否则「谁被滚了」读不出来）
  const long = Array.from({ length: 80 }, (_, i) => `row${i}: timeout-${i}`).join("\n");
  await visible(page, ".code-editor-ta").first().fill(long);
  await page.waitForTimeout(600);

  // 弹框自己的标题条：黑名单子树 ⇒ 一格都不许动（弹框后面那块 chrome 被顺带滚走更糟）
  await runProbe(page, { tag: "新建配置弹框 .modal-header（黑名单）", sel: ".modal-overlay .modal-header", offset: [120, 10] }, failures);
  // 压在 textarea 上的查找浮标：为这块正文存在的覆盖层 ⇒ 归正文，且不许越权滚弹框正文区
  await runProbe(
    page,
    { tag: "新建配置弹框 .code-find-open（G2）", sel: ".modal-overlay .code-editor .code-find-open", expect: ["editor-ta"] },
    failures
  );
  await visible(page, ".modal-overlay .code-editor .code-find-open").first().click();
  const findInput = visible(page, ".modal-overlay .code-find-input").first();
  await expect(findInput).toBeVisible({ timeout: 10_000 });
  await runProbe(
    page,
    { tag: "新建配置弹框 .code-find（G2）", sel: ".modal-overlay .code-find", offset: [420, 10], expect: ["editor-ta"] },
    failures
  );
  await findInput.fill("timeout");
  await expect(visible(page, "mark.search-hit").first()).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(400);
  expect(await visible(page, "mark.search-hit").count(), "弹框里的编辑器同样要标红命中").toBeGreaterThan(0);
  // 两次 Escape 各有分工，钉的是「查找条的 Esc 不会顺手把整个草稿关掉」：
  // 第一下只关查找条（逃逸岛优先），第二下才走到弹框的 attemptClose —— 内容有改动 ⇒ 弹确认，不静默丢弃。
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  expect(await visible(page, ".modal-overlay .code-find").count(), "第一下 Escape 只关查找条").toBe(0);
  expect(await visible(page, ".modal-overlay").count(), "关完查找条，草稿弹框必须还在").toBe(1);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(350);
  await expect(visible(page, ".modal-overlay").filter({ hasText: "放弃未发布的内容" }).first()).toBeVisible({
    timeout: 10_000,
  });
  await page.getByRole("button", { name: "放弃内容" }).last().click();
  await page.waitForTimeout(400);
  expect(await visible(page, ".modal-overlay").count(), "确认放弃后两层弹层都该收起").toBe(0);

  expect(failures, "真机复核未通过项:\n" + failures.join("\n")).toEqual([]);
});

test("F34-6 单文件对比来源面板底缘的 ⌄ 边条：两态都归正文，且点它仍能收起/展开", async ({ page, retest }) => {
  await installRetestBridge(page, retest);
  await republishRetestData();
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootstrap(page);
  const failures: string[] = [];

  await navigate(page, "配置对比");
  await page.waitForTimeout(500);
  await setDiffSource(page, "left", {
    connection: "Retest Nacos A",
    namespace: NS_A,
    group: GROUP,
    dataId: "svc-gateway.yaml",
  });
  await setDiffSource(page, "right", {
    connection: "Retest Nacos B",
    namespace: NS_B,
    group: GROUP,
    dataId: "svc-gateway.yaml",
  });
  await page.getByRole("button", { name: "加载并对比" }).last().click();
  await expect(visible(page, ".diff-body").first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(500);
  expect(await visible(page, ".diff-row").count(), "两侧必须真有差异行").toBeGreaterThan(4);

  // 边条是 absolute; bottom:-9px 的一条 36x18，落在 .diff-source-panel 的下边缘外，
  // 旧口径按 class 匹配（.diff-source-panel）它不在面板内、判成死区；A 按几何：整块压着它才接管。
  await ensureSourcesPanelExpanded(page);
  await runProbe(
    page,
    { tag: "来源边条 .diff-source-toggle-edge（展开态）", sel: ".diff-source-toggle-edge", expect: ["diff-body"] },
    failures
  );
  await runProbe(
    page,
    { tag: "来源面板底缘缝隙 .diff-source-panel", sel: ".diff-source-panel", offset: [-30, -2], expect: ["diff-body"] },
    failures
  );

  // 收起态：面板只剩 summary 一行，正文余量变了，归属不许变
  await visible(page, ".diff-source-toggle-edge").first().click();
  await expect(visible(page, ".diff-source-panel.collapsed").first()).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(300);
  await runProbe(
    page,
    { tag: "来源边条 .diff-source-toggle-edge（收起态）", sel: ".diff-source-toggle-edge", expect: ["diff-body"] },
    failures
  );

  // 边条本身还是个按钮：滚轮归正文这件事不能把点击吞掉
  await visible(page, ".diff-source-toggle-edge").first().click();
  await expect(visible(page, ".diff-source-panel.collapsed").first()).toHaveCount(0, { timeout: 10_000 });

  expect(failures, "真机复核未通过项:\n" + failures.join("\n")).toEqual([]);
});
