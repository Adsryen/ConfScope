/**
 * 对比来源只有一个事实源（轮46 R01），启动自动比是一次性意图（轮45 R02 + 轮46 R02）。
 *
 * 扫出来的真 bug（探针实测，见 .trellis/tasks/10-19-ui-ux-46/prd.md）：同一件事（比的是哪两个来源）
 * 有两个写侧 —— cs.ui 的 diffLeft 与 diffRight 一族键（只有 App 跳转时写）和 cs.diffViewPreferences
 * （DiffView 每次改动都写、挂载时自己恢复）。镜像常年是旧的，重启时旧的赢下界面，
 * 盖完又被 DiffView 的保存 effect 抄回 prefs：手工改成 billing 那对比出 60 行差异后 prefs 记的确实是
 * billing，重启 656ms 后 DOM 两侧回到种子对、prefs 也被回写成种子对 ⇒ 用户真正比过的那一对一次重启永久丢失。
 *
 * 新口径：**同一件事有两个写侧 ⇒ 必然有一个是过时的；择一必须做到只剩一个写侧**。
 * 所以这里钉的是「没有第二处」，而不只是「这一条链现在是对的」——
 * 行为用例证明不了没有人又在别处读/写那份镜像（这类回声室的复发方式正是顺手读一下），单点用例照样绿。
 *
 * 分工别搅回来：「比一次」是一次性意图，只活在跳转参数（props）里，绝不进任何存储；
 * 「比过的那一对」是状态，只活在 cs.diffViewPreferences 里。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT, readScannedSource, sourceFiles, stripComments } from "./scanUtils";

const APP = "src/App.tsx";
const DIFF_VIEW = "src/components/DiffView.tsx";
const JUMP_LIB = "src/lib/diffJump.ts";
const PREFS_STORE = "src/store/diffPreferences.ts";
const RETEST_SEED = "tests/retest/bridge/storageSeed.ts";
/** cs.ui 那份镜像的全部键名：新口径下一个都不许再出现（注释里提到由 stripComments 抹掉）。 */
const UI_MIRROR_KEYS = /diffLeftConnId|diffRightConnId|diffLeft\b|diffRight\b|diffAutoCompare/;
/** 一次性意图的唯一载体：跳转参数上的可选标志。 */
const TRANSIENT_CARRIER = /autoCompare\?: boolean;/;

function retestSources(): string[] {
  const list: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(PROJECT_ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.(ts|tsx)$/.test(entry.name)) list.push(rel);
    }
  };
  walk("tests/retest");
  return list.sort();
}

describe("对比来源收敛到单一事实源（轮46 R01）", () => {
  it("src 里没有任何一处再读或再写 cs.ui 的 diff 镜像键", () => {
    const offenders = sourceFiles()
      .map((file) => ({ file, source: readScannedSource(file) }))
      .filter((entry) => UI_MIRROR_KEYS.test(entry.source));
    expect(offenders.map((entry) => entry.file)).toEqual([]);
  });

  it("diff 来源的结构只有一个主人：只有它能读写这份形状", () => {
    // appDataDoc 允许提到这个键名 —— 它把每个存储键都当 unknown 的 opaque blob 搬进主数据文件，
    // 不认结构、不搬字段，所以它不是第二个写侧（轮46 的口径：**写侧**唯一，搬运层不算）。
    const owners = sourceFiles().filter((file) => /cs\.diffViewPreferences/.test(readScannedSource(file)));
    expect(owners.sort()).toEqual([PREFS_STORE, "src/lib/appDataDoc.ts"].sort());
    // 结构侧：除 diffPreferences 外谁都不许碰字段，否则字段又开始两处定义
    const appDataDoc = readScannedSource("src/lib/appDataDoc.ts");
    expect(appDataDoc).toMatch(/diffViewPreferences:\s*unknown;/);
    expect(appDataDoc).not.toMatch(/diffViewPreferences\s*\.\s*(left|right|mode|selectedProject)/);
    // App 是轮46 之前那个第二个写侧，这里钉死它再也回不来
    expect(readScannedSource(APP)).not.toMatch(/diffViewPreferences/);
  });

  it("一次性意图不进任何存储：prefs 结构与 cs.ui 回写块都不许出现 autoCompare", () => {
    expect(readScannedSource(PREFS_STORE)).not.toMatch(/autoCompare/);
    const persist = readScannedSource(APP).match(/localStorage\.setItem\(\s*UI_KEY,[\s\S]*?\n\s*\}\);/);
    expect(persist, "找不到 cs.ui 的回写块，这条守卫就成了空转").not.toBeNull();
    expect(persist![0]).not.toMatch(/autoCompare|diffLeft|diffRight|diffViewPreferences/);
    const uiState = readScannedSource(APP).match(/interface UIState \{[\s\S]*?\n\}/);
    expect(uiState, "App 里的 UIState 声明找不到了，这条守卫就成了空转").not.toBeNull();
    expect(uiState![0]).not.toMatch(/autoCompare|diffLeft|diffRight/);
  });

  it("跳转参数类型只有一个出口，不许再各声明一份", () => {
    const carriers = sourceFiles().filter((file) => TRANSIENT_CARRIER.test(readScannedSource(file)));
    expect(carriers).toEqual([JUMP_LIB]);
  });

  it("启动恢复不再走跳转参数那条路：App 的 initialParams 初值必须是 null", () => {
    expect(readScannedSource(APP)).toMatch(
      /const \[diffInitialParams, setDiffInitialParams\] = useState<DiffJumpParams \| null>\(null\);/
    );
  });

  it("挂载即比的意图只在首帧取一次（useState 初值），不得每次渲染现读 mode", () => {
    // 判据必须是 mount-only：ui0 = loadUI() 每次渲染重读存储，直接把 mode === "diff" 传下去
    // 会让「本会话中途点进对比页」也点亮它 ⇒ 每次挂载白比一轮，正是轮45 刚清掉的回声室形状。
    expect(readScannedSource(APP)).toMatch(
      /const \[autoCompareOnRestore\] = useState\(\(\) => initialMode === "diff"\);/
    );
    expect(readScannedSource(APP)).not.toMatch(/autoCompareOnRestore=\{mode === "diff"\}/);
  });

  it("恢复路径判「两侧齐全」，跳转路径刻意不判（智能匹配那条真机路径不许被顺手改死）", () => {
    const source = readScannedSource(DIFF_VIEW);
    const restore = source.match(/const restoreCheckedRef[\s\S]*?\n  \}, \[autoCompareOnRestore\]\);/);
    expect(restore, "找不到恢复 effect，这条守卫就成了空转").not.toBeNull();
    expect(restore![0]).toMatch(/isCompleteDiffSourcePair\(restored\.left, restored\.right\)/);

    const jumpIndex = source.search(/if \(initialParams\.autoCompare\) setPendingAutoCompare\(/);
    expect(jumpIndex, "跳转路径的自动对比入口没了").toBeGreaterThan(-1);
    // 两侧 dataId 为空在跳转语义里是「跳过去跑智能匹配」（loadBoth 的 needMatch 分支），是有意为之
    expect(source.slice(Math.max(0, jumpIndex - 400), jumpIndex)).not.toMatch(/isCompleteDiffSourcePair/);
  });

  it("retest 种子写的是 prefs、不再写 cs.ui 的镜像键", () => {
    const seed = stripComments(readFileSync(join(PROJECT_ROOT, RETEST_SEED), "utf8"));
    expect(seed).not.toMatch(UI_MIRROR_KEYS);
    // 首屏自动比的前提（ensureSourcesPanelExpanded / pinStartupToBrowse 那几条注释都靠它）：
    // 两侧 connId + dataId 必须齐，少一个就是「种子造出一个产品里不存在的状态」。
    expect(seed).toMatch(/cs\.diffViewPreferences/);
    expect(seed.match(/dataId:\s*"[^"\s][^"]*"/g)?.length ?? 0, "种子这一对必须两侧都有非空 dataId").toBeGreaterThanOrEqual(2);
  });

  it("retest 用例不再断言 cs.ui 的 diff 镜像键", () => {
    const offenders = retestSources()
      .map((file) => ({ file, source: stripComments(readFileSync(join(PROJECT_ROOT, file), "utf8")) }))
      .filter((entry) => UI_MIRROR_KEYS.test(entry.source));
    expect(offenders.map((entry) => entry.file)).toEqual([]);
  });
});
