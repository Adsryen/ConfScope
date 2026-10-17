// 模式（路由）切换时统一收起自绘弹层。
// 动机：Select / Combobox 的菜单是 createPortal 到 document.body 的，
// 不在被保活隐藏的页面子树里——只给容器加 hidden 关不掉它，
// 结果是一层 position:fixed 的候选菜单浮在其他模式页面上方，
// 还继续占着 Esc 分层注册表与 window 上的 pointerdown/resize 监听。
// 用一条极简广播而不是给每个下拉传 active：宿主（App）只需在 mode 变化时喊一声。

type CloseHandler = () => void;

const handlers = new Set<CloseHandler>();

/** 注册「被要求收起」回调，返回取消注册函数。 */
export function subscribeClosePopovers(handler: CloseHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

/** 收起当前所有展开的自绘弹层（下拉菜单、候选弹层）。 */
export function closeAllPopovers(): void {
  // 复制一份再遍历：回调里可能触发重渲染并同步取消注册，直接遍历 Set 会被改坏。
  for (const handler of [...handlers]) handler();
}
