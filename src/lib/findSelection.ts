// 查找栏「选中即查找」的初值口径（轮26 F-3）。
//
// 为什么单独成一份：浏览态 CodeView 与编辑态 CodeEditor 共用同一套查找栏语义，
// 「选中的什么算查找词」这个判断只要在两处各写一遍，迟早分叉成
// 「同一个选区，浏览态搜得到、编辑态搜不到」。这里只放纯函数与两个读取器，
// 读取器把浏览器的差异（浏览态正文是 <pre> 里的 DOM 选区，编辑态是 textarea 的选区）收在边界上，
// 决策部分保持能脱离组件直接单测。

/**
 * 初值长度上限。
 *
 * 选区经常是整行甚至整块：一条几千字符的 URL、一段压扁的 JSON。原样塞进查找框，
 * 用户看到的是「一坨打都打不完的词」，而真正有用的往往是行首那几个字符。
 * 截断比全量可用，也比「干脆不用选区」更接近 VSCode 的行为。
 */
export const MAX_FIND_TERM_FROM_SELECTION = 120;

/**
 * 选区原文 → 查找词初值；不适用时返回空串（调用方据此退回原有口径）。
 *
 * 三条规则各有原因：
 * - 只取首行：选区跨行时后面的行多半是别的内容，拼进查找词必然 0 命中；
 * - 跳过空白段：从行尾起手的选区，第一段常常只剩一个换行或几个空格，
 *   直接取第一段会把一段本来能用的选区白白丢掉；
 * - 截断到上限：见上面那条注释。
 */
export function selectionToFindTerm(raw: string | null | undefined): string {
  if (!raw) return "";
  // \r\n / \r / \n 都算：正文来自外部配置文件，不保证已经归一成 \n。
  for (const line of raw.split(/\r\n|\r|\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    return trimmed.length > MAX_FIND_TERM_FROM_SELECTION ? trimmed.slice(0, MAX_FIND_TERM_FROM_SELECTION) : trimmed;
  }
  return "";
}

/** 开栏时查找词的候选来源，三者都已各自清洗过（空串表示「这个来源不适用」）。 */
export interface FindTermCandidates {
  /** 查找栏里已有的词：重复按 Ctrl+F 不该把用户刚打的词清掉。 */
  previous?: string;
  /** 正文里的选区原文（未清洗）。 */
  selectionRaw?: string;
  /** 左侧列表的内容搜索词：只在既没有选区也没有旧词时兜底。 */
  external?: string;
}

/**
 * 开查找栏时的初值优先级：**选区 > 栏内旧词 > 外部搜索词**。
 *
 * 选区排在最前是 VSCode 口径：用户特意选中一段再按 Ctrl+F，要的就是搜它；
 * 让旧词压过选区，等于把这次按键变成「什么也没发生」。
 */
export function pickFindTermOnOpen(candidates: FindTermCandidates): string {
  return selectionToFindTerm(candidates.selectionRaw) || candidates.previous || candidates.external || "";
}

/**
 * 读限定在 `scope` 内的浏览器选区文本（浏览态：正文是 <pre><code> 里的 DOM）。
 *
 * 不许劫持宿主输入框里的选区。实测（Chromium 与 jsdom 一致）：在 `<input>` 里选中几个字时，
 * `window.getSelection()` 给出的是 rangeCount 0 / isCollapsed 为真、但 `toString()` 仍带回那几个字
 * 的对象——只按 toString 判断就会把用户在搜索框里选中的词当成正文选区。所以先过两道闸，
 * 再要求选区两端都落在 scope 内（跨到输入框、或跨到另一个文件视图的半截选区一律不算）。
 */
export function selectionTextWithin(scope: Element | null | undefined): string {
  if (!scope || typeof window === "undefined" || typeof window.getSelection !== "function") return "";
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return "";
  const range = sel.getRangeAt(0);
  if (!scope.contains(range.startContainer) || !scope.contains(range.endContainer)) return "";
  return range.toString();
}

/**
 * 读 textarea 的选区文本（编辑态）。
 *
 * textarea / input 的选中内容不走 `window.getSelection()`，必须用 selectionStart/End 自己切；
 * 折叠光标（end <= start）返回空串，交给调用方退回原有口径。
 */
/** textarea 与 input 共有的那部分：selectionStart 在 input 上可能是 null（email/number 等类型）。 */
export interface SelectableField {
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
}

export function textareaSelectionText(ta: SelectableField | null | undefined): string {
  if (!ta) return "";
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  if (typeof start !== "number" || typeof end !== "number" || end <= start) return "";
  return ta.value.slice(start, end);
}
