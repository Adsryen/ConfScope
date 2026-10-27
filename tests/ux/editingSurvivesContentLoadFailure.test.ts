/**
 * 正文加载失败不许把编辑区连同未保存草稿一起吞掉（轮97 K1 / 轮96 F5）。
 *
 * 缺陷长什么样：编辑分支的条件是 `!contentLoading && !contentError && editing`，而 `openConfig`
 * 的 catch 会 `setContent("")` + `setContentError(...)`——「编辑中 + 一次重取失败」这一刻编辑器
 * 整块消失，草稿还在 state 里但看不见、改不了、抄不走；只剩「重试」一条路，重试再失败就原地困住。
 * 更坏的一头：空基线还在，此时若能生成计划，`buildDirectWriteExitEntry` 拿草稿对上这份空正文，
 * 产出的是一份整文件覆盖计划，服务端那份新值被静默抹掉。
 *
 * 口径：
 * 1. 编辑分支只看 loading，不看 error——草稿必须还在屏幕上、还能改；
 * 2. 只读分支相反，失败态必须独占错误卡，不许渲染一份空正文冒充「这份配置本来就是空的」；
 * 3. 失败态在编辑区上方亮琥珀条把话说清（基线未知 / 下面是草稿 / 现在不能生成计划），并给出
 *    把草稿抄走的出口，抄的必须是编辑器里那份（`text={draft}`，不另造第二份真相）；
 * 4. 生成计划入口在基线未知时必须死掉：`saveAsPlan` 的闸必须走在取草稿之前，按钮禁用；
 *    理由写在看得见的文案上，不挂在 disabled 按钮的 title 里（轮26 F-1 / 轮66 复验）；
 * 5. 失败把基线清掉时，「改用服务端内容」那颗按钮（做的是 `setDraft(content)`）必须一起收掉。
 */
import { describe, expect, it } from "vitest";
import { loadLocale, readScannedSource } from "./scanUtils";

const CB = "src/components/ConfigBrowser.tsx";

/** 编辑分支：只被 loading 挡，不被 error 挡。 */
function editBranchIsOpenOnFailure(source: string): boolean {
  return /\{\s*!contentLoading && editing && \(/.test(source);
}

/** 只读分支：失败态仍独占错误卡。 */
function readOnlyBranchStaysClosedOnFailure(source: string): boolean {
  return /\{\s*!contentLoading && !contentError && !editing && \(/.test(source);
}

/** 琥珀条真的渲染出来，且带抄走草稿的出口。 */
function failureExplainsItself(source: string): boolean {
  return (
    source.includes('className="browser-baseline-unknown"') &&
    source.includes('t("config.baselineUnknownNotice"') &&
    source.includes("CopyButton text={draft}") &&
    source.includes('t("config.copyDraft"')
  );
}

/** 生成计划的闸：在取草稿之前拒绝，且拒绝时留下看得见的理由（顺序才是重点）。 */
function planEntryRefusesUnknownBaseline(source: string): boolean {
  const at = source.indexOf("const saveAsPlan = () => {");
  const buildAt = source.indexOf("buildDirectWriteExitEntry(", at);
  if (at === -1 || buildAt === -1) return false;
  const before = source.slice(at, buildAt);
  return /if \(contentError\) \{\s*[\s\S]{0,60}?setSaveError\(t\("config\.planBlockedNoBaseline"\)\);\s*return;\s*\}/.test(before);
}

/** 按钮那条路也禁用（原生 disabled + aria-disabled 一起挂，title 只在包裹层上）。 */
function planButtonIsDisabled(source: string): boolean {
  const at = source.indexOf("{t(\"config.saveAsPlan\")}");
  if (at === -1) return false;
  const header = source.slice(source.lastIndexOf("<button", at), at);
  return (
    header.includes("disabled={!!contentError}") &&
    header.includes("aria-disabled={!!contentError}") &&
    !header.includes("title=")
  );
}

/** 失败清基线时，那颗会把草稿换成空正文的按钮跟着收掉。 */
function rewriteButtonGoesAwayWithBaseline(source: string): boolean {
  const at = source.indexOf("setContentError(message);");
  if (at === -1) return false;
  return source.slice(at, at + 400).includes("setRemoteMoved(null);");
}

describe("正文重取失败时编辑出口必须在场", () => {
  it("编辑分支不被失败态关掉，只读分支继续关着", () => {
    const source = readScannedSource(CB);
    expect(editBranchIsOpenOnFailure(source), "编辑分支又被 !contentError 关掉了：草稿会连着编辑器一起消失").toBe(true);
    expect(readOnlyBranchStaysClosedOnFailure(source), "只读分支放开 !contentError 就等于拿空正文冒充配置内容").toBe(true);
  });

  it("失败态把基线未知说清，并给一条抄走草稿的出口", () => {
    expect(failureExplainsItself(readScannedSource(CB)), "琥珀条或复制草稿出口没了：失败态只剩重试一条路").toBe(true);
  });

  it("基线未知时生成计划两条入口都拒绝", () => {
    const source = readScannedSource(CB);
    expect(planEntryRefusesUnknownBaseline(source), "saveAsPlan 的基线闸门没了：空基线会生成整文件覆盖计划").toBe(true);
    expect(planButtonIsDisabled(source), "生成计划按钮的禁用写法变了（或把理由塞回 disabled 的 title 里）").toBe(true);
  });

  it("失败时收掉「改用服务端内容」那颗按钮", () => {
    expect(rewriteButtonGoesAwayWithBaseline(readScannedSource(CB))).toBe(true);
  });

  it("文案在两种语言里都在", () => {
    for (const file of ["zh-CN.json", "en-US.json"]) {
      const flat = loadLocale(file);
      expect(flat["config.baselineUnknownNotice"], `${file} 缺基线未知说明`).toBeTruthy();
      // 后果必须写在说明里（整份文件会被覆盖），两种语言各自的词不一样
      expect(flat["config.baselineUnknownNotice"], `${file} 的说明要讲清后果`).toMatch(/覆盖|overwrite/);
      expect(flat["config.copyDraft"], `${file} 缺复制草稿出口`).toBeTruthy();
      expect(flat["config.planBlockedNoBaseline"], `${file} 缺拒绝理由`).toBeTruthy();
    }
  });

  it("探测器不是摆设：修前的形状必须判红", () => {
    const before = [
      "{contentError && selected && <InlineError message={contentError} onRetry={() => openConfig(selected)} />}",
      "{!contentLoading && !contentError && editing && (",
      "  <div className=\"fmt-bar\"><CopyButton text={content} /></div>",
      ")}",
      "{!contentLoading && !contentError && !editing && (",
      "  <div className=\"fmt-bar\">",
      "    <button className=\"btn btn-primary btn-sm\" onClick={saveAsPlan} title={t(\"config.saveShortcutHint\")}>",
      "      {t(\"config.saveAsPlan\")}",
      "    </button>",
      "  </div>",
      ")}",
      "const saveAsPlan = () => {",
      "  if (!selected) return;",
      "  const entry = buildDirectWriteExitEntry({ desiredContent: draft });",
      "  onStartApply(entry);",
      "};",
      "const openConfig = async () => {",
      "  setContentError(message);",
      "  setContent(\"\");",
      "};",
    ].join("\n");
    expect(editBranchIsOpenOnFailure(before), "修前编辑分支被失败态关掉，必须判红").toBe(false);
    expect(readOnlyBranchStaysClosedOnFailure(before), "修前只读分支就是这条写法，应判绿").toBe(true);
    expect(failureExplainsItself(before), "修前没有琥珀条").toBe(false);
    expect(planEntryRefusesUnknownBaseline(before), "修前 saveAsPlan 不看基线").toBe(false);
    expect(planButtonIsDisabled(before), "修前按钮照常可点").toBe(false);
    expect(rewriteButtonGoesAwayWithBaseline(before), "修前失败态留着那颗清空草稿的按钮").toBe(false);
    // 正控：闸门写在取草稿之后同样不成立（顺序才是重点）
    const tooLate = [
      "const saveAsPlan = () => {",
      "  if (!selected) return;",
      "  const entry = buildDirectWriteExitEntry({ desiredContent: draft });",
      "  if (contentError) {",
      "    setSaveError(t(\"config.planBlockedNoBaseline\"));",
      "    return;",
      "  }",
      "  onStartApply(entry);",
      "};",
    ].join("\n");
    expect(planEntryRefusesUnknownBaseline(tooLate), "闸门口令写在 build 之后：等于先生成再拒绝").toBe(false);
    const fixed = [
      "{!contentLoading && editing && (",
      "  <div className=\"browser-baseline-unknown\">",
      "    {t(\"config.baselineUnknownNotice\")}",
      "    <CopyButton text={draft} label={t(\"config.copyDraft\")} />",
      "  </div>",
      ")}",
      "<button className=\"btn btn-primary btn-sm\" onClick={saveAsPlan} disabled={!!contentError} aria-disabled={!!contentError}>",
      "  {t(\"config.saveAsPlan\")}",
      "</button>",
      "const saveAsPlan = () => {",
      "  if (!selected) return;",
      "  if (contentError) {",
      "    setSaveError(t(\"config.planBlockedNoBaseline\"));",
      "    return;",
      "  }",
      "  const entry = buildDirectWriteExitEntry({ desiredContent: draft });",
      "};",
      "setContentError(message);",
      "setRemoteMoved(null);",
    ].join("\n");
    expect(editBranchIsOpenOnFailure(fixed)).toBe(true);
    expect(failureExplainsItself(fixed)).toBe(true);
    expect(planEntryRefusesUnknownBaseline(fixed)).toBe(true);
    expect(planButtonIsDisabled(fixed)).toBe(true);
    expect(rewriteButtonGoesAwayWithBaseline(fixed)).toBe(true);
  });
});
