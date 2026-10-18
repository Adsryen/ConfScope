/**
 * `disabled` 的原生控件上 `title` 提示根本不会显示（轮26 F-1）。
 *
 * 取证：`research/disabledTooltipProbe.cjs`（xvfb-run + headed chromium + 抓屏比 md5，正反序各一轮）——
 * | 构造 | 提示 |
 * |---|---|
 * | 启用 `<button title>` | ✅ |
 * | `disabled` `<button title>` | ❌ 一个像素都不变 |
 * | `<span title>` 包住 disabled 按钮（网上流行的 wrapper 绕法） | ❌ |
 * | `<span title>` + disabled 子元素 `pointer-events:none`（命中节点确认是带 title 的 span） | ❌ |
 * | `<span title>` 包住启用按钮 | ✅ |
 * | `aria-disabled="true"`（不写 disabled）+ `title` | ✅ |
 * ⇒ Blink 在 tooltip 路径上对 disabled 表单控件整段放弃：不看自身 title，也不再向上走祖先。
 *
 * 所以「给按钮加个 title 解释为什么点不动」在禁用态是**写了等于没写**。
 * 现存量逐条读码后判定为无害：这些 title 全是动作名（复制 / 上一页 / 刷新）或瞬时忙态理由
 * （保存中 / 导出中 / 匹配中），动作名在按钮上另有可见文字或 `aria-label`，
 * 忙态理由在别处已经可见（快照按钮把理由写进按钮文字、导出走 TaskCenter 进度项）。
 * 把它们统统换成 `aria-disabled` 要在每个 handler 里补早退闸，风险大于收益 ⇒ 不动存量，
 * 只把口径钉成守卫：**新增不许再往 disabled 控件上挂 title**。
 * 要表达禁用理由，二选一：理由写进按钮文字/紧邻的可见文案，或改 `aria-disabled` + handler 早退。
 *
 * 扫描口径：只看标签头里的**字面属性**。`{...busyProps()}` 这类展开属性看不见（`disabled` 由
 * helper 决定时，title 通常也是同一处 helper 给的，属于运行时语义，静态守卫不猜）。
 */
import { describe, expect, it } from "vitest";
import { readScannedSource, sourceFiles } from "./scanUtils";

/** 需要禁用语义的原生表单控件——只有它们的 title 会被 Blink 整段跳过。 */
const NATIVE_CONTROLS = new Set(["button", "input", "select", "textarea"]);

/** 基线：现存量，只减不增。键 = `文件|<标签> 折叠空白后的标签头前缀`（不用行号，挪动位置不算新增）。 */
const BASELINE: Record<string, string[]> = {
  "src/components/BackupView.tsx": [
    '<button className="btn btn-ghost btn-sm" onClick={loadSnapshots} disabled={loading} title={t("backup.refresh")}>',
    '<button className="btn btn-ghost btn-sm backup-config-compare" onClick={() => jumpToDiff(selectedSnapshot, cfg)} disabled={!selectedSnapshot.path} tit',
  ],
  "src/components/CodeEditor.tsx": [
    '<button type="button" className="code-find-btn" onClick={() => navigate(-1)} disabled={!hits.length} title={t("config.findPrevKey")} aria-label={t("co',
    '<button type="button" className="code-find-btn" onClick={() => navigate(1)} disabled={!hits.length} title={t("config.findNextKey")} aria-label={t("con',
  ],
  "src/components/CodeView.tsx": [
    '<button type="button" className="code-find-btn" onClick={() => navigate(-1)} disabled={!hits.length} title={t("config.findPrevKey")} aria-label={t("co',
    '<button type="button" className="code-find-btn" onClick={() => navigate(1)} disabled={!hits.length} title={t("config.findNextKey")} aria-label={t("con',
  ],
  "src/components/ConfigBrowser.tsx": [
    '<button className="btn btn-ghost btn-sm browser-icon-btn" onClick={() => searchMode === "content" ? searchAllContent(search, selectedGroup) : fetchLis',
    '<button className="btn btn-ghost btn-sm browser-icon-btn" title={ sourceExporting ? t("config.exportInFlight") : t("config.exportCurrentList") } aria-',
    '<button className="btn btn-ghost btn-sm browser-icon-btn" title={ sourceExporting ? t("config.exportInFlight") : t("config.exportSourceFilesToDirector',
    '<button className="btn btn-ghost btn-sm snapshot-action-btn" onClick={createSnapshot} disabled={snapshotSaving || listLoading} title={snapshotSaving ?',
    '<button className="btn btn-primary btn-sm" onClick={saveEdit} disabled={saving} title={t("config.saveShortcutHint")}>',
    '<button className="btn btn-ghost btn-sm" onClick={() => selected && openConfig(selected)} title={t("config.refreshContent")} disabled={contentLoading}',
  ],
  "src/components/ConfigEditor.tsx": [
    '<button className="btn btn-primary" onClick={save} disabled={saving} title={t("config.saveShortcutHint")}>',
  ],
  "src/components/CopyButton.tsx": [
    '<button className="btn btn-ghost btn-sm" onClick={onClick} disabled={!text} title={t("common.copyToClipboard")}>',
  ],
  "src/components/DeleteConfirm.tsx": [
    '<button className="modal-x" onClick={onCancel} disabled={busy} title={t("common.close")} aria-label={t("common.close")}>',
  ],
  "src/components/DiffView.tsx": [
    '<button type="button" className="btn btn-ghost btn-sm" onClick={() => doMatch()} disabled={matchLoading} title={t("diff.refreshMatch")} >',
  ],
  "src/components/HistoryView.tsx": [
    '<button className={`btn btn-sm ${rbConfirm ? "btn-danger" : "btn-ghost"}`} onClick={rollback} onBlur={() => setRbConfirm(false)} disabled={rollingBack',
  ],
  "src/components/MessageCenter.tsx": [
    '<button className="message-icon-btn" onClick={clearErrors} disabled={items.length === 0} title={t("messageCenter.clear")} aria-label={t("messageCenter',
  ],
  "src/components/Pager.tsx": [
    '<button className="btn btn-ghost btn-sm" disabled={loading || page <= 1} onClick={() => onPage(page - 1)} title={t("common.previousPage")} aria-label=',
    '<button className="btn btn-ghost btn-sm" disabled={loading || page >= pages} onClick={() => onPage(page + 1)} title={t("common.nextPage")} aria-label=',
  ],
};

/**
 * 从 `<name` 起走到标签头的结束 `>`：`()` / `{}` / `[]` / 嵌套 `<` 都在闭合前继续走，
 * 字符串与模板里的括号不算层数（属性值里写 `title="a > b"` 不能提前收尾）。
 */
function tagHeader(src: string, start: number): { header: string; end: number } | null {
  // 标签自己的 `<` 不算一层：从它后面一格开始走，否则整串属性都会被当成"嵌套内容"看不见。
  let i = start + 1;
  let brace = 0;
  let paren = 0;
  let bracket = 0;
  let angle = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") i += 2;
      else if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === "{") brace += 1;
    else if (ch === "}") {
      brace -= 1;
      if (brace < 0) return null;
    } else if (ch === "(") paren += 1;
    else if (ch === ")") {
      if (paren === 0 && brace === 0) break;
      paren = Math.max(0, paren - 1);
    } else if (ch === "[") bracket += 1;
    else if (ch === "]") bracket = Math.max(0, bracket - 1);
    else if (ch === "<") angle += 1;
    else if (ch === ">") {
      if (brace === 0 && paren === 0 && bracket === 0 && angle === 0) return { header: src.slice(start, i + 1), end: i };
      angle = Math.max(0, angle - 1);
    }
    i += 1;
  }
  return null;
}

/**
 * 把标签头里「非顶层」的内容换成空格：属性表达式 `{...}`、`(...)`、字符串内部都不参与属性名识别，
 * 于是 `title="已禁用"` 里的中文不会被当成另一个属性。
 */
function topLevelMask(header: string): string {
  const chars = [...header];
  let brace = 0;
  let paren = 0;
  let bracket = 0;
  let angle = 0;
  let quote: string | null = null;
  // 同样跳过标签自己的 `<`（i=0），它不是嵌套层。
  for (let i = 1; i < chars.length; i += 1) {
    const ch = chars[i];
    if (quote) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      else chars[i] = " ";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    const nested = brace > 0 || paren > 0 || bracket > 0 || angle > 0;
    if (nested) chars[i] = " ";
    if (ch === "{") brace += 1;
    else if (ch === "}") brace = Math.max(0, brace - 1);
    else if (ch === "(") paren += 1;
    else if (ch === ")") paren = Math.max(0, paren - 1);
    else if (ch === "[") bracket += 1;
    else if (ch === "]") bracket = Math.max(0, bracket - 1);
    else if (ch === "<") angle += 1;
    else if (ch === ">") angle = Math.max(0, angle - 1);
  }
  return chars.join("");
}

/** 顶层属性名集合（带值与不带值都算）。 */
function attributeNames(mask: string): Set<string> {
  const names = new Set<string>();
  for (const m of mask.matchAll(/(^|[\s/>])([A-Za-z][A-Za-z0-9-]*)/g)) names.add(m[2]);
  return names;
}

/** 基线条目的键长度：够唯一，又不至于把整段 JSX 抄进测试。 */
const KEY_LENGTH = 150;

interface Site {
  /** `文件|折叠空白后的标签头`——不随行号漂移。 */
  key: string;
  file: string;
  line: number;
  tag: string;
}

/** src 生产代码里 `disabled` 与 `title` 同时出现在标签头上的原生表单控件。 */
function disabledWithTitleSites(): Site[] {
  const sites: Site[] = [];
  sourceFiles()
    .filter((file) => file.endsWith(".tsx"))
    .forEach((file) => {
      const src = readScannedSource(file);
      for (const m of src.matchAll(/<(button|input|select|textarea)(?=[\s/>])/g)) {
        const found = tagHeader(src, m.index);
        if (!found) continue;
        const attrs = attributeNames(topLevelMask(found.header));
        if (!attrs.has("disabled") || !attrs.has("title")) continue;
        const key = `${file}|${found.header.replace(/\s+/g, " ").trim().slice(0, KEY_LENGTH)}`;
        sites.push({ key, file, line: src.slice(0, m.index).split("\n").length, tag: m[1] });
      }
    });
  return sites;
}

function baselineKeys(): Set<string> {
  return new Set(Object.entries(BASELINE).flatMap(([file, keys]) => keys.map((key) => `${file}|${key}`)));
}

describe("disabled 的原生控件不许靠 title 表达禁用理由", () => {
  it("没有新增「disabled + title」的站点（Blink 在这条路径上不弹提示）", () => {
    const allowed = baselineKeys();
    const found = disabledWithTitleSites()
      .filter((site) => !allowed.has(site.key))
      .map(
        (site) => `${site.file}:L${site.line} <${site.tag}> ${site.key.split("|")[1]}
    ↑ 禁用态的 title 不会显示：理由写进按钮文字/紧邻可见文案，或改 aria-disabled 并给 handler 补早退`
      );
    expect(found, `这些控件禁用了还挂 title，用户悬停什么都看不到：\n${found.join("\n")}`).toEqual([]);
  });

  it("基线只减不增：已经改好的条目要一起删掉", () => {
    const alive = new Set(disabledWithTitleSites().map((site) => site.key));
    const stale = [...baselineKeys()].filter((key) => !alive.has(key));
    expect(stale, "这些站点已经不存在了，请把基线里对应条目删掉").toEqual([]);
  });

  it("基线非空且扫描口径没空转（守卫自己也要能被证伪）", () => {
    const sites = disabledWithTitleSites();
    expect(sites.length, "扫描没找到任何 disabled+title 站点，说明口径失效了（源码里明明有）").toBeGreaterThan(0);
    expect(baselineKeys().size).toBe(sites.length);
  });
});
