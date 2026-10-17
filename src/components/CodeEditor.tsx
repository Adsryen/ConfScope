import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties } from "react";
import { Format } from "../lib/format";
import { EscapePriority, isImeComposing, useEscape } from "../lib/useEscape";
import { isSaveShortcutKey } from "../lib/saveShortcut";
import { highlightCode } from "../lib/highlight";
import {
  activeLineOf,
  activeOffsetOf,
  findCodeHits,
  hitLines,
  lineOffsets,
  markHighlightedHtml,
  normalizeLineEndings,
  splitLines,
  type CodeHit,
} from "../lib/codeLines";
import { useTranslation } from "../i18n";
import { useRememberedState } from "../lib/viewState";
import { pickFindTermOnOpen, textareaSelectionText } from "../lib/findSelection";
import type { MatchOptions } from "../lib/textMatch";

interface Props {
  value: string;
  onChange: (v: string) => void;
  format: Format;
  placeholder?: string;
  /** 可访问名兜底：正文编辑器常被单独放置（变更计划的目标内容、配置浏览的编辑抽屉），
   *  没有包裹式 label 时读屏只能念出「编辑框」。优先取调用方给的名字，退而用 placeholder。 */
  ariaLabel?: string;
  /** 外部内容搜索词：进入编辑态后仍保持标红，与浏览态一致。 */
  searchTerm?: string;
  /** 是否启用编辑态视图内查找（Ctrl+F / F3）。 */
  enableFind?: boolean;
  /**
   * 宿主页面是否在前台。被保活隐藏的页面里的编辑器不能再挂全局 Ctrl+F 监听，
   * 否则隐藏的查找栏会抢走前台页面的快捷键。
   */
  active?: boolean;
  /**
   * Ctrl/Cmd+S 的出口（R47）。焦点在编辑区内时「保存」指的就是这份内容，不能让按键漏出去。
   * 不传表示宿主没有保存动作（变更计划的目标内容编辑器）：编辑器不装作拥有这个语义，
   * 交给 App 的全局兜底把原生「保存网页」对话框吞掉。
   */
  onSave?: () => void;
}

/** 对外暴露的编辑器命令式入口（父组件用它打开查找、跳到指定行）。 */
export interface CodeEditorHandle {
  openFind: () => void;
  /** 跳到 1 基行号：选区落到该行并把焦点交回编辑区。校验错误「跳到第 N 行」用它。 */
  revealLine: (lineOneBased: number) => void;
}

// 几何常量：与 styles.css 里 .code-editor 的 CSS 变量严格同源（读磁盘静态守卫盯着）。
// 行 i 在滚动内容中的 top = PAD_TOP + i * ROW_H 是行号、命中行底色、跳转定位共同的依据。
const ROW_H = 20;
const GUTTER_W = 52;
const PAD_TOP = 12;
const PAD_LEFT_EXTRA = 14;
const MAX_FALLBACK_ROWS = 200; // clientHeight 未知（首帧 / jsdom）时兜底渲染的行数
const PROBE_CHARS = 20; // 隐形探针里放多少个等宽字符用来量字宽

/**
 * 查找栏选项的模块级常量：与 CodeView 同一口径。
 * 复用同一个引用，非查找态时 hits 的 useMemo 才不会每渲染重算一次。
 */
const NEUTRAL_MATCH_OPTIONS: MatchOptions = {};

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

/** 带语法高亮的可编辑代码框:透明 textarea 叠在高亮 <pre> 之上,
 *  光标/选区来自 textarea,着色来自下层 pre,滚动同步。配色与 CodeView 一致。
 *
 *  与浏览态对齐的三件事（R22）：行号槽、搜索词标红与命中行高亮、视图内 Ctrl+F 查找。
 *  另有一条编辑态专属快捷键（R47）：Ctrl/Cmd+S 走宿主的 onSave，保存的是这份内容而不是整个网页。
 *  刻意不做缩略图：编辑态内容一直在变，重算成本换来的收益低于风险。
 *  不变式：查找定位只改 textarea 的选区与滚动，绝不改 value。 */
const CodeEditor = forwardRef<CodeEditorHandle, Props>(function CodeEditor(
  { value, onChange, format, placeholder, ariaLabel, searchTerm = "", enableFind = true, active = true, onSave }: Props,
  ref
) {
  const { t } = useTranslation();

  const rootRef = useRef<HTMLDivElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const gutterInnerRef = useRef<HTMLDivElement>(null);
  const linesInnerRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);

  const [findOpen, setFindOpen] = useState(false);
  const [findTerm, setFindTerm] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  // 查找栏的两个匹配开关：与浏览态（CodeView）共用同一对记忆键，
  // 浏览态勾了「区分大小写」再进编辑态不必重勾一遍。
  const [caseSensitive, setCaseSensitive] = useRememberedState<boolean>("codeFind.caseSensitive", false);
  const [wholeWord, setWholeWord] = useRememberedState<boolean>("codeFind.wholeWord", false);

  const [metrics, setMetrics] = useState({ scrollTop: 0, clientHeight: 0 });
  // 「跳到第 N 行」落点：不在查找态时也要能高亮那一行
  const [pinnedLine, setPinnedLine] = useState<number | null>(null);

  // 归一到 DOM 真正承载的文本（textarea.value 会吃掉 \r），后续所有偏移、行数组、高亮层都用它，
  // 保证选区、Tab 缩进、高亮标记落在同一套坐标上（R28 修正）。
  const doc = useMemo(() => normalizeLineEndings(value), [value]);
  const lines = useMemo(() => splitLines(doc), [doc]);
  const totalLines = lines.length;

  // 查找栏打开时以查找词为准；否则沿用外部内容搜索词（只标红，不区分当前命中）。
  const effectiveTerm = findOpen ? findTerm : searchTerm;
  // 开关只作用于查找栏自己输入的词。栏一关就退回中性口径：外部内容搜索词必须继续
  // 「大小写不敏感子串」，否则编辑态的标红会和左侧列表的命中数分叉。
  const matchOptions = useMemo<MatchOptions>(
    () => (findOpen ? { caseSensitive, wholeWord } : NEUTRAL_MATCH_OPTIONS),
    [findOpen, caseSensitive, wholeWord]
  );
  const hits = useMemo(() => findCodeHits(doc, effectiveTerm.trim(), matchOptions), [doc, effectiveTerm, matchOptions]);
  const hitSet = useMemo(() => hitLines(hits), [hits]);

  const activeOffset = findOpen ? activeOffsetOf(hits, activeIdx) : null;
  const currentLine = findOpen ? activeLineOf(hits, activeIdx) : pinnedLine;

  // 末尾只在原文本身以换行结尾时才补一个换行,保证高亮层与 textarea 行数严格一致
  // (无条件补 "\n" 会让高亮层多出一行空行,拖拽选区/滚动同步在长文档上发生偏移)
  // 高亮层用 HTML 表示,而 HTML 解析会把“片段末尾的换行”再补一个换行
  // (<div>x\n</div> 解析后 textContent 为 x\n\n),导致 pre 比 textarea 多一行、
  // 拖拽选区/滚动同步偏移。因此末尾换行不用裸 "\n" 表示,而是放在一个空 span 里
  // (解析后不产生额外文本),保证高亮层文本与 textarea 值严格一致。
  const html = useMemo(() => {
    const base = highlightCode(doc, format);
    const withTail = doc.endsWith("\n") ? base + "<span></span>" : base;
    // 只在已转义 HTML 的文本区按整文档偏移插标记，标签结构原样保留，
    // 高亮层的 textContent 仍与 textarea 的值逐字相等（retest 依赖这条）。
    return markHighlightedHtml(withTail, hits, activeOffset);
  }, [doc, format, hits, activeOffset]);

  const syncScroll = useCallback(() => {
    const ta = taRef.current;
    const pre = preRef.current;
    if (!ta) return;
    const top = ta.scrollTop;
    if (pre) {
      pre.scrollTop = top;
      pre.scrollLeft = ta.scrollLeft;
    }
    // 行号 / 命中行用 transform 直接跟手，不等 React 重渲染。
    const transform = `translateY(${-top}px)`;
    if (gutterInnerRef.current) gutterInnerRef.current.style.transform = transform;
    if (linesInnerRef.current) linesInnerRef.current.style.transform = transform;
    setMetrics({ scrollTop: top, clientHeight: ta.clientHeight });
  }, []);

  /** 量一个等宽字符的像素宽度；首帧或 jsdom（无布局）量不到时返回 0。 */
  const measureCharWidth = useCallback((): number => {
    const probe = probeRef.current;
    if (!probe) return 0;
    const width = probe.getBoundingClientRect().width / PROBE_CHARS;
    return Number.isFinite(width) && width > 0 ? width : 0;
  }, []);

  const scrollLineIntoView = useCallback(
    (line: number) => {
      const ta = taRef.current;
      if (!ta) return;
      const y = PAD_TOP + line * ROW_H;
      ta.scrollTop = clamp(y - ta.clientHeight / 2, 0, Math.max(0, ta.scrollHeight - ta.clientHeight));
      // 直接调一次同步：程序化滚动在 jsdom 里不触发 scroll 事件，真机也要保证当帧对齐
      syncScroll();
    },
    [syncScroll]
  );

  /** 长行里的命中可能横向滚出视口，按列宽把水平位置也带过去。 */
  const scrollColumnIntoView = useCallback(
    (hit: CodeHit) => {
      const ta = taRef.current;
      if (!ta) return;
      const charW = measureCharWidth();
      if (!charW) return; // 量不到字宽就不动水平滚动，避免把用户已有的横向偏移清掉
      const x = hit.column * charW;
      ta.scrollLeft = clamp(x - ta.clientWidth / 2, 0, Math.max(0, ta.scrollWidth - ta.clientWidth));
      syncScroll();
    },
    [measureCharWidth, syncScroll]
  );

  /** 把选区与滚动落到一次命中上。注意：只动选区，不动 value。 */
  const revealHit = useCallback(
    (hit: CodeHit) => {
      const ta = taRef.current;
      if (ta) {
        // 未聚焦时选区不渲染，靠 <mark class="search-hit-current"> 和命中行底色表达当前位置；
        // 关闭查找栏后用户接着输入/替换时，这个选区已经就位。
        ta.setSelectionRange(hit.offset, hit.offset + hit.length);
      }
      setPinnedLine(hit.line);
      scrollLineIntoView(hit.line);
      scrollColumnIntoView(hit);
    },
    [scrollColumnIntoView, scrollLineIntoView]
  );

  /**
   * 打开查找栏，初值口径与浏览态 CodeView 完全一致：
   * **选区 > 栏内旧词 > 外部搜索词**（轮26 F-3，见 ../lib/findSelection）。
   *
   * 编辑态的选中内容不走 window.getSelection()，必须读 textarea 的 selectionStart/End；
   * 同样要在 setState 前同步读，输入框聚焦后 textarea 的选区就没了。
   * 注意 Enter/F3 导航会经 revealHit 把选区落在当前命中上，所以「栏已开时再按 Ctrl+F」
   * 读到的是上一处命中——旧词本就与它相同，行为天然延续，不需要额外区分。
   */
  const openFind = useCallback(() => {
    const selectionRaw = textareaSelectionText(taRef.current);
    setPinnedLine(null);
    setFindOpen(true);
    setFindTerm((prev) => pickFindTermOnOpen({ previous: prev, selectionRaw, external: searchTerm }));
    const focusInput = () => {
      const input = findInputRef.current;
      if (input) {
        input.focus();
        input.select();
      }
    };
    // 等查找条挂载后再聚焦；rAF 不可用（如 jsdom 首帧）时退到微任务。
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(focusInput);
    else setTimeout(focusInput, 0);
  }, [searchTerm]);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindTerm("");
    setActiveIdx(0);
    // 查找结束回到编辑：把焦点还给文本区，用户不用重新点一下才能继续打字
    taRef.current?.focus();
  }, []);

  // 查找栏是弹层内部的瞬时层，必须自己登记：ConfigEditor 以 overlay 优先级注册，
  // 裸 onKeyDown 的 Esc 在捕获阶段就被吃掉，一次 Esc 会直接关掉整个弹层（R61）。
  useEscape(active && findOpen, closeFind, EscapePriority.find);

  const navigate = useCallback(
    (delta: number) => {
      if (!hits.length) return;
      const next = (activeIdx + delta + hits.length) % hits.length;
      setActiveIdx(next);
      revealHit(hits[next]);
    },
    [activeIdx, hits, revealHit]
  );

  const revealLine = useCallback(
    (lineOneBased: number) => {
      if (!totalLines) return;
      const line = clamp(lineOneBased - 1, 0, totalLines - 1);
      const start = lineOffsets(lines)[line] ?? 0;
      // doc 已归一，行内不再有 \r，选区长度就是这一行可见文本的长度
      const textLength = lines[line].length;
      const ta = taRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(start, start + textLength);
      }
      setFindOpen(false);
      setFindTerm("");
      setPinnedLine(line);
      scrollLineIntoView(line);
    },
    [lines, scrollLineIntoView, totalLines]
  );

  useImperativeHandle(ref, () => ({ openFind, revealLine }), [openFind, revealLine]);

  // 搜索词 / 匹配口径 / 内容变化：重置当前命中序号，避免越界或指向改动前的位置。
  // 口径必须进依赖：勾上「全词」后命中会变少，旧的 activeIdx 可能已经越过新的末尾，
  // 计数「第 N/M 处」会显示成不存在的位置。
  useEffect(() => {
    setActiveIdx(0);
  }, [effectiveTerm, matchOptions, doc]);

  // 打开 / 改变查找词后，把选区与滚动落到当前命中（前后导航在 navigate 里即时做）。
  useEffect(() => {
    if (!findOpen || !hits.length) return;
    revealHit(hits[clamp(activeIdx, 0, hits.length - 1)]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findOpen, effectiveTerm, matchOptions]);

  // 内容整体换掉（切文件/切草稿）时收起查找栏，防止旧关键词污染新内容。
  useEffect(() => {
    setFindOpen(false);
    setFindTerm("");
    setPinnedLine(null);
  }, [format]);

  useEffect(() => {
    syncScroll();
    // 挂载后尺寸才稳定，再测一次，保证首屏行号不是兜底的那几十行
    const raf = (window as unknown as { requestAnimationFrame?: (cb: () => void) => number }).requestAnimationFrame;
    if (raf) raf(syncScroll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visibleRange = useMemo(() => {
    const { scrollTop, clientHeight } = metrics;
    if (clientHeight <= 0) return { start: 0, end: Math.min(totalLines, MAX_FALLBACK_ROWS) };
    const start = clamp(Math.floor((scrollTop - PAD_TOP) / ROW_H) - 1, 0, totalLines);
    const end = clamp(Math.ceil((scrollTop + clientHeight - PAD_TOP) / ROW_H) + 1, 0, totalLines);
    return { start, end };
  }, [metrics, totalLines]);

  const lineNumbers = useMemo(() => {
    const out: number[] = [];
    for (let i = visibleRange.start; i < visibleRange.end; i += 1) out.push(i);
    return out;
  }, [visibleRange]);

  const hitRows = useMemo(() => {
    const seen = new Set<number>();
    const out: number[] = [];
    const { start, end } = visibleRange;
    for (const hit of hits) {
      if (hit.line >= start && hit.line < end && !seen.has(hit.line)) {
        seen.add(hit.line);
        out.push(hit.line);
      }
    }
    if (pinnedLine !== null && pinnedLine >= start && pinnedLine < end && !seen.has(pinnedLine)) out.push(pinnedLine);
    out.sort((a, b) => a - b);
    return out;
  }, [hits, pinnedLine, visibleRange]);

  // Ctrl+F / Cmd+F / F3：编辑态必须自己接管。浏览态 CodeView 的监听在焦点落到
  // textarea 这类可编辑控件时故意不接管（不抢输入框的查找），所以光脚按 Ctrl+F 以前是死键。
  useEffect(() => {
    if (!enableFind || !active) return;
    const handler = (e: KeyboardEvent) => {
      // 组合态期间不劫持 Ctrl+F / F3：此刻按键属于输入法候选，不该被查找栏抢走
      if (isImeComposing(e)) return;
      const key = e.key;
      const isFindKey = (e.ctrlKey || e.metaKey) && (key === "f" || key === "F");
      const isF3 = key === "F3";
      if (!isFindKey && !isF3) return;
      // F3 只有在查找栏已打开时才导航，否则把系统原生行为留给调用方
      if (isF3 && !findOpen) return;

      const root = rootRef.current;
      const target = e.target as EventTarget | null;
      const inRoot = !!root && target instanceof Node && root.contains(target);
      const focused = document.activeElement as HTMLElement | null;
      const onBody = !focused || focused === document.body || focused === document.documentElement;
      // 焦点在本编辑器内 → 接管；焦点在别处的输入框 → 让给它。
      const mine = inRoot || focused === taRef.current;
      // 没有焦点时也要能按出来，但页面里存在浏览态 CodeView（它自己监听 Ctrl+F）就不抢，
      // 避免同一快捷键被两个视图同时接管。
      const fallback = onBody && !document.querySelector(".code-view");
      if (!mine && !fallback) return;

      e.preventDefault();
      if (isF3) {
        navigate(e.shiftKey ? -1 : 1);
        return;
      }
      openFind();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [active, enableFind, findOpen, navigate, openFind]);

  const onFindKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // 组合态回车是「上屏候选词」，不是「跳到下一个命中」
    if (isImeComposing(e)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      navigate(e.shiftKey ? -1 : 1);
    }
    // Esc 不在这里处理：查找栏已登记为 find 优先级的瞬时层（R61），裸分支跑不到。
  };

  // Tab 键插入两个空格而不是切换焦点
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 组合态的 Tab 属于输入法（部分输入法用 Tab 做整句/候选页切换），不能拦成插空格
    if (isImeComposing(e)) return;
    // Ctrl/Cmd+S：焦点在编辑区里，保存的就是这份内容（R47）。
    // 只在 textarea 本地拦——查找栏里的 Ctrl+S 不该被当成保存，浏览态也不归这里管。
    if (onSave && isSaveShortcutKey(e)) {
      e.preventDefault();
      onSave();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const ta = e.currentTarget;
      const { selectionStart: s, selectionEnd: end } = ta;
      const next = doc.slice(0, s) + "  " + doc.slice(end);
      onChange(next);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = s + 2;
      });
    }
  };

  const vars = {
    "--code-row-h": `${ROW_H}px`,
    "--code-gutter-w": `${GUTTER_W}px`,
    "--code-pad-top": `${PAD_TOP}px`,
    "--code-pad-left": `${GUTTER_W + PAD_LEFT_EXTRA}px`,
  } as CSSProperties;

  return (
    <div className="code-editor" ref={rootRef} style={vars}>
      {/* 命中行底色层：与文本共享同一 ROW_H 网格，位于文本之下 */}
      <div className="code-lines" aria-hidden="true">
        <div className="code-lines-layer" ref={linesInnerRef}>
          {hitRows.map((line) => (
            <div
              key={`line-${line}`}
              className={`code-line${line === currentLine ? " is-current" : " is-hit"}`}
              style={{ top: PAD_TOP + line * ROW_H }}
            />
          ))}
        </div>
      </div>

      <pre ref={preRef} className="code-editor-pre mono hljs" aria-hidden="true">
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>

      <textarea
        ref={taRef}
        className="code-editor-ta mono"
        value={doc}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        wrap="off"
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        onKeyDown={onKeyDown}
      />

      {/* 行号槽：与浏览态复用同一套 .code-gutter/.code-ln 与 CSS 变量 */}
      {totalLines > 0 && (
        <div className="code-gutter" aria-hidden="true">
          <div className="code-gutter-layer" ref={gutterInnerRef}>
            {lineNumbers.map((i) => (
              <div
                key={`ln-${i}`}
                className={`code-ln${i === currentLine ? " is-current" : hitSet.has(i) ? " is-hit" : ""}`}
                style={{ top: PAD_TOP + i * ROW_H }}
              >
                {i + 1}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 隐形探针：量等宽字符像素宽（wrap=off 的横向定位要用），不参与布局与命中 */}
      <span ref={probeRef} className="code-editor-probe mono" aria-hidden="true">
        {"0".repeat(PROBE_CHARS)}
      </span>

      {enableFind && !findOpen && (
        <button
          type="button"
          className="code-find-open"
          onClick={openFind}
          title={t("config.openFind")}
          aria-label={t("config.openFind")}
          aria-keyshortcuts="Control+F"
        >
          ⌕
        </button>
      )}

      {enableFind && findOpen && (
        <div className="code-find" role="search">
          <input
            ref={findInputRef}
            className="code-find-input mono"
            spellCheck={false}
            type="text"
            value={findTerm}
            placeholder={t("config.findPlaceholder")}
            aria-label={t("config.findPlaceholder")}
            onChange={(e) => {
              setFindTerm(e.target.value);
              setActiveIdx(0);
            }}
            onKeyDown={onFindKeyDown}
          />
          {/* 匹配口径开关。onMouseDown preventDefault：按钮默认会夺走焦点，
              点一下开关就得再点一次输入框才能继续改词；编辑态里更糟——
              焦点离开 textarea 会让当前选区一起消失。 */}
          <button
            type="button"
            className={`code-find-toggle${caseSensitive ? " is-on" : ""}`}
            aria-pressed={caseSensitive}
            aria-label={t("config.findCaseSensitive")}
            title={t("config.findCaseSensitive")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setCaseSensitive((v) => !v)}
          >
            Aa
          </button>
          <button
            type="button"
            className={`code-find-toggle${wholeWord ? " is-on" : ""}`}
            aria-pressed={wholeWord}
            aria-label={t("config.findWholeWord")}
            title={t("config.findWholeWord")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setWholeWord((v) => !v)}
          >
            ab|
          </button>
          <span className="code-find-count" aria-live="polite">
            {hits.length
              ? t("config.findCount", { current: clamp(activeIdx, 0, hits.length - 1) + 1, total: hits.length })
              : effectiveTerm
                ? t("config.findNone")
                : t("config.findHint")}
          </span>
          <button
            type="button"
            className="code-find-btn"
            onClick={() => navigate(-1)}
            disabled={!hits.length}
            title={t("config.findPrevKey")}
            aria-label={t("config.findPrev")}
            aria-keyshortcuts="Shift+Enter Shift+F3"
          >
            ↑
          </button>
          <button
            type="button"
            className="code-find-btn"
            onClick={() => navigate(1)}
            disabled={!hits.length}
            title={t("config.findNextKey")}
            aria-label={t("config.findNext")}
            aria-keyshortcuts="Enter F3"
          >
            ↓
          </button>
          <button
            type="button"
            className="code-find-btn"
            onClick={closeFind}
            title={t("config.findCloseKey")}
            aria-label={t("config.findClose")}
            aria-keyshortcuts="Escape"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
});

export default CodeEditor;
