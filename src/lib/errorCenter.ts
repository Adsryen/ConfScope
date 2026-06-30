import { toast, ToastType } from "./toast";

export type MessageLevel = "success" | "info" | "warning" | "error";

export interface AppErrorItem {
  id: number;
  level: MessageLevel;
  title: string;
  message: string;
  detail?: string;
  source?: string;
  actionLabel?: string;
  onAction?: () => void;
  createdAt: string;
  read: boolean;
  count: number;
  mergeKey?: string;
}

type MessageInput = Omit<AppErrorItem, "id" | "createdAt" | "read" | "count" | "level"> & {
  level?: MessageLevel;
  mergeKey?: string;
  dialog?: boolean;
  toast?: boolean | string;
};
type ErrorInput = Omit<MessageInput, "level">;
type Listener = (items: AppErrorItem[]) => void;
type ActiveListener = (item: AppErrorItem | null) => void;

let items: AppErrorItem[] = [];
let nextId = 1;
let activeId: number | null = null;
const listeners = new Set<Listener>();
const activeListeners = new Set<ActiveListener>();
const MERGE_WINDOW_MS = 500;

function emit() {
  for (const listener of listeners) listener(items);
  const active = activeId == null ? null : items.find((item) => item.id === activeId) ?? null;
  for (const listener of activeListeners) listener(active);
}

function nowIso() {
  return new Date().toISOString();
}

function messageToastType(level: MessageLevel): ToastType {
  if (level === "success") return "success";
  if (level === "error") return "error";
  return "info";
}

function makeMergeKey(input: MessageInput): string {
  return input.mergeKey || `${input.level || "error"}:${input.title}:${input.source || ""}:${input.message}`;
}

function shouldMerge(item: AppErrorItem, key: string): boolean {
  if (item.mergeKey !== key) return false;
  return Date.now() - new Date(item.createdAt).getTime() <= MERGE_WINDOW_MS;
}

function notify(item: AppErrorItem, input: MessageInput) {
  if (input.toast === false) return;
  const text =
    typeof input.toast === "string"
      ? input.toast
      : item.count > 1
        ? `${item.title}（${item.count} 次，已记录到消息中心）`
        : `${item.title}，已记录到消息中心`;
  toast(text, messageToastType(item.level));
}

export function subscribeErrors(listener: Listener): () => void {
  listeners.add(listener);
  listener(items);
  return () => {
    listeners.delete(listener);
  };
}

export function subscribeActiveError(listener: ActiveListener): () => void {
  activeListeners.add(listener);
  listener(activeId == null ? null : items.find((item) => item.id === activeId) ?? null);
  return () => {
    activeListeners.delete(listener);
  };
}

export function reportMessage(input: MessageInput): number {
  const level = input.level || "info";
  const mergeKey = makeMergeKey({ ...input, level });
  const existing = [...items].reverse().find((item) => shouldMerge(item, mergeKey));
  const createdAt = nowIso();

  if (existing) {
    items = items.map((item) =>
      item.id === existing.id
        ? {
            ...item,
            message: input.message,
            detail: input.detail || input.message,
            source: input.source,
            actionLabel: input.actionLabel,
            onAction: input.onAction,
            createdAt,
            read: false,
            count: item.count + 1,
          }
        : item
    );
    if (input.dialog) activeId = existing.id;
    emit();
    notify(items.find((item) => item.id === existing.id)!, input);
    return existing.id;
  }

  const id = nextId++;
  const item: AppErrorItem = {
    ...input,
    id,
    level,
    detail: input.detail || input.message,
    createdAt,
    read: false,
    count: 1,
    mergeKey,
  };
  items = [...items, item];
  if (input.dialog) activeId = id;
  emit();
  notify(item, input);
  return id;
}

export function reportError(input: ErrorInput): number {
  return reportMessage({ ...input, level: "error" });
}

export function dismissError(id: number) {
  items = items.filter((item) => item.id !== id);
  if (activeId === id) activeId = null;
  emit();
}

export function showMessageDetail(id: number) {
  activeId = id;
  markMessageRead(id);
}

export function closeMessageDetail() {
  activeId = null;
  emit();
}

export function markMessageRead(id: number) {
  items = items.map((item) => (item.id === id ? { ...item, read: true } : item));
  emit();
}

export function markAllMessagesRead() {
  items = items.map((item) => ({ ...item, read: true }));
  emit();
}

export function clearErrors() {
  items = [];
  activeId = null;
  emit();
}
