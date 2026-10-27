// 轮102 永久回归：变更计划预览高度 / 浏览工具条裁字 / 空列表双空态 / 连接表单复选框排版。
//
// 为什么必须真机量（vitest 里跑不出这些结论）：
//   四条缺陷全是「盒模型算出来的结果」——flex 压缩到 0 高、nowrap + max-width 吃掉文字、
//   grid 第二列空转、column 方向把复选框顶到下一行。jsdom 不做布局，
//   getBoundingClientRect 恒为 0、scrollWidth/clientWidth 恒为 0，静态 grep 只看得到写法看不到渲染。
//   已有的两条真机普查也不覆盖：99-s-target-size 量盒尺寸、99-s-contrast 量前景背景、
//   99-s-textclip-census 只扫「文字节点」且按 CODE_SEL 跳过配置正文，工具条按钮的裁字在它的口径外。
//
// 判据（全部来自轮102 真机读数，tests/retest/results/r102/probe.json）：
//   D1 变更计划预览：6 档宽度（1440/1280/1024/900/860/780）下 .apply-diff-preview 高 >= 300、
//      .diff-body 高 > 0、解析警示条压在统计/表头/正文上的重叠面积恒为 0。
//      缺陷现场：<=900px 时 preview 与 body 都被压成 0 高，警示条与统计重叠 9860~11890 px²。
//   D2 两颗导出图标：aria-label 不同且 svg path 画法必须不同（缺陷现场两枚 d 完全相同）。
//   D3 浏览工具条：行内每颗按钮 scrollWidth - clientWidth <= 0，且行本身不横向出血。
//      缺陷现场「创建当前列表快照」1440 裁 3px / 860 裁 33px。
//   D4 空列表主从：零行时整个 split 里只能有 1 个可见 .data-empty-state，且 .data-detail 不可见。
//      缺陷现场任务中心与操作历史各命中 2 个空态、右栏占位照旧渲染。
//   D5 复选框排版：「默认来源」标签与方框同一行、方框在标签右侧。
//      缺陷现场标签 y=300 / 方框 y=321，左缘同为 x=1280（掉到下一行还左对齐）。
//
// 防假绿：__r102Controls 造 6 条对照屏，每条必须且只能落进它声明的那个桶——
//   「压扁的预览」「裁字的按钮」「双空态」「单空态(list-empty)」「同行复选框」「同画法图标」。
//   探针哪天悄悄失效（选择器改名、阈值被调、CSS 规则被删），红在这里，
//   而不是「全员 0」的漂亮数字。其中「单空态」那条直接吃 styles.css 的 .list-empty 规则：
//   规则被删，它就退回双空态并判红，不依赖真实数据能不能凑出空列表。
//
// tsc --noEmit 的 include 只覆盖 src + wailsjs，查不到 tests/，别拿它当探针类型凭据；
// 本文件只能靠真跑验证（npx playwright test -c tests/retest/playwright.config.ts 本文件）。
import { expect, test } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog, setDiffSource } from "./ui";
import { loadRetestState } from "../state";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(process.cwd(), "tests/retest/results/r102-layout");
const state = loadRetestState();
const NS_A = state.nacos.a.namespace;
const NS_B = state.nacos.b.namespace;
const GROUP = "RETEST-PROD";

/** 变更计划预览要踩到的宽度档：<=900 是缺陷区间，1024/1280/1440 是健康对照组。 */
const PLAN_WIDTHS = [1440, 1280, 1024, 900, 860, 780];
/** 浏览工具条的宽度档（侧栏随视口收窄，860 已经只剩 291px 行宽）。 */
const TOOLBAR_WIDTHS = [1440, 1024, 860];
/** 种子数据里恰有 2 个配置含该标记（与 95-content-replace 同一批），用来把「批量替换」按钮叫出来。 */
const FIND = "每季度复核";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Geom {
  vw: number;
  docOverflowX: number;
  preview: {
    preview: Rect | null;
    panel: Rect | null;
    body: Rect | null;
    stats: Rect | null;
    head: Rect | null;
    notes: number;
    ovlStatsPx: number;
    ovlHeadPx: number;
    ovlBodyPx: number;
  } | null;
  toolbar: {
    rowW: number;
    rowScrollW: number;
    rowLines: number;
    buttons: { text: string; clip: number; overflowRight: number }[];
    icons: { label: string; d: string }[];
    dupIconPath: boolean;
  } | null;
  empties: { splitW: number; listW: number; detailVisible: boolean; visibleEmptyStates: number; listEmptyClass: boolean } | null;
  check: { label: Rect | null; box: Rect | null; sameLine: boolean; boxRightOfLabel: boolean } | null;
}

const GEOM = String.raw`
function __r102Geom(scope) {
  var root = scope || document;
  var rect = function (el) {
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  // 两个盒的重叠面积：宽高都 >2px 才算压在一起（1px 的描边相接不是缺陷）。
  var inter = function (a, b) {
    if (!a || !b) return 0;
    var w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    var h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return w > 2 && h > 2 ? Math.round(w * h) : 0;
  };
  var shown = function (el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  var out = {
    vw: window.innerWidth,
    docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    preview: null, toolbar: null, empties: null, check: null
  };

  // D1：变更计划第 4 步的差异预览——面板高度 + 警示条压印
  var preview = root.querySelector ? root.querySelector('.apply-diff-preview') : null;
  if (preview) {
    var panel = preview.querySelector('.diff-panel');
    var body = preview.querySelector('.diff-body');
    var stats = preview.querySelector('.diff-stats');
    var head = preview.querySelector('.diff-head');
    var notes = Array.prototype.slice.call(root.querySelectorAll('.apply-parse-warning, .apply-parse-error'));
    var pa = rect(panel), ba = rect(body), sa = rect(stats), ha = rect(head);
    var ovlStats = 0, ovlHead = 0, ovlBody = 0;
    for (var i = 0; i < notes.length; i++) {
      var nr = rect(notes[i]);
      ovlStats += inter(nr, sa);
      ovlHead += inter(nr, ha);
      ovlBody += inter(nr, ba);
    }
    out.preview = {
      preview: rect(preview), panel: pa, body: ba, stats: sa, head: ha,
      notes: notes.length, ovlStatsPx: ovlStats, ovlHeadPx: ovlHead, ovlBodyPx: ovlBody
    };
  }

  // D3 + D2：浏览工具条——按钮裁字、行横向出血、导出图标是否同一画法
  var snap = root.querySelector ? root.querySelector('.snapshot-action-btn') : null;
  var row = root.querySelector ? root.querySelector('.browser-action-row') : null;
  if (snap || row) {
    var actionRow = row || (snap ? snap.closest('.browser-action-row') : null);
    var buttons = actionRow ? Array.prototype.slice.call(actionRow.querySelectorAll('button')) : [];
    var rowRect = actionRow ? actionRow.getBoundingClientRect() : null;
    var tops = {};
    var btns = buttons.map(function (b) {
      var br = b.getBoundingClientRect();
      tops[Math.round(br.top)] = 1;
      return {
        text: (b.textContent || '').trim().slice(0, 24),
        clip: b.scrollWidth - b.clientWidth,
        // R102: 越界量用「相对行右缘的净溢出」，再给 1px 亚像素容差（阈值 >1 判缺陷），
        // 否则按钮正好贴满行宽也会被四舍五入误报成出血 1px。
        overflowRight: rowRect ? Math.round(br.right - rowRect.right) : 0
      };
    });
    var icons = actionRow ? Array.prototype.slice.call(actionRow.querySelectorAll('.browser-icon-btn')).map(function (b) {
      var d = Array.prototype.slice.call(b.querySelectorAll('path')).map(function (p) { return p.getAttribute('d'); }).join('|');
      return { label: (b.getAttribute('aria-label') || b.title || '').trim(), d: d };
    }) : [];
    var seen = {}, dup = false;
    icons.forEach(function (ic) { if (seen[ic.d]) dup = true; seen[ic.d] = 1; });
    out.toolbar = {
      rowW: actionRow ? actionRow.clientWidth : 0,
      rowScrollW: actionRow ? actionRow.scrollWidth : 0,
      rowLines: Object.keys(tops).length,
      buttons: btns, icons: icons, dupIconPath: dup
    };
  }

  // D4：主从页空态——整个 split 里可见的空态数量 + 右栏是否还占位
  var split = root.querySelector ? root.querySelector('.data-split') : null;
  if (split) {
    var empties = Array.prototype.slice.call(split.querySelectorAll('.data-empty-state'));
    var visible = empties.filter(shown);
    var detail = split.querySelector('.data-detail');
    var list = split.querySelector('.data-list');
    out.empties = {
      splitW: Math.round(split.getBoundingClientRect().width),
      listW: Math.round((list || split).getBoundingClientRect().width),
      detailVisible: shown(detail),
      visibleEmptyStates: visible.length,
      listEmptyClass: split.classList.contains('list-empty')
    };
  }

  // D5：复选框与标签是否同一行
  var field = root.querySelector ? root.querySelector('label.field.check-field') : null;
  if (field) {
    var lb = field.querySelector('.field-label');
    var cb = field.querySelector('input[type="checkbox"]');
    var lbr = rect(lb), cbr = rect(cb);
    var sameLine = false, rightOf = false;
    if (lbr && cbr) {
      var lcy = lbr.y + lbr.h / 2, ccy = cbr.y + cbr.h / 2;
      sameLine = Math.abs(lcy - ccy) <= 8 && Math.abs(cbr.y - lbr.y) <= 12;
      rightOf = cbr.x >= lbr.x + lbr.w - 4;
    }
    out.check = { label: lbr, box: cbr, sameLine: sameLine, boxRightOfLabel: rightOf };
  }
  return out;
}
`;

/** 对照组：每条都复刻一个缺陷现场（或一个正确形态），断言探针必须照它声明的那样读数。 */
const CONTROLS = String.raw`
function __r102Controls() {
  var host = document.createElement('div');
  host.id = 'r102-controls';
  host.style.cssText = 'position:fixed;left:-9999px;top:0;width:0;height:0;overflow:visible;z-index:-1';
  var mk = function (id, css, html) {
    return '<div id="' + id + '" style="position:absolute;left:0;top:0;' + css + '">' + html + '</div>';
  };
  host.innerHTML =
    // ctl-preview：复刻「flex:1 + min-height:0 被压到 0 高、警示条压在统计上」
    mk('r102ctl-preview', 'width:600px;height:160px',
      '<div class="apply-diff-preview" style="position:relative;min-height:0;height:0;flex:1 1 auto">' +
        '<div class="diff-stats" style="position:absolute;left:0;top:0;width:600px;height:34px"></div>' +
        '<div class="diff-panel" style="position:absolute;left:0;top:34px;width:600px;height:0">' +
          '<div class="diff-head" style="position:absolute;left:0;top:0;width:600px;height:29px"></div>' +
          '<div class="diff-body" style="position:absolute;left:0;top:29px;width:600px;height:0"></div>' +
        '</div>' +
      '</div>' +
      '<div class="apply-parse-warning" style="position:absolute;left:0;top:5px;width:600px;height:30px">w</div>') +
    // ctl-toolbar：复刻旧 CSS 的 max-width + ellipsis 裁字，以及两枚同画法图标
    mk('r102ctl-toolbar', 'width:200px',
      '<div class="browser-action-row" style="display:flex;gap:6px;width:200px">' +
        '<button class="btn btn-sm snapshot-action-btn" style="flex:0 1 auto;max-width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">创建当前列表快照</button>' +
        '<button class="btn btn-ghost btn-sm browser-icon-btn" aria-label="甲"><svg viewBox="0 0 24 24"><path d="M1 1h2"/></svg></button>' +
        '<button class="btn btn-ghost btn-sm browser-icon-btn" aria-label="乙"><svg viewBox="0 0 24 24"><path d="M1 1h2"/></svg></button>' +
      '</div>') +
    // ctl-empty-two：没有 list-empty 类 ⇒ 双空态并存（缺陷形态，探针必须读出 2）
    mk('r102ctl-empty-two', 'width:600px',
      '<div class="data-split">' +
        '<div class="data-list"><div class="data-empty-state"><div>暂无任务</div><span>提示</span></div></div>' +
        '<div class="data-detail"><div class="data-empty-state detail-empty"><div>选择一个任务</div><span>提示</span></div></div>' +
      '</div>') +
    // ctl-empty-one：带 list-empty 类 ⇒ styles.css 必须收单列并摘掉右栏（探针必须读出 1 + 右栏不可见）
    mk('r102ctl-empty-one', 'width:600px',
      '<div class="data-split list-empty">' +
        '<div class="data-list"><div class="data-empty-state"><div>暂无任务</div><span>提示</span></div></div>' +
        '<div class="data-detail"><div class="data-empty-state detail-empty"><div>选择一个任务</div><span>提示</span></div></div>' +
      '</div>') +
    // ctl-check：规则的真实用户，必须与连接表单同一次行排版
    mk('r102ctl-check', 'width:600px',
      '<div class="field-row">' +
        '<label class="field"><span class="field-label"><span>配置名称</span></span><input class="search-input" type="text"></label>' +
        '<label class="field check-field"><span class="field-label"><span>默认来源</span></span><input type="checkbox"></label>' +
      '</div>') +
    // ctl-check-bad：显式退回竖排（缺陷形态），证明探针真的能判红，不是恒绿
    mk('r102ctl-check-bad', 'width:600px',
      '<div class="field-row">' +
        '<label class="field check-field" style="flex-direction:column;align-items:flex-start">' +
          '<span class="field-label"><span>默认来源</span></span><input type="checkbox">' +
        '</label>' +
      '</div>');
  document.body.appendChild(host);
  var ids = ['r102ctl-preview', 'r102ctl-toolbar', 'r102ctl-empty-two', 'r102ctl-empty-one', 'r102ctl-check', 'r102ctl-check-bad'];
  return ids.map(function (id) { return { id: id, node: document.getElementById(id) }; });
}
`;

async function geom(page: import("@playwright/test").Page, scopeId?: string): Promise<Geom> {
  return page.evaluate(
    ([src, id]) => {
      const build = new Function(`${src}; return __r102Geom;`) as () => (el: Element | null) => Geom;
      const scope = id ? document.getElementById(id) : null;
      return build()(scope);
    },
    [GEOM, scopeId ?? null] as [string, string | null]
  );
}

async function clickVisibleButton(page: import("@playwright/test").Page, name: RegExp, opts?: { last?: boolean }) {
  const btn = page.getByRole("button", { name }).filter({ visible: true });
  await expect(btn.first(), `找不到可见按钮 ${name.source}`).toBeVisible({ timeout: 30_000 });
  await (opts?.last ? btn.last() : btn.first()).click();
}

/** 进入变更计划（对比页 → 加载并对比 → 进入变更计划），停在带差异预览的那一步。 */
async function enterPlan(page: import("@playwright/test").Page) {
  await navigate(page, "配置对比");
  await page.waitForTimeout(400);
  await setDiffSource(page, "left", { connection: "Retest Nacos A", namespace: NS_A, group: GROUP, dataId: "svc-gateway.yaml" }, "zh-CN");
  await setDiffSource(page, "right", { connection: "Retest Nacos B", namespace: NS_B, group: GROUP, dataId: "svc-gateway.yaml" }, "zh-CN");
  await clickVisibleButton(page, /加载并对比|对比选中/, { last: true });
  await page.locator(".diff-panel").first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(400);
  await clickVisibleButton(page, /进入配置变更计划|进入变更计划|生成变更计划/, { last: true });
  await expect(page.locator(".apply-diff-preview").first(), "进不了带差异预览的变更计划").toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(800);
}

test("R102 永久回归：计划预览高度 / 工具条裁字 / 空列表双空态 / 复选框排版", async ({ page, retest }) => {
  test.setTimeout(900_000);
  mkdirSync(OUT, { recursive: true });
  await installRetestBridge(page, retest);
  await republishRetestData();

  const readings: Record<string, unknown> = {};
  const defects: string[] = [];

  // ── 0) 对照组：探针失效必须先在这里红 ─────────────────────────────────
  await page.goto("/");
  await dismissStartupDialog(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const ctl = await page.evaluate(([src]) => {
    const build = new Function(`${src}; return __r102Controls;`) as () => () => { id: string; node: HTMLElement }[];
    const made = build()();
    return made.map((m) => m.id);
  }, [CONTROLS] as [string]);
  expect(ctl.length, "对照组一条都没挂上").toBe(6);

  const cPreview = await geom(page, "r102ctl-preview");
  expect(cPreview.preview, "对照组 preview 没量到").not.toBeNull();
  expect(cPreview.preview!.body!.h, "探针测不出 0 高的 diff-body：D1 判据已经失效").toBeLessThanOrEqual(0);
  expect(cPreview.preview!.ovlStatsPx, "探针测不出警示条压在统计上的重叠：D1 判据已经失效").toBeGreaterThan(0);

  const cToolbar = await geom(page, "r102ctl-toolbar");
  expect(cToolbar.toolbar, "对照组 toolbar 没量到").not.toBeNull();
  expect(cToolbar.toolbar!.buttons[0].clip, "探针测不出 max-width+ellipsis 裁字：D3 判据已经失效").toBeGreaterThan(0);
  expect(cToolbar.toolbar!.dupIconPath, "探针测不出两枚图标同一画法：D2 判据已经失效").toBe(true);

  const cTwo = await geom(page, "r102ctl-empty-two");
  expect(cTwo.empties!.visibleEmptyStates, "探针数不出并存的两个空态：D4 判据已经失效").toBe(2);
  expect(cTwo.empties!.detailVisible, "无 list-empty 时右栏本就该占位，否则 D4 的对照组是恒绿的").toBe(true);

  const cOne = await geom(page, "r102ctl-empty-one");
  expect(cOne.empties!.listEmptyClass, "list-empty 类没被认出来").toBe(true);
  expect(cOne.empties!.visibleEmptyStates, "styles.css 的 .list-empty 规则失效：右栏占位又回来了").toBe(1);
  expect(cOne.empties!.detailVisible, "styles.css 的 .list-empty 规则失效：.data-detail 没被摘掉").toBe(false);
  expect(cOne.empties!.listW, "list-empty 时左栏必须占满整格（栅格没收成单列）").toBe(cOne.empties!.splitW);

  const cCheck = await geom(page, "r102ctl-check");
  expect(cCheck.check!.sameLine, "探针判不出复选框与标签同行：D5 的对照组是恒绿的").toBe(true);
  const cCheckBad = await geom(page, "r102ctl-check-bad");
  expect(cCheckBad.check!.sameLine, "竖排对照组竟然也算同行：D5 判据被写死了").toBe(false);
  readings.controls = {
    previewBodyH: cPreview.preview!.body!.h,
    previewOvlStatsPx: cPreview.preview!.ovlStatsPx,
    clip: cToolbar.toolbar!.buttons[0].clip,
    dupIconPath: cToolbar.toolbar!.dupIconPath,
    emptyTwo: cTwo.empties!.visibleEmptyStates,
    emptyOne: cOne.empties!.visibleEmptyStates,
    emptyOneDetail: cOne.empties!.detailVisible,
    checkSameLine: cCheck.check!.sameLine,
    checkBadSameLine: cCheckBad.check!.sameLine,
  };
  await page.evaluate(() => document.getElementById("r102-controls")?.remove());

  // ── 1) D1：变更计划差异预览 × 6 档宽度 ────────────────────────────────
  const planRows: Geom[] = [];
  for (const width of PLAN_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await dismissStartupDialog(page);
    await enterPlan(page);
    const g = await geom(page);
    planRows.push(g);
    await page.screenshot({ path: join(OUT, `plan-w${width}.png`) });
    const at = `计划预览@${width}`;
    if (!g.preview) defects.push(`${at} 没量到 .apply-diff-preview`);
    else {
      if (g.preview.preview!.h < 300) defects.push(`${at} 预览只有 ${g.preview.preview!.h}px 高（下限 300）`);
      if (g.preview.body!.h <= 0) defects.push(`${at} diff-body 高 ${g.preview.body!.h}：差异内容看不见`);
      if (g.preview.ovlStatsPx > 0) defects.push(`${at} 警示条压在统计上 ${g.preview.ovlStatsPx}px²`);
      if (g.preview.ovlHeadPx > 0) defects.push(`${at} 警示条压在表头上 ${g.preview.ovlHeadPx}px²`);
      if (g.preview.ovlBodyPx > 0) defects.push(`${at} 警示条压在正文上 ${g.preview.ovlBodyPx}px²`);
    }
    if (g.docOverflowX > 0) defects.push(`${at} 文档横向出血 ${g.docOverflowX}px`);
  }
  readings.plan = planRows.map((g, i) => ({ width: PLAN_WIDTHS[i], ...(g.preview ?? {}) }));

  // ── 2) D3 + D2：配置浏览工具条 × 3 档宽度（含内容搜索唤出「批量替换」）──
  const barRows: Geom[] = [];
  for (const width of TOOLBAR_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await navigate(page, "配置浏览");
    await page.locator(".browser-item").first().waitFor({ timeout: 30_000 });
    await page.waitForTimeout(400);
    let g = await geom(page);
    barRows.push(g);
    await page.screenshot({ path: join(OUT, `browse-w${width}.png`) });
    let at = `工具条@${width}`;
    if (!g.toolbar) defects.push(`${at} 没量到 .browser-action-row`);
    else {
      for (const b of g.toolbar.buttons) if (b.clip > 0) defects.push(`${at} 按钮「${b.text}」裁掉 ${b.clip}px`);
      for (const b of g.toolbar.buttons) if (b.overflowRight > 1) defects.push(`${at} 按钮「${b.text}」越出行右缘 ${b.overflowRight}px`);
      if (g.toolbar.rowScrollW - g.toolbar.rowW > 0) defects.push(`${at} 工具条横向出血 ${g.toolbar.rowScrollW - g.toolbar.rowW}px`);
      if (g.toolbar.icons.length >= 2 && g.toolbar.dupIconPath) defects.push(`${at} 两枚图标同一画法：${g.toolbar.icons.map((i) => i.label).join("/")}`);
    }
    if (g.docOverflowX > 0) defects.push(`${at} 文档横向出血 ${g.docOverflowX}px`);

    // 内容搜索命中态：这一档会多出一颗「批量替换」，是工具条最挤的时候
    await page.getByRole("button", { name: "内容" }).click();
    const search = page.locator(".browser-search-row .search-input.wide").first();
    await search.fill(FIND);
    await search.press("Enter");
    await expect(page.locator(".browser-item-id", { hasText: "svc-billing.yaml" }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "批量替换" }).last()).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(400);
    g = await geom(page);
    barRows.push(g);
    await page.screenshot({ path: join(OUT, `browse-replace-w${width}.png`) });
    at = `工具条+批量替换@${width}`;
    if (!g.toolbar) defects.push(`${at} 没量到 .browser-action-row`);
    else {
      const texts = g.toolbar.buttons.map((b) => b.text);
      if (!texts.some((x) => /批量替换|Batch replace/.test(x))) defects.push(`${at} 「批量替换」没进读数：${texts.join(" | ")}`);
      for (const b of g.toolbar.buttons) if (b.clip > 0) defects.push(`${at} 按钮「${b.text}」裁掉 ${b.clip}px`);
      for (const b of g.toolbar.buttons) if (b.overflowRight > 1) defects.push(`${at} 按钮「${b.text}」越出行右缘 ${b.overflowRight}px`);
      if (g.toolbar.rowScrollW - g.toolbar.rowW > 0) defects.push(`${at} 工具条横向出血 ${g.toolbar.rowScrollW - g.toolbar.rowW}px`);
    }
    if (g.docOverflowX > 0) defects.push(`${at} 文档横向出血 ${g.docOverflowX}px`);
    // 退回文件名模式，别把内容搜索态带给下一档
    await page.getByRole("button", { name: "文件名" }).click();
    await search.fill("");
    await search.press("Enter");
    await page.waitForTimeout(300);
  }
  readings.toolbar = barRows.map((g) => g.toolbar);

  // ── 3) D4：零行主从（任务中心 = 真的没有任务；操作历史 = 筛到零行）──────
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const [name, splitSel] of [
    ["任务中心", ".data-split.task-center-content"],
    ["操作历史", ".data-split.history-content"],
  ] as const) {
    await navigate(page, name);
    await page.waitForTimeout(800);
    if (name === "操作历史") {
      // 用一个必然筛空的关键字造零行：不依赖这台机器上有没有历史记录，也不去删用户数据。
      const input = page.locator(".history-filter-input").first();
      await expect(input, "操作历史找不到 dataId 筛选框").toBeVisible({ timeout: 15_000 });
      await input.fill("r102-必然筛空的关键字");
      await page.waitForTimeout(500);
    }
    const rows = await page.locator(`${splitSel} .data-list-item`).count();
    expect(rows, `${name} 这一屏没凑出零行列表，D4 判据没被真的执行`).toBe(0);
    const g = await geom(page);
    readings[`empty-${name}`] = g.empties;
    await page.screenshot({ path: join(OUT, `empty-${name}.png`) });
    const at = `空列表-${name}`;
    if (!g.empties) defects.push(`${at} 没量到 .data-split`);
    else {
      if (!g.empties.listEmptyClass) defects.push(`${at} 零行却没打 list-empty 类：JSX 侧的判据丢了`);
      if (g.empties.visibleEmptyStates !== 1) defects.push(`${at} 可见空态 ${g.empties.visibleEmptyStates} 个，应为 1 个`);
      if (g.empties.detailVisible) defects.push(`${at} 右栏占位还在渲染，用户对着两句空态`);
      if (g.empties.listW !== g.empties.splitW) defects.push(`${at} 左栏 ${g.empties.listW}px < 整宽 ${g.empties.splitW}px，栅格没收成单列`);
    }
    if (name === "操作历史") {
      // 清掉筛选：有记录时右栏必须回来（防「一律不渲染右栏」这种把缺陷修成另一种缺陷的改法）
      const input = page.locator(".history-filter-input").first();
      await input.fill("");
      await page.waitForTimeout(500);
      const back = await geom(page);
      const liveRows = await page.locator(".data-split.history-content .data-list-item").count();
      readings["empty-操作历史-restored"] = { rows: liveRows, ...(back.empties ?? {}) };
      if (liveRows > 0) {
        if (back.empties!.listEmptyClass) defects.push("清空筛选后仍带着 list-empty 类");
        if (!back.empties!.detailVisible) defects.push("有记录时右栏被一起摘掉了：list-empty 判据写反了");
      }
    }
  }

  // ── 4) D5：连接表单「默认来源」复选框排版 ──────────────────────────────
  await navigate(page, "连接管理");
  await page.locator(".conn-mgr").first().waitFor({ timeout: 15_000 });
  const checkField = page.locator(".conn-mgr label.field.check-field").first();
  await expect(checkField, "连接表单里找不到 .field.check-field（默认来源）").toBeVisible({ timeout: 15_000 });
  const cg = await geom(page);
  readings.conn = cg.check;
  await page.screenshot({ path: join(OUT, "conn-checkfield.png") });
  if (!cg.check) defects.push("连接管理没量到 .field.check-field");
  else {
    if (!cg.check.sameLine) defects.push(`默认来源：标签 y=${cg.check.label?.y}h=${cg.check.label?.h} / 方框 y=${cg.check.box?.y}h=${cg.check.box?.h}，不在同一行`);
    if (!cg.check.boxRightOfLabel) defects.push(`默认来源：方框 x=${cg.check.box?.x} 没落在标签右侧（标签 x=${cg.check.label?.x} w=${cg.check.label?.w}）`);
  }
  // 复选框整行可点：点标签文字也要能勾上（.field.check-field 是 <label>，排版改回一行后这条才真的成立）
  const boxInput = checkField.locator('input[type="checkbox"]');
  const before = await boxInput.isChecked();
  await checkField.locator(".field-label").first().click();
  await page.waitForTimeout(200);
  expect(await boxInput.isChecked(), "点标签文字没切到复选框：label 与 input 的从属关系断了").toBe(!before);
  await checkField.locator(".field-label").first().click();
  await page.waitForTimeout(200);
  expect(await boxInput.isChecked(), "复选框没复位，后面的读数会带脏状态").toBe(before);

  writeFileSync(join(OUT, "readings.json"), JSON.stringify(readings, null, 2), "utf8");
  console.log("[R102] 对照组读数:", JSON.stringify(readings.controls));
  console.log("[R102] 计划预览:", JSON.stringify(readings.plan));
  console.log(
    "[R102] 工具条:",
    JSON.stringify(
      barRows.map((g) => g.toolbar && { rowW: g.toolbar.rowW, lines: g.toolbar.rowLines, clips: g.toolbar.buttons.filter((b) => b.clip > 0).map((b) => `${b.text}:${b.clip}`) })
    )
  );
  expect(defects.join("\n"), "轮102 布局回归：以下判据没过").toBe("");
});
