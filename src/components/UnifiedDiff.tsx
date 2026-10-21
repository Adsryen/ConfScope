import { useMemo, useRef, useState } from "react";
import { useTranslation } from "../i18n";
import { markHighlightedHtml, markLineSearchHits } from "../lib/codeLines";
import { diffLines } from "../lib/diff";
import { Format } from "../lib/format";
import { escapeHtml, highlightLine } from "../lib/highlight";
import { baseIndexForSide, marksForRowSide, toLineHits, type DiffFindRow, type DiffSide } from "../lib/diffFind";
import { useFindLayer } from "../lib/useFindLayer";
import { useScrollResetOnContentChange } from "../lib/useScrollResetOnContentChange";
import FindBar, { FindOpenButton } from "./FindBar";

interface Props {
  /** 上一版内容（无上一版时传空串，整体视为新增）。 */
  oldText: string;
  /** 当前查看版本的内容。 */
  newText: string;
  /** 提供时按该格式做语法高亮（TEXT 不高亮）。 */
  format?: Format;
  /**
   * 页面级正文搜索词（配置浏览「按内容搜索」模式的词）。
   *
   * 轮41 R41-1：`HistoryView` 的 `rawView` 初值是 `false`，用户点历史版本后**第一眼**看到的就是
   * 这块视图，词没传进来等于「搜完点开历史，默认这一屏一处都不标」。唯一来源仍是 ConfigBrowser
   * （经 HistoryView 透传），本组件不起第二份搜索状态、不复制 searchMode 判定、不读父级 DOM。
   * 缺省 / 空串 / 全空白 ⇒ 一处都不标（R41-4）。
   *
   * 轮49：查找栏打开时这一颗词**让位**给栏内词（两条出口互斥，见 markedLines），关栏后回来 ——
   * 与 CodeView 的 `effectiveTerm` 同一句话，不叠两层标红。
   */
  searchTerm?: string;
  /**
   * 宿主页面被保活隐藏时传 false：不挂 Ctrl+F 全局监听、不抢 Esc、不开别人的查找栏。
   * 与 DiffPanel / CodeView 同一个入参名，HistoryView 把自己的 `active` 原样传下来。
   */
  active?: boolean;
  /** 关掉查找入口（只读小面板复用本组件时用）。 */
  enableFind?: boolean;
}

type LineType = "ctx" | "add" | "del";

/** 统一（单列）差异视图：以「当前版本」为主，改动行用背景色高亮——
 *  新增绿、删除红、修改展开为红(旧)+绿(新)。用于「这一版改了哪些」。 */
export default function UnifiedDiff({ oldText, newText, format, searchTerm, active = true, enableFind = true }: Props) {
  const { t } = useTranslation();
  const hl = format && format !== "TEXT";
  const [onlyChanges, setOnlyChanges] = useState(false);
  const { rows, added, removed, modified } = useMemo(() => diffLines(oldText, newText), [oldText, newText]);

  /** Ctrl+F / F3 的所有权根：条子、⌕ 浮标、正文选区都在这棵树里（与 DiffPanel 同口径）。 */
  const rootRef = useRef<HTMLDivElement>(null);
  /** `.udiff` 是本视图唯一的滚动容器：定位命中行按它量，关栏后焦点也还给这一层（R62）。 */
  const bodyRef = useRef<HTMLDivElement>(null);
  const findBarRef = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  /** ⌕ 浮标的 ref 只服务于本文件的 JSX，共享层不读它。 */
  const findOpenBtnRef = useRef<HTMLButtonElement>(null);

  const allLines = useMemo(() => {
    const out: { type: LineType; no: number | null; text: string }[] = [];
    for (const r of rows) {
      switch (r.type) {
        case "equal":
          out.push({ type: "ctx", no: r.rightNo, text: r.right ?? "" });
          break;
        case "add":
          out.push({ type: "add", no: r.rightNo, text: r.right ?? "" });
          break;
        case "del":
          out.push({ type: "del", no: r.leftNo, text: r.left ?? "" });
          break;
        case "modify":
          out.push({ type: "del", no: r.leftNo, text: r.left ?? "" });
          out.push({ type: "add", no: r.rightNo, text: r.right ?? "" });
          break;
      }
    }
    return out;
  }, [rows]);

  const lines = useMemo(() => (onlyChanges ? allLines.filter((l) => l.type !== "ctx") : allLines), [allLines, onlyChanges]);

  /* ── 视图内查找（轮49 接入）──────────────────────────────────────────────────
   * 条子与状态编排都不在本文件里：FindBar.tsx 那唯一一份 + useFindLayer.ts 那唯一一份。
   * 本视图与并排差异（DiffPanel）同属「量 DOM」那一派：`.udiff-text` 是 pre-wrap + break-all，
   * 行高不固定 ⇒ 定位必须量 DOM，不能套代码视图的行号公式。
   * 单列视图每行只有一侧有文本，另一侧填 null ⇒ findDiffHits 只会在有文本的那侧出命中，
   * 「步进单位 = 行」自动成立，不需要第四个命中模块（del 行归 left、其余归 right）。
   */
  const findRows = useMemo<DiffFindRow[]>(
    () => lines.map((l, rowIndex) => ({ rowIndex, left: l.type === "del" ? l.text : null, right: l.type === "del" ? null : l.text })),
    [lines]
  );
  const find = useFindLayer({
    rows: findRows,
    externalTerm: searchTerm ?? "",
    active,
    enableFind,
    rootRef,
    bodyRef,
    findBarRef,
    findInputRef,
  });
  const {
    findOpen,
    findTerm,
    changeTerm,
    effectiveTerm,
    caseSensitive,
    wholeWord,
    toggleCaseSensitive,
    toggleWholeWord,
    result: findResult,
    hitCount,
    activeIdx,
    currentGroup,
    padTop,
    openFind,
    closeFind,
    navigate,
    onFindKeyDown,
  } = find;

  // 换正文归零 + 外部搜索词定位，两件事一条出口（轮56，与 DiffPanel 同口径）：
  // 历史变更里勾着搜索词切换版本，默认看到的就是这一屏（HistoryView 的 rawView 初值 false），
  // 原先本视图既没接滚动归零、也没人把首个命中滚进来 ⇒ 行号列停在上一版的偏移处，
  // 而新版的红字在屏幕外。定位口径整个待在 useFindLayer 里，本文件不许自己写 scrollTop。
  useScrollResetOnContentChange(bodyRef, [oldText, newText], find.locateFirstExternalHit);

  /**
   * 每行一次「产 HTML → 叠标记」，两者必须同源于这一行（轮41 R41-2/R41-5）。
   *
   * TEXT 档不再走第二个渲染出口（原先是 `<pre>{l.text}</pre>` 交给 React 转义）：
   * `escapeHtml` 的产物与 React 文本节点在 DOM 上等价，而标红需要拿到
   * 与偏移同一口径的 HTML 才能对齐 —— 两个出口就意味着「高亮档标得到、纯文本档标不到」。
   *
   * 两条出口互斥（轮49）：开栏时命中层用栏内词重建标记，关栏时逐字退回轮41 的外部词路径。
   * 「当前命中」不在这里叠 —— 它走 DOM 类（lib/codeLines 的 CURRENT_HIT_CLASS），
   * 所以 Enter 换一处命中时既不重新高亮也不重新解析 HTML。
   *
   * 命中指示只走行号变红：`.udiff-row.add/.del` 的背景是「新增/删除」的**语义色**，
   * 被搜索色盖掉就把两件事挤进同一个通道（R41-3）。
   */
  const markedLines = useMemo(
    () =>
      lines.map((l, rowIndex) => {
        const baseHtml = hl ? highlightLine(l.text, format!) : escapeHtml(l.text);
        if (findOpen) {
          const side: DiffSide = l.type === "del" ? "left" : "right";
          const marks = marksForRowSide(findResult, rowIndex, side);
          return {
            ...l,
            html: markHighlightedHtml(baseHtml, toLineHits(marks), baseIndexForSide(marks)),
            hits: marks.length,
          };
        }
        const marked = markLineSearchHits(baseHtml, l.text, searchTerm ?? "");
        return { ...l, html: marked.html, hits: marked.isHit ? 1 : 0 };
      }),
    [lines, hl, format, findOpen, findResult, searchTerm]
  );

  /**
   * 行号槽的命中态在**渲染时**算，不进上面那条 memo（轮28 F-14 在并排差异里挡过同一笔钱）：
   * 「当前是哪一组」按 Enter 就会变，圈进 memo 依赖等于每按一次把整篇 HTML 重新解析一遍，
   * 而标红本身根本不随序号变。单列视图每行只有一侧有文本 ⇒ currentGroup 的行号就是这一行。
   */
  function gutterClass(hits: number, rowIndex: number): string {
    if (!hits) return "udiff-gutter";
    const current = findOpen && currentGroup?.rowIndex === rowIndex;
    return `udiff-gutter is-hit${current ? " is-current" : ""}`;
  }
  const identical = added === 0 && removed === 0 && modified === 0;

  return (
    <div className="diff-panel" ref={rootRef}>
      <div className="diff-stats">
        {identical ? (
          <span className="diff-same">{t("diff.unifiedNoDiff")}</span>
        ) : (
          <>
            <span className="stat stat-add">{t("diff.statAdded", { count: added })}</span>
            <span className="stat stat-del">{t("diff.statDeleted", { count: removed })}</span>
            <span className="stat stat-mod">{t("diff.statModified", { count: modified })}</span>
          </>
        )}
        <label className="diff-toggle">
          <input type="checkbox" checked={onlyChanges} onChange={(e) => setOnlyChanges(e.target.checked)} />
          {t("diff.onlyChanges")}
        </label>
      </div>
      {/*
        tabIndex/role/aria-label 不是顺手加的合规装饰：关栏要把焦点还给正文这一层（R62），
        少了它 `bodyRef.current?.focus()` 是空操作，实测 activeElement 掉回 body，
        用户接着按方向键 / PageUp 一动不动，必须先用鼠标点一下正文。
      */}
      <div className="udiff mono" ref={bodyRef} tabIndex={0} role="region" aria-label={t("config.content")}>
        {/*
          查找条的锚点：与 DiffPanel 复用同一条 sticky CSS（`.diff-find-anchor`）和同一个净空语义——
          锚点是滚动容器的在流子元素，条子跟着正文滚到哪儿都悬在最上；高度 = padTopForFindBar 那一个数，
          开栏时第一行让到条子下面、关栏时归零。锚点自己不吃鼠标，免得这条带子挡住行上的选区与滚轮。
        */}
        {enableFind && (
          <div className="diff-find-anchor" style={{ height: `${padTop}px` }}>
            {findOpen ? (
              <FindBar
                term={findTerm}
                hasTerm={Boolean(effectiveTerm)}
                hitCount={hitCount}
                currentHit={activeIdx}
                capped={findResult.capped}
                cappedMax={hitCount}
                caseSensitive={caseSensitive}
                wholeWord={wholeWord}
                onTermChange={changeTerm}
                onInputKeyDown={onFindKeyDown}
                onToggleCaseSensitive={toggleCaseSensitive}
                onToggleWholeWord={toggleWholeWord}
                onNavigate={navigate}
                onClose={closeFind}
                barRef={findBarRef}
                inputRef={findInputRef}
              />
            ) : (
              <FindOpenButton onOpen={openFind} btnRef={findOpenBtnRef} />
            )}
          </div>
        )}
        {markedLines.map((l, i) => (
          <div className={`udiff-row ${l.type}`} key={i} data-row-index={i}>
            <span className={gutterClass(l.hits, i)}>{l.no ?? ""}</span>
            <span className="udiff-mark">{l.type === "add" ? "+" : l.type === "del" ? "−" : " "}</span>
            <pre className="udiff-text" dangerouslySetInnerHTML={{ __html: l.html }} />
          </div>
        ))}
      </div>
    </div>
  );
}
