// 极简全局 toast:模块级发布订阅,组件用 subscribe 监听,任意处 toast() 触发。

export type ToastType = "success" | "error" | "info";

export interface ToastItem {
  id: number;
  text: string;
  type: ToastType;
}

type Listener = (items: ToastItem[]) => void;

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l(items);
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  l(items);
  return () => {
    listeners.delete(l);
  };
}

export function toast(text: string, type: ToastType = "success") {
  const id = nextId++;
  items = [...items, { id, text, type }];
  emit();
  setTimeout(() => {
    items = items.filter((i) => i.id !== id);
    emit();
  }, 2600);
}
