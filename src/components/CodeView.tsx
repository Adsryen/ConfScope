import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Format } from "../lib/format";
import { highlightCode } from "../lib/highlight";
import { activeLineOf, activeOffsetOf, buildMinimapRows, findCodeHits, hitLines, markHighlightedHtml, splitLines } from "../lib/codeLines";
import { useTranslation } from "../i18n";

interface Props {
  code: string;
  format: Format;
  /** 内容搜索词：在已转义的高亮 HTML 文本上二次标记命中词（大小写不敏感）。 */
  searchTerm?: string;
  /** 是否显示右侧缩略图（VSCode 风格的 minimap）。 */
  showMinimap?: boolean;
  /** 是否启用视图内 Ctrl+F 查找。 */
  enableFind?: boolean;
  /**
   * 视图当前是否可见可交互。宿主页面被保活隐藏（配置浏览切到其他模式）时传 false：
   * 隐藏后 document.activeElement 会退回 body，本视图的 Ctrl+F 全局监听会把按键
   * 判给「当前文件」，从而劫持其他模式里的查找。
   */
  active?: boolean;
  /**
   * 内容身份键：同一实例换正文时必须变（如「命名空间/分组/dataId + 历史版本 id」）。
   * 缺省时退回 code 本身。存在的原因：相邻历史版本正文可能逐字相同，
   * 只按 code 判断不会触发滚动重置，用户会看到视图停在上一版的偏移处。
   */
  contentKey?: string;
}

// 几何常量：CSS 与 TS 必须共用同一套数值，行号、命中行高亮、缩略图跳转
// 全靠「行 i 在滚动内容中的 top = PAD_TOP + i * ROW_H」这条公式对齐。
const ROW_H = 20;
const GUTTER_W = 52;
const PAD_TOP = 6;
const MM_ROW_H = 2.5;
const MM_MIN_ROWS = 8;
const MAX_FALLBACK_ROWS = 200; // clientHeight 未知（首帧 / jsdom）时兜底渲染的行数

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

/** IDE 风格的只读代码展示：语法高亮 + 行号 + 搜索词标红与命中行高亮 +
 *  右侧 VSCode 式缩略图 + 视图内 Ctrl+F 查找。
 *
 *  关键不变式（retest / 单测依赖）：.code-area 里的文本 blob 其 textContent
 *  必须恒等于原始代码（换行保留、可复制），命中用 <mark class="search-hit">
 *  内联在 blob 内。因此行号、命中行底色都放在 .code-area 之外的独立层
 *  （.code-gutter / .code-lines），绝不作为 .code-area 的文本节点存在。 */
export default function CodeView({ code, format, searchTerm, showMinimap = true, enableFind = true, active = true, contentKey }: Props) {
  const { t } = useTranslation();

  const rootRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLPreElement>(null);
  const gutterInnerRef = useRef<HTMLDivElement>(null);
  const linesInnerRef = useRef<HTMLDivElement>(null);
  const minimapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const draggingRef = useRef(false);

  const [findOpen, setFindOpen] = useState(false);
  const [findTerm, setFindTerm] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [metrics, setMetrics] = useState({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 });
  const [minimapSize, setMinimapSize] = useState({ width: 0, height: 0 });

  const lines = useMemo(() => splitLines(code), [code]);
  const totalLines = lines.length;

  // 查找栏打开时以查找词为准；否则沿用外部内容搜索词（整体标红，不区分当前命中）。
  const effectiveTerm = findOpen ? findTerm : (searchTerm ?? "");
  const hits = useMemo(() => findCodeHits(code, effectiveTerm.trim()), [code, effectiveTerm]);
  const hitSet = useMemo(() => hitLines(hits), [hits]);

  const activeOffset = findOpen ? activeOffsetOf(hits, activeIdx) : null;
  const currentLine = findOpen ? activeLineOf(hits, activeIdx) : null;

  const html = useMemo(() => {
    const base = highlightCode(code, format);
    // 末尾换行的安全表示：不依赖 HTML 解析行为（详见 highlight.ts 注释）。
    const withTail = code.endsWith("\n") ? base + "<span></span>" : base;
    // 只在已转义 HTML 的文本区按整文档偏移插标记，标签结构原样保留。
    return markHighlightedHtml(withTail, hits, activeOffset);
  }, [code, format, hits, activeOffset]);

  const syncScroll = useCallback(() => {
    const el = areaRef.current;
    if (!el) return;
    const top = el.scrollTop;
    // 行号 / 命中行用 transform 直接跟手，不等 React 重渲染。
    const transform = `translateY(${-top}px)`;
    if (gutterInnerRef.current) gutterInnerRef.current.style.transform = transform;
    if (linesInnerRef.current) linesInnerRef.current.style.transform = transform;
    setMetrics({ scrollTop: top, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
  }, []);

  const scrollLineIntoView = useCallback((line: number) => {
    const el = areaRef.current;
    if (!el) return;
    const y = PAD_TOP + line * ROW_H;
    el.scrollTop = clamp(y - el.clientHeight / 2, 0, Math.max(0, el.scrollHeight - el.clientHeight));
  }, []);

  const openFind = useCallback(() => {
    setFindOpen(true);
    setFindTerm((prev) => prev || (searchTerm ?? ""));
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

  const navigate = useCallback(
    (delta: number) => {
      if (!hits.length) return;
      setActiveIdx((prev) => {
        const next = (prev + delta + hits.length) % hits.length;
        scrollLineIntoView(hits[next].line);
        return next;
      });
    },
    [hits, scrollLineIntoView]
  );

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindTerm("");
    setActiveIdx(0);
  }, []);

  // 搜索词 / 文件变化：重置当前命中序号，避免越界或指向上一份文件。
  useEffect(() => {
    setActiveIdx(0);
  }, [effectiveTerm, code]);

  // 换内容时把滚动位置拉回起点（R9）：复用同一实例切换配置或历史版本时，
  // 不重置就会带着上一份内容的偏移，看起来像"莫名停在中间"。
  // 依赖同时看 code 与 contentKey：正文变了要归零；正文逐字相同但版本（contentKey）
  // 变了也要归零，否则相邻无差异版本之间会保留上一版的偏移。
  // 用 useLayoutEffect 在绘制前完成，避免用户看到滚动跳变的一帧。
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.scrollTop = 0;
    el.scrollLeft = 0;
    syncScroll();
  }, [code, contentKey, syncScroll]);

  // 切换文件时收起查找栏，防止旧关键词污染新内容。
  useEffect(() => {
    setFindOpen(false);
    setFindTerm("");
  }, [code]);

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    syncScroll();
    const raf = (window as unknown as { requestAnimationFrame?: (cb: () => void) => number }).requestAnimationFrame;
    const onScroll = () => (raf ? raf(syncScroll) : syncScroll());
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [syncScroll]);

  // 容器尺寸变化（含首次布局）刷新视口高度。
  useEffect(() => {
    const area = areaRef.current;
    if (!area || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => syncScroll());
    ro.observe(area);
    return () => ro.disconnect();
  }, [syncScroll]);

  useEffect(() => {
    const mm = minimapRef.current;
    if (!mm || typeof ResizeObserver === "undefined") return;
    const measure = () => setMinimapSize({ width: mm.clientWidth, height: mm.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(mm);
    return () => ro.disconnect();
  }, [showMinimap]);

  // Ctrl+F / Cmd+F / F3：仅在焦点落在本视图、或没有任何输入框持有焦点时接管，
  // 绝不从其他输入框（如配置列表搜索框）抢走原生查找。
  useEffect(() => {
    // 视图被保活隐藏时不挂全局监听：避免隐藏的查找栏抢走 Ctrl+F / F3
    if (!enableFind || !active) return;
    const takesThisView = (target: EventTarget | null): boolean => {
      const root = rootRef.current;
      // 事件源在本视图内（含查找输入框）→ 接管；Node 判定避免 window/document 触发 contains 抛错
      if (root && target instanceof Node && root.contains(target)) return true;
      const active = document.activeElement as HTMLElement | null;
      const editable = !!active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable);
      // 焦点在别处的可编辑控件上 → 让给它，不劫持
      if (editable) return false;
      // 没有焦点 / 焦点在 body → 视为针对当前文件
      return !active || active === document.body || active === document.documentElement;
    };
    const handler = (e: KeyboardEvent) => {
      const target = e.target as EventTarget | null;
      const key = e.key;
      const isFindKey = (e.ctrlKey || e.metaKey) && (key === "f" || key === "F");
      const isF3 = key === "F3";
      if (!isFindKey && !isF3) return;
      // F3 只有在查找栏已打开时才导航，否则把浏览器原生查找/其它行为留给系统
      if (isF3 && !findOpen) return;
      if (!takesThisView(target)) return;
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

  // 打开 / 改变查找词后，滚动到首个命中（导航本身在 navigate 内即时滚动）。
  useEffect(() => {
    if (!findOpen || !hits.length) return;
    scrollLineIntoView(hits[clamp(activeIdx, 0, hits.length - 1)].line);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findOpen, effectiveTerm]);

  const onFindKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      navigate(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeFind();
    }
  };

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
    out.sort((a, b) => a - b);
    return out;
  }, [hits, visibleRange]);

  const rowLimit = Math.max(MM_MIN_ROWS, Math.floor(minimapSize.height / MM_ROW_H));
  const minimapRows = useMemo(() => buildMinimapRows(lines, hitSet, currentLine, rowLimit), [lines, hitSet, currentLine, rowLimit]);

  // 画缩略图：命中行用红色覆盖，当前命中更亮。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { width, height } = minimapSize;
    // 未测量出尺寸（首帧 / jsdom）时先跳过，顺带避免无谓地调用 getContext。
    if (width <= 0 || height <= 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = (window as unknown as { devicePixelRatio?: number }).devicePixelRatio ?? 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const n = Math.max(1, lines.length);
    for (const row of minimapRows) {
      if (row.kind === "blank") continue;
      const y = (row.startLine / n) * height;
      const h = Math.max(1, ((row.endLine - row.startLine) / n) * height - 0.5);
      const barWidth = Math.max(3, row.widthRatio * (width - 8));
      ctx.fillStyle = row.kind === "comment" ? "rgba(180, 180, 180, 0.16)" : "rgba(220, 220, 220, 0.24)";
      ctx.fillRect(4, y, barWidth, h);
      if (row.hasHit) {
        ctx.fillStyle = row.isCurrent ? "#ff6b6b" : "rgba(244, 71, 71, 0.9)";
        ctx.fillRect(4, y, barWidth, h);
      }
    }
  }, [minimapRows, minimapSize, lines.length]);

  const jumpFromPointer = useCallback((clientY: number) => {
    const mm = minimapRef.current;
    const el = areaRef.current;
    if (!mm || !el || el.scrollHeight <= 0) return;
    const rect = mm.getBoundingClientRect();
    const ratio = clamp((clientY - rect.top) / Math.max(1, rect.height), 0, 1);
    el.scrollTop = clamp(ratio * el.scrollHeight - el.clientHeight / 2, 0, el.scrollHeight);
  }, []);

  const hasMinimap = showMinimap && totalLines > 0;

  const viewport = useMemo(() => {
    const { scrollTop, scrollHeight, clientHeight } = metrics;
    if (scrollHeight <= 0 || clientHeight <= 0 || totalLines <= 0) return null;
    const contentH = PAD_TOP * 2 + totalLines * ROW_H;
    const topPct = clamp((scrollTop / scrollHeight) * 100, 0, 100);
    const heightPct = clamp((clientHeight / scrollHeight) * 100, (ROW_H / contentH) * 100, 100 - topPct);
    return { topPct, heightPct };
  }, [metrics, totalLines]);

  const padRight = hasMinimap ? GUTTER_W + 24 : GUTTER_W + 16;
  const padRightVar = { "--code-pad-right": `${padRight}px`, "--code-find-right": `${hasMinimap ? GUTTER_W + 24 : 16}px` } as CSSProperties;

  return (
    <div className="code-view" ref={rootRef} tabIndex={-1}>
      <div className="code-body">
        <div className="code-lines" aria-hidden="true">
          <div className="code-lines-layer" ref={linesInnerRef}>
            {hitRows.map((line) => (
              <div
                key={`hit-${line}`}
                className={`code-line${line === currentLine ? " is-current" : " is-hit"}`}
                style={{ top: PAD_TOP + line * ROW_H }}
              />
            ))}
          </div>
        </div>

        <pre ref={areaRef} className="code-area mono hljs" onScroll={syncScroll} style={padRightVar}>
          <code dangerouslySetInnerHTML={{ __html: html }} />
        </pre>

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

        {hasMinimap && (
          <div
            className="code-minimap"
            ref={minimapRef}
            title={t("config.minimap")}
            onPointerDown={(e) => {
              draggingRef.current = true;
              e.currentTarget.setPointerCapture?.(e.pointerId);
              jumpFromPointer(e.clientY);
            }}
            onPointerMove={(e) => {
              if (draggingRef.current) jumpFromPointer(e.clientY);
            }}
            onPointerUp={(e) => {
              draggingRef.current = false;
              e.currentTarget.releasePointerCapture?.(e.pointerId);
            }}
            onPointerCancel={() => {
              draggingRef.current = false;
            }}
          >
            <canvas className="code-minimap-canvas" ref={canvasRef} />
            {viewport && <div className="code-minimap-viewport" style={{ top: `${viewport.topPct}%`, height: `${viewport.heightPct}%` }} />}
          </div>
        )}

        {enableFind && !findOpen && (
          <button
            type="button"
            className="code-find-open"
            onClick={openFind}
            title={t("config.openFind")}
            aria-label={t("config.openFind")}
            style={padRightVar}
          >
            ⌕
          </button>
        )}

        {enableFind && findOpen && (
          <div className="code-find" role="search" style={padRightVar}>
            <input
              ref={findInputRef}
              className="code-find-input mono"
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
              title={t("config.findPrev")}
              aria-label={t("config.findPrev")}
            >
              ↑
            </button>
            <button
              type="button"
              className="code-find-btn"
              onClick={() => navigate(1)}
              disabled={!hits.length}
              title={t("config.findNext")}
              aria-label={t("config.findNext")}
            >
              ↓
            </button>
            <button
              type="button"
              className="code-find-btn"
              onClick={closeFind}
              title={t("config.findClose")}
              aria-label={t("config.findClose")}
            >
              ✕
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
