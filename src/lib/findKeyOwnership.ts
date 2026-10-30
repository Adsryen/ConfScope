// 查找快捷键（Ctrl+F / ⌘F / F3）的**所有权**判定（轮39 R39-3）。
//
// 为什么单独成一份：浏览态 CodeView 与编辑态 CodeEditor 各自写过一遍「这次按键该不该我接管」，
// 两份口径已经分叉——CodeView 认「焦点在不在本视图内 / 是不是 body」，CodeEditor 额外用
// `document.querySelector(".code-view")` 猜「浏览态会不会抢」。猜的那份把被保活隐藏
// （`active=false`，根本不挂监听）的视图也算成会抢，于是编辑态跟着让位，两边都不接管。
// 真机实测（`10-19-ui-ux-39-find-key-ownership/prd.md` 取证表）：在左侧列表点一条配置、
// 或焦点停在侧边导航 / 格式下拉触发器这类**不可编辑**控件上时，Ctrl+F 是死的——
// 而「选中文件 → Ctrl+F」恰好是用户最自然的手顺。这里只放纯函数，决策能脱离组件直接单测。

/**
 * 视图根上打的标记：「这个代码视图**当前真的**挂着查找快捷键监听」。
 *
 * 用属性而不是类名：类名（`.code-view`）在视图被保活隐藏后仍然留在 DOM 里，
 * 拿它当「会不会接管」的依据就是本轮要拆掉的那条猜测。属性由视图自己在那个
 * `useEffect` 里打/摘，与监听同生同灭，不可能分叉。
 */
export const FIND_KEY_OWNER_ATTR = "data-find-key-owner";

/** 查找快捷键的按键信号：Ctrl+F / ⌘F 需要的最小字段集，原生 KeyboardEvent 与 React 合成事件都满足。 */
export interface FindShortcutSignal {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

/**
 * 「这次按键是不是查找快捷键」——代码视图的查找栏与 r139 矩阵页的搜索框共用同一份键位口径。
 *
 * 为什么现在才收成一份：轮39 拆掉的是**所有权**判定（这次按键该谁接管），键位本身当时在三处
 * 逐字重复，没出事故只是因为没人动过它。r139 要加第四个消费方（配置矩阵的跨环境内容搜索），
 * 再抄一遍 `key === "f" || key === "F"` 等于把「新增消费方要不要同步另外三处」重新留给下一个人。
 * 组合态（IME）与焦点归属仍由各宿主自己决定——本视图优先、还是「焦点在别人家文本框里就让位」，
 * 这两件事本来就该分开设，不在这一个谓词里。
 */
export function isFindShortcutKey(signal: FindShortcutSignal): boolean {
  return (signal.ctrlKey === true || signal.metaKey === true) && (signal.key === "f" || signal.key === "F");
}

/**
 * 文本光标能落脚的 `<input>` 类型。
 *
 * 只列「会吃掉 Ctrl+F（浏览器原生查找 / 输入法）」的那几种：`checkbox` / `radio` / `range` /
 * `button` / `submit` / `file` / `color` 即便拿到焦点也没有光标，按 Ctrl+F 不该让查找栏死掉。
 * `number` 算进来：Chromium 里它对 Ctrl+F 的处理与文本框一致（原生查找会定位框内文本）。
 */
const TEXT_CARET_INPUT_TYPES = new Set(["text", "search", "email", "url", "tel", "password", "number"]);

/** 没有 type 属性的 `<input>` 在浏览器里就是 text；jsdom 同样归一成 "text"。 */
function inputType(el: Element): string {
  const type = (el as HTMLInputElement).type;
  return typeof type === "string" ? type.toLowerCase() : "text";
}

/**
 * 焦点是不是真的被一个「文本输入控件」持有。
 *
 * `disabled` / `readonly` 例外：这两种框里落不下光标，浏览器也不会把 Ctrl+F 给它们，
 * 继续让位就又造出一个死键。
 */
export function holdsTextCaret(el: Element | null | undefined): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "INPUT") {
    const field = el as HTMLInputElement | HTMLTextAreaElement;
    if (field.disabled || field.readOnly) return false;
    return tag === "TEXTAREA" || TEXT_CARET_INPUT_TYPES.has(inputType(el));
  }
  if ((el as HTMLElement).isContentEditable === true) return true;
  // jsdom（以及少数不实现该属性的环境）里 isContentEditable 恒为 undefined，
  // 只认它会让「焦点在富文本框里不许抢」这条判据在测试中静默失效。退回属性判定，
  // 祖先链上挂着 contenteditable 且没被显式关掉的一律算持有光标。
  const closest = typeof el.closest === "function" ? el.closest("[contenteditable]") : null;
  if (!closest) return false;
  const value = closest.getAttribute("contenteditable");
  return value !== "false" && value !== "inherit";
}

/** 当前挂着查找快捷键监听的视图根，**文档序**。 */
export function findKeyOwners(scope: ParentNode | null | undefined): Element[] {
  if (!scope || typeof scope.querySelectorAll !== "function") return [];
  return Array.from(scope.querySelectorAll(`[${FIND_KEY_OWNER_ATTR}]`));
}

export interface FindKeyOwnershipInput {
  /** keydown 事件源（`e.target`）。 */
  target: EventTarget | null;
  /** 本视图的根元素。 */
  root: Element | null;
  /** 焦点元素。默认取 `document.activeElement`，单测可注入。 */
  activeElement?: Element | null;
  /** 当前所有挂着监听的视图根（文档序）。默认从 `document` 读，单测可注入。 */
  owners?: Element[];
}

function containsNode(root: Element, node: EventTarget | Element | null | undefined): boolean {
  if (!node) return false;
  if (node === root) return true;
  // window / document 不是 Node（对它们调 contains 会抛），这类事件源一律算「不在本视图内」。
  if (typeof Node === "undefined" || !(node instanceof Node)) return false;
  return root.contains(node);
}

/**
 * 这次查找快捷键归不归本视图。四支判据，**顺序即语义**，不许调换：
 *
 * 1. **事件源或焦点在本视图内** → 本视图接管。含正文 `pre.code-area`、编辑态 `textarea`、
 *    以及查找输入框自己（栏开着时 F3 / Enter 要能继续导航）。
 * 2. **焦点落在文本输入控件上** → 谁都不接管。左侧列表搜索框、外部输入框里的 Ctrl+F
 *    属于那个框（既有口径，真机取证 #7/#8 钉着），本轮不放宽。
 * 3. **焦点落在别的代码视图里** → 让给那个视图（它会在第 1 支里接管）。
 *    专治一页多个代码视图（ApplyPlanView 可展开多个编辑器）：两支都放行 = 同时弹两条查找栏。
 * 4. **其余**——没有焦点、焦点在 body、或焦点停在列表项 / 导航项 / 按钮 / 自定义下拉触发器
 *    这类**不可编辑**控件上（页面里其实没有光标）→ 由**文档序第一个**挂着监听的视图接管。
 *    「第一个」而不是「最后一个」：与用户视线一致（先渲染的主视图），也让编辑态那条
 *    「浏览态在前就不抢 body 上的 Ctrl+F」的既有口径自然成立，不必再猜 `.code-view` 的存在。
 */
export function takesFindKeyOwnership(input: FindKeyOwnershipInput): boolean {
  const { target, root } = input;
  const doc = typeof document === "undefined" ? null : document;
  const active = "activeElement" in input ? input.activeElement : doc ? doc.activeElement : null;
  const owners = input.owners ?? findKeyOwners(doc);

  if (root && (containsNode(root, target as EventTarget) || containsNode(root, active as Element | null))) {
    return true;
  }
  if (holdsTextCaret(active as Element | null)) return false;
  if (active && owners.some((owner) => owner !== root && containsNode(owner, active as Element))) return false;

  const first = owners[0];
  return !first || first === root;
}
