// 极简全局 toast：模块级发布订阅，组件用 subscribe 监听，任意处 toast() 触发。
//
// R25 把「出错时看得见、读得完、复制得了」落到这里：
// - 停留时长按类型区分，error 给足 6s，success/info 保持 2.6s；
// - 悬停或键盘聚焦时暂停倒计时，移开后再补一段短尾巴（WCAG 1.4.13 的可暂停要求）；
// - 每条都可手动关闭，文本可选中复制（配套 CSS：容器 pointer-events:none，条目 auto）；
// - 同文案在合并窗口内叠成「× N」，不再把屏幕堆满同一句话；条数上限外的最旧一条先退场。

export type ToastType = "success" | "error" | "info";

export interface ToastItem {
  id: number;
  text: string;
  type: ToastType;
  /** 同文案在 DEDUPE_WINDOW 内合并的条数，1 表示没合并。 */
  count: number;
  /** 悬停/聚焦暂停中：为 true 时没有自动消失的倒计时。 */
  held: boolean;
  /** 最近一次触发时刻，用于合并判断（跟随 Date.now，测试可用 setSystemTime 控制）。 */
  at: number;
}

type Listener = (items: ToastItem[]) => void;

/** 各类型的默认停留时长（毫秒）。 */
export const TOAST_DURATION: Record<ToastType, number> = { success: 2600, info: 2600, error: 6000 };
/** 同文案合并窗口：窗口内的重复提示叠成一条。 */
export const DEDUPE_WINDOW = 1500;
/** 暂停后移开鼠标/失焦时补的尾巴，够读完但不会一直占着屏幕。 */
export const RESUME_GRACE = 1200;
/** 最多同时可见的条数，超出时最旧的一条退场，避免连报错刷屏。 */
export const MAX_VISIBLE = 4;

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<Listener>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit() {
  for (const l of listeners) l(items);
}

function clearTimer(id: number) {
  const timer = timers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(id);
}

function schedule(id: number, ms: number) {
  clearTimer(id);
  timers.set(
    id,
    setTimeout(() => dismiss(id), ms)
  );
}

function patch(id: number, changes: (item: ToastItem) => Partial<ToastItem>) {
  items = items.map((item) => (item.id === id ? { ...item, ...changes(item) } : item));
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  l(items);
  return () => {
    listeners.delete(l);
  };
}

/** 立即撤下某条提示（关闭按钮、合并后的清理都走这里）。 */
export function dismiss(id: number) {
  clearTimer(id);
  if (!items.some((item) => item.id === id)) return;
  items = items.filter((item) => item.id !== id);
  emit();
}

/** 悬停/聚焦：撤掉倒计时，暂停期间这条不会自己走。 */
export function hold(id: number) {
  if (!items.some((item) => item.id === id)) return;
  clearTimer(id);
  patch(id, () => ({ held: true }));
  emit();
}

/** 移开/失焦：补一段短尾巴，而不是按完整时长重来。 */
export function release(id: number) {
  const item = items.find((entry) => entry.id === id);
  if (!item || !item.held) return;
  patch(id, () => ({ held: false }));
  schedule(id, RESUME_GRACE);
  emit();
}

export function clearToasts() {
  for (const id of Array.from(timers.keys())) clearTimer(id);
  items = [];
  emit();
}

/** 发一条提示，返回这一条的 id（合并命中时返回既有条目的 id）。 */
export function toast(text: string, type: ToastType = "success"): number {
  const now = Date.now();
  const duplicate = items.find((item) => item.type === type && item.text === text && now - item.at < DEDUPE_WINDOW);
  if (duplicate) {
    patch(duplicate.id, (item) => ({ count: item.count + 1, at: now }));
    if (!duplicate.held) schedule(duplicate.id, TOAST_DURATION[type]);
    emit();
    return duplicate.id;
  }

  const id = nextId++;
  items = [...items, { id, text, type, count: 1, held: false, at: now }];
  while (items.length > MAX_VISIBLE) {
    const [oldest, ...rest] = items;
    if (oldest) clearTimer(oldest.id);
    items = rest;
  }
  emit();
  schedule(id, TOAST_DURATION[type]);
  return id;
}
