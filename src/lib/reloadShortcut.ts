// F5 / Ctrl+R 这类「刷新」快捷键的判据与原生重载兜底（轮45 R01）。
// 动机：这是套在 webview 里的桌面应用，整页重载 = 内存里的现场全没了。
// 实测（轮45 探针）：浏览页搜出 2 条并打开一条详情后刷新，搜索框回到空、列表回到 13 条、
// 打开的详情直接消失，而且这些现场本来就不在 cs.ui 里，刷新后无从恢复。
// 分工与 saveShortcut（R47 治 Ctrl+S 漏出「保存网页」）同构：
// 应用没有任何「刷新」语义，所以一律吞掉；真需要重载时走浏览器工具栏/菜单，
// 或者用带 Alt 的组合（判据放行，给开发者留手敲的路径）。
//
// 拦得住的依据：Chromium 把 reload 归到「渲染进程没处理才回落给浏览器进程」的非保留键，
// 所以 keydown + preventDefault 是前端有效且唯一的拦截点（Ctrl+N/T/W 那一类保留键才拦不住）。

import { useEffect } from "react";
import { isImeComposing } from "./useEscape";
import { hasAltModifier, type ShortcutKeyEvent } from "./shortcutKey";

/**
 * 「刷新」快捷键 = F5（含 Ctrl+F5 / Ctrl+Shift+F5 强刷）或 Ctrl+R / Cmd+R。
 *
 * F5 无条件算：它自己就是刷新，加什么修饰符都还是刷新。
 * R 必须带 Ctrl/Cmd：裸 r 是打字，吞掉就变成「输入框里打不出 r」。
 * Alt 修饰一律放行（见 hasAltModifier）。
 */
export function isReloadShortcutKey(event: ShortcutKeyEvent): boolean {
  if (hasAltModifier(event)) return false;
  if (event.key === "F5") return true;
  if (!event.ctrlKey && !event.metaKey) return false;
  return event.key === "r" || event.key === "R";
}

/**
 * 全局兜底：没有任何人接管的刷新键，一律拦掉原生重载。
 * 与保存兜底同样必须等事件冒泡完再看 defaultPrevented ——
 * 将来某个页面真要自己处理 F5（比如日志查看器手动刷新）时，这里不能跟它抢。
 */
export function useBlockNativeReloadShortcut(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isReloadShortcutKey(e)) return;
      // 组合态期间按键属于输入法候选，不该被任何全局快捷键吃掉
      if (isImeComposing(e)) return;
      // 已经有人接管就不再重复处理
      if (e.defaultPrevented) return;
      e.preventDefault();
    };
    // 冒泡阶段监听：React 的合成事件在根容器上派发，比 window 更早，defaultPrevented 才可信。
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
