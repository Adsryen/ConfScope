/**
 * 设置页左栏的「当前节」指示只有一个事实源，且顺序与 DOM 一致（轮67 R67-WP3a）。
 *
 * 真机读数：点第 4 项后 scrollTop 0→536，8 项的 `aria-current` 全 null、类名与配色一字未变，
 * 滚到底也一样——索引只回答「点了会去哪」，从不回答「现在在哪」。
 *
 * 钉这四条的理由：
 * - 顺序：判定规则是「最后一个越过判定线的节」，靠的正是 nav 表与 DOM 同序。加了新章节忘了插表，
 *   或者表里换了次序，高亮会稳定地指错一格，而这种错位在单测里看不出来（用例各测各的）。
 * - 单一来源：`aria-current` 与 `.active` 若由两处表达式给（比如再存一个 useState 手改），
 *   就会出现「样式在 A 项、读屏在 B 项」。
 * - 判定规则不许有第二份实现（IntersectionObserver 或组件里自算偏移），
 *   两套判据将来必然互相打架，这也是本仓对滚动几何的一贯口径。
 * - 钉住不许挂在「能不能滚」的判断里：不能滚的旧 WebView 仍要答得出「你在看哪一节」。
 */
import { describe, expect, it } from "vitest";
import { loadLocale, readScannedSource } from "./scanUtils";

const settingsView = readScannedSource("src/components/SettingsView.tsx");
const sectionSpy = readScannedSource("src/lib/sectionSpy.ts");

/** SECTION_NAV 表里的 id，按书写顺序。 */
function navIds(): string[] {
  const block = /const SECTION_NAV[^=]*= \[([\s\S]*?)\];/.exec(settingsView);
  expect(block, "SettingsView 里没有 SECTION_NAV 表").not.toBeNull();
  return Array.from(block![1].matchAll(/id: "(settings-[a-z-]+)"/g), (m) => m[1]);
}

/** JSX 里 <section id="settings-*"> 的出现顺序。 */
function domIds(): string[] {
  return Array.from(settingsView.matchAll(/<section id="(settings-[a-z-]+)"/g), (m) => m[1]);
}

describe("设置页左栏的当前节指示（轮67 R67-WP3a）", () => {
  it("索引表与章节 DOM 同序同集合，逐项都有文案键", () => {
    const ids = navIds();
    expect(ids.length, "扫描口径不能空转").toBeGreaterThanOrEqual(8);
    expect(domIds(), "索引表顺序与章节顺序不一致，高亮会稳定指错一格").toEqual(ids);

    const labels = Array.from(settingsView.matchAll(/labelKey: "(settings\.[A-Za-z]+)"/g), (m) => m[1]);
    expect(labels.length).toBe(ids.length);
    const zh = loadLocale("zh-CN.json");
    const en = loadLocale("en-US.json");
    labels.forEach((key) => {
      expect(zh[key], `索引项 ${key} 缺中文`).toBeTruthy();
      expect(en[key], `索引项 ${key} 缺英文`).toBeTruthy();
    });
  });

  it("aria-current 与 .active 都只从 activeId 派生，不给第二份状态留位置", () => {
    expect(settingsView).toContain('{activeId === item.id ? " active" : ""}');
    expect(settingsView).toContain('aria-current={activeId === item.id ? "true" : undefined}');
    expect(settingsView, "自己再存一份当前节状态就会出现「样式在 A、读屏在 B」").not.toMatch(/useState[^;]*activeSection/i);
  });

  it("判定规则只有一份，组件侧不许另起 IntersectionObserver 或自算偏移", () => {
    expect(settingsView, "组件里另写一套位置判定，两套判据迟早互相打架").not.toContain("IntersectionObserver");
    expect(sectionSpy).toContain("export const SECTION_SPY_THRESHOLD");
    expect(sectionSpy).toMatch(/if \(offset <= threshold\) active = ids\[i\]/);
    expect(sectionSpy, "取不到矩形的那一节会被当成 0 抢走当前节").toContain("Number.isFinite(offset)");
  });

  it("钉住与滚动解耦，用户自己动的手才交还位置判定", () => {
    const pinAt = sectionSpy.indexOf("pinnedRef.current = id;");
    const scrollGuardAt = sectionSpy.indexOf('typeof container.scrollTo === "function"');
    expect(pinAt, "jumpToSection 没钉住当前节，滚到底时高亮会指倒数第二节").toBeGreaterThan(-1);
    expect(scrollGuardAt, "少了 scrollTo 判空，老 WebView 一点索引就抛错").toBeGreaterThan(-1);
    // 钉住必须走在能力探测之前：把它塞进 if 里，老 WebView 只是不能滚，却连「你在看这节」都答不出
    expect(pinAt).toBeLessThan(scrollGuardAt);
    ["wheel", "touchstart", "keydown"].forEach((type) => {
      expect(sectionSpy, `少了 ${type}：用户自己滚动后高亮赖在点过的那一节`).toContain(`"${type}"`);
    });
    expect(sectionSpy, "输入框里的方向键会被当成滚动页面，打字时高亮乱跳").toContain("isEditableTarget(event.target)");
  });
});
