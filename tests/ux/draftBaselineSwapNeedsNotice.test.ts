/**
 * 重取不许在未保存草稿底下偷换基线（轮96 K2）。
 *
 * 缺陷长什么样：`dirty = editing && draft !== content`，而重取正文只写 `content` 不写 `draft` ——
 * 编辑器（`value={draft}`）显示的还是用户那份，屏幕上没有任何东西说明服务端已经变了。
 * 触发路径不止一条：写后失效的自动重取（flushStale）、右下角「内容加载失败」那条重试通知、
 * 详情区的加载失败重试。用户在旧基线上继续改，保存出来的是覆盖别人新值的计划。
 *
 * 口径：
 * 1. 正文的写入只有一个出口（`openConfig` 成功分支里那一处 `setContent(document.content)`），
 *    内容搜索的批量取数不在此列 —— 它只算命中，从不碰正文；
 * 2. 那个出口之前必须做满五条判定：仍在编辑态 / 草稿与旧正文不等 / 重取的是同一份配置 /
 *    服务端真值确实与旧正文不同 / 真值仍与我的草稿不同。判定读渲染镜像，不赌 await 之后闭包还新不新鲜；
 *    最后那条别省：执行完自己的编辑再重取，真值就是草稿本身，报出来是假警报（轮43 ST-01）；
 * 3. 判定成立必须留下可见+可听的一条说明，且两个去向都在：改用服务端内容、继续用我的改动；
 * 4. 这条说明不许套第二层弹框 —— 用户点按钮本身就是确认，套两层是把人往「取消」上推；
 * 5. 换配置时这条说明必须收掉：它只对当前这份配置的编辑态有意义。
 */
import { describe, expect, it } from "vitest";
import { loadLocale, readScannedSource } from "./scanUtils";

const CB = "src/components/ConfigBrowser.tsx";

/** 判定五条是否成句（注释已被剥掉，命中的只能是真代码）。 */
function swapIsDetected(source: string): boolean {
  return (
    /mirror\.editing\s*&&[\s\S]{0,40}mirror\.draft\s*!==\s*mirror\.content\s*&&[\s\S]{0,40}sameConfig\s*&&[\s\S]{0,60}document\.content\s*!==\s*mirror\.content\s*&&[\s\S]{0,60}document\.content\s*!==\s*mirror\.draft/.test(
      source
    ) && /const sameConfig =/.test(source)
  );
}

/** 少写最后那条时会把「刚执行完自己那份」也报成基线交换：ST-01 那条路径必须是假。 */
function detectsOwnAppliedEdit(source: string): boolean {
  return swapIsDetected(source);
}

/** 正文写入是否只有 openConfig 那一处出口。 */
function contentWriteSites(source: string): number {
  return (source.match(/setContent\(document\.content\)/g) ?? []).length;
}

/** 基线换掉时是否同时留下了说明状态（判定 → setRemoteMoved → setContent 的先后顺序）。 */
function swapIsRecordedBeforeWrite(source: string): boolean {
  const record = source.indexOf("setRemoteMoved(");
  const write = source.indexOf("setContent(document.content)");
  return record !== -1 && write !== -1 && record < write && swapIsDetected(source);
}

/** 说明是否真渲染出来，两个去向是否都在。 */
function swapIsAnnounced(source: string): boolean {
  return (
    // 必须真的挂在状态上：写在 {false && ...} 里的 JSX 等于没渲染。
    /\{\s*remoteMoved\s*&&\s*\(\s*<div className="browser-remote-moved"/.test(source) &&
    source.includes('className="browser-remote-moved"') &&
    source.includes('t("config.remoteMovedNotice"') &&
    source.includes('t("config.remoteMovedRewrite")') &&
    source.includes('t("config.remoteMovedKeep")') &&
    rewriteButtonAdoptsServerContent(source) &&
    keepButtonOnlyHidesNotice(source)
  );
}

/**
 * 两个去向各自要真的做对应的事。
 *
 * 只看文件里有没有 `setDraft(content)` 是不够的 —— 进入编辑态那一路本来就有同样的写法，
 * 把「改用服务端内容」按空的变异照样能蒙过去（变异 m8 实测溜走，故按按钮各自的作用域判定）。
 */
function rewriteButtonAdoptsServerContent(source: string): boolean {
  const at = source.indexOf('t("config.remoteMovedRewrite")');
  if (at === -1) return false;
  const btn = source.slice(source.lastIndexOf("<button", at), at);
  return btn.includes("setDraft(content)") && btn.includes("setRemoteMoved(null)");
}

function keepButtonOnlyHidesNotice(source: string): boolean {
  const at = source.indexOf('t("config.remoteMovedKeep")');
  if (at === -1) return false;
  const btn = source.slice(source.lastIndexOf("<button", at), at);
  return btn.includes("setRemoteMoved(null)") && !btn.includes("setDraft(");
}

/** 弹框套弹框：这条说明的动作不许再走一次确认。 */
function announceActionsUseSecondConfirm(source: string): boolean {
  const block = source.slice(source.indexOf('className="browser-remote-moved"'), source.indexOf('className="browser-remote-moved"') + 1600);
  return /setPending\(/.test(block) || /guardNav\(/.test(block);
}

describe("重取压在未保存草稿上时必须说给用户听", () => {
  it("判定与说明都接在唯一的正文出口上", () => {
    const source = readScannedSource(CB);
    expect(contentWriteSites(source), "正文写入必须只有 openConfig 一处出口，否则判定会被绕开").toBe(1);
    expect(swapIsDetected(source), "基线交换判定没了：重取会静默换掉草稿的对照内容").toBe(true);
    expect(swapIsRecordedBeforeWrite(source), "判定成立后必须先记下这条说明，再写正文").toBe(true);
    expect(swapIsAnnounced(source), "说明没渲染出来，或缺一个去向").toBe(true);
  });

  it("判定读渲染镜像，不读 await 之后的旧闭包", () => {
    const source = readScannedSource(CB);
    expect(source, "判定用的镜像引用没了：await 之后读到的是点进去那一刻的旧编辑态").toMatch(/renderMirrorRef\.current/);
    // 判定那一刻取的必须是镜像本身，就地重建一份 { editing, draft, content } 等于没修。
    expect(source, "openConfig 里的 mirror 没有取镜像，读的是旧闭包").toMatch(/const mirror = renderMirrorRef\.current;/);
    expect(source, "镜像必须每轮渲染都刷新（无依赖数组的 effect）").toMatch(
      /const renderMirrorRef = useRef\([\s\S]*?useEffect\(\(\) => \{\s*renderMirrorRef\.current = /
    );
  });

  it("换配置时收掉这条说明", () => {
    const source = readScannedSource(CB);
    const effect = source.slice(source.indexOf("setEditing(false);"), source.indexOf("setEditing(false);") + 600);
    expect(effect, "切换配置要把 remoteMoved 一起清掉，否则提示会挂到别的配置上").toContain("setRemoteMoved(null)");
  });

  it("不套第二层弹框", () => {
    const source = readScannedSource(CB);
    expect(announceActionsUseSecondConfirm(source), "这条说明的两个去向不许再走 guardNav/setPending 二次确认").toBe(false);
  });

  it("三份文案在两种语言里都在，且带着 dataId 插值", () => {
    for (const file of ["zh-CN.json", "en-US.json"]) {
      const flat = loadLocale(file);
      expect(flat["config.remoteMovedNotice"], `${file} 缺说明文案`).toBeTruthy();
      expect(flat["config.remoteMovedNotice"], `${file} 的说明要带上是哪份配置`).toContain("{dataId}");
      expect(flat["config.remoteMovedRewrite"], `${file} 缺「改用服务端内容」`).toBeTruthy();
      expect(flat["config.remoteMovedKeep"], `${file} 缺「继续用我的改动」`).toBeTruthy();
    }
  });

  it("探测器不是摆设：修前的形状必须判红", () => {
    const before = [
      "const document = await getConfigDocument(conn, tenant, item.dataId, item.group);",
      "if (my !== reqId.current) return;",
      "setContent(document.content);",
      "setMetadata({ version: document.version });",
    ].join("\n");
    expect(swapIsDetected(before), "修前没有任何判定，必须判红").toBe(false);
    expect(swapIsRecordedBeforeWrite(before), "缺 setRemoteMoved").toBe(false);
    expect(swapIsAnnounced(before), "缺说明").toBe(false);
    expect(contentWriteSites(before), "单出口本身要成立").toBe(1);
    // 正控：ST-01 那一路（服务端真值 == 用户刚写进去的那份）不许报成基线交换
    const ownApplied = [
      "const mirror = renderMirrorRef.current;",
      "const sameConfig = true;",
      "setRemoteMoved(mirror.editing && mirror.draft !== mirror.content && sameConfig && document.content !== mirror.content ? { dataId: item.dataId } : null);",
      "setContent(document.content);",
    ].join("\n");
    expect(swapIsDetected(ownApplied), "少了「真值仍与草稿不同」这条：刚执行完自己的编辑会被误报").toBe(false);
    expect(detectsOwnAppliedEdit(readScannedSource(CB)), "修好的五条判定里最后那条必须在").toBe(true);
    // 正控：判定在、说明不在 —— 只记状态不告诉用户，同样算违规
    const halfFixed = [
      "const mirror = renderMirrorRef.current;",
      "const sameConfig = !!mirror.selected && mirror.selected.dataId === item.dataId && mirror.selected.group === item.group;",
      "setRemoteMoved(mirror.editing && mirror.draft !== mirror.content && sameConfig && document.content !== mirror.content && document.content !== mirror.draft ? { dataId: item.dataId, group: item.group } : null);",
      "setContent(document.content);",
    ].join("\n");
    expect(swapIsRecordedBeforeWrite(halfFixed), "判定+记录应算通过").toBe(true);
    expect(swapIsAnnounced(halfFixed), "没有可见说明仍然算违规").toBe(false);
  });
});
