import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { decorateMinimapRows, prepareMinimapBuckets } from "../lib/codeLines";
import { useTranslation } from "../i18n";

/**
 * VSCode 式右侧缩略图：浏览态（CodeView）与编辑态（CodeEditor）**共用这一份**。
 *
 * 为什么必须收成一个组件（轮30 F-24）：用户最初那句需求是「在右侧添加一个类似 vscode 的略缩的行显示」，
 * 原先只有浏览态做了。同一个详情面板切到「编辑」，66px 那条缩略图连同命中红条、视口框、点击跳转
 * 一起消失，只剩一条原生滚动条——几万行的 properties/yaml 想回到第 3800 行只能拖滚动条。
 * 而「补一份」的成本不是 66px 那条 UI，是第二份桶表、第二份点击映射、第二套 canvas 颜色：
 * 轮28 F-12/F-13、轮30 F-20 每条修完都只在浏览态生效，分叉就是这么来的。
 * 本文件是那四处口径的唯一出处，两个视图只递几何与数据。
 */

/** 一条桶在缩略图上占多少 CSS px（桶数 = 画布高 / 这个数）。 */
const MM_ROW_H = 2.5;
/** 画布还没量到高度时的最少桶数，别让整条图空着。 */
const MM_MIN_ROWS = 8;
/**
 * 条子的左右内缩（px）。
 *
 * 原先画条写 `ctx.fillRect(4, …)`、条宽标尺写 `width - 8`，同一个数换了两种写法：
 * 改一边就是右边被裁掉一半内缩（轮30 F-24 收口）。
 */
const MM_INSET_X = 4;
/** 再短的桶也得看得见：条宽下限。 */
const MM_MIN_BAR_W = 3;
/** 相邻桶之间留的缝：不留就糊成一块，行边界读不出来。 */
const MM_BAR_ROW_GAP = 0.5;
/** 缩略图占宽（px），与 styles.css 的 `--code-minimap-w` 同源（守卫盯着）。 */
export const MINIMAP_W = 66;
/** 正文右缘与缩略图之间的空隙：留白 = 图宽 + 这个数，两个视图同一个值。 */
export const MINIMAP_SIDE_GAP = 10;
/** 设置里开着缩略图时，正文与查找条该往左让多少。 */
export const MINIMAP_RESERVED_RIGHT = MINIMAP_W + MINIMAP_SIDE_GAP;

// 画布上的四个语义色。全站只有一个深色主题（styles.css 里就一个 :root，无 prefers-color-scheme），
// 所以这里写死不是「待接主题」，是画布层与 CSS 层的分工（轮30 PRD 记的口径）。
const COLOR_CODE_LINE = "rgba(220, 220, 220, 0.24)";
const COLOR_COMMENT_LINE = "rgba(180, 180, 180, 0.16)";
const COLOR_HIT = "rgba(244, 71, 71, 0.9)";
const COLOR_CURRENT_HIT = "#ff6b6b";

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

interface Props {
  /** 真正的滚动容器：浏览态 `.code-area` / 编辑态 `textarea`。点击映射写的就是它的 scrollTop。 */
  containerRef: RefObject<HTMLElement | null>;
  /**
   * 写完 scrollTop 之后**当帧**要补的那一次同步（轮30 F-20）。
   *
   * 行号层与命中行底色层在滚动容器之外，靠 `transform: translateY(-scrollTop)` 跟手；
   * scroll 事件是异步派发的，连续拖动时每帧都在写偏移、事件永远排在后面。
   * 所以每次跳转都由调用方把它自己的 syncScroll 递进来，这里不留第二份实现。
   */
  syncScroll: () => void;
  /** 正文按行切开的数组：桶表唯一数据源，与行号层同源。 */
  lines: string[];
  /** 升序命中行表（`hitLines` 的迭代序），落红条用。 */
  hitLineArray: number[];
  /** 「当前在第几处」所在行；命中行桶要画得更亮。 */
  currentLine: number | null;
  /** 滚动容器实测几何：视口框与「能不能滚」都只看这一份。 */
  metrics: { scrollTop: number; scrollHeight: number; clientHeight: number };
  /** 行网格的行高（px）：由视图递自己的 ROW_H，这里不抄第二份常量。 */
  rowHeight: number;
  /** 顶部净空（px）：随查找栏开合变，同样由视图递进来。 */
  padTop: number;
}

/** 缩略图表面：桶条 + 命中红条 + 视口框 + 点击与拖动跳转。不满一屏时整条不渲染。 */
export default function CodeMinimap({ containerRef, syncScroll, lines, hitLineArray, currentLine, metrics, rowHeight, padTop }: Props) {
  const { t } = useTranslation();

  const surfaceRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const draggingRef = useRef(false);
  const [minimapSize, setMinimapSize] = useState({ width: 0, height: 0 });

  /**
   * 只在内容真能滚时出现（轮28 F-13）。
   *
   * 缺陷长什么样：不满一屏时 `jumpFromPointer` 算出的 scrollTop 恒被夹到 0——
   * 一个「看得见、点不动、还占着右侧留白」的死控件，而且视口遮罩铺满整条，看着像能拖。
   *
   * 量不到（首帧 / jsdom：scrollHeight 与 clientHeight 都是 0）时**放行**：
   * 「没测到」不等于「测到了且不需要滚」，放行让首帧不闪，组件测试也照常渲染。
   * 注意调用方给正文留的右侧留白**不许**跟着这个条件变，否则「收起缩略图 ⇒ 正文变宽 ⇒
   * 不再需要滚 ⇒ 又该收起」是自激振荡——那条口径留在各视图的 minimapReserved 上。
   */
  const canScrollContent = metrics.scrollHeight <= 0 || metrics.scrollHeight > metrics.clientHeight + 1;

  const rowLimit = Math.max(MM_MIN_ROWS, Math.floor(minimapSize.height / MM_ROW_H));
  /**
   * 分两阶段算（轮28 F-12），顺序不许合回去：
   * 贵的那一阶段（桶内行长 / 行类型 / 条宽）只跟正文有关，每按一次 Enter 重算是白付的钱。
   */
  const buckets = useMemo(() => prepareMinimapBuckets(lines, rowLimit), [lines, rowLimit]);
  const minimapRows = useMemo(() => decorateMinimapRows(buckets, hitLineArray, currentLine), [buckets, hitLineArray, currentLine]);

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
    const barArea = Math.max(0, width - MM_INSET_X * 2);
    for (const row of minimapRows) {
      if (row.kind === "blank") continue;
      const y = (row.startLine / n) * height;
      const h = Math.max(1, ((row.endLine - row.startLine) / n) * height - MM_BAR_ROW_GAP);
      const barWidth = Math.max(MM_MIN_BAR_W, row.widthRatio * barArea);
      ctx.fillStyle = row.kind === "comment" ? COLOR_COMMENT_LINE : COLOR_CODE_LINE;
      ctx.fillRect(MM_INSET_X, y, barWidth, h);
      if (row.hasHit) {
        ctx.fillStyle = row.isCurrent ? COLOR_CURRENT_HIT : COLOR_HIT;
        ctx.fillRect(MM_INSET_X, y, barWidth, h);
      }
    }
    // lines.length 而不是 lines：桶表变了才要重画，正文数组的引用变化由 buckets 那条 memo 收敛。
  }, [minimapRows, minimapSize, lines.length]);

  /**
   * 点 / 拖缩略图落到某个偏移。
   *
   * 写完 scrollTop 必须**当帧**补一次 `syncScroll()`（轮30 F-20）：行号层与命中行底色层在滚动
   * 容器**之外**，靠 `translateY(-scrollTop)` 跟手，浏览器不会替我们滚它们；而 scroll 事件是异步
   * 派发的——连续拖动时每帧都在写偏移，事件永远排在后面，于是正文到位了、侧栏还停在上一帧。
   * `scrollLineIntoView` 早就是「写完立刻同步」，这条出口原先漏了。
   */
  const jumpFromPointer = useCallback(
    (clientY: number) => {
      const mm = surfaceRef.current;
      const el = containerRef.current;
      if (!mm || !el || el.scrollHeight <= 0) return;
      const rect = mm.getBoundingClientRect();
      const ratio = clamp((clientY - rect.top) / Math.max(1, rect.height), 0, 1);
      // 上界是「滚得动的最大偏移」= scrollHeight - clientHeight，不是 scrollHeight：写成后者等于没夹，
      // 拖到底部时 metrics 会收到一个越界的 scrollTop（浏览器自己再夹一次，遮罩比例就偏了）。
      el.scrollTop = clamp(ratio * el.scrollHeight - el.clientHeight / 2, 0, Math.max(0, el.scrollHeight - el.clientHeight));
      syncScroll();
    },
    [containerRef, syncScroll]
  );

  const viewport = useMemo(() => {
    const { scrollTop, scrollHeight, clientHeight } = metrics;
    const totalLines = lines.length;
    if (scrollHeight <= 0 || clientHeight <= 0 || totalLines <= 0) return null;
    const contentH = padTop * 2 + totalLines * rowHeight;
    const topPct = clamp((scrollTop / scrollHeight) * 100, 0, 100);
    const heightPct = clamp((clientHeight / scrollHeight) * 100, (rowHeight / contentH) * 100, 100 - topPct);
    return { topPct, heightPct };
  }, [metrics, lines.length, padTop, rowHeight]);

  useEffect(() => {
    const mm = surfaceRef.current;
    if (!mm || typeof ResizeObserver === "undefined") return;
    const measure = () => setMinimapSize({ width: mm.clientWidth, height: mm.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(mm);
    return () => ro.disconnect();
    // 依赖写 canScrollContent 而不是调用方的设置位：元素会因为「内容不满一屏」自己消失，
    // 只盯设置位的话，重新出现后没人再量它，rowLimit 永远停在兜底值。
  }, [canScrollContent]);

  if (!canScrollContent) return null;

  return (
    <div
      className="code-minimap"
      ref={surfaceRef}
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
  );
}
