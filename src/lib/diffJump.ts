// 对比页跳转参数与「来源齐全」谓词（轮46 R04）。
//
// 为什么单独一个文件：
// 1) DiffView 与 AuditView 过去各声明一份 DiffJumpParams，App 再从 AuditView 导入 —— 同一份契约三份真相，
//    加字段时最容易漏掉一处（轮45 的守卫已经钉过「不许第三处」，本轮把它收成一个出口）。
// 2) 「这次要比」是一次性意图，只允许活在跳转参数（props）里，绝不进任何存储（轮45 R02）；
//    「比过的那一对」是状态，只允许活在 cs.diffViewPreferences 里（轮46 R01）。
//    两条口径的判据都放在这里，别让调用方各自发明。

export interface DiffJumpSideParams {
  tenant?: string;
  dataId?: string;
  group?: string;
}

export interface DiffJumpParams {
  leftConnId: string;
  rightConnId: string;
  left?: DiffJumpSideParams | null;
  right?: DiffJumpSideParams | null;
  autoCompare?: boolean;
}

/** 参与「齐全」判定的最小来源形状（DiffView 的 Source 与 prefs 里的来源都能塞进来）。 */
export interface DiffSourceShape {
  connId: string;
  dataId: string;
}

/**
 * 一对来源算不算「齐」：两侧连接都选定、且两侧 dataId 都非空。
 *
 * 判据目前只有「重启恢复」这一处调用方（DiffView 的恢复 effect）：跳转参数带的 autoCompare
 * 不套它 —— 两侧 dataId 为空在跳转语义里是「跳过去跑智能匹配」（loadBoth 的 needMatch 分支），
 * 是有意为之，不是缺参数。
 * 抽到这里而不是写在调用点，是为了让「什么才算一对完整来源」只有一份定义，别被各自发明成两种口径：
 * 少一侧 dataId 时直接比，比出来必然是空正文配一条报错，白付一趟取数还多一份 compare_result 审计。
 */
export function isCompleteDiffSourcePair(left: DiffSourceShape, right: DiffSourceShape): boolean {
  return Boolean(left.connId && right.connId && left.dataId.trim() && right.dataId.trim());
}
