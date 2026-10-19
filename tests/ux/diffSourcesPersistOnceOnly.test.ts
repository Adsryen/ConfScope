/**
 * 「比一次」这个意图不许进持久化（轮45 R02）。
 *
 * 扫出来的真 bug：`cs.ui.diffAutoCompare` 是跳转参数带过来的一次性意图，却被持久化 effect 写进存储，
 * 而 `ui0 = loadUI()` 每次渲染重读存储 ⇒ 上一轮写进去的 true 下一轮被自己读回来再写回去；
 * 全仓没有任何一处把它清成 false，它只剩「永远为真」这一个终态。
 * jsdom 实测（改前）：DiffView 已经 `onInitialParamsConsumed`（initialParams 落回 null 已验证），
 * `cs.ui.diffAutoCompare` 仍然是 `true`；叠加 retest 种子，每次加载都白比一轮。
 *
 * 为什么这里用静态守卫而不是只靠 jsdom：行为用例能证明「这一条链现在是对的」，
 * 证明不了「没有第二处开始读/写这个键」。这类回声室的复发方式正是
 * 「有人在别处顺手 `ui0.diffAutoCompare` 读一下」——单点行为用例照样绿。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT, readScannedSource, sourceFiles, stripComments } from "./scanUtils";

const APP = "src/App.tsx";
const PARAMS_OWNER = "src/components/AuditView.tsx";
const RETEST_SEED = "tests/retest/bridge/storageSeed.ts";
/** 一次性意图的唯一载体：跳转参数上的可选标志。 */
const TRANSIENT_CARRIER = /autoCompare\?: boolean;/;
/** 启动恢复的推导条件：停在对比页 + 左右来源齐全。 */
const DERIVE = /initialMode === "diff" && ui0\.diffLeftConnId && ui0\.diffRightConnId\s*\?\s*\{[\s\S]{0,260}?autoCompare: true,/;

describe("对比页的一次性意图不进 cs.ui（轮45 R02）", () => {
  it("src 里没有任何一处再读或再写 diffAutoCompare", () => {
    const offenders = sourceFiles()
      .map((file) => ({ file, source: readScannedSource(file) }))
      .filter((entry) => /diffAutoCompare/.test(entry.source));
    expect(offenders.map((entry) => entry.file)).toEqual([]);
  });

  it("启动要不要自动比是推导出来的，不再从存储读标志", () => {
    expect(readScannedSource(APP)).toMatch(DERIVE);
    // 持久化块只记来源
    expect(readScannedSource(APP)).toMatch(/diffLeftConnId: diffJumpPersist\.leftConnId,/);
  });

  it("一次性意图仍然只有「跳转参数」这一个载体", () => {
    const carriers = sourceFiles().filter((file) => TRANSIENT_CARRIER.test(readScannedSource(file)));
    // AuditView 导出这份参数类型，DiffView 本地又声明了一份同构的（历史重复，轮45 不收这一笔）。
    // 这里只钉「不许有第三处」以及「这两处都是参数类型、不是存储类型」——存储侧由上面那条守着。
    expect(carriers.sort()).toEqual(["src/components/AuditView.tsx", "src/components/DiffView.tsx"].sort());
    const uiState = readScannedSource(APP).match(/interface UIState \{[\s\S]*?\n\}/);
    expect(uiState, "App 里的 UIState 声明找不到了，这条守卫就变成空转").not.toBeNull();
    expect(uiState![0]).not.toMatch(/autoCompare/);
  });

  it("retest 种子不许再把标志写回 cs.ui（否则每条用例都在测一个产品里已不存在的状态）", () => {
    const seed = stripComments(readFileSync(join(PROJECT_ROOT, RETEST_SEED), "utf8"));
    expect(seed).not.toMatch(/diffAutoCompare/);
  });
  it("记不记得那一对来源与「此刻停在哪个页」无关（轮45 R03：绕道浏览页不许把它抹掉）", () => {
    const block = readScannedSource(APP).match(/const diffJumpPersist =[\s\S]*?: null\);/);
    expect(block, "找不到 diffJumpPersist 的回落块，这条守卫就成了空转").not.toBeNull();
    // 回落读的是存储里那一对，不再被 mode 门住
    expect(block![0]).toMatch(/diffInitialParams\s*\?\?\s*\n\s*\(ui0\.diffLeftConnId\s*\n?\s*\?/);
    expect(
      block![0],
      '回落又被 mode === "diff" 门住了：真机 SA-01 与 jsdom 都量到「切走一次 spread 变 {} ⇒ diffLeft* 整组消失，切回来读到空串」'
    ).not.toMatch(/mode === "diff"/);
    // 而"要不要自动比"仍然只在启动时由 mode + 来源齐全推导，别把两件事又搅回一处
    expect(readScannedSource(APP)).toMatch(DERIVE);
  });
});
