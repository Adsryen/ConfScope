import { translate } from "../locales";
import { toast, ToastType } from "./toast";

export type MessageLevel = "success" | "info" | "warning" | "error";

/**
 * 事件由谁触发（轮94 口径，见 `.trellis/spec/frontend/feedback-channels.md`）。
 *
 * - `user`：用户刚做的那个动作带出来的结果。默认值。
 * - `system`：用户没在等它的时刻 —— 启动提示、后台检查更新、定时任务、本机数据写盘重试。
 *
 * 这个标记只决定**要不要占即时通道（toast）**，不影响是否登记进消息中心：
 * 登记簿永远收，因为它本来就是给用户事后回看用的。
 */
export type MessageOrigin = "user" | "system";

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
  /** 缺省 `"user"`：用户动作的结果照旧即时播报，只有系统自发事件需要显式标出来。 */
  origin?: MessageOrigin;
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

/**
 * 这条消息该不该占用即时通道（toast）—— 全站唯一判定式，别处再搓一份即被
 * `tests/ux/feedbackChannelPolicyStaysWired.test.ts` 判红。
 *
 * 四条规则按优先级：
 * 1. `toast: false` 一票否决（调用方已经用别的方式说过了）；
 * 2. `toast: true` 或给了具体文案 —— 一票放行，显式意图大于口径；
 * 3. 系统自发的 success/info **不播**：用户没在等结果的事，没有资格打断他正在做的事
 *    （轮74 记账的那句「启动提示压住用户自己动作的结果」就是这一条的来源）；
 * 4. 其余都播：用户动作的结果，以及系统自发的坏事（error/warning —— 坏事必须立刻可见）。
 *
 * 不播不等于不说：消息中心照旧登记并累加未读角标，角标那一侧有 live region 负责读屏播报。
 */
export function shouldAnnounce(input: { origin?: MessageOrigin; toast?: boolean | string }, level: MessageLevel): boolean {
  if (input.toast === false) return false;
  if (input.toast === true || typeof input.toast === "string") return true;
  if ((input.origin ?? "user") === "system") return level === "error" || level === "warning";
  return true;
}

function notify(item: AppErrorItem, input: MessageInput) {
  if (!shouldAnnounce(input, item.level)) return;
  // 次数不写进文案：写进去每次文案都不同，toast 层自己的「× N」合并就永远命中不了，
  // 同一件事会按次数铺满整叠提示（轮94 取证 4）。重复播报交给 `lib/toast` 的合并窗口。
  const text = typeof input.toast === "string" ? input.toast : translate("messageCenter.toastRecorded", { title: item.title });
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
