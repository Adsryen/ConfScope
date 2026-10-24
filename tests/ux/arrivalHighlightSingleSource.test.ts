/**
 * 「你到的就是这块」只许一条时间线、一份实现（轮74 D2）。
 *
 * 真机修前读数：设置页点「检查更新」→ 关于页整页一动不动，落地看到的是 logo 与版本号，
 * 「应用更新」那张卡得自己在满页信息里再找一遍；而对比页 stepper 回退早就有滚动 + 闪烁，
 * 算式与类名却留在 DiffView 内部。第二个消费点出现时，只有两种下场：抄一份（两套实现），
 * 或者发明第二种高亮（两套视觉语言）——本轮 A 组缺陷刚为「两套语言」付过一次账。
 *
 * 口径：
 * 1. 类名只有一个出口 `ARRIVE_FLASH_CLASS`，组件里不许再出现字面量类名；
 * 2. 滚动 + 闪烁的算式只在 src/lib/arriveFlash.ts，组件只许调 revealArrival；
 * 3. CSS 里类名与 keyframes 同名，且时长常量与 ARRIVE_FLASH_MS 对得上（改了 CSS 忘了改常量＝类名永不清理）；
 * 4. 关于页那一节必须是合法的焦点落点（tabIndex={-1} + aria-labelledby + 被 ref 接住），
 *    并且 App 侧消费完要清标记 —— 否则从导航栏进关于页也会白闪；
 * 5. 页内回退（对比页）不许抢焦点：抢走的是用户正在填的表单光标；
 * 6. 落地页的形状不许与来源页断崖：那颗「检查更新」在修前被竖排容器拉成 784px 整行宽（全站唯一），
 *    刚在设置页按下的是一颗 62px 的小 ghost，跳过去变成一条空心的横杠。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ARRIVE_FLASH_CLASS, ARRIVE_FLASH_MS } from "../../src/lib/arriveFlash";
import { PROJECT_ROOT, readScannedSource, sourceFiles } from "./scanUtils";

const LIB = "src/lib/arriveFlash.ts";
const ABOUT = "src/components/About.tsx";
const DIFFVIEW = "src/components/DiffView.tsx";
const APP = "src/App.tsx";
const CSS = readFileSync(join(PROJECT_ROOT, "src/styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));

/** 组件里手写到达类名的地方（引号字面量，不含 lib 自己）。 */
function hardcodedClassSites(): string[] {
  return sourceFiles()
    .filter((file) => file !== LIB)
    .filter((file) => readScannedSource(file).includes(`"${ARRIVE_FLASH_CLASS}"`))
    .map((file) => file);
}

describe("到达高亮单一实现（轮74 D2）", () => {
  it("扫描口径不是空转：两个消费点都真的在用共享实现", () => {
    expect(readScannedSource(ABOUT)).toContain("revealArrival(");
    expect(readScannedSource(DIFFVIEW)).toContain("revealArrival(");
    expect(hardcodedClassSites(), "组件里又出现了手写的到达类名").toEqual([]);
  });

  it("类名与 keyframes 只在 lib 里定义一次，CSS 与它同名", () => {
    expect(ARRIVE_FLASH_CLASS).toBe("arrive-flash");
    expect(CSS).toContain(`@keyframes ${ARRIVE_FLASH_CLASS} {`);
    expect(CSS).toContain(`.${ARRIVE_FLASH_CLASS} {`);
    // 旧名字不许以任何形式复活：DiffView 时代的类名一旦回来，就是第二条时间线的起点
    expect(CSS).not.toContain("workflow-flash");
    expect(readScannedSource(DIFFVIEW)).not.toContain("workflow-flash");
  });

  it("CSS 动画时长与 lib 的摘类常量对得上（对不上＝类名挂在元素上过夜）", () => {
    const rule = CSS.match(new RegExp(`\\.${ARRIVE_FLASH_CLASS} \\{([^}]*)\\}`));
    expect(rule, "找不到 .arrive-flash 规则").not.toBeNull();
    const seconds = /animation:\s*[\w-]+\s+([\d.]+)s/.exec(rule![1]);
    expect(seconds, ".arrive-flash 没写动画时长").not.toBeNull();
    const ms = Number(seconds![1]) * 1000;
    expect(ARRIVE_FLASH_MS, "摘类延时必须 ≥ 动画时长，且只留一点余量").toBeGreaterThanOrEqual(ms);
    expect(ARRIVE_FLASH_MS - ms).toBeLessThanOrEqual(200);
  });

  it("lib 自己守住三条底线：re-flow 重播、卸载撤销、滚动按偏好降级", () => {
    const lib = readScannedSource(LIB);
    expect(lib, "少了强制 reflow，连续带到同一块时动画不会重播").toMatch(/void target\.offsetWidth;/);
    expect(lib, "摘类的定时器没有撤销出口，卸载后仍会摸到已离场的节点").toMatch(/return \(\) => \{\s*window\.clearTimeout\(timer\);/);
    expect(lib, "滚动行为必须问 lib/motion，减少动态效果时不能照滑").toMatch(/behavior: scrollBehavior\(\)/);
    expect(lib, "focus 的 preventScroll 丢了：浏览器会在算好的位置上再滚一次").toMatch(/focus\(\{ preventScroll: true \}\)/);
  });

  it("关于页「应用更新」是合法落点，且标记消费完由 App 清掉", () => {
    const about = readScannedSource(ABOUT);
    expect(about, "关于页那一节没有 ref，到达高亮没有目标").toMatch(/ref=\{updateSectionRef\}/);
    expect(about, "落点没有 id，aria-labelledby 会指向空气").toMatch(/<h3 id="about-update-title">/);
    expect(about, "落点不能被设为焦点目标（缺 tabIndex={-1}）").toMatch(/tabIndex=\{-1\}/);
    expect(about, "焦点过去读屏念不出这块叫什么").toMatch(/aria-labelledby="about-update-title"/);
    expect(about, "到达时没交焦点：键盘用户仍停在来源页那颗按钮上").toMatch(/revealArrival\(target, \{ focus: true \}\)/);
    // 撤销函数存 ref 而不是挂 effect cleanup：消费标记会让 arriveAtUpdate 翻转，
    // cleanup 会在动画播到一半时把类名摘掉。
    expect(about, "撤销函数挂到了 effect cleanup 上：消费标记会把闪烁掐在半路").toMatch(/cancelArriveFlashRef\.current = revealArrival/);
    expect(about).toMatch(/onArriveConsumed\?\.\(\);/);
    const app = readScannedSource(APP);
    expect(app, "App 没有清标记，下次进关于页会白闪").toMatch(/onArriveConsumed=\{\(\) => setAboutArriveAtUpdate\(false\)\}/);
  });

  it("页内回退不抢焦点：只有跨页落地才交焦点", () => {
    const diffView = readScannedSource(DIFFVIEW);
    expect(diffView, "对比页开始抢焦点了：会把用户正在填的表单光标带走").not.toMatch(/revealArrival\([^)]*focus/);
  });

  it("关于页的动作按钮按内容收宽，不再被竖排容器拉成整行", () => {
    const rule = CSS.match(/\.update-body > \.btn \{([^}]*)\}/);
    expect(rule, "缺少 .update-body > .btn 规则：flex 列的 align-items 默认 stretch，孤零零的一颗按钮会被拉成整行宽").not.toBeNull();
    expect(rule![1], "收回宽度的口径不是 align-self：面板要铺满，只有按钮该按内容收").toMatch(/align-self:\s*flex-start/);
    // 防永真：面板仍在 stretch 下铺满，别有人改成 .update-body { align-items: flex-start }
    const body = CSS.match(/\.update-body \{([^}]*)\}/);
    expect(body, "找不到 .update-body 规则").not.toBeNull();
    expect(body![1], "整列改成 flex-start 会把进度条与交接面板一起缩成一条").not.toMatch(/align-items/);
  });
});
