/**
 * 设置页左栏跳章节必须把焦点交给目标那一节，且交接方式是「只给焦点、不再滚一次」（轮67 R67-WP3b）。
 *
 * 量出来的原缺陷：7（现 8）个 `<section>` 的 `tabIndex` 与 `aria-labelledby` 全为 null，
 * 点完索引焦点仍留在左栏按钮上，读屏只念出按钮自己的名字——用户不知道自己被带到了哪一节。
 *
 * 为什么这条要落静态守卫而不是只靠组件用例：
 * - 焦点交接本身组件用例能测（`document.activeElement`），但 `preventScroll` 测不出来——
 *   jsdom 没有布局，`focus()` 到底会不会二次滚动无从判定。而少了这个参数，
 *   浏览器会把章节顶到**视口**上缘，与 `container.scrollTo` 算出的容器内偏移互相打架
 *   （章节头被 sticky 页头盖住，看起来像跳过头了）。
 * - 章节多挂 `tabIndex={-1}` 也一样看不见：漏掉的那一节在真机上点索引 = 焦点原地不动。
 */
import { describe, expect, it } from "vitest";
import { readScannedSource } from "./scanUtils";

const settingsView = readScannedSource("src/components/SettingsView.tsx");

/** 逐个 `<section id="settings-*">` 开标签，带回它的属性文本。 */
function sectionTags(): Array<{ id: string; tag: string }> {
  return Array.from(settingsView.matchAll(/<section id="(settings-[a-z-]+)"([^>]*)>/g)).map((match) => ({ id: match[1], tag: match[2] }));
}

describe("设置页索引的焦点交接（轮67 R67-WP3b）", () => {
  it("扫描口径不是空转：确实扫到 8 个章节", () => {
    expect(sectionTags().length).toBe(8);
  });

  it("每一节都可作为焦点目标，并把标题关联到自己身上", () => {
    sectionTags().forEach(({ id, tag }) => {
      expect(tag, `${id} 不能被设为焦点目标（缺 tabIndex={-1}）`).toContain("tabIndex={-1}");
      expect(tag, `${id} 没有标题关联，焦点过去读屏念不出章节名`).toContain(`aria-labelledby="${id}-title"`);
      expect(settingsView, `${id} 的标题没挂 id，aria-labelledby 会指向空气`).toContain(`<h4 id="${id}-title">`);
    });
  });

  it("跳转只交焦点不再滚一次，且 scrollTo 缺实现时只放弃滚动", () => {
    expect(settingsView, "焦点交接丢了：点索引后读屏仍停在左栏按钮").toMatch(/target\.focus\(\{\s*preventScroll:\s*true\s*\}\)/);
    expect(settingsView, "写了 focus 但没带 preventScroll：浏览器会在我们算好的位置上再滚一次").not.toMatch(/target\.focus\(\s*\)/);
    expect(settingsView, "老 WebView 没有 Element.prototype.scrollTo，未判空会让整次跳转抛错").toMatch(
      /typeof container\.scrollTo === "function"/
    );
  });
});
