// 弹框焦点管理：打开时把焦点移入弹框，Tab 在弹框内成环，关闭后焦点归位触发元素。
// 为什么 Enter 不单独做全局分派：焦点陷阱已经把焦点送进弹框，Enter 由「聚焦的那个按钮」
// 原生激活，语义与视觉焦点完全一致。若在 window 上再挂一层 Enter 监听，就会出现
// 「焦点明明在取消，回车却执行确认」的矛盾，还得为 button/textarea 维护让路例外清单。
// 因此本模块只负责把焦点放对地方，Enter 交给浏览器原生行为（focus-follows-activation）。
import { useEffect, useRef } from "react";

/** 可聚焦元素集合：与浏览器 Tab 顺序一致，排除 tabindex="-1" 的编程性焦点目标。 */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * 容器内当前该参与 Tab 循环的元素。
 * 禁用项已由选择器排除；jsdom 不做布局，offsetParent / checkVisibility 在测试环境不可靠，
 * 因此不再按「是否可见」二次过滤——隐藏弹层里的元素本来就拿不到焦点。
 */
function focusableItems(container: HTMLElement): HTMLElement[] {
  const nodes = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
  const items: HTMLElement[] = [];
  for (const node of nodes) {
    if (node.getAttribute("tabindex") === "-1") continue;
    // 弹层里又开一层（编辑器里的「放弃草稿」确认框、校验错误框）时，内层元素不属于外层这个环：
    // 外层要是把它们算进 first/last，Tab 到内层末尾就会被拽回外层的 ×，提问框反倒被跳过。
    if (ownsDialog(node) !== null && ownsDialog(node) !== container) continue;
    items.push(node);
  }
  return items;
}

/** 这个元素离得最近的那个 `[role="dialog"]` 祖先——判定「Tab 该由哪一层接管」用的就是它。 */
function ownsDialog(node: HTMLElement): HTMLElement | null {
  return node.closest<HTMLElement>('[role="dialog"]');
}

/**
 * 把弹框变成焦点模态：
 * 1. active 变 true 时记录当前焦点为归还目标，并把初始焦点送进弹框；
 * 2. 初始焦点优先取 `[data-dialog-autofocus]`，没有则取容器内首个可聚焦元素；
 * 3. Tab / Shift+Tab 在容器内成环，焦点试图逃出时拽回；
 * 4. active 变 false 或卸载时，焦点仍在 body 上才归位，避免抢走用户已主动移动的位置。
 * @param active 弹框是否真的可见（保活隐藏页面必须传 false，否则替别的模式吃掉 Tab 焦点）
 * @param containerRef 弹框容器（通常是 .modal 而非 overlay，避免把遮罩算进循环）
 */
export function useDialogFocus({
  active,
  containerRef,
}: {
  active: boolean;
  containerRef: { readonly current: HTMLElement | null };
}): void {
  // 打开前的焦点所在，供关闭时归位；用 ref 保存以跨渲染存活。
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    openerRef.current = previous;

    const items = focusableItems(container);
    const preferred = container.querySelector<HTMLElement>("[data-dialog-autofocus]") ?? items[0] ?? null;
    preferred?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      // 焦点落在更里层的弹层上时，这一层完全不插手，Tab 归内层那个陷阱管。
      const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const owner = focused ? ownsDialog(focused) : null;
      if (owner && owner !== container && container.contains(owner)) return;
      const current = focusableItems(container);
      if (current.length === 0) {
        // 无可聚焦元素的极端情况：拦住 Tab，别让它跑到被弹框遮住的下层去。
        event.preventDefault();
        return;
      }
      const first = current[0];
      const last = current[current.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;
      const inside = !!activeEl && container.contains(activeEl);
      if (event.shiftKey) {
        // 在首个元素上 Shift+Tab，或焦点已经逃出容器 → 拽回末尾形成反环。
        if (!inside || activeEl === first) {
          event.preventDefault();
          last.focus();
        }
        return;
      }
      if (!inside || activeEl === last) {
        event.preventDefault();
        first.focus();
      }
    };

    container.addEventListener("keydown", onKeyDown);
    return () => {
      container.removeEventListener("keydown", onKeyDown);
      // 只在焦点「无处可去」时归位：焦点还在 body/document 上说明是弹框自己关掉导致的丢失；
      // 若用户已把焦点移到别处（例如点了背景搜索框），不要把焦点硬拽回来打断操作。
      const opener = openerRef.current;
      const still = document.activeElement;
      if (opener && (still === null || still === document.body)) opener.focus();
      openerRef.current = null;
    };
  }, [active, containerRef]);
}
