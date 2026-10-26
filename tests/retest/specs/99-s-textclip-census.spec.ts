// 轮83 永久回归：正文被切掉却读不到全貌的文字，以及英文译名下的布局撞车。
//
// 为什么必须真机量：一行字到底被谁切、切掉多少，是 nowrap + flex 压缩 + 祖先 overflow:hidden
// 三层算出来的结果。jsdom 里 scrollWidth/clientWidth 恒为 0，静态 grep 只看得到写法看不到渲染。
// 已有的两条真机普查不覆盖这一类：99-s-target-size 量盒尺寸，99-s-contrast 量前景背景。
//
// 判据（全量真机读数 68 屏 / 3961 文本节点；收紧成永久回归前后各跑一次，数字一致，
//   四类缺陷桶均为 0，所以这里钉死为 0）：
//   hardClip / ellipsisNoTitle / verticalCut / overlap 必须为 0，每屏 docOverflowX 必须 <= 0。
//   reachableByScroll、scrollableCut 允许非 0：文字落在可滚祖先里，滚过去就看得到，设计如此。
//   这两个桶就是全部口径，判据不豁免任何具体控件，因此也没有豁免清单。
// 防假绿：__r83MakeControls 造 8 条对照组，每条必须且只能落进它声明的那个桶，落错或落空都判红。
//   分类器哪天悄悄失效（字段改名、阈值被调、判据被放宽），红在这里，而不是全员 0 的漂亮数字。
//
// 四条必须留档的探针踩坑（轮83 首跑那 4 条失败屏全是探针自身问题，不是产品缺陷）：
// 1) Playwright 走 Node ESM，JSON 不能直接 import（需 import attribute）——用 fs 同步读 src/locales。
// 2) 判据字段名必须与 measure() 的返回值一致：早先读不存在的 m.scrollable 恒为 undefined，
//    把「溢出但滚得到 + 有 title 兜底」的正确设计全误判成硬切（假阳性）。
// 3) body{height:100vh;overflow:hidden} 让 clipBoxOf 永不返回 null，clipSel 不可能等于 "viewport"：
//    「文档可纵滚所以滚得到」那半截豁免是死代码，真把 576 条接进可达桶的是可滚祖先 clipScrollable。
//    桶名据此从 belowFold 改成 reachableByScroll，别再按「视口下缘」理解它；
//    对照组 r83ctl-fixedbelow 专门钉这一点：悬在视口外又没有可滚祖先，必须算纵切。
// 4) 深状态触发用结构锚（.audit-actions button.btn-primary），不能用文案正则：
//    /run audit|audit/i 先命中侧栏「Audit Log」，等于换了页面，90s 等不到矩阵行。
//
// tsc --noEmit 的 include 只覆盖 src + wailsjs，查不到 tests/，别拿它当探针类型凭据——
// __dirname 在 "type":"module" 下运行时不存在就是这个漏掉的。本文件只能靠真跑验证。
import { expect, test } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { navigate as navigateByLabel, dismissStartupDialog, setDiffSource } from "./ui";
import { loadRetestState } from "../state";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
// Playwright 走 Node ESM，JSON 不能直接 import（需 import attribute，与各版 transpiler 相冲），
// 这里用 fs 同步读，保证 zh/en 标签与 src/locales 单一事实源一致。
const LOCALE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src", "locales");
const dictOf = (file: string): Record<string, string> => {
  const raw = JSON.parse(readFileSync(resolve(LOCALE_ROOT, file), "utf8")) as { app?: Record<string, string> };
  if (!raw.app) throw new Error(`locales/${file} missing "app" namespace`);
  return raw.app;
};
const LOCALE_DICTS: Record<Locale, Record<string, string>> = {
  "zh-CN": dictOf("zh-CN.json"),
  "en-US": dictOf("en-US.json"),
};

const state = loadRetestState();
const NS_A = state.nacos.a.namespace;
const NS_B = state.nacos.b.namespace;
const GROUP = "RETEST-PROD";

type Locale = "zh-CN" | "en-US";

/** 侧栏按 locale 取标签（与 App.tsx navGroups 同一批 i18n key）。 */
const NAV_KEYS = ["title", "diff", "audit", "history", "backup", "tasks", "logViewer", "connectionManage", "sshTunnels", "settings", "about"];

function navLabel(locale: Locale, key: string): string {
  return LOCALE_DICTS[locale][key] ?? key;
}

async function navigate(page: import("@playwright/test").Page, locale: Locale, key: string) {
  await navigateByLabel(page, navLabel(locale, key));
}

/** 提交对比的按钮：单文件态「加载并对比」/批量态「对比选中（N）」，英文同名不同词。
 *  播种会话当时停在哪个模式是不可控的，写死一个名字就会随机选不中（轮83 首跑实测红在这）。 */
const COMPARE_SUBMIT = /加载并对比|对比选中|Load & Compare|Compare Selected/i;
const ENTER_PLAN = /进入配置变更计划|Enter Configuration Change Plan/i;

/** 每轮 (locale × width) 必须跑满的屏。深状态与对照组少一条，就是某处漏了 await 或新屏没登记。
 *  「启动」只在切语言时断言侧栏 title，不进取数，所以不在清单里。 */
const DEEP_LABELS = ["配置浏览+选中文件", "配置矩阵+结果", "配置矩阵+详情", "配置对比+结果", "变更计划-第4步", "侧边栏收起"];
const CONTROL_LABEL = "探针对照组";
const WIDTHS = [1280, 1024];
const LOCALES: Locale[] = ["zh-CN", "en-US"];
const EXPECTED_CHECKS = LOCALES.flatMap((locale) =>
  WIDTHS.flatMap((width) =>
    [...NAV_KEYS.map((k) => navLabel(locale, k)), ...DEEP_LABELS, CONTROL_LABEL].map((label) => `${locale}@${width}:${label}`)
  )
);

/** 把应用真正切到目标语言：只有走设置页的语言开关才算数。
 *  直接写 localStorage 会被启动水合覆回（storageSeed 每轮导航也无条件写 zh-CN）；
 *  直接改主数据文档也会被 store 的 debounce 回推覆回。轮83 两条路都实测过：白改。
 *  setLocale 是 i18n 的唯一入口（写 localStorage + 重渲染 + 随 store 回推进文档），
 *  所以切完必须用「侧栏首项真的变成目标语言」当可见证据，不接受静默回退。 */
async function setAppLocale(page: import("@playwright/test").Page, locale: Locale): Promise<void> {
  await page.goto("/");
  await dismissStartupDialog(page);
  const settings = page.locator(".side-nav-item").filter({ hasText: /设置|Settings/ }).first();
  await expect(settings, "找不到设置入口（zh/en 两种标题都没命中）").toBeVisible({ timeout: 15_000 });
  await settings.click();
  const sel = page.locator("select.lang-switch");
  await expect(sel, "设置页里找不到语言开关 select.lang-switch").toBeVisible({ timeout: 15_000 });
  if ((await sel.inputValue()) !== locale) await sel.selectOption(locale);
  await expect(
    page.locator(".side-nav-item").first(),
    `切到 ${locale} 后侧栏首项应为「${navLabel(locale, "title")}」`
  ).toContainText(navLabel(locale, "title"), { timeout: 10_000 });
}

async function clickVisibleButton(page: import("@playwright/test").Page, name: RegExp, opts?: { last?: boolean }) {
  const btn = page.getByRole("button", { name }).filter({ visible: true });
  await expect(btn.first(), `找不到可见按钮 ${name.source}`).toBeVisible({ timeout: 30_000 });
  await (opts?.last ? btn.last() : btn.first()).click();
  return true;
}

const PROBE_SOURCE = String.raw`
function __r83Census(opts) {
  var CODE_SEL = ".code-area, .code-view, pre, .udiff-body, .diff-line, .diff-gutter, .browser-result-summary, .apply-report-scroll, .log-line, .audit-matrix-body";
  var cls = function (el) {
    var c = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean) : [];
    return (el.tagName.toLowerCase() + (c.length ? "." + c.slice(0, 3).join(".") : "")).slice(0, 64);
  };
  var chainOpacity = function (el) {
    var o = 1, n = el;
    while (n && n.nodeType === 1) { o *= parseFloat(getComputedStyle(n).opacity || "1"); n = n.parentElement; }
    return o;
  };
  var ownTextLen = function (el) {
    var len = 0;
    for (var i = 0; i < el.childNodes.length; i++) {
      var node = el.childNodes[i];
      if (node.nodeType === 3) len += (node.textContent || "").trim().length;
    }
    return len;
  };
  var textOf = function (el) { return (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 48); };
  var vis = function (el) {
    var r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && cs.visibility !== "hidden" && cs.display !== "none" && chainOpacity(el) > 0.05;
  };
  var clipBoxOf = function (el) {
    var n = el.parentElement;
    while (n && n.nodeType === 1) {
      var cs = getComputedStyle(n);
      if (/hidden|clip|auto|scroll/.test(cs.overflowX + " " + cs.overflowY)) {
        var r = n.getBoundingClientRect();
        var padL = parseFloat(cs.paddingLeft) || 0;
        var padR = parseFloat(cs.paddingRight) || 0;
        var padB = parseFloat(cs.paddingBottom) || 0;
        return { node: n, sel: cls(n), scrollable: /auto|scroll/.test(cs.overflowX) || /auto|scroll/.test(cs.overflowY),
          left: r.left + padL, right: r.right - padR, top: r.top, bottom: r.bottom - padB };
      }
      n = n.parentElement;
    }
    return null;
  };
  var measure = function (el) {
    var range = document.createRange(), picked = null;
    for (var i = 0; i < el.childNodes.length; i++) {
      var node = el.childNodes[i];
      if (node.nodeType === 3 && (node.textContent || "").trim().length) { picked = node; break; }
    }
    if (!picked) return null;
    range.selectNodeContents(picked);
    var rects = Array.prototype.slice.call(range.getClientRects());
    if (!rects.length) return null;
    var left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
    rects.forEach(function (r) { left = Math.min(left, r.left); right = Math.max(right, r.right); top = Math.min(top, r.top); bottom = Math.max(bottom, r.bottom); });
    var cs = getComputedStyle(el);
    var clip = clipBoxOf(el);
    var cutX = 0, cutY = 0, clipSel = "viewport", clipScrollable = false, ellipsis = cs.textOverflow === "ellipsis";
    var vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    if (clip) {
      cutX = Math.max(0, right - clip.right);
      cutY = Math.max(0, bottom - clip.bottom);
      clipSel = clip.sel;
      clipScrollable = clip.scrollable;
      if (getComputedStyle(clip.node).textOverflow === "ellipsis") ellipsis = true;
    }
    cutX = Math.max(cutX, Math.max(0, right - vw));
    cutY = Math.max(cutY, Math.max(0, bottom - vh));
    var selfCut = el.scrollWidth - el.clientWidth;
    if (el.clientWidth > 2 && selfCut > 0 && /hidden|clip/.test(cs.overflowX)) cutX = Math.max(cutX, selfCut);
    return { cutX: Math.round(cutX), cutY: Math.round(cutY), ellipsis: ellipsis,
      ownTitle: el.getAttribute("title") || "", ancTitle: (el.closest("[title]") ? el.closest("[title]").getAttribute("title") : "") || "",
      clipSel: clipSel, clipScrollable: clipScrollable, whiteSpace: cs.whiteSpace };
  };

  var hardClip = [], ellipsisNoTitle = [], scrollableCut = [], verticalCut = [], overlap = [], reachableByScroll = [];
  var docEl = document.documentElement, bdy = document.body;
  var pageScrollsY = docEl.scrollHeight - docEl.clientHeight > 1 || (bdy ? bdy.scrollHeight - bdy.clientHeight > 1 : false);
  var nodesScanned = 0, codeSkipped = 0;
  // 对照组在取样 DOM 之前挂上，才能和真实页面走同一套分类；扫完立刻摘掉，不污染真实读数。
  var made = opts.controls ? __r83MakeControls() : null;
  var all = Array.prototype.slice.call(document.querySelectorAll("body *"));
  var textEls = [];
  all.forEach(function (el) {
    if (!vis(el) || !ownTextLen(el)) return;
    if (el.closest(CODE_SEL)) { codeSkipped += 1; return; }
    textEls.push(el);
  });
  nodesScanned = textEls.length;

  textEls.forEach(function (el) {
    var m = measure(el);
    if (!m) return;
    var rec = { sel: cls(el), txt: textOf(el), cutX: m.cutX, cutY: m.cutY, ellipsis: !!m.ellipsis, ownTitle: m.ownTitle.slice(0, 24), ancTitle: m.ancTitle.slice(0, 24), clipSel: m.clipSel, ws: m.whiteSpace, scrollable: m.clipScrollable, pageScrollsY: pageScrollsY };
    if (m.cutX >= opts.minPx) {
      // 判据必须用 clipScrollable：measure() 返回的是这个字段名，早前写成 m.scrollable 恒为
      // undefined，把「溢出但滚得到 + 有 title 兜底」的正确设计全误判成硬切。
      if (m.clipScrollable) scrollableCut.push(rec);
      else if (m.ellipsis && !m.ownTitle && !m.ancTitle) ellipsisNoTitle.push(rec);
      else if (!m.ellipsis) hardClip.push(rec);
    }
    if (m.cutY >= opts.minVerticalPx) {
      // 只有「被可滚祖先兜住」才算滚得到；clipSel === "viewport" 在 body{overflow:hidden} 下永不成立，
      // 留着只当防御，不许把它当豁免口径（见头注释第 3 条）。
      if (m.clipScrollable) reachableByScroll.push(rec);
      else verticalCut.push(rec);
    }
  });

  var parents = [];
  textEls.forEach(function (el) { if (el.parentElement && parents.indexOf(el.parentElement) < 0) parents.push(el.parentElement); });
  parents.forEach(function (p) {
    var kids = Array.prototype.slice.call(p.children).filter(function (k) { return vis(k) && ownTextLen(k); });
    for (var i = 0; i < kids.length; i++) {
      for (var j = i + 1; j < kids.length; j++) {
        var a = kids[i].getBoundingClientRect(), b = kids[j].getBoundingClientRect();
        var ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        var oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ox <= opts.minOverlapPx || oy <= opts.minOverlapPx) continue;
        var contained = (a.left >= b.left && a.right <= b.right && a.top >= b.top && a.bottom <= b.bottom) ||
          (b.left >= a.left && b.right <= a.right && b.top >= a.top && b.bottom <= b.bottom);
        if (contained) continue;
        overlap.push({ parent: cls(p), a: cls(kids[i]), b: cls(kids[j]), at: textOf(kids[i]), bt: textOf(kids[j]), ox: Math.round(ox), oy: Math.round(oy) });
      }
    }
  });

  var controlHits = opts.controls ? checkControls(made, {
    hardClip: hardClip, ellipsisNoTitle: ellipsisNoTitle, scrollableCut: scrollableCut,
    verticalCut: verticalCut, reachableByScroll: reachableByScroll, overlap: overlap
  }) : null;

  var cap = function (arr) { return { n: arr.length, sample: arr.slice(0, 25) }; };
  return {
    docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    bodyOverflowX: document.body.scrollWidth - document.body.clientWidth,
    nodesScanned: nodesScanned, codeSkipped: codeSkipped,
    hardClip: cap(hardClip), ellipsisNoTitle: cap(ellipsisNoTitle), scrollableCut: cap(scrollableCut),
    verticalCut: cap(verticalCut), reachableByScroll: cap(reachableByScroll), overlap: cap(overlap),
    controlHits: controlHits
  };
}

/* ---------- 对照组：分类器自己的回归（每条只许落进它声明的那个桶） ---------- */
var CTLS = [];
var __r83MakeControls = function () {
  var vh = document.documentElement.clientHeight;
  var LONG = "0123456789ABCDEFGHIJ0123456789";
  var specs = [
    // 横向硬切：nowrap + 定宽 + overflow:hidden，没有任何兜底 => 必须读作缺陷
    { marker: "r83ctl-hardclip", expect: "hardClip",
      html: '<div style="position:fixed;left:2px;top:2px;width:60px;overflow:hidden;white-space:nowrap">' +
            '<span class="r83ctl-hardclip">' + LONG + '</span></div>' },
    // 省略号且没有 title：截断成 ... 也没人知道全文 => 必须读作缺陷
    { marker: "r83ctl-ellipsis", expect: "ellipsisNoTitle",
      html: '<div style="position:fixed;left:2px;top:26px;width:60px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">' +
            '<span class="r83ctl-ellipsis">' + LONG + '</span></div>' },
    // 纵向硬切：定高 18px 裁掉 44px 行高 => 必须读作缺陷
    { marker: "r83ctl-vertical", expect: "verticalCut",
      html: '<div style="position:fixed;left:2px;top:50px;width:120px;height:18px;overflow:hidden">' +
            '<span class="r83ctl-vertical" style="display:block;line-height:44px">R83CTL</span></div>' },
    // 撞车：同父两个可见文本块真实交叠且互不包含 => 必须读作缺陷（两条 marker 共享同一段 DOM）
    { marker: "r83ctl-overlap-a", expect: "overlap",
      html: '<div style="position:fixed;left:2px;top:80px;width:160px;height:44px">' +
            '<span class="r83ctl-overlap-a" style="position:absolute;left:0;top:0;width:120px;height:20px;display:block">R83CTL-A</span>' +
            '<span class="r83ctl-overlap-b" style="position:absolute;left:20px;top:10px;width:120px;height:20px;display:block">R83CTL-B</span></div>' },
    { marker: "r83ctl-overlap-b", expect: "overlap", html: null },
    // 横向溢出但有可滚祖先 => 滚得到，不许算缺陷（分类器若把它判成硬切，口径就名存实亡）
    { marker: "r83ctl-scrollable", expect: "scrollableCut",
      html: '<div style="position:fixed;left:2px;top:140px;width:60px;overflow-x:auto;overflow-y:hidden;white-space:nowrap">' +
            '<span class="r83ctl-scrollable">' + LONG + '</span></div>' },
    // 纵向溢出但有可滚祖先 => 同上，不许算纵切
    { marker: "r83ctl-reachable", expect: "reachableByScroll",
      html: '<div style="position:fixed;left:2px;top:170px;width:120px;height:18px;overflow-y:auto">' +
            '<span class="r83ctl-reachable" style="display:block;line-height:44px">R83CTL</span></div>' },
    // 悬在视口下缘之外又没有可滚祖先（position:fixed 滚不到）=> 必须算纵切，不许被「文档可滚」豁免
    { marker: "r83ctl-fixedbelow", expect: "verticalCut",
      html: '<div style="position:fixed;left:2px;top:' + (vh - 4) + 'px;width:120px">' +
            '<span class="r83ctl-fixedbelow" style="display:block;height:20px;line-height:20px">R83CTL</span></div>' },
  ];
  specs.forEach(function (c) {
    if (!c.html) return;
    var wrap = document.createElement("div");
    wrap.style.cssText = "position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none";
    wrap.innerHTML = c.html;
    document.body.appendChild(wrap);
    CTLS.push(wrap);
  });
  return specs;
};
var __r83ClearControls = function () {
  CTLS.forEach(function (w) { if (w.parentNode) w.parentNode.removeChild(w); });
  CTLS = [];
};
var checkControls = function (specs, buckets) {
  var rows = specs.map(function (c) {
    var got = [];
    Object.keys(buckets).forEach(function (name) {
      var arr = buckets[name];
      for (var i = 0; i < arr.length; i++) {
        if (JSON.stringify(arr[i]).indexOf(c.marker) >= 0) got.push(name);
      }
    });
    return { marker: c.marker, expect: c.expect, got: got };
  });
  __r83ClearControls();
  return {
    total: specs.length,
    misses: rows.filter(function (r) { return r.got.length === 0; }),
    wrong: rows.filter(function (r) { return r.got.length > 1 || r.got.indexOf(r.expect) < 0; })
  };
};
`;

interface ControlHits {
  total: number;
  misses: { marker: string; expect: string; got: string[] }[];
  wrong: { marker: string; expect: string; got: string[] }[];
}

interface CensusReport {
  docOverflowX: number;
  bodyOverflowX: number;
  nodesScanned: number;
  codeSkipped: number;
  hardClip: { n: number; sample: unknown[] };
  ellipsisNoTitle: { n: number; sample: unknown[] };
  scrollableCut: { n: number; sample: unknown[] };
  verticalCut: { n: number; sample: unknown[] };
  reachableByScroll: { n: number; sample: unknown[] };
  overlap: { n: number; sample: unknown[] };
  controlHits: ControlHits | null;
}

interface StateReport {
  locale: Locale;
  width: number;
  state: string;
  report: CensusReport;
}

test("R83 永久回归：切掉的文字必须读得到 + 英文布局不许撞车", async ({ page, retest }) => {
  test.setTimeout(1_500_000);
  await installRetestBridge(page, retest);
  await republishRetestData();

  // 分诊产物落系统临时目录：写死 /tmp/cs 在 Windows 上会 ENOENT 直接判红（路径可移植）。
  // 这两个 json 只是给人看的读数转储，不参与任何判据。
  const DUMP_DIR = join(tmpdir(), "confscope-r83");
  mkdirSync(DUMP_DIR, { recursive: true });
  const reports: StateReport[] = [];
  const checked: string[] = [];
  const failures: string[] = [];
  const OPTS = { minPx: 4, minVerticalPx: 6, minOverlapPx: 4 };

  const runProbe = async (opts: typeof OPTS & { controls?: boolean }): Promise<CensusReport> =>
    (await page.evaluate(
      ([src, o]) => {
        const factory = new Function("opts", src + "; return __r83Census(opts);");
        return (factory as (x: unknown) => CensusReport)(o);
      },
      [PROBE_SOURCE, opts] as [string, typeof opts]
    )) as CensusReport;

  /** 对照组：8 条已知答案的 DOM，每条必须且只能落进它声明的那个桶。
   *  读数不进 reports——它量的是探针自己，不是产品，混进去会把真实总数抬高、把缺陷数也抬高。 */
  const probeControls = async (locale: Locale, width: number) => {
    const report = await runProbe({ ...OPTS, controls: true });
    const h = report.controlHits;
    checked.push(`${locale}@${width}:${CONTROL_LABEL}`);
    if (!h) {
      failures.push(`${locale}@${width}:${CONTROL_LABEL} -> 探针没返回 controlHits：对照组根本没跑起来`);
      return;
    }
    console.log(`R83 对照组 ${locale}@${width} 条数=${h.total} 落空=${h.misses.length} 落错桶=${h.wrong.length}`);
    if (h.misses.length) failures.push(`${locale}@${width}:${CONTROL_LABEL} -> 对照组落空 ${JSON.stringify(h.misses)}`);
    if (h.wrong.length) failures.push(`${locale}@${width}:${CONTROL_LABEL} -> 对照组落错桶 ${JSON.stringify(h.wrong)}`);
  };

  const scan = async (locale: Locale, width: number, label: string) => {
    const report = await runProbe(OPTS);
    reports.push({ locale, width, state: label, report });
    checked.push(`${locale}@${width}:${label}`);
    console.log(
      `R83 ${locale}@${width} ${label} 文本=${report.nodesScanned} 正文跳过=${report.codeSkipped} 出血=${report.docOverflowX} 硬切=${report.hardClip.n} 省略号无title=${report.ellipsisNoTitle.n} 可滚=${report.scrollableCut.n} 纵切=${report.verticalCut.n} 滚得到=${report.reachableByScroll.n} 撞车=${report.overlap.n}`
    );
    if (report.hardClip.n) console.log(`  hardClip ${JSON.stringify(report.hardClip.sample.slice(0, 8))}`);
    if (report.ellipsisNoTitle.n) console.log(`  ellipsisNoTitle ${JSON.stringify(report.ellipsisNoTitle.sample.slice(0, 8))}`);
    if (report.verticalCut.n) console.log(`  verticalCut ${JSON.stringify(report.verticalCut.sample.slice(0, 8))}`);
    if (report.overlap.n) console.log(`  overlap ${JSON.stringify(report.overlap.sample.slice(0, 6))}`);
  };

  /** 一屏失败不许带走整轮普查：记原因继续跑，最后由覆盖断言判死，绝不静默吞。 */
  const screen = async (locale: Locale, width: number, label: string, body: () => Promise<void>) => {
    try {
      await body();
    } catch (e) {
      const why = String(e).replace(/\s+/g, " ").slice(0, 220);
      failures.push(`${locale}@${width}:${label} -> ${why}`);
      console.log(`R83 屏失败 ${locale}@${width} ${label}: ${why}`);
    }
  };

  const dump = () => {
    const totals = reports.reduce(
      (acc, r) => {
        acc.hardClip += r.report.hardClip.n;
        acc.ellipsisNoTitle += r.report.ellipsisNoTitle.n;
        acc.verticalCut += r.report.verticalCut.n;
        acc.reachableByScroll += r.report.reachableByScroll.n;
        acc.codeSkipped += r.report.codeSkipped;
        acc.scrollableCut += r.report.scrollableCut.n;
        acc.overlap += r.report.overlap.n;
        acc.docOverflowScreens += r.report.docOverflowX > 0 ? 1 : 0;
        acc.nodes += r.report.nodesScanned;
        return acc;
      },
      { hardClip: 0, ellipsisNoTitle: 0, verticalCut: 0, reachableByScroll: 0, scrollableCut: 0, overlap: 0, docOverflowScreens: 0, nodes: 0, codeSkipped: 0 }
    );
    console.log(
      `R83 合计 屏次=${reports.length} 文本节点=${totals.nodes} 硬切=${totals.hardClip} 省略号无title=${totals.ellipsisNoTitle} 纵切=${totals.verticalCut} 滚得到=${totals.reachableByScroll} 可滚=${totals.scrollableCut} 撞车=${totals.overlap} 出血屏次=${totals.docOverflowScreens} 正文跳过=${totals.codeSkipped} 失败屏=${failures.length}`
    );
    writeFileSync(join(DUMP_DIR, "r83-census.json"), JSON.stringify(reports, null, 2), "utf8");
    writeFileSync(join(DUMP_DIR, "r83-totals.json"), JSON.stringify({ totals, checked, failures }, null, 2), "utf8");
    return totals;
  };

  let totals = { hardClip: 0, ellipsisNoTitle: 0, verticalCut: 0, reachableByScroll: 0, scrollableCut: 0, overlap: 0, docOverflowScreens: 0, nodes: 0, codeSkipped: 0 };
  try {
    for (const locale of LOCALES) {
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: width === 1280 ? 820 : 720 });

        await screen(locale, width, "启动", async () => {
          await setAppLocale(page, locale);
          expect(await page.locator(".side-nav-item").first().getAttribute("title"), "侧栏标签应带全文 title").toBeTruthy();
        });

        // 对照组放在每轮开头：它只验分类器，放在哪一屏都行，但它必须每轮都跑
        // ——阈值/字段/判据这类改动是全局的，一轮绿过不代表另一轮的视口也算得对。
        await screen(locale, width, CONTROL_LABEL, async () => {
          await probeControls(locale, width);
        });

        for (const key of NAV_KEYS) {
          await screen(locale, width, navLabel(locale, key), async () => {
            await navigate(page, locale, key);
            await page.waitForTimeout(650);
            await scan(locale, width, navLabel(locale, key));
          });
        }

        await screen(locale, width, "配置浏览+选中文件", async () => {
          await navigate(page, locale, "title");
          await expect(page.locator(".browser-item").first()).toBeVisible({ timeout: 30_000 });
          await page.locator(".browser-item-id").filter({ hasText: "svc-legacy-prod.yaml" }).first().click();
          await expect(page.locator(".code-area").first()).toBeVisible({ timeout: 30_000 });
          await page.waitForTimeout(500);
          await scan(locale, width, "配置浏览+选中文件");
        });

        await screen(locale, width, "配置矩阵+结果", async () => {
          await navigate(page, locale, "audit");
          await page.waitForTimeout(800);
          // 深状态触发一律用结构锚，不用文案正则：轮83 首跑 /run audit|audit/i 先命中侧栏
          // 「Audit Log」按钮，等于换了个页面，90s 等不到矩阵行（4 条失败同源）。
          // .audit-add-env 只在 envSources.length < 6 时渲染，播种数据已配好 ≥2 个环境，
          // 没有它也能出结果，所以点不点都不许让整屏失败。
          await page.locator(".audit-add-env").first().click({ timeout: 5_000 }).catch(() => undefined);
          await expect(page.locator(".audit-actions button.btn-primary"), "找不到矩阵执行按钮").toBeVisible({ timeout: 15_000 });
          await page.locator(".audit-actions button.btn-primary").first().click();
          await expect(page.locator(".audit-matrix-body .audit-matrix-row").first()).toBeVisible({ timeout: 90_000 });
          await scan(locale, width, "配置矩阵+结果");
        });

        await screen(locale, width, "配置矩阵+详情", async () => {
          await page.locator(".audit-matrix-body .audit-matrix-row").first().click();
          await expect(page.locator(".audit-detail").first()).toBeVisible({ timeout: 15_000 });
          await page.waitForTimeout(400);
          await scan(locale, width, "配置矩阵+详情");
        });

        await screen(locale, width, "配置对比+结果", async () => {
          await navigate(page, locale, "diff");
          await page.waitForTimeout(600);
          // 显式给 dataId 走单文件对比：批量态要取 13 个文件两整轮正文，深状态到位时间不可控，
          // 普查要的是每屏可复现，不是碰运气。
          await setDiffSource(page, "left", { connection: "Retest Nacos A", namespace: NS_A, group: GROUP, dataId: "svc-gateway.yaml" }, locale);
          await setDiffSource(page, "right", { connection: "Retest Nacos B", namespace: NS_B, group: GROUP, dataId: "svc-gateway.yaml" }, locale);
          await clickVisibleButton(page, COMPARE_SUBMIT, { last: true });
          await expect(page.locator(".diff-panel").first()).toBeVisible({ timeout: 60_000 });
          await page.waitForTimeout(600);
          await scan(locale, width, "配置对比+结果");
        });

        await screen(locale, width, "变更计划-第4步", async () => {
          await clickVisibleButton(page, ENTER_PLAN, { last: true });
          await page.waitForTimeout(1_500);
          await scan(locale, width, "变更计划-第4步");
        });

        await screen(locale, width, "侧边栏收起", async () => {
          await page.locator(".sidebar-toggle").click();
          await page.waitForTimeout(500);
          await scan(locale, width, "侧边栏收起");
          await page.locator(".sidebar-toggle").click();
          await page.waitForTimeout(400);
        });
      }
    }
  } finally {
    totals = dump();
  }

  // 1) 每一屏都必须真的跑成。宁可红在这里，也不许「少跑几屏」换来一片 0。
  expect(failures, `普查里有屏没跑成，必须修选择器/对照组而不是放宽判据：\n${failures.join("\n")}`).toEqual([]);

  // 2) 覆盖清单必须逐条对上（防漏 await、防新增屏没登记），且两种 locale 都覆盖。
  expect(
    [...new Set(checked)].sort(),
    "普查覆盖的屏与清单不一致：多半是某处漏了 await、某屏抛错没记进 failures，或新增屏没登记"
  ).toEqual(EXPECTED_CHECKS.slice().sort());
  expect(new Set(reports.map((r) => r.locale)).size, "必须中英两种 locale 都扫到").toBe(2);

  // 3) 四类缺陷桶必须逐屏为 0，且每屏都不许横向出血。样例直接进断言消息，红了一眼就能看到是谁。
  const defects: string[] = [];
  for (const r of reports) {
    const at = `${r.locale}@${r.width}:${r.state}`;
    for (const bucket of ["hardClip", "ellipsisNoTitle", "verticalCut", "overlap"] as const) {
      if (r.report[bucket].n > 0) {
        defects.push(`${at} ${bucket}=${r.report[bucket].n} 样例=${JSON.stringify(r.report[bucket].sample.slice(0, 3))}`);
      }
    }
    if (r.report.docOverflowX > 0) defects.push(`${at} 文档横向出血=${r.report.docOverflowX}px`);
    // 空屏不是「没有缺陷」，是普查没量到东西。真跑读数最低的一屏是 22 个文本节点，5 是留余量的地板。
    if (r.report.nodesScanned < 5) defects.push(`${at} 文本节点只有 ${r.report.nodesScanned}：这屏多半没渲染出来`);
  }
  expect(defects.join("\n"), "文字被切读不到 / 撞车 / 横向出血 / 空屏，必须为 0").toBe("");

  // 4) 防假绿的量地板：取数量级不许塌，正文（代码）确实被排除在普查之外。
  expect(totals.nodes, "文本节点总数太少：多半是某屏没真的加载出来").toBeGreaterThanOrEqual(3200);
  expect(totals.codeSkipped, "正文一个字都没跳过：CODE_SEL 失配，普查会把配置内容当 UI 文字判红").toBeGreaterThan(0);
  //   可达桶是真在起作用的（首跑 576 条，主要来自设置页这类可滚容器）。它归零就意味着口径失效，
  //   下一轮「滚得到的溢出」会全被当成缺陷判红——那是误报，不是质量变好。
  expect(totals.reachableByScroll, "可滚容器兜住的溢出为 0：豁免口径失效了，误报马上会来").toBeGreaterThanOrEqual(20);
});
