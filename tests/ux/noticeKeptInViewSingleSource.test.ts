/**
 * 「提示出现就把自己滚进可视区」只认一个出口（轮67 / R67-WP1）。
 *
 * 缺陷长什么样：设置页右侧是一个 698px 高、内容 2762px 的滚动容器，
 * 备份面板的状态/错误块固定挂在面板最顶部。真机滚到面板底部点「上传当前数据」，
 * 请求失败后量到提示 `top=-221`（整块在容器可视区上方）——按钮那一屏什么都不动，
 * 用户只能认为「没反应」，于是重复点击。同一条提示在面板顶部那一档才看得见。
 *
 * 口径：
 * 1. 定位实现只许写在 src/lib/useKeepVisible.ts，站点手抄一份「自己滚提示」即红；
 * 2. 面板的两条提示通道（status / error）都必须接上，漏一条等于那类动作回到老样子；
 * 3. InlineError 的引用必须落在 role="alert" 根节点上，不许改成套一层包裹 div
 *    （面板是 flex column gap:16px、.inline-error 自带 margin:12px，多套一层会改间距）；
 * 4. lib 模块保住绘制前滚动、nearest 语义、减少动效口径、jsdom 可用性判空。
 */
import { describe, expect, it } from "vitest";
import { readScannedSource, sourceFiles } from "./scanUtils";

const LIB = "src/lib/useKeepVisible.ts";
const PANEL = "src/components/AppDataBackupPanel.tsx";
const INLINE_ERROR = "src/components/InlineError.tsx";
const SETTINGS = "src/components/SettingsView.tsx";

describe("提示落点单一出口（轮67 R67-WP1）", () => {
  const files = sourceFiles();
  const lib = readScannedSource(LIB);
  const panel = readScannedSource(PANEL);
  const inlineError = readScannedSource(INLINE_ERROR);
  const settings = readScannedSource(SETTINGS);

  it("定位实现只有一份，站点不许自己滚提示", () => {
    const copies = files.filter((file) => file !== LIB && /export function useKeepVisible</.test(readScannedSource(file)));
    expect(copies, "长出了第二份 useKeepVisible").toEqual([]);
    // 「谁把自己滚进可视区」这件事只有这一处实现：别的文件里的 scrollIntoView 都是
    // 定位命中行 / 跳段（DiffView、OperationHistoryView 等），与提示落点无关，不该被这条钉住。
    expect([...panel.matchAll(/scrollIntoView\(/g)], "面板绕开 hook 自己写了一次滚动").toHaveLength(0);
  });

  it("备份面板的两条提示通道都接上了", () => {
    const calls = [...panel.matchAll(/useKeepVisible</g)].length;
    expect(calls, "status / error 两条通道各要一次 useKeepVisible").toBeGreaterThanOrEqual(2);
    expect(panel, "状态提示的根节点没挂引用").toMatch(/<div ref=\{statusRef\} className=\{`test-msg/);
    expect(panel, "错误提示没把引用交给 InlineError").toMatch(/<InlineError containerRef=\{errorRef\}/);
  });

  it("InlineError 的引用落在 alert 根节点上，不多套包裹层", () => {
    expect(inlineError, "组件没开放 containerRef").toMatch(/containerRef\?: Ref<HTMLDivElement>/);
    const rootTag = inlineError.match(/<div ref=\{containerRef\}[\s\S]{0,200}?\S>/)?.[0] ?? "";
    expect(rootTag, "引用没落在根 div 的开标签上（改成了包裹层？）").toContain("inline-error");
    expect(rootTag, "带引用的那个节点不是 role=alert 本体").toContain('role="alert"');
    expect(inlineError.match(/role="alert"/g), "错误块只能有一个 alert 根节点").toHaveLength(1);
  });

  it("设置页数据目录一节的三条提示通道都接上了（轮67 R67-WP7）", () => {
    // 真机量过：面板滚到本节底部时，容器可视区底边 798，「需重启」提示块顶边 884，
    // 86px 在框外——用户点完「更改位置…」看不到反馈。三条通道一条都不能漏：
    // 漏 error 那条就是「失败被吞」，漏 warn 那条就是「换根完成但没人告诉我还要重启」。
    const calls = [...settings.matchAll(/useKeepVisible</g)].length;
    expect(calls, "需重启 / 换根失败 / 打开文件夹失败 各要一次 useKeepVisible").toBeGreaterThanOrEqual(3);
    expect(settings, "「需重启」提示的根节点没挂引用").toMatch(/<div ref=\{restartNoticeRef\} className="test-msg warn"/);
    expect(settings, "换根失败的根节点没挂引用").toMatch(/<div ref=\{dataRootErrorRef\} className="inline-error" role="alert"/);
    expect(settings, "打开文件夹失败的根节点没挂引用").toMatch(/<div ref=\{openFolderErrorRef\} className="inline-error" role="alert"/);
    // 不许为了挂引用多套一层包裹 div：面板是 flex column，多一层就改间距与播报节点。
    // 本节 3 条短提示 = 2 条带引用 + 1 条「缓存清理失败」（就在按钮下方，本来看得见，不必滚）。
    expect(settings.match(/className="inline-error" role="alert"/g), "短提示根节点数量变了").toHaveLength(3);
    // 每一条都必须直接是 `<div …>` 的根节点本身：套一层包裹 div 就改 flex 间距，
    // 还会让 alert 节点离引用更远一步。
    expect(
      settings.match(/<div (?:ref=\{\w+Ref\} )?className="inline-error" role="alert"/g),
      "有短提示的 alert 根节点不是 <div 本体（套包裹层了？）"
    ).toHaveLength(3);
    expect([...settings.matchAll(/scrollIntoView\(/g)], "设置页绕开 hook 自己写了一次滚动").toHaveLength(0);
  });

  it("lib 模块保住绘制前、nearest、减少动效与可用性判空", () => {
    expect(lib, "退回 useEffect 会先看见一帧空白再跳").toContain("useLayoutEffect");
    expect(lib, 'block 不是 nearest：已经可见时也会把内容重新对齐，等于抢用户的滚动位置').toMatch(/block:\s*"nearest"/);
    expect(lib, "滚动动效没走全站同一把尺").toMatch(/behavior:\s*scrollBehavior\(\)/);
    expect(lib, "缺 scrollIntoView 的宿主（jsdom / 老 WebView）会直接抛错").toMatch(/typeof el\.scrollIntoView !== "function"/);
  });
});
