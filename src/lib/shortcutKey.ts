// 全局快捷键判据共用的最小按键信号（轮45 R01）。
//
// 为什么单独一个文件：保存（R47）与刷新（R01）两条兜底要判的是同一件事——
// 「这个组合键是不是我关心的那一个」，而原生 KeyboardEvent 与 React 合成事件都能塞进来。
// 判据本身各管各的（放在 saveShortcut / reloadShortcut 里），信号形状只留这一份。

export interface ShortcutKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey?: boolean;
}

/** 带 Alt 的组合留给宿主扩展，两条兜底都不认（也是开发者手敲重载的逃生门）。 */
export function hasAltModifier(event: ShortcutKeyEvent): boolean {
  return event.altKey;
}
