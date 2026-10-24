interface Props {
  /** 当前是否为忙态：决定哪一档文案可见。 */
  busy: boolean;
  /** 静息文案。 */
  idle: string;
  /** 忙态文案（必须走 locale，别再写硬编码省略号——见轮67 R67-WP7）。 */
  busyText: string;
}

/**
 * 「按下去会忙一会儿」按钮的文案切换器（轮74 A3）。
 *
 * 两档文案都在 DOM 里，用 grid 叠进同一格（`.busy-label-stack`），盒子宽度恒等于较宽的那一档，
 * 于是切换文案只换内容不换尺寸。轮67 的解法是给那颗按钮写死一条 `min-width` 地板，
 * 那个数是按一颗按钮、一种语种量出来的：套到别的按钮上忙态反而更窄（实测 134 → 106），
 * 没挂这个 class 的按钮（迁移凭据）照旧跳，换语种就整体失效。
 *
 * 为什么仍然换文案而不是加 spinner：轮67 真机量过，忙态只留一个「…」实测 3px，
 * 按钮塌成一条缝，用户分不清「在忙」还是「点坏了」；完整文案才说得出正在做什么。
 *
 * 无障碍：不可见那一档同时挂 `visibility:hidden`（浏览器按 accname 排除）和 `aria-hidden`——
 * 后者是因为不能赌运行环境：jsdom 不做外链样式表级联，只靠 CSS 的话测试环境里可访问名会变成
 * 「清理缓存 清理中...」两个状态名一起念（真机不会，但守卫与组件测试跑的就是 jsdom）。
 */
export default function BusyLabel({ busy, idle, busyText }: Props) {
  return (
    <span className="busy-label-stack">
      <span className="busy-label-option" data-shown={!busy} aria-hidden={busy ? true : undefined}>
        {idle}
      </span>
      <span className="busy-label-option" data-shown={busy} aria-hidden={busy ? undefined : true}>
        {busyText}
      </span>
    </span>
  );
}
