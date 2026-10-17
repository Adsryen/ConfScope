// 全局 Escape 分层分派：同屏存在多个弹层/下拉时，一次 Esc 只关最内层的那一个。
// 注意：Enter 不在此表内。弹框的 Enter 走「焦点跟随」——焦点陷阱已把焦点送进弹框，回车由聚焦按钮原生激活，
// 见 useDialogFocus.ts 的决策注释。这里只管 Esc。
// 动机：各处各自 addEventListener("keydown") 会互相抢 Esc，
// 出现「确认框打开时底层弹层被一起关掉」「下拉展开时 Esc 直接关掉整个弹层」这类层级穿透。
import { useEffect, useRef } from "react";

/** Esc 响应者优先级：数值越大越内层，越优先吃掉按键。 */
export const EscapePriority = {
  /** 页面级（如编辑态取消守卫） */
  page: 0,
  /** 页面内弹层（批量替换、目标选择等） */
  overlay: 10,
  /** 弹层内的自绘下拉/候选弹层 */
  dropdown: 20,
  /** 覆盖式确认/提示框（ConfirmModal、AlertModal） */
  confirm: 30,
  /** 全局错误详情（z-index 高于应用内所有弹层，Esc 优先吃它） */
  global: 40,
} as const;

/** 事件上可用于判定组合态的字段：原生 KeyboardEvent 与 React 合成事件都覆盖。 */
interface ImeSignal {
  isComposing?: boolean;
  keyCode?: number;
}

/**
 * 中文/日文等输入法组合态判定：候选词尚未上屏时，Enter / Esc / Space 都属于 IME，页面逻辑一律让路。
 * keyCode 229 是 Safari / 部分 WebView 不填 isComposing 时的兜底信号。
 * React 的 SyntheticKeyboardEvent 不透传 isComposing（它只挂在 nativeEvent 上），
 * 因此两个来源都要看，否则组件里的守卫形同虚设。
 */
export function isImeComposing(event: ImeSignal & { nativeEvent?: ImeSignal }): boolean {
  const native = event.nativeEvent;
  return event.isComposing === true || event.keyCode === 229 || native?.isComposing === true || native?.keyCode === 229;
}

interface Registration {
  priority: number;
  order: number;
  onClose: () => void;
}

const registry = new Map<object, Registration>();
let orderSeq = 0;
let bound = false;

/** 取当前最该响应 Esc 的一层：优先级高者胜，同级则后注册（更内层）者胜。 */
function topRegistration(): Registration | undefined {
  let top: Registration | undefined;
  for (const reg of registry.values()) {
    if (!top) {
      top = reg;
      continue;
    }
    if (reg.priority > top.priority) top = reg;
    else if (reg.priority === top.priority && reg.order > top.order) top = reg;
  }
  return top;
}

function onKeyDown(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  // 组合态的 Esc 属于 IME（取消候选词），不能替页面关掉弹层。
  if (isImeComposing(event)) return;
  const top = topRegistration();
  if (!top) return;
  // 捕获阶段拦下：未纳管的旧式监听都挂在冒泡阶段，
  // 一次 Esc 只让最内层响应，避免连带关闭外层。
  event.stopPropagation();
  top.onClose();
}

/**
 * 把当前组件注册为 Esc 响应者。
 * @param active 为 false 时完全不参与分派（用于弹层未打开 / 被更上层遮挡）
 * @param onClose 该层被 Esc 关闭时的回调
 * @param priority 层级，默认页面级；见 EscapePriority
 */
export function useEscape(active: boolean, onClose: () => void, priority: number = EscapePriority.page): void {
  // 每个 hook 实例一个稳定 token，供注册表去重与卸载。
  const tokenRef = useRef<object>({});
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!active) return;
    orderSeq += 1;
    const token = tokenRef.current;
    registry.set(token, { priority, order: orderSeq, onClose: () => closeRef.current() });
    if (!bound) {
      window.addEventListener("keydown", onKeyDown, true);
      bound = true;
    }
    return () => {
      registry.delete(token);
      if (registry.size === 0 && bound) {
        window.removeEventListener("keydown", onKeyDown, true);
        bound = false;
      }
    };
  }, [active, priority]);
}
