// 对比页拖选「串侧」的收口（轮66）。
//
// 症状（真机量化，114 行的 svc-gateway.yaml 对比）：只沿着左栏往下拖 3 行，
// 选区命中左 3 格 + 右 2 格、173 字符——复制出来左右两栏粘在一起。
// 根因是结构性的：DiffPanel 的每一行里「左行号 → 左 cell → 合并箭头 → 右行号 → 右 cell」
// 是同一行的兄弟节点，而选区取的是**文档序区间**，不是视觉列区间，所以跨行必然把中间和右侧卷进来。
//
// 为什么用 user-select 而不是 Range 手术：
// - 单个 Range 表达不了「挖掉中间那一半」，多 Range 又会在片段之间丢换行，抄出来是粘连的；
// - 引擎对 `user-select: none` 的子是**高亮与复制文本同时剔除**（本仓库的行号槽一直靠这条，
//   上面那 173 字符里就没有行号数字），所以把「非起手侧」置为不可选，选区区间不用动，
//   块与块之间的换行也还在；
// - WebView2（Chromium）与 WebKitGTK 都吃这条，不需要各自适配。
//
// 因此这里只做一件事：把「鼠标起手的这一侧」记成类，另一侧临时不可选；
// 下一次在另一侧起手就翻过来。类用 classList 同步写，不进 React state——
// pointerdown 到选区计算之间不容一帧延迟，那一帧浏览器会按旧样式把两侧都刷蓝。

/** 起手在左：右侧临时不可选。 */
export const SIDE_CLASS_LEFT = "side-select-left";
/** 起手在右：左侧临时不可选。 */
export const SIDE_CLASS_RIGHT = "side-select-right";

export type GuardedSide = "left" | "right" | null;

/** 节点落在哪一侧的正文格里；行号槽、合并箭头、格外面都算 null。 */
export function sideOfNode(node: Node | null | undefined): GuardedSide {
  const el =
    node && node.nodeType === 3 ? node.parentElement : (node as HTMLElement | Element | null);
  const cell = el?.closest?.(".diff-cell");
  if (!cell) return null;
  if (cell.classList.contains("left")) return "left";
  if (cell.classList.contains("right")) return "right";
  return null;
}

/**
 * 把 body 收到「只有 side 这一侧可复制」。side 为 null 时恢复两侧都可选
 * （没有选区、或起手不在任何正文格里时走这条，不替用户做主）。
 */
export function applyGuardedSide(body: HTMLElement, side: Exclude<GuardedSide, null> | null): void {
  body.classList.toggle(SIDE_CLASS_LEFT, side === "left");
  body.classList.toggle(SIDE_CLASS_RIGHT, side === "right");
}

/**
 * 给一块并排 diff 正文装上串侧守卫。返回卸载函数。
 *
 * 监听挂在 body 与 document 上而**不是** React 的 onPointerDown：
 * ① 必须在浏览器算选区之前把类写上；② 这块正文由宿主按需挂载，两个 DiffPanel（单配置 /
 * 批量）可以同时在页面上，各装各的，互不干扰。
 */
export function installSideSelectionGuard(body: HTMLElement): () => void {
  const onPointerDown = (event: PointerEvent) => {
    const inside = body.contains(event.target as Node);
    applyGuardedSide(body, inside ? sideOfNode(event.target as Node) : null);
  };
  // 键盘路径（Tab 进正文后 Shift+方向键）与程序化选区没有 pointerdown，靠选区起点兜底。
  const onSelectionChange = () => {
    const sel = document.getSelection?.();
    if (!sel || sel.rangeCount === 0) return;
    const side = sideOfNode(sel.getRangeAt(0).startContainer);
    if (side) applyGuardedSide(body, side);
  };
  const clear = () => applyGuardedSide(body, null);

  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("selectionchange", onSelectionChange);
  body.addEventListener("blur", clear);

  return () => {
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("selectionchange", onSelectionChange);
    body.removeEventListener("blur", clear);
    clear();
  };
}
