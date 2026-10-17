import { type CSSProperties, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { subscribeClosePopovers } from "../lib/popoverBus";
import { EscapePriority, isImeComposing, useEscape } from "../lib/useEscape";
import { useTranslation } from "../i18n";

// 候选渲染上限：超出部分不再静默丢弃，改为显式提示继续输入缩小范围
const MAX_VISIBLE_OPTIONS = 50;

export interface ComboOption {
  value: string;
  /** 可选的分组或辅助说明文案。 */
  sub?: string;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  /** 选中候选项时回传完整 option，便于同步 group 等字段。 */
  onPick?: (o: ComboOption) => void;
  options: ComboOption[];
  placeholder?: string;
  /** 可访问名；不传则退回 placeholder，保证框永远有名字（placeholder 会随输入消失）。 */
  ariaLabel?: string;
  disabled?: boolean;
}

/** 模糊匹配：子串命中或字符顺序命中。
 * 注意：当前值(value)作为查询时不能把候选"过滤没"——
 * 否则 group/dataId 这类"值=当前选中项"的 combobox 展开后只剩自身一项，
 * 用户无法看到/切换到其他候选（真人操作下表现为下拉候选不全）。
 * 候选项与当前值完全相同时视为命中。 */
function fuzzy(query: string, text: string, exactValue?: string): boolean {
  if (!query) return true;
  if (exactValue !== undefined && text === exactValue) return true;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.includes(q)) return true;
  let i = 0;
  for (let k = 0; k < t.length && i < q.length; k++) {
    if (t[k] === q[i]) i++;
  }
  return i === q.length;
}

/** 输入框 + 候选下拉框（combobox）：支持模糊过滤，并防止被父容器裁剪。 */
export default function Combobox({ value, onChange, onPick, options, placeholder, ariaLabel, disabled }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  // 键盘/悬停高亮项索引（与"已选中"分开；输入变化时由 effect 重置到最佳匹配）
  const [activeIndex, setActiveIndex] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const optionId = (i: number) => `${listId}-opt-${i}`;

  const matchFor = (query: string) => options.filter((o) => fuzzy(query, o.value, query) || (o.sub ? fuzzy(query, o.sub) : false));

  const matched = matchFor(value);
  const filtered = matched.slice(0, MAX_VISIBLE_OPTIONS);
  const hiddenCount = matched.length - filtered.length;

  const updateMenuPosition = useCallback(() => {
    const trigger = ref.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const spaceAbove = rect.top - 8;
    const desiredHeight = 260;
    const openAbove = spaceBelow < 160 && spaceAbove > spaceBelow;
    const maxHeight = Math.max(120, Math.min(desiredHeight, openAbove ? spaceAbove : spaceBelow));
    const top = openAbove ? Math.max(8, rect.top - 4 - maxHeight) : rect.bottom + 4;
    setMenuStyle({
      position: "fixed",
      top,
      left: rect.left,
      right: "auto",
      width: rect.width,
      maxHeight,
      zIndex: 10000,
    });
  }, []);

  // 候选弹层展开时 Esc 只收弹层（分层注册表按 dropdown 优先级胜出，不吃掉外层弹层）。
  useEscape(open, () => setOpen(false), EscapePriority.dropdown);

  // 宿主页面被保活隐藏（模式切换）时收起候选弹层：portal 在 document.body 上，不随容器 hidden 消失。
  useEffect(() => subscribeClosePopovers(() => setOpen(false)), []);

  const pick = (o: ComboOption) => {
    onChange(o.value);
    onPick?.(o);
    setOpen(false);
  };

  // ↑↓ 移动高亮（到边界停住；尚未高亮时从首/尾开始）
  const moveActive = (delta: number) => {
    if (filtered.length === 0) return;
    setActiveIndex((cur) => {
      const base = cur < 0 ? (delta > 0 ? -1 : filtered.length) : cur;
      return Math.min(filtered.length - 1, Math.max(0, base + delta));
    });
  };

  // 展开/输入时把高亮落到"当前值"或首个候选，保证 Enter 语义稳定。
  // 由动作显式调用，不放进依赖 filtered 的 effect —— 否则父组件每次重渲染都会重置键盘高亮。
  const resetActive = (list: ComboOption[], query: string) => {
    if (list.length === 0) {
      setActiveIndex(-1);
      return;
    }
    setActiveIndex(
      Math.max(
        0,
        list.findIndex((o) => o.value === query)
      )
    );
  };

  // 收起后清掉高亮
  useEffect(() => {
    if (!open) setActiveIndex(-1);
  }, [open]);

  // 高亮项滚入弹层可视区（block:nearest 只动弹层，不让整页跳动）
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    menuRef.current?.querySelector(`[data-idx="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  useLayoutEffect(() => {
    if (!open || filtered.length === 0) return;
    updateMenuPosition();
  }, [filtered.length, open, updateMenuPosition]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: PointerEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onResize = () => updateMenuPosition();
    window.addEventListener("pointerdown", onDoc);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      window.removeEventListener("pointerdown", onDoc);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    };
  }, [open, updateMenuPosition]);

  return (
    <div className="combo" ref={ref}>
      <input
        type="text"
        ref={inputRef}
        className="search-input wide mono"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        disabled={disabled}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        /* 展开态必须挂在本体上：input 的隐式角色是 textbox，不认 aria-expanded/aria-controls，
           读屏只会念出文本框而不会念「已展开」（R43，APG 的组合框模式要求控件本体是 combobox 角色） */
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        onChange={(e) => {
          const next = e.target.value;
          onChange(next);
          resetActive(matchFor(next), next);
          setOpen(true);
        }}
        onFocus={() => {
          resetActive(matched, value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          // 焦点始终留在输入框（不抢焦点，保证输入法与继续输入不被打断）
          // 组合态的 Enter / 方向键交给 IME：否则候选词上屏的同时会把该项写进表单
          if (isImeComposing(e)) return;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!open) {
              resetActive(matched, value);
              setOpen(true);
            } else {
              moveActive(e.key === "ArrowDown" ? 1 : -1);
            }
            return;
          }
          if (e.key === "Home" || e.key === "End") {
            if (!open || filtered.length === 0) return; // 收起态把光标键交还输入框
            e.preventDefault();
            setActiveIndex(e.key === "Home" ? 0 : filtered.length - 1);
            return;
          }
          if (e.key === "Enter") {
            const target = filtered[activeIndex];
            if (!open || !target) return;
            e.preventDefault(); // 阻止外层表单的默认提交
            pick(target);
          }
          // Escape 由 useEscape 分层注册处理：只收弹层，焦点留在输入框
        }}
      />
      {open &&
        filtered.length > 0 &&
        createPortal(
          <div ref={menuRef} id={listId} role="listbox" className="combo-menu combo-menu-portal" style={menuStyle}>
            {filtered.map((o, i) => (
              <div
                key={`${o.value}/${o.sub ?? ""}/${i}`}
                id={optionId(i)}
                data-idx={i}
                role="option"
                aria-selected={o.value === value}
                className={`combo-option${o.value === value ? " active" : ""}${i === activeIndex ? " highlighted" : ""}`}
                onMouseEnter={() => setActiveIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault(); // 防止 input 失焦抢先关闭下拉框
                  e.stopPropagation();
                  pick(o);
                }}
              >
                <span className="combo-val" title={o.value}>
                  {o.value}
                </span>
                {o.sub && <span className="combo-sub">{o.sub}</span>}
              </div>
            ))}
            {hiddenCount > 0 && <div className="combo-more">{t("common.comboMoreHidden", { count: hiddenCount })}</div>}
          </div>,
          document.body
        )}
    </div>
  );
}
