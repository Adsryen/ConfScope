import type { CSSProperties, KeyboardEvent, RefObject } from "react";
import { useTranslation } from "../i18n";

/**
 * 视图内查找条的唯一实现（轮48）。
 *
 * 为什么现在才抽：原先浏览态与编辑态各抄了一份 DOM 完全一样的条子，两份的差别只有
 * 「输入框 onChange 里顺手把序号归零」和「style 里带不带右侧留白」。轮48 要把同一套
 * Ctrl+F 体验接进并排差异（DiffPanel），第三份拷贝就等于把「只补一边」这类事故
 * （轮22 R75 记的就是它）的成因再复制一遍。这里只放**视图无关**的东西：
 * 输入框、两个匹配口径开关、计数、↑↓✕，以及关栏态那颗 ⌕ 浮标。
 *
 * 状态与几何全部留在宿主：查找词、命中表、当前序号、条高测量、净空公式、
 * Ctrl+F 所有权、Esc 登记都是宿主自己的事（三份视图的正文形状不同，见各自行内注释）。
 *
 * 四条不能随便动的口径（各有守卫钉着，改动前先读守卫）：
 * 1. 四个按钮（两个开关 + ↑↓）挡 mousedown，✕ 明确不挡 —— `findBarNavButtonsMustNotStealFocus`；
 * 2. 键名走 title + aria-keyshortcuts，aria-label 保持纯文案 —— `findBarShortcutHints`；
 * 3. 触顶时计数分两态，「+」必须进可见文案 —— `hitCapMustBeVisibleInCount`；
 * 4. 计数与空态提示长在同一个 live region 的**文本**里，不许塞进属性。
 */

/** 把序号夹回 [0, count-1]：换词 / 改口径后旧的 activeIdx 可能已经越过新的末尾。 */
function shownIndex(currentHit: number, hitCount: number): number {
  if (hitCount <= 0) return 0;
  return Math.min(Math.max(currentHit, 0), hitCount - 1) + 1;
}

export interface FindBarProps {
  /** 输入框里的词（未提交也算，宿主自己决定何时进命中表）。 */
  term: string;
  /** 当前生效的查找词是否非空：决定空态显示「没有命中」还是「输入关键词…」。 */
  hasTerm: boolean;
  /** 可导航单位的总数。代码视图 = 命中处数；并排差异 = 命中行数（步进单位不同，见 DiffPanel）。 */
  hitCount: number;
  /** 当前单位的 0 基序号，越界由本组件夹回来。 */
  currentHit: number;
  /** 命中扫描被动停在预算上：还有没标出来的，计数必须说「+」（轮28 F-10）。 */
  capped: boolean;
  /** 触顶那句话里的 max 槽 = 真的能导航到的单位数，不是扫描预算（拿预算冒充总数是说谎）。 */
  cappedMax: number;
  caseSensitive: boolean;
  wholeWord: boolean;
  onTermChange: (value: string) => void;
  onInputKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onToggleCaseSensitive: () => void;
  onToggleWholeWord: () => void;
  /** delta = ±1，环绕由宿主算（它才知道总数）。 */
  onNavigate: (delta: number) => void;
  /** 关栏：宿主负责清词、清序号、把焦点还给正文。 */
  onClose: () => void;
  /** 宿主在这颗元素上量条高（窄容器 flex-wrap 成两行时净空要跟着长）。 */
  barRef: RefObject<HTMLDivElement>;
  inputRef: RefObject<HTMLInputElement>;
  /** 右侧留白（缩略图占位）由宿主按自己的几何下发。 */
  style?: CSSProperties;
}

/** 浮动查找条。挂在宿主的滚动容器内（绝对定位），开栏条件也由宿主判。 */
export default function FindBar({
  term,
  hasTerm,
  hitCount,
  currentHit,
  capped,
  cappedMax,
  caseSensitive,
  wholeWord,
  onTermChange,
  onInputKeyDown,
  onToggleCaseSensitive,
  onToggleWholeWord,
  onNavigate,
  onClose,
  barRef,
  inputRef,
  style,
}: FindBarProps) {
  const { t } = useTranslation();
  const current = shownIndex(currentHit, hitCount);

  return (
    <div className="code-find" ref={barRef} role="search" style={style}>
      <input
        ref={inputRef}
        className="code-find-input mono"
        spellCheck={false}
        type="text"
        value={term}
        placeholder={t("config.findPlaceholder")}
        aria-label={t("config.findPlaceholder")}
        onChange={(e) => onTermChange(e.target.value)}
        onKeyDown={onInputKeyDown}
      />
      {/* 匹配口径开关。onMouseDown preventDefault：按钮默认会夺走焦点，
          点一下开关就得再点一次输入框才能继续改词——查找栏的老毛病，这里挡住。
          编辑态里更糟：焦点离开 textarea 会连当前选区一起消失。 */}
      <button
        type="button"
        className={`code-find-toggle${caseSensitive ? " is-on" : ""}`}
        aria-pressed={caseSensitive}
        aria-label={t("config.findCaseSensitive")}
        title={t("config.findCaseSensitive")}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onToggleCaseSensitive}
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
        onClick={onToggleWholeWord}
      >
        ab|
      </button>
      {/* 命中触顶时必须说出来（轮28 F-10）：只写「第 1/5000 处」用户会以为文件里一共就 5000 处。
          「+」进可见文案，解释挂 title——这是 span，title 正常显示，不受轮26 F-1（disabled 控件的 title 不弹）影响。 */}
      <span
        className="code-find-count"
        aria-live="polite"
        title={capped ? t("config.findCountCappedHint", { max: cappedMax }) : undefined}
      >
        {hitCount
          ? capped
            ? t("config.findCountCapped", { current, max: cappedMax })
            : t("config.findCount", { current, total: hitCount })
          : hasTerm
            ? t("config.findNone")
            : t("config.findHint")}
      </span>
      {/* ↑↓ 与上面两个开关同一口径（轮32 F-29）：点跳转不许把焦点从查找输入框 / textarea 上抢走——
          抢走之后接着敲的字符哪儿都不去（真机取证见任务目录 research/focus_probe.txt）。
          下面的 ✕ 反过来：它的语义是「结束查找，把焦点还给正文」，onClick 里那句 focus 依赖这次点击，别照抄。 */}
      <button
        type="button"
        className="code-find-btn"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onNavigate(-1)}
        disabled={hitCount === 0}
        title={t("config.findPrevKey")}
        aria-label={t("config.findPrev")}
        aria-keyshortcuts="Shift+Enter Shift+F3"
      >
        ↑
      </button>
      <button
        type="button"
        className="code-find-btn"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onNavigate(1)}
        disabled={hitCount === 0}
        title={t("config.findNextKey")}
        aria-label={t("config.findNext")}
        aria-keyshortcuts="Enter F3"
      >
        ↓
      </button>
      <button
        type="button"
        className="code-find-btn"
        onClick={onClose}
        title={t("config.findCloseKey")}
        aria-label={t("config.findClose")}
        aria-keyshortcuts="Escape"
      >
        ✕
      </button>
    </div>
  );
}

export interface FindOpenButtonProps {
  onOpen: () => void;
  /** 宿主把这条登记进自己的滚轮兜底死区（轮32 F-33 / 轮33 F-34），所以要拿到这颗按钮。 */
  btnRef?: RefObject<HTMLButtonElement>;
  /** 右侧留白：与查找条同一口径，由宿主下发。 */
  style?: CSSProperties;
}

/** 关栏态的 ⌕ 入口浮标（悬停 / 键盘聚焦时可见，见 styles.css 的 .code-find-open）。 */
export function FindOpenButton({ onOpen, btnRef, style }: FindOpenButtonProps) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="code-find-open"
      ref={btnRef}
      onClick={onOpen}
      title={t("config.openFind")}
      aria-label={t("config.openFind")}
      aria-keyshortcuts="Control+F"
      style={style}
    >
      ⌕
    </button>
  );
}
