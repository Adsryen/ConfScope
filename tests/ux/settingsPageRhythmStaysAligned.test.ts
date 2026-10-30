/**
 * 设置页的排版节奏、左栏滚动行为与「保存」反馈的落点各只许一种长相（轮73 R73-V1..V6 / I1..I3 / P3）。
 *
 * 这一族的每一条都是**真机量出来的**，不是审美投票：它们既不报错也不影响渲染，fireEvent 永远点得到，
 * 只能静态钉。量出来的原缺陷：
 * - V1 左栏八项索引的字号/行高一个字没写，落到 UA 默认的 13.3333px / normal，是全站唯一不走
 *   12/13px 排版体系的导航文字（主侧栏 .side-nav-item 是 13px）。
 * - V2 当前节指示用 --bg-active(#094771) 实心蓝：八项里有一颗比页面标题还抢眼的色块，视线被拽去左栏；
 *   而「我在哪」这件事主导航已经用淡色回答过一次，同屏两种强度的当前位置不该并存。
 * - V3 工作区上限 1080px：1440 窗口下侧栏占 184、可用 1256，右边留 176px 死白，页头仍贴左缘，像没排完版。
 * - V4 节内首行的「去掉重复分隔线」写的是 :first-of-type —— 它要求该元素是**同标签**的首个兄弟，
 *   而每节第一个子元素是 .settings-panel-head（div），于是所有 div 行永远匹配不上。实测 8 节里 5 节
 *   首行顶着一条孤零零的横线（凭据 / 备份 / 数据位置 / 应用更新 / 开发者）。
 * - V5 代理三框被 .search-input 的全站 max-width:220px 压住，列宽却有 258~372px：列越宽留白越大，
 *   标签与输入框右缘对不齐。
 * - V6 主数据文件那一行按「左说明 + 右值」排：350px 的右列里绝对路径断成「-data.json（桥内内存替身）」
 *   这种半截一行，「文件位置」四个字被压成竖排。
 * - I1 左栏自己写了 max-height + overflow-y:auto + overscroll-behavior:contain。指针停在左栏滚 600px：
 *   容器 scrollTop 0 → 0，一格没动（同一手势落在面板上是 0 → 600）——导航是这块页面里面积最大、
 *   最容易被指针压住的区域，滚轮落在它上面就成了死区。
 *   实测推翻过一半解释：删掉这三行后**仍然**是 0 → 0，真因是左栏不是 .settings-panels 的子孙、
 *   祖先链上没有任何可滚容器。所以这一族只钉「CSS 侧不再自己滚动」（必要条件的守卫），
 *   充分条件由 tests/ux/wheelFallbackWiring.test.ts 钉兜底接线，两者缺一都还是死区。
 * - I2 「设置已保存」只画在页头右上角：点「智能对比」里的开关时，反馈出现在被点控件上方约 340px 处，
 *   1.2s 消失——用户读不到「保存」与「我刚点的东西」的因果，于是再点一次（轮72 实测被投诉过）。
 * - I3 720px 窄窗两处横向溢出：忽略版本那一行 scrollWidth 457 / clientWidth 454，代码块 83 / 80。
 * - P3 徽章搬进节内后必须绝对定位（不占布局，否则 scroll-spy 量到的节高与偏移跟着变）且不挡点击。
 *
 * 变异对照（逐条实测过判红，别改成「看着像」）：
 * 1. 往 .settings-rail 基础规则塞回 `overflow-y: auto;` → 「左栏不许自己滚动」红；
 *    把 `font-size: 13px;` 从 .settings-rail-item 删掉 → 排版刻度那条红。
 * 2. .settings-rail-item.active 换回 `var(--bg-active)` → 「当前位置是淡色档」红。
 * 3. .settings-workbench 的宽度上限改回 1080px → 「内容列宽度下限」红。
 * 4. 首行判据退回 `.settings-setting-row:first-of-type` → 「分隔线判据」红。
 * 5. 删掉 `.settings-proxy-grid .search-input` 整条 → 代理框撑满那条红；
 *    删掉 .settings-update-skip 的 flex-wrap → 「窄屏换行不溢出」红。
 * 6. 把 align-items: stretch 塞回 .settings-setting-row.settings-data-file-row → 本守卫红，
 *    同时 classOverridesResolveBySpecificity 也会判窄屏覆盖被吃掉（两条从不同维度钉同一件事）。
 * 7. 徽章类删掉 pointer-events: none → 「徽章不占布局也不吃点击」红；
 *    把某个 savedFlagFor("settings-x") 调用删掉 → 「八节各有就近徽章」计数红；
 *    把它挪到别节之后 → 「徽章是这一节的第一个子节点」红。
 * 8. 调用点退回 update({ compare: { ...settings.compare, ... } }) → 「补丁不许展开整段」红。
 * 9. locales 里删掉 settings.railAriaLabel → 「左栏必须有可访问名」红。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT, flattenLocale, loadLocale, readScannedSource } from "./scanUtils";

const SETTINGS = "src/components/SettingsView.tsx";
const STYLES = "src/styles.css";
const KEYBOARD_ACCESS_GUARD = "tests/ux/scrollableReadOnlyRegionsNeedKeyboardAccess.test.ts";

const CSS = readScannedSource(STYLES);
const view = readScannedSource(SETTINGS);
const keyboardGuard = readFileSync(join(PROJECT_ROOT, KEYBOARD_ACCESS_GUARD), "utf8");

const SECTION_IDS = [
  "settings-general",
  "settings-network",
  "settings-compare",
  "settings-credentials",
  "settings-backup",
  "settings-data-locations",
  "settings-update",
  "settings-developer",
];

/** 同一个选择器在 CSS 里可能既写在顶层又写在 @media 里：按缩进分开取，别把两者混成一份。 */
function rulesFor(css: string, selector: string): Array<{ indent: number; body: string }> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found: Array<{ indent: number; body: string }> = [];
  const re = new RegExp(`^([ \\t]*)${escaped} \\{\\n([^}]*)\\}`, "gm");
  let match = re.exec(css);
  while (match) {
    found.push({ indent: match[1].length, body: match[2] });
    match = re.exec(css);
  }
  return found;
}

/** 顶层（行首无缩进）那一条规则体；缺失或多条返回 null，交给调用方判红。 */
function soleTopLevelBody(css: string, selector: string): string | null {
  const hits = rulesFor(css, selector).filter((rule) => rule.indent === 0);
  return hits.length === 1 ? hits[0].body : null;
}

/** 取顶层唯一规则体，缺失即红——写坏选择器名等于把钉子从文档里拔掉。 */
function topLevelRule(css: string, selector: string): string {
  const body = soleTopLevelBody(css, selector);
  expect(body, `${selector} 的顶层规则必须恰好一条（改名或复制都会让这些钉子失去对象）`).not.toBeNull();
  return body as string;
}

/** 左栏自己滚 = 滚轮死区。返回一切「让左栏接管滚动」的声明。 */
function railScrollTraps(css: string): string[] {
  const body = soleTopLevelBody(css, ".settings-rail");
  if (body === null) return [".settings-rail 顶层规则不唯一"];
  return ["overflow", "max-height", "overscroll-behavior"].filter((prop) => new RegExp(`(^|[\\s;])${prop}[a-z-]*\\s*:`, "m").test(body));
}

/** 左栏文字的排版刻度：漏写任何一条都会掉回 UA 默认值（13.3333px / normal）。 */
function railTypeScaleGaps(css: string): string[] {
  const body = soleTopLevelBody(css, ".settings-rail-item");
  if (body === null) return [".settings-rail-item 顶层规则不唯一"];
  const required: Array<[string, RegExp]> = [
    ["font-size: 13px", /font-size:\s*13px;/],
    ["line-height: 1.4", /line-height:\s*1\.4;/],
    ["min-height: 32px", /min-height:\s*32px;/],
  ];
  return required.filter(([, pattern]) => !pattern.test(body)).map(([label]) => label);
}

/**
 * 主数据文件那一行若在父级声明 align-items，就会以 (0,2,0) 的特异度吃掉
 * @media (max-width: 980px) 里 .settings-setting-row { align-items: flex-start } 这条全站窄屏口径
 * ——守卫 classOverridesResolveBySpecificity 从顺序维度钉它，本条从「该由谁声明」维度钉它。
 */
function dataFileRowMediaTheft(css: string): string[] {
  const row = soleTopLevelBody(css, ".settings-setting-row.settings-data-file-row");
  if (row === null) return [".settings-setting-row.settings-data-file-row 顶层规则不唯一"];
  const mediaNarrow = rulesFor(css, ".settings-setting-row").some((rule) => rule.indent > 0 && /align-items/.test(rule.body));
  const childStretches = rulesFor(css, ".settings-setting-row.settings-data-file-row > div").some((rule) =>
    /align-self:\s*stretch/.test(rule.body)
  );
  if (/align-items/.test(row)) return mediaNarrow ? ["父级 align-items 吃掉了窄屏覆盖"] : ["父级多写了一条没人竞争的 align-items"];
  if (!childStretches) return ["堆叠后子块要占满卡片宽度，缺 : > div { align-self: stretch }"];
  return [];
}

/** 节内首行的分隔线判据：必须按「紧跟节标题」判定，:first-of-type 在同标签兄弟里根本轮不到。 */
function separatorJudgement(css: string): { compound: boolean; legacyFirstOfType: boolean } {
  return {
    compound: /(^|\n)\.settings-panel-head \+ \.settings-setting-row:not\(\.settings-danger-zone\) \{\n\s*border-top: none;/.test(css),
    legacyFirstOfType: /\.settings-setting-row:first-of-type/.test(css),
  };
}

describe("设置页排版节奏与就近反馈（轮73 R73）", () => {
  it("扫描口径不是空转：CSS 与组件都真的读到了", () => {
    expect(CSS.length).toBeGreaterThan(1000);
    expect(SECTION_IDS).toHaveLength(8);
    expect(view.match(/<section id="settings-[a-z-]+"/g) ?? []).toHaveLength(8);
  });

  it("左栏不许自己滚动，也不许在键盘守卫里留僵尸登记（I1）", () => {
    expect(railScrollTraps(CSS), "左栏一旦自己滚动就是滚轮死区（实测滚 600px 一格不动）").toEqual([]);
    // 自检：塞回 overflow-y 必须判红（探测器吃整份 CSS，变异跑的是真实文档）
    const mutation = CSS.replace("\n.settings-rail {\n  position: sticky;", "\n.settings-rail {\n  position: sticky;\n  overflow-y: auto;");
    expect(mutation, "变异锚点失效：.settings-rail 结构变了要一起改这里").not.toBe(CSS);
    expect(railScrollTraps(mutation).length, "探测器失去牙齿：overflow-y 加回来必须被抓到").toBeGreaterThan(0);
    // CSS 不再滚动 → 遗留名单里的登记也要一起撤，留着等于告诉下一条守卫「这里可以滚动」
    expect(keyboardGuard, "settings-rail 已不再是滚动容器，LEGACY_NON_PRE_CLASSES 里的登记必须删掉").not.toContain('"settings-rail"');
  });

  it("左栏文字走全站排版刻度，命中区有下限（V1）", () => {
    expect(railTypeScaleGaps(CSS), "字号漏写会落到 UA 的 13.3333px / normal，是全站唯一的例外").toEqual([]);
    // 自检：删掉字号必须判红
    const mutation = CSS.replace("  font-size: 13px;\n  line-height: 1.4;\n  cursor: pointer;", "  cursor: pointer;");
    expect(mutation, "变异锚点失效：.settings-rail-item 的排版声明变了要一起改这里").not.toBe(CSS);
    expect(railTypeScaleGaps(mutation), "探测器失去牙齿：删掉 font-size 必须被抓到").toContain("font-size: 13px");
  });

  it("当前位置指示是淡色档，与主导航同一强度（V2）", () => {
    const body = topLevelRule(CSS, ".settings-rail-item.active");
    expect(body, "当前节指示必须与侧栏 .side-nav-item.active 同色同透明度").toContain("rgba(0, 122, 204, 0.15)");
    expect(body, "实心蓝是全站唯一的，八项索引里不该有一颗比页面标题还抢眼的色块").not.toMatch(/background:\s*var\(--bg-active\)/);
    const hover = topLevelRule(CSS, ".settings-rail-item.active:hover,\n.settings-rail-item.active:focus-visible");
    expect(hover, "悬停时位置指示只能变深，不能整块消失").toContain("rgba(0, 122, 204, 0.22)");
  });

  it("工作区随窗口伸缩，宽度上限不许回来（V3 / P3 / 轮142 D2）", () => {
    const body = topLevelRule(CSS, ".settings-workbench");
    expect(body, "轮142 D2：用户要求右区随窗口宽度，工作区必须铺满所在列").toMatch(/width:\s*100%;/);
    // 自检：把旧的写死上限改回来必须判红
    const regression = topLevelRule(CSS, ".settings-workbench").replace("width: 100%;", "width: min(1200px, 100%);");
    expect(/width:\s*100%;/.test(regression), "探测器失去牙齿：写死上限回来必须被抓到").toBe(false);
    expect(body, "徽章绝对定位的锚点：工作区必须是 relative").toContain("position: relative;");
    expect(body, "不做居中——.page-header 是全站左对齐页头").not.toMatch(/margin:\s*0 auto|justify-content:\s*center/);
  });

  it("节内首行分隔线按「紧跟节标题」判定，:first-of-type 不许回来（V4）", () => {
    const judgement = separatorJudgement(CSS);
    expect(judgement.compound, "判据缺失：首行的分隔线要靠 .settings-panel-head + 这个兄弟选择器").toBe(true);
    expect(judgement.legacyFirstOfType, ":first-of-type 要求同标签首个兄弟，每节首个子元素是 div 的节标题，永远轮不到").toBe(false);
    // 自检：退回旧判据必须判红
    const weakened = separatorJudgement(CSS.replace(".settings-panel-head + .settings-setting-row:not(.settings-danger-zone)", ".settings-setting-row:first-of-type"));
    expect(weakened.compound, "探测器失去牙齿：退回 :first-of-type 必须判红").toBe(false);
    expect(weakened.legacyFirstOfType, "探测器失去牙齿：退回 :first-of-type 必须判红").toBe(true);
  });

  it("代理三框撑满所在列，只在 .settings-proxy-grid 里放开上限（V5）", () => {
    const body = topLevelRule(CSS, ".settings-proxy-grid .search-input");
    expect(body).toContain("max-width: none;");
    expect(body, "只放开宽度不撑满，标签与输入框右缘还是对不齐").toContain("width: 100%;");
    expect(topLevelRule(CSS, ".search-input"), "不许动全站搜索框的 220px 节奏，那是工具栏的刻度").toContain("max-width: 220px;");
  });

  it("窄屏靠换行让路，不靠溢出（I3）", () => {
    const body = topLevelRule(CSS, ".settings-update-skip");
    expect(body, "版本号 + 按钮是不可收缩的整体，720px 实测溢出 3px").toContain("flex-wrap: wrap;");
    expect(body).toContain("justify-content: flex-end;");
    const code = topLevelRule(CSS, ".settings-update-skip code");
    expect(code, "长版本号（未来带构建号）要能在本块内断开").toContain("min-width: 0;");
    expect(code).toContain("overflow-wrap: anywhere;");
  });

  it("主数据文件行改堆叠，靠子元素 align-self 而不是抢媒体查询的活（V6）", () => {
    expect(dataFileRowMediaTheft(CSS), "堆叠只许由子元素的 align-self 承担，父级 align-items 会吃掉窄屏覆盖").toEqual([]);
    const child = topLevelRule(CSS, ".settings-setting-row.settings-data-file-row > div");
    expect(child, "路径 code 不带上 min-width:0 就收缩不了，长路径照样溢出").toContain("min-width: 0;");
    expect(topLevelRule(CSS, ".settings-setting-row.settings-data-file-row")).toContain("flex-direction: column;");
    // 自检：把 align-items 塞回父级必须判红
    const mutation = CSS.replace("\n.settings-setting-row.settings-data-file-row {\n  flex-direction: column;", "\n.settings-setting-row.settings-data-file-row {\n  flex-direction: column;\n  align-items: stretch;");
    expect(mutation, "变异锚点失效：这一行的规则体变了要一起改这里").not.toBe(CSS);
    expect(dataFileRowMediaTheft(mutation), "探测器失去牙齿：父级恢复 align-items 必须被抓到").toEqual(["父级 align-items 吃掉了窄屏覆盖"]);
  });

  it("保存徽章不占布局也不吃点击（P3 / I2）", () => {
    expect(topLevelRule(CSS, ".settings-panel"), "就近徽章的定位锚点：每一节必须是 relative").toContain("position: relative;");
    for (const cls of [".settings-panel-flag", ".settings-saved-flag"]) {
      const body = topLevelRule(CSS, cls);
      expect(body, `${cls} 必须绝对定位：占布局会改动 scroll-spy 量到的节高与偏移`).toContain("position: absolute;");
      expect(body, `${cls} 必须不吃点击：它盖在节标题那一行上`).toContain("pointer-events: none;");
      expect(body).toContain("z-index:");
    }
    expect(view.match(/className="test-msg ok settings-panel-flag"/g) ?? [], "节内徽章在组件里只能有一处模板").toHaveLength(1);
    expect(view.match(/className="test-msg ok settings-saved-flag"/g) ?? [], "工作区兜底徽章只能有一处模板").toHaveLength(1);
  });

  it("八节各有就近徽章，且是自己那一节的第一个子节点（I2）", () => {
    const calls = view.match(/savedFlagFor\("settings-[a-z-]+"\)/g) ?? [];
    expect(calls, "每一节都要有自己的徽章调用点，少一节就退回「页头远处闪一下」").toHaveLength(8);
    expect(new Set(calls).size, "八节八个徽章，id 不许重复").toBe(8);
    SECTION_IDS.forEach((id) => {
      const tag = view.indexOf(`<section id="${id}"`);
      const flag = view.indexOf(`savedFlagFor("${id}")`);
      expect(tag, `${id} 缺小节`).toBeGreaterThanOrEqual(0);
      expect(flag, `${id} 的就近徽章缺失`).toBeGreaterThan(tag);
      expect(flag - tag, `${id} 的徽章必须紧跟开标签：跑到别节里去就近就是骗人`).toBeLessThan(200);
    });
    // 自检：删掉一处调用必须让计数红
    const oneFewer = view.replace(`savedFlagFor("settings-compare")`, "null");
    expect((oneFewer.match(/savedFlagFor\("settings-[a-z-]+"\)/g) ?? []).length, "探测器失去牙齿：少一节必须能被数出来").toBe(7);
  });

  it("徽章不再挂在页头，页头只留标题（I2）", () => {
    const header = /<div className="page-header">([\s\S]*?)<\/div>\s*\n\s*<div className="settings-workbench"/.exec(view);
    expect(header, "页头结构变了，这条钉子要跟着重写").not.toBeNull();
    expect(header?.[0] ?? "", "页头里再画一份徽章 = 同一句「设置已保存」被念两遍").not.toContain("test-msg ok");
    expect(header?.[0] ?? "").not.toContain("saved");
  });

  it("补丁调用点只给要改的字段，不许展开整段（I4）", () => {
    const stale = view
      .split("\n")
      .map((line, index) => ({ line, num: index + 1 }))
      .filter(({ line }) => line.includes("update({") && line.includes("...settings."))
      .map(({ line, num }) => `${SETTINGS}:${num}: ${line.trim()}`);
    expect(stale, `展开的是渲染闭包里那份 settings，连续两次写盘会互相吃掉兄弟字段：\n${stale.join("\n")}`).toEqual([]);
    expect(
      view.match(/update\(\{.*\}, "settings-[a-z-]+"\)/g)?.length,
      "四处落盘调用（代理 / 两个对比开关 / 恢复提醒）都要点名所在节，徽章才知道该落在哪"
    ).toBe(4);
    // 自检：退回整段展开必须判红
    const mutation = `${view}\nconst bad = () => update({ compare: { ...settings.compare, sortNamespaces: true } }, "settings-compare");\n`;
    expect(mutation.split("\n").some((line) => line.includes("update({") && line.includes("...settings.")), "探测器失去牙齿：退回展开写法必须被抓到").toBe(true);
  });

  it("方向键漫游只有一个实现，组件侧只许接线（P1）", () => {
    expect(view, "左栏没接方向键漫游：八项索引只能一颗一颗 Tab 过去").toContain("onKeyDown={moveRailFocus}");
    expect(view, "组件里不许留第二份 focus 交接实现（见 railJumpFocusesTargetSection 的口径）").not.toMatch(/onRailKeyDown|\.focus\(/);
    const spy = readScannedSource("src/lib/sectionSpy.ts");
    expect(spy, "moveRailFocus 是实现所在，组件只许调用").toMatch(/export function moveRailFocus\(/);
    expect(spy, "只挪焦点不跳章节：跳章节是 Enter/Space 的事").not.toContain("jumpToSection(");
  });

  it("左栏必须有可访问名，中英文都齐（P2）", () => {
    for (const file of ["zh-CN.json", "en-US.json"]) {
      const flat = flattenLocale(loadLocale(file));
      expect(flat["settings.railAriaLabel"], `${file} 缺 settings.railAriaLabel：读屏念不出这块索引是什么`).toBeTruthy();
    }
    expect(view, "aside 没挂 aria-label，左栏对读屏是一串无名按钮").toContain('aria-label={t("settings.railAriaLabel")}');
  });
});
