// 设置页左栏索引的「我在哪一节」（轮67 R67-WP3a）。
//
// 量出来的原缺陷：左栏 8 个按钮点完只是滚了一段，`aria-current` 恒为 null、
// 样式一字未变——用户滚到面板中间就再也答不出「现在在看哪一节」，
// 而这块索引是设置页唯一的导航（内容 2762px，一屏只有 698px）。
//
// 为什么按位置量，不用 IntersectionObserver：
// 1. IO 要挑 `rootMargin` 造一条判定带，带子比某一节还高时那节整段都不 intersect，
//    当前节就出现「无人认领」的空档；带子太窄又会在两节之间漏判。参数是猜的。
// 2. IO 回调是异步的：点完索引到回调落地中间有一帧空白，高亮要么慢半拍要么闪一下。
// 3. 判定要能单测。IO 在 jsdom 里得整体伪造，测的是我写的 mock；
//    而「一串偏移量 → 当前节」是纯函数，喂数字就能验，桩掉的只有取矩形那一层。
// 滚动事件本身按帧派发（浏览器不会在一次滚动里高频触发），所以同步量矩形不必再套一层 rAF。
//
// 「点击锁定」是必需品而不是调味：滚到底时最后一节的顶永远够不到判定线，
// 纯按位置判会显示倒数第二节——用户明确点了「开发者」，高亮却回答「你在看数据位置」。
// 所以点索引后把高亮钉在点的那一节，直到用户**自己**滚动（滚轮 / 触摸 / 键盘）才交还给位置判定。

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { scrollBehavior } from "./motion";

/** 判定容差：章节顶缘在容器上缘下方这么多像素内仍算「正在这节」。0 是精确对齐，留点余量给亚像素与上边距。 */
export const SECTION_SPY_THRESHOLD = 24;

/** 这些键会让容器自己滚动（在输入框里打字不算，见 isEditableTarget）。 */
export const SECTION_SPY_SCROLL_KEYS = ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"];

/**
 * 从各节相对容器上缘的偏移里挑当前节：取**最后一个**已越过判定线的节，一个都没越过时返回 null。
 *
 * @param ids 章节 id，顺序必须是文档顺序（自上而下）
 * @param offsets 与 ids 一一对应的偏移（px，视口坐标相减的结果）；取不到矩形传 NaN，会被跳过
 */
export function pickActiveSectionId(ids: readonly string[], offsets: readonly number[], threshold = SECTION_SPY_THRESHOLD): string | null {
  let active: string | null = null;
  for (let i = 0; i < ids.length; i += 1) {
    const offset = offsets[i];
    if (!Number.isFinite(offset)) continue;
    if (offset <= threshold) active = ids[i];
  }
  return active;
}

/** 事件目标是不是正在接收输入的控件：这些控件里的方向键/Home/End 动的是光标，不是滚动条。 */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  // isContentEditable 在 jsdom 与个别老 WebView 里恒为 false，属性才是事实源；两条都认。
  const contentEditable = el.getAttribute("contenteditable");
  if (el.isContentEditable || (contentEditable !== null && contentEditable !== "false")) return true;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

export interface SectionSpyResult {
  /** 当前章节 id；一个都判不出来时为 null（左栏此时不带 aria-current）。 */
  activeId: string | null;
  /** 点索引：滚过去 + 交焦点 + 把高亮钉住（几何与焦点交接见 railJumpFocusesTargetSection 的口径）。 */
  jumpToSection: (id: string) => void;
}

/**
 * 把左栏索引与章节容器的滚动状态绑在一起。
 *
 * @param containerRef 滚动容器（`.settings-panels`）
 * @param ids 章节 id，文档顺序；调用方每次渲染给同一份常量数组即可，内部按 join 结果重订阅
 */
export function useSectionSpy(containerRef: RefObject<HTMLElement | null>, ids: readonly string[]): SectionSpyResult {
  const idsKey = ids.join("|");
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const [activeId, setActiveId] = useState<string | null>(ids[0] ?? null);
  const pinnedRef = useRef<string | null>(null);

  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const containerTop = container.getBoundingClientRect().top;
    const offsets = idsRef.current.map((id) => {
      const el = document.getElementById(id);
      return el ? el.getBoundingClientRect().top - containerTop : Number.NaN;
    });
    const next = pickActiveSectionId(idsRef.current, offsets);
    if (next) setActiveId(next);
  }, [containerRef]);

  useLayoutEffect(() => {
    measure();
  }, [measure, idsKey]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onScroll = () => {
      if (pinnedRef.current !== null) return;
      measure();
    };
    // 用户亲自动了手，位置判定就该接管：这三种是「我自己滚」的唯一信号
    const release = () => {
      if (pinnedRef.current === null) return;
      pinnedRef.current = null;
      measure();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!SECTION_SPY_SCROLL_KEYS.includes(event.key)) return;
      if (isEditableTarget(event.target)) return;
      release();
    };
    const onResize = () => {
      if (pinnedRef.current === null) measure();
    };
    container.addEventListener("scroll", onScroll);
    container.addEventListener("wheel", release, { passive: true });
    container.addEventListener("touchstart", release, { passive: true });
    container.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    return () => {
      container.removeEventListener("scroll", onScroll);
      container.removeEventListener("wheel", release);
      container.removeEventListener("touchstart", release);
      container.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    };
  }, [containerRef, measure, idsKey]);

  const jumpToSection = useCallback(
    (id: string) => {
      const container = containerRef.current;
      const target = document.getElementById(id);
      if (!container || !target) return;
      pinnedRef.current = id;
      setActiveId(id);
      const containerTop = container.getBoundingClientRect().top;
      const targetTop = target.getBoundingClientRect().top;
      // 老 WebView 没有 Element.prototype.scrollTo：缺它也只放弃滚动，焦点交接照做。
      if (typeof container.scrollTo === "function") {
        container.scrollTo({
          top: container.scrollTop + targetTop - containerTop,
          behavior: scrollBehavior(),
        });
      }
      // 焦点交给目标章节：点索引后读屏要念出章节名，Tab 也从这一节继续，而不是留在左栏按钮上。
      // preventScroll：位置已由上面定过，别让浏览器再滚一次。
      target.focus({ preventScroll: true });
    },
    [containerRef]
  );

  return { activeId, jumpToSection };
}
