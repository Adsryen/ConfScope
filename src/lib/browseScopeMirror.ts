// 配置浏览页「当前作用域」的模块级镜像（轮97 K3，真机 CR-02 取证后新增）。
//
// 为什么这件事不能留在组件里：App.tsx 给浏览页的 key 是 `${activeConnId}:${tenant}`，
// 换连接或换命名空间 = 整棵子树**重挂载**，不是换 props。消息中心里那条「重试」挂的是
// 报错那一刻的旧闭包，它要判「作用域还是不是我报错时那个」只能读一份跨实例的账：
// 挂在旧实例自己的 ref 上时，旧实例卸载后那份账被冻结在旧作用域上，
// 比对结果永远是「没变」⇒ 真的又替旧作用域发一次正文读取，而界面上一个字都不动
// （state 写在已卸载的组件上）。jsdom 用 rerender 换 props 换不出这一路，只有真机能。
//
// 只有作用域需要跨实例。editing / draft / content / selected 仍属于各自那份页面，
// 留在组件内的渲染镜像里（见 ConfigBrowser 的 renderMirrorRef）。

/** 一次渲染所代表的作用域。`scopeLabel` 是给人看的那一份，写进过期说明里。 */
export interface BrowseScopeMirror {
  connId: string;
  tenant: string;
  scopeLabel: string;
}

let current: BrowseScopeMirror | null = null;

/**
 * 报上当前作用域（每次渲染都调一次）。
 * 返回写入的那一份对象，宿主把它存起来，卸载时按**身份**清理——换 key 时新实例可能已经先报上了，
 * 照值清会把新作用域一起清没。
 */
export function reportBrowseScope(scope: BrowseScopeMirror): BrowseScopeMirror {
  current = scope;
  return scope;
}

/**
 * 读最新作用域。返回 null 表示浏览页此刻根本不在界面里
 * （没连接 / 连不上命名空间时 App 会整块换成提示，浏览页随之卸载）——
 * 这种时候任何「重试」都无处落地，同样该拒，而不是发一次没人看的请求。
 */
export function readBrowseScope(): BrowseScopeMirror | null {
  return current;
}

/** 卸载时只清自己写的那一份。 */
export function clearBrowseScope(scope: BrowseScopeMirror): void {
  if (current === scope) current = null;
}
