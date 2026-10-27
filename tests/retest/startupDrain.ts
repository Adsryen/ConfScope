/**
 * 启动自动重放的排空判据（轮96）。
 *
 * 背景：复测种子把 `cs.ui.mode` 写成 `diff`（轮46 起故意如此，为的是真测「重启回到对比页、
 * 上一轮比对自动重放」这条恢复路径）。于是每次应用启动，DiffView 都会自己跑一轮比对，
 * 发出两侧的 ListConfigs / GetConfig。凡是拿「请求次数」当判据的用例都会被它污染：
 * ST-05「无写入切走切回 0 次列表请求」整批串跑时读到 2（判红）、单跑时读到 0（判绿），
 * 差的那一点只是「打水位线的时候，那轮比对跑完了没有」。
 *
 * 为什么单纯「等桥面安静」不够：session_start 与它后面那串请求之间可能被调度拉出 >1s 的缝，
 * 安静判据会在那道缝上误判成「本次启动没有重放」，随后 burst 掉进窗口，红得比原来还随机。
 * 所以判据要看审计台账本身：见过 compare 会话就必须等它落终态，没会话才允许按安静收口。
 *
 * 这里只做纯函数：输入是 retest 桥在 node 侧收集的日志行 + 已安静多久，输出是「继续等 / 已排空」，
 * 真机上等多久由调用方的轮询负责。判据能单测（tests/retest/startupDrain.test.ts），
 * 不必为了验证放宽一次真机红而故意把机器压忙。
 */

/** 桥日志里比对会话的起点：`kind":"session_start"` 且 `scope":"compare"`。 */
const START_RE = /"kind":"session_start"/;
const COMPARE_SCOPE_RE = /"scope":"compare"/;
/** 终态：session_end 是正常收口；compare_error 覆盖「跑挂了也要放行」，否则调用方白等一轮超时。 */
const TERMINAL_RES = [/"kind":"session_end"/, /"kind":"compare_error"/];
const SESSION_ID_RE = /"sessionId":"(compare-[^"]+)"/;

export type DrainDecision =
  | { done: false; reason: "waiting" }
  | { done: false; reason: "compare-in-flight"; sessionId: string }
  | { done: true; outcome: "replayed"; sessionId: string }
  | { done: true; outcome: "no-startup-compare" };

/**
 * 从日志行里读出 compare 会话的台账。
 *
 * 为什么不用 JSON.parse：桥日志把 audit 载荷整行写出来，长载荷会被截断
 * （实测 compare_start 那行停在 `"dataId":"svc-`），解析器一崩判据就退化成「永远没重放」。
 * 所以逐字段正则，截断的尾行不影响起点/终态的识别。
 */
export function readCompareLedger(lines: string[]): { started: string[]; finished: string[] } {
  const started: string[] = [];
  const finished: string[] = [];
  for (const line of lines) {
    const sessionId = SESSION_ID_RE.exec(line)?.[1];
    if (!sessionId) continue;
    if (START_RE.test(line) && COMPARE_SCOPE_RE.test(line)) {
      started.push(sessionId);
      continue;
    }
    if (TERMINAL_RES.some((re) => re.test(line))) finished.push(sessionId);
  }
  return { started, finished };
}

/**
 * 下一步该怎么等。
 *
 * @param lines 从观察点起收集到的桥日志行（调用方切片，函数自身不认识「窗口」概念）
 * @param quietMs 距上一条新行已经安静多久
 * @param idleMs 安静多久才敢判定「本次启动不会重放」
 */
export function drainDecision(lines: string[], quietMs: number, idleMs: number): DrainDecision {
  const { started, finished } = readCompareLedger(lines);
  if (started.length > 0) {
    const open = started.filter((id) => !finished.includes(id));
    if (open.length > 0) return { done: false, reason: "compare-in-flight", sessionId: open[open.length - 1]! };
    return { done: true, outcome: "replayed", sessionId: started[started.length - 1]! };
  }
  if (quietMs >= idleMs) return { done: true, outcome: "no-startup-compare" };
  return { done: false, reason: "waiting" };
}
