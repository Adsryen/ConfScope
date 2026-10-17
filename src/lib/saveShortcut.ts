// Ctrl/Cmd+S「保存」快捷键的判据与原生保存兜底（R47）。
// 动机：这是套在 webview 里的桌面应用，Ctrl+S 一路漏到原生层就会弹出浏览器的「保存网页」对话框
// —— 存下来的是整个页面的 HTML，跟用户正在编辑的配置内容毫无关系，看上去像 bug 而不像功能。
// 分工：编辑区里由 CodeEditor 的 onSave 接管（保存的是这份内容）；
// 其余位置（浏览态、列表、设置页、变更计划的目标内容编辑器）没有保存语义，
// 就把原生对话框吞掉，别让它冒出来。

import { useEffect } from "react";
import { isImeComposing } from "./useEscape";

/** 判据需要的最小按键信号：原生 KeyboardEvent 与 React 合成事件都能直接塞进来。 */
export interface ShortcutKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey?: boolean;
}

/**
 * 「保存」快捷键 = Ctrl+S（Windows/Linux）或 Cmd+S（macOS）。
 * 带 alt 的组合留给宿主扩展，不算保存；shift 不参与判据 ——
 * Ctrl+Shift+S（原生「另存为」）同样要能被下面的兜底吞掉，所以这里照单放行。
 */
export function isSaveShortcutKey(event: ShortcutKeyEvent): boolean {
  if (!event.ctrlKey && !event.metaKey) return false;
  if (event.altKey) return false;
  return event.key === "s" || event.key === "S";
}

/**
 * 全局兜底：没有任何人接管的 Ctrl/Cmd+S，一律拦掉原生「保存网页」。
 * 必须等事件冒泡完再看 defaultPrevented —— 编辑区的 CodeEditor 已经处理过一次保存，
 * 这里再插手就会变成「按一下存两遍」。
 */
export function useBlockNativeSaveShortcut(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isSaveShortcutKey(e)) return;
      // 组合态期间按键属于输入法候选，不该被任何全局快捷键吃掉
      if (isImeComposing(e)) return;
      // 已经有人接管（编辑区的 onSave）就不再重复处理
      if (e.defaultPrevented) return;
      e.preventDefault();
    };
    // 冒泡阶段监听：React 的合成事件在根容器上派发，比 window 更早，defaultPrevented 才可信。
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
