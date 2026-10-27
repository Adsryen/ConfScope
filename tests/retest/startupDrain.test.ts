/**
 * 启动自动重放排空判据的行为（轮96）。
 *
 * 为什么要有单测：这条判据管的是「真机红/绿到底该由什么决定」。只靠 Playwright 复现的话，
 * 要证明它有效就得把机器压忙去撞那道竞态——撞中了也无法区分是判据起作用还是这次恰好快。
 * 这里用两条真实时间线（从 99-s-stale-after-apply 整批跑的桥日志抄下来的行形状）直接判。
 */
import { describe, expect, it } from "vitest";
import { drainDecision, readCompareLedger } from "./startupDrain";

/** 整批跑判红那一轮的真实形状：session_start 在前，请求与终态落在观察点之后。 */
const IN_FLIGHT = [
  '[retest-bridge] ok NacosDetectVersion [? ] 16ms',
  '[retest-bridge] audit {"schema":1,"ts":"2026-10-27T01:50:53.982Z","kind":"session_start","sessionId":"compare-mvq143ku1","scope":"compare"}',
  '[retest-bridge] ok AppendAuditEvent [? ] 0ms',
  '[retest-bridge] audit {"schema":1,"ts":"2026-10-27T01:50:53.982Z","kind":"compare_start","scope":"compare","mode":"text","selectedCount":1,"direction":"left->right","left":"Development / Retest Nacos A / retest-dev / RETEST-PROD / svc-',
  '[retest-bridge] ok ConfigCenterListConfigs [retest-b http://127.0.0.1:19849/nacos] 18ms',
];

const AFTER_END = [
  ...IN_FLIGHT,
  '[retest-bridge] ok ConfigCenterGetConfig [retest-b http://127.0.0.1:19849/nacos] 26ms',
  '[retest-bridge] audit {"schema":1,"ts":"2026-10-27T01:50:54.095Z","kind":"compare_result","result":"success","identical":false,"sessionId":"compare-mvq143ku1"}',
  '[retest-bridge] audit {"schema":1,"ts":"2026-10-27T01:50:54.095Z","kind":"session_end","result":"success","sessionId":"compare-mvq143ku1"}',
];

describe("启动自动重放排空判据", () => {
  it("台账认起点也认终态，长载荷被截断照样认得出会话", () => {
    const open = readCompareLedger(IN_FLIGHT);
    expect(open.started).toEqual(["compare-mvq143ku1"]);
    expect(open.finished).toEqual([]);
    const closed = readCompareLedger(AFTER_END);
    expect(closed.started).toEqual(["compare-mvq143ku1"]);
    expect(closed.finished).toContain("compare-mvq143ku1");
  });

  it("会话在飞时禁止按安静收口——这正是「等安静」判据漏掉的那道缝", () => {
    // 真实误判场景：session_start 之后被调度拉出 1.5s 的缝，安静判据会在这里放行，
    // 随后两侧的 ListConfigs 掉进窗口 ⇒ 同一个用例又一次随机红。
    const step = drainDecision(IN_FLIGHT, 1_500, 1_200);
    expect(step.done).toBe(false);
    expect(step).toMatchObject({ reason: "compare-in-flight", sessionId: "compare-mvq143ku1" });
  });

  it("会话落终态即判排空，调用方可以打水位线", () => {
    expect(drainDecision(AFTER_END, 100, 1_200)).toMatchObject({ done: true, outcome: "replayed" });
  });

  it("没起会话时，安静够久才允许判「本次启动没有重放」", () => {
    const boot = ['[retest-bridge] ok GetAppInfo [? ] 0ms', '[retest-bridge] ok ConfigCenterListConfigs [retest-a http://127.0.0.1:19848/nacos] 6ms'];
    expect(drainDecision(boot, 400, 1_200)).toMatchObject({ done: false, reason: "waiting" });
    expect(drainDecision(boot, 1_250, 1_200)).toMatchObject({ done: true, outcome: "no-startup-compare" });
  });

  it("非 compare 作用域与会话号相似的其它事件不许被算进来", () => {
    const noise = [
      '[retest-bridge] audit {"schema":1,"kind":"session_start","sessionId":"apply-mvq00001","scope":"apply"}',
      '[retest-bridge] audit {"schema":1,"kind":"session_end","sessionId":"apply-mvq00001"}',
      '[retest-bridge] audit {"schema":1,"kind":"compare_result","sessionId":"compare-before-window"}',
    ];
    expect(readCompareLedger(noise).started).toEqual([]);
    expect(drainDecision(noise, 2_000, 1_200)).toMatchObject({ done: true, outcome: "no-startup-compare" });
  });
});
