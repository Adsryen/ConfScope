/**
 * 状态提示容器的播报语义（轮14 波33 / R54）。
 *
 * 为什么要收在一处：`.test-msg` / `.pad-msg` / `.field-error-box` 这几族是「轻量单行提示」，
 * 形态本就不同，波28 定过边界不合并组件（R48-a）。后果是 `role` 全靠写的人记得加——
 * 实测 21 处「保存成功」「测试连接失败」「命名空间加载失败」一个都没挂上，
 * 屏幕阅读器用户点完按钮只听到一片沉默，分不清是成功了、还是界面卡住了。
 *
 * 这里只收**语义判定**，不收结构与 CSS：站点展开 `{...statusMessageProps(tone)}` 一次，
 * className、DOM 层级、文案、按钮逻辑一字不动。
 */

/** 提示的语义档：错误 / 成功 / 中性说明。三元站点按状态把档位算出来再传。 */
export type StatusTone = "error" | "success" | "info";

/** 可直接 spread 到提示容器上的无障碍属性。 */
export interface StatusMessageAria {
  role: "alert" | "status";
  "aria-live"?: "polite";
}

/**
 * 由语义档得到播报属性。
 *
 * - `error` → 只给 `role="alert"`。`alert` 在规范里本身就隐含 `aria-live="assertive"`，
 *   再手写一遍 `aria-live` 会让部分读屏把同一句话念两次；错误必须打断当前朗读，所以不降级。
 * - `success` / `info` → `role="status"` 并显式补 `aria-live="polite"`。
 *   `status` 的隐含优先级在旧读屏实现上并不统一，显式写 polite 是既有站点
 *   （`HistoryView` / `BackupView` / `ConfigBrowser` 的加载提示）已经采用的写法，保持一致。
 *
 * 不给 `aria-atomic`：这几族容器整块出现或整块消失，播报粒度由挂载时机决定，
 * 加了只会让读屏在容器内文本变化时把整块重念一遍。
 */
export function statusMessageProps(tone: StatusTone): StatusMessageAria {
  if (tone === "error") return { role: "alert" };
  return { role: "status", "aria-live": "polite" };
}
