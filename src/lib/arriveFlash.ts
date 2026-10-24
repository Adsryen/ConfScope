// 「你到的就是这块」——跨页跳转与页内回退共用的到达高亮（轮74 D2）。
//
// 量出来的原缺陷：设置页点「检查更新」把人送到关于页，落地位置与来源毫无呼应——
// 关于页顶部还压着 265px 的 logo 与版本号，用户得自己在满屏信息里找回刚点的那件事。
// 对比页 stepper 回退早就有滚动 + 闪烁这一套，但算式和类名都留在 DiffView 里，
// 第二个消费点要么抄一份、要么发明第二套视觉语言（本轮 A 组缺陷正是「两套语言」）。
//
// 三条口径：
// 1. 动画只有一条时间线：类名 `arrive-flash` 与 styles.css 的 keyframes 同名，
//    时长常量与 CSS 对齐（1.1s + 余量），别在组件里再写一个 setTimeout 秒数；
// 2. 连续带到同一块时必须能重播 ⇒ 先摘类、强制 reflow、再挂类（少了 reflow，
//    同一元素第二次加同一个类不会重新播放动画）；
// 3. 焦点交接是可选的：只有跨页落地（关于页）才把焦点交给目标区块，
//    页内回退（对比页）保持原行为不抢焦点，避免把用户正在填的表单焦点带走。

import { scrollBehavior } from "./motion";

/** 到达高亮的类名，与 styles.css 里 `@keyframes arrive-flash` 同名。 */
export const ARRIVE_FLASH_CLASS = "arrive-flash";

/** 摘类的兜底延时：CSS 动画 1.1s，多给 100ms 余量，别让类名挂在元素上过夜。 */
export const ARRIVE_FLASH_MS = 1200;

/**
 * 让目标区块闪一下。
 *
 * @returns 撤销函数：清掉未触发的定时器并摘掉类名。组件侧必须在卸载/重做前调用，
 *          否则「离开页面后 1.2 秒内」这条定时器仍会摸到一个已经离场的节点。
 */
export function flashArrival(target: HTMLElement): () => void {
  target.classList.remove(ARRIVE_FLASH_CLASS);
  // 读一次布局属性强制 reflow：连续两次带到同一块时动画才会从头播
  void target.offsetWidth;
  target.classList.add(ARRIVE_FLASH_CLASS);
  const timer = window.setTimeout(() => {
    target.classList.remove(ARRIVE_FLASH_CLASS);
  }, ARRIVE_FLASH_MS);
  return () => {
    window.clearTimeout(timer);
    target.classList.remove(ARRIVE_FLASH_CLASS);
  };
}

/**
 * 完整的一次到达：滚到位 → （按需）交焦点 → 闪一下。
 *
 * jsdom 没有 `Element.prototype.scrollIntoView`，老 WebView 也未必有 `focus(options)`，
 * 两个能力都判空后再用：少了滚动只是看不见，抛错会让整条跳转失效。
 */
export function revealArrival(target: HTMLElement, options: { focus?: boolean } = {}): () => void {
  if (typeof target.scrollIntoView === "function") {
    target.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
  }
  if (options.focus === true && typeof target.focus === "function") {
    // preventScroll：刚按算好的位置滚到位，再让浏览器为焦点元素滚一次就会盖掉它
    try {
      target.focus({ preventScroll: true });
    } catch {
      target.focus();
    }
  }
  return flashArrival(target);
}
