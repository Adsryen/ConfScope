/**
 * 「整行可点」容器的键盘语义（R61）。
 *
 * 为什么要收在一处：日志快照、变更计划、审计矩阵、连接列表这些行都是 `<div onClick>` 实现的，
 * 鼠标一点就选中，键盘却完全够不着——Tab 直接跳过整张列表，Enter 什么也不发生，
 * 连 CSS 里已经写好的 `:focus-visible` 焦点环都永远不可能触发。
 * 把补齐的三件事（可聚焦、Enter/Space 等价于点击、IME 组合态让路）钉在一个 helper 里，
 * 新列表页只需 spread 一次，静态守卫也只认这一组属性。
 */
import type { HTMLAttributes, KeyboardEvent as ReactKeyboardEvent } from "react";
import { isImeComposing } from "./useEscape";

interface ClickableRowOptions {
  /**
   * 无障碍角色。默认 `button`；
   * 行内还嵌着按钮/输入框时必须传 `group`——`button` 的子树在无障碍树里会被当作装饰隐藏掉，
   * 那时行内的「复制」「删除」按钮反而读不到了。
   */
  role?: "button" | "group";
  /** 当前是否处于选中态：补 aria-current，读屏才知道「这行是选中的那个」。 */
  selected?: boolean;
  /** 行不可选（例如变更计划里被阻断的项）：不进 Tab 顺序，避免焦点落在一行按不动的内容上。 */
  disabled?: boolean;
}

/** 空格在不同浏览器上的 key 值（旧版写 Spacebar），两种都要认。 */
const ACTIVATION_KEYS = ["Enter", " ", "Spacebar"];

/**
 * 生成可 spread 到行容器上的属性集。
 *
 * `onActivate` 与行上的 `onClick` 应指向同一个动作；这里不接管 click，
 * 因为点击还会带出 stopPropagation 的细节，交给调用方原有的处理。
 */
export function clickableRowProps(onActivate: () => void, options: ClickableRowOptions = {}): HTMLAttributes<HTMLElement> {
  const { role = "button", selected = false, disabled = false } = options;
  return {
    role,
    tabIndex: disabled ? -1 : 0,
    "aria-disabled": disabled ? true : undefined,
    "aria-current": selected ? "true" : undefined,
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
      // 只处理落在行内的按键（行内按钮自己会吃掉 Enter/Space）
      if (event.target !== event.currentTarget) return;
      if (disabled || !ACTIVATION_KEYS.includes(event.key)) return;
      if (isImeComposing(event)) return;
      event.preventDefault(); // 空格不许把列表滚走
      onActivate();
    },
  };
}
