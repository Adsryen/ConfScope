/**
 * 「这块区域正在被异步换掉」的唯一出口（轮15 波36 / R55）。
 *
 * 为什么要单独收一个函数：波23 只解决了「加载中」这三个字能被念出来（给占位文本挂 role="status"），
 * 但读屏仍然不知道**哪一块**正在变。焦点停在旧行上的用户听见一句「加载中」，接着整块内容凭空被替换——
 * 既不知道换完没有，也不知道该不该等。`aria-busy` 补的就是这后半句：区域开始变得标 busy，忙完属性消失。
 *
 * 为什么只在 busy 时输出 true、不写 `false`：
 * `aria-busy="false"` 会让部分读屏（NVDA/JAWS 行为不一致）把该区域当成「常驻变动区」继续盯，
 * 平时翻页、hover 这类本地重渲染也会被当成变动播报。忙完就该从属性里彻底消失，
 * 所以这里返回 `undefined`，交给 React 把属性整个摘掉。
 *
 * 只许接**真正被异步替换内容**的容器（列表主体、详情主体）。静态占位（「请选择一条配置」）、
 * 常驻说明、纯本地过滤、按钮上的 loading 后缀都不该挂——过度标注和漏标注一样有害，
 * 反向名单钉在 tests/ux/busyRegionsAnnounced.test.ts。
 */
export interface BusyRegionProps {
  "aria-busy"?: boolean;
}

/** busy 为真时返回 `{ "aria-busy": true }`，否则返回 `{ "aria-busy": undefined }`（属性被摘掉）。 */
export function busyProps(busy: boolean): BusyRegionProps {
  return { "aria-busy": busy ? true : undefined };
}
