// 系统「减少动态效果」偏好的 JS 侧读取（轮6 R50）。
//
// CSS 媒体查询管不到 JS 发起的滚动：`scrollIntoView({ behavior: "smooth" })` 和
// `container.scrollTo({ behavior: "smooth" })` 在偏好开启时照样动画，前庭敏感的用户
// 会被自己的「跳转到第 N 步」按钮晃一下。所以把判断收在一处，动效站点自己问一句。

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    // 老 WebView 没有 matchMedia：按「允许动效」处理，别让跳转整个失效
    return false;
  }
}

/** smooth 与 auto 的选择，供 scrollTo / scrollIntoView 直接用。 */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? "auto" : "smooth";
}
