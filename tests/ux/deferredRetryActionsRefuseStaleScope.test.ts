/**
 * 挂在消息中心上的「重试」不许按旧闭包执行（轮96 K2）。
 *
 * 缺陷长什么样：`reportError({ onAction })` 把动作连同那一刻的闭包存进 errorCenter 台账，
 * 人可以先把弹框关掉、换个连接、换个命名空间，再在别的配置上打起草稿，过几分钟才从消息中心
 * 点这条重试。照旧闭包执行会做两件坏事：
 * ① 把界面甩回旧作用域，顺手静默顶掉用户当前的草稿（`openConfig` → `setSelected` → 退编辑态）；
 * ② 把旧作用域取回来的数据写进当前视图的 state（列表 / 搜索结果属于另一个连接）。
 *
 * 口径：
 * 1. 每个 reportError 的 onAction 都必须过 `lateAction` / `retryContentLoad` 这一层；
 * 2. 这一层的判定读每轮渲染刷新的状态镜像，不读闭包；
 * 3. 作用域（连接 + 命名空间）换了 ⇒ 不执行 + 说清楚，且这条说明自己不许再挂一个重试；
 * 4. 作用域没变时按去向分档：还是那份配置 ⇒ 直接重取（非破坏，弹框是假话）；
 *    切到别的配置 ⇒ 跨配置跳转，走 guardNav 的切换确认，且必须取 ref 里那份 guardNav。
 */
import { describe, expect, it } from "vitest";
import { loadLocale, readScannedSource } from "./scanUtils";

const CB = "src/components/ConfigBrowser.tsx";

/** 每个 onAction 站点是否都包在这一层里。 */
function unwrappedActions(source: string): string[] {
  const sites = source.match(/onAction:\s*[^\n]*/g) ?? [];
  return sites.filter((line) => !/onAction:\s*(lateAction|retryContentLoad)\(/.test(line));
}

/** lateAction 是否真的按镜像里的作用域判定，并在 run() 之前先返回。 */
function scopeGuardIsWired(source: string): boolean {
  const body = lateActionBody(source);
  return (
    body !== "" &&
    /const now = renderMirrorRef\.current;/.test(body) &&
    /now\.connId !== reported\.connId\s*\|\|\s*now\.tenant !== reported\.tenant/.test(body) &&
    /reportMessage\(\{[\s\S]{0,400}level:\s*"warning"/.test(body) &&
    /return;\s*\}\s*run\(\);/.test(body)
  );
}

/** 过期说明不许再挂重试动作（把人引回同一个不成立的动作就是死循环）。 */
function staleNoticeOffersRetryAgain(source: string): boolean {
  return /onAction:|actionLabel:/.test(lateActionBody(source));
}

/** 正文重试的分档：同配置直取、跨配置才确认，确认取的是 ref 里那份 guardNav。 */
function contentRetryTiersAreHonest(source: string): boolean {
  const at = source.indexOf("const retryContentLoad =");
  if (at === -1) return false;
  const body = source.slice(at, at + 900);
  return (
    /const sameConfig =[\s\S]{0,220}mirror\.selected\.dataId === item\.dataId && mirror\.selected\.group === item\.group/.test(
      body
    ) &&
    /if \(sameConfig\) \{\s*void openConfig\(item\);\s*return;\s*\}/.test(body) &&
    /guardNavRef\.current\(\(\) => void openConfig\(item\)\)/.test(body)
  );
}

/** 镜像与 guardNav 的 ref 必须每轮渲染都刷新（无依赖数组）。 */
function lateStateStaysFresh(source: string): boolean {
  return (
    /const renderMirrorRef = useRef\([\s\S]*?useEffect\(\(\) => \{\s*renderMirrorRef\.current = /.test(source) &&
    /const guardNavRef = useRef\(guardNav\);\s*useEffect\(\(\) => \{\s*guardNavRef\.current = guardNav;\s*\}\);/.test(source)
  );
}

/** guardNav 的拦截条件仍然是 dirty，别在这一轮被顺手改掉。 */
function guardNavStillAnchorsOnDirty(source: string): boolean {
  return /const guardNav = \(action: \(\) => void, switches = true\) => \{\s*if \(dirty\) \{/.test(source);
}

function lateActionBody(source: string): string {
  const at = source.indexOf("const lateAction =");
  if (at === -1) return "";
  const end = source.indexOf("const retryContentLoad =", at);
  return source.slice(at, end === -1 ? at + 900 : end);
}

describe("延迟触发的重试先验作用域再执行", () => {
  it("每个 reportError 的动作都过这一层", () => {
    const source = readScannedSource(CB);
    const sites = source.match(/onAction:/g) ?? [];
    // 底线：站点数掉了说明新增失败路径时忘了挂动作，这条守卫不该继续算绿。
    expect(sites.length, "配置浏览页至少有 4 处失败重试动作").toBeGreaterThanOrEqual(4);
    expect(unwrappedActions(source), `这些 onAction 没走作用域校验：\n${unwrappedActions(source).join("\n")}`).toEqual([]);
  });

  it("判定读渲染镜像，不符时不执行且说给用户听", () => {
    const source = readScannedSource(CB);
    expect(scopeGuardIsWired(source), "作用域校验没接上镜像，或没在 run() 之前 return").toBe(true);
    expect(staleNoticeOffersRetryAgain(source), "过期说明不许再挂一个重试动作").toBe(false);
    expect(guardNavStillAnchorsOnDirty(source), "guardNav 的拦截条件不能换成别的状态").toBe(true);
    expect(lateStateStaysFresh(source), "镜像或 guardNav 的 ref 没有每轮渲染刷新").toBe(true);
  });

  it("同配置重取不弹框，跨配置跳转才弹", () => {
    const source = readScannedSource(CB);
    expect(contentRetryTiersAreHonest(source), "正文重试的分档写错了").toBe(true);
    // 详情区那张错误卡的重试永远指向当前选中项，同配置 ⇒ 不许套 guardNav（弹「会丢失」是假话）
    // 必须锚定 contentError 这张卡：列表卡 / 搜索卡也长同一个样，抓第一处会读到别的动作。
    const inline = source.match(/<InlineError message=\{contentError\}[^>]*onRetry=\{\(\) => ([^}]*)\}/);
    expect(inline?.[1], "加载失败卡的重试应直取当前配置").toContain("openConfig(selected)");
    // ⟳ 刷新只在非编辑态渲染（那时 dirty 恒 false），同样不许套确认。
    // onClick 写在 title 之前：要从 title 往前找到那颗 <button 才算抓全整颗按钮。
    const titleAt = source.indexOf('title={t("config.refreshContent")}');
    expect(titleAt, "找不到 ⟳ 刷新按钮，这条守卫的锚点得跟着改").toBeGreaterThan(-1);
    const refresh = source.slice(source.lastIndexOf("<button", titleAt), titleAt + 200);
    expect(refresh).toContain("openConfig(selected)");
    expect(refresh, "非编辑态的 ⟳ 不该套切换确认").not.toContain("guardNav");
  });

  it("两份 locale 都有这条说明，且带 from/to 两个插值", () => {
    for (const file of ["zh-CN.json", "en-US.json"]) {
      const flat = loadLocale(file);
      expect(flat["config.retryStaleTitle"], `${file} 缺标题`).toBeTruthy();
      expect(flat["config.retryStaleBody"], `${file} 缺正文`).toBeTruthy();
      expect(flat["config.retryStaleBody"], `${file} 要说清从哪切到哪`).toContain("{from}");
      expect(flat["config.retryStaleBody"]).toContain("{to}");
    }
  });

  it("探测器不是摆设：修前的形状必须判红", () => {
    const before = [
      "const guardNav = (action: () => void, switches = true) => { if (dirty) { setPending(() => action); } else { action(); } };",
      "reportError({",
      '  title: t("config.contentLoadFailed"),',
      "  onAction: () => openConfig(item),",
      "});",
      "<InlineError message={contentError} onRetry={() => openConfig(selected)} />",
    ].join("\n");
    expect(unwrappedActions(before), "修前动作裸奔，必须判红").toHaveLength(1);
    expect(scopeGuardIsWired(before), "修前没有作用域校验").toBe(false);
    expect(contentRetryTiersAreHonest(before), "修前没有分档").toBe(false);
    expect(lateStateStaysFresh(before), "修前没有镜像与 ref").toBe(false);

    const wired = [
      "const lateAction = (reported, run) => () => {",
      "  const now = renderMirrorRef.current;",
      "  if (now.connId !== reported.connId || now.tenant !== reported.tenant) {",
      '    reportMessage({ level: "warning", title: "x", message: "y" });',
      "    return;",
      "  }",
      "  run();",
      "};",
      "const retryContentLoad = (item) => lateAction(reported, () => {",
      "  const mirror = renderMirrorRef.current;",
      "  const sameConfig = !!mirror.selected && mirror.selected.dataId === item.dataId && mirror.selected.group === item.group;",
      "  if (sameConfig) {",
      "    void openConfig(item);",
      "    return;",
      "  }",
      "  guardNavRef.current(() => void openConfig(item));",
      "});",
    ].join("\n");
    expect(scopeGuardIsWired(wired), "写全了应当算绿").toBe(true);
    expect(contentRetryTiersAreHonest(wired), "分档写全了应当算绿").toBe(true);
    const noReturn = wired.replace("    return;\n  }\n  run();", "  }\n  run();");
    expect(scopeGuardIsWired(noReturn), "少了 return 会照常执行，必须判红").toBe(false);
    const alwaysConfirms = wired
      .split("  if (sameConfig) {\n    void openConfig(item);\n    return;\n  }\n")
      .join("");
    expect(contentRetryTiersAreHonest(alwaysConfirms), "同配置也弹确认，分档被抹平必须判红").toBe(false);
  });
});
